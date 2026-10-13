/**
 * Collections on the PC (shared by every device): the query and its
 * mutations, which update the cached list in place and report with a toast.
 */
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ApiError, describeError } from '@/lib/api/client';
import { tr } from '@/lib/i18n-text';
import { queryClient } from '@/lib/query';
import { tick } from './haptics';
import { membershipToggle, upsertCollection, withMembers } from './library-collections';
import { readerApi, readerKeys, type ReaderCollection } from './reader-api';

/**
 * Collections, oldest first. `supported` is false on a backend without them
 * (404) or before the first answer; an unreachable PC keeps the last list.
 */
export function useReaderCollections(): { collections: ReaderCollection[]; supported: boolean } {
  const query = useQuery({
    queryKey: readerKeys.collections,
    queryFn: async ({ signal }): Promise<ReaderCollection[] | null> => {
      try {
        return await readerApi.collections(signal);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    retry: (count, error) => !(error instanceof ApiError && error.status === 0) && count < 2,
  });
  return { collections: query.data ?? [], supported: Boolean(query.data) };
}

function store(next: ReaderCollection) {
  queryClient.setQueryData<ReaderCollection[] | null>(readerKeys.collections, (list) =>
    upsertCollection(list ?? undefined, next),
  );
}

function refresh() {
  void queryClient.invalidateQueries({ queryKey: readerKeys.collections });
}

/** Create a collection, optionally with documents in it already. */
export async function createCollection(
  name: string,
  docIds: readonly string[] = [],
): Promise<ReaderCollection> {
  const created = await readerApi.createCollection(name, docIds);
  store(created);
  return created;
}

export async function renameCollection(id: string, name: string): Promise<ReaderCollection> {
  const renamed = await readerApi.renameCollection(id, name);
  store(renamed);
  return renamed;
}

/** Delete the collection only; its documents stay in the library. */
export async function deleteCollection(id: string): Promise<void> {
  await readerApi.deleteCollection(id);
  queryClient.setQueryData<ReaderCollection[] | null>(readerKeys.collections, (list) =>
    list?.filter((item) => item.id !== id),
  );
}

/** Add the documents to the collection, or take them out when all are in it already. */
export async function toggleInCollection(
  collection: ReaderCollection,
  docIds: readonly string[],
): Promise<void> {
  const change = membershipToggle(collection, docIds);
  if (!change.ids.length) return;
  tick();
  store(withMembers(collection, change.ids, change.add));
  try {
    if (change.add) store(await readerApi.addToCollection(collection.id, change.ids));
    else {
      const results = await Promise.allSettled(
        change.ids.map((id) => readerApi.removeFromCollection(collection.id, id)),
      );
      const failed = results.find((result) => result.status === 'rejected');
      if (failed) throw (failed as PromiseRejectedResult).reason;
    }
    toast.success(
      tr(change.add ? 'reader.lib_collection_added' : 'reader.lib_collection_removed', {
        name: collection.name,
      }),
    );
  } catch (error) {
    toast.error(describeError(error));
    refresh();
    return;
  }
  // Several removals answer separately; settle on the PC's list.
  if (!change.add) refresh();
}

/** A document left the library: drop it from the cached collections too. */
export function forgetDocumentInCollections(docId: string): void {
  queryClient.setQueryData<ReaderCollection[] | null>(readerKeys.collections, (list) =>
    list?.map((item) => (item.doc_ids.includes(docId) ? withMembers(item, [docId], false) : item)),
  );
}
