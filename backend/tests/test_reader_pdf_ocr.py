"""Reader import heuristics: PDF chapter detection (on extracted page texts)
and the OCR post-processing (components, deskew angle, reading order →
paragraphs). The real OCR models run only when already in the local cache."""
from __future__ import annotations

import io
import os

import numpy as np
import pytest

from services import reader_import, reader_ocr
from services.reader_import import Block, pdf_blocks, segment_blocks


@pytest.fixture(autouse=True)
def _sentence_segments(monkeypatch):
    monkeypatch.setattr(reader_import, "GROUP_CHARS", 0)


def _prose(n: int, words=("viento", "mar", "fuego", "piedra", "río", "sombra", "luz", "noche")) -> list[str]:
    w = words[n % len(words)]
    return [
        f"El {w} soplaba con fuerza aquella mañana mientras todos esperaban noticias del",
        f"norte, donde la guerra seguía sin tregua y nadie sabía cuándo terminaría el {w}.",
    ]


def _chapters(blocks):
    _segments, chapters = segment_blocks(blocks, "es")
    return [c["title"] for c in chapters]


def test_spanish_and_english_headings_become_chapters():
    pages = [
        ["Prólogo", *_prose(0)],
        ["Capítulo 1", "El comienzo", *_prose(1)],
        [*_prose(2), "Capítulo II: La huida", *_prose(3)],
        ["Parte tres", *_prose(4)],
        ["Chapter Seven", *_prose(5)],
        ["Epílogo", *_prose(6)],
    ]
    blocks = pdf_blocks([("\n".join(p)) for p in pages], "es")
    assert _chapters(blocks) == [
        "Prólogo", "Capítulo 1. El comienzo", "Capítulo II: La huida", "Parte tres", "Chapter Seven", "Epílogo",
    ]
    assert all(b.level == 1 for b in blocks if b.kind == "h")


def test_heading_words_inside_prose_are_not_chapters():
    pages = [[
        "Llevaba toda la tarde leyendo y al final de la página encontró la",
        "Parte de la historia que más le gustaba, la del viaje al sur, con",
        "Capítulo tras capítulo de aventuras sin descanso para nadie allí.",
        *_prose(1),
    ]]
    assert _chapters(pdf_blocks(["\n".join(p) for p in pages], "es")) == []


def test_bare_numbers_in_sequence_and_caps_lines_are_headings():
    pages = [
        ["1", *_prose(0)],
        [*_prose(1), "2", "La tormenta", *_prose(2)],
        ["LA CIUDAD PERDIDA", *_prose(3)],
        ["7", *_prose(4)],  # out of sequence: not a chapter number
    ]
    titles = _chapters(pdf_blocks(["\n".join(p) for p in pages], "es"))
    assert titles == ["1", "2. La tormenta", "LA CIUDAD PERDIDA"]


def test_page_numbers_and_running_headers_are_dropped():
    pages = [["MI LIBRO", *_prose(i), str(i + 5)] for i in range(8)]
    blocks = pdf_blocks(["\n".join(p) for p in pages], "es")
    text = " ".join(b.text for b in blocks)
    assert "MI LIBRO" not in text and not any(b.kind == "h" for b in blocks)
    assert not any(b.text.strip().isdigit() for b in blocks)


def test_long_pdf_without_headings_gets_ten_page_chapters():
    pages = ["\n".join(_prose(i)) for i in range(23)]
    blocks = pdf_blocks(pages, "es")
    assert _chapters(blocks) == ["Páginas 1–10", "Páginas 11–20", "Páginas 21–23"]
    assert not any(b.kind == "h" for b in blocks)
    english = pdf_blocks(pages, "en")
    assert _chapters(english)[0] == "Pages 1–10"
    # A blank page range does not produce an empty chapter.
    pages[10:20] = [""] * 10
    assert _chapters(pdf_blocks(pages, "es")) == ["Páginas 1–10", "Páginas 21–23"]


def test_paragraphs_flow_across_page_breaks():
    first = _prose(0)
    pages = ["\n".join(first[:1]), "\n".join(first[1:])]
    blocks = pdf_blocks(pages, "es")
    assert len(blocks) == 1 and blocks[0].text.startswith("El viento") and blocks[0].text.endswith("viento.")


def test_chapter_markers_replace_heading_chapters():
    blocks = [
        Block("h", "Título", level=1, chapter="Página 1"),
        Block("p", "Una frase del cuerpo para leer."),
        Block("p", "Otra frase más en la página siguiente.", chapter="Página 2"),
    ]
    segments, chapters = segment_blocks(blocks, "es")
    assert chapters == [{"title": "Página 1", "segment": 0}, {"title": "Página 2", "segment": 2}]


def test_image_only_pdf_is_refused_readably():
    from .test_reader_v2 import _pdf

    with pytest.raises(reader_import.ReaderImportError, match="no text layer"):
        reader_import.import_file("scan.pdf", _pdf([[], []]))


# ── OCR post-processing ──────────────────────────────────────────────────────


def test_components_are_eight_connected():
    mask = np.zeros((6, 10), dtype=bool)
    mask[1, 1:4] = True
    mask[2, 4:6] = True  # touches the first run at a corner
    mask[4, 8] = True
    comps = sorted(reader_ocr._components(mask), key=lambda c: c[0])
    assert [(x0, y0, x1, y1) for x0, y0, x1, y1, _runs in comps] == [(1, 1, 6, 3), (8, 4, 9, 5)]


def test_band_angle_measures_tilt():
    runs = [(int(round(x * 0.05)) + 10, x, x + 4) for x in range(0, 400, 4)]  # falls 0.05 px per px
    angle = reader_ocr._band_angle([(r, s, e) for r, s, e in runs], 1.0, 1.0)
    assert angle == pytest.approx(np.degrees(np.arctan(0.05)), abs=0.3)


def _line(text, x0, y0, x1, y1):
    return reader_ocr.TextLine(text, x0, y0, x1, y1)


def test_reading_order_merges_split_rows_and_dehyphenates():
    lines = [
        _line("segunda parte", 700, 52, 1200, 80),
        _line("Una línea partida en dos", 100, 50, 650, 80),
        _line("y una pala-", 100, 90, 1200, 120),
        _line("bra cortada al final.", 100, 130, 600, 160),
    ]
    rows = reader_ocr.reading_order(lines)
    assert [r.text for r in rows] == ["Una línea partida en dos segunda parte", "y una pala-", "bra cortada al final."]
    assert reader_ocr.page_blocks(lines) == [
        ("p", "Una línea partida en dos segunda parte y una palabra cortada al final.")
    ]


def test_vertical_gap_starts_a_paragraph():
    lines = [
        _line("Primer párrafo que ocupa toda la línea de", 100, 100, 1200, 130),
        _line("texto hasta el margen derecho del papel", 100, 140, 1200, 170),
        _line("Segundo párrafo tras un espacio en blanco", 100, 240, 1200, 270),
    ]
    assert [t for _k, t in reader_ocr.page_blocks(lines)] == [
        "Primer párrafo que ocupa toda la línea de texto hasta el margen derecho del papel",
        "Segundo párrafo tras un espacio en blanco",
    ]


def _models_cached() -> bool:
    try:
        from huggingface_hub import hf_hub_download

        for name in (reader_ocr.DET_FILE, reader_ocr.REC_FILE, reader_ocr.DICT_FILE):
            hf_hub_download(reader_ocr.OCR_REPO, name, revision=reader_ocr.OCR_REVISION, local_files_only=True)
        import onnxruntime  # noqa: F401
    except Exception:  # noqa: BLE001
        return False
    return True


@pytest.mark.skipif(not _models_cached(), reason="OCR models not in the local Hugging Face cache")
@pytest.mark.parametrize("tilt", [0.0, 2.5])
def test_real_ocr_reads_spanish_accents(tilt):
    from PIL import Image, ImageDraw, ImageFont

    candidates = [r"C:\Windows\Fonts\georgia.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf",
                  "/System/Library/Fonts/Supplemental/Georgia.ttf"]
    font_path = next((p for p in candidates if os.path.exists(p)), None)
    if font_path is None:
        pytest.skip("no TrueType font")
    font = ImageFont.truetype(font_path, 34)
    img = Image.new("RGB", (1400, 600), (246, 240, 228))
    draw = ImageDraw.Draw(img)
    for i, line in enumerate(["El niño miró la canción de la", "habitación con una sonrisa tímida."]):
        draw.text((100, 150 + 52 * i), line, font=font, fill=(25, 25, 25))
    img = img.rotate(tilt, fillcolor=(246, 240, 228))
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=85)
    reader_ocr.set_engine(None)
    try:
        blocks = reader_ocr.ocr_page(buf.getvalue())
    finally:
        reader_ocr.set_engine(None)
    assert blocks == [("p", "El niño miró la canción de la habitación con una sonrisa tímida.")]
