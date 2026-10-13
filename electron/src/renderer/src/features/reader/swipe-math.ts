/**
 * Swipe-to-act geometry for library rows (pure). Positive offsets reveal the
 * start-side actions (left edge), negative offsets the end-side ones.
 */

/** Movement before a gesture is classified as a swipe or a scroll. */
export const SWIPE_SLOP = 8;
/** Horizontal must beat vertical by this factor, so diagonal scrolls stay scrolls. */
export const SWIPE_BIAS = 1.2;
/** Width of one revealed action cell (a 44px target with room for a label). */
export const ACTION_WIDTH = 88;
/** Resistance past the full-swipe threshold. */
export const RUBBER = 0.2;

export type SwipeSide = 'start' | 'end';

export interface SwipeLayout {
  /** Actions on the start (left) side, revealed by dragging right. */
  start: number;
  /** Actions on the end (right) side, revealed by dragging left. */
  end: number;
  /** Row width in px. */
  width: number;
  actionWidth?: number;
}

/** `null` until the pointer leaves the slop; then the axis the gesture belongs to. */
export function swipeIntent(
  dx: number,
  dy: number,
  slop = SWIPE_SLOP,
): 'horizontal' | 'vertical' | null {
  if (Math.abs(dx) < slop && Math.abs(dy) < slop) return null;
  return Math.abs(dx) > Math.abs(dy) * SWIPE_BIAS ? 'horizontal' : 'vertical';
}

function sideOf(offset: number): SwipeSide {
  return offset > 0 ? 'start' : 'end';
}

function count(layout: SwipeLayout, side: SwipeSide): number {
  return side === 'start' ? layout.start : layout.end;
}

/** Width of the open (resting) position for a side. */
export function openWidth(layout: SwipeLayout, side: SwipeSide): number {
  return count(layout, side) * (layout.actionWidth ?? ACTION_WIDTH);
}

/** Past this distance a release runs the edge-most action ("full swipe"). */
export function fullThreshold(layout: SwipeLayout, side: SwipeSide): number {
  return Math.max(openWidth(layout, side) + 32, layout.width * 0.6);
}

/** Where the row sits for a raw finger offset: free up to the threshold, then rubber-banded. */
export function dragOffset(raw: number, layout: SwipeLayout): number {
  if (raw === 0) return 0;
  const side = sideOf(raw);
  if (!count(layout, side)) return 0;
  const limit = fullThreshold(layout, side);
  const distance = Math.abs(raw);
  const eased = distance <= limit ? distance : limit + (distance - limit) * RUBBER;
  return Math.sign(raw) * eased;
}

/** Whether the row is past the full-swipe threshold (drives the haptic tick). */
export function pastFull(offset: number, layout: SwipeLayout): boolean {
  if (offset === 0) return false;
  const side = sideOf(offset);
  return count(layout, side) > 0 && Math.abs(offset) >= fullThreshold(layout, side);
}

export type SwipeRelease =
  | { type: 'close' }
  | { type: 'open'; side: SwipeSide; offset: number }
  | { type: 'commit'; side: SwipeSide };

/** What a release does: run the edge action, rest open on the actions, or snap closed. */
export function releaseSwipe(offset: number, layout: SwipeLayout): SwipeRelease {
  if (offset === 0) return { type: 'close' };
  const side = sideOf(offset);
  if (!count(layout, side)) return { type: 'close' };
  if (pastFull(offset, layout)) return { type: 'commit', side };
  const half = (layout.actionWidth ?? ACTION_WIDTH) / 2;
  if (Math.abs(offset) < half) return { type: 'close' };
  const width = openWidth(layout, side);
  return { type: 'open', side, offset: side === 'start' ? width : -width };
}

/** 0–1 reveal of one action cell, for its icon scale-in. */
export function revealFraction(offset: number, layout: SwipeLayout): number {
  const width = layout.actionWidth ?? ACTION_WIDTH;
  return Math.min(1, Math.abs(offset) / width);
}
