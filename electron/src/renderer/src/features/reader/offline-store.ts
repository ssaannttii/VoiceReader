/**
 * Offline copies of Reader documents: the document JSON plus every segment's
 * render timing and audio bytes, kept in IndexedDB (`reader-offline`). Works on
 * plain-HTTP LAN origins, where the Cache API and service workers do not.
 */
import type {
  ReaderDocument,
  ReaderPrerenderStatus,
  ReaderRender,
  ReaderVoiceChoice,
} from './reader-api';

export const OFFLINE_DB_NAME = 'reader-offline';
const DB_VERSION = 1;
const DOCS = 'docs';
const SEGMENTS = 'segments';

export interface OfflineDocRecord {
  id: string;
  doc: ReaderDocument;
  voice: string | null;
  engine: string | null;
  language: string | null;
  complete: boolean;
  /** Segments stored so far. */
  segments: number;
  bytes: number;
  savedAt: number;
}

export interface OfflineSegmentRecord {
  key: string;
  docId: string;
  i: number;
  render: ReaderRender;
  /** Stored as bytes: Safari has dropped Blob values from IndexedDB in the past. */
  audio: ArrayBuffer;
  type: string;
}

export interface OfflineBackend {
  getDoc(id: string): Promise<OfflineDocRecord | undefined>;
  putDoc(record: OfflineDocRecord): Promise<void>;
  listDocs(): Promise<OfflineDocRecord[]>;
  getSegment(docId: string, index: number): Promise<OfflineSegmentRecord | undefined>;
  putSegment(record: OfflineSegmentRecord): Promise<void>;
  segmentIndexes(docId: string): Promise<number[]>;
  /** Removes the document and all of its segments. */
  deleteDoc(id: string): Promise<void>;
}

export const segmentKey = (docId: string, index: number) => `${docId}:${index}`;

/** In-memory backend: tests, and browsers where IndexedDB is unavailable. */
export function createMemoryOfflineBackend(): OfflineBackend {
  const docs = new Map<string, OfflineDocRecord>();
  const segments = new Map<string, OfflineSegmentRecord>();
  return {
    getDoc: async (id) => docs.get(id),
    putDoc: async (record) => void docs.set(record.id, record),
    listDocs: async () => [...docs.values()],
    getSegment: async (docId, index) => segments.get(segmentKey(docId, index)),
    putSegment: async (record) => void segments.set(record.key, record),
    segmentIndexes: async (docId) =>
      [...segments.values()].filter((record) => record.docId === docId).map((record) => record.i),
    deleteDoc: async (id) => {
      docs.delete(id);
      for (const [key, record] of segments) if (record.docId === id) segments.delete(key);
    },
  };
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new DOMException('Request failed', 'UnknownError'));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new DOMException('Transaction aborted', 'AbortError'));
    tx.onerror = () => reject(tx.error ?? new DOMException('Transaction failed', 'UnknownError'));
  });
}

export function createIndexedDbOfflineBackend(
  factory: () => IDBFactory | undefined = () => globalThis.indexedDB,
  name = OFFLINE_DB_NAME,
): OfflineBackend {
  let opening: Promise<IDBDatabase> | null = null;
  const open = () => {
    if (opening) return opening;
    const idb = factory();
    if (!idb) return Promise.reject(new DOMException('IndexedDB unavailable', 'NotSupportedError'));
    const req = idb.open(name, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DOCS)) db.createObjectStore(DOCS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(SEGMENTS))
        db.createObjectStore(SEGMENTS, { keyPath: 'key' }).createIndex('docId', 'docId');
    };
    opening = request(req).then((db) => {
      // Another tab upgrading the schema must not be blocked by this one.
      db.onversionchange = () => {
        db.close();
        opening = null;
      };
      return db;
    });
    opening.catch(() => {
      opening = null;
    });
    return opening;
  };
  const read = async <T>(store: string, run: (os: IDBObjectStore) => IDBRequest<T>) => {
    const db = await open();
    return request(run(db.transaction(store, 'readonly').objectStore(store)));
  };
  const write = async (store: string, value: unknown) => {
    const db = await open();
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value);
    await done(tx);
  };
  return {
    getDoc: (id) => read<OfflineDocRecord | undefined>(DOCS, (os) => os.get(id)),
    putDoc: (record) => write(DOCS, record),
    listDocs: () => read<OfflineDocRecord[]>(DOCS, (os) => os.getAll()),
    getSegment: (docId, index) =>
      read<OfflineSegmentRecord | undefined>(SEGMENTS, (os) => os.get(segmentKey(docId, index))),
    putSegment: (record) => write(SEGMENTS, record),
    segmentIndexes: async (docId) => {
      const keys = await read<IDBValidKey[]>(SEGMENTS, (os) =>
        os.index('docId').getAllKeys(IDBKeyRange.only(docId)),
      );
      return keys.map((key) => Number(String(key).slice(docId.length + 1)));
    },
    deleteDoc: async (id) => {
      const db = await open();
      const tx = db.transaction([DOCS, SEGMENTS], 'readwrite');
      tx.objectStore(DOCS).delete(id);
      const cursor = tx.objectStore(SEGMENTS).index('docId').openKeyCursor(IDBKeyRange.only(id));
      cursor.onsuccess = () => {
        const current = cursor.result;
        if (!current) return;
        tx.objectStore(SEGMENTS).delete(current.primaryKey);
        current.continue();
      };
      await done(tx);
    },
  };
}

export interface OfflineDownloadApi {
  startPrerender(
    id: string,
    choice: ReaderVoiceChoice,
    fromSegment: number,
  ): Promise<ReaderPrerenderStatus>;
  prerenderStatus(id: string): Promise<ReaderPrerenderStatus>;
  render(id: string, segment: number, choice: ReaderVoiceChoice): Promise<ReaderRender>;
  audio(audioUrl: string): Promise<Blob>;
}

export interface OfflineDownloadOptions {
  backend: OfflineBackend;
  api: OfflineDownloadApi;
  doc: ReaderDocument;
  choice: ReaderVoiceChoice;
  signal?: AbortSignal;
  onProgress?: (stored: number, total: number) => void;
  /** Delay between prerender status polls. */
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Download cancelled', 'AbortError');
}

/**
 * Download every segment of `doc` for offline listening. The PC renders in a
 * background prerender job; this fetches each segment once the job reaches
 * it (or renders directly when no job is running). Resumable: segments
 * already stored with the same voice are skipped; a different voice
 * replaces the old copy.
 */
export async function downloadForOffline({
  backend,
  api,
  doc,
  choice,
  signal,
  onProgress,
  pollMs = 1500,
  sleep = wait,
}: OfflineDownloadOptions): Promise<OfflineDocRecord> {
  const voice = choice.voice ?? null;
  const engine = choice.engine ?? null;
  let record = await backend.getDoc(doc.id);
  if (record && (record.voice !== voice || record.engine !== engine)) {
    await backend.deleteDoc(doc.id);
    record = undefined;
  }
  const stored = new Set(await backend.segmentIndexes(doc.id));
  const total = doc.segments.length;
  const current: OfflineDocRecord = {
    id: doc.id,
    doc,
    voice,
    engine,
    language: choice.language ?? null,
    complete: false,
    segments: stored.size,
    bytes: record?.bytes ?? 0,
    savedAt: Date.now(),
  };
  await backend.putDoc(current);
  onProgress?.(stored.size, total);
  const firstMissing = doc.segments.findIndex((segment) => !stored.has(segment.i));
  if (firstMissing >= 0) {
    throwIfAborted(signal);
    let status: ReaderPrerenderStatus | null = await api
      .startPrerender(doc.id, choice, firstMissing)
      .catch(() => null);
    for (let index = firstMissing; index < total; index++) {
      const segment = doc.segments[index];
      if (stored.has(segment.i)) continue;
      // Let the background job get ahead: each fetch below is then a cache hit.
      while (status?.running && firstMissing + status.done <= index) {
        throwIfAborted(signal);
        await sleep(pollMs);
        status = await api.prerenderStatus(doc.id).catch(() => null);
      }
      throwIfAborted(signal);
      const render = await api.render(doc.id, segment.i, choice);
      const blob = await api.audio(render.audio_url);
      throwIfAborted(signal);
      const audio = await blob.arrayBuffer();
      await backend.putSegment({
        key: segmentKey(doc.id, segment.i),
        docId: doc.id,
        i: segment.i,
        render,
        audio,
        type: blob.type || 'audio/mpeg',
      });
      stored.add(segment.i);
      current.segments = stored.size;
      current.bytes += audio.byteLength;
      await backend.putDoc(current);
      onProgress?.(stored.size, total);
    }
  }
  current.complete = true;
  current.savedAt = Date.now();
  await backend.putDoc(current);
  return current;
}

/** Offline audio for one segment as a playable Blob, when stored. */
export async function readOfflineSegment(
  backend: OfflineBackend,
  docId: string,
  index: number,
): Promise<{ render: ReaderRender; blob: Blob; voice: string | null } | null> {
  const [segment, record] = await Promise.all([
    backend.getSegment(docId, index),
    backend.getDoc(docId),
  ]);
  if (!segment) return null;
  return {
    render: segment.render,
    blob: new Blob([segment.audio], { type: segment.type }),
    voice: record?.voice ?? null,
  };
}
