"""Reader collections: user-named groups of documents (shelves)

Revision ID: 0016_reader_collections
Revises: 0015_reader_v2
Create Date: 2026-10-13 12:00:00.000000

Adds ``reader_collections`` (one row per collection the listener names) and
``reader_collection_items`` (membership: a document can be in several
collections). Deleting a collection deletes its membership rows only — never a
document; deleting a document removes it from every collection (the store does
both, docs/reader/SPEC.md "Collections").

Additive + idempotent (guarded by sqlite_master, matching 0014/0015), so
re-running on a fresh-install DB where ``_BASE_SCHEMA`` already declares the
tables is a no-op. Mirrored into ``core/db.py::_BASE_SCHEMA`` so fresh
installs and migrated DBs converge.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0016_reader_collections"
down_revision: Union[str, None] = "0015_reader_v2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _exists(kind: str, name: str) -> bool:
    bind = op.get_bind()
    row = bind.execute(
        sa.text("SELECT name FROM sqlite_master WHERE type=:k AND name=:n"),
        {"k": kind, "n": name},
    ).fetchone()
    return row is not None


def upgrade() -> None:
    if not _exists("table", "reader_collections"):
        op.create_table(
            "reader_collections",
            sa.Column("id", sa.Text(), primary_key=True),
            sa.Column("name", sa.Text(), nullable=False),
            sa.Column("created_at", sa.Float(), nullable=False),
            sa.Column("updated_at", sa.Float(), nullable=False),
        )
    if not _exists("table", "reader_collection_items"):
        op.create_table(
            "reader_collection_items",
            sa.Column("collection_id", sa.Text(), nullable=False),
            sa.Column("doc_id", sa.Text(), nullable=False),
            sa.Column("added_at", sa.Float(), nullable=False),
            sa.PrimaryKeyConstraint("collection_id", "doc_id"),
        )
    if not _exists("index", "idx_reader_collection_items_doc"):
        op.create_index("idx_reader_collection_items_doc", "reader_collection_items", ["doc_id"])


def downgrade() -> None:
    if _exists("table", "reader_collection_items"):
        if _exists("index", "idx_reader_collection_items_doc"):
            op.drop_index("idx_reader_collection_items_doc", table_name="reader_collection_items")
        op.drop_table("reader_collection_items")
    if _exists("table", "reader_collections"):
        op.drop_table("reader_collections")
