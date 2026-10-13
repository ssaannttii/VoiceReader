"""Background music for the Reader: subtle instrumental "film-score spotting".

Optional and **off by default** (Labs). For a document the listener asked for,
a book-wide *palette* (instrumentation) is chosen, every scene gets a *mood*,
and a few short cues per mood are generated locally with Stable Audio Open
(``services/reader_music_engine.py``, its own venv, only while the voice is idle).
Cues are mastered at −24 LUFS; the client attenuates them to the listener's level (−30 LUFS by
default, under a ~−16 LUFS voice), so its volume slider has headroom upwards.

* **Palettes** — a closed list (:data:`PALETTES`) of SAO prompts per mood. Plain
  descriptive prompts with a tempo work best; negative prompts and words such as
  "quiet / sparse / restrained" make the model collapse into a dying drone, and
  no prompt names a composer, artist or film.
* **Palette per book** — rules (title/author, a palette lexicon over the text,
  era from the ambience analysis, the ambience tag mix, dialogue share), and a
  local Ollama (CPU) choosing from the enum when the rules are not decisive. The
  listener can override it.
* **Mood per scene** — the ambience scene windows (``reader_ambience.split_windows``),
  a weighted Spanish/English mood lexicon, chapter priors (lexicon or Ollama), and
  hysteresis: a cue lasts ≥ ~90 s of narration and changes only at scene
  boundaries (inside a section only on strong evidence).
* **Spots** ("moments", the client's default) — music enters at chapter starts,
  after scene breaks and at strong mood shifts, plays up to 60–180 s, never during
  dense dialogue, ~15–30 % of the listening time. **Timeline** ("continuous") —
  every scene mapped to a cue.
* **Cues** — at most :data:`MAX_CUES` moods per book × :data:`VARIATIONS` clips of
  47 s, each the better of :data:`CANDIDATES` seeds by QC metrics; generated in
  order of first use from the listening position.

Storage: the plan in ``<doc>/music.json`` (recomputed when the content changes,
like ``ambience.json``); audio and its manifest under ``<music dir>/<doc id>/``.
File names carry a hash of the prompt, so audio is regenerated only when the
palette or :data:`PROMPT_VERSION` changes.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import queue
import re
import shutil
import threading
import time
from dataclasses import dataclass
from typing import Callable, Optional, Sequence

from services import reader_ambience, reader_store
from services import reader_music_engine as engine

logger = logging.getLogger("omnivoice.reader")

#: Bump when the plan (moods, hysteresis, spots, palette rules) changes: plans are recomputed.
MUSIC_VERSION = 1
#: Bump when prompts or post-processing change: audio is regenerated.
PROMPT_VERSION = 1
MUSIC_FILE = "music.json"
MANIFEST = "manifest.json"
#: Marker in the Reader folder: music was requested on this machine (plans after imports).
_ENABLED_MARKER = "music.enabled"

#: Mastering level of the cues (the client attenuates; its default is -30 LUFS under the voice).
LEVEL_LUFS = -24
#: Narration speed used for durations (the ambience uses the same: 1350 chars ≈ 90 s).
CHARS_PER_SECOND = 15.0
MOODS = ("calm", "wonder", "tension", "dread", "melancholy", "warmth", "resolve")
MAX_CUES = 6
VARIATIONS = 3
CANDIDATES = 2
MIN_CUE_SECONDS = 90.0
SPOT_MIN_SECONDS = 60.0
SPOT_MAX_SECONDS = 180.0
COVERAGE_MIN = 0.15
COVERAGE_TARGET = 0.22
COVERAGE_MAX = 0.30
#: A window whose text is mostly dialogue gets no spot.
DIALOGUE_DENSE = 0.55

# ── Palettes ─────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Palette:
    id: str
    #: Genre + the instruments every cue of the palette shares (one family per book).
    style: str
    #: Per mood: the mood's colour (instruments, feel, key) and tempo.
    moods: dict


PALETTES: dict[str, Palette] = {
    p.id: p
    for p in (
        Palette(
            "dark_fantasy",
            "dark fantasy underscore, low sustained cello and double bass drone",
            {
                "calm": ("slow soft harp arpeggios, distant wordless choir pad, airy, mysterious, minor key", 64),
                "wonder": ("shimmering high violins, soft harp arpeggios, distant wordless choir pad, luminous, sense of wonder, slowly rising, open fifths", 64),
                "tension": ("low string tremolo, ominous sustained drone, soft dissonant string clusters, sparse low harp notes, suspenseful, minor key", 66),
                "dread": ("deep ominous drone, dark low brass swells, cold distant wordless choir, creeping dread, minor key", 60),
                "melancholy": ("warm legato low strings, soft wordless choir pad, melancholic, tender, nostalgic, minor key", 60),
                "warmth": ("warm legato strings, gentle harp, soft choir pad, hopeful, tender, major key", 64),
                "resolve": ("slow rising strings, warm horn pad, soft choir, serene, peaceful resolution, major key", 62),
            },
        ),
        Palette(
            "bright_fantasy",
            "fantasy adventure underscore, warm sustained strings, soft french horn pads",
            {
                "calm": ("gentle harp, airy flute pad, pastoral, peaceful, major key", 68),
                "wonder": ("shimmering celesta, glowing high strings, sense of wonder, majestic, slowly rising, major key", 70),
                "tension": ("low string tremolo, uneasy sustained horns, suspenseful, minor key", 70),
                "dread": ("dark low strings, ominous brass drone, foreboding, minor key", 62),
                "melancholy": ("solo cello over soft strings, wistful, melancholic, minor key", 62),
                "warmth": ("warm strings, gentle harp, soft woodwinds, heartfelt, hopeful, major key", 66),
                "resolve": ("noble horns, warm rising strings, gentle triumph, serene, major key", 66),
            },
        ),
        Palette(
            "classic_novel",
            "intimate romantic-era chamber music, soft sustained string quartet",
            {
                "calm": ("gentle piano phrases over soft sustained strings, warm, contemplative, major key", 62),
                "wonder": ("delicate high violin harmonics, soft piano arpeggios, luminous, tender wonder, major key", 64),
                "tension": ("slow sustained cello, violin tremolo, low sustained piano chords, uneasy, suspenseful, minor key", 60),
                "dread": ("dark low cello drone, dissonant sustained viola, ominous, minor key", 56),
                "melancholy": ("warm legato cello melody, soft piano chords, melancholic, tender, nostalgic, minor key", 58),
                "warmth": ("warm legato strings, soft piano chords, tender, affectionate, major key", 62),
                "resolve": ("soft piano and warm strings, peaceful resolution, serene, major key", 60),
            },
        ),
        Palette(
            "contemporary_thriller",
            "minimal dark ambient electronic underscore, low analog synth drone",
            {
                "calm": ("slowly evolving warm synth pads, soft textures, spacious, calm, clean modern sound", 70),
                "wonder": ("glassy shimmering synth pads, slowly evolving, airy, hopeful, open", 70),
                "tension": ("cold sustained synth pads, soft muted synth pulse, uneasy, suspenseful, minor key", 72),
                "dread": ("deep sub bass drone, cold metallic textures, ominous, creeping dread, minor key", 64),
                "melancholy": ("soft felt piano notes over warm synth pads, melancholic, reflective, minor key", 64),
                "warmth": ("warm analog synth pads, soft electric piano chords, hopeful, gentle, major key", 68),
                "resolve": ("warm rising synth pads, soft piano, relief, calm resolution, major key", 66),
            },
        ),
        Palette(
            "mystery_noir",
            "smoky noir ambient underscore, low upright bass drone, warm electric piano chords",
            {
                "calm": ("soft vibraphone notes, late night, mysterious, smoky, minor seventh chords", 60),
                "wonder": ("shimmering vibraphone, glassy pads, curious, intrigued, minor seventh chords", 62),
                "tension": ("low string tremolo, dark muted brass pad, suspenseful, minor key", 62),
                "dread": ("dark low drone, distant muted brass, ominous, minor key", 56),
                "melancholy": ("soft muted brass pad, slow piano chords, rainy night, melancholic, minor key", 58),
                "warmth": ("warm electric piano, soft vibraphone, gentle, intimate, major seventh chords", 62),
                "resolve": ("warm electric piano chords, soft strings, calm relief, resolved major chords", 60),
            },
        ),
        Palette(
            "romance_warm",
            "warm romantic underscore, soft legato strings, gentle piano",
            {
                "calm": ("tender, peaceful, intimate, major key", 62),
                "wonder": ("shimmering high strings, soft harp glissandi, dreamy, enchanted, major key", 64),
                "tension": ("hesitant sustained cello, soft dissonant strings, uneasy longing, minor key", 60),
                "dread": ("dark low strings, foreboding, heartbreak, minor key", 56),
                "melancholy": ("solo cello, soft piano chords, bittersweet, longing, minor key", 58),
                "warmth": ("lush warm strings, tender piano, affectionate, glowing, major key", 64),
                "resolve": ("warm swelling strings, soft piano, tender reconciliation, serene, major key", 62),
            },
        ),
        Palette(
            "scifi_space",
            "spacious ambient space music, slowly evolving analog synth pads, deep sub drone",
            {
                "calm": ("soft shimmering textures, weightless, floating, serene", 60),
                "wonder": ("glittering high textures, vast, awe, slowly rising, major key", 60),
                "tension": ("cold metallic drones, low pulsing synth, uneasy, suspenseful, minor key", 64),
                "dread": ("dark deep space drone, distant metallic resonances, ominous, minor key", 56),
                "melancholy": ("lonely distant synth pads, soft piano echoes, melancholic, minor key", 58),
                "warmth": ("warm glowing synth pads, gentle, hopeful, major key", 62),
                "resolve": ("warm rising synth pads, luminous, serene resolution, major key", 60),
            },
        ),
        Palette(
            "historical",
            "historical drama underscore, warm low strings and viola da gamba drone",
            {
                "calm": ("soft lute arpeggios, wooden flute pad, pastoral, modal, calm", 62),
                "wonder": ("soft lute, airy wordless choir, sacred, luminous, modal", 60),
                "tension": ("low string tremolo, sustained drone, uneasy, modal minor", 64),
                "dread": ("dark low drone, distant monastic choir, ominous, minor key", 56),
                "melancholy": ("solo viola da gamba, slow lute, melancholic, modal minor", 58),
                "warmth": ("warm strings, gentle lute, hearth, tender, major key", 62),
                "resolve": ("warm strings, soft choir, peaceful resolution, major key", 60),
            },
        ),
        Palette(
            "nonfiction_minimal",
            "minimal ambient, soft felt piano, warm sustained synth pad",
            {
                "calm": ("slow, gentle, spacious, reflective, major key", 64),
                "wonder": ("soft shimmering textures, curious, open, major key", 66),
                "tension": ("low sustained pad, soft dissonance, thoughtful, minor key", 62),
                "dread": ("dark low pad, serious, somber, minor key", 58),
                "melancholy": ("soft piano chords, reflective, melancholic, minor key", 60),
                "warmth": ("warm pad, gentle piano, hopeful, major key", 64),
                "resolve": ("warm pad, soft piano, settled, calm resolution, major key", 62),
            },
        ),
    )
}
PALETTE_IDS = tuple(PALETTES)
#: ``POST …/music {"palette": "auto"}`` drops the listener's override.
AUTO = "auto"
DEFAULT_MOOD = "calm"


def prompt(palette_id: str, mood: str) -> str:
    """The Stable Audio Open prompt of one cue: ``style, mood colour, NN BPM``."""
    palette = PALETTES[palette_id]
    colour, bpm = palette.moods[mood]
    return f"{palette.style}, {colour}, {bpm} BPM"


# ── Palette per book ─────────────────────────────────────────────────────────
# Same term syntax as the ambience lexicon (``*`` = stem, a space = phrase; no
# accents). Weights: 2–3 = the word alone points to the genre, < 1 = supporting.
_PALETTE_TERMS: dict[str, dict[str, dict[str, float]]] = {
    "es": {
        "dark_fantasy": {
            "magia": 2, "mago*": 1.5, "hechic*": 2, "brujo*": 2, "bruja*": 2, "conjuro*": 2, "hechizo*": 2,
            "demonio*": 1.5, "maldicion*": 1.5, "profecia*": 2, "tinieblas": 1.5, "espectr*": 1.5,
            "nigromant*": 3, "runa*": 1.5, "dioses": 1, "imperio": 1, "emperador": 1, "trono": 1,
            "espada*": 1, "ejercito*": 0.8, "asedio": 1.2, "inquisidor*": 2, "lord": 0.6, "criatura*": 1,
            "monstruo*": 1, "poderes": 1, "ceniza*": 0.6,
        },
        "bright_fantasy": {
            "aventura*": 1.5, "elfo*": 3, "enano*": 2, "hada*": 2.5, "duende*": 2, "dragon*": 2, "tesoro*": 1,
            "mapa*": 0.6, "princesa*": 1.2, "principe*": 1, "caballero*": 0.6, "castillo*": 0.8, "magia": 0.6,
            "reino*": 0.8, "unicornio*": 3, "varita*": 2,
        },
        "scifi_space": {
            "nave espacial": 3, "naves espaciales": 3, "planeta*": 2, "galaxia*": 3, "galactic*": 3,
            "estelar*": 2, "robot*": 2.5, "androide*": 3, "laser*": 2, "orbita*": 2, "astronauta*": 3,
            "hiperespacio": 3, "alienigena*": 3, "extraterrestre*": 3, "holograma*": 3, "nave*": 0.6,
        },
        "contemporary_thriller": {
            "policia*": 1.5, "pistola*": 2, "disparo*": 1, "agente*": 1, "cadaver*": 1.5, "forense*": 2.5,
            "sospechos*": 1.5, "comisaria*": 2.5, "fbi": 3, "cia": 2, "movil": 1.5, "telefono*": 1,
            "ordenador*": 1.5, "hacker*": 3, "secuestr*": 2, "terrorist*": 2.5, "asesino*": 1.5, "homicidio*": 2.5,
        },
        "mystery_noir": {
            "detective*": 3, "inspector*": 2, "crimen*": 2, "misterio*": 1, "pista*": 1, "coartada*": 3,
            "testigo*": 1.5, "whisky": 1.5, "cigarr*": 1, "callejon*": 1.5, "gabardina*": 2.5,
            "investigacion": 1, "asesinato*": 2, "culpable*": 1, "interrogatorio*": 2,
        },
        "romance_warm": {
            "amor": 1.5, "enamor*": 2.5, "beso*": 2, "besar*": 2, "corazon": 1, "boda*": 2, "caricia*": 2,
            "abrazo*": 1, "amante*": 1.5, "novio*": 1.5, "novia*": 1.5, "carino": 1, "deseo": 1, "labios": 1.5,
            "romance": 2, "romantic*": 2,
        },
        "historical": {
            "siglo": 1, "corte": 0.8, "duque*": 1.5, "duquesa*": 2, "conde": 1.2, "condesa*": 2, "marques*": 1.5,
            "carruaje*": 1.5, "monasterio*": 1.5, "abadia*": 1.5, "rey": 0.8, "reina": 0.8, "caballeros": 0.8,
            "batalla*": 0.8, "monje*": 1.2, "nobleza": 1.2, "siervo*": 1.2, "gremio*": 1.5, "virrey*": 2.5,
            "inquisicion": 2, "corsario*": 2, "galeon*": 2.5,
        },
        "classic_novel": {
            "señora": 0.8, "señorita": 1.2, "carta*": 1, "salon*": 1, "baile*": 1, "matrimonio*": 1.5,
            "herencia*": 1.2, "sociedad": 0.6, "criada*": 1.5, "mayordomo*": 2, "institutriz": 3, "vicario*": 2,
            "parroquia*": 1, "finca*": 1, "hacienda*": 1, "tertulia*": 2,
        },
        "nonfiction_minimal": {
            "estudio*": 1, "investigacion*": 1.2, "datos": 1.5, "por ejemplo": 2, "es decir": 1.5, "segun": 0.6,
            "porcentaje*": 2, "economi*": 1.5, "ciencia*": 1.2, "cientific*": 1.5, "investigador*": 1.5,
            "sistema*": 0.8, "proceso*": 0.8, "teoria*": 1.2, "analisis": 1.5, "concepto*": 1.5, "capitulo": 0.3,
        },
    },
    "en": {
        "dark_fantasy": {
            "magic": 2, "wizard*": 2, "sorcer*": 2, "witch*": 2, "spell*": 1, "demon*": 1.5, "curse*": 1.5,
            "prophec*": 2, "necromanc*": 3, "rune*": 1.5, "gods": 1, "empire": 1, "emperor": 1, "throne": 1,
            "sword*": 1, "siege": 1.2, "inquisitor*": 2, "lord": 0.6, "creature*": 1, "monster*": 1, "powers": 1,
        },
        "bright_fantasy": {
            "adventure*": 1.5, "elf": 3, "elves": 3, "dwarf*": 2, "fairy": 2.5, "fairies": 2.5, "goblin*": 2,
            "dragon*": 2, "treasure*": 1, "quest*": 1.5, "princess*": 1.2, "prince": 1, "knight*": 0.6,
            "castle*": 0.8, "kingdom*": 0.8, "unicorn*": 3, "wand*": 2,
        },
        "scifi_space": {
            "spaceship*": 3, "starship*": 3, "planet*": 2, "galax*": 3, "robot*": 2.5, "android*": 3, "laser*": 2,
            "orbit*": 2, "astronaut*": 3, "hyperspace": 3, "alien*": 2, "hologram*": 3, "spacecraft": 3,
        },
        "contemporary_thriller": {
            "police": 1.5, "gun*": 1.5, "pistol*": 2, "agent*": 1, "corpse*": 1.5, "forensic*": 2.5, "suspect*": 1.5,
            "fbi": 3, "cia": 2, "phone*": 1, "cellphone*": 2, "computer*": 1.5, "hacker*": 3, "kidnap*": 2,
            "terrorist*": 2.5, "killer*": 1.5, "homicide*": 2.5,
        },
        "mystery_noir": {
            "detective*": 3, "inspector*": 2, "crime*": 2, "mystery": 1, "clue*": 1.5, "alibi*": 3, "witness*": 1.5,
            "whisky": 1.5, "whiskey": 1.5, "cigarette*": 1, "alley*": 1.5, "trench coat": 2.5, "murder*": 2,
            "culprit*": 2, "interrogat*": 2,
        },
        "romance_warm": {
            "love": 1, "lover*": 1.5, "kiss*": 2, "heart": 0.6, "wedding*": 2, "caress*": 2, "embrace*": 1,
            "darling": 1.5, "desire": 1, "lips": 1.5, "romance": 2, "romantic": 2, "fiance*": 2,
        },
        "historical": {
            "century": 1, "court": 0.6, "duke*": 1.5, "duchess*": 2, "countess*": 2, "marquis*": 2, "carriage*": 1.5,
            "monaster*": 1.5, "abbey*": 1.5, "king": 0.8, "queen": 0.8, "knights": 0.8, "battle*": 0.8, "monk*": 1.2,
            "nobility": 1.2, "serf*": 2, "guild*": 1.5, "galleon*": 2.5, "musket*": 2.5,
        },
        "classic_novel": {
            "madam": 1, "mrs": 0.8, "letter*": 1, "drawing room": 2.5, "ball": 0.6, "marriage*": 1.5,
            "inheritance*": 1.2, "society": 0.6, "maid*": 1, "butler*": 2, "governess*": 3, "vicar*": 2,
            "parish*": 1, "estate*": 0.8, "parlour*": 2, "parlor*": 2,
        },
        "nonfiction_minimal": {
            "study": 1, "studies": 1.2, "research*": 1.2, "data": 1.5, "for example": 2, "that is": 0.5,
            "according to": 1, "percent*": 2, "econom*": 1.5, "scien*": 1.2, "researcher*": 1.5, "system*": 0.8,
            "process*": 0.8, "theor*": 1.2, "analysis": 1.5, "concept*": 1.5,
        },
    },
}
_PALETTE_LEX = {lang: reader_ambience._compile(terms) for lang, terms in _PALETTE_TERMS.items()}
#: A term counts at most this many times per 10 000 words (a recurring name must not decide).
_PALETTE_TERM_CAP = 25.0
#: Rules are decisive (no LLM asked) when the best palette beats the next by this factor.
PALETTE_DECISIVE = 1.4
#: Ambience tags that colour the palette (share of the text → bonus).
_TAG_BONUS = {
    "mist": {"dark_fantasy": 60, "mystery_noir": 20},
    "cave": {"dark_fantasy": 40, "bright_fantasy": 15},
    "night": {"dark_fantasy": 20, "mystery_noir": 20},
    "storm": {"dark_fantasy": 15},
    "city": {"contemporary_thriller": 40, "mystery_noir": 30},
    "sea": {"bright_fantasy": 30, "historical": 25},
    "forest": {"bright_fantasy": 30, "historical": 10},
    "river": {"bright_fantasy": 20, "historical": 10},
    "road": {"historical": 25, "bright_fantasy": 20},
    "snow": {"bright_fantasy": 15, "dark_fantasy": 10},
    "temple": {"historical": 30, "dark_fantasy": 15},
    "tavern": {"historical": 20, "bright_fantasy": 20, "dark_fantasy": 10},
    "town": {"historical": 25, "dark_fantasy": 15},
    "library": {"classic_novel": 25, "nonfiction_minimal": 10},
    "interior": {"classic_novel": 20},
}
_BASE_SCORE = {"classic_novel": 5.0, "nonfiction_minimal": 3.0}
_ERA_FACTOR = {
    "historic": {"contemporary_thriller": 0.25, "mystery_noir": 0.6, "romance_warm": 0.9},
    "modern": {"dark_fantasy": 0.7, "bright_fantasy": 0.7, "historical": 0.5, "classic_novel": 0.7},
}


_DIALOGUE_LEAD = frozenset("—–«\"“‘")


def _is_dialogue(text: str) -> bool:
    """A paragraph opening with a dialogue dash or a quote ("-Hola" and "'Hi" too)."""
    stripped = (text or "").lstrip()
    if len(stripped) < 2:
        return False
    if stripped[0] in _DIALOGUE_LEAD:
        return True
    return stripped[0] in "-'" and (stripped[1].isalpha() or stripped[1] in "¿¡")


def dialogue_flags(segments: Sequence[dict]) -> list[bool]:
    """Per segment: part of a dialogue paragraph (its first segment opens with a dash or quote)."""
    flags: list[bool] = []
    current = False
    last_para: object = object()
    for position, seg in enumerate(segments):
        para = seg.get("para", seg.get("i", position))
        if para != last_para:
            current = seg.get("kind") in (None, "p") and _is_dialogue(str(seg.get("text") or ""))
            last_para = para
        flags.append(current)
    return flags


def palette_scores(
    texts: Sequence[str],
    *,
    language: Optional[str],
    title: str = "",
    author: str = "",
    era: str = "modern",
    dialogue_share: float = 0.3,
    tag_share: Optional[dict] = None,
    source_type: Optional[str] = None,
) -> dict[str, float]:
    """Rule scores per palette (higher = better fit)."""
    scores = {pid: _BASE_SCORE.get(pid, 0.0) for pid in PALETTE_IDS}
    lexicon = _PALETTE_LEX.get(language or "")
    if lexicon is not None:
        hits: dict[tuple[str, str], int] = {}
        weights: dict[tuple[str, str], float] = {}
        words = 0
        for text in texts:
            tokens = reader_ambience.tokenize(text)
            words += len(tokens)
            for token in tokens:
                for term, pid, weight in lexicon.matches(token):
                    hits[(pid, term)] = hits.get((pid, term), 0) + 1
                    weights[(pid, term)] = weight
            if lexicon.phrases and len(tokens) > 1:
                joined = f" {' '.join(tokens)} "
                for needle, term, pid, weight in lexicon.phrases:
                    found = joined.count(needle)
                    if found:
                        hits[(pid, term)] = hits.get((pid, term), 0) + found
                        weights[(pid, term)] = weight
        per = max(words, 2000) / 10_000.0
        for key, count in hits.items():
            scores[key[0]] += weights[key] * min(count / per, _PALETTE_TERM_CAP)
        for token in reader_ambience.tokenize(f"{title} {author}"):
            for _term, pid, weight in lexicon.matches(token):
                scores[pid] += weight * 15
        if words >= 2000 and dialogue_share < 0.03:
            for pid in PALETTE_IDS:
                if pid != "nonfiction_minimal":
                    scores[pid] *= 0.6
            scores["nonfiction_minimal"] += 30
    for pid, factor in _ERA_FACTOR.get(era, {}).items():
        scores[pid] *= factor
    for tag, share in (tag_share or {}).items():
        for pid, bonus in _TAG_BONUS.get(tag, {}).items():
            if pid in ("dark_fantasy", "historical", "bright_fantasy") and era == "modern":
                bonus *= 0.5
            scores[pid] += bonus * float(share)
    if source_type == "url":
        scores["nonfiction_minimal"] += 20
    return {pid: round(score, 2) for pid, score in scores.items()}


def rank_palettes(scores: dict[str, float]) -> tuple[str, bool]:
    """``(best palette, decisive)`` — decisive when it clearly beats the runner-up."""
    ranked = sorted(scores.items(), key=lambda kv: (-kv[1], PALETTE_IDS.index(kv[0])))
    best, runner = ranked[0], ranked[1]
    return best[0], best[1] >= 10 and best[1] >= PALETTE_DECISIVE * max(runner[1], 0.01)


_PALETTE_HELP = {
    "dark_fantasy": "dark or epic fantasy, magic, empires, war, shadows",
    "bright_fantasy": "light fantasy adventure, quests, fairy tales",
    "classic_novel": "literary or classic fiction, family and society, intimate",
    "contemporary_thriller": "present-day thriller, crime, police, technology",
    "mystery_noir": "detective mystery, noir, investigation",
    "romance_warm": "romance, love story",
    "scifi_space": "science fiction, space, the future",
    "historical": "historical fiction in a real past era",
    "nonfiction_minimal": "non-fiction: essays, science, history, self-help, articles",
}
_LLM_SYSTEM = "You choose background music for audiobooks. You answer with one JSON object and nothing else."


def palette_question(title: str, author: str, excerpt: str) -> tuple[str, dict]:
    options = "\n".join(f"- {pid}: {_PALETTE_HELP[pid]}" for pid in PALETTE_IDS)
    user = (
        f"Book title: {title or '-'}\nAuthor: {author or '-'}\nOpening text:\n{excerpt}\n\n"
        f"Which music palette suits the whole book best?\n{options}\n"
        'Answer {"palette": "<id>"}.'
    )
    schema = {"type": "object", "properties": {"palette": {"type": "string", "enum": list(PALETTE_IDS)}}, "required": ["palette"]}
    return user, schema


def mood_question(excerpt: str) -> tuple[str, dict]:
    user = (
        f"Chapter excerpt:\n{excerpt}\n\nWhich mood should the quiet background music of this chapter have? "
        f"One of: {', '.join(MOODS)}. Answer {{\"mood\": \"<mood>\"}}."
    )
    schema = {"type": "object", "properties": {"mood": {"type": "string", "enum": list(MOODS)}}, "required": ["mood"]}
    return user, schema


# ── Mood per scene ───────────────────────────────────────────────────────────
_MOOD_TERMS: dict[str, dict[str, dict[str, float]]] = {
    "es": {
        "tension": {
            "peligro*": 2, "amenaz*": 2, "ataque*": 2, "atac*": 1.5, "lucha*": 1.5, "pelea*": 1.5, "golpe*": 0.5,
            "persegu*": 2, "huir": 2, "huyo": 1.5, "huye*": 1.5, "escap*": 1.2, "corrio": 1, "grito*": 1.2,
            "grit*": 1, "tension": 2, "tenso*": 2, "nervios*": 1.5, "acech*": 2, "daga*": 1, "cuchillo*": 1,
            "flecha*": 1, "disparo*": 2, "dispar*": 1.5, "sangre": 1, "herid*": 1, "urgente": 1.5, "deprisa": 1,
            "alarma*": 2, "enemig*": 1.2, "combat*": 2, "batalla*": 1.5, "emboscada*": 2.5, "trampa*": 1,
            "cuidado": 0.8, "de repente": 1, "a punto de": 0.6,
        },
        "dread": {
            "muerte": 1.5, "muerto*": 1.5, "cadaver*": 2.5, "terror": 2.5, "horror*": 2.5, "horrib*": 2,
            "pavor": 2.5, "espanto*": 2, "aterr*": 2, "siniestr*": 2.5, "ominos*": 2.5, "macabr*": 2.5,
            "tumba*": 1.5, "monstruo*": 2, "pesadilla*": 2, "tinieblas": 2, "escalofri*": 2, "miedo": 1.2,
            "temor": 1, "oscuridad": 0.6, "sombra*": 0.6, "demonio*": 1.5, "fantasma*": 1.5, "espectr*": 1.5,
            "podrid*": 1.5, "hedor": 1.5, "putrefac*": 2, "criatura*": 1,
        },
        "melancholy": {
            "triste*": 2.5, "tristeza": 2.5, "llor*": 2, "lagrima*": 2.5, "pena": 1.5, "dolor": 1, "soledad": 2,
            "recuerd*": 0.8, "nostalgi*": 2.5, "luto": 2.5, "añor*": 2.5, "lament*": 1.5, "melancol*": 2.5,
            "suspir*": 0.6, "echaba de menos": 2, "vacio": 1, "abatid*": 2, "desconsol*": 2.5, "funeral*": 2.5,
            "perdida": 1.5, "pesadumbre": 2.5,
        },
        "warmth": {
            "sonri*": 1.5, "sonrisa*": 1.5, "risa*": 1.5, "reia*": 1.5, "reir": 1.2, "abraz*": 2, "amig*": 0.5,
            "carino*": 2.5, "ternura": 2.5, "tierno*": 1.5, "calid*": 1, "amor": 1.2, "querid*": 1, "beso*": 1.5,
            "familia": 0.8, "hogar": 1, "alegr*": 1.5, "feliz": 1.5, "felices": 1.5, "carcajada*": 1.5,
            "consol*": 1, "agradec*": 1,
        },
        "wonder": {
            "maravill*": 2.5, "asombr*": 2, "brill*": 1, "estrellas": 1, "inmens*": 1.5, "belleza": 2,
            "hermos*": 1.5, "magia": 1, "magnific*": 2, "esplendor*": 2, "deslumbr*": 2, "resplandec*": 1.5,
            "prodigi*": 2, "majestu*": 2, "fascin*": 1.5, "sobrecog*": 2, "vasto*": 1,
            "infinit*": 1,
        },
        "calm": {
            "tranquil*": 2, "calma": 2, "calmad*": 1.5, "silencio*": 0.8, "paz": 1.5, "seren*": 2, "descans*": 1.5,
            "suave*": 1, "lentamente": 0.8, "reposo": 1.5, "sosieg*": 2, "apacible*": 2, "dormi*": 0.8,
            "placid*": 2, "relaj*": 1.5, "quiet*": 1,
        },
        "resolve": {
            "por fin": 2, "finalmente": 0.5, "victoria*": 2.5, "venci*": 1.5, "triunf*": 2.5, "esperanza*": 2,
            "alivio": 2.5, "aliviad*": 2, "salvad*": 1.5, "a salvo": 2, "logr*": 1, "celebr*": 1.5,
            "amanecer": 1, "amanecio": 1.2,
        },
    },
    "en": {
        "tension": {
            "danger*": 2, "threat*": 2, "attack*": 2, "fight*": 1.5, "struggl*": 1.2, "chase*": 2, "chasing": 2,
            "flee*": 2, "fled": 2, "escap*": 1.2, "shout*": 1.2, "scream*": 1.2, "tense*": 2, "tension": 2,
            "nervous*": 1.5, "lurk*": 2, "stalk*": 2, "dagger*": 1, "knife": 1, "arrow*": 1, "shot": 1.2,
            "shots": 1.5, "gun*": 1.2, "blood": 1, "wound*": 1, "hurr*": 1, "alarm*": 2, "enemy": 1.2,
            "enemies": 1.2, "battle*": 1.5, "ambush*": 2.5, "trap*": 1, "careful*": 0.8, "pounding": 1.5,
            "suddenly": 1,
        },
        "dread": {
            "death": 1.5, "dead": 1.2, "corpse*": 2.5, "terror": 2.5, "horror*": 2.5, "horrif*": 2.5, "dread*": 2.5,
            "sinister": 2.5, "ominous*": 2.5, "macabre": 2.5, "tomb*": 1.5, "monster*": 2, "nightmare*": 2,
            "fear": 1.2, "feared": 1.2, "afraid": 1, "darkness": 0.6, "shadow*": 0.6, "creature*": 1, "demon*": 1.5,
            "ghost*": 1.5, "stench": 1.5, "shiver*": 1.5, "rotting": 1.5,
        },
        "melancholy": {
            "sad": 2, "sadly": 2, "sadness": 2.5, "sorrow*": 2.5, "grief": 2.5, "griev*": 2.5, "tears": 2, "wept": 2,
            "weep*": 2, "cried": 1.5, "crying": 1.5, "mourn*": 2.5, "lonely": 2, "loneliness": 2.5, "memories": 1,
            "nostalg*": 2.5, "longing": 2, "regret*": 1.5, "sigh*": 1, "funeral*": 2.5, "loss": 1.2, "melanchol*": 2.5,
        },
        "warmth": {
            "smil*": 1.5, "laugh*": 1.5, "hug*": 2, "embrac*": 2, "friend*": 0.8, "tender*": 2, "warmly": 1.5,
            "love": 1.2, "loved": 1.2, "darling": 1.5, "kiss*": 1.5, "family": 0.8, "joy*": 1.5, "happy": 1.5,
            "happiness": 1.5, "comfort*": 1, "cheer*": 1.2, "giggl*": 1.5, "grin*": 1, "grateful": 1,
        },
        "wonder": {
            "wonder*": 2, "awe": 2.5, "amaz*": 2, "marvel*": 2.5, "glow*": 1, "shimmer*": 1.5, "sparkl*": 1.5,
            "stars": 1, "vast": 1.5, "beaut*": 1.5, "magic*": 1, "magnific*": 2, "splendo*": 2, "dazzl*": 2,
            "radian*": 1.5, "majest*": 2, "fascinat*": 1.5, "breathtak*": 2.5, "infinite": 1,
        },
        "calm": {
            "calm*": 2, "quiet*": 1, "peace*": 1.5, "seren*": 2, "gentle": 1, "gently": 1, "stillness": 2,
            "silence": 0.8, "tranquil*": 2, "sleep*": 0.8, "drows*": 1.5, "placid*": 2, "relax*": 1.5, "lazily": 1,
        },
        "resolve": {
            "at last": 2, "finally": 1, "victory": 2.5, "victorious": 2.5, "triumph*": 2.5, "hope": 1.5,
            "hopeful": 2, "relief": 2.5, "relieved": 2.5, "safe": 1.2, "saved": 1.5, "celebrat*": 1.5, "dawn": 1,
        },
    },
}
_MOOD_LEX = {lang: reader_ambience._compile(terms) for lang, terms in _MOOD_TERMS.items()}
#: A window needs this many weighted mood words per 100 words (and in total) to have a mood.
MOOD_MIN_DENSITY = 0.9
MOOD_MIN_WEIGHT = 3.0
MOOD_MARGIN = 1.25
#: Evidence strong enough to change the music inside a section.
MOOD_STRONG_DENSITY = 2.0
#: Exclamations raise tension (arousal), up to this many per window.
_EXCLAMATION_WEIGHT = 0.25
_MAX_EXCLAMATIONS = 8
#: When few moods fit the cue budget, the rarest borrow a neighbour's cue.
_MOOD_FALLBACK = {
    "resolve": ("warmth", "calm"), "wonder": ("calm", "warmth"), "dread": ("tension", "melancholy"),
    "melancholy": ("calm", "warmth"), "warmth": ("calm", "resolve"), "tension": ("dread", "calm"),
    "calm": ("warmth", "melancholy"),
}
_DARK_MOODS = frozenset({"tension", "dread", "melancholy"})


def mood_names(texts: Sequence[str], language: Optional[str]) -> frozenset[str]:
    """Mood words used as names in this document ("Fantasma", "Esperanza")."""
    lexicon = _MOOD_LEX.get(language or "")
    return reader_ambience.proper_names(texts, language or "", lexicon) if lexicon is not None else frozenset()


def mood_scores(
    text: str, language: Optional[str], *, ignore: frozenset[str] = frozenset()
) -> tuple[dict[str, float], int]:
    """Weighted mood-word hits (a term counts at most 3 times; ``ignore`` holds
    words that are names in this document) and the word count."""
    words = [w for w in reader_ambience.tokenize(text) if w not in ignore] if ignore else reader_ambience.tokenize(text)
    lexicon = _MOOD_LEX.get(language or "")
    if lexicon is None:
        return {}, len(words)
    scores: dict[str, float] = {}
    counted: dict[str, int] = {}

    def add(term: str, mood: str, weight: float) -> None:
        key = f"{mood}:{term}"
        if counted.get(key, 0) >= 3:
            return
        counted[key] = counted.get(key, 0) + 1
        scores[mood] = scores.get(mood, 0.0) + weight

    for word in words:
        for term, mood, weight in lexicon.matches(word):
            add(term, mood, weight)
    if lexicon.phrases:
        joined = f" {' '.join(words)} "
        for needle, term, mood, weight in lexicon.phrases:
            for _ in range(min(3, joined.count(needle))):
                add(term, mood, weight)
    exclamations = min(text.count("!"), _MAX_EXCLAMATIONS)
    if exclamations:
        scores["tension"] = scores.get("tension", 0.0) + exclamations * _EXCLAMATION_WEIGHT
    return scores, len(words)


def classify_mood(scores: dict[str, float], words: int) -> tuple[Optional[str], float]:
    """``(mood, density)`` or ``(None, 0)`` when the evidence is weak or split."""
    if not scores:
        return None, 0.0
    span = max(words, 150) / 100.0
    ranked = sorted(scores.items(), key=lambda kv: (-kv[1], MOODS.index(kv[0])))
    best, weight = ranked[0]
    density = weight / span
    runner = ranked[1][1] if len(ranked) > 1 else 0.0
    if weight < MOOD_MIN_WEIGHT or density < MOOD_MIN_DENSITY or weight < MOOD_MARGIN * runner:
        return None, 0.0
    return best, round(density, 2)


#: A chapter's overall mood (its quiet windows' prior): weaker density, clearer margin.
CHAPTER_MIN_DENSITY = 0.8
CHAPTER_MARGIN = 1.4


def _chapter_mood(scores: dict[str, float], words: int) -> Optional[str]:
    if not scores:
        return None
    ranked = sorted(scores.items(), key=lambda kv: (-kv[1], MOODS.index(kv[0])))
    best, weight = ranked[0]
    runner = ranked[1][1] if len(ranked) > 1 else 0.0
    if weight / (max(words, 150) / 100.0) < CHAPTER_MIN_DENSITY or weight < CHAPTER_MARGIN * runner:
        return None
    return best


# ── Plan: timeline (hysteresis) and spots ───────────────────────────────────


@dataclass
class _Run:
    mood: str
    first: int  # window indices, inclusive
    last: int
    chars: int
    strong: bool


def _runs(moods: list[str], windows, strong: list[bool]) -> list[_Run]:
    runs: list[_Run] = []
    for i, mood in enumerate(moods):
        if runs and runs[-1].mood == mood:
            run = runs[-1]
            run.last, run.chars, run.strong = i, run.chars + windows[i].chars, run.strong or strong[i]
        else:
            runs.append(_Run(mood, i, i, windows[i].chars, strong[i]))
    return runs


def _merge_equal(runs: list[_Run]) -> list[_Run]:
    merged: list[_Run] = []
    for run in runs:
        if merged and merged[-1].mood == run.mood:
            last = merged[-1]
            last.last, last.chars, last.strong = run.last, last.chars + run.chars, last.strong or run.strong
        else:
            merged.append(run)
    return merged


def _hard_boundary(windows, i: int) -> bool:
    return i == 0 or windows[i].section != windows[i - 1].section or windows[i].chapter != windows[i - 1].chapter


def _absorb_short(runs: list[_Run], min_chars: int) -> list[_Run]:
    """Hysteresis: a run shorter than ``min_chars`` joins a neighbour (the one it
    sits between when both agree, else the previous one: the music carries on)."""
    while len(runs) > 1:
        short = [k for k, r in enumerate(runs) if r.chars < min_chars]
        if not short:
            break
        k = min(short, key=lambda j: (runs[j].chars, j))
        # The absorbed run's evidence does not make its new neighbour "strong".
        runs[k].mood, runs[k].strong = (runs[k - 1].mood if k > 0 else runs[1].mood), False
        runs = _merge_equal(runs)
    return runs


def timeline_moods(
    windows,
    window_moods: list[tuple[Optional[str], float]],
    chapter_moods: dict[int, str],
    *,
    default: str = DEFAULT_MOOD,
    max_cues: int = MAX_CUES,
    min_chars: int = int(MIN_CUE_SECONDS * CHARS_PER_SECOND),
) -> list[_Run]:
    """Mood runs over the windows: lexicon moods, chapter priors for quiet
    windows, changes inside a section only on strong evidence, every run at
    least ``min_chars`` long, and at most ``max_cues`` distinct moods."""
    if not windows:
        return []
    base = [mood or chapter_moods.get(w.chapter) or default for w, (mood, _d) in zip(windows, window_moods)]
    strong = [bool(mood) and density >= MOOD_STRONG_DENSITY for mood, density in window_moods]
    runs = _absorb_short(_runs(base, windows, strong), min_chars)
    # Inside a section, the music only changes on strong evidence (or after a long
    # stretch of something else: a tense passage does not colour a quiet chapter end).
    for k in range(1, len(runs)):
        if not _hard_boundary(windows, runs[k].first) and not runs[k].strong and runs[k].chars < 2 * min_chars:
            runs[k].mood = runs[k - 1].mood
    runs = _absorb_short(_merge_equal(runs), min_chars)
    # Cue budget: the rarest moods borrow the closest kept mood.
    totals: dict[str, int] = {}
    for run in runs:
        totals[run.mood] = totals.get(run.mood, 0) + run.chars
    kept = {m for m, _c in sorted(totals.items(), key=lambda kv: (-kv[1], MOODS.index(kv[0])))[:max_cues]}
    if len(kept) < len(totals):
        most = max(totals, key=lambda m: totals[m])
        for run in runs:
            if run.mood not in kept:
                run.mood = next((m for m in _MOOD_FALLBACK.get(run.mood, ()) if m in kept), most)
        runs = _merge_equal(runs)
    return runs


def _seconds(chars: int) -> float:
    return chars / CHARS_PER_SECOND


@dataclass
class _Candidate:
    window: int
    priority: int  # 3 chapter start, 2 strong mood shift, 1 scene break
    want: float  # seconds


def build_spots(
    segments: Sequence[dict],
    windows,
    runs: list[_Run],
    dialogue: list[bool],
    *,
    scale: Optional[float] = None,
) -> tuple[list[dict], float]:
    """Spots ("moments") and their share of the listening time."""
    if not windows or not runs:
        return [], 0.0
    sizes = [len(str(seg.get("text") or "")) for seg in segments]
    prefix = [0]
    for size in sizes:
        prefix.append(prefix[-1] + size)
    total_s = _seconds(prefix[-1]) or 1.0
    run_of = [0] * len(windows)
    for k, run in enumerate(runs):
        for i in range(run.first, run.last + 1):
            run_of[i] = k
    section_end = [0] * len(windows)
    end = len(windows) - 1
    for i in range(len(windows) - 1, -1, -1):
        section_end[i] = end
        if i > 0 and _hard_boundary(windows, i):
            end = i - 1

    def dialogue_share(w) -> float:
        chars = sum(sizes[s] for s in range(w.start, w.end + 1))
        talk = sum(sizes[s] for s in range(w.start, w.end + 1) if dialogue[s])
        return talk / chars if chars else 0.0

    dense = [dialogue_share(w) > DIALOGUE_DENSE for w in windows]
    candidates: list[_Candidate] = []
    for i, window in enumerate(windows):
        priority, want = 0, 0.0
        if i == 0 or window.chapter != windows[i - 1].chapter:
            priority, want = 3, 120.0
        elif window.section != windows[i - 1].section:
            priority, want = 1, 75.0
        k = run_of[i]
        if k > 0 and runs[k].first == i:
            previous = runs[k - 1].mood
            shift = (runs[k].mood in _DARK_MOODS) != (previous in _DARK_MOODS) or runs[k].mood == "dread"
            if shift and runs[k].strong and priority < 2:
                priority, want = 2, 90.0
        if priority and not dense[i]:
            candidates.append(_Candidate(i, priority, want))

    def extent(c: _Candidate, want: float) -> Optional[dict]:
        first = windows[c.window]
        last_window = min(section_end[c.window], runs[run_of[c.window]].last)
        for j in range(c.window + 1, last_window + 1):
            if dense[j]:
                last_window = j - 1
                break
        limit = windows[last_window].end
        start = first.start
        stop = start
        while stop < limit and _seconds(prefix[stop + 1] - prefix[start]) < want:
            stop += 1
        seconds = _seconds(prefix[stop + 1] - prefix[start])
        if seconds < 30.0:
            return None
        return {
            "start_segment": int(segments[start].get("i", start)),
            "end_segment": int(segments[stop].get("i", stop)),
            "cue": runs[run_of[c.window]].mood,
            "max_seconds": round(min(want, seconds), 1),
            "_priority": c.priority,
        }

    min_gap = int(120.0 * CHARS_PER_SECOND)

    def build(factor: float) -> tuple[list[dict], float]:
        spots: list[dict] = []
        for c in candidates:
            want = max(SPOT_MIN_SECONDS, min(SPOT_MAX_SECONDS, c.want * factor))
            spot = extent(c, want)
            if spot is None:
                continue
            if spots:
                gap = prefix[spot["start_segment"]] - prefix[spots[-1]["end_segment"] + 1]
                if gap < min_gap:
                    if spot["_priority"] > spots[-1]["_priority"]:
                        spots[-1] = spot
                    continue
            spots.append(spot)
        covered = sum(s["max_seconds"] for s in spots) / total_s
        return spots, covered

    if scale is not None:
        spots, covered = build(scale)
    else:
        # Spot lengths scaled towards the target share of the listening time.
        options = [build(factor) for factor in (0.5, 0.6, 0.7, 0.85, 1.0, 1.25, 1.5)]
        spots, covered = min(options, key=lambda o: (abs(o[1] - COVERAGE_TARGET), -o[1]))
        # Still too much music: thin out the least important spots, evenly.
        while covered > COVERAGE_MAX and len(spots) > 1:
            k = min(
                range(1, len(spots)),
                key=lambda j: (spots[j]["_priority"], prefix[spots[j]["start_segment"]] - prefix[spots[j - 1]["end_segment"] + 1]),
            )
            covered -= spots[k]["max_seconds"] / total_s
            del spots[k]
    for spot in spots:
        spot.pop("_priority", None)
    return spots, round(covered, 4)


def _chapter_excerpts(windows, limit_head: int = 1200, limit_tail: int = 500) -> dict[int, str]:
    texts: dict[int, list[str]] = {}
    for window in windows:
        texts.setdefault(window.chapter, []).append(window.text)
    excerpts = {}
    for chapter, parts in texts.items():
        text = " ".join(parts).strip()
        if len(text) < 600:
            continue
        excerpts[chapter] = text if len(text) <= limit_head + limit_tail else f"{text[:limit_head]} […] {text[-limit_tail:]}"
    return excerpts


def opening_excerpt(segments: Sequence[dict], limit: int = 2000) -> str:
    """~2 000 characters of real prose from the start (skips titles, index lines)."""
    parts: list[str] = []
    size = 0
    for seg in segments:
        text = str(seg.get("text") or "").strip()
        if seg.get("kind") not in (None, "p") or len(text) < 120:
            continue
        parts.append(text)
        size += len(text) + 1
        if size >= limit:
            break
    return " ".join(parts)[:limit]


def build_plan(
    segments: Sequence[dict],
    chapters: Sequence[dict] = (),
    *,
    title: str = "",
    author: str = "",
    language: Optional[str] = None,
    source_type: Optional[str] = None,
    ambience_scenes: Optional[Sequence[dict]] = None,
    palette_answer: Optional[str] = None,
    chapter_moods: Optional[dict[int, str]] = None,
    position: int = 0,
) -> dict:
    """The music plan of a document (pure; the LLM answers are inputs)."""
    lang = reader_ambience.document_language(segments, language)
    texts = [str(seg.get("text") or "") for seg in segments]
    era = reader_ambience.document_era(texts, lang)
    dialogue = dialogue_flags(segments)
    sizes = [len(t) for t in texts]
    total = sum(sizes) or 1
    dialogue_share = sum(s for s, d in zip(sizes, dialogue) if d) / total
    tag_share: dict[str, float] = {}
    for scene in ambience_scenes or ():
        tag = scene.get("tag")
        if tag and tag != reader_ambience.NONE:
            chars = sum(sizes[i] for i in range(int(scene["start_segment"]), min(int(scene["end_segment"]) + 1, len(sizes))))
            tag_share[tag] = tag_share.get(tag, 0.0) + chars / total
    scores = palette_scores(
        texts, language=lang, title=title, author=author, era=era, dialogue_share=dialogue_share,
        tag_share=tag_share, source_type=source_type,
    )
    best, decisive = rank_palettes(scores)
    palette, why = best, "rules"
    if not decisive and palette_answer in PALETTES:
        palette, why = palette_answer, "llm"
    windows = reader_ambience.split_windows(segments, chapters)
    names = mood_names(texts, lang)
    window_scores = [mood_scores(w.text, lang, ignore=names) for w in windows]
    window_moods = [classify_mood(*found) for found in window_scores]
    priors: dict[int, str] = {}
    by_chapter: dict[int, list[int]] = {}
    for i, window in enumerate(windows):
        by_chapter.setdefault(window.chapter, []).append(i)
    for chapter, members in by_chapter.items():
        if chapter_moods and chapter_moods.get(chapter) in MOODS:
            priors[chapter] = chapter_moods[chapter]
            continue
        total_scores: dict[str, float] = {}
        words = 0
        for i in members:
            scores_i, words_i = window_scores[i]
            words += words_i
            for mood, weight in scores_i.items():
                total_scores[mood] = total_scores.get(mood, 0.0) + weight
        mood = _chapter_mood(total_scores, words)
        if mood:
            priors[chapter] = mood
    runs = timeline_moods(windows, window_moods, priors)
    timeline = [
        {
            "start_segment": int(segments[windows[r.first].start].get("i", windows[r.first].start)),
            "end_segment": int(segments[windows[r.last].end].get("i", windows[r.last].end)),
            "cue": r.mood,
        }
        for r in runs
    ]
    spots, coverage = build_spots(segments, windows, runs, dialogue)
    return {
        "palette": palette,
        "palette_why": why,
        "palette_scores": scores,
        "era": era,
        "language": lang,
        "dialogue_share": round(dialogue_share, 3),
        "timeline": timeline,
        "spots": spots,
        "coverage": coverage,
        "moods": cue_order(timeline, spots, position),
    }


def cue_order(timeline: Sequence[dict], spots: Sequence[dict], position: int = 0) -> list[str]:
    """Moods in order of first use from the listening position (spots first:
    they are the default mode), then the rest of the timeline."""
    order: list[str] = []

    def walk(items: Sequence[dict]) -> None:
        ahead = [s for s in items if s["end_segment"] >= position]
        behind = [s for s in items if s["end_segment"] < position]
        for item in ahead + behind:
            if item["cue"] not in order:
                order.append(item["cue"])

    walk(spots)
    walk(timeline)
    return order


# ── Storage ──────────────────────────────────────────────────────────────────

_FILE_RE = re.compile(r"^[a-z_]+-[a-z]+-[1-9]-[0-9a-f]{8}(\.c[0-9])?\.ogg$")
_file_lock = threading.RLock()


def _path(doc_id: str) -> str:
    return os.path.join(reader_store.document_dir(doc_id), MUSIC_FILE)


def audio_dir(doc_id: str) -> str:
    return os.path.join(engine.music_dir(), doc_id)


def _read_json(path: str) -> dict:
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _write_json(path: str, payload: dict) -> None:
    tmp = f"{path}.{os.getpid()}.{threading.get_ident()}.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)


def load_state(doc_id: str) -> dict:
    return _read_json(_path(doc_id))


def _update_state(doc_id: str, **fields) -> dict:
    """Read-modify-write of ``music.json`` (``None`` removes a field)."""
    with _file_lock:
        path = _path(doc_id)
        if not os.path.isdir(os.path.dirname(path)):
            raise reader_store.DocumentNotFound(doc_id)
        state = _read_json(path)
        for key, value in fields.items():
            if value is None:
                state.pop(key, None)
            else:
                state[key] = value
        _write_json(path, state)
        return state


def _fresh(state: dict, segments: Sequence[dict], language: Optional[str]) -> bool:
    return (
        state.get("version") == MUSIC_VERSION
        and state.get("content_version") == reader_ambience._content_version()
        and state.get("segment_count") == len(segments)
        and state.get("language_hint") == (language or None)
        and state.get("fingerprint") == reader_ambience.fingerprint(segments)
        and isinstance(state.get("timeline"), list)
        and isinstance(state.get("spots"), list)
    )


def current_palette(state: dict) -> Optional[str]:
    user = state.get("palette_user")
    if user in PALETTES:
        return user
    auto = state.get("palette_auto")
    return auto if auto in PALETTES else None


def file_name(palette_id: str, mood: str, variation: int) -> str:
    digest = hashlib.sha1(f"{PROMPT_VERSION}|{prompt(palette_id, mood)}|{variation}".encode("utf-8")).hexdigest()[:8]
    return f"{palette_id}-{mood}-{variation}-{digest}.ogg"


def candidate_name(name: str, k: int) -> str:
    return f"{name[:-4]}.c{k}.ogg"


def seed_for(doc_id: str, name: str, k: int) -> int:
    return int(hashlib.sha1(f"{doc_id}|{name}|{k}".encode("utf-8")).hexdigest()[:8], 16) % 2_000_000_000


def wanted_files(state: dict) -> list[tuple[str, str, int]]:
    """``(file name, mood, variation)`` in generation order: every cue's first
    variation, then the second, then the third."""
    palette = current_palette(state)
    moods = [m for m in state.get("moods") or [] if m in MOODS]
    if palette is None:
        return []
    return [(file_name(palette, mood, v), mood, v) for v in range(1, VARIATIONS + 1) for mood in moods]


def _manifest_path(doc_id: str) -> str:
    return os.path.join(audio_dir(doc_id), MANIFEST)


def load_manifest(doc_id: str) -> dict:
    data = _read_json(_manifest_path(doc_id))
    data.setdefault("files", {})
    data.setdefault("candidates", {})
    return data


def _save_manifest(doc_id: str, manifest: dict) -> None:
    os.makedirs(audio_dir(doc_id), exist_ok=True)
    manifest["version"] = 1
    _write_json(_manifest_path(doc_id), manifest)


def ready_files(doc_id: str, state: dict, manifest: Optional[dict] = None) -> dict[str, dict]:
    manifest = manifest if manifest is not None else load_manifest(doc_id)
    folder = audio_dir(doc_id)
    found = {}
    for name, _mood, _v in wanted_files(state):
        record = manifest["files"].get(name)
        if isinstance(record, dict) and os.path.isfile(os.path.join(folder, name)):
            found[name] = record
    return found


def cues_payload(doc_id: str, state: dict) -> list[dict]:
    ready = ready_files(doc_id, state)
    palette = current_palette(state)
    cues = []
    for mood in [m for m in state.get("moods") or [] if m in MOODS]:
        files = []
        for v in range(1, VARIATIONS + 1):
            name = file_name(palette, mood, v) if palette else ""
            if name in ready:
                files.append({"name": name, "duration": float(ready[name].get("duration") or 0.0)})
        cues.append({"id": mood, "mood": mood, "files": files, "ready": bool(files)})
    return cues


def cue_file(doc_id: str, name: str) -> Optional[str]:
    """Path of a generated cue the current plan lists, else None."""
    if not isinstance(name, str) or not _FILE_RE.match(name):
        return None
    state = load_state(doc_id)
    if not state or name not in ready_files(doc_id, state):
        return None
    folder = os.path.realpath(audio_dir(doc_id))
    path = os.path.realpath(os.path.join(folder, name))
    if os.path.dirname(path) != folder or not os.path.isfile(path):
        return None
    return path


def _prune(doc_id: str, state: dict) -> None:
    """Remove audio the plan no longer uses (another palette or prompt version)."""
    folder = audio_dir(doc_id)
    if not os.path.isdir(folder):
        return
    keep = set()
    for name, _mood, _v in wanted_files(state):
        keep.add(name)
        keep.update(candidate_name(name, k) for k in range(CANDIDATES))
    for entry in os.listdir(folder):
        if entry.endswith(".ogg") and entry not in keep:
            try:
                os.remove(os.path.join(folder, entry))
            except OSError:
                pass
    manifest = load_manifest(doc_id)
    changed = False
    for bucket in ("files", "candidates"):
        for name in list(manifest[bucket]):
            if name not in keep:
                manifest[bucket].pop(name)
                changed = True
    if changed:
        _save_manifest(doc_id, manifest)


# ── Plan computation ─────────────────────────────────────────────────────────


def _llm_enabled() -> bool:
    flag = os.environ.get("OMNIVOICE_READER_MUSIC_LLM", "1").strip().lower()
    if flag in ("0", "false", "no", "off"):
        return False
    from services import reader_speech_llm

    return reader_speech_llm.enabled()


def _ollama_client():
    """A CPU-only local Ollama client (started on demand), or None."""
    if not _llm_enabled():
        return None
    from services import reader_speech_llm as llm

    models = llm.ensure_server()
    model = llm.pick_model(models) if models else None
    return llm.OllamaClient(model) if model else None


#: Replaceable in tests; returns an object with ``chat(system, user, schema) -> dict`` or None.
llm_factory: Callable[[], object] = _ollama_client


def _llm_chapter_limit() -> int:
    try:
        return max(0, int(os.environ.get("OMNIVOICE_READER_MUSIC_LLM_CHAPTERS", "8")))
    except ValueError:
        return 8


def _ask(client, user: str, schema: dict, key: str, allowed: Sequence[str]) -> Optional[str]:
    try:
        answer = client.chat(_LLM_SYSTEM, user, schema)
    except Exception:  # noqa: BLE001 — the LLM is optional
        logger.debug("Reader music: LLM call failed", exc_info=True)
        return None
    value = str((answer or {}).get(key) or "").strip().lower()
    return value if value in allowed else None


def _excerpt_key(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:12]


def compute_plan(doc_id: str, *, should_stop: Callable[[], bool] = lambda: False) -> dict:
    """Compute and store the plan of a ready document (blocking): rules first
    (stored at once), then the optional LLM palette and chapter moods."""
    summary = reader_store.get_summary(doc_id)
    content = reader_store.load_content(doc_id)
    segments, chapters = content["segments"], content["chapters"]
    hint = summary.get("language")
    previous = load_state(doc_id)
    lang = reader_ambience.document_language(segments, hint)
    ambience = reader_ambience._stored(doc_id, segments, hint)
    common = dict(
        title=str(summary.get("title") or ""), author=str(summary.get("author") or ""), language=hint,
        source_type=summary.get("source_type"), ambience_scenes=(ambience or {}).get("scenes"),
        position=int(summary.get("position_segment") or 0),
    )
    cache = previous.get("llm_cache") if isinstance(previous.get("llm_cache"), dict) else {}
    cache = {k: v for k, v in cache.items() if isinstance(v, str)}
    excerpt = opening_excerpt(segments)
    palette_key = f"palette:{_excerpt_key(common['title'] + excerpt)}"
    windows = reader_ambience.split_windows(segments, chapters)
    excerpts = _chapter_excerpts(windows)
    cached_moods = {
        ch: cache[f"mood:{_excerpt_key(text)}"] for ch, text in excerpts.items() if f"mood:{_excerpt_key(text)}" in cache
    }
    plan = build_plan(segments, chapters, palette_answer=cache.get(palette_key), chapter_moods=cached_moods, **common)
    _store_plan(doc_id, segments, hint, plan, cache)
    if lang is None or should_stop():
        return plan
    _best, decisive = rank_palettes(plan["palette_scores"])
    wants_palette = not decisive and palette_key not in cache
    position = common["position"]
    todo = [ch for ch in excerpts if f"mood:{_excerpt_key(excerpts[ch])}" not in cache]
    # Chapters nearest to the listening position first, up to the limit.
    chapter_at = {w.chapter: w.start for w in reversed(windows)}
    todo.sort(key=lambda ch: (chapter_at.get(ch, 0) < position, abs(chapter_at.get(ch, 0) - position)))
    todo = todo[: max(0, _llm_chapter_limit() - len(cached_moods))]
    if not wants_palette and not todo:
        return plan
    client = llm_factory()
    if client is None:
        return plan
    started = time.monotonic()
    if wants_palette:
        answer = _ask(client, *palette_question(common["title"], common["author"], excerpt), "palette", PALETTE_IDS)
        if answer:
            cache[palette_key] = answer
    for chapter in todo:
        if should_stop():
            break
        answer = _ask(client, *mood_question(excerpts[chapter]), "mood", MOODS)
        if answer:
            cache[f"mood:{_excerpt_key(excerpts[chapter])}"] = answer
            cached_moods[chapter] = answer
    plan = build_plan(segments, chapters, palette_answer=cache.get(palette_key), chapter_moods=cached_moods, **common)
    _store_plan(doc_id, segments, hint, plan, cache, llm=True)
    logger.info(
        "Reader music: %s planned with the local LLM in %.0f s (palette %s, %d chapter moods)",
        doc_id, time.monotonic() - started, plan["palette"], len(cached_moods),
    )
    return plan


def _store_plan(doc_id: str, segments, hint, plan: dict, cache: dict, *, llm: bool = False) -> None:
    _update_state(
        doc_id,
        version=MUSIC_VERSION,
        prompt_version=PROMPT_VERSION,
        content_version=reader_ambience._content_version(),
        segment_count=len(segments),
        language_hint=hint or None,
        fingerprint=reader_ambience.fingerprint(segments),
        computed_at=round(time.time(), 1),
        palette_auto=plan["palette"],
        palette_why=plan["palette_why"],
        palette_scores=plan["palette_scores"],
        era=plan["era"],
        coverage=plan["coverage"],
        moods=plan["moods"],
        timeline=plan["timeline"],
        spots=plan["spots"],
        llm_cache=cache,
        refined=llm,
    )


# ── Background work ──────────────────────────────────────────────────────────

_queue: "queue.Queue[str]" = queue.Queue()
_pending: set[str] = set()
_lock = threading.Lock()
_worker: dict = {"thread": None}
#: doc id → {"phase": analyzing|waiting|generating, "error": str|None}
_status: dict[str, dict] = {}
#: Documents whose running work must stop (deleted, palette changed).
_cancel: set[str] = set()
_active: dict = {"doc": None}
#: Seconds between idle checks while waiting for the voice to be idle, and how
#: long the probe must stay quiet before the GPU counts as idle.
WAIT_POLL_S = 2.0
IDLE_SETTLE_S = 10.0
#: Back-off after the worker found too little free VRAM, and how often to retry.
RESOURCE_BACKOFF_S = 60.0
RESOURCE_RETRIES = 10

# Replaceable in tests.
busy_probe: Callable[[], Optional[str]] = engine.tts_busy_reason
unload_tts: Callable[[], object] = engine.unload_tts
run_worker: Callable[..., engine.Outcome] = engine.run_worker
engine_available: Callable[[], bool] = engine.engine_available


def _ffmpeg() -> Optional[str]:
    try:
        from services.reader_render import ffmpeg_path

        return ffmpeg_path()
    except Exception:  # noqa: BLE001
        return None


def schedule(doc_id: str) -> None:
    """Queue (re)planning and, when requested, generation (no-op when queued)."""
    with _lock:
        if doc_id in _pending:
            return
        _pending.add(doc_id)
        _queue.put(doc_id)
        thread = _worker["thread"]
        if thread is None or not thread.is_alive():
            thread = threading.Thread(target=_run, name="reader-music", daemon=True)
            _worker["thread"] = thread
            thread.start()


def _run() -> None:
    while True:
        try:
            doc_id = _queue.get(timeout=30.0)
        except queue.Empty:
            with _lock:
                if _queue.empty():
                    _worker["thread"] = None
                    return
            continue
        with _lock:
            _active["doc"] = doc_id
            skip = doc_id in _cancel  # deleted while queued
            _cancel.discard(doc_id)
        try:
            if not skip:
                _process(doc_id)
        except reader_store.DocumentNotFound:
            pass
        except Exception as exc:  # noqa: BLE001 — the worker survives any one document
            logger.warning("Reader music: %s failed", doc_id, exc_info=True)
            _set_status(doc_id, phase=None, error=_public_error(exc))
        finally:
            with _lock:
                _pending.discard(doc_id)
                _cancel.discard(doc_id)
                _active["doc"] = None
                st = _status.get(doc_id)
                if st and not st.get("error"):
                    _status.pop(doc_id, None)
            _queue.task_done()


def _public_error(exc: BaseException) -> str:
    try:
        from core.scrub import scrub_text

        return (scrub_text(str(exc)) or type(exc).__name__)[:300]
    except Exception:  # noqa: BLE001
        return type(exc).__name__


def _set_status(doc_id: str, **fields) -> None:
    with _lock:
        _status.setdefault(doc_id, {}).update(fields)


def _cancelled(doc_id: str) -> bool:
    with _lock:
        return doc_id in _cancel


def _process(doc_id: str) -> None:
    summary = reader_store.get_summary(doc_id)
    if summary.get("import_status") != reader_store.IMPORT_READY:
        return
    content = reader_store.load_content(doc_id)
    state = load_state(doc_id)
    if not _fresh(state, content["segments"], summary.get("language")):
        _set_status(doc_id, phase="analyzing", error=None)
        folder = reader_store.document_dir(doc_id)
        compute_plan(doc_id, should_stop=lambda: _cancelled(doc_id) or not os.path.isdir(folder))
    state = load_state(doc_id)
    if not state.get("requested") or not engine_available():
        return
    _generate(doc_id)


def _pending_clips(doc_id: str, state: dict, manifest: dict) -> list[engine.Clip]:
    folder = audio_dir(doc_id)
    clips = []
    for name, mood, _v in wanted_files(state):
        if name in manifest["files"] and os.path.isfile(os.path.join(folder, name)):
            continue
        for k in range(CANDIDATES):
            cand = candidate_name(name, k)
            if cand in manifest["candidates"] and os.path.isfile(os.path.join(folder, cand)):
                continue
            clips.append(engine.Clip(cand, prompt(current_palette(state), mood), seed_for(doc_id, name, k), os.path.join(folder, cand)))
    return clips


def _integrate(doc_id: str, state: dict, results: dict) -> int:
    """Record finished candidates; promote the better one of each complete pair."""
    manifest = load_manifest(doc_id)
    for cand, record in results.items():
        manifest["candidates"][cand] = {
            "duration": record.get("duration"), "metrics": record.get("metrics"),
            "gen_seconds": record.get("gen_seconds"),
        }
    folder = audio_dir(doc_id)
    promoted = 0
    palette = current_palette(state)
    for name, mood, variation in wanted_files(state):
        if name in manifest["files"] and os.path.isfile(os.path.join(folder, name)):
            continue
        cands = [candidate_name(name, k) for k in range(CANDIDATES)]
        if not all(c in manifest["candidates"] and os.path.isfile(os.path.join(folder, c)) for c in cands):
            continue
        metrics = [manifest["candidates"][c].get("metrics") for c in cands]
        best = engine.pick_candidate(metrics)
        os.replace(os.path.join(folder, cands[best]), os.path.join(folder, name))
        for k, cand in enumerate(cands):
            if k != best:
                try:
                    os.remove(os.path.join(folder, cand))
                except OSError:
                    pass
        manifest["files"][name] = {
            "mood": mood,
            "palette": palette,
            "variation": variation,
            "prompt": prompt(palette, mood),
            "seed": seed_for(doc_id, name, best),
            "duration": manifest["candidates"][cands[best]].get("duration"),
            "metrics": metrics[best],
            "penalties": [engine.penalty(m) for m in metrics],
            "chosen": best,
        }
        for cand in cands:
            manifest["candidates"].pop(cand, None)
        promoted += 1
    _save_manifest(doc_id, manifest)
    return promoted


def _generate(doc_id: str) -> None:
    gate = engine.IdleGate(busy_probe, settle_s=IDLE_SETTLE_S)
    resource_failures = 0
    folder = reader_store.document_dir(doc_id)
    pruned_for = None
    while True:
        if _cancelled(doc_id) or not os.path.isdir(folder):
            return
        state = load_state(doc_id)
        if not state.get("requested") or current_palette(state) is None:
            return
        key = (current_palette(state), tuple(state.get("moods") or ()))
        if pruned_for != key:
            _prune(doc_id, state)
            pruned_for = key
        _integrate(doc_id, state, {})
        clips = _pending_clips(doc_id, state, load_manifest(doc_id))
        if not clips:
            _set_status(doc_id, phase=None, error=None)
            logger.info("Reader music: all cues of %s are ready", doc_id)
            return
        _set_status(doc_id, phase="waiting", error=None)
        while not gate.idle():
            if _cancelled(doc_id) or not os.path.isdir(folder):
                return
            time.sleep(WAIT_POLL_S)
        unload_tts()
        _set_status(doc_id, phase="generating")
        palette = current_palette(state)

        def should_stop() -> Optional[str]:
            if _cancelled(doc_id) or not os.path.isdir(folder):
                return "cancelled"
            if current_palette(load_state(doc_id)) != palette:
                return "palette changed"
            return gate.busy()

        logger.info("Reader music: generating %d clip(s) for %s (%s)", len(clips), doc_id, palette)
        outcome = run_worker(clips, audio_dir(doc_id), should_stop=should_stop, ffmpeg=_ffmpeg())
        if os.path.isdir(folder) and not _cancelled(doc_id):
            _integrate(doc_id, state, outcome.results)
        if outcome.status == "yielded":
            logger.info("Reader music: paused for %s (%s)", doc_id, outcome.reason)
            continue
        if outcome.status == "resources":
            resource_failures += 1
            if resource_failures >= RESOURCE_RETRIES:
                _set_status(doc_id, phase=None, error="Not enough free GPU memory for music.")
                return
            logger.info("Reader music: not enough free VRAM (%s); retrying later", outcome.reason)
            _set_status(doc_id, phase="waiting")
            deadline = time.monotonic() + RESOURCE_BACKOFF_S
            while time.monotonic() < deadline:
                if _cancelled(doc_id):
                    return
                time.sleep(min(WAIT_POLL_S, RESOURCE_BACKOFF_S))
            continue
        if outcome.status == "failed":
            logger.warning("Reader music: generation for %s failed: %s", doc_id, outcome.reason)
            _set_status(doc_id, phase=None, error=str(outcome.reason or "music generation failed")[:300])
            return


# ── Public surface (routes) ──────────────────────────────────────────────────


def _mark_enabled() -> None:
    marker = os.path.join(reader_store.reader_dir(), _ENABLED_MARKER)
    if os.path.exists(marker):
        return
    try:
        os.makedirs(os.path.dirname(marker), exist_ok=True)
        with open(marker, "w", encoding="utf-8") as fh:
            fh.write("1")
    except OSError:
        pass


def after_import(doc_id: str) -> None:
    """Plan a freshly imported document in the background once music was used
    on this machine (no audio: that needs an explicit request)."""
    try:
        if os.path.exists(os.path.join(reader_store.reader_dir(), _ENABLED_MARKER)):
            schedule(doc_id)
    except Exception:  # noqa: BLE001 — never affects the import
        logger.debug("Reader music: could not schedule %s", doc_id, exc_info=True)


def payload(doc_id: str) -> dict:
    """The ``GET /reader/documents/{id}/music`` body; schedules missing work for
    a requested document. Raises :class:`reader_store.DocumentNotFound`."""
    summary = reader_store.get_summary(doc_id)
    state = load_state(doc_id)
    requested = bool(state.get("requested"))
    available = engine_available()
    fresh = False
    if summary.get("import_status") == reader_store.IMPORT_READY and state:
        fresh = _fresh(state, reader_store.load_content(doc_id)["segments"], summary.get("language"))
    with _lock:
        busy = doc_id in _pending
        st = dict(_status.get(doc_id) or {})
        active = _active["doc"] == doc_id
    palette = current_palette(state) if fresh else None
    body = {
        "status": "off",
        "progress": 0.0,
        "error": None,
        "engine_available": available,
        "palette": {"id": palette, "source": "user" if state.get("palette_user") in PALETTES else "auto"} if palette else None,
        "palettes": [{"id": pid} for pid in PALETTE_IDS],
        "cues": cues_payload(doc_id, state) if fresh else [],
        "spots": list(state.get("spots") or []) if fresh else [],
        "timeline": list(state.get("timeline") or []) if fresh else [],
        "level_lufs": LEVEL_LUFS,
    }
    total = len(wanted_files(state)) if fresh else 0
    done = sum(len(c["files"]) for c in body["cues"])
    body["progress"] = round(done / total, 3) if total else 0.0
    if not requested:
        return body
    if summary.get("import_status") != reader_store.IMPORT_READY:
        body["status"] = "queued"
        return body
    if st.get("error") and not busy:
        body.update(status="error", error=st["error"])
        return body
    if not fresh:
        if not busy:
            schedule(doc_id)
        body["status"] = "analyzing" if active and st.get("phase") == "analyzing" else "queued"
        return body
    if not available:
        body["status"] = "unavailable"
        return body
    if done >= total:
        body.update(status="ready", progress=1.0)
        return body
    if not busy:
        schedule(doc_id)
    body["status"] = "generating" if active and st.get("phase") == "generating" else "queued"
    return body


def request(doc_id: str, palette: Optional[str] = None) -> dict:
    """Ask for music on a document (idempotent); ``palette`` overrides the
    automatic choice (its cues are regenerated), ``"auto"`` returns to it.
    Raises ``ValueError`` for an unknown palette and
    :class:`reader_store.DocumentNotFound`."""
    reader_store.get_summary(doc_id)
    if palette is not None and palette != AUTO and palette not in PALETTES:
        raise ValueError(f"unknown palette: {palette}")
    fields: dict = {"requested": True}
    if palette is not None:
        fields["palette_user"] = None if palette == AUTO else palette  # None removes the override
    # A running worker notices a palette change itself and stops (``_generate``).
    _update_state(doc_id, **fields)
    with _lock:
        _status.pop(doc_id, None)
    _mark_enabled()
    schedule(doc_id)
    return payload(doc_id)


def _stop(doc_id: str) -> None:
    """Stop work in progress for a document and drop it from the queue state."""
    with _lock:
        if _active["doc"] == doc_id or doc_id in _pending:
            _cancel.add(doc_id)
        _status.pop(doc_id, None)


def remove(doc_id: str) -> dict:
    """``DELETE …/music``: stop, then delete the plan and the generated audio."""
    reader_store.get_summary(doc_id)
    _stop(doc_id)
    with _file_lock:
        try:
            os.remove(_path(doc_id))
        except OSError:
            pass
    shutil.rmtree(audio_dir(doc_id), ignore_errors=True)
    return payload(doc_id)


def forget(doc_id: str) -> None:
    """The document was deleted: stop its work and delete its audio."""
    _stop(doc_id)
    if reader_store.valid_id(doc_id):
        shutil.rmtree(audio_dir(doc_id), ignore_errors=True)


def wait_idle(timeout: float = 30.0) -> bool:
    """Block until nothing is queued or running (tests)."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with _lock:
            if not _pending:
                return True
        time.sleep(0.02)
    return False
