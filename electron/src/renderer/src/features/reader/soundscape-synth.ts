/**
 * Ambient beds for long listening, synthesized on the device: no recorded or
 * licensed audio. Each soundscape is built from seeded noise and event layers
 * (drops, clinks, crackles) shaped by biquad filters in an OfflineAudioContext,
 * rendered once into a seamless loop and encoded as WAV for a looping
 * `<audio>` element (reader-soundscape.ts). The pure helpers below (noise,
 * crossfade, WAV) are unit-tested.
 */
import type { SoundscapeId } from './listening-prefs';

export const SOUNDSCAPE_RATE = 22_050;
/** Loop length; long enough that the repetition is not noticeable. */
export const LOOP_SECONDS = 32;
/** The loop's tail is crossfaded into its head over this long. */
export const FADE_SECONDS = 2;
/** Filters settle before the loop starts. */
const PREROLL_SECONDS = 0.5;
/** Bump when the synthesis changes so cached loops are rebuilt. */
export const SOUNDSCAPE_VERSION = 1;

// ── pure helpers ───────────────────────────────────────────────────────────

/** Small seeded PRNG (mulberry32): the same soundscape renders the same every time. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function whiteNoise(length: number, random: () => number): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = random() * 2 - 1;
  return out;
}

/** Pink (1/f) noise, Paul Kellet's filter. */
export function pinkNoise(length: number, random: () => number): Float32Array {
  const out = new Float32Array(length);
  let b0 = 0,
    b1 = 0,
    b2 = 0,
    b3 = 0,
    b4 = 0,
    b5 = 0,
    b6 = 0;
  for (let i = 0; i < length; i++) {
    const white = random() * 2 - 1;
    b0 = 0.99886 * b0 + white * 0.0555179;
    b1 = 0.99332 * b1 + white * 0.0750759;
    b2 = 0.969 * b2 + white * 0.153852;
    b3 = 0.8665 * b3 + white * 0.3104856;
    b4 = 0.55 * b4 + white * 0.5329522;
    b5 = -0.7616 * b5 - white * 0.016898;
    out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
    b6 = white * 0.115926;
  }
  return out;
}

/** Brown (1/f²) noise: leaky integrated white noise. */
export function brownNoise(length: number, random: () => number): Float32Array {
  const out = new Float32Array(length);
  let last = 0;
  for (let i = 0; i < length; i++) {
    last = (last + 0.02 * (random() * 2 - 1)) / 1.02;
    out[i] = last * 3.5;
  }
  return out;
}

/** Smooth random curve in [-1, 1] with about `rate` changes per second (cosine-interpolated). */
export function smoothNoise(
  length: number,
  sampleRate: number,
  rate: number,
  random: () => number,
): Float32Array {
  const out = new Float32Array(length);
  const step = Math.max(1, Math.round(sampleRate / Math.max(0.01, rate)));
  let from = random() * 2 - 1;
  let to = random() * 2 - 1;
  for (let i = 0; i < length; i++) {
    const phase = (i % step) / step;
    if (i > 0 && phase === 0) {
      from = to;
      to = random() * 2 - 1;
    }
    const mix = (1 - Math.cos(phase * Math.PI)) / 2;
    out[i] = from + (to - from) * mix;
  }
  return out;
}

/**
 * A seamless loop of `loop` samples: the `fade` samples after the loop are
 * blended into its start with an equal-power crossfade, so the last sample
 * flows into the first one exactly as in the source.
 */
export function loopCrossfade(source: Float32Array, loop: number, fade: number): Float32Array {
  if (source.length < loop + fade) throw new RangeError('source shorter than loop + fade');
  const out = source.slice(0, loop);
  for (let i = 0; i < fade; i++) {
    const x = (i + 0.5) / fade;
    const fadeIn = Math.sin((x * Math.PI) / 2);
    const fadeOut = Math.cos((x * Math.PI) / 2);
    out[i] = source[i] * fadeIn + source[loop + i] * fadeOut;
  }
  return out;
}

/** Scale channels to an RMS target without exceeding `peak`. */
export function normalizeLoudness(channels: Float32Array[], rms = 0.12, peak = 0.9): void {
  let sum = 0;
  let max = 0;
  let count = 0;
  for (const channel of channels) {
    for (const value of channel) {
      sum += value * value;
      max = Math.max(max, Math.abs(value));
    }
    count += channel.length;
  }
  if (!count || max === 0) return;
  const current = Math.sqrt(sum / count);
  const gain = Math.min(rms / current, peak / max);
  for (const channel of channels) for (let i = 0; i < channel.length; i++) channel[i] *= gain;
}

/** 16-bit PCM WAV with interleaved channels. */
export function encodeWav(channels: Float32Array[], sampleRate: number): ArrayBuffer {
  const count = channels.length;
  const frames = count ? channels[0].length : 0;
  const bytes = frames * count * 2;
  const buffer = new ArrayBuffer(44 + bytes);
  const view = new DataView(buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + bytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, count, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * count * 2, true);
  view.setUint16(32, count * 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, bytes, true);
  let offset = 44;
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < count; channel++) {
      const value = Math.max(-1, Math.min(1, channels[channel][frame]));
      view.setInt16(
        offset,
        value < 0 ? Math.round(value * 0x8000) : Math.round(value * 0x7fff),
        true,
      );
      offset += 2;
    }
  }
  return buffer;
}

/** Event times (seconds) of a Poisson process with `rate` events per second. */
export function poissonTimes(duration: number, rate: number, random: () => number): number[] {
  const times: number[] = [];
  let time = 0;
  for (;;) {
    time += -Math.log(1 - random()) / rate;
    if (time >= duration) return times;
    times.push(time);
  }
}

// ── layers ─────────────────────────────────────────────────────────────────

interface Layer {
  /** Stereo source. */
  left: Float32Array;
  right: Float32Array;
  filters: { type: BiquadFilterType; frequency: number; Q?: number }[];
  gain: number;
  /** Slow gain modulation: gain × (1 + depth × noise). */
  wobble?: { rate: number; depth: number };
}

/** A short event written into both channels with a random pan. */
function stamp(
  left: Float32Array,
  right: Float32Array,
  at: number,
  amplitude: number,
  pan: number,
  kernel: Float32Array,
) {
  const l = amplitude * Math.cos(((pan + 1) * Math.PI) / 4);
  const r = amplitude * Math.sin(((pan + 1) * Math.PI) / 4);
  for (let i = 0; i < kernel.length && at + i < left.length; i++) {
    left[at + i] += kernel[i] * l;
    right[at + i] += kernel[i] * r;
  }
}

/** Noise burst with an exponential decay (drops, crackles). */
function burst(seconds: number, sampleRate: number, random: () => number): Float32Array {
  const length = Math.max(2, Math.round(seconds * sampleRate * 5));
  const out = new Float32Array(length);
  const decay = seconds * sampleRate;
  for (let i = 0; i < length; i++) out[i] = (random() * 2 - 1) * Math.exp(-i / decay);
  return out;
}

/** A glass/cup "clink": a few inharmonic partials ringing down. */
function clink(frequency: number, seconds: number, sampleRate: number): Float32Array {
  const length = Math.round(seconds * 5 * sampleRate);
  const out = new Float32Array(length);
  const partials = [
    [1, 1],
    [2.76, 0.5],
    [5.4, 0.25],
  ];
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    let value = 0;
    for (const [ratio, level] of partials) {
      if (frequency * ratio >= sampleRate / 2) continue;
      value +=
        level * Math.sin(2 * Math.PI * frequency * ratio * t) * Math.exp(-t / (seconds / ratio));
    }
    out[i] = value * Math.min(1, i / 20);
  }
  return out;
}

function layers(id: SoundscapeId, length: number, sampleRate: number): Layer[] {
  const seed = { rain: 11, brown: 23, pink: 37, cafe: 41, fire: 53 }[id];
  const random = mulberry32(seed);
  const stereo = (make: (n: number, r: () => number) => Float32Array) => ({
    left: make(length, random),
    right: make(length, random),
  });
  const seconds = length / sampleRate;
  const events = (
    rate: number,
    write: (at: number, left: Float32Array, right: Float32Array) => void,
  ) => {
    const left = new Float32Array(length);
    const right = new Float32Array(length);
    for (const time of poissonTimes(seconds, rate, random))
      write(Math.floor(time * sampleRate), left, right);
    return { left, right };
  };
  switch (id) {
    case 'brown':
      return [{ ...stereo(brownNoise), filters: [{ type: 'lowpass', frequency: 900 }], gain: 1 }];
    case 'pink':
      return [
        {
          ...stereo(pinkNoise),
          filters: [
            { type: 'highpass', frequency: 40 },
            { type: 'lowpass', frequency: 9000 },
          ],
          gain: 1,
        },
      ];
    case 'rain':
      return [
        {
          ...stereo(whiteNoise),
          filters: [
            { type: 'highpass', frequency: 700 },
            { type: 'lowpass', frequency: 7500, Q: 0.5 },
          ],
          gain: 0.22,
          wobble: { rate: 0.15, depth: 0.2 },
        },
        { ...stereo(pinkNoise), filters: [{ type: 'lowpass', frequency: 1800 }], gain: 0.5 },
        { ...stereo(brownNoise), filters: [{ type: 'lowpass', frequency: 220 }], gain: 0.35 },
        {
          ...events(45, (at, left, right) =>
            stamp(
              left,
              right,
              at,
              0.05 + random() ** 3 * 0.5,
              random() * 2 - 1,
              burst(0.002 + random() * 0.008, sampleRate, random),
            ),
          ),
          filters: [{ type: 'bandpass', frequency: 2600, Q: 0.7 }],
          gain: 0.9,
        },
      ];
    case 'cafe': {
      // Babble: pink noise in speech bands, each with its own syllable-rate envelope.
      const babble = [380, 700, 1150, 1900].map((frequency, band) => {
        const envelope = (n: number) => {
          const syllables = smoothNoise(n, sampleRate, 3 + band * 0.7, random);
          const phrases = smoothNoise(n, sampleRate, 0.25, random);
          const out = new Float32Array(n);
          const noise = pinkNoise(n, random);
          for (let i = 0; i < n; i++) {
            const level = Math.max(0, syllables[i]) ** 2 * (0.6 + 0.4 * phrases[i]);
            out[i] = noise[i] * level;
          }
          return out;
        };
        return {
          left: envelope(length),
          right: envelope(length),
          filters: [{ type: 'bandpass' as const, frequency, Q: 1.4 }],
          gain: 0.9 - band * 0.12,
        };
      });
      return [
        ...babble,
        {
          ...stereo(brownNoise),
          filters: [{ type: 'lowpass', frequency: 450 }],
          gain: 0.25,
          wobble: { rate: 0.1, depth: 0.25 },
        },
        {
          ...events(0.35, (at, left, right) =>
            stamp(
              left,
              right,
              at,
              0.04 + random() * 0.08,
              random() * 1.6 - 0.8,
              clink(2200 + random() * 2600, 0.06 + random() * 0.12, sampleRate),
            ),
          ),
          filters: [{ type: 'highpass', frequency: 1200 }],
          gain: 1,
        },
      ];
    }
    case 'fire': {
      // Crackles come in clusters: a Poisson process of bursts of quick clicks.
      const crackles = events(1.6, (at, left, right) => {
        const clicks = 1 + Math.floor(random() ** 2 * 9);
        let offset = at;
        const pan = random() * 1.6 - 0.8;
        for (let i = 0; i < clicks; i++) {
          stamp(
            left,
            right,
            offset,
            0.15 + random() ** 2 * 0.85,
            pan + (random() - 0.5) * 0.3,
            burst(0.0004 + random() * 0.002, sampleRate, random),
          );
          offset += Math.floor((0.004 + random() * 0.06) * sampleRate);
        }
      });
      const pops = events(0.25, (at, left, right) =>
        stamp(
          left,
          right,
          at,
          0.3 + random() * 0.4,
          random() - 0.5,
          burst(0.012, sampleRate, random),
        ),
      );
      return [
        {
          ...stereo(brownNoise),
          filters: [{ type: 'lowpass', frequency: 320 }],
          gain: 0.7,
          wobble: { rate: 0.8, depth: 0.35 },
        },
        {
          ...stereo(whiteNoise),
          filters: [{ type: 'bandpass', frequency: 3200, Q: 0.6 }],
          gain: 0.025,
          wobble: { rate: 0.5, depth: 0.5 },
        },
        { ...crackles, filters: [{ type: 'highpass', frequency: 1400 }], gain: 0.55 },
        { ...pops, filters: [{ type: 'lowpass', frequency: 900 }], gain: 0.5 },
      ];
    }
  }
}

// ── rendering ──────────────────────────────────────────────────────────────

type OfflineContextConstructor = new (
  channels: number,
  length: number,
  sampleRate: number,
) => OfflineAudioContext;

/** Render one soundscape into a seamless stereo loop, as WAV bytes. */
export async function renderSoundscape(id: SoundscapeId): Promise<ArrayBuffer> {
  const Context = ((globalThis as { OfflineAudioContext?: OfflineContextConstructor })
    .OfflineAudioContext ??
    (globalThis as { webkitOfflineAudioContext?: OfflineContextConstructor })
      .webkitOfflineAudioContext) as OfflineContextConstructor | undefined;
  if (!Context) throw new Error('OfflineAudioContext unavailable');
  const rate = SOUNDSCAPE_RATE;
  const preroll = PREROLL_SECONDS * rate;
  const loop = LOOP_SECONDS * rate;
  const fade = FADE_SECONDS * rate;
  const length = preroll + loop + fade;
  const context = new Context(2, length, rate);
  const random = mulberry32(7);
  for (const layer of layers(id, length, rate)) {
    const buffer = context.createBuffer(2, length, rate);
    buffer.copyToChannel(layer.left as Float32Array<ArrayBuffer>, 0);
    buffer.copyToChannel(layer.right as Float32Array<ArrayBuffer>, 1);
    const source = context.createBufferSource();
    source.buffer = buffer;
    let node: AudioNode = source;
    for (const filter of layer.filters) {
      const biquad = context.createBiquadFilter();
      biquad.type = filter.type;
      biquad.frequency.value = filter.frequency;
      if (filter.Q !== undefined) biquad.Q.value = filter.Q;
      node.connect(biquad);
      node = biquad;
    }
    const gain = context.createGain();
    gain.gain.value = layer.gain;
    if (layer.wobble) {
      // Control-rate curve (50 Hz) is plenty for slow swells.
      const points = Math.ceil((length / rate) * 50);
      const noise = smoothNoise(points, 50, layer.wobble.rate, random);
      const curve = new Float32Array(points);
      for (let i = 0; i < points; i++)
        curve[i] = Math.max(0, layer.gain * (1 + layer.wobble.depth * noise[i]));
      gain.gain.setValueCurveAtTime(curve, 0, length / rate);
    }
    node.connect(gain);
    gain.connect(context.destination);
    source.start(0);
  }
  const rendered = await context.startRendering();
  const channels = [0, 1].map((channel) =>
    loopCrossfade(rendered.getChannelData(channel).subarray(preroll), loop, fade),
  );
  normalizeLoudness(channels);
  return encodeWav(channels, rate);
}
