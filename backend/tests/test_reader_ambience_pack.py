"""Reader recorded ambience pack: manifest parsing, the file whitelist and the
``GET /reader/ambience/pack`` routes (services/reader_ambience_pack.py)."""
from __future__ import annotations

import json
import os

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from services import reader_ambience_pack as pack


def _bed(**patch) -> dict:
    bed = {
        "id": "rain", "tag": "rain", "file": "rain.ogg", "rms": 0.1, "duration": 74.2, "sha256": "abc",
        "title": "Rain_06.wav", "author": "Q.K.", "license": "CC0-1.0",
        "source_url": "https://freesound.org/people/Q.K./sounds/56311/",
    }
    bed.update(patch)
    return bed


@pytest.fixture
def folder(tmp_path, monkeypatch):
    monkeypatch.setenv(pack.ENV_DIR, str(tmp_path))
    (tmp_path / "rain.ogg").write_bytes(b"OggS-rain")
    (tmp_path / "mist.ogg").write_bytes(b"OggS-mist")
    (tmp_path / "secret.txt").write_text("no")
    return tmp_path


def _write(folder, beds) -> None:
    path = folder / pack.MANIFEST
    path.write_text(json.dumps({"version": 1, "beds": beds}), encoding="utf-8")
    # A rewrite within the same mtime tick must not be served from the cache.
    stat = os.stat(path)
    os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000))


def test_no_pack_means_unavailable(tmp_path, monkeypatch):
    monkeypatch.setenv(pack.ENV_DIR, str(tmp_path / "missing"))
    assert pack.manifest() == {"available": False, "beds": []}
    assert pack.bed_path("rain.ogg") is None


def test_default_folder_is_under_the_data_dir(monkeypatch, tmp_path):
    import core.config

    monkeypatch.delenv(pack.ENV_DIR, raising=False)
    monkeypatch.setattr(core.config, "DATA_DIR", str(tmp_path))
    assert pack.pack_dir() == os.path.join(str(tmp_path), "reader", "ambience")


def test_manifest_keeps_only_valid_beds_with_files(folder):
    _write(folder, [
        _bed(),
        _bed(id="mist", tag="mist", file="mist.ogg", rms=0.05),
        _bed(id="gone", file="gone.ogg"),             # file missing
        _bed(id="bad", file="../rain.ogg"),            # path tricks
        _bed(id="txt", file="secret.txt"),             # not audio
        _bed(id="loud", rms=7),                        # nonsense loudness
        _bed(id="tag", tag="Rain Storm"),              # malformed tag
        "nope",
    ])
    found = pack.manifest()
    assert found["available"] is True
    assert [b["id"] for b in found["beds"]] == ["rain", "mist"]
    assert found["beds"][0]["license"] == "CC0-1.0"
    assert found["beds"][0]["source_url"].startswith("https://freesound.org/")


def test_unreadable_manifest_is_unavailable(folder):
    (folder / pack.MANIFEST).write_text("{not json", encoding="utf-8")
    assert pack.manifest()["available"] is False


def test_only_listed_files_are_served(folder):
    _write(folder, [_bed()])
    path, media_type = pack.bed_path("rain.ogg")
    assert path.endswith("rain.ogg") and media_type == "audio/ogg"
    assert pack.bed_path("mist.ogg") is None  # present but not in the manifest
    assert pack.bed_path("secret.txt") is None
    assert pack.bed_path("..\\rain.ogg") is None
    assert pack.bed_path("manifest.json") is None


def test_routes(folder):
    from api.routers import reader

    _write(folder, [_bed()])
    app = FastAPI()
    app.include_router(reader.router)
    client = TestClient(app)
    body = client.get("/reader/ambience/pack").json()
    assert body["available"] is True and body["beds"][0]["file"] == "rain.ogg"
    resp = client.get("/reader/ambience/pack/rain.ogg")
    assert resp.status_code == 200
    assert resp.content == b"OggS-rain"
    assert resp.headers["content-type"].startswith("audio/ogg")
    assert client.get("/reader/ambience/pack/mist.ogg").status_code == 404
    assert client.get("/reader/ambience/pack/secret.txt").status_code == 404
    assert client.get("/reader/ambience/pack/..%2Frain.ogg").status_code == 404
