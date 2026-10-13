import { describe, expect, it } from 'vitest';
import {
  CLIP_CROSSFADE_SECONDS,
  FADE_IN_SECONDS,
  FADE_OUT_SECONDS,
  MUSIC_VOLUME_DEFAULT_DB,
  MusicDirector,
  REARM_SEGMENTS,
  clipCrossfadeSeconds,
  envelopeAt,
  musicBusy,
  musicGain,
  musicPlayable,
  nextClip,
  rangeAt,
  sanitizeMusic,
  type ReaderMusic,
} from './music-plan';
import { DEFAULT_MUSIC, sanitizeMusicPrefs } from './music-prefs';

const files = (prefix: string, n = 3) =>
  Array.from({ length: n }, (_, i) => ({ name: `${prefix}_${i}.ogg`, duration: 47 }));

function plan(overrides: Record<string, unknown> = {}): ReaderMusic {
  return sanitizeMusic({
    status: 'ready',
    progress: 1,
    error: null,
    engine_available: true,
    palette: { id: 'dark_fantasy', source: 'auto' },
    palettes: [{ id: 'dark_fantasy' }],
    cues: [
      { id: 'c_tension', mood: 'tension', files: files('t'), ready: true },
      { id: 'c_calm', mood: 'calm', files: files('c'), ready: true },
      { id: 'c_dread', mood: 'dread', files: files('d'), ready: false },
    ],
    spots: [
      { start_segment: 10, end_segment: 20, cue: 'c_tension', max_seconds: 60 },
      { start_segment: 21, end_segment: 25, cue: 'c_calm', max_seconds: 45 },
      { start_segment: 80, end_segment: 90, cue: 'c_dread', max_seconds: 60 },
    ],
    timeline: [
      { start_segment: 0, end_segment: 29, cue: 'c_calm' },
      { start_segment: 30, end_segment: 49, cue: 'c_tension' },
      { start_segment: 50, end_segment: 69, cue: 'c_dread' },
      { start_segment: 70, end_segment: 99, cue: 'c_calm' },
    ],
    level_lufs: -30,
    ...overrides,
  });
}

describe('sanitizeMusic', () => {
  it('keeps a valid plan and drops what is malformed', () => {
    const music = sanitizeMusic({
      status: 'generating',
      progress: 1.7,
      palette: { id: 'mystery_noir', source: 'user' },
      cues: [
        {
          id: 'a',
          mood: 'calm',
          files: [
            { name: 'a_0.ogg', duration: 47 },
            { name: '../etc/passwd', duration: 47 },
            { name: 'a_1.ogg', duration: 0 },
          ],
          ready: true,
        },
        { id: 'b', mood: 'wonder', files: [], ready: true },
        { mood: 'calm', files: [] },
      ],
      spots: [
        { start_segment: 9, end_segment: 12, cue: 'a', max_seconds: 40 },
        { start_segment: 3, end_segment: 5, cue: 'a', max_seconds: 30 },
        { start_segment: 8, end_segment: 2, cue: 'a', max_seconds: 30 },
        { start_segment: 1, end_segment: 2, cue: 'a', max_seconds: 0 },
      ],
      timeline: 'nope',
    });
    expect(music.status).toBe('generating');
    expect(music.progress).toBe(1);
    expect(music.palette).toEqual({ id: 'mystery_noir', source: 'user' });
    expect(music.cues.map((cue) => [cue.id, cue.files.length, cue.ready])).toEqual([
      ['a', 1, true],
      // A cue without clips cannot be ready.
      ['b', 0, false],
    ]);
    expect(music.spots.map((spot) => spot.start_segment)).toEqual([3, 9]);
    expect(music.timeline).toEqual([]);
    expect(music.level_lufs).toBe(-30);
    expect(music.engine_available).toBe(true);
  });

  it('reads garbage as off and unknown statuses as errors', () => {
    expect(sanitizeMusic(null).status).toBe('off');
    expect(sanitizeMusic({ status: 'composing' }).status).toBe('error');
    expect(sanitizeMusic({ status: 'unavailable', engine_available: false }).engine_available).toBe(
      false,
    );
  });

  it('knows when the PC is still working and when something can play', () => {
    expect(musicBusy(plan({ status: 'analyzing' }))).toBe(true);
    expect(musicBusy(plan({ status: 'generating' }))).toBe(true);
    expect(musicBusy(plan())).toBe(false);
    expect(musicPlayable(plan({ status: 'generating' }))).toBe(true);
    expect(musicPlayable(plan({ cues: [] }))).toBe(false);
  });
});

describe('lookups, gain and fades', () => {
  it('finds the range containing a segment', () => {
    const { spots } = plan();
    expect(rangeAt(spots, 9)).toBeNull();
    expect(rangeAt(spots, 10)?.cue).toBe('c_tension');
    expect(rangeAt(spots, 20)?.cue).toBe('c_tension');
    expect(rangeAt(spots, 21)?.cue).toBe('c_calm');
    expect(rangeAt(spots, 50)).toBeNull();
  });

  it('maps the volume in dB, corrects the loudness and never exceeds 1', () => {
    expect(musicGain(0, -30, 1)).toBeCloseTo(1);
    expect(musicGain(MUSIC_VOLUME_DEFAULT_DB, -30, 1)).toBeCloseTo(10 ** (-3 / 20));
    expect(musicGain(-6, -30, 0.5)).toBeCloseTo(0.5 * 10 ** (-6 / 20));
    // Clips mastered 6 dB hotter play 6 dB lower; quieter ones cannot go above unity.
    expect(musicGain(0, -24, 1)).toBeCloseTo(10 ** (-6 / 20));
    expect(musicGain(0, -40, 1)).toBe(1);
    expect(musicGain(99, -30, 1)).toBe(1);
    expect(musicGain(-3, Number.NaN, 1)).toBeCloseTo(10 ** (-3 / 20));
  });

  it('crossfades clips over ~9 s, shorter for short clips', () => {
    expect(clipCrossfadeSeconds(47)).toBe(CLIP_CROSSFADE_SECONDS);
    expect(clipCrossfadeSeconds(12)).toBe(4);
    expect(clipCrossfadeSeconds(Number.NaN)).toBe(1);
  });

  it('keeps the power constant through a crossfade', () => {
    for (const p of [0, 0.25, 0.5, 0.75, 1]) {
      const out = envelopeAt({ from: 1, to: 0, start: 0, ms: 1000 }, p * 1000);
      const inn = envelopeAt({ from: 0, to: 1, start: 0, ms: 1000 }, p * 1000);
      expect(out ** 2 + inn ** 2).toBeCloseTo(1);
    }
    // A fade from where another one stopped starts there.
    expect(envelopeAt({ from: 0.4, to: 0, start: 100, ms: 1000 }, 100)).toBeCloseTo(0.4);
  });
});

describe('nextClip', () => {
  it('never repeats the clip that just played', () => {
    const list = files('x', 3);
    let previous: string | null = null;
    let seed = 7;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const seen = new Set<string>();
    for (let i = 0; i < 300; i++) {
      const next = nextClip(list, previous, random);
      expect(next).not.toBeNull();
      expect(next?.name).not.toBe(previous);
      seen.add(next!.name);
      previous = next!.name;
    }
    expect(seen.size).toBe(3);
  });

  it('repeats a single clip and skips clips that failed', () => {
    const [only] = files('o', 1);
    expect(nextClip([only], only.name)).toBe(only);
    const list = files('s', 3);
    const skip = new Set([list[1].name, list[2].name]);
    expect(nextClip(list, list[0].name, () => 0.9, skip)).toBe(list[0]);
    expect(nextClip(list, null, () => 0, new Set(list.map((f) => f.name)))).toBeNull();
  });
});

describe('MusicDirector — moments', () => {
  const director = (music = plan()) => {
    const d = new MusicDirector();
    d.setPlan(music);
    return d;
  };

  it('is silent outside spots and fades a spot in when the reading enters it', () => {
    const d = director();
    d.setSegment(5);
    expect(d.target().cue).toBeNull();
    d.setSegment(10);
    expect(d.target()).toMatchObject({ cue: 'c_tension', fadeIn: FADE_IN_SECONDS });
  });

  it('fades out early when the narration leaves the spot', () => {
    const d = director();
    d.setSegment(12);
    d.listen(20);
    d.setSegment(40);
    expect(d.target()).toMatchObject({ cue: null, fadeOut: FADE_OUT_SECONDS });
  });

  it('plays at most max_seconds, fade-out included', () => {
    const d = director();
    d.setSegment(12);
    d.listen(45);
    expect(d.target().cue).toBe('c_tension');
    d.listen(6); // 51 s ≥ 60 − 10
    const target = d.target();
    expect(target.cue).toBeNull();
    expect(target.fadeOut).toBe(9);
    // Still inside the spot: it does not start again.
    d.setSegment(15);
    expect(d.target().cue).toBeNull();
  });

  it('does not replay a spot after a small backward seek, but does after a large one', () => {
    const d = director();
    d.setSegment(12);
    d.setSegment(30);
    expect(d.target().cue).toBeNull();
    d.setSegment(11); // back into the spot
    expect(d.target().cue).toBeNull();
    d.setSegment(30);
    d.setSegment(10 - REARM_SEGMENTS - 1); // well before it
    d.setSegment(10);
    expect(d.target().cue).toBe('c_tension');
  });

  it('moves straight into an adjacent spot', () => {
    const d = director();
    d.setSegment(20);
    d.setSegment(21);
    expect(d.target().cue).toBe('c_calm');
  });

  it('waits for a cue that is not ready and starts it once it is, still inside the spot', () => {
    const d = director();
    d.setSegment(82);
    expect(d.target().cue).toBeNull();
    const ready = plan();
    ready.cues[2].ready = true;
    d.setPlan(ready);
    expect(d.target().cue).toBe('c_dread');
  });

  it('forgets played spots for another document', () => {
    const d = director();
    d.setSegment(12);
    expect(d.spentKeys()).toHaveLength(1);
    d.reset();
    d.setPlan(plan());
    d.setSegment(12);
    expect(d.target().cue).toBe('c_tension');
  });
});

describe('MusicDirector — continuous and mode switching', () => {
  it('follows the timeline and keeps the current cue while the next is not ready', () => {
    const d = new MusicDirector();
    d.setMode('continuous');
    d.setPlan(plan());
    d.setSegment(0);
    expect(d.target().cue).toBe('c_calm');
    d.setSegment(35);
    expect(d.target().cue).toBe('c_tension');
    d.setSegment(55); // dread is not ready yet: tension carries on
    expect(d.target().cue).toBe('c_tension');
    d.setSegment(75);
    expect(d.target().cue).toBe('c_calm');
    d.setSegment(150); // past the timeline
    expect(d.target().cue).toBeNull();
  });

  it('stays silent when the first cue is not ready', () => {
    const d = new MusicDirector();
    d.setMode('continuous');
    d.setPlan(plan());
    d.setSegment(60);
    expect(d.target().cue).toBeNull();
  });

  it('switches modes without replaying a spot', () => {
    const d = new MusicDirector();
    d.setPlan(plan());
    d.setSegment(12);
    expect(d.target().cue).toBe('c_tension');
    d.setMode('continuous');
    expect(d.target().cue).toBe('c_calm');
    d.setMode('moments');
    expect(d.target().cue).toBeNull();
    d.setSegment(13);
    expect(d.target().cue).toBeNull();
  });
});

describe('music prefs', () => {
  it('fills defaults and bounds values', () => {
    expect(sanitizeMusicPrefs(undefined)).toEqual(DEFAULT_MUSIC);
    expect(DEFAULT_MUSIC.mode).toBe('moments');
    expect(DEFAULT_MUSIC.offline).toBe(false);
    expect(
      sanitizeMusicPrefs({ mode: 'continuous', volumeDb: 40, offline: true, docs: ['a', 'a', 3] }),
    ).toEqual({ mode: 'continuous', volumeDb: 0, offline: true, docs: ['a'] });
    expect(sanitizeMusicPrefs({ volumeDb: -99 }).volumeDb).toBe(-24);
  });
});
