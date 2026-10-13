"""Background-music engine for the Reader: Stable Audio Open 1.0 in its own venv.

The model never loads inside the backend. ``scripts/reader/music_worker.py`` runs
as a **subprocess** with the Python of a separate venv (torch + diffusers +
soundfile + scipy), so its heavy dependencies never enter the backend venv:

* ``$OMNIVOICE_MUSIC_PYTHON`` — that venv's python (default: the spike venv
  ``E:\\VoiceReaderData\\engines\\music-spike\\ace-step-1.5\\.venv`` when it exists);
* ``$OMNIVOICE_MUSIC_HF_HOME`` — the Hugging Face home holding the (gated) weights
  (default: ``E:\\VoiceReaderData\\hf_cache`` when it exists, else ``$HF_HOME``);
  the worker runs offline and never downloads;
* ``$OMNIVOICE_MUSIC_MODEL`` — a local diffusers folder instead of the repo id;
* ``$OMNIVOICE_MUSIC_DIR`` — where cues are written (default ``<data dir>/reader/music``).

**GPU etiquette.** Music never competes with the voice: :class:`IdleGate` waits
until no Reader render, prerender, warm-up, model load or GPU-pool job has run
for a while; the TTS models are unloaded through the official lifecycle path
(``model_lifecycle.unload``, as ``POST /model/unload/{id}`` does) before the
worker starts; and the worker is killed as soon as the voice needs the GPU
again (finished clips are kept; the rest resume later). The worker runs at
below-normal priority and refuses to start without enough free VRAM.
"""
from __future__ import annotations

import asyncio
import atexit
import json
import logging
import os
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from typing import Callable, Optional

logger = logging.getLogger("omnivoice.reader")

ENV_PYTHON = "OMNIVOICE_MUSIC_PYTHON"
ENV_DIR = "OMNIVOICE_MUSIC_DIR"
ENV_HF_HOME = "OMNIVOICE_MUSIC_HF_HOME"
ENV_MODEL = "OMNIVOICE_MUSIC_MODEL"
ENV_STEPS = "OMNIVOICE_MUSIC_STEPS"
ENV_IDLE = "OMNIVOICE_MUSIC_IDLE_S"
ENV_MIN_FREE = "OMNIVOICE_MUSIC_MIN_FREE_GB"

MODEL_REPO = "stabilityai/stable-audio-open-1.0"
#: Where the spike installed the engine on the owner's PC (used only when present).
_LOCAL_PYTHON = r"E:\VoiceReaderData\engines\music-spike\ace-step-1.5\.venv\Scripts\python.exe"
_LOCAL_HF_HOME = r"E:\VoiceReaderData\hf_cache"

JOB_VERSION = 1
#: Stable Audio Open renders at most ~47.5 s per clip.
CLIP_SECONDS = 47.0
DEFAULT_STEPS = 100
GUIDANCE = 7.0
BITRATE_KBPS = 64
FADE_IN_S = 2.0
FADE_OUT_S = 4.0
#: SAO peaks at ~5.5 GB allocated (more reserved during the VAE decode).
DEFAULT_MIN_FREE_GB = 6.0
#: Seconds without any TTS activity before music may take the GPU.
DEFAULT_IDLE_S = 90.0

EXIT_OK, EXIT_CRASH, EXIT_BAD_JOB, EXIT_RESOURCES = 0, 1, 2, 3


# ── Configuration ────────────────────────────────────────────────────────────


def music_python() -> Optional[str]:
    custom = os.environ.get(ENV_PYTHON, "").strip()
    if custom:
        return os.path.abspath(os.path.expanduser(custom))
    return _LOCAL_PYTHON if sys.platform == "win32" and os.path.isfile(_LOCAL_PYTHON) else None


def music_dir() -> str:
    custom = os.environ.get(ENV_DIR, "").strip()
    if custom:
        return os.path.abspath(os.path.expanduser(custom))
    from services import reader_store

    return os.path.join(reader_store.reader_dir(), "music")


def hf_home() -> Optional[str]:
    custom = os.environ.get(ENV_HF_HOME, "").strip()
    if custom:
        return os.path.abspath(os.path.expanduser(custom))
    if os.path.isdir(_LOCAL_HF_HOME):
        return _LOCAL_HF_HOME
    return os.environ.get("HF_HOME") or None


def model_ref() -> str:
    return os.environ.get(ENV_MODEL, "").strip() or MODEL_REPO


def _float_env(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, "") or default)
    except ValueError:
        return default


def steps() -> int:
    return max(20, min(200, int(_float_env(ENV_STEPS, DEFAULT_STEPS))))


def worker_script() -> str:
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.normpath(os.path.join(here, "..", "..", "scripts", "reader", "music_worker.py"))


def weights_present() -> bool:
    """The diffusers weights are on disk (a local folder, or the HF cache snapshot)."""
    ref = model_ref()
    if os.path.isdir(ref):
        return os.path.isfile(os.path.join(ref, "model_index.json"))
    home = hf_home()
    if not home or "/" not in ref:
        return False
    org, name = ref.split("/", 1)
    snapshots = os.path.join(home, "hub", f"models--{org}--{name}", "snapshots")
    try:
        revisions = os.listdir(snapshots)
    except OSError:
        return False
    for rev in revisions:
        folder = os.path.join(snapshots, rev)
        if os.path.isfile(os.path.join(folder, "model_index.json")) and all(
            os.path.isdir(os.path.join(folder, sub)) for sub in ("transformer", "vae", "text_encoder")
        ):
            return True
    return False


def engine_available() -> bool:
    """A music python is configured and exists, and the weights are present."""
    python = music_python()
    return bool(python and os.path.isfile(python) and os.path.isfile(worker_script()) and weights_present())


# ── Candidate choice (QC metrics from the worker) ───────────────────────────

#: (metric, allowed value, penalty per unit above it) — what made a spike clip
#: unfit to sit under a voice: drums, busy or regular onsets, sudden hits,
#: vocal-like modulation, swells and a drone dying out.
_LIMITS = (
    ("percussive_ratio", 0.15, 10.0),
    ("onsets_per_s", 0.8, 2.0),
    ("pulse_autocorr", 0.40, 10.0),
    ("hits_per_min", 3.0, 0.3),
    ("syllabic_mod_db", 2.5, 3.0),
    ("lra_lu", 8.0, 0.5),
    ("st_max_minus_median", 4.0, 0.7),
    ("decay_db", 6.0, 0.4),
)


def penalty(metrics: Optional[dict]) -> float:
    """How unfit a clip is as quiet underscore (0 = no flag)."""
    if not isinstance(metrics, dict):
        return float("inf")
    total = 0.0
    for key, limit, weight in _LIMITS:
        try:
            value = float(metrics.get(key) or 0.0)
        except (TypeError, ValueError):
            continue
        total += max(0.0, value - limit) * weight
    try:
        duration = float(metrics.get("duration") or 0.0)
    except (TypeError, ValueError):
        duration = 0.0
    total += max(0.0, 38.0 - duration) * 0.3  # ended early (trimmed tail)
    try:
        lra = float(metrics.get("lra_lu", 3.0))
    except (TypeError, ValueError):
        lra = 3.0
    if lra < 1.0:
        total += 1.0  # completely static: hiss or rumble rather than music
    return round(total, 3)


def pick_candidate(candidates: list[Optional[dict]]) -> int:
    """Index of the best candidate (lowest penalty; the first on ties)."""
    scores = [penalty(c) for c in candidates]
    return min(range(len(scores)), key=lambda i: (scores[i], i))


# ── Jobs ─────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Clip:
    id: str
    prompt: str
    seed: int
    out: str
    seconds: float = CLIP_SECONDS


def build_job(clips: list[Clip], result_path: str, *, ffmpeg: Optional[str] = None) -> dict:
    """The JSON job the worker reads (see ``scripts/reader/music_worker.py``)."""
    from services.reader_music import LEVEL_LUFS

    return {
        "version": JOB_VERSION,
        "model": model_ref(),
        "steps": steps(),
        "guidance": GUIDANCE,
        "dtype": "float16",
        "min_free_gb": _float_env(ENV_MIN_FREE, DEFAULT_MIN_FREE_GB),
        "level_lufs": LEVEL_LUFS,
        "bitrate_kbps": BITRATE_KBPS,
        "fade_in_s": FADE_IN_S,
        "fade_out_s": FADE_OUT_S,
        "ffmpeg": ffmpeg,
        "parent_pid": os.getpid(),
        "result": result_path,
        "clips": [
            {"id": c.id, "prompt": c.prompt, "seed": int(c.seed), "seconds": float(c.seconds), "out": c.out}
            for c in clips
        ],
    }


def worker_env() -> dict:
    """The worker's environment: offline, its own HF home, nothing of the backend venv."""
    env = {k: v for k, v in os.environ.items() if k not in ("PYTHONPATH", "PYTHONHOME", "VIRTUAL_ENV")}
    home = hf_home()
    if home:
        env["HF_HOME"] = home
        env.pop("HF_HUB_CACHE", None)
    env.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", PYTHONIOENCODING="utf-8", PYTHONNOUSERSITE="1")
    return env


def _creation_kwargs() -> dict:
    if sys.platform == "win32":
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000) | getattr(
            subprocess, "BELOW_NORMAL_PRIORITY_CLASS", 0x00004000
        )
        return {"creationflags": flags}
    return {"preexec_fn": lambda: os.nice(10)}  # noqa: PLW1509 — only lowers priority


@dataclass
class Outcome:
    #: ``done`` | ``yielded`` (stopped for the voice or a cancel) | ``resources`` | ``failed``
    status: str
    results: dict = field(default_factory=dict)
    reason: Optional[str] = None


_current: dict = {"proc": None}
_current_lock = threading.Lock()


def _kill(proc) -> None:
    try:
        proc.kill()
    except Exception:  # noqa: BLE001
        pass
    try:
        proc.wait(timeout=15)
    except Exception:  # noqa: BLE001
        pass


def kill_current() -> None:
    """Stop the running worker (backend shutdown)."""
    with _current_lock:
        proc = _current["proc"]
    if proc is not None and proc.poll() is None:
        _kill(proc)


atexit.register(kill_current)


def _read_result(path: str) -> dict:
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _log_tail(path: str, limit: int = 600) -> str:
    try:
        with open(path, "rb") as fh:
            fh.seek(0, os.SEEK_END)
            size = fh.tell()
            fh.seek(max(0, size - 4000))
            text = fh.read().decode("utf-8", "replace")
    except OSError:
        return ""
    lines = [line for line in text.splitlines() if line.strip()]
    return "\n".join(lines[-4:])[-limit:]


def run_worker(
    clips: list[Clip],
    work_dir: str,
    *,
    should_stop: Callable[[], Optional[str]] = lambda: None,
    popen: Callable = subprocess.Popen,
    poll_s: float = 0.5,
    ffmpeg: Optional[str] = None,
) -> Outcome:
    """Render ``clips`` with the worker. Finished clips are returned even when
    the worker is stopped (``should_stop`` returned a reason) or crashes; a crash
    is retried once (again whenever the previous attempt made progress)."""
    python = music_python()
    if not python:
        return Outcome("failed", reason="no music python")
    os.makedirs(work_dir, exist_ok=True)
    job_path = os.path.join(work_dir, "_job.json")
    result_path = os.path.join(work_dir, "_result.json")
    log_path = os.path.join(work_dir, "worker.log")
    results: dict = {}
    remaining = list(clips)
    failures = 0
    while remaining:
        job = build_job(remaining, result_path, ffmpeg=ffmpeg)
        with open(job_path, "w", encoding="utf-8") as fh:
            json.dump(job, fh, ensure_ascii=False)
        try:
            os.remove(result_path)
        except OSError:
            pass
        if os.path.isfile(log_path) and os.path.getsize(log_path) > 2_000_000:
            os.replace(log_path, log_path + ".1")
        stopped = None
        started = time.monotonic()
        with open(log_path, "ab") as log:
            try:
                proc = popen(
                    [python, worker_script(), job_path],
                    stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                    env=worker_env(), cwd=work_dir, **_creation_kwargs(),
                )
            except OSError as exc:
                return Outcome("failed", results, f"cannot start the music worker: {exc}")
            with _current_lock:
                _current["proc"] = proc
            try:
                while proc.poll() is None:
                    stopped = should_stop()
                    if stopped:
                        _kill(proc)
                        break
                    time.sleep(poll_s)
            finally:
                with _current_lock:
                    _current["proc"] = None
        data = _read_result(result_path)
        progressed = False
        for clip in remaining:
            record = (data.get("clips") or {}).get(clip.id)
            if isinstance(record, dict) and record.get("ok") and os.path.isfile(clip.out):
                results[clip.id] = record
                progressed = True
        remaining = [c for c in remaining if c.id not in results]
        logger.info(
            "Reader music: worker rendered %d clip(s) in %.0f s%s",
            sum(1 for c in clips if c.id in results), time.monotonic() - started,
            f" (stopped: {stopped})" if stopped else "",
        )
        if stopped:
            return Outcome("yielded", results, stopped)
        code = proc.returncode
        if code == EXIT_RESOURCES:
            return Outcome("resources", results, str(data.get("error") or "resources"))
        if not remaining:
            break
        failures = 0 if progressed else failures + 1
        if failures >= 2 or code == EXIT_BAD_JOB:
            reason = data.get("error") or _first_clip_error(data) or _log_tail(log_path) or f"exit code {code}"
            return Outcome("failed", results, str(reason)[:300])
        logger.warning("Reader music: worker exited with %s; retrying %d clip(s)", code, len(remaining))
    return Outcome("done", results)


def _first_clip_error(data: dict) -> Optional[str]:
    for record in (data.get("clips") or {}).values():
        if isinstance(record, dict) and not record.get("ok") and record.get("error"):
            return str(record["error"])
    return None


# ── GPU etiquette ────────────────────────────────────────────────────────────


def tts_busy_reason(idle_s: Optional[float] = None) -> Optional[str]:
    """Why the voice may need the GPU now (None when it has been idle).

    Reads in-process state only (never imports a module the backend has not
    loaded): interactive renders and prerender jobs, a Reader warm-up, a model
    load, VoiceStudio's GPU pool, and a Reader render within ``idle_s``."""
    grace = _float_env(ENV_IDLE, DEFAULT_IDLE_S) if idle_s is None else idle_s
    render = sys.modules.get("services.reader_render")
    if render is not None:
        if getattr(render, "_interactive", {}).get("active", 0) > 0:
            return "render"
        if any(not t.done() for t in list(getattr(render, "_inflight", {}).values())):
            return "render"
        if any(getattr(job, "running", False) for job in list(getattr(render, "_jobs", {}).values())):
            return "prerender"
    engine = sys.modules.get("services.reader_engine")
    if engine is not None:
        state = getattr(engine, "_state", {})
        task = state.get("task")
        if task is not None and not task.done():
            return "warmup"
        ready_at = state.get("ready_at")
        if ready_at and time.time() - float(ready_at) < grace:
            return "recent render"
    mm = sys.modules.get("services.model_manager")
    if mm is not None:
        try:
            if mm.get_model_status().get("loading"):
                return "model loading"
        except Exception:  # noqa: BLE001
            pass
        pool = getattr(mm, "_gpu_pool_singleton", None)
        stats = getattr(pool, "stats", None)
        if callable(stats):
            try:
                found = stats()
                if int(found.get("running") or 0) or int(found.get("queued") or 0):
                    return "gpu job"
            except Exception:  # noqa: BLE001
                pass
    return None


class IdleGate:
    """Idle = the probe has said "not busy" for ``settle_s`` in a row (renders
    between sentences leave short gaps that must not count as idle)."""

    def __init__(self, probe: Callable[[], Optional[str]], settle_s: float = 10.0, clock: Callable[[], float] = time.monotonic):
        self.probe = probe
        self.settle_s = settle_s
        self.clock = clock
        self._quiet_since: Optional[float] = None

    def busy(self) -> Optional[str]:
        """The probe's reason, remembered so idleness restarts its count."""
        reason = self.probe()
        if reason:
            self._quiet_since = None
        return reason

    def idle(self) -> bool:
        if self.busy():
            return False
        now = self.clock()
        if self._quiet_since is None:
            self._quiet_since = now
        return now - self._quiet_since >= self.settle_s


_loop: dict = {"loop": None}


def bind_loop(loop: asyncio.AbstractEventLoop) -> None:
    """The backend's event loop (the model lifecycle is async and loop-bound)."""
    _loop["loop"] = loop


async def _unload_tts_models() -> list[str]:
    from services import model_lifecycle

    ids = ["tts"]
    try:
        loaded = await asyncio.to_thread(model_lifecycle.list_loaded)
        ids += [m["id"] for m in loaded.get("models") or [] if str(m.get("id", "")).startswith(("engine:", "active-engine:"))]
    except Exception:  # noqa: BLE001
        logger.debug("Reader music: loaded-model inventory unavailable", exc_info=True)
    released = []
    for model_id in dict.fromkeys(ids):
        try:
            outcome = await model_lifecycle.unload(model_id)
        except Exception:  # noqa: BLE001
            logger.debug("Reader music: could not unload %s", model_id, exc_info=True)
            continue
        if outcome.get("success"):
            released.append(model_id)
    try:
        model_lifecycle.free_vram()
    except Exception:  # noqa: BLE001
        pass
    return released


def unload_tts(timeout: float = 120.0) -> list[str]:
    """Unload the TTS models (official lifecycle path) from a background thread."""
    loop = _loop["loop"]
    if loop is None or loop.is_closed() or not loop.is_running():
        return []
    try:
        released = asyncio.run_coroutine_threadsafe(_unload_tts_models(), loop).result(timeout=timeout)
    except Exception:  # noqa: BLE001
        logger.warning("Reader music: unloading the voice model failed", exc_info=True)
        return []
    if released:
        logger.info("Reader music: unloaded %s to free the GPU for music", ", ".join(released))
    return released
