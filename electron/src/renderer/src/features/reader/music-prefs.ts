/**
 * Background music preferences (per device, localStorage): mode, volume,
 * whether downloads keep the music, and the documents it is on for. The Labs
 * switch itself lives in labs-prefs.ts.
 */
import { useSyncExternalStore } from 'react';
import {
  MUSIC_VOLUME_DEFAULT_DB,
  MUSIC_VOLUME_MAX_DB,
  MUSIC_VOLUME_MIN_DB,
  type MusicMode,
} from './music-plan';

export interface MusicPrefs {
  mode: MusicMode;
  /** dB relative to the PC's master level. */
  volumeDb: number;
  /** Downloading a document for offline also keeps its music clips. */
  offline: boolean;
  /** Documents the music is on for (most recent last). */
  docs: string[];
}

const KEY = 'voicestudio.reader.music';
/** The per-document list is bounded (oldest dropped). */
const MAX_DOCS = 200;

export const DEFAULT_MUSIC: MusicPrefs = {
  mode: 'moments',
  volumeDb: MUSIC_VOLUME_DEFAULT_DB,
  offline: false,
  docs: [],
};

export function sanitizeMusicPrefs(value: unknown): MusicPrefs {
  const raw = (value && typeof value === 'object' ? value : {}) as Partial<
    Record<keyof MusicPrefs, unknown>
  >;
  const docs = Array.isArray(raw.docs)
    ? [...new Set(raw.docs.filter((id): id is string => typeof id === 'string' && id.length > 0))]
    : [];
  return {
    mode: raw.mode === 'continuous' ? 'continuous' : 'moments',
    volumeDb:
      typeof raw.volumeDb === 'number' && Number.isFinite(raw.volumeDb)
        ? Math.round(Math.min(MUSIC_VOLUME_MAX_DB, Math.max(MUSIC_VOLUME_MIN_DB, raw.volumeDb)))
        : DEFAULT_MUSIC.volumeDb,
    offline: raw.offline === true,
    docs: docs.slice(-MAX_DOCS),
  };
}

function read(): MusicPrefs {
  try {
    return sanitizeMusicPrefs(JSON.parse(localStorage.getItem(KEY) ?? '{}'));
  } catch {
    return DEFAULT_MUSIC;
  }
}

let current = typeof localStorage === 'undefined' ? DEFAULT_MUSIC : read();
const listeners = new Set<() => void>();

export function musicPrefs(): MusicPrefs {
  return current;
}

export function setMusicPrefs(patch: Partial<MusicPrefs>): void {
  current = sanitizeMusicPrefs({ ...current, ...patch });
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* Preferences stay for this session. */
  }
  listeners.forEach((listener) => listener());
}

export function musicOnFor(docId: string | null | undefined): boolean {
  return Boolean(docId) && current.docs.includes(docId as string);
}

export function setMusicOnFor(docId: string, on: boolean): void {
  const others = current.docs.filter((id) => id !== docId);
  setMusicPrefs({ docs: on ? [...others, docId] : others });
}

export function subscribeMusicPrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function useMusicPrefs(): MusicPrefs {
  return useSyncExternalStore(subscribeMusicPrefs, musicPrefs, musicPrefs);
}
