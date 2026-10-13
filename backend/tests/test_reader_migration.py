"""Reader migrations 0014_reader_documents + 0015_reader_v2: upgrade,
idempotency, downgrade, and convergence with ``core.db._BASE_SCHEMA``
(dual-path discipline)."""
from __future__ import annotations

import importlib
import os
import sqlite3

_PREVIOUS = "0013_generation_history_design_recipe"
_V1 = "0014_reader_documents"
_HEAD = "0015_reader_v2"
_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _alembic(command_name, db_path, target):
    from alembic import command
    from alembic.config import Config

    cfg = Config(os.path.join(_ROOT, "alembic.ini"))
    cfg.set_main_option("sqlalchemy.url", f"sqlite:///{db_path}")
    getattr(command, command_name)(cfg, target)


def _cols(db_path, table="reader_documents"):
    with sqlite3.connect(str(db_path)) as conn:
        rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    norm = {"FLOAT": "REAL"}
    return [(r[1], norm.get(r[2].upper(), r[2].upper()), r[3], r[5]) for r in rows]


def _defaults(db_path, table="reader_documents"):
    with sqlite3.connect(str(db_path)) as conn:
        rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    return {r[1]: (r[4] or "").strip("'\"") or None for r in rows}


def _indexes(db_path, table):
    with sqlite3.connect(str(db_path)) as conn:
        return sorted(r[1] for r in conn.execute(f"PRAGMA index_list({table})") if not r[1].startswith("sqlite_"))


def _base():
    return importlib.import_module("core.db")._BASE_SCHEMA


def _pre_reader_db(path):
    with sqlite3.connect(str(path)) as conn:
        conn.executescript(_base())
        conn.execute("DROP TABLE reader_documents")
        conn.execute("DROP TABLE reader_bookmarks")
        conn.execute("INSERT INTO voice_profiles (id, name) VALUES ('keep', 'Mine')")
        conn.commit()
    _alembic("stamp", path, _PREVIOUS)


def _fresh(path):
    with sqlite3.connect(str(path)) as conn:
        conn.executescript(_base())
    return path


def test_migration_is_the_single_head():
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    script = ScriptDirectory.from_config(Config(os.path.join(_ROOT, "alembic.ini")))
    assert script.get_heads() == [_HEAD]


def test_upgrade_adds_tables_matching_base_schema_and_keeps_rows(tmp_path):
    migrated = tmp_path / "user.db"
    _pre_reader_db(migrated)
    _alembic("upgrade", migrated, "head")
    _alembic("upgrade", migrated, "head")  # idempotent
    fresh = _fresh(tmp_path / "fresh.db")
    for table in ("reader_documents", "reader_bookmarks"):
        assert _cols(migrated, table) and _cols(migrated, table) == _cols(fresh, table)
        assert _defaults(migrated, table) == _defaults(fresh, table)
        assert _indexes(migrated, table) == _indexes(fresh, table)
    with sqlite3.connect(str(migrated)) as conn:
        assert conn.execute("SELECT id, name FROM voice_profiles").fetchall() == [("keep", "Mine")]


def test_v1_rows_get_v2_defaults_and_furthest_from_position(tmp_path):
    dbf = tmp_path / "user.db"
    _pre_reader_db(dbf)
    _alembic("upgrade", dbf, _V1)
    with sqlite3.connect(str(dbf)) as conn:
        conn.execute(
            "INSERT INTO reader_documents (id, title, source_type, segment_count, char_count, position_segment)"
            " VALUES ('d1', 'Book', 'file', 10, 100, 7)"
        )
        conn.commit()
    _alembic("upgrade", dbf, "head")
    with sqlite3.connect(str(dbf)) as conn:
        row = conn.execute(
            "SELECT furthest_segment, archived, completed, import_status, import_progress, import_error"
            " FROM reader_documents WHERE id='d1'"
        ).fetchone()
    assert row == (7, 0, 0, "ready", None, None)


def test_upgrade_is_a_noop_on_fresh_install(tmp_path):
    dbf = _fresh(tmp_path / "fresh.db")
    before = (_cols(dbf), _cols(dbf, "reader_bookmarks"))
    _alembic("stamp", dbf, _PREVIOUS)
    _alembic("upgrade", dbf, "head")
    assert (_cols(dbf), _cols(dbf, "reader_bookmarks")) == before


def test_downgrade_to_v1_then_drops_table(tmp_path):
    dbf = tmp_path / "user.db"
    _pre_reader_db(dbf)
    _alembic("upgrade", dbf, "head")
    _alembic("downgrade", dbf, _V1)
    names = [c[0] for c in _cols(dbf)]
    assert "furthest_segment" not in names and "import_status" not in names and names
    assert _cols(dbf, "reader_bookmarks") == []
    _alembic("upgrade", dbf, "head")  # and back up again
    assert _cols(dbf) == _cols(_fresh(tmp_path / "fresh.db"))
    _alembic("downgrade", dbf, _PREVIOUS)
    assert _cols(dbf) == []


def test_reconcile_adds_v2_columns_when_alembic_cannot_run(tmp_path, monkeypatch):
    import core.db

    dbf = tmp_path / "user.db"
    _pre_reader_db(dbf)
    _alembic("upgrade", dbf, _V1)
    monkeypatch.setattr(core.db, "DB_PATH", str(dbf))
    core.db.ensure_schema()  # CREATE IF NOT EXISTS + additive column reconcile
    names = [c[0] for c in _cols(dbf)]
    assert names[-6:] == [
        "furthest_segment", "archived", "completed", "import_status", "import_progress", "import_error",
    ]
    assert _cols(dbf, "reader_bookmarks")
