import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLongPress, LONG_PRESS_MS, wordAt } from './reader-long-press';

describe('createLongPress', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fires after holding still', () => {
    const onPress = vi.fn();
    const press = createLongPress({ onPress });
    press.down({ x: 10, y: 20 });
    vi.advanceTimersByTime(LONG_PRESS_MS - 1);
    expect(onPress).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onPress).toHaveBeenCalledWith({ x: 10, y: 20 });
    expect(press.fired).toBe(true);
  });

  it('tolerates jitter but cancels on a scroll or drag', () => {
    const onPress = vi.fn();
    const press = createLongPress({ onPress });
    press.down({ x: 0, y: 0 });
    press.move({ x: 4, y: 5 });
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(onPress).toHaveBeenCalledTimes(1);

    press.down({ x: 0, y: 0 });
    press.move({ x: 0, y: 30 });
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(press.fired).toBe(false);
  });

  it('a short tap never fires, and a new press clears the last one', () => {
    const onPress = vi.fn();
    const press = createLongPress({ onPress });
    press.down({ x: 0, y: 0 });
    vi.advanceTimersByTime(200);
    press.up();
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(onPress).not.toHaveBeenCalled();

    press.down({ x: 0, y: 0 });
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(press.consume()).toBe(true);
    expect(press.consume()).toBe(false);
    press.down({ x: 1, y: 1 });
    expect(press.fired).toBe(false);
    press.cancel();
  });
});

describe('wordAt', () => {
  it('finds the word around an offset', () => {
    expect(wordAt('Hola, señor Pérez.', 8)).toEqual({ word: 'señor', start: 6 });
    expect(wordAt('Hola, señor Pérez.', 0)).toEqual({ word: 'Hola', start: 0 });
    // Just past the last letter still picks the word.
    expect(wordAt('Hola, señor Pérez.', 17)).toEqual({ word: 'Pérez', start: 12 });
  });

  it('keeps apostrophes and hyphens inside words', () => {
    expect(wordAt("l'eau du e-mail", 2)).toEqual({ word: "l'eau", start: 0 });
    expect(wordAt("l'eau du e-mail", 11)).toEqual({ word: 'e-mail', start: 9 });
  });

  it('returns null on spaces and punctuation', () => {
    expect(wordAt('a — b', 2)).toBeNull();
    expect(wordAt('', 0)).toBeNull();
  });

  it('handles characters outside the BMP', () => {
    const text = '𝒜 Jürgen';
    expect(wordAt(text, text.indexOf('J') + 1)).toEqual({ word: 'Jürgen', start: 3 });
  });
});
