import { describe, expect, it } from 'vitest';
import { AmbienceEngine, type BedElement } from './ambience-engine';
import {
  DUCK_VOICE,
  MIN_HOLD_SECONDS,
  bedLevel,
  synthChoice,
  type AmbienceScene,
  type AmbienceSceneTag,
  type BedChoice,
  type BedKey,
} from './ambience-schedule';

class FakeElement implements BedElement {
  src = '';
  volume = 1;
  loop = false;
  paused = true;
  plays = 0;
  play() {
    this.paused = false;
    this.plays++;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  removeAttribute(name: string) {
    if (name === 'src') this.src = '';
  }
}

const scenes: AmbienceScene[] = [
  { start_segment: 0, end_segment: 9, tag: 'rain', confidence: 0.9, intensity: 1 },
  { start_segment: 10, end_segment: 19, tag: 'tavern', confidence: 0.9, intensity: 1 },
  { start_segment: 20, end_segment: 29, tag: 'none', confidence: 0, intensity: 0 },
];

interface SetupOptions {
  bedFor?: (tag: AmbienceSceneTag) => BedChoice | null;
  /** Keys whose load fails (a recording offline and not cached). */
  fail?: ReadonlySet<string>;
}

function setup(options: SetupOptions = {}) {
  let clock = 0;
  const elements: FakeElement[] = [];
  const loads: BedKey[] = [];
  const logs: Record<string, unknown>[] = [];
  const engine = new AmbienceEngine({
    createElement: () => {
      const el = new FakeElement();
      elements.push(el);
      return el;
    },
    loadBed: (id) => {
      loads.push(id);
      if (options.fail?.has(id)) return Promise.reject(new DOMException('offline', 'NetworkError'));
      return Promise.resolve(new Blob([id]));
    },
    createUrl: () => `blob:${loads.length}`,
    revokeUrl: () => {},
    now: () => clock,
    log: (type, data) => logs.push({ type, ...data }),
    bedFor: options.bedFor,
  });
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  /** Listen (voice playing) for `seconds`, ticking like `timeupdate` at 4 Hz. */
  const listen = (seconds: number) => {
    for (let i = 0; i < seconds * 4; i++) {
      clock += 250;
      engine.tick();
    }
  };
  const advance = (ms: number) => {
    clock += ms;
  };
  return { engine, elements, loads, logs, flush, listen, advance };
}

async function playing(options: SetupOptions = {}) {
  const t = setup(options);
  t.engine.setEnabled(true);
  t.engine.setMaster(1);
  t.engine.setActive(true);
  t.engine.setVoicePlaying(false);
  t.engine.setSegment(0, false);
  t.engine.setScenes(scenes);
  await t.flush();
  return t;
}

describe('AmbienceEngine', () => {
  it('fades the first scene in from silence on its own element', async () => {
    const t = await playing();
    expect(t.loads).toEqual(['rain']);
    expect(t.engine.beds()).toEqual(['rain', null]);
    expect(t.elements[0].paused).toBe(false);
    expect(t.elements[0].loop).toBe(true);
    expect(t.elements[0].volume).toBe(0);
    t.listen(4); // halfway through the 8 s fade-in
    expect(t.elements[0].volume).toBeCloseTo(bedLevel('rain', 1) * Math.SQRT1_2, 2);
    t.listen(5);
    expect(t.elements[0].volume).toBeCloseTo(bedLevel('rain', 1), 6);
    expect(t.engine.busy()).toBe(false);
  });

  it('holds a bed for 45 s of listening, then crossfades with equal power', async () => {
    const t = await playing();
    t.engine.setVoicePlaying(true);
    t.listen(10);
    t.engine.setSegment(12, false); // tavern scene, too soon
    await t.flush();
    expect(t.loads).toEqual(['rain']);
    t.listen(MIN_HOLD_SECONDS - 10 + 1);
    await t.flush();
    expect(t.loads).toEqual(['rain', 'cafe']);
    expect(t.engine.beds()).toEqual(['rain', 'cafe']);
    t.listen(5); // halfway through the 10 s crossfade
    const rain = bedLevel('rain', 1) * DUCK_VOICE;
    const cafe = bedLevel('cafe', 1) * DUCK_VOICE;
    expect(t.elements[0].volume / rain).toBeCloseTo(Math.SQRT1_2, 1);
    expect(t.elements[1].volume / cafe).toBeCloseTo(Math.SQRT1_2, 1);
    t.listen(6);
    expect(t.elements[0].paused).toBe(true);
    expect(t.engine.beds()).toEqual([null, 'cafe']);
    expect(t.logs.some((log) => log.type === 'ambience' && log.event === 'crossfade')).toBe(true);
  });

  it('fades to silence for a "none" scene and stops the element', async () => {
    const t = await playing();
    t.engine.setVoicePlaying(true);
    t.listen(MIN_HOLD_SECONDS + 1);
    t.engine.setSegment(25, false);
    t.listen(6);
    expect(t.elements[0].volume).toBeGreaterThan(0);
    t.listen(7);
    expect(t.engine.beds()).toEqual([null, null]);
    expect(t.elements.every((el) => el.paused)).toBe(true);
    expect(t.engine.tag()).toBe('none');
  });

  it('ducks ~3 dB while the voice speaks and rises at headings and pauses', async () => {
    const t = await playing();
    t.listen(10);
    const level = bedLevel('rain', 1);
    expect(t.elements[0].volume).toBeCloseTo(level, 6);
    t.engine.setVoicePlaying(true);
    t.listen(3);
    expect(t.elements[0].volume).toBeCloseTo(level * DUCK_VOICE, 6);
    t.engine.setSegment(1, true); // a chapter heading
    t.listen(3);
    expect(t.elements[0].volume).toBeCloseTo(level, 6);
  });

  it('follows the master volume (slider × sleep fade)', async () => {
    const t = await playing();
    t.listen(10);
    t.engine.setMaster(0.25);
    expect(t.elements[0].volume).toBeCloseTo(bedLevel('rain', 1) * 0.25, 6);
    t.engine.setMaster(0);
    expect(t.elements[0].volume).toBe(0);
  });

  it('pauses with the voice and resumes the same bed', async () => {
    const t = await playing();
    t.listen(10);
    t.engine.setActive(false);
    expect(t.elements[0].paused).toBe(true);
    t.engine.setActive(true);
    expect(t.elements[0].paused).toBe(false);
    expect(t.loads).toEqual(['rain']);
  });

  it('turning Automático off silences and forgets everything', async () => {
    const t = await playing();
    t.listen(10);
    t.engine.setEnabled(false);
    expect(t.elements.every((el) => el.paused && el.src === '')).toBe(true);
    expect(t.engine.beds()).toEqual([null, null]);
    expect(t.engine.tag()).toBe('none');
    // While off, nothing is decided or loaded.
    t.engine.setSegment(12, false);
    t.listen(60);
    await t.flush();
    expect(t.loads).toEqual(['rain']);
  });

  it('a new document lets the bed go, then starts its first scene at once', async () => {
    const t = await playing();
    t.engine.setVoicePlaying(true);
    t.listen(10);
    t.engine.setScenes(null);
    t.engine.setSegment(12, false);
    t.engine.setScenes(scenes);
    await t.flush();
    expect(t.loads).toEqual(['rain', 'cafe']);
  });

  it('keeps silent when the scenes cannot be loaded', async () => {
    const t = setup();
    t.engine.setEnabled(true);
    t.engine.setActive(true);
    t.engine.setScenes([]);
    t.listen(60);
    await t.flush();
    expect(t.loads).toEqual([]);
  });
});

describe('AmbienceEngine with recorded beds', () => {
  const RECORDED: Partial<Record<AmbienceSceneTag, BedChoice>> = {
    rain: { key: 'rec:rain.ogg', rms: 0.1, fallback: synthChoice('rain') },
  };
  let recorded = true;
  const bedFor = (tag: AmbienceSceneTag) =>
    (recorded ? RECORDED[tag] : undefined) ?? synthChoice(tag);

  it('plays the recording, trimmed to the ambient level by its loudness', async () => {
    recorded = true;
    const t = await playing({ bedFor });
    expect(t.loads).toEqual(['rec:rain.ogg']);
    expect(t.engine.beds()).toEqual(['rec:rain.ogg', null]);
    t.listen(10);
    expect(t.elements[0].volume).toBeCloseTo(bedLevel('rec:rain.ogg', 1, 0.1), 6);
    expect(bedLevel('rec:rain.ogg', 1, 0.1)).toBeLessThan(1);
  });

  it('falls back to the synthesized bed when the recording cannot load', async () => {
    recorded = true;
    const t = await playing({ bedFor, fail: new Set(['rec:rain.ogg']) });
    await t.flush();
    expect(t.loads).toEqual(['rec:rain.ogg', 'rain']);
    expect(t.engine.beds()).toEqual(['rain', null]);
    expect(t.logs.some((log) => log.event === 'error' && log.bed === 'rec:rain.ogg')).toBe(true);
  });

  it('crossfades the current scene to its new bed when the choice changes', async () => {
    recorded = false;
    const t = await playing({ bedFor });
    t.listen(10);
    expect(t.engine.beds()).toEqual(['rain', null]);
    recorded = true;
    t.engine.refreshBeds();
    await t.flush();
    expect(t.loads).toEqual(['rain', 'rec:rain.ogg']);
    expect(t.engine.beds()).toEqual(['rain', 'rec:rain.ogg']);
    t.listen(11);
    expect(t.engine.beds()).toEqual([null, 'rec:rain.ogg']);
    expect(t.engine.tag()).toBe('rain');
    // Same bed again: nothing reloads.
    t.engine.refreshBeds();
    await t.flush();
    expect(t.loads).toEqual(['rain', 'rec:rain.ogg']);
  });

  it('keeps silent for a tag without any bed (no recording, no stand-in)', async () => {
    const t = setup({ bedFor });
    t.engine.setEnabled(true);
    t.engine.setMaster(1);
    t.engine.setActive(true);
    t.engine.setSegment(0, false);
    t.engine.setScenes([
      { start_segment: 0, end_segment: 9, tag: 'river', confidence: 0.9, intensity: 1 },
    ]);
    await t.flush();
    expect(t.loads).toEqual([]);
    expect(t.engine.tag()).toBe('river');
    expect(t.engine.beds()).toEqual([null, null]);
  });
});
