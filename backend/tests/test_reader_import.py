"""Reader import: text/markdown/html/docx/epub/url → segments, language guess."""
from __future__ import annotations

import io
import textwrap
import zipfile

import httpx
import pytest

from services import reader_import as ri


@pytest.fixture(autouse=True)
def _sentence_segments(monkeypatch):
    """These tests check sentence splitting; grouping has its own tests below."""
    monkeypatch.setattr(ri, "GROUP_CHARS", 0)


def _texts(doc):
    return [s["text"] for s in doc.segments]


# ── Segmentation ─────────────────────────────────────────────────────────────


def test_segments_are_sentences_with_paragraphs_and_headings():
    doc = ri.import_text(
        "# The Title\n\nHello there, Dr. Smith. This is a test of the reader! It works, right?\n\n"
        "Second paragraph here.",
    )
    assert doc.title == "The Title"
    assert _texts(doc) == [
        "The Title",
        "Hello there, Dr. Smith.",
        "This is a test of the reader!",
        "It works, right?",
        "Second paragraph here.",
    ]
    assert [s["kind"] for s in doc.segments] == ["h", "p", "p", "p", "p"]
    assert [s["para"] for s in doc.segments] == [0, 1, 1, 1, 2]
    assert [s["i"] for s in doc.segments] == list(range(5))
    assert doc.chapters == [{"title": "The Title", "segment": 0}]


def test_long_sentence_is_split_at_clause_punctuation_under_the_cap():
    sentence = ", ".join(["a clause with several words in it"] * 30) + "."
    pieces = ri.split_long(sentence)
    assert len(pieces) > 1
    assert all(len(p) <= ri.MAX_SEGMENT_CHARS for p in pieces)
    assert all(p.endswith(",") for p in pieces[:-1])  # cut after the comma
    assert " ".join(pieces) == sentence


def test_long_unbroken_token_is_hard_cut():
    pieces = ri.split_long("x" * 700)
    assert [len(p) for p in pieces] == [300, 300, 100]


def test_long_sentence_in_a_document_never_exceeds_cap():
    doc = ri.import_text(" ".join(["word"] * 400) + ".")
    assert len(doc.segments) >= 2
    assert all(len(s["text"]) <= ri.MAX_SEGMENT_CHARS for s in doc.segments)


def test_hard_wrapped_text_is_reflowed_into_paragraphs():
    p1 = ("It was the best of times, it was the worst of times, it was the age of wisdom, "
          "it was the age of foolishness, it was the epoch of belief.")
    p2 = ("So there were a king with a large jaw and a queen with a plain face, on the throne "
          "of England; there were a king with a large jaw and a queen with a fair face.")
    text = textwrap.fill(p1, 70) + "\n" + textwrap.fill(p2, 70)
    paragraphs = ri._reflow(text.split("\n"))
    assert paragraphs == [p1, p2]


def test_pasted_text_title_is_first_line_capped():
    doc = ri.import_text("A" * 100 + "\n\nBody sentence here.")
    assert len(doc.title) <= ri.TITLE_MAX
    assert ri.import_text("Body.", title="  Given  ").title == "Given"


def test_empty_text_is_refused():
    with pytest.raises(ri.ReaderImportError):
        ri.import_text("   \n  ")


# ── Language guess ───────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "text, lang",
    [
        ("El perro de la casa es muy grande y los niños juegan en el parque con la pelota.", "es"),
        ("The dog of the house is very big and the children are playing in the park with the ball.", "en"),
        ("Le chien de la maison est très grand et les enfants jouent dans le parc avec le ballon.", "fr"),
        ("Der Hund ist sehr groß und die Kinder spielen mit dem Ball, das ist nicht schlecht.", "de"),
    ],
)
def test_guess_language(text, lang):
    assert ri.guess_language(text) == lang


def test_user_language_wins_over_guess():
    doc = ri.import_text("The dog of the house is very big and the children play.", language="es")
    assert doc.language == "es"


# ── Markdown / text files ────────────────────────────────────────────────────


def test_markdown_file_headings_lists_and_inline_markup():
    md = (
        "# Book\n\nIntro with **bold** and a [link](https://x.test) and `code`.\n\n"
        "## Part one\n\n- first item\n- second item\n\n```\nprint('skip me')\n```\n\n"
        "## Part two\n\n> Quoted text.\n"
    )
    doc = ri.import_file("notes.md", md.encode("utf-8"))
    assert doc.title == "Book"
    assert doc.source_type == "file" and doc.source_name == "notes.md"
    texts = _texts(doc)
    assert "Intro with bold and a link and code." in texts
    assert "first item" in texts and "second item" in texts
    assert not any("skip me" in t for t in texts)
    assert "Quoted text." in texts
    # Chapters = the top heading level present.
    assert [c["title"] for c in doc.chapters] == ["Book"]
    heads = [s for s in doc.segments if s["kind"] == "h"]
    assert [h["text"] for h in heads] == ["Book", "Part one", "Part two"]


def test_txt_file_chapter_lines_become_headings():
    txt = "Chapter 1\n\nIt began here.\n\nChapter 2\n\nIt ended there.\n"
    doc = ri.import_file("story.txt", txt.encode("utf-8"))
    assert doc.title == "Story"  # the cleaned, capitalized file name
    assert [c["title"] for c in doc.chapters] == ["Chapter 1", "Chapter 2"]
    assert doc.chapters[1]["segment"] == 2


def test_unsupported_extension_is_refused():
    with pytest.raises(ri.ReaderImportError):
        ri.import_file("image.png", b"\x89PNG....")


# ── HTML ─────────────────────────────────────────────────────────────────────

_ARTICLE_HTML = """<html lang="es"><head><title>T - Site</title>
<meta property="og:title" content="Real Title"><meta name="author" content="Ana">
<script>var x = "nope";</script></head><body>
<nav><a>Home</a><a>News</a></nav><div class="share-bar">Share this</div>
<article><h1>Real Title</h1>
<p>Primera frase del artículo. Segunda frase con <a href="#">enlace</a> incluido.</p>
<aside>Publicidad aquí</aside>
<ul><li>Uno de la lista</li><li>Dos</li></ul>
<blockquote><p>Una cita famosa de alguien importante.</p></blockquote>
<p>Texto final que tiene bastantes caracteres para pasar el umbral del artículo, así que
vamos a escribir un poco más aquí para estar seguros.</p>
<form><p>Suscríbete a nuestro boletín</p></form>
</article><footer>Copyright</footer></body></html>"""


def test_html_file_prefers_article_and_drops_chrome():
    doc = ri.import_file("page.html", _ARTICLE_HTML.encode("utf-8"))
    texts = _texts(doc)
    assert doc.title == "Real Title"
    assert doc.author == "Ana"
    assert doc.language == "es"
    assert texts[0] == "Real Title" and doc.segments[0]["kind"] == "h"
    assert "Primera frase del artículo." in texts
    assert "Segunda frase con enlace incluido." in texts
    assert "Uno de la lista" in texts
    assert "Una cita famosa de alguien importante." in texts
    joined = " ".join(texts)
    for chrome in ("Home", "Share this", "Publicidad", "Copyright", "nope", "boletín"):
        assert chrome not in joined


# ── DOCX ─────────────────────────────────────────────────────────────────────

_W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


def _docx(paragraphs: list[tuple[str | None, str]]) -> bytes:
    body = "".join(
        "<w:p>"
        + (f'<w:pPr><w:pStyle w:val="{style}"/></w:pPr>' if style else "")
        + f"<w:r><w:t>{text}</w:t></w:r></w:p>"
        for style, text in paragraphs
    )
    document = f'<?xml version="1.0"?><w:document xmlns:w="{_W_NS}"><w:body>{body}</w:body></w:document>'
    styles = (
        f'<?xml version="1.0"?><w:styles xmlns:w="{_W_NS}">'
        '<w:style w:styleId="Ttulo1"><w:name w:val="heading 1"/></w:style>'
        '<w:style w:styleId="Heading2"><w:name w:val="heading 2"/></w:style>'
        "</w:styles>"
    )
    core = (
        '<?xml version="1.0"?><cp:coreProperties '
        'xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
        'xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Doc Title</dc:title>'
        "<dc:creator>Jane Writer</dc:creator></cp:coreProperties>"
    )
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("[Content_Types].xml", "<Types/>")
        z.writestr("word/document.xml", document)
        z.writestr("word/styles.xml", styles)
        z.writestr("docProps/core.xml", core)
    return buf.getvalue()


def test_docx_headings_from_styles_and_core_metadata():
    data = _docx([
        ("Ttulo1", "Chapter One"),
        (None, "First body sentence. Second body sentence."),
        ("Heading2", "A subsection"),
        (None, "More text here."),
        ("Ttulo1", "Chapter Two"),
        (None, "The end."),
    ])
    doc = ri.import_file("file.docx", data)
    assert doc.title == "Doc Title"
    assert doc.author == "Jane Writer"
    assert [c["title"] for c in doc.chapters] == ["Chapter One", "Chapter Two"]
    kinds = [(s["kind"], s["text"]) for s in doc.segments]
    assert kinds[:3] == [("h", "Chapter One"), ("p", "First body sentence."), ("p", "Second body sentence.")]
    assert ("h", "A subsection") in kinds


def test_invalid_docx_is_refused():
    with pytest.raises(ri.ReaderImportError):
        ri.import_file("broken.docx", b"not a zip")


# ── EPUB ─────────────────────────────────────────────────────────────────────


def _epub(with_cover: bool = True) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("mimetype", "application/epub+zip")
        z.writestr(
            "META-INF/container.xml",
            '<?xml version="1.0"?>'
            '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
            '<rootfiles><rootfile full-path="OEBPS/content.opf" '
            'media-type="application/oebps-package+xml"/></rootfiles></container>',
        )
        cover_item = (
            '<item id="img" href="images/cover.jpg" media-type="image/jpeg" properties="cover-image"/>'
            if with_cover else ""
        )
        z.writestr(
            "OEBPS/content.opf",
            '<?xml version="1.0"?>'
            '<package xmlns="http://www.idpf.org/2007/opf" version="3.0">'
            '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">'
            "<dc:title>My Novel</dc:title><dc:creator>A. Author</dc:creator>"
            "<dc:language>en-GB</dc:language></metadata>"
            '<manifest><item id="c0" href="ch0.xhtml" media-type="application/xhtml+xml"/>'
            '<item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>'
            f"{cover_item}</manifest>"
            '<spine><itemref idref="c0"/><itemref idref="c1"/></spine></package>',
        )
        z.writestr("OEBPS/ch0.xhtml", "<html><body><h1>Opening</h1><p>It was a dark night.</p><p>Rain fell hard.</p></body></html>")
        z.writestr("OEBPS/ch1.xhtml", "<html><body><h1>Closing</h1><p>The sun came out.</p></body></html>")
        if with_cover:
            z.writestr("OEBPS/images/cover.jpg", b"\xff\xd8\xff\xe0fakejpeg")
    return buf.getvalue()


def test_epub_chapters_metadata_and_cover():
    doc = ri.import_file("book.epub", _epub())
    assert doc.title == "My Novel"
    assert doc.author == "A. Author"
    assert doc.language == "en"
    assert doc.cover == (b"\xff\xd8\xff\xe0fakejpeg", "jpg")
    assert [c["title"] for c in doc.chapters] == ["Opening", "Closing"]
    assert _texts(doc) == ["Opening", "It was a dark night.", "Rain fell hard.", "Closing", "The sun came out."]
    assert [s["para"] for s in doc.segments] == [0, 1, 2, 3, 4]


def test_epub_without_cover():
    assert ri.import_file("book.epub", _epub(with_cover=False)).cover is None


# ── URL ──────────────────────────────────────────────────────────────────────


@pytest.fixture
def fake_web(monkeypatch):
    """httpx with a MockTransport; example.com resolves 'public', the rest real."""
    import core.url_safety as us

    real_check = us.check_public_url

    def check(url):
        if httpx.URL(url).host in ("example.com", "www.example.com"):
            return url
        return real_check(url)

    monkeypatch.setattr(us, "check_public_url", check)
    routes: dict = {}
    seen: list = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        return routes[str(request.url)]()

    real_client = httpx.Client

    def client(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(handler)
        return real_client(*args, **kwargs)

    monkeypatch.setattr(httpx, "Client", client)
    return routes, seen


def test_url_import_extracts_article(fake_web):
    routes, _ = fake_web
    routes["https://www.example.com/a"] = lambda: httpx.Response(
        200, headers={"content-type": "text/html; charset=utf-8"}, content=_ARTICLE_HTML.encode("utf-8")
    )
    doc = ri.import_url("https://www.example.com/a")
    assert doc.source_type == "url"
    assert doc.source_name == "example.com"
    assert doc.source_url == "https://www.example.com/a"
    assert doc.title == "Real Title"
    assert "Primera frase del artículo." in _texts(doc)


def test_url_redirect_is_followed_and_rechecked(fake_web):
    routes, seen = fake_web
    routes["https://example.com/old"] = lambda: httpx.Response(301, headers={"location": "/new"})
    routes["https://example.com/new"] = lambda: httpx.Response(
        200, headers={"content-type": "text/plain"}, content=b"Plain text body for the reader. A second sentence follows it."
    )
    doc = ri.import_url("https://example.com/old")
    assert seen == ["https://example.com/old", "https://example.com/new"]
    assert doc.source_url == "https://example.com/new"
    assert _texts(doc) == ["Plain text body for the reader.", "A second sentence follows it."]


def test_url_redirect_to_private_address_is_refused(fake_web, monkeypatch):
    import core.url_safety as us

    monkeypatch.setattr(us, "private_url_imports_allowed", lambda: False)
    routes, seen = fake_web
    routes["https://example.com/r"] = lambda: httpx.Response(302, headers={"location": "http://127.0.0.1:8080/x"})
    with pytest.raises(ri.ReaderImportError):
        ri.import_url("https://example.com/r")
    assert seen == ["https://example.com/r"]


def test_url_body_over_cap_is_refused(fake_web, monkeypatch):
    monkeypatch.setattr(ri, "MAX_URL_BYTES", 1000)
    routes, _ = fake_web
    routes["https://example.com/big"] = lambda: httpx.Response(
        200, headers={"content-type": "text/html"}, content=b"<p>" + b"a" * 5000 + b"</p>"
    )
    with pytest.raises(ri.ReaderImportError, match="too large"):
        ri.import_url("https://example.com/big")


def test_url_non_http_scheme_is_refused():
    with pytest.raises(ri.ReaderImportError):
        ri.import_url("file:///etc/passwd")


def test_article_extraction_drops_wiki_apparatus():
    from services import reader_import

    html = (
        '<html><head><title>T</title></head><body><main>'
        '<div class="hatnote">"Q" redirects here.</div>'
        '<table class="infobox"><tr><td>Genre</td><td>Novel</td></tr></table>'
        '<p>Don Quixote is a novel by Cervantes<sup class="reference">[1]</sup> published in 1605, '
        'widely regarded as one of the greatest works of literature.</p>'
        '<h2>Plot<span class="mw-editsection">[edit]</span></h2>'
        '<p>A gentleman reads so many chivalric romances that he sets out as a knight-errant.</p>'
        '<h2>References</h2><ol><li>Some citation that should never be read aloud at all.</li></ol>'
        '<h2>External links</h2><p>Official site with plenty of text nobody wants to hear read.</p>'
        '</main></body></html>'
    )
    blocks, _meta = reader_import.parse_html(html)
    assert [(b.kind, b.text) for b in blocks] == [
        ("p", "Don Quixote is a novel by Cervantes published in 1605, widely regarded as one of the greatest works of literature."),
        ("h", "Plot"),
        ("p", "A gentleman reads so many chivalric romances that he sets out as a knight-errant."),
    ]


@pytest.mark.parametrize(
    "title, site, expected",
    [
        ("Don Quijote de la Mancha - Wikipedia, la enciclopedia libre", "", "Don Quijote de la Mancha"),
        ("Cómo funciona un faro | El País", "El País", "Cómo funciona un faro"),
        ("Rust 1.80 released — The Rust Blog", "", "Rust 1.80 released"),
        ("Spider-Man: Far From Home review", "", "Spider-Man: Far From Home review"),
        ("COVID-19 - what we know now about long-term effects of infection", "", "COVID-19 - what we know now about long-term effects of infection"),
    ],
)
def test_strip_site_suffix(title, site, expected):
    from services.reader_import import strip_site_suffix

    assert strip_site_suffix(title, site) == expected


def test_page_level_feature_classes_do_not_drop_the_article():
    from services import reader_import

    html = (
        '<html class="client-js vector-feature-toc-pinned-clientpref-1 vector-sidebar-enabled">'
        '<body class="mw-references-wrap-feature"><main><p>The article text survives page-level feature '
        'classes that merely contain apparatus words.</p></main></body></html>'
    )
    blocks, _meta = reader_import.parse_html(html)
    assert [b.text for b in blocks] == [
        "The article text survives page-level feature classes that merely contain apparatus words."
    ]


def test_short_sentences_of_a_paragraph_are_grouped(monkeypatch):
    monkeypatch.setattr(ri, "GROUP_CHARS", 40)
    doc = ri.import_text(
        "# Title\n\nOne short line. Another short line. A third one here.\n\n"
        "New paragraph starts. It stays apart."
    )
    assert _texts(doc) == [
        "Title",
        "One short line. Another short line.",
        "A third one here.",
        "New paragraph starts. It stays apart.",
    ]
    assert [s["i"] for s in doc.segments] == [0, 1, 2, 3]
    assert doc.chapters == [{"title": "Title", "segment": 0}]


def test_group_segments_maps_every_old_index():
    old = [
        {"i": 0, "text": "Head", "para": 0, "kind": "h"},
        {"i": 1, "text": "a" * 50, "para": 1, "kind": "p"},
        {"i": 2, "text": "b" * 50, "para": 1, "kind": "p"},
        {"i": 3, "text": "c" * 200, "para": 1, "kind": "p"},
        {"i": 4, "text": "d" * 10, "para": 2, "kind": "p"},
    ]
    new, mapping = ri.group_segments(old, limit=120)
    assert [len(s["text"]) for s in new] == [4, 101, 200, 10]
    assert mapping == [0, 1, 1, 2, 3]


def test_repair_reads_small_caps_openings_on_and_joins_broken_paragraphs():
    segs = [
        {"i": 0, "text": "Fin del capítulo anterior.", "para": 0, "kind": "p"},
        {"i": 1, "text": "VIN ATERRIZÓ CON SUAVIDAD", "para": 1, "kind": "h"},
        {"i": 2, "text": "en el húmedo empedrado viendo cómo las", "para": 2, "kind": "p"},
        {"i": 3, "text": "brumas empezaban a formarse.", "para": 3, "kind": "p"},
        {"i": 4, "text": "La ciudad estaba en silencio, inter-", "para": 4, "kind": "p"},
        {"i": 5, "text": "rumpido solo por el viento.", "para": 5, "kind": "p"},
        {"i": 6, "text": "Nuevo párrafo.", "para": 6, "kind": "p"},
    ]
    new, chapters, mapping = ri.repair_segments(
        segs, [{"title": "VIN ATERRIZÓ CON SUAVIDAD", "segment": 1}], limit=0, paginated=True
    )
    assert [s["text"] for s in new] == [
        "Fin del capítulo anterior.",
        "Vin aterrizó con suavidad en el húmedo empedrado viendo cómo las brumas empezaban a formarse.",
        "La ciudad estaba en silencio, interrumpido solo por el viento.",
        "Nuevo párrafo.",
    ]
    assert [s["kind"] for s in new] == ["p", "p", "p", "p"]
    assert [s["para"] for s in new] == [0, 1, 2, 3]
    assert chapters == [{"title": "Vin aterrizó con suavidad", "segment": 1}]
    assert mapping == [0, 1, 1, 1, 2, 2, 3]


def test_repair_glues_italic_runs_and_stray_punctuation_back_on():
    # Italic thoughts and a lone final "." that a PDF extraction set apart as paragraphs.
    segs = [
        {"i": 0, "text": "No hemos prestado suficiente atención a esa amenaza", "para": 0, "kind": "p"},
        {"i": 1, "text": ", pensó.", "para": 1, "kind": "p"},
        {"i": 2, "text": "Tan peligroso para nuestros enemigos como para nosotros", "para": 2, "kind": "p"},
        {"i": 3, "text": ".", "para": 3, "kind": "p"},
        {"i": 4, "text": "Qué diligente", "para": 4, "kind": "p"},
        {"i": 5, "text": ", pensó, estudiando el rostro de Demoux.", "para": 5, "kind": "p"},
        {"i": 6, "text": "Siguió hablando sin parar:", "para": 6, "kind": "p"},
        {"i": 7, "text": "»Y entonces llegó la bruma.", "para": 7, "kind": "p"},
        {"i": 8, "text": "…y nadie volvió a verlo.", "para": 8, "kind": "p"},
    ]
    new, _, mapping = ri.repair_segments(segs, [], limit=0, paginated=True)
    assert [s["text"] for s in new] == [
        "No hemos prestado suficiente atención a esa amenaza, pensó.",
        "Tan peligroso para nuestros enemigos como para nosotros.",
        "Qué diligente, pensó, estudiando el rostro de Demoux.",
        "Siguió hablando sin parar:",
        "»Y entonces llegó la bruma.",
        "…y nadie volvió a verlo.",
    ]
    assert mapping == [0, 0, 1, 1, 2, 2, 3, 4, 5]
    # Not paginated (EPUB, HTML): paragraphs are the author's, never glued.
    kept, _, _ = ri.repair_segments(segs[:2], [], limit=0)
    assert [s["text"] for s in kept] == [segs[0]["text"], ", pensó."]


@pytest.mark.parametrize(
    ("left", "right", "joined"),
    [
        ("Me pregunto", "…", "Me pregunto…"),
        ("No pertenecemos a su mundo", "… Zane no podía saberlo.", "No pertenecemos a su mundo… Zane no podía saberlo."),
        ("Había incumplido su", "Contrato. Por ella.", "Había incumplido su Contrato. Por ella."),
        ("—¿De verdad crees que", "Kelsier va a protegerlos?", "—¿De verdad crees que Kelsier va a protegerlos?"),
        ("inició con", "El camino de los reyes", "inició con El camino de los reyes"),
        ("Su primera novela (2006),", "El Pozo de la Ascensión", "Su primera novela (2006), El Pozo de la Ascensión"),
        ("—", "¡No!", "—¡No!"),
        # A sentence may end without a stop (a heading-like line, a date): kept apart.
        ("Tenía una herida en el lomo", "No, una herida no.", None),
        ("Fecha de esta edición: Septiembre de 2021", "Traducción: Rafael Marín", None),
        ("Fin del capítulo.", "…y nadie volvió a verlo.", None),
    ],
)
def test_paragraph_continuation_across_page_and_italic_breaks(left, right, joined):
    assert ri._paragraph_continuation(left, right) == joined


def test_repair_keeps_real_headings_and_finished_paragraphs():
    segs = [
        {"i": 0, "text": "CAPÍTULO 3", "para": 0, "kind": "h"},
        {"i": 1, "text": "El día empezó tranquilo.", "para": 1, "kind": "p"},
        {"i": 2, "text": "Otro párrafo completo.", "para": 2, "kind": "p"},
    ]
    new, chapters, mapping = ri.repair_segments(segs, [{"title": "CAPÍTULO 3", "segment": 0}], limit=0)
    assert [s["kind"] for s in new] == ["h", "p", "p"] and mapping == [0, 1, 2]
