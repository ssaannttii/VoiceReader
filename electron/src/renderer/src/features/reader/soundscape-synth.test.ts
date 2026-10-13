import { describe, expect, it } from 'vitest';
import {
  brownNoise,
  encodeWav,
  loopCrossfade,
  mulberry32,
  normalizeLoudness,
  pinkNoise,
  poissonTimes,
  smoothNoise,
  whiteNoise,
} from './soundscape-synth';

describe('noise sources', () => {
  it('are deterministic for a seed and bounded', () => {
    expect(whiteNoise(64, mulberry32(1))).toEqual(whiteNoise(64, mulberry32(1)));
    expect(whiteNoise(64, mulberry32(1))).not.toEqual(whiteNoise(64, mulberry32(2)));
    for (const make of [whiteNoise, pinkNoise, brownNoise]) {
      const values = make(20_000, mulberry32(9));
      expect(Math.max(...values.map(Math.abs))).toBeLessThan(1.5);
      expect(values.every(Number.isFinite)).toBe(true);
    }
  });

  it('brown noise is smoother than white noise', () => {
    const roughness = (values: Float32Array) => {
      let sum = 0;
      for (let i = 1; i < values.length; i++) sum += Math.abs(values[i] - values[i - 1]);
      return sum / values.length;
    };
    const white = whiteNoise(10_000, mulberry32(3));
    const brown = brownNoise(10_000, mulberry32(3));
    expect(roughness(brown)).toBeLessThan(roughness(white) / 10);
  });

  it('smooth noise stays in range and changes gradually', () => {
    const curve = smoothNoise(1000, 100, 2, mulberry32(5));
    expect(Math.max(...curve)).toBeLessThanOrEqual(1);
    expect(Math.min(...curve)).toBeGreaterThanOrEqual(-1);
    for (let i = 1; i < curve.length; i++)
      expect(Math.abs(curve[i] - curve[i - 1])).toBeLessThan(0.1);
  });

  it('poisson events average the requested rate', () => {
    const times = poissonTimes(1000, 5, mulberry32(4));
    expect(times.length).toBeGreaterThan(4500);
    expect(times.length).toBeLessThan(5500);
    expect(times.every((time, i) => i === 0 || time > times[i - 1])).toBe(true);
  });
});

describe('loopCrossfade', () => {
  it('wraps seamlessly: the last sample flows into the first like the source did', () => {
    // A ramp makes any discontinuity at the wrap obvious.
    const loop = 1000;
    const fade = 100;
    const source = Float32Array.from({ length: loop + fade }, (_, i) => i / 10_000);
    const out = loopCrossfade(source, loop, fade);
    expect(out).toHaveLength(loop);
    const step = source[1] - source[0];
    // out[0] is (almost) source[loop]: the wrap is one source step, not a jump of `loop` steps.
    expect(Math.abs(out[0] - out[loop - 1] - step)).toBeLessThan(step * 2);
    // Past the fade the loop is the source itself.
    expect(out[500]).toBeCloseTo(source[500], 6);
    expect(out[loop - 1]).toBeCloseTo(source[loop - 1], 6);
  });

  it('keeps the level of uncorrelated noise through the fade (equal power)', () => {
    const loop = 20_000;
    const fade = 10_000;
    const source = whiteNoise(loop + fade, mulberry32(8));
    const out = loopCrossfade(source, loop, fade);
    const rms = (values: Float32Array) =>
      Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length);
    const inFade = rms(out.subarray(fade * 0.4, fade * 0.6));
    const outside = rms(out.subarray(fade, loop));
    expect(inFade / outside).toBeGreaterThan(0.9);
    expect(inFade / outside).toBeLessThan(1.1);
  });

  it('refuses a source shorter than loop + fade', () => {
    expect(() => loopCrossfade(new Float32Array(10), 8, 4)).toThrow(RangeError);
  });
});

describe('normalizeLoudness', () => {
  it('reaches the RMS target without exceeding the peak', () => {
    const channels = [whiteNoise(10_000, mulberry32(1)), whiteNoise(10_000, mulberry32(2))].map(
      (channel) => channel.map((value) => value * 0.01),
    );
    normalizeLoudness(channels, 0.1, 0.9);
    const all = [...channels[0], ...channels[1]];
    const rms = Math.sqrt(all.reduce((sum, value) => sum + value * value, 0) / all.length);
    expect(rms).toBeLessThanOrEqual(0.1001);
    expect(Math.max(...all.map(Math.abs))).toBeLessThanOrEqual(0.9001);
  });

  it('leaves silence alone', () => {
    const silent = [new Float32Array(10)];
    normalizeLoudness(silent);
    expect([...silent[0]]).toEqual(Array.from({ length: 10 }, () => 0));
  });
});

describe('encodeWav', () => {
  it('writes a 16-bit PCM header and interleaved, clamped samples', () => {
    const left = Float32Array.from([0, 1, -1, 2]);
    const right = Float32Array.from([0.5, -0.5, 0, -2]);
    const bytes = encodeWav([left, right], 22_050);
    const view = new DataView(bytes);
    const text = (offset: number, length: number) =>
      String.fromCharCode(...new Uint8Array(bytes, offset, length));
    expect(bytes.byteLength).toBe(44 + 4 * 2 * 2);
    expect(text(0, 4)).toBe('RIFF');
    expect(view.getUint32(4, true)).toBe(36 + 16);
    expect(text(8, 8)).toBe('WAVEfmt ');
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint32(24, true)).toBe(22_050);
    expect(view.getUint32(28, true)).toBe(22_050 * 4);
    expect(view.getUint16(32, true)).toBe(4);
    expect(view.getUint16(34, true)).toBe(16);
    expect(text(36, 4)).toBe('data');
    expect(view.getUint32(40, true)).toBe(16);
    const samples = Array.from({ length: 8 }, (_, i) => view.getInt16(44 + i * 2, true));
    expect(samples).toEqual([0, 16384, 32767, -16384, -32768, 0, 32767, -32768]);
  });
});
