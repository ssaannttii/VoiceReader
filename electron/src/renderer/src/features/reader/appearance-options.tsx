import type { CSSProperties, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@/hooks/use-theme';
import {
  BACKGROUNDS,
  FONTS,
  HIGHLIGHT_COLORS,
  HIGHLIGHTS,
  resolveSurface,
  setReaderAppearance,
  SURFACES,
  useReaderAppearance,
  type ReaderBackground,
  type ReaderFont,
  type ReaderHighlight,
} from './reader-appearance';

const HIGHLIGHT_LABELS: Record<ReaderHighlight, string> = {
  classic: 'reader.highlight_classic',
  amber: 'reader.highlight_amber',
  yellow: 'reader.highlight_yellow',
  blue: 'reader.highlight_blue',
};
const FONT_LABELS: Record<ReaderFont, string> = {
  serif: 'reader.font_serif',
  sans: 'reader.font_sans',
  dyslexic: 'reader.font_dyslexic',
};
const FONT_FAMILIES: Record<ReaderFont, string> = {
  serif: 'var(--rd-serif)',
  sans: "'Inter Variable', system-ui, sans-serif",
  dyslexic: "'OpenDyslexic', 'Inter Variable', system-ui, sans-serif",
};
const BACKGROUND_LABELS: Record<ReaderBackground, string> = {
  system: 'reader.theme_system',
  light: 'reader.theme_light',
  dark: 'reader.theme_dark',
  paper: 'reader.background_paper',
};

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id}>
      <h3
        id={id}
        className="mb-2 px-1 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground"
      >
        {title}
      </h3>
      {children}
    </section>
  );
}

/**
 * A sample sentence painted exactly like the reading view: current sentence
 * and current word highlighted, in the chosen font, size and background.
 */
export function AppearancePreview({ textSize }: { textSize: number }) {
  const { t } = useTranslation();
  const sentence = t('reader.appearance_preview');
  const words = sentence.split(' ');
  // Highlight the third word; scripts without spaces get their first characters.
  let before = '';
  let word: string;
  let after = '';
  if (words.length >= 3) {
    before = `${words.slice(0, 2).join(' ')} `;
    word = words[2];
    after = ` ${words.slice(3).join(' ')}`;
  } else {
    const chars = Array.from(sentence);
    word = chars.slice(0, 2).join('');
    after = chars.slice(2).join('');
  }
  return (
    <div className="rd-preview" aria-hidden="true">
      <div
        className="rd-article"
        style={{ '--rd-text-size': `${Math.min(textSize, 24)}px` } as CSSProperties}
      >
        <p>
          <span className="rd-sent" data-active="true">
            {before}
            <span className="rd-word" data-active="true">
              {word}
            </span>
            {after}
          </span>
        </p>
      </div>
    </div>
  );
}

/** Highlight colour, font and background pickers for the reader options sheet. */
export function AppearanceOptions() {
  const { t } = useTranslation();
  const appearance = useReaderAppearance();
  const { theme } = useTheme();
  const surface = resolveSurface(appearance.background, theme);
  return (
    <>
      <Section id="reader-highlight" title={t('reader.highlight')}>
        <div className="grid grid-cols-4 gap-2">
          {HIGHLIGHTS.map((highlight) => {
            const colors = HIGHLIGHT_COLORS[highlight][surface];
            return (
              <button
                key={highlight}
                type="button"
                className="rd-swatch-btn"
                aria-pressed={appearance.highlight === highlight}
                onClick={() => setReaderAppearance({ highlight })}
              >
                <span
                  className="rd-swatch font-semibold"
                  style={{ background: colors.word, color: colors.wordText }}
                  aria-hidden="true"
                >
                  Aa
                </span>
                <span>{t(HIGHLIGHT_LABELS[highlight])}</span>
              </button>
            );
          })}
        </div>
      </Section>
      <Section id="reader-font" title={t('reader.font')}>
        <div className="grid grid-cols-3 gap-2">
          {FONTS.map((font) => (
            <button
              key={font}
              type="button"
              className="rd-swatch-btn"
              aria-pressed={appearance.font === font}
              onClick={() => setReaderAppearance({ font })}
            >
              <span
                className="text-xl leading-none"
                style={{ fontFamily: FONT_FAMILIES[font] }}
                aria-hidden="true"
              >
                Aa
              </span>
              <span>{t(FONT_LABELS[font])}</span>
            </button>
          ))}
        </div>
      </Section>
      <Section id="reader-background" title={t('reader.background')}>
        <div className="grid grid-cols-4 gap-2">
          {BACKGROUNDS.map((background) => (
            <button
              key={background}
              type="button"
              className="rd-swatch-btn"
              aria-pressed={appearance.background === background}
              onClick={() => setReaderAppearance({ background })}
            >
              <span
                className="rd-swatch font-[family-name:var(--rd-serif)]"
                style={
                  background === 'system'
                    ? {
                        background: `linear-gradient(135deg, ${SURFACES.light.background} 50%, ${SURFACES.dark.background} 50%)`,
                      }
                    : {
                        background: SURFACES[background].background,
                        color: SURFACES[background].foreground,
                      }
                }
                aria-hidden="true"
              >
                {background === 'system' ? '' : 'Aa'}
              </span>
              <span>{t(BACKGROUND_LABELS[background])}</span>
            </button>
          ))}
        </div>
      </Section>
    </>
  );
}
