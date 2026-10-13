import { describe, expect, it } from 'vitest';
import type { ReaderSegment } from './reader-api';
import {
  buildSearchIndex,
  foldText,
  prepareQuery,
  searchDocument,
  snippetFor,
} from './reader-search';

const segments = (texts: string[]): ReaderSegment[] =>
  texts.map((text, i) => ({ i, text, para: i, kind: 'p' }));

describe('foldText', () => {
  it('drops case and accents', () => {
    expect(foldText('Canción ÁRBOL Pingüino')).toBe('cancion arbol pinguino');
  });
});

describe('prepareQuery', () => {
  it('ignores single Latin letters but accepts a single ideograph', () => {
    expect(prepareQuery(' a ')).toBe('');
    expect(prepareQuery('猫')).toBe('猫');
  });
  it('collapses inner whitespace', () => {
    expect(prepareQuery('  el   río ')).toBe('el rio');
  });
});

describe('searchDocument', () => {
  const index = buildSearchIndex(
    segments([
      'El río suena.',
      'Nada aquí.',
      'Otro RIO, y otro río más.',
      // Decomposed accent (e + U+0301): folded text is shorter than the original.
      'Café con rio',
    ]),
  );

  it('is case- and accent-insensitive, one hit per segment in order', () => {
    const result = searchDocument(index, 'Río');
    expect(result.total).toBe(3);
    expect(result.hits.map((hit) => hit.segment)).toEqual([0, 2, 3]);
    expect(result.hits[1]).toEqual({ segment: 2, start: 5, end: 8 });
  });

  it('maps offsets back to the display text when folding changes its length', () => {
    const hit = searchDocument(index, 'cafe con').hits[0];
    const text = 'Café con rio';
    expect(hit.segment).toBe(3);
    expect(text.slice(hit.start, hit.end)).toBe('Café con');
  });

  it('caps the results but still counts every match', () => {
    const many = buildSearchIndex(segments(Array.from({ length: 50 }, () => 'hola mundo')));
    const result = searchDocument(many, 'mundo', 10);
    expect(result.hits).toHaveLength(10);
    expect(result.total).toBe(50);
  });

  it('returns nothing for an empty or too short query', () => {
    expect(searchDocument(index, '').total).toBe(0);
    expect(searchDocument(index, 'r').total).toBe(0);
  });

  it('searches a 15,000-sentence book quickly', () => {
    const words = ['montaña', 'río', 'ciudad', 'noche', 'Sanderson', 'espada', 'luz', 'tormenta'];
    const book = segments(
      Array.from(
        { length: 15_000 },
        (_, i) =>
          `Frase ${i}: la ${words[i % words.length]} y la ${words[(i * 7) % words.length]} bajo la lluvia de otoño.`,
      ),
    );
    const built = performance.now();
    const big = buildSearchIndex(book);
    const indexed = performance.now();
    const result = searchDocument(big, 'tormenta');
    const searched = performance.now();
    expect(result.total).toBeGreaterThan(1000);
    expect(result.hits).toHaveLength(200);
    // Generous bounds for CI; a phone is ~4× slower than a desktop CPU.
    expect(indexed - built).toBeLessThan(1500);
    expect(searched - indexed).toBeLessThan(100);
  });
});

describe('snippetFor', () => {
  it('cuts long sentences at word boundaries with ellipses', () => {
    const text =
      'Primera parte muy larga de la frase que no importa, aquí está la palabra clave buscada, y luego sigue mucho más texto sin interés alguno.';
    const start = text.indexOf('clave');
    const snippet = snippetFor(text, start, start + 5, 20);
    expect(snippet.match).toBe('clave');
    expect(snippet.before.startsWith('…')).toBe(true);
    expect(snippet.after.endsWith('…')).toBe(true);
    // 20 characters back lands inside "aquí", so the snippet starts at the next word.
    expect(snippet.before).toBe('…está la palabra ');
  });

  it('keeps short sentences whole', () => {
    expect(snippetFor('Hola mundo', 5, 10)).toEqual({ before: 'Hola ', match: 'mundo', after: '' });
  });
});
