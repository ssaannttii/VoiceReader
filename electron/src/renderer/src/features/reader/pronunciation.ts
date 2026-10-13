/** Pure helpers for the pronunciation sheet. */
import type { ReaderPronunciation, ReaderSegment, ReaderWord } from './reader-api';

const fold = (value: string) => value.trim().toLocaleLowerCase();

/** The entry a term already has: this language's first, then a global one. */
export function existingEntry(
  entries: readonly ReaderPronunciation[] | undefined,
  term: string,
  language: string | null,
): ReaderPronunciation | null {
  const key = fold(term);
  if (!key || !entries) return null;
  const matches = entries.filter((entry) => fold(entry.term) === key);
  return (
    matches.find((entry) => language && entry.language === language) ??
    matches.find((entry) => entry.language === '*') ??
    matches[0] ??
    null
  );
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * First segment (from `from`, wrapping) where `term` appears as a whole word,
 * case-insensitively; used to preview an entry opened from the list.
 */
export function findTerm(
  segments: readonly ReaderSegment[],
  term: string,
  from = 0,
): { segment: number; offset: number } | null {
  const clean = term.trim();
  if (!clean || !segments.length) return null;
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{M}\\p{N}])${escape(clean)}(?![\\p{L}\\p{M}\\p{N}])`,
    'iu',
  );
  const start = Math.min(Math.max(0, from), segments.length - 1);
  for (let step = 0; step < segments.length; step++) {
    const index = (start + step) % segments.length;
    const found = pattern.exec(segments[index].text);
    if (found) return { segment: index, offset: found.index };
  }
  return null;
}

/** Seconds of a rendered sentence to play around the word at `offset`. */
export function previewWindow(
  words: readonly ReaderWord[],
  offset: number,
  duration: number,
  pad = 1,
): { start: number; end: number } {
  const word =
    words.find((item) => offset >= item.c0 && offset < item.c1) ??
    words.find((item) => item.c0 >= offset);
  if (!word) return { start: 0, end: duration };
  return {
    start: Math.max(0, word.start - pad),
    end: Math.min(duration, word.end + pad),
  };
}
