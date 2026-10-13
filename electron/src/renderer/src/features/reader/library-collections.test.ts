import { describe, expect, it } from 'vitest';
import {
  cleanCollectionName,
  collectionNameTaken,
  collectionsOf,
  liveMembers,
  membership,
  membershipToggle,
  upsertCollection,
  withMembers,
} from './library-collections';

const shelf = (id: string, name: string, doc_ids: string[] = []) => ({
  id,
  name,
  created_at: 1,
  updated_at: 1,
  doc_ids,
});

describe('collection names', () => {
  it('collapse whitespace and stop at the server limit', () => {
    expect(cleanCollectionName('  Novelas   de\tverano ')).toBe('Novelas de verano');
    expect(cleanCollectionName('   ')).toBe('');
    expect(cleanCollectionName('x'.repeat(150))).toHaveLength(100);
  });

  it('are taken case-insensitively, except by the collection being renamed', () => {
    const list = [shelf('a', 'Ensayos'), shelf('b', 'Poesía')];
    expect(collectionNameTaken(list, ' ensayos ')).toBe(true);
    expect(collectionNameTaken(list, 'POESÍA')).toBe(true);
    expect(collectionNameTaken(list, 'Novelas')).toBe(false);
    expect(collectionNameTaken(list, 'ENSAYOS', 'a')).toBe(false);
    expect(collectionNameTaken(list, 'ensayos', 'b')).toBe(true);
  });
});

describe('membership', () => {
  const work = shelf('w', 'Trabajo', ['d1', 'd2']);

  it('tells whether all, some or none of the documents are in it', () => {
    expect(membership(work, ['d1'])).toBe('all');
    expect(membership(work, ['d1', 'd2'])).toBe('all');
    expect(membership(work, ['d1', 'd3'])).toBe('some');
    expect(membership(work, ['d3'])).toBe('none');
    expect(membership(work, [])).toBe('none');
  });

  it('removes when all are in it, otherwise adds only the missing ones', () => {
    expect(membershipToggle(work, ['d1', 'd2'])).toEqual({ add: false, ids: ['d1', 'd2'] });
    expect(membershipToggle(work, ['d1', 'd3'])).toEqual({ add: true, ids: ['d3'] });
    expect(membershipToggle(work, ['d4'])).toEqual({ add: true, ids: ['d4'] });
  });

  it('applies a change without duplicates, keeping the order', () => {
    expect(withMembers(work, ['d3', 'd1'], true).doc_ids).toEqual(['d1', 'd2', 'd3']);
    expect(withMembers(work, ['d1'], false).doc_ids).toEqual(['d2']);
    expect(work.doc_ids).toEqual(['d1', 'd2']);
  });

  it('lists the collections of a document and the members still in the library', () => {
    const list = [work, shelf('n', 'Novelas', ['d2']), shelf('e', 'Vacía')];
    expect(collectionsOf(list, 'd2').map((item) => item.id)).toEqual(['w', 'n']);
    expect(collectionsOf(list, 'd9')).toEqual([]);
    expect(liveMembers(work, new Set(['d2', 'd5']))).toEqual(['d2']);
  });
});

describe('upsertCollection', () => {
  it('replaces in place or appends', () => {
    const list = [shelf('a', 'A'), shelf('b', 'B')];
    expect(upsertCollection(list, shelf('a', 'A2')).map((item) => item.name)).toEqual(['A2', 'B']);
    expect(upsertCollection(list, shelf('c', 'C')).map((item) => item.id)).toEqual(['a', 'b', 'c']);
    expect(upsertCollection(undefined, shelf('c', 'C'))).toHaveLength(1);
  });
});
