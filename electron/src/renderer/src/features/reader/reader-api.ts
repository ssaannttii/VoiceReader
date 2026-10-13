/** Typed client for the backend `/reader` router (see docs/reader/SPEC.md). */
import { apiFetch, apiJson } from '@/lib/api/client';

export type ReaderSourceType = 'text' | 'file' | 'url' | 'scan';

export interface ReaderDocumentSummary {
  id: string;
  title: string;
  author: string | null;
  source_type: ReaderSourceType;
  source_name: string | null;
  source_url: string | null;
  language: string | null;
  segment_count: number;
  char_count: number;
  chapter_count: number;
  has_cover: boolean;
  voice_id: string | null;
  engine: string | null;
  position_segment: number;
  progress: number;
  est_duration_s: number;
  created_at: number;
  updated_at: number;
  last_opened_at: number | null;
  // v2 fields (docs/reader/SPEC.md); absent on servers that predate them.
  /** Furthest segment ever reached. */
  furthest_segment?: number;
  archived?: boolean;
  completed?: boolean;
  import_status?: ReaderImportStatus;
  /** 0–1 while importing. */
  import_progress?: number | null;
  import_error?: string | null;
}

export type ReaderImportStatus = 'ready' | 'importing' | 'error';

/** `h` heading, `p` body, `li` list item, `quote` block quotation, `img` image (silent). */
export type ReaderSegmentKind = 'h' | 'p' | 'li' | 'quote' | 'img';

export interface ReaderSegment {
  i: number;
  text: string;
  para: number;
  kind: ReaderSegmentKind;
  // List items: the list (unique per document), numbered or not, item number, nesting 0–2.
  list?: number;
  ordered?: boolean;
  n?: number;
  depth?: number;
  // Images: API path of the picture, its description and caption, pixel size when known.
  src?: string;
  alt?: string;
  caption?: string;
  w?: number;
  h?: number;
}

export interface ReaderChapter {
  title: string;
  segment: number;
}

export interface ReaderDocument extends ReaderDocumentSummary {
  chapters: ReaderChapter[];
  segments: ReaderSegment[];
}

export interface ReaderWord {
  w: string;
  start: number;
  end: number;
  c0: number;
  c1: number;
}

export interface ReaderRender {
  segment: number;
  render_key: string;
  audio_url: string;
  duration_s: number;
  cached: boolean;
  words: ReaderWord[];
  /** Voice the backend rendered with — its automatic pick when the document had none. */
  voice?: string | null;
}

export interface ReaderPrerenderStatus {
  running: boolean;
  done: number;
  total: number;
  error: string | null;
  voice: string | null;
  engine: string | null;
}

export interface ReaderVoice {
  id: string;
  name: string;
  kind: 'profile' | 'preset';
  engine: string | null;
  language: string | null;
  description: string | null;
}

/** A respelling from VoiceStudio's dictionary; `language` is `*` for every language. */
export interface ReaderPronunciation {
  id: string;
  term: string;
  replacement: string;
  language: string;
}

export interface ReaderBookmark {
  id: string;
  doc_id?: string;
  segment: number;
  word: number | null;
  note: string | null;
  created_at: number;
}

export type ReaderModelState = 'unloaded' | 'loading' | 'ready' | 'error';

export interface ReaderStatus {
  engine: string;
  engine_ready: boolean;
  audio_format: 'mp3' | 'wav';
  lan_url: string | null;
  /** v2 contract; older backends omit it (treat as ready). */
  model_state?: ReaderModelState;
  model_error?: string | null;
}

// ── Prepared reading ("Lectura preparada", docs/reader/SPEC.md) ─────────────

/** Why a pause was added; each can be switched off per document. */
export type ReaderPauseRule =
  | 'heading'
  | 'chapter'
  | 'scene'
  | 'paragraph'
  | 'dialogue'
  | 'list'
  | 'quote'
  | 'ellipsis';

export type ReaderSpeechKind =
  | 'roman'
  | 'abbr'
  | 'ordinal'
  | 'number'
  | 'date'
  | 'time'
  | 'caps'
  | 'acronym'
  | 'hyphen'
  | 'symbol'
  | 'name';

/** One change to what the voice says: `original` (display text) → `spoken`. */
export interface ReaderSpeechItem {
  n: number;
  segment: number;
  c0: number;
  c1: number;
  original: string;
  spoken: string;
  kind: ReaderSpeechKind;
  source: 'rule' | 'llm';
  /** `suggested` (names) is not read until accepted; `reverted` reads as written. */
  state: 'applied' | 'suggested' | 'reverted';
  /** `doc`: applies to every occurrence of the word in the document. */
  scope: 'here' | 'doc';
  count: number;
  edited?: boolean;
  suggested?: string | null;
}

export interface ReaderSpeech {
  enabled: boolean;
  status: 'idle' | 'queued' | 'running' | 'ready' | 'error';
  progress: number | null;
  error: string | null;
  /** Results exist for the current text (false before preparing or after re-segmentation). */
  ready: boolean;
  stale: boolean;
  complete: boolean;
  prepared_at: number | null;
  llm: {
    status: 'used' | 'unavailable' | 'disabled' | 'none' | 'pending';
    model: string | null;
    candidates: number;
    resolved: number;
  } | null;
  pause_rules: Record<ReaderPauseRule, boolean>;
  pause_counts: Record<ReaderPauseRule, number>;
  items: ReaderSpeechItem[];
}

/** Voice/engine/language for synthesis; omitted fields use the backend defaults. */
export interface ReaderVoiceChoice {
  voice?: string | null;
  engine?: string | null;
  language?: string | null;
  /** OmniVoice sampling steps (Labs "high quality"); omitted = engine default. */
  num_step?: number | null;
}

export const readerKeys = {
  all: ['reader'] as const,
  documents: ['reader', 'documents'] as const,
  document: (id: string) => ['reader', 'document', id] as const,
  voices: ['reader', 'voices'] as const,
  defaultVoices: ['reader', 'default-voices'] as const,
  status: ['reader', 'status'] as const,
  pronunciations: (language: string | null) =>
    ['reader', 'pronunciations', language ?? '*'] as const,
  bookmarks: (id: string) => ['reader', 'bookmarks', id] as const,
  speech: (id: string) => ['reader', 'speech', id] as const,
};

const doc = (id: string) => `/reader/documents/${encodeURIComponent(id)}`;

function voiceBody(choice: ReaderVoiceChoice, extra: Record<string, unknown> = {}): string {
  const body: Record<string, unknown> = { ...extra };
  if (choice.voice) body.voice = choice.voice;
  if (choice.engine) body.engine = choice.engine;
  if (choice.language) body.language = choice.language;
  if (choice.num_step) body.num_step = choice.num_step;
  return JSON.stringify(body);
}

export const readerApi = {
  list: (signal?: AbortSignal) => apiJson<ReaderDocumentSummary[]>('/reader/documents', { signal }),
  get: (id: string, signal?: AbortSignal) => apiJson<ReaderDocument>(doc(id), { signal }),
  createFromText: (text: string, title?: string) =>
    apiJson<ReaderDocumentSummary>('/reader/documents/text', {
      method: 'POST',
      body: JSON.stringify(title?.trim() ? { text, title: title.trim() } : { text }),
    }),
  createFromFile: (file: File) => {
    const form = new FormData();
    form.append('file', file, file.name);
    return apiJson<ReaderDocumentSummary>('/reader/documents/file', {
      method: 'POST',
      body: form,
    });
  },
  /** Page photos, in page order, read by OCR on the PC (background import). */
  createFromScan: (files: readonly File[], title?: string) => {
    const form = new FormData();
    files.forEach((file, index) =>
      form.append('files', file, file.name || `page-${index + 1}.jpg`),
    );
    if (title?.trim()) form.append('title', title.trim());
    return apiJson<ReaderDocumentSummary>('/reader/documents/scan', {
      method: 'POST',
      body: form,
    });
  },
  /** Re-queue a failed background import (409 when its upload is gone). */
  retryImport: (id: string) =>
    apiJson<ReaderDocumentSummary>(`${doc(id)}/retry`, { method: 'POST' }),
  createFromUrl: (url: string) =>
    apiJson<ReaderDocumentSummary>('/reader/documents/url', {
      method: 'POST',
      body: JSON.stringify({ url }),
    }),
  update: (
    id: string,
    patch: Partial<
      Pick<
        ReaderDocumentSummary,
        'title' | 'voice_id' | 'engine' | 'language' | 'archived' | 'completed'
      >
    >,
  ) =>
    apiJson<ReaderDocumentSummary>(doc(id), {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  /** `keepalive` lets the final position survive a closing tab (sendBeacon cannot PUT). */
  saveProgress: (id: string, segment: number, keepalive = false) =>
    apiFetch(`${doc(id)}/progress`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ segment }),
      keepalive,
    }),
  remove: (id: string) => apiJson<{ ok: boolean }>(doc(id), { method: 'DELETE' }),
  cover: async (id: string, signal?: AbortSignal) =>
    (await apiFetch(`${doc(id)}/cover`, { signal })).blob(),
  /** An image of a document: `src` of an `img` segment (`/reader/documents/{id}/assets/…`). */
  asset: async (src: string, signal?: AbortSignal) => (await apiFetch(src, { signal })).blob(),
  render: (id: string, segment: number, choice: ReaderVoiceChoice, signal?: AbortSignal) =>
    apiJson<ReaderRender>(`${doc(id)}/segments/${segment}/render`, {
      method: 'POST',
      body: voiceBody(choice),
      signal,
    }),
  audio: async (audioUrl: string, signal?: AbortSignal) =>
    (await apiFetch(audioUrl, { signal })).blob(),
  startPrerender: (id: string, choice: ReaderVoiceChoice, fromSegment = 0) =>
    apiJson<ReaderPrerenderStatus>(`${doc(id)}/prerender`, {
      method: 'POST',
      body: voiceBody(choice, { from_segment: fromSegment }),
    }),
  prerenderStatus: (id: string, signal?: AbortSignal) =>
    apiJson<ReaderPrerenderStatus>(`${doc(id)}/prerender`, { signal }),
  cancelPrerender: (id: string) =>
    apiJson<ReaderPrerenderStatus>(`${doc(id)}/prerender`, { method: 'DELETE' }),
  voices: (signal?: AbortSignal) => apiJson<ReaderVoice[]>('/reader/voices', { signal }),
  /** Voice chosen per document language, e.g. `{ es: 'f952f96a' }`. */
  defaultVoices: (signal?: AbortSignal) =>
    apiJson<Record<string, string>>('/reader/default-voices', { signal }),
  setDefaultVoice: (language: string, voiceId: string | null) =>
    apiJson<Record<string, string>>('/reader/default-voices', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ language, voice_id: voiceId }),
    }),
  status: (signal?: AbortSignal) => apiJson<ReaderStatus>('/reader/status', { signal }),
  pronunciations: (language: string | null, signal?: AbortSignal) =>
    apiJson<ReaderPronunciation[]>(
      language
        ? `/reader/pronunciations?language=${encodeURIComponent(language)}`
        : '/reader/pronunciations',
      { signal },
    ),
  /** Upsert on (term, language); the term matches case-insensitively. */
  savePronunciation: (term: string, replacement: string, language: string | null) =>
    apiJson<ReaderPronunciation>('/reader/pronunciations', {
      method: 'POST',
      body: JSON.stringify({ term, replacement, language }),
    }),
  deletePronunciation: (id: string) =>
    apiJson<{ ok: boolean }>(`/reader/pronunciations/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  bookmarks: (id: string, signal?: AbortSignal) =>
    apiJson<ReaderBookmark[]>(`${doc(id)}/bookmarks`, { signal }),
  addBookmark: (
    id: string,
    mark: { segment: number; word?: number | null; note?: string | null },
  ) =>
    apiJson<ReaderBookmark>(`${doc(id)}/bookmarks`, {
      method: 'POST',
      body: JSON.stringify(mark),
    }),
  updateBookmark: (bookmarkId: string, note: string | null) =>
    apiJson<ReaderBookmark>(`/reader/bookmarks/${encodeURIComponent(bookmarkId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ note }),
    }),
  deleteBookmark: (bookmarkId: string) =>
    apiJson<{ ok: boolean }>(`/reader/bookmarks/${encodeURIComponent(bookmarkId)}`, {
      method: 'DELETE',
    }),
  /** Markdown export (title, then chapter, sentence and note per bookmark). */
  exportBookmarks: async (id: string) => (await apiFetch(`${doc(id)}/bookmarks/export`)).blob(),
  /** Start loading the TTS engine (idempotent; 404 on backends without it). */
  warmup: () => apiJson<ReaderStatus>('/reader/warmup', { method: 'POST' }),
  /** Scenes for the automatic ambience; starts the analysis on the PC when missing. */
  ambience: (id: string, signal?: AbortSignal) =>
    apiJson<ReaderAmbience>(`${doc(id)}/ambience`, { signal }),

  // Prepared reading: what the voice says, never the displayed text.
  speech: (id: string, signal?: AbortSignal) =>
    apiJson<ReaderSpeech>(`${doc(id)}/speech`, { signal }),
  setSpeech: (
    id: string,
    change: { enabled?: boolean; pause_rules?: Partial<Record<ReaderPauseRule, boolean>> },
  ) =>
    apiJson<ReaderSpeech>(`${doc(id)}/speech/enable`, {
      method: 'POST',
      body: JSON.stringify(change),
    }),
  prepareSpeech: (id: string) =>
    apiJson<ReaderSpeech>(`${doc(id)}/speech/prepare`, { method: 'POST' }),
  /** Edit what change `n` says or its state; `all` also changes every identical one. */
  editSpeechItem: (
    id: string,
    n: number,
    patch: { spoken?: string; state?: ReaderSpeechItem['state']; all?: boolean },
  ) =>
    apiJson<ReaderSpeech>(`${doc(id)}/speech/items/${n}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  revertSpeechItem: (id: string, n: number, all = false) =>
    apiJson<ReaderSpeech>(`${doc(id)}/speech/items/${n}${all ? '?all=true' : ''}`, {
      method: 'DELETE',
    }),
  speechToDictionary: (id: string, n: number) =>
    apiJson<{ entry: ReaderPronunciation }>(`${doc(id)}/speech/items/${n}/to-dictionary`, {
      method: 'POST',
    }),
  /** Render a sentence as written (`prepared: false`) or prepared, to compare them. */
  previewSpeech: (
    id: string,
    segment: number,
    choice: ReaderVoiceChoice,
    prepared: boolean,
    item?: number,
    signal?: AbortSignal,
  ) =>
    apiJson<ReaderRender & { prepared: boolean }>(`${doc(id)}/speech/preview/${segment}`, {
      method: 'POST',
      body: voiceBody(choice, item === undefined ? { prepared } : { prepared, item }),
      signal,
    }),
};

/** `GET /reader/documents/{id}/ambience` (backend services/reader_ambience.py). */
export interface ReaderAmbience {
  status: 'ready' | 'computing' | 'unavailable';
  scenes: {
    start_segment: number;
    end_segment: number;
    tag: string;
    confidence: number;
    intensity: number;
  }[];
  refined?: boolean;
}

export const READER_ACCEPTED_FILES = '.txt,.md,.html,.htm,.pdf,.epub,.docx';
