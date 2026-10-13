/**
 * "Up next": documents the player continues with when the current one ends.
 *
 * Per device (localStorage), in order. The player reads it synchronously from
 * media events (reader-player.ts), so advancing never waits on React. Items keep
 * a title and cover flag so the queue sheet renders without the library list.
 */
import { useSyncExternalStore } from 'react';

export interface QueueItem {
  id: string;
  title: string;
  hasCover: boolean;
}

const KEY = 'voicestudio.reader.queue';
/** A long queue is fine; an unbounded one is a bug. */
export const QUEUE_LIMIT = 200;

// ── pure operations (unit-tested) ──────────────────────────────────────────

/** A valid queue from anything stored: drops malformed entries and duplicates. */
export function sanitizeQueue(value: unknown): QueueItem[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const items: QueueItem[] = [];
  for (const raw of value) {
    const entry = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    if (typeof entry.id !== 'string' || !entry.id || seen.has(entry.id)) continue;
    seen.add(entry.id);
    items.push({
      id: entry.id,
      title: typeof entry.title === 'string' ? entry.title : '',
      hasCover: entry.hasCover === true,
    });
    if (items.length >= QUEUE_LIMIT) break;
  }
  return items;
}

/** Append `item`; a document already queued keeps its place (its title is refreshed). */
export function enqueue(queue: readonly QueueItem[], item: QueueItem): QueueItem[] {
  const index = queue.findIndex((entry) => entry.id === item.id);
  if (index >= 0) return queue.map((entry, at) => (at === index ? { ...entry, ...item } : entry));
  return [...queue, item].slice(0, QUEUE_LIMIT);
}

export function dequeue(queue: readonly QueueItem[], id: string): QueueItem[] {
  return queue.filter((entry) => entry.id !== id);
}

/** Move the entry at `from` to `to` (both clamped); returns the same order when nothing moves. */
export function moveItem(queue: readonly QueueItem[], from: number, to: number): QueueItem[] {
  const last = queue.length - 1;
  if (from < 0 || from > last) return [...queue];
  const target = Math.min(Math.max(0, to), last);
  if (target === from) return [...queue];
  const next = [...queue];
  const [entry] = next.splice(from, 1);
  next.splice(target, 0, entry);
  return next;
}

/** The document to continue with after `currentId`: the first queued entry that is not it. */
export function nextAfter(queue: readonly QueueItem[], currentId: string | null): QueueItem | null {
  return queue.find((entry) => entry.id !== currentId) ?? null;
}

/** Where a queued document starts: its saved position, or the beginning once it was finished. */
export function queueStartSegment(doc: {
  position_segment: number;
  segments: readonly unknown[];
  completed?: boolean;
}): number {
  const last = Math.max(0, doc.segments.length - 1);
  const at = Math.min(Math.max(0, Math.floor(doc.position_segment) || 0), last);
  return doc.completed || (last > 0 && at >= last) ? 0 : at;
}

// ── store ──────────────────────────────────────────────────────────────────

function read(): QueueItem[] {
  try {
    return sanitizeQueue(JSON.parse(localStorage.getItem(KEY) ?? '[]'));
  } catch {
    return [];
  }
}

let current: QueueItem[] = typeof localStorage === 'undefined' ? [] : read();
const listeners = new Set<() => void>();

function commit(next: QueueItem[]) {
  current = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* The queue stays for this session. */
  }
  listeners.forEach((listener) => listener());
}

export function readerQueue(): QueueItem[] {
  return current;
}

export function subscribeQueue(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function useReaderQueue(): QueueItem[] {
  return useSyncExternalStore(subscribeQueue, readerQueue, readerQueue);
}

export function addToQueue(item: QueueItem) {
  commit(enqueue(current, item));
}

export function removeFromQueue(id: string) {
  if (current.some((entry) => entry.id === id)) commit(dequeue(current, id));
}

export function moveInQueue(from: number, to: number) {
  commit(moveItem(current, from, to));
}

export function clearQueue() {
  if (current.length) commit([]);
}

export function isQueued(id: string): boolean {
  return current.some((entry) => entry.id === id);
}

/** Keep queued titles in step with the library (renames). */
export function refreshQueueTitles(docs: readonly { id: string; title: string }[]) {
  const titles = new Map(docs.map((doc) => [doc.id, doc.title]));
  if (!current.some((entry) => titles.has(entry.id) && titles.get(entry.id) !== entry.title))
    return;
  commit(current.map((entry) => ({ ...entry, title: titles.get(entry.id) ?? entry.title })));
}

// Another tab (or the installed app beside a browser tab) edited the queue.
if (typeof window !== 'undefined')
  window.addEventListener('storage', (event) => {
    if (event.key !== KEY) return;
    current = read();
    listeners.forEach((listener) => listener());
  });
