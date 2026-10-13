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
  "Back to current" pill when the user scrolls away. Tap a sentence/word to play from it
  (or, with the double-tap option, double-tap; a single tap then only reads). Paused and
  scrolled away, "Continue from here" plays from the first visible sentence.
- Every user jump (text tap, scrubber, chapters, lock-screen seek) shows "Back to mm:ss" for
  6 s; the jump is saved as progress only once that window has passed.
- Player dock: document scrubber (by segment, time estimate) with a tick at the furthest point
  reached and "Go to furthest point" when it is ≥ 30 s ahead, play/pause, skip back/forward
  (10/15/30/60 s, per device) and previous/next (sentence, chapter or skip, per device),
  speed (0.5–3.0×, pitch preserved), voice picker sheet, sleep timer (5/10/15/30/45/60 min,
  end of chapter), chapters sheet, text size, download for offline.
- Status line in the dock instead of a generic error: PC unreachable (retries every 5 s),
  offline with N downloaded sentences, voice loading, voice failed to load.
- Media Session: lock-screen title/artist/artwork and play/pause/stop/seek; previous/next and
  seek backward/forward follow the device's control settings.
- Keyboard on desktop: Space play/pause, ←/→ previous/next sentence, +/− speed.
- Queue ("Up next", per device): "Add to queue" in a document's menu and in the reader options;
  the queue sheet (dock chip, library mini-player) reorders (up/down), removes and plays now.
  When a document ends, the first queued one continues from its saved position (from the start
  once finished) and leaves the queue. The end-of-chapter/end-of-document sleep timer stops
  instead of continuing; a timed sleep keeps running across documents.
- Soundscapes (per device): off, rain, brown noise, pink noise, café, fireplace — synthesized on
  the device — with their own volume and "only while the voice plays"; the sleep timer fades and
  stops them too.
- Audio-only mode (top bar headphones, or options): the text gives way to the cover, title,
  chapter and an orb whose motion follows the word timings; tapping it plays/pauses.

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
| furthest_segment | INTEGER NOT NULL DEFAULT 0 | v2 (alembic `0015_reader_v2`) |
| archived, completed | INTEGER NOT NULL DEFAULT 0 | v2 |
| import_status | TEXT NOT NULL DEFAULT 'ready' | v2: `ready` \| `importing` \| `error` |
| import_progress, import_error | REAL, TEXT | v2, nullable |

`reader_bookmarks` (v2): `id TEXT PK, doc_id TEXT NOT NULL (indexed), segment INTEGER NOT NULL,
word INTEGER, note TEXT, created_at REAL NOT NULL`; rows are deleted with their document.

Content file: `<DATA_DIR>/reader/<id>/content.json`; optional `cover.(jpg|png|webp)` beside it.
A background import keeps its upload in `<id>/source/` and its options in `<id>/import.json`
until it succeeds.
Audio cache: `<DATA_DIR>/reader/audio/<render_key>.mp3` (or `.wav` when no encoder) plus
`<render_key>.json` holding timings. `render_key = sha1(engine|voice|language|final_text)`, where
`final_text` is what the engine synthesizes (display text → `normalize_for_tts` → pronunciation
dictionary) — content-addressed, so identical sentences are shared across documents. Speed is
applied client-side (`playbackRate`), never baked into audio.

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
`kind`: `h` heading (its own paragraph), `p` body sentence; rich content adds `li`, `quote`
and `img` (see "Rich content" below). Segments are sentences from
`services.sentence_chunker.SentenceChunker`; very long sentences are split at ≤ 300 chars on
clause punctuation/whitespace. `text` is the display text (not normalized); normalization
(`services.text_normalization.normalize_for_tts`) is applied only at synthesis time.

### Endpoints
| method | path | body | returns |
|---|---|---|---|
| GET | `/reader/documents` | – | `DocumentSummary[]` ordered by `coalesce(last_opened_at, created_at)` desc |
| POST | `/reader/documents/text` | `{"text": str, "title"?: str, "language"?: str}` | `DocumentSummary` |
| POST | `/reader/documents/file` | multipart `file`, optional form `language` | `DocumentSummary` (`import_status: "importing"`; see v2) |
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
| GET | `/reader/status` | – | `{"engine": str, "engine_ready": bool, "audio_format": "mp3"\|"wav", "lan_url": str\|null, "model_state", "model_error"}` |

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

### Playback transport (client)
- Where `MediaSource.isTypeSupported('audio/mpeg')` (Chrome, Edge, Firefox, Electron; not
  WebKit) the player appends every rendered MP3 to one `SourceBuffer` in `sequence` mode
  (`reader-mse.ts`). Each append records its media start/end (`timestampOffset` /
  `buffered.end`), which maps word timings to the shared clock. It keeps ≥ 3 sentences and
  ≥ 60 s appended ahead while playing (≤ 180 s), evicts audio more than 30 s behind the
  playhead, and rebuilds the MediaSource for seeks outside the buffered audio.
- Background: the element never pauses or swaps `src` between sentences, and appends are
  driven by `timeupdate` / `waiting` / `updateend` events and load promises — not timers or
  animation frames — so a locked Android phone keeps playing.
- Queue advance runs inside the player, never in React, a timer or an animation frame: once a
  document is fully appended (MSE) or prefetched to its end (blob), the next queued document's
  JSON and first sentence are fetched. With a queue, the MSE stream is left open at the end, so
  the element waits (still "playing") instead of firing `ended`; that `waiting` (Chrome holds the
  final MP3 frame of an open stream, so it comes ~0.1 s early) switches documents and rebuilds the
  MediaSource on the same element. The blob player switches on `ended`, synchronously when the
  next sentence is ready. Lock-screen metadata, undo stack and progress follow the new document;
  the reader page navigates to it whenever it next renders. Diagnostics: `queue_advance`.
- Soundscapes play on a second `<audio loop>` element (WAV loops rendered once with
  `OfflineAudioContext`, 32 s with a 2 s equal-power crossfade, cached in IndexedDB
  `reader-soundscapes`). The reading audio is never routed through Web Audio. The element follows
  player events (state, sleep fade, sleep stop), so it pauses/resumes with the voice on a locked
  phone. iOS ignores element volume (system volume applies). Diagnostics: `soundscape` on/off.
- Safari/iOS, WAV audio (no ffmpeg) and any MSE failure use the per-sentence blob player.
  `localStorage['reader-engine'] = 'blob' | 'mse'` forces one for diagnostics.
- `POST /reader/warmup` is called when a document opens (a 404 from older backends is
  ignored); a missing `model_state` counts as ready; a missing `furthest_segment` as the
  saved position.

## Running for the phone
`scripts/reader/start-reader.ps1` builds the web UI when missing/stale, starts the backend
reachable from the LAN, and prints the phone URL. See `docs/reader/README.md`.

## v2 contract (global improvement plan, docs/reader/PLAN.md)

Additive: every existing field and route keeps its meaning.

### DocumentSummary — new fields
| field | type | notes |
|---|---|---|
| `furthest_segment` | int | max segment ever reached; `PUT .../progress` raises it, never lowers it |
| `archived` | bool | hidden from the default library view |
| `completed` | bool | set when progress reaches the end; user can toggle |
| `import_status` | `"ready"` \| `"importing"` \| `"error"` | file/scan imports run in the background |
| `import_progress` | float \| null | 0–1 while importing |
| `import_error` | str \| null | human-readable, when `import_status == "error"` |

`PATCH /reader/documents/{id}` additionally accepts `archived`, `completed`.
`GET /reader/documents/{id}` on a document that is still importing returns 409 `{"detail": "importing"}`.

### Background imports
- `POST /reader/documents/file` and `POST /reader/documents/scan` return a `DocumentSummary`
  immediately with `import_status: "importing"`; the client polls `GET /reader/documents`
  (every 2 s while any row is importing). `text` and `url` imports stay synchronous.
- `POST /reader/documents/scan`: multipart `files` (1–50 images, in page order), optional form
  `language`, `title`. Server-side OCR; the result is a normal document (one paragraph per text
  block, one chapter per image when there are several).

### PDF chapters
PDF import detects chapter headings ("Capítulo 7", "Chapter VII", "Parte II", "Prólogo",
"Epílogo", numbered or roman-numbered short lines, all-caps short lines) and emits `h` blocks;
if none are found, chapters fall back to every 10 pages ("Páginas 1–10"…).

### Engine status
`GET /reader/status` adds `model_state`: `"unloaded"` \| `"loading"` \| `"ready"` \| `"error"`
and `model_error`. `POST /reader/warmup` starts loading the TTS engine (idempotent, returns
status). Clients call it when Reader opens.

### Pronunciation (user-level wrappers over VoiceStudio's dictionary)
- `GET /reader/pronunciations?language=es` → `[{id, term, replacement, language}]`
- `POST /reader/pronunciations` `{term, replacement, language}` → entry
- `DELETE /reader/pronunciations/{id}`
- Rendering applies the dictionary for the document language after `normalize_for_tts`. The
  render cache key is computed from the **final synthesized text**, so a new entry only
  re-renders the segments that contain the term.

### Bookmarks
- `GET /reader/documents/{id}/bookmarks` → `[{id, segment, word, note, created_at}]` (by segment)
- `POST /reader/documents/{id}/bookmarks` `{segment, word?, note?}` → bookmark
- `PATCH /reader/bookmarks/{bid}` `{note}` · `DELETE /reader/bookmarks/{bid}`
- `GET /reader/documents/{id}/bookmarks/export` → `text/markdown` (title, then per bookmark the
  chapter, the segment text and the note)

### Client-only (no API)
Continuous MSE playback, undo seek, configurable controls, reading themes, double-tap, reading
sync, in-document search, queue, soundscapes, voice picker search/recents, share target.

### v2 client (input & study UI)
- **Pronunciation.** Long press (500 ms, cancelled by > 10 px of movement; touch/pen) or
  right-click (mouse, unless text is selected) on a word opens "Pronounce as". *Try* upserts the
  entry, renders the sentence containing the word and plays ~1 s around it; closing without
  saving restores the previous entry (or deletes the trial one). Saving calls
  `readerPlayer.refreshAudio()`, which drops rendered/appended audio and resumes from the current
  sentence. On touch devices the long press replaces native text selection in the reading view.
- **Bookmarks.** Options → "Bookmark this spot" or desktop **B** bookmarks the spoken sentence
  (else the saved position); bookmarked `.rd-sent` elements carry `data-bookmark`. The sheet
  groups by chapter, reveals (`reader:reveal`), plays from a bookmark, edits/deletes notes, and
  downloads the export through an object URL (authenticated like any API call).
- **Share target.** `manifest.webmanifest` declares one POST multipart `share_target` at
  `/reader-share` (params `title`, `text`, `url`, `files`). `reader-sw.js` answers it: files go to
  `POST /reader/documents/file` (one each) and images together to `/reader/documents/scan`, with
  the origin's cookie and the `X-VoiceStudio-CSRF` marker; it then redirects (303) to
  `#/reader/share?files=N&failed=M[&error=…]`. Links and text are redirected as
  `#/reader/share?title&text&url`; that route imports a URL (an http(s) link in `url`, or in `text`
  with ≤ 200 chars of caption) or the text, then opens the document. Needs an installed PWA on a
  secure origin with the service worker active, on a backend serving the UI at its own origin.
- **Scan.** Add sheet → Scan: camera (`capture="environment"`) or gallery images, reorder/remove,
  optional title, ≤ 50 pages → `POST /reader/documents/scan`; the row then imports in the
  background like a file. Failed imports show *Retry* (`POST .../retry`; a 409 explains the upload
  is gone).
- **Chapters sheet.** Each chapter shows listened ✓ (furthest point past its end), *Now*, or the
  percentage the furthest point reached inside it.

### v2 as built (backend notes and additive extensions)
- **409s.** While a document imports, every content route answers 409 `{"detail": "importing"}`:
  `GET` document, render, prerender (start/status/cancel), `PUT .../progress`, `POST .../bookmarks`,
  bookmark export. After a failed import the same routes answer 409 `{"detail": "import_error"}`.
  `DELETE` works in any state (an import in flight is discarded).
- **`completed`** is set when `PUT .../progress` reaches `segment_count - 1` (or `segment_count`;
  a one-segment document needs `segment_count`). Progress never clears it; `PATCH` does.
- **Background worker.** One import at a time on a dedicated thread (`services/reader_jobs.py`).
  `import_progress`: PDF pages (0–0.8) then segmentation; EPUB 0.3 after extraction, then per
  chapter; scans per image. **Restart:** the upload stays in `<id>/source/` until the import
  succeeds, so rows left `importing` are **resumed** on the first `GET /reader/documents` after
  start-up; a row whose upload is gone becomes `error` ("…add the file again").
- **Extension:** `POST /reader/documents/{id}/retry` re-queues a failed import whose upload is still
  stored (409 otherwise) → `DocumentSummary` with `import_status: "importing"`.
- **Scan.** `source_type: "scan"` (new value), `source_name: "N images"`; placeholder title
  `Scan (N pages)` (or the form `title`), replaced by the first detected heading unless a title
  was given. Chapters are named `Página N` / `Page N` by document language. OCR runs locally
  (`services/reader_ocr.py`): PaddleOCR PP-OCRv3 mobile detection + PP-OCRv5 Latin recognition
  (accents, ñ, ¿¡) as ONNX on `onnxruntime` (CPU; already a VoiceStudio dependency), ~10 MB
  downloaded from Hugging Face (`monkt/paddleocr-onnx`, pinned revision, Apache-2.0) on the first
  scan; tilted photos are straightened first. Without network on that first scan, or without
  onnxruntime, the document ends in `error` with a message saying so. Limits: 50 images,
  25 MB each.
- **PDF chapters.** Running headers/footers and page numbers are removed first; a heading needs
  to start a line after a sentence end; bare numbers count only in sequence (1, 2, 3…); a short
  title line right after a heading is merged ("Capítulo 1. La partida"). With fewer than two
  headings, PDFs over 10 pages get `Páginas 1–10`… chapters (labels follow the document
  language: es/pt/fr/de/it, else English) and paragraphs flow across page breaks.
- **Warm-up** returns `{"engine", "model_state", "model_error"}` and never starts a download: the
  built-in model is warmed only when its checkpoint is cached, other engines only when
  `is_available()`. `model_state` comes from the loaded-model inventory (`/model/loaded`) and,
  for OmniVoice, `/model/status`; a model unloaded by the idle timeout reads `unloaded` again.
- **Pronunciation.** `language` may be null / `"*"` (global entry; picker names like `Spanish`
  are stored as their code). `GET ?language=` lists global + that language's respelling entries
  (IPA/CMU rows stay in Settings → Pronunciation). `POST` upserts on (term, language), matching
  the term case-insensitively. Entries live in VoiceStudio's `pronunciation_entries` table, so
  they also apply to Studio generation.
- **Render cache compatibility.** Pre-v2 entries (keyed by the display text) stay valid while the
  dictionary changes nothing in the segment (final text == its normalization), and are found
  through that legacy key; entries now store `synth_text`, the display `text` and the voiced
  `span`, and word timings are recomputed when one final text serves another display text.
- **Bookmarks** also carry `doc_id`; a `word` of a regrouped (segmentation-upgraded) document is
  cleared because it indexed the old segment.

## Rich content (lists, quotes, images)

Additive: documents imported before keep their `h`/`p` segments unchanged (no rich fields are
invented, `SEGMENTATION_VERSION` stays 3).

### Segment kinds
| kind | extra fields | rules |
|---|---|---|
| `li` | `list` (int, unique per document), `ordered` (bool), `n` (item number), `depth` (1–2, omitted at 0) | each item is its own paragraph: never grouped with siblings or neighbours, never joined by the PDF repair; several paragraphs of one item share `list` + `n` |
| `quote` | – | block-quotation paragraphs; sentences group only within the same paragraph |
| `img` | `src`, optional `alt`, `caption`, `w`/`h` (pixels) | one segment with `text: ""` (rendered as 0.4 s of silence) |

In `content.json` an image's `src` is its asset name (`img-001.jpg`); `GET /reader/documents/{id}`
returns it as the API path `/reader/documents/{id}/assets/img-001.jpg`. A document of only images
is refused ("no readable text found"). The bookmark export quotes an image's alt/caption.

### Endpoint
| method | path | returns |
|---|---|---|
| GET | `/reader/documents/{id}/assets/{name}` | image bytes with its content type, `Cache-Control: public, max-age=86400`, `X-Content-Type-Options: nosniff`; 404 for any name the importer would not write (`img-NNN.(jpg\|png\|gif\|webp\|avif)`, no separators) or outside `<id>/assets/` |

Images live in `<DATA_DIR>/reader/<id>/assets/` and are deleted with the document.

### Import
- **HTML / URL:** `ul`/`ol` (incl. `start`) → `li` with nesting depth ≤ 3 levels; `blockquote` → `quote`;
  `<figure>` → one image with its `<figcaption>` (other text inside a figure stays unread, as before);
  loose `<img>` → an image after its paragraph. Decoration is skipped: width/height < 48 px, icon/logo/
  avatar/emoji/tracking class or path hints, `aria-hidden`/`role=presentation`, SVG, lazy-load
  placeholders (real source from `data-src`/`srcset`). Existing noise filtering is unchanged.
- **Downloads:** only for URL imports (the page, or a `.md` fetched by URL), through the same
  SSRF-checked fetch, ≤ 5 MB per image, ≤ 40 images and 100 MB per document, 10 s per image, 45 s in
  total (6 in parallel). Local files never make network requests: they keep `data:` URIs and package
  members only.
- **Markdown / pasted text:** `-`/`*`/`+`/`1.` lists (nesting by indentation, numbering from the
  first item, lazy continuation lines), `>` quotes, `![alt](src "title")` images (title = caption).
- **DOCX:** list paragraphs by `w:numPr` (paragraph or style; bullet vs numbered from
  `numbering.xml`), `Quote`/`Intense Quote` styles (and localized names) → `quote`, inline
  DrawingML/VML pictures from `word/media` (alt from `docPr descr`).
- **EPUB:** the audiobook extractor plus marks for `ul`/`ol`/`li`, `blockquote`, `img`/SVG `image`
  (package members) and `figcaption`; sections with only images are still skipped. Source line breaks
  inside XHTML text read as spaces.
- **PDF / scans:** unchanged.
- Every kept image must sniff as JPEG, PNG, GIF, WebP or AVIF and be at least 48 px on each side.

### Client
- Lists render as `ul`/`ol` (numbers from `n`, nested lists inside their item), quotes as one
  `blockquote` per run of quote paragraphs (left rule, reading font), images as a `figure` that
  reserves `w`/`h`, loads lazily (near the screen) through the API and shows caption or alt below.
  The spoken image gets an accent ring; list items and quotes keep the sentence and word highlight.
- Windowing groups blocks by paragraph as before (`groupBlocks`); `layoutBlocks` nests the visible
  window's list items, so a window may start inside a nested list.
- Search covers `li`/`quote` text; bookmarks and the scrubber preview show an image's alt/caption
  or "Image".
- Offline downloads (IndexedDB `reader-offline` v2, `assets` store) also keep the images; a failed
  image never fails the download, and offline reading falls back to the stored copy.
