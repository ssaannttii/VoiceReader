import { describe, expect, it } from 'vitest';
import { parseShareSearch, shareRequest } from './reader-share';
import { existingEntry, findTerm, previewWindow } from './pronunciation';

describe('parseShareSearch', () => {
  it('keeps known string fields and counts', () => {
    expect(
      parseShareSearch({ title: 'T', text: ' ', url: 'https://a.b', files: '2', other: 'x' }),
    ).toEqual({ title: 'T', url: 'https://a.b', files: 2 });
    expect(parseShareSearch({ failed: '-1', files: 'abc' })).toEqual({});
  });
});

describe('shareRequest', () => {
  it('prefers the url field', () => {
    expect(shareRequest({ url: 'https://example.com/a', text: 'hello' })).toEqual({
      kind: 'url',
      url: 'https://example.com/a',
    });
  });

  it('finds a link Chrome put in the text after the title', () => {
    expect(
      shareRequest({
        title: 'Artículo',
        text: 'Un artículo interesante https://elpais.com/x.html.',
      }),
    ).toEqual({ kind: 'url', url: 'https://elpais.com/x.html' });
  });

  it('imports long text with a link as text', () => {
    const text = `${'Una frase larga. '.repeat(20)}https://example.com`;
    expect(shareRequest({ text, title: 'Nota' })).toEqual({
      kind: 'text',
      text: text.trim(),
      title: 'Nota',
    });
  });

  it('imports plain text, or a lone title', () => {
    expect(shareRequest({ text: 'Hola mundo' })).toEqual({ kind: 'text', text: 'Hola mundo' });
    expect(shareRequest({ title: 'https://example.com' })).toEqual({
      kind: 'url',
      url: 'https://example.com/',
    });
    expect(shareRequest({ title: 'Solo título' })).toEqual({ kind: 'text', text: 'Solo título' });
  });

  it('ignores non-web links and empty shares', () => {
    expect(shareRequest({ url: 'content://x', text: 'algo' })).toEqual({
      kind: 'text',
      text: 'algo',
    });
    expect(shareRequest({})).toBeNull();
  });

  it('reports files the service worker uploaded', () => {
    expect(shareRequest({ files: 2, failed: 1, error: 'too large' })).toEqual({
      kind: 'files',
      files: 2,
      failed: 1,
      error: 'too large',
    });
  });
});

describe('pronunciation helpers', () => {
  const entries = [
    { id: '1', term: 'Jürgen', replacement: 'Yurgen', language: '*' },
    { id: '2', term: 'jürgen', replacement: 'Yúrguen', language: 'es' },
  ];

  it('prefers the document language entry, then a global one', () => {
    expect(existingEntry(entries, 'JÜRGEN', 'es')?.id).toBe('2');
    expect(existingEntry(entries, 'Jürgen', 'en')?.id).toBe('1');
    expect(existingEntry(entries, 'Otro', 'es')).toBeNull();
  });

  it('finds a whole word from the reading position, wrapping around', () => {
    const segments = ['Mi amigo Jürgen.', 'Jürgens no.', 'Hola jürgen'].map((text, i) => ({
      i,
      text,
      para: i,
      kind: 'p' as const,
    }));
    expect(findTerm(segments, 'Jürgen', 1)).toEqual({ segment: 2, offset: 5 });
    expect(findTerm(segments, 'Jürgen', 0)).toEqual({ segment: 0, offset: 9 });
    expect(findTerm(segments, 'a.b', 0)).toBeNull();
  });

  it('plays around the word, within the sentence', () => {
    const words = [
      { w: 'Hola', start: 0.1, end: 0.5, c0: 0, c1: 4 },
      { w: 'Jürgen', start: 0.6, end: 1.2, c0: 5, c1: 11 },
    ];
    expect(previewWindow(words, 5, 3)).toEqual({ start: 0, end: 2.2 });
    expect(previewWindow([], 0, 3)).toEqual({ start: 0, end: 3 });
  });
});
