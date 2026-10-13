import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The controller is wired to the reading player, the API, the clip cache and
// the offline store; all are replaced so only the wiring runs.
const player = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const clock = new Set<() => void>();
  const volume = new Set<(v: number) => void>();
  const sleep = new Set<() => void>();
  const state = {
    doc: null as { id: string; segments: { kind: string }[] } | null,
    segment: 0,
    status: 'paused',
  };
  return {
    state,
    playing: false,
    emit() {
      listeners.forEach((listener) => listener());
    },
    tick() {
      clock.forEach((listener) => listener());
    },
    fade(v: number) {
      volume.forEach((listener) => listener(v));
    },
    sleepStop() {
      sleep.forEach((listener) => listener());
    },
    api: {
      get playing() {
        return player.playing;
      },
      getState: () => state,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      subscribeClock: (listener: () => void) => {
        clock.add(listener);
        return () => clock.delete(listener);
      },
      subscribeVolume: (listener: (v: number) => void) => {
        volume.add(listener);
        return () => volume.delete(listener);
      },
      subscribeSleep: (listener: () => void) => {
        sleep.add(listener);
        return () => sleep.delete(listener);
      },
    },
  };
});

const api = vi.hoisted(() => ({ music: vi.fn() }));

vi.mock('./reader-player', () => ({
  readerPlayer: player.api,
  silentWav: () => 'data:audio/wav;base64,',
}));
vi.mock('./reader-api', () => ({
  readerApi: api,
  readerKeys: { music: (id: string) => ['reader', 'music', id] },
}));
vi.mock('./music-clips', () => ({
  clipBytes: () => Promise.resolve({ bytes: new ArrayBuffer(8), cached: true }),
  clipBlob: () => Promise.resolve(new Blob(['ogg'])),
  readStoredMusic: () => Promise.resolve(null),
  storeMusic: () => Promise.resolve(),
  pruneClips: () => Promise.resolve(),
  prefetchMusic: () => Promise.resolve(0),
}));
vi.mock('./offline-state', () => ({
  offlineSnapshot: () => ({ ready: true, downloaded: {}, active: {} }),
  subscribeOffline: () => () => {},
}));
vi.mock('./reader-debug', () => ({ dlog: () => {} }));
vi.mock('@/lib/audio/object-url', () => ({
  createObjectUrl: () => 'blob:clip',
  revokeObjectUrl: () => {},
}));

class FakeAudio {
  static all: FakeAudio[] = [];
  src = '';
  volume = 1;
  preload = '';
  paused = true;
  ended = false;
  currentTime = 0;
  duration = Number.NaN;
  constructor() {
    FakeAudio.all.push(this);
  }
  setAttribute() {}
  addEventListener() {}
  removeAttribute(name: string) {
    if (name === 'src') this.src = '';
  }
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
}

const PLAN = {
  status: 'ready',
  progress: 1,
  engine_available: true,
  palette: { id: 'dark_fantasy', source: 'auto' },
  palettes: [],
  cues: [
    {
      id: 'tension',
      mood: 'tension',
      ready: true,
      files: [
        { name: 't_0.ogg', duration: 47 },
        { name: 't_1.ogg', duration: 47 },
      ],
    },
  ],
  spots: [{ start_segment: 10, end_segment: 20, cue: 'tension', max_seconds: 60 }],
  timeline: [],
  level_lufs: -24,
};

const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

let now = 0;

describe('background music controller', () => {
  beforeEach(() => {
    vi.stubGlobal('Audio', FakeAudio);
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    api.music.mockResolvedValue(PLAN);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Voice playing for `ms`, ticking like `timeupdate` does. */
  const listen = (ms: number) => {
    for (let left = ms; left > 0; left -= 250) {
      now += 250;
      player.tick();
    }
  };

  it('stays silent and asks nothing while the Labs switch is off', async () => {
    await import('./reader-music');
    const { setMusicOnFor } = await import('./music-prefs');
    setMusicOnFor('doc1', true);
    player.state.doc = { id: 'doc1', segments: [] };
    player.state.segment = 12;
    player.state.status = 'playing';
    player.playing = true;
    player.emit();
    await flush();
    expect(api.music).not.toHaveBeenCalled();
    expect(FakeAudio.all).toHaveLength(0);
  });

  it('plays a spot with the voice, pauses with it and follows the sleep fade', async () => {
    const { musicController } = await import('./reader-music');
    const { setLabsPrefs } = await import('./labs-prefs');
    const { musicPresence } = await import('./music-duck');
    setLabsPrefs({ music: true });
    await flush();
    expect(api.music).toHaveBeenCalledWith('doc1', undefined);
    const deck = FakeAudio.all.find((el) => el.src === 'blob:clip');
    expect(deck).toBeDefined();
    expect(deck!.paused).toBe(false);
    expect(musicController.getInfo()).toMatchObject({ docId: 'doc1', cue: 'tension' });

    listen(6000);
    const full = 10 ** (-6 / 20); // default volume (the design level), clips mastered 6 dB hotter
    expect(deck!.volume).toBeCloseTo(full, 3);
    // The ambience sits lower while the music is present.
    expect(musicPresence()).toBeCloseTo(1, 2);

    // The voice pauses (any way): so does the music.
    player.state.status = 'paused';
    player.playing = false;
    player.emit();
    expect(deck!.paused).toBe(true);
    expect(musicPresence()).toBe(0);

    player.state.status = 'playing';
    player.playing = true;
    player.emit();
    expect(deck!.paused).toBe(false);

    // Sleep timer fade.
    player.fade(0.5);
    expect(deck!.volume).toBeCloseTo(full * 0.5, 3);
    player.fade(1);

    // Reading speed is not the music's business: nothing reads the rate.
    // Leaving the spot fades the music out.
    player.state.segment = 40;
    player.emit();
    listen(10_500);
    expect(musicController.getInfo().cue).toBeNull();
    expect(musicPresence()).toBe(0);
  });

  it('lets the music go on another document without music', async () => {
    const { musicController } = await import('./reader-music');
    player.state.segment = 12;
    player.state.doc = { id: 'doc1', segments: [] };
    player.emit();
    player.state.doc = { id: 'doc2', segments: [] };
    player.emit();
    expect(musicController.getInfo().docId).toBeNull();
    listen(3000);
    expect(musicController.getInfo().cue).toBeNull();
  });
});
