/**
 * Background music (Labs) — the pure decisions: the PC's music plan for a
 * document (`GET /reader/documents/{id}/music`), which cue should sound at a
 * segment ("Moments" follows the spots, "Continuous" the timeline), clip
 * chaining without immediate repeats, crossfade lengths and the element gain.
 * Playback lives in music-engine.ts, the wiring in reader-music.ts.
 */

export const MUSIC_PALETTES = [
  'dark_fantasy',
  'bright_fantasy',
  'classic_novel',
  'contemporary_thriller',
  'mystery_noir',
  'romance_warm',
  'scifi_space',
  'historical',
  'nonfiction_minimal',
] as const;
export type MusicPaletteId = (typeof MUSIC_PALETTES)[number];

export const MUSIC_MOODS = [
  'calm',
  'wonder',
  'tension',
  'dread',
  'melancholy',
  'warmth',
  'resolve',
] as const;
export type MusicMood = (typeof MUSIC_MOODS)[number];

export const MUSIC_STATUSES = [
  'off',
  'queued',
  'analyzing',
  'generating',
  'ready',
  'error',
  'unavailable',
] as const;
export type MusicStatus = (typeof MUSIC_STATUSES)[number];

export type MusicMode = 'moments' | 'continuous';

export interface MusicFile {
  name: string;
  /** Seconds. */
  duration: number;
}

export interface MusicCue {
  id: string;
  mood: string;
  files: MusicFile[];
  ready: boolean;
}

export interface MusicSpot {
  start_segment: number;
  /** Inclusive. */
  end_segment: number;
  cue: string;
  max_seconds: number;
}

export interface MusicSpan {
  start_segment: number;
  /** Inclusive. */
  end_segment: number;
  cue: string;
}

export interface ReaderMusic {
  status: MusicStatus;
  progress: number;
  error: string | null;
  engine_available: boolean;
  palette: { id: string; source: 'auto' | 'user' } | null;
  palettes: { id: string }[];
  cues: MusicCue[];
  spots: MusicSpot[];
  timeline: MusicSpan[];
  level_lufs: number;
}

// ── tuning ─────────────────────────────────────────────────────────────────

/** The PC masters every clip to this loudness. */
export const DESIGN_LUFS = -30;
/** Volume slider, in dB relative to the PC's master (0 dB = the clips as mastered). */
export const MUSIC_VOLUME_MIN_DB = -24;
export const MUSIC_VOLUME_MAX_DB = 0;
/** A little under the master, so there is room both ways (an element cannot go above 1). */
export const MUSIC_VOLUME_DEFAULT_DB = -3;
/** From silence into a cue. */
export const FADE_IN_SECONDS = 6;
/** Leaving a spot (or to silence in Continuous). */
export const FADE_OUT_SECONDS = 10;
/** Between two cues. */
export const CUE_CROSSFADE_SECONDS = 10;
/** Between two clips of the same cue (same palette clips flow over ~10 s). */
export const CLIP_CROSSFADE_SECONDS = 9;
/** A new document (queue advance): the old music leaves quickly. */
export const DOC_CHANGE_FADE_SECONDS = 4;
/** Switched off from the sheet. */
export const STOP_FADE_SECONDS = 2;
/** A played spot sounds again only after going back this many segments before its start. */
export const REARM_SEGMENTS = 30;

const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,160}$/;

// ── sanitizing ─────────────────────────────────────────────────────────────

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isIndex = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export function validClipName(name: unknown): name is string {
  return typeof name === 'string' && FILE_RE.test(name) && !name.includes('..');
}

/** The PC's answer with anything malformed dropped (unknown statuses read as `error`). */
export function sanitizeMusic(value: unknown): ReaderMusic {
  const raw = isObject(value) ? value : {};
  const status = MUSIC_STATUSES.includes(raw.status as MusicStatus)
    ? (raw.status as MusicStatus)
    : isObject(value)
      ? 'error'
      : 'off';
  const progress =
    typeof raw.progress === 'number' && Number.isFinite(raw.progress)
      ? Math.min(1, Math.max(0, raw.progress))
      : 0;
  const palette =
    isObject(raw.palette) && typeof raw.palette.id === 'string' && raw.palette.id
      ? {
          id: raw.palette.id,
          source: raw.palette.source === 'user' ? ('user' as const) : ('auto' as const),
        }
      : null;
  const cues: MusicCue[] = [];
  for (const cue of list(raw.cues)) {
    if (!isObject(cue) || typeof cue.id !== 'string' || !cue.id) continue;
    const files = list(cue.files).filter(
      (file): file is MusicFile =>
        isObject(file) &&
        validClipName(file.name) &&
        typeof file.duration === 'number' &&
        Number.isFinite(file.duration) &&
        file.duration > 0,
    );
    cues.push({
      id: cue.id,
      mood: typeof cue.mood === 'string' ? cue.mood : '',
      files: files.map((file) => ({ name: file.name, duration: file.duration })),
      ready: cue.ready === true && files.length > 0,
    });
  }
  const range = (item: unknown): item is Record<string, unknown> & MusicSpan =>
    isObject(item) &&
    isIndex(item.start_segment) &&
    isIndex(item.end_segment) &&
    item.end_segment >= item.start_segment &&
    typeof item.cue === 'string' &&
    Boolean(item.cue);
  const bySegment = (a: MusicSpan, b: MusicSpan) => a.start_segment - b.start_segment;
  const spots = list(raw.spots)
    .filter(range)
    .filter(
      (spot) =>
        typeof spot.max_seconds === 'number' &&
        Number.isFinite(spot.max_seconds) &&
        spot.max_seconds > 0,
    )
    .map((spot) => ({
      start_segment: spot.start_segment,
      end_segment: spot.end_segment,
      cue: spot.cue,
      max_seconds: spot.max_seconds as number,
    }))
    .sort(bySegment);
  const timeline = list(raw.timeline)
    .filter(range)
    .map((span) => ({
      start_segment: span.start_segment,
      end_segment: span.end_segment,
      cue: span.cue,
    }))
    .sort(bySegment);
  return {
    status,
    progress,
    error: typeof raw.error === 'string' && raw.error ? raw.error : null,
    engine_available: raw.engine_available !== false,
    palette,
    palettes: list(raw.palettes)
      .filter((item): item is { id: string } => isObject(item) && typeof item.id === 'string')
      .map((item) => ({ id: item.id })),
    cues,
    spots,
    timeline,
    level_lufs:
      typeof raw.level_lufs === 'number' && Number.isFinite(raw.level_lufs)
        ? raw.level_lufs
        : DESIGN_LUFS,
  };
}

/** The PC is still working on it (poll). */
export function musicBusy(music: ReaderMusic | null | undefined): boolean {
  return (
    music?.status === 'queued' || music?.status === 'analyzing' || music?.status === 'generating'
  );
}

/** At least one cue can sound. */
export function musicPlayable(music: ReaderMusic | null | undefined): boolean {
  return Boolean(music?.cues.some((cue) => cue.ready));
}

// ── lookups ────────────────────────────────────────────────────────────────

/** The range containing `segment` in a list sorted by start (first one wins on overlaps). */
export function rangeAt<T extends MusicSpan>(ranges: readonly T[], segment: number): T | null {
  for (const range of ranges) {
    if (range.start_segment > segment) break;
    if (segment <= range.end_segment) return range;
  }
  return null;
}

export function spotKey(spot: MusicSpot): string {
  return `${spot.start_segment}-${spot.end_segment}:${spot.cue}`;
}

// ── gain and fades ─────────────────────────────────────────────────────────

/**
 * Element volume: the slider in dB, corrected for clips mastered at another
 * loudness than designed, times the sleep fade (never above 1).
 */
export function musicGain(volumeDb: number, levelLufs: number, fade: number): number {
  const db = Math.min(MUSIC_VOLUME_MAX_DB, Math.max(MUSIC_VOLUME_MIN_DB, volumeDb));
  const level = Number.isFinite(levelLufs) ? levelLufs : DESIGN_LUFS;
  const trim = Math.min(12, Math.max(-12, DESIGN_LUFS - level));
  const gain = 10 ** ((db + trim) / 20) * Math.min(1, Math.max(0, fade));
  return Math.min(1, Math.max(0, gain));
}

/** Crossfade between two clips of a cue: ~9 s, shorter for short clips. */
export function clipCrossfadeSeconds(duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 1;
  return Math.max(0.5, Math.min(CLIP_CROSSFADE_SECONDS, duration / 3));
}

/** A volume ramp in the engine's clock (ms), shaped for equal-power crossfades. */
export interface Envelope {
  from: number;
  to: number;
  start: number;
  ms: number;
}

/** Envelope value at `t`; rising ramps follow sin, falling ones cos (equal power). */
export function envelopeAt(env: Envelope, t: number): number {
  const p = env.ms > 0 ? Math.min(1, Math.max(0, (t - env.start) / env.ms)) : 1;
  const q = (p * Math.PI) / 2;
  return env.to >= env.from
    ? env.from + (env.to - env.from) * Math.sin(q)
    : env.to + (env.from - env.to) * Math.cos(q);
}

export function envelopeDone(env: Envelope, t: number): boolean {
  return env.ms <= 0 || t >= env.start + env.ms;
}

// ── clip chaining ──────────────────────────────────────────────────────────

/**
 * The next clip of a cue: random among its files but never the one that just
 * played (unless it is the only one); `skip` leaves out clips that failed.
 */
export function nextClip(
  files: readonly MusicFile[],
  previous: string | null,
  random: () => number = Math.random,
  skip: ReadonlySet<string> = new Set(),
): MusicFile | null {
  const usable = files.filter((file) => !skip.has(file.name));
  if (!usable.length) return null;
  const fresh = usable.filter((file) => file.name !== previous);
  const pool = fresh.length ? fresh : usable;
  const index = Math.min(pool.length - 1, Math.floor(Math.max(0, random()) * pool.length));
  return pool[index];
}

// ── director ───────────────────────────────────────────────────────────────

/** What should sound: a cue (fading in from silence over `fadeIn`) or silence (fading over `fadeOut`). */
export interface MusicTarget {
  cue: string | null;
  /** Spot key or `tl:<cue>`, for diagnostics. */
  key: string | null;
  fadeIn: number;
  fadeOut: number;
}

const SILENCE: MusicTarget = { cue: null, key: null, fadeIn: 0, fadeOut: FADE_OUT_SECONDS };

/**
 * Decides which cue sounds from the reading position and listening time.
 *
 * - Moments: entering a spot whose cue is ready starts it (fade in); it plays
 *   at most `max_seconds` (its fade-out included) and fades out early when the
 *   narration leaves the spot. A played spot is spent for the session: going
 *   back into it does not replay it unless the reading went back more than
 *   `REARM_SEGMENTS` before its start.
 * - Continuous: the timeline's cue at the segment; a cue that is not ready yet
 *   keeps the current one (or silence).
 */
export class MusicDirector {
  private mode: MusicMode = 'moments';
  private spots: readonly MusicSpot[] = [];
  private timeline: readonly MusicSpan[] = [];
  private ready = new Set<string>();
  private segment: number | null = null;
  private spent = new Map<string, MusicSpot>();
  private spot: { key: string; spot: MusicSpot; listened: number } | null = null;
  private continuous: string | null = null;
  private fadeOut = FADE_OUT_SECONDS;

  get currentMode(): MusicMode {
    return this.mode;
  }

  setMode(mode: MusicMode) {
    if (mode === this.mode) return;
    this.mode = mode;
    // A spot cut short by the switch stays spent; the other mode decides afresh.
    this.spot = null;
    this.continuous = null;
    this.fadeOut = FADE_OUT_SECONDS;
    this.evaluate();
  }

  /** The document's plan (null: none); played spots are kept. */
  setPlan(music: ReaderMusic | null) {
    this.spots = music?.spots ?? [];
    this.timeline = music?.timeline ?? [];
    this.ready = new Set((music?.cues ?? []).filter((cue) => cue.ready).map((cue) => cue.id));
    this.evaluate();
  }

  /** Another document: nothing has played yet. */
  reset() {
    this.spent.clear();
    this.spot = null;
    this.continuous = null;
    this.segment = null;
    this.fadeOut = FADE_OUT_SECONDS;
  }

  setSegment(segment: number) {
    if (segment === this.segment) return;
    this.segment = segment;
    // Far enough back before a spot, it may play again.
    for (const [key, spot] of this.spent)
      if (segment < spot.start_segment - REARM_SEGMENTS) this.spent.delete(key);
    this.evaluate();
  }

  /** Seconds the music was audible with the voice (spot budgets). */
  listen(seconds: number) {
    if (!this.spot || !(seconds > 0) || !Number.isFinite(seconds)) return;
    this.spot.listened += seconds;
    this.evaluate();
  }

  /** Spots played (or cut short) in this session, for tests and diagnostics. */
  spentKeys(): string[] {
    return [...this.spent.keys()];
  }

  target(): MusicTarget {
    if (this.mode === 'moments') {
      if (!this.spot) return { ...SILENCE, fadeOut: this.fadeOut };
      const max = this.spot.spot.max_seconds;
      return {
        cue: this.spot.spot.cue,
        key: this.spot.key,
        fadeIn: Math.min(FADE_IN_SECONDS, max / 3),
        fadeOut: this.fadeOut,
      };
    }
    if (!this.continuous) return SILENCE;
    return {
      cue: this.continuous,
      key: `tl:${this.continuous}`,
      fadeIn: FADE_IN_SECONDS,
      fadeOut: FADE_OUT_SECONDS,
    };
  }

  private evaluate() {
    if (this.segment === null) return;
    if (this.mode === 'continuous') {
      const cue = rangeAt(this.timeline, this.segment)?.cue ?? null;
      if (cue && this.ready.has(cue)) this.continuous = cue;
      else if (!cue || !this.continuous || !this.ready.has(this.continuous)) this.continuous = null;
      return;
    }
    const segment = this.segment;
    if (this.spot) {
      const { spot, listened } = this.spot;
      const outFor = Math.min(FADE_OUT_SECONDS, spot.max_seconds / 3);
      if (segment < spot.start_segment || segment > spot.end_segment || !this.ready.has(spot.cue)) {
        this.spot = null;
        this.fadeOut = FADE_OUT_SECONDS;
      } else if (listened >= spot.max_seconds - outFor) {
        // The fade-out fits in what is left of the budget.
        this.spot = null;
        this.fadeOut = Math.max(0.5, Math.min(outFor, spot.max_seconds - listened));
      }
    }
    if (this.spot) return;
    const spot = rangeAt(this.spots, segment);
    if (!spot || !this.ready.has(spot.cue)) return;
    const key = spotKey(spot);
    if (this.spent.has(key)) return;
    this.spent.set(key, spot);
    this.spot = { key, spot, listened: 0 };
  }
}
