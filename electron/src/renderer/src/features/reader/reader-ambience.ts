/**
 * Automatic ambience ("Automático" in the soundscape sheet): follows the
 * document's scenes (backend `GET /reader/documents/{id}/ambience`) with
 * understated beds. Wiring only — decisions live in ambience-schedule.ts and
 * playback in ambience-engine.ts. Everything is driven by player events and
 * `timeupdate` (the voice's clock and the beds' own), never by React or
 * animation frames, so it keeps working on a locked phone. The manual
 * soundscape (reader-soundscape.ts) owns arming, the volume slider, the sleep
 * fade and "only while the voice plays", and tells this module when it may sound.
 */
import { useSyncExternalStore } from 'react';
import { createObjectUrl, revokeObjectUrl } from '@/lib/audio/object-url';
import { AmbienceEngine, type BedElement } from './ambience-engine';
import type { AmbienceScene, AmbienceTag } from './ambience-schedule';
import { readerApi } from './reader-api';
import { dlog } from './reader-debug';
import { readerPlayer } from './reader-player';
import { loadBed } from './soundscape-cache';

export type AmbienceStatus = 'idle' | 'loading' | 'computing' | 'ready' | 'unavailable';

export interface AmbienceInfo {
  status: AmbienceStatus;
  /** What sounds now ('none' = silence). */
  tag: AmbienceTag;
}

/** While the PC analyzes a document, ask again this often, this many times (~3 min). */
const POLL_MS = 4000;
const POLL_LIMIT = 45;
/** Foreground helper while a fade runs and nothing else ticks (voice paused, beds silent). */
const RAMP_INTERVAL_MS = 250;

class AmbienceController {
  private info: AmbienceInfo = { status: 'idle', tag: 'none' };
  private listeners = new Set<() => void>();
  private enabled = false;
  private docId: string | null = null;
  private fetchToken = 0;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private rampTimer: ReturnType<typeof setInterval> | null = null;
  private installed = false;
  private readonly engine = new AmbienceEngine({
    createElement: () => this.createElement(),
    loadBed,
    createUrl: (blob) => createObjectUrl(blob),
    revokeUrl: (url) => revokeObjectUrl(url),
    now: () => performance.now(),
    log: (type, data) => dlog(type, data),
    onChange: () => this.publish({ tag: this.engine.tag() }),
  });

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
  getInfo = () => this.info;

  private publish(patch: Partial<AmbienceInfo>) {
    const next = { ...this.info, ...patch };
    if (next.status === this.info.status && next.tag === this.info.tag) return;
    this.info = next;
    this.listeners.forEach((listener) => listener());
  }

  install() {
    if (this.installed || typeof window === 'undefined') return;
    this.installed = true;
    readerPlayer.subscribe(() => this.follow());
    // The player's clock is published from the voice's `timeupdate`.
    readerPlayer.subscribeClock(() => this.tick());
  }

  /** Automático chosen or not (from the soundscape preference). */
  setEnabled(enabled: boolean) {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    this.engine.setEnabled(enabled);
    if (enabled) {
      this.follow();
      return;
    }
    this.cancelFetch();
    this.docId = null;
    this.stopRampTimer();
    this.publish({ status: 'idle', tag: 'none' });
  }

  /** May sound now (decided by the soundscape player). */
  setActive(active: boolean) {
    this.engine.setActive(active);
    this.kickRampTimer();
  }

  setMaster(gain: number) {
    this.engine.setMaster(gain);
  }

  unlock(silentUrl: string) {
    this.engine.unlock(silentUrl);
  }

  private follow() {
    if (!this.enabled) return;
    const { doc, segment, status } = readerPlayer.getState();
    const id = doc?.id ?? null;
    if (id !== this.docId) {
      this.docId = id;
      this.engine.setScenes(null);
      this.cancelFetch();
      if (id) this.fetchScenes(id, 0);
      else this.publish({ status: 'idle' });
    }
    this.engine.setVoicePlaying(
      Boolean(doc) && (status === 'playing' || status === 'buffering') && readerPlayer.playing,
    );
    this.engine.setSegment(segment, doc?.segments[segment]?.kind === 'h');
    this.kickRampTimer();
  }

  private tick() {
    if (!this.enabled) return;
    this.engine.tick();
    this.kickRampTimer();
  }

  private fetchScenes(id: string, attempt: number) {
    const token = ++this.fetchToken;
    this.publish({ status: attempt ? 'computing' : 'loading' });
    readerApi.ambience(id).then(
      (result) => {
        if (token !== this.fetchToken || id !== this.docId) return;
        if (result.status === 'computing' && attempt < POLL_LIMIT) {
          this.publish({ status: 'computing' });
          this.pollTimer = setTimeout(() => this.fetchScenes(id, attempt + 1), POLL_MS);
          return;
        }
        const scenes: AmbienceScene[] = result.status === 'ready' ? (result.scenes ?? []) : [];
        dlog('ambience', {
          event: 'scenes',
          status: result.status,
          count: scenes.length,
          sounding: scenes.filter((scene) => scene.tag !== 'none').length,
        });
        this.publish({ status: result.status === 'ready' ? 'ready' : 'unavailable' });
        // Unavailable: an empty scene list means silence everywhere.
        this.engine.setScenes(scenes);
        this.kickRampTimer();
      },
      (error: unknown) => {
        if (token !== this.fetchToken || id !== this.docId) return;
        dlog('ambience', { event: 'scenes', status: 'error', name: (error as Error)?.name });
        this.publish({ status: 'unavailable' });
        this.engine.setScenes([]);
      },
    );
  }

  private cancelFetch() {
    this.fetchToken++;
    if (this.pollTimer !== null) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  private createElement(): BedElement {
    const audio = new Audio();
    audio.loop = true;
    audio.preload = 'auto';
    audio.setAttribute('playsinline', '');
    // The beds tick their own fades while they play (also with the voice paused).
    audio.addEventListener('timeupdate', () => this.tick());
    return audio;
  }

  /** On screen, a fade keeps moving even when no element is ticking. */
  private kickRampTimer() {
    if (!this.enabled || !this.engine.busy()) {
      this.stopRampTimer();
      return;
    }
    if (this.rampTimer !== null) return;
    this.rampTimer = setInterval(() => {
      this.engine.tick();
      if (!this.engine.busy()) this.stopRampTimer();
    }, RAMP_INTERVAL_MS);
  }

  private stopRampTimer() {
    if (this.rampTimer !== null) clearInterval(this.rampTimer);
    this.rampTimer = null;
  }
}

export const ambienceController = new AmbienceController();
ambienceController.install();

export function useAmbienceInfo(): AmbienceInfo {
  return useSyncExternalStore(
    ambienceController.subscribe,
    ambienceController.getInfo,
    ambienceController.getInfo,
  );
}
