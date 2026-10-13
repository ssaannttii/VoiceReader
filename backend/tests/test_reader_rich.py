"""Reader rich content: lists, quotes and images in every format, their
segmentation rules, and the image asset route."""
from __future__ import annotations

import base64
import io
import struct
import zipfile
import zlib

import httpx
import pytest

from services import reader_import as ri


def _png(width: int = 120, height: int = 80) -> bytes:
    """A real (tiny) PNG of the given size."""

    def chunk(kind: bytes, payload: bytes) -> bytes:
        return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload))

    rows = b"".join(b"\x00" + b"\x80\x80\x80" * width for _ in range(height))
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(rows))
        + chunk(b"IEND", b"")
    )


def _data_uri(data: bytes) -> str:
    return "data:image/png;base64," + base64.b64encode(data).decode("ascii")


def _kinds(doc) -> list[tuple]:
    out = []
    for s in doc.segments:
        if s["kind"] == "li":
            out.append(("li", s["text"], s["list"], s["ordered"], s["n"], s.get("depth", 0)))
        elif s["kind"] == "img":
            out.append(("img", s["src"], s.get("alt"), s.get("caption")))
        else:
            out.append((s["kind"], s["text"]))
    return out


# ── Segmentation rules ───────────────────────────────────────────────────────


def test_list_items_are_their_own_paragraphs_and_never_grouped():
    blocks = [
        ri.Block("li", "One.", list_id=7, n=1),
        ri.Block("li", "Two.", list_id=7, n=2),
        ri.Block("li", "Three. Still three.", list_id=7, n=3),
        ri.Block("p", "After the list."),
    ]
    segments, _chapters = ri.segment_blocks(blocks, "en")
    assert [(s["kind"], s["text"]) for s in segments] == [
        ("li", "One."), ("li", "Two."), ("li", "Three. Still three."), ("p", "After the list."),
    ]
    assert [s["para"] for s in segments] == [0, 1, 2, 3]
    assert [s["list"] for s in segments[:3]] == [0, 0, 0]  # renumbered densely per document
    assert [s["n"] for s in segments[:3]] == [1, 2, 3]
    assert "depth" not in segments[0]


def test_paginated_repair_never_joins_list_items_or_quotes():
    blocks = [
        ri.Block("li", "an item without a stop", list_id=1, n=1),
        ri.Block("li", "and another one", list_id=1, n=2),
        ri.Block("quote", "a quote without a stop"),
        ri.Block("p", "continues in lowercase."),
    ]
    segments, _ = ri.segment_blocks(blocks, "en", paginated=True)
    assert [s["kind"] for s in segments] == ["li", "li", "quote", "p"]


def test_quotes_group_only_within_their_paragraph():
    segments = [
        {"i": 0, "text": "First.", "para": 0, "kind": "quote"},
        {"i": 1, "text": "Second.", "para": 0, "kind": "quote"},
        {"i": 2, "text": "Other quote.", "para": 1, "kind": "quote"},
        {"i": 3, "text": "Body.", "para": 2, "kind": "p"},
    ]
    grouped, mapping = ri.group_segments(segments, 280)
    assert [(s["kind"], s["text"]) for s in grouped] == [
        ("quote", "First. Second."), ("quote", "Other quote."), ("p", "Body."),
    ]
    assert mapping == [0, 0, 1, 2]


def test_image_is_one_silent_segment_and_survives_repair():
    blocks = [
        ri.Block("p", "Before."),
        ri.Block("img", "", src="img-001.png", alt="A chart", caption="Figure 1"),
        ri.Block("p", "After."),
    ]
    segments, _ = ri.segment_blocks(blocks, "en")
    assert segments[1] == {"i": 1, "text": "", "para": 1, "kind": "img", "src": "img-001.png", "alt": "A chart", "caption": "Figure 1"}
    again, _chapters, mapping = ri.repair_segments(segments, [], paginated=True)
    assert again == segments and mapping == [0, 1, 2]


def test_old_documents_get_no_rich_fields():
    old = [{"i": 0, "text": "A.", "para": 0, "kind": "p"}, {"i": 1, "text": "B.", "para": 0, "kind": "p"}]
    grouped, _chapters, _mapping = ri.repair_segments(old, [])
    assert grouped == [{"i": 0, "text": "A. B.", "para": 0, "kind": "p"}]


def test_document_of_only_images_is_refused():
    with pytest.raises(ri.ReaderImportError):
        ri.import_text(f"![x]({_data_uri(_png())})")


# ── Markdown ─────────────────────────────────────────────────────────────────


def test_markdown_lists_quotes_and_images(monkeypatch):
    monkeypatch.setattr(ri, "GROUP_CHARS", 0)
    md = (
        "# Notes\n\nIntro text here.\n\n"
        "- apples\n- pears\n  - green ones\n    - very green\n      - too deep\n- plums\n"
        "continued plums\n\n"
        "3. third\n4. fourth\n\n"
        "> A quoted first line that is long enough to wrap\n> and a second line that continues the quotation\n"
        "> still the same quote.\n>\n> Second quote paragraph.\n\n"
        f"![A grey box]({_data_uri(_png())} \"The caption\")\n\n"
        "![remote](https://example.com/pic.png)\n\nThe end.\n"
    )
    doc = ri.import_file("notes.md", md.encode("utf-8"))
    kinds = _kinds(doc)
    lists = [k for k in kinds if k[0] == "li"]
    outer, nested, deeper = lists[0][2], lists[2][2], lists[3][2]
    assert lists == [
        ("li", "apples", outer, False, 1, 0),
        ("li", "pears", outer, False, 2, 0),
        ("li", "green ones", nested, False, 1, 1),
        ("li", "very green", deeper, False, 1, 2),
        ("li", "too deep", deeper, False, 2, 2),  # capped at three levels
        ("li", "plums continued plums", outer, False, 3, 0),
        ("li", "third", lists[6][2], True, 3, 0),
        ("li", "fourth", lists[6][2], True, 4, 0),
    ]
    assert len({outer, nested, deeper, lists[6][2]}) == 4
    quoted = "A quoted first line that is long enough to wrap and a second line that continues the quotation still the same quote."
    assert ("quote", quoted) in kinds
    assert ("quote", "Second quote paragraph.") in kinds
    images = [k for k in kinds if k[0] == "img"]
    # A local file never fetches remote images; data: URIs are kept.
    assert images == [("img", "img-001.png", "A grey box", "The caption")]
    assert doc.assets == {"img-001.png": _png()}


def test_markdown_inline_image_follows_its_paragraph():
    doc = ri.import_text(f"Text before ![pic]({_data_uri(_png())}) and after.")
    assert [(s["kind"], s["text"]) for s in doc.segments] == [("p", "Text before and after."), ("img", "")]


def test_tiny_and_non_raster_images_are_dropped():
    svg = "data:image/svg+xml;base64," + base64.b64encode(b"<svg/>").decode()
    doc = ri.import_text(f"Body text.\n\n![dot]({_data_uri(_png(1, 1))})\n\n![svg]({svg})")
    assert [s["kind"] for s in doc.segments] == ["p"]
    assert doc.assets == {}


# ── HTML ─────────────────────────────────────────────────────────────────────

_RICH_HTML = f"""<html><head><title>Rich</title></head><body><article>
<h1>Rich</h1>
<p>Una introducción con bastante texto para que el artículo supere el umbral mínimo de caracteres.</p>
<ul><li>Primero</li><li>Segundo<ul><li>Anidado</li></ul></li><li><p>Tercero</p></li></ul>
<ol start="5"><li>Cinco</li><li>Seis</li></ol>
<blockquote><p>Una cita.</p><p>Otra parte de la cita.</p></blockquote>
<figure><img src="{_data_uri(_png())}" alt="Una caja"><figcaption>Pie de foto</figcaption></figure>
<p>Con icono <img src="{_data_uri(_png())}" width="16" height="16"> y logo <img class="site-logo" src="{_data_uri(_png())}">
y píxel <img src="https://t.example/pixel.gif"> en línea.</p>
<figure><blockquote>Cita destacada embebida</blockquote></figure>
<p>Final del artículo con más texto para leer en voz alta.</p>
</article></body></html>"""


def test_html_lists_quotes_figures_and_noise_images(monkeypatch):
    monkeypatch.setattr(ri, "GROUP_CHARS", 0)
    doc = ri.import_file("page.html", _RICH_HTML.encode("utf-8"))
    kinds = _kinds(doc)
    lists = [k for k in kinds if k[0] == "li"]
    assert [(k[1], k[3], k[4], k[5]) for k in lists] == [
        ("Primero", False, 1, 0), ("Segundo", False, 2, 0), ("Anidado", False, 1, 1), ("Tercero", False, 3, 0),
        ("Cinco", True, 5, 0), ("Seis", True, 6, 0),
    ]
    assert lists[0][2] == lists[1][2] == lists[3][2] != lists[2][2]
    assert ("quote", "Una cita.") in kinds and ("quote", "Otra parte de la cita.") in kinds
    quotes = [s for s in doc.segments if s["kind"] == "quote"]
    assert quotes[0]["para"] != quotes[1]["para"]
    assert [k for k in kinds if k[0] == "img"] == [("img", "img-001.png", "Una caja", "Pie de foto")]
    texts = [s["text"] for s in doc.segments]
    assert "Con icono y logo y píxel en línea." in texts
    assert not any("embebida" in t for t in texts)  # other figure content is still not read


def test_html_image_filter():
    assert ri._html_image({"src": "/a.jpg", "alt": " A "}) == ("/a.jpg", "A")
    assert ri._html_image({"src": "data:image/gif;base64,R0lGOD", "data-src": "/real.jpg"}) == ("/real.jpg", "")
    assert ri._html_image({"srcset": "/s.jpg 300w, /m.jpg 800w, /xl.jpg 3000w"}) == ("/m.jpg", "")
    for attrs in (
        {"src": "/a.jpg", "width": "20"},
        {"src": "/a.jpg", "height": "1"},
        {"src": "/a.svg"},
        {"src": "/a.jpg", "class": "author-avatar"},
        {"src": "/static/icons/x.png"},
        {"src": "/a.jpg", "aria-hidden": "true"},
        {"src": "data:image/svg+xml,<svg/>"},
        {},
    ):
        assert ri._html_image(attrs) is None, attrs


# ── URL import: images through the safe fetch ───────────────────────────────


@pytest.fixture
def fake_web(monkeypatch):
    import core.url_safety as us

    real_check = us.check_public_url

    def check(url):
        if httpx.URL(url).host in ("example.com", "cdn.example.com"):
            return url
        return real_check(url)

    monkeypatch.setattr(us, "check_public_url", check)
    monkeypatch.setattr(us, "private_url_imports_allowed", lambda: False)
    routes: dict = {}
    seen: list = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((str(request.url), request.headers.get("accept", "")))
        route = routes.get(str(request.url))
        return route() if route else httpx.Response(404)

    real_client = httpx.Client

    def client(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(handler)
        return real_client(*args, **kwargs)

    monkeypatch.setattr(httpx, "Client", client)
    return routes, seen


def test_url_import_downloads_content_images(fake_web, monkeypatch):
    monkeypatch.setattr(ri, "MAX_IMAGE_BYTES", 50_000)
    routes, seen = fake_web
    page = (
        "<html><body><article><h1>Pics</h1>"
        "<p>" + "Texto del artículo con suficiente longitud. " * 8 + "</p>"
        '<figure><img src="/img/a.png" alt="A"><figcaption>Cap A</figcaption></figure>'
        '<img src="https://cdn.example.com/b.png" alt="B">'
        '<img src="/img/missing.png"><img src="/img/huge.png"><img src="/img/fake.png">'
        '<img src="http://127.0.0.1/secret.png">'
        "<p>Fin.</p></article></body></html>"
    )
    routes["https://example.com/post"] = lambda: httpx.Response(200, headers={"content-type": "text/html"}, content=page.encode())
    routes["https://example.com/img/a.png"] = lambda: httpx.Response(200, content=_png())
    routes["https://cdn.example.com/b.png"] = lambda: httpx.Response(200, content=_png(200, 100))
    routes["https://example.com/img/huge.png"] = lambda: httpx.Response(200, content=_png() + b"\0" * 60_000)
    routes["https://example.com/img/fake.png"] = lambda: httpx.Response(200, content=b"<html>not an image</html>")
    doc = ri.import_url("https://example.com/post")
    assert [k for k in _kinds(doc) if k[0] == "img"] == [
        ("img", "img-001.png", "A", "Cap A"), ("img", "img-002.png", "B", None),
    ]
    assert set(doc.assets) == {"img-001.png", "img-002.png"}
    image_requests = [url for url, accept in seen if accept.startswith("image/")]
    assert "http://127.0.0.1/secret.png" not in image_requests  # refused by the SSRF policy


def test_url_import_caps_image_count(fake_web, monkeypatch):
    monkeypatch.setattr(ri, "MAX_IMAGES", 3)
    routes, _seen = fake_web
    imgs = "".join(f'<img src="/i{n}.png">' for n in range(6))
    page = f"<article><p>{'Bastante texto aquí para el artículo. ' * 8}</p>{imgs}</article>"
    routes["https://example.com/many"] = lambda: httpx.Response(200, headers={"content-type": "text/html"}, content=page.encode())
    for n in range(6):
        routes[f"https://example.com/i{n}.png"] = lambda: httpx.Response(200, content=_png())
    doc = ri.import_url("https://example.com/many")
    assert sorted(doc.assets) == ["img-001.png", "img-002.png", "img-003.png"]
    assert sum(1 for s in doc.segments if s["kind"] == "img") == 3


def test_markdown_from_a_url_fetches_its_images(fake_web):
    routes, _seen = fake_web
    routes["https://example.com/doc.md"] = lambda: httpx.Response(
        200, headers={"content-type": "text/markdown"}, content=b"# Doc\n\nSome text here.\n\n![pic](pics/p.png)\n"
    )
    routes["https://example.com/pics/p.png"] = lambda: httpx.Response(200, content=_png())
    doc = ri.import_url("https://example.com/doc.md")
    assert [k for k in _kinds(doc) if k[0] == "img"] == [("img", "img-001.png", "pic", None)]


# ── DOCX ─────────────────────────────────────────────────────────────────────

_W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
_NS = (
    f'xmlns:w="{_W}" '
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" '
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
)


def _para(text: str, *, style: str = "", num: tuple[int, int] | None = None) -> str:
    ppr = ""
    if style or num:
        ppr = "<w:pPr>" + (f'<w:pStyle w:val="{style}"/>' if style else "")
        if num:
            ppr += f'<w:numPr><w:ilvl w:val="{num[1]}"/><w:numId w:val="{num[0]}"/></w:numPr>'
        ppr += "</w:pPr>"
    return f"<w:p>{ppr}<w:r><w:t>{text}</w:t></w:r></w:p>"


def _docx_rich() -> bytes:
    drawing = (
        '<w:p><w:r><w:drawing><wp:inline><wp:docPr id="1" name="Picture 1" descr="A diagram"/>'
        '<a:graphic><a:graphicData><a:blip r:embed="rId9"/></a:graphicData></a:graphic>'
        "</wp:inline></w:drawing></w:r></w:p>"
    )
    body = "".join([
        _para("Doc heading", style="Heading1"),
        _para("Plain paragraph."),
        _para("Bullet one", num=(1, 0)),
        _para("Sub bullet", num=(1, 1)),
        _para("Bullet two", num=(1, 0)),
        _para("Step one", num=(2, 0)),
        _para("Step two", num=(2, 0)),
        _para("Quoted words.", style="Quote"),
        drawing,
        _para("Closing text."),
    ])
    numbering = (
        f'<w:numbering xmlns:w="{_W}">'
        '<w:abstractNum w:abstractNumId="10"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/></w:lvl>'
        '<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>'
        '<w:abstractNum w:abstractNumId="11"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>'
        '<w:num w:numId="1"><w:abstractNumId w:val="10"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="11"/></w:num>'
        "</w:numbering>"
    )
    styles = (
        f'<w:styles xmlns:w="{_W}"><w:style w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>'
        '<w:style w:styleId="Quote"><w:name w:val="Quote"/></w:style></w:styles>'
    )
    rels = (
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" '
        'Target="media/image1.png"/></Relationships>'
    )
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("word/document.xml", f"<w:document {_NS}><w:body>{body}</w:body></w:document>")
        z.writestr("word/styles.xml", styles)
        z.writestr("word/numbering.xml", numbering)
        z.writestr("word/_rels/document.xml.rels", rels)
        z.writestr("word/media/image1.png", _png())
    return buf.getvalue()


def test_docx_lists_quotes_and_images():
    doc = ri.import_file("rich.docx", _docx_rich())
    kinds = _kinds(doc)
    lists = [k for k in kinds if k[0] == "li"]
    assert [(k[1], k[3], k[4], k[5]) for k in lists] == [
        ("Bullet one", False, 1, 0), ("Sub bullet", False, 1, 1), ("Bullet two", False, 2, 0),
        ("Step one", True, 1, 0), ("Step two", True, 2, 0),
    ]
    assert lists[0][2] == lists[2][2] and len({lists[0][2], lists[1][2], lists[3][2]}) == 3
    assert ("quote", "Quoted words.") in kinds
    assert ("img", "img-001.png", "A diagram", None) in kinds
    assert doc.assets["img-001.png"] == _png()


# ── EPUB ─────────────────────────────────────────────────────────────────────


def _epub_rich() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("mimetype", "application/epub+zip")
        z.writestr(
            "META-INF/container.xml",
            '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
            '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>'
            "</rootfiles></container>",
        )
        z.writestr(
            "OEBPS/content.opf",
            '<package xmlns="http://www.idpf.org/2007/opf" version="3.0">'
            '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Rich Book</dc:title></metadata>'
            '<manifest><item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>'
            '<item id="plate" href="text/plate.xhtml" media-type="application/xhtml+xml"/>'
            '<item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>'
            '<item id="map" href="images/map.png" media-type="image/png"/></manifest>'
            '<spine><itemref idref="c1"/><itemref idref="plate"/><itemref idref="c2"/></spine></package>',
        )
        z.writestr(
            "OEBPS/text/ch1.xhtml",
            "<html><body><h1>One</h1><p>It was a dark\nnight.</p>"
            "<ul><li>Bread</li><li>Milk<ol><li>Whole</li><li>Skimmed</li></ol></li></ul>"
            "<blockquote><p>To be or not\nto be.</p></blockquote>"
            '<figure><img src="../images/map.png" alt="The map"/><figcaption>Map of the isle</figcaption></figure>'
            '<p>Ornament <img src="../images/map.png" width="20" height="10"/> here.</p>'
            "</body></html>",
        )
        z.writestr("OEBPS/text/plate.xhtml", '<html><body><img src="../images/map.png" alt="plate"/></body></html>')
        z.writestr("OEBPS/text/ch2.xhtml", "<html><body><h1>Two</h1><p>The end.</p></body></html>")
        z.writestr("OEBPS/images/map.png", _png())
    return buf.getvalue()


def test_epub_lists_quotes_and_images(monkeypatch):
    monkeypatch.setattr(ri, "GROUP_CHARS", 0)
    doc = ri.import_file("book.epub", _epub_rich())
    kinds = _kinds(doc)
    assert kinds[:2] == [("h", "One"), ("p", "It was a dark night.")]
    lists = [k for k in kinds if k[0] == "li"]
    assert [(k[1], k[3], k[4], k[5]) for k in lists] == [
        ("Bread", False, 1, 0), ("Milk", False, 2, 0), ("Whole", True, 1, 1), ("Skimmed", True, 2, 1),
    ]
    assert ("quote", "To be or not to be.") in kinds
    assert ("img", "img-001.png", "The map", "Map of the isle") in kinds
    # The decorative ornament is skipped; the image-only plate page is not a chapter.
    assert [k for k in kinds if k[0] == "img"] == [("img", "img-001.png", "The map", "Map of the isle")]
    assert [c["title"] for c in doc.chapters] == ["One", "Two"]
    assert ("p", "Ornament here.") in kinds
    assert doc.assets == {"img-001.png": _png()}


def test_audiobook_epub_script_is_unchanged_by_the_rich_hook():
    from services.longform_import import epub_to_chapter_script

    script = epub_to_chapter_script(_epub_rich())
    assert ri._RICH_MARK not in script and "Bread" in script


# ── Store + API ──────────────────────────────────────────────────────────────


@pytest.fixture
def client(tmp_path, monkeypatch):
    import core.config
    import core.db
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from api.routers import reader

    monkeypatch.setattr(core.config, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(core.db, "DB_PATH", str(tmp_path / "reader.db"))
    core.db.ensure_schema()
    app = FastAPI()
    app.include_router(reader.router)
    return TestClient(app)


def test_assets_are_stored_and_served(client, tmp_path):
    md = f"# Pics\n\nSome text.\n\n![box]({_data_uri(_png())})\n"
    summary = client.post("/reader/documents/text", json={"text": md}).json()
    doc = client.get(f"/reader/documents/{summary['id']}").json()
    image = next(s for s in doc["segments"] if s["kind"] == "img")
    assert image["src"] == f"/reader/documents/{summary['id']}/assets/img-001.png"
    assert image["text"] == "" and image["alt"] == "box"
    assert (image["w"], image["h"]) == (120, 80)  # the page reserves the space before loading
    resp = client.get(image["src"])
    assert resp.status_code == 200
    assert resp.content == _png()
    assert resp.headers["content-type"] == "image/png"
    assert "max-age" in resp.headers["cache-control"]
    assert resp.headers["x-content-type-options"] == "nosniff"
    # content.json keeps the bare asset name.
    assert (tmp_path / "reader" / summary["id"] / "assets" / "img-001.png").is_file()


@pytest.mark.parametrize(
    "name",
    ["..%2Fcontent.json", "..%5Ccontent.json", "content.json", "img-001.svg", ".img.png", "img-002.png", "a%00.png"],
)
def test_asset_route_refuses_anything_but_stored_images(client, tmp_path, name):
    summary = client.post("/reader/documents/text", json={"text": f"Text.\n\n![x]({_data_uri(_png())})"}).json()
    (tmp_path / "reader" / summary["id"] / "secret.png").write_bytes(_png())
    assert client.get(f"/reader/documents/{summary['id']}/assets/{name}").status_code == 404


def test_asset_route_unknown_document(client):
    assert client.get(f"/reader/documents/{'0' * 32}/assets/img-001.png").status_code == 404
    assert client.get("/reader/documents/not-an-id/assets/img-001.png").status_code == 404


def test_asset_path_rejects_traversal(tmp_path, monkeypatch):
    import core.config

    from services import reader_store

    monkeypatch.setattr(core.config, "DATA_DIR", str(tmp_path))
    doc_id = "a" * 32
    for name in ("../content.json", "..\\x.png", "sub/img.png", "/etc/x.png", "img.png/.."):
        assert reader_store.asset_path(doc_id, name) is None


def test_bookmark_export_quotes_image_descriptions(client):
    summary = client.post("/reader/documents/text", json={"text": f"Text.\n\n![A chart]({_data_uri(_png())})"}).json()
    doc = client.get(f"/reader/documents/{summary['id']}").json()
    index = next(s["i"] for s in doc["segments"] if s["kind"] == "img")
    client.post(f"/reader/documents/{summary['id']}/bookmarks", json={"segment": index})
    export = client.get(f"/reader/documents/{summary['id']}/bookmarks/export").text
    assert "> A chart" in export
