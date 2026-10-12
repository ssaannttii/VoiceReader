import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildAudioInputConstraints, startInputLevelMonitor } from './recorder';

function stubAudioContext(overrides: Record<string, unknown> = {}) {
  const node = () => ({ connect: vi.fn(), disconnect: vi.fn() });
  const context = {
    destination: {},
    createMediaStreamSource: vi.fn(node),
    createAnalyser: vi.fn(() => ({ ...node(), fftSize: 0, getFloatTimeDomainData: vi.fn() })),
    createGain: vi.fn(() => ({ ...node(), gain: { value: 1 } })),
    resume: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    ...overrides,
  };
  vi.stubGlobal('AudioContext', function AudioContextStub() {
    return context;
  });
  return context;
}

afterEach(() => vi.unstubAllGlobals());

describe('startInputLevelMonitor setup failure', () => {
  it('closes the AudioContext when graph setup throws', () => {
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const context = stubAudioContext({
      createMediaStreamSource: vi.fn(() => {
        throw new Error('bad stream');
      }),
    });
    expect(() => startInputLevelMonitor({} as MediaStream, vi.fn())).toThrow('bad stream');
    expect(context.close).toHaveBeenCalledOnce();
  });

  it('closes the AudioContext when frame scheduling throws', () => {
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => {
        throw new Error('no frames');
      }),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const context = stubAudioContext();
    expect(() => startInputLevelMonitor({} as MediaStream, vi.fn())).toThrow('no frames');
    expect(context.close).toHaveBeenCalledOnce();
  });
});

describe('buildAudioInputConstraints', () => {
  it('turns off browser voice processing only for raw voice references', () => {
    expect(buildAudioInputConstraints('', 'auto')).toEqual({ audio: true });
    expect(buildAudioInputConstraints('mic-1', 'mono', true)).toEqual({
      audio: {
        deviceId: { exact: 'mic-1' },
        channelCount: { ideal: 1 },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
  });
});
