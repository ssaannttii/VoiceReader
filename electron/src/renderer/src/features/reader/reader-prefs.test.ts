import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFS, sanitizePrefs } from './reader-prefs';

describe('sanitizePrefs', () => {
  it('fills defaults for missing or old stored preferences', () => {
    expect(sanitizePrefs(undefined)).toEqual(DEFAULT_PREFS);
    expect(sanitizePrefs({ rate: 1.5, textSize: 22 })).toEqual({
      ...DEFAULT_PREFS,
      rate: 1.5,
      textSize: 22,
    });
  });

  it('keeps valid control settings', () => {
    expect(sanitizePrefs({ skipSeconds: 30, trackAction: 'chapter', doubleTap: true })).toEqual({
      ...DEFAULT_PREFS,
      skipSeconds: 30,
      trackAction: 'chapter',
      doubleTap: true,
    });
  });

  it('rejects values outside the offered options', () => {
    expect(
      sanitizePrefs({
        rate: 9,
        textSize: 2,
        skipSeconds: 20,
        trackAction: 'page',
        doubleTap: 'yes',
      }),
    ).toEqual({ ...DEFAULT_PREFS, rate: 3, textSize: 15 });
  });
});
