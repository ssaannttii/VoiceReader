"""Reader API: library CRUD + progress, render (cache, coalescing), prerender,
audio serving, voices and status — with a fake synthesizer (no model)."""
from __future__ import annotations

import asyncio
import io
import os
import time
import zipfile
from types import SimpleNamespace

import numpy as np
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

SR = 16000


def _speech_like(seconds: float = 1.0) -> np.ndarray:
    t = np.arange(int(seconds * SR)) / SR
    tone = (0.4 * np.sin(2 * np.pi * 200 * t)).astype(np.float32)
    pad = np.zeros(int(0.2 * SR), dtype=np.float32)
    return np.concatenate([pad, tone, pad])


@pytest.fixture
def env(tmp_path, monkeypatch):
    import core.config
    import core.db
    from api.routers import reader
    from services import reader_render

    monkeypatch.setattr(core.config, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(core.db, "DB_PATH", str(tmp_path / "reader.db"))
    core.db.ensure_schema()
    monkeypatch.setattr(reader_render, "_inflight", {})
    monkeypatch.setattr(reader_render, "_jobs", {})
    monkeypatch.setattr(reader_render, "_interactive", {"active": 0})
    monkeypatch.setattr(reader_render, "ffmpeg_path", lambda: None)
    monkeypatch.setattr(reader_render, "resolve_engine_id", lambda engine: engine or "fake-engine")

    state = SimpleNamespace(calls=[], delay=0.05, fail=None)

    async def fake_synthesize(text, *, voice, engine, language):
        state.calls.append((text, voice, engine, language))
        await asyncio.sleep(state.delay)
        if state.fail:
            raise state.fail
        return _speech_like(), SR

    monkeypatch.setattr(reader_render, "synthesize_segment", fake_synthesize)
    app = FastAPI()
    app.include_router(reader.router)
    state.app = app
    state.data_dir = tmp_path
    return state


def _create(client, text=None, **extra):
    text = text or "# A Title\n\nThe first sentence is here. The second sentence is here.\n\nAnother paragraph to read."
    resp = client.post("/reader/documents/text", json={"text": text, **extra})
    assert resp.status_code == 200, resp.text
    return resp.json()


# ── Library ──────────────────────────────────────────────────────────────────


def test_create_open_patch_progress_delete(env):
    client = TestClient(env.app)
    doc = _create(client)
    assert doc["title"] == "A Title"
    assert doc["source_type"] == "text"
    assert doc["segment_count"] == 4 and doc["chapter_count"] == 1
    assert doc["progress"] == 0.0 and doc["last_opened_at"] is None
    assert doc["est_duration_s"] == pytest.approx(doc["char_count"] / 15.0, abs=0.1)
    assert doc["has_cover"] is False and doc["language"] == "en"

    full = client.get(f"/reader/documents/{doc['id']}").json()
    assert full["last_opened_at"] is not None
    assert full["chapters"] == [{"title": "A Title", "segment": 0}]
    assert [s["text"] for s in full["segments"]] == [
        "A Title", "The first sentence is here.", "The second sentence is here.", "Another paragraph to read.",
    ]

    patched = client.patch(f"/reader/documents/{doc['id']}", json={"title": "Renamed", "voice_id": "v1"}).json()
    assert patched["title"] == "Renamed" and patched["voice_id"] == "v1" and patched["engine"] is None
    cleared = client.patch(f"/reader/documents/{doc['id']}", json={"voice_id": None}).json()
    assert cleared["voice_id"] is None and cleared["title"] == "Renamed"
    assert client.patch(f"/reader/documents/{doc['id']}", json={"title": "  "}).status_code == 400

    assert client.put(f"/reader/documents/{doc['id']}/progress", json={"segment": 2}).json() == {"ok": True}
    summary = client.get("/reader/documents").json()[0]
    assert summary["position_segment"] == 2 and summary["progress"] == 0.5
    client.put(f"/reader/documents/{doc['id']}/progress", json={"segment": 99})
    assert client.get("/reader/documents").json()[0]["position_segment"] == 4

    assert client.delete(f"/reader/documents/{doc['id']}").json() == {"ok": True}
    assert client.get(f"/reader/documents/{doc['id']}").status_code == 404
    assert not os.path.exists(env.data_dir / "reader" / doc["id"])
    assert client.get("/reader/documents").json() == []


def test_list_orders_by_last_opened_then_created(env):
    client = TestClient(env.app)
    first = _create(client, "First document text here.")
    time.sleep(0.01)
    second = _create(client, "Second document text here.")
    assert [d["id"] for d in client.get("/reader/documents").json()] == [second["id"], first["id"]]
    client.get(f"/reader/documents/{first['id']}")
    assert [d["id"] for d in client.get("/reader/documents").json()] == [first["id"], second["id"]]


def test_unknown_document_is_404(env):
    client = TestClient(env.app)
    missing = "0" * 32
    assert client.get(f"/reader/documents/{missing}").status_code == 404
    assert client.get("/reader/documents/../../etc").status_code == 404
    assert client.patch(f"/reader/documents/{missing}", json={"title": "x"}).status_code == 404
    assert client.put(f"/reader/documents/{missing}/progress", json={"segment": 1}).status_code == 404
    assert client.delete(f"/reader/documents/{missing}").status_code == 404
    assert client.post(f"/reader/documents/{missing}/segments/0/render", json={}).status_code == 404


def test_file_upload_and_epub_cover(env):
    from .test_reader_import import _epub

    client = TestClient(env.app)
    md = client.post(
        "/reader/documents/file",
        files={"file": ("notes.md", b"# Notes\n\nSome body text to read aloud.", "text/markdown")},
    ).json()
    assert md["title"] == "Notes" and md["source_name"] == "notes.md"
    assert client.get(f"/reader/documents/{md['id']}/cover").status_code == 404

    book = client.post(
        "/reader/documents/file",
        files={"file": ("book.epub", _epub(), "application/epub+zip")},
        data={"language": "EN"},
    ).json()
    assert book["has_cover"] is True and book["author"] == "A. Author"
    assert book["language"] == "en" and book["chapter_count"] == 2
    cover = client.get(f"/reader/documents/{book['id']}/cover")
    assert cover.status_code == 200 and cover.headers["content-type"] == "image/jpeg"
    assert cover.content.startswith(b"\xff\xd8")


def test_bad_imports_are_400(env):
    client = TestClient(env.app)
    assert client.post("/reader/documents/text", json={"text": "  "}).status_code == 400
    assert client.post("/reader/documents/url", json={"url": "ftp://example.com/x"}).status_code == 400
    bad = client.post("/reader/documents/file", files={"file": ("x.docx", b"nope", "application/octet-stream")})
    assert bad.status_code == 400 and bad.json()["detail"]


# ── Render ───────────────────────────────────────────────────────────────────


def test_render_caches_and_serves_audio_with_range(env):
    client = TestClient(env.app)
    doc = _create(client)
    first = client.post(f"/reader/documents/{doc['id']}/segments/1/render", json={}).json()
    assert first["segment"] == 1 and first["cached"] is False
    assert first["audio_url"] == f"/reader/audio/{first['render_key']}"
    assert first["duration_s"] == pytest.approx(1.4, abs=0.01)
    text = "The first sentence is here."
    assert [w["w"] for w in first["words"]] == text.split()
    assert all(text[w["c0"]:w["c1"]] == w["w"] for w in first["words"])
    assert first["words"][0]["start"] == pytest.approx(0.2, abs=0.06)

    again = client.post(f"/reader/documents/{doc['id']}/segments/1/render").json()
    assert again["cached"] is True
    assert {k: v for k, v in again.items() if k != "cached"} == {k: v for k, v in first.items() if k != "cached"}
    assert len(env.calls) == 1
    assert env.calls[0] == (text, None, "fake-engine", "en")

    audio = client.get(first["audio_url"])
    assert audio.status_code == 200
    assert audio.headers["content-type"] == "audio/wav"
    assert audio.headers["cache-control"] == "public, max-age=31536000, immutable"
    assert audio.content[:4] == b"RIFF"
    ranged = client.get(first["audio_url"], headers={"Range": "bytes=0-99"})
    assert ranged.status_code == 206 and len(ranged.content) == 100

    assert client.get("/reader/audio/" + "f" * 40).status_code == 404
    assert client.get("/reader/audio/not-a-key").status_code == 404
    assert client.post(f"/reader/documents/{doc['id']}/segments/9/render").status_code == 404


def test_render_key_depends_on_voice_engine_language_and_is_shared_across_docs(env):
    client = TestClient(env.app)
    a = _create(client, "Shared sentence for both documents.")
    b = _create(client, "Shared sentence for both documents.")
    ra = client.post(f"/reader/documents/{a['id']}/segments/0/render").json()
    rb = client.post(f"/reader/documents/{b['id']}/segments/0/render").json()
    assert ra["render_key"] == rb["render_key"] and rb["cached"] is True
    rv = client.post(f"/reader/documents/{a['id']}/segments/0/render", json={"voice": "v2", "engine": "other"}).json()
    assert rv["render_key"] != ra["render_key"]
    assert env.calls[-1][1:] == ("v2", "other", a["language"])
    # The chosen voice/engine are remembered on the document.
    summary = client.get("/reader/documents").json()
    remembered = next(d for d in summary if d["id"] == a["id"])
    assert remembered["voice_id"] == "v2" and remembered["engine"] == "other"
    follow = client.post(f"/reader/documents/{a['id']}/segments/0/render").json()
    assert follow["render_key"] == rv["render_key"] and follow["cached"] is True


def test_concurrent_identical_renders_synthesize_once(env):
    from services import reader_render

    env.delay = 0.2

    async def run():
        return await asyncio.gather(*[
            reader_render.render_segment("Coalesce me please.", voice="v", engine=None, language="en")
            for _ in range(4)
        ])

    results = asyncio.run(run())
    assert len(env.calls) == 1
    assert len({r["render_key"] for r in results}) == 1
    assert all(r["cached"] is False for r in results)
    assert not reader_render._inflight


def test_render_failure_is_reported_and_not_cached(env):
    from api.routers.tts_stream import StreamUnavailableError

    client = TestClient(env.app)
    doc = _create(client, "This will fail to render.")
    env.fail = StreamUnavailableError("engine cannot run on this host")
    resp = client.post(f"/reader/documents/{doc['id']}/segments/0/render")
    assert resp.status_code == 503 and "cannot run" in resp.json()["detail"]
    env.fail = None
    ok = client.post(f"/reader/documents/{doc['id']}/segments/0/render").json()
    assert ok["cached"] is False


def test_unspeakable_segment_renders_silence_without_engine(monkeypatch):
    from services import reader_render

    monkeypatch.setattr(
        "services.text_normalization.normalize_for_tts", lambda text, language=None: text
    )
    samples, sr = asyncio.run(reader_render.synthesize_segment("* * *", voice=None, engine=None, language="en"))
    assert sr == reader_render.SILENCE_SR and not np.any(samples)


def test_mp3_encoding_when_ffmpeg_present(env, monkeypatch):
    from services import reader_render
    from services.ffmpeg_utils import find_ffmpeg

    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        pytest.skip("ffmpeg not available")
    monkeypatch.setattr(reader_render, "ffmpeg_path", lambda: ffmpeg)
    result = reader_render.store_render("a" * 40, "Hello world.", _speech_like(), SR, {})
    assert result["duration_s"] == pytest.approx(1.4, abs=0.01)
    path, media_type = reader_render.audio_file("a" * 40)
    assert path.endswith(".mp3") and media_type == "audio/mpeg"


# ── Prerender ────────────────────────────────────────────────────────────────


def _wait_idle(client, doc_id, timeout=10.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        status = client.get(f"/reader/documents/{doc_id}/prerender").json()
        if not status["running"]:
            return status
        time.sleep(0.02)
    raise AssertionError("prerender did not finish")


def test_prerender_renders_every_segment_once(env):
    env.delay = 0.01
    with TestClient(env.app) as client:
        doc = _create(client)
        idle = client.get(f"/reader/documents/{doc['id']}/prerender").json()
        assert idle == {"running": False, "done": 0, "total": 4, "error": None, "voice": None, "engine": "fake-engine"}
        started = client.post(f"/reader/documents/{doc['id']}/prerender", json={"from_segment": 2}).json()
        assert started["running"] is True and started["total"] == 4
        status = _wait_idle(client, doc["id"])
        assert status["done"] == 4 and status["error"] is None
        # from_segment first, then wrap around.
        assert [c[0] for c in env.calls][:2] == ["The second sentence is here.", "Another paragraph to read."]
        assert len(env.calls) == 4
        # Everything is cached now: rendering is a hit, a new prerender is instant.
        assert client.post(f"/reader/documents/{doc['id']}/segments/0/render").json()["cached"] is True
        client.post(f"/reader/documents/{doc['id']}/prerender", json={})
        assert _wait_idle(client, doc["id"])["done"] == 4
        assert len(env.calls) == 4


def test_prerender_cancel_and_error(env):
    env.delay = 0.3
    with TestClient(env.app) as client:
        doc = _create(client)
        client.post(f"/reader/documents/{doc['id']}/prerender", json={})
        cancelled = client.delete(f"/reader/documents/{doc['id']}/prerender").json()
        assert cancelled["running"] is False and cancelled["done"] < cancelled["total"]

        env.delay = 0.01
        env.fail = RuntimeError("boom")
        client.post(f"/reader/documents/{doc['id']}/prerender", json={"voice": "x"})
        failed = _wait_idle(client, doc["id"])
        assert failed["error"] == "boom" and failed["voice"] == "x"


# ── Voices / status ──────────────────────────────────────────────────────────


def test_voices_lists_profiles_then_presets(env, monkeypatch):
    import core.db
    from services import tts_backend

    with core.db.db_conn() as conn:
        conn.execute(
            "INSERT INTO voice_profiles (id, name, language, description, created_at) VALUES (?,?,?,?,?)",
            ("p1", "Narrator", "Auto", "Warm voice", 1.0),
        )

    class FakeEngine:
        PRESET_VOICES = ["alpha", "beta"]
        DEFAULT_VOICE = "beta"

    monkeypatch.setattr(tts_backend, "active_backend_id", lambda: "fake-engine")
    monkeypatch.setattr(tts_backend, "get_backend_class", lambda engine_id: FakeEngine)
    voices = TestClient(env.app).get("/reader/voices").json()
    assert voices[0] == {
        "id": "p1", "name": "Narrator", "kind": "profile", "engine": None,
        "language": None, "description": "Warm voice",
    }
    assert [(v["id"], v["kind"], v["engine"]) for v in voices[1:]] == [
        ("alpha", "preset", "fake-engine"), ("beta", "preset", "fake-engine"),
    ]


def test_status_reports_engine_format_and_lan_url(env, monkeypatch):
    from services import network_share, reader_render, tts_backend

    class FakeEngine:
        @classmethod
        def is_available(cls):
            return True, "ready"

    monkeypatch.setattr(tts_backend, "active_backend_id", lambda: "fake-engine")
    monkeypatch.setattr(tts_backend, "get_backend_class", lambda engine_id: FakeEngine)
    client = TestClient(env.app)
    monkeypatch.setattr(network_share, "get_state", lambda: network_share.ShareState())
    assert client.get("/reader/status").json() == {
        "engine": "fake-engine", "engine_ready": True, "audio_format": "wav", "lan_url": None,
    }
    monkeypatch.setattr(reader_render, "ffmpeg_path", lambda: "/usr/bin/ffmpeg")
    monkeypatch.setattr(
        network_share,
        "get_state",
        lambda: network_share.ShareState(enabled=True, share_port=3901, pin="123456", lan_addresses=["192.168.1.5"]),
    )
    status = client.get("/reader/status").json()
    assert status["audio_format"] == "mp3"
    assert status["lan_url"] == "http://192.168.1.5:3901"


# ── Registration ─────────────────────────────────────────────────────────────


def test_router_is_registered_in_main():
    import pathlib
    import re

    src = (pathlib.Path(__file__).resolve().parents[1] / "main.py").read_text(encoding="utf-8")
    block = src[src.index("_router_modules.extend(["):]
    block = block[: block.index("])")]
    assert re.search(r"\breader\b", block)


# ── Default voice ────────────────────────────────────────────────────────────


def _add_profile(pid, language, personality="", created=0.0):
    from core.db import db_conn

    with db_conn() as conn:
        conn.execute(
            "INSERT INTO voice_profiles (id, name, language, personality, created_at) VALUES (?, ?, ?, ?, ?)",
            (pid, pid, language, personality, created),
        )
        conn.commit()


def test_render_without_voice_pins_a_profile_in_the_document_language(env):
    _add_profile("demo", "English", created=1)
    _add_profile("es-any", "Spanish", created=2)
    _add_profile("es-reader", "Spanish", personality="Reader", created=3)
    client = TestClient(env.app)
    doc = _create(client, "Hola. Esta es una frase en español para leer en voz alta.", language="es")

    assert client.post(f"/reader/documents/{doc['id']}/segments/0/render", json={}).status_code == 200
    assert env.calls[-1][1] == "es-reader"
    # The pick is stored, so later renders keep the same voice.
    assert client.get(f"/reader/documents/{doc['id']}").json()["voice_id"] == "es-reader"


def test_render_without_profiles_falls_back_to_engine_default(env):
    client = TestClient(env.app)
    doc = _create(client)
    assert client.post(f"/reader/documents/{doc['id']}/segments/0/render", json={}).status_code == 200
    assert env.calls[-1][1] is None


def test_configured_share_pin(monkeypatch):
    from services import network_share

    monkeypatch.setenv("OMNIVOICE_SHARE_PIN", " 48151623 ")
    assert network_share.configured_pin() == "48151623"
    monkeypatch.setenv("OMNIVOICE_SHARE_PIN", "123")
    assert network_share.configured_pin() is None
    monkeypatch.delenv("OMNIVOICE_SHARE_PIN")
    assert network_share.configured_pin() is None
