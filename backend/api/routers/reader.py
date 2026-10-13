"""Reader: a library of documents to listen to (docs/reader/SPEC.md).

User-level routes (no admin guard). LAN clients reach them through the
network-share PIN gate like every other route; ``/reader/audio/{key}`` is a
plain GET (cookie/``?pin=`` auth, HTTP Range via FileResponse) so it works as
an ``<audio src>``.
"""
from __future__ import annotations

import asyncio
import functools
import gzip
import json
import logging
import os
import time
from typing import Optional

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field

from services import reader_debug, reader_engine, reader_import, reader_jobs, reader_render, reader_store
from services import reader_speech

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
    archived: Optional[bool] = None
    completed: Optional[bool] = None


class ProgressRequest(BaseModel):
    segment: int = Field(..., ge=0)


class VoiceRequest(BaseModel):
    voice: Optional[str] = Field(None, max_length=200)
    engine: Optional[str] = Field(None, max_length=100)
    language: Optional[str] = Field(None, max_length=16)


class RenderRequest(VoiceRequest):
    # OmniVoice sampling steps (Reader Labs "high quality"); other engines ignore it.
    num_step: Optional[int] = Field(None, ge=8, le=64)


class PrerenderRequest(VoiceRequest):
    from_segment: Optional[int] = Field(None, ge=0)


def _not_found() -> HTTPException:
    return HTTPException(status_code=404, detail="Document not found")


def _not_ready(exc: reader_store.DocumentImporting) -> HTTPException:
    """409 ``{"detail": "importing"}`` (or ``"import_error"`` for a failed import)."""
    return HTTPException(status_code=409, detail=str(exc.args[0] if exc.args else "importing"))


def _summary(doc_id: str) -> dict:
    try:
        return reader_store.get_summary(doc_id)
    except reader_store.DocumentNotFound:
        raise _not_found() from None


def _ready_content(doc_id: str) -> tuple[dict, dict]:
    """``(summary, content)`` of a document whose import finished; 404/409 otherwise."""
    try:
        doc = reader_store.require_ready(reader_store.get_summary(doc_id))
        return doc, reader_store.load_content(doc_id)
    except reader_store.DocumentNotFound:
        raise _not_found() from None
    except reader_store.DocumentImporting as exc:
        raise _not_ready(exc) from None


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
        assets=doc.assets,
    )


async def _import(fn, *args, **kwargs) -> dict:
    try:
        doc = await asyncio.to_thread(fn, *args, **kwargs)
    except reader_import.ReaderImportError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    summary = await asyncio.to_thread(_save, doc)
    _after_import(summary["id"])  # automatic ambience block below
    return summary


def _clean_lang(value: Optional[str]) -> Optional[str]:
    value = (value or "").strip().lower()
    return value or None


# â”€â”€ Library â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€


@router.get("/reader/documents")
async def list_documents():
    # First library listing after a restart: resume interrupted imports.
    await asyncio.to_thread(reader_jobs.resume_pending)
    return await asyncio.to_thread(reader_store.list_documents)


@router.post("/reader/documents/text")
async def import_text(req: TextImportRequest):
    return await _import(
        reader_import.import_text, req.text, title=req.title, language=_clean_lang(req.language)
    )


def _check_file_type(name: str) -> None:
    ext = os.path.splitext(name)[1].lower()
    if ext not in reader_import.FILE_EXTENSIONS + (".xhtml", ".text", ".markdown", ""):
        raise HTTPException(
            status_code=400,
            detail=f"unsupported file type {ext}; use "
            + ", ".join(e.lstrip(".") for e in reader_import.FILE_EXTENSIONS[:-1]) + " or docx",
        )


async def _start_import(*, title: str, source_type: str, files: list, source_name: str, language, meta: dict) -> dict:
    summary = await asyncio.to_thread(
        functools.partial(
            reader_store.create_pending,
            title=title,
            source_type=source_type,
            files=files,
            source_name=source_name,
            language=language,
            meta=meta,
        )
    )
    reader_jobs.enqueue(summary["id"])
    return summary


@router.post("/reader/documents/file")
async def import_file(file: UploadFile = File(...), language: Optional[str] = Form(None)):
    """Store the upload and import it in the background (``import_status``)."""
    data = await file.read(reader_import.MAX_FILE_BYTES + 1)
    if len(data) > reader_import.MAX_FILE_BYTES:
        raise HTTPException(status_code=400, detail="the file is too large (max 64 MB)")
    if not data:
        raise HTTPException(status_code=400, detail="the file is empty")
    name = os.path.basename(file.filename or "document.txt")
    _check_file_type(name)
    lang = _clean_lang(language)
    # A placeholder while the import runs; the import picks the real title
    # (metadata, heading, cleaned file name) unless the user renames it first.
    placeholder = reader_import.filename_title(name) or reader_import.legacy_filename_title(name) or "Document"
    return await _start_import(
        title=placeholder,
        source_type="file",
        files=[(name, data)],
        source_name=name,
        language=lang,
        meta={"kind": reader_jobs.KIND_FILE, "language": lang, "placeholder_title": placeholder},
    )


@router.post("/reader/documents/scan")
async def import_scan(
    files: list[UploadFile] = File(...),
    language: Optional[str] = Form(None),
    title: Optional[str] = Form(None, max_length=500),
):
    """Page photos (1–50, in page order) → OCR → a document, in the background."""
    if not files:
        raise HTTPException(status_code=400, detail="add at least one image")
    if len(files) > reader_import.MAX_SCAN_IMAGES:
        raise HTTPException(status_code=400, detail=f"too many images (max {reader_import.MAX_SCAN_IMAGES})")
    stored: list[tuple[str, bytes]] = []
    total = 0
    for index, upload in enumerate(files):
        data = await upload.read(reader_import.MAX_SCAN_IMAGE_BYTES + 1)
        if not data:
            raise HTTPException(status_code=400, detail=f"image {index + 1} is empty")
        if len(data) > reader_import.MAX_SCAN_IMAGE_BYTES:
            raise HTTPException(status_code=400, detail=f"image {index + 1} is too large (max 25 MB)")
        total += len(data)
        if total > reader_import.MAX_FILE_BYTES * 4:
            raise HTTPException(status_code=400, detail="the images are too large together (max 256 MB)")
        stored.append((upload.filename or f"page-{index + 1}.jpg", data))
    lang = _clean_lang(language)
    clean_title = " ".join((title or "").split()) or None
    count = len(stored)
    placeholder = clean_title or f"Scan ({count} page{'s' if count != 1 else ''})"
    return await _start_import(
        title=placeholder,
        source_type="scan",
        files=stored,
        source_name=f"{count} image{'s' if count != 1 else ''}",
        language=lang,
        meta={"kind": reader_jobs.KIND_SCAN, "language": lang, "title": clean_title, "placeholder_title": placeholder},
    )


@router.post("/reader/documents/{doc_id}/retry")
async def retry_import(doc_id: str):
    """Re-queue a failed background import whose upload is still stored."""
    try:
        summary = await asyncio.to_thread(reader_store.restart_import, doc_id)
    except reader_store.DocumentNotFound:
        raise _not_found() from None
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from None
    reader_jobs.enqueue(doc_id)
    return summary


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
    except reader_store.DocumentImporting as exc:
        raise _not_ready(exc) from None
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
    for key in ("archived", "completed"):
        if key in fields and fields[key] is None:
            raise HTTPException(status_code=422, detail=f"{key} must be true or false")
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
    except reader_store.DocumentImporting as exc:
        raise _not_ready(exc) from None
    return {"ok": True}


@router.delete("/reader/documents/{doc_id}")
async def delete_document(doc_id: str):
    try:
        await asyncio.to_thread(reader_store.delete_document, doc_id)
    except reader_store.DocumentNotFound:
        raise _not_found() from None
    reader_render.forget_prerender(doc_id)
    reader_speech.forget(doc_id)
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


@router.get("/reader/documents/{doc_id}/assets/{name}")
async def get_asset(doc_id: str, name: str):
    """An image of the document (``src`` of its ``img`` segments)."""
    try:
        found = reader_store.asset_path(doc_id, name)
    except reader_store.DocumentNotFound:
        found = None
    if not found:
        raise HTTPException(status_code=404, detail="No such image")
    path, media_type = found
    return FileResponse(
        path,
        media_type=media_type,
        headers={"Cache-Control": "public, max-age=86400", "X-Content-Type-Options": "nosniff"},
    )


# â”€â”€ Rendering â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€


def _render_settings(doc: dict, req: VoiceRequest) -> tuple[Optional[str], Optional[str], Optional[str]]:
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
    doc, content = await asyncio.to_thread(_ready_content, doc_id)
    segments = content["segments"]
    if index < 0 or index >= len(segments):
        raise HTTPException(status_code=404, detail="Segment not found")
    voice, engine, language = _render_settings(doc, req)
    # Prepared reading (off by default → None → the plain path, unchanged).
    spoken = await asyncio.to_thread(reader_speech.spoken_for, doc_id, content, index)
    started = time.perf_counter()
    try:
        result = await reader_render.render_segment(
            segments[index]["text"], voice=voice, engine=engine, language=language, spoken=spoken,
            num_step=req.num_step,
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
    doc, content = await asyncio.to_thread(_ready_content, doc_id)
    voice, engine, language = _render_settings(doc, req)
    spoken, variant = await asyncio.to_thread(reader_speech.spoken_list, doc_id, content)
    try:
        return reader_render.start_prerender(
            doc_id,
            [s["text"] for s in content["segments"]],
            voice=voice,
            engine=engine,
            language=language,
            from_segment=req.from_segment or 0,
            spoken=spoken,
            variant=variant,
        )
    except Exception as exc:  # noqa: BLE001
        raise _render_error(exc) from None


async def _idle_status(doc_id: str) -> dict:
    doc, content = await asyncio.to_thread(_ready_content, doc_id)
    texts = [s["text"] for s in content["segments"]]
    engine = doc.get("engine")
    try:
        engine = reader_render.resolve_engine_id(engine)
        spoken, _variant = await asyncio.to_thread(reader_speech.spoken_list, doc_id, content)
        done = await asyncio.to_thread(
            reader_render.cached_count,
            texts,
            voice=doc.get("voice_id") or _default_voice(doc.get("language")),
            engine=engine,
            language=doc.get("language"),
            spoken=spoken,
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
    ready, fmt, model = await asyncio.gather(
        asyncio.to_thread(_engine_ready, engine_id),
        asyncio.to_thread(reader_render.audio_format),
        asyncio.to_thread(reader_engine.model_status, engine_id),
    )
    return {
        "engine": engine_id,
        "engine_ready": ready,
        "audio_format": fmt,
        "lan_url": _lan_url(),
        **model,
    }


@router.post("/reader/warmup")
async def warmup():
    """Start loading the active TTS engine in the background (idempotent).

    Returns ``{"engine", "model_state", "model_error"}``. Never downloads a
    model: an engine that is not installed stays ``unloaded``.
    """
    from services import tts_backend

    engine_id = tts_backend.active_backend_id()
    return {"engine": engine_id, **(await reader_engine.warmup(engine_id))}


# ── Pronunciation (user-level wrappers over VoiceStudio's dictionary) ────────


class PronunciationRequest(BaseModel):
    term: str = Field(..., min_length=1, max_length=200)
    replacement: str = Field(..., max_length=500)
    language: Optional[str] = Field(None, max_length=32)


def _pron_entry(row) -> dict:
    return {
        "id": row["id"],
        "term": row["term"],
        "replacement": row["replacement"],
        "language": row["language"] or "*",
    }


def _list_pronunciations(language: Optional[str]) -> list[dict]:
    from services.pronunciation import load_entries_from_db, language_scope_key

    rows = [r for r in load_entries_from_db() if (r.get("type") or "respelling") == "respelling"]
    if language:
        wanted = language_scope_key(language)
        rows = [r for r in rows if (r["language"] or "*") == "*" or language_scope_key(r["language"]) == wanted]
    rows.sort(key=lambda r: (r["term"] or "").casefold())
    return [_pron_entry(r) for r in rows]


def _save_pronunciation(term: str, replacement: str, language: Optional[str]) -> dict:
    """Upsert: one respelling per (term, scope); the term matches case-insensitively."""
    import uuid

    from core.db import db_conn
    from services.pronunciation import language_scope_key

    scope = language_scope_key(language) or "*"
    with db_conn() as conn:
        existing = [
            row for row in conn.execute(
                "SELECT id, term FROM pronunciation_entries WHERE language=? AND type='respelling'", (scope,)
            ).fetchall()
            if (row["term"] or "").strip().casefold() == term.casefold()
        ]
        if existing:
            entry_id = existing[0]["id"]
            conn.execute(
                "UPDATE pronunciation_entries SET term=?, replacement=?, enabled=1 WHERE id=?",
                (term, replacement, entry_id),
            )
        else:
            entry_id = str(uuid.uuid4())[:12]
            conn.execute(
                "INSERT INTO pronunciation_entries (id, term, replacement, type, language, enabled, created_at)"
                " VALUES (?, ?, ?, 'respelling', ?, 1, ?)",
                (entry_id, term, replacement, scope, time.time()),
            )
        row = conn.execute(
            "SELECT id, term, replacement, language FROM pronunciation_entries WHERE id=?", (entry_id,)
        ).fetchone()
    return _pron_entry(row)


def _delete_pronunciation(entry_id: str) -> bool:
    from core.db import db_conn

    with db_conn() as conn:
        deleted = conn.execute("DELETE FROM pronunciation_entries WHERE id=?", (entry_id,)).rowcount
    return bool(deleted)


@router.get("/reader/pronunciations")
async def list_pronunciations(language: Optional[str] = None):
    """Respelling entries (``[{id, term, replacement, language}]``); with
    ``?language=``, those that apply to it (global ``*`` + that language)."""
    return await asyncio.to_thread(_list_pronunciations, (language or "").strip() or None)


@router.post("/reader/pronunciations")
async def add_pronunciation(req: PronunciationRequest):
    term = " ".join(req.term.split())
    if not term:
        raise HTTPException(status_code=400, detail="A pronunciation entry needs a term.")
    if "[[" in term or "]]" in term or "[[" in req.replacement or "]]" in req.replacement:
        raise HTTPException(status_code=400, detail="Remove the double brackets.")
    return await asyncio.to_thread(_save_pronunciation, term, req.replacement.strip(), req.language)


@router.delete("/reader/pronunciations/{entry_id}")
async def delete_pronunciation(entry_id: str):
    if not await asyncio.to_thread(_delete_pronunciation, entry_id):
        raise HTTPException(status_code=404, detail="No such pronunciation entry.")
    return {"ok": True}


# ── Bookmarks ────────────────────────────────────────────────────────────────


class BookmarkRequest(BaseModel):
    segment: int = Field(..., ge=0)
    word: Optional[int] = Field(None, ge=0)
    note: Optional[str] = Field(None, max_length=10_000)


class BookmarkPatch(BaseModel):
    note: Optional[str] = Field(None, max_length=10_000)


def _public_bookmark(mark: dict) -> dict:
    return {k: mark[k] for k in ("id", "doc_id", "segment", "word", "note", "created_at")}


def _clean_note(note: Optional[str]) -> Optional[str]:
    note = (note or "").strip()
    return note or None


@router.get("/reader/documents/{doc_id}/bookmarks")
async def list_bookmarks(doc_id: str):
    try:
        marks = await asyncio.to_thread(reader_store.list_bookmarks, doc_id)
    except reader_store.DocumentNotFound:
        raise _not_found() from None
    return [_public_bookmark(m) for m in marks]


@router.post("/reader/documents/{doc_id}/bookmarks")
async def add_bookmark(doc_id: str, req: BookmarkRequest):
    try:
        mark = await asyncio.to_thread(
            reader_store.add_bookmark, doc_id, req.segment, req.word, _clean_note(req.note)
        )
    except reader_store.DocumentNotFound:
        raise _not_found() from None
    except reader_store.DocumentImporting as exc:
        raise _not_ready(exc) from None
    except ValueError:
        raise HTTPException(status_code=404, detail="Segment not found") from None
    return _public_bookmark(mark)


@router.get("/reader/documents/{doc_id}/bookmarks/export")
async def export_bookmarks(doc_id: str):
    try:
        doc = await asyncio.to_thread(reader_store.get_summary, doc_id)
        text = await asyncio.to_thread(reader_store.bookmarks_markdown, doc_id)
    except reader_store.DocumentNotFound:
        raise _not_found() from None
    except reader_store.DocumentImporting as exc:
        raise _not_ready(exc) from None
    from urllib.parse import quote

    filename = f"{doc['title'][:80].strip() or 'bookmarks'} - bookmarks.md"
    ascii_name = filename.encode("ascii", "ignore").decode().replace('"', "") or "bookmarks.md"
    return Response(
        text.encode("utf-8"),
        media_type="text/markdown; charset=utf-8",
        headers={
            "Content-Disposition": f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(filename)}"
        },
    )


@router.patch("/reader/bookmarks/{bookmark_id}")
async def update_bookmark(bookmark_id: str, req: BookmarkPatch):
    try:
        mark = await asyncio.to_thread(reader_store.update_bookmark, bookmark_id, _clean_note(req.note))
    except reader_store.BookmarkNotFound:
        raise HTTPException(status_code=404, detail="Bookmark not found") from None
    return _public_bookmark(mark)


@router.delete("/reader/bookmarks/{bookmark_id}")
async def delete_bookmark(bookmark_id: str):
    try:
        await asyncio.to_thread(reader_store.delete_bookmark, bookmark_id)
    except reader_store.BookmarkNotFound:
        raise HTTPException(status_code=404, detail="Bookmark not found") from None
    return {"ok": True}


# ── Automatic ambience (scene analysis; services/reader_ambience.py) ────────
# One self-contained block: scene analysis is independent of rendering and speech.


@router.get("/reader/documents/{doc_id}/ambience")
async def get_ambience(doc_id: str):
    """``{status: ready|computing|unavailable, scenes}``; starts the analysis when
    it is missing or stale (the client polls while ``computing``)."""
    from services import reader_ambience

    try:
        return await asyncio.to_thread(reader_ambience.status, doc_id)
    except reader_store.DocumentNotFound:
        raise _not_found() from None


def _after_import(doc_id: str) -> None:
    """Background scene analysis of a new text/URL document (only once Automático has been used)."""
    from services import reader_ambience

    reader_ambience.after_import(doc_id)

# ── Prepared reading ("Lectura preparada", services/reader_speech.py) ────────
# Kept as one block: an optional per-document layer over what the TTS says.
# The plain render path only asks reader_speech.spoken_for(), which is None
# while the option is off.


class SpeechEnableRequest(BaseModel):
    enabled: Optional[bool] = None
    pause_rules: Optional[dict[str, bool]] = None


class SpeechItemPatch(BaseModel):
    spoken: Optional[str] = Field(None, max_length=200)
    state: Optional[str] = Field(None, max_length=16)
    all: bool = False


class SpeechPreviewRequest(RenderRequest):
    prepared: bool = True
    item: Optional[int] = Field(None, ge=0)


async def _speech_call(doc_id: str, fn, *args, **kwargs):
    """Run ``fn(doc_id, content, ...)`` for a ready document; typed errors."""
    _doc, content = await asyncio.to_thread(_ready_content, doc_id)
    try:
        return await asyncio.to_thread(fn, doc_id, content, *args, **kwargs)
    except reader_speech.SpeechItemNotFound:
        raise HTTPException(status_code=404, detail="Change not found") from None
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None


@router.get("/reader/documents/{doc_id}/speech")
async def get_speech(doc_id: str):
    """Prepared reading: ``enabled``, preparation ``status``/``progress``, the
    changes (``items``) and pause counts by rule."""
    return await _speech_call(doc_id, reader_speech.payload)


@router.post("/reader/documents/{doc_id}/speech/enable")
async def enable_speech(doc_id: str, req: SpeechEnableRequest):
    """Switch prepared reading on/off (and pause rules); preparing starts when needed."""
    return await _speech_call(doc_id, reader_speech.set_enabled, req.enabled, req.pause_rules)


@router.post("/reader/documents/{doc_id}/speech/prepare")
async def prepare_speech(doc_id: str):
    """Start (or refresh) the background preparation of the document."""
    await asyncio.to_thread(_ready_content, doc_id)
    reader_speech.enqueue(doc_id)
    return await _speech_call(doc_id, reader_speech.payload)


@router.patch("/reader/documents/{doc_id}/speech/items/{n}")
async def edit_speech_item(doc_id: str, n: int, req: SpeechItemPatch):
    """Edit what change ``n`` says and/or its state (``applied``/``reverted``/
    ``suggested``); ``all`` applies it to every identical change."""
    return await _speech_call(
        doc_id, reader_speech.edit_item, n, spoken=req.spoken, state_value=req.state, all_same=req.all
    )


@router.delete("/reader/documents/{doc_id}/speech/items/{n}")
async def revert_speech_item(doc_id: str, n: int, all: bool = False):  # noqa: A002 — query name
    """Read change ``n`` as written again (``?all=true``: every identical change)."""
    return await _speech_call(doc_id, reader_speech.edit_item, n, state_value="reverted", all_same=all)


@router.post("/reader/documents/{doc_id}/speech/items/{n}/to-dictionary")
async def speech_item_to_dictionary(doc_id: str, n: int):
    """Promote change ``n`` to the pronunciation dictionary (document language)."""
    doc, _content = await asyncio.to_thread(_ready_content, doc_id)
    try:
        item = await asyncio.to_thread(reader_speech.get_item, doc_id, n)
    except reader_speech.SpeechItemNotFound:
        raise HTTPException(status_code=404, detail="Change not found") from None
    term = " ".join(str(item.get("original") or "").split())
    replacement = " ".join(str(item.get("spoken") or "").split())
    if not term or not replacement or len(term) > 200:
        raise HTTPException(status_code=400, detail="This change cannot go to the dictionary.")
    entry = await asyncio.to_thread(_save_pronunciation, term, replacement, doc.get("language"))
    return {"entry": entry}


@router.post("/reader/documents/{doc_id}/speech/preview/{index}")
async def preview_speech(doc_id: str, index: int, req: Optional[SpeechPreviewRequest] = None):
    """Render one segment plainly (``prepared: false``) or prepared — whether
    the option is on or not, ``item`` applied — to compare them. Same
    ``RenderResult`` as the render route; the document's voice is not changed."""
    req = req or SpeechPreviewRequest()
    doc, content = await asyncio.to_thread(_ready_content, doc_id)
    segments = content["segments"]
    if index < 0 or index >= len(segments):
        raise HTTPException(status_code=404, detail="Segment not found")
    voice, engine, language = _render_settings(doc, req)
    spoken = None
    if req.prepared:
        try:
            spoken = await asyncio.to_thread(reader_speech.preview_spoken, doc_id, content, index, req.item)
        except reader_speech.SpeechItemNotFound:
            raise HTTPException(status_code=404, detail="Change not found") from None
    try:
        result = await reader_render.render_segment(
            segments[index]["text"], voice=voice, engine=engine, language=language, spoken=spoken,
            num_step=req.num_step,
        )
    except Exception as exc:  # noqa: BLE001 — mapped to a typed HTTP error
        raise _render_error(exc) from None
    return {"segment": index, "voice": voice, "prepared": spoken is not None, **result}
