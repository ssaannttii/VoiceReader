import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  AlertCircleIcon,
  ArrowDownUpIcon,
  BookOpenTextIcon,
  CheckCircle2Icon,
  CloudOffIcon,
  DownloadIcon,
  HouseIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  SmartphoneIcon,
} from 'lucide-react';
import { describeError } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import { AddDocumentSheet } from './add-document-sheet';
import { CoverTile } from './cover-tile';
import { DocumentActionsSheet } from './document-actions-sheet';
import {
  arrangeLibrary,
  isFinished,
  isReady,
  LIBRARY_FILTERS,
  LIBRARY_SORTS,
  setLibrarySort,
  useLibrarySort,
  type LibraryFilter,
  type LibrarySort,
} from './library-view';
import { MiniPlayer } from './mini-player';
import { useOffline } from './offline-state';
import { PhoneSheet } from './phone-sheet';
import { fetchReaderDocument } from './reader-actions';
import type { ReaderDocumentSummary } from './reader-api';
import { useAppearanceProps } from './reader-appearance';
import { isTouchDevice, searchKey, titlebarChrome } from './reader-chrome';
import { readerPlayer, useReaderPlayer } from './reader-player';
import { ReaderSheet, SheetRow } from './reader-sheet';
import { minutesLeft } from './reader-text';
import { SearchField } from './search-field';
import { useReaderDocuments, type ReaderListItem } from './use-reader-data';
import './reader.css';

const SORT_LABELS: Record<LibrarySort, string> = {
  recent: 'reader.sort_recent',
  progress: 'reader.sort_progress',
  title: 'reader.sort_title',
  added: 'reader.sort_added',
};
const FILTER_LABELS: Record<LibraryFilter, string> = {
  library: 'reader.library',
  archived: 'reader.filter_archived',
  finished: 'reader.filter_finished',
};
const FILTER_EMPTY: Record<LibraryFilter, string> = {
  library: 'reader.no_results',
  archived: 'reader.empty_archived',
  finished: 'reader.empty_finished',
};

function useProgressLabel() {
  const { t } = useTranslation();
  return (doc: ReaderDocumentSummary) => {
    if (isFinished(doc)) return t('reader.finished');
    const remaining = doc.est_duration_s * (1 - Math.min(1, Math.max(0, doc.progress)));
    if (doc.position_segment <= 0)
      return t('reader.minutes_total', { minutes: minutesLeft(doc.est_duration_s) });
    return t('reader.progress_left', {
      percent: Math.max(1, Math.round(doc.progress * 100)),
      minutes: minutesLeft(remaining),
    });
  };
}

function sourceLabel(doc: ReaderDocumentSummary, pasted: string): string {
  return doc.author || doc.source_name || pasted;
}

/** `value` null draws an indeterminate bar (import with no progress figure yet). */
function ProgressBar({ value, className }: { value: number | null; className?: string }) {
  return (
    <div
      className={cn('rd-progress', className)}
      data-indeterminate={value === null ? '' : undefined}
      aria-hidden="true"
    >
      <span
        style={
          value === null ? undefined : { transform: `scaleX(${Math.min(1, Math.max(0, value))})` }
        }
      />
    </div>
  );
}

/** Play from the library without opening the reader; unlocks audio inside the tap. */
function usePlayFromLibrary() {
  const { t } = useTranslation();
  const player = useReaderPlayer();
  return {
    activeId: player.doc?.id ?? null,
    playing: player.status === 'playing' || player.status === 'buffering',
    play: (id: string) => {
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
          action: { label: t('reader.open'), onClick: () => onOpen(doc.id) },
        });
    }
    importing.current = now;
  }, [docs, onOpen, t]);
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
  const label = useProgressLabel();
  return (
    <section aria-labelledby="reader-continue" className="mb-7">
      <h2
        id="reader-continue"
        className="mb-2.5 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground"
      >
        {t('reader.continue')}
      </h2>
      <div className="relative overflow-hidden rounded-[1.6rem] bg-card p-4 shadow-[0_18px_40px_-28px_rgb(0_0_0/0.6)] ring-1 ring-border/70">
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.16] blur-2xl"
          style={{
            background: 'radial-gradient(circle at 20% 10%, var(--primary), transparent 60%)',
          }}
          aria-hidden="true"
        />
        <div className="relative flex items-center gap-4">
          <Link
            to="/reader/$docId"
            params={{ docId: doc.id }}
            className="rd-press flex min-w-0 flex-1 items-center gap-4 rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <CoverTile
              id={doc.id}
              title={doc.title}
              hasCover={doc.has_cover}
              size="lg"
              className="h-28 w-20 text-4xl"
            />
            <span className="min-w-0 flex-1">
              <span className="line-clamp-3 font-[family-name:var(--rd-serif)] text-lg font-semibold leading-snug tracking-tight">
                {doc.title}
              </span>
              <span className="mt-1.5 block text-[13px] leading-snug text-muted-foreground">
                {label(doc)}
              </span>
              <ProgressBar value={doc.progress} className="mt-3" />
            </span>
          </Link>
          <button
            type="button"
            className="rd-play size-14 shrink-0"
            onClick={onPlay}
            aria-label={t(playing ? 'reader.pause' : 'reader.play')}
          >
            {playing ? (
              <PauseIcon className="size-6 fill-current" aria-hidden="true" />
            ) : (
              <PlayIcon className="ml-0.5 size-6 fill-current" aria-hidden="true" />
            )}
          </button>
        </div>
      </div>
    </section>
  );
}

function OfflineBadge({ id }: { id: string }) {
  const { t } = useTranslation();
  const offline = useOffline();
  if (offline.active[id])
    return (
      <Loader2Icon
        className="size-4 shrink-0 animate-spin text-muted-foreground"
        aria-label={t('reader.downloading', {
          percent: Math.round(
            (offline.active[id].stored / Math.max(1, offline.active[id].total)) * 100,
          ),
        })}
      />
    );
  if (offline.downloaded[id]?.complete)
    return <DownloadIcon className="rd-ok size-4 shrink-0" aria-label={t('reader.downloaded')} />;
  return null;
}

const rowClass =
  'rd-press -ml-2 flex min-w-0 flex-1 items-center gap-3.5 rounded-2xl p-2 outline-none focus-visible:ring-2 focus-visible:ring-ring active:bg-foreground/[0.05]';

/** A document still importing in the background, or whose import failed. */
function PendingRow({ doc, onMore }: { doc: ReaderListItem; onMore: () => void }) {
  const { t } = useTranslation();
  const failed = doc.import_status === 'error';
  const progress = typeof doc.import_progress === 'number' ? doc.import_progress : null;
  return (
    <li className="flex items-center gap-1">
      <div className={cn(rowClass, 'cursor-default active:bg-transparent')} aria-disabled="true">
        <CoverTile
          id={doc.id}
          title={doc.title}
          hasCover={false}
          className={cn(!failed && 'opacity-60')}
        />
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 text-[15px] font-semibold leading-snug">{doc.title}</span>
          {failed ? (
            <>
              <span className="mt-1 flex items-start gap-1.5 text-[13px] text-destructive">
                <AlertCircleIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                <span className="line-clamp-2">
                  {doc.import_error || t('reader.import_failed')}
                </span>
              </span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                {t('reader.import_error_hint')}
              </span>
            </>
          ) : (
            <>
              <span className="mt-1 flex items-center gap-1.5 text-[13px] text-muted-foreground">
                <Loader2Icon className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
                {progress === null
                  ? t('reader.importing')
                  : t('reader.importing_percent', { percent: Math.round(progress * 100) })}
              </span>
              <ProgressBar value={progress} className="mt-2 max-w-48" />
            </>
          )}
        </span>
      </div>
      <button
        type="button"
        className="rd-icon-btn -mr-2 text-muted-foreground"
        aria-label={t('reader.more_actions', { title: doc.title })}
        onClick={onMore}
      >
        <MoreHorizontalIcon className="size-5" aria-hidden="true" />
      </button>
    </li>
  );
}

function DocumentRow({ doc, onMore }: { doc: ReaderListItem; onMore: () => void }) {
  const { t } = useTranslation();
  const label = useProgressLabel();
  if (!isReady(doc)) return <PendingRow doc={doc} onMore={onMore} />;
  const finished = isFinished(doc);
  return (
    <li className="flex items-center gap-1">
      <Link to="/reader/$docId" params={{ docId: doc.id }} className={rowClass}>
        <CoverTile id={doc.id} title={doc.title} hasCover={doc.has_cover} />
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 text-[15px] font-semibold leading-snug">{doc.title}</span>
          <span className="mt-1 flex min-w-0 items-center gap-1.5 text-[13px] text-muted-foreground">
            <span className="truncate">{sourceLabel(doc, t('reader.source_text'))}</span>
            <span aria-hidden="true">·</span>
            <span className="shrink-0">{label(doc)}</span>
            {finished && <CheckCircle2Icon className="size-3.5 shrink-0" aria-hidden="true" />}
          </span>
          {doc.progress > 0 && !finished && (
            <ProgressBar value={doc.progress} className="mt-2 max-w-48" />
          )}
        </span>
        <OfflineBadge id={doc.id} />
      </Link>
      {!doc.offlineOnly && (
        <button
          type="button"
          className="rd-icon-btn -mr-2 text-muted-foreground"
          aria-label={t('reader.more_actions', { title: doc.title })}
          onClick={onMore}
        >
          <MoreHorizontalIcon className="size-5" aria-hidden="true" />
        </button>
      )}
    </li>
  );
}

function LibrarySkeleton() {
  return (
    <div className="space-y-5 pt-2" aria-hidden="true">
      <div className="rd-skeleton h-40 rounded-[1.6rem]" />
      {[0, 1, 2, 3].map((index) => (
        <div key={index} className="flex items-center gap-3.5">
          <div className="rd-skeleton h-[4.5rem] w-14 rounded-[0.7rem]" />
          <div className="flex-1 space-y-2">
            <div className="rd-skeleton h-4 w-3/4" />
            <div className="rd-skeleton h-3 w-1/2" />
          </div>
        </div>
      ))}
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
              setLibrarySort(option);
              onOpenChange(false);
            }}
          />
        ))}
      </div>
    </ReaderSheet>
  );
}

export function ReaderLibraryPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const appearance = useAppearanceProps();
  const documents = useReaderDocuments();
  const playback = usePlayFromLibrary();
  const sort = useLibrarySort();
  const [filter, setFilter] = useState<LibraryFilter>('library');
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const [sorting, setSorting] = useState(false);
  const [phoneOpen, setPhoneOpen] = useState(false);
  const [actionsFor, setActionsFor] = useState<ReaderListItem | null>(null);
  const [scrolled, setScrolled] = useState(false);
  const docs = useMemo(() => documents.data ?? [], [documents.data]);
  const offlineOnly = docs.some((doc) => doc.offlineOnly);
  const filtered = useMemo(() => {
    const needle = searchKey(query.trim());
    const arranged = arrangeLibrary(docs, sort, filter);
    if (!needle) return arranged;
    return arranged.filter((doc) =>
      searchKey(`${doc.title} ${doc.author ?? ''} ${doc.source_name ?? ''}`).includes(needle),
    );
  }, [docs, query, sort, filter]);
  const resume =
    query.trim() || filter !== 'library'
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
  const touch = isTouchDevice();
  return (
    <div className="rd-root" data-slot="reader-library" {...appearance}>
      <header className={cn('rd-topbar', titlebarChrome())} data-scrolled={scrolled}>
        <Link to="/" className="rd-icon-btn" aria-label={t('reader.studio')}>
          <HouseIcon className="size-5" aria-hidden="true" />
        </Link>
        <h1 className="min-w-0 flex-1 truncate px-1 text-lg font-semibold tracking-tight">
          {t('reader.title')}
        </h1>
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
        <button
          type="button"
          className="rd-press ml-1 inline-flex h-10 items-center gap-1.5 rounded-full bg-foreground px-4 text-sm font-semibold text-background"
          onClick={() => setAdding(true)}
        >
          <PlusIcon className="size-4" aria-hidden="true" />
          {t('reader.add')}
        </button>
      </header>

      <main
        className="rd-scroll"
        onScroll={(event) => setScrolled(event.currentTarget.scrollTop > 4)}
      >
        <div className="rd-column pb-[calc(7rem+env(safe-area-inset-bottom,0px))] pt-3">
          {docs.length > 0 && (
            <SearchField
              value={query}
              onChange={setQuery}
              label={t('reader.search')}
              clearLabel={t('reader.clear_search')}
              className="mb-5"
            />
          )}

          {offlineOnly && (
            <p className="rd-warn mb-5 flex items-center gap-2 rounded-2xl bg-amber-500/10 px-4 py-3 text-sm">
              <CloudOffIcon className="size-4 shrink-0" aria-hidden="true" />
              {t('reader.offline_banner')}
            </p>
          )}

          {documents.isPending ? (
            <LibrarySkeleton />
          ) : documents.isError ? (
            <div className="flex flex-col items-center gap-3 py-20 text-center" role="alert">
              <CloudOffIcon className="size-9 text-muted-foreground" aria-hidden="true" />
              <p className="text-base font-semibold">{t('reader.load_failed')}</p>
              <p className="max-w-sm text-sm text-muted-foreground">
                {describeError(documents.error)}
              </p>
              <button
                type="button"
                className="rd-press mt-2 h-11 rounded-full bg-foreground px-6 text-sm font-semibold text-background"
                onClick={() => void documents.refetch()}
              >
                {t('reader.retry')}
              </button>
            </div>
          ) : docs.length === 0 ? (
            <div className="flex flex-col items-center gap-3 px-4 py-20 text-center">
              <div className="mb-2 flex size-20 items-center justify-center rounded-[1.6rem] bg-foreground/[0.06]">
                <BookOpenTextIcon className="size-9 text-muted-foreground" aria-hidden="true" />
              </div>
              <p className="text-lg font-semibold tracking-tight">{t('reader.empty_title')}</p>
              <p className="max-w-xs text-sm leading-relaxed text-muted-foreground">
                {t('reader.empty_body')}
              </p>
              <button
                type="button"
                className="rd-press mt-3 inline-flex h-12 items-center gap-2 rounded-full bg-foreground px-6 text-[15px] font-semibold text-background"
                onClick={() => setAdding(true)}
              >
                <PlusIcon className="size-4" aria-hidden="true" />
                {t('reader.add_first')}
              </button>
            </div>
          ) : (
            <>
              {resume && (
                <ContinueCard
                  doc={resume}
                  playing={playback.activeId === resume.id && playback.playing}
                  onPlay={() => playback.play(resume.id)}
                />
              )}
              <section aria-label={t(FILTER_LABELS[filter])}>
                <div className="mb-2 flex items-center gap-2">
                  <div
                    className="-mx-1 flex min-w-0 flex-1 gap-1.5 overflow-x-auto px-1 py-0.5"
                    role="group"
                    aria-label={t('reader.filter')}
                  >
                    {LIBRARY_FILTERS.map((option) => (
                      <button
                        key={option}
                        type="button"
                        className="rd-chip shrink-0"
                        aria-pressed={filter === option}
                        onClick={() => setFilter(option)}
                      >
                        {t(FILTER_LABELS[option])}
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="rd-icon-btn text-muted-foreground"
                    aria-label={t('reader.sort_by_current', { sort: t(SORT_LABELS[sort]) })}
                    title={t(SORT_LABELS[sort])}
                    onClick={() => setSorting(true)}
                  >
                    <ArrowDownUpIcon className="size-5" aria-hidden="true" />
                  </button>
                </div>
                {filtered.length ? (
                  <ul className="space-y-0.5">
                    {filtered.map((doc) => (
                      <DocumentRow key={doc.id} doc={doc} onMore={() => setActionsFor(doc)} />
                    ))}
                  </ul>
                ) : (
                  <p className="py-10 text-center text-sm text-muted-foreground">
                    {t(query.trim() ? 'reader.no_results' : FILTER_EMPTY[filter])}
                  </p>
                )}
              </section>
            </>
          )}
        </div>
      </main>

      <MiniPlayer />
      <AddDocumentSheet
        open={adding}
        onOpenChange={setAdding}
        onCreated={(doc) => {
          setAdding(false);
          if (doc.import_status === 'importing') {
            setFilter('library');
            toast(t('reader.import_started', { title: doc.title }));
            return;
          }
          open(doc.id);
        }}
      />
      <SortSheet open={sorting} onOpenChange={setSorting} />
      <DocumentActionsSheet doc={actionsFor} onClose={() => setActionsFor(null)} />
      {!touch && <PhoneSheet open={phoneOpen} onOpenChange={setPhoneOpen} />}
    </div>
  );
}
