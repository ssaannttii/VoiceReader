import { describe, expect, it } from 'vitest';
import {
  appearanceVars,
  DEFAULT_APPEARANCE,
  HIGHLIGHT_COLORS,
  HIGHLIGHTS,
  parseAppearance,
  resolveSurface,
  SURFACES,
  type ReaderSurface,
} from './reader-appearance';

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const channel = parseInt(hex.slice(i, i + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const surfaces = Object.keys(SURFACES) as ReaderSurface[];

describe('parseAppearance', () => {
  it('keeps valid values and replaces unknown ones', () => {
    expect(parseAppearance({ highlight: 'blue', font: 'dyslexic', background: 'paper' })).toEqual({
      highlight: 'blue',
      font: 'dyslexic',
      background: 'paper',
    });
    expect(parseAppearance({ highlight: 'pink', font: 3 })).toEqual(DEFAULT_APPEARANCE);
    expect(parseAppearance(null)).toEqual(DEFAULT_APPEARANCE);
  });
});

describe('resolveSurface', () => {
  it('follows the app theme only for system', () => {
    expect(resolveSurface('system', 'dark')).toBe('dark');
    expect(resolveSurface('paper', 'dark')).toBe('paper');
    expect(resolveSurface('light', 'dark')).toBe('light');
  });
});

describe('contrast (WCAG AA, 4.5:1)', () => {
  it.each(surfaces)('%s surface: body and secondary text', (surface) => {
    const tokens = SURFACES[surface];
    expect(contrast(tokens.foreground, tokens.background)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens.muted, tokens.background)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens.muted, tokens.popover)).toBeGreaterThanOrEqual(4.5);
  });

  for (const highlight of HIGHLIGHTS)
    it.each(surfaces)(`${highlight} highlight on %s`, (surface) => {
      const colors = HIGHLIGHT_COLORS[highlight][surface];
      const text = SURFACES[surface].foreground;
      expect(contrast(text, colors.sentence)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colors.wordText, colors.word)).toBeGreaterThanOrEqual(4.5);
    });
});

describe('yellow highlight', () => {
  it('keeps the sentence box neutral so only the word carries the colour', () => {
    for (const surface of ['light', 'dark'] as const) {
      const hex = HIGHLIGHT_COLORS.yellow[surface].sentence;
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
      expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThanOrEqual(2);
    }
  });
});

describe('appearanceVars', () => {
  it('sets highlight and font variables, and surface tokens only when forced', () => {
    const system = appearanceVars(DEFAULT_APPEARANCE, 'dark');
    expect(system['--rd-word']).toBe(HIGHLIGHT_COLORS.classic.dark.word);
    expect(system['--background']).toBeUndefined();
    const paper = appearanceVars({ ...DEFAULT_APPEARANCE, background: 'paper' }, 'dark');
    expect(paper['--background']).toBe(SURFACES.paper.background);
    expect(paper['--rd-word']).toBe(HIGHLIGHT_COLORS.classic.paper.word);
    expect(paper['color-scheme']).toBe('light');
    const dyslexic = appearanceVars({ ...DEFAULT_APPEARANCE, font: 'dyslexic' }, 'light');
    expect(dyslexic['--rd-reading-font']).toContain('OpenDyslexic');
  });
});
