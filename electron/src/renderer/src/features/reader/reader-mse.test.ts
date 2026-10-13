import { describe, expect, it } from 'vitest';
import {
  AHEAD_SECONDS,
  AppendQueue,
  evictionRange,
  isMp3,
  MAX_AHEAD_SECONDS,
  MIN_AHEAD_SEGMENTS,
  rangeAt,
  SegmentTimeline,
  shouldAppend,
  type SourceBufferLike,
  type TimeRangesLike,
} from './reader-mse';

function ranges(...spans: [number, number][]): TimeRangesLike {
  return {
    length: spans.length,
    start: (index) => spans[index][0],
    end: (index) => spans[index][1],
  };
}

/**
 * A SourceBuffer stand-in in `sequence` mode: each append of N bytes adds N/10
 * seconds after the previous audio. Updates complete on a later microtask, like
 * the real one, and `updating` is true meanwhile.
 */
class MockSourceBuffer implements SourceBufferLike {
  updating = false;
  timestampOffset = 0;
  spans: [number, number][] = [];
  log: string[] = [];
  /** Throw QuotaExceededError for this many upcoming appends. */
  quotaFailures = 0;
  failNext = false;
  private listeners = new Map<string, Set<() => void>>();

  get buffered(): TimeRangesLike {
    return ranges(...this.spans);
  }

  addEventListener(type: string, listener: () => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: () => void) {
    this.listeners.get(type)?.delete(listener);
  }
  private fire(type: string) {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }

  appendBuffer(data: BufferSource) {
    if (this.updating) throw new DOMException('busy', 'InvalidStateError');
    if (this.quotaFailures > 0) {
      this.quotaFailures--;
      throw new DOMException('full', 'QuotaExceededError');
    }
    const seconds = (data as Uint8Array).byteLength / 10;
    this.log.push(`append ${seconds}`);
    this.updating = true;
    const fail = this.failNext;
    this.failNext = false;
    queueMicrotask(() => {
      this.updating = false;
      if (fail) {
        this.fire('error');
      } else {
        const start = this.timestampOffset;
        const end = start + seconds;
        const last = this.spans[this.spans.length - 1];
        if (last && Math.abs(last[1] - start) < 1e-9) last[1] = end;
        else this.spans.push([start, end]);
        this.timestampOffset = end;
      }
      this.fire('updateend');
    });
  }

  remove(start: number, end: number) {
    if (this.updating) throw new DOMException('busy', 'InvalidStateError');
    this.log.push(`remove ${start}-${end}`);
    this.updating = true;
    queueMicrotask(() => {
      this.updating = false;
      this.spans = this.spans
        .map(([a, b]): [number, number] => [Math.max(a, end), b])
        .filter(([a, b]) => b > a || a < start);
      this.fire('updateend');
    });
  }
}

const bytes = (seconds: number) => new Uint8Array(seconds * 10);

describe('SegmentTimeline', () => {
  function table() {
    const timeline = new SegmentTimeline<string>();
    timeline.add({ segment: 4, start: 0, end: 2.5, data: 'a' });
    timeline.add({ segment: 5, start: 2.5, end: 6, data: 'b' });
    timeline.add({ segment: 6, start: 6, end: 7, data: 'c' });
    return timeline;
  }

  it('maps media time to the sentence and the offset inside it', () => {
    const timeline = table();
    expect(timeline.locate(0)).toMatchObject({ entry: { segment: 4 }, offset: 0, atEnd: false });
    expect(timeline.locate(3)?.entry.segment).toBe(5);
    expect(timeline.locate(3)?.offset).toBeCloseTo(0.5);
    // The boundary belongs to the next sentence: [start, end).
    expect(timeline.locate(2.5)?.entry.segment).toBe(5);
    expect(timeline.locate(6.5)).toMatchObject({ entry: { segment: 6 }, atEnd: false });
  });

  it('reports the end of the appended audio', () => {
    const timeline = table();
    const end = timeline.locate(7);
    expect(end).toMatchObject({ entry: { segment: 6 }, atEnd: true });
    expect(end?.offset).toBeCloseTo(1);
  });

  it('maps word offsets to absolute media time', () => {
    const timeline = table();
    expect(timeline.timeOf(5, 1.25)).toBeCloseTo(3.75);
    expect(timeline.timeOf(4, 0)).toBe(0);
    // Offsets past the sentence clamp inside it.
    expect(timeline.timeOf(6, 9)).toBeLessThan(7);
    expect(timeline.timeOf(9, 0)).toBeNull();
  });

  it('drops evicted sentences and restarts on a non-consecutive append', () => {
    const timeline = table();
    timeline.dropBefore(3);
    expect(timeline.first()?.segment).toBe(5);
    expect(timeline.get(4)).toBeNull();
    expect(timeline.get(6)?.data).toBe('c');
    timeline.add({ segment: 20, start: 7, end: 8, data: 'z' });
    expect(timeline.size).toBe(1);
    expect(timeline.get(20)?.data).toBe('z');
  });

  it('is empty before anything is appended', () => {
    const timeline = new SegmentTimeline<string>();
    expect(timeline.locate(0)).toBeNull();
    expect(timeline.last()).toBeNull();
  });
});

describe('append window', () => {
  it('keeps at least three sentences and a minute ahead while playing', () => {
    expect(shouldAppend(5, MIN_AHEAD_SEGMENTS - 1, true)).toBe(true);
    expect(shouldAppend(AHEAD_SECONDS - 1, 10, true)).toBe(true);
    expect(shouldAppend(AHEAD_SECONDS + 1, MIN_AHEAD_SEGMENTS, true)).toBe(false);
    expect(shouldAppend(MAX_AHEAD_SECONDS, 0, true)).toBe(false);
  });

  it('only warms a few sentences while paused', () => {
    expect(shouldAppend(0, 0, false)).toBe(true);
    expect(shouldAppend(1, MIN_AHEAD_SEGMENTS, false)).toBe(false);
  });

  it('evicts in chunks behind the playhead', () => {
    expect(evictionRange(ranges([0, 100]), 50)).toBeNull();
    expect(evictionRange(ranges([0, 100]), 70)).toEqual([0, 40]);
    expect(evictionRange(ranges([30, 100]), 70)).toBeNull();
    expect(evictionRange(ranges(), 70)).toBeNull();
  });

  it('finds the buffered range around a time', () => {
    const buffered = ranges([0, 10], [20, 30]);
    expect(rangeAt(buffered, 5)).toEqual([0, 10]);
    expect(rangeAt(buffered, 15)).toBeNull();
    expect(rangeAt(buffered, 25)).toEqual([20, 30]);
  });
});

describe('isMp3', () => {
  it('accepts ID3-tagged and raw MPEG frames, rejects WAV', () => {
    expect(isMp3(new Uint8Array([0x49, 0x44, 0x33, 4]))).toBe(true);
    expect(isMp3(new Uint8Array([0xff, 0xfb, 0x90]))).toBe(true);
    expect(isMp3(new TextEncoder().encode('RIFF....WAVE'))).toBe(false);
    expect(isMp3(new Uint8Array([]))).toBe(false);
  });
});

describe('AppendQueue', () => {
  it('serializes appends and reports where each one lands', async () => {
    const buffer = new MockSourceBuffer();
    const queue = new AppendQueue(buffer);
    const spans = await Promise.all([
      queue.append(bytes(2)),
      queue.append(bytes(3)),
      queue.append(bytes(1)),
    ]);
    expect(spans).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 5 },
      { start: 5, end: 6 },
    ]);
    expect(buffer.log).toEqual(['append 2', 'append 3', 'append 1']);
  });

  it('interleaves removes in order and keeps later starts after eviction', async () => {
    const buffer = new MockSourceBuffer();
    const queue = new AppendQueue(buffer);
    void queue.append(bytes(4));
    void queue.remove(0, 3);
    const span = await queue.append(bytes(2));
    expect(span).toEqual({ start: 4, end: 6 });
    expect(buffer.log).toEqual(['append 4', 'remove 0-3', 'append 2']);
    expect(buffer.spans).toEqual([[3, 6]]);
  });

  it('waits for an update it did not start', async () => {
    const buffer = new MockSourceBuffer();
    buffer.appendBuffer(bytes(1));
    const queue = new AppendQueue(buffer);
    await expect(queue.append(bytes(1))).resolves.toEqual({ start: 1, end: 2 });
  });

  it('evicts and retries once on QuotaExceededError', async () => {
    const buffer = new MockSourceBuffer();
    let asked = 0;
    const queue = new AppendQueue(buffer, () => {
      asked++;
      return [0, 1];
    });
    await queue.append(bytes(2));
    buffer.quotaFailures = 1;
    await expect(queue.append(bytes(1))).resolves.toEqual({ start: 2, end: 3 });
    expect(asked).toBe(1);
    expect(buffer.log).toEqual(['append 2', 'remove 0-1', 'append 1']);
  });

  it('rejects when the quota is still exceeded or nothing can be evicted', async () => {
    const buffer = new MockSourceBuffer();
    const queue = new AppendQueue(buffer, () => null);
    buffer.quotaFailures = 1;
    await expect(queue.append(bytes(1))).rejects.toMatchObject({ name: 'QuotaExceededError' });
    // The queue keeps working afterwards.
    await expect(queue.append(bytes(1))).resolves.toEqual({ start: 0, end: 1 });
  });

  it('rejects an append whose update fires error', async () => {
    const buffer = new MockSourceBuffer();
    const queue = new AppendQueue(buffer);
    buffer.failNext = true;
    await expect(queue.append(bytes(1))).rejects.toBeInstanceOf(DOMException);
    await expect(queue.append(bytes(1))).resolves.toEqual({ start: 0, end: 1 });
  });

  it('rejects queued work with AbortError when disposed', async () => {
    const buffer = new MockSourceBuffer();
    const queue = new AppendQueue(buffer);
    const first = queue.append(bytes(1));
    const second = queue.append(bytes(1));
    queue.dispose();
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    // The in-flight append settles as aborted too: its session is gone.
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
  });
});
