import { describe, expect, it } from 'vitest';
import {
  AmbienceScheduler,
  MIN_HOLD_SECONDS,
  TAG_BED,
  bedLevel,
  crossfadeSeconds,
  equalPower,
  sceneAt,
  sceneTag,
  type AmbienceScene,
} from './ambience-schedule';
import { AMBIENT_RMS, MANUAL_RMS } from './soundscape-synth';

const scene = (start: number, end: number, tag: string, confidence = 0.8): AmbienceScene => ({
  start_segment: start,
  end_segment: end,
  tag,
  confidence,
  intensity: 0.6,
});

describe('sceneAt / sceneTag', () => {
  const scenes = [scene(0, 9, 'none', 0), scene(10, 29, 'rain'), scene(30, 30, 'tavern')];

  it('finds the scene containing a segment', () => {
    expect(sceneAt(scenes, 0)?.tag).toBe('none');
    expect(sceneAt(scenes, 10)?.tag).toBe('rain');
    expect(sceneAt(scenes, 29)?.tag).toBe('rain');
    expect(sceneAt(scenes, 30)?.tag).toBe('tavern');
    expect(sceneAt(scenes, 31)).toBeNull();
    expect(sceneAt([], 3)).toBeNull();
  });

  it('is silent for unknown tags, unsure scenes and gaps', () => {
    expect(sceneTag(scene(0, 1, 'rain'))).toBe('rain');
    expect(sceneTag(scene(0, 1, 'rain', 0.1))).toBe('none');
    expect(sceneTag(scene(0, 1, 'thunderclap'))).toBe('none');
    expect(sceneTag(null)).toBe('none');
  });

  it('maps every tag to a bed, reusing the manual loops where they fit', () => {
    expect(TAG_BED.tavern).toBe('cafe');
    expect(TAG_BED.fire).toBe('fire');
    expect(TAG_BED.rain).toBe('rain');
    expect(TAG_BED.interior).toBe('room');
  });
});

describe('AmbienceScheduler (hysteresis)', () => {
  it('applies the first decision at once, then holds for 45 s of listening', () => {
    const scheduler = new AmbienceScheduler();
    expect(scheduler.decide('rain')).toBe('rain');
    scheduler.listen(MIN_HOLD_SECONDS - 1);
    expect(scheduler.decide('tavern')).toBeNull();
    expect(scheduler.current).toBe('rain');
    scheduler.listen(1);
    expect(scheduler.decide('tavern')).toBe('tavern');
    expect(scheduler.decide('none')).toBeNull(); // just changed
  });

  it('never sounds a scene that comes and goes within the hold', () => {
    const scheduler = new AmbienceScheduler();
    scheduler.decide('rain');
    scheduler.listen(10);
    expect(scheduler.decide('sea')).toBeNull();
    scheduler.listen(10);
    expect(scheduler.decide('rain')).toBeNull(); // back to the current bed: nothing to do
    scheduler.listen(30);
    expect(scheduler.current).toBe('rain');
  });

  it('counts listening time only (wall time while paused does not count)', () => {
    const scheduler = new AmbienceScheduler();
    scheduler.decide('rain');
    scheduler.listen(-5);
    scheduler.listen(Number.NaN);
    expect(scheduler.listenedSeconds).toBe(0);
    expect(scheduler.holdLeft()).toBe(MIN_HOLD_SECONDS);
  });

  it('a reset (new document) makes the next decision immediate again', () => {
    const scheduler = new AmbienceScheduler();
    scheduler.decide('rain');
    scheduler.reset('none');
    expect(scheduler.decide('tavern')).toBe('tavern');
  });
});

describe('crossfades and levels', () => {
  it('lasts 8–12 s', () => {
    for (const [from, to] of [
      ['none', 'rain'],
      ['rain', 'none'],
      ['rain', 'sea'],
    ] as const) {
      const seconds = crossfadeSeconds(from, to);
      expect(seconds).toBeGreaterThanOrEqual(8);
      expect(seconds).toBeLessThanOrEqual(12);
    }
  });

  it('is equal power: the summed power stays constant', () => {
    for (const p of [0, 0.1, 0.25, 0.5, 0.75, 1]) {
      const [out, inn] = equalPower(p);
      expect(out * out + inn * inn).toBeCloseTo(1, 6);
    }
    expect(equalPower(0)).toEqual([1, 0]);
    expect(equalPower(2)[1]).toBeCloseTo(1, 9);
  });

  it('trims the reused manual loops down to the ambient level', () => {
    expect(bedLevel('wind', 1)).toBeCloseTo(1, 6);
    expect(bedLevel('rain', 1)).toBeCloseTo(AMBIENT_RMS / MANUAL_RMS, 6);
    expect(bedLevel('wind', 0)).toBeCloseTo(0.7, 6);
    expect(bedLevel('wind', Number.NaN)).toBeCloseTo(0.85, 6);
  });
});
