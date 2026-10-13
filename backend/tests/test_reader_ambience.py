"""Reader automatic ambience: lexicon classifier, scene splitting, smoothing,
storage invalidation and the ``GET /reader/documents/{id}/ambience`` route."""
from __future__ import annotations

import json
import os

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from services import reader_ambience as ra

RAIN_ES = (
    "Llovía desde el amanecer. La lluvia golpeaba los cristales de la posta y los charcos crecían en el camino. "
    "Marta se ajustó el chubasquero empapado y miró las gotas que resbalaban por el paraguas roto. "
    "Seguía lloviendo cuando llegó el carro del correo, con las ruedas hundidas en el barro y la lluvia "
    "cayendo sin descanso sobre los campos."
)
STORM_EN = (
    "The storm broke at midnight. Thunder rolled over the hills and lightning split the sky, while the rain "
    "hammered the shutters. Another clap of thunder shook the house; the downpour drowned every other sound "
    "and the stormy wind tore at the roof."
)
TAVERN_ES = (
    "La taberna estaba llena. El tabernero servía jarras de cerveza mientras la multitud reía y brindaba "
    "junto a la barra. En la posada nadie dormía: las risas y el bullicio de los parroquianos llenaban el "
    "salón, y una moza llevaba otra jarra a la mesa del rincón."
)
SEA_EN = (
    "The ship left the harbour at dawn. Waves broke against the bow and the sailors climbed the mast to "
    "trim the sails. Seagulls followed the boat across the open sea, and the salt spray soaked the deck as "
    "the voyage went on, the coast fading behind them over the waves."
)
DIALOGUE_ES = (
    "—No estoy de acuerdo —dijo Elena—. Deberíamos esperar a que llegue tu hermano antes de decidir. "
    "—¿Y si no viene? —preguntó Tomás—. Llevamos semanas hablando de lo mismo. "
    "—Vendrá. Siempre cumple lo que promete, aunque tarde. "
    "Tomás suspiró y pensó en todo lo que habían perdido desde entonces."
)
DIALOGUE_EN = (
    "\"I don't think that's wise,\" said Margaret. \"We should wait for your brother before deciding anything.\" "
    "\"And if he never comes?\" asked Thomas. \"We have been arguing about this for weeks.\" "
    "\"He will come. He always keeps his word, even when he is late.\" Thomas sighed and thought about the plan."
)


def _doc(*paragraph_lists: list[str], headings: bool = True) -> tuple[list[dict], list[dict]]:
    """Segments (one per paragraph) and chapters: each list is a chapter."""
    segments: list[dict] = []
    chapters: list[dict] = []
    para = 0
    for number, paragraphs in enumerate(paragraph_lists, 1):
        if headings:
            chapters.append({"title": f"Chapter {number}", "segment": len(segments)})
            segments.append({"i": len(segments), "text": f"Chapter {number}", "para": para, "kind": "h"})
            para += 1
        for text in paragraphs:
            segments.append({"i": len(segments), "text": text, "para": para, "kind": "p"})
            para += 1
    return segments, chapters


# ── Lexicon classifier ───────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("text", "language", "tag"),
    [
        (RAIN_ES, "es", "rain"),
        (STORM_EN, "en", "storm"),
        (TAVERN_ES, "es", "tavern"),
        (SEA_EN, "en", "sea"),
        (DIALOGUE_ES, "es", "none"),
        (DIALOGUE_EN, "en", "none"),
    ],
)
def test_classifier_tags_typical_passages(text, language, tag):
    verdict = ra.classify_text(text, language)
    assert verdict.tag == tag, (verdict, ra.score_text(text, language))
    if tag != "none":
        assert 0.35 <= verdict.confidence <= 1.0
        assert 0.35 <= verdict.intensity <= 1.0


def test_language_is_detected_when_unknown():
    assert ra.detect_language([RAIN_ES, DIALOGUE_ES]) == "es"
    assert ra.detect_language([STORM_EN, DIALOGUE_EN]) == "en"
    assert ra.classify_text(RAIN_ES).tag == "rain"
    # A language without a lexicon stays silent rather than guessing.
    assert ra.detect_language(["Der Regen fiel die ganze Nacht auf das Dach des Hauses."]) is None
    assert ra.classify_windows(*_doc([RAIN_ES] * 6), language="de")[0].verdict.tag == "none"


def test_words_shared_across_languages_do_not_leak():
    # Spanish "sea" (subjunctive), "gusto", "trampa" and "echo" are not sea, wind, city or cave.
    text = (
        "Sea como sea, me gusta tu gusto. Le echo la culpa a la trampa, sea quien sea, "
        "porque no me gustaba nada. Sea lo que sea, te echo de menos y me gusta pensarlo."
    )
    scores, _ = ra.score_text(text * 3, "es")
    assert not set(scores) & {"sea", "wind", "city", "cave"}


def test_figurative_uses_barely_count():
    literal, _ = ra.score_text("La lluvia caía.", "es")
    figurative, _ = ra.score_text("Una lluvia de flechas caía.", "es")
    assert figurative.get("rain", 0) < literal["rain"] * 0.5


def test_a_name_that_is_a_lexicon_word_is_ignored():
    texts = [f"Entonces Brisa sonrió y dijo que {x}." for x in ("sí", "no", "tal vez", "nunca", "mañana")]
    assert "brisa" in ra.proper_names(texts, "es")
    assert "brisa" not in ra.proper_names(["La brisa del mar soplaba suave sobre la brisa."] * 3, "es")


def test_one_word_repeated_stops_counting():
    once, _ = ra.score_text("tormenta " * 3, "es")
    many, _ = ra.score_text("tormenta " * 30, "es")
    assert many["storm"] == once["storm"]


def test_storm_wins_over_plain_rain():
    text = RAIN_ES + " Un trueno retumbó y la tormenta descargó con relámpagos sobre el valle."
    assert ra.classify_text(text, "es").tag == "storm"


def test_conflicting_cues_without_margin_are_silent():
    mixed = (
        "La taberna del puerto olía a cerveza. Desde la ventana se veía el mar y los barcos. "
        "El tabernero hablaba de las olas mientras la multitud brindaba por los marineros."
    )
    assert ra.classify_text(mixed, "es").tag == "none"


# ── Scene splitting ──────────────────────────────────────────────────────────


def test_scene_breaks_are_detected():
    for text in ("* * *", "***", "—", "#", "⁂", " ~ ~ ~ "):
        assert ra.is_scene_break(text), text
    for text in ("Hola.", "A", "1", ""):
        assert not ra.is_scene_break(text), text


def test_windows_cut_at_headings_breaks_and_every_ten_paragraphs():
    paragraphs = [f"Paragraph {n} with some words in it." for n in range(25)]
    segments, chapters = _doc(paragraphs[:12], paragraphs[12:])
    # A scene break inside the second chapter.
    segments.insert(18, {"i": 0, "text": "* * *", "para": -1, "kind": "p"})
    for i, seg in enumerate(segments):
        seg["i"] = i
    chapters = [{"title": c["title"], "segment": c["segment"] if c["segment"] < 18 else c["segment"] + 1} for c in chapters]
    windows = ra.split_windows(segments, chapters)
    # Chapter 1: 12 paragraphs → 10 + a short tail of 2 merged back = one window.
    assert [(w.start, w.end) for w in windows if w.section == windows[0].section] == [(0, 12)]
    sections = sorted({w.section for w in windows})
    assert len(sections) == 3  # chapter 1, chapter 2 before the break, after the break
    assert windows[-1].end == len(segments) - 1
    # Windows tile the document without gaps or overlaps.
    for before, after in zip(windows, windows[1:]):
        assert after.start == before.end + 1


def test_long_sections_split_into_windows_of_about_ten_paragraphs():
    segments, chapters = _doc([f"Párrafo {n}." for n in range(35)])
    windows = ra.split_windows(segments, chapters)
    sizes = [len({segments[i]["para"] for i in range(w.start, w.end + 1) if segments[i]["kind"] == "p"}) for w in windows]
    assert sizes == [10, 10, 15] or sizes == [10, 10, 10, 5]
    assert all(size >= 4 for size in sizes)


# ── Smoothing ────────────────────────────────────────────────────────────────


def _scenes_for(pattern: list[str], language: str = "es") -> list[dict]:
    texts = {"rain": RAIN_ES, "tavern": TAVERN_ES, "none": DIALOGUE_ES}
    windows = []
    for tag in pattern:
        windows.append([texts[tag]] * 10)
    segments, chapters = _doc([p for chunk in windows for p in chunk], headings=True)
    scenes, refined = ra.analyze(segments, chapters, language=language)
    assert not refined
    return scenes


def test_adjacent_scenes_with_the_same_tag_merge():
    scenes = _scenes_for(["rain", "rain", "rain"])
    assert [s["tag"] for s in scenes] == ["rain"]
    assert scenes[0]["start_segment"] == 0


def test_one_window_blip_is_ignored():
    scenes = _scenes_for(["rain", "none", "rain"])
    assert [s["tag"] for s in scenes] == ["rain"]
    scenes = _scenes_for(["none", "none", "rain", "none", "none"])
    # A lone confident window survives when it is long enough…
    assert "rain" in [s["tag"] for s in scenes]


def test_short_scenes_fall_back_to_silence(monkeypatch):
    monkeypatch.setattr(ra, "MIN_SCENE_CHARS", 10_000_000)
    scenes = _scenes_for(["none", "rain", "none"])
    assert [s["tag"] for s in scenes] == ["none"]


def test_scenes_cover_the_whole_document_in_order():
    scenes = _scenes_for(["none", "rain", "rain", "none", "tavern", "tavern"])
    assert scenes[0]["start_segment"] == 0
    for before, after in zip(scenes, scenes[1:]):
        assert after["start_segment"] == before["end_segment"] + 1
        assert after["tag"] != before["tag"]
    assert [s["tag"] for s in scenes] == ["none", "rain", "none", "tavern"]


def test_refinement_only_chooses_among_lexicon_candidates():
    # A close call between rain and tavern: the embedding decides; it never invents "sea".
    window = ra.Window(0, 0, 0, "text", 2000)
    window.verdict = ra.Verdict("none", 0.0, 0.0, ambiguous=True, candidates=("rain", "tavern"))
    quiet = ra.Window(1, 1, 0, "other", 2000)
    quiet.verdict = ra.Verdict("none", 0.0, 0.0)

    def embed(texts):
        vectors = []
        for text in texts:
            if text in ra.PROTOTYPES["tavern"]:
                vectors.append([1.0, 0.0, 0.0])
            elif text in ra.PROTOTYPES["sea"]:
                vectors.append([0.0, 0.0, 1.0])
            elif text == "text":
                vectors.append([0.9, 0.1, 0.9])
            else:
                vectors.append([0.0, 1.0, 0.0])
        return vectors

    assert ra._refine([window, quiet], embed, lambda: False)
    assert window.verdict.tag == "tavern"
    assert quiet.verdict.tag == "none"


def test_refinement_failure_keeps_the_lexicon_result():
    window = ra.Window(0, 0, 0, "text", 2000)
    window.verdict = ra.Verdict("none", 0.0, 0.0, ambiguous=True, candidates=("rain",))
    assert not ra._refine([window], lambda texts: None, lambda: False)
    assert window.verdict.tag == "none"


def test_ollama_is_skipped_when_disabled(monkeypatch):
    monkeypatch.setenv("OMNIVOICE_READER_AMBIENCE_OLLAMA", "0")
    assert ra.ollama_embedder() is None


# ── Storage and API ──────────────────────────────────────────────────────────


@pytest.fixture
def env(tmp_path, monkeypatch):
    import core.config
    import core.db
    from api.routers import reader
    from services import reader_import, reader_jobs

    monkeypatch.setattr(core.config, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(core.db, "DB_PATH", str(tmp_path / "reader.db"))
    core.db.ensure_schema()
    monkeypatch.setattr(reader_import, "GROUP_CHARS", 0)
    reader_jobs.wait_idle()
    monkeypatch.setitem(reader_jobs._resumed, "done", True)
    monkeypatch.setattr(ra, "embedder_factory", lambda: None)
    app = FastAPI()
    app.include_router(reader.router)
    return TestClient(app)


def _create(client, text: str) -> str:
    resp = client.post("/reader/documents/text", json={"text": text, "title": "Test"})
    assert resp.status_code == 200, resp.text
    return resp.json()["id"]


def _ready(client, doc_id: str) -> dict:
    body = client.get(f"/reader/documents/{doc_id}/ambience").json()
    if body["status"] == "computing":
        assert ra.wait_idle(30)
        body = client.get(f"/reader/documents/{doc_id}/ambience").json()
    assert body["status"] == "ready", body
    return body


def _book(*blocks: str) -> str:
    return "\n\n".join(f"# Capítulo {n}\n\n" + "\n\n".join([text] * 8) for n, text in enumerate(blocks, 1))


def test_api_computes_stores_and_serves_scenes(env):
    doc_id = _create(env, _book(DIALOGUE_ES, RAIN_ES, TAVERN_ES))
    first = env.get(f"/reader/documents/{doc_id}/ambience").json()
    assert first["status"] in {"computing", "ready"}
    body = _ready(env, doc_id)
    tags = [s["tag"] for s in body["scenes"]]
    assert tags == ["none", "rain", "tavern"], body["scenes"]
    for scene in body["scenes"]:
        assert set(scene) == {"start_segment", "end_segment", "tag", "confidence", "intensity"}
    from services import reader_store

    stored = json.loads(open(os.path.join(reader_store.document_dir(doc_id), "ambience.json"), encoding="utf-8").read())
    assert stored["version"] == ra.AMBIENCE_VERSION
    assert stored["segment_count"] == env.get(f"/reader/documents/{doc_id}").json()["segment_count"]
    assert stored["scenes"] == body["scenes"]


def test_api_unknown_document_is_404(env):
    assert env.get("/reader/documents/" + "0" * 32 + "/ambience").status_code == 404


def test_stale_analysis_is_recomputed_when_the_content_changes(env):
    from services import reader_store

    doc_id = _create(env, _book(RAIN_ES, DIALOGUE_ES))
    assert [s["tag"] for s in _ready(env, doc_id)["scenes"]] == ["rain", "none"]
    # Re-segmentation / edits: the content changes under the stored analysis.
    path = os.path.join(reader_store.document_dir(doc_id), "content.json")
    content = json.loads(open(path, encoding="utf-8").read())
    for seg in content["segments"]:
        if seg["kind"] == "p":
            seg["text"] = TAVERN_ES
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(content, fh)
    assert env.get(f"/reader/documents/{doc_id}/ambience").json()["status"] == "computing"
    assert [s["tag"] for s in _ready(env, doc_id)["scenes"]] == ["tavern"]


def test_stale_analysis_of_an_older_version_is_recomputed(env, monkeypatch):
    doc_id = _create(env, _book(RAIN_ES))
    _ready(env, doc_id)
    monkeypatch.setattr(ra, "AMBIENCE_VERSION", ra.AMBIENCE_VERSION + 1)
    assert env.get(f"/reader/documents/{doc_id}/ambience").json()["status"] == "computing"
    assert _ready(env, doc_id)["scenes"][0]["tag"] == "rain"


def test_language_change_invalidates(env):
    doc_id = _create(env, _book(RAIN_ES))
    _ready(env, doc_id)
    assert env.patch(f"/reader/documents/{doc_id}", json={"language": "de"}).status_code == 200
    body = _ready(env, doc_id)
    assert [s["tag"] for s in body["scenes"]] == ["none"]


def test_imports_are_analyzed_only_after_the_feature_was_used(env):
    from services import reader_store

    doc_id = _create(env, _book(RAIN_ES))
    assert ra.wait_idle(10)
    assert not os.path.exists(os.path.join(reader_store.document_dir(doc_id), "ambience.json"))
    _ready(env, doc_id)  # the listener turns Automático on
    other = _create(env, _book(TAVERN_ES))
    assert ra.wait_idle(30)
    assert os.path.exists(os.path.join(reader_store.document_dir(other), "ambience.json"))


def test_refinement_rewrites_the_stored_analysis(env, monkeypatch):
    calls = []

    def factory():
        def embed(texts):
            calls.append(len(texts))
            return None  # Ollama answered nothing useful: lexicon result stays

        return embed

    monkeypatch.setattr(ra, "embedder_factory", factory)
    doc_id = _create(env, _book("La taberna del puerto olía a cerveza. Desde la ventana se veía el mar y los barcos."))
    body = _ready(env, doc_id)
    assert [s["tag"] for s in body["scenes"]] == ["none"]
    assert body["refined"] is False
