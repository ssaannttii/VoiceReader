"""Automatic ambience for the Reader: which background bed suits each scene.

A document is split into scenes (headings, chapter starts and explicit scene
breaks such as ``* * *`` are hard boundaries; otherwise windows of about ten
paragraphs) and every window is classified into a small palette of ambience
tags by a weighted Spanish + English lexicon. A tag needs a minimum density
and a clear margin over any conflicting runner-up; anything doubtful is
``none`` — silence is better than a wrong sound. Windows that were close
can optionally be re-ranked by embedding similarity with a local Ollama
(``bge-m3``) when one is installed; without it the lexicon result stands.

Smoothing then removes one-window blips, merges neighbours with the same tag
and drops scenes too short to be worth a crossfade.

The result is stored as ``<doc>/ambience.json`` and computed on demand in a
background thread (``GET /reader/documents/{id}/ambience``), and after imports
once the listener has used the feature. It is recomputed whenever the content
changes (segmentation version, segment count or text fingerprint differ).
"""
from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
import unicodedata
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Callable, Optional, Sequence

from services import reader_store

logger = logging.getLogger("omnivoice.reader")

#: Bump when scene splitting, the lexicon or smoothing change: stored analyses are redone.
AMBIENCE_VERSION = 1
AMBIENCE_FILE = "ambience.json"
#: Marker in the Reader folder: the listener has used Automático (enables analysis after imports).
_ENABLED_MARKER = "ambience.enabled"

NONE = "none"
TAGS = ("rain", "storm", "wind", "sea", "forest", "night", "fire", "tavern", "city", "interior", "cave")

# ── Lexicon ──────────────────────────────────────────────────────────────────
# Per language, since words collide across them (Spanish "sea", "gusto",
# "trampa", "echo"). Terms are lowercase without acute/grave accents or
# diaeresis (``ñ`` kept); a trailing ``*`` matches any word starting with the
# stem; a space makes a phrase. Weights: 3 = the word alone sets the scene
# ("tormenta", "taberna"), 1 = a supporting detail, < 1 = common words that only
# count in numbers. Documents in other languages get no ambience (silence).
_LEXICON: dict[str, dict[str, dict[str, float]]] = {
    "es": {
        "rain": {
            "lluvia*": 2.5, "llov*": 2.5, "llueve": 2.5, "lluev*": 2.5, "chaparron*": 2,
            "paraguas": 1.5, "charco*": 1.2, "gota": 0.6, "gotas": 0.8, "empapad*": 1,
            "mojad*": 0.6, "chubasquero*": 1.5, "nubarron*": 0.8, "goterones": 1.5,
        },
        "storm": {
            "tormenta*": 3, "tempestad*": 3, "trueno*": 3, "tronaba": 2.5, "relampag*": 3,
            "diluvio": 2.5, "aguacero*": 2.5, "huracan*": 2.5, "rayos": 0.8,
        },
        "wind": {
            "viento*": 2.5, "ventisca*": 2, "rafaga*": 2.5, "brisa*": 1.5, "vendaval*": 2.5,
            "soplaba": 1, "silbaba": 0.6, "aullaba": 0.5, "ventoso": 2,
        },
        "sea": {
            "mar": 2.5, "mares": 2, "oceano*": 2.5, "ola": 1.5, "olas": 2.5, "oleaje": 3,
            "marea*": 2, "playa*": 2.5, "orilla": 0.8, "barco*": 2, "buque*": 2, "navio*": 2,
            "velero*": 2, "mastil*": 2, "timon": 1.5, "muelle*": 1.2, "marinero*": 2,
            "marino": 1.2, "marinos": 1.5, "gaviota*": 2.5, "salitre": 2, "espuma": 0.7,
            "costas": 1, "acantilad*": 1.2, "naveg*": 1.5, "zarp*": 2, "bahia": 1.5,
            "travesia": 1, "tripulacion": 1.2, "cubierta": 0.6, "puerto": 0.8, "isla": 0.8,
        },
        "forest": {
            "bosque*": 2.5, "selva*": 2.5, "arbol*": 1.2, "arboleda*": 2, "hojas": 0.8,
            "ramas": 1, "follaje": 2, "musgo": 1.5, "helecho*": 2, "pinar*": 2, "pinos": 1.5,
            "roble*": 1.5, "sendero*": 1.2, "maleza": 1.5, "matorral*": 1.5, "arbusto*": 1,
            "pajaro*": 1.5, "trino*": 2, "ardilla*": 1.5, "ciervo*": 1,
        },
        "night": {
            "noche": 0.8, "noches": 0.6, "nocturn*": 1, "grillo*": 3, "cigarra*": 2.5,
            "estrellas": 1.2, "estrellado": 2, "luna": 1.5, "anochec*": 1.5, "medianoche": 1,
            "buho*": 2, "lechuza*": 2, "luciernaga*": 2.5, "crepusculo": 1,
        },
        "fire": {
            "fuego": 1.5, "hoguera*": 3, "chimenea*": 2.5, "brasa*": 2.5, "ascua*": 2.5,
            "llamas": 1, "llamarada*": 2.5, "crepit*": 2.5, "leña": 2.5, "fogata*": 3,
            "fogon*": 2, "lumbre": 2.5, "rescoldo*": 2.5, "chispas": 1, "humo": 0.6,
        },
        "tavern": {
            "taberna*": 3, "posada*": 2.5, "meson": 2, "cantina*": 3, "bar": 1, "bares": 1,
            "cerveza*": 1.5, "jarra*": 1.5, "posadero*": 3, "tabernero*": 3, "mesonero*": 3,
            "multitud*": 1.5, "muchedumbre*": 2, "gentio": 2, "bullicio*": 2, "risas": 1,
            "brindis": 1.5, "brindar*": 1.5, "festin": 2, "banquete*": 2, "fiesta*": 1.5,
            "baile": 1.5, "bailes": 1.5, "bailaban": 1.5, "salon de baile": 2.5,
            "cafeteria*": 2.5, "restaurante*": 2, "camarero*": 1.5,
        },
        "city": {
            "ciudad": 1, "calle": 1.5, "calles": 1.5, "callejon*": 2, "callejuela*": 2,
            "avenida*": 2, "plaza": 1, "mercado*": 1.5, "trafico": 2.5, "carruaje*": 2,
            "coche": 1.2, "coches": 1.5, "bocina*": 2.5, "adoquin*": 2, "acera*": 2,
            "tranvia*": 2.5, "semaforo*": 2.5, "transeunte*": 2, "peaton*": 2,
            "barrio*": 1, "vendedor*": 1, "carretas": 1.2,
        },
        "interior": {
            "habitacion*": 1.2, "despacho": 1.5, "biblioteca*": 1.2, "dormitorio*": 1.5,
            "salon": 1, "sala": 0.8, "cocina": 1, "mesa": 0.6, "escritorio*": 1.5,
            "silla*": 1, "sillon*": 1.5, "sofa*": 1.5, "cama": 1, "alfombra*": 1.2,
            "paredes": 0.6, "techo": 0.6, "estanteria*": 1.2, "lampara*": 1, "pasillo*": 1,
            "oficina*": 1.2,
        },
        "cave": {
            "cueva*": 3, "caverna*": 3, "gruta*": 3, "tunel*": 2, "subterrane*": 2,
            "estalact*": 3, "estalagm*": 3, "goteo": 2, "goteaba": 2, "gotera*": 1.5,
            "mazmorra*": 2.5, "catacumba*": 3, "cripta*": 2.5, "sotano*": 1.5,
            "alcantarilla*": 2, "eco": 1, "ecos": 1.2, "humedad": 0.8,
        },
    },
    "en": {
        "rain": {
            "rain": 2.5, "rains": 2.5, "rained": 2.5, "raining": 2.5, "rainy": 2.5,
            "raindrop*": 2.5, "rainwater": 2, "drizzl*": 2.5, "umbrella*": 1.5, "puddle*": 1.2,
            "drenched": 1, "soaked": 0.8, "drops": 0.6,
        },
        "storm": {
            "storm": 3, "storms": 3, "stormy": 3, "thunder*": 3, "lightning": 3, "tempest*": 3,
            "downpour*": 2.5, "deluge": 2.5, "hurricane*": 2.5, "cloudburst": 2.5,
        },
        "wind": {
            "wind": 2, "winds": 2.5, "windy": 2.5, "gust*": 2.5, "breeze*": 1.5, "gale*": 2,
            "blustery": 2.5, "howling": 0.8, "whistled": 0.5,
        },
        "sea": {
            "sea": 2.5, "seas": 2, "ocean*": 2.5, "waves": 2, "surf": 2, "tide*": 2,
            "beach*": 2.5, "shore*": 1.2, "ship": 2, "ships": 2, "boat*": 2, "deck": 1,
            "mast": 2, "sail": 2, "sails": 2, "sailed": 2, "sailing": 2, "sailor*": 2,
            "harbor*": 1.2, "harbour*": 1.2, "seagull*": 2.5, "gulls": 2, "coast*": 1,
            "voyage*": 1.5, "crew": 0.8, "island*": 0.8,
        },
        "forest": {
            "forest*": 2.5, "woods": 2, "woodland*": 2.5, "jungle*": 2.5, "tree": 1,
            "trees": 1.5, "leaves": 1, "branches": 1, "foliage": 2, "moss*": 1.5, "fern*": 1.5,
            "pines": 1.5, "oak": 1.2, "oaks": 1.5, "trail": 0.8, "bird": 1.2, "birds": 1.5,
            "birdsong": 2.5, "thicket*": 2, "undergrowth": 2, "squirrel*": 1.5,
        },
        "night": {
            "night": 0.8, "nights": 0.6, "nightfall": 1.5, "midnight": 1, "cricket": 2.5,
            "crickets": 3, "cicada*": 2.5, "stars": 1.2, "starlight": 2, "starry": 2,
            "moon": 1.5, "moonlight": 2, "moonlit": 2, "owl": 2, "owls": 2, "firefl*": 2.5,
            "dusk": 1.2,
        },
        "fire": {
            "fire": 1.5, "fires": 1.2, "fireplace*": 3, "campfire*": 3, "bonfire*": 3,
            "hearth*": 3, "ember*": 2.5, "flames": 1.2, "crackl*": 2, "firelight": 2.5,
            "firewood": 2.5, "logs": 1, "smoke": 0.6, "sparks": 0.8,
        },
        "tavern": {
            "tavern*": 3, "inn": 2, "inns": 2, "innkeeper*": 3, "pub": 2.5, "pubs": 2.5,
            "ale": 1.5, "beer*": 1.5, "tankard*": 2.5, "crowd": 1.5, "crowded": 1.5,
            "throng": 2, "laughter": 1, "chatter*": 1.5, "feast*": 1.5, "banquet*": 2,
            "ballroom*": 2.5, "dancing": 1, "cafe": 2, "restaurant*": 2, "waiter*": 1.5,
            "barmaid*": 3,
        },
        "city": {
            "city": 1, "street": 1.5, "streets": 1.5, "alley*": 2, "avenue*": 2,
            "market*": 1.5, "traffic": 2.5, "carriage*": 2, "cab": 1.2, "taxi*": 2,
            "car": 1, "cars": 1.2, "honk*": 2.5, "sidewalk*": 2, "pavement*": 1.5,
            "cobble*": 2, "tram": 2, "trams": 2, "bus": 1.2, "downtown": 2, "pedestrian*": 2,
        },
        "interior": {
            "room": 1, "rooms": 0.8, "bedroom*": 1.5, "office": 1, "library": 1,
            "kitchen*": 1, "desk*": 1.5, "chair*": 1, "armchair*": 1.5, "sofa*": 1.5,
            "couch*": 1.5, "bed": 0.8, "carpet*": 1.2, "rug": 1.2, "ceiling": 0.8,
            "shelf": 1, "shelves": 1, "lamp*": 1, "hallway*": 1, "corridor*": 1,
        },
        "cave": {
            "cave": 3, "caves": 3, "cavern*": 3, "grotto*": 3, "tunnel*": 2,
            "underground": 1.5, "stalact*": 3, "stalagm*": 3, "dripping": 1.5,
            "dungeon*": 2.5, "catacomb*": 3, "crypt*": 2.5, "cellar*": 1.5, "sewer*": 2,
            "echo": 1, "echoes": 1.2, "echoed": 1.2,
        },
    },
}
LANGUAGES = tuple(_LEXICON)

#: Figurative "X de / X of" ("una lluvia de flechas", "a sea of faces") barely counts.
_FIGURATIVE_BEFORE_OF = {"lluvia", "mar", "ola", "oleada", "tormenta", "torrente", "rain", "sea", "wave", "storm", "fuego"}
_OF_WORDS = {"de", "of"}
_FIGURATIVE_FACTOR = 0.2
#: One word repeated (a name like "Bosque") stops counting after this many hits.
_MAX_HITS_PER_TERM = 3

_STOPWORDS = {
    "es": frozenset(
        "el la los las de que y en un una por con para se no su al lo como mas pero sus le ya "
        "fue este ha porque esta entre cuando muy sin sobre tambien me hasta hay donde desde "
        "todo nos durante uno les ni contra ese eso ante ellos esto antes algunos unos yo otro "
        "el tanto esa estos mucho nada muchos cual poco ella estar estas algo".split()
    ),
    "en": frozenset(
        "the and of to in is it that was he for on are with as his they at be this have from "
        "or had by but not what all were we when your can said there an each which she do how "
        "their if will up about out them then these so her would him into has more could my "
        "than been who its now did down only".split()
    ),
}


def detect_language(texts: Sequence[str], limit_words: int = 20_000) -> Optional[str]:
    """``es`` / ``en`` by stopword counts, or None (another language: no ambience)."""
    counts = {lang: 0 for lang in _STOPWORDS}
    seen = 0
    for text in texts:
        for word in tokenize(text):
            seen += 1
            for lang, words in _STOPWORDS.items():
                if word in words:
                    counts[lang] += 1
        if seen >= limit_words:
            break
    ranked = sorted(counts.items(), key=lambda kv: kv[1], reverse=True)
    best, runner = ranked[0], ranked[1]
    if best[1] >= 5 and best[1] >= 1.3 * runner[1] and best[1] >= 0.15 * seen:
        return best[0]
    return None

#: Tags that can share a scene: the stronger one wins without a margin check.
_COMPATIBLE = {
    frozenset(pair)
    for pair in (
        ("rain", "storm"), ("storm", "wind"), ("rain", "wind"), ("sea", "wind"), ("sea", "storm"),
        ("forest", "night"), ("forest", "wind"), ("night", "wind"), ("tavern", "city"),
        ("tavern", "fire"), ("interior", "fire"), ("interior", "tavern"), ("cave", "interior"),
        ("night", "fire"), ("forest", "rain"), ("city", "rain"), ("city", "night"),
    )
}
#: When compatible tags both score, the more specific/eventful sound wins.
_PRIORITY = {
    "storm": 10, "fire": 9, "tavern": 8, "rain": 7, "sea": 6, "cave": 5, "wind": 4,
    "forest": 3, "city": 2, "night": 1, "interior": 0,
}

#: Minimum weighted hits per 100 words (density) and in total for a tag to sound.
MIN_DENSITY = 1.6
MIN_WEIGHT = 5.0
#: Room tone is everywhere in fiction; it needs more evidence.
_TAG_MIN_DENSITY = {"interior": 2.6, "night": 2.0, "city": 2.0}
#: The winner must beat the strongest conflicting tag by this factor.
MARGIN = 1.6
#: Below this the window stays silent (and counts as a close call for the refinement).
MIN_CONFIDENCE = 0.35
#: Lexicon weight a tag needs to be a candidate of the embedding refinement.
REFINE_MIN_WEIGHT = 3.5
#: Densities are computed over at least this many words (short windows don't explode).
_MIN_WORDS = 150

# ── Scenes ───────────────────────────────────────────────────────────────────
WINDOW_PARAS = 10
WINDOW_MAX_CHARS = 4000
#: A trailing window shorter than this many paragraphs joins the previous one.
_MIN_TAIL_PARAS = 4
#: A sounding scene shorter than this (≈ 15 chars/s at 1×, so ~90 s) is dropped to silence.
MIN_SCENE_CHARS = 1350
#: A blip (one window differing from two agreeing neighbours) is overruled below this confidence.
_BLIP_CONFIDENCE = 0.75

_BREAK_RE = re.compile(r"^[\s*·•~#—–\-_=§⁂❦❧✻✦◆◇○●+oO]{1,24}$")


def is_scene_break(text: str) -> bool:
    """``* * *``, ``***``, ``—``, ``#``, ``⁂``… on a line of their own."""
    stripped = (text or "").strip()
    return bool(stripped) and bool(_BREAK_RE.match(stripped)) and not stripped.isalnum()


def _plain(text: str) -> str:
    """Lowercase without acute/grave accents and diaeresis (keeps ``ñ``)."""
    decomposed = unicodedata.normalize("NFD", text.lower())
    return unicodedata.normalize("NFC", "".join(c for c in decomposed if c not in _STRIPPED_MARKS))


#: Combining grave, acute, circumflex and diaeresis (the tilde of ``ñ`` stays).
_STRIPPED_MARKS = frozenset("̀́̂̈")


_WORD_RE = re.compile(r"[^\W\d_]+", re.UNICODE)


@dataclass
class _CompiledLexicon:
    exact: dict[str, list[tuple[str, str, float]]] = field(default_factory=dict)
    prefix: dict[str, list[tuple[str, str, float]]] = field(default_factory=dict)
    prefix_lengths: tuple[int, ...] = ()
    phrases: list[tuple[str, str, str, float]] = field(default_factory=list)
    cache: dict[str, list[tuple[str, str, float]]] = field(default_factory=dict)

    def matches(self, word: str) -> list[tuple[str, str, float]]:
        """Entries for a word: per tag, an exact entry beats the longest matching stem."""
        found = self.cache.get(word)
        if found is not None:
            return found
        best: dict[str, tuple[str, str, float]] = {}
        for entry in self.exact.get(word, ()):
            best[entry[1]] = entry
        for length in self.prefix_lengths:
            if length <= len(word):
                for entry in self.prefix.get(word[:length], ()):
                    best.setdefault(entry[1], entry)
        found = list(best.values())
        if len(self.cache) < 200_000:
            self.cache[word] = found
        return found


def _compile(lexicon: dict[str, dict[str, float]]) -> _CompiledLexicon:
    compiled = _CompiledLexicon()
    lengths: set[int] = set()
    for tag, terms in lexicon.items():
        for term, weight in terms.items():
            term = _plain(term)
            if " " in term:
                compiled.phrases.append((f" {term} ", term, tag, weight))
            elif term.endswith("*"):
                stem = term[:-1]
                compiled.prefix.setdefault(stem, []).append((term, tag, weight))
                lengths.add(len(stem))
            else:
                compiled.exact.setdefault(term, []).append((term, tag, weight))
    compiled.prefix_lengths = tuple(sorted(lengths, reverse=True))
    return compiled


_LEX = {language: _compile(tags) for language, tags in _LEXICON.items()}


def tokenize(text: str) -> list[str]:
    return _WORD_RE.findall(_plain(text))


_SENTENCE_LEAD = frozenset(".!?¡¿—–-«\"“”'‘(:;…[")


def proper_names(texts: Sequence[str], language: str) -> frozenset[str]:
    """Lexicon words used as names in this document ("Brisa", "Bosque", "Marina"):
    mostly capitalized where a sentence does not start."""
    lexicon = _LEX.get(language)
    if lexicon is None:
        return frozenset()
    capital: dict[str, int] = {}
    lower: dict[str, int] = {}
    for text in texts:
        for match in _WORD_RE.finditer(text):
            word = match.group(0)
            plain = _plain(word)
            if not lexicon.matches(plain):
                continue
            before = text[max(0, match.start() - 4) : match.start()].rstrip()
            if not before or before[-1] in _SENTENCE_LEAD:
                continue
            if word[0].isupper():
                capital[plain] = capital.get(plain, 0) + 1
            else:
                lower[plain] = lower.get(plain, 0) + 1
    return frozenset(w for w, n in capital.items() if n >= 3 and n > 2 * lower.get(w, 0))


def score_text(
    text: str,
    language: str,
    *,
    ignore: frozenset[str] = frozenset(),
    trace: Optional[dict[str, dict[str, int]]] = None,
) -> tuple[dict[str, float], int]:
    """Weighted lexicon hits per tag, and the number of words. ``ignore`` holds
    words that are names in this document; ``trace`` collects ``{tag: {term: hits}}``."""
    words = tokenize(text)
    lexicon = _LEX.get(language)
    if lexicon is None:
        return {}, len(words)
    hits: dict[str, int] = {}
    scores: dict[str, float] = {}

    def add(term: str, tag: str, weight: float) -> None:
        key = f"{tag}:{term}"
        count = hits.get(key, 0)
        if count >= _MAX_HITS_PER_TERM:
            return
        hits[key] = count + 1
        scores[tag] = scores.get(tag, 0.0) + weight
        if trace is not None:
            trace.setdefault(tag, {})[term] = count + 1

    for index, word in enumerate(words):
        if word in ignore:
            continue
        matches = lexicon.matches(word)
        if not matches:
            continue
        figurative = (
            word in _FIGURATIVE_BEFORE_OF and index + 1 < len(words) and words[index + 1] in _OF_WORDS
        )
        for term, tag, weight in matches:
            add(term, tag, weight * (_FIGURATIVE_FACTOR if figurative else 1.0))
    if lexicon.phrases:
        joined = f" {' '.join(words)} "
        for needle, term, tag, weight in lexicon.phrases:
            for _ in range(min(_MAX_HITS_PER_TERM, joined.count(needle))):
                add(term, tag, weight)
    return scores, len(words)


@dataclass
class Verdict:
    tag: str
    confidence: float
    intensity: float
    #: Close call (a candidate scored but failed the density or margin test).
    ambiguous: bool = False
    candidates: tuple[str, ...] = ()


def _conflicts(a: str, b: str) -> bool:
    return a != b and frozenset((a, b)) not in _COMPATIBLE


def classify_scores(scores: dict[str, float], words: int) -> Verdict:
    """Pick the scene's tag from lexicon scores, or ``none`` when unsure."""
    span = max(words, _MIN_WORDS) / 100.0
    density = {tag: weight / span for tag, weight in scores.items() if weight > 0}
    if not density:
        return Verdict(NONE, 0.0, 0.0)
    ranked = sorted(density, key=lambda tag: (density[tag], _PRIORITY[tag]), reverse=True)
    # Only tags with real evidence (one strong word, or several weak ones) may be refined into.
    candidates = tuple(tag for tag in ranked[:3] if scores[tag] >= REFINE_MIN_WEIGHT)
    top = ranked[0]
    # A compatible, more eventful tag with real evidence takes the lead (rain + thunder → storm).
    for tag in ranked[1:]:
        if (
            not _conflicts(top, tag)
            and _PRIORITY[tag] > _PRIORITY[top]
            and density[tag] >= 0.5 * density[top]
            and scores[tag] >= 3
        ):
            top = tag
            break
    rival = max((density[tag] for tag in ranked if _conflicts(top, tag)), default=0.0)
    # Supporting evidence from compatible tags (thunder + rain + wind) adds to the winner.
    support = sum(density[tag] for tag in ranked if tag != top and not _conflicts(top, tag))
    strength = density[top] + 0.5 * support
    needed = _TAG_MIN_DENSITY.get(top, MIN_DENSITY)
    passes = strength >= needed and scores[top] >= MIN_WEIGHT * (0.6 if support else 1.0)
    clear = strength >= MARGIN * rival
    margin = 1.0 - (rival / strength if strength else 1.0)
    confidence = max(0.0, min(1.0, margin * min(1.0, strength / (2 * needed))))
    if passes and clear and confidence >= MIN_CONFIDENCE:
        intensity = max(0.35, min(1.0, 0.35 + 0.65 * strength / (3 * needed)))
        return Verdict(top, round(confidence, 2), round(intensity, 2), candidates=candidates)
    ambiguous = strength >= 0.5 * needed and bool(candidates)
    return Verdict(NONE, 0.0, 0.0, ambiguous=ambiguous, candidates=candidates if ambiguous else ())


def classify_text(text: str, language: Optional[str] = None, *, ignore: frozenset[str] = frozenset()) -> Verdict:
    language = language or detect_language([text])
    if language is None:
        return Verdict(NONE, 0.0, 0.0)
    scores, words = score_text(text, language, ignore=ignore)
    return classify_scores(scores, words)


@dataclass
class Window:
    start: int
    end: int  # inclusive segment index
    section: int  # windows in different sections are separated by a hard boundary
    text: str
    chars: int
    verdict: Verdict = field(default_factory=lambda: Verdict(NONE, 0.0, 0.0))
    #: Cosine similarity to each tag's prototypes, when the refinement looked at it.
    sims: Optional[dict[str, float]] = None


def split_windows(segments: Sequence[dict], chapters: Sequence[dict] = ()) -> list[Window]:
    """Scene windows: hard cuts at headings, chapter starts and scene breaks,
    otherwise every ~``WINDOW_PARAS`` paragraphs (≤ ``WINDOW_MAX_CHARS``)."""
    chapter_starts = {int(c.get("segment") or 0) for c in chapters if isinstance(c, dict)}
    windows: list[Window] = []
    section = 0
    in_section: list[Window] = []
    current: Optional[dict] = None

    def finish(tail: bool) -> None:
        nonlocal current
        if current is None:
            return
        window = Window(current["start"], current["end"], section, " ".join(current["texts"]), current["chars"])
        short = current["paras"] < _MIN_TAIL_PARAS
        current = None
        if tail and short and in_section:
            # A short tail (the last lines of a chapter) belongs to the window before it.
            last = in_section[-1]
            last.end = window.end
            last.text = f"{last.text} {window.text}".strip()
            last.chars += window.chars
            return
        in_section.append(window)
        windows.append(window)

    def new_section() -> None:
        nonlocal section, in_section
        finish(True)
        if in_section:
            section += 1
        in_section = []

    last_para: object = None
    for position, seg in enumerate(segments):
        index = int(seg.get("i", position))
        text = str(seg.get("text") or "")
        kind = seg.get("kind")
        scene_break = is_scene_break(text)
        if kind == "h" or scene_break or (index in chapter_starts and index > 0):
            new_section()
        para = seg.get("para", index)
        new_para = para != last_para
        last_para = para
        if current is not None and new_para and (
            current["paras"] >= WINDOW_PARAS or current["chars"] >= WINDOW_MAX_CHARS
        ):
            finish(False)
        if current is None:
            current = {"start": index, "end": index, "texts": [], "chars": 0, "paras": 0}
            new_para = True
        current["end"] = index
        if kind == "h" or scene_break or not text:
            continue
        if new_para:
            current["paras"] += 1
        current["texts"].append(text)
        current["chars"] += len(text)
    new_section()
    return windows


def _smooth(windows: list[Window]) -> list[dict]:
    """Blip removal inside sections, merge equal neighbours, drop short scenes."""
    tags = [w.verdict.tag for w in windows]
    conf = [w.verdict.confidence for w in windows]
    inten = [w.verdict.intensity for w in windows]
    for i in range(1, len(windows) - 1):
        before, after = windows[i - 1], windows[i + 1]
        if before.section != windows[i].section or after.section != windows[i].section:
            continue
        if tags[i - 1] == tags[i + 1] and tags[i] != tags[i - 1]:
            neighbour = tags[i - 1]
            if tags[i] == NONE and neighbour != NONE:
                # A quiet window inside a scene keeps the scene's sound (no 45 s of silence).
                tags[i], conf[i] = neighbour, round(min(conf[i - 1], conf[i + 1]) * 0.8, 2)
                inten[i] = round((inten[i - 1] + inten[i + 1]) / 2, 2)
            elif conf[i] < _BLIP_CONFIDENCE:
                tags[i], conf[i] = neighbour, round(min(conf[i - 1], conf[i + 1]) * 0.8, 2)
                inten[i] = round((inten[i - 1] + inten[i + 1]) / 2, 2) if neighbour != NONE else 0.0
    scenes = _merge([(w.start, w.end, w.chars, tags[k], conf[k], inten[k]) for k, w in enumerate(windows)])
    # Too short to be worth a crossfade: silence instead, then merge again.
    for scene in scenes:
        if scene["tag"] != NONE and scene["_chars"] < MIN_SCENE_CHARS:
            scene.update(tag=NONE, confidence=0.0, intensity=0.0)
    scenes = _merge([(s["start_segment"], s["end_segment"], s["_chars"], s["tag"], s["confidence"], s["intensity"]) for s in scenes])
    for scene in scenes:
        scene.pop("_chars", None)
    return scenes


def _merge(rows: list[tuple[int, int, int, str, float, float]]) -> list[dict]:
    scenes: list[dict] = []
    for start, end, chars, tag, confidence, intensity in rows:
        if scenes and scenes[-1]["tag"] == tag:
            last = scenes[-1]
            total = last["_chars"] + chars
            if total:
                last["confidence"] = round((last["confidence"] * last["_chars"] + confidence * chars) / total, 2)
                last["intensity"] = round((last["intensity"] * last["_chars"] + intensity * chars) / total, 2)
            last["end_segment"] = end
            last["_chars"] = total
            continue
        scenes.append(
            {"start_segment": start, "end_segment": end, "tag": tag, "confidence": confidence,
             "intensity": intensity, "_chars": chars}
        )
    return scenes


Embedder = Callable[[list[str]], Optional[list[list[float]]]]


def analyze(
    segments: Sequence[dict],
    chapters: Sequence[dict] = (),
    *,
    language: Optional[str] = None,
    embed: Optional[Embedder] = None,
    should_stop: Callable[[], bool] = lambda: False,
) -> tuple[list[dict], bool]:
    """Scenes of a document; returns ``(scenes, refined)``."""
    windows = classify_windows(segments, chapters, language)
    refined = _refine(windows, embed, should_stop) if embed is not None else False
    return _smooth(windows), refined


def document_language(segments: Sequence[dict], hint: Optional[str] = None) -> Optional[str]:
    """The lexicon language: the document's own (``es``, ``en-GB``…) when known, else detected."""
    code = (hint or "").strip().lower()[:2]
    if code in LANGUAGES:
        return code
    if code:
        return None  # another language: no lexicon, no ambience
    return detect_language([str(seg.get("text") or "") for seg in segments])


def classify_windows(
    segments: Sequence[dict], chapters: Sequence[dict] = (), language: Optional[str] = None
) -> list[Window]:
    windows = split_windows(segments, chapters)
    language = document_language(segments, language)
    if language is None:
        return windows  # all "none"
    names = proper_names([str(seg.get("text") or "") for seg in segments], language)
    for window in windows:
        window.verdict = classify_text(window.text, language, ignore=names)
    return windows


# ── Optional refinement with local embeddings (Ollama) ──────────────────────
#: Short descriptions per tag; scenes are compared with them (bge-m3 is multilingual).
PROTOTYPES: dict[str, tuple[str, ...]] = {
    "rain": ("Llueve sin parar; las gotas golpean los cristales y el suelo mojado.", "Rain falls steadily on the roof and the wet street."),
    "storm": ("Una tormenta: truenos, relámpagos y lluvia torrencial.", "A violent storm with thunder, lightning and pouring rain."),
    "wind": ("El viento sopla con fuerza y las ráfagas silban entre las rocas.", "A cold wind gusts and howls across the open land."),
    "sea": ("El barco navega entre las olas; el mar, la espuma y las gaviotas.", "Waves break on the shore; the ship sails across the sea."),
    "forest": ("Caminan por el bosque entre árboles, hojas y cantos de pájaros.", "They walk through the forest among trees, leaves and birdsong."),
    "night": ("Una noche tranquila al aire libre, bajo la luna y las estrellas, con grillos.", "A quiet night outdoors under the moon and stars, crickets chirping."),
    "fire": ("Se calientan junto a la hoguera; el fuego crepita y las brasas brillan.", "They sit by the hearth; the fire crackles and the embers glow."),
    "tavern": ("Una taberna llena de gente que bebe, ríe y conversa.", "A crowded tavern full of people drinking, laughing and talking."),
    "city": ("Las calles de la ciudad, el tráfico, los carruajes y los transeúntes.", "Busy city streets with traffic, carriages and passers-by."),
    "interior": ("Una habitación silenciosa con una mesa, sillas y una lámpara.", "A quiet room indoors with a desk, chairs and a lamp."),
    "cave": ("Dentro de una cueva oscura, el agua gotea y el eco resuena.", "Inside a dark cave, water drips and echoes."),
    NONE: ("Conversan sobre planes, política y recuerdos; diálogo y pensamientos.", "They discuss plans, politics and memories; dialogue and thoughts."),
}
#: The best candidate must beat "none" and the next candidate by these cosine margins.
REFINE_OVER_NONE = 0.03
REFINE_OVER_NEXT = 0.02
_REFINE_MAX_WINDOWS = 600
_REFINE_CHARS = 1500
_REFINE_BATCH = 8


def _cosine(a: Sequence[float], b: Sequence[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0


def _refine(windows: list[Window], embed: Embedder, should_stop: Callable[[], bool]) -> bool:
    """Re-rank close calls among their lexicon candidates; never invents a tag."""
    pending = [w for w in windows if w.verdict.ambiguous and w.verdict.candidates][:_REFINE_MAX_WINDOWS]
    if not pending:
        return False
    names = [tag for tag in PROTOTYPES]
    texts = [text for tag in names for text in PROTOTYPES[tag]]
    vectors = embed(texts)
    if not vectors or len(vectors) != len(texts):
        return False
    proto: dict[str, list[list[float]]] = {}
    k = 0
    for tag in names:
        proto[tag] = vectors[k : k + len(PROTOTYPES[tag])]
        k += len(PROTOTYPES[tag])
    changed = False
    for start in range(0, len(pending), _REFINE_BATCH):
        if should_stop():
            break
        batch = pending[start : start + _REFINE_BATCH]
        found = embed([w.text[:_REFINE_CHARS] for w in batch])
        if not found or len(found) != len(batch):
            break
        for window, vector in zip(batch, found):
            sims = {tag: max(_cosine(vector, p) for p in proto[tag]) for tag in names}
            window.sims = sims
            ranked = sorted(window.verdict.candidates, key=lambda tag: sims[tag], reverse=True)
            best = ranked[0]
            runner = sims[ranked[1]] if len(ranked) > 1 else -1.0
            # Lexicon and embedding must agree: the best candidate is also the closest tag overall.
            overall = max(sims[tag] for tag in names if tag not in (best, NONE))
            if (
                sims[best] - sims[NONE] >= REFINE_OVER_NONE
                and sims[best] - runner >= REFINE_OVER_NEXT
                and sims[best] >= overall
            ):
                window.verdict = Verdict(best, 0.5, 0.5)
                changed = True
    return changed


_OLLAMA_URL = os.environ.get("OMNIVOICE_READER_OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
_ollama_state = {"start_tried": False}
_ollama_lock = threading.Lock()


def _ollama_enabled() -> bool:
    return os.environ.get("OMNIVOICE_READER_AMBIENCE_OLLAMA", "1").strip().lower() not in {"0", "false", "no", "off"}


def _embed_model() -> str:
    return os.environ.get("OMNIVOICE_READER_AMBIENCE_EMBED_MODEL", "bge-m3").strip() or "bge-m3"


def _http_json(path: str, payload: Optional[dict] = None, timeout: float = 2.0) -> Optional[dict]:
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    request = urllib.request.Request(
        f"{_OLLAMA_URL}{path}", data=data, headers={"Content-Type": "application/json"} if data else {}
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310 — fixed local URL
            return json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError, TimeoutError):
        return None


def _ollama_executable() -> Optional[str]:
    if sys.platform == "win32":
        local = os.environ.get("LOCALAPPDATA")
        candidate = os.path.join(local, "Programs", "Ollama", "ollama.exe") if local else None
        if candidate and os.path.isfile(candidate):
            return candidate
    return shutil.which("ollama")


def _start_ollama() -> bool:
    """Start ``ollama serve`` once per process (detached, hidden); True when it answers."""
    with _ollama_lock:
        if _ollama_state["start_tried"]:
            return False
        _ollama_state["start_tried"] = True
    exe = _ollama_executable()
    if not exe:
        return False
    kwargs: dict = {"stdin": subprocess.DEVNULL, "stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL, "close_fds": True}
    if sys.platform == "win32":
        kwargs["creationflags"] = (
            getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
            | getattr(subprocess, "DETACHED_PROCESS", 0x00000008)
            | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200)
        )
    else:
        kwargs["start_new_session"] = True
    try:
        subprocess.Popen([exe, "serve"], **kwargs)  # noqa: S603 — the user's own Ollama install
    except OSError:
        return False
    logger.info("Reader ambience: started Ollama for scene refinement")
    deadline = time.monotonic() + 15.0
    while time.monotonic() < deadline:
        if _http_json("/api/version", timeout=1.0) is not None:
            return True
        time.sleep(0.5)
    return False


def ollama_embedder() -> Optional[Embedder]:
    """An embedding function backed by a local Ollama with the model pulled, else None."""
    if not _ollama_enabled():
        return None
    tags = _http_json("/api/tags", timeout=1.0)
    if tags is None and _start_ollama():
        tags = _http_json("/api/tags", timeout=2.0)
    if not tags:
        return None
    model = _embed_model()
    names = {str(m.get("name") or m.get("model") or "") for m in tags.get("models") or []}
    if not any(name == model or name.startswith(f"{model}:") for name in names):
        return None
    # CPU only and few threads: the GPU belongs to the voice, and nothing here is urgent.
    options = {"num_gpu": 0, "num_thread": max(1, min(4, (os.cpu_count() or 2) // 2))}

    def embed(texts: list[str]) -> Optional[list[list[float]]]:
        found = _http_json(
            "/api/embed", {"model": model, "input": texts, "options": options, "keep_alive": "2m"}, timeout=120.0
        )
        if found and isinstance(found.get("embeddings"), list):
            return found["embeddings"]
        vectors = []
        for text in texts:  # older Ollama: one at a time
            single = _http_json(
                "/api/embeddings", {"model": model, "prompt": text, "options": options, "keep_alive": "2m"}, timeout=60.0
            )
            if not single or not isinstance(single.get("embedding"), list):
                return None
            vectors.append(single["embedding"])
        return vectors

    return embed


# ── Storage and background computation ──────────────────────────────────────


def _path(doc_id: str) -> str:
    return os.path.join(reader_store.document_dir(doc_id), AMBIENCE_FILE)


def fingerprint(segments: Sequence[dict]) -> str:
    digest = hashlib.sha1()
    for seg in segments:
        digest.update(str(seg.get("kind") or "").encode("utf-8"))
        digest.update(b"\x1f")
        digest.update(str(seg.get("text") or "").encode("utf-8"))
        digest.update(b"\x1e")
    return digest.hexdigest()


def _content_version() -> int:
    from services.reader_import import SEGMENTATION_VERSION

    return SEGMENTATION_VERSION


def _stored(doc_id: str, segments: Sequence[dict], language: Optional[str]) -> Optional[dict]:
    """The stored analysis when it matches the current content, else None."""
    try:
        with open(_path(doc_id), encoding="utf-8") as fh:
            stored = json.load(fh)
    except (OSError, ValueError):
        return None
    if (
        not isinstance(stored, dict)
        or stored.get("version") != AMBIENCE_VERSION
        or stored.get("content_version") != _content_version()
        or stored.get("segment_count") != len(segments)
        or stored.get("language") != (language or None)
        or stored.get("fingerprint") != fingerprint(segments)
        or not isinstance(stored.get("scenes"), list)
    ):
        return None
    return stored


def _write(doc_id: str, segments: Sequence[dict], language: Optional[str], scenes: list[dict], refined: bool) -> None:
    payload = {
        "version": AMBIENCE_VERSION,
        "content_version": _content_version(),
        "segment_count": len(segments),
        "language": language or None,
        "fingerprint": fingerprint(segments),
        "refined": refined,
        "computed_at": round(time.time(), 1),
        "scenes": scenes,
    }
    path = _path(doc_id)
    if not os.path.isdir(os.path.dirname(path)):
        return  # deleted meanwhile
    tmp = f"{path}.{os.getpid()}.{threading.get_ident()}.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)


_queue: "queue.Queue[str]" = queue.Queue()
_pending: set[str] = set()
_failed: dict[str, str] = {}
_lock = threading.Lock()
_worker: dict[str, Optional[threading.Thread]] = {"thread": None}
#: Replaceable in tests; returns an embedder or None.
embedder_factory: Callable[[], Optional[Embedder]] = ollama_embedder


def schedule(doc_id: str) -> None:
    """Queue a (re)computation in the background (no-op when already queued)."""
    with _lock:
        if doc_id in _pending:
            return
        _pending.add(doc_id)
        _failed.pop(doc_id, None)
        _queue.put(doc_id)
        thread = _worker["thread"]
        if thread is None or not thread.is_alive():
            thread = threading.Thread(target=_run, name="reader-ambience", daemon=True)
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
        try:
            compute(doc_id)
        except reader_store.DocumentNotFound:
            pass
        except Exception as exc:  # noqa: BLE001 — the worker survives any one document
            logger.warning("Reader ambience: analysis of %s failed", doc_id, exc_info=True)
            with _lock:
                _failed[doc_id] = type(exc).__name__
        finally:
            with _lock:
                _pending.discard(doc_id)
            _queue.task_done()


def compute(doc_id: str) -> dict:
    """Analyze one document now (blocking): lexicon first (stored at once), then
    the optional embedding refinement, which rewrites the file when it helps."""
    language = reader_store.get_summary(doc_id).get("language")
    content = reader_store.load_content(doc_id)
    segments, chapters = content["segments"], content["chapters"]
    windows = classify_windows(segments, chapters, language)
    scenes = _smooth(windows)
    _write(doc_id, segments, language, scenes, refined=False)
    if any(w.verdict.ambiguous for w in windows):
        embed = embedder_factory()
        if embed is not None:
            folder = reader_store.document_dir(doc_id)
            if _refine(windows, embed, lambda: not os.path.isdir(folder)):
                scenes = _smooth(windows)
                _write(doc_id, segments, language, scenes, refined=True)
    return {"status": "ready", "scenes": scenes}


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
    """Analyze a freshly imported document in the background, once the listener
    has used Automático on this machine (otherwise nothing runs)."""
    try:
        if os.path.exists(os.path.join(reader_store.reader_dir(), _ENABLED_MARKER)):
            schedule(doc_id)
    except Exception:  # noqa: BLE001 — never affects the import
        logger.debug("Reader ambience: could not schedule %s", doc_id, exc_info=True)


def status(doc_id: str) -> dict:
    """``{status: ready|computing|unavailable, scenes}``; starts computing when missing or stale.

    Raises :class:`reader_store.DocumentNotFound` for an unknown document.
    """
    doc = reader_store.get_summary(doc_id)
    if doc.get("import_status") != reader_store.IMPORT_READY:
        return {"status": "unavailable", "scenes": []}
    _mark_enabled()
    content = reader_store.load_content(doc_id)
    stored = _stored(doc_id, content["segments"], doc.get("language"))
    with _lock:
        busy = doc_id in _pending
        failed = _failed.get(doc_id)
    if stored is not None:
        return {"status": "ready", "scenes": stored["scenes"], "refined": bool(stored.get("refined"))}
    if failed and not busy:
        return {"status": "unavailable", "scenes": []}
    schedule(doc_id)
    return {"status": "computing", "scenes": []}


def wait_idle(timeout: float = 30.0) -> bool:
    """Block until no analysis is queued or running (tests)."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with _lock:
            if not _pending:
                return True
        time.sleep(0.02)
    return False
