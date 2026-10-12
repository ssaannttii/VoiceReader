"""Reader: library of documents to listen to

Revision ID: 0014_reader_documents
Revises: 0013_generation_history_design_recipe
Create Date: 2026-10-12 00:00:00.000000

Adds the ``reader_documents`` table backing the Reader library
(docs/reader/SPEC.md). Each row is one imported document (pasted text, file or
article URL); its segments live in ``<DATA_DIR>/reader/<id>/content.json`` and
rendered sentence audio in the content-addressed ``<DATA_DIR>/reader/audio``
cache, so the row only carries metadata, the last voice/engine used and the
listening position.

Additive + idempotent (guarded by sqlite_master, matching 0008), so re-running
on a fresh-install DB where ``_BASE_SCHEMA`` already created the table is a
no-op. The same table is mirrored into ``core/db.py::_BASE_SCHEMA`` so fresh
installs and migrated DBs converge on an identical end-state.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0014_reader_documents"
down_revision: Union[str, None] = "0013_generation_history_design_recipe"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_table(name: str) -> bool:
    bind = op.get_bind()
    row = bind.execute(
        sa.text("SELECT name FROM sqlite_master WHERE type='table' AND name=:n"),
        {"n": name},
    ).fetchone()
    return row is not None


def upgrade() -> None:
    if _has_table("reader_documents"):
        return
    op.create_table(
        "reader_documents",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("author", sa.Text(), nullable=True),
        sa.Column("source_type", sa.Text(), nullable=False),
        sa.Column("source_name", sa.Text(), nullable=True),
        sa.Column("source_url", sa.Text(), nullable=True),
        sa.Column("language", sa.Text(), nullable=True),
        sa.Column("segment_count", sa.Integer(), nullable=False),
        sa.Column("char_count", sa.Integer(), nullable=False),
        sa.Column("chapter_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("has_cover", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("voice_id", sa.Text(), nullable=True),
        sa.Column("engine", sa.Text(), nullable=True),
        sa.Column("position_segment", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.Float(), nullable=True),
        sa.Column("updated_at", sa.Float(), nullable=True),
        sa.Column("last_opened_at", sa.Float(), nullable=True),
    )


def downgrade() -> None:
    if _has_table("reader_documents"):
        op.drop_table("reader_documents")
