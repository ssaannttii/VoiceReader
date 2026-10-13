/**
 * "Music" in the sound sheet (Labs switch on): background music for the
 * current document — on/off, mode, volume, style (palette), prepare on the PC
 * with its progress, delete, and whether downloads keep it.
 */
import { useState, type CSSProperties } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { TFunction } from 'i18next';
import { Loader2Icon, Music2Icon, RefreshCwIcon, Trash2Icon } from 'lucide-react';
import { ApiError, describeError } from '@/lib/api/client';
import { queryClient } from '@/lib/query';
import { cn } from '@/lib/utils';
import { forgetMusic } from './music-clips';
import {
  MUSIC_PALETTES,
  MUSIC_VOLUME_MAX_DB,
  MUSIC_VOLUME_MIN_DB,
  musicBusy,
  sanitizeMusic,
  type MusicMode,
  type MusicMood,
  type MusicPaletteId,
  type ReaderMusic,
} from './music-plan';
import { setMusicOnFor, setMusicPrefs, useMusicPrefs } from './music-prefs';
import { readerApi } from './reader-api';
import { dlog } from './reader-debug';
import { fetchMusic, musicController, musicQueryKey, useMusicInfo } from './reader-music';
import { silentWav } from './reader-player';
import { SheetRow } from './reader-sheet';
import './labs.css';

const PALETTE_LABELS: Record<MusicPaletteId, string> = {
  dark_fantasy: 'reader.music_palette_dark_fantasy',
  bright_fantasy: 'reader.music_palette_bright_fantasy',
  classic_novel: 'reader.music_palette_classic_novel',
  contemporary_thriller: 'reader.music_palette_contemporary_thriller',
  mystery_noir: 'reader.music_palette_mystery_noir',
  romance_warm: 'reader.music_palette_romance_warm',
  scifi_space: 'reader.music_palette_scifi_space',
  historical: 'reader.music_palette_historical',
  nonfiction_minimal: 'reader.music_palette_nonfiction_minimal',
};

const MOOD_LABELS: Record<MusicMood, string> = {
  calm: 'reader.music_mood_calm',
  wonder: 'reader.music_mood_wonder',
  tension: 'reader.music_mood_tension',
  dread: 'reader.music_mood_dread',
  melancholy: 'reader.music_mood_melancholy',
  warmth: 'reader.music_mood_warmth',
  resolve: 'reader.music_mood_resolve',
};

const MODES: readonly { id: MusicMode; label: string; hint: string }[] = [
  {
    id: 'moments',
    label: 'reader.music_mode_moments',
    hint: 'reader.music_mode_moments_hint',
  },
  {
    id: 'continuous',
    label: 'reader.music_mode_continuous',
    hint: 'reader.music_mode_continuous_hint',
  },
];

/** "dark_fantasy" → "Dark fantasy" for ids this build does not know. */
function prettyId(id: string): string {
  const words = id.replace(/[_-]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : id;
}

export function paletteLabel(t: TFunction, id: string): string {
  return id in PALETTE_LABELS ? t(PALETTE_LABELS[id as MusicPaletteId]) : prettyId(id);
}

export function moodLabel(t: TFunction, mood: string): string {
  return mood in MOOD_LABELS ? t(MOOD_LABELS[mood as MusicMood]) : prettyId(mood);
}

export function musicPercent(music: ReaderMusic | null | undefined): number {
  return Math.round((music?.progress ?? 0) * 100);
}

/** One line on what the music of this document is doing. */
export function musicStatusText(
  t: TFunction,
  music: ReaderMusic | undefined,
  options: { unreachable: boolean; failed: boolean; mood: string | null },
): string {
  if (!music) {
    if (options.unreachable) return t('reader.music_unreachable');
    return options.failed ? t('reader.music_status_error') : t('reader.music_loading');
  }
  if (music.status === 'unavailable' || (!music.engine_available && music.status !== 'ready'))
    return t('reader.music_status_unavailable');
  switch (music.status) {
    case 'off':
      return t('reader.music_status_off');
    case 'queued':
      return t('reader.music_status_queued');
    case 'analyzing':
      return t('reader.music_status_analyzing');
    case 'generating':
      return t('reader.music_status_generating', { percent: musicPercent(music) });
    case 'error':
      return music.error
        ? `${t('reader.music_status_error')} · ${music.error}`
        : t('reader.music_status_error');
    default:
      return options.mood
        ? t('reader.music_now', { mood: moodLabel(t, options.mood) })
        : t('reader.music_status_ready');
  }
}

function formatDb(value: number): string {
  if (value === 0) return '0 dB';
  return `${value > 0 ? '+' : '−'}${Math.abs(value)} dB`;
}

function useMusic(docId: string) {
  return useQuery({
    queryKey: musicQueryKey(docId),
    queryFn: ({ signal }) => fetchMusic(docId, signal),
    staleTime: 10_000,
    retry: false,
    refetchInterval: (query) => (musicBusy(query.state.data) ? 3000 : false),
  });
}

export function MusicSection({ docId }: { docId: string }) {
  const { t } = useTranslation();
  const prefs = useMusicPrefs();
  const info = useMusicInfo();
  const query = useMusic(docId);
  const music = query.data;
  const [pending, setPending] = useState<'prepare' | 'delete' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const on = prefs.docs.includes(docId);
  const busy = musicBusy(music);
  const engineMissing = Boolean(
    music && (music.status === 'unavailable' || !music.engine_available),
  );
  const unreachable = query.error instanceof ApiError && query.error.status === 0;
  const status = musicStatusText(t, music, {
    unreachable: unreachable || (info.docId === docId && info.unreachable),
    failed: Boolean(query.error),
    mood: info.docId === docId ? info.mood : null,
  });

  const store = (next: ReaderMusic) => {
    queryClient.setQueryData(musicQueryKey(docId), next);
    musicController.refresh();
  };

  const prepare = async (palette?: string) => {
    setPending('prepare');
    dlog('music', { event: 'prepare', palette: palette ?? null });
    try {
      store(sanitizeMusic(await readerApi.prepareMusic(docId, palette)));
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setPending(null);
    }
  };

  const remove = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setConfirmDelete(false);
    setPending('delete');
    dlog('music', { event: 'delete' });
    try {
      await readerApi.deleteMusic(docId);
      await forgetMusic(docId);
      store(
        sanitizeMusic({
          status: 'off',
          engine_available: music?.engine_available ?? true,
          palettes: music?.palettes ?? [],
        }),
      );
      toast.success(t('reader.music_deleted'));
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setPending(null);
    }
  };

  const toggle = () => {
    const next = !on;
    if (next) musicController.unlock(silentWav());
    setMusicOnFor(docId, next);
    dlog('music', { event: 'switch', on: next });
    // Turning it on for a document without music asks the PC to compose it.
    if (next && music && !engineMissing && (music.status === 'off' || music.status === 'error'))
      void prepare();
  };

  const palettes = music?.palettes.length
    ? music.palettes.map((palette) => palette.id)
    : [...MUSIC_PALETTES];
  const chosen = music?.palette?.source === 'user' ? music.palette.id : '';
  if (chosen && !palettes.includes(chosen)) palettes.push(chosen);
  const autoLabel =
    music?.palette?.source === 'auto'
      ? t('reader.music_palette_auto_chosen', { palette: paletteLabel(t, music.palette.id) })
      : t('reader.music_palette_auto');
  const volume = prefs.volumeDb;
  const fill = ((volume - MUSIC_VOLUME_MIN_DB) / (MUSIC_VOLUME_MAX_DB - MUSIC_VOLUME_MIN_DB)) * 100;
  const hasMusic = Boolean(music && music.status !== 'off');

  return (
    <section aria-labelledby="reader-music" className="space-y-2">
      <h3
        id="reader-music"
        className="flex items-center gap-2 px-1 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground"
      >
        {t('reader.music')}
        <span className="rd-lab-badge normal-case tracking-normal">
          {t('reader.labs_experimental')}
        </span>
      </h3>
      <SheetRow
        icon={Music2Icon}
        label={t('reader.music_doc')}
        detail={on ? status : t('reader.music_hint')}
        role="switch"
        aria-checked={on}
        checked={on}
        trailing={
          on && (busy || pending === 'prepare') ? (
            <Loader2Icon className="size-4 animate-spin text-muted-foreground" aria-hidden="true" />
          ) : undefined
        }
        onClick={toggle}
      />
      {on && busy && (
        <div
          className="mx-3 h-1 overflow-hidden rounded-full bg-foreground/10"
          role="progressbar"
          aria-label={status}
          aria-valuenow={musicPercent(music)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className="h-full bg-primary" style={{ width: `${musicPercent(music)}%` }} />
        </div>
      )}
      {on && (
        <div className="space-y-3 px-1">
          {engineMissing && (
            <p className="text-xs leading-relaxed text-muted-foreground" role="note">
              {t('reader.music_engine_missing')}
            </p>
          )}
          <div>
            <div
              className="grid grid-cols-2 gap-2"
              role="radiogroup"
              aria-label={t('reader.music_mode')}
            >
              {MODES.map((mode) => (
                <button
                  key={mode.id}
                  type="button"
                  role="radio"
                  aria-checked={prefs.mode === mode.id}
                  data-active={prefs.mode === mode.id}
                  className="rd-chip w-full"
                  onClick={() => setMusicPrefs({ mode: mode.id })}
                >
                  {t(mode.label)}
                </button>
              ))}
            </div>
            <p className="mt-1.5 px-1 text-xs leading-relaxed text-muted-foreground">
              {t(MODES.find((mode) => mode.id === prefs.mode)?.hint ?? MODES[0].hint)}
            </p>
          </div>
          <div>
            <div className="flex items-baseline justify-between px-1">
              <span
                id="reader-music-volume"
                className="text-xs font-semibold text-muted-foreground"
              >
                {t('reader.music_volume')}
              </span>
              <span className="text-xs tabular-nums text-muted-foreground">{formatDb(volume)}</span>
            </div>
            <input
              type="range"
              className="rd-range"
              min={MUSIC_VOLUME_MIN_DB}
              max={MUSIC_VOLUME_MAX_DB}
              step={1}
              value={volume}
              aria-labelledby="reader-music-volume"
              aria-valuetext={formatDb(volume)}
              style={{ '--rd-fill': `${fill}%` } as CSSProperties}
              onChange={(event) => setMusicPrefs({ volumeDb: Number(event.target.value) })}
            />
          </div>
          <label className="block">
            <span className="block px-1 pb-1 text-xs font-semibold text-muted-foreground">
              {t('reader.music_palette')}
            </span>
            <select
              className="rd-input rd-lab-select"
              value={chosen}
              disabled={pending !== null || engineMissing}
              onChange={(event) => void prepare(event.target.value || 'auto')}
            >
              <option value="">{autoLabel}</option>
              {palettes.map((id) => (
                <option key={id} value={id}>
                  {paletteLabel(t, id)}
                </option>
              ))}
            </select>
          </label>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              className="rd-chip w-full"
              disabled={pending !== null || busy || engineMissing}
              onClick={() => void prepare()}
            >
              {pending === 'prepare' ? (
                <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <RefreshCwIcon className="size-4" aria-hidden="true" />
              )}
              {t('reader.music_prepare')}
            </button>
            <button
              type="button"
              className={cn('rd-chip w-full', confirmDelete && 'text-destructive')}
              disabled={pending !== null || !hasMusic}
              onClick={() => void remove()}
              onBlur={() => setConfirmDelete(false)}
            >
              {pending === 'delete' ? (
                <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <Trash2Icon className="size-4" aria-hidden="true" />
              )}
              {t(confirmDelete ? 'reader.music_delete_confirm' : 'reader.music_delete')}
            </button>
          </div>
          <SheetRow
            className="-mx-1 w-[calc(100%+0.5rem)]"
            label={t('reader.music_offline')}
            detail={t('reader.music_offline_hint')}
            role="switch"
            aria-checked={prefs.offline}
            checked={prefs.offline}
            onClick={() => setMusicPrefs({ offline: !prefs.offline })}
          />
        </div>
      )}
    </section>
  );
}
