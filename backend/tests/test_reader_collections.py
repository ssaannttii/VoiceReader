"""Reader collections (docs/reader/SPEC.md "Collections"): named groups of
documents shared by every device — create, rename, delete, add/remove, and the
rule that deleting a collection never deletes a document."""
from __future__ import annotations

import sqlite3

from fastapi.testclient import TestClient

from .test_reader_api import _create, env  # noqa: F401 — fixture

_MISSING = "0" * 32


def _two_docs(client):
    first = _create(client, "# First\n\nOne sentence to read here.")
    second = _create(client, "# Second\n\nAnother sentence to read here.")
    return first["id"], second["id"]


def test_create_list_rename_and_delete_keeps_documents(env):
    client = TestClient(env.app)
    a, b = _two_docs(client)
    assert client.get("/reader/collections").json() == []

    novels = client.post("/reader/collections", json={"name": "  Novelas   de  verano ", "doc_ids": [b, a, b]})
    assert novels.status_code == 200, novels.text
    novels = novels.json()
    assert novels["name"] == "Novelas de verano"
    assert novels["doc_ids"] == [b, a]  # unique, in the order given
    work = client.post("/reader/collections", json={"name": "Trabajo"}).json()
    assert work["doc_ids"] == []

    listed = client.get("/reader/collections").json()
    assert [c["name"] for c in listed] == ["Novelas de verano", "Trabajo"]  # oldest first

    renamed = client.patch(f"/reader/collections/{work['id']}", json={"name": "Oficina"}).json()
    assert renamed["name"] == "Oficina" and renamed["updated_at"] >= work["updated_at"]

    assert client.delete(f"/reader/collections/{novels['id']}").json() == {"ok": True}
    assert [c["id"] for c in client.get("/reader/collections").json()] == [work["id"]]
    # The documents are still in the library.
    assert {d["id"] for d in client.get("/reader/documents").json()} == {a, b}
    with sqlite3.connect(str(env.data_dir / "reader.db")) as conn:
        assert conn.execute("SELECT COUNT(*) FROM reader_collection_items").fetchone()[0] == 0


def test_add_remove_and_a_document_in_several_collections(env):
    client = TestClient(env.app)
    a, b = _two_docs(client)
    one = client.post("/reader/collections", json={"name": "Uno"}).json()
    two = client.post("/reader/collections", json={"name": "Dos", "doc_ids": [a]}).json()

    added = client.post(f"/reader/collections/{one['id']}/documents", json={"doc_ids": [a, b]}).json()
    assert added["doc_ids"] == [a, b]
    again = client.post(f"/reader/collections/{one['id']}/documents", json={"doc_ids": [b]}).json()
    assert again["doc_ids"] == [a, b]  # idempotent, keeps its place

    by_id = {c["id"]: c["doc_ids"] for c in client.get("/reader/collections").json()}
    assert by_id == {one["id"]: [a, b], two["id"]: [a]}

    removed = client.delete(f"/reader/collections/{one['id']}/documents/{a}").json()
    assert removed["doc_ids"] == [b]
    # Removing what is not there is a no-op.
    assert client.delete(f"/reader/collections/{one['id']}/documents/{a}").json()["doc_ids"] == [b]
    assert client.get("/reader/collections").json()[1]["doc_ids"] == [a]


def test_deleting_a_document_takes_it_out_of_every_collection(env):
    client = TestClient(env.app)
    a, b = _two_docs(client)
    client.post("/reader/collections", json={"name": "Uno", "doc_ids": [a, b]})
    client.post("/reader/collections", json={"name": "Dos", "doc_ids": [a]})
    assert client.delete(f"/reader/documents/{a}").json() == {"ok": True}
    assert [c["doc_ids"] for c in client.get("/reader/collections").json()] == [[b], []]
    with sqlite3.connect(str(env.data_dir / "reader.db")) as conn:
        rows = conn.execute("SELECT doc_id FROM reader_collection_items").fetchall()
    assert sorted(r[0] for r in rows) == [b]


def test_validation_and_errors(env):
    client = TestClient(env.app)
    a, _ = _two_docs(client)
    shelf = client.post("/reader/collections", json={"name": "Ensayos"}).json()

    assert client.post("/reader/collections", json={"name": "   "}).status_code == 400
    assert client.post("/reader/collections", json={"name": "ensayos"}).status_code == 409  # case-insensitive
    other = client.post("/reader/collections", json={"name": "Poesía"}).json()
    assert client.patch(f"/reader/collections/{other['id']}", json={"name": "ENSAYOS"}).status_code == 409
    # Renaming to its own name (another case) is fine.
    assert client.patch(f"/reader/collections/{shelf['id']}", json={"name": "ensayos"}).json()["name"] == "ensayos"
    assert client.patch(f"/reader/collections/{shelf['id']}", json={"name": ""}).status_code == 400
    long_name = client.post("/reader/collections", json={"name": "x" * 150}).json()
    assert len(long_name["name"]) == 100

    for method, path, body in (
        ("patch", f"/reader/collections/{_MISSING}", {"name": "Nada"}),
        ("delete", f"/reader/collections/{_MISSING}", None),
        ("delete", "/reader/collections/not-an-id", None),
        ("post", f"/reader/collections/{_MISSING}/documents", {"doc_ids": [a]}),
        ("delete", f"/reader/collections/{_MISSING}/documents/{a}", None),
    ):
        resp = getattr(client, method)(path, **({"json": body} if body is not None else {}))
        assert resp.status_code == 404, (method, path, resp.text)
        assert resp.json()["detail"] == "Collection not found"

    # Unknown documents are refused and nothing is added.
    bad = client.post(f"/reader/collections/{shelf['id']}/documents", json={"doc_ids": [a, _MISSING]})
    assert bad.status_code == 404 and bad.json()["detail"] == "Document not found"
    assert client.post("/reader/collections", json={"name": "Nueva", "doc_ids": ["nope"]}).status_code == 404
    assert [c["name"] for c in client.get("/reader/collections").json()] == ["ensayos", "Poesía", "x" * 100]
    assert client.get("/reader/collections").json()[0]["doc_ids"] == []
    assert client.post(f"/reader/collections/{shelf['id']}/documents", json={"doc_ids": []}).status_code == 422
