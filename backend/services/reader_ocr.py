"""Reader scan import: local OCR of page photos.

Engine: PaddleOCR's PP-OCR models exported to ONNX, run with ``onnxruntime``
(already installed with every VoiceStudio build through faster-whisper) on the
CPU — no new Python dependency, no GPU contention with the TTS engine.

* detection: ``PP-OCRv3_mobile_det`` (2.4 MB), a DB text-line detector;
* recognition: ``latin_PP-OCRv5_mobile_rec`` (7.9 MB), 32 Latin-script
  languages with their accents (á é í ó ú ñ ü ¿ ¡ ç à è ß …).

Both come from the Apache-2.0 ``monkt/paddleocr-onnx`` Hugging Face repo, pinned
to one revision, and are downloaded into the regular Hugging Face cache the
first time the listener scans a page (a user-started action); later scans are
offline. Decoding is pure numpy + Pillow: DB post-processing uses
axis-aligned boxes (book pages photographed upright), which keeps the module
free of OpenCV/pyclipper.

The engine is pluggable: :func:`set_engine` swaps in any object with
``read(image) -> list[TextLine]`` (tests use a fake; a future Tesseract or GPU
backend would plug in the same way). When the runtime or the models are not
available, :class:`OcrUnavailable` carries a message saying what to install.
"""
from __future__ import annotations

import io
import logging
import math
import os
import re
import statistics
import threading
from dataclasses import dataclass
from typing import Callable, Optional, Protocol

import numpy as np

logger = logging.getLogger("omnivoice.reader")

OCR_REPO = "monkt/paddleocr-onnx"
OCR_REVISION = "7b02d0a30a07ba2b92ad1ff5a8941ae2c633de65"
DET_FILE = "detection/v3/det.onnx"
REC_FILE = "languages/latin/rec.onnx"
DICT_FILE = "languages/latin/dict.txt"

#: Longest side the detector sees (multiple of 32). Book text photographed with
#: a phone is ~25-40 px tall at this size: well inside what DB detects.
DET_MAX_SIDE = 1280
DET_THRESH = 0.3
DET_BOX_THRESH = 0.55
DET_UNCLIP = 1.6
REC_HEIGHT = 48
REC_BATCH = 8
#: A recognized line below this mean confidence is noise (texture, figures).
MIN_LINE_SCORE = 0.5
#: Photos tilted more than this are straightened before recognition (degrees).
MIN_DESKEW_DEG = 0.4
MAX_DESKEW_DEG = 20.0
#: Images larger than this are scaled down before anything else.
MAX_IMAGE_PIXELS = 40_000_000

_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)


class OcrUnavailable(RuntimeError):
    """OCR cannot run on this install; the message says what is missing."""


class OcrImageError(ValueError):
    """An uploaded image could not be decoded."""


@dataclass
class TextLine:
    text: str
    x0: float
    y0: float
    x1: float
    y1: float
    score: float = 1.0
    #: Glyph line height. The box of a slightly rotated photo is taller than
    #: its text; the detector's mean stroke-band thickness is not.
    size: float = 0.0

    @property
    def height(self) -> float:
        return max(1.0, self.size or (self.y1 - self.y0))

    @property
    def cy(self) -> float:
        return (self.y0 + self.y1) / 2


class OcrEngine(Protocol):
    def read(self, image) -> list[TextLine]:  # PIL.Image (RGB) → lines, any order
        ...


# ── Image loading ────────────────────────────────────────────────────────────


def load_image(data: bytes):
    """Decoded, upright RGB ``PIL.Image`` (EXIF orientation applied)."""
    from PIL import Image, ImageOps, UnidentifiedImageError

    try:
        image = Image.open(io.BytesIO(data))
        image = ImageOps.exif_transpose(image)
        image = image.convert("RGB")
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError) as exc:
        raise OcrImageError("one of the images could not be read (use JPEG, PNG or WebP)") from exc
    if image.width * image.height > MAX_IMAGE_PIXELS:
        scale = math.sqrt(MAX_IMAGE_PIXELS / (image.width * image.height))
        image = image.resize((max(1, int(image.width * scale)), max(1, int(image.height * scale))))
    return image


# ── Connected components (run-length union-find, numpy + stdlib) ─────────────


def _components(mask: np.ndarray) -> list[tuple[int, int, int, int, list[tuple[int, int, int]]]]:
    """8-connected components of a boolean mask.

    Returns ``(x0, y0, x1, y1, runs)`` per component, ``runs`` being
    ``(row, start, end)`` half-open column ranges.
    """
    runs: list[tuple[int, int, int]] = []
    row_runs: list[list[int]] = []
    parent: list[int] = []

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    previous: list[int] = []
    for y in range(mask.shape[0]):
        row = mask[y]
        if not row.any():
            previous = []
            row_runs.append([])
            continue
        padded = np.concatenate(([0], row.view(np.int8), [0]))
        edges = np.flatnonzero(np.diff(padded))
        current: list[int] = []
        j = 0
        for k in range(0, len(edges), 2):
            start, end = int(edges[k]), int(edges[k + 1])
            index = len(runs)
            runs.append((y, start, end))
            parent.append(index)
            # Overlap with the previous row's runs (8-connectivity: touch at corners).
            while j < len(previous) and runs[previous[j]][2] < start:
                j += 1
            m = j
            while m < len(previous) and runs[previous[m]][1] <= end:
                a, b = find(index), find(previous[m])
                if a != b:
                    parent[max(a, b)] = min(a, b)
                m += 1
            current.append(index)
        previous = current
        row_runs.append(current)
    groups: dict[int, list[tuple[int, int, int]]] = {}
    for index, run in enumerate(runs):
        groups.setdefault(find(index), []).append(run)
    out = []
    for members in groups.values():
        ys = [r[0] for r in members]
        out.append((min(r[1] for r in members), min(ys), max(r[2] for r in members), max(ys) + 1, members))
    return out


def _band_angle(runs: list[tuple[int, int, int]], sx: float, sy: float) -> float:
    """Tilt of one text band in degrees (positive = falling to the right).

    Least-squares slope of the run midpoints, weighted by run length, in
    original-image units. ``PIL.Image.rotate(angle)`` levels it.
    """
    xs = np.array([(s + e) / 2.0 * sx for _r, s, e in runs])
    ys = np.array([r * sy for r, _s, _e in runs], dtype=np.float64)
    weights = np.array([float(e - s) for _r, s, e in runs])
    mx = np.average(xs, weights=weights)
    my = np.average(ys, weights=weights)
    var = float(np.sum(weights * (xs - mx) ** 2))
    if var <= 0:
        return 0.0
    slope = float(np.sum(weights * (xs - mx) * (ys - my))) / var
    return math.degrees(math.atan(slope))


# ── PP-OCR on onnxruntime ────────────────────────────────────────────────────


def _model_path(filename: str) -> str:
    try:
        from huggingface_hub import hf_hub_download
    except ImportError as exc:  # pragma: no cover — always installed with VoiceStudio
        raise OcrUnavailable("OCR needs the huggingface_hub package") from exc
    try:
        return hf_hub_download(OCR_REPO, filename, revision=OCR_REVISION, local_files_only=True)
    except Exception:  # noqa: BLE001 — not cached yet: download it (user-started scan)
        pass
    try:
        logger.info("Reader OCR: downloading %s/%s", OCR_REPO, filename)
        return hf_hub_download(OCR_REPO, filename, revision=OCR_REVISION, token=False)
    except Exception as exc:  # noqa: BLE001 — offline, proxy, HF outage
        raise OcrUnavailable(
            "the text-recognition model could not be downloaded (about 10 MB from Hugging Face, "
            "only the first time). Check the PC's internet connection and try again."
        ) from exc


class PaddleOnnxEngine:
    """PP-OCR detection + Latin recognition on ``onnxruntime`` (CPU)."""

    def __init__(self) -> None:
        try:
            import onnxruntime as ort
        except ImportError as exc:
            raise OcrUnavailable(
                "OCR needs the onnxruntime package; reinstall VoiceStudio's Python "
                "environment (uv sync) to get it back"
            ) from exc
        options = ort.SessionOptions()
        options.log_severity_level = 3
        # Leave cores for the API and the TTS engine's own CPU work.
        options.intra_op_num_threads = max(1, min(4, (os.cpu_count() or 2) // 2))
        providers = ["CPUExecutionProvider"]
        self._det = ort.InferenceSession(_model_path(DET_FILE), options, providers=providers)
        self._rec = ort.InferenceSession(_model_path(REC_FILE), options, providers=providers)
        with open(_model_path(DICT_FILE), encoding="utf-8") as fh:
            chars = [line.rstrip("\r\n") for line in fh]
        # CTC: index 0 is the blank; the exported model appends a space class.
        self._chars = ["", *chars, " "]
        self._lock = threading.Lock()

    # Detection ---------------------------------------------------------------

    def _detect(self, image) -> tuple[list[tuple[float, float, float, float, float]], float]:
        """``(boxes, skew_degrees)``; boxes are ``(x0, y0, x1, y1, glyph_height)``."""
        from PIL import Image

        width, height = image.size
        ratio = min(1.0, DET_MAX_SIDE / max(width, height))
        new_w = max(32, int(round(width * ratio / 32)) * 32)
        new_h = max(32, int(round(height * ratio / 32)) * 32)
        resized = image.resize((new_w, new_h), Image.BILINEAR)
        arr = np.asarray(resized, dtype=np.float32)[:, :, ::-1] / 255.0  # BGR, as trained
        arr = (arr - _MEAN) / _STD
        tensor = arr.transpose(2, 0, 1)[None].astype(np.float32)
        prob = self._det.run(None, {self._det.get_inputs()[0].name: tensor})[0][0, 0]
        mask = prob > DET_THRESH
        sx, sy = width / float(new_w), height / float(new_h)
        boxes = []
        angles: list[float] = []
        for x0, y0, x1, y1, runs in _components(mask):
            w, h = x1 - x0, y1 - y0
            if min(w, h) < 3:
                continue
            total = sum(float(prob[r, s:e].sum()) for r, s, e in runs)
            count = sum(e - s for _r, s, e in runs)
            if not count or total / count < DET_BOX_THRESH:
                continue
            if w > 8 * (count / float(w)):
                angles.append(_band_angle(runs, sx, sy))
            grow = (w * h) * DET_UNCLIP / (2.0 * (w + h))
            band = count / float(w)  # mean thickness of the shrunk text band
            boxes.append((
                max(0.0, (x0 - grow) * sx),
                max(0.0, (y0 - grow) * sy),
                min(float(width), (x1 + grow) * sx),
                min(float(height), (y1 + grow) * sy),
                band * (1.0 + DET_UNCLIP) * sy,  # grown like the box
            ))
        skew = statistics.median(angles) if len(angles) >= 3 else 0.0
        return boxes, skew

    # Recognition -------------------------------------------------------------

    def _recognize(self, crops: list) -> list[tuple[str, float]]:
        from PIL import Image

        results: list[tuple[str, float]] = [("", 0.0)] * len(crops)
        order = sorted(range(len(crops)), key=lambda i: crops[i].width / max(1, crops[i].height))
        for start in range(0, len(order), REC_BATCH):
            batch = order[start:start + REC_BATCH]
            widths = [max(8, int(math.ceil(REC_HEIGHT * crops[i].width / max(1, crops[i].height)))) for i in batch]
            max_w = max(widths)
            tensor = np.zeros((len(batch), 3, REC_HEIGHT, max_w), dtype=np.float32)
            for row, (index, w) in enumerate(zip(batch, widths)):
                img = crops[index].resize((w, REC_HEIGHT), Image.BILINEAR)
                arr = np.asarray(img, dtype=np.float32)[:, :, ::-1] / 255.0
                tensor[row, :, :, :w] = ((arr - 0.5) / 0.5).transpose(2, 0, 1)
            probs = self._rec.run(None, {self._rec.get_inputs()[0].name: tensor})[0]
            for row, index in enumerate(batch):
                results[index] = self._ctc_decode(probs[row])
        return results

    def _ctc_decode(self, probs: np.ndarray) -> tuple[str, float]:
        best = probs.argmax(axis=1)
        conf = probs.max(axis=1)
        chars: list[str] = []
        scores: list[float] = []
        previous = -1
        for index, score in zip(best.tolist(), conf.tolist()):
            if index != previous and index != 0 and index < len(self._chars):
                chars.append(self._chars[index])
                scores.append(score)
            previous = index
        text = "".join(chars).strip()
        return text, (sum(scores) / len(scores)) if scores else 0.0

    def read(self, image) -> list[TextLine]:
        with self._lock:  # one onnxruntime session per model, used serially
            boxes, skew = self._detect(image)
            if abs(skew) > MIN_DESKEW_DEG and abs(skew) < MAX_DESKEW_DEG:
                # Axis-aligned crops need level lines: straighten the photo, detect again.
                from PIL import Image

                background = tuple(int(v) for v in np.median(np.asarray(image.resize((64, 64))), axis=(0, 1)))
                image = image.rotate(skew, resample=Image.BICUBIC, expand=True, fillcolor=background)
                boxes, _skew = self._detect(image)
            if not boxes:
                return []
            crops = [image.crop(tuple(int(round(v)) for v in box[:4])) for box in boxes]
            texts = self._recognize(crops)
        return [
            TextLine(text, *box[:4], score=score, size=box[4])
            for box, (text, score) in zip(boxes, texts)
            if text and score >= MIN_LINE_SCORE
        ]


_engine: Optional[OcrEngine] = None
_engine_factory: Callable[[], OcrEngine] = PaddleOnnxEngine
_engine_lock = threading.Lock()


def get_engine() -> OcrEngine:
    global _engine
    with _engine_lock:
        if _engine is None:
            _engine = _engine_factory()
        return _engine


def set_engine(engine: Optional[OcrEngine]) -> None:
    """Swap the OCR backend (``None`` = the default, rebuilt on next use)."""
    global _engine
    with _engine_lock:
        _engine = engine


# ── Reading order → paragraphs ───────────────────────────────────────────────

_PAGE_NUMBER_RE = re.compile(r"^[\W_]*(?:\d{1,4}|[ivxlcdm]{1,7})[\W_]*$", re.IGNORECASE)
_TERMINAL_RE = re.compile(r"[.!?…:»\"”’)]$")


def reading_order(lines: list[TextLine]) -> list[TextLine]:
    """Merge boxes that share a text row and order rows top to bottom, left to right.

    Two boxes are on one row when their centres are less than half a glyph
    height apart (the detector splits a line at wide gaps). Centres, not box
    edges: the boxes of a slightly rotated photo overlap their neighbours.
    """
    rows: list[list[TextLine]] = []
    for line in sorted(lines, key=lambda ln: ln.cy):
        target = None
        for row in reversed(rows[-3:]):
            row_cy = sum(ln.cy for ln in row) / len(row)
            if abs(line.cy - row_cy) < 0.5 * min(line.height, min(ln.height for ln in row)):
                target = row
                break
        if target is None:
            rows.append([line])
        else:
            target.append(line)
    merged: list[TextLine] = []
    for row in rows:
        row.sort(key=lambda ln: ln.x0)
        merged.append(TextLine(
            " ".join(ln.text for ln in row),
            min(ln.x0 for ln in row), min(ln.y0 for ln in row),
            max(ln.x1 for ln in row), max(ln.y1 for ln in row),
            score=min(ln.score for ln in row),
            size=max(ln.height for ln in row),
        ))
    merged.sort(key=lambda ln: ln.cy)
    return merged


def _join(current: str, line: str) -> str:
    if current.endswith("-") and len(current) > 1 and current[-2].isalpha() and line[:1].islower():
        return current[:-1] + line
    return f"{current} {line}"


def page_blocks(lines: list[TextLine]) -> list[tuple[str, str]]:
    """``[(kind, text)]`` for one page: ``("h", title)`` or ``("p", paragraph)``.

    Lines are put in reading order; a paragraph breaks at a vertical gap, a
    first-line indent, or after a clearly short line that ends a sentence. A
    short line set clearly larger than the body is a heading. Lone page
    numbers on the first/last row are dropped.
    """
    rows = reading_order([ln for ln in lines if ln.text.strip()])
    if rows and _PAGE_NUMBER_RE.match(rows[-1].text):
        rows = rows[:-1]
    if rows and _PAGE_NUMBER_RE.match(rows[0].text):
        rows = rows[1:]
    if not rows:
        return []
    body_h = statistics.median(ln.height for ln in rows)
    body = [ln for ln in rows if ln.height <= 1.35 * body_h]
    left = statistics.median(ln.x0 for ln in body)
    right = max(ln.x1 for ln in body)
    width = max(1.0, right - left)
    # Line pitch: a low quantile of the row-to-row distances (blank lines only
    # ever add to it), never below the glyph height.
    pitches = sorted(b.cy - a.cy for a, b in zip(body, body[1:]))
    pitch = max(pitches[len(pitches) // 4], 1.05 * body_h) if pitches else 1.6 * body_h
    out: list[tuple[str, str]] = []
    current = ""
    previous: Optional[TextLine] = None
    for line in rows:
        text = " ".join(line.text.split())
        is_heading = (
            line.height > 1.35 * body_h
            and len(text) <= 80
            and not text.endswith((",", ";"))
        )
        if is_heading:
            if current:
                out.append(("p", current))
                current = ""
            if out and out[-1][0] == "h" and previous is not None and line.cy - previous.cy < 1.6 * line.height:
                out[-1] = ("h", f"{out[-1][1]} {text}")  # a title set on two rows
            else:
                out.append(("h", text))
            previous = line
            continue
        if current and previous is not None:
            gap = line.cy - previous.cy > 1.45 * pitch
            indented = line.x0 - left > 1.2 * body_h and line.x0 - left < 0.3 * width
            short_end = previous.x1 < right - 0.12 * width and bool(_TERMINAL_RE.search(current))
            if gap or indented or short_end:
                out.append(("p", current))
                current = ""
        current = _join(current, text) if current else text
        previous = line
    if current:
        out.append(("p", current))
    return out


def ocr_page(data: bytes) -> list[tuple[str, str]]:
    """Image bytes → ``[(kind, text)]`` blocks in reading order. Blocking."""
    image = load_image(data)
    return page_blocks(get_engine().read(image))
