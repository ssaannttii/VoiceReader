/**
 * Ambient beds for long listening, synthesized on the device: no recorded or
 * licensed audio. Each soundscape is built from seeded noise and event layers
 * (drops, clinks, crackles) shaped by biquad filters in an OfflineAudioContext,
 * rendered once into a seamless loop and encoded as WAV for a looping
 * `<audio>` element (reader-soundscape.ts). The pure helpers below (noise,
 * crossfade, WAV) are unit-tested.
 */
import type { SoundscapeId } from './listening-prefs';

/** Beds only the automatic ambience uses (scene tags without a manual sound). */
export const AMBIENT_BEDS = [
  'wind',
  'sea',
  'storm',
  'forest',
  'night',
  'room',
  'city',
  'cave',
] as const;
export type AmbientBedId = (typeof AMBIENT_BEDS)[number];
/** Every synthesized loop: the manual soundscapes plus the ambient beds. */
export type BedId = SoundscapeId | AmbientBedId;

/** Loop loudness (RMS of full scale): manual sounds ≈ −18 dBFS, ambient beds ≈ −25 dBFS. */
export const MANUAL_RMS = 0.12;
export const AMBIENT_RMS = 0.056;
/** Ambient beds also keep their peaks low (drips, chirps): understated, never startling. */
const AMBIENT_PEAK = 0.5;

export function isAmbientBed(id: BedId): id is AmbientBedId {
  return (AMBIENT_BEDS as readonly string[]).includes(id);
}

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

/** A short bird call: a few quick sine sweeps with soft edges. */
function chirp(sampleRate: number, random: () => number): Float32Array {
  const notes = 2 + Math.floor(random() * 4);
  const noteSeconds = 0.05 + random() * 0.07;
  const gapSeconds = 0.04 + random() * 0.06;
  const base = 2600 + random() * 1800;
  const sweep = (random() < 0.5 ? -1 : 1) * (300 + random() * 900);
  const noteLength = Math.round(noteSeconds * sampleRate);
  const step = noteLength + Math.round(gapSeconds * sampleRate);
  const out = new Float32Array(step * notes);
  for (let note = 0; note < notes; note++) {
    let phase = 0;
    const level = 1 - note * 0.12;
    for (let i = 0; i < noteLength; i++) {
      const x = i / noteLength;
      phase += (2 * Math.PI * (base + sweep * x)) / sampleRate;
      out[note * step + i] = Math.sin(phase) * Math.sin(Math.PI * x) ** 2 * level;
    }
  }
  return out;
}

/** A cricket chirp: three or four 4–5 kHz pulses. */
function cricket(frequency: number, sampleRate: number, pulses: number): Float32Array {
  const pulse = Math.round(0.016 * sampleRate);
  const step = Math.round(0.032 * sampleRate);
  const out = new Float32Array(step * pulses);
  for (let p = 0; p < pulses; p++)
    for (let i = 0; i < pulse; i++) {
      const t = i / sampleRate;
      out[p * step + i] =
        Math.sin(2 * Math.PI * frequency * t) * Math.sin((Math.PI * i) / pulse) ** 2;
    }
  return out;
}

/** A water drop in a cave: a falling "plink" and a few fading echoes. */
function drip(sampleRate: number, random: () => number): Float32Array {
  const length = Math.round(0.9 * sampleRate);
  const out = new Float32Array(length);
  const start = 1500 + random() * 900;
  const ring = Math.round(0.12 * sampleRate);
  const dry = new Float32Array(ring);
  let phase = 0;
  for (let i = 0; i < ring; i++) {
    const t = i / sampleRate;
    phase += (2 * Math.PI * start * (0.62 + 0.38 * Math.exp(-t / 0.012))) / sampleRate;
    dry[i] = Math.sin(phase) * Math.exp(-t / 0.035) * Math.min(1, i / 8);
  }
  const echoes = [
    [0, 1],
    [0.13, 0.35],
    [0.29, 0.2],
    [0.47, 0.11],
    [0.68, 0.06],
  ];
  for (const [delay, gain] of echoes) {
    const at = Math.round(delay * sampleRate);
    for (let i = 0; i < ring && at + i < length; i++) out[at + i] += dry[i] * gain;
  }
  return out;
}

/** Amplitude envelope of swells (waves, passing cars, distant thunder) at the given times. */
function swells(
  length: number,
  sampleRate: number,
  times: number[],
  shape: () => { rise: number; fall: number; level: number },
): Float32Array {
  const out = new Float32Array(length);
  for (const time of times) {
    const { rise, fall, level } = shape();
    const start = Math.floor(time * sampleRate);
    const peak = start + Math.round(rise * sampleRate);
    const end = peak + Math.round(fall * 4 * sampleRate);
    for (let i = start; i < Math.min(end, length); i++) {
      const value =
        i < peak
          ? Math.sin(((i - start) / Math.max(1, peak - start)) * (Math.PI / 2)) ** 2
          : Math.exp(-(i - peak) / (fall * sampleRate));
      out[i] += value * level;
    }
  }
  return out;
}

/** Noise shaped by an envelope (one per channel, slightly offset for width). */
function shaped(noise: Float32Array, envelope: Float32Array, floor = 0): Float32Array {
  const out = new Float32Array(noise.length);
  for (let i = 0; i < noise.length; i++) out[i] = noise[i] * (floor + envelope[i]);
  return out;
}

/** Times every `min`–`max` seconds (an irregular but steady pulse: waves, cricket rows). */
function paced(duration: number, min: number, max: number, random: () => number): number[] {
  const times: number[] = [];
  for (let time = random() * min; time < duration; time += min + random() * (max - min))
    times.push(time);
  return times;
}

function ambientLayers(
  id: AmbientBedId,
  length: number,
  sampleRate: number,
  random: () => number,
): Layer[] {
  const seconds = length / sampleRate;
  const stereo = (make: (n: number, r: () => number) => Float32Array) => ({
    left: make(length, random),
    right: make(length, random),
  });
  const events = (
    times: number[],
    write: (at: number, left: Float32Array, right: Float32Array) => void,
  ) => {
    const left = new Float32Array(length);
    const right = new Float32Array(length);
    for (const time of times) write(Math.floor(time * sampleRate), left, right);
    return { left, right };
  };
  switch (id) {
    case 'wind': {
      // Gusts: slow, deep swells of brown and pink noise, and a faint high whistle.
      return [
        {
          ...stereo(brownNoise),
          filters: [{ type: 'lowpass', frequency: 420 }],
          gain: 0.8,
          wobble: { rate: 0.12, depth: 0.75 },
        },
        {
          ...stereo(pinkNoise),
          filters: [{ type: 'bandpass', frequency: 850, Q: 0.7 }],
          gain: 0.55,
          wobble: { rate: 0.17, depth: 0.85 },
        },
        {
          ...stereo(whiteNoise),
          filters: [{ type: 'bandpass', frequency: 1700, Q: 7 }],
          gain: 0.05,
          wobble: { rate: 0.09, depth: 0.95 },
        },
      ];
    }
    case 'sea': {
      // Waves every 6–9 s: a rumble that swells and a foam hiss that trails it.
      const times = paced(seconds, 6, 9, random);
      const wave = () => ({
        rise: 1.6 + random() * 1.2,
        fall: 1.2 + random(),
        level: 0.6 + random() * 0.4,
      });
      const body = swells(length, sampleRate, times, wave);
      const foam = swells(
        length,
        sampleRate,
        times.map((time) => time + 1.2),
        wave,
      );
      return [
        {
          left: shaped(brownNoise(length, random), body, 0.25),
          right: shaped(brownNoise(length, random), body, 0.25),
          filters: [{ type: 'lowpass', frequency: 380 }],
          gain: 0.9,
        },
        {
          left: shaped(pinkNoise(length, random), foam, 0.08),
          right: shaped(pinkNoise(length, random), foam, 0.08),
          filters: [
            { type: 'highpass', frequency: 500 },
            { type: 'lowpass', frequency: 4200 },
          ],
          gain: 0.45,
        },
      ];
    }
    case 'storm': {
      // Heavy rain plus a distant rumble every 10–16 s (low, slow, never a crack).
      const thunder = swells(length, sampleRate, paced(seconds, 10, 16, random), () => ({
        rise: 0.5 + random() * 0.8,
        fall: 0.9 + random() * 1.2,
        level: 0.5 + random() * 0.5,
      }));
      return [
        {
          ...stereo(whiteNoise),
          filters: [
            { type: 'highpass', frequency: 500 },
            { type: 'lowpass', frequency: 6000, Q: 0.5 },
          ],
          gain: 0.3,
          wobble: { rate: 0.2, depth: 0.25 },
        },
        { ...stereo(pinkNoise), filters: [{ type: 'lowpass', frequency: 1500 }], gain: 0.65 },
        {
          left: shaped(brownNoise(length, random), thunder),
          right: shaped(brownNoise(length, random), thunder),
          filters: [{ type: 'lowpass', frequency: 110 }],
          gain: 1.6,
        },
        { ...stereo(brownNoise), filters: [{ type: 'lowpass', frequency: 200 }], gain: 0.4 },
      ];
    }
    case 'forest': {
      // Soft wind in leaves and, rarely, a simple bird call somewhere to the side.
      const birds = events(poissonTimes(seconds, 0.14, random), (at, left, right) =>
        stamp(
          left,
          right,
          at,
          0.05 + random() * 0.07,
          random() * 1.6 - 0.8,
          chirp(sampleRate, random),
        ),
      );
      return [
        {
          ...stereo(pinkNoise),
          filters: [
            { type: 'highpass', frequency: 900 },
            { type: 'lowpass', frequency: 5200 },
          ],
          gain: 0.35,
          wobble: { rate: 0.18, depth: 0.7 },
        },
        { ...stereo(brownNoise), filters: [{ type: 'lowpass', frequency: 260 }], gain: 0.35 },
        { ...birds, filters: [{ type: 'highpass', frequency: 1500 }], gain: 1 },
      ];
    }
    case 'night': {
      // Two or three crickets with their own pitch, pace and place; quiet night air below.
      const crickets = { left: new Float32Array(length), right: new Float32Array(length) };
      const rows = [
        { frequency: 4300, pan: -0.55, min: 0.55, max: 0.75, level: 0.07 },
        { frequency: 4750, pan: 0.5, min: 0.7, max: 1.0, level: 0.05 },
        { frequency: 3900, pan: 0.1, min: 1.1, max: 1.7, level: 0.03 },
      ];
      for (const row of rows)
        for (const time of paced(seconds, row.min, row.max, random))
          stamp(
            crickets.left,
            crickets.right,
            Math.floor(time * sampleRate),
            row.level * (0.7 + random() * 0.3),
            row.pan,
            cricket(row.frequency, sampleRate, 3 + Math.floor(random() * 2)),
          );
      return [
        {
          ...crickets,
          filters: [{ type: 'bandpass', frequency: 4400, Q: 1.2 }],
          gain: 1,
          wobble: { rate: 0.07, depth: 0.4 },
        },
        { ...stereo(pinkNoise), filters: [{ type: 'lowpass', frequency: 900 }], gain: 0.12 },
        { ...stereo(brownNoise), filters: [{ type: 'lowpass', frequency: 180 }], gain: 0.25 },
      ];
    }
    case 'room':
      // Room tone: the soft air of a quiet room, almost nothing.
      return [
        { ...stereo(brownNoise), filters: [{ type: 'lowpass', frequency: 220 }], gain: 0.8 },
        {
          ...stereo(pinkNoise),
          filters: [
            { type: 'highpass', frequency: 120 },
            { type: 'lowpass', frequency: 1200 },
          ],
          gain: 0.1,
          wobble: { rate: 0.05, depth: 0.2 },
        },
      ];
    case 'city': {
      // Distant traffic (cars passing as slow swells) and a far-off murmur.
      const passing = swells(length, sampleRate, poissonTimes(seconds, 0.3, random), () => ({
        rise: 1.5 + random() * 2,
        fall: 0.8 + random() * 1.2,
        level: 0.3 + random() * 0.5,
      }));
      return [
        { ...stereo(brownNoise), filters: [{ type: 'lowpass', frequency: 320 }], gain: 0.7 },
        {
          left: shaped(pinkNoise(length, random), passing, 0.1),
          right: shaped(pinkNoise(length, random), passing, 0.1),
          filters: [
            { type: 'highpass', frequency: 150 },
            { type: 'lowpass', frequency: 1400 },
          ],
          gain: 0.6,
        },
        {
          ...stereo(pinkNoise),
          filters: [{ type: 'bandpass', frequency: 700, Q: 0.9 }],
          gain: 0.12,
          wobble: { rate: 0.4, depth: 0.5 },
        },
      ];
    }
    case 'cave': {
      // Still, cold air and a drop every few seconds with its echoes.
      const drips = events(poissonTimes(seconds, 0.45, random), (at, left, right) =>
        stamp(
          left,
          right,
          at,
          0.04 + random() * 0.06,
          random() * 1.4 - 0.7,
          drip(sampleRate, random),
        ),
      );
      return [
        { ...stereo(brownNoise), filters: [{ type: 'lowpass', frequency: 160 }], gain: 0.8 },
        {
          ...stereo(pinkNoise),
          filters: [{ type: 'bandpass', frequency: 320, Q: 0.8 }],
          gain: 0.1,
          wobble: { rate: 0.06, depth: 0.3 },
        },
        { ...drips, filters: [{ type: 'highpass', frequency: 700 }], gain: 1 },
      ];
    }
  }
}

const BED_SEEDS: Record<BedId, number> = {
  rain: 11,
  brown: 23,
  pink: 37,
  cafe: 41,
  fire: 53,
  wind: 61,
  sea: 67,
  storm: 71,
  forest: 79,
  night: 83,
  room: 89,
  city: 97,
  cave: 101,
};

function layers(id: BedId, length: number, sampleRate: number): Layer[] {
  if (isAmbientBed(id)) return ambientLayers(id, length, sampleRate, mulberry32(BED_SEEDS[id]));
  const seed = BED_SEEDS[id];
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

/** Wobble gain curve at 50 Hz control rate (slow swells need no more). */
function wobbleCurve(layer: Layer, seconds: number, random: () => number): Float32Array | null {
  if (!layer.wobble) return null;
  const points = Math.ceil(seconds * 50);
  const noise = smoothNoise(points, 50, layer.wobble.rate, random);
  const curve = new Float32Array(points);
  for (let i = 0; i < points; i++)
    curve[i] = Math.max(0, layer.gain * (1 + layer.wobble.depth * noise[i]));
  return curve;
}

/** Biquad coefficients exactly as the Web Audio spec defines them (lowpass/highpass Q in dB). */
export function biquadCoefficients(
  type: BiquadFilterType,
  frequency: number,
  Q: number | undefined,
  sampleRate: number,
): [number, number, number, number, number] {
  const w0 = (2 * Math.PI * Math.min(frequency, sampleRate / 2)) / sampleRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const q = Q ?? 1;
  let b0: number, b1: number, b2: number;
  let alpha: number;
  switch (type) {
    case 'lowpass':
      alpha = sin / (2 * 10 ** (q / 20));
      b0 = (1 - cos) / 2;
      b1 = 1 - cos;
      b2 = b0;
      break;
    case 'highpass':
      alpha = sin / (2 * 10 ** (q / 20));
      b0 = (1 + cos) / 2;
      b1 = -(1 + cos);
      b2 = b0;
      break;
    case 'bandpass':
      alpha = sin / (2 * q);
      b0 = alpha;
      b1 = 0;
      b2 = -alpha;
      break;
    default:
      throw new RangeError(`unsupported filter ${type}`);
  }
  const a0 = 1 + alpha;
  return [b0 / a0, b1 / a0, b2 / a0, (-2 * cos) / a0, (1 - alpha) / a0];
}

function biquad(data: Float32Array, coefficients: [number, number, number, number, number]) {
  const [b0, b1, b2, a1, a2] = coefficients;
  let x1 = 0,
    x2 = 0,
    y1 = 0,
    y2 = 0;
  for (let i = 0; i < data.length; i++) {
    const x = data[i];
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    data[i] = y;
  }
}

/** The same graph as the OfflineAudioContext one, computed in plain JS (tests, old browsers). */
export function mixLayers(list: Layer[], length: number, sampleRate: number): Float32Array[] {
  const out = [new Float32Array(length), new Float32Array(length)];
  const random = mulberry32(7);
  for (const layer of list) {
    const curve = wobbleCurve(layer, length / sampleRate, random);
    [layer.left, layer.right].forEach((source, channel) => {
      const data = source.slice(0, length);
      for (const filter of layer.filters)
        biquad(data, biquadCoefficients(filter.type, filter.frequency, filter.Q, sampleRate));
      const target = out[channel];
      if (!curve) {
        for (let i = 0; i < length; i++) target[i] += data[i] * layer.gain;
        return;
      }
      // setValueCurveAtTime interpolates linearly between the points over the duration.
      const last = curve.length - 1;
      for (let i = 0; i < length; i++) {
        const position = (i / length) * last;
        const k = Math.floor(position);
        const g = curve[k] + (curve[Math.min(last, k + 1)] - curve[k]) * (position - k);
        target[i] += data[i] * g;
      }
    });
  }
  return out;
}

async function renderOffline(
  Context: OfflineContextConstructor,
  list: Layer[],
  length: number,
  rate: number,
): Promise<Float32Array[]> {
  const context = new Context(2, length, rate);
  const random = mulberry32(7);
  for (const layer of list) {
    const buffer = context.createBuffer(2, length, rate);
    buffer.copyToChannel(layer.left as Float32Array<ArrayBuffer>, 0);
    buffer.copyToChannel(layer.right as Float32Array<ArrayBuffer>, 1);
    const source = context.createBufferSource();
    source.buffer = buffer;
    let node: AudioNode = source;
    for (const filter of layer.filters) {
      const biquadNode = context.createBiquadFilter();
      biquadNode.type = filter.type;
      biquadNode.frequency.value = filter.frequency;
      if (filter.Q !== undefined) biquadNode.Q.value = filter.Q;
      node.connect(biquadNode);
      node = biquadNode;
    }
    const gain = context.createGain();
    gain.gain.value = layer.gain;
    const curve = wobbleCurve(layer, length / rate, random);
    if (curve) gain.gain.setValueCurveAtTime(curve, 0, length / rate);
    node.connect(gain);
    gain.connect(context.destination);
    source.start(0);
  }
  const rendered = await context.startRendering();
  return [0, 1].map((channel) => rendered.getChannelData(channel));
}

/**
 * One bed as a seamless, loudness-normalized stereo loop (`LOOP_SECONDS` long).
 * Uses an OfflineAudioContext when there is one, else the identical JS graph.
 */
export async function renderBedChannels(
  id: BedId,
  options: { offline?: boolean } = {},
): Promise<Float32Array[]> {
  const Context = ((globalThis as { OfflineAudioContext?: OfflineContextConstructor })
    .OfflineAudioContext ??
    (globalThis as { webkitOfflineAudioContext?: OfflineContextConstructor })
      .webkitOfflineAudioContext) as OfflineContextConstructor | undefined;
  const rate = SOUNDSCAPE_RATE;
  const preroll = PREROLL_SECONDS * rate;
  const loop = LOOP_SECONDS * rate;
  const fade = FADE_SECONDS * rate;
  const length = preroll + loop + fade;
  const list = layers(id, length, rate);
  const useOffline = options.offline ?? true;
  if (useOffline && !Context && !isAmbientBed(id))
    throw new Error('OfflineAudioContext unavailable');
  const mixed =
    useOffline && Context
      ? await renderOffline(Context, list, length, rate)
      : mixLayers(list, length, rate);
  const channels = mixed.map((channel) => loopCrossfade(channel.subarray(preroll), loop, fade));
  if (isAmbientBed(id)) normalizeLoudness(channels, AMBIENT_RMS, AMBIENT_PEAK);
  else normalizeLoudness(channels, MANUAL_RMS);
  return channels;
}

/** Render one bed into a seamless stereo loop, as WAV bytes. */
export async function renderSoundscape(id: BedId): Promise<ArrayBuffer> {
  return encodeWav(await renderBedChannels(id), SOUNDSCAPE_RATE);
}
