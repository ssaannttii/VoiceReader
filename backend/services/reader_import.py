"""Turn pasted text, files and article URLs into Reader segments.

Every source is first reduced to a list of :class:`Block` (heading or body
paragraph), then :func:`segment_blocks` splits paragraphs into sentences with
the same :class:`services.sentence_chunker.SentenceChunker` the streaming TTS
path uses. Segment ``text`` is display text — normalization for TTS happens
only at synthesis time.

Stdlib only (html.parser, zipfile, ElementTree) apart from the parsers the
audiobook importer already relies on (``services.longform_import``: pypdf for
PDF, the EPUB spine walker). The URL fetch is user-initiated, SSRF-checked on
every hop (``core.url_safety``) and size/time bounded.
"""
from __future__ import annotations

import base64
import binascii
import functools
import io
import json
import os
import posixpath
import re
import struct
import unicodedata
import zipfile
from dataclasses import dataclass, field
from html.parser import HTMLParser
from typing import Callable, Optional
from urllib.parse import urljoin, urlsplit
from xml.etree import ElementTree as ET

#: Hard cap for one segment, in characters (SPEC: very long sentences are
#: split at <= 300 chars on clause punctuation/whitespace).
MAX_SEGMENT_CHARS = 300
#: Consecutive sentences of one paragraph are read as one segment up to this length.
#: Each synthesis call has a large fixed cost (~1.5 s on an RTX 2070 regardless of
#: length), so one-sentence segments of 2-3 s audio barely outpace playback and any
#: hiccup becomes an audible gap; ~280-char segments render ~5x faster than real time
#: and carry the narration's intonation across sentences.
GROUP_CHARS = 280
#: Stored in content.json; documents saved with an older layout are regrouped on load.
SEGMENTATION_VERSION = 4
#: Upload / download caps.
MAX_FILE_BYTES = 64 * 1024 * 1024
MAX_URL_BYTES = 10 * 1024 * 1024
URL_TIMEOUT_S = 20.0
MAX_REDIRECTS = 5
#: Text cap after extraction (~ a 1,500-page book) so one import can't
#: produce an unbounded content file.
MAX_TEXT_CHARS = 5_000_000
TITLE_MAX = 80
#: Rich content: nested lists keep at most three levels (depth 0–2).
MAX_LIST_DEPTH = 2
#: Images kept per document, bytes per image and per document, alt/caption length.
MAX_IMAGES = 40
MAX_IMAGE_BYTES = 5 * 1024 * 1024
MAX_IMAGES_TOTAL_BYTES = 100 * 1024 * 1024
IMAGE_TEXT_MAX = 300
#: Narrower or shorter images are decoration (icons, ornaments, tracking pixels).
MIN_IMAGE_SIDE = 48
#: Image downloads of a URL import: per image, and for all of them together.
IMAGE_TIMEOUT_S = 10.0
IMAGES_DEADLINE_S = 45.0

FILE_EXTENSIONS = (".txt", ".md", ".markdown", ".html", ".htm", ".pdf", ".epub", ".docx")


@dataclass
class Block:
    kind: str  # "h" | "p" | "li" (list item) | "quote" (block quotation) | "img"
    text: str
    level: int = 0  # heading level (1-6) for "h"
    #: A chapter starts at this block under this title without the title being
    #: read aloud (page-range chapters of a PDF, one chapter per scanned
    #: page). When any block carries one, headings no longer make chapters.
    chapter: Optional[str] = None
    #: List items: the parser's id of their list (renumbered per document), whether it
    #: is numbered, the item number and the nesting depth (0–2). Blocks of one item that
    #: holds several paragraphs share the number.
    list_id: Optional[int] = None
    ordered: bool = False
    n: int = 0
    depth: int = 0
    #: Images: where the parser found them (URL, ``data:`` URI or package member) until
    #: :func:`_attach_images` stores them, then the asset name. ``text`` stays empty.
    src: Optional[str] = None
    alt: str = ""
    caption: str = ""
    #: Pixel size read from the stored image (0 when unknown), so the page can
    #: reserve its space before it loads.
    width: int = 0
    height: int = 0


#: ``progress(fraction)`` callback for long imports (0–1).
Progress = Optional[Callable[[float], None]]


@dataclass
class ImportedDocument:
    title: str
    blocks: list[Block]
    source_type: str
    author: Optional[str] = None
    source_name: Optional[str] = None
    source_url: Optional[str] = None
    language: Optional[str] = None
    cover: Optional[tuple[bytes, str]] = None
    segments: list[dict] = field(default_factory=list)
    chapters: list[dict] = field(default_factory=list)
    #: Images referenced by ``img`` segments: asset name ("img-001.jpg") → bytes.
    assets: dict[str, bytes] = field(default_factory=dict)


class ReaderImportError(ValueError):
    """Import refused with a user-facing message (maps to HTTP 400)."""


# ── Whitespace / title helpers ───────────────────────────────────────────────

_WS_RE = re.compile(r"\s+")


def _clean(text: str) -> str:
    return _WS_RE.sub(" ", (text or "").replace("\u00ad", "")).strip()


def _short_title(text: str) -> str:
    text = _clean(text)
    if len(text) <= TITLE_MAX:
        return text
    cut = text.rfind(" ", 0, TITLE_MAX - 1)
    return (text[: cut if cut > TITLE_MAX // 2 else TITLE_MAX - 1]).rstrip(" ,;:.-") + "…"


# ── Titles and authors of imported files ─────────────────────────────────────
#
# A file name is a poor title ("9788466658898_Nacidos_bruma_v3 (1)"), and so is
# much embedded metadata ("Microsoft Word - informe.docx", "Untitled",
# "Usuario de Windows"). :func:`pick_title` takes the first metadata title that
# reads like one, then a heading the document opens with (when the file name is
# unusable, messy or shares a word with it), then the cleaned file name.

#: Titles that name a template, a placeholder or nothing at all (compared by :func:`_title_key`).
_PLACEHOLDER_TITLES = frozenset((
    "untitled", "untitled document", "sin titulo", "sans titre", "ohne titel", "senza titolo", "sem titulo",
    "document", "documento", "doc", "title", "titulo", "titre", "titel", "titolo", "new document",
    "nuevo documento", "presentation", "presentacion", "powerpoint presentation", "presentacion de powerpoint",
    "slide 1", "diapositiva 1", "pdf", "unknown", "desconocido", "none", "null", "n a", "na", "cover",
    "portada", "title page", "word", "file", "archivo", "fichero", "scan", "scanned document",
    "documento escaneado", "download", "descarga", "ebook",
))
_GENERIC_NAME_RE = re.compile(
    r"^(?:untitled|document|documento|doc|scan|scanned|escaneo|escaneado|img|image|imagen|page|p[aá]gina|dsc|"
    r"file|archivo|slide|diapositiva|new|nuevo|download|descarga)[\s._-]*\d*$",
    re.IGNORECASE,
)
#: Producer / creator software that some tools write into the title or author field.
_TOOL_RE = re.compile(
    r"\b(?:microsoft\s+(?:word|office|excel|powerpoint)|acrobat|adobe\s+(?:acrobat|indesign|illustrator|"
    r"photoshop|pdf|distiller|livecycle)|pdftex|xetex|luatex|latex\s+with\s+hyperref|ghostscript|distiller|"
    r"abbyy|finereader|calibre|libreoffice|openoffice|pdfcreator|cutepdf|primopdf|nitro\s+pdf|foxit|itext|"
    r"wkhtmltopdf|camscanner|scansnap|indesign|quarkxpress|quartz\s+pdfcontext|google\s+docs)\b",
    re.IGNORECASE,
)
_FILE_EXT_RE = re.compile(
    r"\.(?:pdf|docx?|odt|rtf|txt|tex|indd|qxd|pages|epub|mobi|azw3?|html?|xml|dvi|e?ps|ai|psd|jpe?g|png|"
    r"tiff?|pptx?|xlsx?)\s*$",
    re.IGNORECASE,
)
#: One token mixing letters with three or more digits ("DOC00123", "IMG_2041").
_CODE_TOKEN_RE = re.compile(r"^(?=\S*[^\W\d_])(?=(?:\S*\d){3})\S+$")
_DIGIT_GLUE_RE = re.compile(r"(?<=\d)[-\s.](?=\d)")
_PLACEHOLDER_AUTHORS = frozenset((
    "unknown", "unknown author", "desconocido", "autor desconocido", "admin", "administrator", "administrador",
    "user", "usuario", "owner", "propietario", "author", "autor", "windows user", "usuario de windows",
    "utilisateur windows", "microsoft office user", "usuario de microsoft office", "hp", "dell", "lenovo",
    "asus", "acer", "pc", "home", "default", "guest", "invitado", "none", "null", "n a", "na", "calibre",
))
_COPY_MARK_RE = re.compile(
    r"\s*[(\[]\d{1,3}[)\]]|\s+-\s+(?:copy|copia)(?:\s*\(\d+\))?\s*$|^(?:copy of|copia de)\s+",
    re.IGNORECASE,
)
#: Download-site tags: "(z-lib.org)", "[www.example.com]".
_SITE_TAG_RE = re.compile(
    r"[\[(][^\])]{0,60}(?:z-?lib|libgen|www\.|\.com|\.org|\.net|\.es)[^\])]{0,60}[\])]", re.IGNORECASE
)
#: File-name tokens that are versions or processing marks, never part of a title.
_NOISE_TOKEN_RE = re.compile(
    r"^(?:v\d+(?:\.\d+)*|rev\d*|ocr|ocred|compressed|optimized|comprimido|optimizado|isbn:?)$", re.IGNORECASE
)
_HEX_TOKEN_RE = re.compile(r"^(?=[0-9a-f-]*\d)(?=[0-9a-f-]*[a-f])[0-9a-f-]{12,}$", re.IGNORECASE)
_SHARED_STOPWORDS = frozenset((
    "para", "with", "from", "that", "this", "como", "sobre", "dans", "pour", "into", "their", "edition",
    "edicion", "volume", "libro", "book", "the", "and", "los", "las", "del", "une", "des",
))


def _title_key(text: str) -> str:
    """Case-, accent- and punctuation-insensitive form of a title, for comparisons."""
    folded = unicodedata.normalize("NFKD", text or "").casefold()
    folded = "".join(c for c in folded if not unicodedata.combining(c))
    return " ".join(re.findall(r"[^\W_]+", folded))


def _looks_like_path(text: str) -> bool:
    return bool(re.match(r"^(?:[A-Za-z]:[\\/]|[\\/]|(?:https?|file|ftp)://|www\.)", text)) or "\\" in text \
        or text.count("/") >= 2


def _title_junk(text: Optional[str]) -> bool:
    """Whether a metadata title / heading is a placeholder, a file name, a tool name or noise."""
    text = _clean(text or "")
    if len(text) < 2 or len(text) > 200 or sum(c.isalpha() for c in text) < 2:
        return True
    if _title_key(text) in _PLACEHOLDER_TITLES or _GENERIC_NAME_RE.match(text):
        return True
    if _TOOL_RE.search(text) or _FILE_EXT_RE.search(text) or _looks_like_path(text):
        return True
    if re.search(r"\d{9,}", _DIGIT_GLUE_RE.sub("", text)):  # an ISBN or another long number
        return True
    if " " not in text and (
        "_" in text or len(re.findall(r"[-.]", text)) >= 2 or _CODE_TOKEN_RE.match(text)
    ):
        return True  # file-name-like: "Nacidos_bruma_v3", "libro-final-ocr", "DOC00123"
    return False


def _tidy_title(text: str) -> str:
    """Collapse whitespace, drop wrapping quotes, sentence-case an all-caps phrase."""
    text = _clean(text).strip("\"'«»“”‘’ ").rstrip(" -–—|:;,")
    return _short_title(_sentence_case(text) if " " in text else text)


def _noise_token(token: str) -> bool:
    bare = token.replace("-", "")
    if bare.isdigit() and len(bare) >= 9 or re.fullmatch(r"\d{9}[Xx]", bare):
        return True  # ISBN-10/13 or another long number (dates like 2024-01-03 stay)
    return bool(_NOISE_TOKEN_RE.match(token) or _HEX_TOKEN_RE.match(token))


def filename_title(name: str) -> str:
    """A readable title from a file name ("" when nothing readable is left).

    Strips the extension, copy marks ("(1)", "- copia"), download-site tags,
    ISBNs and other long numbers, hashes and version/OCR marks; turns ``_``
    (and the ``-``/``.`` of a name without spaces) into spaces; capitalizes an
    all-lowercase name and sentence-cases an all-caps one.
    """
    base = os.path.basename((name or "").replace("\\", "/")).strip()
    stem, ext = os.path.splitext(base)
    if not re.fullmatch(r"\.[A-Za-z0-9]{1,5}", ext):
        stem = base
    text = _SITE_TAG_RE.sub(" ", stem)
    for _ in range(3):
        text = _COPY_MARK_RE.sub(" ", text).strip()
    spaced = " " in text
    text = re.sub(r"[_+]", " ", text)
    if not spaced:  # a slug: "libro-final-OCR" (a date's hyphens stay: "2024-01-03")
        text = re.sub(r"(?<=[^\W\d_])-|-(?=[^\W\d_])", " ", text)
    if not spaced and text.count(".") >= 2:
        text = text.replace(".", " ")
    text = _clean(" ".join(token for token in text.split() if not _noise_token(token))).strip(" -–—.,;:")
    if sum(c.isalpha() for c in text) < 2 or _GENERIC_NAME_RE.match(text) or _title_key(text) in _PLACEHOLDER_TITLES:
        return ""
    if text == text.lower():
        text = text[:1].upper() + text[1:]
    elif " " in text:
        text = _sentence_case(text)
    return _short_title(text)


def legacy_filename_title(name: str) -> str:
    """The title earlier versions gave a file: its stem with ``_`` as spaces."""
    base = os.path.basename(name or "")
    return _short_title(os.path.splitext(base)[0].replace("_", " ").strip())


def _filename_is_messy(name: str) -> bool:
    """Whether the file name needed cleaning (a machine name, not one a person typed)."""
    stem = os.path.splitext(os.path.basename(name or ""))[0]
    return "_" in stem or ("-" in stem and " " not in stem) or _title_key(filename_title(name)) != _title_key(stem)


_NOT_A_TITLE_RE = re.compile(
    r"^(?:contents|table of contents|[íi]ndice|sumario|contenidos?|copyright|cr[eé]ditos|"
    r"table des mati[eè]res|sommaire|inhalt|inhaltsverzeichnis|indice|sum[aá]rio)\b",
    re.IGNORECASE,
)


def _section_heading(text: str) -> bool:
    """A heading that names a part of the document ("Capítulo 1", "Prólogo", "Índice"), not the document."""
    return bool(
        _NOT_A_TITLE_RE.match(text) or _NUMBERED_HEADING_RE.match(text) or _NAMED_HEADING_RE.match(text)
        or _NUMBER_LINE_RE.match(text) or _APPARATUS_HEADING_RE.match(text)
    )


def _shares_word(left: str, right: str) -> bool:
    words = {w for w in _title_key(left).split() if len(w) >= 4 and w not in _SHARED_STOPWORDS}
    return bool(words & set(_title_key(right).split()))


def pick_title(metadata: list, *, filename: str = "", heading: Optional[str] = None) -> str:
    """The best title for an imported file ("" when nothing qualifies).

    ``metadata`` titles in order of trust (junk ones are skipped); then
    ``heading`` — a heading the document opens with — when the cleaned file
    name is empty, was messy, or shares a word with it; then the cleaned name.
    """
    for candidate in metadata:
        if candidate and not _title_junk(candidate):
            return _tidy_title(candidate)
    from_name = filename_title(filename) if filename else ""
    if heading and not _title_junk(heading) and not _section_heading(_clean(heading)) and (
        not from_name or _filename_is_messy(filename) or _shares_word(heading, from_name)
    ):
        return _tidy_title(heading)
    return from_name


def _author_junk(text: str) -> bool:
    text = _clean(text)
    if len(text) < 2 or len(text) > 150 or sum(c.isalpha() for c in text) < 2:
        return True
    if _title_key(text) in _PLACEHOLDER_AUTHORS or _TOOL_RE.search(text) or _looks_like_path(text):
        return True
    # Account names: digits, "_", e-mail addresses, a lone lowercase login ("jdoe").
    return bool(re.search(r"[\d_@]", text) or re.fullmatch(r"[a-z][a-z.-]*", text))


def pick_author(candidates: list) -> Optional[str]:
    """The first candidate that reads like a person's (or organization's) name."""
    for candidate in candidates:
        text = _clean(candidate or "")
        if text and not _author_junk(text):
            if _is_shouted(text):
                text = " ".join(word[:1].upper() + word[1:].lower() for word in text.split(" "))
            return text[:150]
    return None


# ── Segmentation ─────────────────────────────────────────────────────────────

_CLAUSE_BREAK_RE = re.compile(r"[,;:)\]—–](?=\s)")


def split_long(sentence: str, limit: int = MAX_SEGMENT_CHARS) -> list[str]:
    """Split ``sentence`` into pieces of at most ``limit`` characters.

    Prefers the last clause punctuation (``, ; : ) —``) in the window, then
    the last whitespace, then a hard cut. Pieces are substrings of the input.
    """
    out: list[str] = []
    rest = sentence.strip()
    while len(rest) > limit:
        window = rest[: limit + 1]
        cut = -1
        for match in _CLAUSE_BREAK_RE.finditer(window):
            if match.end() <= limit and match.end() >= limit * 0.35:
                cut = match.end()
        if cut < 0:
            space = window.rfind(" ", 0, limit + 1)
            cut = space if space > limit * 0.35 else limit
        piece = rest[:cut].strip()
        if piece:
            out.append(piece)
        rest = rest[cut:].strip()
    if rest:
        out.append(rest)
    return out


def split_sentences(text: str, language: Optional[str]) -> list[str]:
    from services.sentence_chunker import SentenceChunker

    chunker = SentenceChunker(language=(language or "en"))
    sentences = chunker.push(text)
    sentences.extend(chunker.flush())
    out: list[str] = []
    for sentence in sentences or [text]:
        out.extend(split_long(sentence))
    return out


#: Segment fields beyond i/text/para/kind: list items (``list``, ``ordered``, ``n``,
#: ``depth``) and images (``src``, ``alt``, ``caption``, pixel size ``w``/``h``).
#: Carried through regrouping.
_EXTRA_KEYS = ("list", "ordered", "n", "depth", "src", "alt", "caption", "w", "h")
#: Kinds whose sentences are read as running text and may be grouped within their paragraph.
_PROSE_KINDS = ("p", "li", "quote")


def _extras(seg: dict) -> dict:
    return {key: seg[key] for key in _EXTRA_KEYS if key in seg}


def group_segments(segments: list[dict], limit: Optional[int] = None) -> tuple[list[dict], list[int]]:
    """Merge consecutive sentences of the same paragraph up to ``limit`` chars.

    Only body text, list items and quotes are merged, each within its own paragraph
    (a list item never joins its siblings). Returns the regrouped segments
    (renumbered) and, for every input index, the index of the segment that now
    contains it. Headings and images are never merged.
    """
    limit = GROUP_CHARS if limit is None else limit
    out: list[dict] = []
    mapping: list[int] = []
    for seg in segments:
        prev = out[-1] if out else None
        if (
            prev is not None
            and seg["kind"] in _PROSE_KINDS
            and prev["kind"] == seg["kind"]
            and prev["para"] == seg["para"]
            and len(prev["text"]) + 1 + len(seg["text"]) <= limit
        ):
            prev["text"] = f"{prev['text']} {seg['text']}"
        else:
            out.append({"i": len(out), "text": seg["text"], "para": seg["para"], "kind": seg["kind"], **_extras(seg)})
        mapping.append(len(out) - 1)
    return out, mapping


_TERMINAL_END_RE = re.compile(r"[.!?…:;»”\"')\]]\s*$")
_STARTS_LOWER_RE = re.compile(r"^[\s«“\"'(¿¡—–-]*[a-zà-öø-ÿ]")
#: Marks that only ever continue a sentence. Not "…" or a dash, which can open one, nor
#: "»", which opens every follow-on paragraph of a quotation in Spanish.
_CONTINUES_RE = re.compile(r"^\s*[,.;:?!)\]”]")


def _is_shouted(text: str) -> bool:
    letters = [c for c in text if c.isalpha()]
    return len(letters) >= 3 and all(c.isupper() for c in letters)


def _sentence_case(text: str) -> str:
    return text[:1].upper() + text[1:].lower() if _is_shouted(text) else text


def _join_text(left: str, right: str) -> str:
    # "inter-" + "rumpido" → "interrumpido" (a hyphenated line break), else a space.
    if re.search(r"[a-zà-ÿ]-$", left) and _STARTS_LOWER_RE.match(right):
        return left[:-1] + right.lstrip()
    return f"{left} {right}"


#: Words a sentence cannot end on: a paragraph ending in one was cut mid-sentence even
#: when the next starts with a capital ("Había incumplido su" + "Contrato.").
_OPEN_ENDINGS = frozenset(
    "de del la las el los lo un una unos unas y e o u ni que a al en con por para su sus mi mis tu tus "
    "se sin sobre entre hasta desde hacia como pero si cuando donde este esta estos estas ese esa "
    "esos esas aquel aquella es era son fue muy más menos "
    "the a an of to in on at and or but nor that his her its their my your with for by from as is was".split()
)


def _paragraph_continuation(left: str, right: str) -> Optional[str]:
    """``left + right`` as one sentence when a paginated source split them, else None.

    * ``right`` opens with a mark that only continues a sentence: an italic run set
      apart ("No hemos prestado atención" + ", pensó.") or a stray final ".".
    * ``left`` stops mid-sentence (no end punctuation) and ``right`` goes on in
      lowercase, after an ellipsis ("Me pregunto" + "…"), or after a word a sentence
      cannot end on, or ``left`` is a lone dialogue dash.
    """
    if _CONTINUES_RE.match(right):
        return left.rstrip() + right.lstrip()
    if _TERMINAL_END_RE.search(left):
        return None
    if _STARTS_LOWER_RE.match(right):
        return _join_text(left, right)
    stripped = right.lstrip()
    if stripped.startswith("…") or left.strip() in ("—", "–", "-"):
        return left.rstrip() + stripped
    last = re.search(r"(\w+)\W*$", left.lower())
    if left.rstrip().endswith(",") or (last and last.group(1) in _OPEN_ENDINGS):
        return f"{left.rstrip()} {stripped}"
    return None


def is_paginated(source_type: Optional[str], source_name: Optional[str]) -> bool:
    """PDFs and scans are laid out in pages and lines, so their paragraphs can be cut."""
    return source_type == "scan" or (source_name or "").lower().endswith(".pdf")


def repair_segments(
    segments: list[dict],
    chapters: list[dict],
    limit: Optional[int] = None,
    *,
    paginated: bool = False,
) -> tuple[list[dict], list[dict], list[int]]:
    """Fix layout artefacts of paginated sources, then regroup.

    * A shouted line followed by lowercase text ("VIN ATERRIZÓ CON SUAVIDAD" + "en el
      húmedo…") is a book's small-caps chapter opening, not a heading: it is read on
      into its sentence and kept only as the chapter title (sentence case).
    * Only for ``paginated`` sources (PDF, scans): a paragraph that stops without end
      punctuation and is followed by one starting in lowercase was cut by a page or
      line break: they are joined (also across a hyphenated break). Elsewhere such
      paragraphs are deliberate (list items, verse).

    Returns the new segments, remapped chapters and, for every old index, its new index.
    """
    # Mutable copies; "olds" lists the old indices folded into each, "x" the extra fields.
    work: list[dict] = []
    for seg in segments:
        work.append({"text": seg["text"], "para": seg["para"], "kind": seg["kind"], "olds": [seg["i"]], "x": _extras(seg)})
    titles = {c["segment"]: c for c in chapters}

    out: list[dict] = []
    leadins: set[int] = set()  # old indices of small-caps openings read into their sentence
    for seg in work:
        prev = out[-1] if out else None
        if (
            prev is not None
            and prev["kind"] == "h"
            and _is_shouted(prev["text"])
            and seg["kind"] == "p"
            and _STARTS_LOWER_RE.match(seg["text"])
        ):
            # Small-caps opening: becomes the start of this paragraph's first sentence.
            # Sentence case so the engine does not spell the opening as an acronym.
            prev.update(text=f"{_sentence_case(prev['text'])} {seg['text']}", kind="p", para=seg["para"])
            leadins.update(prev["olds"])
            prev["olds"].extend(seg["olds"])
            continue
        joined = (
            _paragraph_continuation(prev["text"], seg["text"])
            if paginated and prev is not None and prev["kind"] == "p" and seg["kind"] == "p" and prev["para"] != seg["para"]
            else None
        )
        if joined is not None:
            # Broken paragraph: continue the sentence, and the rest of this paragraph
            # joins the previous one.
            prev["text"] = joined
            prev["olds"].extend(seg["olds"])
            prev["_absorb"] = seg["para"]
            continue
        if prev is not None and prev.get("_absorb") == seg["para"] and seg["kind"] == "p":
            seg = {**seg, "para": prev["para"]}
            seg["_absorb"] = prev["_absorb"]
        out.append(seg)

    # Merged segments can outgrow the per-segment limit: split them again.
    split: list[dict] = []
    for seg in out:
        pieces = split_long(seg["text"]) if len(seg["text"]) > MAX_SEGMENT_CHARS else [seg["text"]]
        for n, piece in enumerate(pieces):
            split.append(
                {"text": piece, "para": seg["para"], "kind": seg["kind"], "olds": seg["olds"] if n == 0 else [], "x": seg["x"]}
            )

    # Renumber paragraphs densely, then regroup sentences.
    para_ids: dict[int, int] = {}
    staged: list[dict] = []
    first_of: dict[int, int] = {}
    for idx, seg in enumerate(split):
        para = para_ids.setdefault(seg["para"], len(para_ids))
        staged.append({"i": idx, "text": seg["text"], "para": para, "kind": seg["kind"], **seg["x"]})
        for old in seg["olds"]:
            first_of.setdefault(old, idx)
    grouped, group_map = group_segments(staged, limit)

    mapping: list[int] = []
    last = 0
    for old in range(len(segments)):
        if old in first_of:
            last = group_map[first_of[old]]
        mapping.append(last)

    new_chapters = []
    for chapter in chapters:
        target = mapping[chapter["segment"]] if chapter["segment"] < len(mapping) else len(grouped)
        title = _sentence_case(chapter["title"]) if chapter["segment"] in leadins else chapter["title"]
        if new_chapters and new_chapters[-1]["segment"] == target:
            continue
        new_chapters.append({**chapter, "title": title, "segment": target})
    return grouped, new_chapters, mapping


def segment_blocks(
    blocks: list[Block], language: Optional[str], progress: Progress = None, *, paginated: bool = False
) -> tuple[list[dict], list[dict]]:
    """``(segments, chapters)`` for a block list.

    Chapters are the headings at the document's top heading level (``#`` in
    Markdown, EPUB/PDF chapter titles, ``Heading 1`` in DOCX) — or, when any
    block carries a :attr:`Block.chapter` marker, exactly those markers.
    ``progress`` is called with the fraction of blocks done.
    """
    segments: list[dict] = []
    chapters: list[dict] = []
    marked = any(b.chapter for b in blocks)
    levels = [b.level for b in blocks if b.kind == "h" and _clean(b.text)]
    top = None if marked or not levels else min(levels)
    para = 0
    list_ids: dict[int, int] = {}  # parser list id → dense per-document id
    step = max(1, len(blocks) // 50)
    for number, block in enumerate(blocks):
        if progress is not None and number % step == 0:
            progress(number / len(blocks))
        if block.chapter:
            if chapters and chapters[-1]["segment"] == len(segments):
                chapters[-1]["title"] = _short_title(block.chapter)  # an empty range: replace it
            else:
                chapters.append({"title": _short_title(block.chapter), "segment": len(segments)})
        if block.kind == "img":
            # One silent segment per image, its own paragraph.
            if block.src:
                image = {"i": len(segments), "text": "", "para": para, "kind": "img", "src": block.src}
                for key in ("alt", "caption"):
                    value = _clean(getattr(block, key))[:IMAGE_TEXT_MAX]
                    if value:
                        image[key] = value
                if block.width > 0 and block.height > 0:
                    image["w"], image["h"] = block.width, block.height
                segments.append(image)
                para += 1
            continue
        text = _clean(block.text)
        if not text:
            continue
        extra: dict = {}
        if block.kind == "h":
            if block.level == top:
                chapters.append({"title": _short_title(text), "segment": len(segments)})
            pieces = split_long(text)
            kind = "h"
        else:
            pieces = split_sentences(text, language)
            kind = block.kind if block.kind in ("li", "quote") else "p"
            if kind == "li":
                key = block.list_id if block.list_id is not None else -1 - number
                extra = {"list": list_ids.setdefault(key, len(list_ids)), "ordered": bool(block.ordered), "n": max(1, block.n)}
                if block.depth > 0:
                    extra["depth"] = min(block.depth, MAX_LIST_DEPTH)
        for piece in pieces:
            segments.append({"i": len(segments), "text": piece, "para": para, "kind": kind, **extra})
        para += 1
    segments, chapters, _mapping = repair_segments(segments, chapters, paginated=paginated)
    if marked:
        chapters = [c for c in chapters if c["segment"] < len(segments)]
    if progress is not None:
        progress(1.0)
    return segments, chapters


# ── Language guess ───────────────────────────────────────────────────────────

_STOPWORDS = {
    "en": "the and of to in is that it was for on with as he she you are this be at by not have from or but they his her",
    "es": "el la de que y en los las del se por un una con no para es al lo como más pero sus le ya o este fue ha",
    "fr": "le la les de des et est un une du que qui dans pour pas au sur ne se ce il elle avec sont mais",
    "de": "der die und das ist nicht den von zu mit sich des auf für ein eine im dem auch es an als wie",
    "it": "il di che la e è un una per non del della sono gli le con si da ma come anche questo nel alla",
    "pt": "o a de que e do da em um uma para com não os as no na por mais se dos das ao foi mas é",
}
_STOPSETS = {lang: set(words.split()) for lang, words in _STOPWORDS.items()}
_WORD_RE = re.compile(r"[^\W\d_]+", re.UNICODE)


def guess_language(text: str) -> Optional[str]:
    """ISO 639-1 guess among es/en/fr/de/it/pt from stopword counts, or None."""
    words = [w.lower() for w in _WORD_RE.findall((text or "")[:40_000])][:6000]
    if len(words) < 3:
        return None
    scores = {lang: sum(1 for w in words if w in stops) for lang, stops in _STOPSETS.items()}
    ranked = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)
    best, score = ranked[0]
    runner_up = ranked[1][1]
    if score < 2 or score < runner_up * 1.15:
        return None
    return best


# ── Plain text / Markdown ────────────────────────────────────────────────────

_MD_HEADING_RE = re.compile(r"^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$")
_MD_SETEXT_RE = re.compile(r"^\s{0,3}(=+|-+)\s*$")
_MD_FENCE_RE = re.compile(r"^\s{0,3}(```|~~~)")
_MD_RULE_RE = re.compile(r"^\s{0,3}([-*_])(\s*\1){2,}\s*$")
_MD_LIST_ITEM_RE = re.compile(r"^(\s*)(?:[-*+]|(\d{1,3})[.)])\s+(.*)$")
_MD_TASK_RE = re.compile(r"^\[[ xX]\]\s+")
_MD_QUOTE_RE = re.compile(r"^\s*(?:>\s?)+")
#: ``![alt](src "title")`` with the parts captured (the title becomes the caption).
_MD_IMAGE_REF_RE = re.compile(r"!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+[\"'(]([^\"')]*)[\"')])?\s*\)")
_MD_EMPTY_LINK_RE = re.compile(r"\[\s*\]\([^)]*\)")
#: Rich EPUB script lines (see :class:`_RichEpubExtractor`): MARK + JSON + END + text.
_RICH_MARK = "\ue000"
_RICH_END = "\ue001"
_MD_TABLE_SEP_RE = re.compile(r"^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$")
_MD_IMAGE_RE = re.compile(r"!\[([^\]]*)\]\([^)]*\)")
_MD_LINK_RE = re.compile(r"\[([^\]]+)\]\([^)]*\)")
_MD_REF_LINK_RE = re.compile(r"\[([^\]]+)\]\[[^\]]*\]")
_MD_CODE_RE = re.compile(r"`+([^`]*)`+")
_MD_STRONG_RE = re.compile(r"(\*\*|__)(?=\S)(.+?)(?<=\S)\1")
_MD_EM_RE = re.compile(r"(?<![\w*])\*(?=\S)([^*]+?)(?<=\S)\*(?![\w*])")
_MD_EM_US_RE = re.compile(r"(?<![\w_])_(?=\S)([^_]+?)(?<=\S)_(?![\w_])")
_MD_HTML_RE = re.compile(r"</?[A-Za-z][^>]{0,200}>")
_TERMINAL_RE = re.compile(r"[.!?…:;\"”’)]$")


def _strip_inline_md(text: str) -> str:
    text = _MD_IMAGE_RE.sub(r"\1", text)
    text = _MD_LINK_RE.sub(r"\1", text)
    text = _MD_REF_LINK_RE.sub(r"\1", text)
    text = _MD_CODE_RE.sub(r"\1", text)
    text = _MD_STRONG_RE.sub(r"\2", text)
    text = _MD_EM_RE.sub(r"\1", text)
    text = _MD_EM_US_RE.sub(r"\1", text)
    text = _MD_HTML_RE.sub("", text)
    return text


def _reflow(lines: list[str]) -> list[str]:
    """Paragraphs from one blank-line-free run of lines.

    Hard-wrapped prose (PDF text layers, 72-column .txt) has short line widths
    and a short last line per paragraph: join until a line that is clearly
    shorter than the wrap width. Text whose lines are long (one paragraph per
    line: EPUB, pasted articles) keeps every line as its own paragraph.
    """
    lines = [ln.strip() for ln in lines if ln.strip()]
    if len(lines) <= 1:
        return lines
    widths = sorted(len(ln) for ln in lines)
    width = widths[int(0.9 * (len(widths) - 1))]
    if width > 120 or width < 35:
        return lines
    paragraphs: list[str] = []
    current = ""
    for index, ln in enumerate(lines):
        if current:
            if current.endswith("-") and len(current) > 1 and current[-2].isalpha() and ln[:1].islower():
                current = current[:-1] + ln
            else:
                current = f"{current} {ln}"
        else:
            current = ln
        nxt = lines[index + 1] if index + 1 < len(lines) else ""
        # A paragraph ends on a clearly short line, or on a sentence end when
        # the next line's first word would have fit on this one (the wrapper
        # would have pulled it up had it been the same paragraph).
        next_word = nxt.split(" ", 1)[0]
        ends_sentence = bool(_TERMINAL_RE.search(ln)) and nxt[:1].isupper()
        if len(ln) < 0.72 * width or (ends_sentence and len(ln) + 1 + len(next_word) <= widths[-1]):
            paragraphs.append(current)
            current = ""
    if current:
        paragraphs.append(current)
    return paragraphs


def _rich_line(line: str, blocks: list[Block]) -> None:
    """One marked line of a rich EPUB script → a list item, quote, image or caption."""
    head, _sep, body = line[len(_RICH_MARK):].partition(_RICH_END)
    try:
        meta = json.loads(head)
    except ValueError:
        meta = {}
    kind = meta.get("t") if isinstance(meta, dict) else None
    if kind == "img":
        blocks.append(Block("img", "", src=str(meta.get("src") or "") or None, alt=str(meta.get("alt") or "")))
    elif kind == "cap" and blocks and blocks[-1].kind == "img" and not blocks[-1].caption:
        blocks[-1].caption = body
    elif kind == "li":
        blocks.append(Block(
            "li", body, list_id=int(meta.get("list") or 0), ordered=bool(meta.get("o")),
            n=int(meta.get("n") or 1), depth=int(meta.get("d") or 0),
        ))
    elif kind == "quote":
        blocks.append(Block("quote", body))
    elif _clean(body):
        blocks.append(Block("p", body))


def parse_markdown(text: str, *, markdown: bool = True, rich: bool = False) -> list[Block]:
    """Blocks from Markdown (or plain text with ``# `` chapter headings).

    Markdown lists become ``li`` blocks (nesting by indentation, numbering from the
    first item), ``>`` lines ``quote`` paragraphs and ``![alt](src "title")`` images
    ``img`` blocks placed after their paragraph. ``markdown=False`` recognizes only
    ATX headings (the chapter-script grammar ``services.longform_import`` emits) and
    leaves inline characters alone; ``rich`` also reads the marked lines of a rich
    EPUB script.
    """
    blocks: list[Block] = []
    pending: list[str] = []
    pending_kind = "p"
    in_fence = False
    lists: list[dict] = []  # open lists, outermost first: indent, id, ordered, n
    list_seq = 0
    last_item: Optional[Block] = None  # list item a lazy continuation line extends

    def flush() -> None:
        nonlocal pending_kind
        if not pending:
            return
        for paragraph in _reflow(pending):
            images: list[Block] = []
            if markdown:
                images = [
                    Block("img", "", src=m.group(2), alt=_strip_inline_md(m.group(1)), caption=m.group(3) or "")
                    for m in _MD_IMAGE_REF_RE.finditer(paragraph)
                ]
                paragraph = _MD_EMPTY_LINK_RE.sub("", _MD_IMAGE_REF_RE.sub("", paragraph))
            body = _strip_inline_md(paragraph) if markdown else paragraph
            if _clean(body):
                blocks.append(Block(pending_kind, body))
            blocks.extend(images)
        pending.clear()
        pending_kind = "p"

    def close_lists() -> None:
        nonlocal last_item
        lists.clear()
        last_item = None

    def list_item(indent: int, ordered: bool, start: int, body: str) -> None:
        nonlocal list_seq, last_item
        while lists and indent < lists[-1]["indent"]:
            lists.pop()
        top = lists[-1] if lists else None
        if top is None or (indent >= top["indent"] + 2 and len(lists) <= MAX_LIST_DEPTH):
            list_seq += 1
            lists.append({"indent": indent, "id": list_seq, "ordered": ordered, "n": start})
        elif top["ordered"] != ordered:
            list_seq += 1
            lists[-1] = {"indent": top["indent"], "id": list_seq, "ordered": ordered, "n": start}
        else:
            top["n"] += 1
        top = lists[-1]
        last_item = Block("li", body, list_id=top["id"], ordered=top["ordered"], n=top["n"], depth=len(lists) - 1)
        blocks.append(last_item)

    for raw in (text or "").replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        if rich and raw.startswith(_RICH_MARK):
            flush()
            close_lists()
            _rich_line(raw, blocks)
            continue
        if markdown and _MD_FENCE_RE.match(raw):
            flush()
            close_lists()
            in_fence = not in_fence
            continue
        if in_fence:
            continue  # code is not narrated
        heading = _MD_HEADING_RE.match(raw)
        if heading:
            flush()
            close_lists()
            title = _strip_inline_md(heading.group(2)) if markdown else heading.group(2)
            if _clean(title):
                blocks.append(Block("h", title, level=len(heading.group(1))))
            continue
        if markdown:
            setext = _MD_SETEXT_RE.match(raw)
            if setext and len(pending) == 1 and pending[0].strip():
                title = _strip_inline_md(pending[0])
                pending.clear()
                pending_kind = "p"
                blocks.append(Block("h", title, level=1 if setext.group(1)[0] == "=" else 2))
                continue
            if _MD_RULE_RE.match(raw) or _MD_TABLE_SEP_RE.match(raw):
                flush()
                close_lists()
                continue
            quote = _MD_QUOTE_RE.match(raw)
            line = raw[quote.end():] if quote else raw
            item = _MD_LIST_ITEM_RE.match(line)
            if item:
                flush()
                body = _strip_inline_md(_MD_TASK_RE.sub("", item.group(3)))
                number = item.group(2)
                list_item(len(item.group(1).expandtabs(4)), number is not None, int(number or 1), body)
                continue
            if line.strip().startswith("|") and line.strip().endswith("|"):
                flush()
                close_lists()
                cells = [c.strip() for c in line.strip().strip("|").split("|")]
                pending.append(", ".join(c for c in cells if c))
                flush()
                continue
            if not line.strip():
                flush()
                last_item = None
                continue
            if last_item is not None:
                # A lazy continuation line of the item above.
                last_item.text = f"{last_item.text} {_strip_inline_md(line.strip())}"
                continue
            if lists and line[:1] in (" ", "\t"):
                # An indented paragraph after a blank line: more of the open item.
                top = lists[-1]
                last_item = Block(
                    "li", _strip_inline_md(line.strip()), list_id=top["id"], ordered=top["ordered"],
                    n=top["n"], depth=len(lists) - 1,
                )
                blocks.append(last_item)
                continue
            close_lists()
            kind = "quote" if quote else "p"
            if pending and pending_kind != kind:
                flush()
            pending_kind = kind
            raw = line
        if not raw.strip():
            flush()
            continue
        pending.append(raw)
    flush()
    return blocks


def _first_line(text: str) -> str:
    for line in (text or "").splitlines():
        cleaned = _clean(_strip_inline_md(_MD_HEADING_RE.sub(r"\2", line)))
        if cleaned:
            return cleaned
    return ""


# ── HTML / article extraction ────────────────────────────────────────────────


_IMAGE_NOISE_CLASS = re.compile(
    r"(^|[\s_-])(icons?|logos?|avatars?|emojis?|sprites?|badges?|spinner|loader|pixel|tracking|tracker|"
    r"spacer|gravatar|ads?|advert|share|social)([\s_-]|$)",
    re.IGNORECASE,
)
_IMAGE_NOISE_PATH = re.compile(r"pixel|spacer|tracking|beacon|/ads?/|gravatar|emoji|/icons?/|favicon|logo", re.IGNORECASE)
_LAZY_SRC_ATTRS = ("data-src", "data-original", "data-lazy-src", "data-url", "data-hi-res-src")
_RASTER_DATA_PREFIXES = ("data:image/png", "data:image/jpeg", "data:image/jpg", "data:image/gif", "data:image/webp", "data:image/avif")


def _px(value: Optional[str]) -> Optional[int]:
    match = re.match(r"\s*(\d{1,5})(?:\.\d+)?\s*(?:px)?\s*$", value or "")
    return int(match.group(1)) if match else None


def _srcset_best(srcset: str) -> str:
    """The widest candidate up to 1600 px of a ``srcset`` (else its first)."""
    best, best_width, first = "", -1, ""
    for part in re.split(r",\s+", (srcset or "").strip()):
        bits = part.split()
        if not bits:
            continue
        first = first or bits[0]
        width = 0
        if len(bits) > 1 and bits[1].lower().endswith("w") and bits[1][:-1].isdigit():
            width = int(bits[1][:-1])
        if best_width < width <= 1600:
            best, best_width = bits[0], width
    return best or first


def _html_image(attrs: dict) -> Optional[tuple[str, str]]:
    """``(src, alt)`` of a content ``<img>``, or ``None`` for decoration: tiny or
    tracking images, icons, logos, avatars (by size attributes or class/path hints),
    SVG (never served) and lazy-load placeholders without a real source."""
    if attrs.get("aria-hidden") == "true" or (attrs.get("role") or "").lower() == "presentation":
        return None
    if _IMAGE_NOISE_CLASS.search(f"{attrs.get('class') or ''} {attrs.get('id') or ''}"):
        return None
    width, height = _px(attrs.get("width")), _px(attrs.get("height"))
    if (width is not None and width < MIN_IMAGE_SIDE) or (height is not None and height < MIN_IMAGE_SIDE):
        return None
    src = (attrs.get("src") or "").strip()
    lazy = next((attrs[key].strip() for key in _LAZY_SRC_ATTRS if (attrs.get(key) or "").strip()), "")
    if lazy and (not src or src.startswith("data:")):
        src = lazy
    if not src or (src.startswith("data:") and len(src) < 200):  # a placeholder pixel
        src = _srcset_best(attrs.get("srcset") or attrs.get("data-srcset") or "") or src
    if not src:
        return None
    lowered = src.lower()
    if lowered.startswith("data:"):
        if not lowered.startswith(_RASTER_DATA_PREFIXES):
            return None
    else:
        try:
            path = urlsplit(src).path.lower()
        except ValueError:
            return None
        if path.endswith((".svg", ".svgz")) or _IMAGE_NOISE_PATH.search(path):
            return None
    return src, _clean(attrs.get("alt") or "")


class _ArticleParser(HTMLParser):
    """Main-content extraction with the stdlib parser.

    Collects ``h1-h3``, ``p``, ``li`` and ``blockquote`` text (plus loose text
    inside ``div``-like containers), tagging each block with the ``<article>``
    and ``<main>`` it sits in so the caller can prefer real article content
    over the page chrome around it. List items keep their list (id, numbering,
    nesting), blockquote paragraphs become quotes, and content images (``<img>``,
    ``<figure>`` with its ``<figcaption>``) become image blocks; any other text
    inside a ``<figure>`` (embeds, pull quotes, code) is not read.
    """

    _DROP = {
        "script", "style", "noscript", "nav", "aside", "footer", "form", "template",
        "svg", "button", "select", "textarea", "iframe", "canvas", "object", "dialog",
        "menu",
    }
    _BLOCKS = {"h1": 1, "h2": 2, "h3": 3, "h4": 4, "h5": 5, "h6": 6, "p": 0, "li": 0, "blockquote": 0, "pre": 0, "dd": 0, "dt": 0, "td": 0, "th": 0, "figcaption": 0}
    _BOUNDARY = {"div", "section", "br", "tr", "table", "ul", "ol", "header", "main", "article", "body", "hr", "dl"}
    _VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}
    #: Dropping one of these (a footnote marker, an edit link) must not split the paragraph around it.
    _INLINE = {"sup", "sub", "span", "a", "small", "abbr", "cite", "b", "i", "em", "strong", "button", "svg"}
    _HIDDEN_ROLE = {"navigation", "banner", "contentinfo", "complementary", "search", "menu", "menubar", "dialog"}
    _NOISE_CLASS = re.compile(
        r"(^|[\s_-])(nav|navbar|menu|footer|sidebar|share|sharing|social|comments?|related|newsletter|"
        r"subscribe|promo|advert|ads?|cookie|breadcrumbs?|popup|modal|byline-share)([\s_-]|$)",
        re.IGNORECASE,
    )

    _NEVER_DROP = {"html", "body", "main", "article"}
    _APPARATUS_CLASS = re.compile(
        r"(infobox|navbox|vertical-navbox|hatnote|dablink|reference|references|reflist|"
        r"mw-references-wrap|mw-editsection|mw-jump-link|mw-cite-backlink|toc|metadata|"
        r"ambox|sistersitebox|noprint|printfooter|catlinks|sidebar|shortdescription|"
        r"thumb|thumbinner|gallery|footnotes?|citation-needed)(-[\w-]+)?",
        re.IGNORECASE,
    )

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.meta: dict[str, str] = {}
        self.title_tag = ""
        self._in_title = False
        self._stack: list[tuple[str, bool]] = []  # (tag, drops)
        self._drop_depth = 0
        self._article_depth = 0
        self._article_index = -1
        self._article_count = 0
        self._main_depth = 0
        self._block_stack: list[str] = []
        self._buffer: list[str] = []
        self._lists: list[dict] = []  # open ul/ol: list, ordered, n (last item number)
        self._list_seq = 0
        self._items: list[dict] = []  # open li: list, ordered, n, depth
        self._quote_depth = 0
        self._figure_depth = 0
        self._figure: dict = {}  # outermost open figure: img, caption parts
        self._caption_depth = 0
        self._images: list[dict] = []  # images seen since the last flush
        #: (kind, level, text, article_index | -1, in_main, extra | None)
        self.blocks: list[tuple[str, int, str, int, bool, Optional[dict]]] = []

    # -- helpers
    def _flush(self) -> None:
        text = _clean("".join(self._buffer))
        self._buffer = []
        article = self._article_index if self._article_depth else -1
        if text:
            tag = self._block_stack[-1] if self._block_stack else ""
            level = self._BLOCKS.get(tag, 0)
            kind = "h" if level else ("p" if tag else "loose")
            extra = None
            if not level and self._items and "li" in self._block_stack:
                kind, extra = "li", dict(self._items[-1])
            elif not level and self._quote_depth:
                kind = "quote"
            self.blocks.append((kind, level, text, article, self._main_depth > 0, extra))
        # Images inside a paragraph follow it.
        for image in self._images:
            self.blocks.append(("img", 0, "", article, self._main_depth > 0, image))
        self._images = []

    def _is_dropped(self, tag: str, attrs: dict) -> bool:
        if tag in self._DROP:
            return True
        if attrs.get("hidden") is not None or attrs.get("aria-hidden") == "true":
            return True
        if (attrs.get("role") or "").lower() in self._HIDDEN_ROLE:
            return True
        style = (attrs.get("style") or "").replace(" ", "").lower()
        if "display:none" in style or "visibility:hidden" in style:
            return True
        marker = f"{attrs.get('class') or ''} {attrs.get('id') or ''}"
        if tag in ("div", "section", "ul", "span", "aside", "header") and self._NOISE_CLASS.search(marker):
            return True
        # Reference apparatus and wiki chrome on any element: infoboxes, hatnotes,
        # footnote markers, edit links, navboxes, tables of contents. Whole class
        # tokens only — page-level feature classes such as Wikipedia's
        # "vector-feature-toc-pinned" must not take the article down with them.
        if tag not in self._NEVER_DROP and any(
            self._APPARATUS_CLASS.fullmatch(token) for token in marker.split()
        ):
            return True
        return False

    # -- parser callbacks
    def handle_starttag(self, tag, attrs):
        attr = {k.lower(): (v if v is not None else "") for k, v in attrs}
        if tag == "meta":
            key = (attr.get("property") or attr.get("name") or "").lower()
            if key and attr.get("content") and key not in self.meta:
                self.meta[key] = attr["content"]
            return
        if tag == "title" and not self.title_tag:
            self._in_title = True
            return
        if tag == "img":
            image = None if self._drop_depth else _html_image(attr)
            if image is not None:
                if self._figure_depth:
                    self._figure.setdefault("img", image)
                else:
                    self._images.append({"src": image[0], "alt": image[1], "caption": ""})
            return
        if tag in self._VOID:
            if tag in ("br", "hr") and not self._drop_depth:
                if self._block_stack:
                    self._buffer.append(" ")
                else:
                    self._flush()
            return
        drops = self._drop_depth == 0 and self._is_dropped(tag, attr)
        self._stack.append((tag, drops))
        if drops or self._drop_depth:
            if drops and tag not in self._INLINE:
                self._flush()
            self._drop_depth += 1 if drops else 0
            return
        if tag == "figure":
            if not self._figure_depth:
                self._flush()
                self._figure = {"caption": []}
            self._figure_depth += 1
        elif tag == "figcaption" and self._figure_depth:
            self._caption_depth += 1
        elif tag in ("ul", "ol"):
            self._list_seq += 1
            start = _px(attr.get("start")) if tag == "ol" else None
            self._lists.append({"list": self._list_seq, "ordered": tag == "ol", "n": (start or 1) - 1})
        elif tag == "li":
            if not self._lists:  # a stray item: a list of its own
                self._list_seq += 1
                self._lists.append({"list": self._list_seq, "ordered": False, "n": 0, "stray": True})
            top = self._lists[-1]
            top["n"] += 1
            depth = min(sum(1 for item in self._lists if not item.get("stray")) - 1, MAX_LIST_DEPTH)
            self._items.append({"list": top["list"], "ordered": top["ordered"], "n": top["n"], "depth": max(0, depth)})
        elif tag == "blockquote":
            self._quote_depth += 1
        if tag == "article":
            self._flush()
            if self._article_depth == 0:
                self._article_index = self._article_count
                self._article_count += 1
            self._article_depth += 1
        elif tag == "main":
            self._flush()
            self._main_depth += 1
        if tag in self._BLOCKS:
            self._flush()
            self._block_stack.append(tag)
        elif tag in self._BOUNDARY:
            self._flush()

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False
            return
        if tag in self._VOID:
            return
        # Pop to the matching open tag (HTML is forgiving about nesting).
        for index in range(len(self._stack) - 1, -1, -1):
            if self._stack[index][0] == tag:
                popped = self._stack[index:]
                del self._stack[index:]
                break
        else:
            return
        for name, drops in reversed(popped):
            if drops:
                self._drop_depth -= 1
                continue
            if self._drop_depth:
                continue
            if name in self._BLOCKS or name in self._BOUNDARY:
                self._flush()
            if name in self._BLOCKS and self._block_stack and self._block_stack[-1] == name:
                self._block_stack.pop()
            if name == "article" and self._article_depth:
                self._article_depth -= 1
            elif name == "main" and self._main_depth:
                self._main_depth -= 1
            elif name in ("ul", "ol") and self._lists:
                self._lists.pop()
            elif name == "li" and self._items:
                self._items.pop()
                if self._lists and self._lists[-1].get("stray"):
                    self._lists.pop()
            elif name == "blockquote" and self._quote_depth:
                self._quote_depth -= 1
            elif name == "figcaption" and self._caption_depth:
                self._caption_depth -= 1
            elif name == "figure" and self._figure_depth:
                self._figure_depth -= 1
                if not self._figure_depth:
                    figure, self._figure = self._figure, {}
                    if figure.get("img"):
                        src, alt = figure["img"]
                        caption = _clean("".join(figure["caption"]))
                        self._images.append({"src": src, "alt": alt, "caption": caption})
                        self._flush()

    def handle_data(self, data):
        if self._in_title:
            self.title_tag += data
            return
        if self._drop_depth:
            return
        if self._figure_depth:
            if self._caption_depth:
                self._figure["caption"].append(data)
            return
        self._buffer.append(data)

    def close(self):
        super().close()
        self._flush()


#: Section headings whose content is reference apparatus, not prose to listen to.
_APPARATUS_HEADING_RE = re.compile(
    r"^\s*(references?|notes?|footnotes|citations|sources|bibliography|further reading|external links|"
    r"see also|referencias|notas|bibliograf[ií]a|fuentes|enlaces externos|v[eé]ase tambi[eé]n|"
    r"lecturas? adicionales?|r[eé]f[eé]rences|liens externes|voir aussi|einzelnachweise|literatur|weblinks|"
    r"siehe auch|note|bibliografia|collegamenti esterni|voci correlate|refer[eê]ncias|liga[cç][oõ]es externas|"
    r"ver tamb[eé]m)\s*(\[.*\])?\s*$",
    re.IGNORECASE,
)


def _select_blocks(raw: list[tuple[str, int, str, int, bool, Optional[dict]]]) -> list[Block]:
    def chars(items) -> int:
        return sum(len(item[2]) for item in items if item[0] != "h")

    chosen = raw
    articles: dict[int, list] = {}
    for item in raw:
        if item[3] >= 0:
            articles.setdefault(item[3], []).append(item)
    if articles:
        best = max(articles.values(), key=chars)
        if chars(best) >= 200:
            chosen = best
    if chosen is raw:
        main = [item for item in raw if item[4]]
        if chars(main) >= 200:
            chosen = main
    blocks: list[Block] = []
    skip_level = 0  # inside a dropped section until a heading at this level or above
    for kind, level, text, _article, _main, extra in chosen:
        if kind == "h":
            if skip_level and level <= skip_level:
                skip_level = 0
            if not skip_level and _APPARATUS_HEADING_RE.match(text):
                skip_level = level
        if skip_level:
            continue
        if kind == "img" and extra:
            blocks.append(Block("img", "", src=extra["src"], alt=extra["alt"], caption=extra["caption"]))
            continue
        if kind == "li" and extra:
            blocks.append(Block(
                "li", text, list_id=extra["list"], ordered=extra["ordered"], n=extra["n"], depth=extra["depth"],
            ))
            continue
        if kind == "loose":
            # Loose text outside paragraphs is mostly chrome ("Share", "Ad");
            # keep it only when it reads like prose.
            if len(text) < 40 or not _TERMINAL_RE.search(text):
                continue
            kind = "p"
        if kind == "h" and level > 3:
            kind, level = "p", 0
        blocks.append(Block(kind, text, level=level))
    return blocks


_TITLE_SEPARATORS = (" | ", " - ", " — ", " – ", " · ", " :: ")


def strip_site_suffix(title: str, site_name: str = "") -> str:
    """Drop a trailing "| Site name" from a page title.

    "Don Quijote - Wikipedia, la enciclopedia libre" → "Don Quijote". Only the
    last separator is considered, and only when the tail names the site
    (``og:site_name``) or is short enough to be a masthead, so titles that
    merely contain a dash survive.
    """
    site = site_name.strip().lower()
    for sep in _TITLE_SEPARATORS:
        head, found, tail = title.rpartition(sep)
        if not found or len(head.strip()) < 3:
            continue
        tail_l = tail.strip().lower()
        names_site = bool(site) and (site in tail_l or tail_l in site)
        if names_site or tail_l.split(",")[0].strip() in {"wikipedia", "wikipedia, la enciclopedia libre"}:
            return head.strip()
        if not site and len(tail.split()) <= 3 and len(tail.strip()) <= 30 and len(head) > len(tail):
            return head.strip()
    return title


def parse_html(html: str) -> tuple[list[Block], dict]:
    """``(blocks, meta)`` where meta has ``title``/``author``/``site_name``."""
    parser = _ArticleParser()
    try:
        parser.feed(html)
        parser.close()
    except Exception:  # noqa: BLE001 — keep whatever was collected
        parser._flush()
    meta = parser.meta
    title = _clean(meta.get("og:title") or meta.get("twitter:title") or parser.title_tag)
    author = _clean(meta.get("author") or meta.get("article:author") or meta.get("dc.creator") or "")
    if author.lower().startswith(("http://", "https://")):
        author = ""
    site_name = _clean(meta.get("og:site_name") or "")
    info = {
        "title": strip_site_suffix(title, site_name) or None,
        "author": author or None,
        "site_name": site_name or None,
        "language": None,
    }
    return _select_blocks(parser.blocks), info


_HTML_LANG_RE = re.compile(r"<html[^>]{0,400}?\blang\s*=\s*[\"']?([A-Za-z]{2})", re.IGNORECASE)


def _html_lang(html: str) -> Optional[str]:
    match = _HTML_LANG_RE.search(html[:5000])
    return match.group(1).lower() if match else None


# ── DOCX ─────────────────────────────────────────────────────────────────────

_W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
_DOCX_MAX_XML = 50 * 1024 * 1024
_HEADING_STYLE_RE = re.compile(r"^(?:heading|titre|título|titulo|überschrift|titolo)\s*(\d)$", re.IGNORECASE)


def _zip_member(zf: zipfile.ZipFile, name: str, limit: int) -> Optional[bytes]:
    try:
        info = zf.getinfo(name)
    except KeyError:
        return None
    if info.file_size > limit:
        raise ReaderImportError(f"{name} is too large")
    return zf.read(info)


def parse_docx(data: bytes) -> tuple[list[Block], dict]:
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as exc:
        raise ReaderImportError(f"not a valid DOCX file: {exc}") from exc
    with zf:
        document = _zip_member(zf, "word/document.xml", _DOCX_MAX_XML)
        if document is None:
            raise ReaderImportError("not a valid DOCX file: word/document.xml is missing")
        styles_xml = _zip_member(zf, "word/styles.xml", _DOCX_MAX_XML)
        core_xml = _zip_member(zf, "docProps/core.xml", 1024 * 1024)
        numbering_xml = _zip_member(zf, "word/numbering.xml", _DOCX_MAX_XML)
        rels_xml = _zip_member(zf, "word/_rels/document.xml.rels", _DOCX_MAX_XML)
    try:
        root = ET.fromstring(document)  # nosec B314 — local user file, no external entities
    except ET.ParseError as exc:
        raise ReaderImportError(f"DOCX document is not well-formed XML: {exc}") from exc

    style_levels: dict[str, int] = {}
    style_quotes: set[str] = set()
    style_numbering: dict[str, tuple[str, int]] = {}  # style id → (numId, ilvl)
    if styles_xml:
        try:
            for style in ET.fromstring(styles_xml).iter(f"{_W}style"):  # nosec B314
                style_id = style.get(f"{_W}styleId") or ""
                name_el = style.find(f"{_W}name")
                name = (name_el.get(f"{_W}val") if name_el is not None else "") or style_id
                level = _style_level(name) or _style_level(style_id)
                if level:
                    style_levels[style_id] = level
                if _QUOTE_STYLE_RE.match(name) or _QUOTE_STYLE_RE.match(style_id):
                    style_quotes.add(style_id)
                num = _docx_num_pr(style.find(f"{_W}pPr"))
                if num:
                    style_numbering[style_id] = num
        except ET.ParseError:
            pass
    formats = _docx_numbering(numbering_xml)
    images = _docx_relationships(rels_xml)

    blocks: list[Block] = []
    counters: dict[str, list[int]] = {}  # numId → item count per level
    open_lists: dict[tuple[str, int], int] = {}  # (numId, ilvl) → list id while the list runs
    list_seq = 0
    body = root.find(f"{_W}body")
    for paragraph in (body.iter(f"{_W}p") if body is not None else []):
        parts: list[str] = []
        pictures: list[Block] = []
        for node in paragraph.iter():
            if node.tag == f"{_W}t" and node.text:
                parts.append(node.text)
            elif node.tag in (f"{_W}tab", f"{_W}br", f"{_W}cr"):
                parts.append(" ")
            elif node.tag in (f"{_W}drawing", f"{_W}pict"):
                pictures.extend(_docx_pictures(node, images))
        text = _clean("".join(parts))
        if not text and not pictures:
            continue
        properties = paragraph.find(f"{_W}pPr")
        style_el = paragraph.find(f"{_W}pPr/{_W}pStyle")
        style_id = (style_el.get(f"{_W}val") if style_el is not None else "") or ""
        level = style_levels.get(style_id) or _style_level(style_id)
        num = _docx_num_pr(properties) or style_numbering.get(style_id)
        if text and level:
            blocks.append(Block("h", text, level=level))
            open_lists.clear()
        elif text and num and num[0] != "0":
            num_id, ilvl = num[0], min(max(num[1], 0), 8)
            levels = counters.setdefault(num_id, [0] * 9)
            levels[ilvl] += 1
            for deeper in range(ilvl + 1, 9):
                levels[deeper] = 0
            for key in [key for key in open_lists if key[0] == num_id and key[1] > ilvl]:
                del open_lists[key]  # a sublist ended
            if (num_id, ilvl) not in open_lists:
                list_seq += 1
                open_lists[(num_id, ilvl)] = list_seq
            fmt, start = formats.get((num_id, ilvl), ("decimal", 1))
            blocks.append(Block(
                "li", text, list_id=open_lists[(num_id, ilvl)], ordered=fmt not in ("bullet", "none"),
                n=start - 1 + levels[ilvl], depth=min(ilvl, MAX_LIST_DEPTH),
            ))
        elif text:
            blocks.append(Block("quote" if style_id in style_quotes or _QUOTE_STYLE_RE.match(style_id) else "p", text))
            open_lists.clear()
        # mc:AlternateContent can carry the same picture twice (DrawingML + VML fallback).
        blocks.extend({picture.src: picture for picture in pictures}.values())

    meta = {"title": None, "author": None}
    if core_xml:
        try:
            core = ET.fromstring(core_xml)  # nosec B314
            for el in core.iter():
                local = el.tag.rsplit("}", 1)[-1]
                if local == "title" and el.text and el.text.strip():
                    meta["title"] = _clean(el.text)
                elif local == "creator" and el.text and el.text.strip():
                    meta["author"] = _clean(el.text)
        except ET.ParseError:
            pass
    return blocks, meta


def _style_level(name: str) -> int:
    name = (name or "").strip()
    if name.lower() == "title":
        return 1
    compact = re.sub(r"\s+", " ", name)
    match = _HEADING_STYLE_RE.match(compact) or _HEADING_STYLE_RE.match(
        re.sub(r"(\D)(\d)$", r"\1 \2", compact)
    )
    if match:
        return max(1, min(6, int(match.group(1))))
    return 0


_QUOTE_STYLE_RE = re.compile(
    r"^(?:intense\s*quote|quote|block\s*text|cita(?:\s*destacada)?|zitat|intensives\s*zitat|citation(?:\s*intense)?|"
    r"citazione(?:\s*intensa)?|cita[cç][aã]o(?:\s*intensa)?)$",
    re.IGNORECASE,
)
_R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"


def _docx_num_pr(properties) -> Optional[tuple[str, int]]:
    """``(numId, ilvl)`` of a paragraph's (or style's) ``w:numPr``, if any."""
    if properties is None:
        return None
    num_pr = properties.find(f"{_W}numPr")
    if num_pr is None:
        return None
    num_id = num_pr.find(f"{_W}numId")
    if num_id is None or not num_id.get(f"{_W}val"):
        return None
    ilvl = num_pr.find(f"{_W}ilvl")
    try:
        level = int(ilvl.get(f"{_W}val") or 0) if ilvl is not None else 0
    except ValueError:
        level = 0
    return num_id.get(f"{_W}val"), level


def _docx_numbering(xml: Optional[bytes]) -> dict[tuple[str, int], tuple[str, int]]:
    """``(numId, ilvl)`` → ``(numFmt, start)`` from ``word/numbering.xml``."""
    if not xml:
        return {}
    try:
        root = ET.fromstring(xml)  # nosec B314 — local user file
    except ET.ParseError:
        return {}
    abstract: dict[str, dict[int, tuple[str, int]]] = {}
    for definition in root.iter(f"{_W}abstractNum"):
        levels: dict[int, tuple[str, int]] = {}
        for lvl in definition.findall(f"{_W}lvl"):
            try:
                index = int(lvl.get(f"{_W}ilvl") or 0)
                start_el = lvl.find(f"{_W}start")
                start = int(start_el.get(f"{_W}val") or 1) if start_el is not None else 1
            except ValueError:
                continue
            fmt_el = lvl.find(f"{_W}numFmt")
            levels[index] = ((fmt_el.get(f"{_W}val") if fmt_el is not None else "") or "decimal", start)
        abstract[definition.get(f"{_W}abstractNumId") or ""] = levels
    out: dict[tuple[str, int], tuple[str, int]] = {}
    for num in root.iter(f"{_W}num"):
        ref = num.find(f"{_W}abstractNumId")
        levels = abstract.get(ref.get(f"{_W}val") if ref is not None else "", {})
        for index, value in levels.items():
            out[(num.get(f"{_W}numId") or "", index)] = value
    return out


def _docx_relationships(xml: Optional[bytes]) -> dict[str, str]:
    """Relationship id → package member of the document's embedded images."""
    if not xml:
        return {}
    try:
        root = ET.fromstring(xml)  # nosec B314 — local user file
    except ET.ParseError:
        return {}
    out: dict[str, str] = {}
    for rel in root:
        if (rel.get("TargetMode") or "").lower() == "external" or not rel.get("Id"):
            continue
        if not (rel.get("Type") or "").endswith("/image"):
            continue
        target = (rel.get("Target") or "").replace("\\", "/")
        member = target.lstrip("/") if target.startswith("/") else posixpath.normpath(posixpath.join("word", target))
        if member and not member.startswith(".."):
            out[rel.get("Id")] = member
    return out


def _docx_pictures(node, images: dict[str, str]) -> list[Block]:
    """Image blocks for one ``w:drawing`` (DrawingML) or ``w:pict`` (VML) run."""
    alt = ""
    found: list[str] = []
    for child in node.iter():
        local = child.tag.rsplit("}", 1)[-1]
        if local == "docPr":
            alt = alt or child.get("descr") or child.get("title") or ""
        elif local == "blip" and child.get(f"{_R}embed") in images:
            found.append(images[child.get(f"{_R}embed")])
        elif local == "imagedata" and child.get(f"{_R}id") in images:
            found.append(images[child.get(f"{_R}id")])
            alt = alt or child.get("{urn:schemas-microsoft-com:office:office}title") or ""
    return [Block("img", "", src=member, alt=alt) for member in dict.fromkeys(found)]


# ── EPUB metadata + cover ────────────────────────────────────────────────────

_COVER_MAX_BYTES = 10 * 1024 * 1024
_IMAGE_EXT = {"image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/webp": "webp"}


def epub_metadata(data: bytes) -> dict:
    """``{"title", "author", "language", "cover"}`` from the OPF package; best effort."""
    from services.longform_import import (
        _EPUB_MAX_ENTRY_BYTES,
        _EPUB_MAX_TOTAL_BYTES,
        _OPF_NS,
        _ReadBudget,
        _member_path,
        _opf_path,
        _read_member,
    )

    out: dict = {"title": None, "author": None, "language": None, "cover": None}
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
        budget = _ReadBudget(_EPUB_MAX_ENTRY_BYTES, _EPUB_MAX_TOTAL_BYTES)
        opf_path = _opf_path(zf, budget)
        opf = ET.fromstring(_read_member(zf, opf_path, budget, required=True))  # nosec B314
    except Exception:  # noqa: BLE001 — metadata is optional
        return out
    dc = "{http://purl.org/dc/elements/1.1/}"
    for key, tag in (("title", "title"), ("author", "creator"), ("language", "language")):
        el = opf.find(f".//{dc}{tag}")
        if el is not None and el.text and el.text.strip():
            out[key] = _clean(el.text)
    if out["language"]:
        out["language"] = out["language"][:2].lower()

    base = posixpath.dirname(opf_path)
    items = opf.findall(".//opf:manifest/opf:item", _OPF_NS)
    cover_item = None
    for item in items:
        if "cover-image" in (item.get("properties") or "").split():
            cover_item = item
            break
    if cover_item is None:
        meta = opf.find(".//opf:metadata/opf:meta[@name='cover']", _OPF_NS)
        cover_id = meta.get("content") if meta is not None else None
        for item in items:
            if cover_id and item.get("id") == cover_id:
                cover_item = item
                break
    if cover_item is None:
        for item in items:
            if (item.get("media-type") or "") in _IMAGE_EXT and "cover" in (
                f"{item.get('id') or ''} {item.get('href') or ''}".lower()
            ):
                cover_item = item
                break
    if cover_item is not None:
        ext = _IMAGE_EXT.get((cover_item.get("media-type") or "").lower())
        if ext is None:
            suffix = os.path.splitext(cover_item.get("href") or "")[1].lower().lstrip(".")
            ext = {"jpeg": "jpg", "jpg": "jpg", "png": "png", "webp": "webp"}.get(suffix)
        member = _member_path(base, cover_item.get("href") or "")
        if ext and member:
            try:
                info = zf.getinfo(member)
                if 0 < info.file_size <= _COVER_MAX_BYTES:
                    out["cover"] = (zf.read(info), ext)
            except (KeyError, zipfile.BadZipFile, RuntimeError, NotImplementedError, EOFError):
                pass
    return out


# ── EPUB rich content ────────────────────────────────────────────────────────


@functools.lru_cache(maxsize=1)
def _rich_epub_extractor() -> type:
    """The audiobook importer's XHTML text extractor, extended to mark list items,
    block quotations, images and figure captions as rich script lines
    (``_RICH_MARK`` + JSON + ``_RICH_END`` + text) for :func:`parse_markdown`.

    Everything else (titles, page-break markers, skipped elements, front-matter
    detection in ``epub_to_chapter_script``) stays exactly the audiobook's.
    """
    from services.longform_import import _member_path, _TextExtractor

    class RichEpubExtractor(_TextExtractor):
        def __init__(self, base: str) -> None:
            super().__init__()
            self._base = base
            self._lists: list[dict] = []
            self._list_seq = 0
            self._items: list[dict] = []
            self._quote = 0
            self._caption = 0
            self._marked = False  # the current line already carries its mark

        def _gated(self) -> bool:
            return bool(self._skip_depth or self._pagebreak_stack)

        @staticmethod
        def _mark(meta: dict) -> str:
            return _RICH_MARK + json.dumps(meta, ensure_ascii=False, separators=(",", ":")) + _RICH_END

        def handle_starttag(self, tag, attrs):
            super().handle_starttag(tag, attrs)
            if tag in self._BREAK:
                self._marked = False
            if self._gated():
                return
            attr = {k.lower(): v or "" for k, v in attrs}
            if tag in ("ul", "ol"):
                self._list_seq += 1
                start = _px(attr.get("start")) if tag == "ol" else None
                self._lists.append({"list": self._list_seq, "o": int(tag == "ol"), "n": (start or 1) - 1})
            elif tag == "li":
                if not self._lists:
                    self._list_seq += 1
                    self._lists.append({"list": self._list_seq, "o": 0, "n": 0})
                top = self._lists[-1]
                top["n"] += 1
                depth = min(len(self._lists) - 1, MAX_LIST_DEPTH)
                self._items.append({"t": "li", "list": top["list"], "o": top["o"], "n": top["n"], "d": depth})
            elif tag == "blockquote":
                self._quote += 1
            elif tag == "figcaption":
                self._caption += 1
            elif tag in ("img", "image") and not self._in_title:
                src = attr.get("src") or attr.get("href") or attr.get("xlink:href") or ""
                width, height = _px(attr.get("width")), _px(attr.get("height"))
                small = (width is not None and width < MIN_IMAGE_SIDE) or (height is not None and height < MIN_IMAGE_SIDE)
                member = _member_path(self._base, src) if src and not src.startswith("data:") and not small else ""
                if member and not member.startswith(".."):
                    alt = _clean(attr.get("alt") or "")
                    self._parts.append("\n" + self._mark({"t": "img", "src": member, "alt": alt}) + "\n")
                    self._marked = False

        def handle_endtag(self, tag):
            super().handle_endtag(tag)
            if tag in self._BREAK:
                self._marked = False
            if tag in ("ul", "ol") and self._lists:
                self._lists.pop()
            elif tag == "li" and self._items:
                self._items.pop()
            elif tag == "blockquote" and self._quote:
                self._quote -= 1
            elif tag == "figcaption" and self._caption:
                self._caption -= 1

        def handle_data(self, data):
            if not any(name == "pre" for name, _ns in self._elements):
                # A line break in the source is a space in XHTML; only <br> and blocks break lines.
                data = data.replace("\r", " ").replace("\n", " ")
            if not self._gated() and not self._in_title and not self._marked and data.strip():
                if self._items:
                    meta = self._items[-1]
                elif self._quote:
                    meta = {"t": "quote"}
                elif self._caption:
                    meta = {"t": "cap"}
                else:
                    meta = None
                if meta is not None:
                    self._parts.append(self._mark(meta))
                self._marked = True
            super().handle_data(data)

    return RichEpubExtractor


def _rich_epub_extract(xhtml: str, path: str) -> tuple[set[str], str, str]:
    """``epub_to_chapter_script`` ``extract`` hook: rich body lines; a section
    whose only content is images reads as empty (skipped, as before)."""
    parser = _rich_epub_extractor()(posixpath.dirname(path))
    try:
        parser.feed(xhtml)
    except Exception:  # noqa: BLE001 — keep what was collected, like the plain extractor
        pass
    body = parser.text()
    readable = any(
        (line.partition(_RICH_END)[2] if line.startswith(_RICH_MARK) else line).strip()
        for line in body.split("\n")
    )
    return parser.epub_types, parser.title, body if readable else ""


# ── PDF ──────────────────────────────────────────────────────────────────────
#
# pypdf gives one text layer per page, with hard-wrapped lines and no markup.
# Chapter headings are recognized line by line (``pdf_blocks``); running
# headers/footers and page numbers are dropped first so they cannot pose as
# headings. Without at least two headings, a long PDF gets one chapter per
# ``PDF_PAGES_PER_CHAPTER`` pages instead.

PDF_PAGES_PER_CHAPTER = 10
PDF_MAX_PAGES = 5000
_HEADING_MAX = 60

_NUMBER_WORDS = (
    "uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|"
    "dieciséis|dieciseis|diecisiete|dieciocho|diecinueve|veinte|primer[oa]?|segund[oa]|tercer[oa]?|"
    "cuart[oa]|quint[oa]|sext[oa]|séptim[oa]|septim[oa]|octav[oa]|noven[oa]|décim[oa]|decim[oa]|"
    "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|"
    "sixteen|seventeen|eighteen|nineteen|twenty|first|second|third|fourth|fifth|sixth|seventh|"
    "eighth|ninth|tenth|un|deux|trois|eins|zwei|drei|primo|secondo|terzo"
)
_ROMAN = r"[IVXLCDM]{1,7}"
_NUMBERED_HEADING_RE = re.compile(
    r"^(?:cap[ií]tulo|cap\.|chapter|chapitre|kapitel|capitolo|parte|part|partie|teil|libro|book|"
    r"livre|buch|tomo|volumen|volume|secci[oó]n|section)\s+"
    rf"(?:\d{{1,3}}|{_ROMAN}|(?:{_NUMBER_WORDS}))\b\.?(?:\s*[:.—–-]\s*\S.*|\s+\S.*)?$",
    re.IGNORECASE,
)
_NAMED_HEADING_RE = re.compile(
    r"^(?:pr[oó]logo|prologue|prolog|ep[ií]logo|epilogue|epilog|epilogo|introducci[oó]n|introduction|"
    r"einleitung|introduzione|introdu[cç][aã]o|interludio|interlude|pr[eé]facio|prefacio|preface|"
    r"pr[eé]face|vorwort|prefazione|ap[eé]ndice|appendix|annexe|anhang|appendice|conclusi[oó]n|"
    r"conclusion|nota del autor|nota de la autora|author'?s note|agradecimientos|acknowledg(?:e)?ments?|"
    r"dedicatoria|pr[oó]logo del autor)\.?(?:\s*[:.—–-]\s*\S.*)?$",
    re.IGNORECASE,
)
_NUMBER_LINE_RE = re.compile(rf"^(?:\d{{1,3}}|{_ROMAN})\.?$")
_SENTENCE_END_RE = re.compile(r"[.!?…:;»\"”’)\]]$")
_PAGES_LABEL = {
    "es": "Páginas {a}–{b}", "pt": "Páginas {a}–{b}", "fr": "Pages {a}–{b}",
    "de": "Seiten {a}–{b}", "it": "Pagine {a}–{b}", "en": "Pages {a}–{b}",
}
_PAGE_LABEL = {
    "es": "Página {n}", "pt": "Página {n}", "fr": "Page {n}",
    "de": "Seite {n}", "it": "Pagina {n}", "en": "Page {n}",
}


def _label(table: dict, language: Optional[str], **values) -> str:
    return table.get((language or "en")[:2], table["en"]).format(**values)


def _roman_value(text: str) -> int:
    values = {"I": 1, "V": 5, "X": 10, "L": 50, "C": 100, "D": 500, "M": 1000}
    total = 0
    for char, nxt in zip(text, text[1:] + " "):
        value = values[char]
        total += -value if values.get(nxt, 0) > value else value
    return total


def _number_value(line: str) -> Optional[int]:
    token = line.strip().rstrip(".")
    if token.isdigit():
        return int(token)
    if re.fullmatch(_ROMAN, token):
        return _roman_value(token)
    return None


def _open_pdf(data: bytes):
    """A ``pypdf.PdfReader`` (decrypted when it only has an empty user password)."""
    from pypdf import PdfReader
    from pypdf.errors import PdfReadError

    try:
        reader = PdfReader(io.BytesIO(data))
    except (PdfReadError, OSError, ValueError) as exc:
        raise ReaderImportError(f"couldn't read the PDF: not a valid PDF file ({exc})") from exc
    if reader.is_encrypted:
        try:
            if reader.decrypt("") == 0:
                raise ReaderImportError("couldn't read the PDF: it is password-protected")
        except (NotImplementedError, PdfReadError) as exc:
            raise ReaderImportError(f"couldn't read this encrypted PDF: {exc}") from exc
    return reader


def pdf_pages(data: bytes, progress: Progress = None, *, max_pages: int = PDF_MAX_PAGES) -> list[str]:
    """Text layer of every page (``""`` for a page without one), in order.

    Raises :class:`ReaderImportError` for unreadable, encrypted, oversized or
    image-only PDFs.
    """
    from pypdf.errors import PdfReadError

    reader = _open_pdf(data)
    try:
        pages = reader.pages
        total = len(pages)
    except (PdfReadError, OSError, ValueError) as exc:
        raise ReaderImportError(f"couldn't read the PDF: {exc}") from exc
    if total > max_pages:
        raise ReaderImportError(f"the PDF has too many pages (max {max_pages})")
    out: list[str] = []
    for index in range(total):
        try:
            out.append(pages[index].extract_text() or "")
        except Exception:  # noqa: BLE001 — one bad page shouldn't kill the import
            out.append("")
        if progress is not None:
            progress((index + 1) / total)
    if not any(text.strip() for text in out):
        raise ReaderImportError(
            "this PDF has no text layer (a scanned or image-only PDF); "
            "photograph the pages with Scan instead"
        )
    return out


def _edge_lines(lines: list[str]) -> list[int]:
    """Indexes of the first two and last two lines of a page."""
    n = len(lines)
    return sorted({i for i in (0, 1, n - 2, n - 1) if 0 <= i < n})


def _strip_page_furniture(pages: list[list[str]]) -> list[list[str]]:
    """Drop running headers/footers and page numbers from page line lists.

    A header/footer is an edge line whose digit-less form repeats on at least
    a quarter of the pages (min. 3). A page number is an edge number line
    whose value keeps a constant offset from the page index on several pages.
    """
    def key(text: str) -> str:
        return " ".join(re.sub(r"\d+", "#", text).lower().split())

    repeats: dict[str, int] = {}
    offsets: dict[int, int] = {}
    for index, lines in enumerate(pages):
        seen = set()
        for i in _edge_lines(lines):
            k = key(lines[i])
            if k and k not in seen and not _NUMBER_LINE_RE.match(lines[i].strip()):
                seen.add(k)
                repeats[k] = repeats.get(k, 0) + 1
            value = _number_value(lines[i]) if lines[i].strip().isdigit() else None
            if value is not None:
                offsets[value - index] = offsets.get(value - index, 0) + 1
    furniture = {k for k, count in repeats.items() if count >= max(3, len(pages) // 4)}
    numbered_pages = sum(offsets.values())
    page_offsets = {
        offset for offset, count in offsets.items()
        if count >= 2 and count >= 0.3 * numbered_pages
    } if numbered_pages else set()
    out = []
    for index, lines in enumerate(pages):
        edges = set(_edge_lines(lines))
        kept = []
        for i, line in enumerate(lines):
            if i in edges:
                if key(line) in furniture:
                    continue
                if line.strip().isdigit() and int(line.strip()) - index in page_offsets:
                    continue
            kept.append(line)
        out.append(kept)
    return out


def _is_caps_heading(line: str) -> bool:
    letters = [c for c in line if c.isalpha()]
    return (
        len(letters) >= 4
        and all(c.isupper() for c in letters)
        and len(line.split()) <= 8
        and not re.fullmatch(_ROMAN, line.replace(" ", ""))
        and not line.endswith((",", ";"))
    )


def pdf_blocks(page_texts: list[str], language: Optional[str] = None) -> list[Block]:
    """Blocks for a PDF's page texts: detected chapter headings as level-1
    ``h`` blocks, or (fewer than two headings in a PDF over
    ``PDF_PAGES_PER_CHAPTER`` pages) chapter markers every that many pages."""
    pages = _strip_page_furniture([
        [line.strip() for line in (text or "").replace("\r\n", "\n").replace("\r", "\n").split("\n")]
        for text in page_texts
    ])
    lengths = sorted(len(line) for lines in pages for line in lines if line)
    typical = lengths[int(0.8 * (len(lengths) - 1))] if lengths else 60

    # (page, line index) → heading text; consumed title lines are skipped.
    headings: dict[tuple[int, int], str] = {}
    consumed: set[tuple[int, int]] = set()
    last_number: Optional[int] = None
    for p, lines in enumerate(pages):
        previous = ""  # the previous non-empty line on this page
        for i, line in enumerate(lines):
            if not line or (p, i) in consumed:
                continue
            starts_unit = not previous or bool(_SENTENCE_END_RE.search(previous)) or (p, i - 1) in headings
            heading = None
            if starts_unit and len(line) <= _HEADING_MAX and (line[:1].isupper() or line[:1].isdigit()):
                if _NUMBERED_HEADING_RE.match(line) or _NAMED_HEADING_RE.match(line):
                    heading = line
                elif _NUMBER_LINE_RE.match(line):
                    # A bare chapter number: only as the next one in sequence.
                    value = _number_value(line)
                    if value is not None and (value == (last_number or 0) + 1 or (last_number is None and value <= 3)):
                        heading = line.rstrip(".")
                        last_number = value
                elif _is_caps_heading(line):
                    heading = line
            if heading is not None:
                # A short following line without end punctuation is the title.
                j = i + 1
                while j < len(lines) and not lines[j]:
                    j += 1
                if j < len(lines):
                    title = lines[j]
                    if (
                        len(title) < 0.6 * typical
                        and not _SENTENCE_END_RE.search(title)
                        and not title.endswith((",", "-"))
                        and title[:1].isupper()
                        and not (_NUMBERED_HEADING_RE.match(title) or _NAMED_HEADING_RE.match(title))
                    ):
                        heading = f"{heading}. {title}" if heading[-1:].isalnum() else f"{heading} {title}"
                        consumed.add((p, j))
                headings[(p, i)] = heading
            previous = line

    def paragraphs(lines: list[str]) -> list[Block]:
        out: list[Block] = []
        run: list[str] = []
        for line in [*lines, ""]:
            if line:
                run.append(line)
                continue
            for paragraph in _reflow(run):
                if _clean(paragraph):
                    out.append(Block("p", paragraph))
            run = []
        return out

    blocks: list[Block] = []
    if len(headings) >= 2 or len(pages) <= PDF_PAGES_PER_CHAPTER:
        body: list[str] = []
        for p, lines in enumerate(pages):
            for i, line in enumerate(lines):
                if (p, i) in consumed:
                    continue
                if (p, i) in headings:
                    blocks.extend(paragraphs(body))
                    body = []
                    blocks.append(Block("h", headings[(p, i)], level=1))
                else:
                    body.append(line)
        blocks.extend(paragraphs(body))
        return blocks

    # Page-range chapters; a lone detected heading is still read as a heading.
    for start in range(0, len(pages), PDF_PAGES_PER_CHAPTER):
        end = min(start + PDF_PAGES_PER_CHAPTER, len(pages))
        group: list[Block] = []
        body = []
        for p in range(start, end):
            for i, line in enumerate(pages[p]):
                if (p, i) in consumed:
                    continue
                if (p, i) in headings:
                    group.extend(paragraphs(body))
                    body = []
                    group.append(Block("h", headings[(p, i)], level=1))
                else:
                    body.append(line)
        group.extend(paragraphs(body))
        label = _label(_PAGES_LABEL, language, a=start + 1, b=end)
        if group:
            group[0].chapter = label
        else:
            group = [Block("p", "", chapter=label)]
        blocks.extend(group)
    return blocks


#: Pages searched for the first one with a text layer (a cover is often an image).
_TITLE_PAGES = 3
_HEADING_TITLE_MAX = 150


def _pdf_text(value) -> Optional[str]:
    try:
        text = _clean(str(value).replace("\x00", "")) if value is not None else ""
    except Exception:  # noqa: BLE001 — undecodable metadata is no metadata
        return None
    return text or None


def pdf_metadata(data: bytes) -> dict:
    """``{"titles", "author", "subject", "heading"}`` of a PDF; best effort.

    ``titles`` are the document-information and XMP titles as written (junk
    included — :func:`pick_title` filters them); ``author`` the first creator
    that reads like a name; ``subject`` a short subject line; ``heading`` the
    largest-type text near the top of the first page that has a text layer.
    """
    out: dict = {"titles": [], "author": None, "subject": None, "heading": None}
    try:
        reader = _open_pdf(data)
    except ReaderImportError:
        return out
    authors: list[Optional[str]] = []
    try:
        info = reader.metadata
    except Exception:  # noqa: BLE001 — metadata is optional
        info = None
    if info is not None:
        for key, attr in (("titles", "title"), ("authors", "author"), ("subject", "subject")):
            try:
                value = _pdf_text(getattr(info, attr))
            except Exception:  # noqa: BLE001
                value = None
            if key == "titles":
                out["titles"].append(value)
            elif key == "authors":
                authors.append(value)
            elif value and len(value) <= TITLE_MAX and len(value.split()) <= 12 and not value.endswith(".") \
                    and not _title_junk(value):
                out["subject"] = _tidy_title(value)
    try:
        xmp = reader.xmp_metadata
        if xmp is not None:
            titles = xmp.dc_title or {}
            out["titles"].extend(_pdf_text(t) for t in (titles.values() if isinstance(titles, dict) else [titles]))
            creators = [_pdf_text(c) for c in (xmp.dc_creator or [])]
            authors.append("; ".join(c for c in creators if c) or None)
    except Exception:  # noqa: BLE001 — malformed XMP is common
        pass
    out["author"] = pick_author(authors)
    out["heading"] = _pdf_heading(reader, out["author"])
    return out


def _pdf_heading(reader, author: Optional[str] = None) -> Optional[str]:
    """The largest-type line of the first page with text, when it stands out."""
    try:
        pages = reader.pages
        count = min(len(pages), _TITLE_PAGES)
    except Exception:  # noqa: BLE001
        return None
    for index in range(count):
        runs: list[list] = []  # [effective font size, text], consecutive equal sizes merged

        def visit(text, cm, tm, _font, size, runs=runs):
            if not text:
                return
            if not text.strip():
                if runs:
                    runs[-1][1] += text
                return
            try:
                # Size on the page = font size × the vertical scale of Tm × CTM.
                c = tm[2] * cm[0] + tm[3] * cm[2]
                d = tm[2] * cm[1] + tm[3] * cm[3]
                scaled = round(abs(float(size)) * (c * c + d * d) ** 0.5, 1)
            except (TypeError, ValueError, IndexError):
                return
            if runs and abs(runs[-1][0] - scaled) <= 0.5:
                runs[-1][1] += text
            else:
                runs.append([scaled, text])

        try:
            pages[index].extract_text(visitor_text=visit)
        except Exception:  # noqa: BLE001 — one bad page shouldn't kill the import
            continue
        cleaned = [(size, _clean(text)) for size, text in runs if size > 0 and _clean(text)]
        if cleaned:
            return _heading_from_runs(cleaned, author)
    return None


def _heading_from_runs(runs: list[tuple[float, str]], author: Optional[str]) -> Optional[str]:
    chars: dict[float, int] = {}
    for size, text in runs:
        chars[size] = chars.get(size, 0) + len(text)
    body = max(chars, key=lambda size: chars[size])
    top = max(chars)
    # A heading is set larger than the body text — or, on a short title page, is
    # simply the largest of several sizes.
    title_page = len(chars) >= 2 and sum(chars.values()) <= 400
    if top < body * 1.2 and not title_page:
        return None
    floor = min(chars) + 0.5 if title_page else body * 1.2
    author_key = _title_key(author or "")
    for size in sorted((s for s in chars if s >= floor), reverse=True):
        texts = [text for s, text in runs if abs(s - size) <= 0.5]
        others = [text for text in texts if not (author_key and _title_key(text) == author_key)]
        if not others:
            continue  # a cover sets the author's name largest: look one size down
        for text in others:
            if len(text) <= _HEADING_TITLE_MAX and not _title_junk(text) and not _section_heading(text):
                return _tidy_title(text)
        return None  # the largest text names a section ("Capítulo 1"): not a title page
    return None


def import_pdf(
    data: bytes,
    *,
    title: Optional[str] = None,
    filename: str = "",
    language: Optional[str] = None,
    progress: Progress = None,
    **common,
) -> ImportedDocument:
    """PDF bytes → document; ``progress`` gets 0–0.8 for pages, 0.8–1 for segmentation.

    A ``title`` the caller was given is kept as is; otherwise :func:`pick_title`
    chooses between the PDF's metadata, its first-page heading and ``filename``.
    """
    pages = pdf_pages(data, (lambda f: progress(0.8 * f)) if progress else None)
    _check_size("".join(pages))
    sample = "\n".join(pages)[:40_000]
    lang = (language or "").strip().lower()[:8] or guess_language(sample)
    blocks = pdf_blocks(pages, lang)
    meta = pdf_metadata(data)
    title = _clean(title or "") or pick_title(meta["titles"], filename=filename, heading=meta["heading"]) \
        or meta["subject"] or ""
    doc = ImportedDocument(title=title, author=meta["author"], blocks=blocks, **common)
    return _finish(doc, lang, sample, (lambda f: progress(0.8 + 0.2 * f)) if progress else None)


# ── Scan (OCR) ───────────────────────────────────────────────────────────────

MAX_SCAN_IMAGES = 50
MAX_SCAN_IMAGE_BYTES = 25 * 1024 * 1024


def import_scan(
    images: list[bytes],
    *,
    title: Optional[str] = None,
    language: Optional[str] = None,
    progress: Progress = None,
) -> ImportedDocument:
    """Page photos (in page order) → document via OCR (``services.reader_ocr``).

    One paragraph per detected text block, in reading order; one chapter per
    image when there are several. Raises ``reader_ocr.OcrUnavailable`` when OCR
    cannot run here, :class:`ReaderImportError` for unreadable input.
    """
    from services import reader_ocr

    if not images:
        raise ReaderImportError("add at least one image")
    if len(images) > MAX_SCAN_IMAGES:
        raise ReaderImportError(f"too many images (max {MAX_SCAN_IMAGES})")
    pages: list[list[tuple[str, str]]] = []
    for index, data in enumerate(images):
        try:
            pages.append(reader_ocr.ocr_page(data))
        except reader_ocr.OcrImageError as exc:
            raise ReaderImportError(f"page {index + 1}: {exc}") from exc
        if progress is not None:
            progress(0.9 * (index + 1) / len(images))
    sample = "\n".join(text for page in pages for _kind, text in page)[:40_000]
    if not sample.strip():
        raise ReaderImportError("no text was recognized in the images")
    lang = (language or "").strip().lower()[:8] or guess_language(sample)
    blocks: list[Block] = []
    for number, page in enumerate(pages, start=1):
        page_blocks = [Block(kind, text, level=1 if kind == "h" else 0) for kind, text in page]
        if len(pages) > 1:
            label = _label(_PAGE_LABEL, lang, n=number)
            if page_blocks:
                page_blocks[0].chapter = label
        blocks.extend(page_blocks)
    first_heading = next((b.text for b in blocks if b.kind == "h"), None)
    doc = ImportedDocument(
        title=_clean(title or "") or first_heading or "",
        blocks=blocks,
        source_type="scan",
        source_name=f"{len(images)} image{'s' if len(images) != 1 else ''}",
    )
    return _finish(doc, lang, sample, (lambda f: progress(0.9 + 0.1 * f)) if progress else None)


# ── Images ───────────────────────────────────────────────────────────────────
#
# Parsers leave ``img`` blocks pointing at where the picture lives; an
# ``ImageLoader`` turns that reference into bytes. Only raster images whose
# bytes say so (JPEG, PNG, GIF, WebP, AVIF) are kept — never SVG, which could
# carry script — named ``img-NNN.<ext>`` and stored with the document.

#: ``loader(reference) -> bytes | None``.
ImageLoader = Callable[[str], Optional[bytes]]

IMAGE_MEDIA_TYPES = {
    "jpg": "image/jpeg", "png": "image/png", "gif": "image/gif", "webp": "image/webp", "avif": "image/avif",
}
_DATA_URI_RE = re.compile(r"^data:image/[a-z0-9.+-]+(?:;[^,;]*)*;base64,", re.IGNORECASE)
_IMAGE_ACCEPT = "image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.1"


def image_type(data: bytes) -> Optional[str]:
    """Extension of a supported raster image, sniffed from its bytes."""
    if data.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    if data[4:12] in (b"ftypavif", b"ftypavis"):
        return "avif"
    return None


def _image_size(data: bytes, ext: str) -> Optional[tuple[int, int]]:
    """``(width, height)`` from the image header, when cheap to read."""
    try:
        if ext == "png" and len(data) >= 24:
            return struct.unpack(">II", data[16:24])
        if ext == "gif" and len(data) >= 10:
            return struct.unpack("<HH", data[6:10])
        if ext == "webp" and len(data) >= 30:
            chunk = data[12:16]
            if chunk == b"VP8X":
                return 1 + int.from_bytes(data[24:27], "little"), 1 + int.from_bytes(data[27:30], "little")
            if chunk == b"VP8 ":
                width, height = struct.unpack("<HH", data[26:30])
                return width & 0x3FFF, height & 0x3FFF
            if chunk == b"VP8L":
                bits = int.from_bytes(data[21:25], "little")
                return 1 + (bits & 0x3FFF), 1 + ((bits >> 14) & 0x3FFF)
        if ext == "jpg":
            index = 2
            while index + 9 < len(data):
                if data[index] != 0xFF:
                    index += 1
                    continue
                marker = data[index + 1]
                if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7 or marker == 0xFF:
                    index += 1 if marker == 0xFF else 2
                    continue
                length = struct.unpack(">H", data[index + 2:index + 4])[0]
                if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
                    height, width = struct.unpack(">HH", data[index + 5:index + 9])
                    return width, height
                index += 2 + length
    except struct.error:
        return None
    return None


def data_uri_image(reference: str) -> Optional[bytes]:
    """Bytes of a base64 ``data:image/…`` URI (``None`` for anything else)."""
    match = _DATA_URI_RE.match(reference or "")
    if not match:
        return None
    payload = reference[match.end():]
    if len(payload) > MAX_IMAGE_BYTES * 4 // 3 + 8:
        return None
    try:
        return base64.b64decode(re.sub(r"\s+", "", payload), validate=True)
    except (binascii.Error, ValueError):
        return None


def _zip_image_loader(data: bytes) -> ImageLoader:
    """Images that are members of an EPUB/DOCX package (``data:`` URIs too)."""
    state: dict = {}

    def load(reference: str) -> Optional[bytes]:
        if reference.startswith("data:"):
            return data_uri_image(reference)
        try:
            if "zip" not in state:
                state["zip"] = zipfile.ZipFile(io.BytesIO(data))
            info = state["zip"].getinfo(reference)
            if info.file_size > MAX_IMAGE_BYTES:
                return None
            return state["zip"].read(info)
        except (KeyError, zipfile.BadZipFile, RuntimeError, NotImplementedError, EOFError, OSError):
            return None

    return load


def _url_image_loader(base_url: str) -> ImageLoader:
    """Images of a fetched page, through the same SSRF-checked fetch (≤ 5 MB each)."""

    def load(reference: str) -> Optional[bytes]:
        if reference.startswith("data:"):
            return data_uri_image(reference)
        try:
            url = urljoin(base_url, reference)
        except ValueError:
            return None
        if urlsplit(url).scheme not in ("http", "https"):
            return None
        body, _type, _final = fetch_url(
            url, max_bytes=MAX_IMAGE_BYTES, accept=_IMAGE_ACCEPT, timeout=IMAGE_TIMEOUT_S, referer=base_url
        )
        return body

    return load


def _load_image(loader: ImageLoader, reference: str) -> Optional[bytes]:
    try:
        data = loader(reference)
    except Exception:  # noqa: BLE001 — a missing picture never fails the import
        return None
    return data if data and len(data) <= MAX_IMAGE_BYTES else None


def _load_images(references: list[str], loader: ImageLoader, parallel: bool) -> dict[str, Optional[bytes]]:
    if not parallel:
        return {ref: _load_image(loader, ref) for ref in references}
    from concurrent.futures import ThreadPoolExecutor, wait

    pool = ThreadPoolExecutor(max_workers=6, thread_name_prefix="reader-image")
    try:
        futures = {pool.submit(_load_image, loader, ref): ref for ref in references}
        done, _pending = wait(futures, timeout=IMAGES_DEADLINE_S)
        return {futures[future]: future.result() for future in done}
    finally:
        pool.shutdown(wait=False, cancel_futures=True)


def attach_images(
    blocks: list[Block], loader: Optional[ImageLoader], *, parallel: bool = False
) -> tuple[list[Block], dict[str, bytes]]:
    """Load the pictures of ``img`` blocks: ``(blocks, assets)``.

    Kept images get their asset name as ``src``; images that cannot be loaded, are
    not a supported raster type, are smaller than :data:`MIN_IMAGE_SIDE`, or exceed
    :data:`MAX_IMAGES` / :data:`MAX_IMAGES_TOTAL_BYTES` are dropped (with their block).
    """
    references = list(dict.fromkeys(b.src for b in blocks if b.kind == "img" and b.src))[: MAX_IMAGES * 2]
    loaded = _load_images(references, loader, parallel) if references and loader else {}
    names: dict[str, tuple[str, tuple[int, int]]] = {}
    assets: dict[str, bytes] = {}
    total = 0
    for reference in references:
        data = loaded.get(reference)
        ext = image_type(data) if data else None
        if not ext or len(assets) >= MAX_IMAGES or total + len(data) > MAX_IMAGES_TOTAL_BYTES:
            continue
        size = _image_size(data, ext)
        if size and min(size) < MIN_IMAGE_SIDE:
            continue
        name = f"img-{len(assets) + 1:03d}.{ext}"
        names[reference] = (name, size or (0, 0))
        assets[name] = data
        total += len(data)
    out: list[Block] = []
    for block in blocks:
        if block.kind == "img":
            if block.src not in names:
                continue
            block.src, (block.width, block.height) = names[block.src]
        out.append(block)
    return out, assets


# ── Front doors ──────────────────────────────────────────────────────────────


def _finish(
    doc: ImportedDocument,
    language: Optional[str],
    sample: str,
    progress: Progress = None,
    *,
    images: Optional[ImageLoader] = data_uri_image,
    parallel_images: bool = False,
) -> ImportedDocument:
    doc.blocks, doc.assets = attach_images(doc.blocks, images, parallel=parallel_images)
    if not any(block.kind != "img" for block in doc.blocks):
        raise ReaderImportError("no readable text found")
    doc.language = (language or "").strip().lower()[:8] or doc.language or guess_language(sample)
    doc.segments, doc.chapters = segment_blocks(
        doc.blocks, doc.language, progress, paginated=is_paginated(doc.source_type, doc.source_name)
    )
    if not any(segment["text"] for segment in doc.segments):
        raise ReaderImportError("no readable text found")
    first_text = next(segment["text"] for segment in doc.segments if segment["text"])
    doc.title = _short_title(doc.title or "") or _short_title(first_text) or "Untitled"
    return doc


def _blocks_text(blocks: list[Block], limit: int = 40_000) -> str:
    out, size = [], 0
    for block in blocks:
        out.append(block.text)
        size += len(block.text)
        if size >= limit:
            break
    return "\n".join(out)


def _check_size(text: str) -> None:
    if len(text) > MAX_TEXT_CHARS:
        raise ReaderImportError("the text is too long for one document")


def import_text(text: str, *, title: Optional[str] = None, language: Optional[str] = None) -> ImportedDocument:
    """Pasted text. Title = the given one or the first line (<= 80 chars)."""
    from services.longform_import import chapterize_plaintext

    text = text or ""
    _check_size(text)
    if not text.strip():
        raise ReaderImportError("the text is empty")
    blocks = parse_markdown(chapterize_plaintext(text))
    doc = ImportedDocument(
        title=_clean(title or "") or _first_line(text),
        blocks=blocks,
        source_type="text",
    )
    return _finish(doc, language, _blocks_text(blocks))


def _decode_html_bytes(data: bytes, content_type: str = "") -> str:
    from services.text_upload import decode_text_upload

    charset = re.search(r"charset=([\w.:-]+)", content_type or "", re.IGNORECASE)
    if not charset:
        charset = re.search(rb"<meta[^>]{0,200}?charset\s*=\s*[\"']?\s*([\w.:-]{1,40})", data[:4096], re.IGNORECASE)
    if charset:
        name = charset.group(1)
        name = name.decode("ascii", "ignore") if isinstance(name, bytes) else name
        try:
            return data.decode(name, errors="replace")
        except (LookupError, UnicodeError):
            pass
    return decode_text_upload(data)


def _from_html(
    html: str,
    *,
    fallback_title: str,
    source_type: str,
    language: Optional[str],
    images: Optional[ImageLoader] = data_uri_image,
    **extra,
) -> ImportedDocument:
    blocks, info = parse_html(html)
    doc = ImportedDocument(
        title=info["title"] or fallback_title,
        author=info["author"],
        blocks=blocks,
        source_type=source_type,
        language=_html_lang(html),
        **extra,
    )
    return _finish(doc, language, _blocks_text(blocks), images=images, parallel_images=images is not data_uri_image)


def import_file(
    filename: str,
    data: bytes,
    *,
    language: Optional[str] = None,
    progress: Progress = None,
    image_base: Optional[str] = None,
) -> ImportedDocument:
    """txt / md / html / pdf / epub / docx bytes → document.

    ``progress`` (0–1) is reported per page for PDFs and per chapter while
    segmenting EPUBs (and every other format). Images come from the package
    (EPUB, DOCX) or ``data:`` URIs; a Markdown or HTML file fetched from the web
    passes its URL as ``image_base`` so its images are fetched too (a local file
    never makes network requests).
    """
    from services.longform_import import epub_to_chapter_script
    from services.text_upload import decode_text_upload

    if not data:
        raise ReaderImportError("the file is empty")
    if len(data) > MAX_FILE_BYTES:
        raise ReaderImportError(f"the file is too large (max {MAX_FILE_BYTES // (1024 * 1024)} MB)")
    name = os.path.basename(filename or "document")
    stem, ext = os.path.splitext(name)
    ext = ext.lower()
    # The file name is only a fallback: metadata and headings usually say more.
    title = filename_title(name)
    common = {"source_type": "file", "source_name": name}
    web_images = _url_image_loader(image_base) if image_base else data_uri_image

    if ext in (".html", ".htm", ".xhtml"):
        return _from_html(_decode_html_bytes(data), fallback_title=title, language=language, images=web_images, **common)
    if ext == ".pdf":
        return import_pdf(data, filename=name, language=language, progress=progress, **common)
    if ext == ".epub":
        try:
            script = epub_to_chapter_script(data, extract=_rich_epub_extract)
        except ValueError as exc:
            raise ReaderImportError(f"couldn't read the EPUB: {exc}") from exc
        _check_size(script)
        if progress is not None:
            progress(0.3)
        meta = epub_metadata(data)
        blocks = parse_markdown(script, markdown=False, rich=True)
        doc = ImportedDocument(
            title=pick_title([meta["title"]], filename=name),
            author=pick_author([meta["author"]]),
            blocks=blocks,
            language=meta["language"],
            cover=meta["cover"],
            **common,
        )
        return _finish(
            doc, language, _blocks_text(blocks), (lambda f: progress(0.3 + 0.7 * f)) if progress else None,
            images=_zip_image_loader(data),
        )
    if ext == ".docx":
        blocks, meta = parse_docx(data)
        opening = next((b.text for b in blocks[:3] if b.kind == "h"), None)
        doc = ImportedDocument(
            title=pick_title([meta["title"]], filename=name, heading=opening),
            author=pick_author([meta["author"]]),
            blocks=blocks,
            **common,
        )
        return _finish(doc, language, _blocks_text(blocks), progress, images=_zip_image_loader(data))
    if ext in (".txt", ".md", ".markdown", ".text", ""):
        from services.longform_import import chapterize_plaintext

        text = decode_text_upload(data)
        _check_size(text)
        is_md = ext in (".md", ".markdown")
        blocks = parse_markdown(text if is_md else chapterize_plaintext(text))
        first_heading = next((b.text for b in blocks if b.kind == "h" and b.level == 1), None)
        doc = ImportedDocument(title=(first_heading if is_md else None) or title, blocks=blocks, **common)
        return _finish(
            doc, language, _blocks_text(blocks), progress, images=web_images, parallel_images=bool(image_base)
        )
    raise ReaderImportError(
        f"unsupported file type {ext or '(none)'}; use " + ", ".join(e.lstrip(".") for e in FILE_EXTENSIONS[:-1]) + " or docx"
    )


# ── URL ──────────────────────────────────────────────────────────────────────

_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/126.0 Safari/537.36 VoiceStudio-Reader"
)


def fetch_url(
    url: str,
    *,
    max_bytes: Optional[int] = None,
    accept: Optional[str] = None,
    timeout: Optional[float] = None,
    referer: Optional[str] = None,
) -> tuple[bytes, str, str]:
    """``(body, content_type, final_url)``; blocking — call from a worker thread.

    Every hop is policy-checked (``check_public_url``) and the connections run
    under the connect-time guard, so a redirect or DNS answer can't reach a
    private address. Body capped at ``max_bytes`` (default :data:`MAX_URL_BYTES`).
    """
    import httpx

    from core.url_safety import UnsafeURLError, check_public_url, guard_outbound_connections

    limit = MAX_URL_BYTES if max_bytes is None else max_bytes
    too_large = f"the page is too large (max {max(1, limit // (1024 * 1024))} MB)"
    try:
        current = check_public_url(url)
    except UnsafeURLError as exc:
        raise ReaderImportError(str(exc)) from exc
    headers = {"User-Agent": _USER_AGENT, "Accept": accept or "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5"}
    if referer:
        headers["Referer"] = referer
    with guard_outbound_connections(), httpx.Client(
        follow_redirects=False, timeout=URL_TIMEOUT_S if timeout is None else timeout, headers=headers
    ) as client:
        for _hop in range(MAX_REDIRECTS + 1):
            with client.stream("GET", current) as response:
                if response.status_code in (301, 302, 303, 307, 308) and response.headers.get("location"):
                    nxt = urljoin(current, response.headers["location"])
                    try:
                        current = check_public_url(nxt)
                    except UnsafeURLError as exc:
                        raise ReaderImportError(str(exc)) from exc
                    continue
                if response.status_code >= 400:
                    raise ReaderImportError(f"the page answered HTTP {response.status_code}")
                declared = response.headers.get("content-length")
                if declared and declared.isdigit() and int(declared) > limit:
                    raise ReaderImportError(too_large)
                chunks, size = [], 0
                for chunk in response.iter_bytes():
                    size += len(chunk)
                    if size > limit:
                        raise ReaderImportError(too_large)
                    chunks.append(chunk)
                return b"".join(chunks), response.headers.get("content-type", ""), current
    raise ReaderImportError("too many redirects")


def import_url(url: str, *, language: Optional[str] = None) -> ImportedDocument:
    """Fetch an article URL and extract its main content. Blocking."""
    import httpx

    try:
        body, content_type, final_url = fetch_url(url)
    except ReaderImportError:
        raise
    except httpx.HTTPError as exc:
        raise ReaderImportError(f"couldn't fetch the page: {exc.__class__.__name__}") from exc
    except OSError as exc:
        raise ReaderImportError(f"couldn't fetch the page: {exc}") from exc
    host = (urlsplit(final_url).hostname or "").lower()
    if host.startswith("www."):
        host = host[4:]
    common = {"source_type": "url", "source_name": host or None, "source_url": final_url}
    kind = content_type.split(";", 1)[0].strip().lower()
    path = urlsplit(final_url).path.lower()
    if kind == "application/pdf" or path.endswith(".pdf"):
        doc = import_file(os.path.basename(path) or "document.pdf", body, language=language)
        doc.source_type, doc.source_name, doc.source_url = "url", common["source_name"], final_url
        return doc
    if kind == "text/plain" or path.endswith((".txt", ".md")):
        doc = import_file(os.path.basename(path) or "document.txt", body, language=language, image_base=final_url)
        doc.source_type, doc.source_name, doc.source_url = "url", common["source_name"], final_url
        return doc
    return _from_html(
        _decode_html_bytes(body, content_type),
        fallback_title=host or final_url,
        language=language,
        images=_url_image_loader(final_url),
        **common,
    )
