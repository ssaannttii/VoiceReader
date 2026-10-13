/**
 * Background music (Labs, off by default): subtle instrumental cues composed on
 * the PC for a document (`/reader/documents/{id}/music`), under the narration.
 * Wiring only — decisions live in music-plan.ts and playback in
 * music-engine.ts. Everything follows player events (state, `timeupdate`
 * clock, sleep fade) and the decks' own `timeupdate`, never React or animation
 * frames, so the music keeps in step with the voice on a locked phone. The
 * reading audio is never routed through Web Audio and is not touched here.
 */
import { useSyncExternalStore } from 'react';
import { ApiError } from '@/lib/api/client';
import { createObjectUrl, revokeObjectUrl } from '@/lib/audio/object-url';
import { queryClient } from '@/lib/query';
import { labsPrefs, subscribeLabs } from './labs-prefs';
import {
  clipBlob,
  clipBytes,
  prefetchMusic,
  pruneClips,
  readStoredMusic,
  storeMusic,
} from './music-clips';
import { setMusicPresence } from './music-duck';
import { MusicEngine, type MusicElement } from './music-engine';
import {
  DOC_CHANGE_FADE_SECONDS,
  MusicDirector,
  STOP_FADE_SECONDS,
  musicBusy,
  musicGain,
  musicPlayable,
  sanitizeMusic,
  type MusicTarget,
  type ReaderMusic,
} from './music-plan';
import { musicOnFor, musicPrefs, subscribeMusicPrefs } from './music-prefs';
import { offlineSnapshot, subscribeOffline } from './offline-state';
import { readerApi, readerKeys } from './reader-api';
import { dlog } from './reader-debug';
import { readerPlayer } from './reader-player';

export interface MusicInfo {
  /** Document the music follows (null: off for the current one). */
  docId: string | null;
  /** Cue sounding now and its mood. */
  cue: string | null;
  mood: string | null;
  /** The PC could not be reached; a stored plan (if any) is used. */
  unreachable: boolean;
}

/** While the PC prepares the music, ask again this often (up to ~1 h). */
const POLL_MS = 5000;
const POLL_LIMIT = 720;
/** Foreground helper while a fade runs and nothing else ticks. */
const RAMP_INTERVAL_MS = 250;
/** Listening time counted per tick is capped (a suspended page must not jump ahead). */
const MAX_LISTEN_SECONDS = 2;

/** The music query's data (also written by the sound sheet). */
export function musicQueryKey(docId: string) {
  return readerKeys.music(docId);
}

/** Fetch the plan, sanitized (the sound sheet's query uses the same function). */
export async function fetchMusic(docId: string, signal?: AbortSignal): Promise<ReaderMusic> {
  return sanitizeMusic(await readerApi.music(docId, signal));
}

class MusicController {
  private info: MusicInfo = { docId: null, cue: null, mood: null, unreachable: false };
  private listeners = new Set<() => void>();
  private installed = false;
  private docId: string | null = null;
  private music: ReaderMusic | null = null;
  private fade = 1;
  private active = false;
  /** Switched off while sounding: a short fade, then everything stops. */
  private stopping = false;
  private lastListen: number | null = null;
  private lastKey: string | null = null;
  private fetchToken = 0;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private rampTimer: ReturnType<typeof setInterval> | null = null;
  private offlineKept = new Set<string>();
  private offlinePending = new Set<string>();
  private offlineSeen = new Set<string>();
  private offlineQueue: Promise<void> = Promise.resolve();
  private readonly director = new MusicDirector();
  private readonly engine = new MusicEngine({
    createElement: () => this.createElement(),
    loadClip: async (cue, file) => {
      const docId = this.docId;
      if (!docId) throw new DOMException('No document', 'AbortError');
      const t0 = performance.now();
      const { bytes, cached } = await clipBytes(docId, this.music?.palette?.id ?? null, file);
      const blob = await clipBlob(bytes);
      dlog('music_load', {
        cue: cue.id,
        file: file.name,
        cached,
        ms: Math.round(performance.now() - t0),
        kb: Math.round(bytes.byteLength / 1024),
      });
      return blob;
    },
    createUrl: (blob) => createObjectUrl(blob),
    revokeUrl: (url) => revokeObjectUrl(url),
    now: () => performance.now(),
    log: (type, data) => dlog(type, data),
    onChange: () => this.publishCue(),
  });

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
  getInfo = () => this.info;

  private publish(patch: Partial<MusicInfo>) {
    const next = { ...this.info, ...patch };
    if (
      next.docId === this.info.docId &&
      next.cue === this.info.cue &&
      next.mood === this.info.mood &&
      next.unreachable === this.info.unreachable
    )
      return;
    this.info = next;
    this.listeners.forEach((listener) => listener());
  }

  install() {
    if (this.installed || typeof window === 'undefined') return;
    this.installed = true;
    this.director.setMode(musicPrefs().mode);
    readerPlayer.subscribe(() => this.follow());
    // The player's clock is published from the voice's `timeupdate`.
    readerPlayer.subscribeClock(() => this.tick());
    readerPlayer.subscribeVolume((volume) => {
      this.fade = volume;
      this.applyMaster();
    });
    // The sleep timer paused the voice: the music pauses with it (follow) and
    // the fade it followed is over.
    readerPlayer.subscribeSleep(() => {
      this.fade = 1;
      this.follow();
    });
    subscribeLabs(() => this.follow());
    // Downloads re-checked only when something relevant changes (not on volume drags or
    // download progress): the option, the documents with music, a download completing.
    let offlineScope = `${musicPrefs().offline}|${musicPrefs().docs.join(',')}`;
    subscribeMusicPrefs(() => {
      this.director.setMode(musicPrefs().mode);
      this.applyMaster();
      this.follow();
      const scope = `${musicPrefs().offline}|${musicPrefs().docs.join(',')}`;
      if (scope !== offlineScope) {
        offlineScope = scope;
        this.keepDownloads();
      }
    });
    subscribeOffline(() => {
      const complete = Object.entries(offlineSnapshot().downloaded)
        .filter(([, meta]) => meta.complete)
        .map(([id]) => id);
      const fresh = complete.filter((id) => !this.offlineSeen.has(id));
      this.offlineSeen = new Set(complete);
      if (fresh.length) this.keepDownloads(fresh);
    });
    // The sound sheet polls, prepares and deletes through the same query.
    queryClient.getQueryCache().subscribe((event) => {
      const id = this.docId;
      if (!id || event.type !== 'updated') return;
      const key = event.query.queryKey;
      if (key[0] !== 'reader' || key[1] !== 'music' || key[2] !== id) return;
      const data = event.query.state.data as ReaderMusic | undefined;
      if (data && data !== this.music) this.usePlan(id, data, false);
    });
    this.follow();
  }

  /** iOS: inside the tap that turns the music on. */
  unlock(silentUrl: string) {
    this.engine.unlock(silentUrl);
  }

  /** The plan changed on the PC (prepare, palette, delete): fetch it again now. */
  refresh() {
    if (this.docId) this.fetchPlan(this.docId, 0);
  }

  private follow() {
    const { doc, segment, status } = readerPlayer.getState();
    const id = doc?.id ?? null;
    const enabled = Boolean(id) && labsPrefs().music && musicOnFor(id);
    const wanted = enabled ? id : null;
    const voicePlaying =
      Boolean(doc) && (status === 'playing' || status === 'buffering') && readerPlayer.playing;
    if (wanted !== this.docId) this.switchDocument(wanted, voicePlaying);
    if (wanted) this.director.setSegment(segment);
    this.setActive(voicePlaying && (Boolean(wanted) || this.stopping));
    this.push();
  }

  private switchDocument(id: string | null, voicePlaying: boolean) {
    const previous = this.docId;
    this.docId = id;
    this.music = null;
    this.lastKey = null;
    this.cancelFetch();
    this.director.reset();
    this.director.setPlan(null);
    this.engine.clearFailures();
    dlog('music', { event: 'document', on: Boolean(id), mode: musicPrefs().mode });
    if (!id) {
      // Switched off (or the document has none): a short fade while the voice plays, else at once.
      if (voicePlaying && this.engine.presence() > 0) {
        this.stopping = true;
        this.engine.setTarget({ cue: null, key: null, fadeIn: 0, fadeOut: STOP_FADE_SECONDS });
      } else {
        this.stopping = false;
        this.engine.stop();
      }
      this.publish({ docId: null, cue: null, mood: null, unreachable: false });
      setMusicPresence(this.engine.presence());
      return;
    }
    this.stopping = false;
    // Another document (queue advance, a new book): the old music leaves quickly.
    this.engine.setCues([], id);
    this.engine.setTarget({
      cue: null,
      key: null,
      fadeIn: 0,
      fadeOut: previous ? DOC_CHANGE_FADE_SECONDS : STOP_FADE_SECONDS,
    });
    this.publish({ docId: id, cue: null, mood: null, unreachable: false });
    const cached = queryClient.getQueryData<ReaderMusic>(musicQueryKey(id));
    if (cached) this.usePlan(id, cached, false);
    this.fetchPlan(id, 0);
  }

  private fetchPlan(id: string, attempt: number) {
    this.cancelFetch();
    const token = ++this.fetchToken;
    fetchMusic(id).then(
      (music) => {
        if (token !== this.fetchToken || id !== this.docId) return;
        queryClient.setQueryData(musicQueryKey(id), music);
        this.usePlan(id, music, true);
        this.publish({ unreachable: false });
        if (musicBusy(music) && attempt < POLL_LIMIT)
          this.pollTimer = setTimeout(() => this.fetchPlan(id, attempt + 1), POLL_MS);
      },
      async (error: unknown) => {
        if (token !== this.fetchToken || id !== this.docId) return;
        const unreachable = error instanceof ApiError && error.status === 0;
        dlog('music', {
          event: 'plan_error',
          status: error instanceof ApiError ? error.status : -1,
          name: (error as Error)?.name,
        });
        this.publish({ unreachable });
        // Offline: the plan as last seen plays the clips this device keeps.
        if (!this.music) {
          const stored = await readStoredMusic(id);
          if (stored && token === this.fetchToken && id === this.docId)
            this.usePlan(id, stored, false);
        }
      },
    );
  }

  private usePlan(id: string, music: ReaderMusic, fresh: boolean) {
    if (id !== this.docId) return;
    const before = this.music;
    this.music = music;
    if (before?.palette?.id !== music.palette?.id) this.engine.clearFailures();
    this.engine.setCues(music.cues, id);
    this.director.setPlan(music.status === 'off' ? null : music);
    this.applyMaster();
    if (
      fresh &&
      (before?.status !== music.status ||
        before?.cues.filter((c) => c.ready).length !== music.cues.filter((c) => c.ready).length)
    )
      dlog('music', {
        event: 'plan',
        status: music.status,
        progress: Math.round(music.progress * 100),
        palette: music.palette?.id ?? null,
        cues: music.cues.length,
        ready: music.cues.filter((cue) => cue.ready).length,
        spots: music.spots.length,
        spans: music.timeline.length,
        engine: music.engine_available,
      });
    if (fresh && musicPlayable(music)) void storeMusic(id, music);
    if (fresh && music.status === 'ready') {
      void pruneClips(id, music);
      this.keepDownloads([id]);
    }
    this.push();
  }

  private cancelFetch() {
    this.fetchToken++;
    if (this.pollTimer !== null) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  private setActive(active: boolean) {
    if (active === this.active) return;
    this.active = active;
    this.lastListen = performance.now();
    this.engine.setActive(active);
    setMusicPresence(this.engine.presence());
    this.kickRampTimer();
  }

  private applyMaster() {
    this.engine.setMaster(
      musicGain(musicPrefs().volumeDb, this.music?.level_lufs ?? Number.NaN, this.fade),
    );
  }

  /** Hand the director's decision to the engine. */
  private push() {
    const target: MusicTarget =
      this.docId && this.music
        ? this.director.target()
        : { cue: null, key: null, fadeIn: 0, fadeOut: STOP_FADE_SECONDS };
    if (this.docId && target.key !== this.lastKey) {
      this.lastKey = target.key;
      dlog('music', {
        event: 'target',
        key: target.key,
        cue: target.cue,
        mode: this.director.currentMode,
        seg: readerPlayer.getState().segment,
      });
    }
    if (this.docId || !this.stopping) this.engine.setTarget(target);
    this.publishCue();
    this.kickRampTimer();
  }

  /** "Now: tension" in the sheet. */
  private publishCue() {
    const cue = this.engine.playingCue();
    this.publish({
      cue,
      mood: cue ? (this.music?.cues.find((item) => item.id === cue)?.mood ?? null) : null,
    });
  }

  private tick() {
    if (!this.docId && !this.stopping) return;
    const now = performance.now();
    if (this.active && this.lastListen !== null && this.engine.playingCue())
      this.director.listen(
        Math.min(MAX_LISTEN_SECONDS, Math.max(0, (now - this.lastListen) / 1000)),
      );
    this.lastListen = now;
    this.engine.tick();
    this.push();
    setMusicPresence(this.engine.presence());
    if (this.stopping && this.engine.presence() === 0 && !this.engine.busy()) {
      this.stopping = false;
      this.engine.stop();
      this.setActive(false);
    }
  }

  private createElement(): MusicElement {
    const audio = new Audio();
    audio.preload = 'auto';
    audio.setAttribute('playsinline', '');
    // The decks tick their own fades and chaining while they play.
    audio.addEventListener('timeupdate', () => this.tick());
    audio.addEventListener('ended', () => this.tick());
    return audio;
  }

  /** On screen, a fade keeps moving even when no element is ticking. */
  private kickRampTimer() {
    if (!this.active || !this.engine.busy()) {
      this.stopRampTimer();
      return;
    }
    if (this.rampTimer !== null) return;
    this.rampTimer = setInterval(() => {
      this.tick();
      if (!this.active || !this.engine.busy()) this.stopRampTimer();
    }, RAMP_INTERVAL_MS);
  }

  private stopRampTimer() {
    if (this.rampTimer !== null) clearInterval(this.rampTimer);
    this.rampTimer = null;
  }

  /**
   * "Include in downloads": a downloaded document with music on keeps its
   * ready clips on the device (once per palette per session; failures retry).
   */
  private keepDownloads(ids?: readonly string[]) {
    if (!labsPrefs().music || !musicPrefs().offline) return;
    const { downloaded } = offlineSnapshot();
    for (const id of ids ?? Object.keys(downloaded)) {
      if (!downloaded[id]?.complete || !musicOnFor(id) || this.offlinePending.has(id)) continue;
      this.offlinePending.add(id);
      this.offlineQueue = this.offlineQueue
        .then(() => this.keepOffline(id))
        .finally(() => this.offlinePending.delete(id));
    }
  }

  private async keepOffline(id: string) {
    try {
      const music =
        id === this.docId && this.music?.status === 'ready' ? this.music : await fetchMusic(id);
      if (music.status !== 'ready') return;
      const key = `${id}:${music.palette?.id ?? 'auto'}`;
      if (this.offlineKept.has(key)) return;
      const fetched = await prefetchMusic(id, music);
      this.offlineKept.add(key);
      dlog('music', { event: 'offline', fetched, cues: music.cues.length });
    } catch (error) {
      dlog('music', { event: 'offline_error', name: (error as Error)?.name });
    }
  }
}

export const musicController = new MusicController();
musicController.install();

export function useMusicInfo(): MusicInfo {
  return useSyncExternalStore(
    musicController.subscribe,
    musicController.getInfo,
    musicController.getInfo,
  );
}
