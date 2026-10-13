import '@fontsource-variable/source-serif-4';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import {
  ArrowDownToLineIcon,
  BookmarkIcon,
  ChevronLeftIcon,
  CloudOffIcon,
  EllipsisIcon,
  MonitorIcon,
  MoonIcon,
  SunIcon,
  UserRoundIcon,
} from 'lucide-react';
import { describeError } from '@/lib/api/client';
import { useTheme } from '@/hooks/use-theme';
import { cn } from '@/lib/utils';
import { DebugHud, DiagnosticsRows } from './debug-hud';
import { OfflineRow } from './document-actions-sheet';
import { PlayerDock, type DockSheet } from './player-dock';
import { ChaptersSheet, FOLLOW_EVENT, SleepSheet, SpeedSheet, VoiceSheet } from './player-sheets';
import type { ReaderDocument } from './reader-api';
import { titlebarChrome } from './reader-chrome';
import { readerPlayer, useReaderPlayer } from './reader-player';
import { setReaderPrefs, TEXT_SIZE_MAX, TEXT_SIZE_MIN, useReaderPrefs } from './reader-prefs';
import { ReaderSheet, SheetRow } from './reader-sheet';
import { ReaderTextView } from './reader-text-view';
import { minutesLeft } from './reader-text';
import { useReaderDocument } from './use-reader-data';
import './reader.css';

type Sheet = DockSheet | 'options' | 'chapters' | null;

function OptionsSheet({
  doc,
  open,
  onOpenChange,
  onSheet,
}: {
  doc: ReaderDocument;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSheet: (sheet: Sheet) => void;
}) {
  const { t } = useTranslation();
  const prefs = useReaderPrefs();
  const theme = useTheme();
  const fill = ((prefs.textSize - TEXT_SIZE_MIN) / (TEXT_SIZE_MAX - TEXT_SIZE_MIN)) * 100;
  const themes = [
    { mode: 'light', icon: SunIcon, label: 'reader.theme_light' },
    { mode: 'dark', icon: MoonIcon, label: 'reader.theme_dark' },
    { mode: 'system', icon: MonitorIcon, label: 'reader.theme_system' },
  ] as const;
  return (
    <ReaderSheet open={open} onOpenChange={onOpenChange} title={doc.title}>
      <div className="space-y-4 pb-1">
        <section aria-labelledby="reader-text-size">
          <h3
            id="reader-text-size"
            className="px-1 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground"
          >
            {t('reader.text_size')}
          </h3>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="rd-icon-btn font-[family-name:var(--rd-serif)] text-sm"
              aria-label={t('reader.text_smaller')}
              disabled={prefs.textSize <= TEXT_SIZE_MIN}
              onClick={() => setReaderPrefs({ textSize: prefs.textSize - 1 })}
            >
              A
            </button>
            <input
              type="range"
              className="rd-range flex-1"
              min={TEXT_SIZE_MIN}
              max={TEXT_SIZE_MAX}
              step={1}
              value={prefs.textSize}
              aria-label={t('reader.text_size')}
              style={{ '--rd-fill': `${fill}%` } as CSSProperties}
              onChange={(event) => setReaderPrefs({ textSize: Number(event.target.value) })}
            />
            <button
              type="button"
              className="rd-icon-btn font-[family-name:var(--rd-serif)] text-xl"
              aria-label={t('reader.text_larger')}
              disabled={prefs.textSize >= TEXT_SIZE_MAX}
              onClick={() => setReaderPrefs({ textSize: prefs.textSize + 1 })}
            >
              A
            </button>
          </div>
        </section>
        <section aria-labelledby="reader-theme">
          <h3
            id="reader-theme"
            className="mb-2 px-1 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground"
          >
            {t('reader.theme')}
          </h3>
          <div className="grid grid-cols-3 gap-2">
            {themes.map(({ mode, icon: Icon, label }) => (
              <button
                key={mode}
                type="button"
                className="rd-chip"
                aria-pressed={theme.mode === mode}
                onClick={() => theme.setTheme(mode)}
              >
                <Icon className="size-4" aria-hidden="true" />
                {t(label)}
              </button>
            ))}
          </div>
        </section>
        <div className="-mx-1 space-y-0.5 border-t border-border/60 pt-2">
          {doc.chapters.length > 0 && (
            <SheetRow
              icon={BookmarkIcon}
              label={t('reader.chapters')}
              chevron
              onClick={() => onSheet('chapters')}
            />
          )}
          <SheetRow
            icon={UserRoundIcon}
            label={t('reader.voice')}
            chevron
            onClick={() => onSheet('voice')}
          />
          <SheetRow
            icon={MoonIcon}
            label={t('reader.sleep_timer')}
            chevron
            onClick={() => onSheet('sleep')}
          />
          <OfflineRow id={doc.id} />
        </div>
        <DiagnosticsRows />
      </div>
    </ReaderSheet>
  );
}

function ReaderSkeleton() {
  return (
    <div className="rd-column space-y-4 pt-8" aria-hidden="true">
      <div className="rd-skeleton h-8 w-3/4" />
      <div className="rd-skeleton h-4 w-1/3" />
      {[92, 100, 84, 97, 70, 100, 88].map((width, index) => (
        <div key={index} className="rd-skeleton h-5" style={{ width: `${width}%` }} />
      ))}
    </div>
  );
}

const editable = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    target.matches('input, textarea, select') ||
    Boolean(target.closest('.rd-sheet')));

export function ReaderDocumentPage() {
  const { t } = useTranslation();
  const { docId } = useParams({ from: '/reader/$docId' });
  const query = useReaderDocument(docId);
  const doc = query.data;
  const player = useReaderPlayer();
  const prefs = useReaderPrefs();
  const scroller = useRef<HTMLElement>(null);
  const follow = useRef(true);
  const [following, setFollowing] = useState(true);
  const [scrolled, setScrolled] = useState(false);
  const [sheet, setSheet] = useState<Sheet>(null);
  const active = Boolean(doc && player.doc?.id === doc.id);
  const otherPlaying =
    Boolean(doc && player.doc && player.doc.id !== doc.id) &&
    (player.status === 'playing' || player.status === 'buffering');

  useEffect(() => {
    if (!doc || otherPlaying) return;
    readerPlayer.load(doc);
    readerPlayer.prepare();
    // A document that is playing is never cut off; this one loads once it stops.
  }, [doc, otherPlaying]);

  const resumeFollowing = useCallback(() => {
    follow.current = true;
    setFollowing(true);
  }, []);

  useEffect(() => {
    const onFollow = () => {
      resumeFollowing();
      const sentence = scroller.current?.querySelector<HTMLElement>('.rd-sent[data-active]');
      if (sentence && scroller.current) {
        scroller.current.scrollTo({
          top:
            scroller.current.scrollTop +
            sentence.getBoundingClientRect().top -
            scroller.current.getBoundingClientRect().top -
            scroller.current.clientHeight * 0.28,
          behavior: 'smooth',
        });
      }
    };
    window.addEventListener(FOLLOW_EVENT, onFollow);
    return () => window.removeEventListener(FOLLOW_EVENT, onFollow);
  }, [resumeFollowing]);

  // A user scroll gesture stops auto-follow until "Back to current".
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const stop = () => {
      if (!follow.current) return;
      follow.current = false;
      setFollowing(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown'].includes(event.key)) stop();
    };
    element.addEventListener('wheel', stop, { passive: true });
    element.addEventListener('touchmove', stop, { passive: true });
    element.addEventListener('keydown', onKey);
    return () => {
      element.removeEventListener('wheel', stop);
      element.removeEventListener('touchmove', stop);
      element.removeEventListener('keydown', onKey);
    };
  }, [doc]);

  // Desktop shortcuts: Space play/pause, ←/→ sentence, +/− speed.
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (editable(event.target)) return;
      const key = event.key;
      if (key === ' ' || key === 'k') readerPlayer.toggle();
      else if (key === 'ArrowLeft') readerPlayer.previous();
      else if (key === 'ArrowRight') readerPlayer.next();
      else if (key === '+' || key === '=') readerPlayer.setRate(readerPlayer.getState().rate + 0.1);
      else if (key === '-' || key === '_') readerPlayer.setRate(readerPlayer.getState().rate - 0.1);
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active]);

  const activate = () => {
    if (!doc) return;
    readerPlayer.unlockFromGesture();
    readerPlayer.load(doc);
    readerPlayer.play();
  };

  const openSheet = (next: Sheet) => setSheet(next);
  const closeSheet = (open: boolean) => {
    if (!open) setSheet(null);
  };

  // Memoized so the (memoized) text view does not re-render on every sentence.
  const header = useMemo(() => {
    if (!doc) return null;
    const meta = [
      doc.author || doc.source_name,
      t('reader.minutes_total', { minutes: minutesLeft(doc.est_duration_s) }),
    ]
      .filter(Boolean)
      .join(' · ');
    const first = doc.segments[0];
    const showTitle = !(first?.kind === 'h' && first.text.trim() === doc.title.trim());
    return (
      <header className="mb-8">
        {showTitle && <h1 className="rd-doc-title">{doc.title}</h1>}
        <p className="font-sans text-sm text-muted-foreground">{meta}</p>
      </header>
    );
  }, [doc, t]);

  return (
    <div className="rd-root" data-slot="reader-document">
      <header className={cn('rd-topbar', titlebarChrome())} data-scrolled={scrolled}>
        <Link to="/reader" className="rd-icon-btn" aria-label={t('reader.back_to_library')}>
          <ChevronLeftIcon className="size-6" aria-hidden="true" />
        </Link>
        <p
          className={cn(
            'min-w-0 flex-1 truncate px-1 text-center text-sm font-semibold transition-opacity duration-200',
            scrolled ? 'opacity-100' : 'opacity-0',
          )}
          aria-hidden={!scrolled}
        >
          {doc?.title}
        </p>
        {player.offline && active && (
          <CloudOffIcon
            className="size-4 shrink-0 text-muted-foreground"
            aria-label={t('reader.playing_offline')}
          />
        )}
        <button
          type="button"
          className="rd-icon-btn"
          aria-label={t('reader.options')}
          disabled={!doc}
          onClick={() => openSheet('options')}
        >
          <EllipsisIcon className="size-6" aria-hidden="true" />
        </button>
      </header>

      <div className="relative flex min-h-0 flex-1 flex-col">
        <main
          ref={scroller}
          className="rd-scroll"
          tabIndex={-1}
          onScroll={(event) => setScrolled(event.currentTarget.scrollTop > 48)}
        >
          {query.isPending ? (
            <ReaderSkeleton />
          ) : query.isError || !doc ? (
            <div
              className="rd-column flex flex-col items-center gap-3 py-24 text-center"
              role="alert"
            >
              <p className="text-base font-semibold">{t('reader.load_failed')}</p>
              <p className="max-w-sm text-sm text-muted-foreground">{describeError(query.error)}</p>
              <div className="mt-2 flex gap-2">
                <Link
                  to="/reader"
                  className="rd-press inline-flex h-11 items-center rounded-full bg-foreground/[0.07] px-5 text-sm font-semibold"
                >
                  {t('reader.back_to_library')}
                </Link>
                <button
                  type="button"
                  className="rd-press h-11 rounded-full bg-foreground px-5 text-sm font-semibold text-background"
                  onClick={() => void query.refetch()}
                >
                  {t('reader.retry')}
                </button>
              </div>
            </div>
          ) : (
            <div
              className="rd-column pb-16 pt-6"
              style={{ '--rd-text-size': `${prefs.textSize}px` } as CSSProperties}
            >
              <ReaderTextView
                docId={doc.id}
                segments={doc.segments}
                active={active}
                scroller={scroller}
                follow={follow}
                onSeek={resumeFollowing}
                lang={doc.language ?? undefined}
                header={header}
              />
              {doc.segments.length === 0 && (
                <p className="py-10 text-center text-sm text-muted-foreground">
                  {t('reader.empty_document')}
                </p>
              )}
            </div>
          )}
        </main>
        {!following && active && (
          <button
            type="button"
            className="rd-press rd-follow-pill inline-flex h-11 items-center gap-2 rounded-full bg-foreground px-4 text-sm font-semibold whitespace-nowrap text-background shadow-lg"
            onClick={() => window.dispatchEvent(new Event(FOLLOW_EVENT))}
          >
            <ArrowDownToLineIcon className="size-4" aria-hidden="true" />
            {t('reader.back_to_current')}
          </button>
        )}
      </div>

      {doc && (
        <>
          <PlayerDock doc={doc} active={active} onSheet={openSheet} onActivate={activate} />
          <DebugHud />
          <OptionsSheet
            doc={doc}
            open={sheet === 'options'}
            onOpenChange={closeSheet}
            onSheet={openSheet}
          />
          <SpeedSheet open={sheet === 'speed'} onOpenChange={closeSheet} />
          <VoiceSheet doc={doc} open={sheet === 'voice'} onOpenChange={closeSheet} />
          <SleepSheet doc={doc} open={sheet === 'sleep'} onOpenChange={closeSheet} />
          <ChaptersSheet doc={doc} open={sheet === 'chapters'} onOpenChange={closeSheet} />
        </>
      )}
    </div>
  );
}
