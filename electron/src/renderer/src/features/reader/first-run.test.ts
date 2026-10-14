import { afterEach, describe, expect, it, vi } from 'vitest';
import { tipText } from './first-run-card';
import {
  firstRunState,
  markTip,
  markVoiceAsked,
  nextTip,
  resetFirstRun,
  sampleLanguage,
  sanitizeFirstRun,
  shouldAskVoice,
  type FirstRunState,
} from './first-run';
import type { ReaderVoice } from './reader-api';
import { languageName } from './voice-picker';

const voice = (id: string, language: string | null) =>
  ({
    id,
    name: id,
    kind: 'profile',
    engine: null,
    language,
    description: null,
  }) satisfies ReaderVoice;
const voices = [voice('Lucía', 'es'), voice('Mateo', 'es-ES'), voice('Emma', 'en')];
const fresh: FirstRunState = { tips: [], voiceAsked: [] };
const ask = (patch: Partial<Parameters<typeof shouldAskVoice>[0]> = {}) =>
  shouldAskVoice({
    state: fresh,
    language: 'es',
    voiceId: null,
    defaults: {},
    voices,
    ...patch,
  });

afterEach(() => resetFirstRun());

describe('sanitizeFirstRun', () => {
  it('keeps known tips in order and string languages once', () => {
    expect(
      sanitizeFirstRun({ tips: ['menu', 'bogus', 'tap'], voiceAsked: ['es', 3, 'es'] }),
    ).toEqual({ tips: ['tap', 'menu'], voiceAsked: ['es'] });
  });
  it('turns anything else into a fresh state', () => {
    expect(sanitizeFirstRun(null)).toEqual(fresh);
    expect(sanitizeFirstRun({ tips: 'tap' })).toEqual(fresh);
  });
});

describe('tips', () => {
  it('come one at a time until all are seen', () => {
    expect(nextTip(firstRunState())).toBe('tap');
    markTip('press');
    expect(nextTip(firstRunState())).toBe('tap');
    markTip('tap');
    expect(nextTip(firstRunState())).toBe('menu');
    markTip('menu');
    expect(nextTip(firstRunState())).toBeNull();
  });
  it('are remembered on this device', async () => {
    // In-memory Storage: Node's own experimental `localStorage` can shadow jsdom's.
    const data = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
    });
    try {
      vi.resetModules();
      const store = await import('./first-run');
      store.markTip('tap');
      store.markVoiceAsked('es-ES');
      // A fresh load (next visit) reads the same state back.
      vi.resetModules();
      const reloaded = await import('./first-run');
      expect(reloaded.firstRunState()).toEqual({ tips: ['tap'], voiceAsked: ['es'] });
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('follow the double-tap preference and the pointer', () => {
    expect(tipText('tap', { doubleTap: false, touch: true })).toBe('reader.tip_tap');
    expect(tipText('tap', { doubleTap: true, touch: true })).toBe('reader.tip_double_tap');
    expect(tipText('press', { doubleTap: false, touch: true })).toBe('reader.tip_press');
    expect(tipText('press', { doubleTap: false, touch: false })).toBe('reader.tip_right_click');
    expect(tipText('menu', { doubleTap: false, touch: false })).toBe('reader.tip_menu');
  });
});

describe('shouldAskVoice', () => {
  it('asks for a language with a choice and no default voice', () => {
    expect(ask()).toBe(true);
    expect(ask({ language: 'es-ES' })).toBe(true);
  });
  it('waits for the PC to answer', () => {
    expect(ask({ defaults: undefined })).toBe(false);
    expect(ask({ voices: undefined })).toBe(false);
  });
  it('stays quiet when there is nothing to choose', () => {
    expect(ask({ voiceId: 'Lucía' })).toBe(false);
    expect(ask({ defaults: { es: 'Lucía' } })).toBe(false);
    expect(ask({ defaults: { 'es-ES': 'Lucía' } })).toBe(false);
    expect(ask({ language: 'en' })).toBe(false);
    expect(ask({ language: null })).toBe(false);
  });
  it('counts multilingual voices for every language', () => {
    expect(ask({ language: 'en', voices: [...voices, voice('Omni', null)] })).toBe(true);
  });
  it('asks once per language on this device', () => {
    markVoiceAsked('es-ES');
    expect(ask({ state: firstRunState() })).toBe(false);
    expect(
      ask({ state: firstRunState(), language: 'en', voices: [...voices, voice('Ava', 'en')] }),
    ).toBe(true);
  });
});

it('writes the sample in the UI language', () => {
  expect(sampleLanguage('es')).toBe('es');
  expect(sampleLanguage('pt-BR')).toBe('pt');
  expect(sampleLanguage('zh-TW')).toBe('zh');
  expect(sampleLanguage(undefined)).toBeUndefined();
});

it('names the language as it reads mid-sentence', () => {
  expect(languageName('es', 'es', { inSentence: true })).toBe('español');
  expect(languageName('es', 'es')).toBe('Español');
  expect(languageName('en', 'de', { inSentence: true })).toBe('Englisch');
});
