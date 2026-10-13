import { describe, expect, it } from 'vitest';
import { DEFAULT_LISTENING, sanitizeListening } from './listening-prefs';

describe('sanitizeListening', () => {
  it('fills defaults for missing preferences', () => {
    expect(sanitizeListening(undefined)).toEqual(DEFAULT_LISTENING);
    expect(sanitizeListening({ soundscape: 'rain' })).toEqual({
      ...DEFAULT_LISTENING,
      soundscape: 'rain',
    });
  });

  it('rejects unknown sounds and clamps the volume', () => {
    expect(
      sanitizeListening({
        soundscape: 'thunder',
        soundscapeVolume: 140.4,
        soundscapeWithVoice: 'no',
        audioOnly: 1,
      }),
    ).toEqual({ ...DEFAULT_LISTENING, soundscapeVolume: 100 });
    expect(sanitizeListening({ soundscapeVolume: -5 }).soundscapeVolume).toBe(0);
    expect(sanitizeListening({ soundscapeVolume: Number.NaN }).soundscapeVolume).toBe(
      DEFAULT_LISTENING.soundscapeVolume,
    );
  });

  it('accepts Automático', () => {
    expect(sanitizeListening({ soundscape: 'auto' }).soundscape).toBe('auto');
    expect(sanitizeListening({ soundscape: 'automatic' }).soundscape).toBe('off');
  });

  it('keeps valid choices', () => {
    expect(
      sanitizeListening({
        soundscape: 'fire',
        soundscapeVolume: 62,
        soundscapeWithVoice: false,
        audioOnly: true,
      }),
    ).toEqual({
      soundscape: 'fire',
      soundscapeVolume: 62,
      soundscapeWithVoice: false,
      audioOnly: true,
    });
  });
});
