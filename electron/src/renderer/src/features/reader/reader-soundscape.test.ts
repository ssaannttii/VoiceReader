import { beforeEach, describe, expect, it, vi } from 'vitest';

// The soundscape player is wired to the reading player, the scene ambience and
// the loop cache; all three are replaced so only the switching logic runs.
const ambience = vi.hoisted(() => ({
  enabled: false,
  active: false,
  master: 0,
  unlocked: 0,
  setEnabled(value: boolean) {
    this.enabled = value;
  },
  setActive(value: boolean) {
    this.active = value;
  },
  setMaster(value: number) {
    this.master = value;
  },
  unlock() {
    this.unlocked++;
  },
}));

vi.mock('./reader-ambience', () => ({ ambienceController: ambience }));
vi.mock('./soundscape-cache', () => ({
  loadBed: vi.fn(() => Promise.resolve(new Blob(['wav']))),
}));
vi.mock('@/lib/audio/object-url', () => ({
  createObjectUrl: () => 'blob:manual',
  revokeObjectUrl: () => {},
}));
vi.mock('./reader-player', () => {
  const listeners = new Set<() => void>();
  return {
    silentWav: () => 'data:audio/wav;base64,',
    readerPlayer: {
      playing: false,
      getState: () => ({ status: 'paused', doc: null }),
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      subscribeVolume: () => () => {},
      subscribeSleep: () => () => {},
    },
  };
});

class FakeAudio {
  static last: FakeAudio | null = null;
  src = '';
  volume = 1;
  loop = false;
  preload = '';
  paused = true;
  plays = 0;
  constructor() {
    FakeAudio.last = this;
  }
  setAttribute() {}
  addEventListener() {}
  play() {
    this.paused = false;
    this.plays++;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('soundscape player with Automático', () => {
  beforeEach(() => {
    vi.stubGlobal('Audio', FakeAudio);
  });

  it('hands playback to the scene ambience and back to the manual sound', async () => {
    const { soundscapePlayer } = await import('./reader-soundscape');
    const { listeningPrefs } = await import('./listening-prefs');
    soundscapePlayer.setWithVoice(false); // play without the voice, so it is wanted now

    soundscapePlayer.choose('rain');
    await flush();
    const manual = FakeAudio.last!;
    expect(manual.src).toBe('blob:manual');
    expect(manual.paused).toBe(false);
    expect(ambience.enabled).toBe(false);
    expect(ambience.active).toBe(false);

    soundscapePlayer.choose('auto');
    await flush();
    expect(listeningPrefs().soundscape).toBe('auto');
    expect(ambience.enabled).toBe(true);
    expect(ambience.active).toBe(true);
    expect(ambience.unlocked).toBe(1);
    expect(manual.paused).toBe(true);
    expect(soundscapePlayer.getStatus()).toBe('playing');

    // Back to a fixed sound: exactly the manual behaviour again.
    soundscapePlayer.choose('rain');
    await flush();
    expect(ambience.enabled).toBe(false);
    expect(ambience.active).toBe(false);
    expect(manual.paused).toBe(false);
    expect(manual.src).toBe('blob:manual');

    soundscapePlayer.choose('off');
    await flush();
    expect(manual.paused).toBe(true);
    expect(ambience.enabled).toBe(false);
    expect(soundscapePlayer.getStatus()).toBe('off');
  });

  it('the volume slider drives the ambience master gain too', async () => {
    const { soundscapePlayer, soundscapeGain } = await import('./reader-soundscape');
    soundscapePlayer.choose('auto');
    soundscapePlayer.setVolume(60);
    await flush();
    expect(ambience.master).toBeCloseTo(soundscapeGain(60, 1), 6);
  });
});
