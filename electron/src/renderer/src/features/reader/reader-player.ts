/**
 * The Reader's playback engine: one module-level HTMLAudioElement that plays a
 * document sentence by sentence. React reads three channels with different
 * rates so the long reading view never re-renders while audio plays:
 *
 * - `useReaderPlayer()` — document, segment, status, speed, voice, sleep timer.
 * - `useReaderClock()` — position inside the segment/document (≈4 Hz).
 * - `subscribeHighlight()` — imperative (segment, word) callbacks per frame.
 *
 * Two transports feed the element:
 * - MSE (reader-mse.ts, the default where supported): every sentence is
 *   appended to one MediaSource, so playback is gapless and never needs a
 *   `play()` between sentences — it keeps going on a locked phone.
 * - Per-sentence blobs (Safari/iOS, WAV audio, MSE failures): `src` swaps to
 *   the next prefetched sentence on `ended`.
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
import {
  MSE_RETRY_MS,
  MseEngine,
  mseSupported,
  UnsupportedAudioError,
  type MseLoaded,
  type MseSegmentData,
  type TimelineEntry,
} from './reader-mse';
import { UNDO_WINDOW_MS, UndoStack, type UndoEntry } from './reader-undo';

export type ReaderStatus = 'idle' | 'paused' | 'buffering' | 'playing' | 'ended' | 'error';

export type ReaderSleep =
  | { mode: 'off' }
  | { mode: 'time'; endsAt: number; minutes: number }
  | { mode: 'chapter'; endSegment: number };

/** Why playback is waiting and retrying on its own (not an error). */
export type ReaderBlocked = 'unreachable' | 'engine' | null;

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
  /** Set while playback waits for the PC or its voice engine and retries every few seconds. */
  blocked: ReaderBlocked;
  /** Where "Volver a…" returns to after the latest jump; null when there is none. */
  undo: UndoEntry | null;
  /** Furthest segment reached in this document. */
  furthest: number;
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

/** The sentence at the playhead. */
interface PlayingSegment {
  segment: number;
  render: ReaderRender;
  offline: boolean;
  /** Blob transport only: the element's `src` for this sentence. */
  url?: string;
}

interface ReadySegment extends PlayingSegment {
  blob: Blob;
  /** Blob transport: object URL (created lazily) or the network URL. */
  url?: string;
  owned: boolean;
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

/** Failures that clear up on their own: the PC is unreachable or its engine is busy loading. */
export function retryableFailure(error: unknown): ReaderBlocked {
  if (!(error instanceof ApiError)) return null;
  if (error.status === 0) return 'unreachable';
  if (error.status === 503) return 'engine';
  return null;
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
    blocked: null,
    undo: null,
    furthest: 0,
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
  private current: PlayingSegment | null = null;
  private word = -1;
  private wantPlay = false;
  private raf: number | null = null;
  private release: (() => void) | null = null;
  private progressTimer: ReturnType<typeof setTimeout> | null = null;
  private savedSegment: number | null = null;
  private sleepTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnect: (() => void) | null = null;
  private lastClockAt = 0;
  private undoStack = new UndoStack();
  /** An undoable jump is not saved as progress (nor furthest point) until this time. */
  private progressHoldUntil = 0;
  /** MSE transport; null on the blob fallback. Decided when the element is created. */
  private mse: MseEngine | null = null;
  private mseFailed = false;
  /** Segment the MSE playhead starved before (its `start` was logged as a miss). */
  private starvedAt: number | null = null;
  /** Last failed MSE load ahead of the playhead, surfaced once playback reaches it. */
  private aheadFailure: { index: number; error: unknown } | null = null;

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
    return (
      this.cache.get(segment)?.ready?.render.words ??
      this.mse?.timeline?.get(segment)?.data.render.words ??
      null
    );
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
  debugSnapshot(): {
    segment: number;
    total: number;
    readyAhead: number;
    status: string;
    engine: 'mse' | 'blob';
  } {
    const total = this.state.doc?.segments.length ?? 0;
    let readyAhead = 0;
    if (this.mse) readyAhead = this.mse.readyAhead();
    else
      for (let i = this.state.segment + 1; i < total && this.cache.get(i)?.ready; i++) readyAhead++;
    return {
      segment: this.state.segment,
      total,
      readyAhead,
      status: this.state.status,
      engine: this.mse ? 'mse' : 'blob',
    };
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
    audio.preservesPitch = true;
    (audio as HTMLAudioElement & { webkitPreservesPitch?: boolean }).webkitPreservesPitch = true;
    audio.addEventListener('playing', () => {
      if (!this.isCurrent()) return;
      this.set({ status: 'playing', error: null, blocked: null });
      this.startFrames();
      this.updatePosition();
    });
    audio.addEventListener('waiting', () => {
      if (!this.isCurrent() || !this.wantPlay) return;
      // Every seek waits a moment for data; that is not a stall.
      if (audio.seeking) {
        this.set({ status: 'buffering' });
        return;
      }
      if (this.mse) this.onMseWaiting();
      else dlog('waiting', { seg: this.state.segment, at: Math.round(audio.currentTime * 1000) });
      this.set({ status: 'buffering' });
    });
    audio.addEventListener('pause', () => {
      // Source swaps and the end of a sentence also pause; only an external
      // pause (OS, headphones, another tab) changes the user's intent.
      if (!this.isCurrent() || audio.ended || !this.wantPlay) return;
      this.wantPlay = false;
      this.clearReconnect();
      this.stopFrames();
      this.set({ status: 'paused', blocked: null });
      this.flushProgress();
      this.releaseClaim();
      this.updatePosition();
    });
    audio.addEventListener('ended', () => {
      if (this.isCurrent()) this.onEnded();
    });
    audio.addEventListener('timeupdate', () => {
      if (!this.isCurrent()) return;
      // Media events keep firing on a locked phone; timers and frames may not.
      if (this.mse) this.onMseTime();
      this.tickClock();
      if (this.state.sleep.mode !== 'off') this.sleepTick();
    });
    audio.addEventListener('ratechange', () => this.updatePosition());
    audio.addEventListener('error', () => {
      if (!this.isCurrent() || !audio.error) return;
      dlog('media_error', {
        seg: this.state.segment,
        code: audio.error.code,
        engine: this.mse ? 'mse' : 'blob',
      });
      if (this.mse) this.fallbackToBlob(`media_error_${audio.error.code}`);
      else this.fail(tr('reader.error_playback'));
    });
    this.audio = audio;
    if (!this.mseFailed && mseSupported()) this.mse = new MseEngine(audio, this.mseHost());
    dlog('engine', { engine: this.mse ? 'mse' : 'blob' });
    this.installMediaSession();
    window.addEventListener('pagehide', () => this.flushProgress(true));
    window.addEventListener('online', () => this.retryNow());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.flushProgress(true);
      else {
        if (this.wantPlay) this.startFrames();
        this.mse?.kick();
      }
    });
    return audio;
  }

  private isCurrent(): boolean {
    if (!this.audio) return false;
    // A MediaSource whose first sentence never arrived (a failed warm-up) is not playable.
    if (this.mse) return this.mse.attached() && !this.mse.switching && this.current !== null;
    return Boolean(this.current?.url && this.audio.src === this.current.url);
  }

  /** Must run synchronously inside a user gesture: lets iOS play later without one. */
  private unlock() {
    const audio = this.element();
    // MSE browsers honour the page's sticky activation; a silent src would detach the MediaSource.
    if (this.mse || this.isCurrent() || !audio.paused) return;
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
        this.set({
          doc: { ...doc, voice_id: this.state.voice, engine: this.state.engine },
          furthest: Math.max(this.state.furthest, doc.furthest_segment ?? 0),
        });
        this.updateMetadata();
      }
      return;
    }
    this.flushProgress();
    this.stopAudio();
    this.resetCache();
    this.durations.clear();
    this.prefix = null;
    this.undoStack.clear();
    revokeObjectUrl(this.state.coverUrl);
    const last = Math.max(0, doc.segments.length - 1);
    const segment = Math.min(Math.max(0, doc.position_segment), last);
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
      blocked: null,
      undo: null,
      furthest: Math.min(last, Math.max(segment, doc.furthest_segment ?? 0)),
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
    this.undoStack.clear();
    revokeObjectUrl(this.state.coverUrl);
    this.set({
      doc: null,
      segment: 0,
      status: 'idle',
      error: null,
      coverUrl: null,
      offline: false,
      blocked: null,
      undo: null,
      furthest: 0,
    });
    if (typeof navigator !== 'undefined' && navigator.mediaSession)
      navigator.mediaSession.metadata = null;
  }

  private resetCache() {
    this.epoch++;
    this.prefetchToken++;
    for (const entry of this.cache.values()) this.dropReady(entry.ready);
    this.cache.clear();
    this.current = null;
    this.aheadFailure = null;
    this.mse?.reset();
  }

  private dropReady(ready: ReadySegment | undefined) {
    if (ready?.owned) revokeObjectUrl(ready.url);
  }

  private stopAudio() {
    this.playToken++;
    this.wantPlay = false;
    this.clearReconnect();
    this.stopFrames();
    this.stopSleepTimer();
    const audio = this.audio;
    if (audio) {
      this.current = null;
      audio.pause();
      audio.volume = 1;
    }
    this.mse?.reset();
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
    const ready = (render: ReaderRender, blob: Blob, offline: boolean): ReadySegment => ({
      segment: index,
      render,
      blob,
      offline,
      owned: false,
    });
    const promise = (async () => {
      const t0 = performance.now();
      const local = await this.offlineCopy(doc.id, index, false);
      if (local) {
        dlog('seg_load', {
          seg: index,
          offline: true,
          total_ms: Math.round(performance.now() - t0),
        });
        return ready(local.render, local.blob, true);
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
        return ready(render, blob, false);
      } catch (error) {
        // Unreachable PC: any downloaded voice beats silence.
        const fallback =
          error instanceof ApiError && error.status === 0
            ? await this.offlineCopy(doc.id, index, true)
            : null;
        if (fallback) return ready(fallback.render, fallback.blob, true);
        throw error;
      }
    })();
    const entry: CacheEntry = { promise };
    this.cache.set(index, entry);
    promise.then(
      (loaded) => {
        if (epoch !== this.epoch) return;
        entry.ready = loaded;
        if (this.durations.get(index) !== loaded.render.duration_s) {
          this.durations.set(index, loaded.render.duration_s);
          this.prefix = null;
        }
      },
      () => {
        if (this.cache.get(index) === entry) this.cache.delete(index);
      },
    );
    return promise;
  }

  /** The blob transport's `src` for a loaded sentence (object URL, else the network URL). */
  private urlOf(ready: ReadySegment): string {
    if (!ready.url) {
      const url = createObjectUrl(ready.blob);
      ready.owned = Boolean(url);
      // Absolute, because isCurrent() compares it with the element's resolved src.
      ready.url = url ?? new URL(apiPath(ready.render.audio_url), window.location.href).href;
    }
    return ready.url;
  }

  /** Drop cached sentences far from `from` (the current one is always kept). */
  private pruneCache(from: number) {
    for (const [index, entry] of this.cache) {
      if (index >= from - KEEP_BEHIND && index <= from + KEEP_AHEAD) continue;
      if (entry.ready && entry.ready === this.current) continue;
      this.dropReady(entry.ready);
      this.cache.delete(index);
    }
  }

  private async prefetch(from: number) {
    const token = ++this.prefetchToken;
    const count = this.state.doc?.segments.length ?? 0;
    this.pruneCache(from);
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
    this.clearReconnect();
    this.starvedAt = null;
    if (this.state.segment !== index) this.set({ segment: index });
    this.emitHighlight(-1, true);
    this.scheduleProgress();
    this.element();
    if (this.mse) {
      this.startMse(this.mse, index, offset, autoplay, token);
      return;
    }
    this.stopFrames();
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
        this.loadFailed(error, () => this.startAt(index, offset, true));
      },
    );
  }

  private attach(ready: ReadySegment, offset: number, autoplay: boolean) {
    const audio = this.element();
    const { rate } = this.state;
    this.current = ready;
    audio.src = this.urlOf(ready);
    audio.defaultPlaybackRate = rate;
    audio.playbackRate = rate;
    if (offset > 0) {
      const seek = () => {
        if (this.current === ready) audio.currentTime = Math.min(offset, ready.render.duration_s);
      };
      if (audio.readyState >= 1) seek();
      else audio.addEventListener('loadedmetadata', seek, { once: true });
    }
    this.set({ offline: ready.offline, error: null, blocked: null });
    this.emitHighlight(wordIndexAt(ready.render.words, offset), true);
    this.publishClock(offset, ready.render.duration_s);
    if (autoplay) this.playElement();
    else this.set({ status: 'paused' });
    this.updateMetadata();
    void this.prefetch(ready.segment);
  }

  /** `audio.play()` with the shared failure handling. */
  private playElement() {
    const audio = this.element();
    const token = this.playToken;
    this.set({ status: 'buffering' });
    audio.play().catch((error: unknown) => {
      if (token !== this.playToken || !this.wantPlay) return;
      this.wantPlay = false;
      this.releaseClaim();
      const blocked = (error as { name?: string })?.name === 'NotAllowedError';
      if (blocked || isAbortError(error)) this.set({ status: 'paused' });
      else this.fail(tr('reader.error_playback'));
    });
  }

  /** A sentence failed to load: wait and retry when it may clear up, else report. */
  private loadFailed(error: unknown, again: () => void) {
    // A background warm-up stays quiet; pressing play retries and reports.
    if (!this.wantPlay) return;
    const blocked = retryableFailure(error);
    if (!blocked) {
      this.fail(describeError(error));
      return;
    }
    dlog('blocked', { seg: this.state.segment, kind: blocked });
    this.stopFrames();
    this.set({ status: 'buffering', blocked, error: null });
    this.scheduleReconnect(again);
  }

  private scheduleReconnect(again: () => void) {
    this.clearReconnect();
    this.reconnect = again;
    this.reconnectTimer = setTimeout(() => this.retryNow(), MSE_RETRY_MS);
  }

  private clearReconnect() {
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.reconnect = null;
  }

  /** Retry a blocked load now (network back, page visible, user tap). */
  retryNow() {
    const again = this.reconnect;
    this.clearReconnect();
    if (again && this.wantPlay) again();
    else this.mse?.kick(true);
  }

  private fail(message: string) {
    dlog('fail', { seg: this.state.segment, message: message.slice(0, 300) });
    this.wantPlay = false;
    this.clearReconnect();
    this.stopFrames();
    this.releaseClaim();
    this.set({ status: 'error', error: message, blocked: null });
  }

  private onEnded() {
    const doc = this.state.doc;
    if (!doc) return;
    if (this.mse) this.syncMseSegment();
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

  // ── MSE transport ────────────────────────────────────────────────────────
  private mseHost() {
    return {
      count: () => this.state.doc?.segments.length ?? 0,
      limit: () => {
        const { sleep, doc } = this.state;
        return sleep.mode === 'chapter' ? sleep.endSegment : (doc?.segments.length ?? 0);
      },
      playing: () => this.wantPlay,
      load: (index: number): Promise<MseLoaded> => this.ensure(index),
      release: (index: number) => {
        const entry = this.cache.get(index);
        if (entry?.ready === this.current) return;
        this.dropReady(entry?.ready);
        this.cache.delete(index);
      },
      appended: (entry: TimelineEntry<MseSegmentData>) => this.onMseAppended(entry),
      loadFailed: (index: number, error: unknown) => this.onMseLoadFailed(index, error),
      unsupported: (reason: string) => this.fallbackToBlob(reason),
      log: dlog,
    };
  }

  private startMse(
    engine: MseEngine,
    index: number,
    offset: number,
    autoplay: boolean,
    token: number,
  ) {
    const audio = this.element();
    this.aheadFailure = null;
    const inside = engine.timeOf(index, offset);
    dlog('start', {
      seg: index,
      offset: Math.round(offset * 1000),
      autoplay,
      ready: inside !== null || Boolean(this.cache.get(index)?.ready),
      mse: inside === null ? 'rebuild' : 'seek',
    });
    if (inside !== null) {
      audio.currentTime = inside;
      this.enterMseSegment(index, offset);
      this.emitHighlight(this.wordAt(offset), true);
      this.set({ error: null, blocked: null });
      if (autoplay) {
        if (audio.paused) this.playElement();
      } else {
        if (!audio.paused) audio.pause();
        this.set({ status: 'paused' });
      }
      this.tickClock(true);
      this.updatePosition();
      engine.kick();
      return;
    }
    this.stopFrames();
    this.current = null;
    this.pruneCache(index);
    this.set({ status: autoplay ? 'buffering' : 'paused', error: null });
    this.publishClock(0, 0);
    engine.start(index, offset).then(
      (entry) => {
        if (token !== this.playToken) return;
        audio.defaultPlaybackRate = this.state.rate;
        audio.playbackRate = this.state.rate;
        this.enterMseSegment(entry.segment, offset);
        this.emitHighlight(this.wordAt(offset), true);
        this.tickClock(true);
        this.set({ error: null, blocked: null });
        if (this.wantPlay) this.playElement();
        else this.set({ status: 'paused' });
        this.updatePosition();
      },
      (error: unknown) => {
        if (token !== this.playToken || isAbortError(error)) return;
        if (error instanceof UnsupportedAudioError) {
          this.fallbackToBlob(error.message);
          return;
        }
        if (error instanceof ApiError || !this.wantPlay) {
          this.loadFailed(error, () => this.startAt(index, offset, true));
          return;
        }
        // The MediaSource itself failed (did not open, append rejected): use the blob player.
        dlog('mse_error', { seg: index, name: (error as { name?: string })?.name ?? 'Error' });
        this.fallbackToBlob('mse_error');
      },
    );
  }

  /** The playhead is in `segment`: update state, highlight, metadata. */
  private enterMseSegment(segment: number, offset = 0) {
    const entry = this.mse?.timeline?.get(segment);
    if (!entry) return;
    const changed = segment !== this.state.segment || this.current?.segment !== segment;
    this.current = { segment, render: entry.data.render, offline: entry.data.offline };
    if (segment !== this.state.segment) {
      this.set({ segment });
      this.scheduleProgress();
    }
    if (this.state.offline !== entry.data.offline) this.set({ offline: entry.data.offline });
    if (changed) {
      this.emitHighlight(wordIndexAt(entry.data.render.words, offset), true);
      this.updateMetadata();
    }
  }

  /** Follow the playhead across sentence boundaries (timeupdate and frames). */
  private syncMseSegment(): boolean {
    const location = this.mse?.locate();
    if (!location) return false;
    const { segment } = location.entry;
    if (segment === this.state.segment && this.current?.segment === segment) return false;
    const natural = segment === this.state.segment + 1;
    if (natural && this.starvedAt !== segment)
      dlog('start', { seg: segment, offset: 0, autoplay: true, ready: true, mse: 'append' });
    this.starvedAt = null;
    this.enterMseSegment(segment, location.offset);
    this.updatePosition();
    const { sleep } = this.state;
    if (sleep.mode === 'chapter' && segment >= sleep.endSegment) this.sleepNow(segment);
    return true;
  }

  private onMseTime() {
    this.syncMseSegment();
    const engine = this.mse;
    if (!engine) return;
    engine.kick();
    const { sleep, doc } = this.state;
    // End-of-chapter sleep: nothing beyond the chapter is appended, so the end of
    // the buffer is the end of the chapter.
    if (sleep.mode === 'chapter' && doc && sleep.endSegment < doc.segments.length) {
      const location = engine.locate();
      if (location?.atEnd && location.entry.segment >= sleep.endSegment - 1)
        this.sleepNow(sleep.endSegment);
    }
  }

  private onMseWaiting() {
    const engine = this.mse;
    const audio = this.audio;
    if (!engine || !audio) return;
    const location = engine.locate();
    if (location && !location.atEnd) {
      // A stall inside a sentence: the thing continuous playback must avoid.
      dlog('waiting', {
        seg: location.entry.segment,
        at: Math.round(location.offset * 1000),
        mse: true,
      });
      return;
    }
    const next = (location?.entry.segment ?? this.state.segment - 1) + 1;
    const { sleep, doc } = this.state;
    if (sleep.mode === 'chapter' && next >= sleep.endSegment) {
      this.sleepNow(Math.min(next, (doc?.segments.length ?? 1) - 1));
      return;
    }
    // Starved at a sentence boundary: the next one was not ready in time.
    dlog('waiting', { seg: next, at: 0, mse: true });
    if (this.starvedAt !== next) {
      this.starvedAt = next;
      dlog('start', { seg: next, offset: 0, autoplay: true, ready: false, mse: 'append' });
    }
    const failure = this.aheadFailure;
    if (failure && failure.index === next) {
      this.reportAheadFailure(failure.index, failure.error);
      if (!this.wantPlay) return;
    }
    engine.kick(true);
  }

  private onMseAppended(entry: TimelineEntry<MseSegmentData>) {
    if (this.aheadFailure && this.aheadFailure.index <= entry.segment) this.aheadFailure = null;
    if (this.state.blocked) this.set({ blocked: null });
    if (this.durations.get(entry.segment) !== entry.data.render.duration_s) {
      this.durations.set(entry.segment, entry.data.render.duration_s);
      this.prefix = null;
    }
  }

  private onMseLoadFailed(index: number, error: unknown) {
    if (isAbortError(error)) return;
    this.aheadFailure = { index, error };
    if (this.wantPlay && this.mse?.starved()) this.reportAheadFailure(index, error);
  }

  /** Playback reached a sentence that failed to load. */
  private reportAheadFailure(index: number, error: unknown) {
    const blocked = retryableFailure(error);
    if (blocked) {
      // The engine retries on its own (MSE_RETRY_MS, `online`, visibility).
      if (this.state.blocked !== blocked) {
        dlog('blocked', { seg: index, kind: blocked });
        this.set({ status: 'buffering', blocked });
      }
      return;
    }
    this.aheadFailure = null;
    this.set({ segment: index });
    this.fail(describeError(error));
  }

  /** MSE cannot play this audio here: continue with the per-sentence player. */
  private fallbackToBlob(reason: string) {
    const engine = this.mse;
    if (!engine) return;
    dlog('mse_fallback', { seg: this.state.segment, reason });
    const offset = this.segmentTime();
    const resume = this.wantPlay;
    this.mse = null;
    this.mseFailed = true;
    this.playToken++;
    this.current = null;
    engine.reset();
    if (this.state.doc) this.startAt(this.state.segment, offset, resume);
  }

  play() {
    const { doc, status, segment } = this.state;
    if (!doc) return;
    dlog('user_play', { seg: segment, status });
    if (status === 'ended') {
      this.startAt(0, 0, true);
      return;
    }
    if (status === 'error') {
      this.retry();
      return;
    }
    if (this.isCurrent() && this.audio) {
      this.wantPlay = true;
      this.claim();
      this.set({ error: null });
      this.playElement();
      this.mse?.kick();
      return;
    }
    this.startAt(segment, 0, true);
  }

  pause() {
    this.wantPlay = false;
    this.clearReconnect();
    this.stopFrames();
    this.audio?.pause();
    if (this.state.status !== 'idle' && this.state.status !== 'ended')
      this.set({ status: this.state.status === 'error' ? 'error' : 'paused', blocked: null });
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

  /** Seconds into the current sentence. */
  private segmentTime(): number {
    const audio = this.audio;
    if (!audio || !this.isCurrent()) return this.clock.time;
    if (this.mse) {
      const location = this.mse.locate(audio.currentTime);
      return location && location.entry.segment === this.state.segment ? location.offset : 0;
    }
    return audio.currentTime;
  }

  private segmentDuration(): number {
    return this.current?.segment === this.state.segment ? this.current.render.duration_s : 0;
  }

  // ── jumps and undo ───────────────────────────────────────────────────────
  /** Remember where we are before a user jump to `segment` + `offset`. */
  private rememberJump(segment: number, offset: number) {
    if (!this.state.doc) return;
    const entry = this.undoStack.push(
      { segment: this.state.segment, offset: this.segmentTime() },
      { segment, offset },
    );
    if (entry) {
      dlog('jump', { from: entry.segment, to: segment });
      this.progressHoldUntil = Date.now() + UNDO_WINDOW_MS + 500;
      this.set({ undo: entry });
    }
  }

  /** Go back to where the latest jump started ("Volver a 12:34"). */
  undoJump() {
    const entry = this.undoStack.pop();
    this.progressHoldUntil = 0;
    this.set({ undo: null });
    if (!entry || !this.state.doc) return;
    dlog('undo_jump', { to: entry.segment });
    this.startAt(entry.segment, entry.offset, this.wantPlay);
  }

  /** User jump to a sentence (text tap, scrubber, chapters, search…): undoable. */
  seekSegment(segment: number, autoplay = this.wantPlay) {
    this.rememberJump(segment, 0);
    this.startAt(segment, 0, autoplay);
  }

  /** Play from a word: seeks inside the loaded sentence, or starts it there. */
  seekWord(segment: number, word: number) {
    const words = this.wordsFor(segment);
    const offset = Math.max(0, (words?.[word]?.start ?? 0) - 0.02);
    this.rememberJump(segment, offset);
    if (!this.mse && segment === this.state.segment && this.isCurrent() && this.audio) {
      this.audio.currentTime = offset;
      this.emitHighlight(word, true);
      if (!this.wantPlay) this.play();
      return;
    }
    this.startAt(segment, offset, true);
  }

  /** Jump to the furthest point reached in this document. */
  goFurthest() {
    this.seekSegment(this.state.furthest, true);
  }

  next() {
    const doc = this.state.doc;
    if (doc && this.state.segment < doc.segments.length - 1)
      this.startAt(this.state.segment + 1, 0, this.wantPlay);
  }

  previous() {
    if (this.audio && this.isCurrent() && this.segmentTime() > 2) {
      if (this.mse) this.startAt(this.state.segment, 0, this.wantPlay);
      else {
        this.audio.currentTime = 0;
        this.emitHighlight(-1);
        this.tickClock(true);
      }
      return;
    }
    if (this.state.segment > 0) this.startAt(this.state.segment - 1, 0, this.wantPlay);
  }

  nextChapter() {
    const doc = this.state.doc;
    const next = doc?.chapters.find((chapter) => chapter.segment > this.state.segment);
    if (!doc || !next) {
      this.next();
      return;
    }
    this.seekSegment(next.segment);
  }

  previousChapter() {
    const doc = this.state.doc;
    if (!doc || !doc.chapters.length) {
      this.previous();
      return;
    }
    const index = chapterIndexAt(doc.chapters, this.state.segment);
    const start = doc.chapters[index]?.segment ?? 0;
    const into = this.secondsAt(this.state.segment) + this.segmentTime() - this.secondsAt(start);
    // Like "previous track": restart the chapter unless it just started.
    const target = into > 3 || index <= 0 ? start : doc.chapters[index - 1].segment;
    this.seekSegment(target);
  }

  /** Dock buttons, headphones and the lock screen: previous/next per the user's setting. */
  trackPrevious() {
    const { trackAction, skipSeconds } = readerPrefs();
    if (trackAction === 'skip') this.skip(-skipSeconds);
    else if (trackAction === 'chapter') this.previousChapter();
    else this.previous();
  }

  trackNext() {
    const { trackAction, skipSeconds } = readerPrefs();
    if (trackAction === 'skip') this.skip(skipSeconds);
    else if (trackAction === 'chapter') this.nextChapter();
    else this.next();
  }

  /** ±seconds of document time, crossing sentences as needed. */
  skip(delta: number) {
    const doc = this.state.doc;
    const audio = this.audio;
    if (!doc) return;
    if (audio && this.isCurrent()) {
      if (this.mse) {
        const target = Math.max(0, audio.currentTime + delta);
        if (this.mse.seekable(target)) {
          audio.currentTime = target;
          this.syncMseSegment();
          this.emitHighlight(this.wordAt(this.segmentTime()), true);
          this.tickClock(true);
          this.updatePosition();
          return;
        }
      } else if (this.current) {
        const target = audio.currentTime + delta;
        if (target >= 0 && target < this.current.render.duration_s - 0.05) {
          audio.currentTime = target;
          this.emitHighlight(this.wordAt(target), true);
          this.tickClock(true);
          this.updatePosition();
          return;
        }
      }
    }
    const here = this.secondsAt(this.state.segment) + this.segmentTime();
    const [segment, offset] = this.positionAt(here + delta);
    this.startAt(segment, offset, this.wantPlay);
  }

  private wordAt(offset: number): number {
    const words = this.current?.render.words;
    return words ? wordIndexAt(words, offset) : -1;
  }

  retry() {
    const { segment } = this.state;
    this.cache.delete(segment);
    this.aheadFailure = null;
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

  /** The backend pins a language-matched voice on a document's first render;
   * show it instead of "Default voice". Render keys don't change: an omitted
   * voice already resolves to the pinned one server-side. */
  private adoptAutoVoice(docId: string, voice: string | null | undefined) {
    const doc = this.state.doc;
    if (!voice || this.state.voice || !doc || doc.id !== docId) return;
    this.set({ voice, doc: { ...doc, voice_id: voice } });
  }

  /** Switch voice; re-renders from the current sentence. */
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

  /** Forget rendered audio (a pronunciation changed); re-renders from the current sentence. */
  refreshAudio() {
    if (!this.state.doc) return;
    const resume = this.wantPlay;
    this.stopAudio();
    this.resetCache();
    this.durations.clear();
    this.prefix = null;
    this.set({ status: 'paused' });
    if (resume) this.startAt(this.state.segment, 0, true);
    // stopAudio() cleared the sleep interval; a running timer keeps counting.
    if (this.state.sleep.mode !== 'off' && this.sleepTimer === null)
      this.sleepTimer = setInterval(() => this.sleepTick(), 250);
  }

  // ── sleep timer ──────────────────────────────────────────────────────────
  setSleep(option: { mode: 'off' } | { mode: 'time'; minutes: number } | { mode: 'chapter' }) {
    const doc = this.state.doc;
    if (this.audio) this.audio.volume = 1;
    this.stopSleepTimer();
    if (!doc || option.mode === 'off') {
      this.set({ sleep: { mode: 'off' } });
      this.publishClock(this.clock.time, this.clock.duration);
      this.mse?.kick();
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
    // The interval drives the fade on screen; `timeupdate` also ticks it when timers are throttled.
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
      const left = (this.segmentDuration() - this.segmentTime()) * 1000;
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
  /** Word highlighting per frame while visible; never needed for playback itself. */
  private startFrames() {
    if (this.raf !== null || typeof requestAnimationFrame !== 'function') return;
    const frame = () => {
      this.raf = null;
      const audio = this.audio;
      if (!audio || !this.wantPlay) return;
      if (this.mse) {
        this.syncMseSegment();
        const location = this.mse.locate(audio.currentTime);
        if (location && location.entry.segment === this.state.segment)
          this.emitHighlight(wordIndexAt(location.entry.data.render.words, location.offset));
      } else if (this.current) {
        this.emitHighlight(wordIndexAt(this.current.render.words, audio.currentTime));
      } else return;
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

  /** Document seconds (1x) of the playhead. */
  positionSeconds(): number {
    return this.secondsAt(this.state.segment) + this.segmentTime();
  }

  /** (segment, offset) at a document time in 1x seconds. */
  private positionAt(seconds: number): [number, number] {
    const prefix = this.offsets();
    const total = prefix[prefix.length - 1] ?? 0;
    const target = Math.min(Math.max(0, seconds), Math.max(0, total - 0.25));
    let low = 0;
    let high = prefix.length - 2;
    let segment = 0;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (prefix[mid] <= target) {
        segment = mid;
        low = mid + 1;
      } else high = mid - 1;
    }
    return [segment, Math.max(0, target - prefix[segment])];
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
    if (!this.audio || !this.current) return;
    const now = performance.now();
    if (!force && now - this.lastClockAt < 200) return;
    this.lastClockAt = now;
    this.publishClock(this.segmentTime(), this.segmentDuration());
  }

  // ── progress ─────────────────────────────────────────────────────────────
  private scheduleProgress() {
    if (this.progressTimer !== null) clearTimeout(this.progressTimer);
    const delay = Math.max(PROGRESS_DEBOUNCE_MS, this.progressHoldUntil - Date.now());
    this.progressTimer = setTimeout(() => this.flushProgress(), delay);
  }

  private flushProgress(keepalive = false) {
    if (this.progressTimer !== null) clearTimeout(this.progressTimer);
    this.progressTimer = null;
    const doc = this.state.doc;
    if (!doc || this.savedSegment === this.state.segment) return;
    // A jump that may still be undone (an accidental tap) must not move the
    // saved position or the furthest point; leaving the page saves it anyway.
    if (!keepalive && Date.now() < this.progressHoldUntil) {
      this.scheduleProgress();
      return;
    }
    const segment = this.state.segment;
    this.savedSegment = segment;
    // The backend raises furthest_segment with every saved position; mirror it.
    const furthest = Math.max(this.state.furthest, segment);
    if (furthest !== this.state.furthest) this.set({ furthest });
    void readerApi.saveProgress(doc.id, segment, keepalive).catch(() => {
      if (this.savedSegment === segment) this.savedSegment = null;
    });
    const count = Math.max(1, doc.segments.length);
    const patch = (summary: ReaderDocumentSummary): ReaderDocumentSummary =>
      summary.id === doc.id
        ? {
            ...summary,
            position_segment: segment,
            furthest_segment: Math.max(summary.furthest_segment ?? 0, furthest),
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
      ['stop', () => this.pause()],
      ['previoustrack', () => this.trackPrevious()],
      ['nexttrack', () => this.trackNext()],
      ['seekbackward', (details) => this.skip(-(details.seekOffset ?? readerPrefs().skipSeconds))],
      ['seekforward', (details) => this.skip(details.seekOffset ?? readerPrefs().skipSeconds)],
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
    const [segment, offset] = this.positionAt(seconds);
    this.rememberJump(segment, offset);
    if (!this.mse && segment === this.state.segment && this.isCurrent() && this.audio) {
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
    const position = Math.min(total, this.positionSeconds());
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
