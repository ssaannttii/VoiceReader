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

import io
import os
import posixpath
import re
import zipfile
from dataclasses import dataclass, field
from html.parser import HTMLParser
from typing import Optional
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
SEGMENTATION_VERSION = 2
#: Upload / download caps.
MAX_FILE_BYTES = 64 * 1024 * 1024
MAX_URL_BYTES = 10 * 1024 * 1024
URL_TIMEOUT_S = 20.0
MAX_REDIRECTS = 5
#: Text cap after extraction (~ a 1,500-page book) so one import can't
#: produce an unbounded content file.
MAX_TEXT_CHARS = 5_000_000
TITLE_MAX = 80

FILE_EXTENSIONS = (".txt", ".md", ".markdown", ".html", ".htm", ".pdf", ".epub", ".docx")


@dataclass
class Block:
    kind: str  # "h" | "p"
    text: str
    level: int = 0  # heading level (1-6) for "h"


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


def group_segments(segments: list[dict], limit: Optional[int] = None) -> tuple[list[dict], list[int]]:
    """Merge consecutive body sentences of the same paragraph up to ``limit`` chars.

    Returns the regrouped segments (renumbered) and, for every input index, the
    index of the segment that now contains it. Headings are never merged.
    """
    limit = GROUP_CHARS if limit is None else limit
    out: list[dict] = []
    mapping: list[int] = []
    for seg in segments:
        prev = out[-1] if out else None
        if (
            prev is not None
            and seg["kind"] == "p"
            and prev["kind"] == "p"
            and prev["para"] == seg["para"]
            and len(prev["text"]) + 1 + len(seg["text"]) <= limit
        ):
            prev["text"] = f"{prev['text']} {seg['text']}"
        else:
            out.append({"i": len(out), "text": seg["text"], "para": seg["para"], "kind": seg["kind"]})
        mapping.append(len(out) - 1)
    return out, mapping


def segment_blocks(blocks: list[Block], language: Optional[str]) -> tuple[list[dict], list[dict]]:
    """``(segments, chapters)`` for a block list.

    Chapters are the headings at the document's top heading level (``#`` in
    Markdown, EPUB/PDF chapter titles, ``Heading 1`` in DOCX).
    """
    segments: list[dict] = []
    chapters: list[dict] = []
    levels = [b.level for b in blocks if b.kind == "h" and _clean(b.text)]
    top = min(levels) if levels else None
    para = 0
    for block in blocks:
        text = _clean(block.text)
        if not text:
            continue
        if block.kind == "h":
            if block.level == top:
                chapters.append({"title": _short_title(text), "segment": len(segments)})
            pieces = split_long(text)
            kind = "h"
        else:
            pieces = split_sentences(text, language)
            kind = "p"
        for piece in pieces:
            segments.append({"i": len(segments), "text": piece, "para": para, "kind": kind})
        para += 1
    segments, mapping = group_segments(segments)
    for chapter in chapters:
        chapter["segment"] = mapping[chapter["segment"]] if chapter["segment"] < len(mapping) else len(segments)
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
_MD_LIST_RE = re.compile(r"^\s*(?:[-*+]|\d{1,3}[.)])\s+")
_MD_QUOTE_RE = re.compile(r"^\s*(?:>\s?)+")
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


def parse_markdown(text: str, *, markdown: bool = True) -> list[Block]:
    """Blocks from Markdown (or plain text with ``# `` chapter headings).

    ``markdown=False`` recognizes only ATX headings (the chapter-script grammar
    ``services.longform_import`` emits) and leaves inline characters alone.
    """
    blocks: list[Block] = []
    pending: list[str] = []
    in_fence = False

    def flush() -> None:
        if not pending:
            return
        for paragraph in _reflow(pending):
            body = _strip_inline_md(paragraph) if markdown else paragraph
            if _clean(body):
                blocks.append(Block("p", body))
        pending.clear()

    for raw in (text or "").replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        if markdown and _MD_FENCE_RE.match(raw):
            flush()
            in_fence = not in_fence
            continue
        if in_fence:
            continue  # code is not narrated
        heading = _MD_HEADING_RE.match(raw)
        if heading:
            flush()
            title = _strip_inline_md(heading.group(2)) if markdown else heading.group(2)
            if _clean(title):
                blocks.append(Block("h", title, level=len(heading.group(1))))
            continue
        if markdown:
            setext = _MD_SETEXT_RE.match(raw)
            if setext and len(pending) == 1 and pending[0].strip():
                title = _strip_inline_md(pending[0])
                pending.clear()
                blocks.append(Block("h", title, level=1 if setext.group(1)[0] == "=" else 2))
                continue
            if _MD_RULE_RE.match(raw) or _MD_TABLE_SEP_RE.match(raw):
                flush()
                continue
            line = _MD_QUOTE_RE.sub("", raw)
            if _MD_LIST_RE.match(line):
                flush()
                pending.append(_MD_LIST_RE.sub("", line))
                flush()
                continue
            if line.strip().startswith("|") and line.strip().endswith("|"):
                flush()
                cells = [c.strip() for c in line.strip().strip("|").split("|")]
                pending.append(", ".join(c for c in cells if c))
                flush()
                continue
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


class _ArticleParser(HTMLParser):
    """Main-content extraction with the stdlib parser.

    Collects ``h1-h3``, ``p``, ``li`` and ``blockquote`` text (plus loose text
    inside ``div``-like containers), tagging each block with the ``<article>``
    and ``<main>`` it sits in so the caller can prefer real article content
    over the page chrome around it.
    """

    _DROP = {
        "script", "style", "noscript", "nav", "aside", "footer", "form", "template",
        "svg", "button", "select", "textarea", "iframe", "canvas", "object", "dialog",
        "menu", "figure",
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
        #: (kind, level, text, article_index | -1, in_main)
        self.blocks: list[tuple[str, int, str, int, bool]] = []

    # -- helpers
    def _flush(self) -> None:
        text = _clean("".join(self._buffer))
        self._buffer = []
        if not text:
            return
        tag = self._block_stack[-1] if self._block_stack else ""
        level = self._BLOCKS.get(tag, 0)
        kind = "h" if level else ("p" if tag else "loose")
        article = self._article_index if self._article_depth else -1
        self.blocks.append((kind, level, text, article, self._main_depth > 0))

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

    def handle_data(self, data):
        if self._in_title:
            self.title_tag += data
            return
        if self._drop_depth:
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


def _select_blocks(raw: list[tuple[str, int, str, int, bool]]) -> list[Block]:
    def chars(items) -> int:
        return sum(len(t) for k, _, t, _, _ in items if k != "h")

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
    for kind, level, text, _article, _main in chosen:
        if kind == "h":
            if skip_level and level <= skip_level:
                skip_level = 0
            if not skip_level and _APPARATUS_HEADING_RE.match(text):
                skip_level = level
        if skip_level:
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
    try:
        root = ET.fromstring(document)  # nosec B314 — local user file, no external entities
    except ET.ParseError as exc:
        raise ReaderImportError(f"DOCX document is not well-formed XML: {exc}") from exc

    style_levels: dict[str, int] = {}
    if styles_xml:
        try:
            for style in ET.fromstring(styles_xml).iter(f"{_W}style"):  # nosec B314
                style_id = style.get(f"{_W}styleId") or ""
                name_el = style.find(f"{_W}name")
                name = (name_el.get(f"{_W}val") if name_el is not None else "") or style_id
                level = _style_level(name) or _style_level(style_id)
                if level:
                    style_levels[style_id] = level
        except ET.ParseError:
            pass

    blocks: list[Block] = []
    body = root.find(f"{_W}body")
    for paragraph in (body.iter(f"{_W}p") if body is not None else []):
        parts: list[str] = []
        for node in paragraph.iter():
            if node.tag == f"{_W}t" and node.text:
                parts.append(node.text)
            elif node.tag in (f"{_W}tab", f"{_W}br", f"{_W}cr"):
                parts.append(" ")
        text = _clean("".join(parts))
        if not text:
            continue
        style_el = paragraph.find(f"{_W}pPr/{_W}pStyle")
        style_id = style_el.get(f"{_W}val") if style_el is not None else ""
        level = style_levels.get(style_id or "") or _style_level(style_id or "")
        blocks.append(Block("h", text, level=level) if level else Block("p", text))

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


# ── Front doors ──────────────────────────────────────────────────────────────


def _finish(doc: ImportedDocument, language: Optional[str], sample: str) -> ImportedDocument:
    if not doc.blocks:
        raise ReaderImportError("no readable text found")
    doc.language = (language or "").strip().lower()[:8] or doc.language or guess_language(sample)
    doc.segments, doc.chapters = segment_blocks(doc.blocks, doc.language)
    if not doc.segments:
        raise ReaderImportError("no readable text found")
    doc.title = _short_title(doc.title or "") or _short_title(doc.segments[0]["text"]) or "Untitled"
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


def _from_html(html: str, *, fallback_title: str, source_type: str, language: Optional[str], **extra) -> ImportedDocument:
    blocks, info = parse_html(html)
    doc = ImportedDocument(
        title=info["title"] or fallback_title,
        author=info["author"],
        blocks=blocks,
        source_type=source_type,
        language=_html_lang(html),
        **extra,
    )
    return _finish(doc, language, _blocks_text(blocks))


def import_file(filename: str, data: bytes, *, language: Optional[str] = None) -> ImportedDocument:
    """txt / md / html / pdf / epub / docx bytes → document."""
    from services.longform_import import epub_to_chapter_script, pdf_to_chapter_script
    from services.text_upload import decode_text_upload

    if not data:
        raise ReaderImportError("the file is empty")
    if len(data) > MAX_FILE_BYTES:
        raise ReaderImportError(f"the file is too large (max {MAX_FILE_BYTES // (1024 * 1024)} MB)")
    name = os.path.basename(filename or "document")
    stem, ext = os.path.splitext(name)
    ext = ext.lower()
    title = stem.replace("_", " ").strip()
    common = {"source_type": "file", "source_name": name}

    if ext in (".html", ".htm", ".xhtml"):
        return _from_html(_decode_html_bytes(data), fallback_title=title, language=language, **common)
    if ext == ".pdf":
        try:
            script = pdf_to_chapter_script(data)
        except ValueError as exc:
            raise ReaderImportError(f"couldn't read the PDF: {exc}") from exc
        _check_size(script)
        blocks = parse_markdown(script, markdown=False)
        doc = ImportedDocument(title=title, blocks=blocks, **common)
        return _finish(doc, language, _blocks_text(blocks))
    if ext == ".epub":
        try:
            script = epub_to_chapter_script(data)
        except ValueError as exc:
            raise ReaderImportError(f"couldn't read the EPUB: {exc}") from exc
        _check_size(script)
        meta = epub_metadata(data)
        blocks = parse_markdown(script, markdown=False)
        doc = ImportedDocument(
            title=meta["title"] or title,
            author=meta["author"],
            blocks=blocks,
            language=meta["language"],
            cover=meta["cover"],
            **common,
        )
        return _finish(doc, language, _blocks_text(blocks))
    if ext == ".docx":
        blocks, meta = parse_docx(data)
        doc = ImportedDocument(title=meta["title"] or title, author=meta["author"], blocks=blocks, **common)
        return _finish(doc, language, _blocks_text(blocks))
    if ext in (".txt", ".md", ".markdown", ".text", ""):
        from services.longform_import import chapterize_plaintext

        text = decode_text_upload(data)
        _check_size(text)
        is_md = ext in (".md", ".markdown")
        blocks = parse_markdown(text if is_md else chapterize_plaintext(text))
        first_heading = next((b.text for b in blocks if b.kind == "h" and b.level == 1), None)
        doc = ImportedDocument(title=(first_heading if is_md else None) or title, blocks=blocks, **common)
        return _finish(doc, language, _blocks_text(blocks))
    raise ReaderImportError(
        f"unsupported file type {ext or '(none)'}; use " + ", ".join(e.lstrip(".") for e in FILE_EXTENSIONS[:-1]) + " or docx"
    )


# ── URL ──────────────────────────────────────────────────────────────────────

_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/126.0 Safari/537.36 VoiceStudio-Reader"
)


def fetch_url(url: str) -> tuple[bytes, str, str]:
    """``(body, content_type, final_url)``; blocking — call from a worker thread.

    Every hop is policy-checked (``check_public_url``) and the connections run
    under the connect-time guard, so a redirect or DNS answer can't reach a
    private address. Body capped at :data:`MAX_URL_BYTES`.
    """
    import httpx

    from core.url_safety import UnsafeURLError, check_public_url, guard_outbound_connections

    try:
        current = check_public_url(url)
    except UnsafeURLError as exc:
        raise ReaderImportError(str(exc)) from exc
    headers = {"User-Agent": _USER_AGENT, "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5"}
    with guard_outbound_connections(), httpx.Client(
        follow_redirects=False, timeout=URL_TIMEOUT_S, headers=headers
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
                if declared and declared.isdigit() and int(declared) > MAX_URL_BYTES:
                    raise ReaderImportError("the page is too large (max 10 MB)")
                chunks, size = [], 0
                for chunk in response.iter_bytes():
                    size += len(chunk)
                    if size > MAX_URL_BYTES:
                        raise ReaderImportError("the page is too large (max 10 MB)")
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
        doc = import_file(os.path.basename(path) or "document.txt", body, language=language)
        doc.source_type, doc.source_name, doc.source_url = "url", common["source_name"], final_url
        return doc
    return _from_html(
        _decode_html_bytes(body, content_type),
        fallback_title=host or final_url,
        language=language,
        **common,
    )
