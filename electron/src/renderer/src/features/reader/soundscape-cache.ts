/**
 * Synthesized loops, rendered once per device and cached as WAV bytes in
 * IndexedDB (works on plain-HTTP LAN origins). Shared by the manual
 * soundscape (reader-soundscape.ts) and the automatic ambience
 * (reader-ambience.ts); a bed is only rendered the first time it is needed.
 */
import { dlog } from './reader-debug';
import { isAmbientBed, renderSoundscape, SOUNDSCAPE_VERSION, type BedId } from './soundscape-synth';

const DB_NAME = 'reader-soundscapes';
const STORE = 'loops';
let opening: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (opening) return opening;
  const idb = globalThis.indexedDB;
  if (!idb) return Promise.reject(new DOMException('IndexedDB unavailable', 'NotSupportedError'));
  opening = new Promise<IDBDatabase>((resolve, reject) => {
    const req = idb.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  opening.catch(() => {
    opening = null;
  });
  return opening;
}

const cacheKey = (id: BedId) => `${id}@${SOUNDSCAPE_VERSION}`;

/** Bytes stored under `key` (synthesized loops and recorded beds share the store). */
export async function cachedBytes(key: string): Promise<ArrayBuffer | null> {
  try {
    const db = await openDb();
    return await new Promise((resolve) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result instanceof ArrayBuffer ? req.result : null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function storeBytes(key: string, bytes: ArrayBuffer): Promise<void> {
  try {
    const db = await openDb();
    db.transaction(STORE, 'readwrite').objectStore(STORE).put(bytes, key);
  } catch {
    // Not cached: rendered again next time (about a second).
  }
}

/** Remove stored entries whose key starts with `prefix`, except those in `keep`. */
export async function pruneBytes(prefix: string, keep: ReadonlySet<string>): Promise<void> {
  try {
    const db = await openDb();
    const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
    const req = store.getAllKeys();
    req.onsuccess = () => {
      for (const key of req.result)
        if (typeof key === 'string' && key.startsWith(prefix) && !keep.has(key)) store.delete(key);
    };
  } catch {
    // Kept until next time.
  }
}

const loops = new Map<BedId, Promise<Blob>>();

/** The loop's WAV: memory, then IndexedDB, else rendered now and cached. */
export function loadBed(id: BedId): Promise<Blob> {
  let loop = loops.get(id);
  if (!loop) {
    loop = (async () => {
      const t0 = performance.now();
      let bytes = await cachedBytes(cacheKey(id));
      const cached = Boolean(bytes);
      if (!bytes) {
        bytes = await renderSoundscape(id);
        void storeBytes(cacheKey(id), bytes);
      }
      dlog('soundscape_load', {
        id,
        cached,
        ms: Math.round(performance.now() - t0),
        kb: Math.round(bytes.byteLength / 1024),
      });
      return new Blob([bytes], { type: 'audio/wav' });
    })();
    loops.set(id, loop);
    // Ambient beds come and go with the scenes: IndexedDB keeps them, memory doesn't (~2.8 MB each).
    if (isAmbientBed(id)) void loop.finally(() => loops.delete(id)).catch(() => {});
    else loop.catch(() => loops.delete(id));
  }
  return loop;
}
