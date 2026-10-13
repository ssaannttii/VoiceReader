/**
 * Recorded ambience beds: the PC's optional pack of public-domain field
 * recordings (backend services/reader_ambience_pack.py, built by
 * scripts/reader/fetch-ambience.py). When the pack has a recording for a scene
 * tag (or for a manual rain / café / fireplace) and the listener keeps
 * "Recorded sounds" on, it plays instead of the synthesized bed; anything
 * missing, unreadable or offline-and-uncached falls back to the synthesized
 * bed exactly as before.
 *
 * Recordings arrive compressed (Ogg Opus), are kept in IndexedDB like the
 * synthesized loops (so they work offline) and are decoded to WAV before they
 * reach the `<audio loop>` element: decoded PCM loops without a codec gap. The
 * decoding uses an OfflineAudioContext (never a realtime one), and the reading
 * audio is not involved.
 */
import { useSyncExternalStore } from 'react';
import {
  isRecordedKey,
  synthChoice,
  type AmbienceSceneTag,
  type BedChoice,
  type BedKey,
  type RecordedKey,
} from './ambience-schedule';
import { listeningPrefs, type SoundscapeId } from './listening-prefs';
import { readerApi, type ReaderAmbienceBed } from './reader-api';
import { dlog } from './reader-debug';
import { cachedBytes, loadBed, pruneBytes, storeBytes } from './soundscape-cache';
import { encodeWav, type BedId } from './soundscape-synth';

const STORAGE_KEY = 'voicestudio.reader.ambience-pack';
/** The pack is asked for again at most this often (it changes only when rebuilt on the PC). */
const REFRESH_MS = 10 * 60_000;
/** Decoded loops: enough for ambience, a third less memory than 48 kHz. */
export const DECODE_RATE = 32_000;
const CACHE_PREFIX = 'rec:';

export type PackStatus = 'unknown' | 'loading' | 'ready' | 'unavailable';

export interface PackState {
  status: PackStatus;
  beds: readonly ReaderAmbienceBed[];
}

/** Manual soundscapes that have a recorded counterpart (by scene tag). */
export const MANUAL_TAG: Partial<Record<SoundscapeId, AmbienceSceneTag>> = {
  rain: 'rain',
  cafe: 'tavern',
  fire: 'fire',
};

// ── pure helpers ───────────────────────────────────────────────────────────

const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

/** Valid beds of a pack response (anything malformed is dropped). */
export function sanitizePack(value: unknown): ReaderAmbienceBed[] {
  const beds =
    (value && typeof value === 'object' ? (value as { beds?: unknown }).beds : null) ?? [];
  if (!Array.isArray(beds)) return [];
  return beds.filter(
    (bed): bed is ReaderAmbienceBed =>
      Boolean(bed) &&
      typeof bed === 'object' &&
      typeof bed.tag === 'string' &&
      typeof bed.file === 'string' &&
      FILE_RE.test(bed.file) &&
      !bed.file.includes('..') &&
      typeof bed.rms === 'number' &&
      bed.rms > 0 &&
      bed.rms <= 1 &&
      typeof bed.duration === 'number' &&
      bed.duration > 0 &&
      (bed.pad === undefined || (typeof bed.pad === 'number' && bed.pad >= 0 && bed.pad <= 5)),
  );
}

export function recordedKey(bed: ReaderAmbienceBed): RecordedKey {
  return `rec:${bed.file}`;
}

/** IndexedDB key of a recording's bytes (changes when the pack rebuilds the file). */
export function storageKey(bed: ReaderAmbienceBed): string {
  return `${CACHE_PREFIX}${bed.file}@${bed.sha256 ?? bed.duration}`;
}

/** The bed for a tag: its recording (with the synthesized stand-in as fallback) or the synthesized bed. */
export function chooseBed(
  tag: AmbienceSceneTag,
  beds: readonly ReaderAmbienceBed[],
  recorded: boolean,
): BedChoice | null {
  const synth = synthChoice(tag);
  const bed = recorded ? beds.find((candidate) => candidate.tag === tag) : undefined;
  if (!bed) return synth;
  return { key: recordedKey(bed), rms: bed.rms, fallback: synth };
}

// ── decoding ───────────────────────────────────────────────────────────────

type OfflineCtor = new (channels: number, length: number, rate: number) => OfflineAudioContext;

function offlineContext(): OfflineCtor | null {
  const scope = globalThis as unknown as {
    OfflineAudioContext?: OfflineCtor;
    webkitOfflineAudioContext?: OfflineCtor;
  };
  return scope.OfflineAudioContext ?? scope.webkitOfflineAudioContext ?? null;
}

function canPlayOpus(): boolean {
  try {
    return typeof Audio !== 'undefined' && new Audio().canPlayType('audio/ogg; codecs=opus') !== '';
  } catch {
    return false;
  }
}

/**
 * The samples of the loop itself: `pad` seconds of its own tail and head are
 * encoded around it (codec edge effects land there) and cut off here.
 */
export function trimPad(
  channel: Float32Array,
  sampleRate: number,
  pad: number,
  duration: number,
): Float32Array {
  const start = Math.round(Math.max(0, pad) * sampleRate);
  const length = Math.round(duration * sampleRate);
  if (start <= 0 || length <= 0 || start + length > channel.length) return channel;
  return channel.subarray(start, start + length);
}

/** A compressed loop as a gapless WAV (or as is when this browser cannot decode it here). */
export async function decodeLoop(bytes: ArrayBuffer, pad = 0, duration = 0): Promise<Blob> {
  const Offline = offlineContext();
  if (Offline) {
    try {
      const ctx = new Offline(2, 1, DECODE_RATE);
      const buffer = await ctx.decodeAudioData(bytes.slice(0));
      const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) =>
        trimPad(buffer.getChannelData(c), buffer.sampleRate, pad, duration),
      );
      return new Blob([encodeWav(channels, buffer.sampleRate)], { type: 'audio/wav' });
    } catch {
      // Fall through: play the compressed file directly when the element can.
    }
  }
  // A padded file played as is would jump at its seam: only an unpadded one may.
  if (pad <= 0 && canPlayOpus()) return new Blob([bytes], { type: 'audio/ogg' });
  throw new DOMException('Cannot decode the recording', 'NotSupportedError');
}

// ── store ──────────────────────────────────────────────────────────────────

function readStored(): ReaderAmbienceBed[] {
  try {
    return sanitizePack(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}'));
  } catch {
    return [];
  }
}

function writeStored(beds: readonly ReaderAmbienceBed[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ beds }));
  } catch {
    /* Asked again next time. */
  }
}

class AmbiencePack {
  private state: PackState = { status: 'unknown', beds: [] };
  private listeners = new Set<() => void>();
  private fetchedAt = Number.NEGATIVE_INFINITY;
  private inflight: Promise<void> | null = null;

  constructor() {
    if (typeof localStorage !== 'undefined') {
      const beds = readStored();
      // The last known pack (offline start); confirmed or replaced by refresh().
      if (beds.length) this.state = { status: 'ready', beds };
    }
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
  getState = () => this.state;

  private set(state: PackState) {
    this.state = state;
    this.listeners.forEach((listener) => listener());
  }

  /** Ask the PC which recordings it has (at most every 10 minutes unless forced). */
  refresh(force = false): Promise<void> {
    if (this.inflight) return this.inflight;
    if (!force && performance.now() - this.fetchedAt < REFRESH_MS) return Promise.resolve();
    if (this.state.status === 'unknown') this.set({ status: 'loading', beds: [] });
    this.inflight = readerApi
      .ambiencePack()
      .then(
        (pack) => {
          const beds = sanitizePack(pack);
          this.fetchedAt = performance.now();
          writeStored(beds);
          this.set({ status: beds.length ? 'ready' : 'unavailable', beds });
          dlog('ambience', { event: 'pack', beds: beds.length });
          void pruneBytes(CACHE_PREFIX, new Set(beds.map(storageKey)));
        },
        () => {
          // Offline or an older backend: keep what we knew (cached recordings still play).
          if (this.state.status === 'loading' || this.state.status === 'unknown')
            this.set({ status: 'unavailable', beds: [] });
        },
      )
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  /** The bed for a scene tag, following the "Recorded sounds" preference. */
  bedFor = (tag: AmbienceSceneTag): BedChoice | null =>
    chooseBed(tag, this.state.beds, listeningPrefs().soundscapeRecorded);

  /** Recording, else synthesized bed, for a manual soundscape (rain, café, fireplace…). */
  manualKey(id: SoundscapeId): BedKey {
    const tag = MANUAL_TAG[id];
    const choice = tag
      ? chooseBed(tag, this.state.beds, listeningPrefs().soundscapeRecorded)
      : null;
    return choice && isRecordedKey(choice.key) ? choice.key : id;
  }

  /** Bytes → WAV of any bed key (recorded: IndexedDB, else the PC). */
  load = (key: BedKey): Promise<Blob> => {
    if (!isRecordedKey(key)) return loadBed(key as BedId);
    const file = key.slice(4);
    const bed = this.state.beds.find((candidate) => candidate.file === file);
    if (!bed) return Promise.reject(new DOMException('Not in the pack', 'NotFoundError'));
    return loadRecorded(bed);
  };
}

/** A recording's loop: IndexedDB, else downloaded once and kept; decoded on every load. */
export async function loadRecorded(bed: ReaderAmbienceBed): Promise<Blob> {
  const t0 = performance.now();
  const key = storageKey(bed);
  let bytes = await cachedBytes(key);
  const cached = Boolean(bytes);
  if (!bytes) {
    bytes = await readerApi.ambienceFile(bed.file);
    void storeBytes(key, bytes);
  }
  const blob = await decodeLoop(bytes, bed.pad ?? 0, bed.duration);
  dlog('soundscape_load', {
    id: bed.id,
    recorded: true,
    cached,
    ms: Math.round(performance.now() - t0),
    kb: Math.round(bytes.byteLength / 1024),
  });
  return blob;
}

export const ambiencePack = new AmbiencePack();

export function useAmbiencePack(): PackState {
  return useSyncExternalStore(ambiencePack.subscribe, ambiencePack.getState, ambiencePack.getState);
}
