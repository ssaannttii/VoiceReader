/** Pure helpers for the bookmarks sheet: chapter grouping, snippets and dates. */
import type { ReaderBookmark, ReaderChapter, ReaderSegment } from './reader-api';
import { chapterIndexAt } from './reader-text';

export interface BookmarkGroup {
  /** Chapter index, or -1 before the first chapter / without chapters. */
  chapter: number;
  title: string | null;
  items: ReaderBookmark[];
}

/** Bookmarks in reading order, grouped by the chapter that contains them. */
export function groupBookmarks(
  bookmarks: readonly ReaderBookmark[],
  chapters: readonly ReaderChapter[],
): BookmarkGroup[] {
  const sorted = [...bookmarks].sort(
    (a, b) =>
      a.segment - b.segment || (a.word ?? -1) - (b.word ?? -1) || a.created_at - b.created_at,
  );
  const groups: BookmarkGroup[] = [];
  for (const mark of sorted) {
    const index = chapterIndexAt(chapters, mark.segment);
    let group = groups[groups.length - 1];
    if (!group || group.chapter !== index) {
      group = { chapter: index, title: index >= 0 ? chapters[index].title : null, items: [] };
      groups.push(group);
    }
    group.items.push(mark);
  }
  return groups;
}

/**
 * A short excerpt of the bookmarked sentence: whitespace collapsed, cut at a
 * word boundary near `max` characters with an ellipsis.
 */
export function bookmarkSnippet(text: string, max = 140): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const space = cut.lastIndexOf(' ');
  const head = space > max * 0.6 ? cut.slice(0, space) : cut;
  return `${head.replace(/[\s,;:.\-–—]+$/u, '')}…`;
}

/** Sentence text of a bookmark (empty when the segment no longer exists). */
export function bookmarkText(segments: readonly ReaderSegment[], segment: number): string {
  return segments[segment]?.text ?? '';
}

/** Set of bookmarked segments, for the marks in the reading view. */
export function bookmarkedSegments(bookmarks: readonly ReaderBookmark[] | undefined): Set<number> {
  return new Set((bookmarks ?? []).map((mark) => mark.segment));
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 86400],
  ['month', 30 * 86400],
  ['week', 7 * 86400],
  ['day', 86400],
  ['hour', 3600],
  ['minute', 60],
];

/** Largest whole unit for a time `then` relative to `now` (unix seconds); "now" under a minute. */
export function relativeParts(
  then: number,
  now: number,
): { value: number; unit: Intl.RelativeTimeFormatUnit } | null {
  const delta = then - now;
  for (const [unit, seconds] of UNITS) {
    // Whole units elapsed: 90 s is "1 minute ago", like a clock would say.
    if (Math.abs(delta) >= seconds) return { value: Math.trunc(delta / seconds), unit };
  }
  return null;
}

/** "hace 3 días" / "3 days ago" in `locale`; `justNow` under a minute. */
export function formatRelative(then: number, now: number, locale: string, justNow: string): string {
  const parts = relativeParts(then, now);
  if (!parts) return justNow;
  try {
    return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(parts.value, parts.unit);
  } catch {
    return new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(parts.value, parts.unit);
  }
}

/** Name for the exported Markdown file. */
export function exportFileName(title: string): string {
  const printable = Array.from(title, (char) => (char.charCodeAt(0) < 32 ? ' ' : char)).join('');
  const base = printable
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .trim();
  return `${base || 'Reader'} - bookmarks.md`;
}
