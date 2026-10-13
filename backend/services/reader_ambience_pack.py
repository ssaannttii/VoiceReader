"""Recorded ambience beds for the Reader (optional; docs/reader/SPEC.md).

A pack is a folder outside the repository with seamless loops (Ogg Opus) and a
``manifest.json`` describing them (built by ``scripts/reader/fetch-ambience.py``
from public-domain field recordings). The client prefers a recording for a scene
tag when the pack has one and falls back to its synthesized bed otherwise, so a
missing or broken pack only means synthesized sounds.

The folder is ``$OMNIVOICE_AMBIENCE_DIR`` when set, else ``<data dir>/reader/ambience``.
Only files listed in the manifest, with a plain name and an audio extension, are
ever served.
"""
from __future__ import annotations

import json
import logging
import os
import re
import threading
from typing import Optional

logger = logging.getLogger("omnivoice.reader")

ENV_DIR = "OMNIVOICE_AMBIENCE_DIR"
MANIFEST = "manifest.json"
#: Audio types a pack may hold (what Chrome, Android WebView and Safari decode).
MEDIA_TYPES = {".ogg": "audio/ogg", ".opus": "audio/ogg", ".m4a": "audio/mp4", ".mp3": "audio/mpeg", ".wav": "audio/wav"}
_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$")
#: Fields passed to the client (credits included: the sheet can show them).
_FIELDS = ("id", "tag", "file", "rms", "duration", "pad", "sha256", "title", "author", "license", "source_url")

_cache: dict[str, object] = {"key": None, "value": None}
_lock = threading.Lock()


def pack_dir() -> str:
    custom = os.environ.get(ENV_DIR, "").strip()
    if custom:
        return os.path.abspath(os.path.expanduser(custom))
    from core.config import DATA_DIR

    return os.path.join(DATA_DIR, "reader", "ambience")


def _valid_name(name: object) -> bool:
    return (
        isinstance(name, str)
        and bool(_NAME_RE.match(name))
        and ".." not in name
        and os.path.splitext(name)[1].lower() in MEDIA_TYPES
    )


def _entry(raw: object, folder: str) -> Optional[dict]:
    if not isinstance(raw, dict):
        return None
    name, tag = raw.get("file"), raw.get("tag")
    if not _valid_name(name) or not isinstance(tag, str) or not re.match(r"^[a-z]{2,20}$", tag):
        return None
    if not os.path.isfile(os.path.join(folder, name)):
        return None
    try:
        rms = float(raw.get("rms") or 0)
        duration = float(raw.get("duration") or 0)
        pad = float(raw.get("pad") or 0)
    except (TypeError, ValueError):
        return None
    if not (0 < rms <= 1 and duration > 0 and 0 <= pad <= 5):
        return None
    entry = {key: raw.get(key) for key in _FIELDS if raw.get(key) is not None}
    entry.update(
        id=str(raw.get("id") or os.path.splitext(name)[0]), rms=round(rms, 5), duration=round(duration, 3), pad=pad
    )
    for key in ("sha256", "title", "author", "license", "source_url"):
        if key in entry:
            entry[key] = str(entry[key])[:300]
    return entry


def manifest() -> dict:
    """``{"available": bool, "beds": [...]}``; beds whose file is missing are left out."""
    folder = pack_dir()
    path = os.path.join(folder, MANIFEST)
    try:
        stamp = os.stat(path).st_mtime_ns
    except OSError:
        return {"available": False, "beds": []}
    key = (path, stamp)
    with _lock:
        if _cache["key"] == key:
            return _cache["value"]  # type: ignore[return-value]
    try:
        with open(path, encoding="utf-8") as fh:
            raw = json.load(fh)
    except (OSError, ValueError):
        logger.warning("Reader ambience pack: unreadable manifest %s", path)
        return {"available": False, "beds": []}
    items = raw.get("beds") if isinstance(raw, dict) else None
    beds = [e for e in (_entry(item, folder) for item in (items or [])) if e is not None]
    value = {"available": bool(beds), "version": raw.get("version") if isinstance(raw, dict) else None, "beds": beds}
    with _lock:
        _cache.update(key=key, value=value)
    return value


def bed_path(name: str) -> Optional[tuple[str, str]]:
    """``(path, media type)`` of a file listed in the manifest, else None."""
    if not _valid_name(name):
        return None
    if not any(bed["file"] == name for bed in manifest()["beds"]):
        return None
    folder = os.path.realpath(pack_dir())
    path = os.path.realpath(os.path.join(folder, name))
    if os.path.dirname(path) != folder or not os.path.isfile(path):
        return None
    return path, MEDIA_TYPES[os.path.splitext(name)[1].lower()]
