"""Reader synthesis: one segment → cached audio + word timings, and prerender.

Audio cache (docs/reader/SPEC.md)::

    <DATA_DIR>/reader/audio/<render_key>.mp3   (or .wav when no encoder)
    <DATA_DIR>/reader/audio/<render_key>.json  timings + duration

``render_key = sha1(engine|voice|language|final_text)`` where ``final_text`` is
what the engine actually synthesizes: the display text after
``normalize_for_tts`` and the pronunciation dictionary for the document
language (``services.pronunciation``). Content-addressed, so identical
sentences are shared across documents, a re-render of the same key is a cache
hit, and a new dictionary entry only invalidates the segments whose final text
it changes. The JSON is written last, so its presence means the entry is
complete. Speed is applied client-side; it is never part of the key.

Cache entries written before v2 were keyed by the *display* text
(``sha1(engine|voice|language|display_text)``) and synthesized from
``normalize_for_tts(display_text)``. They stay valid exactly when the
dictionary changes nothing in that segment (final text == what they were
synthesized from), so a miss on the final-text key falls back to the legacy
key in that case (:func:`_lookup`). Word timings are recomputed from the
stored voiced span whenever an entry is served for a display text other than
the one it was rendered for (two display texts can share one final text).

Synthesis reuses the streaming TTS path (``api.routers.tts_stream``): engine
resolution + routing gate + eviction via ``stream_engine_session`` and the
guarded GPU-pool dispatch of ``render_stream_sentence`` (mastered, normalized,
watermarked). Concurrent requests for one key share a single synthesis task.
"""
from __future__ import annotations

import asyncio
import functools
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

from services.reader_timing import distribute_words, voiced_span, word_timings

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


# ── Final (synthesized) text ─────────────────────────────────────────────────

#: ``((term, replacement), ...)`` in dictionary order — hashable for the memo.
Lexicon = tuple


def pronunciation_lexicon(language: Optional[str]) -> Lexicon:
    """The enabled respelling entries of VoiceStudio's pronunciation dictionary
    that apply to ``language`` (global ``*`` rows + that language's rows).

    Never raises: a missing table or locked DB means "no dictionary".
    """
    try:
        from services.pronunciation import entries_for_language, load_entries_from_db

        return tuple(entries_for_language(load_entries_from_db(), language).items())
    except Exception:  # noqa: BLE001 — pronunciation must never break reading
        logger.debug("Reader: pronunciation dictionary unavailable", exc_info=True)
        return ()


@functools.lru_cache(maxsize=32768)
def _normalized(text: str, language: Optional[str]) -> str:
    from services.text_normalization import normalize_for_tts

    return (normalize_for_tts(text, language) or "").strip()


@functools.lru_cache(maxsize=32768)
def _final_text(text: str, language: Optional[str], lexicon: Lexicon) -> str:
    from services.pronunciation import apply_inline_overrides, apply_lexicon

    out = _normalized(text, language)
    if lexicon:
        out = apply_lexicon(out, dict(lexicon))
    return apply_inline_overrides(out).strip()


def final_text(text: str, language: Optional[str], lexicon: Lexicon = ()) -> str:
    """What the engine synthesizes for a segment's display ``text``:
    ``normalize_for_tts`` first, then the pronunciation dictionary (and inline
    ``[[term|say]]`` overrides)."""
    return _final_text(text or "", language, tuple(lexicon or ()))


def clear_text_cache() -> None:
    _normalized.cache_clear()
    _final_text.cache_clear()


@dataclass(frozen=True)
class Spoken:
    """A prepared reading of one segment (``services.reader_speech``).

    ``pieces`` are ``(c0, c1, text, pause_ms_after)``: what to say for the
    display span ``[c0, c1)`` and the silence after it, in order and covering
    the whole display text; ``lead_ms`` is silence before the first piece.
    Each piece is synthesized on its own and the silences are inserted
    exactly; word timings stay on the display text.
    """

    pieces: tuple
    lead_ms: int = 0


@dataclass(frozen=True)
class SegmentPlan:
    """Cache addressing for one segment under one engine/voice/language."""

    text: str  # display text (word timings index into it)
    final: str  # synthesized text
    key: str  # sha1(engine|voice|language|final)
    legacy_key: Optional[str]  # pre-v2 key, when its entry would still be valid
    spoken: Optional[Spoken] = None  # prepared reading (pieces + silences)
    finals: tuple = ()  # final text of each spoken piece


def _spoken_plan(
    text: str, spoken: Spoken, *, engine_id: str, voice: Optional[str], language: Optional[str], lexicon: Lexicon
) -> SegmentPlan:
    """The plan of a prepared reading: every piece goes through the same
    ``final_text`` as plain text; the pauses are part of the final text, so
    the key differs from the plain reading's whenever the audio does."""
    finals = tuple(final_text(piece[2], language, lexicon) for piece in spoken.pieces)
    parts = [f"[pause {int(spoken.lead_ms)}ms]"] if spoken.lead_ms else []
    for piece, final in zip(spoken.pieces, finals):
        if final:
            parts.append(final)
        if piece[3]:
            parts.append(f"[pause {int(piece[3])}ms]")
    final = " ".join(parts)
    return SegmentPlan(
        text=text, final=final, key=render_key(engine_id, voice, language, final), legacy_key=None,
        spoken=spoken, finals=finals,
    )


def plan_segment(
    text: str,
    *,
    engine_id: str,
    voice: Optional[str],
    language: Optional[str],
    lexicon: Lexicon = (),
    spoken: Optional[Spoken] = None,
) -> SegmentPlan:
    if spoken is not None:
        return _spoken_plan(text, spoken, engine_id=engine_id, voice=voice, language=language, lexicon=lexicon)
    final = final_text(text, language, lexicon)
    key = render_key(engine_id, voice, language, final)
    # Pre-v2 entries were keyed by the display text and synthesized from its
    # normalization: still right when the dictionary changes nothing here.
    legacy = None
    if final == _normalized(text, language):
        legacy = render_key(engine_id, voice, language, text)
        if legacy == key:
            legacy = None
    return SegmentPlan(text=text, final=final, key=key, legacy_key=legacy)


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


def _load_entry(key: str) -> Optional[dict]:
    if not valid_key(key):
        return None
    try:
        with open(os.path.join(audio_dir(), f"{key}.json"), encoding="utf-8") as fh:
            entry = json.load(fh)
    except (OSError, ValueError):
        return None
    if not isinstance(entry, dict) or audio_file(key) is None:
        return None
    return entry


def cached_result(key: str) -> Optional[dict]:
    """The stored render for ``key`` (without ``segment``/``cached``), or None."""
    entry = _load_entry(key)
    return _public(entry) if entry is not None else None


def _entry_span(entry: dict) -> tuple[float, float]:
    span = entry.get("span")
    if isinstance(span, list) and len(span) == 2:
        return float(span[0]), float(span[1])
    words = entry.get("words") or []
    if words:
        return float(words[0]["start"]), float(words[-1]["end"])
    return 0.0, float(entry.get("duration_s") or 0.0)


def _for_display(entry: dict, rendered_text: str, display: str) -> dict:
    """The public result, with word timings for ``display`` when the entry
    was rendered for another display text with the same final text."""
    result = _public(entry)
    if rendered_text != display:
        start, end = _entry_span(entry)
        result["words"] = distribute_words(display, start, end)
    return result


def lookup(plan: SegmentPlan) -> Optional[dict]:
    """The cached render for a segment (``_public`` shape), or None.

    Tries the final-text key, then the pre-v2 display-text key when that entry
    is still valid (see the module docstring).
    """
    entry = _load_entry(plan.key)
    if entry is not None:
        synth = entry.get("synth_text")
        if synth is None:
            # Pre-v2 entry that happens to sit at this key: it was rendered for
            # display text == plan.final, from its normalization.
            if _normalized(plan.final, entry.get("language")) == plan.final:
                return _for_display(entry, plan.final, plan.text)
        elif synth == plan.final:
            return _for_display(entry, entry.get("text", plan.text), plan.text)
    if plan.legacy_key:
        entry = _load_entry(plan.legacy_key)
        if entry is not None and entry.get("synth_text") is None:
            return _for_display(entry, plan.text, plan.text)
    return None


def is_cached(plan: SegmentPlan) -> bool:
    """Cheap existence check matching :func:`lookup` (no word timings)."""
    folder = audio_dir()
    if os.path.isfile(os.path.join(folder, f"{plan.key}.json")):
        return True
    return bool(plan.legacy_key) and os.path.isfile(os.path.join(folder, f"{plan.legacy_key}.json"))


def store_render(
    key: str, text: str, samples: np.ndarray, sample_rate: int, meta: dict, timings: Optional[tuple] = None
) -> dict:
    """Encode + persist one render; returns the public result. Blocking.

    ``text`` is the display text the word timings index into; ``meta`` should
    carry ``synth_text`` (the final text) so later lookups can verify the key.
    ``timings`` (``(words, duration)``) replaces the estimate from the audio.
    """
    words, duration = timings if timings is not None else word_timings(text, samples, sample_rate)
    span = [words[0]["start"], words[-1]["end"]] if words else [0.0, duration]
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
        "span": span,
        "text": text,
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
    """``(mono float32 samples, sample_rate)`` for one segment's *final* text.

    ``text`` is already normalized and has the pronunciation dictionary
    applied (:func:`final_text`); it is rendered through the streaming path's
    guarded GPU-pool dispatch. Module seam for tests.
    """
    from api.routers.tts_stream import render_stream_sentence, stream_engine_session
    from services.model_manager import generate_timeout_s, run_on_gpu_pool_guarded

    normalized = (text or "").strip()
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


async def _synthesize_spoken(plan: SegmentPlan, voice, engine_id, language) -> tuple[np.ndarray, int, tuple]:
    """Audio of a prepared reading: each piece synthesized on its own, the
    silences inserted exactly, and word timings per piece (the display words
    of a piece spread over that piece's voiced audio)."""
    spoken = plan.spoken
    audios: list = []
    sample_rate = 0
    for final in plan.finals:
        if _SPEAKABLE_RE.search(final or ""):
            audio, sample_rate = await synthesize_segment(final, voice=voice, engine=engine_id, language=language)
            audios.append(np.asarray(audio, dtype=np.float32).reshape(-1))
        else:
            audios.append(None)
    sample_rate = int(sample_rate or SILENCE_SR)

    def silence(ms) -> np.ndarray:
        return np.zeros(int(round(int(ms) * sample_rate / 1000.0)), dtype=np.float32)

    chunks = [silence(spoken.lead_ms)]
    words: list = []
    offset = len(chunks[0])
    for (c0, c1, _text, pause_ms), audio in zip(spoken.pieces, audios):
        if audio is not None and len(audio):
            start, end = voiced_span(audio, sample_rate)
            chunks.append(audio)
        else:
            start = end = 0.0
        base = offset / float(sample_rate)
        for word in distribute_words(plan.text[c0:c1], base + start, base + end):
            words.append({**word, "c0": word["c0"] + c0, "c1": word["c1"] + c0})
        offset += len(audio) if audio is not None else 0
        pause = silence(pause_ms)
        chunks.append(pause)
        offset += len(pause)
    samples = np.concatenate(chunks)
    if all(audio is None for audio in audios):
        if not len(samples):
            samples = np.zeros(int(SILENCE_S * sample_rate), dtype=np.float32)
        return samples, sample_rate, word_timings(plan.text, samples, sample_rate)
    return samples, sample_rate, (words, round(len(samples) / float(sample_rate), 3))


async def _render_uncached(plan: SegmentPlan, voice, engine_id, language) -> tuple[dict, str]:
    meta = {"engine": engine_id, "voice": voice, "language": language, "synth_text": plan.final}
    if plan.spoken is not None:
        samples, sample_rate, timings = await _synthesize_spoken(plan, voice, engine_id, language)
        result = await asyncio.to_thread(store_render, plan.key, plan.text, samples, sample_rate, meta, timings)
    else:
        samples, sample_rate = await synthesize_segment(
            plan.final, voice=voice, engine=engine_id, language=language
        )
        result = await asyncio.to_thread(store_render, plan.key, plan.text, samples, sample_rate, meta)
    from services import reader_engine

    reader_engine.note_rendered(engine_id)
    return result, plan.text


async def render_segment(
    text: str,
    *,
    voice: Optional[str],
    engine: Optional[str],
    language: Optional[str],
    interactive: bool = True,
    lexicon: Optional[Lexicon] = None,
    spoken: Optional[Spoken] = None,
) -> dict:
    """``{render_key, audio_url, duration_s, words, cached}`` for one segment.

    ``text`` is the display text; the pronunciation dictionary for
    ``language`` is loaded unless ``lexicon`` is given. ``spoken`` (prepared
    reading) replaces what is said, never the display text. Cache hit → stored
    result. Otherwise one synthesis task per key; every concurrent caller
    awaits the same task (shielded, so a cancelled prerender never aborts a
    render an interactive request is waiting on).
    """
    engine_id = resolve_engine_id(engine)
    if lexicon is None:
        lexicon = await asyncio.to_thread(pronunciation_lexicon, language)
    plan = plan_segment(text, engine_id=engine_id, voice=voice, language=language, lexicon=lexicon, spoken=spoken)
    hit = await asyncio.to_thread(lookup, plan)
    if hit is not None:
        return {**hit, "cached": True}
    key = plan.key
    if interactive:
        _interactive["active"] += 1
    try:
        task = _inflight.get(key)
        if task is None or task.done():
            task = asyncio.ensure_future(_render_uncached(plan, voice, engine_id, language))
            _inflight[key] = task
            task.add_done_callback(lambda t, k=key: _inflight.pop(k, None) if _inflight.get(k) is t else None)
        result, rendered_for = await asyncio.shield(task)
    finally:
        if interactive:
            _interactive["active"] -= 1
    if rendered_for != text:
        # Same final text from another display text (shared synthesis):
        # timings must index into this segment's own text.
        result = await asyncio.to_thread(lookup, plan) or result
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
    variant: str = ""  # what is said (prepared reading on/off): a change restarts the job

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


async def _prerender_loop(job: PrerenderJob, texts: list[str], order: list[int], spoken: Optional[list] = None) -> None:
    try:
        lexicon = await asyncio.to_thread(pronunciation_lexicon, job.language)
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
                lexicon=lexicon,
                spoken=spoken[index] if spoken else None,
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
    spoken: Optional[list] = None,
    variant: str = "",
) -> dict:
    """Start (or continue) the background prerender of a document.

    Renders every segment, starting at ``from_segment`` and wrapping around,
    sequentially. A running job with the same voice/engine/language (and
    ``variant``: the prepared reading, ``spoken[i]`` per segment) is left
    alone; different settings cancel it and start over.
    """
    engine_id = resolve_engine_id(engine)
    current = _jobs.get(doc_id)
    if current and current.running:
        if (current.voice, current.engine, current.language, current.variant) == (voice, engine_id, language, variant):
            return current.status()
        cancel_prerender(doc_id)
    total = len(texts)
    start = max(0, min(int(from_segment or 0), max(total - 1, 0)))
    order = list(range(start, total)) + list(range(0, start))
    job = PrerenderJob(doc_id=doc_id, voice=voice, engine=engine_id, language=language, total=total, variant=variant)
    job.task = asyncio.ensure_future(_prerender_loop(job, texts, order, spoken))
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


def cached_count(texts: list[str], *, voice, engine, language, spoken: Optional[list] = None) -> int:
    """How many of ``texts`` already have a complete cached render."""
    engine_id = resolve_engine_id(engine)
    lexicon = pronunciation_lexicon(language)
    count = 0
    for index, text in enumerate(texts):
        plan = plan_segment(
            text, engine_id=engine_id, voice=voice, language=language, lexicon=lexicon,
            spoken=spoken[index] if spoken else None,
        )
        if is_cached(plan):
            count += 1
    return count
