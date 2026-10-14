import { describe, expect, it } from 'vitest';
import {
  charOffsets,
  clampPage,
  dragOffset,
  EDGE_PAGES,
  estimatePagesBefore,
  growWindow,
  PAGE_GAP,
  PAGE_RUBBER,
  pageGeometry,
  PAGED_AFTER,
  PAGED_BEFORE,
  PAGED_EXTEND,
  PAGED_MAX,
  pagedWindow,
  pageKeyDelta,
  pageOfOffset,
  percentRead,
  SPREAD_EDGE_ZONE,
  SPREAD_MAX_PX,
  spreadFits,
  swipeTurn,
  SWIPE_TURN_PX,
  tapZone,
  windowEdge,
} from './reader-pages';

describe('pageOfOffset', () => {
  const pitch = 393 + 48;

  it('maps column offsets to pages', () => {
    expect(pageOfOffset(0, pitch)).toBe(0);
    expect(pageOfOffset(392, pitch)).toBe(0);
    expect(pageOfOffset(pitch, pitch)).toBe(1);
    expect(pageOfOffset(pitch * 12 + 30, pitch)).toBe(12);
  });

  it('absorbs sub-pixel rounding at a column edge', () => {
    expect(pageOfOffset(pitch * 3 - 0.3, pitch)).toBe(3);
  });

  it('never goes negative or breaks on bad input', () => {
    expect(pageOfOffset(-20, pitch)).toBe(0);
    expect(pageOfOffset(Number.NaN, pitch)).toBe(0);
    expect(pageOfOffset(500, 0)).toBe(0);
  });
});

describe('clampPage', () => {
  it('keeps the page inside the document', () => {
    expect(clampPage(-1, 10)).toBe(0);
    expect(clampPage(4, 10)).toBe(4);
    expect(clampPage(10, 10)).toBe(9);
    expect(clampPage(3, 0)).toBe(0);
  });
});

describe('tapZone', () => {
  it('turns pages on the outer quarters and reads in the middle', () => {
    expect(tapZone(10, 400)).toBe('previous');
    expect(tapZone(99, 400)).toBe('previous');
    expect(tapZone(100, 400)).toBe('centre');
    expect(tapZone(200, 400)).toBe('centre');
    expect(tapZone(300, 400)).toBe('centre');
    expect(tapZone(301, 400)).toBe('next');
    expect(tapZone(399, 400)).toBe('next');
  });

  it('reads when the width is unknown', () => {
    expect(tapZone(5, 0)).toBe('centre');
  });
});

describe('swipeTurn', () => {
  it('turns forward when dragged left and back when dragged right', () => {
    expect(swipeTurn(-SWIPE_TURN_PX, 4, 600)).toBe(1);
    expect(swipeTurn(SWIPE_TURN_PX + 10, -6, 600)).toBe(-1);
  });

  it('needs distance, or a quick flick', () => {
    expect(swipeTurn(-SWIPE_TURN_PX / 2, 0, 600)).toBe(0);
    expect(swipeTurn(-SWIPE_TURN_PX / 2, 0, 150)).toBe(1);
    expect(swipeTurn(-10, 0, 100)).toBe(0);
  });

  it('ignores mostly vertical drags', () => {
    expect(swipeTurn(-80, 90, 200)).toBe(0);
  });
});

describe('dragOffset', () => {
  it('follows the finger between pages', () => {
    expect(dragOffset(-60, 3, 10)).toBe(-60);
    expect(dragOffset(60, 3, 10)).toBe(60);
  });

  it('resists past the first and the last page', () => {
    expect(dragOffset(100, 0, 10)).toBe(100 * PAGE_RUBBER);
    expect(dragOffset(-100, 9, 10)).toBe(-100 * PAGE_RUBBER);
    expect(dragOffset(-100, 0, 10)).toBe(-100);
  });
});

describe('pageKeyDelta', () => {
  it('maps arrows and Page Up/Down', () => {
    expect(pageKeyDelta('ArrowRight')).toBe(1);
    expect(pageKeyDelta('ArrowDown')).toBe(1);
    expect(pageKeyDelta('PageDown')).toBe(1);
    expect(pageKeyDelta('ArrowLeft')).toBe(-1);
    expect(pageKeyDelta('ArrowUp')).toBe(-1);
    expect(pageKeyDelta('PageUp')).toBe(-1);
    expect(pageKeyDelta(' ')).toBe(0);
    expect(pageKeyDelta('b')).toBe(0);
  });
});

describe('windowEdge', () => {
  const both = { before: true, after: true };

  it('asks for more text near either end of the window', () => {
    expect(windowEdge(20, 40, both)).toBeNull();
    expect(windowEdge(40 - 1 - EDGE_PAGES, 40, both)).toBe('after');
    expect(windowEdge(39, 40, both)).toBe('after');
    expect(windowEdge(EDGE_PAGES, 40, both)).toBe('before');
    expect(windowEdge(0, 40, both)).toBe('before');
  });

  it('stays quiet at the ends of the document', () => {
    expect(windowEdge(39, 40, { before: true, after: false })).toBeNull();
    expect(windowEdge(0, 40, { before: false, after: true })).toBeNull();
  });
});

describe('pagedWindow / growWindow', () => {
  it('renders a smaller window than scrolling', () => {
    expect(pagedWindow(500, 13000)).toEqual({
      start: 500 - PAGED_BEFORE,
      end: 500 + PAGED_AFTER,
    });
    expect(pagedWindow(3, 13000)).toEqual({ start: 0, end: PAGED_BEFORE + PAGED_AFTER });
  });

  it('grows towards the edge the reader is reaching', () => {
    const range = { start: 460, end: 580 };
    expect(growWindow(range, 'after', 13000, 575)).toEqual({
      start: 460,
      end: 580 + PAGED_EXTEND,
    });
    expect(growWindow(range, 'before', 13000, 462)).toEqual({
      start: 460 - PAGED_EXTEND,
      end: 580,
    });
    expect(growWindow({ start: 10, end: 100 }, 'before', 13000, 12)).toEqual({
      start: 0,
      end: 100,
    });
    expect(growWindow({ start: 12900, end: 12990 }, 'after', 13000, 12980)).toEqual({
      start: 12900,
      end: 13000,
    });
  });

  it('re-centres on the page instead of growing past the limit', () => {
    const range = { start: 1000, end: 1000 + PAGED_MAX };
    expect(growWindow(range, 'after', 13000, 1230)).toEqual(pagedWindow(1230, 13000));
  });
});

describe('page numbers', () => {
  it('sums characters per segment', () => {
    expect(Array.from(charOffsets([10, 0, 5, -3]))).toEqual([0, 10, 10, 15, 15]);
  });

  it('estimates the pages before the window from its characters per page', () => {
    expect(estimatePagesBefore(0, 40_000, 80)).toBe(0);
    expect(estimatePagesBefore(100_000, 40_000, 80)).toBe(200);
    expect(estimatePagesBefore(1_000, 0, 1)).toBe(0);
  });

  it('reports a whole-number percentage', () => {
    expect(percentRead(0, 1000)).toBe(0);
    expect(percentRead(374, 1000)).toBe(37);
    expect(percentRead(1000, 1000)).toBe(100);
    expect(percentRead(5, 0)).toBe(0);
  });
});

describe('two pages side by side', () => {
  it('fit when each page holds a comfortable line at this text size', () => {
    // 2 × 24 em × 20 px + 48 px gap + 40 px padding = 1048 px.
    expect(spreadFits(1048, 20)).toBe(true);
    expect(spreadFits(1047, 20)).toBe(false);
    // A phone on its side or a portrait tablet keeps one page.
    expect(spreadFits(915, 20)).toBe(false);
    // Larger text needs more room.
    expect(spreadFits(1200, 26)).toBe(false);
  });
  it('never count on more room than the widened reading column', () => {
    expect(spreadFits(3000, 27)).toBe(2 * 24 * 27 + PAGE_GAP + 40 <= SPREAD_MAX_PX);
    expect(spreadFits(3000, 30)).toBe(false);
  });
  it('lay out whole-px pages and turn a whole screen at a time', () => {
    expect(pageGeometry(600, 1)).toEqual({ column: 600, width: 600, pitch: 600 + PAGE_GAP });
    // (1001 − 48) / 2 = 476.5 → 476 px pages; the run is 1000 px and a screen is two pages.
    expect(pageGeometry(1001, 2)).toEqual({
      column: 476,
      width: 1000,
      pitch: 2 * (476 + PAGE_GAP),
    });
  });
  it('find the screen holding a page of the second column', () => {
    const { column, pitch } = pageGeometry(1000, 2);
    // Columns 0–1 are screen 0, columns 2–3 screen 1.
    expect(pageOfOffset(column + PAGE_GAP, pitch)).toBe(0);
    expect(pageOfOffset(2 * (column + PAGE_GAP), pitch)).toBe(1);
    expect(pageOfOffset(3 * (column + PAGE_GAP), pitch)).toBe(1);
  });
  it('keep most of the left page for reading taps', () => {
    expect(tapZone(1000 * 0.2, 1000, SPREAD_EDGE_ZONE)).toBe('centre');
    expect(tapZone(1000 * 0.1, 1000, SPREAD_EDGE_ZONE)).toBe('previous');
    expect(tapZone(1000 * 0.95, 1000, SPREAD_EDGE_ZONE)).toBe('next');
  });
});
