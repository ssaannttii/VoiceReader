import { describe, expect, it } from 'vitest';
import { MusicEngine, type MusicElement } from './music-engine';
import {
  CUE_CROSSFADE_SECONDS,
  DOC_CHANGE_FADE_SECONDS,
  type MusicCue,
  type MusicTarget,
} from './music-plan';

class FakeAudio implements MusicElement {
  src = '';
  volume = 1;
  paused = true;
  ended = false;
  currentTime = 0;
  duration = Number.NaN;
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  removeAttribute(name: string) {
    if (name === 'src') this.src = '';
  }
}

const cue = (id: string, n = 3, ready = true): MusicCue => ({
  id,
  mood: id,
  ready,
  files: Array.from({ length: n }, (_, i) => ({ name: `${id}_${i}.ogg`, duration: 47 })),
});

const target = (cueId: string | null, fadeIn = 6, fadeOut = 10): MusicTarget => ({
  cue: cueId,
  key: cueId,
  fadeIn,
  fadeOut,
});

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function setup(options: { fail?: Set<string> } = {}) {
  let now = 0;
  const elements: FakeAudio[] = [];
  const loads: string[] = [];
  const logs: Record<string, unknown>[] = [];
  let seed = 3;
  const engine = new MusicEngine({
    createElement: () => {
      const el = new FakeAudio();
      elements.push(el);
      return el;
    },
    loadClip: (_cue, file) => {
      loads.push(file.name);
      return options.fail?.has(file.name)
        ? Promise.reject(new DOMException('gone', 'NotFoundError'))
        : Promise.resolve(new Blob([file.name]));
    },
    createUrl: (blob) => `blob:${(blob as Blob).size}:${loads.length}`,
    revokeUrl: () => {},
    now: () => now,
    log: (_type, data) => logs.push(data),
    random: () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    },
  });
  // Ticks come every ~250 ms (timeupdate / the ramp interval); one tick is capped at 2 s.
  const advance = (ms: number) => {
    for (let left = ms; left > 0; left -= 250) {
      now += Math.min(250, left);
      engine.tick();
    }
  };
  return { engine, elements, loads, logs, advance };
}

describe('MusicEngine', () => {
  it('fades a cue in from silence on its own element', async () => {
    const { engine, elements, advance } = setup();
    engine.setMaster(0.5);
    engine.setCues([cue('a')], 'doc');
    engine.setActive(true);
    engine.setTarget(target('a', 6));
    await flush();
    expect(engine.playingCue()).toBe('a');
    expect(elements[0].paused).toBe(false);
    expect(elements[0].volume).toBe(0);
    advance(3000);
    expect(elements[0].volume).toBeCloseTo(0.5 * Math.sin(Math.PI / 4));
    advance(3000);
    expect(elements[0].volume).toBeCloseTo(0.5);
    expect(engine.presence()).toBeCloseTo(1);
  });

  it('chains clips of a cue with an equal-power crossfade and no immediate repeat', async () => {
    const { engine, elements, advance } = setup();
    engine.setMaster(1);
    engine.setCues([cue('a')], 'doc');
    engine.setActive(true);
    engine.setTarget(target('a', 6));
    await flush();
    advance(6000);
    const [first] = engine.clips();
    elements[0].duration = 47;
    elements[0].currentTime = 38; // 47 − 9
    advance(100);
    await flush();
    const clips = engine.clips();
    expect(clips[1]).not.toBeNull();
    expect(clips[1]).not.toBe(first);
    advance(4500); // halfway through 9 s
    const [a, b] = engine.volumes();
    expect(a ** 2 + b ** 2).toBeCloseTo(1);
    advance(5000);
    expect(engine.clips()[0]).toBeNull();
    expect(engine.volumes()[1]).toBeCloseTo(1);
    expect(engine.playingCue()).toBe('a');
  });

  it('freezes fades while paused and resumes them where they were', async () => {
    const { engine, elements, advance } = setup();
    engine.setMaster(1);
    engine.setCues([cue('a')], 'doc');
    engine.setActive(true);
    engine.setTarget(target('a', 6));
    await flush();
    advance(3000);
    const mid = elements[0].volume;
    engine.setActive(false);
    expect(elements[0].paused).toBe(true);
    expect(engine.presence()).toBe(0);
    advance(60_000);
    engine.setActive(true);
    expect(elements[0].paused).toBe(false);
    expect(elements[0].volume).toBeCloseTo(mid);
    advance(3000);
    expect(elements[0].volume).toBeCloseTo(1);
  });

  it('crossfades to another cue and fades to silence', async () => {
    const { engine, advance } = setup();
    engine.setMaster(1);
    engine.setCues([cue('a'), cue('b')], 'doc');
    engine.setActive(true);
    engine.setTarget(target('a'));
    await flush();
    advance(6000);
    engine.setTarget(target('b'));
    await flush();
    expect(engine.playingCue()).toBe('b');
    advance((CUE_CROSSFADE_SECONDS / 2) * 1000);
    const [x, y] = engine.volumes();
    expect(x ** 2 + y ** 2).toBeCloseTo(1);
    advance((CUE_CROSSFADE_SECONDS / 2) * 1000 + 10);
    expect(engine.clips().filter(Boolean)).toHaveLength(1);
    engine.setTarget(target(null, 6, 10));
    expect(engine.playingCue()).toBeNull();
    advance(5000);
    expect(engine.presence()).toBeGreaterThan(0);
    advance(5100);
    expect(engine.clips()).toEqual([null, null]);
    expect(engine.presence()).toBe(0);
  });

  it('lets the old document go even when the new one uses the same cue id', async () => {
    const { engine, loads, advance } = setup();
    engine.setMaster(1);
    engine.setCues([cue('a')], 'doc1');
    engine.setActive(true);
    engine.setTarget(target('a'));
    await flush();
    advance(6000);
    engine.setCues([cue('a')], 'doc2');
    expect(engine.playingCue()).toBeNull();
    await flush();
    // The target still says "a": it starts afresh for the new document.
    expect(engine.playingCue()).toBe('a');
    expect(loads).toHaveLength(2);
    advance(DOC_CHANGE_FADE_SECONDS * 1000 + 10);
    expect(engine.clips().filter(Boolean)).toHaveLength(1);
  });

  it('skips clips that cannot load and stays silent when none can', async () => {
    const all = new Set(['a_0.ogg', 'a_1.ogg', 'a_2.ogg']);
    const { engine, loads } = setup({ fail: all });
    engine.setMaster(1);
    engine.setCues([cue('a')], 'doc');
    engine.setActive(true);
    engine.setTarget(target('a'));
    for (let i = 0; i < 5; i++) await flush();
    expect(new Set(loads)).toEqual(all);
    expect(loads).toHaveLength(3);
    expect(engine.playingCue()).toBeNull();
  });

  it('does not start a cue that is not ready, and stop() silences at once', async () => {
    const { engine, elements } = setup();
    engine.setMaster(1);
    engine.setCues([cue('a', 2, false), cue('b')], 'doc');
    engine.setActive(true);
    engine.setTarget(target('a'));
    await flush();
    expect(engine.playingCue()).toBeNull();
    engine.setTarget(target('b'));
    await flush();
    expect(engine.playingCue()).toBe('b');
    engine.stop();
    expect(engine.playingCue()).toBeNull();
    expect(elements.every((el) => el.paused && el.src === '')).toBe(true);
  });

  it('drops a cue change still loading when the target returns to what sounds', async () => {
    const { engine, advance } = setup();
    engine.setMaster(1);
    engine.setCues([cue('a'), cue('b')], 'doc');
    engine.setActive(true);
    engine.setTarget(target('a'));
    await flush();
    advance(6000);
    engine.setTarget(target('b'));
    engine.setTarget(target('a'));
    await flush();
    expect(engine.playingCue()).toBe('a');
    expect(engine.clips().filter(Boolean)).toHaveLength(1);
  });
});
