import { describe, expect, it } from 'vitest';
import {
  AMBIENT_BEDS,
  AMBIENT_RMS,
  LOOP_SECONDS,
  SOUNDSCAPE_RATE,
  biquadCoefficients,
  brownNoise,
  encodeWav,
  loopCrossfade,
  mulberry32,
  normalizeLoudness,
  pinkNoise,
  poissonTimes,
  renderBedChannels,
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

describe('ambient beds (automatic ambience)', () => {
  const rms = (channels: Float32Array[]) => {
    let sum = 0;
    let count = 0;
    for (const channel of channels) {
      for (const value of channel) sum += value * value;
      count += channel.length;
    }
    return Math.sqrt(sum / count);
  };
  const dbfs = (value: number) => 20 * Math.log10(value);
  const peak = (channel: Float32Array) => channel.reduce((max, v) => Math.max(max, Math.abs(v)), 0);

  it.each(AMBIENT_BEDS)(
    '%s renders a seamless, understated stereo loop',
    async (id) => {
      const channels = await renderBedChannels(id, { offline: false });
      expect(channels).toHaveLength(2);
      for (const channel of channels) {
        expect(channel).toHaveLength(LOOP_SECONDS * SOUNDSCAPE_RATE);
        expect(channel.every(Number.isFinite)).toBe(true);
      }
      // Understated: about −25 dBFS RMS (never louder), peaks well below full scale.
      const level = dbfs(rms(channels));
      expect(level).toBeLessThanOrEqual(dbfs(AMBIENT_RMS) + 0.01);
      expect(level).toBeGreaterThan(-36);
      for (const channel of channels) expect(peak(channel)).toBeLessThanOrEqual(0.5001);
      // Seamless: the jump from the last sample to the first is an ordinary step.
      for (const channel of channels) {
        let largest = 0;
        let total = 0;
        for (let i = 1; i < channel.length; i++) {
          const step = Math.abs(channel[i] - channel[i - 1]);
          largest = Math.max(largest, step);
          total += step;
        }
        const wrap = Math.abs(channel[0] - channel[channel.length - 1]);
        expect(wrap).toBeLessThanOrEqual(largest);
        expect(wrap).toBeLessThanOrEqual((8 * total) / (channel.length - 1));
        // …and the loop does not start or end on a cut to silence.
        expect(peak(channel.subarray(0, SOUNDSCAPE_RATE))).toBeGreaterThan(0);
      }
    },
    30_000,
  );

  it('renders the same bed identically every time (seeded)', async () => {
    const a = await renderBedChannels('night', { offline: false });
    const b = await renderBedChannels('night', { offline: false });
    expect(a[0].subarray(0, 5000)).toEqual(b[0].subarray(0, 5000));
  }, 30_000);

  it('beds differ from each other', async () => {
    const sea = await renderBedChannels('sea', { offline: false });
    const wind = await renderBedChannels('wind', { offline: false });
    expect(sea[0].subarray(0, 1000)).not.toEqual(wind[0].subarray(0, 1000));
  }, 30_000);

  it('encodes ambient beds as WAV like the manual loops', async () => {
    const bytes = encodeWav(await renderBedChannels('room', { offline: false }), SOUNDSCAPE_RATE);
    expect(bytes.byteLength).toBe(44 + LOOP_SECONDS * SOUNDSCAPE_RATE * 2 * 2);
  }, 30_000);
});

describe('biquadCoefficients (Web Audio formulas)', () => {
  const gainAt = (c: number[], frequency: number, rate: number) => {
    const w = (2 * Math.PI * frequency) / rate;
    const re = (b0: number, b1: number, b2: number) => b0 + b1 * Math.cos(w) + b2 * Math.cos(2 * w);
    const im = (b1: number, b2: number) => -(b1 * Math.sin(w) + b2 * Math.sin(2 * w));
    const [b0, b1, b2, a1, a2] = c;
    const num = Math.hypot(re(b0, b1, b2), im(b1, b2));
    const den = Math.hypot(re(1, a1, a2), im(a1, a2));
    return num / den;
  };

  it('passes and stops the right bands', () => {
    const lowpass = biquadCoefficients('lowpass', 500, undefined, 22_050);
    expect(gainAt(lowpass, 20, 22_050)).toBeCloseTo(1, 2);
    expect(gainAt(lowpass, 5000, 22_050)).toBeLessThan(0.02);
    const highpass = biquadCoefficients('highpass', 500, undefined, 22_050);
    expect(gainAt(highpass, 20, 22_050)).toBeLessThan(0.01);
    expect(gainAt(highpass, 5000, 22_050)).toBeCloseTo(1, 1);
    const bandpass = biquadCoefficients('bandpass', 1000, 2, 22_050);
    expect(gainAt(bandpass, 1000, 22_050)).toBeCloseTo(1, 3);
    expect(gainAt(bandpass, 100, 22_050)).toBeLessThan(0.1);
  });
});
