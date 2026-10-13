"""Reader Labs: opt-in OmniVoice sampling steps (``num_step``) on the render
and speech-preview routes. Default renders keep their cache keys exactly."""
from __future__ import annotations

import asyncio
import hashlib
import json
from contextlib import asynccontextmanager
from types import SimpleNamespace

import numpy as np
import pytest
from fastapi.testclient import TestClient

from .test_reader_api import SR, _create, _speech_like, env  # noqa: F401 — fixture


@pytest.fixture
def labs(env, monkeypatch):
    """The API fixture with a fake synthesizer that also records ``num_step``."""
    from services import reader_render

    env.steps = []

    async def fake_synthesize(text, *, voice, engine, language, **extra):
        env.calls.append((text, voice, engine, language))
        env.steps.append(extra.get("num_step"))
        await asyncio.sleep(0)
        return _speech_like(), SR

    monkeypatch.setattr(reader_render, "synthesize_segment", fake_synthesize)
    return env


def test_default_keys_are_unchanged():
    from services import reader_render

    raw = "omnivoice|v|es|Hola mundo."
    legacy = hashlib.sha1(raw.encode("utf-8")).hexdigest()  # noqa: S324
    assert reader_render.render_key("omnivoice", "v", "es", "Hola mundo.") == legacy
    assert reader_render.render_key("omnivoice", "v", "es", "Hola mundo.", None) == legacy
    assert reader_render.render_key("omnivoice", "v", "es", "Hola mundo.", 32) != legacy

    # Only a non-default step count on an engine that honours it changes anything.
    assert reader_render.effective_num_step("omnivoice", None) is None
    assert reader_render.effective_num_step("omnivoice", 16) is None
    assert reader_render.effective_num_step("omnivoice", 32) == 32
    assert reader_render.effective_num_step("kittentts", 32) is None

    text = "Tengo 25 años."
    plain = reader_render.plan_segment(text, engine_id="omnivoice", voice="v", language="es")
    assert plain.key == reader_render.render_key("omnivoice", "v", "es", reader_render.final_text(text, "es"))
    assert plain.num_step is None and plain.legacy_key is not None
    high = reader_render.plan_segment(text, engine_id="omnivoice", voice="v", language="es", num_step=32)
    assert high.key != plain.key and high.final == plain.final
    # A pre-v2 entry was rendered with the default steps: never served for 32.
    assert high.legacy_key is None
    spoken = reader_render.Spoken(pieces=((0, len(text), text, 300),))
    prepared = reader_render.plan_segment(text, engine_id="omnivoice", voice="v", language="es", spoken=spoken)
    prepared_high = reader_render.plan_segment(
        text, engine_id="omnivoice", voice="v", language="es", spoken=spoken, num_step=32
    )
    assert prepared_high.key != prepared.key and prepared_high.num_step == 32


def test_render_route_num_step(labs):
    client = TestClient(labs.app)
    doc = _create(client)
    url = f"/reader/documents/{doc['id']}/segments/1/render"

    base = client.post(url, json={"engine": "omnivoice"}).json()
    default = client.post(url, json={"engine": "omnivoice", "num_step": 16}).json()
    assert default["render_key"] == base["render_key"] and default["cached"] is True
    assert labs.steps == [None]

    high = client.post(url, json={"engine": "omnivoice", "num_step": 32}).json()
    assert high["render_key"] != base["render_key"] and high["cached"] is False
    assert labs.steps == [None, 32]
    entry = json.loads((labs.data_dir / "reader" / "audio" / f"{high['render_key']}.json").read_text("utf-8"))
    assert entry["num_step"] == 32
    again = client.post(url, json={"engine": "omnivoice", "num_step": 32}).json()
    assert again["render_key"] == high["render_key"] and again["cached"] is True

    # Engines without sampling steps ignore it: same key, no extra synthesis.
    other = client.post(url, json={"engine": "fake-engine"}).json()
    other_high = client.post(url, json={"engine": "fake-engine", "num_step": 32}).json()
    assert other_high["render_key"] == other["render_key"] and other_high["cached"] is True
    assert labs.steps == [None, 32, None]

    assert client.post(url, json={"num_step": 4}).status_code == 422
    assert client.post(url, json={"num_step": 65}).status_code == 422


def test_preview_route_num_step(labs):
    client = TestClient(labs.app)
    doc = _create(client)
    url = f"/reader/documents/{doc['id']}/speech/preview/1"
    plain = client.post(url, json={"prepared": False, "engine": "omnivoice"})
    assert plain.status_code == 200, plain.text
    high = client.post(url, json={"prepared": False, "engine": "omnivoice", "num_step": 32}).json()
    assert high["render_key"] != plain.json()["render_key"] and high["prepared"] is False
    assert labs.steps == [None, 32]


def test_synthesize_segment_passes_num_step_to_omnivoice_only(monkeypatch):
    from api.routers import tts_stream
    from services import model_manager, reader_render

    seen = []

    def make_session(backend_id):
        @asynccontextmanager
        async def session(engine, *, voice=None, language=None):
            yield SimpleNamespace(id=backend_id), {"speed": 1.0, "language": language}

        return session

    def fake_render(backend, kw, text):
        seen.append(dict(kw))
        return np.zeros(SR, dtype=np.float32), SR, 0.0

    async def fake_pool(fn, *, what, timeout):
        return fn()

    monkeypatch.setattr(tts_stream, "render_stream_sentence", fake_render)
    monkeypatch.setattr(model_manager, "run_on_gpu_pool_guarded", fake_pool)
    monkeypatch.setattr(model_manager, "generate_timeout_s", lambda text, engine=None: 30)

    monkeypatch.setattr(tts_stream, "stream_engine_session", make_session("omnivoice"))
    asyncio.run(reader_render.synthesize_segment("Hola.", voice=None, engine=None, language="es", num_step=32))
    asyncio.run(reader_render.synthesize_segment("Hola.", voice=None, engine=None, language="es"))
    monkeypatch.setattr(tts_stream, "stream_engine_session", make_session("kittentts"))
    asyncio.run(reader_render.synthesize_segment("Hola.", voice=None, engine=None, language="es", num_step=32))
    assert [kw.get("num_step") for kw in seen] == [32, None, None]
