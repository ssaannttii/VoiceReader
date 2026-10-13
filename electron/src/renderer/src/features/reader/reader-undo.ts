/** Positions to return to after a jump: "Volver a 12:34" undoes an accidental tap. */

export interface ReaderPosition {
  segment: number;
  /** Seconds into the segment. */
  offset: number;
}

export interface UndoEntry extends ReaderPosition {
  /** `Date.now()` when the jump happened (the pill shows for a few seconds). */
  at: number;
}

/** How long "Volver a…" is offered after a jump (and progress waits before saving it). */
export const UNDO_WINDOW_MS = 6000;

/** Jumps shorter than this (same segment) are not worth an undo. */
const SAME_SPOT_SECONDS = 2;

export function samePosition(a: ReaderPosition, b: ReaderPosition): boolean {
  return a.segment === b.segment && Math.abs(a.offset - b.offset) < SAME_SPOT_SECONDS;
}

/** A small bounded stack of positions left by user jumps. */
export class UndoStack {
  private entries: UndoEntry[] = [];

  constructor(private limit = 20) {}

  get size(): number {
    return this.entries.length;
  }

  peek(): UndoEntry | null {
    return this.entries[this.entries.length - 1] ?? null;
  }

  /**
   * Remember `from` before jumping to `to`. Returns the new top, or null when
   * the jump goes nowhere (same spot) and nothing was recorded.
   */
  push(from: ReaderPosition, to: ReaderPosition, at = Date.now()): UndoEntry | null {
    if (samePosition(from, to)) return null;
    const top = this.peek();
    const entry: UndoEntry = { segment: from.segment, offset: from.offset, at };
    // Several quick jumps from the same place keep one entry (the original spot).
    if (top && samePosition(top, from)) this.entries[this.entries.length - 1] = entry;
    else this.entries.push(entry);
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
    return entry;
  }

  pop(): UndoEntry | null {
    return this.entries.pop() ?? null;
  }

  clear() {
    this.entries = [];
  }
}
