# Reader — spec and API contract

Reader is a personal "listen to anything" workspace (ElevenLabs Reader–style) built on
VoiceStudio's local TTS. Documents live on the PC's backend; any device on the LAN
(phone first) opens the web UI served by the backend and streams sentence audio
rendered on the PC GPU.

## Product surface

**Library** (`#/reader`)
- "Continue listening" hero card for the most recently opened unfinished document.
- Searchable list of documents: cover tile (EPUB cover or generated gradient + initial),
  title, author/source host, progress bar, "x% · ~N min left".
- Add button opens a bottom sheet: Paste text · Upload file (txt, md, html, pdf, epub, docx)
  · From link (article URL).
- Per-document menu: rename, download for offline, remove download, delete.
- Persistent mini-player at the bottom whenever a document is loaded in the player.

**Reader** (`#/reader/$docId`)
- Reading view: serif text, paragraphs and headings preserved, current sentence softly
  highlighted, current word strongly highlighted, auto-scroll that follows playback,
  "Back to current" pill when the user scrolls away. Tap a sentence/word to play from it.
- Player dock: document scrubber (by segment, time estimate), play/pause, back/forward
  (previous/next sentence; long-form skip ±15 s inside the current sentence where possible),
  speed (0.5–3.0×, pitch preserved), voice picker sheet, sleep timer (5/10/15/30/45/60 min,
  end of chapter), chapters sheet, text size, download for offline.
- Media Session: lock-screen title/artist/artwork and play/pause/next/previous/seek.
- Keyboard on desktop: Space play/pause, ←/→ previous/next sentence, +/− speed.

**Mobile/PWA**
- Mobile-first layout (360–430 px wide) with safe-area insets; scales to a centered column
  on desktop. No studio sidebar on Reader routes.
- `manifest.webmanifest` + icons, `start_url: "/#/reader"`, theme colour, apple meta.
- Service worker registered only in secure contexts (HTTPS / localhost); caches the app shell.
- Offline audio uses IndexedDB (works on plain-HTTP LAN too).
- On the web build, opening `/` on a phone-sized/coarse-pointer device goes to `#/reader`.

## Data model

SQLite table `reader_documents` (in `_BASE_SCHEMA` **and** alembic `0014_reader_documents`):

| column | type | notes |
|---|---|---|
| id | TEXT PK | uuid4 hex |
| title | TEXT NOT NULL | |
| author | TEXT | nullable |
| source_type | TEXT NOT NULL | `text` \| `file` \| `url` |
| source_name | TEXT | original filename or URL host |
| source_url | TEXT | nullable |
| language | TEXT | ISO 639-1 guess (`es`, `en`, …), nullable |
| segment_count | INTEGER NOT NULL | |
| char_count | INTEGER NOT NULL | |
| chapter_count | INTEGER NOT NULL DEFAULT 0 | |
| has_cover | INTEGER NOT NULL DEFAULT 0 | |
| voice_id | TEXT | last voice used for this doc, nullable |
| engine | TEXT | last engine used, nullable (null = active engine) |
| position_segment | INTEGER NOT NULL DEFAULT 0 | |
| created_at, updated_at, last_opened_at | REAL | unix seconds; last_opened nullable |

Content file: `<DATA_DIR>/reader/<id>/content.json`; optional `cover.(jpg|png|webp)` beside it.
Audio cache: `<DATA_DIR>/reader/audio/<render_key>.mp3` (or `.wav` when no encoder) plus
`<render_key>.json` holding timings. `render_key = sha1(engine|voice|language|segment_text)` —
content-addressed, so identical sentences are shared across documents. Speed is applied
client-side (`playbackRate`), never baked into audio.

## API (FastAPI router, prefix `/reader`)

All JSON. Errors use FastAPI's `{"detail": "..."}`.

`DocumentSummary`:
```json
{
  "id": "9f…", "title": "…", "author": null, "source_type": "url",
  "source_name": "elpais.com", "source_url": "https://…", "language": "es",
  "segment_count": 212, "char_count": 18234, "chapter_count": 0, "has_cover": false,
  "voice_id": null, "engine": null, "position_segment": 37,
  "progress": 0.17,                 // position_segment / segment_count
  "est_duration_s": 1215.0,         // char_count / 15.0 (≈15 chars per second at 1×)
  "created_at": 1760000000.0, "updated_at": 1760000000.0, "last_opened_at": null
}
```

`Document` = `DocumentSummary` + :
```json
{
  "chapters": [{"title": "Capítulo 1", "segment": 0}],
  "segments": [
    {"i": 0, "text": "El título", "para": 0, "kind": "h"},
    {"i": 1, "text": "Primera frase.", "para": 1, "kind": "p"},
    {"i": 2, "text": "Segunda frase.", "para": 1, "kind": "p"}
  ]
}
```
`kind`: `h` heading (its own paragraph), `p` body sentence. Segments are sentences from
`services.sentence_chunker.SentenceChunker`; very long sentences are split at ≤ 300 chars on
clause punctuation/whitespace. `text` is the display text (not normalized); normalization
(`services.text_normalization.normalize_for_tts`) is applied only at synthesis time.

### Endpoints
| method | path | body | returns |
|---|---|---|---|
| GET | `/reader/documents` | – | `DocumentSummary[]` ordered by `coalesce(last_opened_at, created_at)` desc |
| POST | `/reader/documents/text` | `{"text": str, "title"?: str, "language"?: str}` | `DocumentSummary` |
| POST | `/reader/documents/file` | multipart `file`, optional form `language` | `DocumentSummary` |
| POST | `/reader/documents/url` | `{"url": str, "language"?: str}` | `DocumentSummary` |
| GET | `/reader/documents/{id}` | – | `Document` (also sets `last_opened_at`) |
| PATCH | `/reader/documents/{id}` | any of `title, voice_id, engine, language` | `DocumentSummary` |
| PUT | `/reader/documents/{id}/progress` | `{"segment": int}` | `{"ok": true}` |
| DELETE | `/reader/documents/{id}` | – | `{"ok": true}` |
| GET | `/reader/documents/{id}/cover` | – | image bytes or 404 |
| POST | `/reader/documents/{id}/segments/{i}/render` | `{"voice"?: str, "engine"?: str, "language"?: str}` | `RenderResult` |
| POST | `/reader/documents/{id}/prerender` | `{"voice"?, "engine"?, "language"?, "from_segment"?: int}` | `PrerenderStatus` (starts/continues a background job) |
| GET | `/reader/documents/{id}/prerender` | – | `PrerenderStatus` |
| DELETE | `/reader/documents/{id}/prerender` | – | cancels; `PrerenderStatus` |
| GET | `/reader/audio/{render_key}` | – | audio bytes (`audio/mpeg` or `audio/wav`), `Cache-Control: public, max-age=31536000, immutable`, supports Range |
| GET | `/reader/voices` | optional `?engine=` | `Voice[]` |
| GET / PUT | `/reader/default-voices` | PUT `{"language": "es", "voice_id": str\|null}` | `{lang: voice_id}`: the listener's chosen voice per document language |
| GET | `/reader/status` | – | `{"engine": str, "engine_ready": bool, "audio_format": "mp3"\|"wav", "lan_url": str\|null}` |

`RenderResult`:
```json
{
  "segment": 12, "render_key": "ab12…", "audio_url": "/reader/audio/ab12…",
  "duration_s": 3.84, "cached": true,
  "words": [{"w": "Primera", "start": 0.08, "end": 0.52, "c0": 0, "c1": 7}]
}
```
`words` cover every whitespace-delimited token of the segment's display `text`
(`c0`/`c1` = char offsets into `text`). Timing: trim leading/trailing silence by an energy
threshold, then distribute the voiced span across words weighted by character length
(+ extra weight after `, ; :` and sentence punctuation). Same render key ⇒ same response.
Concurrent requests for the same key must coalesce (one synthesis).

`PrerenderStatus`: `{"running": bool, "done": int, "total": int, "error": str|null, "voice": str|null, "engine": str|null}`

`Voice`: `{"id": str, "name": str, "kind": "profile"|"preset", "engine": str|null, "language": str|null, "description": str|null}`
— saved voice profiles (`voice_profiles` table) first, then the active engine's preset voices.

### Synthesis path
Reuse `api/routers/tts_stream.py`: `_resolve_stream_backend(engine)`, `build_stream_kwargs`,
`engine_in_use`, `runtime_compute_profile_async` gate, `evict_other_tts_engines`,
`run_on_gpu_pool_guarded(partial(render_stream_sentence, backend, kw, normalized_text), …)`.
Encode MP3 with the managed ffmpeg (`services/media_tools.py`) when available; else WAV.

### Import
- text: title = provided or first line (≤ 80 chars).
- file: txt/md (markdown headings → `h`), html, pdf (`longform_import.pdf_to_chapter_script`),
  epub (`longform_import.epub_to_chapter_script`; chapters + cover when present), docx
  (stdlib `zipfile` + `word/document.xml`; headings from `Heading*` styles).
- url: `core.url_safety` public-URL check, httpx fetch (timeout 20 s, ≤ 10 MB, follow
  redirects re-checked), main-content extraction with stdlib `html.parser`
  (prefer `<article>`/`<main>`, drop nav/aside/footer/script/style/form, keep `h1–h3`, `p`, `li`,
  `blockquote`), title from `og:title`/`<title>`, author from `meta[name=author]`.
- language: lightweight guess (stopword counts for es/en/fr/de/it/pt), user value wins.

## Implementation notes (as built)
- Render request fields default to the document's saved values; explicit `voice`/`engine` are
  saved on the document. With no voice at all, the backend picks a saved profile in the
  document language — the one chosen in `/reader/default-voices` (star in the voice sheet), else
  one preferring personality "Reader" — and pins it — cloning engines would
  otherwise invent a new speaker per sentence. `RenderResult.voice` reports the voice used.
- Prerender starts at `from_segment` and wraps to the start; idle status counts cached segments.
- `lan_url` is the share base URL (no PIN, no hash).
- Sentences shorter than 20 chars merge into the next segment; segments with nothing to
  pronounce render as 0.4 s of silence.
- Article extraction drops wiki apparatus (infoboxes, hatnotes, footnote markers, edit links,
  navboxes) by whole class token, and trailing "References / External links"-style sections.
  Page titles lose a trailing "| Site name".
- Limits: files 64 MB, URLs 10 MB, extracted text 5 M chars.
- LAN: `OMNIVOICE_SHARE_PIN` fixes the share PIN; the `ov_pin` cookie lasts a year; a `?pin=`
  link is captured by the renderer client and scrubbed from the address bar. PWA shell files
  (`/manifest.webmanifest`, `/reader-sw.js`, `/reader-icon*`, `/apple-touch-icon.png`) are public.

## Running for the phone
`scripts/reader/start-reader.ps1` builds the web UI when missing/stale, starts the backend
reachable from the LAN, and prints the phone URL. See `docs/reader/README.md`.
