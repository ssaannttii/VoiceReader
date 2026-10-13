"""Reader engine status and warm-up (``GET /reader/status``, ``POST /reader/warmup``).

``model_state`` answers "will the next sentence start quickly?" for the engine
the Reader renders with:

* ``ready``    — the engine's weights are resident (``model_lifecycle.list_loaded``,
  the inventory behind ``GET /model/loaded``; for the built-in OmniVoice model
  also ``model_manager.get_model_status`` behind ``GET /model/status``);
* ``loading``  — a Reader warm-up, or VoiceStudio's own (pre)load, is running;
* ``error``    — the last load failed (``model_error`` says why);
* ``unloaded`` — nothing resident (never loaded, or idle-unloaded since).

Warm-up loads the engine through the same path a render takes
(``tts_stream.stream_engine_session``: licence, routing gate, eviction of
other TTS engines, the shared OmniVoice model) and then ``ensure_ready`` under
the model-load budget (``gpu_gateway.prewarm``). It never starts a model
*download*: the built-in model is only warmed when its checkpoint is already
in the local cache, other engines only when ``is_available()`` says they are
installed — the first render keeps owning first-use downloads.
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Optional

logger = logging.getLogger("omnivoice.reader")

_state: dict = {"engine": None, "task": None, "error": None, "ready_at": None}

UNLOADED, LOADING, READY, ERROR = "unloaded", "loading", "ready", "error"


def _warming(engine_id: str) -> bool:
    task = _state.get("task")
    return _state.get("engine") == engine_id and task is not None and not task.done()


def note_rendered(engine_id: str) -> None:
    """A render just succeeded on ``engine_id``: it is loaded."""
    if _state.get("engine") in (None, engine_id):
        _state.update(engine=engine_id, error=None, ready_at=time.time())


def _loaded_engines() -> Optional[set]:
    try:
        from services import model_lifecycle

        models = model_lifecycle.list_loaded().get("models") or []
    except Exception:  # noqa: BLE001 — status must never fail
        logger.debug("Reader: loaded-model inventory unavailable", exc_info=True)
        return None
    return {m.get("engine_id") for m in models if m.get("engine_id")}


def _core_status() -> dict:
    try:
        from services.model_manager import get_model_status

        return get_model_status() or {}
    except Exception:  # noqa: BLE001
        return {}


def model_status(engine_id: str) -> dict:
    """``{"model_state", "model_error"}`` for ``engine_id``. Blocking (cheap)."""
    if _warming(engine_id):
        return {"model_state": LOADING, "model_error": None}
    loaded = _loaded_engines()
    if loaded is not None and engine_id in loaded:
        return {"model_state": READY, "model_error": None}
    if engine_id == "omnivoice":
        core = _core_status()
        if core.get("loaded"):
            return {"model_state": READY, "model_error": None}
        if core.get("loading"):
            return {"model_state": LOADING, "model_error": None}
        if core.get("error"):
            return {"model_state": ERROR, "model_error": str(core["error"])}
    if _state.get("engine") == engine_id and _state.get("error"):
        return {"model_state": ERROR, "model_error": _state["error"]}
    if loaded is None and _state.get("engine") == engine_id and _state.get("ready_at"):
        return {"model_state": READY, "model_error": None}  # inventory down: trust the last render
    return {"model_state": UNLOADED, "model_error": None}


def _installed(engine_id: str) -> tuple[bool, Optional[str]]:
    """Whether warming ``engine_id`` can happen without a download."""
    try:
        from services import tts_backend

        cls = tts_backend.get_backend_class(engine_id)
        if cls is tts_backend.OmniVoiceBackend:
            from services import model_manager as mm

            return bool(mm._checkpoint_in_local_cache(mm.resolve_omnivoice_checkpoint())), None
        ok, reason = cls.is_available()
        return bool(ok), (None if ok else str(reason or "") or None)
    except Exception as exc:  # noqa: BLE001
        return False, str(exc)


async def _load(engine_id: str) -> None:
    from api.routers.tts_stream import stream_engine_session
    from services import gpu_gateway, tts_backend

    # The active engine resolves exactly as a document without an engine
    # override renders (for OmniVoice: the shared model via ``get_model()``).
    requested = None if engine_id == tts_backend.active_backend_id() else engine_id
    async with stream_engine_session(requested) as (backend, _kw):
        await gpu_gateway.prewarm(backend=backend, engine=engine_id)


async def _warm(engine_id: str) -> None:
    try:
        await _load(engine_id)
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001 — surfaced through model_error
        from services.reader_render import _public_error

        logger.warning("Reader warm-up of %s failed: %s", engine_id, exc)
        _state["error"] = _public_error(exc)
        return
    _state.update(error=None, ready_at=time.time())


async def warmup(engine_id: str) -> dict:
    """Start loading ``engine_id`` in the background (idempotent); returns
    :func:`model_status`. A model that is not installed is left alone."""
    status = await asyncio.to_thread(model_status, engine_id)
    if status["model_state"] in (READY, LOADING):
        return status
    installed, _reason = await asyncio.to_thread(_installed, engine_id)
    if not installed:
        return status
    _state.update(engine=engine_id, error=None, ready_at=None)
    _state["task"] = asyncio.ensure_future(_warm(engine_id))
    return {"model_state": LOADING, "model_error": None}
