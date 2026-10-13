/** Long-press detection and word lookup for the reading view (pronunciation sheet). */

/** Hold this long without moving to count as a long press. */
export const LONG_PRESS_MS = 500;
/** Moving the pointer further than this (px) is a scroll or a selection, not a press. */
export const LONG_PRESS_SLOP = 10;

export interface LongPressPoint {
  x: number;
  y: number;
}

export interface LongPressOptions {
  onPress: (point: LongPressPoint) => void;
  delay?: number;
  slop?: number;
  schedule?: (callback: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}

/**
 * Pointer-driven long-press detector. `down` arms a timer; moving beyond the
 * slop, lifting the pointer or a cancel disarms it. `fired` stays true until
 * the next `down`, so the click that follows a long press can be ignored.
 */
export function createLongPress({
  onPress,
  delay = LONG_PRESS_MS,
  slop = LONG_PRESS_SLOP,
  schedule = (callback, ms) => setTimeout(callback, ms),
  cancel = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}: LongPressOptions) {
  let timer: unknown = null;
  let origin: LongPressPoint | null = null;
  let fired = false;
  const disarm = () => {
    if (timer !== null) cancel(timer);
    timer = null;
    origin = null;
  };
  return {
    down(point: LongPressPoint) {
      disarm();
      fired = false;
      origin = point;
      timer = schedule(() => {
        timer = null;
        const at = origin;
        origin = null;
        if (!at) return;
        fired = true;
        onPress(at);
      }, delay);
    },
    move(point: LongPressPoint) {
      if (!origin) return;
      if (Math.hypot(point.x - origin.x, point.y - origin.y) > slop) disarm();
    },
    up: disarm,
    cancel: disarm,
    /** The latest press turned into a long press. */
    get fired() {
      return fired;
    },
    /** Forget a fired press once its follow-up click was swallowed. */
    consume() {
      const was = fired;
      fired = false;
      return was;
    },
  };
}

export type LongPress = ReturnType<typeof createLongPress>;

/** Letters, marks and digits plus in-word apostrophes and hyphens ("l'eau", "e-mail"). */
const WORD_CHAR = /[\p{L}\p{M}\p{N}]/u;
const JOINER = /['’\-‐]/u;

/**
 * The word around character `offset` of `text`, or null on whitespace or
 * punctuation. Trailing/leading joiners are not part of the word.
 */
export function wordAt(text: string, offset: number): { word: string; start: number } | null {
  const chars = Array.from(text);
  // Map the UTF-16 offset to a code-point index.
  let index = 0;
  for (let units = 0; index < chars.length && units + chars[index].length <= offset; index++)
    units += chars[index].length;
  const isWord = (i: number) => i >= 0 && i < chars.length && WORD_CHAR.test(chars[i]);
  const inWord = (i: number) =>
    isWord(i) || (i > 0 && JOINER.test(chars[i] ?? '') && isWord(i - 1) && isWord(i + 1));
  // Pressing just past a word's last letter still picks that word.
  if (!inWord(index) && inWord(index - 1)) index -= 1;
  if (!inWord(index)) return null;
  let start = index;
  let end = index + 1;
  while (start > 0 && inWord(start - 1)) start--;
  while (end < chars.length && inWord(end)) end++;
  const word = chars.slice(start, end).join('');
  return { word, start: chars.slice(0, start).join('').length };
}

/** Text node and offset under a viewport point (Chromium/WebKit and Firefox APIs). */
export function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  if (typeof doc.caretPositionFromPoint === 'function') {
    const position = doc.caretPositionFromPoint(x, y);
    if (position) return { node: position.offsetNode, offset: position.offset };
  }
  if (typeof doc.caretRangeFromPoint === 'function') {
    const range = doc.caretRangeFromPoint(x, y);
    if (range) return { node: range.startContainer, offset: range.startOffset };
  }
  return null;
}

/**
 * The word of a sentence element under a viewport point: its text, the
 * segment and the word's character offset in the segment text.
 */
export function wordAtPoint(
  sentence: HTMLElement,
  x: number,
  y: number,
): { word: string; offset: number } | null {
  const caret = caretAt(x, y);
  if (!caret || caret.node.nodeType !== Node.TEXT_NODE || !sentence.contains(caret.node))
    return null;
  // Offset of the caret within the sentence's whole text (word spans split it).
  let before = 0;
  const walker = document.createTreeWalker(sentence, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node && node !== caret.node; node = walker.nextNode())
    before += node.textContent?.length ?? 0;
  const found = wordAt(sentence.textContent ?? '', before + caret.offset);
  return found ? { word: found.word, offset: found.start } : null;
}
