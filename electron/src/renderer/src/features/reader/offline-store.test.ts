import { describe, expect, it, vi } from 'vitest';
import type { ReaderDocument, ReaderPrerenderStatus, ReaderRender } from './reader-api';
import {
  createMemoryOfflineBackend,
  downloadForOffline,
  readOfflineSegment,
  segmentKey,
  type OfflineDownloadApi,
} from './offline-store';

function makeDoc(count: number): ReaderDocument {
  return {
    id: 'doc1',
    title: 'Doc',
    author: null,
    source_type: 'text',
    source_name: null,
    source_url: null,
    language: 'es',
    segment_count: count,
    char_count: count * 10,
    chapter_count: 0,
    has_cover: false,
    voice_id: null,
    engine: null,
    position_segment: 0,
    progress: 0,
    est_duration_s: 10,
    created_at: 0,
    updated_at: 0,
    last_opened_at: null,
    chapters: [],
    segments: Array.from({ length: count }, (_, i) => ({
      i,
      text: `Frase ${i}.`,
      para: i,
      kind: 'p' as const,
    })),
  };
}

function fakeApi(statuses: ReaderPrerenderStatus[] = []) {
  const queue = [...statuses];
  const idle = { running: false, done: 0, total: 0, error: null, voice: null, engine: null };
  const api: OfflineDownloadApi = {
    startPrerender: vi.fn(async () => queue.shift() ?? idle),
    prerenderStatus: vi.fn(async () => queue.shift() ?? idle),
    render: vi.fn(async (_id: string, segment: number): Promise<ReaderRender> => ({
      segment,
      render_key: `k${segment}`,
      audio_url: `/reader/audio/k${segment}`,
      duration_s: 1,
      cached: true,
      words: [],
    })),
    audio: vi.fn(async () => new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/mpeg' })),
  };
  return api;
}

describe('downloadForOffline', () => {
  it('stores every segment, reports progress and marks the copy complete', async () => {
    const backend = createMemoryOfflineBackend();
    const api = fakeApi();
    const progress: number[] = [];
    const record = await downloadForOffline({
      backend,
      api,
      doc: makeDoc(3),
      choice: { voice: 'v1', language: 'es' },
      onProgress: (stored) => progress.push(stored),
      sleep: async () => {},
    });
    expect(record).toMatchObject({ complete: true, segments: 3, bytes: 12, voice: 'v1' });
    expect(progress).toEqual([0, 1, 2, 3]);
    expect((await backend.segmentIndexes('doc1')).sort()).toEqual([0, 1, 2]);
    const segment = await readOfflineSegment(backend, 'doc1', 2);
    expect(segment?.render.render_key).toBe('k2');
    expect(segment?.blob.type).toBe('audio/mpeg');
    expect(segment?.voice).toBe('v1');
    expect(await readOfflineSegment(backend, 'doc1', 7)).toBeNull();
  });

  it('waits for the background prerender job to reach a segment before fetching it', async () => {
    const backend = createMemoryOfflineBackend();
    const running = (done: number) => ({
      running: true,
      done,
      total: 2,
      error: null,
      voice: null,
      engine: null,
    });
    const api = fakeApi([running(0), running(0), running(1), running(2)]);
    const sleep = vi.fn(async () => {});
    await downloadForOffline({ backend, api, doc: makeDoc(2), choice: {}, sleep });
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(api.render).toHaveBeenCalledTimes(2);
  });

  it('resumes without refetching stored segments and replaces a copy in another voice', async () => {
    const backend = createMemoryOfflineBackend();
    const doc = makeDoc(3);
    await downloadForOffline({ backend, api: fakeApi(), doc, choice: { voice: 'a' } });
    const sameVoice = fakeApi();
    await downloadForOffline({ backend, api: sameVoice, doc, choice: { voice: 'a' } });
    expect(sameVoice.render).not.toHaveBeenCalled();
    expect(sameVoice.startPrerender).not.toHaveBeenCalled();

    const otherVoice = fakeApi();
    const record = await downloadForOffline({
      backend,
      api: otherVoice,
      doc,
      choice: { voice: 'b' },
    });
    expect(otherVoice.render).toHaveBeenCalledTimes(3);
    expect(record).toMatchObject({ voice: 'b', segments: 3, bytes: 12 });
  });

  it('stops on abort and leaves an incomplete, resumable copy', async () => {
    const backend = createMemoryOfflineBackend();
    const controller = new AbortController();
    const api = fakeApi();
    api.audio = vi.fn(async () => {
      controller.abort();
      return new Blob([new Uint8Array([1])]);
    });
    await expect(
      downloadForOffline({ backend, api, doc: makeDoc(3), choice: {}, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(await backend.getDoc('doc1')).toMatchObject({ complete: false, segments: 0 });
  });

  it('removes a document together with its segments', async () => {
    const backend = createMemoryOfflineBackend();
    await downloadForOffline({ backend, api: fakeApi(), doc: makeDoc(2), choice: {} });
    expect(await backend.getSegment('doc1', 1)).toMatchObject({ key: segmentKey('doc1', 1) });
    await backend.deleteDoc('doc1');
    expect(await backend.listDocs()).toEqual([]);
    expect(await backend.segmentIndexes('doc1')).toEqual([]);
  });
});
