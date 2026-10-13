/** Pure helpers for the Reader: text layout, timing lookups, and estimates. */
import type { ReaderChapter, ReaderSegment, ReaderWord } from './reader-api';

/** Characters spoken per second at 1x; mirrors the backend's `est_duration_s`. */
export const CHARS_PER_SECOND = 15;

export type ReaderBlockKind = 'h' | 'p' | 'li' | 'quote' | 'img';

export interface ReaderBlock {
  key: string;
  kind: ReaderBlockKind;
  segments: ReaderSegment[];
}

const BLOCK_KINDS: ReadonlySet<string> = new Set(['h', 'p', 'li', 'quote', 'img']);

/** A segment's block kind; unknown kinds from newer servers read as body text. */
function blockKind(segment: ReaderSegment): ReaderBlockKind {
  return BLOCK_KINDS.has(segment.kind) ? segment.kind : 'p';
}

/**
 * Group sentence segments into rendered blocks: consecutive sentences of one
 * paragraph (body, list item or quote) form one block; every heading and every
 * image is its own block. List items are paragraphs of their own, so siblings
 * never merge.
 */
export function groupBlocks(segments: readonly ReaderSegment[]): ReaderBlock[] {
  const blocks: ReaderBlock[] = [];
  let current: ReaderBlock | null = null;
  for (const segment of segments) {
    const kind = blockKind(segment);
    if (
      !current ||
      kind === 'h' ||
      kind === 'img' ||
      current.kind !== kind ||
      current.segments[0].para !== segment.para
    ) {
      current = { key: `b${segment.i}`, kind, segments: [] };
      blocks.push(current);
    }
    current.segments.push(segment);
  }
  return blocks;
}

/** One `<li>`: its paragraphs (blocks sharing the item number) and nested lists. */
export interface ListItemNode {
  key: string;
  n: number;
  blocks: ReaderBlock[];
  lists: ListNode[];
}

export interface ListNode {
  type: 'list';
  key: string;
  /** The segments' `list` id. */
  id: number;
  ordered: boolean;
  /** Nesting depth of this list (0 = top level); a window may start inside a nested list. */
  depth: number;
  items: ListItemNode[];
}

export type LayoutNode =
  | { type: 'block'; key: string; block: ReaderBlock }
  | { type: 'quote'; key: string; blocks: ReaderBlock[] }
  | ListNode;

/**
 * Arrange a run of blocks for rendering: consecutive list items of one list form a
 * list (deeper items nest inside the item before them, items sharing a number are
 * one item with several paragraphs) and consecutive quote paragraphs one quotation.
 */
export function layoutBlocks(blocks: readonly ReaderBlock[]): LayoutNode[] {
  const out: LayoutNode[] = [];
  let open: ListNode[] = []; // open lists, outermost first
  let quote: { type: 'quote'; key: string; blocks: ReaderBlock[] } | null = null;
  for (const block of blocks) {
    if (block.kind === 'quote') {
      open = [];
      if (!quote) {
        quote = { type: 'quote', key: block.key, blocks: [] };
        out.push(quote);
      }
      quote.blocks.push(block);
      continue;
    }
    quote = null;
    if (block.kind !== 'li') {
      open = [];
      out.push({ type: 'block', key: block.key, block });
      continue;
    }
    const first = block.segments[0];
    const id = first.list ?? -1;
    const depth = Math.max(0, first.depth ?? 0);
    const n = first.n ?? 1;
    const innermost = () => open[open.length - 1];
    // Close lists deeper than this item, and a different list at its own depth.
    while (
      open.length &&
      (innermost().depth > depth || (innermost().depth === depth && innermost().id !== id))
    )
      open.pop();
    let list = open.length && innermost().depth === depth ? innermost() : null;
    if (!list) {
      list = {
        type: 'list',
        key: `l${block.key}`,
        id,
        ordered: Boolean(first.ordered),
        depth,
        items: [],
      };
      const parent = innermost()?.items.at(-1);
      if (parent) parent.lists.push(list);
      else out.push(list);
      open.push(list);
    }
    const last = list.items.at(-1);
    // A later paragraph of the same item (same number, no nested list in between).
    if (last && last.n === n && !last.lists.length) last.blocks.push(block);
    else list.items.push({ key: block.key, n, blocks: [block], lists: [] });
  }
  return out;
}

/** Text shown for a segment in lists and previews: an image shows its description. */
export function segmentLabel(segment: ReaderSegment | undefined, imageLabel = ''): string {
  if (!segment) return '';
  if (segment.kind === 'img') return segment.alt || segment.caption || imageLabel;
  return segment.text;
}

/**
 * Index of the word being spoken at `time` seconds: the last word whose
 * start is at or before `time` (so pauses keep the previous word lit), or -1
 * before the first word starts. Binary search; `words` is in start order.
 */
export function wordIndexAt(words: readonly ReaderWord[], time: number): number {
  let low = 0;
  let high = words.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (words[mid].start <= time) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

/** Split `text` into plain runs and word runs using the render's char offsets. */
export function splitWords(
  text: string,
  words: readonly ReaderWord[],
): Array<{ text: string; word: number | null }> {
  const parts: Array<{ text: string; word: number | null }> = [];
  let cursor = 0;
  words.forEach((word, index) => {
    const c0 = Math.max(cursor, Math.min(text.length, word.c0));
    const c1 = Math.max(c0, Math.min(text.length, word.c1));
    if (c0 > cursor) parts.push({ text: text.slice(cursor, c0), word: null });
    if (c1 > c0) parts.push({ text: text.slice(c0, c1), word: index });
    cursor = c1;
  });
  if (cursor < text.length) parts.push({ text: text.slice(cursor), word: null });
  return parts;
}

/** Estimated seconds for a segment at 1x before its real duration is known. */
export function estimateSegmentSeconds(text: string): number {
  return Math.max(0.6, text.length / CHARS_PER_SECOND);
}

/** Index of the chapter containing `segment`, or -1 when there are no chapters before it. */
export function chapterIndexAt(chapters: readonly ReaderChapter[], segment: number): number {
  let found = -1;
  chapters.forEach((chapter, index) => {
    if (chapter.segment <= segment) found = index;
  });
  return found;
}

/** First segment after the chapter that contains `segment` (document end when last). */
export function chapterEndSegment(
  chapters: readonly ReaderChapter[],
  segment: number,
  segmentCount: number,
): number {
  const next = chapters
    .map((chapter) => chapter.segment)
    .filter((start) => start > segment)
    .sort((a, b) => a - b)[0];
  return next ?? segmentCount;
}

/** `m:ss` or `h:mm:ss`. */
export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.round(Number.isFinite(seconds) ? seconds : 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

/** Whole minutes left, never below 1 while anything remains. */
export function minutesLeft(seconds: number): number {
  return seconds <= 0 ? 0 : Math.max(1, Math.round(seconds / 60));
}

/** Stable warm gradient for documents without a cover. */
export function coverGradient(seed: string): string {
  let hash = 0;
  for (let index = 0; index < seed.length; index++) hash = (hash * 31 + seed.charCodeAt(index)) | 0;
  const hue = Math.abs(hash) % 360;
  const second = (hue + 38 + (Math.abs(hash >> 8) % 50)) % 360;
  return `linear-gradient(140deg, oklch(0.62 0.15 ${hue}), oklch(0.42 0.13 ${second}))`;
}

/** First visible letter of a title for the generated cover. */
export function coverInitial(title: string): string {
  const match = /[\p{L}\p{N}]/u.exec(title);
  return (match?.[0] ?? '•').toLocaleUpperCase();
}

export const SPEED_MIN = 0.5;
export const SPEED_MAX = 3;

/** Clamp to 0.5–3.0 on the 0.1 grid. */
export function clampSpeed(value: number): number {
  const rounded = Math.round(value * 10) / 10;
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, Number.isFinite(rounded) ? rounded : 1));
}

export function formatSpeed(value: number): string {
  return `${clampSpeed(value).toFixed(1)}×`;
}

/** For every segment index, the index of the block (paragraph/heading) holding it. */
export function blockIndexBySegment(blocks: readonly ReaderBlock[], count: number): Int32Array {
  const out = new Int32Array(count);
  blocks.forEach((block, index) => {
    for (const segment of block.segments) if (segment.i < count) out[segment.i] = index;
  });
  return out;
}

export interface BlockWindow {
  start: number;
  end: number;
}

/** The slice of blocks rendered around `index`: a long book is never in the DOM at once. */
export function windowAround(index: number, total: number, before = 60, after = 140): BlockWindow {
  const anchor = Math.min(Math.max(0, index), Math.max(0, total - 1));
  const start = Math.max(0, anchor - before);
  return { start, end: Math.min(total, Math.max(anchor + after, start + before + after)) };
}

/** "17 %" / "17%" as the reader's locale writes a whole-number percentage. */
export function formatPercent(percent: number, locale?: string): string {
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(
    Math.max(0, Math.min(100, percent)) / 100,
  );
}
