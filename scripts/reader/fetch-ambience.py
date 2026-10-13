"""Build the Reader's recorded ambience pack (seamless loops) from public-domain recordings.

Reads ``scripts/reader/ambience-sources.json`` (sources, licences, trim points),
downloads each recording's public preview, checks on its page that the licence is
still Creative Commons 0, and writes seamless Ogg Opus loops plus a
``manifest.json`` to the pack folder. The audio never goes into git.

    uv run --no-sync python scripts/reader/fetch-ambience.py --out E:/VoiceReaderData/ambience
    uv run --no-sync python scripts/reader/fetch-ambience.py --out <dir> --only rain,mist --force

Then point the backend at the folder (``OMNIVOICE_AMBIENCE_DIR``; default
``<data dir>/reader/ambience``). See docs/reader/SPEC.md ("Recorded beds").

Processing per bed: decode, resample to 48 kHz, take ``start`` + ``length`` (+ the
crossfade), tame loud moments (a slow gain rider keeps the level within a few dB
of its median: nothing startles under the narration), pick the exact loop length
whose seam matches best, equal-power crossfade the tail into the head, normalize
to the pack loudness with a peak limiter, and encode Opus (stereo, 80 kb/s).
Needs numpy, scipy and soundfile (in the project environment) and ffmpeg
(PATH, ``--ffmpeg``, or the copy VoiceStudio downloads to its media tools).
"""
from __future__ import annotations

import argparse
import glob
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

import numpy as np
import soundfile as sf
from scipy import ndimage, signal

HERE = os.path.dirname(os.path.abspath(__file__))
SOURCES = os.path.join(HERE, "ambience-sources.json")
RATE = 48_000
#: Pack loudness (RMS of full scale, ≈ −20 dBFS) and peak ceiling (≈ −3 dBFS: headroom for the codec).
TARGET_RMS = 0.1
PEAK = 0.7
#: The limiter may take this much off the loudest transients before the whole bed is lowered.
MAX_LIMIT_DB = 6.0
#: Loud moments are held to the median short-term level plus this much.
TAME_DB = 4.0
CROSSFADE = 3.0
BITRATE = "80k"
#: Seconds of the loop's own tail and head encoded around it (the client trims them after
#: decoding), so codec and resampler edge effects never land on the seam.
PAD = 0.5
UA = {"User-Agent": "VoiceReader-ambience/1.0 (+https://github.com/ssaannttii/VoiceReader)"}


def _ssl() -> None:
    try:
        import truststore  # Kaspersky and other TLS inspectors (Windows store certificates)

        truststore.inject_into_ssl()
    except ImportError:
        pass


def fetch(url: str) -> bytes:
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as response:  # noqa: S310
        return response.read()


def verify_cc0(page_url: str) -> bool:
    """The sound page still links the CC0 deed."""
    text = fetch(page_url).decode("utf-8", "replace")
    return "creativecommons.org/publicdomain/zero/1.0" in text


def find_ffmpeg(explicit: str | None) -> str:
    if explicit:
        return explicit
    found = shutil.which("ffmpeg")
    if found:
        return found
    roots = [os.environ.get("OMNIVOICE_DATA_DIR") or "", os.path.join(os.environ.get("APPDATA", ""), "OmniVoice"),
             os.path.expanduser("~/Library/Application Support/OmniVoice"), os.path.expanduser("~/.omnivoice")]
    for root in filter(None, roots):
        for pattern in ("media_tools/ffbin-*/*/ffmpeg*", "media_tools/shims/ffmpeg*"):
            hits = sorted(glob.glob(os.path.join(root, pattern)))
            if hits:
                return hits[0]
    sys.exit("ffmpeg not found: install it, pass --ffmpeg, or let VoiceStudio download its media tools.")


# ── DSP ────────────────────────────────────────────────────────────────────


def to_48k(audio: np.ndarray, rate: int) -> np.ndarray:
    if rate == RATE:
        return audio
    g = np.gcd(rate, RATE)
    return signal.resample_poly(audio, RATE // g, rate // g, axis=0).astype(np.float32)


def envelope(audio: np.ndarray, window: float = 0.4) -> np.ndarray:
    """Short-term RMS per sample (centred moving window)."""
    power = (audio.astype(np.float64) ** 2).mean(axis=1)
    size = max(1, int(window * RATE))
    return np.sqrt(ndimage.uniform_filter1d(power, size, mode="nearest") + 1e-12)


def tame(audio: np.ndarray, ceiling_db: float = TAME_DB) -> np.ndarray:
    """Slow gain rider: loud moments come down to the median level + ``ceiling_db``."""
    env = envelope(audio)
    limit = np.median(env) * 10 ** (ceiling_db / 20)
    gain = np.minimum(1.0, limit / env)
    # Attack and release of about a second: no pumping, no clicks.
    gain = ndimage.minimum_filter1d(gain, int(0.8 * RATE), mode="nearest")
    gain = ndimage.uniform_filter1d(gain, int(1.2 * RATE), mode="nearest")
    return (audio * gain[:, None]).astype(np.float32)


def best_loop_length(audio: np.ndarray, target: int, fade: int, search: int) -> int:
    """Loop length near ``target`` whose seam (the head vs what follows the loop) matches best."""
    env = envelope(audio, 0.05)[:: RATE // 1000]  # 1 kHz envelope
    head = env[: fade * 1000 // RATE]
    head = head - head.mean()
    best, best_score = target, -np.inf
    low = max(fade, target - search)
    high = min(len(audio) - fade - 1, target + search)
    for length in range(low, high + 1, RATE // 1000):
        tail = env[length * 1000 // RATE : length * 1000 // RATE + len(head)]
        if len(tail) < len(head):
            break
        tail = tail - tail.mean()
        score = float(np.dot(head, tail) / (np.linalg.norm(head) * np.linalg.norm(tail) + 1e-12))
        if score > best_score:
            best, best_score = length, score
    return best


def loop_crossfade(audio: np.ndarray, length: int, fade: int) -> np.ndarray:
    """Seamless loop of ``length`` samples: the ``fade`` after the loop blends into its start."""
    out = audio[:length].copy()
    x = (np.arange(fade) + 0.5) / fade
    fade_in = np.sin(x * np.pi / 2)[:, None]
    fade_out = np.cos(x * np.pi / 2)[:, None]
    out[:fade] = audio[:fade] * fade_in + audio[length : length + fade] * fade_out
    return out


def limit_peaks(audio: np.ndarray, ceiling: float) -> np.ndarray:
    """Look-ahead peak limiter (5 ms), circular so the loop seam is untouched."""
    pad = int(0.05 * RATE)
    ring = np.concatenate([audio[-pad:], audio, audio[:pad]])
    need = np.minimum(1.0, ceiling / (np.abs(ring).max(axis=1) + 1e-12))
    gain = ndimage.minimum_filter1d(need, int(0.005 * RATE), mode="wrap")
    gain = ndimage.uniform_filter1d(gain, int(0.005 * RATE), mode="wrap")
    gain = np.minimum(gain, need)
    return (ring * gain[:, None])[pad:-pad].astype(np.float32)


def normalize(audio: np.ndarray, target_rms: float = TARGET_RMS) -> tuple[np.ndarray, float]:
    rms = float(np.sqrt((audio.astype(np.float64) ** 2).mean()))
    gain = target_rms / max(rms, 1e-9)
    peak = float(np.abs(audio).max()) * gain
    allowed = PEAK * 10 ** (MAX_LIMIT_DB / 20)
    if peak > allowed:  # too peaky for the limiter alone: lower the whole bed
        gain *= allowed / peak
    out = limit_peaks(audio * gain, PEAK)
    return out, float(np.sqrt((out.astype(np.float64) ** 2).mean()))


def circular_filter(loop: np.ndarray, kind: str, freq: float) -> np.ndarray:
    """Butterworth filter that keeps the loop seamless (run over three copies, keep the middle)."""
    sos = signal.butter(2, freq, kind, fs=RATE, output="sos")
    tiled = signal.sosfilt(sos, np.concatenate([loop, loop, loop]), axis=0)
    return tiled[len(loop) : 2 * len(loop)].astype(np.float32)


def process(raw: str, spec: dict) -> tuple[np.ndarray, float]:
    """One bed per its spec: ``start``/``length`` (s), ``level_db`` (pack RMS, dBFS),
    ``lowpass``/``highpass`` (Hz; a lowpass blurs chatter into murmur), ``tame_db``,
    ``tile`` (the source is already a loop), ``invert_right`` (fix a phase-inverted channel)."""
    data, rate = sf.read(raw, always_2d=True, dtype="float32")
    if data.shape[1] == 1:
        data = np.repeat(data, 2, axis=1)
    data = to_48k(data[:, :2], rate)
    if spec.get("invert_right"):
        data[:, 1] *= -1
    if spec.get("tile"):
        data = np.concatenate([data, data])
    fade = int(spec.get("crossfade", CROSSFADE) * RATE)
    start = int(float(spec.get("start", 0)) * RATE)
    length = int(float(spec["length"]) * RATE)
    search = int(float(spec.get("search", 1.5)) * RATE)
    piece = data[start : start + length + search + fade]
    if len(piece) < length + fade:
        raise ValueError(f"{spec['id']}: recording too short for start {spec.get('start')} + length {spec['length']}")
    piece = tame(piece, float(spec.get("tame_db", TAME_DB)))
    loop_len = best_loop_length(piece, length, fade, search) if search else length
    loop = loop_crossfade(piece, loop_len, fade)
    for kind in ("highpass", "lowpass"):
        if spec.get(kind):
            loop = circular_filter(loop, kind, float(spec[kind]))
    return normalize(loop, 10 ** (float(spec.get("level_db", 20 * np.log10(TARGET_RMS))) / 20))


def encode(ffmpeg: str, audio: np.ndarray, dest: str) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        wav = os.path.join(tmp, "loop.wav")
        sf.write(wav, audio, RATE, subtype="PCM_24")
        subprocess.run(
            [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", wav, "-c:a", "libopus", "-b:a", BITRATE,
             "-vbr", "on", "-application", "audio", "-ac", "2", dest],
            check=True,
        )


def sha256(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", required=True, help="pack folder (created); downloads go to <out>/_downloads")
    parser.add_argument("--only", default="", help="comma-separated bed ids or tags")
    parser.add_argument("--force", action="store_true", help="re-process beds that already exist")
    parser.add_argument("--no-verify", action="store_true", help="skip the licence check on each sound page")
    parser.add_argument("--ffmpeg", default=None)
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    _ssl()

    with open(SOURCES, encoding="utf-8") as fh:
        sources = json.load(fh)
    beds = sources["beds"]
    wanted = {w.strip() for w in args.only.split(",") if w.strip()}
    out = os.path.abspath(args.out)
    downloads = os.path.join(out, "_downloads")
    os.makedirs(downloads, exist_ok=True)
    ffmpeg = find_ffmpeg(args.ffmpeg)

    manifest_path = os.path.join(out, "manifest.json")
    previous = {}
    if os.path.exists(manifest_path):
        with open(manifest_path, encoding="utf-8") as fh:
            previous = {b["id"]: b for b in json.load(fh).get("beds", [])}

    entries = []
    for spec in beds:
        name = f"{spec['id']}.ogg"
        dest = os.path.join(out, name)
        selected = not wanted or spec["id"] in wanted or spec["tag"] in wanted
        if not selected or (os.path.exists(dest) and not args.force and spec["id"] in previous):
            if spec["id"] in previous and os.path.exists(dest):
                entries.append(previous[spec["id"]])
            continue
        if spec.get("license") != "CC0-1.0":
            print(f"skip {spec['id']}: licence {spec.get('license')} is not CC0")
            continue
        if not args.no_verify and not verify_cc0(spec["source_url"]):
            print(f"skip {spec['id']}: the page no longer shows CC0 ({spec['source_url']})")
            continue
        raw = os.path.join(downloads, os.path.basename(spec["preview_url"]))
        if not os.path.exists(raw):
            print(f"download {spec['id']} ← {spec['preview_url']}")
            data = fetch(spec["preview_url"])
            with open(raw, "wb") as fh:
                fh.write(data)
            time.sleep(1.0)  # be gentle with the CDN
        audio, rms = process(raw, spec)
        pad = int(PAD * RATE)
        encode(ffmpeg, np.concatenate([audio[-pad:], audio, audio[:pad]]), dest)
        entry = {
            "id": spec["id"], "tag": spec["tag"], "file": name, "rms": round(rms, 5),
            "duration": round(len(audio) / RATE, 3), "pad": PAD, "sha256": sha256(dest)[:16],
            "title": spec["title"], "author": spec["author"], "license": spec["license"],
            "source_url": spec["source_url"],
        }
        entries.append(entry)
        print(f"ok {spec['id']:16s} {entry['duration']:6.1f}s rms {20 * np.log10(rms):6.1f} dBFS "
              f"{os.path.getsize(dest) // 1024} KB")

    order = {spec["id"]: n for n, spec in enumerate(beds)}
    entries.sort(key=lambda e: order.get(e["id"], 1_000))
    payload = {"version": sources.get("version", 1), "generated_at": int(time.time()),
               "note": "Built by scripts/reader/fetch-ambience.py; recordings are CC0 (public domain).",
               "beds": entries}
    tmp = manifest_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=1)
    os.replace(tmp, manifest_path)
    print(f"{len(entries)} beds in {manifest_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
