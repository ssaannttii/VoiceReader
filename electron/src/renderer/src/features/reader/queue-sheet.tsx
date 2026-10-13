import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  ChevronDownIcon,
  ChevronUpIcon,
  ListPlusIcon,
  ListXIcon,
  PlayIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react';
import { describeError } from '@/lib/api/client';
import { CoverTile } from './cover-tile';
import { fetchReaderDocument } from './reader-actions';
import { readerPlayer, useReaderPlayer } from './reader-player';
import {
  addToQueue,
  clearQueue,
  moveInQueue,
  removeFromQueue,
  useReaderQueue,
  type QueueItem,
} from './reader-queue';
import { ReaderSheet, SheetRow } from './reader-sheet';

/** Play a queued document now: it leaves the queue and replaces what plays. */
export function playQueuedNow(id: string, onError: (error: unknown) => void) {
  removeFromQueue(id);
  readerPlayer.unlockFromGesture();
  fetchReaderDocument(id)
    .then((doc) => {
      readerPlayer.load(doc);
      readerPlayer.play();
    })
    .catch(onError);
}

/** "Add to queue" / "Remove from queue" row for a document's menus. */
export function QueueRow({
  doc,
  onDone,
}: {
  doc: { id: string; title: string; has_cover: boolean };
  onDone?: () => void;
}) {
  const { t } = useTranslation();
  const queue = useReaderQueue();
  const queued = queue.some((item) => item.id === doc.id);
  return (
    <SheetRow
      icon={queued ? ListXIcon : ListPlusIcon}
      label={t(queued ? 'reader.queue_remove' : 'reader.queue_add')}
      detail={queued ? undefined : t('reader.queue_hint')}
      onClick={() => {
        if (queued) {
          removeFromQueue(doc.id);
          toast(t('reader.queue_removed'));
        } else {
          addToQueue({ id: doc.id, title: doc.title, hasCover: doc.has_cover });
          toast.success(t('reader.queue_added', { title: doc.title }));
        }
        onDone?.();
      }}
    />
  );
}

function QueueEntry({
  item,
  onMove,
}: {
  item: QueueItem;
  /** Swap with the previous (-1) or next (1) shown entry; null at that end. */
  onMove: (direction: -1 | 1) => (() => void) | null;
}) {
  const { t } = useTranslation();
  const title = item.title || t('reader.title');
  const up = onMove(-1);
  const down = onMove(1);
  return (
    <li className="flex items-center gap-0.5">
      <button
        type="button"
        className="rd-sheet-row min-w-0 flex-1 gap-3 pl-1"
        aria-label={t('reader.queue_play_now_named', { title })}
        onClick={() =>
          playQueuedNow(item.id, (error) =>
            toast.error(t('reader.load_failed'), { description: describeError(error) }),
          )
        }
      >
        <CoverTile id={item.id} title={title} hasCover={item.hasCover} size="sm" />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{title}</span>
          <span className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
            <PlayIcon className="size-3 fill-current" aria-hidden="true" />
            {t('reader.queue_play_now')}
          </span>
        </span>
      </button>
      <button
        type="button"
        className="rd-icon-btn text-muted-foreground"
        aria-label={t('reader.queue_move_up', { title })}
        disabled={!up}
        onClick={() => up?.()}
      >
        <ChevronUpIcon className="size-5" aria-hidden="true" />
      </button>
      <button
        type="button"
        className="rd-icon-btn text-muted-foreground"
        aria-label={t('reader.queue_move_down', { title })}
        disabled={!down}
        onClick={() => down?.()}
      >
        <ChevronDownIcon className="size-5" aria-hidden="true" />
      </button>
      <button
        type="button"
        className="rd-icon-btn text-muted-foreground"
        aria-label={t('reader.queue_remove_named', { title })}
        onClick={() => removeFromQueue(item.id)}
      >
        <XIcon className="size-5" aria-hidden="true" />
      </button>
    </li>
  );
}

/** "Up next": the per-device queue, with reorder, remove and play now. */
export function QueueSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const queue = useReaderQueue();
  const { doc } = useReaderPlayer();
  // The playing document is shown above the queue, not in it.
  const items = queue.filter((item) => item.id !== doc?.id);
  return (
    <ReaderSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t('reader.queue')}
      description={t('reader.queue_hint')}
    >
      <div className="pb-1">
        {doc && (
          <section className="mb-2">
            <h3 className="px-3 pb-1 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              {t('reader.queue_now_playing')}
            </h3>
            <div className="flex items-center gap-3 px-3 py-1.5">
              <CoverTile id={doc.id} title={doc.title} hasCover={doc.has_cover} size="sm" />
              <span className="min-w-0 flex-1 truncate font-medium">{doc.title}</span>
            </div>
          </section>
        )}
        {items.length ? (
          <>
            <h3 className="px-3 pb-1 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              {t('reader.queue')}
            </h3>
            <ol className="space-y-0.5">
              {items.map((item, index) => (
                <QueueEntry
                  key={item.id}
                  item={item}
                  onMove={(direction) => {
                    const other = items[index + direction];
                    return other
                      ? () => moveInQueue(queue.indexOf(item), queue.indexOf(other))
                      : null;
                  }}
                />
              ))}
            </ol>
            <div className="mt-2 border-t border-border/60 pt-2">
              <SheetRow
                icon={Trash2Icon}
                label={t('reader.queue_clear')}
                destructive
                onClick={() => clearQueue()}
              />
            </div>
          </>
        ) : (
          <p className="px-3 py-8 text-center text-sm leading-relaxed text-muted-foreground">
            {t('reader.queue_empty')}
          </p>
        )}
      </div>
    </ReaderSheet>
  );
}
