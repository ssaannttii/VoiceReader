/**
 * Background music playback: two `<audio>` decks that crossfade (equal power,
 * by element volume) between the clips of a cue and from one cue to the next.
 * Nothing goes through Web Audio, and the reading audio is never touched.
 *
 * Time is the engine's own clock: it advances only while the music may play
 * (ticks from the player's `timeupdate`, the decks' own `timeupdate` and a
 * short interval while a fade runs on screen), so a fade or a crossfade paused
 * with the voice resumes where it was, also on a locked phone. Dependencies
 * are injected so the engine is unit-tested with fake elements.
 */
import {
  CUE_CROSSFADE_SECONDS,
  DOC_CHANGE_FADE_SECONDS,
  clipCrossfadeSeconds,
  envelopeAt,
  envelopeDone,
  nextClip,
  type Envelope,
  type MusicCue,
  type MusicFile,
  type MusicTarget,
} from './music-plan';

/** The parts of an HTMLAudioElement the engine uses. */
export interface MusicElement {
  src: string;
  volume: number;
  readonly paused: boolean;
  readonly ended: boolean;
  readonly currentTime: number;
  readonly duration: number;
  play(): Promise<void>;
  pause(): void;
  removeAttribute(name: string): void;
}

export interface MusicEngineDeps {
  createElement(): MusicElement;
  loadClip(cue: MusicCue, file: MusicFile): Promise<Blob>;
  createUrl(blob: Blob): string | null;
  revokeUrl(url: string | null): void;
  /** Milliseconds (monotonic). */
  now(): number;
  log(type: string, data: Record<string, unknown>): void;
  random?(): number;
  /** A clip started (the cue sounding may have changed). */
  onChange?(): void;
}

interface Deck {
  el: MusicElement | null;
  cue: MusicCue | null;
  file: MusicFile | null;
  url: string | null;
  env: Envelope | null;
  /** Gain when no envelope runs. */
  level: number;
  /** Its successor clip has been started (or it is on its way out). */
  chained: boolean;
  /** Fading out, released at the end of the fade. */
  leaving: boolean;
}

/** A tick never advances the clock by more than this (a suspended page must not jump ahead). */
const MAX_TICK_MS = 2000;

const SILENCE: MusicTarget = { cue: null, key: null, fadeIn: 0, fadeOut: 0 };

export class MusicEngine {
  private readonly decks: [Deck, Deck] = [this.emptyDeck(), this.emptyDeck()];
  private cues = new Map<string, MusicCue>();
  private target: MusicTarget = SILENCE;
  private active = false;
  private master = 0;
  /** Engine clock (ms of time the music could play). */
  private t = 0;
  private last: number | null = null;
  private token = 0;
  private loading: { cue: string; chain: boolean } | null = null;
  private failed = new Set<string>();
  private scope: string | null = null;

  constructor(private readonly deps: MusicEngineDeps) {}

  private emptyDeck(): Deck {
    return {
      el: null,
      cue: null,
      file: null,
      url: null,
      env: null,
      level: 0,
      chained: false,
      leaving: false,
    };
  }

  // ── inputs ───────────────────────────────────────────────────────────────

  /**
   * The document's cues (the clips each one chains). Another `scope` (a new
   * document) lets whatever sounds leave quickly, even a cue with the same id.
   */
  setCues(cues: readonly MusicCue[], scope: string | null = this.scope) {
    this.cues = new Map(cues.map((cue) => [cue.id, cue]));
    if (scope !== this.scope) {
      this.scope = scope;
      this.advance();
      this.token++;
      this.loading = null;
      for (const deck of this.decks)
        if (deck.cue && !deck.leaving) this.fade(deck, 0, DOC_CHANGE_FADE_SECONDS);
    }
    this.reconcile();
    this.apply();
  }

  /** What should sound now (from the director). */
  setTarget(target: MusicTarget) {
    if (
      target.cue === this.target.cue &&
      target.fadeOut === this.target.fadeOut &&
      target.fadeIn === this.target.fadeIn
    )
      return;
    this.advance();
    this.target = target;
    this.reconcile();
    this.apply();
  }

  /** May sound now (the voice plays and music is on). */
  setActive(active: boolean) {
    if (active === this.active) return;
    this.advance();
    this.active = active;
    this.last = this.deps.now();
    for (const deck of this.decks) {
      if (!deck.el || !deck.cue) continue;
      if (active) this.play(deck);
      else if (!deck.el.paused) deck.el.pause();
    }
    this.reconcile();
    this.apply();
  }

  /** Volume slider × loudness trim × sleep fade (0–1). */
  setMaster(gain: number) {
    this.master = Math.min(1, Math.max(0, gain));
    this.apply();
  }

  /** Advance the clock, finish fades, chain clips and follow the target. */
  tick() {
    this.advance();
    this.reconcile();
    this.apply();
  }

  /** iOS: elements only play later if first started inside a tap. */
  unlock(silentUrl: string) {
    for (const deck of this.decks) {
      const el = this.element(deck);
      if (deck.cue || !el.paused) continue;
      el.src = silentUrl;
      void el.play().catch(() => {});
    }
  }

  /** Silence at once and forget everything (music switched off, new plan without cues). */
  stop() {
    this.token++;
    this.loading = null;
    this.target = SILENCE;
    for (const deck of this.decks) this.release(deck);
  }

  /** Clips that failed to load are skipped until the plan changes. */
  clearFailures() {
    this.failed.clear();
  }

  // ── state for the controller ───────────────────────────────────────────────

  /** How present the music is now (0–1, before the master volume); 0 while paused. */
  presence(): number {
    if (!this.active) return 0;
    return Math.max(0, ...this.decks.map((deck) => (deck.cue ? this.gainOf(deck) : 0)));
  }

  /** A fade runs (the controller keeps ticking on screen). */
  busy(): boolean {
    return this.decks.some((deck) => deck.env !== null) || this.loading !== null;
  }

  /** The cue sounding (not leaving), if any. */
  playingCue(): string | null {
    return this.live()?.cue?.id ?? null;
  }

  /** Clips in the decks (tests, diagnostics). */
  clips(): (string | null)[] {
    return this.decks.map((deck) => deck.file?.name ?? null);
  }

  volumes(): number[] {
    return this.decks.map((deck) => deck.el?.volume ?? 0);
  }

  // ── internals ────────────────────────────────────────────────────────────

  private advance() {
    const now = this.deps.now();
    if (this.active && this.last !== null)
      this.t += Math.min(MAX_TICK_MS, Math.max(0, now - this.last));
    this.last = now;
    for (const deck of this.decks) {
      if (deck.env && envelopeDone(deck.env, this.t)) {
        deck.level = deck.env.to;
        deck.env = null;
        if (deck.leaving && deck.level <= 0) this.release(deck);
      }
      // A clip that ran out (no successor yet, or a fading tail) leaves its deck.
      if (deck.cue && deck.el?.ended) this.release(deck);
    }
  }

  private live(): Deck | null {
    return this.decks.find((deck) => deck.cue && !deck.leaving) ?? null;
  }

  private gainOf(deck: Deck): number {
    return deck.env ? envelopeAt(deck.env, this.t) : deck.level;
  }

  private fade(deck: Deck, to: number, seconds: number) {
    deck.env = { from: this.gainOf(deck), to, start: this.t, ms: Math.max(0, seconds) * 1000 };
    if (to <= 0) {
      deck.leaving = true;
      deck.chained = true;
    }
  }

  private reconcile() {
    const target = this.target.cue;
    const live = this.live();
    if (!target) {
      if (this.loading) {
        this.token++;
        this.loading = null;
      }
      for (const deck of this.decks)
        if (deck.cue && !deck.leaving) this.fade(deck, 0, this.target.fadeOut);
      return;
    }
    if (live && live.cue?.id === target) {
      // Back to the cue that sounds: a change still loading is dropped.
      if (this.loading && !this.loading.chain) {
        this.token++;
        this.loading = null;
      }
      this.chain(live);
      return;
    }
    if (this.loading?.cue === target && !this.loading.chain) return;
    const cue = this.cues.get(target);
    if (!cue?.ready) {
      // Not playable (yet): let what sounds go quietly.
      if (live) this.fade(live, 0, this.target.fadeOut || CUE_CROSSFADE_SECONDS);
      return;
    }
    const free = this.decks.find((deck) => !deck.cue);
    // Both decks busy (a crossfade is finishing): start once one is free.
    if (!free) return;
    const file = this.pick(cue, null);
    if (!file) return;
    this.start(free, cue, file, live ? CUE_CROSSFADE_SECONDS : this.target.fadeIn, live, false);
  }

  /** The live clip nears its end: the next clip of the cue starts crossfading in. */
  private chain(deck: Deck) {
    if (deck.chained || this.loading || !deck.el || !deck.cue || !deck.file) return;
    const duration =
      Number.isFinite(deck.el.duration) && deck.el.duration > 0
        ? deck.el.duration
        : deck.file.duration;
    const seconds = clipCrossfadeSeconds(duration);
    if (deck.el.currentTime < duration - seconds) return;
    const file = this.pick(deck.cue, deck.file.name);
    if (!file) return;
    deck.chained = true;
    const other = this.decks.find((candidate) => candidate !== deck) ?? this.decks[0];
    if (other.cue) this.release(other);
    this.start(other, deck.cue, file, seconds, deck, true);
  }

  private pick(cue: MusicCue, previous: string | null): MusicFile | null {
    const skip = new Set(
      cue.files.filter((file) => this.failed.has(`${cue.id}/${file.name}`)).map((f) => f.name),
    );
    return nextClip(cue.files, previous, this.deps.random ?? Math.random, skip);
  }

  private start(
    deck: Deck,
    cue: MusicCue,
    file: MusicFile,
    seconds: number,
    outgoing: Deck | null,
    chain: boolean,
  ) {
    const token = ++this.token;
    this.loading = { cue: cue.id, chain };
    this.deps.loadClip(cue, file).then(
      (blob) => {
        if (token !== this.token) return;
        this.loading = null;
        const url = this.deps.createUrl(blob);
        if (!url) {
          this.fail(cue, file, outgoing, chain);
          return;
        }
        this.advance();
        const el = this.element(deck);
        this.deps.revokeUrl(deck.url);
        deck.url = url;
        deck.cue = cue;
        deck.file = file;
        deck.level = 0;
        deck.chained = false;
        deck.leaving = false;
        deck.env = { from: 0, to: 1, start: this.t, ms: seconds * 1000 };
        el.volume = 0;
        el.src = url;
        if (outgoing?.cue && !outgoing.leaving) this.fade(outgoing, 0, seconds);
        this.deps.log('music', {
          event: chain ? 'clip' : 'crossfade',
          cue: cue.id,
          mood: cue.mood,
          file: file.name,
          from: chain ? null : (outgoing?.cue?.id ?? null),
          seconds,
        });
        if (this.active) this.play(deck);
        this.apply();
        this.deps.onChange?.();
      },
      (error: unknown) => {
        if (token !== this.token) return;
        this.loading = null;
        this.deps.log('music', {
          event: 'error',
          cue: cue.id,
          file: file.name,
          name: (error as { name?: string })?.name ?? 'Error',
        });
        this.fail(cue, file, outgoing, chain);
      },
    );
  }

  /** A clip that cannot load is skipped; with nothing left, silence beats the wrong music. */
  private fail(cue: MusicCue, file: MusicFile, outgoing: Deck | null, chain: boolean) {
    this.failed.add(`${cue.id}/${file.name}`);
    if (chain && outgoing) {
      // Try another clip at the next tick (or let this one end).
      outgoing.chained = false;
      return;
    }
    if (!this.pick(cue, null) && outgoing?.cue && !outgoing.leaving)
      this.fade(outgoing, 0, this.target.fadeOut || CUE_CROSSFADE_SECONDS);
    this.reconcile();
  }

  private apply() {
    for (const deck of this.decks) {
      if (!deck.el || !deck.cue) continue;
      deck.el.volume = Math.min(1, Math.max(0, this.master * this.gainOf(deck)));
    }
  }

  private element(deck: Deck): MusicElement {
    deck.el ??= this.deps.createElement();
    return deck.el;
  }

  private play(deck: Deck) {
    const el = deck.el;
    if (!el || !el.paused || !deck.cue) return;
    el.play().catch((error: unknown) => {
      if ((error as { name?: string })?.name === 'AbortError') return;
      this.deps.log('music', {
        event: 'play_error',
        cue: deck.cue?.id ?? null,
        name: (error as { name?: string })?.name ?? 'Error',
      });
    });
  }

  private release(deck: Deck) {
    if (deck.el) {
      if (!deck.el.paused) deck.el.pause();
      deck.el.volume = 0;
      deck.el.removeAttribute('src');
    }
    this.deps.revokeUrl(deck.url);
    deck.url = null;
    deck.cue = null;
    deck.file = null;
    deck.env = null;
    deck.level = 0;
    deck.chained = false;
    deck.leaving = false;
  }
}
