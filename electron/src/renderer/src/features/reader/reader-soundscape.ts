/**
 * Soundscape playback: a SECOND `<audio loop>` element beside the reading
 * audio, with its own volume. The reading audio is never routed through Web
 * Audio (a MediaElementSource on it would tie playback to an AudioContext that
 * Android suspends with the screen off); the loops are rendered offline once
 * (soundscape-synth.ts) and cached as WAV bytes in IndexedDB.
 *
 * Everything here follows player events (state, sleep fade, sleep stop), not
 * React, so it keeps in step with the voice on a locked phone.
 */
import { useSyncExternalStore } from 'react';
import { createObjectUrl, revokeObjectUrl } from '@/lib/audio/object-url';
import {
  listeningPrefs,
  setListeningPrefs,
  subscribeListening,
  type SoundscapeId,
} from './listening-prefs';
import { dlog } from './reader-debug';
import { readerPlayer, silentWav } from './reader-player';
import { renderSoundscape, SOUNDSCAPE_VERSION } from './soundscape-synth';

export type SoundscapeStatus = 'off' | 'loading' | 'playing' | 'paused' | 'error';

// ── loop cache (IndexedDB; works on plain-HTTP LAN origins) ────────────────

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

const cacheKey = (id: SoundscapeId) => `${id}@${SOUNDSCAPE_VERSION}`;

async function cachedLoop(id: SoundscapeId): Promise<ArrayBuffer | null> {
  try {
    const db = await openDb();
    return await new Promise((resolve) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(cacheKey(id));
      req.onsuccess = () => resolve(req.result instanceof ArrayBuffer ? req.result : null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function storeLoop(id: SoundscapeId, bytes: ArrayBuffer): Promise<void> {
  try {
    const db = await openDb();
    db.transaction(STORE, 'readwrite').objectStore(STORE).put(bytes, cacheKey(id));
  } catch {
    // Not cached: rendered again next time (about a second).
  }
}

const loops = new Map<SoundscapeId, Promise<Blob>>();

/** The loop's WAV: memory, then IndexedDB, else rendered now and cached. */
function loadLoop(id: SoundscapeId): Promise<Blob> {
  let loop = loops.get(id);
  if (!loop) {
    loop = (async () => {
      const t0 = performance.now();
      let bytes = await cachedLoop(id);
      const cached = Boolean(bytes);
      if (!bytes) {
        bytes = await renderSoundscape(id);
        void storeLoop(id, bytes);
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
    loop.catch(() => loops.delete(id));
  }
  return loop;
}

// ── player ─────────────────────────────────────────────────────────────────

/** Perceptual volume: the slider's 0–100 squared, times the sleep fade. */
export function soundscapeGain(volume: number, fade: number): number {
  const level = Math.min(100, Math.max(0, volume)) / 100;
  return Math.min(1, Math.max(0, level * level * Math.min(1, Math.max(0, fade))));
}

class SoundscapePlayer {
  private audio: HTMLAudioElement | null = null;
  private url: string | null = null;
  private loadedId: SoundscapeId | null = null;
  private loadToken = 0;
  /** May play: set by choosing a sound or by the voice starting, cleared by the sleep timer. */
  private armed = false;
  private voicePlaying = false;
  private fade = 1;
  private status: SoundscapeStatus = 'off';
  private listeners = new Set<() => void>();
  private installed = false;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
  getStatus = () => this.status;

  private setStatus(status: SoundscapeStatus) {
    if (status === this.status) return;
    const before = this.status;
    this.status = status;
    if (status === 'playing' || before === 'playing')
      dlog('soundscape', {
        on: status === 'playing',
        id: listeningPrefs().soundscape,
        volume: listeningPrefs().soundscapeVolume,
        with_voice: listeningPrefs().soundscapeWithVoice,
      });
    this.listeners.forEach((listener) => listener());
  }

  install() {
    if (this.installed || typeof window === 'undefined') return;
    this.installed = true;
    this.voicePlaying = this.isVoicePlaying();
    readerPlayer.subscribe(() => {
      const playing = this.isVoicePlaying();
      if (playing === this.voicePlaying) return;
      this.voicePlaying = playing;
      // The voice starting (any way: dock, headphones, lock screen) re-arms the sound.
      if (playing) this.armed = true;
      this.sync();
    });
    readerPlayer.subscribeVolume((volume) => {
      this.fade = volume;
      this.applyVolume();
    });
    readerPlayer.subscribeSleep(() => {
      this.armed = false;
      this.fade = 1;
      this.sync();
    });
    subscribeListening(() => this.sync());
  }

  private isVoicePlaying(): boolean {
    const { status, doc } = readerPlayer.getState();
    return Boolean(doc) && (status === 'playing' || status === 'buffering') && readerPlayer.playing;
  }

  private element(): HTMLAudioElement {
    if (this.audio) return this.audio;
    const audio = new Audio();
    audio.loop = true;
    audio.preload = 'auto';
    audio.setAttribute('playsinline', '');
    audio.addEventListener('playing', () => {
      if (this.audio?.src === this.url) this.setStatus('playing');
    });
    audio.addEventListener('pause', () => {
      if (this.status === 'playing') this.setStatus(this.wanted() ? 'loading' : 'paused');
    });
    audio.addEventListener('error', () => {
      if (this.url && audio.src === this.url) this.setStatus('error');
    });
    this.audio = audio;
    return audio;
  }

  /** Choose a soundscape (from a tap): saves it and starts it now. */
  choose(id: SoundscapeId | 'off') {
    setListeningPrefs({ soundscape: id });
    if (id === 'off') {
      this.sync();
      return;
    }
    this.armed = true;
    this.unlock();
    this.sync();
  }

  setVolume(volume: number) {
    setListeningPrefs({ soundscapeVolume: volume });
  }

  setWithVoice(withVoice: boolean) {
    if (!withVoice) this.armed = true;
    setListeningPrefs({ soundscapeWithVoice: withVoice });
  }

  /** iOS only plays elements first started inside a tap. */
  private unlock() {
    const audio = this.element();
    if (!audio.paused || audio.src === this.url) return;
    audio.src = silentWav();
    void audio.play().catch(() => {});
  }

  private wanted(): boolean {
    const prefs = listeningPrefs();
    return (
      prefs.soundscape !== 'off' && this.armed && (this.voicePlaying || !prefs.soundscapeWithVoice)
    );
  }

  private applyVolume() {
    if (this.audio)
      this.audio.volume = soundscapeGain(listeningPrefs().soundscapeVolume, this.fade);
  }

  private sync() {
    const prefs = listeningPrefs();
    this.applyVolume();
    if (!this.wanted()) {
      this.loadToken++;
      if (this.audio && !this.audio.paused) this.audio.pause();
      this.setStatus(prefs.soundscape === 'off' ? 'off' : 'paused');
      return;
    }
    const id = prefs.soundscape as SoundscapeId;
    const audio = this.element();
    if (this.loadedId === id && this.url && audio.src === this.url) {
      if (audio.paused) this.play();
      return;
    }
    const token = ++this.loadToken;
    this.setStatus('loading');
    loadLoop(id).then(
      (blob) => {
        if (token !== this.loadToken || !this.wanted()) return;
        revokeObjectUrl(this.url);
        this.url = createObjectUrl(blob);
        this.loadedId = id;
        if (!this.url) {
          this.setStatus('error');
          return;
        }
        audio.src = this.url;
        this.applyVolume();
        this.play();
      },
      (error: unknown) => {
        if (token !== this.loadToken) return;
        dlog('soundscape_error', { id, name: (error as { name?: string })?.name ?? 'Error' });
        this.setStatus('error');
      },
    );
  }

  private play() {
    const audio = this.element();
    this.applyVolume();
    audio.play().catch((error: unknown) => {
      if ((error as { name?: string })?.name === 'AbortError') return;
      // Autoplay refused (no tap yet on this page): wait for the next voice start or choice.
      this.armed = false;
      this.setStatus('paused');
    });
  }
}

export const soundscapePlayer = new SoundscapePlayer();
soundscapePlayer.install();

export function useSoundscapeStatus(): SoundscapeStatus {
  return useSyncExternalStore(
    soundscapePlayer.subscribe,
    soundscapePlayer.getStatus,
    soundscapePlayer.getStatus,
  );
}
