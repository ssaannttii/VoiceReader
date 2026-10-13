import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
  type UIEvent,
} from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ArrowDownUpIcon,
  ChevronDownIcon,
  CircleCheckIcon,
  CircleIcon,
  CloudDownloadIcon,
  CloudOffIcon,
  EllipsisIcon,
  HouseIcon,
  Loader2Icon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  SearchIcon,
  SmartphoneIcon,
  SquareCheckIcon,
  Trash2Icon,
  VibrateIcon,
  XIcon,
  type LucideIcon,
} from 'lucide-react';
import { describeError } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import { AddDocumentSheet } from './add-document-sheet';
import { CoverTile } from './cover-tile';
import { DocumentActionsSheet } from './document-actions-sheet';
import { hapticsPref, hapticsSupported, setHaptics, tick } from './haptics';
import {
  deleteMany,
  setFlagsWithUndo,
  startDownloads,
  useHiddenDocuments,
} from './library-actions';
import { DocumentRow, durationLabel, sourceLabel } from './library-row';
import {
  bulkFinishedTarget,
  NO_SELECTION,
  selectionReducer,
  type LibrarySelection,
} from './library-selection';
import { CoverWall, EmptyState, LibrarySkeleton, StackedCards } from './library-states';
import {
  arrangeLibrary,
  coverArt,
  coverShape,
  isFinished,
  isReady,
  LIBRARY_FILTERS,
  LIBRARY_SORTS,
  matchesQuery,
  rowStatus,
  setLibrarySort,
  useLibrarySort,
  type LibraryFilter,
  type LibrarySort,
} from './library-view';
import { MiniPlayer } from './mini-player';
import { PhoneSheet } from './phone-sheet';
import { fetchReaderDocument } from './reader-actions';
import type { ReaderDocumentSummary } from './reader-api';
import { useAppearanceProps } from './reader-appearance';
import { isTouchDevice, titlebarChrome } from './reader-chrome';
import { readerPlayer, useReaderPlayer } from './reader-player';
import { ReaderSheet, SheetRow } from './reader-sheet';
import { SearchField } from './search-field';
import { useReaderDocuments, type ReaderListItem } from './use-reader-data';
import './reader.css';
import './library.css';
import { formatPercent } from './reader-text';

const SORT_LABELS: Record<LibrarySort, string> = {
  recent: 'reader.sort_recent',
  least_recent: 'reader.lib_sort_least_recent',
  progress: 'reader.sort_progress',
  title: 'reader.sort_title',
  title_desc: 'reader.lib_sort_title_desc',
  added: 'reader.sort_added',
  oldest: 'reader.lib_sort_oldest',
};
const FILTER_LABELS: Record<LibraryFilter, string> = {
  library: 'reader.library',
  archived: 'reader.filter_archived',
  finished: 'reader.filter_finished',
};

/** Play from the library without opening the reader; unlocks audio inside the tap. */
function usePlayFromLibrary() {
  const { t } = useTranslation();
  const player = useReaderPlayer();
  return {
    activeId: player.doc?.id ?? null,
    playing: player.status === 'playing' || player.status === 'buffering',
    play: (id: string) => {
      tick();
      if (player.doc?.id === id) {
        readerPlayer.toggle();
        return;
      }
      readerPlayer.unlockFromGesture();
      fetchReaderDocument(id)
        .then((doc) => {
          readerPlayer.load(doc);
          readerPlayer.play();
        })
        .catch((error: unknown) =>
          toast.error(t('reader.load_failed'), { description: describeError(error) }),
        );
    },
  };
}

/** Toast when a background import finishes or fails while the library is open. */
function useImportNotices(docs: readonly ReaderListItem[], onOpen: (id: string) => void) {
  const { t } = useTranslation();
  const importing = useRef(new Set<string>());
  useEffect(() => {
    const now = new Set<string>();
    for (const doc of docs) {
      if (doc.import_status === 'importing') {
        now.add(doc.id);
        continue;
      }
      if (!importing.current.has(doc.id)) continue;
      if (doc.import_status === 'error')
        toast.error(t('reader.import_failed_named', { title: doc.title }), {
          description: doc.import_error ?? undefined,
        });
      else
        toast.success(t('reader.import_ready', { title: doc.title }), {
          duration: 6000,
          action: { label: t('reader.open'), onClick: () => onOpen(doc.id) },
        });
    }
    importing.current = now;
  }, [docs, onOpen, t]);
}

/**
 * Header chrome driven by the list scroll: the large title collapsing into the
 * bar, the bar hairline, and the mini player hiding while scrolling down.
 */
function useScrollChrome() {
  const scroller = useRef<HTMLElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const [scrolled, setScrolled] = useState(false);
  const [compact, setCompact] = useState(false);
  const [miniHidden, setMiniHidden] = useState(false);
  const last = useRef(0);
  useEffect(() => {
    const root = scroller.current;
    const node = title.current;
    if (!root || !node || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) => setCompact(!entry.isIntersecting), {
      root,
      rootMargin: '-4px 0px 0px 0px',
      threshold: 0,
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const onScroll = (event: UIEvent<HTMLElement>) => {
    const el = event.currentTarget;
    const top = el.scrollTop;
    setScrolled(top > 4);
    const delta = top - last.current;
    if (top <= 8 || el.scrollHeight - el.clientHeight - top < 8) {
      setMiniHidden(false);
      last.current = top;
    } else if (Math.abs(delta) > 10) {
      setMiniHidden(delta > 0);
      last.current = top;
    }
  };
  return { scroller, title, scrolled, compact, miniHidden, onScroll };
}

function ContinueCard({
  doc,
  onPlay,
  playing,
}: {
  doc: ReaderDocumentSummary;
  onPlay: () => void;
  playing: boolean;
}) {
  const { t } = useTranslation();
  const status = rowStatus(doc);
  return (
    <section aria-labelledby="reader-continue" className="rd-continue">
      <h2 id="reader-continue" className="rd-section-label">
        {t('reader.continue')}
      </h2>
      <div className="rd-continue-card">
        <Link to="/reader/$docId" params={{ docId: doc.id }} className="rd-continue-open rd-press">
          <span className="rd-cover-slot" data-size="lg">
            <CoverTile
              id={doc.id}
              title={doc.title}
              hasCover={doc.has_cover}
              shape={coverShape(doc)}
              art={coverArt(doc)}
              size="lg"
            />
          </span>
          <span className="min-w-0 flex-1">
            <span className="rd-continue-title">{doc.title}</span>
            <span className="rd-row-meta">{sourceLabel(doc, t)}</span>
            {status.kind === 'progress' && (
              <span className="rd-row-meta">
                {formatPercent(status.percent)} · {durationLabel(t, status.minutes, true)}
              </span>
            )}
            <span className="rd-continue-progress" aria-hidden="true">
              <span style={{ transform: `scaleX(${Math.min(1, Math.max(0, doc.progress))})` }} />
            </span>
          </span>
        </Link>
        <button
          type="button"
          className="rd-continue-play rd-press"
          onClick={onPlay}
          aria-label={t(playing ? 'reader.pause' : 'reader.play')}
        >
          {playing ? (
            <PauseIcon className="size-5 fill-current" strokeWidth={0} aria-hidden="true" />
          ) : (
            <PlayIcon className="ml-0.5 size-5 fill-current" strokeWidth={0} aria-hidden="true" />
          )}
        </button>
      </div>
    </section>
  );
}

/** Text tabs with an underline that slides (and stretches a little) between them. */
function LibraryTabs({
  value,
  onChange,
}: {
  value: LibraryFilter;
  onChange: (value: LibraryFilter) => void;
}) {
  const { t } = useTranslation();
  const list = useRef<HTMLDivElement>(null);
  const [bar, setBar] = useState<{ left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const measure = () => {
      const tab = list.current?.querySelector<HTMLElement>(`[data-tab='${value}']`);
      if (tab) setBar({ left: tab.offsetLeft, width: tab.offsetWidth });
    };
    measure();
    window.addEventListener('resize', measure);
    void document.fonts?.ready.then(measure);
    return () => window.removeEventListener('resize', measure);
  }, [value, t]);
  return (
    <div ref={list} className="rd-tabs" role="tablist" aria-label={t('reader.filter')}>
      {LIBRARY_FILTERS.map((option) => (
        <button
          key={option}
          type="button"
          role="tab"
          data-tab={option}
          aria-selected={value === option}
          className="rd-tab"
          onClick={() => {
            if (option !== value) tick();
            onChange(option);
          }}
        >
          {t(FILTER_LABELS[option])}
        </button>
      ))}
      {bar && (
        <span
          key={value}
          className="rd-tabs-bar"
          aria-hidden="true"
          style={{ transform: `translateX(${bar.left}px)`, width: bar.width }}
        />
      )}
    </div>
  );
}

function SortSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const sort = useLibrarySort();
  return (
    <ReaderSheet open={open} onOpenChange={onOpenChange} title={t('reader.sort_by')}>
      <div className="space-y-0.5 pb-1">
        {LIBRARY_SORTS.map((option) => (
          <SheetRow
            key={option}
            label={t(SORT_LABELS[option])}
            checked={sort === option}
            onClick={() => {
              tick();
              setLibrarySort(option);
              onOpenChange(false);
            }}
          />
        ))}
      </div>
    </ReaderSheet>
  );
}

/** The header ••• menu: select, sort, phone, vibration. */
function LibraryMenu({
  open,
  onOpenChange,
  onSelect,
  onSort,
  onPhone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: () => void;
  onSort: () => void;
  onPhone?: () => void;
}) {
  const { t } = useTranslation();
  const sort = useLibrarySort();
  const [vibrate, setVibrate] = useState(hapticsPref);
  return (
    <ReaderSheet open={open} onOpenChange={onOpenChange} title={t('reader.options')}>
      <div className="space-y-0.5 pb-1">
        <SheetRow icon={SquareCheckIcon} label={t('reader.lib_select')} onClick={onSelect} />
        <SheetRow
          icon={ArrowDownUpIcon}
          label={t('reader.sort_by')}
          detail={t(SORT_LABELS[sort])}
          chevron
          onClick={onSort}
        />
        {onPhone && (
          <SheetRow icon={SmartphoneIcon} label={t('reader.phone_title')} onClick={onPhone} />
        )}
        {hapticsSupported() && isTouchDevice() && (
          <SheetRow
            icon={VibrateIcon}
            label={t('reader.lib_haptics')}
            detail={t('reader.lib_haptics_hint')}
            role="switch"
            aria-checked={vibrate}
            trailing={
              <span className="rd-switch" data-on={vibrate || undefined} aria-hidden="true" />
            }
            onClick={() => {
              const next = !vibrate;
              setHaptics(next);
              setVibrate(next);
              if (next) tick();
            }}
          />
        )}
      </div>
    </ReaderSheet>
  );
}

function BarAction({
  icon: Icon,
  label,
  onClick,
  disabled,
  danger,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      className="rd-selbar-btn rd-press"
      data-danger={danger || undefined}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}

/** Bottom bar in select mode (replaces the mini player). */
function SelectionBar({
  docs,
  onDone,
  onDelete,
}: {
  docs: readonly ReaderListItem[];
  onDone: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const ready = docs.filter((doc) => isReady(doc) && !doc.offlineOnly);
  const archivedAll = docs.length > 0 && docs.every((doc) => doc.archived);
  const finishTarget = bulkFinishedTarget(ready.map(isFinished));
  return (
    <div
      className="rd-selbar"
      role="toolbar"
      aria-label={t('reader.lib_selected', { count: docs.length })}
    >
      <BarAction
        icon={archivedAll ? ArchiveRestoreIcon : ArchiveIcon}
        label={t(archivedAll ? 'reader.unarchive' : 'reader.archive')}
        disabled={!ready.length}
        onClick={() => {
          const targets = ready.filter((doc) => Boolean(doc.archived) === archivedAll);
          void setFlagsWithUndo(
            targets,
            { archived: !archivedAll },
            t(archivedAll ? 'reader.unarchived' : 'reader.archived'),
          );
          onDone();
        }}
      />
      <BarAction
        icon={finishTarget ? CircleCheckIcon : CircleIcon}
        label={t(finishTarget ? 'reader.finished' : 'reader.lib_unread_short')}
        disabled={!ready.length}
        onClick={() => {
          void setFlagsWithUndo(
            ready.filter((doc) => isFinished(doc) !== finishTarget),
            { completed: finishTarget },
            t(finishTarget ? 'reader.marked_finished' : 'reader.marked_unread'),
          );
          onDone();
        }}
      />
      <BarAction
        icon={CloudDownloadIcon}
        label={t('reader.lib_download_short')}
        disabled={!ready.length}
        onClick={() => {
          startDownloads(ready);
          onDone();
        }}
      />
      <BarAction
        icon={Trash2Icon}
        label={t('reader.delete')}
        danger
        disabled={!docs.filter((doc) => !doc.offlineOnly).length}
        onClick={onDelete}
      />
    </div>
  );
}

function DeleteManySheet({
  docs,
  onClose,
  onDeleted,
}: {
  docs: readonly ReaderListItem[] | null;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const count = docs?.length ?? 0;
  return (
    <ReaderSheet
      open={docs !== null}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title={t('reader.lib_delete_many_title', { count })}
    >
      <div className="space-y-4 pb-1">
        <p className="text-[15px] leading-relaxed text-muted-foreground">
          {t('reader.lib_delete_many_body')}
        </p>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            className="rd-pill-btn rd-press"
            data-tone="secondary"
            onClick={onClose}
          >
            {t('reader.cancel')}
          </button>
          <button
            type="button"
            disabled={busy}
            className="rd-pill-btn rd-press"
            data-tone="danger"
            onClick={() => {
              if (!docs) return;
              setBusy(true);
              void deleteMany(docs).finally(() => {
                setBusy(false);
                onDeleted();
              });
            }}
          >
            {busy && <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />}
            {t('reader.delete')}
          </button>
        </div>
      </div>
    </ReaderSheet>
  );
}

function IconArt({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span className="rd-icon-art" aria-hidden="true">
      <Icon />
    </span>
  );
}

export function ReaderLibraryPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const appearance = useAppearanceProps();
  const documents = useReaderDocuments();
  const playback = usePlayFromLibrary();
  const sort = useLibrarySort();
  const hidden = useHiddenDocuments();
  const chrome = useScrollChrome();
  const [filter, setFilter] = useState<LibraryFilter>('library');
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const [sorting, setSorting] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [phoneOpen, setPhoneOpen] = useState(false);
  const [actionsFor, setActionsFor] = useState<ReaderListItem | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ReaderListItem[] | null>(null);
  const [selection, dispatch] = useReducer(selectionReducer, NO_SELECTION as LibrarySelection);
  const searchInput = useRef<HTMLInputElement>(null);
  const touch = isTouchDevice();

  const docs = useMemo(
    () => (documents.data ?? []).filter((doc) => !hidden.has(doc.id)),
    [documents.data, hidden],
  );
  const offlineOnly = docs.some((doc) => doc.offlineOnly);
  const searching = query.trim().length > 0;
  const visible = useMemo(() => {
    if (!searching) return arrangeLibrary(docs, sort, filter);
    // Search looks everywhere: the library first, then the archive.
    return [
      ...arrangeLibrary(docs, sort, 'library'),
      ...arrangeLibrary(docs, sort, 'archived'),
    ].filter((doc) => matchesQuery(doc, query));
  }, [docs, query, searching, sort, filter]);
  const visibleIds = useMemo(() => visible.map((doc) => doc.id), [visible]);
  useEffect(() => dispatch({ type: 'prune', ids: visibleIds }), [visibleIds]);

  const resume =
    searching || filter !== 'library'
      ? undefined
      : docs.find(
          (doc) =>
            doc.last_opened_at &&
            isReady(doc) &&
            !doc.archived &&
            !isFinished(doc) &&
            doc.position_segment > 0,
        );
  const open = useCallback(
    (id: string) => void navigate({ to: '/reader/$docId', params: { docId: id } }),
    [navigate],
  );
  useImportNotices(docs, open);

  const openSearch = () => {
    setSearchOpen(true);
    requestAnimationFrame(() => searchInput.current?.focus());
  };
  const closeSearch = () => {
    setQuery('');
    setSearchOpen(false);
  };
  const exitSelection = useCallback(() => dispatch({ type: 'exit' }), []);
  useEffect(() => {
    if (!selection.active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) exitSelection();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selection.active, exitSelection]);

  const selectedDocs = useMemo(
    () => docs.filter((doc) => selection.ids.includes(doc.id)),
    [docs, selection.ids],
  );
  const mode = selection.active ? 'select' : searchOpen ? 'search' : 'default';
  const hasDocs = docs.length > 0;
  const loaded = !documents.isPending && !documents.isError;

  let content: ReactNode;
  let contentKey: string;
  if (documents.isPending) {
    contentKey = 'loading';
    content = <LibrarySkeleton label={t('reader.lib_loading')} />;
  } else if (documents.isError) {
    contentKey = 'error';
    content = (
      <EmptyState
        role="alert"
        art={<IconArt icon={CloudOffIcon} />}
        title={t('reader.load_failed')}
        body={describeError(documents.error)}
        primary={{ label: t('reader.retry'), onClick: () => void documents.refetch() }}
      />
    );
  } else if (!hasDocs) {
    contentKey = 'empty';
    content = (
      <EmptyState
        art={<CoverWall />}
        title={t('reader.empty_title')}
        body={t('reader.empty_body')}
        primary={{ label: t('reader.add_first'), icon: PlusIcon, onClick: () => setAdding(true) }}
        secondary={
          touch
            ? undefined
            : {
                label: t('reader.phone_title'),
                icon: SmartphoneIcon,
                onClick: () => setPhoneOpen(true),
              }
        }
      />
    );
  } else {
    contentKey = 'list';
    const swipeHint = touch ? 'rd-swipe-hint' : undefined;
    content = (
      <>
        {resume && !selection.active && (
          <ContinueCard
            doc={resume}
            playing={playback.activeId === resume.id && playback.playing}
            onPlay={() => playback.play(resume.id)}
          />
        )}
        {!searching && (
          <div className="rd-lib-controls">
            <LibraryTabs
              value={filter}
              onChange={(next) => {
                setFilter(next);
                chrome.scroller.current?.scrollTo({ top: 0 });
              }}
            />
            <button
              type="button"
              className="rd-sort-label"
              aria-label={t('reader.sort_by_current', { sort: t(SORT_LABELS[sort]) })}
              onClick={() => setSorting(true)}
            >
              {t(SORT_LABELS[sort])}
              <ChevronDownIcon aria-hidden="true" />
            </button>
          </div>
        )}
        {swipeHint && (
          <span id={swipeHint} className="sr-only">
            {t('reader.lib_swipe_hint')}
          </span>
        )}
        {visible.length ? (
          <ul
            className="rd-lib-list"
            aria-label={t(searching ? 'reader.search' : FILTER_LABELS[filter])}
          >
            {visible.map((doc) => (
              <DocumentRow
                key={doc.id}
                doc={doc}
                onMore={() => setActionsFor(doc)}
                onLongPress={() => dispatch({ type: 'enter', id: doc.id })}
                swipeHintId={swipeHint}
                selection={{
                  active: selection.active,
                  selected: selection.ids.includes(doc.id),
                  onToggle: () => {
                    tick();
                    dispatch({ type: 'toggle', id: doc.id });
                  },
                }}
              />
            ))}
          </ul>
        ) : searching ? (
          <EmptyState
            compact
            role="status"
            art={<StackedCards icon={SearchIcon} />}
            title={t('reader.lib_search_empty_title')}
            body={t('reader.no_results')}
          />
        ) : filter === 'archived' ? (
          <EmptyState
            compact
            art={<StackedCards icon={ArchiveIcon} />}
            title={t('reader.empty_archived')}
            body={t('reader.lib_empty_archived_hint')}
          />
        ) : filter === 'finished' ? (
          <EmptyState
            compact
            art={<StackedCards icon={CircleCheckIcon} />}
            title={t('reader.empty_finished')}
            body={t('reader.lib_empty_finished_hint')}
          />
        ) : (
          <EmptyState
            compact
            art={<StackedCards icon={PlusIcon} />}
            title={t('reader.empty_title')}
            primary={{
              label: t('reader.add_first'),
              icon: PlusIcon,
              onClick: () => setAdding(true),
            }}
          />
        )}
      </>
    );
  }

  return (
    <div className="rd-root rd-lib" data-slot="reader-library" {...appearance}>
      <header
        className={cn('rd-topbar rd-lib-bar', titlebarChrome())}
        data-scrolled={chrome.scrolled || mode !== 'default'}
        data-mode={mode}
      >
        {mode === 'select' ? (
          <>
            <button
              type="button"
              className="rd-icon-btn"
              aria-label={t('reader.lib_exit_select')}
              onClick={exitSelection}
            >
              <XIcon className="size-5" aria-hidden="true" />
            </button>
            <p className="rd-bar-title" data-shown="" aria-live="polite">
              {selection.ids.length
                ? t('reader.lib_selected', { count: selection.ids.length })
                : t('reader.lib_select_none')}
            </p>
            <button
              type="button"
              className="rd-text-btn rd-press"
              onClick={() => {
                tick();
                dispatch({ type: 'toggle-all', ids: visibleIds });
              }}
            >
              {t('reader.lib_select_all')}
            </button>
          </>
        ) : mode === 'search' ? (
          <>
            <SearchField
              ref={searchInput}
              value={query}
              onChange={setQuery}
              label={t('reader.search')}
              clearLabel={t('reader.clear_search')}
              className="rd-bar-search"
              onKeyDown={(event) => {
                if (event.key !== 'Escape') return;
                event.preventDefault();
                if (query) setQuery('');
                else closeSearch();
              }}
            />
            <button type="button" className="rd-text-btn rd-press" onClick={closeSearch}>
              {t('reader.cancel')}
            </button>
          </>
        ) : (
          <>
            <Link to="/" className="rd-icon-btn" aria-label={t('reader.studio')}>
              <HouseIcon className="size-5" aria-hidden="true" />
            </Link>
            <span
              className="rd-bar-title"
              data-shown={chrome.compact || undefined}
              aria-hidden="true"
            >
              {t('reader.title')}
            </span>
            {!touch && (
              <button
                type="button"
                className="rd-icon-btn"
                aria-label={t('reader.phone_title')}
                onClick={() => setPhoneOpen(true)}
              >
                <SmartphoneIcon className="size-5" aria-hidden="true" />
              </button>
            )}
            {hasDocs && (
              <button
                type="button"
                className="rd-icon-btn"
                aria-label={t('reader.search')}
                onClick={openSearch}
              >
                <SearchIcon className="size-[22px]" aria-hidden="true" />
              </button>
            )}
            <button
              type="button"
              className="rd-icon-btn md:hidden"
              aria-label={t('reader.add_title')}
              onClick={() => setAdding(true)}
            >
              <PlusIcon className="size-6" aria-hidden="true" />
            </button>
            <button
              type="button"
              className="rd-press rd-add-pill hidden md:inline-flex"
              onClick={() => setAdding(true)}
            >
              <PlusIcon className="size-4" aria-hidden="true" />
              {t('reader.add')}
            </button>
            <button
              type="button"
              className="rd-icon-btn"
              aria-label={t('reader.lib_menu')}
              onClick={() => setMenuOpen(true)}
            >
              <EllipsisIcon className="size-[22px]" aria-hidden="true" />
            </button>
          </>
        )}
      </header>

      <main ref={chrome.scroller} className="rd-scroll" onScroll={chrome.onScroll}>
        <div className="rd-column rd-lib-column">
          <h1 ref={chrome.title} className="rd-lib-title" hidden={mode === 'search'}>
            {t('reader.title')}
          </h1>
          {offlineOnly && (
            <p className="rd-lib-banner">
              <CloudOffIcon className="size-4 shrink-0" aria-hidden="true" />
              {t('reader.offline_banner')}
            </p>
          )}
          <div key={contentKey} className="rd-fade" aria-busy={documents.isPending || undefined}>
            {content}
          </div>
        </div>
      </main>

      {selection.active ? (
        <SelectionBar
          docs={selectedDocs}
          onDone={exitSelection}
          onDelete={() => setConfirmDelete(selectedDocs.filter((doc) => !doc.offlineOnly))}
        />
      ) : (
        loaded && <MiniPlayer hidden={chrome.miniHidden} />
      )}
      <AddDocumentSheet
        open={adding}
        onOpenChange={setAdding}
        onCreated={(doc) => {
          setAdding(false);
          if (doc.import_status === 'importing') {
            setFilter('library');
            closeSearch();
            toast(t('reader.import_started', { title: doc.title }));
            return;
          }
          open(doc.id);
        }}
      />
      <SortSheet open={sorting} onOpenChange={setSorting} />
      <LibraryMenu
        open={menuOpen}
        onOpenChange={setMenuOpen}
        onSelect={() => {
          setMenuOpen(false);
          tick();
          dispatch({ type: 'enter' });
        }}
        onSort={() => {
          setMenuOpen(false);
          setSorting(true);
        }}
        onPhone={
          touch
            ? undefined
            : () => {
                setMenuOpen(false);
                setPhoneOpen(true);
              }
        }
      />
      <DocumentActionsSheet doc={actionsFor} onClose={() => setActionsFor(null)} />
      <DeleteManySheet
        docs={confirmDelete}
        onClose={() => setConfirmDelete(null)}
        onDeleted={() => {
          setConfirmDelete(null);
          exitSelection();
        }}
      />
      {!touch && <PhoneSheet open={phoneOpen} onOpenChange={setPhoneOpen} />}
    </div>
  );
}
