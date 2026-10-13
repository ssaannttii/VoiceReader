import { describe, expect, it } from 'vitest';
import type { ReaderDocumentSummary } from './reader-api';
import {
  arrangeLibrary,
  coverArt,
  coverShape,
  downloadTotals,
  durationLabel,
  durationText,
  isFinished,
  isReady,
  isUnread,
  matchesFilter,
  matchesQuery,
  parseLibrarySort,
  rowStatus,
  splitMinutes,
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

  it('sorts least recent, oldest added and Z–A', () => {
    expect(arrangeLibrary(all, 'least_recent', 'library')).toEqual([d, c, a, b]);
    expect(arrangeLibrary(all, 'oldest', 'library')).toEqual([d, b, c, a]);
    expect(arrangeLibrary(all, 'title_desc', 'library')).toEqual([c, d, a, b]);
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
    expect(parseLibrarySort({ sort: 'title_desc' })).toBe('title_desc');
    expect(parseLibrarySort({ sort: 'nope' })).toBe('recent');
    expect(parseLibrarySort(null)).toBe('recent');
  });
});

describe('matchesQuery', () => {
  it('folds accents and case across title, author and source', () => {
    const item = doc({
      title: 'Canción de hielo',
      author: 'G. Martin',
      source_name: 'ejemplo.com',
    });
    expect(matchesQuery(item, 'CANCION')).toBe(true);
    expect(matchesQuery(item, 'martin')).toBe(true);
    expect(matchesQuery(item, 'ejemplo')).toBe(true);
    expect(matchesQuery(item, 'fuego')).toBe(false);
    expect(matchesQuery(item, '   ')).toBe(true);
  });
});

describe('cover shape and art', () => {
  it('draws books as portraits and everything else as squares', () => {
    expect(coverShape(doc({ source_type: 'file', source_name: 'Libro.EPUB' }))).toBe('book');
    expect(coverShape(doc({ source_type: 'file', source_name: 'informe.pdf' }))).toBe('book');
    expect(coverShape(doc({ source_type: 'file', source_name: 'notas.txt' }))).toBe('square');
    expect(coverShape(doc({ source_type: 'url', source_name: 'es.wikipedia.org' }))).toBe('square');
    expect(coverShape(doc({ source_type: 'text' }))).toBe('square');
    expect(coverShape(doc({ source_type: 'url', has_cover: true }))).toBe('book');
  });

  it('picks generated art by source', () => {
    expect(coverArt(doc({ source_type: 'url' }))).toBe('web');
    expect(coverArt(doc({ source_type: 'scan' }))).toBe('scan');
    expect(coverArt(doc({ source_type: 'text' }))).toBe('text');
    expect(coverArt(doc({ source_type: 'file', source_name: 'a.pdf' }))).toBe('pdf');
    expect(coverArt(doc({ source_type: 'file', source_name: 'a.epub' }))).toBe('book');
    expect(coverArt(doc({ source_type: 'file', source_name: 'a.md' }))).toBe('file');
  });
});

describe('rowStatus', () => {
  it('formats not started, in progress and finished', () => {
    expect(rowStatus(doc({ est_duration_s: 720 }))).toEqual({ kind: 'new', minutes: 12 });
    expect(rowStatus(doc({ est_duration_s: 1800, position_segment: 17, progress: 0.17 }))).toEqual({
      kind: 'progress',
      percent: 17,
      minutes: 25,
    });
    expect(rowStatus(doc({ completed: true }))).toEqual({ kind: 'finished' });
  });

  it('keeps the percent between 1 and 99 while in progress', () => {
    expect(rowStatus(doc({ position_segment: 1, progress: 0.001 }))).toMatchObject({ percent: 1 });
    expect(rowStatus(doc({ position_segment: 98, progress: 0.998 }))).toMatchObject({
      percent: 99,
      minutes: 1,
    });
  });
});

describe('isUnread', () => {
  it('marks only never-opened, ready, unfinished documents', () => {
    expect(isUnread(doc())).toBe(true);
    expect(isUnread(doc({ last_opened_at: 5 }))).toBe(false);
    expect(isUnread(doc({ import_status: 'importing' }))).toBe(false);
    expect(isUnread(doc({ completed: true }))).toBe(false);
  });
});

describe('splitMinutes', () => {
  it('switches to hours from 60 minutes', () => {
    expect(splitMinutes(59)).toEqual({ hours: 0, minutes: 59 });
    expect(splitMinutes(60)).toEqual({ hours: 1, minutes: 0 });
    expect(splitMinutes(1560)).toEqual({ hours: 26, minutes: 0 });
    expect(splitMinutes(95)).toEqual({ hours: 1, minutes: 35 });
  });
});

describe('durationLabel', () => {
  // A fake `t` that shows which key and values were used.
  const t = (key: string, values?: Record<string, unknown>) =>
    `${key.replace('reader.', '')}${JSON.stringify(values)}`;

  it('drops "0 min" from whole hours (26 h, not 26 h 0 min)', () => {
    expect(durationLabel(t, 1560, false)).toBe('duration_h{"hours":26}');
    expect(durationLabel(t, 1560, true)).toBe('lib_hours_only_left{"hours":26}');
    expect(durationLabel(t, 60, true)).toBe('lib_hours_only_left{"hours":1}');
  });

  it('keeps hours with minutes and plain minutes', () => {
    expect(durationLabel(t, 95, false)).toBe('lib_hours_total{"hours":1,"minutes":35}');
    expect(durationLabel(t, 95, true)).toBe('lib_hours_left{"hours":1,"minutes":35}');
    expect(durationLabel(t, 25, false)).toBe('minutes_total{"minutes":25}');
    expect(durationLabel(t, 25, true)).toBe('lib_minutes_left{"minutes":25}');
  });

  it('has the same rule for any hours/minutes split', () => {
    expect(durationText({ hours: 2, minutes: 0 }, false).key).toBe('reader.duration_h');
    expect(durationText({ hours: 0, minutes: 0 }, false).key).toBe('reader.minutes_total');
  });
});

describe('collections and downloads lists', () => {
  const a = doc({ title: 'a', created_at: 3 });
  const b = doc({ title: 'b', created_at: 2, archived: true });
  const c = doc({ title: 'c', created_at: 1 });

  it('keeps only the given ids (a collection), still sorted and filtered', () => {
    const members = new Set([a.id, b.id]);
    expect(arrangeLibrary([a, b, c], 'title', 'library', members)).toEqual([a]);
    expect(arrangeLibrary([c, a], 'title', 'library', new Set([a.id, c.id]))).toEqual([a, c]);
    expect(arrangeLibrary([a, b, c], 'title', 'library', new Set())).toEqual([]);
  });

  it('lists archived documents too with the "all" scope', () => {
    expect(arrangeLibrary([c, b, a], 'title', 'all')).toEqual([a, b, c]);
    expect(matchesFilter(b, 'all')).toBe(true);
  });

  it('adds up downloads on this device', () => {
    expect(downloadTotals({})).toEqual({ count: 0, bytes: 0 });
    expect(downloadTotals({ x: { bytes: 1024 }, y: { bytes: 2048 } })).toEqual({
      count: 2,
      bytes: 3072,
    });
  });
});
