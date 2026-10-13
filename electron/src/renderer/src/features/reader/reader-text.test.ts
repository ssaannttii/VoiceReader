import { describe, expect, it } from 'vitest';
import type { ReaderSegment, ReaderWord } from './reader-api';
import {
  chapterEndSegment,
  chapterIndexAt,
  clampSpeed,
  formatClock,
  groupBlocks,
  layoutBlocks,
  segmentLabel,
  splitWords,
  wordIndexAt,
  blockIndexBySegment,
  windowAround,
  type LayoutNode,
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

  it('keeps list items, quotes and images apart', () => {
    const blocks = groupBlocks([
      seg(0, 0),
      li(1, 1, 0, 1),
      li(2, 1, 0, 1, 'Second sentence of item one.'),
      li(3, 2, 0, 2),
      quote(4, 3),
      quote(5, 3),
      quote(6, 4),
      img(7, 5),
      img(8, 6),
      seg(9, 7),
    ]);
    expect(blocks.map((block) => [block.kind, block.segments.map((s) => s.i)])).toEqual([
      ['p', [0]],
      ['li', [1, 2]],
      ['li', [3]],
      ['quote', [4, 5]],
      ['quote', [6]],
      ['img', [7]],
      ['img', [8]],
      ['p', [9]],
    ]);
  });

  it('never joins a paragraph with a list item or quote of the same para', () => {
    const blocks = groupBlocks([seg(0, 0), { ...li(1, 0, 0, 1) }, { ...quote(2, 0) }]);
    expect(blocks.map((block) => block.kind)).toEqual(['p', 'li', 'quote']);
  });

  it('reads unknown kinds as body text', () => {
    const odd = { i: 0, text: 'x', para: 0, kind: 'table' } as unknown as ReaderSegment;
    expect(groupBlocks([odd])[0].kind).toBe('p');
  });
});

const li = (
  i: number,
  para: number,
  list: number,
  n: number,
  text = `Item ${i}.`,
  depth = 0,
  ordered = false,
): ReaderSegment => ({ i, text, para, kind: 'li', list, n, ordered, depth });
const quote = (i: number, para: number): ReaderSegment => ({
  i,
  text: `Q${i}.`,
  para,
  kind: 'quote',
});
const img = (i: number, para: number): ReaderSegment => ({
  i,
  text: '',
  para,
  kind: 'img',
  src: `/reader/documents/x/assets/img-${i}.png`,
});

describe('layoutBlocks', () => {
  type Shape = string | { list: number; ordered: boolean; depth: number; items: unknown[] };
  const shape = (nodes: LayoutNode[]): Shape[] =>
    nodes.map((node) => {
      if (node.type === 'block') return `${node.block.kind}:${node.block.segments[0].i}`;
      if (node.type === 'quote')
        return `quote:${node.blocks.map((b) => b.segments[0].i).join(',')}`;
      return {
        list: node.id,
        ordered: node.ordered,
        depth: node.depth,
        items: node.items.map((item) => ({
          n: item.n,
          paras: item.blocks.map((b) => b.segments[0].i),
          ...(item.lists.length ? { lists: shape(item.lists) } : {}),
        })),
      };
    });

  it('builds nested lists with their numbers', () => {
    const blocks = groupBlocks([
      seg(0, 0),
      li(1, 1, 0, 1),
      li(2, 2, 1, 1, 'Nested.', 1, true),
      li(3, 3, 1, 2, 'Nested two.', 1, true),
      li(4, 4, 2, 1, 'Deeper.', 2),
      li(5, 5, 0, 2),
      li(6, 6, 0, 2, 'Second paragraph of item two.'),
      seg(7, 7),
      li(8, 8, 3, 5, 'Five.', 0, true),
    ]);
    expect(shape(layoutBlocks(blocks))).toEqual([
      'p:0',
      {
        list: 0,
        ordered: false,
        depth: 0,
        items: [
          {
            n: 1,
            paras: [1],
            lists: [
              {
                list: 1,
                ordered: true,
                depth: 1,
                items: [
                  { n: 1, paras: [2] },
                  {
                    n: 2,
                    paras: [3],
                    lists: [{ list: 2, ordered: false, depth: 2, items: [{ n: 1, paras: [4] }] }],
                  },
                ],
              },
            ],
          },
          { n: 2, paras: [5, 6] },
        ],
      },
      'p:7',
      { list: 3, ordered: true, depth: 0, items: [{ n: 5, paras: [8] }] },
    ]);
  });

  it('starts a new list for a different list at the same depth', () => {
    const blocks = groupBlocks([li(0, 0, 0, 1), li(1, 1, 1, 1)]);
    const nodes = layoutBlocks(blocks);
    expect(nodes).toHaveLength(2);
    expect(new Set(nodes.map((node) => node.key)).size).toBe(2);
  });

  it('opens a window that starts inside a nested list at its depth', () => {
    const blocks = groupBlocks([li(0, 0, 1, 3, 'Deep.', 1), li(1, 1, 0, 2)]);
    expect(shape(layoutBlocks(blocks))).toEqual([
      { list: 1, ordered: false, depth: 1, items: [{ n: 3, paras: [0] }] },
      { list: 0, ordered: false, depth: 0, items: [{ n: 2, paras: [1] }] },
    ]);
  });

  it('joins consecutive quote paragraphs and keeps images as blocks', () => {
    const blocks = groupBlocks([quote(0, 0), quote(1, 1), img(2, 2), quote(3, 3)]);
    expect(shape(layoutBlocks(blocks))).toEqual(['quote:0,1', 'img:2', 'quote:3']);
  });
});

describe('segmentLabel', () => {
  it('describes images by alt, caption or a fallback', () => {
    expect(segmentLabel({ ...img(0, 0), alt: 'A map' }, 'Image')).toBe('A map');
    expect(segmentLabel({ ...img(0, 0), caption: 'Fig. 1' }, 'Image')).toBe('Fig. 1');
    expect(segmentLabel(img(0, 0), 'Image')).toBe('Image');
    expect(segmentLabel(seg(1, 0), 'Image')).toBe('S1.');
    expect(segmentLabel(undefined)).toBe('');
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

describe('block windows', () => {
  const segments = Array.from({ length: 10 }, (_, i) => ({
    i,
    text: `s${i}`,
    para: Math.floor(i / 2),
    kind: 'p' as const,
  }));

  it('maps segments to their paragraph blocks', () => {
    const blocks = groupBlocks(segments);
    expect(Array.from(blockIndexBySegment(blocks, segments.length))).toEqual([
      0, 0, 1, 1, 2, 2, 3, 3, 4, 4,
    ]);
  });

  it('centres a bounded window on the anchor and clamps at both ends', () => {
    expect(windowAround(500, 10_000, 60, 140)).toEqual({ start: 440, end: 640 });
    expect(windowAround(10, 10_000, 60, 140)).toEqual({ start: 0, end: 200 });
    expect(windowAround(9_999, 10_000, 60, 140)).toEqual({ start: 9_939, end: 10_000 });
    expect(windowAround(3, 5, 60, 140)).toEqual({ start: 0, end: 5 });
  });
});
