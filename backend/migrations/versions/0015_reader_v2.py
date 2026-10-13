"""Reader v2: furthest point, library state, background imports, bookmarks

Revision ID: 0015_reader_v2
Revises: 0014_reader_documents
Create Date: 2026-10-13 00:00:00.000000

Adds to ``reader_documents`` (docs/reader/SPEC.md, "v2 contract"):

* ``furthest_segment`` — the furthest segment ever reached (progress raises it,
  never lowers it);
* ``archived`` / ``completed`` — library state the listener toggles;
* ``import_status`` / ``import_progress`` / ``import_error`` — file and scan
  imports run in the background; existing rows are complete, hence
  ``'ready'``.

and the ``reader_bookmarks`` table (one row per bookmark, deleted with its
document by the store).

Additive + idempotent (guarded by sqlite_master / PRAGMA table_info, matching
0013/0014), so re-running on a fresh-install DB where ``_BASE_SCHEMA`` already
declares everything is a no-op. Mirrored into ``core/db.py::_BASE_SCHEMA``
(columns appended in the same order) so fresh installs and migrated DBs
converge, and ``_reconcile_additive_columns`` heals DBs where alembic cannot
run.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0015_reader_v2"
down_revision: Union[str, None] = "0014_reader_documents"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_COLUMNS = (
    ("furthest_segment", sa.Integer(), False, "0"),
    ("archived", sa.Integer(), False, "0"),
    ("completed", sa.Integer(), False, "0"),
    ("import_status", sa.Text(), False, "ready"),
    ("import_progress", sa.Float(), True, None),
    ("import_error", sa.Text(), True, None),
)


def _has_table(name: str) -> bool:
    bind = op.get_bind()
    row = bind.execute(
        sa.text("SELECT name FROM sqlite_master WHERE type='table' AND name=:n"),
        {"n": name},
    ).fetchone()
    return row is not None


def _has_column(table: str, column: str) -> bool:
    bind = op.get_bind()
    rows = bind.execute(sa.text(f"PRAGMA table_info({table})")).fetchall()
    return any(r[1] == column for r in rows)


def _has_index(name: str) -> bool:
    bind = op.get_bind()
    row = bind.execute(
        sa.text("SELECT name FROM sqlite_master WHERE type='index' AND name=:n"),
        {"n": name},
    ).fetchone()
    return row is not None


def upgrade() -> None:
    # 0014 created reader_documents; a DB that somehow lacks it gets the full
    # table (with these columns) from _BASE_SCHEMA at startup.
    if _has_table("reader_documents"):
        for name, type_, nullable, default in _COLUMNS:
            if not _has_column("reader_documents", name):
                op.add_column(
                    "reader_documents",
                    sa.Column(name, type_, nullable=nullable, server_default=default),
                )
        if _has_column("reader_documents", "position_segment"):
            # Existing documents: the furthest point is at least where the
            # listener is now.
            op.execute(
                "UPDATE reader_documents SET furthest_segment = position_segment"
                " WHERE furthest_segment < position_segment"
            )
    if not _has_table("reader_bookmarks"):
        op.create_table(
            "reader_bookmarks",
            sa.Column("id", sa.Text(), primary_key=True),
            sa.Column("doc_id", sa.Text(), nullable=False),
            sa.Column("segment", sa.Integer(), nullable=False),
            sa.Column("word", sa.Integer(), nullable=True),
            sa.Column("note", sa.Text(), nullable=True),
            sa.Column("created_at", sa.Float(), nullable=False),
        )
    if not _has_index("idx_reader_bookmarks_doc"):
        op.create_index("idx_reader_bookmarks_doc", "reader_bookmarks", ["doc_id"])


def downgrade() -> None:
    if _has_table("reader_bookmarks"):
        if _has_index("idx_reader_bookmarks_doc"):
            op.drop_index("idx_reader_bookmarks_doc", table_name="reader_bookmarks")
        op.drop_table("reader_bookmarks")
    if _has_table("reader_documents"):
        for name, *_ in reversed(_COLUMNS):
            if _has_column("reader_documents", name):
                op.drop_column("reader_documents", name)
