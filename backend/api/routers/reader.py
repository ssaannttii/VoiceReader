"""Reader: a library of documents to listen to (docs/reader/SPEC.md).

User-level routes (no admin guard). LAN clients reach them through the
network-share PIN gate like every other route; ``/reader/audio/{key}`` is a
plain GET (cookie/``?pin=`` auth, HTTP Range via FileResponse) so it works as
an ``<audio src>``.
"""
from __future__ import annotations

import asyncio
import gzip
import json
import logging
import time
from typing import Optional

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field

from services import reader_debug, reader_import, reader_render, reader_store

router = APIRouter()
logger = logging.getLogger("omnivoice.reader")

_AUDIO_CACHE_CONTROL = "public, max-age=31536000, immutable"


class TextImportRequest(BaseModel):
    text: str = Field(..., max_length=reader_import.MAX_TEXT_CHARS)
    title: Optional[str] = Field(None, max_length=500)
    language: Optional[str] = Field(None, max_length=16)


class UrlImportRequest(BaseModel):
    url: str = Field(..., max_length=4096)
    language: Optional[str] = Field(None, max_length=16)


class DocumentPatch(BaseModel):
    title: Optional[str] = Field(None, max_length=500)
    voice_id: Optional[str] = Field(None, max_length=200)
    engine: Optional[str] = Field(None, max_length=100)
    language: Optional[str] = Field(None, max_length=16)


class ProgressRequest(BaseModel):
    segment: int = Field(..., ge=0)


class RenderRequest(BaseModel):
    voice: Optional[str] = Field(None, max_length=200)
    engine: Optional[str] = Field(None, max_length=100)
    language: Optional[str] = Field(None, max_length=16)


class PrerenderRequest(RenderRequest):
    from_segment: Optional[int] = Field(None, ge=0)


def _not_found() -> HTTPException:
    return HTTPException(status_code=404, detail="Document not found")


def _summary(doc_id: str) -> dict:
    try:
        return reader_store.get_summary(doc_id)
    except reader_store.DocumentNotFound:
        raise _not_found() from None


def _save(doc: reader_import.ImportedDocument) -> dict:
    return reader_store.create_document(
        title=doc.title,
        author=doc.author,
        source_type=doc.source_type,
        source_name=doc.source_name,
        source_url=doc.source_url,
        language=doc.language,
        segments=doc.segments,
        chapters=doc.chapters,
        cover=doc.cover,
    )


async def _import(fn, *args, **kwargs) -> dict:
    try:
        doc = await asyncio.to_thread(fn, *args, **kwargs)
    except reader_import.ReaderImportError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    return await asyncio.to_thread(_save, doc)


def _clean_lang(value: Optional[str]) -> Optional[str]:
    value = (value or "").strip().lower()
    return value or None


# â”€â”€ Library â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€


@router.get("/reader/documents")
async def list_documents():
    return await asyncio.to_thread(reader_store.list_documents)


@router.post("/reader/documents/text")
async def import_text(req: TextImportRequest):
    return await _import(
        reader_import.import_text, req.text, title=req.title, language=_clean_lang(req.language)
    )


@router.post("/reader/documents/file")
async def import_file(file: UploadFile = File(...), language: Optional[str] = Form(None)):
    data = await file.read(reader_import.MAX_FILE_BYTES + 1)
    if len(data) > reader_import.MAX_FILE_BYTES:
        raise HTTPException(status_code=400, detail="the file is too large (max 64 MB)")
    return await _import(
        reader_import.import_file, file.filename or "document.txt", data, language=_clean_lang(language)
    )


@router.post("/reader/documents/url")
async def import_url(req: UrlImportRequest):
    return await _import(reader_import.import_url, req.url, language=_clean_lang(req.language))


def _json_response(request: Request, payload: dict) -> Response:
    """JSON, gzipped when the client accepts it and it is worth it.

    A whole book is megabytes of text (a 26-hour novel: 2.2 MB); compressed it
    is ~4x smaller, which is most of the wait when a phone opens it.
    """
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    headers = {"vary": "Accept-Encoding"}
    if len(body) >= 16_384 and "gzip" in request.headers.get("accept-encoding", "").lower():
        body = gzip.compress(body, compresslevel=5)
        headers["content-encoding"] = "gzip"
    return Response(body, media_type="application/json", headers=headers)


@router.get("/reader/documents/{doc_id}")
async def get_document(doc_id: str, request: Request):
    try:
        doc = await asyncio.to_thread(reader_store.open_document, doc_id)
    except reader_store.DocumentNotFound:
        raise _not_found() from None
    return await asyncio.to_thread(_json_response, request, doc)


@router.patch("/reader/documents/{doc_id}")
async def update_document(doc_id: str, req: DocumentPatch):
    fields = req.model_dump(exclude_unset=True)
    if "title" in fields:
        title = (fields["title"] or "").strip()
        if not title:
            raise HTTPException(status_code=400, detail="Title cannot be empty")
        fields["title"] = title
    if "language" in fields:
        fields["language"] = _clean_lang(fields["language"])
    for key in ("voice_id", "engine"):
        if key in fields:
            fields[key] = (fields[key] or "").strip() or None
    try:
        return await asyncio.to_thread(reader_store.update_document, doc_id, fields)
    except reader_store.DocumentNotFound:
        raise _not_found() from None


@router.put("/reader/documents/{doc_id}/progress")
async def set_progress(doc_id: str, req: ProgressRequest):
    try:
        await asyncio.to_thread(reader_store.set_progress, doc_id, req.segment)
    except reader_store.DocumentNotFound:
        raise _not_found() from None
    return {"ok": True}


@router.delete("/reader/documents/{doc_id}")
async def delete_document(doc_id: str):
    try:
        await asyncio.to_thread(reader_store.delete_document, doc_id)
    except reader_store.DocumentNotFound:
        raise _not_found() from None
    reader_render.forget_prerender(doc_id)
    return {"ok": True}


@router.get("/reader/documents/{doc_id}/cover")
async def get_cover(doc_id: str):
    try:
        found = reader_store.cover_path(doc_id)
    except reader_store.DocumentNotFound:
        found = None
    if not found:
        raise HTTPException(status_code=404, detail="No cover")
    path, media_type = found
    return FileResponse(path, media_type=media_type, headers={"Cache-Control": "public, max-age=86400"})


# â”€â”€ Rendering â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€


def _render_settings(doc: dict, req: RenderRequest) -> tuple[Optional[str], Optional[str], Optional[str]]:
    fields = req.model_fields_set
    voice = (req.voice or None) if "voice" in fields else doc.get("voice_id")
    engine = (req.engine or None) if "engine" in fields else doc.get("engine")
    language = _clean_lang(req.language) if "language" in fields else doc.get("language")
    if voice is None:
        voice = _default_voice(language)
    return voice, engine, language


_LANGUAGE_NAMES = {
    "es": "spanish", "en": "english", "fr": "french", "de": "german",
    "it": "italian", "pt": "portuguese",
}


_DEFAULT_VOICES_PREF = "reader_default_voices"


def _default_voice_prefs() -> dict:
    from core import prefs

    value = prefs.get(_DEFAULT_VOICES_PREF, {})
    return value if isinstance(value, dict) else {}


class DefaultVoiceRequest(BaseModel):
    language: str = Field(min_length=2, max_length=12)
    voice_id: Optional[str] = Field(None, max_length=200)


@router.get("/reader/default-voices")
async def get_default_voices():
    """The listener's chosen voice per document language, e.g. ``{"es": "f952f96a"}``."""
    return await asyncio.to_thread(_default_voice_prefs)


@router.put("/reader/default-voices")
async def set_default_voice(req: DefaultVoiceRequest):
    """Choose (or clear, with ``voice_id: null``) the voice new documents in a language use."""
    from core import prefs

    language = _clean_lang(req.language)
    if not language:
        raise HTTPException(status_code=422, detail="Unknown language")
    if req.voice_id:
        voices = await asyncio.to_thread(_list_voices, None)
        if not any(voice["id"] == req.voice_id for voice in voices):
            raise HTTPException(status_code=404, detail="Voice not found")

    def write() -> dict:
        current = dict(_default_voice_prefs())
        if req.voice_id:
            current[language] = req.voice_id
        else:
            current.pop(language, None)
        prefs.set_(_DEFAULT_VOICES_PREF, current)
        return current

    return await asyncio.to_thread(write)


def _default_voice(language: Optional[str]) -> Optional[str]:
    """A saved profile to read with when the listener has not picked a voice.

    Without a reference clip, cloning engines invent a new speaker per call, so
    a document would change voice from one sentence to the next. Prefer
    profiles tagged with the "Reader" personality in the document language,
    then any profile in that language, then any Reader profile.
    """
    from core.db import db_conn

    wanted = {language or "", _LANGUAGE_NAMES.get(language or "", "")} - {""}
    try:
        with db_conn() as conn:
            rows = conn.execute(
                "SELECT id, language, personality FROM voice_profiles ORDER BY created_at"
            ).fetchall()
        chosen = _default_voice_prefs().get(language or "")
        if chosen and any(row["id"] == chosen for row in rows):
            return chosen
    except Exception:  # noqa: BLE001 â€” rendering still works with the engine default
        logger.warning("Reader: default voice lookup failed", exc_info=True)
        return None

    def score(row) -> int:
        lang_match = (row["language"] or "").strip().lower() in wanted
        reader = (row["personality"] or "").strip().lower() == "reader"
        return (2 if lang_match else 0) + (1 if reader else 0)

    best = max(rows, key=score, default=None)
    return best["id"] if best is not None and score(best) > 0 else None


def _render_error(exc: Exception) -> HTTPException:
    from api.routers.tts_stream import StreamUnavailableError
    from core.failure import licence_required_detail

    if isinstance(exc, StreamUnavailableError):
        return HTTPException(status_code=503, detail=str(exc))
    if licence_required_detail(exc) is not None:
        return HTTPException(status_code=403, detail=str(exc))
    if isinstance(exc, ValueError):
        return HTTPException(status_code=400, detail=str(exc))
    logger.exception("Reader render failed")
    return HTTPException(status_code=500, detail=reader_render._public_error(exc))


@router.post("/reader/documents/{doc_id}/segments/{index}/render")
async def render_segment(doc_id: str, index: int, req: Optional[RenderRequest] = None):
    req = req or RenderRequest()
    try:
        doc = await asyncio.to_thread(reader_store.get_summary, doc_id)
        content = await asyncio.to_thread(reader_store.load_content, doc_id)
    except reader_store.DocumentNotFound:
        raise _not_found() from None
    segments = content["segments"]
    if index < 0 or index >= len(segments):
        raise HTTPException(status_code=404, detail="Segment not found")
    voice, engine, language = _render_settings(doc, req)
    started = time.perf_counter()
    try:
        result = await reader_render.render_segment(
            segments[index]["text"], voice=voice, engine=engine, language=language
        )
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 â€” mapped to a typed HTTP error
        error = _render_error(exc)
        await asyncio.to_thread(
            reader_debug.server_event, "server_render_error",
            doc=doc_id, seg=index, status=error.status_code, detail=str(error.detail)[:300],
        )
        raise error from None
    await asyncio.to_thread(
        reader_debug.server_event, "server_render",
        doc=doc_id, seg=index, cached=result.get("cached"),
        ms=round((time.perf_counter() - started) * 1000), dur_s=result.get("duration_s"), voice=voice,
    )
    # Remember the last voice/engine the listener chose for this document.
    changes = {}
    # An auto-picked default is pinned too, so the document keeps one voice
    # even if profiles are added later.
    if voice != doc.get("voice_id") and ("voice" in req.model_fields_set or doc.get("voice_id") is None):
        changes["voice_id"] = voice
    if "engine" in req.model_fields_set and engine != doc.get("engine"):
        changes["engine"] = engine
    if changes:
        await asyncio.to_thread(reader_store.update_document, doc_id, changes)
    return {"segment": index, "voice": voice, **result}


@router.post("/reader/documents/{doc_id}/prerender")
async def start_prerender(doc_id: str, req: Optional[PrerenderRequest] = None):
    req = req or PrerenderRequest()
    try:
        doc = await asyncio.to_thread(reader_store.get_summary, doc_id)
        content = await asyncio.to_thread(reader_store.load_content, doc_id)
    except reader_store.DocumentNotFound:
        raise _not_found() from None
    voice, engine, language = _render_settings(doc, req)
    try:
        return reader_render.start_prerender(
            doc_id,
            [s["text"] for s in content["segments"]],
            voice=voice,
            engine=engine,
            language=language,
            from_segment=req.from_segment or 0,
        )
    except Exception as exc:  # noqa: BLE001
        raise _render_error(exc) from None


async def _idle_status(doc_id: str) -> dict:
    doc = await asyncio.to_thread(reader_store.get_summary, doc_id)
    texts = [s["text"] for s in (await asyncio.to_thread(reader_store.load_content, doc_id))["segments"]]
    engine = doc.get("engine")
    try:
        engine = reader_render.resolve_engine_id(engine)
        done = await asyncio.to_thread(
            reader_render.cached_count,
            texts,
            voice=doc.get("voice_id") or _default_voice(doc.get("language")),
            engine=engine,
            language=doc.get("language"),
        )
    except Exception:  # noqa: BLE001 â€” status must not fail on engine lookup
        done = 0
    return {
        "running": False,
        "done": done,
        "total": len(texts),
        "error": None,
        "voice": doc.get("voice_id"),
        "engine": engine,
    }


@router.get("/reader/documents/{doc_id}/prerender")
async def get_prerender(doc_id: str):
    status = reader_render.prerender_status(doc_id)
    if status is not None:
        return status
    try:
        return await _idle_status(doc_id)
    except reader_store.DocumentNotFound:
        raise _not_found() from None


@router.delete("/reader/documents/{doc_id}/prerender")
async def cancel_prerender(doc_id: str):
    status = reader_render.cancel_prerender(doc_id)
    if status is not None:
        return status
    try:
        return await _idle_status(doc_id)
    except reader_store.DocumentNotFound:
        raise _not_found() from None


@router.get("/reader/audio/{key}")
async def get_audio(key: str):
    found = reader_render.audio_file(key)
    if not found:
        raise HTTPException(status_code=404, detail="Audio not found")
    path, media_type = found
    return FileResponse(path, media_type=media_type, headers={"Cache-Control": _AUDIO_CACHE_CONTROL})


# â”€â”€ Voices / status â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€


def _list_voices(engine: Optional[str]) -> list[dict]:
    voices: list[dict] = []
    try:
        from core.db import db_conn

        with db_conn() as conn:
            rows = conn.execute(
                "SELECT id, name, language, description FROM voice_profiles ORDER BY name COLLATE NOCASE"
            ).fetchall()
        for row in rows:
            language = (row["language"] or "").strip()
            voices.append({
                "id": row["id"],
                "name": row["name"],
                "kind": "profile",
                "engine": None,
                "language": None if language.lower() in ("", "auto") else language,
                "description": (row["description"] or None),
            })
    except Exception:  # noqa: BLE001 â€” presets still list without the DB
        logger.warning("Reader: voice profiles could not be loaded", exc_info=True)
    try:
        from services import tts_backend

        engine_id = engine or tts_backend.active_backend_id()
        cls = tts_backend.get_backend_class(engine_id)
        presets = list(getattr(cls, "PRESET_VOICES", None) or [])
        default = getattr(cls, "DEFAULT_VOICE", None)
        for name in presets:
            voices.append({
                "id": name,
                "name": name,
                "kind": "preset",
                "engine": engine_id,
                "language": None,
                "description": "Default voice" if name == default else None,
            })
    except Exception:  # noqa: BLE001 â€” unknown engine id: profiles only
        logger.debug("Reader: preset voices unavailable for %r", engine, exc_info=True)
    return voices


class DebugBatch(BaseModel):
    session: str = Field(min_length=1, max_length=40)
    device: Optional[dict] = None
    events: list[dict] = Field(default_factory=list, max_length=500)


@router.post("/reader/debug/events")
async def debug_events(batch: DebugBatch, request: Request):
    """Diagnostics from a Reader client, appended to the local debug log."""
    client = request.client.host if request.client else None
    records = []
    if batch.device:
        records.append({"session": batch.session, "type": "device", "client": client, **batch.device})
    records.extend({"session": batch.session, **event} for event in batch.events)
    stored = await asyncio.to_thread(reader_debug.append, records)
    return {"ok": True, "stored": stored}


@router.get("/reader/voices")
async def list_voices(engine: Optional[str] = None):
    return await asyncio.to_thread(_list_voices, engine)


def _engine_ready(engine_id: str) -> bool:
    try:
        from services import tts_backend

        ok, _reason = tts_backend.get_backend_class(engine_id).is_available()
        return bool(ok)
    except Exception:  # noqa: BLE001
        return False


def _lan_url() -> Optional[str]:
    try:
        from services import network_share

        state = network_share.get_state()
    except Exception:  # noqa: BLE001
        return None
    if not state.enabled or not state.share_port or not state.lan_addresses:
        return None
    return f"http://{state.lan_addresses[0]}:{state.share_port}"


@router.get("/reader/status")
async def reader_status():
    from services import tts_backend

    engine_id = tts_backend.active_backend_id()
    ready, fmt = await asyncio.gather(
        asyncio.to_thread(_engine_ready, engine_id),
        asyncio.to_thread(reader_render.audio_format),
    )
    return {"engine": engine_id, "engine_ready": ready, "audio_format": fmt, "lan_url": _lan_url()}
