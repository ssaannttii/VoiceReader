"""Titles and authors of imported files: PDF metadata (Info + XMP), the first
page's largest heading, cleaned file names, junk filtering — and the same
filters on DOCX/EPUB metadata. PDFs are synthesized here (Helvetica text)."""
from __future__ import annotations

import importlib.util
import io
import json
import os
import sqlite3
import zipfile
from typing import Optional

import pytest

from services import reader_import as ri

from .test_reader_api import env  # noqa: F401 — fixture

_BODY = (
    "El viento soplaba con fuerza aquella mañana mientras todos esperaban noticias del norte.",
    "Nadie sabía cuándo terminaría la guerra ni quién volvería a casa antes del invierno.",
    "Las calles de la ciudad estaban vacías y solo se oía el rumor del río bajo el puente.",
)


def _pdf_string(text: str) -> bytes:
    return b"(" + text.replace("\\", "\\\\").replace("(", r"\(").replace(")", r"\)").encode("cp1252") + b")"


def _pdf(
    pages: list[list[tuple[float, str]]],
    *,
    info: Optional[dict[str, str]] = None,
    xmp: Optional[str] = None,
    scaled: bool = False,
) -> bytes:
    """A PDF with one Helvetica line per ``(font size, text)``; ``scaled`` sets the
    size through the text matrix (``1 Tf`` + ``Tm``) as many producers do."""
    page_ids = [10 + 2 * i for i in range(len(pages))]
    objs: dict[int, bytes] = {
        1: b"<< /Type /Catalog /Pages 2 0 R" + (b" /Metadata 5 0 R" if xmp else b"") + b" >>",
        2: b"<< /Type /Pages /Kids [" + b" ".join(f"{p} 0 R".encode() for p in page_ids)
        + f"] /Count {len(pages)} >>".encode(),
        3: b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    }
    if info:
        objs[4] = b"<< " + b" ".join(f"/{k} ".encode() + _pdf_string(v) for k, v in info.items()) + b" >>"
    if xmp:
        packet = xmp.encode("utf-8")
        objs[5] = b"<< /Type /Metadata /Subtype /XML /Length " + str(len(packet)).encode() + b" >>\nstream\n" \
            + packet + b"\nendstream"
    for index, lines in enumerate(pages):
        show, y = b"", 740.0
        for size, text in lines:
            if scaled:
                show += f"BT /F1 1 Tf {size} 0 0 {size} 72 {y} Tm ".encode() + _pdf_string(text) + b" Tj ET\n"
            else:
                show += f"BT /F1 {size} Tf 72 {y} Td ".encode() + _pdf_string(text) + b" Tj ET\n"
            y -= size * 1.4
        page_id = page_ids[index]
        objs[page_id] = (
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >>"
            f" /Contents {page_id + 1} 0 R >>"
        ).encode()
        objs[page_id + 1] = b"<< /Length " + str(len(show)).encode() + b" >>\nstream\n" + show + b"\nendstream"
    out = io.BytesIO()
    out.write(b"%PDF-1.4\n")
    offsets = {}
    for number in sorted(objs):
        offsets[number] = out.tell()
        out.write(f"{number} 0 obj\n".encode() + objs[number] + b"\nendobj\n")
    xref = out.tell()
    size = max(objs) + 1
    out.write(f"xref\n0 {size}\n".encode() + b"0000000000 65535 f \n")
    for number in range(1, size):
        out.write((f"{offsets[number]:010d} 00000 n \n" if number in offsets else "0000000000 65535 f \n").encode())
    trailer = f"trailer\n<< /Size {size} /Root 1 0 R" + (" /Info 4 0 R" if info else "") + " >>"
    out.write(f"{trailer}\nstartxref\n{xref}\n%%EOF".encode())
    return out.getvalue()


def _book(title_lines=((26, "NACIDOS DE LA BRUMA"), (14, "Brandon Sanderson")), **kwargs) -> bytes:
    first = list(title_lines)
    return _pdf([first, [(11, line) for line in _BODY]], **kwargs)


# ── File names ───────────────────────────────────────────────────────────────


@pytest.mark.parametrize(("name", "expected"), [
    ("9788466658898_Nacidos_bruma_v3 (1).pdf", "Nacidos bruma"),
    ("libro-final-OCR.pdf", "Libro final"),
    ("El nombre del viento.pdf", "El nombre del viento"),
    ("the.final.empire.epub", "The final empire"),
    ("EL_IMPERIO_FINAL.pdf", "El imperio final"),
    ("Informe trimestral - copia.docx", "Informe trimestral"),
    ("Copy of notes_2024-01-03.txt", "Notes 2024-01-03"),
    ("Mistborn (z-lib.org).pdf", "Mistborn"),
    ("3f2a9c1e7b4d5a6f8e9d0c1b2a3f4e5d_La_guerra.pdf", "La guerra"),
    ("ISBN 978-84-666-5889-8 Elantris.pdf", "Elantris"),
    ("Document1.docx", ""),
    ("scan0001.pdf", ""),
    ("9788466658898.pdf", ""),
    ("Mr. Smith goes", "Mr. Smith goes"),
])
def test_filename_title_cleans_machine_names(name, expected):
    assert ri.filename_title(name) == expected


@pytest.mark.parametrize("junk", [
    "", "untitled", "Untitled-1", "Sin título", "Microsoft Word - informe_final.docx", "Document1",
    "Presentación de PowerPoint", "9788466658898", "ISBN 978-84-666-5889-8", "C:\\Users\\ana\\libro.pdf",
    "/home/ana/libros/x", "Nacidos_bruma_v3", "libro-final-ocr", "DOC00123", "SKMBT_C22412", "Acrobat Distiller 9.0",
    "https://example.com/book", "x" * 250, "1234",
])
def test_junk_titles_are_rejected(junk):
    assert ri._title_junk(junk)


@pytest.mark.parametrize("good", ["Nacidos de la bruma", "It", "1984: edición conmemorativa", "AC/DC", "Spider-Man"])
def test_real_titles_pass(good):
    assert not ri._title_junk(good)


@pytest.mark.parametrize(("candidates", "expected"), [
    (["Usuario de Windows", "Brandon Sanderson"], "Brandon Sanderson"),
    (["jdoe", "admin", "HP_Owner", "ana@example.com"], None),
    (["BRANDON SANDERSON"], "Brandon Sanderson"),
    (["Microsoft Office User", None, "Ursula K. Le Guin"], "Ursula K. Le Guin"),
])
def test_author_picker(candidates, expected):
    assert ri.pick_author(candidates) == expected


def test_heading_wins_over_a_clean_file_name_only_when_they_agree():
    assert ri.pick_title([None], filename="Nacidos bruma.pdf", heading="Nacidos de la bruma") == "Nacidos de la bruma"
    # A clean name the user chose beats an unrelated heading (often the author or a publisher).
    assert ri.pick_title([], filename="Mi novela favorita.pdf", heading="Editorial Planeta") == "Mi novela favorita"
    # A messy name loses to any real heading; chapter-like headings never win.
    assert ri.pick_title([], filename="x_9788466658898_v2.pdf", heading="El pozo de la ascensión") == \
        "El pozo de la ascensión"
    assert ri.pick_title([], filename="presupuesto_v2.docx", heading="Introducción") == "Presupuesto"
    assert ri.pick_title([], filename="Document1.docx", heading="Capítulo 1") == ""


# ── PDF ──────────────────────────────────────────────────────────────────────


def test_pdf_title_and_author_come_from_metadata():
    data = _book(info={"Title": "Nacidos de la bruma", "Author": "Brandon Sanderson"})
    doc = ri.import_file("9788466658898_Nacidos_bruma_v3 (1).pdf", data)
    assert doc.title == "Nacidos de la bruma"
    assert doc.author == "Brandon Sanderson"


def test_junk_pdf_metadata_falls_back_to_the_first_page_heading():
    data = _book(info={"Title": "Microsoft Word - nacidos_v3.docx", "Author": "Usuario de Windows"})
    doc = ri.import_file("9788466658898_Nacidos_bruma_v3 (1).pdf", data)
    assert doc.title == "Nacidos de la bruma"  # all-caps heading, sentence-cased
    assert doc.author is None


def test_heading_size_through_the_text_matrix_is_measured():
    meta = ri.pdf_metadata(_book(scaled=True))
    assert meta["heading"] == "Nacidos de la bruma"


def test_heading_skips_the_author_and_image_only_cover_pages():
    cover_then_title = _pdf([
        [],  # an image-only cover: no text layer
        [(28, "Brandon Sanderson"), (20, "El imperio final"), *[(11, line) for line in _BODY]],
    ], info={"Author": "Brandon Sanderson"})
    meta = ri.pdf_metadata(cover_then_title)
    assert meta["author"] == "Brandon Sanderson"
    assert meta["heading"] == "El imperio final"  # the largest line is the author's name: one size down


def test_no_distinct_heading_falls_back_to_the_cleaned_file_name():
    data = _pdf([[(11, line) for line in _BODY]])
    assert ri.pdf_metadata(data)["heading"] is None
    assert ri.import_file("libro-final-OCR.pdf", data).title == "Libro final"


def test_chapter_heading_on_the_first_page_is_not_the_title():
    data = _pdf([[(20, "Capítulo 1"), *[(11, line) for line in _BODY]]])
    assert ri.import_file("libro_v2.pdf", data).title == "Libro"


def test_xmp_title_and_creator_are_read():
    xmp = (
        '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>'
        '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
        '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">'
        '<dc:title><rdf:Alt><rdf:li xml:lang="x-default">El Pozo de la Ascensión</rdf:li></rdf:Alt></dc:title>'
        "<dc:creator><rdf:Seq><rdf:li>Brandon Sanderson</rdf:li></rdf:Seq></dc:creator>"
        "</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end=\"w\"?>"
    )
    data = _book(info={"Title": "untitled", "Author": "admin"}, xmp=xmp)
    doc = ri.import_file("scan0001.pdf", data)
    assert doc.title == "El Pozo de la Ascensión"
    assert doc.author == "Brandon Sanderson"


def test_explicit_title_is_kept():
    data = _book(info={"Title": "Nacidos de la bruma"})
    assert ri.import_pdf(data, title="Mi copia", filename="x.pdf", source_type="file").title == "Mi copia"


def test_unreadable_metadata_never_breaks_the_import():
    assert ri.pdf_metadata(b"not a pdf") == {"titles": [], "author": None, "subject": None, "heading": None}


# ── DOCX / EPUB ──────────────────────────────────────────────────────────────


def _docx(core: str, body: str) -> bytes:
    w = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as zf:
        zf.writestr("word/document.xml", f"<w:document {w}><w:body>{body}</w:body></w:document>")
        zf.writestr(
            "docProps/core.xml",
            '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"'
            f' xmlns:dc="http://purl.org/dc/elements/1.1/">{core}</cp:coreProperties>',
        )
    return out.getvalue()


def _para(text: str, style: str = "") -> str:
    props = f'<w:pPr><w:pStyle w:val="{style}"/></w:pPr>' if style else ""
    return f"<w:p>{props}<w:r><w:t>{text}</w:t></w:r></w:p>"


def test_docx_junk_core_properties_are_ignored():
    data = _docx(
        "<dc:title>Document1</dc:title><dc:creator>Usuario de Windows</dc:creator>",
        _para("Plan de viaje a Lisboa", "Title") + _para("Saldremos el lunes temprano por la mañana."),
    )
    doc = ri.import_file("plan_viaje_v2.docx", data)
    assert doc.title == "Plan de viaje a Lisboa"
    assert doc.author is None
    good = _docx("<dc:title>Memoria anual</dc:title><dc:creator>Ana Pérez</dc:creator>", _para("Texto del cuerpo."))
    doc = ri.import_file("x.docx", good)
    assert (doc.title, doc.author) == ("Memoria anual", "Ana Pérez")


def test_epub_placeholder_metadata_falls_back_to_the_cleaned_name():
    from .test_reader_import import _epub

    meta = ri.epub_metadata(_epub())
    assert meta["title"]  # the fixture's real title is kept
    assert ri.import_file("x.epub", _epub()).title == ri._tidy_title(meta["title"])
    assert ri.pick_title(["Unknown"], filename="9788466658898_El_imperio_final.epub") == "El imperio final"
    assert ri.pick_author(["calibre"]) is None


# ── Background import keeps a rename made meanwhile ──────────────────────────


def test_rename_during_import_is_kept(env):
    from fastapi.testclient import TestClient

    from services import reader_jobs, reader_store

    client = TestClient(env.app)
    data = _book(info={"Title": "Nacidos de la bruma"})
    pending = reader_store.create_pending(
        title="Nacidos bruma", source_type="file", files=[("9788466658898_Nacidos_bruma.pdf", data)],
        source_name="9788466658898_Nacidos_bruma.pdf",
        meta={"kind": reader_jobs.KIND_FILE, "placeholder_title": "Nacidos bruma"},
    )
    reader_store.update_document(pending["id"], {"title": "Mi libro"})
    reader_jobs.run_import(pending["id"])
    assert reader_store.get_summary(pending["id"])["title"] == "Mi libro"

    resp = client.post("/reader/documents/file", files={"file": ("9788466658898_Nacidos_bruma.pdf", data)})
    assert resp.json()["title"] == "Nacidos bruma"  # the cleaned name while importing
    assert reader_jobs.wait_idle()
    done = reader_store.get_summary(resp.json()["id"])
    assert done["title"] == "Nacidos de la bruma"


# ── Re-title script (dry run by default) ─────────────────────────────────────


def _retitle_module():
    path = os.path.join(os.path.dirname(__file__), "..", "..", "scripts", "reader", "retitle-pdfs.py")
    spec = importlib.util.spec_from_file_location("retitle_pdfs", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _library(tmp_path, rows):
    data_dir = tmp_path / "data"
    (data_dir / "reader").mkdir(parents=True)
    with sqlite3.connect(data_dir / "omnivoice.db") as conn:
        conn.execute(
            "CREATE TABLE reader_documents (id TEXT PRIMARY KEY, title TEXT, author TEXT, source_type TEXT,"
            " source_name TEXT, import_status TEXT)"
        )
        for doc_id, title, source_name, segments in rows:
            conn.execute(
                "INSERT INTO reader_documents VALUES (?,?,NULL,'file',?,'ready')", (doc_id, title, source_name)
            )
            folder = data_dir / "reader" / doc_id
            folder.mkdir()
            (folder / "content.json").write_text(json.dumps({"segments": segments}), encoding="utf-8")
    return data_dir


def _titles(data_dir):
    with sqlite3.connect(data_dir / "omnivoice.db") as conn:
        return dict(conn.execute("SELECT id, title FROM reader_documents").fetchall())


def test_retitle_script_proposes_and_only_writes_when_asked(tmp_path, capsys):
    retitle = _retitle_module()
    ids = [c * 32 for c in "abcd"]
    data_dir = _library(tmp_path, [
        (ids[0], "9788466658898 Nacidos bruma v3 (1)", "9788466658898_Nacidos_bruma_v3 (1).pdf",
         [{"text": "NACIDOS DE LA BRUMA", "kind": "h"}, {"text": "Texto.", "kind": "p"}]),
        (ids[1], "Mi título", "9788466658898_Nacidos_bruma_v3 (1).pdf", [{"text": "Texto.", "kind": "p"}]),
        (ids[2], "libro-final-OCR", "libro-final-OCR.pdf", [{"text": "Capítulo 1", "kind": "h"}]),
        (ids[3], "El nombre del viento", "El nombre del viento.pdf", [{"text": "Texto.", "kind": "p"}]),
    ])
    before = _titles(data_dir)
    proposals = retitle.main(["--data-dir", str(data_dir)])
    assert {p["id"]: p["new"] for p in proposals} == {ids[0]: "Nacidos de la bruma", ids[2]: "Libro final"}
    assert _titles(data_dir) == before  # dry run
    assert "dry run" in capsys.readouterr().out

    # With the original PDF at hand, its metadata is used.
    pdf_dir = tmp_path / "pdfs"
    pdf_dir.mkdir()
    (pdf_dir / "libro-final-OCR.pdf").write_bytes(_book(info={"Title": "El libro definitivo", "Author": "Ana Pérez"}))
    proposals = retitle.main(["--data-dir", str(data_dir), "--pdf-dir", str(pdf_dir), "--write"])
    assert {p["id"]: p["new"] for p in proposals}[ids[2]] == "El libro definitivo"
    after = _titles(data_dir)
    assert after[ids[0]] == "Nacidos de la bruma" and after[ids[2]] == "El libro definitivo"
    assert after[ids[1]] == "Mi título" and after[ids[3]] == "El nombre del viento"
    with sqlite3.connect(data_dir / "omnivoice.db") as conn:
        assert conn.execute("SELECT author FROM reader_documents WHERE id=?", (ids[2],)).fetchone()[0] == "Ana Pérez"
