"""Migration 0014_reader_documents: upgrade, idempotency, downgrade, and
convergence with ``core.db._BASE_SCHEMA`` (dual-path discipline)."""
from __future__ import annotations

import importlib
import os
import sqlite3

_PREVIOUS = "0013_generation_history_design_recipe"
_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _alembic(command_name, db_path, target):
    from alembic import command
    from alembic.config import Config

    cfg = Config(os.path.join(_ROOT, "alembic.ini"))
    cfg.set_main_option("sqlalchemy.url", f"sqlite:///{db_path}")
    getattr(command, command_name)(cfg, target)


def _cols(db_path):
    with sqlite3.connect(str(db_path)) as conn:
        rows = conn.execute("PRAGMA table_info(reader_documents)").fetchall()
    norm = {"FLOAT": "REAL"}
    return [(r[1], norm.get(r[2].upper(), r[2].upper()), r[3], r[5]) for r in rows]


def _pre_reader_db(path):
    base = importlib.import_module("core.db")._BASE_SCHEMA
    with sqlite3.connect(str(path)) as conn:
        conn.executescript(base)
        conn.execute("DROP TABLE reader_documents")
        conn.execute("INSERT INTO voice_profiles (id, name) VALUES ('keep', 'Mine')")
        conn.commit()
    _alembic("stamp", path, _PREVIOUS)


def test_migration_is_the_single_head():
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    script = ScriptDirectory.from_config(Config(os.path.join(_ROOT, "alembic.ini")))
    assert script.get_heads() == ["0014_reader_documents"]


def test_upgrade_adds_table_matching_base_schema_and_keeps_rows(tmp_path):
    migrated = tmp_path / "user.db"
    _pre_reader_db(migrated)
    _alembic("upgrade", migrated, "head")
    _alembic("upgrade", migrated, "head")  # idempotent
    fresh = tmp_path / "fresh.db"
    with sqlite3.connect(str(fresh)) as conn:
        conn.executescript(importlib.import_module("core.db")._BASE_SCHEMA)
    assert _cols(migrated) and _cols(migrated) == _cols(fresh)
    with sqlite3.connect(str(migrated)) as conn:
        assert conn.execute("SELECT id, name FROM voice_profiles").fetchall() == [("keep", "Mine")]


def test_upgrade_is_a_noop_on_fresh_install(tmp_path):
    dbf = tmp_path / "fresh.db"
    with sqlite3.connect(str(dbf)) as conn:
        conn.executescript(importlib.import_module("core.db")._BASE_SCHEMA)
    _alembic("stamp", dbf, _PREVIOUS)
    _alembic("upgrade", dbf, "head")
    assert _cols(dbf)


def test_downgrade_drops_table(tmp_path):
    dbf = tmp_path / "user.db"
    _pre_reader_db(dbf)
    _alembic("upgrade", dbf, "head")
    _alembic("downgrade", dbf, _PREVIOUS)
    assert _cols(dbf) == []
