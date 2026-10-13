import { useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ArrowDownToLineIcon,
  CheckIcon,
  CircleCheckIcon,
  CircleIcon,
  ClockIcon,
  CloudDownloadIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  RotateCcwIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from 'lucide-react';
import { ApiError, describeError } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import { CoverTile } from './cover-tile';
import { deleteWithUndo, setFlagsWithUndo, toggleDownload } from './library-actions';
import {
  coverArt,
  coverShape,
  isFinished,
  isReady,
  isUnread,
  rowStatus,
  splitMinutes,
} from './library-view';
import { useOffline } from './offline-state';
import { readerApi, readerKeys, type ReaderDocumentSummary } from './reader-api';
import { SwipeRow, type SwipeAction } from './swipe-row';
import type { ReaderListItem } from './use-reader-data';

type Doc = ReaderDocumentSummary;

export function sourceLabel(doc: Doc, t: (key: string) => string): string {
  if (doc.author) return doc.author;
  if (doc.source_type === 'scan') return t('reader.lib_source_scan');
  return doc.source_name || t('reader.source_text');
}

/** "25 min", "3 h 10 min" (total) or the same with "left". */
export function durationLabel(
  t: (key: string, options?: Record<string, unknown>) => string,
  total: number,
  left: boolean,
): string {
  const { hours, minutes } = splitMinutes(total);
  if (!hours) return t(left ? 'reader.lib_minutes_left' : 'reader.minutes_total', { minutes });
  return t(left ? 'reader.lib_hours_left' : 'reader.lib_hours_total', { hours, minutes });
}

/** Cover in its 2:3 or square shape, with the import ring, error badge or selection check. */
export function RowCover({
  doc,
  size = 'md',
  progress,
  failed,
  selected,
}: {
  doc: Doc;
  size?: 'sm' | 'md' | 'lg';
  /** Import progress 0–1, `null` for indeterminate, undefined when not importing. */
  progress?: number | null;
  failed?: boolean;
  /** undefined outside select mode. */
  selected?: boolean;
}) {
  return (
    <span className="rd-cover-slot" data-size={size}>
      <CoverTile
        id={doc.id}
        title={doc.title}
        hasCover={doc.has_cover}
        shape={coverShape(doc)}
        art={coverArt(doc)}
        size={size}
        className={cn(progress !== undefined && 'rd-cover-dim')}
      />
      {progress !== undefined && <ProgressRing value={progress} />}
      {failed && (
        <span className="rd-cover-badge" aria-hidden="true">
          <TriangleAlertIcon />
        </span>
      )}
      {selected !== undefined && (
        <span className="rd-cover-check" data-checked={selected || undefined} aria-hidden="true">
          {selected && <CheckIcon strokeWidth={3} />}
        </span>
      )}
    </span>
  );
}

function ProgressRing({ value }: { value: number | null }) {
  const r = 11;
  const length = 2 * Math.PI * r;
  return (
    <svg
      className="rd-ring"
      viewBox="0 0 28 28"
      data-indeterminate={value === null || undefined}
      aria-hidden="true"
    >
      <circle cx="14" cy="14" r={r} className="rd-ring-track" />
      <circle
        cx="14"
        cy="14"
        r={r}
        className="rd-ring-fill"
        strokeDasharray={length}
        strokeDashoffset={value === null ? length * 0.7 : length * (1 - Math.min(1, value))}
      />
    </svg>
  );
}

/** "12 min", "17 % · 25 min left" or "Finished", plus the download state. */
function StatusLine({ doc }: { doc: ReaderListItem }) {
  const { t } = useTranslation();
  const offline = useOffline();
  const status = rowStatus(doc);
  const active = offline.active[doc.id];
  const downloaded = offline.downloaded[doc.id]?.complete;
  return (
    <span className="rd-row-status">
      {status.kind === 'finished' ? (
        <>
          <CircleCheckIcon aria-hidden="true" />
          {t('reader.finished')}
        </>
      ) : status.kind === 'new' ? (
        <>
          <ClockIcon aria-hidden="true" />
          {durationLabel(t, status.minutes, false)}
        </>
      ) : (
        <>
          {t('reader.search_position', { percent: status.percent })}
          <span aria-hidden="true">·</span>
          {durationLabel(t, status.minutes, true)}
        </>
      )}
      {active ? (
        <>
          <span aria-hidden="true">·</span>
          <Loader2Icon className="animate-spin" aria-hidden="true" />
          {t('reader.downloading', {
            percent: Math.round((active.stored / Math.max(1, active.total)) * 100),
          })}
        </>
      ) : downloaded ? (
        <>
          <span aria-hidden="true">·</span>
          <ArrowDownToLineIcon className="rd-ok" aria-label={t('reader.downloaded')} />
        </>
      ) : null}
    </span>
  );
}

function MoreButton({ doc, onMore }: { doc: Doc; onMore: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className="rd-icon-btn rd-row-more"
      aria-label={t('reader.more_actions', { title: doc.title })}
      onClick={onMore}
    >
      <MoreHorizontalIcon className="size-5" aria-hidden="true" />
    </button>
  );
}

/** Swipe actions for a ready document; every one is also in its ••• sheet. */
function useSwipeActions(doc: ReaderListItem): { start: SwipeAction[]; end: SwipeAction[] } {
  const { t } = useTranslation();
  const offline = useOffline();
  if (doc.offlineOnly) return { start: [], end: [] };
  const finished = isFinished(doc);
  const downloaded = offline.downloaded[doc.id]?.complete;
  const active = Boolean(offline.active[doc.id]);
  const start: SwipeAction[] = [
    {
      key: 'download',
      label: t(
        active
          ? 'reader.cancel_download'
          : downloaded
            ? 'reader.remove_download'
            : 'reader.lib_download_short',
      ),
      icon: downloaded ? Trash2Icon : CloudDownloadIcon,
      tone: 'neutral',
      run: () => toggleDownload(doc),
    },
  ];
  if (doc.archived)
    return {
      start,
      end: [
        {
          key: 'restore',
          label: t('reader.unarchive'),
          icon: ArchiveRestoreIcon,
          tone: 'positive',
          run: () => void setFlagsWithUndo([doc], { archived: false }, t('reader.unarchived')),
        },
        {
          key: 'delete',
          label: t('reader.delete'),
          icon: Trash2Icon,
          tone: 'danger',
          run: () => deleteWithUndo(doc),
        },
      ],
    };
  const end: SwipeAction[] = [];
  if (typeof doc.completed === 'boolean')
    end.push({
      key: 'finished',
      label: t(finished ? 'reader.lib_unread_short' : 'reader.finished'),
      icon: finished ? CircleIcon : CircleCheckIcon,
      tone: 'accent',
      run: () =>
        void setFlagsWithUndo(
          [doc],
          { completed: !finished },
          t(finished ? 'reader.marked_unread' : 'reader.marked_finished'),
        ),
    });
  if (typeof doc.archived === 'boolean')
    end.push({
      key: 'archive',
      label: t('reader.archive'),
      icon: ArchiveIcon,
      tone: 'positive',
      run: () => void setFlagsWithUndo([doc], { archived: true }, t('reader.archived')),
    });
  return { start, end };
}

export interface RowSelection {
  active: boolean;
  selected: boolean;
  onToggle: () => void;
}

function RowBody({
  doc,
  cover,
  status,
  trailing,
}: {
  doc: Doc;
  cover: ReactNode;
  status: ReactNode;
  trailing?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <>
      {cover}
      <span className="rd-row-text">
        <span className="rd-row-title">{doc.title}</span>
        <span className="rd-row-meta">{sourceLabel(doc, t)}</span>
        {status}
      </span>
      {trailing}
    </>
  );
}

/** A library row: opens the reader on tap, swipes on touch, selects in select mode. */
export function DocumentRow({
  doc,
  onMore,
  selection,
  onLongPress,
  swipeHintId,
}: {
  doc: ReaderListItem;
  onMore: () => void;
  selection: RowSelection;
  onLongPress: () => void;
  swipeHintId?: string;
}) {
  const { t } = useTranslation();
  const swipe = useSwipeActions(doc);
  if (!isReady(doc)) return <PendingRow doc={doc} onMore={onMore} selection={selection} />;
  const unread = isUnread(doc);
  const body = (
    <RowBody
      doc={doc}
      cover={<RowCover doc={doc} selected={selection.active ? selection.selected : undefined} />}
      status={<StatusLine doc={doc} />}
      trailing={
        unread ? <span className="rd-row-dot" role="img" aria-label={t('reader.lib_new')} /> : null
      }
    />
  );
  return (
    <SwipeRow
      start={swipe.start}
      end={swipe.end}
      disabled={selection.active}
      onLongPress={doc.offlineOnly ? undefined : onLongPress}
      aria-describedby={swipeHintId}
    >
      <div className="rd-row" data-selected={(selection.active && selection.selected) || undefined}>
        {selection.active ? (
          <button
            type="button"
            className="rd-row-main"
            aria-pressed={selection.selected}
            onClick={selection.onToggle}
          >
            {body}
          </button>
        ) : (
          <Link to="/reader/$docId" params={{ docId: doc.id }} className="rd-row-main">
            {body}
          </Link>
        )}
        {!doc.offlineOnly && !selection.active && <MoreButton doc={doc} onMore={onMore} />}
      </div>
    </SwipeRow>
  );
}

/** A document still importing in the background, or whose import failed. */
function PendingRow({
  doc,
  onMore,
  selection,
}: {
  doc: ReaderListItem;
  onMore: () => void;
  selection: RowSelection;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [retrying, setRetrying] = useState(false);
  const failed = doc.import_status === 'error';
  const progress = typeof doc.import_progress === 'number' ? doc.import_progress : null;
  const retry = () => {
    setRetrying(true);
    readerApi
      .retryImport(doc.id)
      .then((summary) => {
        // The list polls while a row is importing.
        queryClient.setQueryData<ReaderListItem[]>(readerKeys.documents, (list) =>
          list?.map((item) => (item.id === summary.id ? { ...item, ...summary } : item)),
        );
        void queryClient.invalidateQueries({ queryKey: readerKeys.documents });
      })
      .catch((error: unknown) =>
        toast.error(t('reader.import_retry_failed'), {
          // 409: the upload is gone; the file has to be added again.
          description:
            error instanceof ApiError && error.status === 409
              ? t('reader.import_error_hint')
              : describeError(error),
        }),
      )
      .finally(() => setRetrying(false));
  };
  const selecting = selection.active;
  const body = (
    <RowBody
      doc={doc}
      cover={
        <RowCover
          doc={doc}
          progress={failed ? undefined : progress}
          failed={failed}
          selected={selecting ? selection.selected : undefined}
        />
      }
      status={
        failed ? (
          <>
            <span className="rd-row-status" data-tone="danger">
              <span className="line-clamp-2">{doc.import_error || t('reader.import_failed')}</span>
            </span>
            {!selecting && (
              <button
                type="button"
                className="rd-press rd-row-retry"
                disabled={retrying}
                onClick={retry}
              >
                {retrying ? (
                  <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <RotateCcwIcon className="size-4" aria-hidden="true" />
                )}
                {t('reader.import_retry')}
              </button>
            )}
          </>
        ) : (
          <span className="rd-row-status">
            {progress === null
              ? t('reader.importing')
              : t('reader.importing_percent', { percent: Math.round(progress * 100) })}
          </span>
        )
      }
    />
  );
  return (
    <SwipeRow
      end={
        failed && !selecting
          ? [
              {
                key: 'delete',
                label: t('reader.delete'),
                icon: Trash2Icon,
                tone: 'danger',
                run: () => deleteWithUndo(doc),
              },
            ]
          : []
      }
      disabled={selecting}
    >
      <div className="rd-row" data-pending={failed ? undefined : ''}>
        {selecting ? (
          <button
            type="button"
            className="rd-row-main"
            aria-pressed={selection.selected}
            onClick={selection.onToggle}
          >
            {body}
          </button>
        ) : (
          <div className="rd-row-main" aria-disabled={failed ? undefined : 'true'}>
            {body}
          </div>
        )}
        {!selecting && <MoreButton doc={doc} onMore={onMore} />}
      </div>
    </SwipeRow>
  );
}
