"""Prepared reading ("Lectura preparada"): an optional per-document layer that
changes what the TTS *says* — never the displayed text.

Off by default. When off, rendering is exactly the plain path (same text, same
cache keys). When on, each segment is rendered from its prepared reading
(:class:`services.reader_render.Spoken`): rule changes and accepted LLM
suggestions applied, pauses inserted as exact silence. The render key covers
the final synthesized text, pauses included, so prepared audio has its own
cache entries and switching back is instant.

Storage, beside ``content.json``::

    <DATA_DIR>/reader/<id>/speech.json
    {
      "version": 1, "rules_version": 1, "enabled": false,
      "fingerprint": "<sha1 of the segmentation the results belong to>",
      "complete": true, "prepared_at": 1760000000.0,
      "llm": {"status": "used"|"unavailable"|"disabled"|"none"|"pending", "model": "llama3.1:8b",
              "candidates": 12, "resolved": 12, "seconds": 41.2},
      "pause_rules": {"dialogue": false, ...},
      "items": [{"n", "segment", "c0", "c1", "original", "spoken", "kind",
                 "source": "rule"|"llm", "state": "applied"|"suggested"|"reverted",
                 "scope": "here"|"doc", "count", "edited"?}],
      "pauses": [[segment, at, ms, reason], ...],
      "overrides": {"<key>": {"state", "spoken"}}   # the listener's edits, kept across recomputes
    }

Preparation runs on one background thread, one document at a time: the rules
(seconds for a long book), then the LLM over the candidates only, nearest to
the listening position first, pausing whenever an interactive TTS render is in
flight. Results are written after the rules and periodically while the LLM
works, so pauses and safe changes apply at once. A document re-segmented after
preparation (its fingerprint changed) is read plainly until it is prepared
again, which happens automatically while the option is on.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import queue
import threading
import time
import uuid
from typing import Optional

from services import reader_speech_llm as llm
from services import reader_speech_rules as rules

logger = logging.getLogger("omnivoice.reader")

SPEECH_FILE = "speech.json"
VERSION = 1
LLM_CACHE_FILE = "speech-llm-cache.json"
#: Seconds between partial writes while the LLM works.
_WRITE_EVERY_S = 8.0
_YIELD_POLL_S = 0.25
ITEM_STATES = ("applied", "suggested", "reverted")


class SpeechItemNotFound(LookupError):
    """No change with that number."""


# ── Files ────────────────────────────────────────────────────────────────────



#: Pauses inside a dialogue sentence ("—Pero tú… —dijo Elend—. Tú…") split it into separate
#: synthesis calls, and the first piece ends on a rising, question-like contour. Listening
#: tests preferred the unsplit sentence, so they are opt-in; every other pause is on.
DEFAULT_PAUSE_RULES = {reason: reason != "dialogue" for reason in rules.PAUSE_REASONS}

def _doc_dir(doc_id: str) -> str:
    from services.reader_store import document_dir

    return document_dir(doc_id)


def speech_path(doc_id: str) -> str:
    return os.path.join(_doc_dir(doc_id), SPEECH_FILE)


def _llm_cache_path() -> Optional[str]:
    try:
        from services.reader_store import reader_dir

        os.makedirs(reader_dir(), exist_ok=True)
        return os.path.join(reader_dir(), LLM_CACHE_FILE)
    except Exception:  # noqa: BLE001
        return None


def _default_state() -> dict:
    return {
        "version": VERSION,
        "rules_version": rules.RULES_VERSION,
        "enabled": False,
        "fingerprint": None,
        "complete": False,
        "prepared_at": None,
        "llm": {"status": "none", "model": None, "candidates": 0, "resolved": 0, "seconds": 0.0},
        "pause_rules": dict(DEFAULT_PAUSE_RULES),
        "items": [],
        "pauses": [],
        "overrides": {},
    }


_lock = threading.RLock()
_memo: dict = {}  # doc_id → {"mtime": ns, "state": dict, "index": ...}


def _mtime(path: str) -> Optional[int]:
    try:
        return os.stat(path).st_mtime_ns
    except OSError:
        return None


def load_state(doc_id: str) -> dict:
    """The stored state (defaults when the document was never prepared)."""
    path = speech_path(doc_id)
    with _lock:
        mtime = _mtime(path)
        memo = _memo.get(doc_id)
        if memo is not None and memo["mtime"] == mtime:
            return memo["state"]
        state = _default_state()
        if mtime is not None:
            try:
                with open(path, encoding="utf-8") as fh:
                    stored = json.load(fh)
                if isinstance(stored, dict):
                    state.update(stored)
            except (OSError, ValueError):
                logger.warning("Reader: unreadable %s; preparing again", path)
        state["pause_rules"] = {
            reason: bool((state.get("pause_rules") or {}).get(reason, DEFAULT_PAUSE_RULES[reason]))
            for reason in rules.PAUSE_REASONS
        }
        _memo[doc_id] = {"mtime": mtime, "state": state, "index": None, "spoken": None}
        return state


def _write_state(doc_id: str, state: dict) -> None:
    path = speech_path(doc_id)
    folder = os.path.dirname(path)
    if not os.path.isdir(folder):
        return  # deleted meanwhile
    tmp = f"{path}.{uuid.uuid4().hex[:8]}.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(state, fh, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)
    _memo[doc_id] = {"mtime": _mtime(path), "state": state, "index": None, "spoken": None}


def _update(doc_id: str, fn) -> dict:
    with _lock:
        state = json.loads(json.dumps(load_state(doc_id)))  # private copy
        fn(state)
        _write_state(doc_id, state)
        return state


# ── Fingerprint (segmentation the results belong to) ───────────────────────

_fp_memo: dict = {}


def fingerprint(doc_id: str, content: dict) -> str:
    """sha1 over the segments' text/kind/paragraph and the chapter starts,
    memoized by the content file's stat."""
    try:
        path = os.path.join(_doc_dir(doc_id), "content.json")
        stat = os.stat(path)
        stamp = (stat.st_mtime_ns, stat.st_size, len(content.get("segments") or []))
    except (OSError, LookupError):
        stamp = None
    memo = _fp_memo.get(doc_id)
    if stamp is not None and memo is not None and memo[0] == stamp:
        return memo[1]
    digest = hashlib.sha1()  # noqa: S324 — change detection
    for seg in content.get("segments") or []:
        digest.update(f"{seg.get('kind') or 'p'}\x1f{seg.get('para')}\x1f{seg.get('text') or ''}\x1e".encode("utf-8"))
    digest.update(json.dumps([c.get("segment") for c in content.get("chapters") or []]).encode("utf-8"))
    value = digest.hexdigest()
    if stamp is not None:
        _fp_memo[doc_id] = (stamp, value)
    return value


def _fresh(state: dict, fp: str) -> bool:
    return bool(state.get("fingerprint")) and state.get("fingerprint") == fp and (
        state.get("rules_version") == rules.RULES_VERSION
    )


# ── Items ────────────────────────────────────────────────────────────────────


def _seg_hash(text: str) -> str:
    return hashlib.sha1((text or "").encode("utf-8")).hexdigest()[:12]  # noqa: S324


def _item_key(item: dict, segments: list) -> str:
    if item.get("scope") == "doc":
        return f"doc:{item['kind']}:{item['original']}"
    index = item["segment"]
    text = segments[index].get("text") if 0 <= index < len(segments) else ""
    return f"{_seg_hash(text)}:{item['c0']}:{item['original']}"


def _change_dict(change) -> dict:
    return {
        "segment": change.segment, "c0": change.c0, "c1": change.c1, "original": change.original,
        "spoken": change.spoken, "kind": change.kind, "source": change.source, "state": change.state,
        "scope": change.scope, "count": change.count,
    }


def _apply_overrides(items: list, overrides: dict, segments: list) -> list:
    out = []
    for n, item in enumerate(items):
        item = dict(item, n=n)
        found = overrides.get(_item_key(item, segments))
        if found:
            if found.get("spoken") is not None and found["spoken"] != item["spoken"]:
                item["suggested"] = item["spoken"]
                item["spoken"] = found["spoken"]
                item["edited"] = True
            if found.get("state") in ITEM_STATES:
                item["state"] = found["state"]
        out.append(item)
    return out


# ── Spoken plans (used by the renderer) ──────────────────────────────────────


def _index(doc_id: str, state: dict):
    memo = _memo.get(doc_id)
    if memo is not None and memo.get("state") is state and memo.get("index") is not None:
        return memo["index"]
    here: dict = {}
    names: dict = {}
    for item in state.get("items") or []:
        if item.get("state") != "applied":
            continue
        if item.get("scope") == "doc":
            names[item["original"]] = item["spoken"]
        else:
            here.setdefault(int(item["segment"]), []).append((int(item["c0"]), int(item["c1"]), item["spoken"]))
    pauses: dict = {}
    for seg, at, ms, reason in state.get("pauses") or []:
        pauses.setdefault(int(seg), []).append((at, ms, reason))
    index = (here, names, pauses)
    if memo is not None and memo.get("state") is state:
        memo["index"] = index
    return index


def _build(text: str, index: int, state: dict, built, *, extra: Optional[dict] = None):
    from services.reader_render import Spoken

    here, names, pauses = built
    changes = list(here.get(index, ()))
    doc_names = dict(names)
    if extra is not None:
        if extra.get("scope") == "doc":
            doc_names[extra["original"]] = extra["spoken"]
        elif int(extra["segment"]) == index:
            changes = [c for c in changes if not (c[0] < int(extra["c1"]) and int(extra["c0"]) < c[1])]
            changes.append((int(extra["c0"]), int(extra["c1"]), extra["spoken"]))
    result = rules.build_spoken(
        text, changes=changes, pauses=pauses.get(index, ()), names=doc_names or None, rules=state.get("pause_rules")
    )
    if result is None:
        return None
    lead, pieces = result
    return Spoken(pieces=pieces, lead_ms=lead)


def _active_state(doc_id: str, content: dict) -> Optional[dict]:
    """The state to read with, or None (off, never prepared, or stale)."""
    state = load_state(doc_id)
    if not state.get("enabled"):
        return None
    if not _fresh(state, fingerprint(doc_id, content)):
        if doc_id not in _status:
            enqueue(doc_id)  # re-segmented (or rules changed) while on: prepare again
        return None
    return state


def spoken_for(doc_id: str, content: dict, index: int):
    """The prepared reading of one segment, or ``None`` to read it plainly."""
    try:
        state = _active_state(doc_id, content)
        if state is None:
            return None
        segments = content.get("segments") or []
        if not 0 <= index < len(segments):
            return None
        return _build(segments[index].get("text") or "", index, state, _index(doc_id, state))
    except Exception:  # noqa: BLE001 — prepared reading must never break reading
        logger.warning("Reader: prepared reading of %s/%s failed; reading plainly", doc_id, index, exc_info=True)
        return None


def spoken_list(doc_id: str, content: dict) -> tuple[Optional[list], str]:
    """``(spoken per segment, variant)`` for a prerender; ``(None, "")`` when off."""
    try:
        state = _active_state(doc_id, content)
        if state is None:
            return None, ""
        memo = _memo.get(doc_id)
        if memo is not None and memo.get("state") is state and memo.get("spoken") is not None:
            return memo["spoken"]
        built = _index(doc_id, state)
        plans = [
            _build(seg.get("text") or "", i, state, built) for i, seg in enumerate(content.get("segments") or [])
        ]
        variant = "prepared:" + hashlib.sha1(  # noqa: S324
            json.dumps([state.get("fingerprint"), state.get("pause_rules"), len(state.get("items") or []),
                        _mtime(speech_path(doc_id))]).encode("utf-8")
        ).hexdigest()[:12]
        result = (plans, variant)
        if memo is not None and memo.get("state") is state:
            memo["spoken"] = result
        return result
    except Exception:  # noqa: BLE001
        logger.warning("Reader: prepared reading of %s failed; prerendering plainly", doc_id, exc_info=True)
        return None, ""


def preview_spoken(doc_id: str, content: dict, index: int, item: Optional[int] = None):
    """The prepared reading of a segment whether the option is on or not
    (with change ``item`` applied even if it is only suggested or reverted)."""
    state = load_state(doc_id)
    if not _fresh(state, fingerprint(doc_id, content)):
        return None
    extra = None
    if item is not None:
        extra = _find_item(state, item)
    segments = content.get("segments") or []
    if not 0 <= index < len(segments):
        return None
    return _build(segments[index].get("text") or "", index, state, _index(doc_id, state), extra=extra)


# ── Public state (API) ───────────────────────────────────────────────────────


def _find_item(state: dict, n: int) -> dict:
    items = state.get("items") or []
    if not 0 <= n < len(items) or items[n].get("n") != n:
        found = next((it for it in items if it.get("n") == n), None)
        if found is None:
            raise SpeechItemNotFound(n)
        return found
    return items[n]


def payload(doc_id: str, content: dict) -> dict:
    state = load_state(doc_id)
    fp = fingerprint(doc_id, content)
    fresh = _fresh(state, fp)
    job = _status.get(doc_id) or {}
    counts: dict = {reason: 0 for reason in rules.PAUSE_REASONS}
    if fresh:
        for _seg, _at, _ms, reason in state.get("pauses") or []:
            counts[reason] = counts.get(reason, 0) + 1
    items = []
    if fresh:
        for item in state.get("items") or []:
            items.append({k: item[k] for k in (
                "n", "segment", "c0", "c1", "original", "spoken", "kind", "source", "state", "scope", "count",
            ) if k in item} | ({"edited": True, "suggested": item.get("suggested")} if item.get("edited") else {}))
    return {
        "enabled": bool(state.get("enabled")),
        "status": job.get("state") or ("ready" if fresh and state.get("complete") else "idle"),
        "progress": job.get("progress"),
        "error": job.get("error"),
        "ready": fresh,
        "stale": bool(state.get("fingerprint")) and not fresh,
        "complete": bool(fresh and state.get("complete")),
        "prepared_at": state.get("prepared_at") if fresh else None,
        "llm": state.get("llm") if fresh else None,
        "pause_rules": state.get("pause_rules"),
        "pause_counts": counts,
        "items": items,
    }


def set_enabled(doc_id: str, content: dict, enabled: Optional[bool], pause_rules: Optional[dict] = None) -> dict:
    def change(state: dict) -> None:
        if enabled is not None:
            state["enabled"] = bool(enabled)
        if pause_rules:
            for reason, on in pause_rules.items():
                if reason in rules.PAUSE_REASONS:
                    state["pause_rules"][reason] = bool(on)

    state = _update(doc_id, change)
    if state.get("enabled") and not _fresh(state, fingerprint(doc_id, content)) and not is_busy(doc_id):
        enqueue(doc_id)
    return payload(doc_id, content)


def _matching(state: dict, item: dict, all_same: bool) -> list:
    if not all_same:
        return [item]
    return [
        it for it in state.get("items") or []
        if it.get("original") == item.get("original") and it.get("kind") == item.get("kind")
        and it.get("spoken") == item.get("spoken")
    ]


def edit_item(
    doc_id: str, content: dict, n: int, *, spoken: Optional[str] = None, state_value: Optional[str] = None,
    all_same: bool = False,
) -> dict:
    """Edit what change ``n`` says and/or its state (``applied`` |
    ``reverted`` | ``suggested``); ``all_same`` also edits every identical
    change. Raises :class:`SpeechItemNotFound`, ``ValueError``."""
    if spoken is not None:
        spoken = " ".join(spoken.split())
        if not spoken or len(spoken) > 200 or any(ch in spoken for ch in "[]{}<>\n"):
            raise ValueError("Write only the words to say.")
    if state_value is not None and state_value not in ITEM_STATES:
        raise ValueError("Unknown state.")
    segments = content.get("segments") or []

    def change(state: dict) -> None:
        target = _find_item(state, n)
        overrides = state.setdefault("overrides", {})
        for item in _matching(state, target, all_same):
            if spoken is not None and spoken != item["spoken"]:
                item.setdefault("suggested", item["spoken"])
                item["spoken"] = spoken
                item["edited"] = True
                if state_value is None and item["state"] == "suggested":
                    item["state"] = "applied"
            if state_value is not None:
                item["state"] = state_value
            overrides[_item_key(item, segments)] = {
                "state": item["state"], "spoken": item["spoken"] if item.get("edited") else None,
            }

    with _lock:
        if not _fresh(load_state(doc_id), fingerprint(doc_id, content)):
            raise SpeechItemNotFound(n)
        _update(doc_id, change)
    return payload(doc_id, content)


def get_item(doc_id: str, n: int) -> dict:
    return dict(_find_item(load_state(doc_id), n))


# ── Background preparation ───────────────────────────────────────────────────

_queue: "queue.Queue[str]" = queue.Queue()
_queued: set = set()
_status: dict = {}
_cancel: set = set()
_worker: dict = {"thread": None}
_qlock = threading.Lock()


def is_busy(doc_id: str) -> bool:
    return (_status.get(doc_id) or {}).get("state") in ("queued", "running")


def enqueue(doc_id: str) -> None:
    """Queue a document for preparation (no-op if queued or running)."""
    with _qlock:
        _cancel.discard(doc_id)
        if doc_id in _queued or (_status.get(doc_id) or {}).get("state") == "running":
            if (_status.get(doc_id) or {}).get("state") == "running":
                _status[doc_id]["again"] = True
            return
        _queued.add(doc_id)
        _status[doc_id] = {"state": "queued", "progress": 0.0, "error": None}
        _queue.put(doc_id)
        thread = _worker["thread"]
        if thread is None or not thread.is_alive():
            thread = threading.Thread(target=_run, name="reader-speech", daemon=True)
            _worker["thread"] = thread
            thread.start()


def forget(doc_id: str) -> None:
    """The document was deleted: stop preparing it, drop memos."""
    with _qlock:
        _cancel.add(doc_id)
        _queued.discard(doc_id)
        _status.pop(doc_id, None)
    with _lock:
        _memo.pop(doc_id, None)
        _fp_memo.pop(doc_id, None)


def wait_idle(timeout: float = 30.0) -> bool:
    """Block until nothing is queued or running (tests)."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with _qlock:
            busy = bool(_queued) or any(s.get("state") == "running" for s in _status.values())
        if not busy:
            return True
        time.sleep(0.02)
    return False


def _interactive_busy() -> bool:
    try:
        from services import reader_render

        return reader_render._interactive["active"] > 0
    except Exception:  # noqa: BLE001
        return False


def _run() -> None:
    while True:
        try:
            doc_id = _queue.get(timeout=2.0)
        except queue.Empty:
            with _qlock:
                if _queue.empty():
                    _worker["thread"] = None
                    break
            continue
        with _qlock:
            _queued.discard(doc_id)
            if doc_id in _cancel:
                continue
            _status[doc_id] = {"state": "running", "progress": 0.0, "error": None}
        try:
            prepare_now(doc_id)
            with _qlock:
                again = (_status.get(doc_id) or {}).get("again")
                _status.pop(doc_id, None)
            if again:
                enqueue(doc_id)
        except Exception as exc:  # noqa: BLE001 — surfaced through the status
            logger.warning("Reader: preparing %s failed: %s", doc_id, exc, exc_info=True)
            with _qlock:
                if doc_id in _status:
                    _status[doc_id] = {"state": "error", "progress": None, "error": _public_error(exc)}
    llm.stop_started_server()


def _public_error(exc: BaseException) -> str:
    try:
        from core.scrub import scrub_text

        return scrub_text(str(exc)) or exc.__class__.__name__
    except Exception:  # noqa: BLE001
        return exc.__class__.__name__


def _progress(doc_id: str, value: float) -> None:
    status = _status.get(doc_id)
    if status is not None:
        status["progress"] = round(max(0.0, min(1.0, value)), 3)


def _cancelled(doc_id: str) -> bool:
    return doc_id in _cancel


def _store_results(
    doc_id: str, fp: str, segments: list, items: list, pauses: list, *, complete: bool, llm_info: dict
) -> None:
    def change(state: dict) -> None:
        state["version"] = VERSION
        state["rules_version"] = rules.RULES_VERSION
        state["fingerprint"] = fp
        state["items"] = _apply_overrides(items, state.get("overrides") or {}, segments)
        state["pauses"] = pauses
        state["complete"] = complete
        state["llm"] = llm_info
        state["prepared_at"] = time.time() if complete else state.get("prepared_at")

    _update(doc_id, change)


def _candidate_order(candidates: list, position: int, count: int) -> list:
    """Nearest to the listening position first (forward, then wrapping)."""
    count = max(count, 1)
    return sorted(candidates, key=lambda c: ((c.segment - position) % count, c.c0))


def prepare_now(doc_id: str, *, client: Optional["llm.OllamaClient"] = None, use_llm: Optional[bool] = None) -> dict:
    """Prepare one document synchronously (the worker; tests and tools).

    Returns the LLM summary (``status``, ``model``, ``candidates``,
    ``resolved``, ``seconds``).
    """
    from services import reader_store

    summary = reader_store.require_ready(reader_store.get_summary(doc_id))
    content = reader_store.load_content(doc_id)
    segments = content.get("segments") or []
    fp = fingerprint(doc_id, content)
    _progress(doc_id, 0.02)
    analysis = rules.analyze(segments, content.get("chapters") or [], summary.get("language"))
    rule_items = [_change_dict(c) for c in analysis.changes]
    candidates = analysis.candidates
    _progress(doc_id, 0.2)
    info = {"status": "none", "model": None, "candidates": len(candidates), "resolved": 0, "seconds": 0.0}
    want_llm = llm.enabled() if use_llm is None else use_llm
    if candidates and not want_llm:
        info["status"] = "disabled"
    elif candidates:
        info["status"] = "pending"
    _store_results(doc_id, fp, segments, rule_items, analysis.pauses, complete=not candidates or not want_llm, llm_info=dict(info))
    if not candidates or not want_llm or _cancelled(doc_id):
        return info
    if client is None:
        models = llm.ensure_server()
        model = llm.pick_model(models) if models else None
        if not model:
            info["status"] = "unavailable"
            _store_results(doc_id, fp, segments, rule_items, analysis.pauses, complete=True, llm_info=dict(info))
            return info
        client = llm.OllamaClient(model)
    info["model"] = client.model
    cache = llm.AnswerCache(_llm_cache_path())
    # One question per distinct (kind, text, sentence); every occurrence gets the answer.
    groups: dict = {}
    order: list = []
    for cand in _candidate_order(candidates, int(summary.get("position_segment") or 0), len(segments)):
        context = llm.sentence_around(cand.context, cand.c0, cand.c1)
        key = (cand.kind, cand.original, "" if cand.kind == "name" else context)
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(cand)
    llm_items: list = []
    last_write = time.monotonic()
    started = time.perf_counter()
    failures = 0
    for done, key in enumerate(order, 1):
        while _interactive_busy() and not _cancelled(doc_id):
            time.sleep(_YIELD_POLL_S)
        if _cancelled(doc_id):
            return info
        first = groups[key][0]
        try:
            spoken, _cached = llm.resolve(first, client, cache)
            failures = 0
        except Exception as exc:  # noqa: BLE001 — one bad answer never stops the rest
            logger.info("Reader: LLM could not resolve %r: %s", first.original, exc)
            spoken = None
            failures += 1
            if failures >= 3:
                # The server went away: keep what we have, rules included.
                info["status"] = "unavailable"
                cache.save()
                _store_results(doc_id, fp, segments, rule_items + llm_items, analysis.pauses, complete=True,
                               llm_info=dict(info))
                return info
        if spoken:
            for cand in groups[key]:
                if cand.kind == "name":
                    llm_items.append({
                        "segment": cand.segment, "c0": cand.c0, "c1": cand.c1, "original": cand.original,
                        "spoken": spoken, "kind": "name", "source": "llm", "state": "suggested",
                        "scope": "doc", "count": cand.count,
                    })
                else:
                    llm_items.append({
                        "segment": cand.segment, "c0": cand.c0, "c1": cand.c1, "original": cand.original,
                        "spoken": spoken, "kind": cand.kind, "source": "llm", "state": "applied",
                        "scope": "here", "count": 1,
                    })
        info["resolved"] = done
        info["seconds"] = round(time.perf_counter() - started, 1)
        _progress(doc_id, 0.2 + 0.8 * done / max(len(order), 1))
        if time.monotonic() - last_write > _WRITE_EVERY_S:
            _store_results(doc_id, fp, segments, rule_items + llm_items, analysis.pauses, complete=False, llm_info=dict(info))
            cache.save()
            last_write = time.monotonic()
    info["status"] = "used"
    cache.save()
    _store_results(doc_id, fp, segments, rule_items + llm_items, analysis.pauses, complete=True, llm_info=dict(info))
    return info
