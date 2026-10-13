/** Per-chapter listening state for the chapters sheet (pure). */
import type { ReaderChapter } from './reader-api';
import { estimateSegmentSeconds } from './reader-text';

export type ChapterState =
  | { kind: 'current'; percent: number }
  | { kind: 'done' }
  | { kind: 'partial'; percent: number }
  | { kind: 'unread' };

/**
 * State of every chapter from the current segment and the furthest segment
 * reached: the one being read is "current", chapters the furthest point has
 * gone past are "done", the one it stopped inside shows its percentage.
 * Chapters are in reading order, as the backend emits them.
 */
export function chapterStates(
  chapters: readonly ReaderChapter[],
  segmentCount: number,
  current: number,
  furthest: number,
): ChapterState[] {
  const reached = Math.max(furthest, current);
  return chapters.map((chapter, index) => {
    const start = chapter.segment;
    const end = Math.max(start + 1, chapters[index + 1]?.segment ?? segmentCount);
    const percentAt = (segment: number) =>
      Math.min(100, Math.max(0, Math.round(((segment - start + 1) / (end - start)) * 100)));
    if (current >= start && current < end) return { kind: 'current', percent: percentAt(current) };
    if (reached >= end) return { kind: 'done' };
    if (reached >= start) {
      const percent = percentAt(reached);
      return percent >= 100 ? { kind: 'done' } : { kind: 'partial', percent };
    }
    return { kind: 'unread' };
  });
}

/** Length of every chapter in 1x seconds, from `secondsAt(segment)` (document start of a segment). */
export function chapterSeconds(
  chapters: readonly ReaderChapter[],
  segmentCount: number,
  secondsAt: (segment: number) => number,
): number[] {
  return chapters.map((chapter, index) => {
    const end = Math.max(chapter.segment, chapters[index + 1]?.segment ?? segmentCount);
    return Math.max(0, secondsAt(end) - secondsAt(chapter.segment));
  });
}

/** `secondsAt` from text-length estimates, for a document that is not in the player. */
export function estimatedSecondsAt(
  segments: readonly { text: string }[],
): (segment: number) => number {
  const prefix = new Float64Array(segments.length + 1);
  segments.forEach((segment, index) => {
    prefix[index + 1] = prefix[index] + estimateSegmentSeconds(segment.text);
  });
  return (segment) => prefix[Math.min(Math.max(0, segment), segments.length)] ?? 0;
}
