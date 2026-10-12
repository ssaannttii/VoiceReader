/** Per-device Reader preferences (speed, text size), persisted in localStorage. */
import { useSyncExternalStore } from 'react';
import { clampSpeed } from './reader-text';

export interface ReaderPrefs {
  rate: number;
  /** Reading text size in CSS pixels. */
  textSize: number;
}

export const TEXT_SIZE_MIN = 15;
export const TEXT_SIZE_MAX = 30;
const KEY = 'voicestudio.reader.prefs';
const defaults: ReaderPrefs = { rate: 1, textSize: 20 };

function clampText(value: unknown): number {
  const size = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 20;
  return Math.min(TEXT_SIZE_MAX, Math.max(TEXT_SIZE_MIN, size));
}

function read(): ReaderPrefs {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<ReaderPrefs>;
    return {
      rate: typeof value.rate === 'number' ? clampSpeed(value.rate) : defaults.rate,
      textSize: clampText(value.textSize ?? defaults.textSize),
    };
  } catch {
    return defaults;
  }
}

let current = read();
const listeners = new Set<() => void>();

export function readerPrefs(): ReaderPrefs {
  return current;
}

export function setReaderPrefs(patch: Partial<ReaderPrefs>): void {
  current = {
    rate: patch.rate === undefined ? current.rate : clampSpeed(patch.rate),
    textSize: patch.textSize === undefined ? current.textSize : clampText(patch.textSize),
  };
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
