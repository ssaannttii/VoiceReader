"""Reader word timings: silence trim + char-weighted distribution (no model)."""
from __future__ import annotations

import numpy as np
import pytest

from services.reader_timing import distribute_words, voiced_span, word_timings

SR = 16000


def _clip(lead_s: float, voiced_s: float, tail_s: float) -> np.ndarray:
    t = np.arange(int(voiced_s * SR)) / SR
    tone = 0.5 * np.sin(2 * np.pi * 220 * t).astype(np.float32)
    return np.concatenate([
        np.zeros(int(lead_s * SR), dtype=np.float32),
        tone,
        np.zeros(int(tail_s * SR), dtype=np.float32),
    ])


def test_voiced_span_trims_leading_and_trailing_silence():
    start, end = voiced_span(_clip(0.5, 2.0, 0.7), SR)
    assert start == pytest.approx(0.5, abs=0.05)
    assert end == pytest.approx(2.5, abs=0.05)


def test_voiced_span_of_silence_is_whole_clip():
    assert voiced_span(np.zeros(SR, dtype=np.float32), SR) == (0.0, 1.0)


def test_words_cover_every_token_with_char_offsets():
    text = "Hola,  mundo cruel. ¿Qué tal?"
    words = distribute_words(text, 0.0, 3.0)
    assert [w["w"] for w in words] == ["Hola,", "mundo", "cruel.", "¿Qué", "tal?"]
    for w in words:
        assert text[w["c0"]:w["c1"]] == w["w"]
    starts = [w["start"] for w in words]
    assert starts == sorted(starts)
    assert all(w["end"] >= w["start"] for w in words)
    assert words[0]["start"] == 0.0 and words[-1]["end"] == 3.0


def test_longer_words_get_more_time_and_punctuation_adds_pause():
    words = distribute_words("a extraordinarily b", 0.0, 2.0)
    durations = [w["end"] - w["start"] for w in words]
    assert durations[1] > 5 * durations[0]
    plain = distribute_words("one two", 0.0, 1.0)
    paused = distribute_words("one, two", 0.0, 1.0)
    gap_plain = plain[1]["start"] - plain[0]["end"]
    gap_paused = paused[1]["start"] - paused[0]["end"]
    assert gap_plain == pytest.approx(0.0, abs=1e-3)
    assert gap_paused > 0.1
    sentence = distribute_words("one. two", 0.0, 1.0)
    assert sentence[1]["start"] - sentence[0]["end"] > gap_paused


def test_word_timings_map_onto_voiced_span():
    words, duration = word_timings("Hello brave world", _clip(0.4, 1.5, 0.6), SR)
    assert duration == pytest.approx(2.5, abs=1e-3)
    assert words[0]["start"] == pytest.approx(0.4, abs=0.06)
    assert words[-1]["end"] == pytest.approx(1.9, abs=0.06)


def test_empty_text_has_no_words():
    assert distribute_words("   ", 0.0, 1.0) == []
