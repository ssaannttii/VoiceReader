/** Multi-select state for the library (pure reducer). */

export interface LibrarySelection {
  /** Select mode is on (the header and bottom bar change). */
  active: boolean;
  /** Selected document ids, in selection order. */
  ids: readonly string[];
}

export type SelectionAction =
  | { type: 'enter'; id?: string }
  | { type: 'toggle'; id: string }
  /** Select every id given, or clear when they are all selected already. */
  | { type: 'toggle-all'; ids: readonly string[] }
  /** Drop ids that are no longer listed (deleted, filtered away). */
  | { type: 'prune'; ids: readonly string[] }
  | { type: 'exit' };

export const NO_SELECTION: LibrarySelection = { active: false, ids: [] };

export function selectionReducer(
  state: LibrarySelection,
  action: SelectionAction,
): LibrarySelection {
  switch (action.type) {
    case 'enter':
      if (!action.id) return state.active ? state : { active: true, ids: [] };
      return {
        active: true,
        ids: state.ids.includes(action.id) ? state.ids : [...state.ids, action.id],
      };
    case 'toggle':
      if (!state.active) return state;
      return {
        active: true,
        ids: state.ids.includes(action.id)
          ? state.ids.filter((id) => id !== action.id)
          : [...state.ids, action.id],
      };
    case 'toggle-all': {
      if (!state.active) return state;
      const all = action.ids.length > 0 && action.ids.every((id) => state.ids.includes(id));
      return { active: true, ids: all ? [] : [...action.ids] };
    }
    case 'prune': {
      const keep = state.ids.filter((id) => action.ids.includes(id));
      return keep.length === state.ids.length ? state : { ...state, ids: keep };
    }
    case 'exit':
      return state.active || state.ids.length ? NO_SELECTION : state;
  }
}

/** What the bulk "finished" button does: unread only when every selected item is finished. */
export function bulkFinishedTarget(finished: readonly boolean[]): boolean {
  return !(finished.length > 0 && finished.every(Boolean));
}
