/**
 * Reader Labs ("Laboratorio"): per-device experimental preferences
 * (localStorage). Only what the player needs to read lives here; the A/B
 * vote history is in labs-ab.ts.
 */
import { useSyncExternalStore } from 'react';
import type { ReaderVoiceChoice } from './reader-api';

export const VOICE_QUALITIES = ['normal', 'high'] as const;
export type VoiceQuality = (typeof VOICE_QUALITIES)[number];

/** OmniVoice sampling steps of "high" quality; "normal" keeps the engine default (16). */
export const HIGH_QUALITY_STEPS = 32;

export interface LabsPrefs {
  /** Sampling steps the player asks for (OmniVoice only; others ignore it). */
  voiceQuality: VoiceQuality;
  /** A/B: hide which variant is which (X / Y) until the vote. */
  blind: boolean;
  /** Background music composed on the PC (set up per document in the sound sheet). */
  music: boolean;
}

const KEY = 'voicestudio.reader.labs';
export const DEFAULT_LABS: LabsPrefs = { voiceQuality: 'normal', blind: true, music: false };

export function sanitizeLabs(value: unknown): LabsPrefs {
  const raw = (value && typeof value === 'object' ? value : {}) as Partial<
    Record<keyof LabsPrefs, unknown>
  >;
  return {
    voiceQuality: VOICE_QUALITIES.includes(raw.voiceQuality as VoiceQuality)
      ? (raw.voiceQuality as VoiceQuality)
      : DEFAULT_LABS.voiceQuality,
    blind: typeof raw.blind === 'boolean' ? raw.blind : DEFAULT_LABS.blind,
    music: raw.music === true,
  };
}

/** `num_step` for a quality; undefined keeps the request (and its cache key) as before. */
export function qualitySteps(quality: VoiceQuality): number | undefined {
  return quality === 'high' ? HIGH_QUALITY_STEPS : undefined;
}

function read(): LabsPrefs {
  try {
    return sanitizeLabs(JSON.parse(localStorage.getItem(KEY) ?? '{}'));
  } catch {
    return DEFAULT_LABS;
  }
}

let current = typeof localStorage === 'undefined' ? DEFAULT_LABS : read();
const listeners = new Set<() => void>();

export function labsPrefs(): LabsPrefs {
  return current;
}

export function setLabsPrefs(patch: Partial<LabsPrefs>): void {
  current = sanitizeLabs({ ...current, ...patch });
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* Preferences stay for this session. */
  }
  listeners.forEach((listener) => listener());
}

export function subscribeLabs(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function useLabsPrefs(): LabsPrefs {
  return useSyncExternalStore(subscribeLabs, labsPrefs, labsPrefs);
}

/** The player's render request with this device's quality applied (the one Labs hook). */
export function withLabsQuality(choice: ReaderVoiceChoice): ReaderVoiceChoice {
  const steps = qualitySteps(current.voiceQuality);
  return steps === undefined ? choice : { ...choice, num_step: steps };
}
