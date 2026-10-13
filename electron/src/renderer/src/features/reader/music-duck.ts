/**
 * How present the background music is (0–1, follows its fades), so the
 * ambience can sit ~3 dB lower under it. A tiny store with no dependencies:
 * the soundscape player reads it without importing the music controller.
 */

/** Ambience gain under fully present music (−3 dB). */
export const MUSIC_AMBIENCE_DUCK = 10 ** (-3 / 20);

let presence = 0;
const listeners = new Set<() => void>();

export function musicPresence(): number {
  return presence;
}

export function setMusicPresence(value: number) {
  const next = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  // Small steps are skipped (fewer volume writes), but the ends are always reached.
  if (next === presence) return;
  if (Math.abs(next - presence) < 0.02 && next !== 0 && next !== 1) return;
  presence = next;
  listeners.forEach((listener) => listener());
}

export function subscribeMusicPresence(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** Factor for the ambience and soundscape volume (1 without music). */
export function ambienceDuckGain(): number {
  return 1 - (1 - MUSIC_AMBIENCE_DUCK) * presence;
}
