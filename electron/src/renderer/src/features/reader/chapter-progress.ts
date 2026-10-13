/** Per-chapter listening state for the chapters sheet (pure). */
import type { ReaderChapter } from './reader-api';

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
