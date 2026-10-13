"""Summarize the Reader diagnostics log (what phones and the backend recorded).

usage: python scripts/reader/debug-report.py [YYYY-MM-DD | path.jsonl] [--since MINUTES] [--timeline]

Per client session: device, page load, sentence load times (p50/p90), playback misses
(the next sentence was not ready), stalls, UI jank, errors, and every "report a problem"
marker with the events around it. Reads %APPDATA%\\OmniVoice\\reader-debug by default.
"""
from __future__ import annotations

import argparse
import collections
import datetime as dt
import json
import os
import statistics
import sys


def log_path(arg: str | None) -> str:
    if arg and arg.endswith(".jsonl"):
        return arg
    base = os.path.join(os.environ.get("OMNIVOICE_DATA_DIR") or os.path.join(os.environ["APPDATA"], "OmniVoice"), "reader-debug")
    day = arg or max(f[:-6] for f in os.listdir(base) if f.endswith(".jsonl"))
    return os.path.join(base, f"{day}.jsonl")


def pct(values, q):
    if not values:
        return None
    values = sorted(values)
    return values[min(len(values) - 1, int(round(q * (len(values) - 1))))]


def when(record) -> str:
    stamp = record.get("t", 0) / 1000 if record.get("t") else record.get("recv", 0)
    return dt.datetime.fromtimestamp(stamp).strftime("%H:%M:%S")


def brief(record) -> str:
    skip = {"session", "recv", "t", "p", "type", "ua"}
    return f"{when(record)} {record['type']:<16} " + " ".join(f"{k}={v}" for k, v in record.items() if k not in skip)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("log", nargs="?")
    ap.add_argument("--since", type=float, help="only the last N minutes")
    ap.add_argument("--timeline", action="store_true", help="print every client event")
    args = ap.parse_args()
    path = log_path(args.log)
    rows = [json.loads(line) for line in open(path, encoding="utf-8") if line.strip()]
    if args.since:
        cutoff = dt.datetime.now().timestamp() - args.since * 60
        rows = [r for r in rows if r.get("recv", 0) >= cutoff]
    print(f"{path}: {len(rows)} events")

    server = [r for r in rows if r.get("session") == "server"]
    if server:
        renders = [r for r in server if r["type"] == "server_render"]
        fresh = [r["ms"] for r in renders if not r.get("cached")]
        errors = [r for r in server if r["type"] == "server_render_error"]
        print(f"\n[server] renders={len(renders)} cached={sum(1 for r in renders if r.get('cached'))} "
              f"synth p50={pct(fresh, .5)} p90={pct(fresh, .9)} max={max(fresh, default=None)} ms errors={len(errors)}")
        for r in errors[-5:]:
            print("   ", brief(r))

    sessions = collections.OrderedDict()
    for r in rows:
        if r.get("session") != "server":
            sessions.setdefault(r.get("session"), []).append(r)

    for sid, events in sessions.items():
        by = collections.defaultdict(list)
        for r in events:
            by[r["type"]].append(r)
        dev = (by.get("device") or [{}])[0]
        print(f"\n=== session {sid}  {when(events[0])}–{when(events[-1])}  client={dev.get('client')}")
        if dev:
            print(f"    device: {dev.get('ua', '')[:90]}")
            print(f"            viewport={dev.get('viewport')} cores={dev.get('cores')} mem={dev.get('memory_gb')}GB "
                  f"net={dev.get('net')} standalone={dev.get('standalone')} secure={dev.get('secure')}")
        for r in by.get("page_load", []):
            print(f"    page load: ttfb={r.get('ttfb_ms')} dom={r.get('dom_ready_ms')} load={r.get('load_ms')} ms "
                  f"transferred={r.get('transferred_kb')} KB resources={r.get('resources')}")
        loads = by.get("seg_load", [])
        net_loads = [r for r in loads if not r.get("offline")]
        if loads:
            total = [r["total_ms"] for r in net_loads if "total_ms" in r]
            fresh = [r["render_ms"] for r in net_loads if not r.get("cached") and "render_ms" in r]
            audio = [r["audio_ms"] for r in net_loads if "audio_ms" in r]
            print(f"    sentences loaded={len(loads)} (offline {len(loads) - len(net_loads)}) "
                  f"total p50={pct(total, .5)} p90={pct(total, .9)} | fresh render p50={pct(fresh, .5)} | audio p50={pct(audio, .5)} ms")
        starts = by.get("start", [])
        misses = [r for r in starts if r.get("autoplay") and not r.get("ready")]
        print(f"    starts={len(starts)} misses(next not ready)={len(misses)} stalls(mid-sentence)={sum(1 for r in by.get('waiting', []) if r.get('at', 0) > 0)} "
              f"user_play={len(by.get('user_play', []))}")
        waits = [r["after_ms"] for r in by.get("status", []) if r.get("from") == "buffering" and r.get("to") == "playing" and r.get("after_ms") is not None]
        if waits:
            print(f"    buffering->playing: p50={pct(waits, .5)} p90={pct(waits, .9)} max={max(waits)} ms (n={len(waits)})")
        jank = by.get("jank", [])
        longtasks = [r["ms"] for r in by.get("longtask", [])]
        if jank or longtasks:
            print(f"    UI: jank windows={len(jank)} worst frame={max((r['worst_ms'] for r in jank), default=None)} ms "
                  f"min fps={min((r['fps'] for r in jank), default=None)} | long tasks={len(longtasks)} max={max(longtasks, default=None)} ms")
        problems = by.get("error", []) + by.get("rejection", []) + by.get("console_error", []) + by.get("fail", []) + by.get("media_error", [])
        for r in problems[-8:]:
            print("    !", brief(r))
        for marker in by.get("user_marker", []):
            t0 = marker.get("t", 0)
            print(f"    >>> MARKER {when(marker)} {marker.get('note') or ''}")
            for r in events:
                if r is not marker and abs(r.get("t", 0) - t0) <= 20_000 and r["type"] not in ("device",):
                    print("        ", brief(r))
        if args.timeline:
            for r in events:
                print("      ", brief(r))
    return 0


if __name__ == "__main__":
    sys.exit(main())
