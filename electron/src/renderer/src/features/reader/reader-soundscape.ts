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
  type SoundscapeChoice,
  type SoundscapeId,
} from './listening-prefs';
import { ambienceController } from './reader-ambience';
import { dlog } from './reader-debug';
import { readerPlayer, silentWav } from './reader-player';
import { ambiencePack } from './ambience-pack';
import { isRecordedKey, type BedKey } from './ambience-schedule';
import { loadBed } from './soundscape-cache';

export type SoundscapeStatus = 'off' | 'loading' | 'playing' | 'paused' | 'error';

// ── player ─────────────────────────────────────────────────────────────────

/** Perceptual volume: the slider's 0–100 squared, times the sleep fade. */
export function soundscapeGain(volume: number, fade: number): number {
  const level = Math.min(100, Math.max(0, volume)) / 100;
  return Math.min(1, Math.max(0, level * level * Math.min(1, Math.max(0, fade))));
}

class SoundscapePlayer {
  private audio: HTMLAudioElement | null = null;
  private url: string | null = null;
  /** The bed in the element: the synthesized loop or its recording. */
  private loadedKey: BedKey | null = null;
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
    // Which recordings the PC has (manual and automatic sounds prefer them).
    void ambiencePack.refresh();
    // Automático fetches the document's scenes ahead of the first play.
    ambienceController.setEnabled(listeningPrefs().soundscape === 'auto');
    this.applyVolume();
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
      if (listeningPrefs().soundscape === 'auto') return; // Automático plays its own elements.
      if (this.status === 'playing') this.setStatus(this.wanted() ? 'loading' : 'paused');
    });
    audio.addEventListener('error', () => {
      if (this.url && audio.src === this.url) this.setStatus('error');
    });
    this.audio = audio;
    return audio;
  }

  /** Choose a soundscape, Automático or off (from a tap): saves it and starts it now. */
  choose(id: SoundscapeChoice) {
    setListeningPrefs({ soundscape: id });
    if (id === 'off') {
      this.sync();
      return;
    }
    this.armed = true;
    if (id === 'auto') ambienceController.unlock(silentWav());
    else this.unlock();
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
    const gain = soundscapeGain(listeningPrefs().soundscapeVolume, this.fade);
    if (this.audio) this.audio.volume = gain;
    ambienceController.setMaster(gain);
  }

  private sync() {
    const prefs = listeningPrefs();
    this.applyVolume();
    ambienceController.setEnabled(prefs.soundscape === 'auto');
    if (prefs.soundscape === 'auto') {
      // Automático: the manual element rests; the scene beds follow the same arming and volume.
      this.loadToken++;
      if (this.audio && !this.audio.paused) this.audio.pause();
      const wanted = this.wanted();
      ambienceController.setActive(wanted);
      this.setStatus(wanted ? 'playing' : 'paused');
      return;
    }
    ambienceController.setActive(false);
    if (!this.wanted()) {
      this.loadToken++;
      if (this.audio && !this.audio.paused) this.audio.pause();
      this.setStatus(prefs.soundscape === 'off' ? 'off' : 'paused');
      return;
    }
    const id = prefs.soundscape as SoundscapeId;
    const audio = this.element();
    const key = ambiencePack.manualKey(id);
    if (this.loadedKey === key && this.url && audio.src === this.url) {
      if (audio.paused) this.play();
      return;
    }
    const token = ++this.loadToken;
    this.setStatus('loading');
    // A recording that cannot load (offline and not cached yet) gives way to the synthesized loop.
    const load = isRecordedKey(key) ? ambiencePack.load(key).catch(() => loadBed(id)) : loadBed(id);
    load.then(
      (blob) => {
        if (token !== this.loadToken || !this.wanted()) return;
        revokeObjectUrl(this.url);
        this.url = createObjectUrl(blob);
        this.loadedKey = key;
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
