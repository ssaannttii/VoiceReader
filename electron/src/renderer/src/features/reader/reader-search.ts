/**
 * In-document search: case- and accent-insensitive matching over a
 * document's sentences. The folded text is built once per document so each
 * query is a plain `indexOf` per segment (15,000 segments in a few ms).
 */
import type { ReaderSegment } from './reader-api';

const MARKS = /\p{M}/gu;
const LOGOGRAPHIC = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** Fold one string for matching: decompose, drop combining marks, lowercase. */
export function foldText(value: string): string {
  return value.normalize('NFD').replace(MARKS, '').toLowerCase();
}

interface IndexedSegment {
  segment: number;
  text: string;
  folded: string;
  /** `map[i]` = offset in `text` of folded char `i`; absent when lengths match 1:1. */
  map: Int32Array | null;
}

export interface SearchIndex {
  segments: IndexedSegment[];
}

/**
 * Fold char by char, recording where each folded char came from. Only used
 * for the rare text whose folded length differs (decomposed input, ligatures,
 * "İ"), so offsets still point at the original display text.
 */
function foldWithMap(text: string): { folded: string; map: Int32Array } {
  let folded = '';
  const offsets: number[] = [];
  let offset = 0;
  for (const char of text) {
    const piece = foldText(char);
    for (let i = 0; i < piece.length; i++) offsets.push(offset);
    folded += piece;
    offset += char.length;
  }
  offsets.push(offset);
  return { folded, map: Int32Array.from(offsets) };
}

export function buildSearchIndex(segments: readonly ReaderSegment[]): SearchIndex {
  return {
    segments: segments.map(({ i, text }) => {
      const folded = foldText(text);
      if (folded.length === text.length) return { segment: i, text, folded, map: null };
      return { segment: i, text, ...foldWithMap(text) };
    }),
  };
}

const indexCache = new WeakMap<readonly ReaderSegment[], SearchIndex>();

/** Index for a document's segments, built on first use and kept while they live. */
export function searchIndexFor(segments: readonly ReaderSegment[]): SearchIndex {
  let index = indexCache.get(segments);
  if (!index) {
    index = buildSearchIndex(segments);
    indexCache.set(segments, index);
  }
  return index;
}

export interface SearchHit {
  segment: number;
  /** Match offsets in the segment's display text. */
  start: number;
  end: number;
}

export interface SearchResult {
  hits: SearchHit[];
  /** Segments that match, including those past the result cap. */
  total: number;
}

export const SEARCH_LIMIT = 200;

/** Collapse whitespace and fold; '' when the query is too short to be useful. */
export function prepareQuery(query: string): string {
  const folded = foldText(query.replace(/\s+/g, ' ').trim());
  // One letter matches nearly every sentence; a single ideograph or syllable is a word.
  if (folded.length < 2 && !LOGOGRAPHIC.test(folded)) return '';
  return folded;
}

/** First match per segment, in document order, capped at `limit`. */
export function searchDocument(
  index: SearchIndex,
  query: string,
  limit = SEARCH_LIMIT,
): SearchResult {
  const needle = prepareQuery(query);
  const hits: SearchHit[] = [];
  let total = 0;
  if (!needle) return { hits, total };
  for (const entry of index.segments) {
    const at = entry.folded.indexOf(needle);
    if (at < 0) continue;
    total++;
    if (hits.length >= limit) continue;
    const end = at + needle.length;
    hits.push(
      entry.map
        ? { segment: entry.segment, start: entry.map[at], end: entry.map[end] }
        : { segment: entry.segment, start: at, end },
    );
  }
  return { hits, total };
}

export interface Snippet {
  before: string;
  match: string;
  after: string;
}

/**
 * Context around a match, cut at word boundaries, with ellipses where the
 * sentence continues.
 */
export function snippetFor(text: string, start: number, end: number, radius = 48): Snippet {
  let from = Math.max(0, start - radius);
  let to = Math.min(text.length, end + radius);
  if (from > 0) {
    const space = text.indexOf(' ', from);
    if (space >= 0 && space < start) from = space + 1;
  }
  if (to < text.length) {
    const space = text.lastIndexOf(' ', to);
    if (space >= end) to = space;
  }
  return {
    before: (from > 0 ? '…' : '') + text.slice(from, start),
    match: text.slice(start, end),
    after: text.slice(end, to) + (to < text.length ? '…' : ''),
  };
}
