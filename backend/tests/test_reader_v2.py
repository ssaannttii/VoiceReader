"""Reader v2 contract (docs/reader/SPEC.md): library state, background
imports + scans, PDF chapters, engine status/warm-up, pronunciation and
bookmarks — with a fake synthesizer and a fake OCR engine (no models)."""
from __future__ import annotations

import asyncio
import io
import json
import threading
import time

import pytest
from fastapi.testclient import TestClient

from .test_reader_api import _create, _imported, env  # noqa: F401 — fixture

# ── Helpers ──────────────────────────────────────────────────────────────────


def _pdf(pages: list[list[str]]) -> bytes:
    """A minimal multi-page PDF with one Helvetica text line per entry."""
    n_pages = len(pages)
    font_id = 3
    page_ids = [4 + 2 * i for i in range(n_pages)]
    objs: dict[int, bytes] = {
        1: b"<< /Type /Catalog /Pages 2 0 R >>",
        2: b"<< /Type /Pages /Kids [" + b" ".join(f"{p} 0 R".encode() for p in page_ids)
        + f"] /Count {n_pages} >>".encode(),
        3: b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    }
    for index, lines in enumerate(pages):
        show = "BT /F1 11 Tf 72 740 Td 14 TL\n"
        for line in lines:
            esc = line.replace("\\", "\\\\").replace("(", r"\(").replace(")", r"\)")
            show += f"({esc}) Tj T*\n"
        content = (show + "ET").encode("cp1252")
        page_id = page_ids[index]
        objs[page_id] = (
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 {font_id} 0 R >> >>"
            f" /Contents {page_id + 1} 0 R >>"
        ).encode()
        objs[page_id + 1] = b"<< /Length " + str(len(content)).encode() + b" >>\nstream\n" + content + b"\nendstream"
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
        out.write(f"{offsets[number]:010d} 00000 n \n".encode())
    out.write(f"trailer\n<< /Size {size} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF".encode())
    return out.getvalue()


_PLACES = ("Sevilla", "Madrid", "Toledo", "Granada", "Burgos", "Cádiz")
_PEOPLE = ("Juan", "María", "Pedro", "Lucía", "Andrés", "Elena")


def _book_pages() -> list[list[str]]:
    pages = []
    for n in range(6):
        lines = ["EL CAMINO DEL VIENTO"]  # running header
        if n in (0, 3):
            lines += [f"Capítulo {1 if n == 0 else 2}", "La partida" if n == 0 else "El regreso"]
        place, person = _PLACES[n], _PEOPLE[n]
        lines += [
            f"La lluvia caía sobre {place} mientras {person} caminaba despacio por la calle",
            "mojada, pensando en todo lo que había perdido durante aquellos largos años de",
            f"guerra y de silencio. Nadie esperaba a {person} en casa y la noche era fría.",
        ]
        lines.append(str(n + 11))  # page number with an offset
        pages.append(lines)
    return pages


# ── Library state ────────────────────────────────────────────────────────────


def test_summary_has_v2_fields_and_patch_archived_completed(env):
    client = TestClient(env.app)
    doc = _create(client)
    assert {k: doc[k] for k in ("furthest_segment", "archived", "completed", "import_status",
                                "import_progress", "import_error")} == {
        "furthest_segment": 0, "archived": False, "completed": False, "import_status": "ready",
        "import_progress": None, "import_error": None,
    }
    patched = client.patch(f"/reader/documents/{doc['id']}", json={"archived": True, "completed": True}).json()
    assert patched["archived"] is True and patched["completed"] is True and patched["title"] == doc["title"]
    again = client.patch(f"/reader/documents/{doc['id']}", json={"completed": False}).json()
    assert again["completed"] is False and again["archived"] is True
    assert client.patch(f"/reader/documents/{doc['id']}", json={"archived": None}).status_code == 422


def test_progress_raises_furthest_and_completes_at_the_end(env):
    client = TestClient(env.app)
    doc = _create(client)  # 4 segments
    url = f"/reader/documents/{doc['id']}/progress"
    client.put(url, json={"segment": 2})
    client.put(url, json={"segment": 1})
    summary = client.get("/reader/documents").json()[0]
    assert summary["position_segment"] == 1 and summary["furthest_segment"] == 2
    assert summary["completed"] is False
    client.put(url, json={"segment": 3})  # the last segment
    summary = client.get("/reader/documents").json()[0]
    assert summary["completed"] is True and summary["furthest_segment"] == 3
    # Going back never lowers furthest nor clears completed; the user can.
    client.put(url, json={"segment": 0})
    summary = client.get("/reader/documents").json()[0]
    assert summary["furthest_segment"] == 3 and summary["completed"] is True
    assert client.patch(f"/reader/documents/{doc['id']}", json={"completed": False}).json()["completed"] is False


# ── Background imports ───────────────────────────────────────────────────────


@pytest.fixture
def gate(monkeypatch):
    """Hold background imports until ``gate.set()``."""
    from services import reader_import

    event = threading.Event()
    real = reader_import.import_file

    def held(*args, **kwargs):
        progress = kwargs.get("progress")
        if progress:
            progress(0.25)
        assert event.wait(10)
        return real(*args, **kwargs)

    monkeypatch.setattr(reader_import, "import_file", held)
    yield event
    event.set()


def _wait(predicate, timeout=10.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.02)
    raise AssertionError("condition not met")


def test_file_import_runs_in_background_and_409s_until_ready(env, gate):
    from services import reader_jobs

    client = TestClient(env.app)
    started = client.post(
        "/reader/documents/file", files={"file": ("my_notes.md", b"# Notes\n\nSome text to read aloud.", "text/markdown")}
    ).json()
    assert started["import_status"] == "importing" and started["title"] == "My notes"
    assert started["segment_count"] == 0
    doc_id = started["id"]
    listed = _wait(lambda: next(
        (d for d in client.get("/reader/documents").json() if d["id"] == doc_id and d["import_progress"] == 0.25), None
    ))
    assert listed["import_status"] == "importing"
    for method, url in (
        ("get", f"/reader/documents/{doc_id}"),
        ("post", f"/reader/documents/{doc_id}/segments/0/render"),
        ("post", f"/reader/documents/{doc_id}/prerender"),
        ("put", f"/reader/documents/{doc_id}/progress"),
        ("post", f"/reader/documents/{doc_id}/bookmarks"),
    ):
        body = {"segment": 0} if method in ("put", "post") and "render" not in url and "prerender" not in url else None
        resp = getattr(client, method)(url, json=body) if body is not None else getattr(client, method)(url)
        assert resp.status_code == 409 and resp.json() == {"detail": "importing"}, url
    gate.set()
    assert reader_jobs.wait_idle(10)
    full = client.get(f"/reader/documents/{doc_id}").json()
    assert full["import_status"] == "ready" and full["title"] == "Notes" and full["segments"]


def test_deleting_an_import_in_progress_discards_it(env, gate):
    from services import reader_jobs

    client = TestClient(env.app)
    doc_id = client.post(
        "/reader/documents/file", files={"file": ("a.txt", b"Some text to read aloud here.", "text/plain")}
    ).json()["id"]
    _wait(lambda: any(d["import_progress"] == 0.25 for d in client.get("/reader/documents").json()))
    assert client.delete(f"/reader/documents/{doc_id}").json() == {"ok": True}
    gate.set()
    assert reader_jobs.wait_idle(10)
    assert client.get("/reader/documents").json() == []
    assert not (env.data_dir / "reader" / doc_id).exists()


def test_pdf_import_reports_progress_and_detects_chapters(env, monkeypatch):
    from services import reader_store

    seen: list[float] = []
    real = reader_store.set_import_progress
    monkeypatch.setattr(reader_store, "set_import_progress", lambda d, f: (seen.append(f), real(d, f)))
    from services import reader_jobs

    monkeypatch.setattr(reader_jobs, "_PROGRESS_INTERVAL_S", 0.0)
    client = TestClient(env.app)
    doc = _imported(client, client.post(
        "/reader/documents/file", files={"file": ("libro.pdf", _pdf(_book_pages()), "application/pdf")}
    ).json())
    assert doc["import_status"] == "ready", doc
    assert seen == sorted(seen) and seen[-1] == 1.0 and len(seen) >= 6
    full = client.get(f"/reader/documents/{doc['id']}").json()
    assert [c["title"] for c in full["chapters"]] == ["Capítulo 1. La partida", "Capítulo 2. El regreso"]
    texts = " ".join(s["text"] for s in full["segments"])
    assert "EL CAMINO DEL VIENTO" not in texts and " 13" not in texts
    assert full["segments"][full["chapters"][1]["segment"]]["kind"] == "h"


def test_interrupted_imports_resume_or_fail_after_restart(env, monkeypatch):
    from services import reader_jobs, reader_store

    client = TestClient(env.app)
    # Rows a previous process left "importing": one with its upload, one without.
    kept = reader_store.create_pending(
        title="kept", source_type="file", files=[("kept.txt", b"Text that survives a restart.")],
        source_name="kept.txt", meta={"kind": "file"},
    )
    lost = reader_store.create_pending(
        title="lost", source_type="file", files=[("lost.txt", b"Gone.")], source_name="lost.txt", meta={"kind": "file"},
    )
    import shutil

    shutil.rmtree(env.data_dir / "reader" / lost["id"] / "source")
    monkeypatch.setitem(reader_jobs._resumed, "done", False)
    client.get("/reader/documents")  # first listing after start-up resumes them
    assert reader_jobs.wait_idle(10)
    docs = {d["id"]: d for d in client.get("/reader/documents").json()}
    assert docs[kept["id"]]["import_status"] == "ready" and docs[kept["id"]]["segment_count"] == 1
    assert docs[lost["id"]]["import_status"] == "error"
    assert "add the file again" in docs[lost["id"]]["import_error"]
    assert client.post(f"/reader/documents/{lost['id']}/retry").status_code == 409


def test_failed_import_can_be_retried(env, monkeypatch):
    from services import reader_import, reader_jobs

    client = TestClient(env.app)
    real = reader_import.import_file
    monkeypatch.setattr(reader_import, "import_file", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("disk hiccup")))
    failed = _imported(client, client.post(
        "/reader/documents/file", files={"file": ("a.txt", b"Retry me please, I am text.", "text/plain")}
    ).json())
    assert failed["import_status"] == "error" and "disk hiccup" in failed["import_error"]
    monkeypatch.setattr(reader_import, "import_file", real)
    again = client.post(f"/reader/documents/{failed['id']}/retry").json()
    assert again["import_status"] == "importing" and again["import_error"] is None
    assert reader_jobs.wait_idle(10)
    assert client.get(f"/reader/documents/{failed['id']}").json()["segments"][0]["text"] == "Retry me please, I am text."


# ── Scan ─────────────────────────────────────────────────────────────────────


class FakeOcr:
    def __init__(self, pages):
        self.pages = list(pages)

    def read(self, image):
        from services.reader_ocr import TextLine

        return [TextLine(text, x0, y0, x1, y1) for text, x0, y0, x1, y1 in self.pages.pop(0)]


def _png() -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (40, 30), (255, 255, 255)).save(buf, "PNG")
    return buf.getvalue()


def test_scan_imports_images_as_paragraphs_with_a_chapter_per_page(env, monkeypatch):
    from services import reader_ocr

    page1 = [  # out of order on purpose: reading order comes from geometry
        ("una sonrisa tímida.", 100, 160, 700, 190),
        ("El niño miró la canción que sonaba en la", 140, 100, 1300, 130),
        ("habitación. Nadie sabía qué pasó, dijo él con", 100, 130, 1300, 160),
        ("Capítulo 7", 500, 20, 800, 70),
        ("Al día siguiente volvió a la orilla del", 140, 190, 1300, 220),
        ("océano, más allá de la montaña.", 100, 220, 900, 250),
        ("127", 650, 400, 700, 430),
    ]
    page2 = [("Segunda página con más texto para escuchar.", 100, 100, 1300, 130)]
    monkeypatch.setattr(reader_ocr, "_engine", FakeOcr([page1, page2]))
    client = TestClient(env.app)
    started = client.post(
        "/reader/documents/scan",
        files=[("files", ("p1.png", _png(), "image/png")), ("files", ("p2.png", _png(), "image/png"))],
    ).json()
    assert started["title"] == "Scan (2 pages)" and started["source_type"] == "scan"
    doc = _imported(client, started)
    assert doc["import_status"] == "ready", doc
    full = client.get(f"/reader/documents/{doc['id']}").json()
    assert full["title"] == "Capítulo 7" and full["language"] == "es"
    page2 = next(s["i"] for s in full["segments"] if s["text"].startswith("Segunda página"))
    assert full["chapters"] == [{"title": "Página 1", "segment": 0}, {"title": "Página 2", "segment": page2}]
    paragraphs: dict[int, list[str]] = {}
    for seg in full["segments"]:
        paragraphs.setdefault(seg["para"], []).append(seg["text"])
    assert [" ".join(p) for p in paragraphs.values()] == [
        "Capítulo 7",
        "El niño miró la canción que sonaba en la habitación. Nadie sabía qué pasó, dijo él con una sonrisa tímida.",
        "Al día siguiente volvió a la orilla del océano, más allá de la montaña.",
        "Segunda página con más texto para escuchar.",
    ]
    assert full["segments"][0]["kind"] == "h"


def test_scan_without_ocr_runtime_fails_readably(env, monkeypatch):
    from services import reader_ocr

    def unavailable():
        raise reader_ocr.OcrUnavailable("the text-recognition model could not be downloaded")

    monkeypatch.setattr(reader_ocr, "_engine", None)
    monkeypatch.setattr(reader_ocr, "_engine_factory", unavailable)
    client = TestClient(env.app)
    doc = _imported(client, client.post(
        "/reader/documents/scan", files=[("files", ("p.png", _png(), "image/png"))], data={"title": "Mi página"}
    ).json())
    assert doc["import_status"] == "error" and "could not be downloaded" in doc["import_error"]
    assert doc["title"] == "Mi página"


def test_scan_validation(env):
    client = TestClient(env.app)
    assert client.post("/reader/documents/scan").status_code == 422
    many = [("files", (f"{i}.png", b"x", "image/png")) for i in range(51)]
    assert client.post("/reader/documents/scan", files=many).status_code == 400
    empty = client.post("/reader/documents/scan", files=[("files", ("e.png", b"", "image/png"))])
    assert empty.status_code == 400


def test_scan_of_an_unreadable_image_reports_the_page(env, monkeypatch):
    from services import reader_ocr

    monkeypatch.setattr(reader_ocr, "_engine", FakeOcr([]))
    client = TestClient(env.app)
    doc = _imported(client, client.post(
        "/reader/documents/scan", files=[("files", ("p.jpg", b"not an image", "image/jpeg"))]
    ).json())
    assert doc["import_status"] == "error" and doc["import_error"].startswith("page 1:")


# ── Engine status / warm-up ──────────────────────────────────────────────────


def test_status_reports_model_state_and_warmup_is_idempotent(env, monkeypatch):
    from services import model_lifecycle, reader_engine, tts_backend

    class FakeEngine:
        @classmethod
        def is_available(cls):
            return True, "ready"

    monkeypatch.setattr(tts_backend, "active_backend_id", lambda: "fake-engine")
    monkeypatch.setattr(tts_backend, "get_backend_class", lambda engine_id: FakeEngine)
    loaded: list[dict] = []
    monkeypatch.setattr(model_lifecycle, "list_loaded", lambda: {"models": list(loaded), "count": len(loaded)})
    calls = []
    release = asyncio.Event()

    async def fake_load(engine_id):
        calls.append(engine_id)
        await release.wait()
        loaded.append({"id": "engine:fake", "engine_id": engine_id})

    monkeypatch.setattr(reader_engine, "_load", fake_load)
    with TestClient(env.app) as client:
        assert client.get("/reader/status").json()["model_state"] == "unloaded"
        first = client.post("/reader/warmup").json()
        assert first == {"engine": "fake-engine", "model_state": "loading", "model_error": None}
        assert client.post("/reader/warmup").json()["model_state"] == "loading"
        assert client.get("/reader/status").json()["model_state"] == "loading"
        client.portal.call(release.set)
        _wait(lambda: client.get("/reader/status").json()["model_state"] == "ready")
        assert client.post("/reader/warmup").json()["model_state"] == "ready"
        assert calls == ["fake-engine"]

        # Unloaded again (idle) and a failing load.
        loaded.clear()

        async def failing(engine_id):
            raise RuntimeError("CUDA out of memory")

        monkeypatch.setattr(reader_engine, "_load", failing)
        client.post("/reader/warmup")
        status = _wait(lambda: (lambda s: s if s["model_state"] == "error" else None)(client.get("/reader/status").json()))
        assert "out of memory" in status["model_error"]


def test_warmup_never_downloads_an_engine_that_is_not_installed(env, monkeypatch):
    from services import model_lifecycle, reader_engine, tts_backend

    class Missing:
        @classmethod
        def is_available(cls):
            return False, "not installed"

    monkeypatch.setattr(tts_backend, "active_backend_id", lambda: "missing")
    monkeypatch.setattr(tts_backend, "get_backend_class", lambda engine_id: Missing)
    monkeypatch.setattr(model_lifecycle, "list_loaded", lambda: {"models": [], "count": 0})

    async def boom(engine_id):
        raise AssertionError("must not load")

    monkeypatch.setattr(reader_engine, "_load", boom)
    with TestClient(env.app) as client:
        assert client.post("/reader/warmup").json()["model_state"] == "unloaded"


# ── Pronunciation ────────────────────────────────────────────────────────────


def test_pronunciation_crud_is_scoped_by_language(env):
    client = TestClient(env.app)
    es = client.post("/reader/pronunciations", json={"term": "Sanderson", "replacement": "Sánderson", "language": "es"}).json()
    assert es == {"id": es["id"], "term": "Sanderson", "replacement": "Sánderson", "language": "es"}
    glob = client.post("/reader/pronunciations", json={"term": "GIF", "replacement": "jif", "language": None}).json()
    assert glob["language"] == "*"
    client.post("/reader/pronunciations", json={"term": "Kaladin", "replacement": "Káladin", "language": "en"})
    # Upsert: the same term in the same scope replaces the respelling.
    same = client.post("/reader/pronunciations", json={"term": "sanderson", "replacement": "Sanderson", "language": "Spanish"}).json()
    assert same["id"] == es["id"] and same["replacement"] == "Sanderson"
    terms = [e["term"] for e in client.get("/reader/pronunciations", params={"language": "es"}).json()]
    assert terms == ["GIF", "sanderson"]
    assert len(client.get("/reader/pronunciations").json()) == 3
    assert client.delete(f"/reader/pronunciations/{glob['id']}").json() == {"ok": True}
    assert client.delete(f"/reader/pronunciations/{glob['id']}").status_code == 404
    assert client.post("/reader/pronunciations", json={"term": "  ", "replacement": "x"}).status_code == 400


def test_new_entry_rerenders_only_segments_containing_the_term(env):
    client = TestClient(env.app)
    doc = _create(client, "Sanderson escribió este libro largo.\n\nOtra frase sin el nombre del autor.", language="es")
    url = f"/reader/documents/{doc['id']}/segments/{{}}/render"
    first = [client.post(url.format(i), json={}).json() for i in range(2)]
    assert len(env.calls) == 2
    client.post("/reader/pronunciations", json={"term": "Sanderson", "replacement": "Sánderson", "language": "es"})
    second = [client.post(url.format(i), json={}).json() for i in range(2)]
    assert second[0]["cached"] is False and second[1]["cached"] is True
    assert second[0]["render_key"] != first[0]["render_key"] and second[1]["render_key"] == first[1]["render_key"]
    assert env.calls[-1][0] == "Sánderson escribió este libro largo."
    # Word timings still index into the display text.
    text = "Sanderson escribió este libro largo."
    assert [w["w"] for w in second[0]["words"]] == text.split()
    # An entry for another language changes nothing.
    client.post("/reader/pronunciations", json={"term": "libro", "replacement": "book", "language": "en"})
    assert client.post(url.format(0), json={}).json()["cached"] is True
    assert len(env.calls) == 3


def test_pre_v2_cache_entries_stay_valid_when_the_dictionary_is_a_noop(env):
    from services import reader_render

    client = TestClient(env.app)
    text = "El 3 de mayo llegó tarde."
    doc = _create(client, text, language="es")
    # A cache entry as v1 wrote it: keyed by the display text, no synth_text.
    legacy = reader_render.render_key("fake-engine", None, "es", text)
    from .test_reader_api import SR, _speech_like

    reader_render.store_render(legacy, text, _speech_like(), SR, {"engine": "fake-engine", "voice": None, "language": "es"})
    path = env.data_dir / "reader" / "audio" / f"{legacy}.json"
    entry = json.loads(path.read_text(encoding="utf-8"))
    for key in ("synth_text", "span", "text"):
        entry.pop(key, None)
    path.write_text(json.dumps(entry), encoding="utf-8")

    hit = client.post(f"/reader/documents/{doc['id']}/segments/0/render", json={}).json()
    assert hit["cached"] is True and hit["render_key"] == legacy and env.calls == []
    assert client.get(f"/reader/documents/{doc['id']}/prerender").json()["done"] == 1
    # Once an entry changes the segment, the legacy render no longer applies.
    client.post("/reader/pronunciations", json={"term": "tarde", "replacement": "tárde", "language": "es"})
    miss = client.post(f"/reader/documents/{doc['id']}/segments/0/render", json={}).json()
    assert miss["cached"] is False and miss["render_key"] != legacy


def test_shared_final_text_gets_timings_for_each_display_text(env):
    from services import reader_render

    client = TestClient(env.app)
    client.post("/reader/pronunciations", json={"term": "Dr", "replacement": "Doctor", "language": "en"})
    a = _create(client, "Doctor Who arrives today at noon.", language="en")
    plain = reader_render.final_text("Doctor Who arrives today at noon.", "en", reader_render.pronunciation_lexicon("en"))
    ra = client.post(f"/reader/documents/{a['id']}/segments/0/render", json={}).json()
    calls = len(env.calls)
    b_text = "Dr Who arrives today at noon."
    if reader_render.final_text(b_text, "en", reader_render.pronunciation_lexicon("en")) != plain:
        pytest.skip("normalization differs for this phrasing")
    b = _create(client, b_text, language="en")
    rb = client.post(f"/reader/documents/{b['id']}/segments/0/render", json={}).json()
    assert rb["cached"] is True and rb["render_key"] == ra["render_key"] and len(env.calls) == calls
    assert [w["w"] for w in rb["words"]] == b_text.split()
    assert all(b_text[w["c0"]:w["c1"]] == w["w"] for w in rb["words"])


# ── Bookmarks ────────────────────────────────────────────────────────────────


def test_bookmarks_crud_export_and_delete_with_document(env):
    client = TestClient(env.app)
    doc = _create(client, "# Uno\n\nPrimera frase del libro aquí.\n\n# Dos\n\nSegunda frase del libro aquí.", language="es")
    base = f"/reader/documents/{doc['id']}/bookmarks"
    later = client.post(base, json={"segment": 3, "note": "  Me gusta  "}).json()
    first = client.post(base, json={"segment": 1, "word": 2}).json()
    assert later["note"] == "Me gusta" and first["word"] == 2 and first["note"] is None
    assert [m["id"] for m in client.get(base).json()] == [first["id"], later["id"]]
    assert client.post(base, json={"segment": 99}).status_code == 404
    assert client.post(base, json={"segment": -1}).status_code == 422

    patched = client.patch(f"/reader/bookmarks/{first['id']}", json={"note": "Ojo\ncon esto"}).json()
    assert patched["note"] == "Ojo\ncon esto"
    export = client.get(f"{base}/export")
    assert export.status_code == 200 and export.headers["content-type"].startswith("text/markdown")
    assert "attachment" in export.headers["content-disposition"]
    assert export.text == (
        "# Uno\n\n"
        "## Uno\n\n> Primera frase del libro aquí.\n\nOjo\ncon esto\n\n---\n\n"
        "## Dos\n\n> Segunda frase del libro aquí.\n\nMe gusta\n"
    )

    assert client.delete(f"/reader/bookmarks/{later['id']}").json() == {"ok": True}
    assert client.delete(f"/reader/bookmarks/{later['id']}").status_code == 404
    assert client.patch(f"/reader/bookmarks/{'0' * 32}", json={"note": "x"}).status_code == 404
    assert client.patch("/reader/bookmarks/bad-id", json={"note": "x"}).status_code == 404

    import core.db

    client.delete(f"/reader/documents/{doc['id']}")
    with core.db.db_conn() as conn:
        assert conn.execute("SELECT COUNT(*) FROM reader_bookmarks").fetchone()[0] == 0
    assert client.get(base).status_code == 404


def test_regrouping_old_content_remaps_furthest_and_bookmarks(env, monkeypatch):
    from services import reader_import

    client = TestClient(env.app)
    doc = _create(client)  # sentence-level (GROUP_CHARS=0 in this fixture)
    client.put(f"/reader/documents/{doc['id']}/progress", json={"segment": 3})
    client.put(f"/reader/documents/{doc['id']}/progress", json={"segment": 2})
    mark = client.post(f"/reader/documents/{doc['id']}/bookmarks", json={"segment": 2, "word": 1}).json()
    path = env.data_dir / "reader" / doc["id"] / "content.json"
    content = json.loads(path.read_text(encoding="utf-8"))
    content["version"] = 1
    path.write_text(json.dumps(content), encoding="utf-8")
    monkeypatch.setattr(reader_import, "GROUP_CHARS", 280)
    full = client.get(f"/reader/documents/{doc['id']}").json()
    assert full["position_segment"] == 1 and full["furthest_segment"] == 2
    moved = client.get(f"/reader/documents/{doc['id']}/bookmarks").json()[0]
    assert moved["id"] == mark["id"] and moved["segment"] == 1 and moved["word"] is None
