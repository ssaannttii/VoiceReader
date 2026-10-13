"""Web UI static files: precompressed variants and cache headers."""
from __future__ import annotations

import gzip

from fastapi import FastAPI
from fastapi.testclient import TestClient


def _app(tmp_path):
    from core.spa_static import SpaStaticFiles

    (tmp_path / "assets").mkdir()
    js = b"console.log('reader');" * 200
    (tmp_path / "assets" / "index-abc123.js").write_bytes(js)
    (tmp_path / "assets" / "index-abc123.js.gz").write_bytes(gzip.compress(js))
    (tmp_path / "index.html").write_text("<!doctype html><div id=root></div>")
    app = FastAPI()
    app.mount("/", SpaStaticFiles(directory=str(tmp_path), html=True), name="frontend")
    return TestClient(app), js


def test_serves_gzip_variant_with_immutable_cache_for_hashed_assets(tmp_path):
    client, js = _app(tmp_path)
    resp = client.get("/assets/index-abc123.js", headers={"Accept-Encoding": "gzip"})
    assert resp.status_code == 200
    assert resp.headers["content-encoding"] == "gzip"
    assert resp.headers["content-type"].startswith("text/javascript") or "javascript" in resp.headers["content-type"]
    assert resp.headers["cache-control"] == "public, max-age=31536000, immutable"
    assert resp.headers["vary"] == "Accept-Encoding"
    assert resp.content == js  # the client transparently decompresses


def test_plain_file_when_encoding_not_accepted_or_refused(tmp_path):
    client, js = _app(tmp_path)
    for header in ("identity", "gzip;q=0"):
        resp = client.get("/assets/index-abc123.js", headers={"Accept-Encoding": header})
        assert "content-encoding" not in resp.headers
        assert resp.content == js


def test_index_is_revalidated_and_conditional_requests_get_304(tmp_path):
    client, _ = _app(tmp_path)
    first = client.get("/", headers={"Accept-Encoding": "identity"})
    assert first.headers["cache-control"] == "no-cache"
    again = client.get("/", headers={"Accept-Encoding": "identity", "If-None-Match": first.headers["etag"]})
    assert again.status_code == 304
    asset = client.get("/assets/index-abc123.js", headers={"Accept-Encoding": "gzip"})
    cached = client.get(
        "/assets/index-abc123.js",
        headers={"Accept-Encoding": "gzip", "If-None-Match": asset.headers["etag"]},
    )
    assert cached.status_code == 304
