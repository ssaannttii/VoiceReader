/**
 * Library actions behind swipes and the selection bar: each one reports with
 * a Reader toast and, where it can be reverted, an inline "Undo".
 */
import { useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { describeError } from '@/lib/api/client';
import { tr } from '@/lib/i18n-text';
import { queryClient } from '@/lib/query';
import { confirm, tick } from './haptics';
import { cancelOfflineDownload, offlineSnapshot, removeOfflineDownload } from './offline-state';
import { deleteDocument, downloadDocument, setDocumentFlags } from './reader-actions';
import { readerKeys, type ReaderDocumentSummary } from './reader-api';
import type { ReaderListItem } from './use-reader-data';

type Flags = Pick<Partial<ReaderDocumentSummary>, 'archived' | 'completed'>;
type Doc = Pick<ReaderDocumentSummary, 'id' | 'title' | 'archived' | 'completed'>;

/** Toasts with an inline action stay up longer, so there is time to reach it. */
export const ACTION_TOAST_MS = 6000;

const subject = (docs: readonly Doc[]) =>
  docs.length === 1 ? docs[0].title : tr('reader.lib_items', { count: docs.length });

/** Set archive / finished flags on one or more documents, with Undo. */
export async function setFlagsWithUndo(
  docs: readonly Doc[],
  patch: Flags,
  message: string,
): Promise<void> {
  if (!docs.length) return;
  const before = docs.map((doc) => ({
    id: doc.id,
    flags: Object.fromEntries(
      Object.keys(patch).map((key) => [key, Boolean(doc[key as keyof Flags])]),
    ) as Flags,
  }));
  const results = await Promise.allSettled(docs.map((doc) => setDocumentFlags(doc.id, patch)));
  const failed = results.find((result) => result.status === 'rejected');
  if (failed) toast.error(describeError((failed as PromiseRejectedResult).reason));
  const done = before.filter((_, index) => results[index].status === 'fulfilled');
  if (!done.length) return;
  toast.success(message, {
    description: subject(docs.filter((doc) => done.some((item) => item.id === doc.id))),
    duration: ACTION_TOAST_MS,
    action: {
      label: tr('reader.undo'),
      onClick: () => {
        tick();
        void Promise.all(done.map((item) => setDocumentFlags(item.id, item.flags))).catch(
          (error: unknown) => toast.error(describeError(error)),
        );
      },
    },
  });
}

export function startDownload(doc: Pick<ReaderDocumentSummary, 'id' | 'title'>): void {
  toast(tr('reader.lib_download_started'), { description: doc.title });
  void downloadDocument(doc.id).catch((error: unknown) =>
    toast.error(tr('reader.download_failed'), { description: describeError(error) }),
  );
}

/** Download several documents (skipping saved and running ones) under one toast. */
export function startDownloads(docs: readonly Pick<ReaderDocumentSummary, 'id' | 'title'>[]): void {
  const offline = offlineSnapshot();
  const todo = docs.filter(
    (doc) => !offline.active[doc.id] && !offline.downloaded[doc.id]?.complete,
  );
  if (!todo.length) return;
  if (todo.length === 1) {
    startDownload(todo[0]);
    return;
  }
  toast(tr('reader.lib_download_started'), {
    description: tr('reader.lib_items', { count: todo.length }),
  });
  // One after another, so the PC renders a single document at a time.
  void todo.reduce<Promise<void>>(
    (chain, doc) =>
      chain.then(() =>
        downloadDocument(doc.id).catch((error: unknown) => {
          toast.error(tr('reader.download_failed'), { description: describeError(error) });
        }),
      ),
    Promise.resolve(),
  );
}

/** Download, cancel a running download, or remove a finished one (with Undo). */
export function toggleDownload(doc: Pick<ReaderDocumentSummary, 'id' | 'title'>): void {
  const offline = offlineSnapshot();
  if (offline.active[doc.id]) {
    cancelOfflineDownload(doc.id);
    return;
  }
  if (!offline.downloaded[doc.id]?.complete) {
    startDownload(doc);
    return;
  }
  removeDownloads([doc]);
}

/** Library entries that exist only as downloads leave the list with them. */
function forgetOfflineOnly(ids: readonly string[]) {
  queryClient.setQueryData<ReaderListItem[]>(readerKeys.documents, (list) =>
    list?.filter((item) => !(item.offlineOnly && ids.includes(item.id))),
  );
}

/**
 * Remove downloads from this device (works without the PC). Undo downloads
 * them again, so it is offered only for documents the PC still serves.
 */
export function removeDownloads(
  docs: readonly Pick<ReaderListItem, 'id' | 'title' | 'offlineOnly'>[],
): void {
  if (!docs.length) return;
  void Promise.allSettled(docs.map((doc) => removeOfflineDownload(doc.id))).then((results) => {
    const failed = results.find((result) => result.status === 'rejected');
    if (failed) toast.error(describeError((failed as PromiseRejectedResult).reason));
    const done = docs.filter((_, index) => results[index].status === 'fulfilled');
    if (!done.length) return;
    forgetOfflineOnly(done.filter((doc) => doc.offlineOnly).map((doc) => doc.id));
    const again = done.filter((doc) => !doc.offlineOnly);
    toast.success(tr('reader.lib_download_removed'), {
      description: done.length === 1 ? done[0].title : tr('reader.lib_items', { count: done.length }),
      duration: ACTION_TOAST_MS,
      action: again.length
        ? {
            label: tr('reader.undo'),
            onClick: () => {
              tick();
              startDownloads(again);
            },
          }
        : undefined,
    });
  });
}

/* Deferred delete: the row hides at once and the DELETE runs when Undo expires. */

let hidden: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function setHidden(next: ReadonlySet<string>) {
  hidden = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Ids waiting for their delete to commit; the library leaves them out. */
export function useHiddenDocuments(): ReadonlySet<string> {
  return useSyncExternalStore(
    subscribe,
    () => hidden,
    () => hidden,
  );
}

export function deleteWithUndo(doc: Pick<ReaderDocumentSummary, 'id' | 'title'>): void {
  if (timers.has(doc.id)) return;
  confirm();
  setHidden(new Set(hidden).add(doc.id));
  const restore = () => {
    const next = new Set(hidden);
    next.delete(doc.id);
    setHidden(next);
  };
  timers.set(
    doc.id,
    setTimeout(() => {
      timers.delete(doc.id);
      deleteDocument(doc.id)
        .catch((error: unknown) => toast.error(describeError(error)))
        .finally(restore);
    }, ACTION_TOAST_MS),
  );
  toast.success(tr('reader.lib_deleted'), {
    description: doc.title,
    duration: ACTION_TOAST_MS,
    action: {
      label: tr('reader.undo'),
      onClick: () => {
        tick();
        clearTimeout(timers.get(doc.id));
        timers.delete(doc.id);
        restore();
      },
    },
  });
}

/** Delete several documents now (the selection bar asks first). */
export async function deleteMany(docs: readonly Doc[]): Promise<void> {
  confirm();
  const results = await Promise.allSettled(docs.map((doc) => deleteDocument(doc.id)));
  const failed = results.find((result) => result.status === 'rejected');
  if (failed) toast.error(describeError((failed as PromiseRejectedResult).reason));
  const done = results.filter((result) => result.status === 'fulfilled').length;
  if (done)
    toast.success(tr('reader.lib_deleted'), {
      description: tr('reader.lib_items', { count: done }),
    });
}
