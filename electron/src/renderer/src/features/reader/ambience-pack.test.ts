import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReaderAmbienceBed } from './reader-api';

const api = vi.hoisted(() => ({
  ambiencePack: vi.fn(),
  ambienceFile: vi.fn(),
}));
vi.mock('./reader-api', () => ({ readerApi: api }));
vi.mock('./soundscape-cache', () => ({
  loadBed: vi.fn((id: string) => Promise.resolve(new Blob([`synth:${id}`]))),
  cachedBytes: vi.fn(() => Promise.resolve(null)),
  storeBytes: vi.fn(() => Promise.resolve()),
  pruneBytes: vi.fn(() => Promise.resolve()),
}));

const { ambiencePack, chooseBed, decodeLoop, recordedKey, sanitizePack, storageKey, trimPad } =
  await import('./ambience-pack');
const { setListeningPrefs } = await import('./listening-prefs');

const bed = (patch: Partial<ReaderAmbienceBed> = {}): ReaderAmbienceBed => ({
  id: 'rain',
  tag: 'rain',
  file: 'rain.ogg',
  rms: 0.1,
  duration: 74.5,
  sha256: 'abc123',
  ...patch,
});

describe('sanitizePack', () => {
  it('keeps well-formed beds and drops the rest', () => {
    const beds = sanitizePack({
      beds: [
        bed(),
        bed({ file: '../secret.ogg' }),
        bed({ file: 'a/b.ogg' }),
        bed({ rms: 0 }),
        bed({ rms: 3 }),
        bed({ duration: -1 }),
        { tag: 'mist' },
        null,
        'rain.ogg',
      ],
    });
    expect(beds).toEqual([bed()]);
    expect(sanitizePack(null)).toEqual([]);
    expect(sanitizePack({ beds: 'nope' })).toEqual([]);
  });
});

describe('chooseBed', () => {
  const beds = [bed(), bed({ id: 'river', tag: 'river', file: 'river.ogg', rms: 0.08 })];

  it('prefers the recording and keeps the synthesized bed as fallback', () => {
    expect(chooseBed('rain', beds, true)).toEqual({
      key: 'rec:rain.ogg',
      rms: 0.1,
      fallback: { key: 'rain' },
    });
    // No synthesized river: the recording has no fallback (silence if it cannot load).
    expect(chooseBed('river', beds, true)).toEqual({
      key: 'rec:river.ogg',
      rms: 0.08,
      fallback: null,
    });
  });

  it('uses the synthesized bed when recordings are off or missing', () => {
    expect(chooseBed('rain', beds, false)).toEqual({ key: 'rain' });
    expect(chooseBed('tavern', beds, true)).toEqual({ key: 'cafe' });
    expect(chooseBed('river', beds, false)).toBeNull();
  });

  it('keys recordings by file and their cache entries by content', () => {
    expect(recordedKey(bed())).toBe('rec:rain.ogg');
    expect(storageKey(bed())).toBe('rec:rain.ogg@abc123');
    expect(storageKey(bed({ sha256: undefined }))).toBe('rec:rain.ogg@74.5');
  });
});

describe('ambiencePack store', () => {
  beforeEach(() => {
    api.ambiencePack.mockReset();
    api.ambienceFile.mockReset();
    setListeningPrefs({ soundscapeRecorded: true });
  });

  it('learns the PC pack, then answers per tag and for the manual sounds', async () => {
    api.ambiencePack.mockResolvedValue({
      available: true,
      beds: [bed(), bed({ id: 'fire', tag: 'fire', file: 'fire.ogg' })],
    });
    await ambiencePack.refresh(true);
    expect(ambiencePack.getState().status).toBe('ready');
    expect(ambiencePack.bedFor('rain')?.key).toBe('rec:rain.ogg');
    expect(ambiencePack.bedFor('storm')?.key).toBe('storm');
    expect(ambiencePack.manualKey('fire')).toBe('rec:fire.ogg');
    expect(ambiencePack.manualKey('cafe')).toBe('cafe');
    expect(ambiencePack.manualKey('brown')).toBe('brown');
    setListeningPrefs({ soundscapeRecorded: false });
    expect(ambiencePack.bedFor('rain')?.key).toBe('rain');
    expect(ambiencePack.manualKey('fire')).toBe('fire');
  });

  it('keeps the last known pack when the PC cannot be reached', async () => {
    api.ambiencePack.mockResolvedValue({ available: true, beds: [bed()] });
    await ambiencePack.refresh(true);
    api.ambiencePack.mockRejectedValue(new TypeError('offline'));
    await ambiencePack.refresh(true);
    expect(ambiencePack.getState().beds).toEqual([bed()]);
  });

  it('loads synthesized keys from the loop cache and rejects unknown recordings', async () => {
    api.ambiencePack.mockResolvedValue({ available: false, beds: [] });
    await ambiencePack.refresh(true);
    expect(ambiencePack.getState().status).toBe('unavailable');
    await expect(ambiencePack.load('rain').then((blob) => blob.text())).resolves.toBe('synth:rain');
    await expect(ambiencePack.load('rec:gone.ogg')).rejects.toThrow();
  });
});

describe('decodeLoop', () => {
  it('refuses bytes this environment can neither decode nor play (the caller falls back)', async () => {
    vi.stubGlobal('OfflineAudioContext', undefined);
    await expect(decodeLoop(new ArrayBuffer(8))).rejects.toThrow();
    vi.unstubAllGlobals();
  });

  it('decodes to a WAV loop at the decode rate', async () => {
    class FakeOffline {
      decodeAudioData() {
        return Promise.resolve({
          numberOfChannels: 2,
          sampleRate: 32000,
          getChannelData: () => new Float32Array(320),
        });
      }
    }
    vi.stubGlobal('OfflineAudioContext', FakeOffline);
    const blob = await decodeLoop(new ArrayBuffer(8));
    expect(blob.type).toBe('audio/wav');
    expect(blob.size).toBe(44 + 320 * 2 * 2);
    // 8 ms of loop after 1 ms of padding: only the loop is kept.
    const padded = await decodeLoop(new ArrayBuffer(8), 0.001, 0.008);
    expect(padded.size).toBe(44 + 256 * 2 * 2);
    vi.unstubAllGlobals();
  });

  it('never plays a padded file undecoded (its seam would jump)', async () => {
    vi.stubGlobal('OfflineAudioContext', undefined);
    await expect(decodeLoop(new ArrayBuffer(8), 0.5, 70)).rejects.toThrow();
    vi.unstubAllGlobals();
  });
});

describe('trimPad', () => {
  it('cuts the padding around the loop off', () => {
    const channel = Float32Array.from({ length: 100 }, (_, i) => i);
    const loop = trimPad(channel, 10, 0.5, 9);
    expect(loop.length).toBe(90);
    expect(loop[0]).toBe(5);
    expect(loop[89]).toBe(94);
  });

  it('leaves unpadded or inconsistent buffers alone', () => {
    const channel = new Float32Array(100);
    expect(trimPad(channel, 10, 0, 10)).toBe(channel);
    expect(trimPad(channel, 10, 0.5, 20)).toBe(channel);
  });
});
