/** Per-device Reader preferences (speed, text size, controls), persisted in localStorage. */
import { useSyncExternalStore } from 'react';
import { clampSpeed } from './reader-text';

export const SKIP_OPTIONS = [10, 15, 30, 60] as const;
export type SkipSeconds = (typeof SKIP_OPTIONS)[number];
/** What previous/next (dock, headphones, lock screen) move by. */
export const TRACK_ACTIONS = ['sentence', 'chapter', 'skip'] as const;
export type TrackAction = (typeof TRACK_ACTIONS)[number];

export interface ReaderPrefs {
  rate: number;
  /** Reading text size in CSS pixels. */
  textSize: number;
  /** Seconds the skip buttons (and Media Session seek actions) move. */
  skipSeconds: SkipSeconds;
  trackAction: TrackAction;
  /** A single tap on the text does nothing; a double tap plays from there. */
  doubleTap: boolean;
}

export const TEXT_SIZE_MIN = 15;
export const TEXT_SIZE_MAX = 30;
const KEY = 'voicestudio.reader.prefs';
export const DEFAULT_PREFS: ReaderPrefs = {
  rate: 1,
  textSize: 20,
  skipSeconds: 15,
  trackAction: 'sentence',
  doubleTap: false,
};

function clampText(value: unknown): number {
  const size = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 20;
  return Math.min(TEXT_SIZE_MAX, Math.max(TEXT_SIZE_MIN, size));
}

const oneOf = <T>(options: readonly T[], value: unknown, fallback: T): T =>
  options.includes(value as T) ? (value as T) : fallback;

/** Valid preferences from anything stored (old versions, hand edits). */
export function sanitizePrefs(value: unknown): ReaderPrefs {
  const raw = (value && typeof value === 'object' ? value : {}) as Partial<
    Record<keyof ReaderPrefs, unknown>
  >;
  return {
    rate: typeof raw.rate === 'number' ? clampSpeed(raw.rate) : DEFAULT_PREFS.rate,
    textSize: clampText(raw.textSize ?? DEFAULT_PREFS.textSize),
    skipSeconds: oneOf(SKIP_OPTIONS, raw.skipSeconds, DEFAULT_PREFS.skipSeconds),
    trackAction: oneOf(TRACK_ACTIONS, raw.trackAction, DEFAULT_PREFS.trackAction),
    doubleTap: typeof raw.doubleTap === 'boolean' ? raw.doubleTap : DEFAULT_PREFS.doubleTap,
  };
}

function read(): ReaderPrefs {
  try {
    return sanitizePrefs(JSON.parse(localStorage.getItem(KEY) ?? '{}'));
  } catch {
    return DEFAULT_PREFS;
  }
}

let current = read();
const listeners = new Set<() => void>();

export function readerPrefs(): ReaderPrefs {
  return current;
}

export function setReaderPrefs(patch: Partial<ReaderPrefs>): void {
  current = sanitizePrefs({ ...current, ...patch });
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* Preferences stay for this session. */
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useReaderPrefs(): ReaderPrefs {
  return useSyncExternalStore(subscribe, readerPrefs, readerPrefs);
}
