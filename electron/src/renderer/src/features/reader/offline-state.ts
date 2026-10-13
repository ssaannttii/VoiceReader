/** App-wide offline download state for Reader documents. */
import { useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { describeError, isAbortError } from '@/lib/api/client';
import { tr } from '@/lib/i18n-text';
import { readerApi, type ReaderDocument, type ReaderVoiceChoice } from './reader-api';
import {
  createIndexedDbOfflineBackend,
  createMemoryOfflineBackend,
  downloadForOffline,
  readOfflineAsset,
  type OfflineBackend,
  type OfflineDocRecord,
} from './offline-store';

export interface OfflineDocMeta {
  voice: string | null;
  engine: string | null;
  complete: boolean;
  segments: number;
  total: number;
  bytes: number;
}

export interface ActiveDownload {
  stored: number;
  total: number;
}

export interface OfflineSnapshot {
  ready: boolean;
  downloaded: Record<string, OfflineDocMeta>;
  active: Record<string, ActiveDownload>;
}

let backend: OfflineBackend | null = null;
export function offlineBackend(): OfflineBackend {
  if (!backend)
    backend =
      typeof indexedDB === 'undefined'
        ? createMemoryOfflineBackend()
        : createIndexedDbOfflineBackend();
  return backend;
}

let snapshot: OfflineSnapshot = { ready: false, downloaded: {}, active: {} };
const listeners = new Set<() => void>();
const controllers = new Map<string, AbortController>();

function publish(next: Partial<OfflineSnapshot>) {
  snapshot = { ...snapshot, ...next };
  listeners.forEach((listener) => listener());
}

function meta(record: OfflineDocRecord): OfflineDocMeta {
  return {
    voice: record.voice,
    engine: record.engine,
    complete: record.complete,
    segments: record.segments,
    total: record.doc.segments.length,
    bytes: record.bytes,
  };
}

export async function refreshOffline(): Promise<void> {
  try {
    const records = await offlineBackend().listDocs();
    publish({
      ready: true,
      downloaded: Object.fromEntries(records.map((record) => [record.id, meta(record)])),
    });
  } catch {
    publish({ ready: true });
  }
}

/** Offline copies as library entries, for when the PC is unreachable. */
export async function offlineDocuments(): Promise<ReaderDocument[]> {
  try {
    return (await offlineBackend().listDocs()).map((record) => record.doc);
  } catch {
    return [];
  }
}

export async function offlineDocument(id: string): Promise<ReaderDocument | null> {
  try {
    return (await offlineBackend().getDoc(id))?.doc ?? null;
  } catch {
    return null;
  }
}

/** A downloaded document's image, or null when it was not kept. */
export async function offlineAsset(docId: string, src: string): Promise<Blob | null> {
  try {
    return await readOfflineAsset(offlineBackend(), docId, src);
  } catch {
    return null;
  }
}

export function offlineSnapshot(): OfflineSnapshot {
  return snapshot;
}

export function subscribeOffline(listener: () => void): () => void {
  listeners.add(listener);
  if (!snapshot.ready) void refreshOffline();
  return () => {
    listeners.delete(listener);
  };
}

export function useOffline(): OfflineSnapshot {
  return useSyncExternalStore(subscribeOffline, offlineSnapshot, offlineSnapshot);
}

export async function startOfflineDownload(
  doc: ReaderDocument,
  choice: ReaderVoiceChoice,
): Promise<void> {
  if (controllers.has(doc.id)) return;
  const controller = new AbortController();
  controllers.set(doc.id, controller);
  publish({ active: { ...snapshot.active, [doc.id]: { stored: 0, total: doc.segments.length } } });
  // Ask the browser not to evict downloaded books under storage pressure.
  void navigator.storage?.persist?.().catch(() => false);
  try {
    await downloadForOffline({
      backend: offlineBackend(),
      api: {
        startPrerender: (id, voice, from) => readerApi.startPrerender(id, voice, from),
        prerenderStatus: (id) => readerApi.prerenderStatus(id),
        render: (id, segment, voice) => readerApi.render(id, segment, voice, controller.signal),
        audio: (url) => readerApi.audio(url, controller.signal),
        asset: (src) => readerApi.asset(src, controller.signal),
      },
      doc,
      choice,
      signal: controller.signal,
      onProgress: (stored, total) =>
        publish({ active: { ...snapshot.active, [doc.id]: { stored, total } } }),
    });
    toast.success(tr('reader.downloaded_toast', { title: doc.title }));
  } catch (error) {
    if (!isAbortError(error))
      toast.error(tr('reader.download_failed'), { description: describeError(error) });
  } finally {
    controllers.delete(doc.id);
    const { [doc.id]: _done, ...rest } = snapshot.active;
    publish({ active: rest });
    await refreshOffline();
  }
}

export function cancelOfflineDownload(id: string): void {
  controllers.get(id)?.abort();
  void readerApi.cancelPrerender(id).catch(() => {});
}

export async function removeOfflineDownload(id: string): Promise<void> {
  cancelOfflineDownload(id);
  try {
    await offlineBackend().deleteDoc(id);
  } finally {
    await refreshOffline();
  }
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
