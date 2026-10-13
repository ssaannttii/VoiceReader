/** Library mutations shared by the library and reader screens. */
import { queryClient } from '@/lib/query';
import {
  readerApi,
  readerKeys,
  type ReaderDocument,
  type ReaderDocumentSummary,
} from './reader-api';
import { removeOfflineDownload, startOfflineDownload } from './offline-state';
import { readerPlayer } from './reader-player';
import { refreshQueueTitles, removeFromQueue } from './reader-queue';

export function fetchReaderDocument(id: string): Promise<ReaderDocument> {
  return queryClient.fetchQuery({
    queryKey: readerKeys.document(id),
    queryFn: ({ signal }) => readerApi.get(id, signal),
    staleTime: 5 * 60_000,
  });
}

/** Save every sentence of a document on this device, in the voice it plays with. */
export async function downloadDocument(id: string): Promise<void> {
  const doc = await fetchReaderDocument(id);
  const player = readerPlayer.getState();
  const loaded = player.doc?.id === id;
  await startOfflineDownload(doc, {
    voice: loaded ? player.voice : doc.voice_id,
    engine: loaded ? player.engine : doc.engine,
    language: doc.language,
  });
}

export async function renameDocument(id: string, title: string): Promise<void> {
  const summary = await readerApi.update(id, { title });
  queryClient.setQueryData<ReaderDocumentSummary[]>(readerKeys.documents, (list) =>
    list?.map((item) => (item.id === id ? { ...item, title: summary.title } : item)),
  );
  queryClient.setQueryData<ReaderDocument>(readerKeys.document(id), (doc) =>
    doc ? { ...doc, title: summary.title } : doc,
  );
  refreshQueueTitles([{ id, title: summary.title }]);
  const loaded = readerPlayer.getState().doc;
  if (loaded?.id === id) readerPlayer.load({ ...loaded, title: summary.title });
}

export async function deleteDocument(id: string): Promise<void> {
  await readerApi.remove(id);
  if (readerPlayer.getState().doc?.id === id) readerPlayer.unload();
  removeFromQueue(id);
  await removeOfflineDownload(id).catch(() => {});
  queryClient.setQueryData<ReaderDocumentSummary[]>(readerKeys.documents, (list) =>
    list?.filter((item) => item.id !== id),
  );
  queryClient.removeQueries({ queryKey: readerKeys.document(id) });
}

/** Archive / unarchive, or mark finished / unread; the library updates in place. */
export async function setDocumentFlags(
  id: string,
  patch: Pick<Partial<ReaderDocumentSummary>, 'archived' | 'completed'>,
): Promise<void> {
  const summary = await readerApi.update(id, patch);
  queryClient.setQueryData<ReaderDocumentSummary[]>(readerKeys.documents, (list) =>
    list?.map((item) => (item.id === id ? { ...item, ...summary } : item)),
  );
  queryClient.setQueryData<ReaderDocument>(readerKeys.document(id), (doc) =>
    doc ? { ...doc, archived: summary.archived, completed: summary.completed } : doc,
  );
}
