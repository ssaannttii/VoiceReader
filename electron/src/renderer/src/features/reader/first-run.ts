/**
 * First run: a sample document for an empty library, a one-time "choose your voice" card per
 * language, and one-time reading tips. What this device has already shown lives in localStorage.
 */
import { useSyncExternalStore } from 'react';
import type { ReaderVoice } from './reader-api';
import { filterVoices, languageKey } from './voice-picker';

/** Reading tips, in the order they are shown (one at a time). */
export const TIPS = ['tap', 'press', 'menu'] as const;
export type Tip = (typeof TIPS)[number];

export interface FirstRunState {
  /** Tips already shown and dismissed (or acted on). */
  tips: Tip[];
  /** Language keys whose "choose your voice" card was already shown. */
  voiceAsked: string[];
}

const KEY = 'voicestudio.reader.firstRun';
const EMPTY: FirstRunState = { tips: [], voiceAsked: [] };

/** Valid state from anything stored (old versions, hand edits). */
export function sanitizeFirstRun(value: unknown): FirstRunState {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const tips = Array.isArray(raw.tips)
    ? TIPS.filter((tip) => (raw.tips as unknown[]).includes(tip))
    : [];
  const voiceAsked = Array.isArray(raw.voiceAsked)
    ? [...new Set(raw.voiceAsked.filter((item): item is string => typeof item === 'string'))]
    : [];
  return { tips, voiceAsked };
}

function read(): FirstRunState {
  try {
    return sanitizeFirstRun(JSON.parse(localStorage.getItem(KEY) ?? '{}'));
  } catch {
    return EMPTY;
  }
}

let current = read();
const listeners = new Set<() => void>();

function save(next: FirstRunState): void {
  current = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* Shown again next session at worst. */
  }
  listeners.forEach((listener) => listener());
}

export function firstRunState(): FirstRunState {
  return current;
}

export function markTip(tip: Tip): void {
  if (!current.tips.includes(tip)) save({ ...current, tips: [...current.tips, tip] });
}

export function markVoiceAsked(language: string): void {
  const key = languageKey(language);
  if (key && !current.voiceAsked.includes(key))
    save({ ...current, voiceAsked: [...current.voiceAsked, key] });
}

/** Test hook: forget everything shown. */
export function resetFirstRun(): void {
  save(EMPTY);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useFirstRun(): FirstRunState {
  return useSyncExternalStore(subscribe, firstRunState, firstRunState);
}

/** The next tip this device has not seen, or null. */
export function nextTip(state: FirstRunState): Tip | null {
  return TIPS.find((tip) => !state.tips.includes(tip)) ?? null;
}

/**
 * Whether to offer choosing a voice for this document's language: it uses the automatic voice,
 * its language has no default voice yet, there is a real choice (two or more voices speak it)
 * and this device has not asked before.
 */
export function shouldAskVoice({
  state,
  language,
  voiceId,
  defaults,
  voices,
}: {
  state: FirstRunState;
  language: string | null | undefined;
  voiceId: string | null | undefined;
  defaults: Record<string, string> | undefined;
  voices: readonly ReaderVoice[] | undefined;
}): boolean {
  const key = languageKey(language);
  if (!key || voiceId || !defaults || !voices) return false;
  if (state.voiceAsked.includes(key)) return false;
  if (Object.keys(defaults).some((lang) => languageKey(lang) === key)) return false;
  return filterVoices(voices, key, '').length >= 2;
}

/** Language for the sample document: the UI's ("pt-BR" → "pt"). */
export function sampleLanguage(uiLanguage: string | undefined): string | undefined {
  return languageKey(uiLanguage) || undefined;
}
