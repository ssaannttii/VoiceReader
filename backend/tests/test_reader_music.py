"""Reader background music: palettes and prompts, palette rules, moods,
hysteresis, spots and coverage, the engine runner (job JSON, candidate choice,
retries, yielding to the voice) and the ``/reader/documents/{id}/music`` routes.

No GPU and no music venv: the worker is replaced by fakes."""
from __future__ import annotations

import importlib.util
import json
import os
import re
import sys
import types

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from services import reader_ambience as ra
from services import reader_music as rm
from services import reader_music_engine as engine

TENSION_ES = (
    "El peligro acechaba en cada esquina. Los enemigos atacaron por sorpresa y la lucha estalló junto al muro; "
    "gritos, sangre y una emboscada que nadie esperaba. Huir era imposible: la amenaza crecía y el combate "
    "se volvió desesperado mientras los heridos caían."
)
CALM_ES = (
    "La tarde era tranquila. Reinaba la calma en el jardín y una paz serena lo envolvía todo; el agua corría "
    "suave y lentamente, y Marta descansaba en silencio, relajada, mientras el día se apagaba apacible."
)
DREAD_ES = (
    "El cadáver yacía en la tumba abierta. Un terror helado le recorrió la espalda: aquel horror siniestro, "
    "la pesadilla de una muerte macabra, el pavor de las tinieblas donde algo espantoso esperaba."
)
NEUTRAL_ES = (
    "Pedro abrió la puerta y dejó el abrigo en la silla. Después revisó las cuentas del mes, anotó dos cifras "
    "en el cuaderno y preguntó a su hermana si el tren de las ocho seguía saliendo a la misma hora."
)
DIALOGUE_ES = (
    "—No estoy de acuerdo —dijo Elena—. Deberíamos esperar a que llegue tu hermano antes de decidir nada."
)


def _doc(*chapters: list[str], dialogue_every: int = 0) -> tuple[list[dict], list[dict]]:
    """Segments (one paragraph each, ``# n`` heading per chapter) and chapters."""
    segments: list[dict] = []
    marks: list[dict] = []
    para = 0
    for n, paragraphs in enumerate(chapters, 1):
        marks.append({"title": f"Capítulo {n}", "segment": len(segments)})
        segments.append({"i": len(segments), "text": f"Capítulo {n}", "para": para, "kind": "h"})
        para += 1
        for k, text in enumerate(paragraphs):
            if dialogue_every and k % dialogue_every == 0:
                text = DIALOGUE_ES
            segments.append({"i": len(segments), "text": text, "para": para, "kind": "p"})
            para += 1
    return segments, marks


# ── Palettes and prompts ─────────────────────────────────────────────────────

_BANNED = re.compile(
    r"\b(zimmer|williams|shore|morricone|hisaishi|elfman|horner|desplat|arnalds|frahm|einaudi|tolkien|"
    r"star wars|harry potter|lord of the rings|in the style of|film score|cinematic|trailer|quiet|restrained|"
    r"no drums|without|vocals?|lyrics|drums?|percussion)\b",
    re.I,
)


def test_every_palette_has_a_prompt_for_every_mood():
    assert len(rm.PALETTE_IDS) >= 9
    for pid, palette in rm.PALETTES.items():
        assert re.match(r"^[a-z_]+$", pid)
        assert set(palette.moods) == set(rm.MOODS), pid
        for mood in rm.MOODS:
            text = rm.prompt(pid, mood)
            assert re.search(r"\b\d{2,3} BPM$", text), text
            assert not _BANNED.search(text), text
            assert 40 <= len(text) <= 300


def test_file_names_change_with_the_prompt_and_are_valid():
    name = rm.file_name("dark_fantasy", "calm", 1)
    assert rm._FILE_RE.match(name) and rm._FILE_RE.match(rm.candidate_name(name, 1))
    assert name != rm.file_name("dark_fantasy", "calm", 2)
    assert name != rm.file_name("classic_novel", "calm", 1)
    assert rm.seed_for("a" * 32, name, 0) != rm.seed_for("a" * 32, name, 1)


# ── Palette per book ─────────────────────────────────────────────────────────


def _rank(texts, **kw):
    return rm.rank_palettes(rm.palette_scores(texts, **kw))


def test_palette_rules():
    fantasy = ["La magia del hechicero protegía el trono del imperio; el nigromante conjuró a sus demonios y la profecía se cumplió."] * 300
    assert _rank(fantasy, language="es", era="historic")[0] == "dark_fantasy"
    space = ["The starship left orbit; the android checked the hologram while the planet and the galaxy turned below."] * 300
    assert _rank(space, language="en", era="modern")[0] == "scifi_space"
    essay = ["Según los datos del estudio, el porcentaje de investigadores en ciencia creció; por ejemplo, el análisis económico lo confirma."] * 300
    best, decisive = _rank(essay, language="es", era="modern", dialogue_share=0.0)
    assert best == "nonfiction_minimal" and decisive
    noir = ["The detective checked the alibi of the witness; the murder and the clue led him down the alley."] * 300
    assert _rank(noir, language="en", era="modern")[0] == "mystery_noir"
    # Nothing to go on: a neutral literary palette, not decisive (the LLM may decide).
    best, decisive = _rank(["Pedro abrió la puerta y se sentó."] * 300, language="es")
    assert best == "classic_novel" and not decisive


def test_title_and_ambience_mix_count():
    plain = ["Pedro abrió la puerta y se sentó a la mesa."] * 300
    assert _rank(plain, language="es", title="La galaxia perdida")[0] == "scifi_space"
    assert _rank(plain, language="es", era="historic", tag_share={"mist": 0.5})[0] == "dark_fantasy"


def test_llm_palette_only_when_rules_are_not_decisive():
    segments, chapters = _doc([NEUTRAL_ES] * 40)
    plan = rm.build_plan(segments, chapters, language="es", palette_answer="romance_warm")
    assert (plan["palette"], plan["palette_why"]) == ("romance_warm", "llm")
    fantasy = "La magia del hechicero y el nigromante; demonios, profecías y conjuros en el imperio."
    segments, chapters = _doc([fantasy] * 40)
    plan = rm.build_plan(segments, chapters, language="es", palette_answer="romance_warm")
    assert (plan["palette"], plan["palette_why"]) == ("dark_fantasy", "rules")
    plan = rm.build_plan(segments, chapters, language="es", palette_answer="not-a-palette")
    assert plan["palette"] in rm.PALETTES


def test_llm_questions_offer_only_the_enums():
    user, schema = rm.palette_question("T", "A", "texto")
    assert schema["properties"]["palette"]["enum"] == list(rm.PALETTE_IDS)
    assert all(pid in user for pid in rm.PALETTE_IDS)
    _user, schema = rm.mood_question("texto")
    assert schema["properties"]["mood"]["enum"] == list(rm.MOODS)


# ── Moods ────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("text,mood", [(TENSION_ES, "tension"), (CALM_ES, "calm"), (DREAD_ES, "dread"), (NEUTRAL_ES, None)])
def test_mood_lexicon(text, mood):
    assert rm.classify_mood(*rm.mood_scores(text, "es"))[0] == mood


def test_split_evidence_has_no_mood():
    assert rm.classify_mood({"tension": 5.0, "calm": 4.5}, 150) == (None, 0.0)


def test_a_mood_word_used_as_a_name_is_ignored():
    texts = ["Fantasma vigilaba la calle. Luego Fantasma bajó del tejado.", "Ella miró a Fantasma y Fantasma asintió."] * 3
    assert "fantasma" in rm.mood_names(texts, "es")
    scores, _ = rm.mood_scores("Fantasma sonrió.", "es", ignore=frozenset({"fantasma"}))
    assert "dread" not in scores


def test_dialogue_paragraphs_are_detected():
    segments = [
        {"i": 0, "text": "—Hola —dijo.", "para": 0, "kind": "p"},
        {"i": 1, "text": "Y se fue.", "para": 0, "kind": "p"},
        {"i": 2, "text": "Narración sin diálogo.", "para": 1, "kind": "p"},
        {"i": 3, "text": "«Ven», pidió.", "para": 2, "kind": "p"},
        {"i": 4, "text": "- 3 kg de harina", "para": 3, "kind": "p"},
    ]
    assert rm.dialogue_flags(segments) == [True, True, False, True, False]


# ── Timeline and hysteresis ─────────────────────────────────────────────────


def _windows(spec):
    """Fake windows from ``[(chars, section, chapter), ...]``."""
    out = []
    start = 0
    for chars, section, chapter in spec:
        out.append(ra.Window(start, start, section, "", chars, chapter=chapter))
        start += 1
    return out


def test_short_moods_are_absorbed_and_changes_need_strong_evidence_inside_a_section():
    windows = _windows([(1500, 0, 0), (500, 0, 0), (1500, 0, 0), (1500, 1, 0), (1500, 1, 0)])
    moods = [("calm", 1.0), ("tension", 2.5), ("calm", 1.0), ("tension", 1.0), ("tension", 1.0)]
    runs = rm.timeline_moods(windows, moods, {})
    # The 33 s blip of tension is absorbed; the next section starts a new cue.
    assert [(r.mood, r.first, r.last) for r in runs] == [("calm", 0, 2), ("tension", 3, 4)]
    # A weak change inside a section does not move the music…
    windows = _windows([(1500, 0, 0), (1500, 0, 0), (1500, 0, 0)])
    runs = rm.timeline_moods(windows, [("calm", 1.0), ("tension", 1.0), (None, 0)], {})
    assert [r.mood for r in runs] == ["calm"]
    # …strong evidence does.
    runs = rm.timeline_moods(windows, [("calm", 1.0), ("tension", 3.0), ("tension", 1.0)], {})
    assert [r.mood for r in runs] == ["calm", "tension"]


def test_every_cue_lasts_at_least_ninety_seconds():
    spec = [(700, i // 2, i // 4) for i in range(40)]
    moods = [(rm.MOODS[(i * 3) % len(rm.MOODS)], 3.0) for i in range(40)]
    runs = rm.timeline_moods(_windows(spec), moods, {})
    assert all(r.chars >= rm.MIN_CUE_SECONDS * rm.CHARS_PER_SECOND for r in runs)
    assert len({r.mood for r in runs}) <= rm.MAX_CUES


def test_quiet_windows_take_the_chapter_mood_else_the_default():
    windows = _windows([(1500, 0, 0), (1500, 1, 1)])
    runs = rm.timeline_moods(windows, [(None, 0), (None, 0)], {0: "melancholy"})
    assert [r.mood for r in runs] == ["melancholy", "calm"]


def test_cue_budget_maps_rare_moods_to_kept_ones():
    spec = [(2000, i, i) for i in range(7)]
    moods = [(m, 3.0) for m in rm.MOODS]
    runs = rm.timeline_moods(_windows(spec), moods, {}, max_cues=3)
    assert len({r.mood for r in runs}) <= 3


def test_plan_timeline_covers_the_document_and_spots_follow_the_rules():
    chapters = [[TENSION_ES] * 30, [CALM_ES] * 30, [NEUTRAL_ES] * 30, [DREAD_ES] * 30] * 3
    segments, marks = _doc(*chapters)
    plan = rm.build_plan(segments, marks, language="es")
    timeline = plan["timeline"]
    assert timeline[0]["start_segment"] == 0 and timeline[-1]["end_segment"] == len(segments) - 1
    for a, b in zip(timeline, timeline[1:]):
        assert b["start_segment"] == a["end_segment"] + 1 and a["cue"] != b["cue"]
    assert {t["cue"] for t in timeline} >= {"tension", "calm", "dread"}
    spots = plan["spots"]
    assert spots and set(spots[0]) == {"start_segment", "end_segment", "cue", "max_seconds"}
    chapter_starts = {m["segment"] for m in marks}
    assert all(s["start_segment"] in chapter_starts for s in spots)
    for a, b in zip(spots, spots[1:]):
        assert b["start_segment"] > a["end_segment"]
    assert all(rm.SPOT_MIN_SECONDS * 0.5 <= s["max_seconds"] <= rm.SPOT_MAX_SECONDS for s in spots)
    assert rm.COVERAGE_MIN <= plan["coverage"] <= rm.COVERAGE_MAX
    assert set(plan["moods"]) == {t["cue"] for t in timeline}


def test_no_spot_starts_in_dense_dialogue():
    segments, marks = _doc(*([[TENSION_ES] * 30] * 4), dialogue_every=1)
    plan = rm.build_plan(segments, marks, language="es")
    assert plan["spots"] == []
    assert plan["timeline"]


def test_coverage_is_thinned_when_chapters_are_short():
    segments, marks = _doc(*([[CALM_ES] * 6] * 60))
    plan = rm.build_plan(segments, marks, language="es")
    assert plan["coverage"] <= rm.COVERAGE_MAX


def test_cue_order_starts_at_the_listening_position():
    timeline = [{"start_segment": 0, "end_segment": 9, "cue": "calm"}, {"start_segment": 10, "end_segment": 19, "cue": "dread"}]
    spots = [{"start_segment": 10, "end_segment": 12, "cue": "dread", "max_seconds": 60}]
    assert rm.cue_order(timeline, spots, 0) == ["dread", "calm"]
    assert rm.cue_order(timeline, [], 0) == ["calm", "dread"]
    assert rm.cue_order(timeline, [], 15) == ["dread", "calm"]


# ── Engine: configuration, jobs, candidates ─────────────────────────────────


def test_engine_available_needs_python_and_weights(tmp_path, monkeypatch):
    monkeypatch.setenv(engine.ENV_PYTHON, str(tmp_path / "missing.exe"))
    monkeypatch.setenv(engine.ENV_HF_HOME, str(tmp_path / "hf"))
    assert engine.engine_available() is False
    python = tmp_path / "python.exe"
    python.write_text("")
    monkeypatch.setenv(engine.ENV_PYTHON, str(python))
    assert engine.weights_present() is False
    snap = tmp_path / "hf" / "hub" / "models--stabilityai--stable-audio-open-1.0" / "snapshots" / "abc"
    for sub in ("transformer", "vae", "text_encoder"):
        (snap / sub).mkdir(parents=True)
    (snap / "model_index.json").write_text("{}")
    assert engine.weights_present() is True
    assert engine.engine_available() is True
    local = tmp_path / "local-model"
    local.mkdir()
    monkeypatch.setenv(engine.ENV_MODEL, str(local))
    assert engine.weights_present() is False
    (local / "model_index.json").write_text("{}")
    assert engine.weights_present() is True


def test_music_dir_defaults_under_the_reader_folder(tmp_path, monkeypatch):
    import core.config

    monkeypatch.delenv(engine.ENV_DIR, raising=False)
    monkeypatch.setattr(core.config, "DATA_DIR", str(tmp_path))
    assert engine.music_dir() == os.path.join(str(tmp_path), "reader", "music")
    monkeypatch.setenv(engine.ENV_DIR, str(tmp_path / "elsewhere"))
    assert engine.music_dir() == str(tmp_path / "elsewhere")


def test_worker_job_json(tmp_path, monkeypatch):
    monkeypatch.delenv(engine.ENV_MODEL, raising=False)
    monkeypatch.setenv(engine.ENV_STEPS, "80")
    clips = [engine.Clip("c1", "dark fantasy underscore, 64 BPM", 12, str(tmp_path / "a.ogg"))]
    job = engine.build_job(clips, str(tmp_path / "r.json"), ffmpeg=None)
    assert job["version"] == engine.JOB_VERSION and job["model"] == engine.MODEL_REPO
    assert job["steps"] == 80 and job["dtype"] == "float16" and job["level_lufs"] == rm.LEVEL_LUFS == -24
    assert job["clips"] == [{"id": "c1", "prompt": "dark fantasy underscore, 64 BPM", "seed": 12, "seconds": 47.0, "out": str(tmp_path / "a.ogg")}]
    assert job["parent_pid"] == os.getpid() and job["result"].endswith("r.json")
    json.dumps(job)
    env = engine.worker_env()
    assert env["HF_HUB_OFFLINE"] == "1" and "PYTHONPATH" not in env


def test_candidate_choice_prefers_the_subtle_clip():
    steady = {"duration": 47, "percussive_ratio": 0.08, "onsets_per_s": 0.25, "pulse_autocorr": 0.29, "hits_per_min": 0,
              "syllabic_mod_db": 1.0, "lra_lu": 5.0, "st_max_minus_median": 2.8, "decay_db": 1.0}
    busy = dict(steady, onsets_per_s=1.9, pulse_autocorr=0.52, hits_per_min=33)
    dying = dict(steady, decay_db=18.0, lra_lu=15.0)
    assert engine.penalty(steady) == 0
    assert engine.pick_candidate([busy, steady]) == 1
    assert engine.pick_candidate([steady, dying]) == 0
    assert engine.pick_candidate([None, steady]) == 1
    assert engine.pick_candidate([steady, steady]) == 0


class _FakeProc:
    def __init__(self, behaviour, job):
        self.returncode = None
        self.killed = False
        self._polls = 0
        self.behaviour = behaviour
        self.job = job

    def poll(self):
        if self.returncode is None and not self.killed:
            self._polls += 1
            if self._polls >= 2:
                self.returncode = self.behaviour(self.job)
        return self.returncode

    def kill(self):
        self.killed = True
        self.returncode = -9

    def wait(self, timeout=None):
        return self.returncode


def _fake_popen(behaviours, calls):
    def popen(cmd, **_kw):
        with open(cmd[-1], encoding="utf-8") as fh:
            job = json.load(fh)
        calls.append(job)
        return _FakeProc(behaviours[min(len(calls) - 1, len(behaviours) - 1)], job)

    return popen


def _render(n):
    """Worker behaviour: finish the first ``n`` clips, then exit 0 (or crash)."""

    def run(job):
        clips = {}
        for clip in job["clips"][:n]:
            with open(clip["out"], "wb") as fh:
                fh.write(b"OggS")
            clips[clip["id"]] = {"ok": True, "out": clip["out"], "duration": 47.0, "metrics": {"duration": 47.0}}
        with open(job["result"], "w", encoding="utf-8") as fh:
            json.dump({"version": 1, "clips": clips}, fh)
        return 0 if n >= len(job["clips"]) else 1

    return run


def _clips(tmp_path, n=3):
    return [engine.Clip(f"c{i}", "p", i, str(tmp_path / f"c{i}.ogg")) for i in range(n)]


@pytest.fixture
def python(tmp_path, monkeypatch):
    exe = tmp_path / "python.exe"
    exe.write_text("")
    monkeypatch.setenv(engine.ENV_PYTHON, str(exe))
    return exe


def test_worker_crash_is_retried_and_keeps_finished_clips(tmp_path, python):
    calls = []
    outcome = engine.run_worker(_clips(tmp_path), str(tmp_path / "w"), popen=_fake_popen([_render(1), _render(5)], calls), poll_s=0)
    assert outcome.status == "done" and set(outcome.results) == {"c0", "c1", "c2"}
    assert [len(job["clips"]) for job in calls] == [3, 2]  # the retry only asks for what is missing


def test_worker_gives_up_after_two_crashes_without_progress(tmp_path, python):
    calls = []
    outcome = engine.run_worker(_clips(tmp_path), str(tmp_path / "w"), popen=_fake_popen([_render(0)], calls), poll_s=0)
    assert outcome.status == "failed" and len(calls) == 2


def test_worker_yields_when_the_voice_needs_the_gpu(tmp_path, python):
    calls = []
    outcome = engine.run_worker(
        _clips(tmp_path), str(tmp_path / "w"), popen=_fake_popen([_render(5)], calls), poll_s=0,
        should_stop=lambda: "render",
    )
    assert outcome.status == "yielded" and outcome.reason == "render" and outcome.results == {}


def test_worker_out_of_vram_is_a_resource_outcome(tmp_path, python):
    def no_vram(job):
        with open(job["result"], "w", encoding="utf-8") as fh:
            json.dump({"error": "vram", "clips": {}}, fh)
        return engine.EXIT_RESOURCES

    outcome = engine.run_worker(_clips(tmp_path), str(tmp_path / "w"), popen=_fake_popen([no_vram], []), poll_s=0)
    assert (outcome.status, outcome.reason) == ("resources", "vram")


def test_idle_gate_needs_a_quiet_stretch():
    now = [0.0]
    busy = ["render"]
    gate = engine.IdleGate(lambda: busy[0], settle_s=10, clock=lambda: now[0])
    assert not gate.idle()
    busy[0] = None
    assert not gate.idle()
    now[0] = 5
    assert not gate.idle()
    now[0] = 11
    assert gate.idle()
    busy[0] = "render"
    assert gate.busy() == "render"
    busy[0] = None
    assert not gate.idle()  # the count restarts


def test_busy_probe_reads_in_process_render_state(monkeypatch):
    render = types.SimpleNamespace(_interactive={"active": 0}, _inflight={}, _jobs={})
    reader_engine = types.SimpleNamespace(_state={"task": None, "ready_at": None})
    monkeypatch.setitem(sys.modules, "services.reader_render", render)
    monkeypatch.setitem(sys.modules, "services.reader_engine", reader_engine)
    monkeypatch.delitem(sys.modules, "services.model_manager", raising=False)
    assert engine.tts_busy_reason(idle_s=60) is None
    render._interactive["active"] = 1
    assert engine.tts_busy_reason(idle_s=60) == "render"
    render._interactive["active"] = 0
    render._jobs["d"] = types.SimpleNamespace(running=True)
    assert engine.tts_busy_reason(idle_s=60) == "prerender"
    render._jobs.clear()
    import time as _time

    reader_engine._state["ready_at"] = _time.time() - 5
    assert engine.tts_busy_reason(idle_s=60) == "recent render"
    assert engine.tts_busy_reason(idle_s=1) is None
    pool = types.SimpleNamespace(stats=lambda: {"running": 1, "queued": 0})
    mm = types.SimpleNamespace(get_model_status=lambda: {"loading": False}, _gpu_pool_singleton=pool)
    monkeypatch.setitem(sys.modules, "services.model_manager", mm)
    assert engine.tts_busy_reason(idle_s=1) == "gpu job"


# ── Worker DSP (runs in the music venv; checked here when scipy is present) ─


def _worker_module():
    pytest.importorskip("scipy")
    path = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "..", "scripts", "reader", "music_worker.py"))
    spec = importlib.util.spec_from_file_location("music_worker", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_worker_post_processing_hits_the_target_loudness():
    import numpy as np

    worker = _worker_module()
    sr = worker.SR
    t = np.arange(sr * 20) / sr
    # A 1 kHz sine at -20 dBFS peak in both channels reads about -20 LUFS (two -23 dB channels summed).
    tone = 0.1 * np.sin(2 * np.pi * 1000 * t)
    stereo = np.stack([tone, tone], 1)
    assert abs(worker.integrated_lufs(stereo) + 20) < 1.5
    rng = np.random.default_rng(1)
    pad = np.stack([np.sin(2 * np.pi * 110 * t), np.sin(2 * np.pi * 165 * t)], 1) * 0.3 + rng.normal(0, 0.01, (len(t), 2))
    out = worker.process(pad, target_lufs=-24)
    assert abs(worker.integrated_lufs(out) + 24) < 0.6
    assert np.max(np.abs(out)) < 10 ** (-5 / 20)  # limiter ~ -6 dBFS
    assert np.max(np.abs(out[:10])) < 1e-3 and np.max(np.abs(out[-10:])) < 1e-3  # faded
    metrics = worker.analyze(pad)
    assert {"percussive_ratio", "onsets_per_s", "pulse_autocorr", "lra_lu", "raw_lufs"} <= set(metrics)
    assert abs(worker._opus_level(64) - 0.896) < 0.002


def test_worker_rejects_bad_jobs():
    worker = _worker_module()
    with pytest.raises(ValueError):
        worker.validate_job({"version": 1, "result": "r", "clips": [{"id": "a", "prompt": "p", "seed": 1, "seconds": 60, "out": "o"}]})
    with pytest.raises(ValueError):
        worker.validate_job({"version": 2, "result": "r", "clips": []})


# ── API ──────────────────────────────────────────────────────────────────────


@pytest.fixture
def env(tmp_path, monkeypatch):
    import core.config
    import core.db
    from api.routers import reader
    from services import reader_import, reader_jobs

    monkeypatch.setattr(core.config, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(core.db, "DB_PATH", str(tmp_path / "reader.db"))
    monkeypatch.delenv(engine.ENV_DIR, raising=False)
    core.db.ensure_schema()
    monkeypatch.setattr(reader_import, "GROUP_CHARS", 0)
    reader_jobs.wait_idle()
    monkeypatch.setitem(reader_jobs._resumed, "done", True)
    monkeypatch.setattr(ra, "embedder_factory", lambda: None)
    monkeypatch.setattr(rm, "llm_factory", lambda: None)
    monkeypatch.setattr(rm, "IDLE_SETTLE_S", 0.0)
    monkeypatch.setattr(rm, "WAIT_POLL_S", 0.01)
    monkeypatch.setattr(rm, "busy_probe", lambda: None)
    unloads: list = []
    monkeypatch.setattr(rm, "unload_tts", lambda: unloads.append(1))
    monkeypatch.setattr(rm, "engine_available", lambda: True)
    rendered: list = []

    def fake_worker(clips, work_dir, should_stop=lambda: None, ffmpeg=None):
        os.makedirs(work_dir, exist_ok=True)
        results = {}
        for clip in clips:
            with open(clip.out, "wb") as fh:
                fh.write(b"OggS" + clip.id.encode())
            results[clip.id] = {"ok": True, "duration": 46.5, "metrics": {"duration": 46.5, "pulse_autocorr": 0.6 if clip.id.endswith(".c0.ogg") else 0.2}}
            rendered.append(clip)
        return engine.Outcome("done", results)

    monkeypatch.setattr(rm, "run_worker", fake_worker)
    app = FastAPI()
    app.include_router(reader.router)
    client = TestClient(app)
    client.unloads = unloads
    client.rendered = rendered
    return client


def _book() -> str:
    blocks = [TENSION_ES, CALM_ES, DREAD_ES, NEUTRAL_ES]
    return "\n\n".join(f"# Capítulo {n}\n\n" + "\n\n".join([text] * 20) for n, text in enumerate(blocks * 2, 1))


def _create(client) -> str:
    resp = client.post("/reader/documents/text", json={"text": _book(), "title": "Prueba"})
    assert resp.status_code == 200, resp.text
    return resp.json()["id"]


_KEYS = {"status", "progress", "error", "engine_available", "palette", "palettes", "cues", "spots", "timeline", "level_lufs"}


def _settled(client, doc_id) -> dict:
    for _ in range(3):
        assert rm.wait_idle(30)
        body = client.get(f"/reader/documents/{doc_id}/music").json()
        if body["status"] not in ("queued", "analyzing", "generating"):
            return body
    return body


def test_music_is_off_until_requested(env):
    doc_id = _create(env)
    body = env.get(f"/reader/documents/{doc_id}/music").json()
    assert set(body) == _KEYS
    assert body["status"] == "off" and body["cues"] == [] and body["palette"] is None
    assert body["level_lufs"] == -24 and {"id": "dark_fantasy"} in body["palettes"]
    assert not os.path.exists(os.path.join(rm.reader_store.document_dir(doc_id), rm.MUSIC_FILE))
    assert env.get("/reader/documents/" + "0" * 32 + "/music").status_code == 404


def test_request_plans_generates_and_serves_cues(env):
    doc_id = _create(env)
    first = env.post(f"/reader/documents/{doc_id}/music", json={})
    assert first.status_code == 200 and set(first.json()) == _KEYS
    assert first.json()["status"] in {"queued", "analyzing", "generating", "ready"}
    body = _settled(env, doc_id)
    assert body["status"] == "ready" and body["progress"] == 1.0 and body["error"] is None
    assert body["palette"]["source"] == "auto" and body["palette"]["id"] in rm.PALETTES
    cues = body["cues"]
    assert cues and all(set(c) == {"id", "mood", "files", "ready"} and c["ready"] for c in cues)
    assert all(len(c["files"]) == rm.VARIATIONS for c in cues)
    assert all(set(f) == {"name", "duration"} and f["duration"] == 46.5 for c in cues for f in c["files"])
    assert all(set(t) == {"start_segment", "end_segment", "cue"} for t in body["timeline"])
    assert {t["cue"] for t in body["timeline"]} <= {c["id"] for c in cues}
    assert all(set(s) == {"start_segment", "end_segment", "cue", "max_seconds"} for s in body["spots"])
    assert env.unloads  # the voice model is released before generating
    assert len(env.rendered) == len(cues) * rm.VARIATIONS * rm.CANDIDATES
    # The better candidate (lower pulse) was kept: the ".c1" files in the fake.
    name = cues[0]["files"][0]["name"]
    resp = env.get(f"/reader/documents/{doc_id}/music/{name}")
    assert resp.status_code == 200 and resp.headers["content-type"] == "audio/ogg"
    assert resp.content.endswith(b".c1.ogg") and "max-age" in resp.headers["cache-control"]
    manifest = rm.load_manifest(doc_id)
    assert manifest["files"][name]["chosen"] == 1 and not manifest["candidates"]
    # Only listed names are served.
    for bad in ("manifest.json", "../music.json", name.replace(".ogg", ".c0.ogg"), "x.ogg", rm.file_name("scifi_space", "calm", 1)):
        assert env.get(f"/reader/documents/{doc_id}/music/{bad}").status_code == 404
    # Idempotent: nothing is generated again.
    count = len(env.rendered)
    assert env.post(f"/reader/documents/{doc_id}/music").json()["status"] in {"ready", "queued"}
    assert _settled(env, doc_id)["status"] == "ready" and len(env.rendered) == count


def test_user_palette_regenerates_the_cues(env):
    doc_id = _create(env)
    env.post(f"/reader/documents/{doc_id}/music")
    before = _settled(env, doc_id)
    other = next(pid for pid in rm.PALETTE_IDS if pid != before["palette"]["id"])
    assert env.post(f"/reader/documents/{doc_id}/music", json={"palette": "nope"}).status_code == 400
    env.post(f"/reader/documents/{doc_id}/music", json={"palette": other})
    after = _settled(env, doc_id)
    assert after["status"] == "ready" and after["palette"] == {"id": other, "source": "user"}
    names = {f["name"] for c in after["cues"] for f in c["files"]}
    assert all(n.startswith(other + "-") for n in names)
    old = before["cues"][0]["files"][0]["name"]
    assert not os.path.exists(os.path.join(rm.audio_dir(doc_id), old))  # pruned
    assert after["timeline"] == before["timeline"]  # the plan itself is unchanged
    env.post(f"/reader/documents/{doc_id}/music", json={"palette": "auto"})
    back = _settled(env, doc_id)
    assert back["status"] == "ready" and back["palette"] == {"id": before["palette"]["id"], "source": "auto"}
    assert "palette_user" not in rm.load_state(doc_id)


def test_without_engine_the_plan_is_kept_and_status_is_unavailable(env, monkeypatch):
    monkeypatch.setattr(rm, "engine_available", lambda: False)
    doc_id = _create(env)
    env.post(f"/reader/documents/{doc_id}/music")
    body = _settled(env, doc_id)
    assert body["status"] == "unavailable" and body["engine_available"] is False
    assert body["timeline"] and all(not c["ready"] for c in body["cues"])
    assert env.rendered == []


def test_generation_waits_for_the_voice_and_resumes(env, monkeypatch):
    busy = {"reason": "render"}
    monkeypatch.setattr(rm, "busy_probe", lambda: busy["reason"])
    doc_id = _create(env)
    env.post(f"/reader/documents/{doc_id}/music")
    import time as _time

    deadline = _time.monotonic() + 10
    while _time.monotonic() < deadline:
        if env.get(f"/reader/documents/{doc_id}/music").json()["timeline"]:
            break
        _time.sleep(0.02)
    _time.sleep(0.1)
    body = env.get(f"/reader/documents/{doc_id}/music").json()
    assert body["status"] == "queued" and env.rendered == [] and env.unloads == []
    busy["reason"] = None
    assert _settled(env, doc_id)["status"] == "ready"


def test_a_failed_generation_reports_an_error_and_a_new_request_retries(env, monkeypatch):
    monkeypatch.setattr(rm, "run_worker", lambda *a, **k: engine.Outcome("failed", {}, "worker crashed"))
    doc_id = _create(env)
    env.post(f"/reader/documents/{doc_id}/music")
    body = _settled(env, doc_id)
    assert body["status"] == "error" and body["error"] == "worker crashed"


def test_delete_music_and_delete_document_remove_the_audio(env):
    doc_id = _create(env)
    env.post(f"/reader/documents/{doc_id}/music")
    assert _settled(env, doc_id)["status"] == "ready"
    folder = rm.audio_dir(doc_id)
    assert os.listdir(folder)
    body = env.delete(f"/reader/documents/{doc_id}/music").json()
    assert body["status"] == "off" and body["cues"] == []
    assert not os.path.exists(folder)
    assert not os.path.exists(os.path.join(rm.reader_store.document_dir(doc_id), rm.MUSIC_FILE))
    env.post(f"/reader/documents/{doc_id}/music")
    assert _settled(env, doc_id)["status"] == "ready" and os.listdir(folder)
    assert env.delete(f"/reader/documents/{doc_id}").status_code == 200
    rm.wait_idle(10)
    assert not os.path.exists(folder)


def test_imports_are_planned_only_after_music_was_requested(env):
    first = _create(env)
    second = _create(env)
    rm.wait_idle(10)
    assert not os.path.exists(os.path.join(rm.reader_store.document_dir(second), rm.MUSIC_FILE))
    env.post(f"/reader/documents/{first}/music")
    _settled(env, first)
    third = _create(env)
    assert rm.wait_idle(30)
    state = rm.load_state(third)
    assert state.get("timeline") and not state.get("requested")
    body = env.get(f"/reader/documents/{third}/music").json()
    assert body["status"] == "off"  # planned, but no audio unless requested
    count = len(env.rendered)
    rm.wait_idle(5)
    assert len(env.rendered) == count


def test_content_change_recomputes_the_plan_but_keeps_the_audio(env):
    doc_id = _create(env)
    env.post(f"/reader/documents/{doc_id}/music")
    _settled(env, doc_id)
    count = len(env.rendered)
    path = os.path.join(rm.reader_store.document_dir(doc_id), "content.json")
    with open(path, encoding="utf-8") as fh:
        content = json.load(fh)
    content["segments"][-1]["text"] += " Fin."
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(content, fh)
    assert env.get(f"/reader/documents/{doc_id}/music").json()["status"] in {"queued", "analyzing"}
    body = _settled(env, doc_id)
    assert body["status"] == "ready" and len(env.rendered) == count
