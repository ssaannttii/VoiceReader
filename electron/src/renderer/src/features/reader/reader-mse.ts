/**
 * Continuous Reader playback with Media Source Extensions.
 *
 * One `<audio>` element plays a MediaSource whose single SourceBuffer
 * (`audio/mpeg`, `sequence` mode) receives every rendered sentence in order,
 * so the element never pauses or swaps `src` between sentences. That is what
 * keeps a locked Android phone playing: nothing playback-critical waits on a
 * timer or an animation frame — appends are driven by media and SourceBuffer
 * events (`timeupdate`, `updateend`, `waiting`) and by the load promises.
 *
 * Each append records where its sentence starts and ends in media time
 * (`timestampOffset` / `buffered.end` before and after), so word timings —
 * relative to their sentence — map to the shared audio clock exactly.
 *
 * The per-sentence blob player in reader-player.ts stays as the fallback when
 * this engine is unsupported (iOS/Safari, no `audio/mpeg` MSE, WAV audio).
 */
import type { ReaderRender } from './reader-api';

export const MSE_MIME = 'audio/mpeg';
/** Keep at least this much audio appended ahead of the playhead while playing… */
export const AHEAD_SECONDS = 60;
/** …and at least this many sentences. */
export const MIN_AHEAD_SEGMENTS = 3;
/** Never append further ahead than this (memory, wasted renders after a jump). */
export const MAX_AHEAD_SECONDS = 180;
/** Audio kept behind the playhead for short skips back; older audio is evicted. */
export const KEEP_BEHIND_SECONDS = 30;
/** Evict in chunks of at least this many seconds, not on every tick. */
export const EVICT_CHUNK_SECONDS = 30;
/** Retry delay after a failed sentence load (PC unreachable, engine busy). */
export const MSE_RETRY_MS = 5000;
const OPEN_TIMEOUT_MS = 10_000;
const EDGE = 0.05;

// ── support ────────────────────────────────────────────────────────────────

/**
 * Whether this browser should use the MSE engine. WebKit (Safari and every iOS
 * browser) keeps the per-sentence player: iPhones have no MediaSource and
 * Safari's MPEG audio MSE path has been unreliable. `localStorage['reader-engine']`
 * (`mse` | `blob`) overrides the choice for diagnostics.
 */
export function mseSupported(): boolean {
  let forced: string | null = null;
  try {
    forced = localStorage.getItem('reader-engine');
  } catch {
    // Storage blocked: use the detected engine.
  }
  if (forced === 'blob') return false;
  const source = (globalThis as { MediaSource?: typeof MediaSource }).MediaSource;
  if (!source || typeof source.isTypeSupported !== 'function') return false;
  try {
    if (!source.isTypeSupported(MSE_MIME)) return false;
  } catch {
    return false;
  }
  if (forced === 'mse') return true;
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  return !(/AppleWebKit/.test(ua) && !/Chrome|Chromium|Android/.test(ua));
}

/** MP3 bytes start with an ID3 tag or an MPEG audio frame sync; WAV starts with RIFF. */
export function isMp3(bytes: Uint8Array): boolean {
  if (bytes.length < 3) return false;
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return true;
  return bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
}

// ── time ranges ────────────────────────────────────────────────────────────

export interface TimeRangesLike {
  readonly length: number;
  start(index: number): number;
  end(index: number): number;
}

export function lastEnd(ranges: TimeRangesLike): number {
  return ranges.length ? ranges.end(ranges.length - 1) : 0;
}

/** The buffered range holding `time` (with a small tolerance), or null. */
export function rangeAt(ranges: TimeRangesLike, time: number): [number, number] | null {
  for (let index = 0; index < ranges.length; index++) {
    const start = ranges.start(index);
    const end = ranges.end(index);
    if (time >= start - EDGE && time < end + EDGE) return [start, end];
  }
  return null;
}

// ── segment timeline ───────────────────────────────────────────────────────

export interface TimelineEntry<T> {
  segment: number;
  /** Media seconds where the sentence starts and ends on the shared audio clock. */
  start: number;
  end: number;
  data: T;
}

export interface TimelineLocation<T> {
  entry: TimelineEntry<T>;
  /** Seconds into the sentence (what word timings are relative to). */
  offset: number;
  /** The playhead reached the end of everything appended. */
  atEnd: boolean;
}

/** Appended sentences in media-time order: the offset table behind highlighting. */
export class SegmentTimeline<T> {
  private entries: TimelineEntry<T>[] = [];

  get size(): number {
    return this.entries.length;
  }
  first(): TimelineEntry<T> | null {
    return this.entries[0] ?? null;
  }
  last(): TimelineEntry<T> | null {
    return this.entries[this.entries.length - 1] ?? null;
  }
  clear() {
    this.entries = [];
  }

  /** Record the next appended sentence; anything not consecutive restarts the table. */
  add(entry: TimelineEntry<T>) {
    const last = this.last();
    if (last && (entry.segment !== last.segment + 1 || entry.start < last.start)) this.clear();
    this.entries.push(entry);
  }

  get(segment: number): TimelineEntry<T> | null {
    const first = this.entries[0];
    if (!first) return null;
    const entry = this.entries[segment - first.segment];
    return entry?.segment === segment ? entry : null;
  }

  /** The sentence playing at `time`: the last one starting at or before it. */
  locate(time: number): TimelineLocation<T> | null {
    let low = 0;
    let high = this.entries.length - 1;
    let found = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (this.entries[mid].start <= time + 1e-6) {
        found = mid;
        low = mid + 1;
      } else high = mid - 1;
    }
    if (found < 0) {
      const first = this.entries[0];
      return first ? { entry: first, offset: 0, atEnd: false } : null;
    }
    const entry = this.entries[found];
    const duration = Math.max(0, entry.end - entry.start);
    const last = found === this.entries.length - 1;
    return {
      entry,
      offset: Math.min(duration, Math.max(0, time - entry.start)),
      atEnd: last && time >= entry.end - EDGE,
    };
  }

  /** Media time of `offset` seconds into `segment`, when that sentence is in the table. */
  timeOf(segment: number, offset: number): number | null {
    const entry = this.get(segment);
    if (!entry) return null;
    return entry.start + Math.min(Math.max(0, offset), Math.max(0, entry.end - entry.start - EDGE));
  }

  /** Forget sentences that end at or before `time` (their audio was evicted). */
  dropBefore(time: number) {
    let count = 0;
    while (count < this.entries.length && this.entries[count].end <= time + 1e-6) count++;
    if (count) this.entries = this.entries.slice(count);
  }
}

/** Whether to append another sentence, given what is already ahead of the playhead. */
export function shouldAppend(
  aheadSeconds: number,
  aheadSegments: number,
  playing: boolean,
): boolean {
  if (!playing) return aheadSegments < MIN_AHEAD_SEGMENTS;
  if (aheadSeconds >= MAX_AHEAD_SECONDS) return false;
  return aheadSegments < MIN_AHEAD_SEGMENTS || aheadSeconds < AHEAD_SECONDS;
}

/** The buffered span to evict behind `time`, or null when it is still small. */
export function evictionRange(
  ranges: TimeRangesLike,
  time: number,
  keepBehind = KEEP_BEHIND_SECONDS,
  chunk = EVICT_CHUNK_SECONDS,
): [number, number] | null {
  if (!ranges.length) return null;
  const start = ranges.start(0);
  const cut = time - keepBehind;
  return cut - start >= chunk ? [start, cut] : null;
}

// ── append queue ───────────────────────────────────────────────────────────

/** The part of SourceBuffer the queue needs (a mock in tests). */
export interface SourceBufferLike {
  readonly updating: boolean;
  readonly buffered: TimeRangesLike;
  timestampOffset: number;
  appendBuffer(data: BufferSource): void;
  remove(start: number, end: number): void;
  addEventListener(type: 'updateend' | 'error', listener: () => void): void;
  removeEventListener(type: 'updateend' | 'error', listener: () => void): void;
}

type QueueOp =
  | {
      kind: 'append';
      data: BufferSource;
      resolve: (span: { start: number; end: number }) => void;
      reject: (error: unknown) => void;
    }
  | {
      kind: 'remove';
      start: number;
      end: number;
      resolve: () => void;
      reject: (error: unknown) => void;
    };

const abortError = () => new DOMException('MSE session closed', 'AbortError');

export function isQuotaError(error: unknown): boolean {
  return (error as { name?: string } | null)?.name === 'QuotaExceededError';
}

/** End of the appended media: where the next `sequence`-mode append starts. */
export function appendEnd(buffer: SourceBufferLike): number {
  const offset = Number.isFinite(buffer.timestampOffset) ? buffer.timestampOffset : 0;
  return Math.max(offset, lastEnd(buffer.buffered));
}

/**
 * Serializes SourceBuffer work: an append or remove only starts once the
 * previous one fired `updateend`. An append that hits QuotaExceededError
 * evicts what `onQuota` returns and retries once.
 */
export class AppendQueue {
  private ops: QueueOp[] = [];
  private running = false;
  private disposed = false;

  constructor(
    private buffer: SourceBufferLike,
    private onQuota: () => [number, number] | null = () => null,
  ) {}

  get pending(): number {
    return this.ops.length + (this.running ? 1 : 0);
  }

  append(data: BufferSource): Promise<{ start: number; end: number }> {
    return new Promise((resolve, reject) => {
      this.ops.push({ kind: 'append', data, resolve, reject });
      void this.run();
    });
  }

  remove(start: number, end: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!(end > start)) {
        resolve();
        return;
      }
      this.ops.push({ kind: 'remove', start, end, resolve, reject });
      void this.run();
    });
  }

  /** Reject everything queued; the session is going away. */
  dispose() {
    this.disposed = true;
    const ops = this.ops;
    this.ops = [];
    for (const op of ops) op.reject(abortError());
  }

  private async run() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.ops.length && !this.disposed) {
        const op = this.ops.shift()!;
        try {
          await this.idle();
          if (this.disposed) throw abortError();
          if (op.kind === 'remove') {
            await this.update(() => this.buffer.remove(op.start, op.end));
            if (this.disposed) throw abortError();
            op.resolve();
          } else {
            const span = await this.appendOnce(op.data, true);
            if (this.disposed) throw abortError();
            op.resolve(span);
          }
        } catch (error) {
          op.reject(this.disposed ? abortError() : error);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async appendOnce(
    data: BufferSource,
    retry: boolean,
  ): Promise<{ start: number; end: number }> {
    const start = appendEnd(this.buffer);
    try {
      await this.update(() => this.buffer.appendBuffer(data));
    } catch (error) {
      const range = retry && isQuotaError(error) ? this.onQuota() : null;
      if (!range) throw error;
      await this.update(() => this.buffer.remove(range[0], range[1]));
      return this.appendOnce(data, false);
    }
    return { start, end: Math.max(start, appendEnd(this.buffer)) };
  }

  /** Wait for an in-flight update that the queue did not start. */
  private idle(): Promise<void> {
    if (!this.buffer.updating) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        this.buffer.removeEventListener('updateend', done);
        resolve();
      };
      this.buffer.addEventListener('updateend', done);
    });
  }

  /** Run one SourceBuffer operation and settle on its `updateend` / `error`. */
  private update(action: () => void): Promise<void> {
    return new Promise((resolve, reject) => {
      let failed = false;
      const cleanup = () => {
        this.buffer.removeEventListener('updateend', onEnd);
        this.buffer.removeEventListener('error', onError);
      };
      const onEnd = () => {
        cleanup();
        if (failed) reject(new DOMException('SourceBuffer update failed', 'InvalidStateError'));
        else resolve();
      };
      const onError = () => {
        failed = true;
      };
      this.buffer.addEventListener('updateend', onEnd);
      this.buffer.addEventListener('error', onError);
      try {
        action();
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }
}

// ── session: one MediaSource on the audio element ──────────────────────────

export interface MseSegmentData {
  render: ReaderRender;
  offline: boolean;
}

class MseSession {
  readonly timeline = new SegmentTimeline<MseSegmentData>();
  pumping = false;
  private constructor(
    readonly url: string,
    private source: MediaSource,
    readonly buffer: SourceBuffer,
    readonly queue: AppendQueue,
  ) {}

  static async open(
    audio: HTMLAudioElement,
    onQuota: (buffer: SourceBuffer) => [number, number] | null,
  ): Promise<MseSession> {
    const source = new MediaSource();
    const url = URL.createObjectURL(source);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new DOMException('MediaSource did not open', 'TimeoutError')),
        OPEN_TIMEOUT_MS,
      );
      source.addEventListener(
        'sourceopen',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      audio.src = url;
    });
    const buffer = source.addSourceBuffer(MSE_MIME);
    try {
      buffer.mode = 'sequence';
    } catch {
      // `audio/mpeg` generates timestamps and is already in sequence mode.
    }
    return new MseSession(url, source, buffer, new AppendQueue(buffer, () => onQuota(buffer)));
  }

  get ended(): boolean {
    return this.source.readyState === 'ended';
  }

  /** Signal the document's end so the element fires `ended` after the last sentence. */
  end() {
    if (this.source.readyState !== 'open' || this.buffer.updating || this.queue.pending) return;
    try {
      this.source.endOfStream();
    } catch {
      // Raced with an append; the next pump retries.
    }
  }

  destroy() {
    this.queue.dispose();
    if (this.source.readyState === 'open') {
      try {
        this.buffer.abort();
      } catch {
        // Already detached.
      }
    }
    URL.revokeObjectURL(this.url);
  }
}

// ── engine ─────────────────────────────────────────────────────────────────

export interface MseLoaded extends MseSegmentData {
  blob: Blob;
}

/** What the engine needs from the player. */
export interface MseHost {
  /** Sentences in the document. */
  count(): number;
  /** Append no sentence at or beyond this index (the end-of-chapter sleep timer). */
  limit(): number;
  /** The user wants audio now (append the long window, not just a few sentences). */
  playing(): boolean;
  load(index: number): Promise<MseLoaded>;
  /** The sentence's bytes are in the SourceBuffer; its cached blob can go. */
  release(index: number): void;
  appended(entry: TimelineEntry<MseSegmentData>): void;
  loadFailed(index: number, error: unknown): void;
  /** The audio cannot go through MSE (e.g. the backend serves WAV). */
  unsupported(reason: string): void;
  log(type: string, data: Record<string, unknown>): void;
}

export class UnsupportedAudioError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'UnsupportedAudioError';
  }
}

export class MseEngine {
  private session: MseSession | null = null;
  private generation = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private failedAt = 0;
  /** True while a new MediaSource is being attached: element events belong to the old one. */
  switching = false;

  constructor(
    private audio: HTMLAudioElement,
    private host: MseHost,
  ) {}

  /** The element is playing this engine's MediaSource. */
  attached(): boolean {
    return Boolean(this.session && this.audio.src === this.session.url);
  }

  get timeline(): SegmentTimeline<MseSegmentData> | null {
    return this.session?.timeline ?? null;
  }

  locate(time = this.audio.currentTime): TimelineLocation<MseSegmentData> | null {
    return this.session?.timeline.locate(time) ?? null;
  }

  /** Media time for a position, when it is appended and still buffered. */
  timeOf(segment: number, offset: number): number | null {
    const session = this.session;
    if (!session || this.switching) return null;
    const time = session.timeline.timeOf(segment, offset);
    if (time === null) return null;
    return rangeAt(session.buffer.buffered, time) ? time : null;
  }

  /** `time` is inside the buffered audio around the playhead. */
  seekable(time: number): boolean {
    const session = this.session;
    if (!session || this.switching) return false;
    const range = rangeAt(session.buffer.buffered, this.audio.currentTime);
    const location = session.timeline.locate(time);
    return Boolean(
      range && location && time >= range[0] && time < range[1] - EDGE && !location.atEnd,
    );
  }

  /** The playhead is at the end of everything appended (waiting for the next sentence). */
  starved(): boolean {
    const location = this.locate();
    return !location || location.atEnd;
  }

  /** Sentences appended after the one at the playhead. */
  readyAhead(): number {
    const location = this.locate();
    const last = this.session?.timeline.last();
    return location && last ? last.segment - location.entry.segment : 0;
  }

  /**
   * Build a fresh MediaSource that starts at `segment` + `offset`. The first
   * sentence loads while the MediaSource opens; it resolves once that sentence
   * is appended and the element is positioned (not playing).
   */
  async start(segment: number, offset: number): Promise<TimelineEntry<MseSegmentData>> {
    this.teardown();
    const generation = this.generation;
    this.switching = true;
    const t0 = performance.now();
    try {
      const loading = this.host.load(segment);
      // Without this, a load that fails while the MediaSource opens is "unhandled".
      loading.catch(() => {});
      const session = await MseSession.open(this.audio, (buffer) => this.quotaRange(buffer, true));
      if (generation !== this.generation) {
        session.destroy();
        throw abortError();
      }
      this.session = session;
      const ready = await loading;
      if (generation !== this.generation) throw abortError();
      const entry = await this.appendLoaded(session, segment, ready);
      if (this.audio.readyState < 1) await this.metadata();
      if (generation !== this.generation) throw abortError();
      const time = session.timeline.timeOf(segment, offset) ?? entry.start;
      if (Math.abs(this.audio.currentTime - time) > 0.01) this.audio.currentTime = time;
      this.host.log('mse_rebuild', {
        seg: segment,
        offset: Math.round(offset * 1000),
        ms: Math.round(performance.now() - t0),
      });
      return entry;
    } finally {
      if (generation === this.generation) {
        this.switching = false;
        if (this.session) void this.pump();
      }
    }
  }

  private metadata(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, 2000);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.audio.addEventListener('loadedmetadata', done, { once: true });
    });
  }

  /** Append one loaded sentence, recording where it lands on the audio clock. */
  private async appendLoaded(
    session: MseSession,
    segment: number,
    ready: MseLoaded,
  ): Promise<TimelineEntry<MseSegmentData>> {
    const bytes = new Uint8Array(await ready.blob.arrayBuffer());
    if (!isMp3(bytes)) throw new UnsupportedAudioError('not_mp3');
    const t0 = performance.now();
    const span = await session.queue.append(bytes);
    const entry: TimelineEntry<MseSegmentData> = {
      segment,
      start: span.start,
      end: span.end,
      data: { render: ready.render, offline: ready.offline },
    };
    session.timeline.add(entry);
    this.failedAt = 0;
    this.host.log('mse_append', {
      seg: segment,
      ms: Math.round(performance.now() - t0),
      start: Math.round(span.start * 1000),
      dur: Math.round((span.end - span.start) * 1000),
      kb: Math.round(bytes.byteLength / 1024),
      ahead_s: Math.round(span.end - this.audio.currentTime),
    });
    this.host.release(segment);
    this.host.appended(entry);
    return entry;
  }

  /**
   * Keep the window ahead filled. Single-flight per session; safe to call from
   * any event. Retries a failed load after MSE_RETRY_MS (or on `kick(true)`).
   */
  async pump(force = false): Promise<void> {
    const session = this.session;
    if (!session || session.pumping || this.switching) return;
    if (!force && this.failedAt && performance.now() - this.failedAt < MSE_RETRY_MS) return;
    session.pumping = true;
    try {
      while (session === this.session) {
        const last = session.timeline.last();
        if (!last) break;
        const next = last.segment + 1;
        if (next >= this.host.count()) {
          session.end();
          break;
        }
        if (next >= this.host.limit()) break;
        const location = session.timeline.locate(this.audio.currentTime);
        const aheadSeconds = last.end - this.audio.currentTime;
        const aheadSegments = location ? last.segment - location.entry.segment : 0;
        if (!shouldAppend(aheadSeconds, aheadSegments, this.host.playing())) break;
        let ready: MseLoaded;
        try {
          ready = await this.host.load(next);
        } catch (error) {
          if (session !== this.session) break;
          this.failedAt = performance.now();
          this.scheduleRetry();
          this.host.loadFailed(next, error);
          break;
        }
        if (session !== this.session) break;
        try {
          await this.appendLoaded(session, next, ready);
        } catch (error) {
          if (session !== this.session) break;
          if (error instanceof UnsupportedAudioError) {
            this.host.unsupported(error.message);
            break;
          }
          this.host.log('mse_append_failed', {
            seg: next,
            name: (error as { name?: string })?.name ?? 'Error',
          });
          // Quota still exceeded after evicting: playback frees space, retry later.
          this.failedAt = performance.now();
          this.scheduleRetry();
          break;
        }
        this.evict();
      }
    } finally {
      session.pumping = false;
    }
  }

  /** Something changed (time advanced, a limit lifted, the network is back). */
  kick(force = false) {
    if (force) this.failedAt = 0;
    void this.pump(force);
    this.evict();
  }

  private scheduleRetry() {
    if (this.retryTimer !== null) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.pump(true);
    }, MSE_RETRY_MS);
  }

  /** Drop audio well behind the playhead so long books keep memory bounded. */
  private evict() {
    const session = this.session;
    if (!session || this.switching || session.buffer.updating) return;
    const range = evictionRange(session.buffer.buffered, this.audio.currentTime);
    if (!range) return;
    session.timeline.dropBefore(range[1]);
    session.queue.remove(range[0], range[1]).catch(() => {});
  }

  private quotaRange(buffer: SourceBuffer, aggressive: boolean): [number, number] | null {
    const keep = aggressive ? 2 : KEEP_BEHIND_SECONDS;
    const range = evictionRange(buffer.buffered, this.audio.currentTime, keep, 1);
    if (range) this.session?.timeline.dropBefore(range[1]);
    this.host.log('mse_quota', { evict_s: range ? Math.round(range[1] - range[0]) : 0 });
    return range;
  }

  private teardown() {
    this.generation++;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.failedAt = 0;
    this.session?.destroy();
    this.session = null;
  }

  /** Forget the MediaSource and detach it from the element. */
  reset() {
    const attached = this.attached();
    this.teardown();
    this.switching = false;
    if (attached) {
      this.audio.removeAttribute('src');
      this.audio.load();
    }
  }
}
