import { describe, expect, it } from 'vitest';
import {
  ACTION_WIDTH,
  dragOffset,
  fullThreshold,
  pastFull,
  releaseSwipe,
  swipeIntent,
  type SwipeLayout,
} from './swipe-math';

const layout: SwipeLayout = { start: 1, end: 2, width: 400 };

describe('swipeIntent', () => {
  it('waits for the slop, then favours vertical scrolling on diagonals', () => {
    expect(swipeIntent(4, 3)).toBeNull();
    expect(swipeIntent(20, 2)).toBe('horizontal');
    expect(swipeIntent(-20, 4)).toBe('horizontal');
    expect(swipeIntent(3, 20)).toBe('vertical');
    expect(swipeIntent(20, 18)).toBe('vertical');
  });
});

describe('dragOffset', () => {
  it('follows the finger up to the full-swipe threshold', () => {
    expect(dragOffset(60, layout)).toBe(60);
    expect(dragOffset(-150, layout)).toBe(-150);
  });

  it('rubber-bands past the threshold', () => {
    const limit = fullThreshold(layout, 'start');
    expect(limit).toBe(240);
    expect(dragOffset(limit + 100, layout)).toBe(limit + 20);
    expect(dragOffset(-(limit + 50), layout)).toBe(-(limit + 10));
  });

  it('does not move toward a side without actions', () => {
    expect(dragOffset(80, { ...layout, start: 0 })).toBe(0);
    expect(dragOffset(-80, { ...layout, end: 0 })).toBe(0);
  });
});

describe('fullThreshold', () => {
  it('is 60% of the row, but always past the open actions', () => {
    expect(fullThreshold({ start: 1, end: 2, width: 400 }, 'end')).toBe(240);
    expect(fullThreshold({ start: 1, end: 3, width: 300 }, 'end')).toBe(3 * ACTION_WIDTH + 32);
  });
});

describe('releaseSwipe', () => {
  it('snaps closed under half an action', () => {
    expect(releaseSwipe(ACTION_WIDTH / 2 - 1, layout)).toEqual({ type: 'close' });
    expect(releaseSwipe(0, layout)).toEqual({ type: 'close' });
  });

  it('rests open on the actions of the swiped side', () => {
    expect(releaseSwipe(ACTION_WIDTH / 2 + 1, layout)).toEqual({
      type: 'open',
      side: 'start',
      offset: ACTION_WIDTH,
    });
    expect(releaseSwipe(-120, layout)).toEqual({
      type: 'open',
      side: 'end',
      offset: -2 * ACTION_WIDTH,
    });
  });

  it('commits the edge action past the threshold', () => {
    expect(releaseSwipe(240, layout)).toEqual({ type: 'commit', side: 'start' });
    expect(releaseSwipe(-260, layout)).toEqual({ type: 'commit', side: 'end' });
    expect(pastFull(-239, layout)).toBe(false);
    expect(pastFull(-240, layout)).toBe(true);
  });
});
