"""Reader library storage: ``reader_documents`` rows + per-document content files.

Layout (docs/reader/SPEC.md)::

    <DATA_DIR>/reader/<id>/content.json   {"version", "segments", "chapters"}
    <DATA_DIR>/reader/<id>/cover.<ext>    optional (jpg | png | webp)
    <DATA_DIR>/reader/<id>/assets/        images of ``img`` segments (img-001.jpg …)
    <DATA_DIR>/reader/<id>/source/        upload awaiting a background import
                                          (removed once the import succeeds)

Rows hold metadata and the listening position; content files hold the
segments, written once at import and never rewritten. A document imported in
the background has a row (``import_status='importing'``) before it has a
content file; ``reader_bookmarks`` rows are deleted with their document.
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
ASSETS_DIR = "assets"
#: Asset names as the importer writes them; anything else is never served.
_ASSET_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.(jpg|png|gif|webp|avif)$")
ASSET_MEDIA_TYPES = {
    "jpg": "image/jpeg", "png": "image/png", "gif": "image/gif", "webp": "image/webp", "avif": "image/avif",
}
_UPDATABLE = ("title", "voice_id", "engine", "language", "archived", "completed")
_BOOL_COLUMNS = ("has_cover", "archived", "completed")
_COLUMNS = (
    "id", "title", "author", "source_type", "source_name", "source_url", "language",
    "segment_count", "char_count", "chapter_count", "has_cover", "voice_id", "engine",
    "position_segment", "created_at", "updated_at", "last_opened_at",
    "furthest_segment", "archived", "completed", "import_status", "import_progress", "import_error",
)
IMPORT_READY = "ready"
IMPORT_RUNNING = "importing"
IMPORT_ERROR = "error"
SOURCE_DIR = "source"


class DocumentNotFound(LookupError):
    """No Reader document with that id."""


class DocumentImporting(RuntimeError):
    """The document is still being imported in the background (HTTP 409)."""


class BookmarkNotFound(LookupError):
    """No Reader bookmark with that id."""


class CollectionNotFound(LookupError):
    """No Reader collection with that id."""


class CollectionNameTaken(ValueError):
    """Another collection already has that name (compared case-insensitively)."""


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
    for key in _BOOL_COLUMNS:
        doc[key] = bool(doc[key])
    doc["furthest_segment"] = int(doc["furthest_segment"] or 0)
    doc["import_status"] = doc["import_status"] or IMPORT_READY
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


def _write_content(
    folder: str, segments: list[dict], chapters: list[dict], cover, assets: Optional[dict[str, bytes]] = None
) -> bool:
    """Write the images, content.json (+ cover); returns whether a cover was stored."""
    if assets:
        target = os.path.join(folder, ASSETS_DIR)
        os.makedirs(target, exist_ok=True)
        for name, data in assets.items():
            if _ASSET_NAME_RE.match(name):
                with open(os.path.join(target, name), "wb") as fh:
                    fh.write(data)
    _write_json_atomic(
        os.path.join(folder, "content.json"),
        {"version": _segmentation_version(), "segments": segments, "chapters": chapters},
    )
    if cover and cover[0] and cover[1] in COVER_EXTENSIONS:
        with open(os.path.join(folder, f"cover.{cover[1]}"), "wb") as fh:
            fh.write(cover[0])
        return True
    return False


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
    assets: Optional[dict[str, bytes]] = None,
) -> dict:
    """Persist a new document and return its ``DocumentSummary``."""
    doc_id = uuid.uuid4().hex
    folder = document_dir(doc_id)
    os.makedirs(folder, exist_ok=True)
    try:
        has_cover = _write_content(folder, segments, chapters, cover, assets)
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


# ── Background imports ───────────────────────────────────────────────────────

_SAFE_NAME_RE = re.compile(r"[^\w.\-]+", re.UNICODE)
_IMPORT_META = "import.json"


def _safe_name(name: str, index: int) -> str:
    stem = _SAFE_NAME_RE.sub("_", os.path.basename(name or "")).strip("._")[:80] or "upload"
    return f"{index:03d}-{stem}"


@_with_schema
def create_pending(
    *,
    title: str,
    source_type: str,
    files: list[tuple[str, bytes]],
    source_name: Optional[str] = None,
    language: Optional[str] = None,
    meta: Optional[dict] = None,
) -> dict:
    """A placeholder row (``import_status='importing'``) + the stored upload.

    ``files`` are ``(original name, bytes)``, kept in order under
    ``<id>/source/`` until the background import finishes; ``meta`` (the
    import options) is kept beside them so an interrupted import can resume.
    """
    doc_id = uuid.uuid4().hex
    folder = document_dir(doc_id)
    source = os.path.join(folder, SOURCE_DIR)
    os.makedirs(source, exist_ok=True)
    try:
        for index, (name, data) in enumerate(files):
            with open(os.path.join(source, _safe_name(name, index)), "wb") as fh:
                fh.write(data)
        _write_json_atomic(os.path.join(folder, _IMPORT_META), meta or {})
        now = time.time()
        with db_conn() as conn:
            conn.execute(
                "INSERT INTO reader_documents (id, title, author, source_type, source_name,"
                " source_url, language, segment_count, char_count, chapter_count, has_cover,"
                " voice_id, engine, position_segment, created_at, updated_at, last_opened_at,"
                " import_status, import_progress, import_error)"
                " VALUES (?,?,NULL,?,?,NULL,?,0,0,0,0,NULL,NULL,0,?,?,NULL,?,0,NULL)",
                (doc_id, title, source_type, source_name, language, now, now, IMPORT_RUNNING),
            )
    except BaseException:
        shutil.rmtree(folder, ignore_errors=True)
        raise
    return get_summary(doc_id)


def import_meta(doc_id: str) -> dict:
    """The options a pending import was started with (``{}`` when unknown)."""
    try:
        with open(os.path.join(document_dir(doc_id), _IMPORT_META), encoding="utf-8") as fh:
            meta = json.load(fh)
    except (OSError, ValueError):
        return {}
    return meta if isinstance(meta, dict) else {}


def source_files(doc_id: str) -> list[tuple[str, str]]:
    """``(original name, path)`` of a pending import's stored upload, in order."""
    source = os.path.join(document_dir(doc_id), SOURCE_DIR)
    try:
        names = sorted(os.listdir(source))
    except FileNotFoundError:
        return []
    return [(name.split("-", 1)[-1], os.path.join(source, name)) for name in names]


@_with_schema
def pending_imports() -> list[str]:
    with db_conn() as conn:
        rows = conn.execute(
            "SELECT id FROM reader_documents WHERE import_status=? ORDER BY created_at",
            (IMPORT_RUNNING,),
        ).fetchall()
    return [row["id"] for row in rows]


@_with_schema
def set_import_progress(doc_id: str, fraction: float) -> None:
    with db_conn() as conn:
        conn.execute(
            "UPDATE reader_documents SET import_progress=? WHERE id=? AND import_status=?",
            (round(max(0.0, min(1.0, float(fraction))), 3), doc_id, IMPORT_RUNNING),
        )


@_with_schema
def complete_import(
    doc_id: str,
    *,
    title: str,
    segments: list[dict],
    chapters: list[dict],
    author: Optional[str] = None,
    language: Optional[str] = None,
    cover: Optional[tuple[bytes, str]] = None,
    assets: Optional[dict[str, bytes]] = None,
    keep_title_unless: Optional[str] = None,
) -> Optional[dict]:
    """Write the imported content and mark the row ready.

    With ``keep_title_unless`` (the placeholder title the row was created
    with), a title the user changed while the import ran is kept.
    Returns the summary, or ``None`` when the document was deleted meanwhile
    (its folder is removed again).
    """
    folder = document_dir(doc_id)
    has_cover = _write_content(folder, segments, chapters, cover, assets)
    with db_conn() as conn:
        updated = conn.execute(
            "UPDATE reader_documents SET title=CASE WHEN ? IS NULL OR title=? THEN ? ELSE title END, author=?,"
            " language=?, segment_count=?,"
            " char_count=?, chapter_count=?, has_cover=?, import_status=?, import_progress=NULL,"
            " import_error=NULL, updated_at=? WHERE id=? AND import_status=?",
            (
                keep_title_unless, keep_title_unless, title,
                author, language, len(segments), sum(len(s["text"]) for s in segments),
                len(chapters), int(has_cover), IMPORT_READY, time.time(), doc_id, IMPORT_RUNNING,
            ),
        ).rowcount
    if not updated:
        shutil.rmtree(folder, ignore_errors=True)
        return None
    shutil.rmtree(os.path.join(folder, SOURCE_DIR), ignore_errors=True)
    try:
        os.remove(os.path.join(folder, _IMPORT_META))
    except OSError:
        pass
    return get_summary(doc_id)


@_with_schema
def fail_import(doc_id: str, message: str) -> None:
    """Mark a background import failed; the stored upload is kept for a retry."""
    with db_conn() as conn:
        conn.execute(
            "UPDATE reader_documents SET import_status=?, import_progress=NULL, import_error=?,"
            " updated_at=? WHERE id=? AND import_status=?",
            (IMPORT_ERROR, (message or "the import failed")[:500], time.time(), doc_id, IMPORT_RUNNING),
        )


@_with_schema
def restart_import(doc_id: str) -> dict:
    """Put a failed import back in the queue (its upload must still be stored)."""
    doc = get_summary(doc_id)
    if doc["import_status"] != IMPORT_ERROR or not source_files(doc_id):
        raise ValueError("this document has nothing to retry")
    with db_conn() as conn:
        conn.execute(
            "UPDATE reader_documents SET import_status=?, import_progress=0, import_error=NULL,"
            " updated_at=? WHERE id=?",
            (IMPORT_RUNNING, time.time(), doc_id),
        )
    return get_summary(doc_id)


def require_ready(doc: dict) -> dict:
    """Raise :class:`DocumentImporting` unless the document's content exists.

    ``exc.args[0]`` is ``"importing"`` while the import runs and
    ``"import_error"`` after it failed (no content to open either way).
    """
    status = doc.get("import_status") or IMPORT_READY
    if status == IMPORT_RUNNING:
        raise DocumentImporting("importing")
    if status != IMPORT_READY:
        raise DocumentImporting("import_error")
    return doc


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


def _segmentation_version() -> int:
    from services.reader_import import SEGMENTATION_VERSION

    return SEGMENTATION_VERSION


def _upgrade_content(doc_id: str, path: str, content: dict) -> dict:
    """Re-segment a document saved with an older layout (sentence grouping, broken
    paragraphs, small-caps chapter openings), keeping the listener's place."""
    from services.reader_import import is_paginated, repair_segments

    with db_conn() as conn:
        meta = conn.execute(
            "SELECT source_type, source_name FROM reader_documents WHERE id=?", (doc_id,)
        ).fetchone()
    segments, chapters, mapping = repair_segments(
        content.get("segments") or [],
        content.get("chapters") or [],
        paginated=bool(meta) and is_paginated(meta["source_type"], meta["source_name"]),
    )
    upgraded = {"version": _segmentation_version(), "segments": segments, "chapters": chapters}
    _write_json_atomic(path, upgraded)
    def remap(old) -> int:
        old = int(old or 0)
        return mapping[old] if old < len(mapping) else len(segments)

    with db_conn() as conn:
        row = conn.execute(
            "SELECT position_segment, furthest_segment FROM reader_documents WHERE id=?", (doc_id,)
        ).fetchone()
        if row is not None:
            conn.execute(
                "UPDATE reader_documents SET segment_count=?, chapter_count=?, position_segment=?,"
                " furthest_segment=? WHERE id=?",
                (len(segments), len(chapters), remap(row["position_segment"]), remap(row["furthest_segment"]), doc_id),
            )
        for mark in conn.execute("SELECT id, segment FROM reader_bookmarks WHERE doc_id=?", (doc_id,)).fetchall():
            # Word offsets pointed into the old, shorter segment: drop them.
            conn.execute(
                "UPDATE reader_bookmarks SET segment=?, word=NULL WHERE id=?",
                (min(remap(mark["segment"]), max(len(segments) - 1, 0)), mark["id"]),
            )
    return upgraded


def load_content(doc_id: str) -> dict:
    path = os.path.join(document_dir(doc_id), "content.json")
    try:
        with open(path, encoding="utf-8") as fh:
            content = json.load(fh)
    except FileNotFoundError as exc:
        raise DocumentNotFound(doc_id) from exc
    if int(content.get("version") or 1) < _segmentation_version():
        content = _upgrade_content(doc_id, path, content)
    return {"segments": content.get("segments") or [], "chapters": content.get("chapters") or []}


@_with_schema
def open_document(doc_id: str) -> dict:
    """Full ``Document`` (summary + segments + chapters); stamps last_opened_at.

    Raises :class:`DocumentImporting` while a background import runs.
    """
    require_ready(get_summary(doc_id))
    with db_conn() as conn:
        conn.execute(
            "UPDATE reader_documents SET last_opened_at=? WHERE id=?", (time.time(), doc_id)
        )
    content = load_content(doc_id)  # first: it may regroup and renumber the summary fields
    for segment in content["segments"]:
        # Stored by asset name; served as the API path of the image.
        if segment.get("kind") == "img" and segment.get("src") and "/" not in segment["src"]:
            segment["src"] = asset_url(doc_id, segment["src"])
    doc = get_summary(doc_id)
    doc.update(content)
    return doc


def asset_url(doc_id: str, name: str) -> str:
    return f"/reader/documents/{doc_id}/assets/{name}"


def asset_path(doc_id: str, name: str) -> Optional[tuple[str, str]]:
    """``(path, media_type)`` of one of the document's images, or ``None``.

    Only names the importer writes are accepted (no separators, no dot segments,
    raster extensions), and the resolved path must stay inside the asset folder.
    """
    if not _ASSET_NAME_RE.match(name or ""):
        return None
    folder = os.path.realpath(os.path.join(document_dir(doc_id), ASSETS_DIR))
    path = os.path.realpath(os.path.join(folder, name))
    if os.path.dirname(path) != folder or not os.path.isfile(path):
        return None
    return path, ASSET_MEDIA_TYPES[name.rsplit(".", 1)[1]]


@_with_schema
def update_document(doc_id: str, fields: dict) -> dict:
    changes = {k: (int(bool(v)) if k in _BOOL_COLUMNS else v) for k, v in fields.items() if k in _UPDATABLE}
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
    """Move the listening position; raise ``furthest_segment`` (never lower it)
    and mark the document completed once the last segment is reached."""
    doc = require_ready(get_summary(doc_id))
    count = int(doc["segment_count"])
    segment = max(0, min(int(segment), count))
    reached_end = count > 0 and (segment >= count or (count > 1 and segment >= count - 1))
    with db_conn() as conn:
        conn.execute(
            "UPDATE reader_documents SET position_segment=?, furthest_segment=MAX(furthest_segment, ?),"
            " completed=CASE WHEN ? THEN 1 ELSE completed END, updated_at=? WHERE id=?",
            (segment, segment, int(reached_end), time.time(), doc_id),
        )


@_with_schema
def delete_document(doc_id: str) -> None:
    get_summary(doc_id)
    with db_conn() as conn:
        conn.execute("DELETE FROM reader_documents WHERE id=?", (doc_id,))
        conn.execute("DELETE FROM reader_bookmarks WHERE doc_id=?", (doc_id,))
        conn.execute("DELETE FROM reader_collection_items WHERE doc_id=?", (doc_id,))
    shutil.rmtree(document_dir(doc_id), ignore_errors=True)


# ── Bookmarks ────────────────────────────────────────────────────────────────

_BOOKMARK_COLUMNS = ("id", "doc_id", "segment", "word", "note", "created_at")


def _bookmark(row) -> dict:
    return {key: row[key] for key in _BOOKMARK_COLUMNS}


@_with_schema
def list_bookmarks(doc_id: str) -> list[dict]:
    get_summary(doc_id)
    with db_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM reader_bookmarks WHERE doc_id=?"
            " ORDER BY segment, COALESCE(word, -1), created_at",
            (doc_id,),
        ).fetchall()
    return [_bookmark(r) for r in rows]


@_with_schema
def add_bookmark(doc_id: str, segment: int, word: Optional[int] = None, note: Optional[str] = None) -> dict:
    """Raises ``ValueError`` for a segment outside the document."""
    doc = require_ready(get_summary(doc_id))
    if not 0 <= int(segment) < int(doc["segment_count"]):
        raise ValueError("segment out of range")
    bookmark_id = uuid.uuid4().hex
    with db_conn() as conn:
        conn.execute(
            "INSERT INTO reader_bookmarks (id, doc_id, segment, word, note, created_at) VALUES (?,?,?,?,?,?)",
            (bookmark_id, doc_id, int(segment), word, note, time.time()),
        )
    return get_bookmark(bookmark_id)


@_with_schema
def get_bookmark(bookmark_id: str) -> dict:
    if not valid_id(bookmark_id):
        raise BookmarkNotFound(bookmark_id)
    with db_conn() as conn:
        row = conn.execute("SELECT * FROM reader_bookmarks WHERE id=?", (bookmark_id,)).fetchone()
    if row is None:
        raise BookmarkNotFound(bookmark_id)
    return _bookmark(row)


@_with_schema
def update_bookmark(bookmark_id: str, note: Optional[str]) -> dict:
    get_bookmark(bookmark_id)
    with db_conn() as conn:
        conn.execute("UPDATE reader_bookmarks SET note=? WHERE id=?", (note, bookmark_id))
    return get_bookmark(bookmark_id)


@_with_schema
def delete_bookmark(bookmark_id: str) -> None:
    get_bookmark(bookmark_id)
    with db_conn() as conn:
        conn.execute("DELETE FROM reader_bookmarks WHERE id=?", (bookmark_id,))


# ── Collections ──────────────────────────────────────────────────────────────
# Named groups of documents (shelves). A document can be in several; deleting a
# collection only drops its membership rows, never a document.

MAX_COLLECTION_NAME = 100


def _collection_name(name: str) -> str:
    """Whitespace-collapsed name; ``ValueError`` when empty."""
    clean = " ".join((name or "").split())[:MAX_COLLECTION_NAME]
    if not clean:
        raise ValueError("name is empty")
    return clean


def _check_name_free(conn, name: str, except_id: Optional[str] = None) -> None:
    wanted = name.casefold()
    for row in conn.execute("SELECT id, name FROM reader_collections").fetchall():
        if row["id"] != except_id and row["name"].casefold() == wanted:
            raise CollectionNameTaken(name)


def _require_collection(conn, collection_id: str):
    if not valid_id(collection_id):
        raise CollectionNotFound(collection_id)
    row = conn.execute("SELECT * FROM reader_collections WHERE id=?", (collection_id,)).fetchone()
    if row is None:
        raise CollectionNotFound(collection_id)
    return row


def _require_documents(conn, doc_ids) -> list[str]:
    """Unique, existing document ids in the given order (``DocumentNotFound`` otherwise)."""
    ids = list(dict.fromkeys(doc_ids))
    for doc_id in ids:
        if not valid_id(doc_id):
            raise DocumentNotFound(doc_id)
    if ids:
        marks = ",".join("?" for _ in ids)
        found = {
            r["id"]
            for r in conn.execute(f"SELECT id FROM reader_documents WHERE id IN ({marks})", ids)  # noqa: S608 — placeholders only
        }
        missing = [doc_id for doc_id in ids if doc_id not in found]
        if missing:
            raise DocumentNotFound(missing[0])
    return ids


def _collections(conn, collection_id: Optional[str] = None) -> list[dict]:
    where, args = ("WHERE id=?", (collection_id,)) if collection_id else ("", ())
    rows = conn.execute(
        f"SELECT * FROM reader_collections {where} ORDER BY created_at, id", args  # noqa: S608 — fixed clauses
    ).fetchall()
    members: dict[str, list[str]] = {row["id"]: [] for row in rows}
    # Only documents that exist (a row deleted outside the store never shows).
    item_where = "WHERE i.collection_id=?" if collection_id else ""
    for item in conn.execute(
        "SELECT i.collection_id, i.doc_id FROM reader_collection_items i"
        f" JOIN reader_documents d ON d.id = i.doc_id {item_where}"  # noqa: S608 — fixed clauses
        " ORDER BY i.added_at, i.doc_id",
        args,
    ):
        if item["collection_id"] in members:
            members[item["collection_id"]].append(item["doc_id"])
    return [
        {
            "id": row["id"],
            "name": row["name"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "doc_ids": members[row["id"]],
        }
        for row in rows
    ]


@_with_schema
def list_collections() -> list[dict]:
    """Every collection (oldest first) with its document ids (in the order added)."""
    with db_conn() as conn:
        return _collections(conn)


@_with_schema
def get_collection(collection_id: str) -> dict:
    with db_conn() as conn:
        _require_collection(conn, collection_id)
        return _collections(conn, collection_id)[0]


def _add_items(conn, collection_id: str, doc_ids: list[str], now: float) -> None:
    for offset, doc_id in enumerate(doc_ids):
        # A tiny offset keeps the given order for documents added together.
        conn.execute(
            "INSERT OR IGNORE INTO reader_collection_items (collection_id, doc_id, added_at) VALUES (?,?,?)",
            (collection_id, doc_id, now + offset * 1e-6),
        )


@_with_schema
def create_collection(name: str, doc_ids=()) -> dict:
    """New collection, optionally with documents already in it.

    Raises ``ValueError`` (empty name), :class:`CollectionNameTaken` or
    :class:`DocumentNotFound`.
    """
    clean = _collection_name(name)
    collection_id = uuid.uuid4().hex
    now = time.time()
    with db_conn() as conn:
        _check_name_free(conn, clean)
        ids = _require_documents(conn, doc_ids)
        conn.execute(
            "INSERT INTO reader_collections (id, name, created_at, updated_at) VALUES (?,?,?,?)",
            (collection_id, clean, now, now),
        )
        _add_items(conn, collection_id, ids, now)
    return get_collection(collection_id)


@_with_schema
def rename_collection(collection_id: str, name: str) -> dict:
    clean = _collection_name(name)
    with db_conn() as conn:
        _require_collection(conn, collection_id)
        _check_name_free(conn, clean, except_id=collection_id)
        conn.execute(
            "UPDATE reader_collections SET name=?, updated_at=? WHERE id=?",
            (clean, time.time(), collection_id),
        )
    return get_collection(collection_id)


@_with_schema
def delete_collection(collection_id: str) -> None:
    """Remove the collection and its membership rows; documents are untouched."""
    with db_conn() as conn:
        _require_collection(conn, collection_id)
        conn.execute("DELETE FROM reader_collection_items WHERE collection_id=?", (collection_id,))
        conn.execute("DELETE FROM reader_collections WHERE id=?", (collection_id,))


@_with_schema
def add_to_collection(collection_id: str, doc_ids) -> dict:
    """Add documents (already present ones are kept where they are)."""
    now = time.time()
    with db_conn() as conn:
        _require_collection(conn, collection_id)
        ids = _require_documents(conn, doc_ids)
        _add_items(conn, collection_id, ids, now)
        conn.execute("UPDATE reader_collections SET updated_at=? WHERE id=?", (now, collection_id))
    return get_collection(collection_id)


@_with_schema
def remove_from_collection(collection_id: str, doc_id: str) -> dict:
    """Take a document out of a collection (a no-op when it was not in it)."""
    with db_conn() as conn:
        _require_collection(conn, collection_id)
        removed = conn.execute(
            "DELETE FROM reader_collection_items WHERE collection_id=? AND doc_id=?",
            (collection_id, doc_id),
        ).rowcount
        if removed:
            conn.execute(
                "UPDATE reader_collections SET updated_at=? WHERE id=?", (time.time(), collection_id)
            )
    return get_collection(collection_id)


def _md_inline(text: str) -> str:
    return " ".join((text or "").split())


def bookmarks_markdown(doc_id: str) -> str:
    """The document's bookmarks as Markdown: title, then per bookmark the
    chapter (when it changes), the quoted segment text and the note."""
    doc = require_ready(get_summary(doc_id))
    marks = list_bookmarks(doc_id)
    content = load_content(doc_id)
    segments = content["segments"]
    chapters = sorted(content["chapters"], key=lambda c: c["segment"])
    lines = [f"# {_md_inline(doc['title'])}", ""]
    if doc.get("author"):
        lines += [f"*{_md_inline(doc['author'])}*", ""]
    if not marks:
        lines += ["_No bookmarks yet._", ""]
    current_chapter = None
    for mark in marks:
        chapter = None
        for item in chapters:
            if item["segment"] <= mark["segment"]:
                chapter = item
            else:
                break
        if chapter is not None and chapter is not current_chapter:
            lines += [f"## {_md_inline(chapter['title'])}", ""]
            current_chapter = chapter
        index = mark["segment"]
        segment = segments[index] if 0 <= index < len(segments) else {}
        # An image has no text: quote its description instead.
        text = segment.get("text") or segment.get("alt") or segment.get("caption") or ""
        if text:
            lines += [f"> {_md_inline(text)}", ""]
        note = (mark.get("note") or "").strip()
        if note:
            lines += [*note.splitlines(), ""]
        lines += ["---", ""]
    if lines[-2:] == ["---", ""]:
        lines = lines[:-2]
    return "\n".join(lines).rstrip() + "\n"


def cover_path(doc_id: str) -> Optional[tuple[str, str]]:
    """``(path, media_type)`` of the document's cover, or ``None``."""
    folder = document_dir(doc_id)
    for ext in COVER_EXTENSIONS:
        path = os.path.join(folder, f"cover.{ext}")
        if os.path.isfile(path):
            return path, COVER_MEDIA_TYPES[ext]
    return None
