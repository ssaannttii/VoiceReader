/** Per-device "long listening" preferences: soundscape and audio-only mode (localStorage). */
import { useSyncExternalStore } from 'react';

export const SOUNDSCAPES = ['rain', 'brown', 'pink', 'cafe', 'fire'] as const;
export type SoundscapeId = (typeof SOUNDSCAPES)[number];
/** `auto`: a bed chosen per scene of the document (reader-ambience.ts). */
export type SoundscapeChoice = SoundscapeId | 'auto' | 'off';

export interface ListeningPrefs {
  soundscape: SoundscapeChoice;
  /** 0–100. */
  soundscapeVolume: number;
  /** Pause the soundscape whenever the voice pauses. */
  soundscapeWithVoice: boolean;
  /** Hide the text and show the calm player with the orb. */
  audioOnly: boolean;
}

const KEY = 'voicestudio.reader.listening';
export const DEFAULT_LISTENING: ListeningPrefs = {
  soundscape: 'off',
  soundscapeVolume: 35,
  soundscapeWithVoice: true,
  audioOnly: false,
};

export function sanitizeListening(value: unknown): ListeningPrefs {
  const raw = (value && typeof value === 'object' ? value : {}) as Partial<
    Record<keyof ListeningPrefs, unknown>
  >;
  const volume =
    typeof raw.soundscapeVolume === 'number' && Number.isFinite(raw.soundscapeVolume)
      ? Math.round(Math.min(100, Math.max(0, raw.soundscapeVolume)))
      : DEFAULT_LISTENING.soundscapeVolume;
  return {
    soundscape:
      raw.soundscape === 'auto' || SOUNDSCAPES.includes(raw.soundscape as SoundscapeId)
        ? (raw.soundscape as SoundscapeId | 'auto')
        : 'off',
    soundscapeVolume: volume,
    soundscapeWithVoice:
      typeof raw.soundscapeWithVoice === 'boolean'
        ? raw.soundscapeWithVoice
        : DEFAULT_LISTENING.soundscapeWithVoice,
    audioOnly: raw.audioOnly === true,
  };
}

function read(): ListeningPrefs {
  try {
    return sanitizeListening(JSON.parse(localStorage.getItem(KEY) ?? '{}'));
  } catch {
    return DEFAULT_LISTENING;
  }
}

let current = typeof localStorage === 'undefined' ? DEFAULT_LISTENING : read();
const listeners = new Set<() => void>();

export function listeningPrefs(): ListeningPrefs {
  return current;
}

export function setListeningPrefs(patch: Partial<ListeningPrefs>) {
  current = sanitizeListening({ ...current, ...patch });
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* Preferences stay for this session. */
  }
  listeners.forEach((listener) => listener());
}

export function subscribeListening(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function useListeningPrefs(): ListeningPrefs {
  return useSyncExternalStore(subscribeListening, listeningPrefs, listeningPrefs);
}
