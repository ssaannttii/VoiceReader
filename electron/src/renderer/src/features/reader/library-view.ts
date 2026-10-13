/** Library ordering and filtering (pure), plus the per-device sort choice. */
import { useSyncExternalStore } from 'react';
import type { ReaderDocumentSummary } from './reader-api';

export const LIBRARY_SORTS = ['recent', 'progress', 'title', 'added'] as const;
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
  // Furthest along first; finished books after everything still in progress.
  progress: (a, b) => Number(isFinished(a)) - Number(isFinished(b)) || b.progress - a.progress,
  title: (a, b) => collator.compare(a.title, b.title),
  added: (a, b) => b.created_at - a.created_at,
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
