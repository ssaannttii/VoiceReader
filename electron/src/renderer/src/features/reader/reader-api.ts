/** Typed client for the backend `/reader` router (see docs/reader/SPEC.md). */
import { apiFetch, apiJson } from '@/lib/api/client';

export type ReaderSourceType = 'text' | 'file' | 'url';

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
  /** Furthest segment ever reached (v2 contract); older backends omit it. */
  furthest_segment?: number;
  progress: number;
  est_duration_s: number;
  created_at: number;
  updated_at: number;
  last_opened_at: number | null;
}

export interface ReaderSegment {
  i: number;
  text: string;
  para: number;
  kind: 'h' | 'p';
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

/** Voice/engine/language for synthesis; omitted fields use the backend defaults. */
export interface ReaderVoiceChoice {
  voice?: string | null;
  engine?: string | null;
  language?: string | null;
}

export const readerKeys = {
  all: ['reader'] as const,
  documents: ['reader', 'documents'] as const,
  document: (id: string) => ['reader', 'document', id] as const,
  voices: ['reader', 'voices'] as const,
  defaultVoices: ['reader', 'default-voices'] as const,
  status: ['reader', 'status'] as const,
};

const doc = (id: string) => `/reader/documents/${encodeURIComponent(id)}`;

function voiceBody(choice: ReaderVoiceChoice, extra: Record<string, unknown> = {}): string {
  const body: Record<string, unknown> = { ...extra };
  if (choice.voice) body.voice = choice.voice;
  if (choice.engine) body.engine = choice.engine;
  if (choice.language) body.language = choice.language;
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
  createFromUrl: (url: string) =>
    apiJson<ReaderDocumentSummary>('/reader/documents/url', {
      method: 'POST',
      body: JSON.stringify({ url }),
    }),
  update: (
    id: string,
    patch: Partial<Pick<ReaderDocumentSummary, 'title' | 'voice_id' | 'engine' | 'language'>>,
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
  /** Start loading the TTS engine (idempotent; 404 on backends without it). */
  warmup: () => apiJson<ReaderStatus>('/reader/warmup', { method: 'POST' }),
};

export const READER_ACCEPTED_FILES = '.txt,.md,.html,.htm,.pdf,.epub,.docx';
