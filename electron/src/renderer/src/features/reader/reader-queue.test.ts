import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dequeue,
  enqueue,
  moveItem,
  nextAfter,
  QUEUE_LIMIT,
  queueStartSegment,
  sanitizeQueue,
  type QueueItem,
} from './reader-queue';

const item = (id: string, title = id.toUpperCase()): QueueItem => ({ id, title, hasCover: false });
const ids = (queue: QueueItem[]) => queue.map((entry) => entry.id);

describe('queue operations', () => {
  it('appends in order and keeps a queued document in its place', () => {
    let queue = enqueue([], item('a'));
    queue = enqueue(queue, item('b'));
    queue = enqueue(queue, item('a', 'Renamed'));
    expect(ids(queue)).toEqual(['a', 'b']);
    expect(queue[0].title).toBe('Renamed');
  });

  it('removes by id', () => {
    expect(ids(dequeue([item('a'), item('b'), item('c')], 'b'))).toEqual(['a', 'c']);
    expect(ids(dequeue([item('a')], 'zz'))).toEqual(['a']);
  });

  it('moves entries up and down, clamped to the ends', () => {
    const queue = [item('a'), item('b'), item('c'), item('d')];
    expect(ids(moveItem(queue, 2, 1))).toEqual(['a', 'c', 'b', 'd']);
    expect(ids(moveItem(queue, 0, 3))).toEqual(['b', 'c', 'd', 'a']);
    expect(ids(moveItem(queue, 3, -5))).toEqual(['d', 'a', 'b', 'c']);
    expect(ids(moveItem(queue, 1, 1))).toEqual(['a', 'b', 'c', 'd']);
    expect(ids(moveItem(queue, 9, 0))).toEqual(['a', 'b', 'c', 'd']);
    // The input is never mutated.
    expect(ids(queue)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('continues with the first entry that is not the playing document', () => {
    expect(nextAfter([item('a'), item('b')], 'a')?.id).toBe('b');
    expect(nextAfter([item('a'), item('b')], 'x')?.id).toBe('a');
    expect(nextAfter([item('a')], 'a')).toBeNull();
    expect(nextAfter([], null)).toBeNull();
  });

  it('caps the queue length', () => {
    let queue: QueueItem[] = [];
    for (let i = 0; i < QUEUE_LIMIT + 5; i++) queue = enqueue(queue, item(`d${i}`));
    expect(queue).toHaveLength(QUEUE_LIMIT);
  });
});

describe('sanitizeQueue', () => {
  it('drops malformed entries and duplicates from storage', () => {
    expect(
      sanitizeQueue([
        { id: 'a', title: 'A', hasCover: true },
        { id: 'a', title: 'again' },
        { title: 'no id' },
        null,
        'b',
        { id: 'c', title: 5 },
      ]),
    ).toEqual([
      { id: 'a', title: 'A', hasCover: true },
      { id: 'c', title: '', hasCover: false },
    ]);
    expect(sanitizeQueue('nope')).toEqual([]);
    expect(sanitizeQueue(undefined)).toEqual([]);
  });
});

describe('queueStartSegment', () => {
  const doc = (position: number, count: number, completed?: boolean) => ({
    position_segment: position,
    segments: Array.from({ length: count }, () => 0),
    completed,
  });

  it('resumes from the saved position', () => {
    expect(queueStartSegment(doc(12, 40))).toBe(12);
    expect(queueStartSegment(doc(0, 40))).toBe(0);
  });

  it('starts over when the document was finished', () => {
    expect(queueStartSegment(doc(39, 40))).toBe(0);
    expect(queueStartSegment(doc(12, 40, true))).toBe(0);
  });

  it('clamps odd positions', () => {
    expect(queueStartSegment(doc(-3, 40))).toBe(0);
    expect(queueStartSegment(doc(999, 40))).toBe(0);
    expect(queueStartSegment(doc(5, 0))).toBe(0);
    expect(queueStartSegment(doc(0, 1))).toBe(0);
  });
});

/** In-memory Storage: Node's own experimental `localStorage` can shadow jsdom's. */
function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, String(value)),
  };
}

describe('queue store', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage());
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('persists the order per device and notifies subscribers', async () => {
    const store = await import('./reader-queue');
    const seen: number[] = [];
    const unsubscribe = store.subscribeQueue(() => seen.push(store.readerQueue().length));
    store.addToQueue(item('a'));
    store.addToQueue(item('b'));
    store.moveInQueue(1, 0);
    store.removeFromQueue('zz');
    unsubscribe();
    expect(seen).toEqual([1, 2, 2]);
    expect(JSON.parse(localStorage.getItem('voicestudio.reader.queue') ?? '[]')).toEqual([
      item('b'),
      item('a'),
    ]);
    // A fresh load (next visit) reads the same queue back.
    vi.resetModules();
    const reloaded = await import('./reader-queue');
    expect(ids(reloaded.readerQueue())).toEqual(['b', 'a']);
    reloaded.clearQueue();
    expect(reloaded.readerQueue()).toEqual([]);
  });

  it('follows title changes from the library', async () => {
    const store = await import('./reader-queue');
    store.addToQueue(item('a', 'Old'));
    store.refreshQueueTitles([{ id: 'a', title: 'New' }]);
    expect(store.readerQueue()[0].title).toBe('New');
    expect(store.isQueued('a')).toBe(true);
  });
});
