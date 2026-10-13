import { afterEach, describe, expect, it } from 'vitest';
import {
  AB_HISTORY_MAX,
  abVariants,
  abVotes,
  addVote,
  blindMapping,
  clearVotes,
  labelOf,
  pickOtherVoice,
  recordVote,
  resolveChoice,
  sanitizeVotes,
  speakableSegment,
  tallyVotes,
  trialKey,
  type AbVote,
} from './labs-ab';
import type { ReaderVoice } from './reader-api';

const ctx = { prepared: false, voice: 'v1', engine: 'omnivoice', language: 'es' };

const vote = (patch: Partial<AbVote> = {}): AbVote => ({
  at: 1,
  comparison: 'prepared',
  segment: 3,
  winner: 'a',
  blind: true,
  a: 'prepared',
  b: 'plain',
  ...patch,
});

describe('blind mapping', () => {
  it('assigns X and Y to A and B in either order', () => {
    expect(blindMapping(() => 0.1)).toEqual({ x: 'a', y: 'b' });
    expect(blindMapping(() => 0.9)).toEqual({ x: 'b', y: 'a' });
  });

  it('resolves a blind vote to the variant behind the label', () => {
    const swapped = { x: 'b', y: 'a' } as const;
    expect(resolveChoice('x', swapped)).toBe('b');
    expect(resolveChoice('y', swapped)).toBe('a');
    expect(resolveChoice('same', swapped)).toBe('same');
    // Open (non-blind) votes name the side directly.
    expect(resolveChoice('a', swapped)).toBe('a');
    expect(labelOf('a', swapped)).toBe('y');
    expect(labelOf('b', swapped)).toBe('x');
  });

  it('is roughly balanced over many trials', () => {
    let x = 0;
    for (let i = 0; i < 2000; i++) if (blindMapping().x === 'a') x++;
    expect(x).toBeGreaterThan(800);
    expect(x).toBeLessThan(1200);
  });
});

describe('variants', () => {
  it('prepared vs plain keeps voice and quality', () => {
    const [a, b] = abVariants('prepared', { ...ctx, numStep: 32 });
    expect([a.prepared, b.prepared]).toEqual([true, false]);
    expect([a.num_step, b.num_step]).toEqual([32, 32]);
    expect([a.tag, b.tag]).toEqual(['prepared', 'plain']);
  });

  it('quality compares the default with 32 steps on what the player reads', () => {
    const [a, b] = abVariants('quality', { ...ctx, prepared: true, numStep: 32 });
    expect([a.num_step, b.num_step]).toEqual([undefined, 32]);
    expect([a.prepared, b.prepared]).toEqual([true, true]);
  });

  it('voice A vs B uses each voice with its engine', () => {
    const [a, b] = abVariants('voice', {
      ...ctx,
      voiceA: { id: 'v1', engine: null },
      voiceB: { id: 'v2', engine: 'kittentts' },
    });
    expect([a.voice, a.engine]).toEqual(['v1', 'omnivoice']);
    expect([b.voice, b.engine]).toEqual(['v2', 'kittentts']);
    expect(trialKey(4, [a, b])).not.toBe(trialKey(5, [a, b]));
    expect(trialKey(4, [a, b])).toBe(
      trialKey(
        4,
        abVariants('voice', {
          ...ctx,
          voiceA: { id: 'v1', engine: null },
          voiceB: { id: 'v2', engine: 'kittentts' },
        }),
      ),
    );
  });

  it('suggests another voice in the document language', () => {
    const voices: ReaderVoice[] = [
      { id: 'en1', name: 'En', kind: 'profile', engine: null, language: 'en', description: null },
      {
        id: 'es0',
        name: 'Preset',
        kind: 'preset',
        engine: null,
        language: 'es',
        description: null,
      },
      { id: 'v1', name: 'Mine', kind: 'profile', engine: null, language: 'es', description: null },
      { id: 'es2', name: 'Ana', kind: 'profile', engine: null, language: 'es', description: null },
    ];
    expect(pickOtherVoice(voices, 'v1', 'es')?.id).toBe('es2');
    expect(pickOtherVoice(voices.slice(0, 1), 'en1', 'es')).toBeNull();
  });

  it('skips segments without words', () => {
    const segments = [{ text: '' }, { text: '* * *' }, { text: 'Hola.' }, { text: '' }];
    expect(speakableSegment(segments, 0)).toBe(2);
    expect(speakableSegment(segments, 3, -1)).toBe(2);
    expect(speakableSegment(segments, 3)).toBeNull();
  });
});

describe('vote history', () => {
  afterEach(() => clearVotes());

  it('keeps the newest votes first, capped', () => {
    let history: AbVote[] = [];
    for (let i = 0; i < AB_HISTORY_MAX + 5; i++) history = addVote(history, vote({ at: i }));
    expect(history).toHaveLength(AB_HISTORY_MAX);
    expect(history[0].at).toBe(AB_HISTORY_MAX + 4);
  });

  it('tallies per comparison type', () => {
    const tally = tallyVotes([
      vote({ winner: 'a' }),
      vote({ winner: 'a' }),
      vote({ winner: 'same' }),
      vote({ comparison: 'quality', winner: 'b', a: 'normal', b: '32' }),
    ]);
    expect(tally.prepared).toEqual({ a: 2, b: 0, same: 1, total: 3 });
    expect(tally.quality).toEqual({ a: 0, b: 1, same: 0, total: 1 });
    expect(tally.voice).toEqual({ a: 0, b: 0, same: 0, total: 0 });
  });

  it('drops malformed stored votes', () => {
    expect(sanitizeVotes('nope')).toEqual([]);
    expect(
      sanitizeVotes([vote(), { ...vote(), winner: 'c' }, { ...vote(), comparison: 'x' }, null]),
    ).toEqual([vote()]);
  });

  it('records and clears through the store', () => {
    recordVote(vote({ at: 10 }));
    recordVote(vote({ at: 11, winner: 'b' }));
    expect(abVotes().map((entry) => entry.at)).toEqual([11, 10]);
    clearVotes();
    expect(abVotes()).toEqual([]);
  });
});
