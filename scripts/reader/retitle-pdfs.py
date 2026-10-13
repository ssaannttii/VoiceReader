"""Propose better titles for PDFs imported before the Reader picked titles itself.

usage: python scripts/reader/retitle-pdfs.py [--data-dir DIR] [--pdf-dir DIR] [--write]

Looks at ready PDF documents whose title is still the one older versions derived
from the file name ("9788466658898 Nacidos bruma v3 (1)") — a title the user
renamed is never touched — and proposes what an import would pick today
(``reader_import.pick_title``): the PDF's metadata title when the original file
is found in ``--pdf-dir`` (the upload itself is not kept after an import), else a
heading the stored text opens with, else the cleaned file name. The author is
filled in too when the row has none and the PDF's metadata names one.

Dry run by default: prints the proposals and opens the database read-only.
``--write`` applies them (each row only if its title is still unchanged).
Reads ``%APPDATA%\\OmniVoice`` (or ``OMNIVOICE_DATA_DIR``) by default; stop the
backend before writing.
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import sqlite3
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "backend"))

from services import reader_import  # noqa: E402

#: The stored text is searched this far for an opening heading.
_HEADING_SEGMENTS = 5


def default_data_dir() -> str:
    return os.environ.get("OMNIVOICE_DATA_DIR") or os.path.join(os.environ.get("APPDATA") or "", "OmniVoice")


def _opening_heading(data_dir: str, doc_id: str) -> str | None:
    try:
        with open(os.path.join(data_dir, "reader", doc_id, "content.json"), encoding="utf-8") as fh:
            segments = json.load(fh).get("segments") or []
    except (OSError, ValueError):
        return None
    for segment in segments[:_HEADING_SEGMENTS]:
        if segment.get("kind") == "h" and segment.get("text"):
            return segment["text"]
    return None


def propose(data_dir: str, conn: sqlite3.Connection, pdf_dir: str | None = None) -> list[dict]:
    """``{"id", "old", "new", "author"}`` for every PDF whose file-name title can be improved."""
    rows = conn.execute(
        "SELECT id, title, author, source_name FROM reader_documents"
        " WHERE source_type='file' AND COALESCE(import_status, 'ready')='ready' AND lower(source_name) LIKE '%.pdf'"
    ).fetchall()
    proposals = []
    for doc_id, title, author, source_name in rows:
        if title != reader_import.legacy_filename_title(source_name):
            continue  # renamed by the user, or already titled by a newer import
        meta = {"titles": [], "author": None, "subject": None, "heading": None}
        path = os.path.join(pdf_dir, os.path.basename(source_name)) if pdf_dir else None
        if path and os.path.isfile(path):
            with open(path, "rb") as fh:
                meta = reader_import.pdf_metadata(fh.read())
        heading = meta["heading"] or _opening_heading(data_dir, doc_id)
        new = reader_import.pick_title(meta["titles"], filename=source_name, heading=heading) or meta["subject"]
        new_author = meta["author"] if not author else None
        if (new and new != title) or new_author:
            proposals.append({"id": doc_id, "old": title, "new": new or title, "author": new_author})
    return proposals


def main(argv: list[str] | None = None) -> list[dict]:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--data-dir", default=default_data_dir(), help="the app's data folder (holds omnivoice.db)")
    ap.add_argument("--pdf-dir", help="a folder with the original PDFs (matched by file name), to read their metadata")
    ap.add_argument("--write", action="store_true", help="apply the proposals (default: dry run)")
    args = ap.parse_args(argv)
    db_path = os.path.join(args.data_dir, "omnivoice.db")
    if not os.path.isfile(db_path):
        ap.error(f"no database at {db_path}")
    if args.write:
        conn = sqlite3.connect(db_path)
    else:
        conn = sqlite3.connect(pathlib.Path(db_path).resolve().as_uri() + "?mode=ro", uri=True)
    try:
        proposals = propose(args.data_dir, conn, args.pdf_dir)
        for p in proposals:
            extra = f"  (author: {p['author']})" if p["author"] else ""
            print(f"{p['id']}  {p['old']!r} -> {p['new']!r}{extra}")
        if args.write:
            with conn:
                for p in proposals:
                    conn.execute(
                        "UPDATE reader_documents SET title=?, author=COALESCE(author, ?) WHERE id=? AND title=?",
                        (p["new"], p["author"], p["id"], p["old"]),
                    )
            print(f"{len(proposals)} document(s) updated")
        else:
            print(f"{len(proposals)} proposal(s); dry run, nothing changed (add --write to apply)")
    finally:
        conn.close()
    return proposals


if __name__ == "__main__":
    main()
