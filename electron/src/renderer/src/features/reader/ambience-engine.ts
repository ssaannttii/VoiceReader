/**
 * Automatic ambience playback: two alternating `<audio loop>` elements that
 * crossfade (equal power) from one bed to the next as the reading moves
 * across scenes. Volume automation is computed from timestamps on every tick
 * (player `timeupdate`, the beds' own `timeupdate`), never from animation
 * frames, so fades keep going on a locked phone. The reading audio is not
 * touched. Dependencies are injected so the engine is unit-tested with fakes.
 */
import {
  AmbienceScheduler,
  DUCK_SECONDS,
  DUCK_VOICE,
  TAG_BED,
  bedLevel,
  crossfadeSeconds,
  equalPower,
  sceneAt,
  sceneTag,
  type AmbienceScene,
  type AmbienceTag,
} from './ambience-schedule';
import type { BedId } from './soundscape-synth';

/** The parts of an HTMLAudioElement the engine uses. */
export interface BedElement {
  src: string;
  volume: number;
  loop: boolean;
  readonly paused: boolean;
  play(): Promise<void>;
  pause(): void;
  removeAttribute(name: string): void;
}

export interface AmbienceEngineDeps {
  createElement(): BedElement;
  loadBed(id: BedId): Promise<Blob>;
  createUrl(blob: Blob): string | null;
  revokeUrl(url: string | null): void;
  /** Milliseconds (a monotonic clock). */
  now(): number;
  log(type: string, data: Record<string, unknown>): void;
  /** The playing tag changed (sheet: "Now: rain"). */
  onChange?(): void;
}

interface Fade {
  dir: 'in' | 'out';
  start: number;
  ms: number;
}

interface Slot {
  el: BedElement | null;
  bed: BedId | null;
  url: string | null;
  /** Bed trim × intensity (before master volume and ducking). */
  level: number;
  fade: Fade | null;
}

interface Ramp {
  from: number;
  to: number;
  start: number;
  ms: number;
}

/** Listening time counted per tick is capped (a suspended page must not jump ahead). */
const MAX_TICK_SECONDS = 2;

export class AmbienceEngine {
  readonly scheduler = new AmbienceScheduler();
  private readonly slots: [Slot, Slot] = [this.emptySlot(), this.emptySlot()];
  private enabled = false;
  private active = false;
  private master = 0;
  private duck: Ramp = { from: 1, to: 1, start: 0, ms: 0 };
  private voicePlaying = false;
  private heading = false;
  private scenes: readonly AmbienceScene[] | null = null;
  private segment = 0;
  private lastTick: number | null = null;
  private loadToken = 0;
  private lastSceneKey: string | null = null;

  constructor(private readonly deps: AmbienceEngineDeps) {}

  private emptySlot(): Slot {
    return { el: null, bed: null, url: null, level: 0, fade: null };
  }

  /** Tag now sounding (or fading in); 'none' for silence. */
  tag(): AmbienceTag {
    return this.scheduler.current;
  }

  /** Beds currently loaded into the two elements (tests, diagnostics). */
  beds(): (BedId | null)[] {
    return this.slots.map((slot) => slot.bed);
  }

  /** Element volumes (tests, diagnostics). */
  volumes(): number[] {
    return this.slots.map((slot) => slot.el?.volume ?? 0);
  }

  /** A fade or the ducking ramp is still moving. */
  busy(): boolean {
    const now = this.deps.now();
    return this.slots.some((slot) => slot.fade !== null) || now < this.duck.start + this.duck.ms;
  }

  /** Automático chosen (true) or not: when off, everything stops and nothing is decided. */
  setEnabled(enabled: boolean) {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (!enabled) this.stop();
    else {
      this.scheduler.reset('none');
      this.evaluate();
    }
  }

  /** May sound now (armed, and the voice plays unless "only with the voice" is off). */
  setActive(active: boolean) {
    const now = this.deps.now();
    if (active === this.active) return;
    this.active = active && this.enabled;
    this.lastTick = now;
    for (const slot of this.slots) {
      if (!slot.el || !slot.bed) continue;
      if (this.active) this.play(slot);
      else if (!slot.el.paused) slot.el.pause();
    }
    this.apply(now);
  }

  /** Master gain 0–1: the soundscape volume slider × the sleep-timer fade. */
  setMaster(gain: number) {
    this.master = Math.min(1, Math.max(0, gain));
    this.apply(this.deps.now());
  }

  /** The document's scenes; null while unknown (new document, loading, unavailable). */
  setScenes(scenes: readonly AmbienceScene[] | null) {
    this.scenes = scenes;
    this.lastSceneKey = null;
    if (!scenes) {
      // Unknown: let the current bed go quietly; the first scene of the next document is immediate.
      if (this.scheduler.current !== 'none') this.transition(this.scheduler.current, 'none', 0.5);
      this.scheduler.reset('none');
      this.deps.onChange?.();
      return;
    }
    this.scheduler.reset();
    this.evaluate();
  }

  setSegment(segment: number, heading: boolean) {
    const headingChanged = heading !== this.heading;
    this.segment = segment;
    this.heading = heading;
    if (headingChanged) this.updateDuck();
    this.evaluate();
  }

  setVoicePlaying(playing: boolean) {
    if (playing === this.voicePlaying) return;
    this.tick();
    this.voicePlaying = playing;
    this.updateDuck();
  }

  /** Advance listening time, apply decisions and volume automation (player/bed timeupdate). */
  tick() {
    const now = this.deps.now();
    if (this.lastTick !== null && this.active && this.voicePlaying)
      this.scheduler.listen(Math.min(MAX_TICK_SECONDS, Math.max(0, (now - this.lastTick) / 1000)));
    this.lastTick = now;
    this.evaluate();
    this.apply(now);
  }

  /** iOS: elements only play later if first started inside a tap. */
  unlock(silentUrl: string) {
    for (const slot of this.slots) {
      const el = this.element(slot);
      if (slot.bed || !el.paused) continue;
      el.src = silentUrl;
      void el.play().catch(() => {});
    }
  }

  /** Automático turned off: silence at once and forget the current bed. */
  stop() {
    this.loadToken++;
    for (const slot of this.slots) this.release(slot);
    this.scheduler.reset('none');
    this.active = false;
    this.lastSceneKey = null;
    this.deps.onChange?.();
  }

  // ── internals ────────────────────────────────────────────────────────────

  private evaluate() {
    if (!this.enabled || !this.scenes) return;
    const scene = sceneAt(this.scenes, this.segment);
    const target = sceneTag(scene);
    const key = `${scene?.start_segment ?? -1}:${target}`;
    if (key !== this.lastSceneKey) {
      this.lastSceneKey = key;
      this.deps.log('ambience', {
        event: 'scene',
        seg: this.segment,
        tag: target,
        start: scene?.start_segment ?? null,
        end: scene?.end_segment ?? null,
        hold_s: Math.round(this.scheduler.holdLeft()),
      });
    }
    const from = this.scheduler.current;
    const next = this.scheduler.decide(target);
    if (next === null) return;
    this.transition(from, next, scene?.intensity ?? 0.5);
    this.deps.onChange?.();
  }

  private transition(from: AmbienceTag, to: AmbienceTag, intensity: number) {
    const seconds = crossfadeSeconds(from, to);
    const ms = seconds * 1000;
    const now = this.deps.now();
    // A fade still running finishes at once (only after a reset can changes come this close).
    for (const slot of this.slots) {
      if (slot.fade?.dir === 'out') this.release(slot);
      else if (slot.fade?.dir === 'in') slot.fade = null;
    }
    const live = this.slots.find((slot) => slot.bed !== null) ?? null;
    const bed = to === 'none' ? null : TAG_BED[to];
    this.deps.log('ambience', { event: 'crossfade', from, to, bed, seconds, seg: this.segment });
    const token = ++this.loadToken;
    if (live && bed && live.bed === bed) {
      live.level = bedLevel(bed, intensity);
      this.apply(now);
      return;
    }
    if (!bed) {
      if (live) live.fade = { dir: 'out', start: now, ms };
      this.apply(now);
      return;
    }
    const incoming = this.slots.find((slot) => slot !== live) ?? this.slots[0];
    this.deps.loadBed(bed).then(
      (blob) => {
        if (token !== this.loadToken) return;
        const at = this.deps.now();
        const url = this.deps.createUrl(blob);
        if (!url) {
          if (live?.bed) live.fade = { dir: 'out', start: at, ms };
          return;
        }
        const el = this.element(incoming);
        this.deps.revokeUrl(incoming.url);
        incoming.url = url;
        incoming.bed = bed;
        incoming.level = bedLevel(bed, intensity);
        incoming.fade = { dir: 'in', start: at, ms };
        el.volume = 0;
        el.src = url;
        if (live?.bed) live.fade = { dir: 'out', start: at, ms };
        this.apply(at);
        if (this.active) this.play(incoming);
      },
      (error: unknown) => {
        if (token !== this.loadToken) return;
        this.deps.log('ambience', {
          event: 'error',
          bed,
          name: (error as { name?: string })?.name ?? 'Error',
        });
        // Silence is better than the wrong sound.
        if (live?.bed) live.fade = { dir: 'out', start: this.deps.now(), ms };
      },
    );
  }

  private updateDuck() {
    const now = this.deps.now();
    const target = this.voicePlaying && !this.heading ? DUCK_VOICE : 1;
    if (target === this.duck.to) return;
    this.duck = { from: this.duckAt(now), to: target, start: now, ms: DUCK_SECONDS * 1000 };
    this.apply(now);
  }

  private duckAt(now: number): number {
    const { from, to, start, ms } = this.duck;
    if (ms <= 0 || now >= start + ms) return to;
    if (now <= start) return from;
    return from + (to - from) * ((now - start) / ms);
  }

  /** Fade gain of a slot at `now`; finishes fades that are over. */
  private fadeGain(slot: Slot, now: number): number {
    if (!slot.bed) return 0;
    const fade = slot.fade;
    if (!fade) return 1;
    const progress = fade.ms > 0 ? (now - fade.start) / fade.ms : 1;
    if (progress >= 1) {
      slot.fade = null;
      if (fade.dir === 'out') {
        this.release(slot);
        return 0;
      }
      return 1;
    }
    const [outgoing, incoming] = equalPower(progress);
    return fade.dir === 'in' ? incoming : outgoing;
  }

  private apply(now: number) {
    const duck = this.duckAt(now);
    for (const slot of this.slots) {
      const gain = this.fadeGain(slot, now);
      if (slot.el && slot.bed)
        slot.el.volume = Math.min(1, Math.max(0, this.master * duck * slot.level * gain));
    }
  }

  private element(slot: Slot): BedElement {
    if (!slot.el) {
      const el = this.deps.createElement();
      el.loop = true;
      slot.el = el;
    }
    return slot.el;
  }

  private play(slot: Slot) {
    const el = slot.el;
    if (!el || !el.paused) return;
    el.play().catch((error: unknown) => {
      if ((error as { name?: string })?.name === 'AbortError') return;
      this.deps.log('ambience', {
        event: 'play_error',
        bed: slot.bed,
        name: (error as { name?: string })?.name ?? 'Error',
      });
    });
  }

  private release(slot: Slot) {
    if (slot.el) {
      if (!slot.el.paused) slot.el.pause();
      slot.el.volume = 0;
      slot.el.removeAttribute('src');
    }
    this.deps.revokeUrl(slot.url);
    slot.url = null;
    slot.bed = null;
    slot.fade = null;
  }
}
