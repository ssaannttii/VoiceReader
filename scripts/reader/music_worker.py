"""Background-music worker for the Reader (docs/reader/SPEC.md, "Background music").

Runs **outside the backend venv**, with the Python of a venv that has torch +
diffusers (``StableAudioPipeline``) + soundfile + scipy (``$OMNIVOICE_MUSIC_PYTHON``),
so none of those heavy dependencies enter the backend. The backend
(``backend/services/reader_music_engine.py``) writes a job and runs::

    <music python> music_worker.py <job.json>

Job: ``{"version": 1, "model", "steps", "guidance", "dtype", "min_free_gb",
"level_lufs", "bitrate_kbps", "fade_in_s", "fade_out_s", "ffmpeg"?, "parent_pid"?,
"result", "clips": [{"id", "prompt", "seed", "seconds", "out"}]}``.

The model is loaded once; every clip is rendered (Stable Audio Open 1.0, fp16,
no negative prompt — negative prompts collapsed the output into a dying drone
in the spike), resampled to 48 kHz, measured on the raw audio (QC metrics, so
the backend can pick the better of two seeds), post-processed for listening
under a narrator — 40 Hz high-pass, mono below 150 Hz, side × 0.7, a −5 dB dip
around 2 kHz (≈ 1–4 kHz, the voice's presence band) and −2 dB at 7 kHz,
the job's level (−24 LUFS: the client attenuates to the listener's level),
a soft limiter 18 dB above it (≈ −6 dBFS), short equal-power fades so clips
can be crossfaded — and encoded as Ogg Opus (~64 kb/s stereo) with soundfile (ffmpeg
when the job names one and soundfile cannot).

The result JSON is rewritten after every clip, so a killed worker (the backend
yields the GPU to the voice) keeps what it finished::

    {"version": 1, "done": bool, "error": str|null, "device", "load_seconds",
     "clips": {id: {"ok": true, "out", "duration", "gen_seconds", "vram_peak_gb",
                    "metrics": {...}} | {"ok": false, "error"}}}

Exit codes: 0 finished (individual clips may still have failed), 2 bad job,
3 resources (no CUDA or not enough free VRAM — try later), 1 anything else.
"""
from __future__ import annotations

import json
import math
import os
import subprocess
import sys
import time
import traceback

EXIT_OK, EXIT_CRASH, EXIT_BAD_JOB, EXIT_RESOURCES = 0, 1, 2, 3
SR = 48000


# ── Loudness (ITU-R BS.1770 K-weighting, the same filters pyloudnorm uses) ──


def _biquad_high_shelf(sr: int, gain_db: float = 4.0, q: float = 1 / math.sqrt(2), fc: float = 1500.0):
    import numpy as np

    a = 10 ** (gain_db / 40.0)
    w0 = 2 * math.pi * fc / sr
    alpha = math.sin(w0) / (2 * q)
    cos = math.cos(w0)
    b = np.array([
        a * ((a + 1) + (a - 1) * cos + 2 * math.sqrt(a) * alpha),
        -2 * a * ((a - 1) + (a + 1) * cos),
        a * ((a + 1) + (a - 1) * cos - 2 * math.sqrt(a) * alpha),
    ])
    den = np.array([
        (a + 1) - (a - 1) * cos + 2 * math.sqrt(a) * alpha,
        2 * ((a - 1) - (a + 1) * cos),
        (a + 1) - (a - 1) * cos - 2 * math.sqrt(a) * alpha,
    ])
    return b / den[0], den / den[0]


def _biquad_high_pass(sr: int, q: float = 0.5, fc: float = 38.0):
    import numpy as np

    w0 = 2 * math.pi * fc / sr
    alpha = math.sin(w0) / (2 * q)
    cos = math.cos(w0)
    b = np.array([(1 + cos) / 2, -(1 + cos), (1 + cos) / 2])
    den = np.array([1 + alpha, -2 * cos, 1 - alpha])
    return b / den[0], den / den[0]


def k_weight(x, sr: int = SR):
    from scipy import signal

    b, a = _biquad_high_shelf(sr)
    y = signal.lfilter(b, a, x, axis=0)
    b, a = _biquad_high_pass(sr)
    return signal.lfilter(b, a, y, axis=0)


def _block_power(y, sr: int, block_s: float, step_s: float):
    """Summed channel mean-square per block (K-weighted input)."""
    import numpy as np

    block, step = int(block_s * sr), int(step_s * sr)
    if len(y) < block:
        return np.zeros(0)
    power = (y ** 2).sum(axis=1)
    cs = np.concatenate([[0.0], np.cumsum(power)])
    starts = np.arange(0, len(y) - block + 1, step)
    return (cs[starts + block] - cs[starts]) / block


def _lufs_of(power):
    import numpy as np

    return -0.691 + 10 * np.log10(power + 1e-15)


def integrated_lufs(x, sr: int = SR) -> float:
    import numpy as np

    z = _block_power(k_weight(x, sr), sr, 0.4, 0.1)
    if not len(z):
        return -70.0
    loud = _lufs_of(z)
    gated = z[loud > -70.0]
    if not len(gated):
        return -70.0
    relative = _lufs_of(gated.mean()) - 10.0
    final = z[(loud > -70.0) & (loud > relative)]
    return float(_lufs_of(final.mean())) if len(final) else -70.0


def short_term(x, sr: int = SR):
    """EBU short-term loudness: 3 s windows every 1 s."""
    return _lufs_of(_block_power(k_weight(x, sr), sr, 3.0, 1.0))


# ── QC metrics (the spike's post.py measures) ───────────────────────────────


def analyze(x, sr: int = SR) -> dict:
    """Subtlety measures of a raw clip: loudness range and swells, HPSS
    percussive ratio, onset density and regularity (pulse), sudden hits,
    3–8 Hz modulation in the voice band (vocals/speech), and decay (a drone
    dying out)."""
    import numpy as np
    from scipy import signal
    from scipy.ndimage import median_filter

    mono = x.mean(axis=1)
    duration = len(x) / sr
    res: dict = {"duration": round(duration, 2), "raw_lufs": round(integrated_lufs(x, sr), 2)}
    st = short_term(x, sr)
    g = st[st > -70]
    if len(g):
        g = g[g > (10 * np.log10(np.mean(10 ** (g / 10)))) - 20]
    if len(g):
        res["lra_lu"] = round(float(np.percentile(g, 95) - np.percentile(g, 10)), 2)
        res["st_max_minus_median"] = round(float(g.max() - np.median(g)), 2)
    if len(st) >= 12:
        head = np.median(st[: len(st) // 2])
        tail = np.median(st[-8:])
        res["decay_db"] = round(float(max(0.0, head - tail)), 2)
    f, _t, z = signal.stft(mono, sr, nperseg=2048, noverlap=1536)
    s = np.abs(z) + 1e-10
    p = s ** 2
    total = p.sum()
    harmonic = median_filter(s, size=(1, 17))
    percussive = median_filter(s, size=(17, 1))
    mask = harmonic ** 2 / (harmonic ** 2 + percussive ** 2 + 1e-12)
    res["percussive_ratio"] = round(float((p * (1 - mask)).sum() / total), 3)
    log_mag = np.log1p(100 * s)
    flux = np.maximum(0, np.diff(log_mag, axis=1)).sum(0)
    flux = (flux - np.median(flux)) / (np.std(flux) + 1e-9)
    hop_s = 512 / sr
    peaks, _ = signal.find_peaks(flux, height=3.0, distance=max(1, int(0.1 / hop_s)))
    res["onsets_per_s"] = round(len(peaks) / max(duration, 1e-6), 3)
    fl = np.maximum(flux, 0)
    fl = fl - fl.mean()
    ac = np.correlate(fl, fl, "full")[len(fl) - 1 :]
    ac /= ac[0] + 1e-9
    lo, hi = int(0.3 / hop_s), int(1.5 / hop_s)
    res["pulse_autocorr"] = round(float(ac[lo:hi].max()) if hi < len(ac) else 0.0, 3)
    frame = int(0.025 * sr)
    count = len(mono) // frame
    if count > 16:
        r = 10 * np.log10((mono[: count * frame].reshape(count, frame) ** 2).mean(1) + 1e-12)
        lin = 10 ** (r / 10)
        prev = np.convolve(lin, np.ones(8) / 8, "full")[:count]
        prev = np.concatenate([[lin[0]], prev[:-1]])
        jumps = (r - 10 * np.log10(prev + 1e-12)) > 9
        jumps &= r > (np.percentile(r, 50) - 3)
        events = np.flatnonzero(jumps)
        events = events[np.concatenate([[True], np.diff(events) > 8])] if len(events) else events
        res["hits_per_min"] = round(len(events) / (duration / 60), 2)
    band = p[(f >= 300) & (f < 3400)].sum(0)
    env = 10 * np.log10(band + 1e-12)
    if len(env) > 30:
        sos = signal.butter(2, [3, 8], "bp", fs=1 / hop_s, output="sos")
        res["syllabic_mod_db"] = round(float(np.std(signal.sosfiltfilt(sos, env))), 2)
    return res


# ── Post-processing for listening under a voice ─────────────────────────────


def _peak_eq(f0: float, gain_db: float, q: float, sr: int = SR):
    import numpy as np

    a = 10 ** (gain_db / 40)
    w = 2 * np.pi * f0 / sr
    alpha = np.sin(w) / (2 * q)
    b = np.array([1 + alpha * a, -2 * np.cos(w), 1 - alpha * a])
    den = np.array([1 + alpha / a, -2 * np.cos(w), 1 - alpha / a])
    return b / den[0], den / den[0]


def soft_limit(x, ceiling_db: float, sr: int = SR):
    import numpy as np
    from scipy import signal
    from scipy.ndimage import maximum_filter1d

    c = 10 ** (ceiling_db / 20)
    env = maximum_filter1d(np.max(np.abs(x), axis=1), size=2 * int(0.005 * sr) + 1)
    gain = np.minimum(1.0, c / (env + 1e-12))
    rel = math.exp(-1 / (0.2 * sr))
    g = signal.lfilter([1 - rel], [1, -rel], gain[::-1])[::-1]
    g = np.minimum(g, gain)
    g = signal.lfilter([1 - rel], [1, -rel], g)
    g = np.clip(g, 0.0, 1.0)
    return np.tanh(x * g[:, None] / c) * c


def fades(x, fade_in_s: float, fade_out_s: float, sr: int = SR):
    import numpy as np

    y = x.copy()
    a = min(len(y) // 2, int(fade_in_s * sr))
    b = min(len(y) // 2, int(fade_out_s * sr))
    if a:
        y[:a] *= (np.sin(np.linspace(0, np.pi / 2, a)) ** 2)[:, None]
    if b:
        y[len(y) - b :] *= (np.cos(np.linspace(0, np.pi / 2, b)) ** 2)[:, None]
    return y


def trim_tail(x, sr: int = SR, thresh_db: float = -50.0):
    """Drop trailing near-silence (the model often ends early)."""
    import numpy as np

    frame = int(0.05 * sr)
    n = len(x) // frame
    if n == 0:
        return x
    r = 20 * np.log10(np.sqrt((x[: n * frame].mean(1).reshape(n, frame) ** 2).mean(1)) + 1e-9)
    loud = np.flatnonzero(r > r.max() + thresh_db)
    return x[: (loud[-1] + 1) * frame] if len(loud) else x


def process(x, *, target_lufs: float = -24.0, fade_in_s: float = 2.0, fade_out_s: float = 4.0, sr: int = SR):
    import numpy as np
    from scipy import signal

    x = trim_tail(x, sr)
    if x.shape[1] == 1:
        x = np.repeat(x, 2, axis=1)
    x = signal.sosfiltfilt(signal.butter(2, 40, "hp", fs=sr, output="sos"), x, axis=0)
    mid, side = (x[:, 0] + x[:, 1]) / 2, (x[:, 0] - x[:, 1]) / 2
    side = signal.sosfiltfilt(signal.butter(2, 150, "hp", fs=sr, output="sos"), side) * 0.7
    x = np.stack([mid + side, mid - side], 1)
    b, a = _peak_eq(2000, -5.0, 0.7, sr)
    x = signal.lfilter(b, a, x, axis=0)
    b, a = _peak_eq(7000, -2.0, 0.8, sr)
    x = signal.lfilter(b, a, x, axis=0)
    x = x * 10 ** ((target_lufs - integrated_lufs(x, sr)) / 20)
    x = soft_limit(x, ceiling_db=target_lufs + 18, sr=sr)
    x = x * 10 ** ((target_lufs - integrated_lufs(x, sr)) / 20)
    return fades(x, fade_in_s, fade_out_s, sr)


def resample(x, sr_in: int, sr_out: int = SR):
    from math import gcd

    from scipy import signal

    if sr_in == sr_out:
        return x
    g = gcd(sr_in, sr_out)
    return signal.resample_poly(x, sr_out // g, sr_in // g, axis=0)


# ── Encoding ─────────────────────────────────────────────────────────────────


def _opus_level(kbps: float, channels: int = 2) -> float:
    """libsndfile maps compression level linearly onto 6–256 kb/s per channel."""
    per_channel = max(6.0, min(256.0, kbps / channels))
    return round(1.0 - (per_channel - 6.0) / 250.0, 4)


def encode(x, dst: str, *, kbps: float = 64, ffmpeg: str | None = None, sr: int = SR) -> None:
    import numpy as np
    import soundfile as sf

    data = np.clip(x, -1, 1).astype(np.float32)
    tmp = f"{dst}.{os.getpid()}.tmp"
    try:
        try:
            with sf.SoundFile(tmp, "w", sr, data.shape[1], format="OGG", subtype="OPUS",
                              compression_level=_opus_level(kbps, data.shape[1])) as fh:
                fh.write(data)
        except Exception:
            if not ffmpeg:
                raise
            wav = f"{tmp}.wav"
            sf.write(wav, data, sr, subtype="FLOAT")
            try:
                subprocess.run(
                    [ffmpeg, "-y", "-loglevel", "error", "-i", wav, "-c:a", "libopus", "-b:a", f"{int(kbps)}k",
                     "-vbr", "constrained", "-application", "audio", "-f", "ogg", tmp],
                    check=True, stdin=subprocess.DEVNULL,
                )
            finally:
                if os.path.exists(wav):
                    os.remove(wav)
        os.replace(tmp, dst)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


# ── Job ──────────────────────────────────────────────────────────────────────


def _parent_alive(pid) -> bool:
    if not pid:
        return True
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return True
    if sys.platform == "win32":
        import ctypes

        synchronize, wait_timeout = 0x00100000, 0x00000102
        kernel = ctypes.windll.kernel32
        handle = kernel.OpenProcess(synchronize, False, pid)
        if not handle:
            return False
        try:
            return kernel.WaitForSingleObject(handle, 0) == wait_timeout
        finally:
            kernel.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def validate_job(job: object) -> list[dict]:
    if not isinstance(job, dict) or job.get("version") != 1 or not isinstance(job.get("result"), str):
        raise ValueError("not a music job")
    clips = job.get("clips")
    if not isinstance(clips, list):
        raise ValueError("clips missing")
    for clip in clips:
        if not isinstance(clip, dict) or not all(k in clip for k in ("id", "prompt", "seed", "seconds", "out")):
            raise ValueError("bad clip")
        if not (0 < float(clip["seconds"]) <= 47.5):
            raise ValueError("clip too long")
    return clips


class _Result:
    def __init__(self, path: str):
        self.path = path
        self.data: dict = {"version": 1, "done": False, "error": None, "clips": {}}

    def save(self) -> None:
        tmp = f"{self.path}.{os.getpid()}.tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(self.data, fh, ensure_ascii=False)
        os.replace(tmp, self.path)


def run(job: dict) -> int:
    clips = validate_job(job)
    result = _Result(job["result"])
    result.save()
    import numpy as np
    import torch

    if not torch.cuda.is_available():
        result.data["error"] = "cuda"
        result.save()
        return EXIT_RESOURCES
    free, _total = torch.cuda.mem_get_info()
    result.data["vram_free_gb"] = round(free / 2**30, 2)
    if free / 2**30 < float(job.get("min_free_gb") or 0):
        result.data["error"] = "vram"
        result.save()
        return EXIT_RESOURCES
    from diffusers import StableAudioPipeline

    started = time.perf_counter()
    dtype = getattr(torch, str(job.get("dtype") or "float16"))
    pipe = StableAudioPipeline.from_pretrained(job["model"], torch_dtype=dtype).to("cuda")
    pipe.set_progress_bar_config(disable=True)
    result.data.update(device=torch.cuda.get_device_name(0), load_seconds=round(time.perf_counter() - started, 1))
    result.save()
    model_sr = int(pipe.vae.sampling_rate)
    for clip in clips:
        if not _parent_alive(job.get("parent_pid")):
            result.data["error"] = "parent gone"
            result.save()
            return EXIT_CRASH
        torch.cuda.reset_peak_memory_stats()
        t0 = time.perf_counter()
        try:
            generator = torch.Generator("cuda").manual_seed(int(clip["seed"]))
            audio = pipe(
                str(clip["prompt"]),
                num_inference_steps=int(job.get("steps") or 100),
                audio_end_in_s=float(clip["seconds"]),
                guidance_scale=float(job.get("guidance") or 7.0),
                num_waveforms_per_prompt=1,
                generator=generator,
            ).audios
            raw = audio[0].T.float().cpu().numpy().astype(np.float64)
            gen_seconds = time.perf_counter() - t0
            if not np.isfinite(raw).all() or float(np.max(np.abs(raw))) < 1e-5:
                raise RuntimeError("silent or non-finite audio")
            raw = resample(raw, model_sr, SR)
            metrics = analyze(raw)
            out = process(raw, target_lufs=float(job.get("level_lufs") or -24.0),
                          fade_in_s=float(job.get("fade_in_s") or 2.0), fade_out_s=float(job.get("fade_out_s") or 4.0))
            encode(out, clip["out"], kbps=float(job.get("bitrate_kbps") or 64), ffmpeg=job.get("ffmpeg"))
            metrics["lufs"] = round(integrated_lufs(out), 2)
            result.data["clips"][clip["id"]] = {
                "ok": True,
                "out": clip["out"],
                "duration": round(len(out) / SR, 3),
                "gen_seconds": round(gen_seconds, 2),
                "vram_peak_gb": round(torch.cuda.max_memory_allocated() / 2**30, 2),
                "metrics": metrics,
            }
        except torch.cuda.OutOfMemoryError:
            result.data["error"] = "vram"
            result.save()
            return EXIT_RESOURCES
        except Exception as exc:  # noqa: BLE001 — recorded per clip
            traceback.print_exc()
            result.data["clips"][clip["id"]] = {"ok": False, "error": f"{type(exc).__name__}: {exc}"[:300]}
        result.save()
        print(f"[music] {clip['id']} {time.perf_counter() - t0:.1f}s", flush=True)
    result.data["done"] = True
    result.save()
    return EXIT_OK


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: music_worker.py <job.json>", file=sys.stderr)
        return EXIT_BAD_JOB
    try:
        with open(argv[1], encoding="utf-8") as fh:
            job = json.load(fh)
        validate_job(job)
    except (OSError, ValueError, TypeError) as exc:
        print(f"bad job: {exc}", file=sys.stderr)
        return EXIT_BAD_JOB
    return run(job)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
