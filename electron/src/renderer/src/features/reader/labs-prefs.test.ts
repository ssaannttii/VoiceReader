import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_LABS,
  HIGH_QUALITY_STEPS,
  labsPrefs,
  qualitySteps,
  sanitizeLabs,
  setLabsPrefs,
  withLabsQuality,
} from './labs-prefs';

describe('sanitizeLabs', () => {
  it('fills defaults and rejects unknown values', () => {
    expect(sanitizeLabs(undefined)).toEqual(DEFAULT_LABS);
    expect(sanitizeLabs({ voiceQuality: 'ultra', blind: 'yes' })).toEqual(DEFAULT_LABS);
    expect(sanitizeLabs({ voiceQuality: 'high', blind: false })).toEqual({
      voiceQuality: 'high',
      blind: false,
      music: false,
    });
    // Background music is off unless switched on explicitly.
    expect(sanitizeLabs({ music: 'yes' }).music).toBe(false);
    expect(sanitizeLabs({ music: true }).music).toBe(true);
  });
});

describe('quality steps', () => {
  afterEach(() => setLabsPrefs(DEFAULT_LABS));

  it('normal leaves the render request untouched (same cache keys)', () => {
    expect(qualitySteps('normal')).toBeUndefined();
    const choice = { voice: 'v', engine: null, language: 'es' };
    expect(withLabsQuality(choice)).toBe(choice);
    expect(JSON.stringify(withLabsQuality(choice))).not.toContain('num_step');
  });

  it('high asks for 32 sampling steps', () => {
    setLabsPrefs({ voiceQuality: 'high' });
    expect(labsPrefs().voiceQuality).toBe('high');
    expect(withLabsQuality({ voice: 'v' })).toEqual({ voice: 'v', num_step: HIGH_QUALITY_STEPS });
    expect(HIGH_QUALITY_STEPS).toBe(32);
  });
});
