/**
 * Motion of the audio-only orb, driven by the reading pace instead of audio
 * analysis: every word boundary from the highlight channel gives a pulse sized
 * by the word and timed by its duration, plus gentle noise. No Web Audio
 * touches the reading audio (that would break background playback).
 */
import type { ReaderWord } from './reader-api';

/** A word's pulse: longer words push a little harder (0.45–1). */
export function wordStrength(word: Pick<ReaderWord, 'w'> | null | undefined): number {
  const letters = word?.w.replace(/[^\p{L}\p{N}]/gu, '').length ?? 0;
  if (!letters) return 0.3;
  return Math.min(1, 0.45 + letters * 0.06);
}

/** Seconds a word lasts at the current speed (at least a frame or two). */
export function wordSeconds(word: Pick<ReaderWord, 'start' | 'end'>, rate: number): number {
  return Math.max(0.05, (word.end - word.start) / Math.max(0.1, rate));
}

/**
 * Envelope of one word pulse `t` seconds after it began: a quick rise over the
 * first fifth, then a decay that lasts about the word's length.
 */
export function pulseEnvelope(t: number, seconds: number): number {
  if (t < 0) return 0;
  const attack = Math.min(0.08, seconds * 0.2);
  if (t < attack) return t / attack;
  return Math.exp(-(t - attack) / Math.max(0.06, seconds * 0.9));
}

/** Words per second from a sentence's timings; 2.5 when unknown. */
export function wordsPerSecond(words: readonly Pick<ReaderWord, 'start' | 'end'>[], rate: number) {
  if (words.length < 2) return 2.5;
  const span = words[words.length - 1].end - words[0].start;
  if (!(span > 0)) return 2.5;
  return (words.length / span) * Math.max(0.1, rate);
}

/** How fast the orb's outline flows: follows the speaking pace, within calm bounds. */
export function flowSpeed(wps: number): number {
  return Math.min(1.6, Math.max(0.35, wps / 2.5));
}

/** Frame-rate independent exponential approach of `current` to `target`. */
export function approach(current: number, target: number, dt: number, tau: number): number {
  if (tau <= 0) return target;
  return target + (current - target) * Math.exp(-Math.max(0, dt) / tau);
}

/** Smooth 1-D value noise in [-1, 1] (hash lattice with smoothstep). */
export function noise1(x: number, seed = 0): number {
  const hash = (n: number) => {
    const s = Math.sin(n * 127.1 + seed * 311.7) * 43758.5453;
    return (s - Math.floor(s)) * 2 - 1;
  };
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return hash(i) * (1 - u) + hash(i + 1) * u;
}

/**
 * Radius multiplier of the outline at `angle`: a breathing base, the speech
 * energy, and three slow harmonics whose phase flows with `phase`.
 */
export function orbOutline(angle: number, phase: number, energy: number, calm: number): number {
  const wobble =
    0.035 * Math.sin(2 * angle + phase * 1.3) +
    0.025 * Math.sin(3 * angle - phase * 0.9 + 1.7) +
    0.015 * Math.sin(5 * angle + phase * 2.1 + 0.4);
  return 1 + energy * 0.12 + wobble * (calm + energy * 1.6);
}

/** Target energy for the current state: silent when paused, else the word pulse. */
export function targetEnergy(playing: boolean, pulse: number, strength: number): number {
  return playing ? Math.min(1, pulse * strength) : 0;
}

/** The orb is still: paused and settled close enough to stop drawing. */
export function settled(playing: boolean, energy: number, calm: number, restCalm: number) {
  return !playing && energy < 0.002 && Math.abs(calm - restCalm) < 0.002;
}
