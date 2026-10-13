"""Background imports for the Reader (file uploads and page scans).

``POST /reader/documents/file`` and ``/scan`` store the upload under
``<doc>/source/`` and insert a row with ``import_status='importing'``; this
module parses it off the request path and finishes the row as ``ready`` (with
content) or ``error`` (with a readable message).

One worker thread, one import at a time: parsing a PDF and OCR are CPU-bound
blocking work, and a dedicated thread keeps them off the event loop and the
GPU pool without depending on any particular event loop's lifetime. Jobs are
FIFO.

Restart behaviour: the upload stays on disk until the import succeeds, so rows
left ``importing`` by a crash or restart are **resumed** — :func:`resume_pending`
runs on the first Reader request after start-up (the library list the client
polls). A row whose upload is gone becomes ``error`` with a message asking to
add the file again; a failed import keeps its upload and can be re-queued with
``POST /reader/documents/{id}/retry``.
"""
from __future__ import annotations

import logging
import queue
import threading
import time
from typing import Optional

from services import reader_import, reader_store

logger = logging.getLogger("omnivoice.reader")

KIND_FILE = "file"
KIND_SCAN = "scan"
#: Progress writes are throttled to one per this many seconds.
_PROGRESS_INTERVAL_S = 0.5

_queue: "queue.Queue[str]" = queue.Queue()
_queued: set[str] = set()
_lock = threading.Lock()
_worker: Optional[threading.Thread] = None
_resumed = {"done": False}
_current = {"id": None}


def enqueue(doc_id: str) -> None:
    """Queue a stored upload for import (no-op if it is already queued).

    The import options (``kind``, ``language``, ``title``) come from the
    document's ``import.json`` (``reader_store.create_pending(meta=...)``).
    """
    global _worker
    with _lock:
        if doc_id in _queued or _current["id"] == doc_id:
            return
        _queued.add(doc_id)
        _queue.put(doc_id)
        if _worker is None or not _worker.is_alive():
            _worker = threading.Thread(target=_run, name="reader-import", daemon=True)
            _worker.start()


def resume_pending() -> None:
    """Re-queue imports a previous process left half-done (once per process)."""
    with _lock:
        if _resumed["done"]:
            return
        _resumed["done"] = True
    try:
        pending = reader_store.pending_imports()
    except Exception:  # noqa: BLE001 — never break the library listing
        logger.warning("Reader: could not look for interrupted imports", exc_info=True)
        return
    for doc_id in pending:
        with _lock:
            if doc_id in _queued or _current["id"] == doc_id:
                continue
        if not reader_store.source_files(doc_id):
            reader_store.fail_import(doc_id, "the import was interrupted and the upload is gone; add the file again")
            continue
        logger.info("Reader: resuming the interrupted import of %s", doc_id)
        enqueue(doc_id)


def _run() -> None:
    global _worker
    while True:
        try:
            doc_id = _queue.get(timeout=30.0)
        except queue.Empty:
            with _lock:
                if _queue.empty():
                    _worker = None
                    return
            continue
        with _lock:
            _queued.discard(doc_id)
            _current["id"] = doc_id
        try:
            run_import(doc_id)
        except Exception:  # noqa: BLE001 — the worker must survive any one import
            logger.exception("Reader: import of %s crashed", doc_id)
        finally:
            with _lock:
                _current["id"] = None
            _queue.task_done()


def _error_message(exc: BaseException) -> str:
    from services import reader_ocr

    if isinstance(exc, (reader_import.ReaderImportError, reader_ocr.OcrUnavailable)):
        return str(exc)
    from services.reader_render import _public_error

    return f"the import failed: {_public_error(exc)}"


def run_import(doc_id: str) -> None:
    """Import one stored upload and finish its row. Blocking; never raises for
    a bad file (the row records the error instead)."""
    try:
        files = reader_store.source_files(doc_id)
    except reader_store.DocumentNotFound:
        return
    meta = reader_store.import_meta(doc_id)
    kind = meta.get("kind") or KIND_FILE
    language = meta.get("language") or None
    title = meta.get("title") or None
    if not files:
        reader_store.fail_import(doc_id, "the uploaded file is missing; add it again")
        return
    last = {"t": 0.0}

    def progress(fraction: float) -> None:
        now = time.monotonic()
        if now - last["t"] >= _PROGRESS_INTERVAL_S or fraction >= 1.0:
            last["t"] = now
            reader_store.set_import_progress(doc_id, fraction)

    try:
        if kind == KIND_SCAN:
            images = []
            for _name, path in files:
                with open(path, "rb") as fh:
                    images.append(fh.read())
            doc = reader_import.import_scan(images, title=title, language=language, progress=progress)
        else:
            name, path = files[0]
            with open(path, "rb") as fh:
                data = fh.read()
            doc = reader_import.import_file(name, data, language=language, progress=progress)
    except Exception as exc:  # noqa: BLE001 — recorded on the row
        if not isinstance(exc, reader_import.ReaderImportError):
            logger.warning("Reader: import of %s failed", doc_id, exc_info=True)
        reader_store.fail_import(doc_id, _error_message(exc))
        return
    try:
        done = reader_store.complete_import(
            doc_id,
            title=doc.title,
            author=doc.author,
            language=doc.language,
            segments=doc.segments,
            chapters=doc.chapters,
            cover=doc.cover,
            assets=doc.assets,
        )
    except reader_store.DocumentNotFound:
        return
    if done is not None:
        from services import reader_ambience

        reader_ambience.after_import(doc_id)


def wait_idle(timeout: float = 30.0) -> bool:
    """Block until the queue is drained (tests, shutdown hooks)."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with _lock:
            if not _queued and _current["id"] is None and _queue.empty():
                return True
        time.sleep(0.02)
    return False
