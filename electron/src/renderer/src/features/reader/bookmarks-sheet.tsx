import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  BookmarkPlusIcon,
  FileDownIcon,
  Loader2Icon,
  PencilIcon,
  PlayIcon,
  Trash2Icon,
} from 'lucide-react';
import { createObjectUrl, revokeObjectUrl } from '@/lib/audio/object-url';
import { describeError } from '@/lib/api/client';
import { queryClient } from '@/lib/query';
import {
  bookmarkSnippet,
  bookmarkText,
  exportFileName,
  formatRelative,
  groupBookmarks,
} from './bookmarks';
import { FOLLOW_EVENT } from './player-sheets';
import { readerApi, readerKeys, type ReaderBookmark, type ReaderDocument } from './reader-api';
import { revealSegment } from './reader-events';
import { readerPlayer } from './reader-player';
import { ReaderSheet, SheetRow } from './reader-sheet';
import { tr } from '@/lib/i18n-text';

export function useBookmarks(docId: string, enabled = true) {
  return useQuery({
    queryKey: readerKeys.bookmarks(docId),
    queryFn: ({ signal }) => readerApi.bookmarks(docId, signal),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

function setBookmarks(docId: string, update: (list: ReaderBookmark[]) => ReaderBookmark[]) {
  queryClient.setQueryData<ReaderBookmark[]>(readerKeys.bookmarks(docId), (list) =>
    update(list ?? []),
  );
}

async function deleteBookmark(docId: string, mark: ReaderBookmark) {
  await readerApi.deleteBookmark(mark.id);
  setBookmarks(docId, (list) => list.filter((item) => item.id !== mark.id));
}

/** Where "add bookmark" points: the spoken sentence, else the saved position. */
export function bookmarkSegment(doc: ReaderDocument): number {
  const player = readerPlayer.getState();
  const segment = player.doc?.id === doc.id ? player.segment : doc.position_segment;
  return Math.min(Math.max(0, segment), Math.max(0, doc.segments.length - 1));
}

/**
 * Bookmark the current position; the toast offers "Undo" and "Add note"
 * (`onAddNote` opens the bookmarks sheet editing it).
 */
export async function addBookmarkHere(
  doc: ReaderDocument,
  onAddNote: (id: string) => void,
): Promise<void> {
  if (!doc.segments.length) return;
  try {
    const mark = await readerApi.addBookmark(doc.id, { segment: bookmarkSegment(doc) });
    setBookmarks(doc.id, (list) => [...list.filter((item) => item.id !== mark.id), mark]);
    toast.success(tr('reader.bookmark_saved'), {
      action: { label: tr('reader.bookmark_add_note'), onClick: () => onAddNote(mark.id) },
      cancel: {
        label: tr('reader.undo'),
        onClick: () =>
          void deleteBookmark(doc.id, mark).catch((error: unknown) =>
            toast.error(describeError(error)),
          ),
      },
    });
  } catch (error) {
    toast.error(tr('reader.bookmark_failed'), { description: describeError(error) });
  }
}

/** Save the Markdown export with a normal browser download. */
async function exportBookmarks(doc: ReaderDocument) {
  const blob = await readerApi.exportBookmarks(doc.id);
  const url = createObjectUrl(blob);
  if (!url) throw new Error(tr('reader.bookmarks_export_failed'));
  const link = document.createElement('a');
  link.href = url;
  link.download = exportFileName(doc.title);
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => revokeObjectUrl(url), 10_000);
}

export function BookmarksSheet({
  doc,
  open,
  onOpenChange,
  editing,
  onEditing,
}: {
  doc: ReaderDocument;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Bookmark whose note is being edited (from the toast's "Add note"). */
  editing: string | null;
  onEditing: (id: string | null) => void;
}) {
  const { t, i18n } = useTranslation();
  const bookmarks = useBookmarks(doc.id, open);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const groups = useMemo(
    () => groupBookmarks(bookmarks.data ?? [], doc.chapters),
    [bookmarks.data, doc.chapters],
  );
  const now = useMemo(() => Date.now() / 1000, [open, bookmarks.data]);

  useEffect(() => {
    const mark = bookmarks.data?.find((item) => item.id === editing);
    setNote(mark?.note ?? '');
  }, [editing, bookmarks.data]);

  const reveal = (mark: ReaderBookmark) => {
    revealSegment(mark.segment);
    onOpenChange(false);
  };

  const listen = (mark: ReaderBookmark) => {
    readerPlayer.unlockFromGesture();
    if (readerPlayer.getState().doc?.id !== doc.id) readerPlayer.load(doc);
    readerPlayer.seekSegment(mark.segment, true);
    window.dispatchEvent(new Event(FOLLOW_EVENT));
    onOpenChange(false);
  };

  const saveNote = async (event: FormEvent, mark: ReaderBookmark) => {
    event.preventDefault();
    setBusy(mark.id);
    try {
      const saved = await readerApi.updateBookmark(mark.id, note.trim() || null);
      setBookmarks(doc.id, (list) => list.map((item) => (item.id === saved.id ? saved : item)));
      onEditing(null);
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (mark: ReaderBookmark) => {
    setBusy(mark.id);
    try {
      await deleteBookmark(doc.id, mark);
      toast.success(t('reader.bookmark_deleted'), {
        action: {
          label: t('reader.undo'),
          onClick: () =>
            void readerApi
              .addBookmark(doc.id, { segment: mark.segment, word: mark.word, note: mark.note })
              .then((restored) => setBookmarks(doc.id, (list) => [...list, restored]))
              .catch((error: unknown) => toast.error(describeError(error))),
        },
      });
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setBusy(null);
    }
  };

  const runExport = () => {
    setExporting(true);
    exportBookmarks(doc)
      .catch((error: unknown) =>
        toast.error(t('reader.bookmarks_export_failed'), { description: describeError(error) }),
      )
      .finally(() => setExporting(false));
  };

  const list = bookmarks.data ?? [];
  return (
    <ReaderSheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onEditing(null);
        onOpenChange(next);
      }}
      title={t('reader.bookmarks')}
      keyboard={editing !== null}
    >
      <div className="pb-1">
        <SheetRow
          icon={BookmarkPlusIcon}
          label={t('reader.bookmark_add')}
          onClick={() => void addBookmarkHere(doc, onEditing)}
        />
        {bookmarks.isPending && (
          <div className="space-y-2 py-2" aria-hidden="true">
            {[0, 1].map((index) => (
              <div key={index} className="rd-skeleton h-16" />
            ))}
          </div>
        )}
        {bookmarks.isError && (
          <p className="px-3 py-4 text-sm text-destructive" role="alert">
            {describeError(bookmarks.error)}
          </p>
        )}
        {bookmarks.isSuccess && !list.length && (
          <p className="px-6 py-8 text-center text-sm leading-relaxed text-muted-foreground">
            {t('reader.bookmarks_empty')}
          </p>
        )}
        {groups.map((group) => (
          <section key={`${group.chapter}-${group.items[0]?.id}`} className="mt-3">
            {group.title && (
              <h3 className="truncate px-3 pb-1 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                {group.title}
              </h3>
            )}
            <ul className="space-y-1">
              {group.items.map((mark) => (
                <li key={mark.id} className="rounded-2xl bg-foreground/[0.035]">
                  <button
                    type="button"
                    className="rd-press block w-full rounded-2xl px-3 pb-1 pt-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => reveal(mark)}
                  >
                    <span className="block text-xs text-muted-foreground">
                      {formatRelative(mark.created_at, now, i18n.language, t('reader.just_now'))}
                    </span>
                    <span className="mt-0.5 line-clamp-3 font-[family-name:var(--rd-serif)] text-[0.95rem] leading-snug">
                      {bookmarkSnippet(bookmarkText(doc.segments, mark.segment)) ||
                        t('reader.bookmark_missing')}
                    </span>
                    {mark.note && editing !== mark.id && (
                      <span className="mt-1.5 block whitespace-pre-line border-l-2 border-[var(--rd-accent)] pl-2 text-sm text-muted-foreground">
                        {mark.note}
                      </span>
                    )}
                  </button>
                  {editing === mark.id ? (
                    <form
                      className="space-y-2 px-3 pb-3 pt-1"
                      onSubmit={(event) => void saveNote(event, mark)}
                    >
                      <label className="block">
                        <span className="sr-only">{t('reader.bookmark_note')}</span>
                        <textarea
                          className="rd-input min-h-24 resize-none leading-relaxed"
                          value={note}
                          onChange={(event) => setNote(event.target.value)}
                          placeholder={t('reader.bookmark_note_placeholder')}
                          maxLength={10_000}
                          autoFocus
                        />
                      </label>
                      <div className="grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          className="rd-press h-11 rounded-full bg-foreground/[0.07] text-sm font-semibold"
                          onClick={() => onEditing(null)}
                        >
                          {t('reader.cancel')}
                        </button>
                        <button
                          type="submit"
                          disabled={busy === mark.id}
                          className="rd-press flex h-11 items-center justify-center gap-2 rounded-full bg-foreground text-sm font-semibold text-background disabled:opacity-40"
                        >
                          {busy === mark.id && (
                            <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
                          )}
                          {t('reader.save')}
                        </button>
                      </div>
                    </form>
                  ) : (
                    <div className="flex items-center gap-1 px-1 pb-1">
                      <button
                        type="button"
                        className="rd-press inline-flex h-11 items-center gap-1.5 rounded-full px-3 text-sm font-medium"
                        onClick={() => listen(mark)}
                      >
                        <PlayIcon className="size-3.5 fill-current" aria-hidden="true" />
                        {t('reader.listen_from_here')}
                      </button>
                      <span className="flex-1" />
                      <button
                        type="button"
                        className="rd-icon-btn text-muted-foreground"
                        aria-label={t(
                          mark.note ? 'reader.bookmark_edit_note' : 'reader.bookmark_add_note',
                        )}
                        title={t(
                          mark.note ? 'reader.bookmark_edit_note' : 'reader.bookmark_add_note',
                        )}
                        onClick={() => onEditing(mark.id)}
                      >
                        <PencilIcon className="size-4" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="rd-icon-btn text-muted-foreground"
                        aria-label={t('reader.bookmark_delete')}
                        title={t('reader.bookmark_delete')}
                        disabled={busy === mark.id}
                        onClick={() => void remove(mark)}
                      >
                        <Trash2Icon className="size-4" aria-hidden="true" />
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}
        {list.length > 0 && (
          <div className="mt-3 border-t border-border/60 pt-2">
            <SheetRow
              icon={exporting ? Loader2Icon : FileDownIcon}
              label={t('reader.bookmarks_export')}
              detail={t('reader.bookmarks_export_hint')}
              disabled={exporting}
              onClick={runExport}
            />
          </div>
        )}
      </div>
    </ReaderSheet>
  );
}
