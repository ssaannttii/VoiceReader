/**
 * Reader Labs A/B listening tests: which two variants a comparison renders,
 * the blind X/Y mapping, and the local vote history (last 20, this device).
 * Pure helpers plus a tiny localStorage store; the sheet is lab-sheet.tsx.
 */
import { useSyncExternalStore } from 'react';
import type { ReaderVoice, ReaderVoiceChoice } from './reader-api';
import { HIGH_QUALITY_STEPS } from './labs-prefs';

export const AB_COMPARISONS = ['prepared', 'voice', 'quality'] as const;
export type AbComparison = (typeof AB_COMPARISONS)[number];
export type AbSide = 'a' | 'b';
/** Blind labels: X and Y stand for A and B in a random order. */
export type AbLabel = 'x' | 'y';
export type AbMapping = Record<AbLabel, AbSide>;
/** What the listener tapped: a label (blind), a side (open), or "same". */
export type AbChoice = AbLabel | AbSide | 'same';
export type AbWinner = AbSide | 'same';

/** One variant to render: the preview route's body. */
export interface AbVariant extends ReaderVoiceChoice {
  prepared: boolean;
  /** Short, content-free description kept with a vote ("prepared", "32", a voice id). */
  tag: string;
}

export interface AbContext {
  /** What the player reads now (prepared reading on and ready). */
  prepared: boolean;
  voice: string | null;
  engine: string | null;
  language: string | null;
  /** This device's quality setting (undefined = engine default). */
  numStep?: number;
  /** "Voz A vs Voz B": the two voices (null = the default voice). */
  voiceA?: { id: string | null; engine: string | null };
  voiceB?: { id: string | null; engine: string | null };
}

/** The two variants of a comparison, in the order its title names them. */
export function abVariants(comparison: AbComparison, ctx: AbContext): [AbVariant, AbVariant] {
  const base = {
    voice: ctx.voice,
    engine: ctx.engine,
    language: ctx.language,
    num_step: ctx.numStep,
    prepared: ctx.prepared,
  };
  if (comparison === 'prepared')
    return [
      { ...base, prepared: true, tag: 'prepared' },
      { ...base, prepared: false, tag: 'plain' },
    ];
  if (comparison === 'quality')
    return [
      { ...base, num_step: undefined, tag: 'normal' },
      { ...base, num_step: HIGH_QUALITY_STEPS, tag: String(HIGH_QUALITY_STEPS) },
    ];
  const a = ctx.voiceA ?? { id: ctx.voice, engine: ctx.engine };
  const b = ctx.voiceB ?? { id: null, engine: null };
  return [
    { ...base, voice: a.id, engine: a.engine ?? ctx.engine, tag: a.id ?? 'default' },
    { ...base, voice: b.id, engine: b.engine ?? ctx.engine, tag: b.id ?? 'default' },
  ];
}

/** Stable key of a trial: same key ⇒ the rendered audio can be reused. */
export function trialKey(segment: number, variants: readonly AbVariant[]): string {
  return JSON.stringify([
    segment,
    variants.map((v) => [v.prepared, v.voice ?? null, v.engine ?? null, v.num_step ?? null]),
  ]);
}

/** A random X/Y assignment (`random` in [0, 1), injectable for tests). */
export function blindMapping(random: () => number = Math.random): AbMapping {
  return random() < 0.5 ? { x: 'a', y: 'b' } : { x: 'b', y: 'a' };
}

/** The variant behind what was tapped (labels need the mapping). */
export function resolveChoice(choice: AbChoice, mapping: AbMapping): AbWinner {
  if (choice === 'x' || choice === 'y') return mapping[choice];
  return choice;
}

/** The label a side carries under a mapping. */
export function labelOf(side: AbSide, mapping: AbMapping): AbLabel {
  return mapping.x === side ? 'x' : 'y';
}

/** A voice to compare against: same language first (profiles before presets), never `current`. */
export function pickOtherVoice(
  voices: readonly ReaderVoice[],
  current: string | null,
  language: string | null,
): ReaderVoice | null {
  const others = voices.filter((voice) => voice.id !== current);
  const lang = (language ?? '').toLowerCase();
  const rank = (voice: ReaderVoice) =>
    (lang && (voice.language ?? '').toLowerCase().startsWith(lang) ? 0 : 2) +
    (voice.kind === 'profile' ? 0 : 1);
  return others.slice().sort((x, y) => rank(x) - rank(y))[0] ?? null;
}

/**
 * The first segment from `from` (moving by `step`) with words to say — images
 * and empty segments render as silence and cannot be compared. Null if none.
 */
export function speakableSegment(
  segments: readonly { text: string }[],
  from: number,
  step: 1 | -1 = 1,
): number | null {
  for (let index = from; index >= 0 && index < segments.length; index += step) {
    if (/[\p{L}\p{N}]/u.test(segments[index]?.text ?? '')) return index;
  }
  return null;
}

// ── Vote history ────────────────────────────────────────────────────────────

export interface AbVote {
  at: number;
  comparison: AbComparison;
  segment: number;
  winner: AbWinner;
  blind: boolean;
  a: string;
  b: string;
}

export interface AbTally {
  a: number;
  b: number;
  same: number;
  total: number;
}

export const AB_HISTORY_MAX = 20;
const KEY = 'voicestudio.reader.labs.votes';

/** Valid votes from anything stored (old versions, hand edits), newest first. */
export function sanitizeVotes(value: unknown): AbVote[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (vote): vote is AbVote =>
        Boolean(vote) &&
        typeof vote === 'object' &&
        AB_COMPARISONS.includes(vote.comparison) &&
        ['a', 'b', 'same'].includes(vote.winner) &&
        typeof vote.at === 'number' &&
        typeof vote.segment === 'number',
    )
    .map((vote) => ({
      at: vote.at,
      comparison: vote.comparison,
      segment: vote.segment,
      winner: vote.winner,
      blind: vote.blind === true,
      a: String(vote.a ?? ''),
      b: String(vote.b ?? ''),
    }))
    .slice(0, AB_HISTORY_MAX);
}

/** History with `vote` first, capped. */
export function addVote(history: readonly AbVote[], vote: AbVote, max = AB_HISTORY_MAX): AbVote[] {
  return [vote, ...history].slice(0, max);
}

export function tallyVotes(history: readonly AbVote[]): Record<AbComparison, AbTally> {
  const tally = Object.fromEntries(
    AB_COMPARISONS.map((comparison) => [comparison, { a: 0, b: 0, same: 0, total: 0 }]),
  ) as Record<AbComparison, AbTally>;
  for (const vote of history) {
    const row = tally[vote.comparison];
    row[vote.winner] += 1;
    row.total += 1;
  }
  return tally;
}

function read(): AbVote[] {
  try {
    return sanitizeVotes(JSON.parse(localStorage.getItem(KEY) ?? '[]'));
  } catch {
    return [];
  }
}

let votes: AbVote[] = typeof localStorage === 'undefined' ? [] : read();
const listeners = new Set<() => void>();

function save(next: AbVote[]) {
  votes = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(votes));
  } catch {
    /* The history stays for this session. */
  }
  listeners.forEach((listener) => listener());
}

export function abVotes(): AbVote[] {
  return votes;
}

export function recordVote(vote: AbVote): void {
  save(addVote(votes, vote));
}

export function clearVotes(): void {
  save([]);
}

export function useAbVotes(): AbVote[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    abVotes,
    abVotes,
  );
}
