/**
 * The Reader's playback engine: one module-level HTMLAudioElement that plays a
 * document sentence by sentence. React reads three channels with different
 * rates so the long reading view never re-renders while audio plays:
 *
 * - `useReaderPlayer()` — document, segment, status, speed, voice, sleep timer.
 * - `useReaderClock()` — position inside the segment/document (≈4 Hz).
 * - `subscribeHighlight()` — imperative (segment, word) callbacks per frame.
 */
import { useSyncExternalStore } from 'react';
import { dlog, installDebug } from './reader-debug';
import { claimPlayback } from '@/lib/audio/playback';
import { createObjectUrl, revokeObjectUrl } from '@/lib/audio/object-url';
import { ApiError, apiPath, describeError, isAbortError } from '@/lib/api/client';
import { tr } from '@/lib/i18n-text';
import { queryClient } from '@/lib/query';
import {
  readerApi,
  readerKeys,
  type ReaderDocument,
  type ReaderDocumentSummary,
  type ReaderRender,
  type ReaderVoiceChoice,
  type ReaderWord,
} from './reader-api';
import {
  chapterEndSegment,
  chapterIndexAt,
  clampSpeed,
  estimateSegmentSeconds,
  wordIndexAt,
} from './reader-text';
import { readOfflineSegment } from './offline-store';
import { offlineBackend, offlineSnapshot, refreshOffline } from './offline-state';
import { readerPrefs, setReaderPrefs } from './reader-prefs';

export type ReaderStatus = 'idle' | 'paused' | 'buffering' | 'playing' | 'ended' | 'error';

export type ReaderSleep =
  | { mode: 'off' }
  | { mode: 'time'; endsAt: number; minutes: number }
  | { mode: 'chapter'; endSegment: number };

export interface ReaderPlayerState {
  doc: ReaderDocument | null;
  segment: number;
  status: ReaderStatus;
  error: string | null;
  rate: number;
  voice: string | null;
  engine: string | null;
  sleep: ReaderSleep;
  coverUrl: string | null;
  /** True while the current segment plays from the offline copy. */
  offline: boolean;
}

export interface ReaderClock {
  /** Seconds into the current segment (media time). */
  time: number;
  /** Current segment length, 0 until known. */
  duration: number;
  /** Document position and length in 1x seconds (estimated for unrendered segments). */
  elapsed: number;
  total: number;
  /** Milliseconds before a timed sleep stops playback. */
  sleepLeft: number | null;
}

interface ReadySegment {
  segment: number;
  render: ReaderRender;
  url: string;
  owned: boolean;
  offline: boolean;
}

interface CacheEntry {
  promise: Promise<ReadySegment>;
  ready?: ReadySegment;
}

const PREFETCH_AHEAD = 3;
const KEEP_BEHIND = 2;
const KEEP_AHEAD = 8;
const PROGRESS_DEBOUNCE_MS = 3000;
const FADE_MS = 5000;
const PLAYBACK_SOURCE = 'reader';

/** 0.1 s of 8 kHz 8-bit silence; played inside a tap so iOS unlocks the element. */
export function silentWav(): string {
  const samples = 800;
  const bytes = new Uint8Array(44 + samples);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) =>
    [...text].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples, true);
  ascii(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 8000, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  ascii(36, 'data');
  view.setUint32(40, samples, true);
  bytes.fill(128, 44);
  let binary = '';
  bytes.forEach((byte) => (binary += String.fromCharCode(byte)));
  return `data:audio/wav;base64,${btoa(binary)}`;
}

class ReaderPlayer {
  private audio: HTMLAudioElement | null = null;
  private silent: string | null = null;
  private state: ReaderPlayerState = {
    doc: null,
    segment: 0,
    status: 'idle',
    error: null,
    rate: readerPrefs().rate,
    voice: null,
    engine: null,
    sleep: { mode: 'off' },
    coverUrl: null,
    offline: false,
  };
  private clock: ReaderClock = { time: 0, duration: 0, elapsed: 0, total: 0, sleepLeft: null };
  private listeners = new Set<() => void>();
  private clockListeners = new Set<() => void>();
  private highlightListeners = new Set<(segment: number, word: number) => void>();
  private cache = new Map<number, CacheEntry>();
  private durations = new Map<number, number>();
  private prefix: Float64Array | null = null;
  private epoch = 0;
  private playToken = 0;
  private prefetchToken = 0;
  private current: ReadySegment | null = null;
  private word = -1;
  private wantPlay = false;
  private raf: number | null = null;
  private release: (() => void) | null = null;
  private progressTimer: ReturnType<typeof setTimeout> | null = null;
  private savedSegment: number | null = null;
  private sleepTimer: ReturnType<typeof setInterval> | null = null;
  private lastClockAt = 0;

  // ── subscriptions ────────────────────────────────────────────────────────
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
  getState = () => this.state;
  subscribeClock = (listener: () => void) => {
    this.clockListeners.add(listener);
    return () => void this.clockListeners.delete(listener);
  };
  getClock = () => this.clock;
  subscribeHighlight(listener: (segment: number, word: number) => void): () => void {
    this.highlightListeners.add(listener);
    listener(this.state.segment, this.word);
    return () => void this.highlightListeners.delete(listener);
  }
  /** Word timings of a segment when its render is loaded. */
  wordsFor(segment: number): ReaderWord[] | null {
    return this.cache.get(segment)?.ready?.render.words ?? null;
  }

  private statusSince = 0;

  private set(patch: Partial<ReaderPlayerState>) {
    const before = this.state.status;
    this.state = { ...this.state, ...patch };
    if (patch.status && patch.status !== before) {
      const now = performance.now();
      dlog('status', {
        from: before,
        to: patch.status,
        seg: this.state.segment,
        after_ms: this.statusSince ? Math.round(now - this.statusSince) : null,
      });
      this.statusSince = now;
    }
    this.listeners.forEach((listener) => listener());
  }

  /** Live numbers for the diagnostics overlay. */
  debugSnapshot(): { segment: number; total: number; readyAhead: number; status: string } {
    const total = this.state.doc?.segments.length ?? 0;
    let readyAhead = 0;
    for (let i = this.state.segment + 1; i < total && this.cache.get(i)?.ready; i++) readyAhead++;
    return { segment: this.state.segment, total, readyAhead, status: this.state.status };
  }

  private emitHighlight(word: number, force = false) {
    if (word === this.word && !force) return;
    this.word = word;
    const { segment } = this.state;
    this.highlightListeners.forEach((listener) => listener(segment, word));
  }

  // ── audio element ────────────────────────────────────────────────────────
  private element(): HTMLAudioElement {
    if (this.audio) return this.audio;
    const audio = new Audio();
    audio.preload = 'auto';
    audio.setAttribute('playsinline', '');
    audio.setAttribute('x-webkit-airplay', 'allow');
    audio.addEventListener('playing', () => {
      if (!this.isCurrent()) return;
      this.set({ status: 'playing', error: null });
      this.startFrames();
      this.updatePosition();
    });
    audio.addEventListener('waiting', () => {
      if (!this.isCurrent() || !this.wantPlay) return;
      dlog('waiting', { seg: this.state.segment, at: Math.round(audio.currentTime * 1000) });
      this.set({ status: 'buffering' });
    });
    audio.addEventListener('pause', () => {
      // Source swaps and the end of a sentence also pause; only an external
      // pause (OS, headphones, another tab) changes the user's intent.
      if (!this.isCurrent() || audio.ended || !this.wantPlay) return;
      this.wantPlay = false;
      this.stopFrames();
      this.set({ status: 'paused' });
      this.flushProgress();
      this.releaseClaim();
      this.updatePosition();
    });
    audio.addEventListener('ended', () => {
      if (this.isCurrent()) this.onEnded();
    });
    audio.addEventListener('timeupdate', () => {
      if (this.isCurrent()) this.tickClock();
    });
    audio.addEventListener('ratechange', () => this.updatePosition());
    audio.addEventListener('error', () => {
      if (!this.isCurrent() || !audio.error) return;
      dlog('media_error', { seg: this.state.segment, code: audio.error.code });
      this.fail(tr('reader.error_playback'));
    });
    this.audio = audio;
    this.installMediaSession();
    window.addEventListener('pagehide', () => this.flushProgress(true));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.flushProgress(true);
      else if (this.wantPlay) this.startFrames();
    });
    return audio;
  }

  private isCurrent(): boolean {
    return Boolean(this.audio && this.current && this.audio.src === this.current.url);
  }

  /** Must run synchronously inside a user gesture: lets iOS play later without one. */
  private unlock() {
    const audio = this.element();
    if (this.isCurrent() || !audio.paused) return;
    this.silent ??= silentWav();
    audio.src = this.silent;
    this.current = null;
    void audio.play().catch(() => {});
  }

  private claim() {
    if (this.release) return;
    this.release = claimPlayback(() => {
      this.release = null;
      this.pause();
    }, PLAYBACK_SOURCE);
  }

  private releaseClaim() {
    const release = this.release;
    this.release = null;
    release?.();
  }

  /** Call synchronously from a tap that will start playback after an await. */
  unlockFromGesture() {
    if (!this.wantPlay) this.unlock();
  }

  // ── document lifecycle ───────────────────────────────────────────────────
  /** Make `doc` the player's document without starting playback. */
  load(doc: ReaderDocument) {
    if (this.state.doc?.id === doc.id) {
      if (this.state.doc !== doc) {
        this.set({ doc: { ...doc, voice_id: this.state.voice, engine: this.state.engine } });
        this.updateMetadata();
      }
      return;
    }
    this.flushProgress();
    this.stopAudio();
    this.resetCache();
    this.durations.clear();
    this.prefix = null;
    revokeObjectUrl(this.state.coverUrl);
    const segment = Math.min(
      Math.max(0, doc.position_segment),
      Math.max(0, doc.segments.length - 1),
    );
    this.savedSegment = segment;
    this.word = -1;
    this.set({
      doc,
      segment,
      status: 'paused',
      error: null,
      voice: doc.voice_id,
      engine: doc.engine,
      sleep: { mode: 'off' },
      coverUrl: null,
      offline: false,
    });
    this.emitHighlight(-1, true);
    this.publishClock(0, 0);
    this.updateMetadata();
    if (doc.has_cover) {
      const id = doc.id;
      readerApi
        .cover(id)
        .then((blob) => {
          if (this.state.doc?.id !== id) return;
          this.set({ coverUrl: createObjectUrl(blob) });
          this.updateMetadata();
        })
        .catch(() => {});
    }
  }

  /** Forget the document (it was deleted). */
  unload() {
    this.flushProgress();
    this.stopAudio();
    this.resetCache();
    this.durations.clear();
    this.prefix = null;
    revokeObjectUrl(this.state.coverUrl);
    this.set({
      doc: null,
      segment: 0,
      status: 'idle',
      error: null,
      coverUrl: null,
      offline: false,
    });
    if (typeof navigator !== 'undefined' && navigator.mediaSession)
      navigator.mediaSession.metadata = null;
  }

  private resetCache() {
    this.epoch++;
    this.prefetchToken++;
    for (const entry of this.cache.values())
      if (entry.ready?.owned) revokeObjectUrl(entry.ready.url);
    this.cache.clear();
    this.current = null;
  }

  private stopAudio() {
    this.playToken++;
    this.wantPlay = false;
    this.stopFrames();
    this.stopSleepTimer();
    const audio = this.audio;
    if (audio) {
      this.current = null;
      audio.pause();
      audio.volume = 1;
    }
    this.releaseClaim();
  }

  // ── segment loading ──────────────────────────────────────────────────────
  private choice(): ReaderVoiceChoice {
    return {
      voice: this.state.voice,
      engine: this.state.engine,
      language: this.state.doc?.language ?? null,
    };
  }

  private async offlineCopy(docId: string, index: number, anyVoice: boolean) {
    if (!offlineSnapshot().ready) await refreshOffline();
    const meta = offlineSnapshot().downloaded[docId];
    if (!meta) return null;
    if (!anyVoice && (meta.voice !== this.state.voice || meta.engine !== this.state.engine))
      return null;
    return readOfflineSegment(offlineBackend(), docId, index).catch(() => null);
  }

  private ensure(index: number): Promise<ReadySegment> {
    const existing = this.cache.get(index);
    if (existing) return existing.promise;
    const doc = this.state.doc;
    if (!doc) return Promise.reject(new Error('No document'));
    const epoch = this.epoch;
    const choice = this.choice();
    const fromBlob = (render: ReaderRender, blob: Blob, offline: boolean): ReadySegment => {
      const url = createObjectUrl(blob);
      return {
        segment: index,
        render,
        // Absolute, because isCurrent() compares it with the element's resolved src.
        url: url ?? new URL(apiPath(render.audio_url), window.location.href).href,
        owned: Boolean(url),
        offline,
      };
    };
    const promise = (async () => {
      const t0 = performance.now();
      const local = await this.offlineCopy(doc.id, index, false);
      if (local) {
        dlog('seg_load', {
          seg: index,
          offline: true,
          total_ms: Math.round(performance.now() - t0),
        });
        return fromBlob(local.render, local.blob, true);
      }
      try {
        const render = await readerApi.render(doc.id, index, choice);
        const t1 = performance.now();
        this.adoptAutoVoice(doc.id, render.voice);
        const blob = await readerApi.audio(render.audio_url);
        const t2 = performance.now();
        dlog('seg_load', {
          seg: index,
          cached: render.cached,
          render_ms: Math.round(t1 - t0),
          audio_ms: Math.round(t2 - t1),
          total_ms: Math.round(t2 - t0),
          kb: Math.round(blob.size / 1024),
          dur_s: render.duration_s,
          current: this.state.segment,
        });
        return fromBlob(render, blob, false);
      } catch (error) {
        // Unreachable PC: any downloaded voice beats silence.
        const fallback =
          error instanceof ApiError && error.status === 0
            ? await this.offlineCopy(doc.id, index, true)
            : null;
        if (fallback) return fromBlob(fallback.render, fallback.blob, true);
        throw error;
      }
    })();
    const entry: CacheEntry = { promise };
    this.cache.set(index, entry);
    promise.then(
      (ready) => {
        if (epoch !== this.epoch) {
          if (ready.owned) revokeObjectUrl(ready.url);
          return;
        }
        entry.ready = ready;
        if (this.durations.get(index) !== ready.render.duration_s) {
          this.durations.set(index, ready.render.duration_s);
          this.prefix = null;
        }
      },
      () => {
        if (this.cache.get(index) === entry) this.cache.delete(index);
      },
    );
    return promise;
  }

  private async prefetch(from: number) {
    const token = ++this.prefetchToken;
    const count = this.state.doc?.segments.length ?? 0;
    for (const [index, entry] of this.cache) {
      if (index >= from - KEEP_BEHIND && index <= from + KEEP_AHEAD) continue;
      if (entry.ready === this.current) continue;
      if (entry.ready?.owned) revokeObjectUrl(entry.ready.url);
      this.cache.delete(index);
    }
    for (let index = from + 1; index <= Math.min(count - 1, from + PREFETCH_AHEAD); index++) {
      if (token !== this.prefetchToken) return;
      try {
        await this.ensure(index);
      } catch {
        return; // Retried when playback reaches it.
      }
    }
  }

  // ── transport ────────────────────────────────────────────────────────────
  /** Start or move playback. Call from the user's tap so iOS allows audio. */
  private startAt(segment: number, offset: number, autoplay: boolean) {
    const doc = this.state.doc;
    if (!doc || !doc.segments.length) return;
    const index = Math.min(Math.max(0, segment), doc.segments.length - 1);
    const token = ++this.playToken;
    this.wantPlay = autoplay;
    if (autoplay) this.claim();
    this.stopFrames();
    if (this.state.segment !== index) this.set({ segment: index });
    this.emitHighlight(-1, true);
    this.scheduleProgress();
    const ready = this.cache.get(index)?.ready;
    dlog('start', {
      seg: index,
      offset: Math.round(offset * 1000),
      autoplay,
      ready: Boolean(ready),
    });
    if (ready) {
      this.attach(ready, offset, autoplay);
      return;
    }
    if (this.audio) {
      this.current = null;
      this.audio.pause();
    }
    if (autoplay) this.unlock();
    this.set({ status: autoplay ? 'buffering' : 'paused', error: null });
    this.publishClock(0, 0);
    this.ensure(index).then(
      (loaded) => {
        if (token === this.playToken) this.attach(loaded, offset, this.wantPlay);
      },
      (error) => {
        if (token !== this.playToken || isAbortError(error)) return;
        // A background warm-up stays quiet; pressing play retries and reports.
        if (this.wantPlay) this.fail(describeError(error));
      },
    );
  }

  private attach(ready: ReadySegment, offset: number, autoplay: boolean) {
    const audio = this.element();
    const { rate } = this.state;
    this.current = ready;
    audio.src = ready.url;
    audio.defaultPlaybackRate = rate;
    audio.playbackRate = rate;
    audio.preservesPitch = true;
    (audio as HTMLAudioElement & { webkitPreservesPitch?: boolean }).webkitPreservesPitch = true;
    if (offset > 0) {
      const seek = () => {
        if (this.current === ready) audio.currentTime = Math.min(offset, ready.render.duration_s);
      };
      if (audio.readyState >= 1) seek();
      else audio.addEventListener('loadedmetadata', seek, { once: true });
    }
    this.set({ offline: ready.offline, error: null });
    this.emitHighlight(wordIndexAt(ready.render.words, offset), true);
    this.publishClock(offset, ready.render.duration_s);
    if (autoplay) {
      this.set({ status: 'buffering' });
      audio.play().catch((error: unknown) => {
        if (this.current !== ready) return;
        this.wantPlay = false;
        this.releaseClaim();
        const blocked = (error as { name?: string })?.name === 'NotAllowedError';
        if (blocked || isAbortError(error)) this.set({ status: 'paused' });
        else this.fail(tr('reader.error_playback'));
      });
    } else {
      this.set({ status: 'paused' });
    }
    this.updateMetadata();
    void this.prefetch(ready.segment);
  }

  private fail(message: string) {
    dlog('fail', { seg: this.state.segment, message: message.slice(0, 300) });
    this.wantPlay = false;
    this.stopFrames();
    this.releaseClaim();
    this.set({ status: 'error', error: message });
  }

  private onEnded() {
    const doc = this.state.doc;
    if (!doc) return;
    const next = this.state.segment + 1;
    const { sleep } = this.state;
    if (sleep.mode === 'chapter' && next >= sleep.endSegment) {
      this.sleepNow(next < doc.segments.length ? next : this.state.segment);
      return;
    }
    if (next >= doc.segments.length) {
      this.wantPlay = false;
      this.stopFrames();
      this.releaseClaim();
      this.set({ status: 'ended' });
      this.flushProgress();
      return;
    }
    // Stays synchronous when the next sentence is prefetched, which keeps
    // playback going on a locked iPhone.
    this.startAt(next, 0, true);
  }

  play() {
    const { doc, status, segment } = this.state;
    if (!doc) return;
    dlog('user_play', { seg: segment, status });
    if (status === 'ended') {
      this.startAt(0, 0, true);
      return;
    }
    if (this.isCurrent() && this.audio) {
      this.wantPlay = true;
      this.claim();
      this.set({ status: 'buffering', error: null });
      this.audio.play().catch((error: unknown) => {
        if (isAbortError(error)) return;
        this.wantPlay = false;
        this.releaseClaim();
        this.set({ status: 'paused' });
      });
      return;
    }
    this.startAt(segment, 0, true);
  }

  pause() {
    this.wantPlay = false;
    this.stopFrames();
    this.audio?.pause();
    if (this.state.status !== 'idle' && this.state.status !== 'ended')
      this.set({ status: this.state.status === 'error' ? 'error' : 'paused' });
    this.flushProgress();
    this.releaseClaim();
    this.updatePosition();
  }

  /** Load the current sentence's audio ahead of the first tap on play. */
  prepare() {
    if (this.state.doc && !this.wantPlay && !this.isCurrent() && this.state.status !== 'error')
      this.startAt(this.state.segment, 0, false);
  }

  toggle() {
    if (this.wantPlay) this.pause();
    else this.play();
  }

  get playing(): boolean {
    return this.wantPlay;
  }

  /** Jump to a sentence; keeps playing when already playing unless told otherwise. */
  seekSegment(segment: number, autoplay = this.wantPlay) {
    this.startAt(segment, 0, autoplay);
  }

  /** Play from a word: seeks inside the loaded sentence, or starts it there. */
  seekWord(segment: number, word: number) {
    const words = this.wordsFor(segment);
    const offset = words?.[word]?.start ?? 0;
    if (segment === this.state.segment && this.isCurrent() && this.audio) {
      this.audio.currentTime = Math.max(0, offset - 0.02);
      this.emitHighlight(word, true);
      if (!this.wantPlay) this.play();
      return;
    }
    this.startAt(segment, offset, true);
  }

  next() {
    const doc = this.state.doc;
    if (doc && this.state.segment < doc.segments.length - 1)
      this.seekSegment(this.state.segment + 1);
  }

  previous() {
    if (this.audio && this.isCurrent() && this.audio.currentTime > 2) {
      this.audio.currentTime = 0;
      this.emitHighlight(-1);
      return;
    }
    if (this.state.segment > 0) this.seekSegment(this.state.segment - 1);
  }

  /** ±seconds inside the sentence; crosses into the neighbour at the edges. */
  skip(delta: number) {
    const audio = this.audio;
    if (!audio || !this.isCurrent() || !this.current) {
      if (delta < 0) this.previous();
      else this.next();
      return;
    }
    const target = audio.currentTime + delta;
    if (target < 0) {
      if (audio.currentTime > 1.5 || this.state.segment === 0) audio.currentTime = 0;
      else this.seekSegment(this.state.segment - 1);
      return;
    }
    if (target >= this.current.render.duration_s - 0.05) {
      this.next();
      return;
    }
    audio.currentTime = target;
    this.tickClock(true);
  }

  retry() {
    const { segment } = this.state;
    this.cache.delete(segment);
    this.startAt(segment, 0, true);
  }

  setRate(value: number) {
    const rate = clampSpeed(value);
    setReaderPrefs({ rate });
    this.set({ rate });
    if (this.audio) {
      this.audio.defaultPlaybackRate = rate;
      this.audio.playbackRate = rate;
    }
    this.publishClock(this.clock.time, this.clock.duration);
  }

  /** Switch voice; re-renders from the current sentence. */
  /** The backend pins a language-matched voice on a document's first render;
   * show it instead of "Default voice". Render keys don't change: an omitted
   * voice already resolves to the pinned one server-side. */
  private adoptAutoVoice(docId: string, voice: string | null | undefined) {
    const doc = this.state.doc;
    if (!voice || this.state.voice || !doc || doc.id !== docId) return;
    this.set({ voice, doc: { ...doc, voice_id: voice } });
  }

  setVoice(voice: string | null, engine: string | null) {
    const doc = this.state.doc;
    if (!doc || (voice === this.state.voice && engine === this.state.engine)) return;
    const resume = this.wantPlay;
    this.stopAudio();
    this.resetCache();
    this.durations.clear();
    this.prefix = null;
    this.set({ voice, engine, status: 'paused', doc: { ...doc, voice_id: voice, engine } });
    void readerApi
      .update(doc.id, { voice_id: voice, engine })
      .then((summary) => this.patchSummaries(summary))
      .catch(() => {});
    if (resume) this.startAt(this.state.segment, 0, true);
  }

  // ── sleep timer ──────────────────────────────────────────────────────────
  setSleep(option: { mode: 'off' } | { mode: 'time'; minutes: number } | { mode: 'chapter' }) {
    const doc = this.state.doc;
    if (this.audio) this.audio.volume = 1;
    this.stopSleepTimer();
    if (!doc || option.mode === 'off') {
      this.set({ sleep: { mode: 'off' } });
      this.publishClock(this.clock.time, this.clock.duration);
      return;
    }
    const sleep: ReaderSleep =
      option.mode === 'time'
        ? { mode: 'time', minutes: option.minutes, endsAt: Date.now() + option.minutes * 60_000 }
        : {
            mode: 'chapter',
            endSegment: chapterEndSegment(doc.chapters, this.state.segment, doc.segments.length),
          };
    this.set({ sleep });
    this.sleepTimer = setInterval(() => this.sleepTick(), 250);
  }

  private stopSleepTimer() {
    if (this.sleepTimer !== null) clearInterval(this.sleepTimer);
    this.sleepTimer = null;
  }

  private sleepTick() {
    const { sleep } = this.state;
    const audio = this.audio;
    if (sleep.mode === 'time') {
      const left = sleep.endsAt - Date.now();
      if (left <= 0) {
        this.sleepNow();
        return;
      }
      if (audio && this.wantPlay) audio.volume = Math.min(1, Math.max(0, left / FADE_MS));
      this.publishClock(this.clock.time, this.clock.duration);
    } else if (sleep.mode === 'chapter' && audio && this.current) {
      const last = this.state.segment === sleep.endSegment - 1;
      const left = (this.current.render.duration_s - audio.currentTime) * 1000;
      audio.volume = last ? Math.min(1, Math.max(0, left / FADE_MS)) : 1;
    }
  }

  private sleepNow(resumeAt?: number) {
    this.stopSleepTimer();
    this.pause();
    if (this.audio) this.audio.volume = 1;
    this.set({ sleep: { mode: 'off' } });
    if (resumeAt !== undefined && resumeAt !== this.state.segment) this.startAt(resumeAt, 0, false);
    this.publishClock(this.clock.time, this.clock.duration);
  }

  // ── frames, clock and position ───────────────────────────────────────────
  private startFrames() {
    if (this.raf !== null || typeof requestAnimationFrame !== 'function') return;
    const frame = () => {
      this.raf = null;
      const audio = this.audio;
      if (!audio || !this.wantPlay || !this.current) return;
      this.emitHighlight(wordIndexAt(this.current.render.words, audio.currentTime));
      if (document.visibilityState !== 'hidden') this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  private stopFrames() {
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.raf = null;
  }

  private segmentSeconds(index: number): number {
    const doc = this.state.doc;
    if (!doc) return 0;
    return this.durations.get(index) ?? estimateSegmentSeconds(doc.segments[index]?.text ?? '');
  }

  /** Cumulative 1x seconds before each segment; rebuilt when a real duration arrives. */
  private offsets(): Float64Array {
    const count = this.state.doc?.segments.length ?? 0;
    if (this.prefix && this.prefix.length === count + 1) return this.prefix;
    const prefix = new Float64Array(count + 1);
    for (let index = 0; index < count; index++)
      prefix[index + 1] = prefix[index] + this.segmentSeconds(index);
    this.prefix = prefix;
    return prefix;
  }

  /** Document seconds (1x) at the start of `segment`. */
  secondsAt(segment: number): number {
    const prefix = this.offsets();
    return prefix[Math.min(Math.max(0, segment), prefix.length - 1)] ?? 0;
  }

  private publishClock(time: number, duration: number) {
    const prefix = this.offsets();
    const { sleep } = this.state;
    this.clock = {
      time,
      duration,
      elapsed: (prefix[this.state.segment] ?? 0) + time,
      total: prefix[prefix.length - 1] ?? 0,
      sleepLeft: sleep.mode === 'time' ? Math.max(0, sleep.endsAt - Date.now()) : null,
    };
    this.clockListeners.forEach((listener) => listener());
  }

  private tickClock(force = false) {
    const audio = this.audio;
    if (!audio || !this.current) return;
    const now = performance.now();
    if (!force && now - this.lastClockAt < 200) return;
    this.lastClockAt = now;
    this.publishClock(audio.currentTime, this.current.render.duration_s);
  }

  // ── progress ─────────────────────────────────────────────────────────────
  private scheduleProgress() {
    if (this.progressTimer !== null) clearTimeout(this.progressTimer);
    this.progressTimer = setTimeout(() => this.flushProgress(), PROGRESS_DEBOUNCE_MS);
  }

  private flushProgress(keepalive = false) {
    if (this.progressTimer !== null) clearTimeout(this.progressTimer);
    this.progressTimer = null;
    const doc = this.state.doc;
    if (!doc || this.savedSegment === this.state.segment) return;
    const segment = this.state.segment;
    this.savedSegment = segment;
    void readerApi.saveProgress(doc.id, segment, keepalive).catch(() => {
      if (this.savedSegment === segment) this.savedSegment = null;
    });
    const count = Math.max(1, doc.segments.length);
    const patch = (summary: ReaderDocumentSummary): ReaderDocumentSummary =>
      summary.id === doc.id
        ? {
            ...summary,
            position_segment: segment,
            progress: segment / count,
            last_opened_at: Date.now() / 1000,
          }
        : summary;
    queryClient.setQueryData<ReaderDocumentSummary[]>(readerKeys.documents, (list) =>
      list?.map(patch),
    );
  }

  private patchSummaries(summary: ReaderDocumentSummary) {
    queryClient.setQueryData<ReaderDocumentSummary[]>(readerKeys.documents, (list) =>
      list?.map((item) => (item.id === summary.id ? { ...item, ...summary } : item)),
    );
  }

  // ── media session ────────────────────────────────────────────────────────
  private installMediaSession() {
    const session = typeof navigator === 'undefined' ? undefined : navigator.mediaSession;
    if (!session) return;
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ['play', () => this.play()],
      ['pause', () => this.pause()],
      ['previoustrack', () => this.previous()],
      ['nexttrack', () => this.next()],
      ['seekbackward', (details) => this.skip(-(details.seekOffset ?? 15))],
      ['seekforward', (details) => this.skip(details.seekOffset ?? 15)],
      ['seekto', (details) => this.seekDocument(details.seekTime ?? 0)],
    ];
    for (const [action, handler] of handlers) {
      try {
        session.setActionHandler(action, handler);
      } catch {
        // Action unsupported by this browser.
      }
    }
  }

  /** Seek by document time (1x seconds), e.g. from the lock-screen scrubber. */
  seekDocument(seconds: number) {
    const prefix = this.offsets();
    let low = 0;
    let high = prefix.length - 2;
    let segment = 0;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (prefix[mid] <= seconds) {
        segment = mid;
        low = mid + 1;
      } else high = mid - 1;
    }
    const offset = Math.max(0, seconds - prefix[segment]);
    if (segment === this.state.segment && this.isCurrent() && this.audio) {
      this.audio.currentTime = offset;
      this.tickClock(true);
      this.updatePosition();
      return;
    }
    this.startAt(segment, offset, this.wantPlay);
  }

  private updateMetadata() {
    const session = typeof navigator === 'undefined' ? undefined : navigator.mediaSession;
    const doc = this.state.doc;
    if (!session || !doc || typeof MediaMetadata === 'undefined') return;
    const chapter = doc.chapters[chapterIndexAt(doc.chapters, this.state.segment)]?.title;
    const artwork = this.state.coverUrl
      ? [{ src: this.state.coverUrl }]
      : [
          {
            src: new URL('reader-icon-512.png', window.location.href).toString(),
            sizes: '512x512',
            type: 'image/png',
          },
        ];
    const title = doc.title;
    const artist = doc.author || doc.source_name || tr('reader.title');
    const album = chapter ?? '';
    const current = session.metadata;
    if (
      current &&
      current.title === title &&
      current.artist === artist &&
      current.album === album &&
      current.artwork[0]?.src === artwork[0].src
    )
      return;
    try {
      session.metadata = new MediaMetadata({ title, artist, album, artwork });
    } catch {
      // Invalid artwork URLs must not break playback.
    }
  }

  private updatePosition() {
    const session = typeof navigator === 'undefined' ? undefined : navigator.mediaSession;
    if (!session) return;
    session.playbackState = this.wantPlay ? 'playing' : 'paused';
    if (typeof session.setPositionState !== 'function' || !this.audio) return;
    const total = this.secondsAt(Number.MAX_SAFE_INTEGER);
    const position = Math.min(total, this.secondsAt(this.state.segment) + this.audio.currentTime);
    try {
      session.setPositionState({
        duration: Math.max(total, 0.1),
        position: Math.max(0, position),
        playbackRate: this.state.rate,
      });
    } catch {
      // Inconsistent estimates are ignored rather than surfaced.
    }
  }
}

export const readerPlayer = new ReaderPlayer();

export function useReaderPlayer(): ReaderPlayerState {
  return useSyncExternalStore(readerPlayer.subscribe, readerPlayer.getState, readerPlayer.getState);
}

export function useReaderClock(): ReaderClock {
  return useSyncExternalStore(
    readerPlayer.subscribeClock,
    readerPlayer.getClock,
    readerPlayer.getClock,
  );
}

// Reader diagnostics start with the player: only Reader pages pay for them.
if (typeof window !== 'undefined') installDebug();
