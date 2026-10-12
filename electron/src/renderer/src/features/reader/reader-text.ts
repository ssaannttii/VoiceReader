/** Pure helpers for the Reader: text layout, timing lookups, and estimates. */
import type { ReaderChapter, ReaderSegment, ReaderWord } from './reader-api';

/** Characters spoken per second at 1x; mirrors the backend's `est_duration_s`. */
export const CHARS_PER_SECOND = 15;

export interface ReaderBlock {
  key: string;
  kind: 'h' | 'p';
  segments: ReaderSegment[];
}

/**
 * Group sentence segments into rendered blocks: consecutive body sentences
 * sharing a `para` form one paragraph; every heading is its own block.
 */
export function groupBlocks(segments: readonly ReaderSegment[]): ReaderBlock[] {
  const blocks: ReaderBlock[] = [];
  let current: ReaderBlock | null = null;
  for (const segment of segments) {
    const kind = segment.kind === 'h' ? 'h' : 'p';
    if (
      !current ||
      kind === 'h' ||
      current.kind === 'h' ||
      current.segments[0].para !== segment.para
    ) {
      current = { key: `b${segment.i}`, kind, segments: [] };
      blocks.push(current);
    }
    current.segments.push(segment);
  }
  return blocks;
}

/**
 * Index of the word being spoken at `time` seconds: the last word whose
 * start is at or before `time` (so pauses keep the previous word lit), or -1
 * before the first word starts. Binary search; `words` is in start order.
 */
export function wordIndexAt(words: readonly ReaderWord[], time: number): number {
  let low = 0;
  let high = words.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (words[mid].start <= time) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

/** Split `text` into plain runs and word runs using the render's char offsets. */
export function splitWords(
  text: string,
  words: readonly ReaderWord[],
): Array<{ text: string; word: number | null }> {
  const parts: Array<{ text: string; word: number | null }> = [];
  let cursor = 0;
  words.forEach((word, index) => {
    const c0 = Math.max(cursor, Math.min(text.length, word.c0));
    const c1 = Math.max(c0, Math.min(text.length, word.c1));
    if (c0 > cursor) parts.push({ text: text.slice(cursor, c0), word: null });
    if (c1 > c0) parts.push({ text: text.slice(c0, c1), word: index });
    cursor = c1;
  });
  if (cursor < text.length) parts.push({ text: text.slice(cursor), word: null });
  return parts;
}

/** Estimated seconds for a segment at 1x before its real duration is known. */
export function estimateSegmentSeconds(text: string): number {
  return Math.max(0.6, text.length / CHARS_PER_SECOND);
}

/** Index of the chapter containing `segment`, or -1 when there are no chapters before it. */
export function chapterIndexAt(chapters: readonly ReaderChapter[], segment: number): number {
  let found = -1;
  chapters.forEach((chapter, index) => {
    if (chapter.segment <= segment) found = index;
  });
  return found;
}

/** First segment after the chapter that contains `segment` (document end when last). */
export function chapterEndSegment(
  chapters: readonly ReaderChapter[],
  segment: number,
  segmentCount: number,
): number {
  const next = chapters
    .map((chapter) => chapter.segment)
    .filter((start) => start > segment)
    .sort((a, b) => a - b)[0];
  return next ?? segmentCount;
}

/** `m:ss` or `h:mm:ss`. */
export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.round(Number.isFinite(seconds) ? seconds : 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

/** Whole minutes left, never below 1 while anything remains. */
export function minutesLeft(seconds: number): number {
  return seconds <= 0 ? 0 : Math.max(1, Math.round(seconds / 60));
}

/** Stable warm gradient for documents without a cover. */
export function coverGradient(seed: string): string {
  let hash = 0;
  for (let index = 0; index < seed.length; index++) hash = (hash * 31 + seed.charCodeAt(index)) | 0;
  const hue = Math.abs(hash) % 360;
  const second = (hue + 38 + (Math.abs(hash >> 8) % 50)) % 360;
  return `linear-gradient(140deg, oklch(0.62 0.15 ${hue}), oklch(0.42 0.13 ${second}))`;
}

/** First visible letter of a title for the generated cover. */
export function coverInitial(title: string): string {
  const match = /[\p{L}\p{N}]/u.exec(title);
  return (match?.[0] ?? '•').toLocaleUpperCase();
}

export const SPEED_MIN = 0.5;
export const SPEED_MAX = 3;
export const SPEED_PRESETS = [0.8, 1, 1.2, 1.5, 2, 2.5] as const;

/** Clamp to 0.5–3.0 on the 0.1 grid. */
export function clampSpeed(value: number): number {
  const rounded = Math.round(value * 10) / 10;
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, Number.isFinite(rounded) ? rounded : 1));
}

export function formatSpeed(value: number): string {
  return `${clampSpeed(value).toFixed(1)}×`;
}
