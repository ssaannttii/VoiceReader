import { describe, expect, it } from 'vitest';
import { autoHideDefault, autoHideOn, DEFAULT_PREFS, sanitizePrefs } from './reader-prefs';

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
        autoHide: 'sometimes',
      }),
    ).toEqual({ ...DEFAULT_PREFS, rate: 3, textSize: 15 });
  });
});

describe('auto-hide controls', () => {
  it('keeps an explicit choice and follows the device otherwise', () => {
    expect(sanitizePrefs({ autoHide: false }).autoHide).toBe(false);
    expect(sanitizePrefs({}).autoHide).toBeNull();
    expect(autoHideOn({ ...DEFAULT_PREFS, autoHide: true })).toBe(true);
    expect(autoHideOn({ ...DEFAULT_PREFS, autoHide: false })).toBe(false);
  });

  it('defaults on for phones and tablets, off for a desktop', () => {
    expect(autoHideDefault(true, 1280)).toBe(true);
    expect(autoHideDefault(false, 412)).toBe(true);
    expect(autoHideDefault(false, 1280)).toBe(false);
  });
});
