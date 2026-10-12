import { describe, expect, it } from 'vitest';
import type { ReaderSegment, ReaderWord } from './reader-api';
import {
  chapterEndSegment,
  chapterIndexAt,
  clampSpeed,
  formatClock,
  groupBlocks,
  splitWords,
  wordIndexAt,
} from './reader-text';

const seg = (i: number, para: number, kind: 'h' | 'p' = 'p', text = `S${i}.`): ReaderSegment => ({
  i,
  text,
  para,
  kind,
});

describe('groupBlocks', () => {
  it('joins sentences of one paragraph and isolates headings', () => {
    const blocks = groupBlocks([
      seg(0, 0, 'h'),
      seg(1, 1),
      seg(2, 1),
      seg(3, 2),
      seg(4, 3, 'h'),
      seg(5, 3, 'h'),
      seg(6, 4),
    ]);
    expect(blocks.map((block) => [block.kind, block.segments.map((s) => s.i)])).toEqual([
      ['h', [0]],
      ['p', [1, 2]],
      ['p', [3]],
      ['h', [4]],
      ['h', [5]],
      ['p', [6]],
    ]);
    expect(new Set(blocks.map((block) => block.key)).size).toBe(blocks.length);
  });

  it('returns nothing for an empty document', () => {
    expect(groupBlocks([])).toEqual([]);
  });
});

describe('wordIndexAt', () => {
  const words: ReaderWord[] = [
    { w: 'Hola', start: 0.1, end: 0.4, c0: 0, c1: 4 },
    { w: 'mundo,', start: 0.5, end: 0.9, c0: 5, c1: 11 },
    { w: 'adiós.', start: 1.3, end: 1.8, c0: 12, c1: 18 },
  ];

  it('is -1 before the first word', () => {
    expect(wordIndexAt(words, 0)).toBe(-1);
    expect(wordIndexAt([], 3)).toBe(-1);
  });

  it('finds the word at its boundaries and holds it through pauses', () => {
    expect(wordIndexAt(words, 0.1)).toBe(0);
    expect(wordIndexAt(words, 0.45)).toBe(0);
    expect(wordIndexAt(words, 0.5)).toBe(1);
    expect(wordIndexAt(words, 1.1)).toBe(1);
    expect(wordIndexAt(words, 1.3)).toBe(2);
    expect(wordIndexAt(words, 99)).toBe(2);
  });

  it('matches a linear scan on a long sentence', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      w: 'x',
      start: i * 0.25,
      end: i * 0.25 + 0.2,
      c0: i * 2,
      c1: i * 2 + 1,
    }));
    for (let t = -0.1; t < 52; t += 0.37) {
      const linear = many.reduce((found, word, index) => (word.start <= t ? index : found), -1);
      expect(wordIndexAt(many, t)).toBe(linear);
    }
  });
});

describe('splitWords', () => {
  it('keeps punctuation and spacing outside of word runs intact', () => {
    const text = '«Hola»  mundo';
    const parts = splitWords(text, [
      { w: '«Hola»', start: 0, end: 1, c0: 0, c1: 6 },
      { w: 'mundo', start: 1, end: 2, c0: 8, c1: 13 },
    ]);
    expect(parts.map((part) => part.text).join('')).toBe(text);
    expect(parts.filter((part) => part.word !== null).map((part) => part.text)).toEqual([
      '«Hola»',
      'mundo',
    ]);
  });

  it('tolerates offsets beyond the text', () => {
    const parts = splitWords('Hi', [{ w: 'Hi', start: 0, end: 1, c0: 0, c1: 10 }]);
    expect(parts).toEqual([{ text: 'Hi', word: 0 }]);
  });
});

describe('chapters', () => {
  const chapters = [
    { title: 'One', segment: 0 },
    { title: 'Two', segment: 10 },
    { title: 'Three', segment: 25 },
  ];
  it('locates the current chapter and where it ends', () => {
    expect(chapterIndexAt(chapters, 0)).toBe(0);
    expect(chapterIndexAt(chapters, 12)).toBe(1);
    expect(chapterIndexAt([], 12)).toBe(-1);
    expect(chapterEndSegment(chapters, 12, 40)).toBe(25);
    expect(chapterEndSegment(chapters, 30, 40)).toBe(40);
    expect(chapterEndSegment([], 3, 40)).toBe(40);
  });
});

describe('formatting', () => {
  it('formats clocks and speeds', () => {
    expect(formatClock(5)).toBe('0:05');
    expect(formatClock(3725)).toBe('1:02:05');
    expect(clampSpeed(0.2)).toBe(0.5);
    expect(clampSpeed(1.26)).toBe(1.3);
    expect(clampSpeed(9)).toBe(3);
  });
});
