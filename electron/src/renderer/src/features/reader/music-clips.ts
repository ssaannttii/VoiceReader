/**
 * Background music clips on this device: each clip's compressed bytes are
 * downloaded once (with the app's auth, like every API call) and kept in
 * IndexedDB beside the soundscape loops, so replays and offline listening do
 * not need the PC. The document's last plan is kept too (offline starts).
 */
import { readerApi } from './reader-api';
import { decodeLoop } from './ambience-pack';
import { sanitizeMusic, type MusicFile, type ReaderMusic } from './music-plan';
import { cachedBytes, pruneBytes, storeBytes } from './soundscape-cache';

const docPrefix = (docId: string) => `music:${docId}:`;

/** IndexedDB key of a clip (a new palette or a re-rendered clip gets a new key). */
export function clipKey(docId: string, palette: string | null, file: MusicFile): string {
  return `${docPrefix(docId)}clip:${palette ?? 'auto'}:${file.name}@${file.duration}`;
}

export function metaKey(docId: string): string {
  return `${docPrefix(docId)}meta`;
}

let opus: boolean | null = null;
function canPlayOpus(): boolean {
  if (opus !== null) return opus;
  try {
    opus = typeof Audio !== 'undefined' && new Audio().canPlayType('audio/ogg; codecs=opus') !== '';
  } catch {
    opus = false;
  }
  return opus;
}

/** A clip's bytes: IndexedDB, else downloaded from the PC and kept. */
export async function clipBytes(
  docId: string,
  palette: string | null,
  file: MusicFile,
  signal?: AbortSignal,
): Promise<{ bytes: ArrayBuffer; cached: boolean }> {
  const key = clipKey(docId, palette, file);
  const stored = await cachedBytes(key);
  if (stored) return { bytes: stored, cached: true };
  const bytes = await readerApi.musicFile(docId, file.name, signal);
  await storeBytes(key, bytes);
  return { bytes, cached: false };
}

/**
 * Something an `<audio>` element plays: the Ogg Opus clip as is where the
 * browser plays Opus, else decoded to WAV offline (never a realtime context).
 */
export async function clipBlob(bytes: ArrayBuffer): Promise<Blob> {
  if (canPlayOpus()) return new Blob([bytes], { type: 'audio/ogg' });
  return decodeLoop(bytes);
}

/** The document's plan as last seen (offline starts). */
export async function readStoredMusic(docId: string): Promise<ReaderMusic | null> {
  const bytes = await cachedBytes(metaKey(docId));
  if (!bytes) return null;
  try {
    return sanitizeMusic(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return null;
  }
}

export async function storeMusic(docId: string, music: ReaderMusic): Promise<void> {
  const bytes = new TextEncoder().encode(JSON.stringify(music));
  await storeBytes(metaKey(docId), bytes.buffer.slice(0) as ArrayBuffer);
}

/** Clips of an older palette or render are dropped once a plan is final. */
export async function pruneClips(docId: string, music: ReaderMusic): Promise<void> {
  const keep = new Set<string>([metaKey(docId)]);
  for (const cue of music.cues)
    for (const file of cue.files) keep.add(clipKey(docId, music.palette?.id ?? null, file));
  await pruneBytes(docPrefix(docId), keep);
}

/** "Delete music": the document's clips and plan leave this device. */
export async function forgetMusic(docId: string): Promise<void> {
  await pruneBytes(docPrefix(docId), new Set());
}

/** Keep every ready clip on the device (offline downloads); returns the clips fetched. */
export async function prefetchMusic(
  docId: string,
  music: ReaderMusic,
  signal?: AbortSignal,
): Promise<number> {
  let fetched = 0;
  await storeMusic(docId, music);
  for (const cue of music.cues) {
    if (!cue.ready) continue;
    for (const file of cue.files) {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      const { cached } = await clipBytes(docId, music.palette?.id ?? null, file, signal);
      if (!cached) fetched++;
    }
  }
  return fetched;
}
