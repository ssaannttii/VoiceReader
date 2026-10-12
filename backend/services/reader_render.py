"""Reader synthesis: one segment → cached audio + word timings, and prerender.

Audio cache (docs/reader/SPEC.md)::

    <DATA_DIR>/reader/audio/<render_key>.mp3   (or .wav when no encoder)
    <DATA_DIR>/reader/audio/<render_key>.json  timings + duration

``render_key = sha1(engine|voice|language|segment_text)`` — content-addressed,
so identical sentences are shared across documents and a re-render of the same
key is a cache hit. The JSON is written last, so its presence means the entry
is complete. Speed is applied client-side; it is never part of the key.

Synthesis reuses the streaming TTS path (``api.routers.tts_stream``): engine
resolution + routing gate + eviction via ``stream_engine_session`` and the
guarded GPU-pool dispatch of ``render_stream_sentence`` (mastered, normalized,
watermarked). Concurrent requests for one key share a single synthesis task.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import subprocess
import time
import uuid
import wave
from dataclasses import dataclass, field
from typing import Optional

import numpy as np

from services.reader_timing import word_timings

logger = logging.getLogger("omnivoice.reader")

_KEY_RE = re.compile(r"^[0-9a-f]{40}$")
_SPEAKABLE_RE = re.compile(r"\w", re.UNICODE)
MEDIA_TYPES = {"mp3": "audio/mpeg", "wav": "audio/wav"}
#: A segment with nothing to pronounce ("* * *", "—") renders as a short pause.
SILENCE_S = 0.4
SILENCE_SR = 24000
MP3_BITRATE = "64k"


# ── Paths / keys ─────────────────────────────────────────────────────────────


def audio_dir() -> str:
    from services.reader_store import reader_dir

    return os.path.join(reader_dir(), "audio")


def valid_key(key: str) -> bool:
    return bool(_KEY_RE.match(key or ""))


def render_key(engine: str, voice: Optional[str], language: Optional[str], text: str) -> str:
    raw = f"{engine or ''}|{voice or ''}|{language or ''}|{text}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()  # noqa: S324 — cache key, not security


def resolve_engine_id(engine: Optional[str]) -> str:
    if engine:
        return engine
    from services import tts_backend

    return tts_backend.active_backend_id()


def audio_file(key: str) -> Optional[tuple[str, str]]:
    """``(path, media_type)`` of a cached render, or ``None``."""
    if not valid_key(key):
        return None
    for fmt in ("mp3", "wav"):
        path = os.path.join(audio_dir(), f"{key}.{fmt}")
        if os.path.isfile(path):
            return path, MEDIA_TYPES[fmt]
    return None


# ── Encoder ──────────────────────────────────────────────────────────────────

_ffmpeg_cache: dict = {"path": None, "checked_at": 0.0}
_FFMPEG_RECHECK_S = 60.0


def ffmpeg_path() -> Optional[str]:
    """The managed ffmpeg (``services.ffmpeg_utils.find_ffmpeg``), cached.

    A hit is kept for the process; a miss is re-checked at most once a minute
    so an ffmpeg acquired later (Settings → Audio tools) is picked up.
    """
    if _ffmpeg_cache["path"]:
        return _ffmpeg_cache["path"]
    now = time.monotonic()
    if _ffmpeg_cache["checked_at"] and now - _ffmpeg_cache["checked_at"] < _FFMPEG_RECHECK_S:
        return None
    _ffmpeg_cache["checked_at"] = now
    try:
        from services.ffmpeg_utils import find_ffmpeg

        _ffmpeg_cache["path"] = find_ffmpeg()
    except Exception:  # noqa: BLE001 — no encoder means WAV, never an error
        logger.debug("ffmpeg lookup failed", exc_info=True)
        _ffmpeg_cache["path"] = None
    return _ffmpeg_cache["path"]


def audio_format() -> str:
    return "mp3" if ffmpeg_path() else "wav"


def _write_wav(path: str, samples: np.ndarray, sample_rate: int) -> None:
    pcm = (np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2")
    with wave.open(path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(int(sample_rate))
        wf.writeframes(pcm.tobytes())


def _encode_mp3(ffmpeg: str, wav_path: str, mp3_path: str) -> None:
    from services.ffmpeg_utils import local_inputs_only

    cmd = local_inputs_only(
        [
            ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
            "-i", wav_path, "-ac", "1", "-c:a", "libmp3lame", "-b:a", MP3_BITRATE,
            "-f", "mp3", mp3_path,
        ],
        tool="ffmpeg",
    )
    subprocess.run(
        cmd,
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        timeout=120,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )


def _public(entry: dict) -> dict:
    return {
        "render_key": entry["render_key"],
        "audio_url": f"/reader/audio/{entry['render_key']}",
        "duration_s": entry["duration_s"],
        "words": entry["words"],
    }


def cached_result(key: str) -> Optional[dict]:
    """The stored render for ``key`` (without ``segment``/``cached``), or None."""
    if not valid_key(key):
        return None
    try:
        with open(os.path.join(audio_dir(), f"{key}.json"), encoding="utf-8") as fh:
            entry = json.load(fh)
    except (OSError, ValueError):
        return None
    if audio_file(key) is None:
        return None
    return _public(entry)


def store_render(key: str, text: str, samples: np.ndarray, sample_rate: int, meta: dict) -> dict:
    """Encode + persist one render; returns the public result. Blocking."""
    words, duration = word_timings(text, samples, sample_rate)
    folder = audio_dir()
    os.makedirs(folder, exist_ok=True)
    nonce = uuid.uuid4().hex[:8]
    tmp_wav = os.path.join(folder, f"{key}.{nonce}.wav.tmp")
    fmt = "wav"
    _write_wav(tmp_wav, samples, sample_rate)
    try:
        ffmpeg = ffmpeg_path()
        if ffmpeg:
            tmp_mp3 = os.path.join(folder, f"{key}.{nonce}.mp3.tmp")
            try:
                _encode_mp3(ffmpeg, tmp_wav, tmp_mp3)
                os.replace(tmp_mp3, os.path.join(folder, f"{key}.mp3"))
                fmt = "mp3"
            except (OSError, subprocess.SubprocessError) as exc:
                logger.warning("Reader: MP3 encode failed (%s); storing WAV", exc)
                try:
                    os.remove(tmp_mp3)
                except OSError:
                    pass
        if fmt == "wav":
            os.replace(tmp_wav, os.path.join(folder, f"{key}.wav"))
    finally:
        if os.path.exists(tmp_wav):
            os.remove(tmp_wav)
    entry = {
        "render_key": key,
        "format": fmt,
        "duration_s": duration,
        "sample_rate": int(sample_rate),
        "words": words,
        "created_at": time.time(),
        **meta,
    }
    tmp_json = os.path.join(folder, f"{key}.{nonce}.json.tmp")
    with open(tmp_json, "w", encoding="utf-8") as fh:
        json.dump(entry, fh, ensure_ascii=False)
    os.replace(tmp_json, os.path.join(folder, f"{key}.json"))
    return _public(entry)


# ── Synthesis ────────────────────────────────────────────────────────────────


def _to_mono(wav) -> np.ndarray:
    if hasattr(wav, "detach"):
        wav = wav.detach().to("cpu").float().numpy()
    audio = np.asarray(wav, dtype=np.float32)
    if audio.ndim == 2:
        audio = audio[0] if audio.shape[0] <= audio.shape[1] else audio[:, 0]
    return audio.reshape(-1)


async def synthesize_segment(
    text: str, *, voice: Optional[str], engine: Optional[str], language: Optional[str]
) -> tuple[np.ndarray, int]:
    """``(mono float32 samples, sample_rate)`` for one segment's display text.

    Normalized once here (``normalize_for_tts``), then rendered through the
    streaming path's guarded GPU-pool dispatch. Module seam for tests.
    """
    import functools

    from api.routers.tts_stream import render_stream_sentence, stream_engine_session
    from services.model_manager import generate_timeout_s, run_on_gpu_pool_guarded
    from services.text_normalization import normalize_for_tts

    normalized = (normalize_for_tts(text, language) or "").strip()
    if not _SPEAKABLE_RE.search(normalized):
        return np.zeros(int(SILENCE_S * SILENCE_SR), dtype=np.float32), SILENCE_SR
    async with stream_engine_session(engine, voice=voice, language=language) as (backend, kw):
        wav, sample_rate, _synth_s = await run_on_gpu_pool_guarded(
            functools.partial(render_stream_sentence, backend, kw, normalized),
            what="Reader TTS",
            timeout=generate_timeout_s(normalized, engine=backend),
        )
    return _to_mono(wav), int(sample_rate)


_inflight: dict[str, asyncio.Task] = {}
_interactive = {"active": 0}


async def _render_uncached(key, text, voice, engine_id, language) -> dict:
    samples, sample_rate = await synthesize_segment(
        text, voice=voice, engine=engine_id, language=language
    )
    meta = {"engine": engine_id, "voice": voice, "language": language}
    return await asyncio.to_thread(store_render, key, text, samples, sample_rate, meta)


async def render_segment(
    text: str,
    *,
    voice: Optional[str],
    engine: Optional[str],
    language: Optional[str],
    interactive: bool = True,
) -> dict:
    """``{render_key, audio_url, duration_s, words, cached}`` for one segment.

    Cache hit → stored result. Otherwise one synthesis task per key; every
    concurrent caller awaits the same task (shielded, so a cancelled prerender
    never aborts a render an interactive request is waiting on).
    """
    engine_id = resolve_engine_id(engine)
    key = render_key(engine_id, voice, language, text)
    hit = cached_result(key)
    if hit is not None:
        return {**hit, "cached": True}
    if interactive:
        _interactive["active"] += 1
    try:
        task = _inflight.get(key)
        if task is None or task.done():
            task = asyncio.ensure_future(_render_uncached(key, text, voice, engine_id, language))
            _inflight[key] = task
            task.add_done_callback(lambda t, k=key: _inflight.pop(k, None) if _inflight.get(k) is t else None)
        result = await asyncio.shield(task)
    finally:
        if interactive:
            _interactive["active"] -= 1
    return {**result, "cached": False}


# ── Prerender ────────────────────────────────────────────────────────────────


@dataclass
class PrerenderJob:
    doc_id: str
    voice: Optional[str]
    engine: Optional[str]
    language: Optional[str]
    total: int
    done: int = 0
    running: bool = True
    error: Optional[str] = None
    task: Optional[asyncio.Task] = field(default=None, repr=False)

    def status(self) -> dict:
        return {
            "running": self.running,
            "done": self.done,
            "total": self.total,
            "error": self.error,
            "voice": self.voice,
            "engine": self.engine,
        }


_jobs: dict[str, PrerenderJob] = {}
#: How long prerender waits between polls while interactive renders run.
_YIELD_POLL_S = 0.05


def _public_error(exc: BaseException) -> str:
    try:
        from core.scrub import scrub_text

        return scrub_text(str(exc)) or exc.__class__.__name__
    except Exception:  # noqa: BLE001
        return exc.__class__.__name__


async def _prerender_loop(job: PrerenderJob, texts: list[str], order: list[int]) -> None:
    try:
        for index in order:
            # Interactive renders go first: never queue a prerender segment in
            # front of the sentence the listener is waiting for.
            while _interactive["active"] > 0:
                await asyncio.sleep(_YIELD_POLL_S)
            await render_segment(
                texts[index],
                voice=job.voice,
                engine=job.engine,
                language=job.language,
                interactive=False,
            )
            job.done += 1
    except asyncio.CancelledError:
        job.running = False
        raise
    except Exception as exc:  # noqa: BLE001 — surfaced through the status
        logger.warning("Reader prerender of %s stopped: %s", job.doc_id, exc)
        job.error = _public_error(exc)
    finally:
        job.running = False


def start_prerender(
    doc_id: str,
    texts: list[str],
    *,
    voice: Optional[str],
    engine: Optional[str],
    language: Optional[str],
    from_segment: int = 0,
) -> dict:
    """Start (or continue) the background prerender of a document.

    Renders every segment, starting at ``from_segment`` and wrapping around,
    sequentially. A running job with the same voice/engine/language is left
    alone; different settings cancel it and start over.
    """
    engine_id = resolve_engine_id(engine)
    current = _jobs.get(doc_id)
    if current and current.running:
        if (current.voice, current.engine, current.language) == (voice, engine_id, language):
            return current.status()
        cancel_prerender(doc_id)
    total = len(texts)
    start = max(0, min(int(from_segment or 0), max(total - 1, 0)))
    order = list(range(start, total)) + list(range(0, start))
    job = PrerenderJob(doc_id=doc_id, voice=voice, engine=engine_id, language=language, total=total)
    job.task = asyncio.ensure_future(_prerender_loop(job, texts, order))
    _jobs[doc_id] = job
    return job.status()


def prerender_status(doc_id: str) -> Optional[dict]:
    job = _jobs.get(doc_id)
    return job.status() if job else None


def cancel_prerender(doc_id: str) -> Optional[dict]:
    job = _jobs.get(doc_id)
    if job is None:
        return None
    if job.task is not None and not job.task.done():
        job.task.cancel()
    job.running = False
    return job.status()


def forget_prerender(doc_id: str) -> None:
    cancel_prerender(doc_id)
    _jobs.pop(doc_id, None)


def cached_count(texts: list[str], *, voice, engine, language) -> int:
    """How many of ``texts`` already have a complete cached render."""
    engine_id = resolve_engine_id(engine)
    folder = audio_dir()
    count = 0
    for text in texts:
        key = render_key(engine_id, voice, language, text)
        if os.path.isfile(os.path.join(folder, f"{key}.json")):
            count += 1
    return count
