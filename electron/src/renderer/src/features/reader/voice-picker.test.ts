import { describe, expect, it } from 'vitest';
import type { ReaderVoice } from './reader-api';
import {
  ALL_LANGUAGES,
  defaultVoiceLanguage,
  filterVoices,
  languageKey,
  parseRecent,
  pushRecent,
  voiceLanguages,
} from './voice-picker';

const voice = (id: string, language: string | null, description: string | null = null) =>
  ({
    id,
    name: id,
    kind: 'profile',
    engine: null,
    language,
    description,
  }) satisfies ReaderVoice;

const voices = [
  voice('Lucía', 'es'),
  voice('Mateo', 'es-ES', 'Narrador cálido'),
  voice('Emma', 'en'),
  voice('Multi', null),
];

describe('voiceLanguages', () => {
  it('lists base languages, most voices first', () => {
    expect(voiceLanguages(voices)).toEqual(['es', 'en']);
  });
});

describe('languageKey', () => {
  it('maps codes, regional tags and English names to one key', () => {
    expect(languageKey('es-ES')).toBe('es');
    expect(languageKey('Spanish')).toBe('es');
    expect(languageKey('ENGLISH')).toBe('en');
    expect(languageKey('Klingon')).toBe('klingon');
    expect(languageKey(null)).toBe('');
  });
  it('lets a voice listed as "Spanish" match a Spanish document', () => {
    const named = [voice('Andrés', 'Spanish'), voice('Emma', 'English')];
    expect(defaultVoiceLanguage(named, 'es')).toBe('es');
    expect(filterVoices(named, 'es', '').map((item) => item.id)).toEqual(['Andrés']);
  });
});

describe('defaultVoiceLanguage', () => {
  it('uses the document language when a voice speaks it', () => {
    expect(defaultVoiceLanguage(voices, 'es')).toBe('es');
    expect(defaultVoiceLanguage(voices, 'fr')).toBe(ALL_LANGUAGES);
    expect(defaultVoiceLanguage(voices, null)).toBe(ALL_LANGUAGES);
  });
});

describe('filterVoices', () => {
  it('keeps language-less voices in every language', () => {
    expect(filterVoices(voices, 'es', '').map((item) => item.id)).toEqual([
      'Lucía',
      'Mateo',
      'Multi',
    ]);
  });
  it('searches name and description without accents', () => {
    expect(filterVoices(voices, ALL_LANGUAGES, 'lucia').map((item) => item.id)).toEqual(['Lucía']);
    expect(filterVoices(voices, ALL_LANGUAGES, 'CALIDO').map((item) => item.id)).toEqual(['Mateo']);
  });
});

describe('recent voices', () => {
  it('moves the used voice first, dedupes and keeps five', () => {
    expect(pushRecent(['a', 'b', 'c', 'd', 'e'], 'c')).toEqual(['c', 'a', 'b', 'd', 'e']);
    expect(pushRecent(['a', 'b', 'c', 'd', 'e'], 'f')).toEqual(['f', 'a', 'b', 'c', 'd']);
  });
  it('ignores malformed storage', () => {
    expect(parseRecent('x')).toEqual([]);
    expect(parseRecent(['a', 1, 'b'])).toEqual(['a', 'b']);
  });
});
