/** Prepared reading ("Lectura preparada"): pure helpers for the review sheet. */
import type {
  ReaderChapter,
  ReaderPauseRule,
  ReaderSpeech,
  ReaderSpeechItem,
  ReaderSpeechKind,
} from './reader-api';
import { chapterIndexAt } from './reader-text';

/** Pause rules in the order the sheet lists them. */
export const PAUSE_RULES: readonly ReaderPauseRule[] = [
  'heading',
  'chapter',
  'scene',
  'paragraph',
  'dialogue',
  'list',
  'quote',
  'ellipsis',
];

export const PAUSE_RULE_LABELS = {
  heading: 'reader.speech_pause_heading',
  chapter: 'reader.speech_pause_chapter',
  scene: 'reader.speech_pause_scene',
  paragraph: 'reader.speech_pause_paragraph',
  dialogue: 'reader.speech_pause_dialogue',
  list: 'reader.speech_pause_list',
  quote: 'reader.speech_pause_quote',
  ellipsis: 'reader.speech_pause_ellipsis',
} as const satisfies Record<ReaderPauseRule, string>;

export const SPEECH_KIND_LABELS = {
  roman: 'reader.speech_kind_roman',
  abbr: 'reader.speech_kind_abbr',
  ordinal: 'reader.speech_kind_ordinal',
  number: 'reader.speech_kind_number',
  date: 'reader.speech_kind_date',
  time: 'reader.speech_kind_time',
  caps: 'reader.speech_kind_caps',
  acronym: 'reader.speech_kind_acronym',
  hyphen: 'reader.speech_kind_hyphen',
  symbol: 'reader.speech_kind_symbol',
  name: 'reader.speech_kind_name',
} as const satisfies Record<ReaderSpeechKind, string>;

/** Identical changes in one chapter, shown once ("XIV → catorce ×3"). */
export interface SpeechChange {
  key: string;
  original: string;
  spoken: string;
  kind: ReaderSpeechKind;
  state: ReaderSpeechItem['state'];
  edited: boolean;
  /** First occurrence: compared and edited on behalf of the group. */
  first: ReaderSpeechItem;
  count: number;
}

export interface SpeechGroup {
  key: string;
  /** Chapter title; null before the first chapter. */
  title: string | null;
  changes: SpeechChange[];
}

/** Changes made in place (not name suggestions), by chapter in reading order. */
export function groupSpeechChanges(
  items: readonly ReaderSpeechItem[],
  chapters: readonly ReaderChapter[],
): SpeechGroup[] {
  const sorted = items
    .filter((item) => item.scope !== 'doc')
    .slice()
    .sort((a, b) => a.segment - b.segment || a.c0 - b.c0);
  const groups: SpeechGroup[] = [];
  const byChapter = new Map<number, { group: SpeechGroup; changes: Map<string, SpeechChange> }>();
  for (const item of sorted) {
    const chapter = chapterIndexAt(chapters, item.segment);
    let entry = byChapter.get(chapter);
    if (!entry) {
      const group: SpeechGroup = {
        key: `c${chapter}`,
        title: chapter >= 0 ? (chapters[chapter]?.title ?? null) : null,
        changes: [],
      };
      entry = { group, changes: new Map() };
      byChapter.set(chapter, entry);
      groups.push(group);
    }
    const key = `${item.original}\u0000${item.spoken}\u0000${item.state}`;
    const existing = entry.changes.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }
    const change: SpeechChange = {
      key: `${entry.group.key}-${item.n}`,
      original: item.original,
      spoken: item.spoken,
      kind: item.kind,
      state: item.state,
      edited: Boolean(item.edited),
      first: item,
      count: 1,
    };
    entry.changes.set(key, change);
    entry.group.changes.push(change);
  }
  return groups;
}

/** Name respellings (one per name), most frequent first. */
export function nameSuggestions(items: readonly ReaderSpeechItem[]): ReaderSpeechItem[] {
  return items
    .filter((item) => item.scope === 'doc')
    .slice()
    .sort((a, b) => b.count - a.count || a.original.localeCompare(b.original));
}

export function speechBusy(speech: ReaderSpeech | undefined): boolean {
  return speech?.status === 'queued' || speech?.status === 'running';
}

export function speechPercent(speech: ReaderSpeech | undefined): number {
  return Math.max(0, Math.min(100, Math.round((speech?.progress ?? 0) * 100)));
}

/** Changes the voice actually makes (applied, in place or by name). */
export function appliedCount(speech: ReaderSpeech | undefined): number {
  return speech?.items.filter((item) => item.state === 'applied').length ?? 0;
}

/**
 * Whether a state change alters what the player will say, so its rendered
 * audio must be refreshed: the switch changed, or the results became usable
 * (or changed) while the switch is on.
 */
export function speechAudioChanged(
  before: ReaderSpeech | undefined,
  after: ReaderSpeech | undefined,
): boolean {
  if (!before || !after) return false;
  if (before.enabled !== after.enabled) return before.ready || after.ready;
  if (!after.enabled) return false;
  return before.ready !== after.ready;
}
