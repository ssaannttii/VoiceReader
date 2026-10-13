"""Evaluate the automatic-ambience classifier on a Reader document (read-only).

Prints the share of the text (by characters) that gets each ambience tag and,
per sounding scene, a snippet and the lexicon words that decided it, so a human
can judge whether the sounds fit. Nothing is written next to the document.

    uv run --no-sync python scripts/reader/ambience-eval.py <content.json> [--lang es] [--scenes 40] [--seed 1]

``content.json`` is a Reader document file (``<data dir>/reader/<id>/content.json``);
copy it somewhere else first if you want to be extra careful. The embedding
refinement (Ollama) is not used: this measures the lexicon pipeline.
"""
from __future__ import annotations

import argparse
import json
import os
import random
import sys
import tempfile

_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(_ROOT, "backend"))
# Never touch the real data dir: imports below resolve DATA_DIR at import time.
os.environ["OMNIVOICE_DATA_DIR"] = tempfile.mkdtemp(prefix="ambience-eval-")

from services import reader_ambience as ra  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("content", help="path to a Reader content.json")
    parser.add_argument("--lang", default=None, help="document language (default: detected)")
    parser.add_argument("--scenes", type=int, default=30, help="sounding scenes to print (sampled)")
    parser.add_argument("--seed", type=int, default=1)
    parser.add_argument("--snippet", type=int, default=260, help="characters of text per scene")
    parser.add_argument("--tag", default=None, help="only sample scenes with this tag")
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    with open(args.content, encoding="utf-8") as fh:
        content = json.load(fh)
    segments, chapters = content["segments"], content.get("chapters") or []
    language = ra.document_language(segments, args.lang)
    windows = ra.classify_windows(segments, chapters, language)
    scenes = ra._smooth(windows, ra.document_profile(segments, language))
    chars = [len(str(seg.get("text") or "")) for seg in segments]
    total = sum(chars) or 1

    def span(scene: dict) -> int:
        return sum(chars[scene["start_segment"] : scene["end_segment"] + 1])

    print(f"language={language} segments={len(segments)} windows={len(windows)} scenes={len(scenes)} "
          f"chars={total} version={ra.AMBIENCE_VERSION}")
    profile = ra.document_profile(segments, language)
    print(f"profile: era={profile.era} names_ignored={len(profile.names)}")
    by_tag: dict[str, int] = {}
    count: dict[str, int] = {}
    for scene in scenes:
        by_tag[scene["tag"]] = by_tag.get(scene["tag"], 0) + span(scene)
        count[scene["tag"]] = count.get(scene["tag"], 0) + 1
    sounding = total - by_tag.get(ra.NONE, 0)
    print(f"\ncoverage: {100 * sounding / total:.1f}% of the text has an ambience\n")
    for tag, n in sorted(by_tag.items(), key=lambda kv: -kv[1]):
        print(f"  {tag:10s} {100 * n / total:5.1f}%  ({count[tag]} scenes)")

    text_of = lambda s: " ".join(str(segments[i].get("text") or "") for i in range(s["start_segment"], s["end_segment"] + 1))  # noqa: E731
    loud = [s for s in scenes if s["tag"] != ra.NONE and (args.tag is None or s["tag"] == args.tag)]
    random.Random(args.seed).shuffle(loud)
    print(f"\n── {min(args.scenes, len(loud))} sample scenes ──")
    for scene in sorted(loud[: args.scenes], key=lambda s: s["start_segment"]):
        text = text_of(scene)
        trace: dict[str, dict[str, int]] = {}
        ra.score_text(text, language or "es", ignore=profile.names, trace=trace)
        words = ", ".join(f"{t}×{n}" for t, n in sorted(trace.get(scene["tag"], {}).items(), key=lambda kv: -kv[1])[:8])
        print(f"\n[{scene['start_segment']}-{scene['end_segment']}] {scene['tag']} conf={scene['confidence']} "
              f"int={scene['intensity']} chars={span(scene)}\n  words: {words}\n  « {text[: args.snippet]}… »")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
