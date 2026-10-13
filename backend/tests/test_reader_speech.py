"""Prepared reading ("Lectura preparada"): rules, LLM validation (mocked
Ollama), storage/API, the render path with pauses and cache isolation."""
from __future__ import annotations

import json

import numpy as np
import pytest
from fastapi.testclient import TestClient

from services import reader_speech_llm as llm
from services import reader_speech_rules as rules

from .test_reader_api import SR, _create, env  # noqa: F401 — fixture


def _seg(text, kind="p", para=0):
    return {"text": text, "kind": kind, "para": para}


def _changes(texts, language="es", chapters=()):
    analysis = rules.analyze([_seg(t, para=i) for i, t in enumerate(texts)], list(chapters), language, names=False)
    return {(c.original, c.spoken) for c in analysis.changes}, analysis


# ── Rules: pauses ────────────────────────────────────────────────────────────


def test_spanish_dialogue_pauses_around_the_narrator_tag_and_drops_the_dashes():
    text = "—¿Sabes? —dijo—. No estoy seguro."
    lead, pieces = rules.build_spoken(text, pauses=[(at, ms, r) for at, ms, r in rules.dialogue_marks(text)[1]])
    assert lead == 0
    assert [p[2] for p in pieces] == ["¿Sabes?", "dijo.", "No estoy seguro."]
    assert [p[3] for p in pieces] == [200, 200, 0]
    assert all("—" not in p[2] for p in pieces)
    # Pieces cover the display text in order.
    assert pieces[0][0] == 0 and pieces[-1][1] == len(text)
    assert all(a[1] == b[0] for a, b in zip(pieces, pieces[1:]))


def test_dialogue_turns_short_pieces_and_inciso_without_punctuation():
    text = "—Kelsier no lo hubiese permitido —murmuró Fantasma—. Cuando estaba aquí era distinto. —El Superviviente está muerto —dijo Elend—."
    _edits, cuts = rules.dialogue_marks(text)
    # Before/after "murmuró Fantasma", before "dijo Elend" (nothing after it), the new turn.
    assert sorted(ms for _at, ms, _r in cuts) == [200, 200, 200, 350]
    _lead, pieces = rules.build_spoken(text, pauses=cuts)
    said = [p[2] for p in pieces]
    assert said[0] == "Kelsier no lo hubiese permitido"
    assert said[1] == "murmuró Fantasma."
    assert said[-1] == "dijo Elend."
    # A piece too short to synthesize alone merges, with a comma.
    _lead, pieces = rules.build_spoken("—Sí —dijo él con calma.", pauses=rules.dialogue_marks("—Sí —dijo él con calma.")[1])
    assert [p[2] for p in pieces] == ["Sí, dijo él con calma."]
    # A dash between words is a comma, not a sound.
    assert rules.build_spoken("Era —pensó— demasiado tarde.", pauses=[])[1][0][2] == "Era, pensó, demasiado tarde."


def test_structure_pauses_headings_chapters_scenes_lists_quotes_ellipsis():
    segments = [
        _seg("Capítulo 1", "h", 0),
        _seg("El ejército se arrastraba hacia la ciudad.", "p", 1),
        _seg("Nadie lo vio llegar…", "p", 1),
        _seg("* * *", "p", 2),
        _seg("Primer punto de la lista", "li", 3),
        _seg("Una cita célebre.", "quote", 4),
        _seg("Otra frase de la cita.", "quote", 4),
        _seg("Fin del capítulo.", "p", 5),
        _seg("Capítulo 2", "h", 6),
        _seg("Yo… no sé qué decir ahora mismo.", "p", 7),
    ]
    analysis = rules.analyze(segments, [{"title": "1", "segment": 0}, {"title": "2", "segment": 8}], "es")
    by = {}
    for seg, at, ms, reason in analysis.pauses:
        by.setdefault(seg, []).append((at, ms, reason))
    assert (len("Capítulo 1"), 700, "heading") in by[0]
    assert any(r == "ellipsis" and at == len(segments[2]["text"]) for at, _ms, r in by[2])
    assert {(0, 500, "scene"), (5, 500, "scene")} <= set(by[3])
    assert (len(segments[4]["text"]), 250, "list") in by[4]
    assert (0, 300, "quote") in by[5] and (len(segments[6]["text"]), 300, "quote") in by[6]
    assert (len(segments[7]["text"]), 1200, "chapter") in by[7]
    assert any(r == "ellipsis" and 0 < at < len(segments[9]["text"]) for at, _ms, r in by[9])
    # A scene break says nothing and is one second of silence.
    lead, pieces = rules.build_spoken("* * *", pauses=by[3])
    assert lead == 500 and pieces[0][2] == "" and pieces[0][3] == 500
    # Disabled rules add nothing.
    assert rules.build_spoken(segments[0]["text"], pauses=by[0], rules={"heading": False}) is None


def test_chapter_number_prefix_gets_a_pause():
    segments = [_seg("Capítulo 1", "h", 0), _seg("1. el ejército se arrastraba por la llanura.", "p", 1)]
    analysis = rules.analyze(segments, [{"title": "x", "segment": 1}], "es")
    assert [1, 3, 600, "heading"] in analysis.pauses


# ── Rules: changes ───────────────────────────────────────────────────────────


def test_roman_numerals_in_context_and_false_positives():
    found, analysis = _changes([
        "Luis XIV reinó en el siglo XVII y Felipe II antes que él.",
        "Isabel II y Carlos V; en el s. XIX llegó el Capítulo IV.",
        "MI CASA ES TU CASA y VI la luz.",
        "Juan Pablo II y Alfonso XIII.",
    ])
    assert ("XIV", "catorce") in found and ("XVII", "diecisiete") in found
    assert ("II", "segundo") in found and ("V", "quinto") in found
    assert ("s. XIX", "siglo diecinueve") in found and ("IV", "cuatro") in found
    assert ("XIII", "trece") in found
    assert ("II", "segunda") in found  # Isabel II
    assert not any(orig in ("MI", "VI") and spoken in ("mil uno", "seis", "uno") for orig, spoken in found)
    assert not any(c.original in ("MI", "VI") for c in analysis.candidates if c.kind == "roman")
    # English: "I" stays a pronoun; numerals after a section word are cardinals.
    found_en, _ = _changes(["I think Chapter IV is better than Henry VIII.", "I said I would."], "en")
    assert ("IV", "four") in found_en and ("VIII", "the eighth") in found_en
    assert not any(orig == "I" for orig, _ in found_en)


def test_abbreviations_ordinals_quantities_dates_times():
    found, _ = _changes([
        "El Sr. de la casa, p. ej., vino de EE. UU. con 1.500 hombres.",
        "Pagó 3,50 € el 12/10/1492 a las 15:30 y recorrió 25 km.",
        "La 2.ª vez, el 1.er día y el 1.º de mayo; 3,5 % entre 1936-1939.",
        "Lo vieron los Sres. García en la pág. 5.",
    ])
    expected = {
        ("Sr.", "señor"), ("p. ej.", "por ejemplo"), ("EE. UU.", "Estados Unidos"),
        ("1.500", "mil quinientos"), ("3,50 €", "tres euros con cincuenta"),
        ("12/10/1492", "doce de octubre de mil cuatrocientos noventa y dos"),
        ("a las 15:30", "a las quince y treinta"), ("25 km", "veinticinco kilómetros"),
        ("2.ª", "segunda"), ("1.er", "primer"), ("1.º", "primero"),
        ("3,5 %", "tres coma cinco por ciento"), ("Sres.", "señores"), ("pág.", "página"),
    }
    assert expected <= found
    # What the normalizer already reads is left to it.
    found2, _ = _changes(["Llegó el Sr. García con 25 soldados y un 50 % de bajas."])
    assert found2 == set()


def test_capitals_hyphens_and_name_candidates():
    texts = [
        "VIN ENCONTRÓ FINALMENTE a Elend en su estudio.",
        "Vin encontró la puerta; finalmente entró.",
        "—¡NO! —gritó. No quería verla.",
        "Era incompren- sible para todos.",
        "Kelsier sonrió. Kelsier lo sabía. Tindwyl y Tindwyl.",
    ]
    found, analysis = _changes(texts)
    assert ("VIN ENCONTRÓ FINALMENTE", "Vin encontró finalmente") in found
    assert ("NO", "No") in found
    assert ("incompren- sible", "incomprensible") in found
    names = {c.original for c in rules.analyze([_seg(t) for t in texts], [], "es").candidates if c.kind == "name"}
    assert {"Kelsier", "Tindwyl"} <= names and "Vin" not in names


# ── LLM: prompts + validation with a mocked Ollama ───────────────────────────


class FakeOllama:
    """Answers in order; a dict ``{"choice": …, "respelling": …}`` answers
    by the schema the prompt asks for."""

    def __init__(self, answers):
        self.answers = list(answers)
        self.payloads = []

    def __call__(self, payload):
        self.payloads.append(payload)
        answer = self.answers.pop(0) if self.answers else {}
        if isinstance(answer, dict) and len(answer) > 1:
            wanted = next(iter(payload["format"]["properties"]))
            answer = {wanted: answer[wanted]}
        if isinstance(answer, Exception):
            raise answer
        return {"message": {"content": answer if isinstance(answer, str) else json.dumps(answer)}}


def test_llm_choice_is_validated_and_runs_on_cpu(tmp_path):
    cand = rules.Candidate(0, 9, 12, "XXI", "roman", "Llegó Atium XXI al trono.", rules._roman_options(21, "es"))
    fake = FakeOllama([{"choice": "cardinal"}])
    client = llm.OllamaClient("fake", post=fake)
    cache = llm.AnswerCache(str(tmp_path / "cache.json"))
    assert llm.resolve(cand, client, cache) == ("veintiuno", False)
    payload = fake.payloads[0]
    assert payload["options"]["num_gpu"] == 0 and payload["options"]["temperature"] == 0
    assert payload["format"]["properties"]["choice"]["enum"][-1] == "keep"
    assert "Atium XXI" in payload["messages"][1]["content"]
    # Cached by (candidate, context): no second call.
    assert llm.resolve(cand, client, cache) == ("veintiuno", True)
    assert len(fake.payloads) == 1
    # Out-of-schema, keep, and garbage answers change nothing.
    for answer in ({"choice": "veintiuno y medio"}, {"choice": "keep"}, "not json", {"other": 1}):
        other = rules.Candidate(0, 9, 12, "XXI", "roman", f"Otra frase {answer!s} XXI.", cand.options)
        assert llm.resolve(other, llm.OllamaClient("fake", post=FakeOllama([answer]))) == (None, False)


def test_llm_respelling_validation_rejects_rewrites():
    ok = llm.validate_respelling
    assert ok("Tindwyl", {"respelling": "Tíndüil"}) == "Tíndüil"
    assert ok("Kelsier", {"respelling": "Kelsier"}) is None  # unchanged
    assert ok("Kelsier", {"respelling": "Kelsier sonrió y se fue de la sala"}) is None  # a sentence
    assert ok("Kelsier", {"respelling": "[pause 1s] Kelsier"}) is None  # markup
    assert ok("Kelsier", {"respelling": "Roberto"}) is None  # another name
    assert ok("Kelsier", {"respelling": "K3lsier"}) is None
    assert ok("Ashweather", {"respelling": "Ashuéther Cett"}) is None  # another word
    assert ok("Dockson", {"respelling": "Dohk-son"}) is None and ok("Renoux", {"respelling": "Renoo"}) is None
    assert ok("Kwaan", {"respelling": "Kuán"}) == "Kuán"
    assert ok("Kelsier", {"respelling": ""}) is None and ok("Kelsier", {}) is None


# ── Storage + API ────────────────────────────────────────────────────────────

BOOK = (
    "# Capítulo 1\n\n"
    "—¿Sabes? —dijo—. No estoy seguro de nada.\n\n"
    "Luis XIV reinó mucho tiempo en Francia.\n\n"
    "Kelsier sonrió. Kelsier lo sabía todo.\n\n"
    "Llegó Atium XXI al trono del reino."
)


@pytest.fixture
def speech(env, monkeypatch):
    from services import reader_speech

    monkeypatch.setattr(reader_speech, "_status", {})
    monkeypatch.setattr(reader_speech, "_memo", {})
    monkeypatch.setattr(reader_speech, "_fp_memo", {})
    monkeypatch.setenv("OMNIVOICE_READER_LLM", "0")
    return env


def _doc(client):
    doc = _create(client, BOOK, language="es")
    full = client.get(f"/reader/documents/{doc['id']}").json()
    return doc["id"], full["segments"]


def test_speech_is_off_by_default_and_rendering_is_unchanged(speech):
    from services import reader_speech

    client = TestClient(speech.app)
    doc_id, segments = _doc(client)
    state = client.get(f"/reader/documents/{doc_id}/speech").json()
    assert state["enabled"] is False and state["items"] == [] and state["ready"] is False
    plain = client.post(f"/reader/documents/{doc_id}/segments/1/render").json()
    assert speech.calls[-1][0] == segments[1]["text"]  # the plain path: display text
    # Cache isolation: with the option off, keys are the plain keys.
    from services import reader_render

    expected = reader_render.plan_segment(
        segments[1]["text"], engine_id="fake-engine", voice=plain["voice"], language="es"
    ).key
    assert plain["render_key"] == expected
    assert reader_speech.wait_idle(5)
    assert not (speech.data_dir / "reader" / doc_id / "speech.json").exists()


def test_enable_prepares_and_renders_prepared_text_under_its_own_keys(speech):
    from services import reader_speech

    client = TestClient(speech.app)
    doc_id, segments = _doc(client)
    plain = client.post(f"/reader/documents/{doc_id}/segments/1/render").json()
    state = client.post(f"/reader/documents/{doc_id}/speech/enable", json={"enabled": True}).json()
    assert state["enabled"] is True
    # Dialogue pauses split a sentence and change its contour: opt-in, everything else on.
    assert state["pause_rules"]["dialogue"] is False
    assert all(on for reason, on in state["pause_rules"].items() if reason != "dialogue")
    state = client.post(
        f"/reader/documents/{doc_id}/speech/enable", json={"pause_rules": {"dialogue": True}}
    ).json()
    assert state["pause_rules"]["dialogue"] is True
    assert reader_speech.wait_idle(10)
    state = client.get(f"/reader/documents/{doc_id}/speech").json()
    assert state["ready"] and state["complete"] and state["status"] == "ready"
    assert state["llm"]["status"] == "disabled"
    assert state["pause_counts"]["dialogue"] == 2 and state["pause_counts"]["heading"] == 1
    xiv = next(i for i in state["items"] if i["original"] == "XIV")
    assert xiv["spoken"] == "catorce" and xiv["source"] == "rule" and xiv["state"] == "applied"

    speech.calls.clear()
    prepared = client.post(f"/reader/documents/{doc_id}/segments/1/render").json()
    assert prepared["render_key"] != plain["render_key"] and prepared["cached"] is False
    assert [c[0] for c in speech.calls] == ["¿Sabes?", "dijo.", "No estoy seguro de nada."]
    # Word timings stay on the display text and follow the pieces + silences.
    words = prepared["words"]
    assert [segments[1]["text"][w["c0"]:w["c1"]] for w in words] == segments[1]["text"].split()
    assert all(a["start"] <= b["start"] for a, b in zip(words, words[1:]))
    # Three fake renders (1.4 s each) + two tag pauses + the paragraph pause.
    assert prepared["duration_s"] == pytest.approx(3 * 1.4 + 0.2 + 0.2 + 0.2, abs=0.02)

    # Off again: the plain key and the plain audio, instantly (cached).
    client.post(f"/reader/documents/{doc_id}/speech/enable", json={"enabled": False})
    again = client.post(f"/reader/documents/{doc_id}/segments/1/render").json()
    assert again["render_key"] == plain["render_key"] and again["cached"] is True

    # Preview both ways, whatever the switch says.
    a = client.post(f"/reader/documents/{doc_id}/speech/preview/1", json={"prepared": False}).json()
    b = client.post(f"/reader/documents/{doc_id}/speech/preview/1", json={"prepared": True}).json()
    assert a["render_key"] == plain["render_key"] and b["render_key"] == prepared["render_key"]
    assert b["prepared"] is True and a["prepared"] is False


def test_edit_revert_keep_across_recompute_and_to_dictionary(speech):
    from services import reader_speech

    client = TestClient(speech.app)
    doc_id, segments = _doc(client)
    client.post(f"/reader/documents/{doc_id}/speech/enable", json={"enabled": True})
    assert reader_speech.wait_idle(10)
    items = client.get(f"/reader/documents/{doc_id}/speech").json()["items"]
    n = next(i["n"] for i in items if i["original"] == "XIV")
    edited = client.patch(f"/reader/documents/{doc_id}/speech/items/{n}", json={"spoken": "catorce de Francia"}).json()
    item = next(i for i in edited["items"] if i["n"] == n)
    assert item["spoken"] == "catorce de Francia" and item["edited"] and item["suggested"] == "catorce"
    assert client.patch(f"/reader/documents/{doc_id}/speech/items/{n}", json={"spoken": "[pause 1s]"}).status_code == 400
    speech.calls.clear()
    client.post(f"/reader/documents/{doc_id}/segments/2/render")
    assert speech.calls[-1][0] == "Luis catorce de Francia reinó mucho tiempo en Francia."
    reverted = client.delete(f"/reader/documents/{doc_id}/speech/items/{n}").json()
    assert next(i for i in reverted["items"] if i["n"] == n)["state"] == "reverted"
    # The listener's decision survives a refresh.
    client.post(f"/reader/documents/{doc_id}/speech/prepare")
    assert reader_speech.wait_idle(10)
    items = client.get(f"/reader/documents/{doc_id}/speech").json()["items"]
    again = next(i for i in items if i["original"] == "XIV")
    assert again["state"] == "reverted" and again["spoken"] == "catorce de Francia"
    entry = client.post(f"/reader/documents/{doc_id}/speech/items/{again['n']}/to-dictionary").json()["entry"]
    assert entry["term"] == "XIV" and entry["replacement"] == "catorce de Francia" and entry["language"] == "es"
    assert client.patch(f"/reader/documents/{doc_id}/speech/items/999", json={"state": "applied"}).status_code == 404


def test_llm_candidates_with_a_mocked_ollama(speech, monkeypatch):
    from services import reader_speech

    client = TestClient(speech.app)
    doc_id, _segments = _doc(client)
    fake = FakeOllama([{"choice": "cardinal", "respelling": "Kélsier"}] * 3)
    monkeypatch.setattr(reader_speech, "_llm_cache_path", lambda: None)
    info = reader_speech.prepare_now(doc_id, client=llm.OllamaClient("fake", post=fake), use_llm=True)
    assert info["status"] == "used" and info["resolved"] >= 2
    assert all(p["options"]["num_gpu"] == 0 for p in fake.payloads)
    items = client.get(f"/reader/documents/{doc_id}/speech").json()["items"]
    xxi = next(i for i in items if i["original"] == "XXI")
    assert xxi["source"] == "llm" and xxi["spoken"] == "veintiuno" and xxi["state"] == "applied"
    name = next(i for i in items if i["original"] == "Kelsier")
    assert name["state"] == "suggested" and name["scope"] == "doc" and name["spoken"] == "Kélsier"
    # A suggestion is not read until accepted; accepting applies it everywhere.
    client.post(f"/reader/documents/{doc_id}/speech/enable", json={"enabled": True})
    speech.calls.clear()
    client.post(f"/reader/documents/{doc_id}/segments/3/render")
    assert "Kelsier" in speech.calls[-1][0]
    client.patch(f"/reader/documents/{doc_id}/speech/items/{name['n']}", json={"state": "applied"})
    speech.calls.clear()
    client.post(f"/reader/documents/{doc_id}/segments/3/render")
    assert speech.calls[-1][0].count("Kélsier") == 2


def test_resegmentation_makes_results_stale_and_reads_plainly(speech, monkeypatch):
    from services import reader_speech, reader_store

    client = TestClient(speech.app)
    doc_id, segments = _doc(client)
    client.post(f"/reader/documents/{doc_id}/speech/enable", json={"enabled": True})
    assert reader_speech.wait_idle(10)
    content = reader_store.load_content(doc_id)
    content["segments"][2]["text"] = "Otro texto distinto al original."
    reader_store._write_json_atomic(
        str(speech.data_dir / "reader" / doc_id / "content.json"), {"version": 99, **content}
    )
    monkeypatch.setattr(reader_speech, "enqueue", lambda doc_id: None)  # keep it stale for the assertions
    reader_speech._fp_memo.clear()
    state = client.get(f"/reader/documents/{doc_id}/speech").json()
    assert state["stale"] is True and state["items"] == []
    assert reader_speech.spoken_for(doc_id, reader_store.load_content(doc_id), 1) is None


# ── Render path with pauses (fake synth) ─────────────────────────────────────


def test_render_inserts_exact_silence_and_shifts_timings(env):
    import asyncio

    from services import reader_render

    text = "Uno dos, tres cuatro"
    spoken = reader_render.Spoken(pieces=((0, 8, "Uno dos", 500), (8, len(text), "tres cuatro", 0)), lead_ms=250)
    result = asyncio.run(reader_render.render_segment(text, voice="v", engine=None, language="es", spoken=spoken))
    assert [c[0] for c in env.calls] == ["Uno dos", "tres cuatro"]
    # 0.25 lead + 1.4 + 0.5 pause + 1.4 (each fake render: 0.2 + 1.0 + 0.2 s).
    assert result["duration_s"] == pytest.approx(0.25 + 1.4 + 0.5 + 1.4, abs=0.01)
    words = result["words"]
    assert [w["w"] for w in words] == ["Uno", "dos,", "tres", "cuatro"]
    assert words[0]["start"] == pytest.approx(0.25 + 0.17, abs=0.03)
    assert words[2]["start"] == pytest.approx(0.25 + 1.4 + 0.5 + 0.17, abs=0.03)
    entry = json.loads((env.data_dir / "reader" / "audio" / f"{result['render_key']}.json").read_text("utf-8"))
    assert entry["synth_text"] == "[pause 250ms] Uno dos [pause 500ms] tres cuatro"
    import wave

    with wave.open(str(env.data_dir / "reader" / "audio" / f"{result['render_key']}.wav")) as wf:
        audio = np.frombuffer(wf.readframes(wf.getnframes()), dtype="<i2")
    lead = int(0.25 * SR)
    assert not audio[:lead].any()
    gap0 = lead + int(1.4 * SR)
    assert not audio[gap0: gap0 + int(0.5 * SR)].any()


def test_cache_isolation_plain_keys_unchanged(env):
    from services import reader_render

    text = "—Hola —dijo—. Tengo 25 años."
    plain = reader_render.plan_segment(text, engine_id="e", voice="v", language="es")
    assert plain.key == reader_render.render_key("e", "v", "es", reader_render.final_text(text, "es"))
    # The pre-v2 (display-text) key is still offered, exactly as before.
    assert plain.spoken is None and plain.legacy_key == reader_render.render_key("e", "v", "es", text)
    same = reader_render.Spoken(pieces=((0, len(text), text, 0),))
    assert reader_render.plan_segment(text, engine_id="e", voice="v", language="es", spoken=same).key == plain.key
    paused = reader_render.Spoken(pieces=((0, len(text), text, 300),))
    assert reader_render.plan_segment(text, engine_id="e", voice="v", language="es", spoken=paused).key != plain.key
