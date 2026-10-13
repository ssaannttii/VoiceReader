import { useQuery } from '@tanstack/react-query';
import { ApiError } from '@/lib/api/client';
import { createObjectUrl } from '@/lib/audio/object-url';
import {
  readerApi,
  readerKeys,
  type ReaderDocument,
  type ReaderDocumentSummary,
} from './reader-api';
import { offlineDocument, offlineDocuments } from './offline-state';

/** A library entry; `offlineOnly` marks entries served from downloads while the PC is unreachable. */
export type ReaderListItem = ReaderDocumentSummary & { offlineOnly?: boolean };

export const IMPORT_POLL_MS = 2000;

const unreachable = (error: unknown) => error instanceof ApiError && error.status === 0;

function summary(doc: ReaderDocument): ReaderListItem {
  const { segments: _segments, chapters: _chapters, ...rest } = doc;
  return { ...rest, offlineOnly: true };
}

export function useReaderDocuments() {
  return useQuery({
    queryKey: readerKeys.documents,
    queryFn: async ({ signal }): Promise<ReaderListItem[]> => {
      try {
        return await readerApi.list(signal);
      } catch (error) {
        if (!unreachable(error)) throw error;
        const offline = await offlineDocuments();
        if (!offline.length) throw error;
        return offline.map(summary);
      }
    },
    // Background imports report progress through the list (docs/reader/SPEC.md v2).
    refetchInterval: (query) =>
      query.state.data?.some((doc) => doc.import_status === 'importing') ? IMPORT_POLL_MS : false,
  });
}

export function useReaderDocument(id: string) {
  return useQuery({
    queryKey: readerKeys.document(id),
    queryFn: async ({ signal }): Promise<ReaderDocument> => {
      try {
        return await readerApi.get(id, signal);
      } catch (error) {
        if (!unreachable(error)) throw error;
        const offline = await offlineDocument(id);
        if (!offline) throw error;
        return offline;
      }
    },
    staleTime: 5 * 60_000,
  });
}

/** Object URL for an EPUB cover; null while loading or when there is none. */
export function useCoverUrl(id: string, hasCover: boolean): string | null {
  const { data } = useQuery({
    queryKey: ['reader', 'cover', id],
    queryFn: async ({ signal }) => createObjectUrl(await readerApi.cover(id, signal)),
    enabled: hasCover,
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    retry: false,
  });
  return hasCover ? (data ?? null) : null;
}
