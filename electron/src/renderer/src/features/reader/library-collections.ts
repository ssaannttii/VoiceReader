/** Collections in the library (pure): names, membership and cache updates. */
import type { ReaderCollection } from './reader-api';

type Members = Pick<ReaderCollection, 'doc_ids'>;

/** The server's limit; longer names are cut. */
export const COLLECTION_NAME_MAX = 100;

/** Whitespace collapsed and trimmed, as the server stores it. */
export function cleanCollectionName(name: string): string {
  return name.split(/\s+/).filter(Boolean).join(' ').slice(0, COLLECTION_NAME_MAX);
}

/** Another collection already uses this name (case-insensitive, like the server). */
export function collectionNameTaken(
  collections: readonly Pick<ReaderCollection, 'id' | 'name'>[],
  name: string,
  exceptId?: string,
): boolean {
  const wanted = cleanCollectionName(name).toLocaleLowerCase();
  return collections.some(
    (item) => item.id !== exceptId && item.name.toLocaleLowerCase() === wanted,
  );
}

export type Membership = 'all' | 'some' | 'none';

/** Whether every, some or none of the documents are in the collection. */
export function membership(collection: Members, ids: readonly string[]): Membership {
  const inside = ids.filter((id) => collection.doc_ids.includes(id)).length;
  if (!ids.length || !inside) return 'none';
  return inside === ids.length ? 'all' : 'some';
}

/** Tapping a collection in the picker: remove when all are in it, else add the missing ones. */
export function membershipToggle(
  collection: Members,
  ids: readonly string[],
): { add: boolean; ids: string[] } {
  if (membership(collection, ids) === 'all') return { add: false, ids: [...ids] };
  return { add: true, ids: ids.filter((id) => !collection.doc_ids.includes(id)) };
}

/** The collection after adding or removing documents (added ones go last). */
export function withMembers<T extends Members>(collection: T, ids: readonly string[], add: boolean): T {
  const doc_ids = add
    ? [...collection.doc_ids, ...ids.filter((id) => !collection.doc_ids.includes(id))]
    : collection.doc_ids.filter((id) => !ids.includes(id));
  return { ...collection, doc_ids };
}

/** Collections a document is in, in their usual order. */
export function collectionsOf<T extends Members>(collections: readonly T[], docId: string): T[] {
  return collections.filter((item) => item.doc_ids.includes(docId));
}

/** Member ids that are still in the library (deleted or unknown ones never count). */
export function liveMembers(collection: Members, libraryIds: ReadonlySet<string>): string[] {
  return collection.doc_ids.filter((id) => libraryIds.has(id));
}

/** Replace one collection in a cached list (append when new), keeping the order. */
export function upsertCollection<T extends { id: string }>(
  list: readonly T[] | undefined,
  next: T,
): T[] {
  if (!list) return [next];
  return list.some((item) => item.id === next.id)
    ? list.map((item) => (item.id === next.id ? next : item))
    : [...list, next];
}
