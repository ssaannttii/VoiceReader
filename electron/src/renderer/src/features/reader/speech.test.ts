import { describe, expect, it } from 'vitest';
import type { ReaderSpeech, ReaderSpeechItem } from './reader-api';
import {
  appliedCount,
  groupSpeechChanges,
  nameSuggestions,
  speechAudioChanged,
  speechBusy,
  speechPercent,
} from './speech';

const item = (n: number, segment: number, original: string, spoken: string, extra = {}) =>
  ({
    n,
    segment,
    c0: n,
    c1: n + original.length,
    original,
    spoken,
    kind: 'roman',
    source: 'rule',
    state: 'applied',
    scope: 'here',
    count: 1,
    ...extra,
  }) as ReaderSpeechItem;

const speech = (extra: Partial<ReaderSpeech> = {}): ReaderSpeech => ({
  enabled: false,
  status: 'idle',
  progress: null,
  error: null,
  ready: false,
  stale: false,
  complete: false,
  prepared_at: null,
  llm: null,
  pause_rules: {} as ReaderSpeech['pause_rules'],
  pause_counts: {} as ReaderSpeech['pause_counts'],
  items: [],
  ...extra,
});

describe('groupSpeechChanges', () => {
  const chapters = [
    { title: 'Uno', segment: 2 },
    { title: 'Dos', segment: 10 },
  ];

  it('groups by chapter in reading order and merges identical changes', () => {
    const groups = groupSpeechChanges(
      [
        item(3, 12, 'XIV', 'catorce'),
        item(1, 0, 'EE. UU.', 'Estados Unidos'),
        item(2, 4, 'XIV', 'catorce'),
        item(4, 5, 'XIV', 'catorce'),
        item(5, 6, 'XIV', 'catorce', { state: 'reverted' }),
        item(6, 7, 'Kelsier', 'Kélsier', { scope: 'doc', state: 'suggested' }),
      ],
      chapters,
    );
    expect(groups.map((group) => group.title)).toEqual([null, 'Uno', 'Dos']);
    const uno = groups[1].changes;
    expect(uno.map((change) => [change.original, change.state, change.count])).toEqual([
      ['XIV', 'applied', 2],
      ['XIV', 'reverted', 1],
    ]);
    expect(uno[0].first.n).toBe(2);
    // Name suggestions are listed apart.
    expect(groups.flatMap((group) => group.changes).some((c) => c.original === 'Kelsier')).toBe(
      false,
    );
  });
});

describe('speech helpers', () => {
  it('lists name suggestions by frequency', () => {
    const names = nameSuggestions([
      item(1, 0, 'Vin', 'Vin', { scope: 'doc', count: 3 }),
      item(2, 0, 'Kelsier', 'Kélsier', { scope: 'doc', count: 9 }),
      item(3, 0, 'XIV', 'catorce'),
    ]);
    expect(names.map((name) => name.original)).toEqual(['Kelsier', 'Vin']);
  });

  it('reports progress and counts', () => {
    expect(speechBusy(speech({ status: 'running' }))).toBe(true);
    expect(speechBusy(speech({ status: 'ready' }))).toBe(false);
    expect(speechPercent(speech({ progress: 0.456 }))).toBe(46);
    expect(speechPercent(undefined)).toBe(0);
    expect(
      appliedCount(
        speech({ items: [item(1, 0, 'a', 'b'), item(2, 0, 'c', 'd', { state: 'reverted' })] }),
      ),
    ).toBe(1);
  });

  it('refreshes audio only when what is said changes', () => {
    const off = speech({ ready: true });
    const on = speech({ ready: true, enabled: true });
    expect(speechAudioChanged(off, on)).toBe(true);
    expect(speechAudioChanged(on, off)).toBe(true);
    // Switched on before anything was prepared: nothing to refresh yet...
    expect(speechAudioChanged(speech(), speech({ enabled: true }))).toBe(false);
    // ...until the results arrive.
    expect(speechAudioChanged(speech({ enabled: true }), on)).toBe(true);
    expect(speechAudioChanged(on, { ...on, progress: 0.5 })).toBe(false);
    expect(speechAudioChanged(undefined, on)).toBe(false);
  });
});
