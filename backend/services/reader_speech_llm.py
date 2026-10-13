"""Prepared reading: resolve rule *candidates* with a local LLM (Ollama).

Only the candidates :mod:`services.reader_speech_rules` could not settle go to
the model — never the whole text — each with the sentence around it, in a
short JSON-only prompt at temperature 0:

* Roman numerals and capitalized acronyms are a **choice** between readings
  the rules already computed (``cardinal`` / ``ordinal`` / ``keep``,
  ``word`` / ``spell`` / ``keep``): the model cannot invent text.
* Names get a **respelling suggestion**, validated (letters only, close to the
  original spelling, not longer than needed) and stored as a suggestion the
  listener accepts or not.

The model runs on the CPU (``num_gpu: 0``) so it never takes VRAM from the
TTS engine, and is local (``http://127.0.0.1:11434`` by default): nothing
leaves the machine. When Ollama is installed but not running, it is started
once (hidden, CPU-only) and stopped again when the preparation queue is idle.
Answers are cached by (model, kind, candidate, context hash).

Environment: ``OMNIVOICE_READER_LLM=0`` disables the model;
``OMNIVOICE_READER_LLM_MODEL`` picks one; ``OMNIVOICE_READER_OLLAMA_URL``
points elsewhere (never started automatically then); ``OLLAMA_EXE`` names
the executable.
"""
from __future__ import annotations

import atexit
import difflib
import hashlib
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import unicodedata
from typing import Callable, Optional

logger = logging.getLogger("omnivoice.reader")

DEFAULT_URL = "http://127.0.0.1:11434"
PREFERRED_MODELS = ("llama3.1:8b", "gemma3:12b", "qwen2.5:7b", "gemma3:4b", "qwen2.5-coder:7b", "llama3.2:3b")
CALL_TIMEOUT_S = 180.0
START_WAIT_S = 25.0

_NAME_OK_RE = re.compile(r"^[A-Za-zÁÉÍÓÚÜÑáéíóúüñÀ-ÿ' -]+$")
#: Respellings for an English reader, not for a Spanish voice.
_ENGLISH_PHONETICS = tuple(re.compile(p) for p in (r"oo", r"ee", r"[aeiou]h(?![aeiou])", r"ey\b", r"ay\b"))


class LlmUnavailable(RuntimeError):
    """No usable local model."""


def enabled() -> bool:
    value = os.environ.get("OMNIVOICE_READER_LLM")
    return value is None or value.strip().lower() not in ("0", "false", "no", "off", "")


def base_url() -> str:
    return (os.environ.get("OMNIVOICE_READER_OLLAMA_URL") or DEFAULT_URL).rstrip("/")


# ── Server ───────────────────────────────────────────────────────────────────

_server = {"proc": None, "tried": False}
_server_lock = threading.Lock()


def list_models(url: Optional[str] = None, timeout: float = 2.0) -> Optional[list[str]]:
    """Installed model names, or ``None`` when the server does not answer."""
    import httpx

    try:
        resp = httpx.get(f"{url or base_url()}/api/tags", timeout=timeout)
        resp.raise_for_status()
        return [m.get("name") or m.get("model") for m in resp.json().get("models", []) if isinstance(m, dict)]
    except Exception:  # noqa: BLE001 — any failure means "not available"
        return None


def _ollama_exe() -> Optional[str]:
    env = os.environ.get("OLLAMA_EXE")
    if env and os.path.isfile(env):
        return env
    if sys.platform == "win32":
        local = os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs", "Ollama", "ollama.exe")
        if os.path.isfile(local):
            return local
    return shutil.which("ollama")


def ensure_server() -> Optional[list[str]]:
    """Models of a running Ollama; start a local one once if installed."""
    models = list_models()
    if models is not None:
        return models
    if base_url() != DEFAULT_URL:
        return None
    with _server_lock:
        if _server["tried"]:
            return list_models()
        _server["tried"] = True
        exe = _ollama_exe()
        if not exe:
            return None
        env = dict(os.environ, CUDA_VISIBLE_DEVICES="-1", HIP_VISIBLE_DEVICES="-1", OLLAMA_KEEP_ALIVE="2m")
        kwargs: dict = {"stdin": subprocess.DEVNULL, "stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL, "env": env}
        if sys.platform == "win32":
            kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0) | getattr(
                subprocess, "CREATE_NEW_PROCESS_GROUP", 0
            )
        else:
            kwargs["start_new_session"] = True
        try:
            _server["proc"] = subprocess.Popen([exe, "serve"], **kwargs)  # noqa: S603 — local executable
        except OSError as exc:
            logger.info("Reader: could not start Ollama (%s)", exc)
            return None
        logger.info("Reader: started a local Ollama server for prepared reading")
    deadline = time.monotonic() + START_WAIT_S
    while time.monotonic() < deadline:
        models = list_models(timeout=1.0)
        if models is not None:
            return models
        time.sleep(0.5)
    return None


def stop_started_server() -> None:
    """Stop the Ollama server this process started (never one it found running)."""
    with _server_lock:
        proc = _server["proc"]
        _server["proc"] = None
        _server["tried"] = False
    if proc is None or proc.poll() is not None:
        return
    # The server spawns a model runner per loaded model: stop the whole tree,
    # or the runner outlives it holding gigabytes of RAM.
    try:
        if sys.platform == "win32":
            subprocess.run(  # noqa: S603 — fixed system tool
                ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        else:
            import signal

            os.killpg(proc.pid, signal.SIGTERM)
        proc.wait(timeout=10)
    except Exception:  # noqa: BLE001
        try:
            proc.kill()
        except Exception:  # noqa: BLE001
            pass


atexit.register(stop_started_server)


def pick_model(models: list[str]) -> Optional[str]:
    wanted = (os.environ.get("OMNIVOICE_READER_LLM_MODEL") or "").strip()
    if wanted:
        return wanted if wanted in models or f"{wanted}:latest" in models else None
    for name in PREFERRED_MODELS:
        if name in models:
            return name
    usable = [m for m in models if m and "embed" not in m]
    return usable[0] if usable else None


# ── Client ───────────────────────────────────────────────────────────────────


class OllamaClient:
    """``chat(system, user, schema) -> dict`` against one model, on the CPU."""

    def __init__(self, model: str, url: Optional[str] = None, post: Optional[Callable] = None):
        self.model = model
        self.url = url or base_url()
        self._post = post
        self.calls = 0
        self.seconds = 0.0

    def _send(self, payload: dict) -> dict:
        if self._post is not None:
            return self._post(payload)
        import httpx

        resp = httpx.post(f"{self.url}/api/chat", json=payload, timeout=CALL_TIMEOUT_S)
        if resp.status_code == 400 and isinstance(payload.get("format"), dict):
            # Servers before structured outputs accept plain JSON mode.
            resp = httpx.post(f"{self.url}/api/chat", json={**payload, "format": "json"}, timeout=CALL_TIMEOUT_S)
        resp.raise_for_status()
        return resp.json()

    def chat(self, system: str, user: str, schema: dict) -> dict:
        threads = max(2, (os.cpu_count() or 4) // 2)
        payload = {
            "model": self.model,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            "stream": False,
            "format": schema,
            "keep_alive": "2m",
            "options": {
                "temperature": 0, "seed": 7, "num_gpu": 0, "num_thread": threads,
                "num_ctx": 2048, "num_predict": 80,
            },
        }
        started = time.perf_counter()
        try:
            data = self._send(payload)
        finally:
            self.calls += 1
            self.seconds += time.perf_counter() - started
        content = ((data or {}).get("message") or {}).get("content") or ""
        try:
            parsed = json.loads(content)
        except ValueError:
            m = re.search(r"\{.*\}", content, re.S)
            parsed = json.loads(m.group(0)) if m else {}
        return parsed if isinstance(parsed, dict) else {}


# ── Prompts + validation ─────────────────────────────────────────────────────

_SYSTEM = (
    "You prepare text for a Spanish audiobook narrator's text-to-speech voice. "
    "You answer with one JSON object and nothing else."
)


def sentence_around(text: str, c0: int, c1: int, limit: int = 280) -> str:
    """The sentence holding ``text[c0:c1]`` (at most ``limit`` characters)."""
    start = max(text.rfind(". ", 0, c0), text.rfind("? ", 0, c0), text.rfind("! ", 0, c0))
    start = 0 if start < 0 else start + 2
    ends = [i for i in (text.find(". ", c1), text.find("? ", c1), text.find("! ", c1)) if i >= 0]
    end = min(ends) + 1 if ends else len(text)
    if end - start > limit:
        start = max(start, c0 - limit // 2)
        end = min(end, c1 + limit // 2)
    return text[start:end].strip()


def _fold(text: str) -> str:
    decomposed = unicodedata.normalize("NFKD", text.lower())
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch))


def choice_prompt(kind: str, original: str, context: str, options: dict) -> tuple[str, dict]:
    labels = {
        "cardinal": "as a cardinal number (siglo XIX, Luis XIV, capítulo IV)",
        "ordinal": "as an ordinal (Felipe II → segundo, Carlos V → quinto)",
        "ordinal_f": "as a feminine ordinal (Isabel II → segunda)",
        "word": "as one word",
        "spell": "letter by letter",
    }
    lines = [f"Sentence: «{context}»"]
    if kind == "roman":
        lines.append(f"How should the narrator read the Roman numeral «{original}» in this sentence?")
    else:
        lines.append(f"How should the narrator read «{original}», written in capitals, in this sentence?")
    choices = list(options) + ["keep"]
    for name in options:
        lines.append(f'- "{name}": say "{options[name]}" ({labels.get(name, name)})')
    keep = (
        "it is not a number here (a word, a name, initials or a code)"
        if kind == "roman"
        else "it is an ordinary word written in capitals, or you are not sure"
    )
    lines.append(f'- "keep": leave it as written ({keep})')
    lines.append(f'Answer {{"choice": one of {json.dumps(choices)}}}.')
    schema = {
        "type": "object",
        "properties": {"choice": {"type": "string", "enum": choices}},
        "required": ["choice"],
    }
    return "\n".join(lines), schema


def name_prompt(original: str, context: str) -> tuple[str, dict]:
    user = (
        f"Name: «{original}»\nSentence: «{context}»\n"
        "A Spanish text-to-speech voice reads every word with Spanish spelling rules. Respell this name in "
        "Spanish spelling so the voice says it as a Spanish audiobook narrator would. Rules: one word, no "
        "hyphens, no English phonetics (never 'oo', 'ee', 'ah', 'oh', 'eh'); change only letters Spanish "
        "reads wrongly (sh→ch or s, th→t, w→u, ck→c, doubled letters → one, silent final letters); add a "
        "written accent only if the stress would be wrong. If Spanish already reads it well, return it "
        "unchanged.\n"
        "Examples: Thompson → Tómson; Rousseau → Rusó; Shallan → Chálan; Wheeler → Uíler; Sarah → Sara; "
        "Dalinar → Dalinar.\n"
        'Answer {"respelling": "..."}.'
    )
    schema = {
        "type": "object",
        "properties": {"respelling": {"type": "string", "maxLength": 40}},
        "required": ["respelling"],
    }
    return user, schema


def validate_choice(kind: str, original: str, options: dict, answer: dict) -> Optional[str]:
    """What to say for a choice answer; ``None`` keeps the text (or rejects)."""
    choice = answer.get("choice") if isinstance(answer, dict) else None
    if not isinstance(choice, str) or choice == "keep" or choice not in options:
        return None
    spoken = options[choice]
    if spoken == original or not spoken.strip():
        return None
    return spoken


def validate_respelling(original: str, answer: dict) -> Optional[str]:
    """A respelling that only re-spells the name, or ``None``.

    Rejects markup, digits, sentences, other words, and anything that is not
    recognisably the same name (similarity of the accent-free spellings).
    """
    value = answer.get("respelling") if isinstance(answer, dict) else None
    if not isinstance(value, str):
        return None
    value = " ".join(value.split()).strip(" .\"'«»")
    if not value or not _NAME_OK_RE.match(value):
        return None
    if len(value) > 2 * len(original) + 3 or len(value) < max(2, len(original) // 2):
        return None
    if len(value.split()) != len(original.split()):
        return None
    a, b = _fold(original), _fold(value)
    if value == original:
        return None
    if "-" in value:
        return None  # syllable breaks: the voice would pause inside the name
    for pattern in _ENGLISH_PHONETICS:
        if pattern.search(b) and not pattern.search(a):
            return None  # "Dohkson", "Renoo": English pronunciation spelling
    if difflib.SequenceMatcher(None, a, b).ratio() < 0.5:
        return None
    if a[:1] != b[:1] and difflib.SequenceMatcher(None, a, b).ratio() < 0.7:
        return None
    return value


# ── Cache ────────────────────────────────────────────────────────────────────


def cache_key(model: str, kind: str, original: str, context: str) -> str:
    ctx = "" if kind == "name" else hashlib.sha1(context.encode("utf-8")).hexdigest()[:16]  # noqa: S324
    raw = f"{model}|{kind}|{original}|{ctx}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()  # noqa: S324 — cache key


class AnswerCache:
    """``{key: {"spoken": str|None}}`` in one JSON file (best effort)."""

    def __init__(self, path: Optional[str]):
        self.path = path
        self.data: dict = {}
        self.dirty = False
        if path:
            try:
                with open(path, encoding="utf-8") as fh:
                    loaded = json.load(fh)
                if isinstance(loaded, dict):
                    self.data = loaded
            except (OSError, ValueError):
                pass

    def get(self, key: str):
        return self.data.get(key)

    def put(self, key: str, spoken: Optional[str]) -> None:
        self.data[key] = {"spoken": spoken}
        self.dirty = True

    def save(self) -> None:
        if not self.path or not self.dirty:
            return
        tmp = f"{self.path}.tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(self.data, fh, ensure_ascii=False)
            os.replace(tmp, self.path)
            self.dirty = False
        except OSError:
            logger.debug("Reader: could not save the LLM answer cache", exc_info=True)


def resolve(candidate, client: OllamaClient, cache: Optional[AnswerCache] = None) -> tuple[Optional[str], bool]:
    """``(spoken or None, cached)`` for one rule candidate."""
    context = sentence_around(candidate.context, candidate.c0, candidate.c1)
    key = cache_key(client.model, candidate.kind, candidate.original, context)
    if cache is not None:
        hit = cache.get(key)
        if isinstance(hit, dict) and "spoken" in hit:
            return hit["spoken"], True
    if candidate.kind == "name":
        user, schema = name_prompt(candidate.original, context)
        spoken = validate_respelling(candidate.original, client.chat(_SYSTEM, user, schema))
    else:
        user, schema = choice_prompt(candidate.kind, candidate.original, context, candidate.options)
        spoken = validate_choice(candidate.kind, candidate.original, candidate.options, client.chat(_SYSTEM, user, schema))
    if cache is not None:
        cache.put(key, spoken)
    return spoken, False
