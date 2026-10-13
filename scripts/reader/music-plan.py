"""Plan (and optionally render) background music for a Reader document, read-only.

Prints the palette scores and choice, the share of the text per mood, the spots
and their coverage of the listening time, and writes ``plan.json`` to ``--out``.
With ``--generate N`` it also renders the first variation of the first N cues
(two seeds each, the better one kept by the QC metrics) with the music worker,
exactly as the backend does, into ``--out``. Nothing is written next to the
document and the backend is not involved — the worker refuses to start when
the GPU lacks free memory (stop the voice first: ``POST /model/unload/tts``).

    uv run --no-sync python scripts/reader/music-plan.py <content.json> [--ambience ambience.json]
        [--title T] [--author A] [--lang es] [--llm] [--generate 3] --out <folder>
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import time

_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(_ROOT, "backend"))
# Never touch the real data dir: imports below resolve DATA_DIR at import time.
os.environ["OMNIVOICE_DATA_DIR"] = tempfile.mkdtemp(prefix="music-plan-")

from services import reader_music as rm  # noqa: E402
from services import reader_music_engine as engine  # noqa: E402


def _llm_answers(client, title: str, author: str, segments, chapters, limit: int) -> tuple[str | None, dict]:
    windows = rm.reader_ambience.split_windows(segments, chapters)
    excerpts = rm._chapter_excerpts(windows)
    palette = rm._ask(client, *rm.palette_question(title, author, rm.opening_excerpt(segments)), "palette", rm.PALETTE_IDS)
    moods = {}
    for chapter in sorted(excerpts)[:limit]:
        answer = rm._ask(client, *rm.mood_question(excerpts[chapter]), "mood", rm.MOODS)
        if answer:
            moods[chapter] = answer
    return palette, moods


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("content", help="path to a Reader content.json")
    parser.add_argument("--ambience", default=None, help="the document's ambience.json (optional)")
    parser.add_argument("--title", default="")
    parser.add_argument("--author", default="")
    parser.add_argument("--lang", default=None)
    parser.add_argument("--position", type=int, default=0, help="listening position (segment)")
    parser.add_argument("--palette", default=None, help="force a palette")
    parser.add_argument("--llm", action="store_true", help="ask the local Ollama (palette + chapter moods)")
    parser.add_argument("--llm-chapters", type=int, default=12)
    parser.add_argument("--generate", type=int, default=0, help="render variation 1 of the first N cues")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    os.makedirs(args.out, exist_ok=True)

    with open(args.content, encoding="utf-8") as fh:
        content = json.load(fh)
    segments, chapters = content["segments"], content.get("chapters") or []
    scenes = None
    if args.ambience:
        with open(args.ambience, encoding="utf-8") as fh:
            scenes = json.load(fh).get("scenes")
    palette_answer, chapter_moods = None, {}
    started = time.perf_counter()
    if args.llm:
        client = rm._ollama_client()
        if client is None:
            print("LLM: no local Ollama model; rules only")
        else:
            palette_answer, chapter_moods = _llm_answers(client, args.title, args.author, segments, chapters, args.llm_chapters)
            print(f"LLM ({client.model}): palette={palette_answer}, chapter moods={chapter_moods} "
                  f"in {time.perf_counter() - started:.0f} s")
    t0 = time.perf_counter()
    plan = rm.build_plan(
        segments, chapters, title=args.title, author=args.author, language=args.lang, ambience_scenes=scenes,
        palette_answer=palette_answer, chapter_moods=chapter_moods, position=args.position,
    )
    plan_s = time.perf_counter() - t0
    palette = args.palette or plan["palette"]
    sizes = [len(str(s.get("text") or "")) for s in segments]
    total = sum(sizes) or 1
    shares: dict[str, float] = {}
    for item in plan["timeline"]:
        chars = sum(sizes[item["start_segment"] : item["end_segment"] + 1])
        shares[item["cue"]] = shares.get(item["cue"], 0.0) + chars / total
    print(f"plan in {plan_s:.1f} s · language {plan['language']} · era {plan['era']} · dialogue {plan['dialogue_share']:.0%}")
    print("palette scores:", ", ".join(f"{k} {v}" for k, v in sorted(plan["palette_scores"].items(), key=lambda kv: -kv[1])))
    print(f"palette: {palette} ({'forced' if args.palette else plan['palette_why']})")
    print("moods (share of text):", ", ".join(f"{m} {shares[m]:.0%}" for m in sorted(shares, key=lambda m: -shares[m])))
    print(f"timeline: {len(plan['timeline'])} cues · spots: {len(plan['spots'])} · coverage {plan['coverage']:.1%}"
          f" · narration ≈ {total / rm.CHARS_PER_SECOND / 3600:.1f} h")
    print("cue order:", plan["moods"])
    for spot in plan["spots"][:8]:
        text = str(segments[spot["start_segment"]].get("text") or "")[:90]
        print(f"  spot {spot['start_segment']}–{spot['end_segment']} {spot['cue']} {spot['max_seconds']} s · {text}")
    plan["palette"] = palette
    with open(os.path.join(args.out, "plan.json"), "w", encoding="utf-8") as fh:
        json.dump(plan, fh, ensure_ascii=False, indent=1)

    if args.generate:
        if not engine.engine_available():
            print("music engine not available (OMNIVOICE_MUSIC_PYTHON / weights)")
            return 1
        cues = plan["moods"][: args.generate]
        clips = []
        for mood in cues:
            name = rm.file_name(palette, mood, 1)
            for k in range(rm.CANDIDATES):
                cand = rm.candidate_name(name, k)
                clips.append(engine.Clip(cand, rm.prompt(palette, mood), rm.seed_for("music-plan", name, k), os.path.join(args.out, cand)))
        print(f"rendering {len(clips)} clips ({len(cues)} cues × {rm.CANDIDATES} seeds)…")
        t0 = time.perf_counter()
        outcome = engine.run_worker(clips, args.out)
        wall = time.perf_counter() - t0
        result = engine._read_result(os.path.join(args.out, "_result.json"))
        print(f"worker: {outcome.status} {outcome.reason or ''} in {wall:.0f} s · load {result.get('load_seconds')} s"
              f" · free VRAM at start {result.get('vram_free_gb')} GB · {result.get('device')}")
        report = []
        for mood in cues:
            name = rm.file_name(palette, mood, 1)
            cands = [rm.candidate_name(name, k) for k in range(rm.CANDIDATES)]
            records = [outcome.results.get(c) for c in cands]
            if not all(records):
                print(f"  {mood}: incomplete")
                continue
            metrics = [r["metrics"] for r in records]
            best = engine.pick_candidate(metrics)
            os.replace(os.path.join(args.out, cands[best]), os.path.join(args.out, name))
            os.replace(os.path.join(args.out, cands[1 - best]), os.path.join(args.out, f"rejected-{cands[1 - best]}"))
            penalties = [engine.penalty(m) for m in metrics]
            print(f"  {mood}: {name} · gen {[r['gen_seconds'] for r in records]} s · peak "
                  f"{[r['vram_peak_gb'] for r in records]} GB · penalties {penalties} → seed #{best}")
            report.append({"mood": mood, "file": name, "prompt": rm.prompt(palette, mood), "chosen": best,
                           "penalties": penalties, "candidates": records})
        with open(os.path.join(args.out, "cues.json"), "w", encoding="utf-8") as fh:
            json.dump({"palette": palette, "wall_seconds": round(wall, 1), "worker": result, "cues": report},
                      fh, ensure_ascii=False, indent=1)
    return 0


if __name__ == "__main__":
    sys.exit(main())
