"""Reader diagnostics log: JSON lines under ``<DATA_DIR>/reader-debug/YYYY-MM-DD.jsonl``.

Phones (and the desktop UI) post timing/error events here so Reader can be tuned
from real devices; the backend adds its own synthesis timings to the same file.
Local only — the file never leaves the PC — and events carry indices and
timings, never document text. Files older than ``RETENTION_DAYS`` are pruned.
"""
from __future__ import annotations

import json
import os
import threading
import time
from datetime import date, datetime, timedelta

RETENTION_DAYS = 14
MAX_EVENT_BYTES = 2048

_lock = threading.Lock()
_last_prune: date | None = None


def debug_dir() -> str:
    from core import config

    return os.path.join(config.DATA_DIR, "reader-debug")


def _prune(directory: str, today: date) -> None:
    cutoff = today - timedelta(days=RETENTION_DAYS)
    for name in os.listdir(directory):
        stem, ext = os.path.splitext(name)
        if ext != ".jsonl":
            continue
        try:
            if datetime.strptime(stem, "%Y-%m-%d").date() < cutoff:
                os.remove(os.path.join(directory, name))
        except (ValueError, OSError):
            continue


def _line(record: dict) -> str:
    text = json.dumps(record, ensure_ascii=False, default=str, separators=(",", ":"))
    if len(text.encode("utf-8")) <= MAX_EVENT_BYTES:
        return text
    slim = {k: record[k] for k in ("recv", "session", "type", "t") if k in record}
    slim["truncated"] = True
    return json.dumps(slim, ensure_ascii=False, default=str, separators=(",", ":"))


def append(records: list[dict]) -> int:
    """Append records (each gets ``recv`` if missing); returns how many were written."""
    if not records:
        return 0
    global _last_prune
    now = time.time()
    today = date.today()
    directory = debug_dir()
    with _lock:
        os.makedirs(directory, exist_ok=True)
        if _last_prune != today:
            _prune(directory, today)
            _last_prune = today
        with open(os.path.join(directory, f"{today.isoformat()}.jsonl"), "a", encoding="utf-8") as fh:
            for record in records:
                record.setdefault("recv", round(now, 3))
                fh.write(_line(record) + "\n")
    return len(records)


def server_event(event_type: str, **data) -> None:
    """Best-effort backend-side event; diagnostics must never break a request."""
    try:
        append([{"session": "server", "type": event_type, "t": int(time.time() * 1000), **data}])
    except Exception:  # noqa: BLE001
        pass
