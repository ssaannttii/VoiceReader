import { describe, expect, it } from 'vitest';
import type { ReaderDocumentSummary } from './reader-api';
import {
  arrangeLibrary,
  isFinished,
  isReady,
  matchesFilter,
  parseLibrarySort,
} from './library-view';

let next = 0;
function doc(patch: Partial<ReaderDocumentSummary> = {}): ReaderDocumentSummary {
  next++;
  return {
    id: `d${next}`,
    title: `Doc ${next}`,
    author: null,
    source_type: 'text',
    source_name: null,
    source_url: null,
    language: 'es',
    segment_count: 100,
    char_count: 1000,
    chapter_count: 0,
    has_cover: false,
    voice_id: null,
    engine: null,
    position_segment: 0,
    progress: 0,
    est_duration_s: 60,
    created_at: 1000,
    updated_at: 1000,
    last_opened_at: null,
    ...patch,
  };
}

describe('isFinished', () => {
  it('uses the server flag when present, else reading to the end', () => {
    expect(isFinished(doc({ position_segment: 99 }))).toBe(true);
    expect(isFinished(doc({ position_segment: 50 }))).toBe(false);
    expect(isFinished(doc({ position_segment: 99, completed: false }))).toBe(false);
    expect(isFinished(doc({ position_segment: 3, completed: true }))).toBe(true);
    expect(isFinished(doc({ segment_count: 0 }))).toBe(false);
  });
});

describe('isReady', () => {
  it('treats a missing status (older server) as ready', () => {
    expect(isReady({})).toBe(true);
    expect(isReady({ import_status: 'ready' })).toBe(true);
    expect(isReady({ import_status: 'importing' })).toBe(false);
    expect(isReady({ import_status: 'error' })).toBe(false);
  });
});

describe('matchesFilter', () => {
  it('splits library, archived and finished', () => {
    const active = doc();
    const archived = doc({ archived: true });
    const finished = doc({ completed: true });
    const finishedArchived = doc({ completed: true, archived: true });
    const docs = [active, archived, finished, finishedArchived];
    expect(docs.filter((item) => matchesFilter(item, 'library'))).toEqual([active, finished]);
    expect(docs.filter((item) => matchesFilter(item, 'archived'))).toEqual([
      archived,
      finishedArchived,
    ]);
    expect(docs.filter((item) => matchesFilter(item, 'finished'))).toEqual([finished]);
  });
});

describe('arrangeLibrary', () => {
  const a = doc({ title: 'beta', created_at: 30, last_opened_at: 100, progress: 0.2 });
  const b = doc({ title: 'Álgebra', created_at: 10, last_opened_at: 300, progress: 0.9 });
  const c = doc({ title: 'capítulo 10', created_at: 20, progress: 0.5 });
  const d = doc({ title: 'capítulo 9', created_at: 5, progress: 1, completed: true });
  const all = [a, b, c, d];

  it('sorts by recency, then progress, title and date added', () => {
    expect(arrangeLibrary(all, 'recent', 'library')).toEqual([b, a, c, d]);
    expect(arrangeLibrary(all, 'progress', 'library')).toEqual([b, c, a, d]);
    expect(arrangeLibrary(all, 'title', 'library')).toEqual([b, a, d, c]);
    expect(arrangeLibrary(all, 'added', 'library')).toEqual([a, c, b, d]);
  });

  it('keeps imports in progress or failed on top', () => {
    const importing = doc({ title: 'zzz', created_at: 1, import_status: 'importing' });
    expect(arrangeLibrary([...all, importing], 'title', 'library')[0]).toBe(importing);
  });

  it('does not mutate its input', () => {
    const copy = [...all];
    arrangeLibrary(all, 'title', 'library');
    expect(all).toEqual(copy);
  });
});

describe('parseLibrarySort', () => {
  it('falls back to recent', () => {
    expect(parseLibrarySort({ sort: 'title' })).toBe('title');
    expect(parseLibrarySort({ sort: 'nope' })).toBe('recent');
    expect(parseLibrarySort(null)).toBe('recent');
  });
});
