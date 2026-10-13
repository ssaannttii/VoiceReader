/** Library ordering and filtering (pure), plus the per-device sort choice. */
import { useSyncExternalStore } from 'react';
import type { ReaderDocumentSummary } from './reader-api';
import { searchKey } from './reader-chrome';
import { minutesLeft } from './reader-text';

export const LIBRARY_SORTS = [
  'recent',
  'least_recent',
  'progress',
  'title',
  'title_desc',
  'added',
  'oldest',
] as const;
export const LIBRARY_FILTERS = ['library', 'archived', 'finished'] as const;
export type LibrarySort = (typeof LIBRARY_SORTS)[number];
export type LibraryFilter = (typeof LIBRARY_FILTERS)[number];

type Doc = Pick<
  ReaderDocumentSummary,
  | 'title'
  | 'segment_count'
  | 'position_segment'
  | 'progress'
  | 'created_at'
  | 'last_opened_at'
  | 'archived'
  | 'completed'
  | 'import_status'
>;

type SourceDoc = Pick<ReaderDocumentSummary, 'source_type' | 'source_name' | 'has_cover'>;

/** Finished: the server's `completed` flag when it has one, else read to the end. */
export function isFinished(doc: Doc): boolean {
  if (typeof doc.completed === 'boolean') return doc.completed;
  return doc.segment_count > 0 && doc.position_segment >= doc.segment_count - 1;
}

/** Ready to open (servers without background imports omit the status). */
export function isReady(doc: Pick<Doc, 'import_status'>): boolean {
  return !doc.import_status || doc.import_status === 'ready';
}

export function matchesFilter(doc: Doc, filter: LibraryFilter): boolean {
  if (filter === 'archived') return doc.archived === true;
  if (doc.archived) return false;
  return filter === 'finished' ? isReady(doc) && isFinished(doc) : true;
}

const recency = (doc: Doc) => doc.last_opened_at ?? doc.created_at;
const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

const comparators: Record<LibrarySort, (a: Doc, b: Doc) => number> = {
  recent: (a, b) => recency(b) - recency(a),
  least_recent: (a, b) => recency(a) - recency(b),
  // Furthest along first; finished books after everything still in progress.
  progress: (a, b) => Number(isFinished(a)) - Number(isFinished(b)) || b.progress - a.progress,
  title: (a, b) => collator.compare(a.title, b.title),
  title_desc: (a, b) => collator.compare(b.title, a.title),
  added: (a, b) => b.created_at - a.created_at,
  oldest: (a, b) => a.created_at - b.created_at,
};

/**
 * Filtered and sorted copy. Imports in flight (or failed) stay on top so a
 * new upload is always visible; ties fall back to recency.
 */
export function arrangeLibrary<T extends Doc>(
  docs: readonly T[],
  sort: LibrarySort,
  filter: LibraryFilter,
): T[] {
  const compare = comparators[sort];
  return docs
    .filter((doc) => matchesFilter(doc, filter))
    .sort(
      (a, b) => Number(isReady(a)) - Number(isReady(b)) || compare(a, b) || recency(b) - recency(a),
    );
}

/** Case- and accent-insensitive match on title, author and source. */
export function matchesQuery(
  doc: Pick<ReaderDocumentSummary, 'title' | 'author' | 'source_name'>,
  query: string,
): boolean {
  const needle = searchKey(query.trim());
  if (!needle) return true;
  return searchKey(`${doc.title} ${doc.author ?? ''} ${doc.source_name ?? ''}`).includes(needle);
}

const BOOK_FILES = /\.(epub|pdf|docx?|mobi|azw3?|fb2)$/i;

/** Cover proportions: books are 2:3 portraits, articles, notes and scans are square. */
export function coverShape(doc: SourceDoc): 'book' | 'square' {
  if (doc.has_cover) return 'book';
  return doc.source_type === 'file' && BOOK_FILES.test(doc.source_name ?? '') ? 'book' : 'square';
}

export type CoverArt = 'book' | 'pdf' | 'web' | 'text' | 'scan' | 'file';

/** Which generated artwork a document without a real cover gets. */
export function coverArt(doc: SourceDoc): CoverArt {
  if (doc.source_type === 'url') return 'web';
  if (doc.source_type === 'scan') return 'scan';
  if (doc.source_type === 'text') return 'text';
  if (/\.pdf$/i.test(doc.source_name ?? '')) return 'pdf';
  return coverShape(doc) === 'book' ? 'book' : 'file';
}

/** Never opened and not yet finished: shows the "new" dot. */
export function isUnread(doc: Doc): boolean {
  return (
    doc.last_opened_at == null && doc.position_segment <= 0 && isReady(doc) && !isFinished(doc)
  );
}

export type RowStatus =
  | { kind: 'finished' }
  | { kind: 'new'; minutes: number }
  | { kind: 'progress'; percent: number; minutes: number };

/** The status line under a row title: "12 min", "17 % · 25 min left" or finished. */
export function rowStatus(doc: Doc & Pick<ReaderDocumentSummary, 'est_duration_s'>): RowStatus {
  if (isFinished(doc)) return { kind: 'finished' };
  if (doc.position_segment <= 0) return { kind: 'new', minutes: minutesLeft(doc.est_duration_s) };
  const progress = Math.min(1, Math.max(0, doc.progress));
  return {
    kind: 'progress',
    // 0 % reads as "not started" and 100 % as finished, so clamp inside.
    percent: Math.min(99, Math.max(1, Math.round(progress * 100))),
    minutes: minutesLeft(doc.est_duration_s * (1 - progress)),
  };
}

/** Long durations read as hours: 1560 min → 26 h 0 min; under an hour stays in minutes. */
export function splitMinutes(total: number): { hours: number; minutes: number } {
  if (total < 60) return { hours: 0, minutes: total };
  return { hours: Math.floor(total / 60), minutes: total % 60 };
}

const KEY = 'voicestudio.reader.library';

export function parseLibrarySort(raw: unknown): LibrarySort {
  const sort = raw && typeof raw === 'object' ? (raw as { sort?: unknown }).sort : undefined;
  return LIBRARY_SORTS.includes(sort as LibrarySort) ? (sort as LibrarySort) : 'recent';
}

function read(): LibrarySort {
  try {
    return parseLibrarySort(JSON.parse(localStorage.getItem(KEY) ?? '{}'));
  } catch {
    return 'recent';
  }
}

let current = read();
const listeners = new Set<() => void>();

export function setLibrarySort(sort: LibrarySort): void {
  current = sort;
  try {
    localStorage.setItem(KEY, JSON.stringify({ sort }));
  } catch {
    /* Kept for this session. */
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useLibrarySort(): LibrarySort {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => current,
  );
}
