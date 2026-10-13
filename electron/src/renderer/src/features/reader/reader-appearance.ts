/**
 * Reading appearance (highlight colours, font, background), per device in
 * localStorage. Applied as CSS variables on every Reader surface (`.rd-root`
 * and its portaled sheets), so the studio keeps the app theme.
 */
import { useSyncExternalStore, type CSSProperties } from 'react';
import { useTheme } from '@/hooks/use-theme';

export const HIGHLIGHTS = ['classic', 'amber', 'yellow', 'blue'] as const;
export const FONTS = ['serif', 'sans', 'dyslexic'] as const;
export const BACKGROUNDS = ['system', 'light', 'dark', 'paper'] as const;

export type ReaderHighlight = (typeof HIGHLIGHTS)[number];
export type ReaderFont = (typeof FONTS)[number];
export type ReaderBackground = (typeof BACKGROUNDS)[number];
/** The palette a page is painted with once `system` is resolved. */
export type ReaderSurface = 'light' | 'dark' | 'paper';

export interface ReaderAppearance {
  highlight: ReaderHighlight;
  font: ReaderFont;
  background: ReaderBackground;
}

export const DEFAULT_APPEARANCE: ReaderAppearance = {
  highlight: 'classic',
  font: 'serif',
  background: 'system',
};

const KEY = 'voicestudio.reader.appearance';

const pick = <T extends string>(options: readonly T[], value: unknown, fallback: T): T =>
  options.includes(value as T) ? (value as T) : fallback;

/** Validate stored preferences; unknown or missing values fall back to the defaults. */
export function parseAppearance(raw: unknown): ReaderAppearance {
  const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    highlight: pick(HIGHLIGHTS, value.highlight, DEFAULT_APPEARANCE.highlight),
    font: pick(FONTS, value.font, DEFAULT_APPEARANCE.font),
    background: pick(BACKGROUNDS, value.background, DEFAULT_APPEARANCE.background),
  };
}

export function resolveSurface(
  background: ReaderBackground,
  appTheme: 'light' | 'dark',
): ReaderSurface {
  return background === 'system' ? appTheme : background;
}

export interface SurfaceTokens {
  background: string;
  foreground: string;
  card: string;
  popover: string;
  muted: string;
  border: string;
  input: string;
}

/**
 * Forced Reader backgrounds. `system` keeps the app palette; these mirror the
 * default light/dark palettes so the Reader looks the same either way.
 */
export const SURFACES: Record<ReaderSurface, SurfaceTokens> = {
  light: {
    background: '#fcfcfc',
    foreground: '#27272a',
    card: '#ffffff',
    popover: '#ffffff',
    muted: '#68686f',
    border: '#e4e4e7',
    input: '#d4d4d8',
  },
  dark: {
    background: '#0a0a0a',
    foreground: '#f5f5f5',
    card: '#121212',
    popover: '#141414',
    muted: '#a3a3a3',
    border: '#262626',
    input: '#303030',
  },
  paper: {
    background: '#f5eddc',
    foreground: '#3a2e21',
    card: '#fbf6eb',
    popover: '#fbf6eb',
    muted: '#6e5d47',
    border: '#e2d5bd',
    input: '#d3c3a6',
  },
};

export interface HighlightColors {
  /** Background of the sentence being read. */
  sentence: string;
  /** Background of the word being read. */
  word: string;
  /** Text colour on the word highlight. */
  wordText: string;
}

/** Solid colours so text contrast is predictable (AA, checked in tests) on every surface. */
export const HIGHLIGHT_COLORS: Record<ReaderHighlight, Record<ReaderSurface, HighlightColors>> = {
  classic: {
    light: { sentence: '#e3f3e7', word: '#ade0bc', wordText: '#18181b' },
    dark: { sentence: '#132a1c', word: '#22633a', wordText: '#ffffff' },
    paper: { sentence: '#e4e9cf', word: '#b9d6a6', wordText: '#2b2118' },
  },
  amber: {
    light: { sentence: '#fdefd6', word: '#f8c97a', wordText: '#18181b' },
    dark: { sentence: '#2d2210', word: '#7c4d0b', wordText: '#ffffff' },
    paper: { sentence: '#f2ddb6', word: '#eab86a', wordText: '#2b2118' },
  },
  yellow: {
    light: { sentence: '#fdf7c3', word: '#fde047', wordText: '#18181b' },
    dark: { sentence: '#29270f', word: '#e9c84a', wordText: '#141414' },
    paper: { sentence: '#f4e8a6', word: '#f1d34f', wordText: '#2b2118' },
  },
  blue: {
    light: { sentence: '#e2ecfc', word: '#b4cff9', wordText: '#18181b' },
    dark: { sentence: '#13223a', word: '#2c5590', wordText: '#ffffff' },
    paper: { sentence: '#e0e3e2', word: '#b8cde2', wordText: '#2b2118' },
  },
};

const FONT_STACKS: Record<ReaderFont, { family: string; scale: number; leading: number }> = {
  serif: { family: 'var(--rd-serif)', scale: 1, leading: 1.68 },
  sans: {
    family:
      "'Inter Variable', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
    scale: 0.96,
    leading: 1.66,
  },
  // OpenDyslexic runs wide and tall: a smaller size keeps the line length close.
  dyslexic: {
    family: "'OpenDyslexic', 'Inter Variable', system-ui, sans-serif",
    scale: 0.88,
    leading: 1.8,
  },
};

/** CSS variables (and data attributes) for a Reader surface. */
export function appearanceVars(
  appearance: ReaderAppearance,
  appTheme: 'light' | 'dark',
): Record<string, string> {
  const surface = resolveSurface(appearance.background, appTheme);
  const colors = HIGHLIGHT_COLORS[appearance.highlight][surface];
  const font = FONT_STACKS[appearance.font];
  const vars: Record<string, string> = {
    '--rd-sentence': colors.sentence,
    '--rd-word': colors.word,
    '--rd-word-text': colors.wordText,
    '--rd-reading-font': font.family,
    '--rd-font-scale': String(font.scale),
    '--rd-leading': String(font.leading),
  };
  if (appearance.background !== 'system') {
    const tokens = SURFACES[surface];
    Object.assign(vars, {
      '--background': tokens.background,
      '--foreground': tokens.foreground,
      '--card': tokens.card,
      '--card-foreground': tokens.foreground,
      '--popover': tokens.popover,
      '--popover-foreground': tokens.foreground,
      '--muted-foreground': tokens.muted,
      '--border': tokens.border,
      '--input': tokens.input,
      'color-scheme': surface === 'dark' ? 'dark' : 'light',
    });
  }
  return vars;
}

function read(): ReaderAppearance {
  try {
    return parseAppearance(JSON.parse(localStorage.getItem(KEY) ?? '{}'));
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

let current = read();
const listeners = new Set<() => void>();
let dyslexicFont: Promise<unknown> | null = null;

/** OpenDyslexic is only downloaded once someone picks it. */
function loadFont(font: ReaderFont) {
  if (font !== 'dyslexic' || dyslexicFont) return;
  dyslexicFont = Promise.all([
    import('@fontsource/opendyslexic/400.css'),
    import('@fontsource/opendyslexic/700.css'),
  ]).catch(() => {
    dyslexicFont = null;
  });
}
loadFont(current.font);

export function readerAppearance(): ReaderAppearance {
  return current;
}

export function setReaderAppearance(patch: Partial<ReaderAppearance>): void {
  current = parseAppearance({ ...current, ...patch });
  loadFont(current.font);
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* Kept for this session. */
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useReaderAppearance(): ReaderAppearance {
  return useSyncExternalStore(subscribe, readerAppearance, readerAppearance);
}

/** Props for a Reader surface: inline variables plus `data-rd-surface` for CSS. */
export function useAppearanceProps(): { style: CSSProperties; 'data-rd-surface': ReaderSurface } {
  const appearance = useReaderAppearance();
  const { theme } = useTheme();
  return {
    style: appearanceVars(appearance, theme) as CSSProperties,
    'data-rd-surface': resolveSurface(appearance.background, theme),
  };
}
