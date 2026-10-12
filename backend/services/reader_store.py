"""Reader library storage: ``reader_documents`` rows + per-document content files.

Layout (docs/reader/SPEC.md)::

    <DATA_DIR>/reader/<id>/content.json   {"version", "segments", "chapters"}
    <DATA_DIR>/reader/<id>/cover.<ext>    optional (jpg | png | webp)

Rows hold metadata and the listening position; content files hold the
segments, written once at import and never rewritten.
"""
from __future__ import annotations

import functools
import json
import os
import re
import shutil
import sqlite3
import time
import uuid
from typing import Any, Optional

from core.db import db_conn

#: Characters per second at 1x, for the "~N min left" estimate.
CHARS_PER_SECOND = 15.0
COVER_EXTENSIONS = ("jpg", "png", "webp")
COVER_MEDIA_TYPES = {"jpg": "image/jpeg", "png": "image/png", "webp": "image/webp"}

_ID_RE = re.compile(r"^[0-9a-f]{32}$")
_UPDATABLE = ("title", "voice_id", "engine", "language")
_COLUMNS = (
    "id", "title", "author", "source_type", "source_name", "source_url", "language",
    "segment_count", "char_count", "chapter_count", "has_cover", "voice_id", "engine",
    "position_segment", "created_at", "updated_at", "last_opened_at",
)


class DocumentNotFound(LookupError):
    """No Reader document with that id."""


def reader_dir() -> str:
    from core.config import DATA_DIR

    return os.path.join(DATA_DIR, "reader")


def valid_id(doc_id: str) -> bool:
    return bool(_ID_RE.match(doc_id or ""))


def document_dir(doc_id: str) -> str:
    if not valid_id(doc_id):
        raise DocumentNotFound(doc_id)
    return os.path.join(reader_dir(), doc_id)


def _with_schema(fn):
    """Self-heal a DB that never got the table (a DB init skipped, a test DB)."""

    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except sqlite3.OperationalError as exc:
            if "no such table" not in str(exc).lower():
                raise
            from core.db import ensure_schema

            ensure_schema()
            return fn(*args, **kwargs)

    return wrapper


def summary_from_row(row) -> dict:
    doc = {key: row[key] for key in _COLUMNS}
    doc["has_cover"] = bool(doc["has_cover"])
    count = int(doc["segment_count"] or 0)
    position = int(doc["position_segment"] or 0)
    doc["progress"] = round(min(1.0, position / count), 4) if count else 0.0
    doc["est_duration_s"] = round(float(doc["char_count"] or 0) / CHARS_PER_SECOND, 1)
    return doc


def _write_json_atomic(path: str, payload: Any) -> None:
    tmp = f"{path}.{uuid.uuid4().hex[:8]}.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)


@_with_schema
def create_document(
    *,
    title: str,
    source_type: str,
    segments: list[dict],
    chapters: list[dict],
    author: Optional[str] = None,
    source_name: Optional[str] = None,
    source_url: Optional[str] = None,
    language: Optional[str] = None,
    cover: Optional[tuple[bytes, str]] = None,
) -> dict:
    """Persist a new document and return its ``DocumentSummary``."""
    doc_id = uuid.uuid4().hex
    folder = document_dir(doc_id)
    os.makedirs(folder, exist_ok=True)
    try:
        _write_json_atomic(
            os.path.join(folder, "content.json"),
            {"version": 1, "segments": segments, "chapters": chapters},
        )
        has_cover = False
        if cover and cover[0] and cover[1] in COVER_EXTENSIONS:
            with open(os.path.join(folder, f"cover.{cover[1]}"), "wb") as fh:
                fh.write(cover[0])
            has_cover = True
        now = time.time()
        with db_conn() as conn:
            conn.execute(
                "INSERT INTO reader_documents (id, title, author, source_type, source_name,"
                " source_url, language, segment_count, char_count, chapter_count, has_cover,"
                " voice_id, engine, position_segment, created_at, updated_at, last_opened_at)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,0,?,?,NULL)",
                (
                    doc_id, title, author, source_type, source_name, source_url, language,
                    len(segments), sum(len(s["text"]) for s in segments), len(chapters),
                    int(has_cover), now, now,
                ),
            )
    except BaseException:
        shutil.rmtree(folder, ignore_errors=True)
        raise
    return get_summary(doc_id)


@_with_schema
def list_documents() -> list[dict]:
    with db_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM reader_documents"
            " ORDER BY COALESCE(last_opened_at, created_at) DESC, created_at DESC"
        ).fetchall()
    return [summary_from_row(r) for r in rows]


@_with_schema
def get_summary(doc_id: str) -> dict:
    if not valid_id(doc_id):
        raise DocumentNotFound(doc_id)
    with db_conn() as conn:
        row = conn.execute("SELECT * FROM reader_documents WHERE id=?", (doc_id,)).fetchone()
    if row is None:
        raise DocumentNotFound(doc_id)
    return summary_from_row(row)


def load_content(doc_id: str) -> dict:
    path = os.path.join(document_dir(doc_id), "content.json")
    try:
        with open(path, encoding="utf-8") as fh:
            content = json.load(fh)
    except FileNotFoundError as exc:
        raise DocumentNotFound(doc_id) from exc
    return {"segments": content.get("segments") or [], "chapters": content.get("chapters") or []}


@_with_schema
def open_document(doc_id: str) -> dict:
    """Full ``Document`` (summary + segments + chapters); stamps last_opened_at."""
    get_summary(doc_id)
    with db_conn() as conn:
        conn.execute(
            "UPDATE reader_documents SET last_opened_at=? WHERE id=?", (time.time(), doc_id)
        )
    doc = get_summary(doc_id)
    doc.update(load_content(doc_id))
    return doc


@_with_schema
def update_document(doc_id: str, fields: dict) -> dict:
    changes = {k: v for k, v in fields.items() if k in _UPDATABLE}
    get_summary(doc_id)
    if changes:
        assignments = ", ".join(f"{k}=?" for k in changes)
        with db_conn() as conn:
            conn.execute(
                f"UPDATE reader_documents SET {assignments}, updated_at=? WHERE id=?",  # noqa: S608 — keys allowlisted
                (*changes.values(), time.time(), doc_id),
            )
    return get_summary(doc_id)


@_with_schema
def set_progress(doc_id: str, segment: int) -> None:
    doc = get_summary(doc_id)
    count = int(doc["segment_count"])
    segment = max(0, min(int(segment), count))
    with db_conn() as conn:
        conn.execute(
            "UPDATE reader_documents SET position_segment=?, updated_at=? WHERE id=?",
            (segment, time.time(), doc_id),
        )


@_with_schema
def delete_document(doc_id: str) -> None:
    get_summary(doc_id)
    with db_conn() as conn:
        conn.execute("DELETE FROM reader_documents WHERE id=?", (doc_id,))
    shutil.rmtree(document_dir(doc_id), ignore_errors=True)


def cover_path(doc_id: str) -> Optional[tuple[str, str]]:
    """``(path, media_type)`` of the document's cover, or ``None``."""
    folder = document_dir(doc_id)
    for ext in COVER_EXTENSIONS:
        path = os.path.join(folder, f"cover.{ext}")
        if os.path.isfile(path):
            return path, COVER_MEDIA_TYPES[ext]
    return None
