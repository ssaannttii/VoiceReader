"""Word timings for one Reader segment, estimated without a forced aligner.

Pure functions (numpy in, plain dicts out) so they are unit-tested without a
model. The estimate is deliberately simple and engine-agnostic:

1. Find the voiced span: frame RMS energy against a threshold relative to the
   loudest frame, trimming leading/trailing silence the engine pads with.
2. Distribute that span over the whitespace-delimited tokens of the display
   text, weighted by character count, with extra "pause" weight after clause
   punctuation (``, ; :``) and sentence punctuation (``. ! ?``) so the cursor
   lingers where the voice does.

Good enough to highlight the word being spoken at sentence granularity; the
error is bounded by the sentence length because every segment is rendered on
its own.
"""
from __future__ import annotations

import math
import re

import numpy as np

#: Frame size for the energy envelope.
FRAME_S = 0.010
#: A frame is "voiced" when its RMS is within this many dB of the loudest frame.
RELATIVE_THRESHOLD_DB = -35.0
#: ...and above this absolute floor (digital silence / dither never counts).
ABSOLUTE_FLOOR = 1e-3
#: Keep a little of the onset/release around the voiced span.
PAD_S = 0.03

#: Extra weight (in characters) for the pause after a token.
CLAUSE_PAUSE = 3.0
SENTENCE_PAUSE = 6.0

_TOKEN_RE = re.compile(r"\S+")
_CLAUSE_END = re.compile(r"[,;:—–]['\"”’)\]]*$")
_SENTENCE_END = re.compile(r"[.!?…]['\"”’)\]]*$")
_WORD_CHAR = re.compile(r"\w", re.UNICODE)


def voiced_span(samples, sample_rate: int) -> tuple[float, float]:
    """``(start_s, end_s)`` of the voiced part of ``samples``.

    Falls back to the whole clip when nothing crosses the threshold (a very
    quiet render is still speech, just quiet).
    """
    audio = np.asarray(samples, dtype=np.float32).reshape(-1)
    total = len(audio) / float(sample_rate) if sample_rate else 0.0
    if not len(audio) or sample_rate <= 0:
        return 0.0, total
    frame = max(1, int(round(FRAME_S * sample_rate)))
    n_frames = int(math.ceil(len(audio) / frame))
    padded = np.zeros(n_frames * frame, dtype=np.float32)
    padded[: len(audio)] = audio
    rms = np.sqrt(np.mean(padded.reshape(n_frames, frame) ** 2, axis=1))
    peak = float(rms.max())
    if peak <= ABSOLUTE_FLOOR:
        return 0.0, total
    threshold = max(ABSOLUTE_FLOOR, peak * (10.0 ** (RELATIVE_THRESHOLD_DB / 20.0)))
    voiced = np.nonzero(rms >= threshold)[0]
    if not len(voiced):
        return 0.0, total
    start = max(0.0, voiced[0] * frame / sample_rate - PAD_S)
    end = min(total, (voiced[-1] + 1) * frame / sample_rate + PAD_S)
    if end <= start:
        return 0.0, total
    return start, end


def _weight(token: str) -> float:
    letters = len(_WORD_CHAR.findall(token))
    return float(max(1, letters))


def _pause_after(token: str) -> float:
    if _SENTENCE_END.search(token):
        return SENTENCE_PAUSE
    if _CLAUSE_END.search(token):
        return CLAUSE_PAUSE
    return 0.0


def distribute_words(text: str, start_s: float, end_s: float) -> list[dict]:
    """Spread ``[start_s, end_s]`` over every whitespace token of ``text``.

    Each entry is ``{"w", "start", "end", "c0", "c1"}`` where ``c0``/``c1``
    are character offsets into ``text`` (``text[c0:c1] == w``). Times are
    monotonic and rounded to milliseconds.
    """
    tokens = [(m.group(0), m.start(), m.end()) for m in _TOKEN_RE.finditer(text or "")]
    if not tokens:
        return []
    weights = [_weight(t) for t, _, _ in tokens]
    # The pause after the LAST token is trailing silence — already trimmed.
    pauses = [_pause_after(t) for t, _, _ in tokens[:-1]] + [0.0]
    span = max(0.0, end_s - start_s)
    unit = span / (sum(weights) + sum(pauses))
    out: list[dict] = []
    cursor = start_s
    for (token, c0, c1), weight, pause in zip(tokens, weights, pauses):
        w_start = cursor
        w_end = w_start + weight * unit
        out.append({
            "w": token,
            "start": round(w_start, 3),
            "end": round(w_end, 3),
            "c0": c0,
            "c1": c1,
        })
        cursor = w_end + pause * unit
    out[-1]["end"] = round(end_s, 3)
    return out


def word_timings(text: str, samples, sample_rate: int) -> tuple[list[dict], float]:
    """``(words, duration_s)`` for a rendered segment."""
    audio = np.asarray(samples, dtype=np.float32).reshape(-1)
    duration = len(audio) / float(sample_rate) if sample_rate > 0 else 0.0
    start, end = voiced_span(audio, sample_rate)
    return distribute_words(text, start, end), round(duration, 3)
