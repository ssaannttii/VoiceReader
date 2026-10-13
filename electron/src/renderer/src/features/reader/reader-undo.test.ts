import { describe, expect, it } from 'vitest';
import { samePosition, UndoStack } from './reader-undo';

describe('UndoStack', () => {
  it('remembers where a jump started and pops it back', () => {
    const stack = new UndoStack();
    const entry = stack.push({ segment: 10, offset: 3.2 }, { segment: 200, offset: 0 }, 1000);
    expect(entry).toEqual({ segment: 10, offset: 3.2, at: 1000 });
    expect(stack.peek()).toEqual(entry);
    expect(stack.pop()).toEqual(entry);
    expect(stack.pop()).toBeNull();
  });

  it('ignores jumps that go nowhere', () => {
    const stack = new UndoStack();
    expect(stack.push({ segment: 5, offset: 1 }, { segment: 5, offset: 2 })).toBeNull();
    expect(stack.size).toBe(0);
    // Same sentence but far inside it is a real jump.
    expect(stack.push({ segment: 5, offset: 1 }, { segment: 5, offset: 30 })).not.toBeNull();
  });

  it('keeps one entry for repeated jumps from the same spot', () => {
    const stack = new UndoStack();
    stack.push({ segment: 1, offset: 0 }, { segment: 50, offset: 0 }, 1);
    stack.push({ segment: 50, offset: 0 }, { segment: 90, offset: 0 }, 2);
    stack.push({ segment: 50, offset: 0.5 }, { segment: 70, offset: 0 }, 3);
    expect(stack.size).toBe(2);
    expect(stack.pop()).toEqual({ segment: 50, offset: 0.5, at: 3 });
    expect(stack.pop()?.segment).toBe(1);
  });

  it('stays bounded', () => {
    const stack = new UndoStack(3);
    for (let index = 0; index < 10; index++)
      stack.push({ segment: index * 10, offset: 0 }, { segment: index * 10 + 5, offset: 0 });
    expect(stack.size).toBe(3);
    expect(stack.pop()?.segment).toBe(90);
  });

  it('compares positions with a small tolerance', () => {
    expect(samePosition({ segment: 1, offset: 0 }, { segment: 1, offset: 1.5 })).toBe(true);
    expect(samePosition({ segment: 1, offset: 0 }, { segment: 2, offset: 0 })).toBe(false);
  });
});
