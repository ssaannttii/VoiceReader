/** Page list for "Scan pages" (pure helpers). */

/** The backend's limit for one scan (docs/reader/SPEC.md). */
export const MAX_SCAN_PAGES = 50;

/** Copy of `list` with the item at `from` moved to `to` (clamped). */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  if (from < 0 || from >= next.length) return next;
  const target = Math.min(Math.max(0, to), next.length - 1);
  const [item] = next.splice(from, 1);
  next.splice(target, 0, item);
  return next;
}

/** Append `added` images, keeping at most `MAX_SCAN_PAGES`; returns the list and how many were dropped. */
export function addPages<T>(
  list: readonly T[],
  added: readonly T[],
): { pages: T[]; dropped: number } {
  const room = Math.max(0, MAX_SCAN_PAGES - list.length);
  return {
    pages: [...list, ...added.slice(0, room)],
    dropped: Math.max(0, added.length - room),
  };
}
