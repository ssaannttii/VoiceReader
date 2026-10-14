/**
 * Pure rules for the paginated reading layout ("Pages"): the rendered window of
 * blocks is laid out as CSS columns one page wide (reader-pager.ts), so a page
 * is a horizontal offset. Kept free of React and the DOM so it is tested.
 */
import { SWIPE_BIAS } from './swipe-math';
import { windowAround, type BlockWindow } from './reader-text';

/** Space between two columns (pages); wider than the clip margin, so a neighbour never peeks. */
export const PAGE_GAP = 48;
/** Share of the width, on each side, where a tap turns the page instead of reading. */
export const EDGE_ZONE = 0.25;
/** The same with two pages side by side, so most of the left page still reads on a tap. */
export const SPREAD_EDGE_ZONE = 0.12;
/** Two pages side by side need room for this many ems of text in each. */
export const SPREAD_MIN_EM = 24;
/** The reading column's side padding (1.25rem each side). */
const COLUMN_PADDING = 40;
/** Widest the reading column grows for two pages (`.rd-root[data-spread]`, 84.5rem). */
export const SPREAD_MAX_PX = 1352;
/** Pages from either end of the rendered window at which more text is rendered. */
export const EDGE_PAGES = 2;
/** Blocks rendered around the position: smaller than the scrolling window, as every
 *  change to the text lays out the whole run of columns again. */
export const PAGED_BEFORE = 40;
export const PAGED_AFTER = 80;
/** Blocks added when a page turn nears an edge of the window. */
export const PAGED_EXTEND = 60;
/** Past this many blocks the window re-centres instead of growing. */
export const PAGED_MAX = 240;
/** A swipe turns the page past this distance (or a quick flick past half of it). */
export const SWIPE_TURN_PX = 48;
export const FLICK_MS = 250;
/** Pull at the first/last page follows the finger this much. */
export const PAGE_RUBBER = 0.3;

/** The window of blocks rendered around `index` in the paginated layout. */
export function pagedWindow(index: number, total: number): BlockWindow {
  return windowAround(index, total, PAGED_BEFORE, PAGED_AFTER);
}

/** Whether two pages fit side by side on a screen `width` px wide at this text size. */
export function spreadFits(width: number, textSize: number): boolean {
  const room = Math.min(width, SPREAD_MAX_PX);
  return room >= 2 * SPREAD_MIN_EM * textSize + PAGE_GAP + COLUMN_PADDING;
}

/**
 * Column geometry for `columns` pages in a `width`-px viewport: whole-px columns, the run's
 * width (at most the viewport's) and the pitch between screens (every page plus its gap).
 */
export function pageGeometry(
  width: number,
  columns: number,
): { column: number; width: number; pitch: number } {
  const n = columns >= 2 ? 2 : 1;
  const column = Math.max(1, Math.floor((width - (n - 1) * PAGE_GAP) / n));
  return { column, width: n * column + (n - 1) * PAGE_GAP, pitch: n * (column + PAGE_GAP) };
}

/** Page holding a horizontal offset (px from the start of the first column). */
export function pageOfOffset(offset: number, pitch: number): number {
  if (!(pitch > 0) || !Number.isFinite(offset)) return 0;
  // Half a pixel of slack: line boxes start exactly at a column edge, give or take rounding.
  return Math.max(0, Math.floor((offset + 0.5) / pitch));
}

export function clampPage(page: number, count: number): number {
  return Math.min(Math.max(0, Math.round(page) || 0), Math.max(0, count - 1));
}

/** Where a tap at `x` (px from the left of a `width`-wide surface) lands. */
export function tapZone(
  x: number,
  width: number,
  edge = EDGE_ZONE,
): 'previous' | 'next' | 'centre' {
  if (!(width > 0)) return 'centre';
  if (x < width * edge) return 'previous';
  if (x > width * (1 - edge)) return 'next';
  return 'centre';
}

/** Page turn for a finished horizontal gesture: 1 next (dragged left), -1 previous, 0 none. */
export function swipeTurn(dx: number, dy: number, ms: number): -1 | 0 | 1 {
  if (Math.abs(dx) <= Math.abs(dy) * SWIPE_BIAS) return 0;
  const far = Math.abs(dx) >= SWIPE_TURN_PX;
  const flick = Math.abs(dx) >= SWIPE_TURN_PX / 2 && ms <= FLICK_MS;
  if (!far && !flick) return 0;
  return dx < 0 ? 1 : -1;
}

/** Drag offset shown while a finger pulls the page; resists past the first and last page. */
export function dragOffset(dx: number, page: number, count: number): number {
  const pastStart = page <= 0 && dx > 0;
  const pastEnd = page >= count - 1 && dx < 0;
  return pastStart || pastEnd ? dx * PAGE_RUBBER : dx;
}

/** Page turn for a key on desktop (arrows, Page Up/Down), or 0. */
export function pageKeyDelta(key: string): -1 | 0 | 1 {
  if (key === 'ArrowLeft' || key === 'ArrowUp' || key === 'PageUp') return -1;
  if (key === 'ArrowRight' || key === 'ArrowDown' || key === 'PageDown') return 1;
  return 0;
}

/**
 * Which edge of the rendered window a page is close enough to that more text
 * should be rendered there, if the document has more on that side.
 */
export function windowEdge(
  page: number,
  count: number,
  more: { before: boolean; after: boolean },
  margin = EDGE_PAGES,
): 'before' | 'after' | null {
  if (more.after && page >= count - 1 - margin) return 'after';
  if (more.before && page <= margin) return 'before';
  return null;
}

/** The window grown towards `edge`, or re-centred on `anchorBlock` once it would be too large. */
export function growWindow(
  range: BlockWindow,
  edge: 'before' | 'after',
  total: number,
  anchorBlock: number,
): BlockWindow {
  const next =
    edge === 'after'
      ? { start: range.start, end: Math.min(total, range.end + PAGED_EXTEND) }
      : { start: Math.max(0, range.start - PAGED_EXTEND), end: range.end };
  return next.end - next.start <= PAGED_MAX ? next : pagedWindow(anchorBlock, total);
}

/** Characters before each segment (`out[i]`) and in all of them (`out[count]`). */
export function charOffsets(lengths: readonly number[]): Float64Array {
  const out = new Float64Array(lengths.length + 1);
  lengths.forEach((length, index) => {
    out[index + 1] = out[index] + Math.max(0, length);
  });
  return out;
}

/**
 * Pages before the rendered window, estimated from the characters before it at
 * the window's own characters per page. Exact (0) when the window starts the document.
 */
export function estimatePagesBefore(
  charsBefore: number,
  windowChars: number,
  windowPages: number,
): number {
  if (charsBefore <= 0 || windowChars <= 0 || windowPages <= 0) return 0;
  return Math.max(0, Math.round(charsBefore / (windowChars / windowPages)));
}

/** Whole-number percentage of `done` out of `total` characters. */
export function percentRead(done: number, total: number): number {
  if (!(total > 0)) return 0;
  return Math.min(100, Math.max(0, Math.round((done / total) * 100)));
}
