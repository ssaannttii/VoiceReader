/**
 * Pure rules for the reading view's floating chrome (header + dock): when it
 * auto-hides, what a tap on the text does, the chapter-relative scrubber and
 * the generated voice avatars. Kept free of React and the DOM so it is tested.
 */
import type { ReaderChapter } from './reader-api';
import { chapterIndexAt, coverInitial } from './reader-text';

/** Uninterrupted playback before the chrome fades out. */
export const CHROME_HIDE_MS = 4000;
/** Accumulated user scroll that hides (down) or shows (up) the chrome. */
export const SCROLL_HIDE_PX = 56;
export const SCROLL_SHOW_PX = 24;

export interface ChromeInputs {
  /** "Hide controls while playing" preference. */
  enabled: boolean;
  /** This document is the one playing (not paused, idle, ended or failed). */
  playing: boolean;
  /** A sheet (or the pronunciation sheet) is open. */
  sheetOpen: boolean;
  /** Something needs the user's eyes: an error, the engine or the PC is down. */
  attention: boolean;
  /** Keyboard focus is inside the chrome. */
  focused: boolean;
  /** Audio-only mode has no text to give the screen to. */
  audioOnly: boolean;
}

/** The chrome may only disappear while this document plays undisturbed. */
export function canHideChrome(inputs: ChromeInputs): boolean {
  return (
    inputs.enabled &&
    inputs.playing &&
    !inputs.sheetOpen &&
    !inputs.attention &&
    !inputs.focused &&
    !inputs.audioOnly
  );
}

export interface ChromeState {
  hidden: boolean;
  /** Signed user scroll accumulated in the current direction (px, down > 0). */
  scroll: number;
}

export const CHROME_SHOWN: ChromeState = { hidden: false, scroll: 0 };

export type ChromeEvent =
  /** A single tap on the reading surface. */
  | { type: 'toggle' }
  /** Any other interaction (a seek, keys, the pointer in the chrome): show and restart the timer. */
  | { type: 'interact' }
  /** The idle timer ran out. */
  | { type: 'timeout' }
  /** A user (not follow) scroll by `dy` px. */
  | { type: 'scroll'; dy: number };

/**
 * Next chrome state. Whatever happens, the chrome is shown when it cannot hide
 * (paused, a sheet open, an error…); the timer is armed by the caller whenever
 * `canHide && !hidden`, and restarted on every event.
 */
export function reduceChrome(
  state: ChromeState,
  event: ChromeEvent,
  canHide: boolean,
): ChromeState {
  if (!canHide) return state.hidden || state.scroll ? CHROME_SHOWN : state;
  switch (event.type) {
    case 'toggle':
      return { hidden: !state.hidden, scroll: 0 };
    case 'interact':
      return state.hidden || state.scroll ? CHROME_SHOWN : state;
    case 'timeout':
      return state.hidden ? state : { hidden: true, scroll: 0 };
    case 'scroll': {
      if (!event.dy) return state;
      const sameWay = Math.sign(event.dy) === Math.sign(state.scroll);
      const scroll = (sameWay ? state.scroll : 0) + event.dy;
      if (scroll >= SCROLL_HIDE_PX) return { hidden: true, scroll: 0 };
      if (scroll <= -SCROLL_SHOW_PX) return { hidden: false, scroll: 0 };
      return { hidden: state.hidden, scroll };
    }
  }
}

/**
 * What one tap on the text does (the double tap of the "double tap to play"
 * preference is handled separately: it always plays from the sentence).
 * - Chrome hidden: the tap only brings the controls back (never seeks).
 * - "Double tap to play" on: a single tap toggles the controls.
 * - Otherwise a tap on a sentence seeks there; a tap beside the text toggles.
 */
export function tapOutcome({
  chromeHidden,
  doubleTap,
  onSentence,
}: {
  chromeHidden: boolean;
  doubleTap: boolean;
  onSentence: boolean;
}): 'toggle' | 'seek' {
  if (chromeHidden || doubleTap || !onSentence) return 'toggle';
  return 'seek';
}

/** Segment range `[start, end)` the scrubber spans: the current chapter, or the whole text. */
export interface ScrubRange {
  start: number;
  end: number;
  /** Chapter index, or -1 for the whole document (or the text before chapter one). */
  chapter: number;
  /** The range is a chapter (times are chapter-relative). */
  chaptered: boolean;
}

export function scrubRange(
  chapters: readonly ReaderChapter[],
  segmentCount: number,
  segment: number,
): ScrubRange {
  const count = Math.max(1, segmentCount);
  if (!chapters.length) return { start: 0, end: count, chapter: -1, chaptered: false };
  const index = chapterIndexAt(chapters, segment);
  const start = index < 0 ? 0 : Math.min(chapters[index].segment, count - 1);
  const next = index < 0 ? chapters[0].segment : (chapters[index + 1]?.segment ?? count);
  const end = Math.min(count, Math.max(start + 1, next));
  return { start, end, chapter: index, chaptered: true };
}

/** Left and right scrubber labels in seconds (already divided by the speed). */
export interface ScrubTimes {
  left: number;
  right: number;
  /** The right label is a remaining time ("−4:10") rather than a length. */
  rightIsRemaining: boolean;
  /** Whole-document time left. */
  remaining: number;
}

/**
 * Times for the scrubber labels. `elapsed` and `total` are document seconds at
 * 1x; `secondsAt(segment)` gives the document second where a segment starts.
 */
export function scrubTimes(
  range: ScrubRange,
  elapsed: number,
  total: number,
  rate: number,
  secondsAt: (segment: number) => number,
): ScrubTimes {
  const speed = rate > 0 ? rate : 1;
  const remaining = Math.max(0, total - elapsed) / speed;
  if (!range.chaptered)
    return { left: elapsed / speed, right: remaining, rightIsRemaining: true, remaining };
  const start = secondsAt(range.start);
  const length = Math.max(0, secondsAt(range.end) - start);
  const into = Math.min(length, Math.max(0, elapsed - start));
  return { left: into / speed, right: length / speed, rightIsRemaining: false, remaining };
}

/** Hours and minutes of a duration for "2 h 14 min left" (never 0 min while time remains). */
export function durationParts(seconds: number): { hours: number; minutes: number } {
  const value = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  if (value <= 0) return { hours: 0, minutes: 0 };
  const total = Math.max(1, Math.round(value / 60));
  return { hours: Math.floor(total / 60), minutes: total % 60 };
}

/** Within this distance (px) a scrubber drag sticks to the furthest-point mark… */
export const SNAP_PX = 12;
/** …until it is pulled this far away. */
export const SNAP_BREAK_PX = 24;

/** Whether a drag at `valuePx` sticks to the mark at `markPx` (with hysteresis). */
export function snapToMark(valuePx: number, markPx: number, snapped: boolean): boolean {
  const distance = Math.abs(valuePx - markPx);
  return snapped ? distance <= SNAP_BREAK_PX : distance <= SNAP_PX;
}

/** The source name unless it only repeats the title (an imported file named after the book). */
export function distinctSource(title: string, source: string | null | undefined): string | null {
  const key = (value: string) =>
    value
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '');
  if (!source?.trim()) return null;
  const head = key(title).slice(0, 12);
  return head && key(source).startsWith(head) ? null : source;
}

function hash(seed: string): number {
  let value = 2166136261;
  for (let index = 0; index < seed.length; index++) {
    value ^= seed.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

/** A voice's generated avatar: a stable two-stop gradient and the name's initial. */
export function voiceAvatar(
  seed: string,
  name: string,
): { initial: string; hue: number; background: string } {
  const value = hash(seed || name);
  const hue = value % 360;
  const second = (hue + 40 + ((value >>> 9) % 60)) % 360;
  return {
    initial: coverInitial(name),
    hue,
    background: `linear-gradient(135deg, oklch(0.64 0.13 ${hue}), oklch(0.46 0.14 ${second}))`,
  };
}
