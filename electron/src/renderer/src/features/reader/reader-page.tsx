import '@fontsource-variable/source-serif-4';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type RefObject,
} from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import {
  ALargeSmallIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronsRightIcon,
  CloudOffIcon,
  EllipsisIcon,
  LocateFixedIcon,
  PlayIcon,
  Undo2Icon,
} from 'lucide-react';
import { ApiError, describeError } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import { DebugHud } from './debug-hud';
import { markTip } from './first-run';
import { FirstRunCard } from './first-run-card';
import { durationLabel } from './library-view';
import { PlayerDock, type DockSheet } from './player-dock';
import { ChaptersSheet, FOLLOW_EVENT, SleepSheet, SpeedSheet, VoiceSheet } from './player-sheets';
import type { ReaderDocument } from './reader-api';
import { useAppearanceProps, useReaderAppearance } from './reader-appearance';
import { spreadFits } from './reader-pages';
import { titlebarChrome } from './reader-chrome';
import { readerPlayer, useReaderClock, useReaderPlayer } from './reader-player';
import { autoHideOn, useReaderPrefs } from './reader-prefs';
import {
  editableTarget,
  firstVisibleSegment,
  ReaderTextView,
  scrollToSentence,
  type WordPress,
} from './reader-text-view';
import { chapterIndexAt, formatClock, minutesLeft } from './reader-text';
import { SearchSheet } from './search-sheet';
import { useReaderDocument } from './use-reader-data';
import { ControlsSheet } from './controls-sheet';
import { useReaderWarmup } from './engine-status';
import { REVEAL_EVENT, type RevealDetail } from './reader-events';
import { UNDO_WINDOW_MS } from './reader-undo';
import { addBookmarkHere, BookmarksSheet, useBookmarks } from './bookmarks-sheet';
import { bookmarkedSegments } from './bookmarks';
import {
  PronounceSheet,
  PronunciationsSheet,
  pressTarget,
  type PronounceTarget,
} from './pronunciation-sheet';
import { AudioOnlyView } from './audio-only-view';
import { useListeningPrefs } from './listening-prefs';
import { QueueSheet } from './queue-sheet';
import { SoundscapeSheet } from './soundscape-sheet';
import { SpeechSheet } from './speech-sheet';
import { LabSheet } from './lab-sheet';
import { ActionsSheet, AppearanceSheet, type MenuSheet } from './reader-menus';
import { canHideChrome, distinctSource } from './player-chrome';
import { useChromeFocus, useReaderChrome } from './use-reader-chrome';
import { confirm as confirmHaptic } from './haptics';
import './reader.css';
import './player-chrome.css';

type Sheet = DockSheet | MenuSheet | 'actions' | 'appearance' | null;

/** Furthest point reached: offered when it is well ahead of the playhead. */
const FURTHEST_MIN_SECONDS = 30;

/** "Volver a 12:34": undo the latest jump (an accidental tap, a scrubber slip). */
function UndoButton() {
  const { t } = useTranslation();
  const { undo, rate } = useReaderPlayer();
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const left = undo ? UNDO_WINDOW_MS - (Date.now() - undo.at) : 0;
    setVisible(left > 0);
    if (left <= 0) return;
    const timer = setTimeout(() => setVisible(false), left);
    return () => clearTimeout(timer);
  }, [undo]);
  if (!undo || !visible) return null;
  const seconds = (readerPlayer.secondsAt(undo.segment) + undo.offset) / rate;
  return (
    <button
      type="button"
      className="rd-press rd-float-btn"
      onClick={() => {
        readerPlayer.undoJump();
        window.dispatchEvent(new Event(FOLLOW_EVENT));
      }}
    >
      <Undo2Icon className="size-4 shrink-0" aria-hidden="true" />
      <span className="truncate">{t('reader.undo_jump', { time: formatClock(seconds) })}</span>
    </button>
  );
}

/** "Ir al punto más lejano": shown while the furthest point is well ahead. */
function FurthestButton() {
  const { t } = useTranslation();
  const { segment, furthest, rate } = useReaderPlayer();
  const clock = useReaderClock();
  const furthestAt = readerPlayer.secondsAt(furthest);
  if (furthest <= segment || furthestAt - clock.elapsed < FURTHEST_MIN_SECONDS) return null;
  return (
    <button
      type="button"
      className="rd-press rd-float-btn"
      onClick={() => {
        readerPlayer.goFurthest();
        window.dispatchEvent(new Event(FOLLOW_EVENT));
      }}
    >
      <ChevronsRightIcon className="size-4 shrink-0" aria-hidden="true" />
      <span className="truncate">
        {t('reader.go_furthest', { time: formatClock(furthestAt / rate) })}
      </span>
    </button>
  );
}

function ReaderSkeleton() {
  return (
    <div className="rd-column rd-reading space-y-4" aria-hidden="true">
      <div className="rd-skeleton h-8 w-3/4" />
      <div className="rd-skeleton h-4 w-1/3" />
      {[92, 100, 84, 97, 70, 100, 88].map((width, index) => (
        <div key={index} className="rd-skeleton h-5" style={{ width: `${width}%` }} />
      ))}
    </div>
  );
}

/** Desktop layout (wide window): the header keeps a "back" chevron instead of "minimise". */
function useWide(): boolean {
  const query = '(min-width: 1024px)';
  const [wide, setWide] = useState(
    () => typeof window.matchMedia === 'function' && window.matchMedia(query).matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(query);
    const update = () => setWide(media.matches);
    media.addEventListener?.('change', update);
    return () => media.removeEventListener?.('change', update);
  }, []);
  return wide;
}

/** Pages: two side by side when the option is on and the reader is wide enough. */
function useSpread(root: RefObject<HTMLElement | null>, on: boolean, textSize: number): boolean {
  const [fits, setFits] = useState(false);
  useLayoutEffect(() => {
    const element = root.current;
    if (!on || !element) {
      setFits(false);
      return;
    }
    const check = () => setFits(spreadFits(element.clientWidth, textSize));
    check();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(check) : null;
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [root, on, textSize]);
  return fits;
}

/** Keep `--rd-top-h` / `--rd-dock-h` on the root equal to the floating chrome's heights. */
function useChromeInsets(
  root: RefObject<HTMLElement | null>,
  top: RefObject<HTMLElement | null>,
  bottom: RefObject<HTMLElement | null>,
  ready: boolean,
) {
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const update = () => {
      element.style.setProperty('--rd-top-h', `${top.current?.offsetHeight ?? 0}px`);
      element.style.setProperty('--rd-dock-h', `${bottom.current?.offsetHeight ?? 0}px`);
    };
    update();
    if (typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(update);
    if (top.current) observer.observe(top.current);
    if (bottom.current) observer.observe(bottom.current);
    return () => observer.disconnect();
  }, [root, top, bottom, ready]);
}

function HeaderSubtitle({ doc, active }: { doc: ReaderDocument; active: boolean }) {
  const { t } = useTranslation();
  const { segment } = useReaderPlayer();
  const chapter =
    doc.chapters[chapterIndexAt(doc.chapters, active ? segment : doc.position_segment)]?.title;
  const text =
    doc.author ||
    chapter ||
    distinctSource(doc.title, doc.source_name) ||
    durationLabel(t, minutesLeft(doc.est_duration_s), false);
  return <span className="rd-head-sub">{text}</span>;
}

export function ReaderDocumentPage() {
  const { t } = useTranslation();
  const { docId } = useParams({ from: '/reader/$docId' });
  const query = useReaderDocument(docId);
  const doc = query.data;
  const player = useReaderPlayer();
  const prefs = useReaderPrefs();
  const appearance = useAppearanceProps();
  const { layout, font, spread: spreadPref } = useReaderAppearance();
  const wide = useWide();
  const root = useRef<HTMLDivElement>(null);
  const topbar = useRef<HTMLElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLElement>(null);
  const follow = useRef(true);
  const [following, setFollowing] = useState(true);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [pronounce, setPronounce] = useState<PronounceTarget | null>(null);
  /** Bookmark whose note the bookmarks sheet is editing. */
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const bookmarks = useBookmarks(docId, Boolean(query.data));
  const marked = useMemo(() => bookmarkedSegments(bookmarks.data), [bookmarks.data]);
  /** Segment last shown by reader:reveal; "continue from here" starts there. */
  const revealed = useRef<number | null>(null);
  // The backend answers 409 while a background import is still running.
  const importing = query.error instanceof ApiError && query.error.status === 409;
  const active = Boolean(doc && player.doc?.id === doc.id);
  const playing = player.status === 'playing' || player.status === 'buffering';
  const listening = useListeningPrefs();
  /** Pages instead of scrolling (appearance option); audio-only has no text. */
  const paged = layout === 'pages' && !listening.audioOnly;
  const spread = useSpread(root, paged && spreadPref, prefs.textSize);
  useReaderWarmup();
  const otherPlaying =
    Boolean(doc && player.doc && player.doc.id !== doc.id) &&
    (player.status === 'playing' || player.status === 'buffering');

  // Floating chrome: fades out while this document plays (see player-chrome.ts).
  const chromeFocused = useChromeFocus(root);
  const canHide = canHideChrome({
    enabled: autoHideOn(prefs),
    playing: active && playing,
    sheetOpen: sheet !== null || pronounce !== null,
    attention: player.status === 'error' || player.blocked !== null,
    focused: chromeFocused,
    audioOnly: listening.audioOnly,
  });
  const chrome = useReaderChrome({ canHide, scroller, chrome: root });
  useChromeInsets(root, topbar, bottom, Boolean(doc));

  useEffect(() => {
    if (!doc || otherPlaying) return;
    readerPlayer.load(doc);
    readerPlayer.prepare();
    // A document that is playing is never cut off; this one loads once it stops.
  }, [doc, otherPlaying]);

  // The queue moved on from this document: show the next one. Playback never
  // waits for this (it may run much later, when a locked phone wakes up).
  const navigate = useNavigate();
  const playerDocId = player.doc?.id ?? null;
  const shownPlayerDoc = useRef(playerDocId);
  useEffect(() => {
    const before = shownPlayerDoc.current;
    shownPlayerDoc.current = playerDocId;
    const advance = readerPlayer.lastAdvance;
    if (before === docId && advance && advance.from === docId && advance.to === playerDocId)
      void navigate({ to: '/reader/$docId', params: { docId: advance.to }, replace: true });
  }, [playerDocId, docId, navigate]);

  const resumeFollowing = useCallback(() => {
    follow.current = true;
    revealed.current = null;
    setFollowing(true);
  }, []);
  /** A tap (or double tap) on a sentence: the tip about it has been learnt. */
  const onSeek = useCallback(() => {
    markTip('tap');
    resumeFollowing();
  }, [resumeFollowing]);
  const stopFollowing = useCallback(() => {
    revealed.current = null;
    if (!follow.current) return;
    follow.current = false;
    setFollowing(false);
  }, []);
  /** Pages: turning away from the spoken page stops following; turning back to it resumes. */
  const onBrowse = useCallback(
    (away: boolean) => (away ? stopFollowing() : resumeFollowing()),
    [stopFollowing, resumeFollowing],
  );

  // Search results and bookmarks reveal a segment: stop following the voice there.
  useEffect(() => {
    const onReveal = (event: Event) => {
      const segment = (event as CustomEvent<RevealDetail>).detail?.segment;
      follow.current = false;
      setFollowing(false);
      revealed.current = typeof segment === 'number' ? segment : null;
    };
    window.addEventListener(REVEAL_EVENT, onReveal);
    return () => window.removeEventListener(REVEAL_EVENT, onReveal);
  }, []);

  /** Paused and scrolled away: play from what is on screen. */
  const continueHere = () => {
    const element = scroller.current;
    const segment = revealed.current ?? (element ? firstVisibleSegment(element) : null);
    if (segment === null) return;
    readerPlayer.unlockFromGesture();
    resumeFollowing();
    readerPlayer.seekSegment(segment, true);
  };

  useEffect(() => {
    const onFollow = () => {
      resumeFollowing();
      // Pages: the text view turns to the spoken page itself.
      if (paged) return;
      const sentence = scroller.current?.querySelector<HTMLElement>('.rd-sent[data-active]');
      if (sentence && scroller.current) scrollToSentence(scroller.current, sentence, true);
    };
    window.addEventListener(FOLLOW_EVENT, onFollow);
    return () => window.removeEventListener(FOLLOW_EVENT, onFollow);
  }, [resumeFollowing, paged]);

  // A user scroll gesture stops auto-follow until "Back to current" (pages: onBrowse).
  useEffect(() => {
    const element = scroller.current;
    if (!element || paged) return;
    const stop = stopFollowing;
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
  }, [doc, paged, stopFollowing]);

  // Desktop shortcuts: Space play/pause, ←/→ sentence (pages: the page), +/− speed.
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (editableTarget(event.target)) return;
      const key = event.key;
      if (paged && (key === 'ArrowLeft' || key === 'ArrowRight')) return;
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
  }, [active, paged]);

  useEffect(() => {
    if (!doc) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey) return;
      const find = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f';
      const slash =
        event.key === '/' && !event.ctrlKey && !event.metaKey && !editableTarget(event.target);
      if (!find && !slash) return;
      event.preventDefault();
      setSheet('search');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [doc]);

  const addBookmark = useCallback(() => {
    if (!doc) return;
    setSheet((open) => (open === 'actions' ? null : open));
    confirmHaptic();
    void addBookmarkHere(doc, (id) => {
      setNoteFor(id);
      setSheet('bookmarks');
    });
  }, [doc]);

  // Desktop: B bookmarks the current position.
  useEffect(() => {
    if (!doc) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key.toLowerCase() !== 'b' || event.repeat || editableTarget(event.target)) return;
      event.preventDefault();
      addBookmark();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [doc, addBookmark]);

  const onWordPress = useCallback((press: WordPress) => {
    markTip('press');
    setSheet(null);
    setPronounce(pressTarget(press));
  }, []);

  const dispatchChrome = chrome.dispatch;
  const onChrome = useCallback(
    (event: 'toggle' | 'interact') => dispatchChrome({ type: event }),
    [dispatchChrome],
  );
  /** Taps beside the article (margins, padding, audio-only background) toggle the controls. */
  const onSurfaceClick = (event: MouseEvent<HTMLElement>) => {
    const target = event.target as Element;
    if (target.closest('.rd-article, button, a, input, [role="button"]')) return;
    if (window.getSelection()?.toString()) return;
    onChrome('toggle');
  };

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
      durationLabel(t, minutesLeft(doc.est_duration_s), false),
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

  const BackIcon = wide ? ChevronLeftIcon : ChevronDownIcon;
  return (
    <div
      ref={root}
      className="rd-root"
      data-slot="reader-document"
      data-chrome={chrome.hidden ? 'hidden' : 'shown'}
      data-layout={paged ? 'pages' : undefined}
      data-spread={spread || undefined}
      {...appearance}
    >
      <header ref={topbar} className={cn('rd-topbar rd-chrome', titlebarChrome())}>
        <div className="rd-topbar-side">
          <Link
            to="/reader"
            className="rd-icon-btn"
            aria-label={t(wide ? 'reader.back_to_library' : 'reader.minimize')}
          >
            <BackIcon className="size-6" aria-hidden="true" />
          </Link>
        </div>
        <div className="rd-head-text">
          <span className="rd-head-title">{doc?.title}</span>
          {doc && <HeaderSubtitle doc={doc} active={active} />}
        </div>
        <div className="rd-topbar-side justify-end">
          {player.offline && active && (
            <CloudOffIcon
              className="mx-1 size-4 shrink-0 text-muted-foreground"
              aria-label={t('reader.playing_offline')}
            />
          )}
          <button
            type="button"
            className="rd-icon-btn"
            aria-label={t('reader.appearance')}
            disabled={!doc}
            onClick={() => openSheet('appearance')}
          >
            <ALargeSmallIcon className="size-6" aria-hidden="true" />
          </button>
          <button
            type="button"
            className="rd-icon-btn"
            aria-label={t('reader.options')}
            disabled={!doc}
            onClick={() => {
              markTip('menu');
              openSheet('actions');
            }}
          >
            <EllipsisIcon className="size-6" aria-hidden="true" />
          </button>
        </div>
      </header>

      <main ref={scroller} className="rd-scroll" tabIndex={-1} onClick={onSurfaceClick}>
        {query.isPending ? (
          <ReaderSkeleton />
        ) : query.isError || !doc ? (
          <div
            className="rd-column rd-reading flex flex-col items-center gap-3 text-center"
            role="alert"
          >
            <p className="mt-16 text-base font-semibold">
              {t(importing ? 'reader.import_in_progress' : 'reader.load_failed')}
            </p>
            {!importing && (
              <p className="max-w-sm text-sm text-muted-foreground">{describeError(query.error)}</p>
            )}
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
        ) : listening.audioOnly ? (
          <AudioOnlyView doc={doc} active={active} onActivate={activate} />
        ) : (
          <div
            className="rd-column rd-reading"
            style={{ '--rd-text-size': `${prefs.textSize}px` } as CSSProperties}
          >
            <ReaderTextView
              docId={doc.id}
              segments={doc.segments}
              active={active}
              position={doc.position_segment}
              scroller={scroller}
              follow={follow}
              onSeek={onSeek}
              lang={doc.language ?? undefined}
              header={header}
              marked={marked}
              onWordPress={onWordPress}
              chromeHidden={chrome.hiddenRef}
              onChrome={onChrome}
              paged={paged}
              pageKey={`${prefs.textSize}|${font}`}
              onBrowse={onBrowse}
            />
            {doc.segments.length === 0 && (
              <p className="py-10 text-center text-sm text-muted-foreground">
                {t('reader.empty_document')}
              </p>
            )}
          </div>
        )}
      </main>

      <div ref={bottom} className="rd-bottom rd-chrome">
        {doc && active && (
          <div className="rd-floating">
            <div className="rd-floating-start">
              <UndoButton />
              <FurthestButton />
            </div>
            {!following && !listening.audioOnly && (
              <div className="rd-floating-end">
                {!playing && (
                  <button
                    type="button"
                    className="rd-press rd-float-btn rd-float-strong"
                    onClick={continueHere}
                  >
                    <PlayIcon className="size-4 shrink-0 fill-current" aria-hidden="true" />
                    <span className="truncate">{t('reader.continue_here')}</span>
                  </button>
                )}
                <button
                  type="button"
                  className="rd-press rd-float-round"
                  aria-label={t('reader.back_to_current')}
                  title={t('reader.back_to_current')}
                  onClick={() => window.dispatchEvent(new Event(FOLLOW_EVENT))}
                >
                  <LocateFixedIcon className="size-5" aria-hidden="true" />
                </button>
              </div>
            )}
          </div>
        )}
        {doc && (
          <FirstRunCard
            doc={doc}
            hidden={
              sheet !== null ||
              pronounce !== null ||
              listening.audioOnly ||
              doc.segments.length === 0
            }
            onChooseVoice={() => openSheet('voice')}
          />
        )}
        {doc && (
          <PlayerDock
            doc={doc}
            active={active}
            onSheet={openSheet}
            onActivate={activate}
            onBookmark={addBookmark}
          />
        )}
      </div>

      {doc && (
        <>
          <DebugHud />
          <ActionsSheet
            doc={doc}
            active={active}
            open={sheet === 'actions'}
            onOpenChange={closeSheet}
            onSheet={openSheet}
            onAddBookmark={addBookmark}
          />
          <AppearanceSheet open={sheet === 'appearance'} onOpenChange={closeSheet} />
          <SpeedSheet open={sheet === 'speed'} onOpenChange={closeSheet} />
          <VoiceSheet doc={doc} open={sheet === 'voice'} onOpenChange={closeSheet} />
          <SleepSheet doc={doc} open={sheet === 'sleep'} onOpenChange={closeSheet} />
          <ChaptersSheet doc={doc} open={sheet === 'chapters'} onOpenChange={closeSheet} />
          <ControlsSheet open={sheet === 'controls'} onOpenChange={closeSheet} />
          <SearchSheet doc={doc} open={sheet === 'search'} onOpenChange={closeSheet} />
          <BookmarksSheet
            doc={doc}
            open={sheet === 'bookmarks'}
            onOpenChange={closeSheet}
            editing={noteFor}
            onEditing={setNoteFor}
          />
          <PronunciationsSheet
            doc={doc}
            open={sheet === 'pronunciations'}
            onOpenChange={closeSheet}
            onEdit={(target) => {
              setSheet(null);
              setPronounce(target);
            }}
          />
          <PronounceSheet doc={doc} target={pronounce} onClose={() => setPronounce(null)} />
          <QueueSheet open={sheet === 'queue'} onOpenChange={closeSheet} />
          <SoundscapeSheet open={sheet === 'soundscape'} onOpenChange={closeSheet} />
          <SpeechSheet doc={doc} open={sheet === 'speech'} onOpenChange={closeSheet} />
          <LabSheet doc={doc} open={sheet === 'labs'} onOpenChange={closeSheet} />
        </>
      )}
    </div>
  );
}
