import { describe, expect, it } from 'vitest';
import {
  approach,
  flowSpeed,
  noise1,
  orbOutline,
  pulseEnvelope,
  settled,
  targetEnergy,
  wordSeconds,
  wordStrength,
  wordsPerSecond,
} from './orb-math';

const word = (w: string, start: number, end: number) => ({ w, start, end, c0: 0, c1: w.length });

describe('word pulses', () => {
  it('longer words pulse harder, within bounds', () => {
    expect(wordStrength(word('a', 0, 0.1))).toBeLessThan(wordStrength(word('extraordinary', 0, 1)));
    expect(wordStrength(word('incomprehensibilities', 0, 1))).toBe(1);
    expect(wordStrength(word('—', 0, 0.1))).toBe(0.3);
    expect(wordStrength(null)).toBe(0.3);
  });

  it('a word lasts less at higher speed', () => {
    expect(wordSeconds(word('hola', 1, 1.4), 1)).toBeCloseTo(0.4);
    expect(wordSeconds(word('hola', 1, 1.4), 2)).toBeCloseTo(0.2);
    expect(wordSeconds(word('x', 1, 1), 1)).toBe(0.05);
  });

  it('rises quickly, then decays over about the word length', () => {
    const seconds = 0.4;
    expect(pulseEnvelope(-0.1, seconds)).toBe(0);
    expect(pulseEnvelope(0, seconds)).toBe(0);
    expect(pulseEnvelope(0.04, seconds)).toBeCloseTo(0.5);
    expect(pulseEnvelope(0.08, seconds)).toBeCloseTo(1);
    const later = pulseEnvelope(0.5, seconds);
    expect(later).toBeLessThan(0.4);
    expect(pulseEnvelope(1.5, seconds)).toBeLessThan(later);
  });
});

describe('pace', () => {
  it('measures words per second at the playback rate', () => {
    const words = [word('uno', 0, 0.3), word('dos', 0.4, 0.7), word('tres', 0.8, 1)];
    expect(wordsPerSecond(words, 1)).toBeCloseTo(3);
    expect(wordsPerSecond(words, 2)).toBeCloseTo(6);
    expect(wordsPerSecond([], 1)).toBe(2.5);
    expect(wordsPerSecond([word('a', 1, 1), word('b', 1, 1)], 1)).toBe(2.5);
  });

  it('keeps the flow calm at any pace', () => {
    expect(flowSpeed(2.5)).toBe(1);
    expect(flowSpeed(0)).toBe(0.35);
    expect(flowSpeed(50)).toBe(1.6);
  });
});

describe('smoothing and settling', () => {
  it('approaches the target independently of the frame rate', () => {
    // One 100 ms step equals ten 10 ms steps.
    let stepped = 0;
    for (let i = 0; i < 10; i++) stepped = approach(stepped, 1, 0.01, 0.2);
    expect(approach(0, 1, 0.1, 0.2)).toBeCloseTo(stepped, 10);
    expect(approach(0.3, 1, 0, 0.2)).toBeCloseTo(0.3, 12);
    expect(approach(0.3, 1, 0.1, 0)).toBe(1);
  });

  it('is silent when paused and settles there', () => {
    expect(targetEnergy(false, 1, 1)).toBe(0);
    expect(targetEnergy(true, 0.5, 0.8)).toBeCloseTo(0.4);
    expect(targetEnergy(true, 2, 1)).toBe(1);
    let energy = 1;
    let calm = 1;
    let frames = 0;
    while (!settled(false, energy, calm, 0.15) && frames < 1000) {
      energy = approach(energy, targetEnergy(false, 1, 1), 1 / 60, 0.09);
      calm = approach(calm, 0.15, 1 / 60, 0.8);
      frames++;
    }
    // Within a few seconds the orb stops (and the canvas stops drawing).
    expect(frames).toBeLessThan(60 * 6);
    expect(settled(true, 0, 0.15, 0.15)).toBe(false);
  });

  it('outline stays near a circle and swells with energy', () => {
    const radii = (energy: number, calm: number) =>
      Array.from({ length: 64 }, (_, i) => orbOutline((i / 64) * Math.PI * 2, 1.3, energy, calm));
    const still = radii(0, 0);
    expect(Math.max(...still) - Math.min(...still)).toBeLessThan(1e-9);
    const speaking = radii(1, 1);
    expect(Math.min(...speaking)).toBeGreaterThan(0.85);
    expect(Math.max(...speaking)).toBeLessThan(1.35);
    expect(speaking.reduce((a, b) => a + b) / 64).toBeGreaterThan(1.1);
  });

  it('noise is smooth and bounded', () => {
    for (let x = 0; x < 20; x += 0.05) {
      expect(Math.abs(noise1(x))).toBeLessThanOrEqual(1);
      expect(Math.abs(noise1(x + 0.01) - noise1(x))).toBeLessThan(0.1);
    }
    expect(noise1(3.7, 1)).toBe(noise1(3.7, 1));
  });
});
