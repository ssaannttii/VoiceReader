import { describe, expect, it } from 'vitest';
import {
  bulkFinishedTarget,
  NO_SELECTION,
  selectionReducer,
  type LibrarySelection,
  type SelectionAction,
} from './library-selection';

const run = (state: LibrarySelection, ...actions: SelectionAction[]) =>
  actions.reduce(selectionReducer, state);

describe('selectionReducer', () => {
  it('enters with the long-pressed row selected', () => {
    expect(run(NO_SELECTION, { type: 'enter', id: 'a' })).toEqual({ active: true, ids: ['a'] });
    expect(run(NO_SELECTION, { type: 'enter' })).toEqual({ active: true, ids: [] });
  });

  it('toggles rows and stays in select mode when the last one is cleared', () => {
    const state = run(
      NO_SELECTION,
      { type: 'enter', id: 'a' },
      { type: 'toggle', id: 'b' },
      { type: 'toggle', id: 'a' },
    );
    expect(state).toEqual({ active: true, ids: ['b'] });
    expect(run(state, { type: 'toggle', id: 'b' })).toEqual({ active: true, ids: [] });
  });

  it('ignores toggles outside select mode', () => {
    expect(run(NO_SELECTION, { type: 'toggle', id: 'a' })).toBe(NO_SELECTION);
  });

  it('selects all, then clears when everything is selected', () => {
    const all = run(
      NO_SELECTION,
      { type: 'enter', id: 'b' },
      { type: 'toggle-all', ids: ['a', 'b'] },
    );
    expect(all.ids).toEqual(['a', 'b']);
    expect(run(all, { type: 'toggle-all', ids: ['a', 'b'] }).ids).toEqual([]);
  });

  it('prunes rows that disappeared and exits cleanly', () => {
    const state = run(NO_SELECTION, { type: 'enter', id: 'a' }, { type: 'toggle', id: 'b' });
    expect(run(state, { type: 'prune', ids: ['b', 'c'] }).ids).toEqual(['b']);
    expect(run(state, { type: 'prune', ids: ['a', 'b'] })).toBe(state);
    expect(run(state, { type: 'exit' })).toBe(NO_SELECTION);
  });
});

describe('bulkFinishedTarget', () => {
  it('marks unread only when every selected document is finished', () => {
    expect(bulkFinishedTarget([true, true])).toBe(false);
    expect(bulkFinishedTarget([true, false])).toBe(true);
    expect(bulkFinishedTarget([])).toBe(true);
  });
});
