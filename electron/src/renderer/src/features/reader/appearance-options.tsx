import type { CSSProperties, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BookOpenIcon,
  CheckIcon,
  Columns2Icon,
  ScrollTextIcon,
  type LucideIcon,
} from 'lucide-react';
import { useTheme } from '@/hooks/use-theme';
import {
  BACKGROUNDS,
  FONTS,
  HIGHLIGHT_COLORS,
  HIGHLIGHTS,
  LAYOUTS,
  resolveSurface,
  setReaderAppearance,
  SURFACES,
  useReaderAppearance,
  type ReaderBackground,
  type ReaderFont,
  type ReaderHighlight,
  type ReaderLayout,
  type ReaderSurface,
} from './reader-appearance';
import { SheetRow } from './reader-sheet';

const LAYOUT_OPTIONS: Record<ReaderLayout, { label: string; icon: LucideIcon }> = {
  scroll: { label: 'reader.layout_scroll', icon: ScrollTextIcon },
  pages: { label: 'reader.layout_pages', icon: BookOpenIcon },
};
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

export function SheetSection({
  id,
  title,
  aside,
  children,
}: {
  id: string;
  title: string;
  /** Right side of the heading (a current value). */
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id}>
      <div className="mb-2 flex items-baseline justify-between gap-2 px-1">
        <h3 id={id} className="rd-sheet-heading">
          {title}
        </h3>
        {aside}
      </div>
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

/** A miniature paragraph showing a highlight theme: grey lines, the sentence box, the word. */
function HighlightSample({
  highlight,
  surface,
}: {
  highlight: ReaderHighlight;
  surface: ReaderSurface;
}) {
  const colors = HIGHLIGHT_COLORS[highlight][surface];
  const tokens = SURFACES[surface];
  return (
    <span
      className="rd-hl-sample"
      style={
        {
          '--hl-bg': tokens.background,
          '--hl-ink': tokens.foreground,
          '--hl-sentence': colors.sentence,
          '--hl-word': colors.word,
        } as CSSProperties
      }
      aria-hidden="true"
    >
      <i style={{ width: '82%' }} />
      <b>
        <i />
        <u />
        <i />
      </b>
      <b>
        <i />
      </b>
    </span>
  );
}

/** Layout, background, font and highlight pickers for the "Aa" sheet. */
export function AppearanceOptions() {
  const { t } = useTranslation();
  const appearance = useReaderAppearance();
  const { theme } = useTheme();
  const surface = resolveSurface(appearance.background, theme);
  return (
    <>
      <SheetSection id="reader-layout" title={t('reader.layout')}>
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-labelledby="reader-layout">
          {LAYOUTS.map((layout) => {
            const { label, icon: Icon } = LAYOUT_OPTIONS[layout];
            return (
              <button
                key={layout}
                type="button"
                role="radio"
                aria-checked={appearance.layout === layout}
                data-active={appearance.layout === layout}
                className="rd-chip w-full"
                onClick={() => setReaderAppearance({ layout })}
              >
                <Icon className="size-4" aria-hidden="true" />
                <span className="truncate">{t(label)}</span>
              </button>
            );
          })}
        </div>
        {appearance.layout === 'pages' && (
          <>
            <p className="mt-2 px-1 text-xs leading-relaxed text-muted-foreground">
              {t('reader.layout_pages_hint')}
            </p>
            <div className="-mx-1 mt-2">
              <SheetRow
                icon={Columns2Icon}
                label={t('reader.layout_spread')}
                detail={t('reader.layout_spread_hint')}
                role="switch"
                aria-checked={appearance.spread}
                checked={appearance.spread}
                onClick={() => setReaderAppearance({ spread: !appearance.spread })}
              />
            </div>
          </>
        )}
      </SheetSection>
      <SheetSection id="reader-background" title={t('reader.background')}>
        <div className="flex justify-between gap-2 px-1" role="radiogroup">
          {BACKGROUNDS.map((background) => {
            const selected = appearance.background === background;
            const tokens = background === 'system' ? null : SURFACES[background];
            return (
              <button
                key={background}
                type="button"
                role="radio"
                aria-checked={selected}
                className="rd-bg-option"
                onClick={() => setReaderAppearance({ background })}
              >
                <span
                  className="rd-bg-swatch"
                  style={
                    tokens
                      ? { background: tokens.background, color: tokens.foreground }
                      : {
                          background: `linear-gradient(135deg, ${SURFACES.light.background} 50%, ${SURFACES.dark.background} 50%)`,
                          color: SURFACES.dark.foreground,
                        }
                  }
                  aria-hidden="true"
                >
                  {selected && <CheckIcon className="size-4" strokeWidth={2.6} />}
                </span>
                <span className="max-w-full truncate">{t(BACKGROUND_LABELS[background])}</span>
              </button>
            );
          })}
        </div>
      </SheetSection>
      <SheetSection id="reader-font" title={t('reader.font')}>
        <div className="-mx-1 space-y-0.5" role="radiogroup">
          {FONTS.map((font) => (
            <button
              key={font}
              type="button"
              role="radio"
              aria-checked={appearance.font === font}
              className="rd-sheet-row"
              onClick={() => setReaderAppearance({ font })}
            >
              <span
                className="min-w-0 flex-1 truncate text-[1.0625rem]"
                style={{ fontFamily: FONT_FAMILIES[font] }}
              >
                {t(FONT_LABELS[font])}
              </span>
              {appearance.font === font && (
                <CheckIcon className="size-5 shrink-0 text-primary" aria-hidden="true" />
              )}
            </button>
          ))}
        </div>
      </SheetSection>
      <SheetSection id="reader-highlight" title={t('reader.highlight')}>
        <div className="grid grid-cols-2 gap-2" role="radiogroup">
          {HIGHLIGHTS.map((highlight) => (
            <button
              key={highlight}
              type="button"
              role="radio"
              aria-checked={appearance.highlight === highlight}
              className="rd-hl-card"
              onClick={() => setReaderAppearance({ highlight })}
            >
              <HighlightSample highlight={highlight} surface={surface} />
              <span className="flex items-center justify-between gap-1">
                <span className="truncate">{t(HIGHLIGHT_LABELS[highlight])}</span>
                {appearance.highlight === highlight && (
                  <CheckIcon className="size-4 shrink-0 text-primary" aria-hidden="true" />
                )}
              </span>
            </button>
          ))}
        </div>
      </SheetSection>
    </>
  );
}
