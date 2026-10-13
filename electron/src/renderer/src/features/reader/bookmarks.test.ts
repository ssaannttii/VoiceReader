import { describe, expect, it } from 'vitest';
import {
  bookmarkedSegments,
  bookmarkSnippet,
  exportFileName,
  formatRelative,
  groupBookmarks,
  relativeParts,
} from './bookmarks';
import type { ReaderBookmark } from './reader-api';
import { chapterStates } from './chapter-progress';
import { addPages, MAX_SCAN_PAGES, moveItem } from './scan-pages';

const mark = (id: string, segment: number, created_at = 0): ReaderBookmark => ({
  id,
  segment,
  word: null,
  note: null,
  created_at,
});

describe('groupBookmarks', () => {
  const chapters = [
    { title: 'Uno', segment: 2 },
    { title: 'Dos', segment: 10 },
  ];

  it('groups by chapter in reading order', () => {
    const groups = groupBookmarks(
      [mark('c', 12), mark('a', 0), mark('b', 3), mark('d', 4)],
      chapters,
    );
    expect(groups.map((group) => [group.title, group.items.map((item) => item.id)])).toEqual([
      [null, ['a']],
      ['Uno', ['b', 'd']],
      ['Dos', ['c']],
    ]);
  });

  it('keeps one untitled group without chapters', () => {
    const groups = groupBookmarks([mark('b', 5, 2), mark('a', 5, 1)], []);
    expect(groups).toHaveLength(1);
    expect(groups[0].chapter).toBe(-1);
    expect(groups[0].items.map((item) => item.id)).toEqual(['a', 'b']);
  });
});

describe('bookmarkSnippet', () => {
  it('collapses whitespace and keeps short text', () => {
    expect(bookmarkSnippet('  Una   frase\ncorta. ')).toBe('Una frase corta.');
  });

  it('cuts long text at a word boundary', () => {
    const text = 'palabra '.repeat(40);
    const snippet = bookmarkSnippet(text, 50);
    expect(snippet.endsWith('palabra…')).toBe(true);
    expect(snippet.length).toBeLessThanOrEqual(51);
  });
});

describe('relative dates', () => {
  it('picks the largest whole unit', () => {
    expect(relativeParts(0, 30)).toBeNull();
    expect(relativeParts(0, 90)).toEqual({ value: -1, unit: 'minute' });
    expect(relativeParts(0, 7199)).toEqual({ value: -1, unit: 'hour' });
    expect(relativeParts(0, 3 * 86400)).toEqual({ value: -3, unit: 'day' });
    expect(relativeParts(0, 400 * 86400)).toEqual({ value: -1, unit: 'year' });
  });

  it('formats in the UI language', () => {
    expect(formatRelative(0, 10, 'es', 'ahora mismo')).toBe('ahora mismo');
    expect(formatRelative(0, 86400, 'en', 'now')).toBe('yesterday');
    expect(formatRelative(0, 2 * 86400, 'es', 'now')).toBe('anteayer');
  });
});

describe('bookmark helpers', () => {
  it('collects bookmarked segments', () => {
    expect([...bookmarkedSegments([mark('a', 3), mark('b', 3), mark('c', 7)])]).toEqual([3, 7]);
    expect(bookmarkedSegments(undefined).size).toBe(0);
  });

  it('names the export file safely', () => {
    expect(exportFileName('Mi libro: "El fin"?')).toBe('Mi libro El fin - bookmarks.md');
    expect(exportFileName('  ')).toBe('Reader - bookmarks.md');
  });
});

describe('chapterStates', () => {
  const chapters = [
    { title: 'A', segment: 0 },
    { title: 'B', segment: 10 },
    { title: 'C', segment: 20 },
    { title: 'D', segment: 30 },
  ];

  it('marks listened, current, partial and unread chapters', () => {
    expect(chapterStates(chapters, 40, 12, 24)).toEqual([
      { kind: 'done' },
      { kind: 'current', percent: 30 },
      { kind: 'partial', percent: 50 },
      { kind: 'unread' },
    ]);
  });

  it('counts a chapter whose last sentence was reached as listened', () => {
    expect(chapterStates(chapters, 40, 0, 19)[1]).toEqual({ kind: 'done' });
    expect(chapterStates(chapters, 40, 39, 39)[3]).toEqual({ kind: 'current', percent: 100 });
  });

  it('without progress only the first chapter is current', () => {
    expect(chapterStates(chapters, 40, 0, 0).map((state) => state.kind)).toEqual([
      'current',
      'unread',
      'unread',
      'unread',
    ]);
  });
});

describe('scan pages', () => {
  it('moves pages within bounds', () => {
    expect(moveItem(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    expect(moveItem(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'c', 'b']);
    expect(moveItem(['a', 'b'], 1, 5)).toEqual(['a', 'b']);
    expect(moveItem(['a'], 3, 0)).toEqual(['a']);
  });

  it('caps a scan at the backend limit', () => {
    const full = Array.from({ length: MAX_SCAN_PAGES - 1 }, (_, i) => i);
    const { pages, dropped } = addPages(full, [100, 101, 102]);
    expect(pages).toHaveLength(MAX_SCAN_PAGES);
    expect(pages.at(-1)).toBe(100);
    expect(dropped).toBe(2);
  });
});
