/**
 * Small haptic cues for Reader gestures (Android Chrome; a no-op elsewhere).
 * `tick` for selections, snaps and toggles; `confirm` when an action commits.
 * Respects the reader's "haptics" preference and reduced motion.
 */
const KEY = 'reader-haptics';

function enabled(): boolean {
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return false;
  if (
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  )
    return false;
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

export function hapticsOn(): boolean {
  return enabled();
}

/** The device can vibrate at all (decides whether the setting is shown). */
export function hapticsSupported(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
}

/** The stored preference, independent of device support and reduced motion. */
export function hapticsPref(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setHaptics(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {
    // A blocked store keeps the default (on).
  }
}

export function tick() {
  if (enabled()) navigator.vibrate(8);
}

export function confirm() {
  if (enabled()) navigator.vibrate([10, 40, 14]);
}
