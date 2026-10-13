/**
 * Automatic ambience — the pure decisions: which bed a scene gets, when a
 * change is allowed (hysteresis), crossfade lengths and curves, and ducking.
 * The scenes come from `GET /reader/documents/{id}/ambience` (backend
 * services/reader_ambience.py); playback lives in ambience-engine.ts.
 */
import { AMBIENT_RMS, MANUAL_RMS, isAmbientBed, type BedId } from './soundscape-synth';

export const AMBIENCE_TAGS = [
  'rain',
  'storm',
  'wind',
  'sea',
  'forest',
  'night',
  'fire',
  'tavern',
  'city',
  'interior',
  'cave',
  'mist',
  'snow',
  'river',
  'crowd',
  'temple',
  'library',
  'road',
  'town',
] as const;
export type AmbienceSceneTag = (typeof AMBIENCE_TAGS)[number];
export type AmbienceTag = AmbienceSceneTag | 'none';

export interface AmbienceScene {
  start_segment: number;
  /** Inclusive. */
  end_segment: number;
  tag: string;
  confidence: number;
  intensity: number;
}

/**
 * The synthesized bed each scene tag plays (reusing the manual rain, café and
 * fireplace loops) when no recording is available; null = no synthesized
 * stand-in is good enough, so silence (a river is not the sea).
 */
export const TAG_BED: Record<AmbienceSceneTag, BedId | null> = {
  rain: 'rain',
  storm: 'storm',
  wind: 'wind',
  sea: 'sea',
  forest: 'forest',
  night: 'night',
  fire: 'fire',
  tavern: 'cafe',
  city: 'city',
  interior: 'room',
  cave: 'cave',
  mist: 'wind',
  snow: 'wind',
  river: null,
  crowd: 'city',
  temple: 'room',
  library: 'room',
  road: null,
  town: 'city',
};

/** A recorded loop of the ambience pack (`rec:<file>`), as opposed to a synthesized bed. */
export type RecordedKey = `rec:${string}`;
/** What an element plays: a synthesized bed or a recorded loop. */
export type BedKey = BedId | RecordedKey;

/** The bed chosen for a tag; `rms` is a recording's loudness (synthesized beds know theirs). */
export interface BedChoice {
  key: BedKey;
  rms?: number;
  /** Played instead when the recording cannot be loaded (offline and not cached, removed). */
  fallback?: BedChoice | null;
}

export function isRecordedKey(key: BedKey | null | undefined): key is RecordedKey {
  return typeof key === 'string' && key.startsWith('rec:');
}

/** The synthesized choice for a tag (no recordings). */
export function synthChoice(tag: AmbienceSceneTag): BedChoice | null {
  const bed = TAG_BED[tag];
  return bed ? { key: bed } : null;
}

/** Seconds of listening between two changes of bed. */
export const MIN_HOLD_SECONDS = 45;
/** Scenes the backend was unsure about stay silent. */
export const MIN_CONFIDENCE = 0.3;
/** The bed sits ~3 dB lower while the voice speaks, and rises back in pauses and at headings. */
export const DUCK_VOICE = 10 ** (-3 / 20);
export const DUCK_SECONDS = 2.5;

export function isSceneTag(tag: unknown): tag is AmbienceSceneTag {
  return (AMBIENCE_TAGS as readonly unknown[]).includes(tag);
}

/** The scene containing `segment` (scenes are sorted and contiguous), or null. */
export function sceneAt(scenes: readonly AmbienceScene[], segment: number): AmbienceScene | null {
  let low = 0;
  let high = scenes.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const scene = scenes[mid];
    if (segment < scene.start_segment) high = mid - 1;
    else if (segment > scene.end_segment) low = mid + 1;
    else return scene;
  }
  return null;
}

/** What should sound for a scene: its tag when known and confident, else silence. */
export function sceneTag(scene: AmbienceScene | null): AmbienceTag {
  if (!scene || !isSceneTag(scene.tag) || !(scene.confidence >= MIN_CONFIDENCE)) return 'none';
  return scene.tag;
}

/** Crossfade length: arriving from silence is quicker, leaving to silence slower (8–12 s). */
export function crossfadeSeconds(from: AmbienceTag, to: AmbienceTag): number {
  if (from === 'none') return 8;
  if (to === 'none') return 12;
  return 10;
}

/** Equal-power crossfade gains `[outgoing, incoming]` at progress 0–1. */
export function equalPower(progress: number): [number, number] {
  const p = Math.min(1, Math.max(0, progress));
  return [Math.cos((p * Math.PI) / 2), Math.sin((p * Math.PI) / 2)];
}

/**
 * Element gain of a bed relative to the master volume: ambient beds are
 * rendered at their quiet level already; the manual loops reused here (rain,
 * café, fireplace) and recordings (by their `rms`) are trimmed down to it.
 * Intensity adds up to +3 dB.
 */
export function bedLevel(bed: BedKey, intensity: number, rms?: number): number {
  const recorded = rms !== undefined && Number.isFinite(rms) && rms > 0 ? rms : MANUAL_RMS;
  const trim = isRecordedKey(bed)
    ? AMBIENT_RMS / Math.max(AMBIENT_RMS, recorded)
    : isAmbientBed(bed)
      ? 1
      : AMBIENT_RMS / MANUAL_RMS;
  const i = Number.isFinite(intensity) ? Math.min(1, Math.max(0, intensity)) : 0.5;
  return trim * (0.7 + 0.3 * i);
}

/**
 * Hysteresis over listening time: the first decision after a reset is
 * immediate; afterwards the bed changes at most once per `MIN_HOLD_SECONDS`
 * of listening, and a scene that comes and goes within the hold never sounds.
 */
export class AmbienceScheduler {
  current: AmbienceTag = 'none';
  private decided = false;
  private listened = 0;
  private changedAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly holdSeconds = MIN_HOLD_SECONDS) {}

  /** A new document or a fresh start: the next decision applies at once. */
  reset(current: AmbienceTag = this.current) {
    this.current = current;
    this.decided = false;
  }

  /** Seconds the voice played since the last call. */
  listen(seconds: number) {
    if (seconds > 0 && Number.isFinite(seconds)) this.listened += seconds;
  }

  get listenedSeconds(): number {
    return this.listened;
  }

  /** Seconds of listening before another change is allowed (0 = free). */
  holdLeft(): number {
    return Math.max(0, this.changedAt + this.holdSeconds - this.listened);
  }

  /** The tag to change to now, or null to keep the current bed. */
  decide(target: AmbienceTag): AmbienceTag | null {
    if (target === this.current) {
      this.decided = true;
      return null;
    }
    if (this.decided && this.holdLeft() > 0) return null;
    this.decided = true;
    this.current = target;
    this.changedAt = this.listened;
    return target;
  }
}
