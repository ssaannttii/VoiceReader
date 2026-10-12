import { useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertCircleIcon,
  CloudOffIcon,
  Loader2Icon,
  MoonIcon,
  PauseIcon,
  PlayIcon,
  RotateCcwIcon,
  RotateCwIcon,
  SkipBackIcon,
  SkipForwardIcon,
  UserRoundIcon,
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { readerApi, readerKeys, type ReaderDocument } from './reader-api';
import { readerPlayer, useReaderClock, useReaderPlayer } from './reader-player';
import { SleepLabel } from './player-sheets';
import { formatClock, formatSpeed } from './reader-text';

export type DockSheet = 'speed' | 'voice' | 'sleep';

function Scrubber({ doc }: { doc: ReaderDocument }) {
  const { t } = useTranslation();
  const { segment, rate } = useReaderPlayer();
  const clock = useReaderClock();
  const [preview, setPreview] = useState<number | null>(null);
  const count = Math.max(1, doc.segments.length);
  const within = clock.duration > 0 ? Math.min(0.999, clock.time / clock.duration) : 0;
  const value = preview ?? segment + within;
  const previewSegment = preview === null ? null : Math.min(count - 1, Math.floor(preview));
  const elapsed = previewSegment === null ? clock.elapsed : readerPlayer.secondsAt(previewSegment);
  const total = clock.total || doc.est_duration_s;
  const commit = () => {
    if (previewSegment !== null) {
      readerPlayer.seekSegment(previewSegment);
      window.dispatchEvent(new Event('reader:follow'));
    }
    setPreview(null);
  };
  return (
    <div className="relative">
      {previewSegment !== null && (
        <div className="pointer-events-none absolute inset-x-0 bottom-full mb-2 flex justify-center">
          <p className="line-clamp-2 max-w-md rounded-xl bg-popover px-3 py-2 text-center font-[family-name:var(--rd-serif)] text-sm shadow-lg ring-1 ring-border">
            {doc.segments[previewSegment]?.text}
          </p>
        </div>
      )}
      <input
        type="range"
        className="rd-range -my-2 block"
        min={0}
        max={count}
        step="any"
        value={value}
        aria-label={t('reader.position')}
        aria-valuetext={`${formatClock(elapsed / rate)} / ${formatClock(total / rate)}`}
        style={{ '--rd-fill': `${(value / count) * 100}%` } as CSSProperties}
        onChange={(event) => setPreview(Number(event.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={() => setPreview(null)}
      />
      <div className="flex justify-between text-[11px] font-medium tabular-nums text-muted-foreground">
        <span>{formatClock(elapsed / rate)}</span>
        <span>−{formatClock(Math.max(0, total - elapsed) / rate)}</span>
      </div>
    </div>
  );
}

export function PlayerDock({
  doc,
  active,
  onSheet,
  onActivate,
}: {
  doc: ReaderDocument;
  /** This document is loaded in the player. */
  active: boolean;
  onSheet: (sheet: DockSheet) => void;
  /** Load this document (replacing whatever plays) and start it. */
  onActivate: () => void;
}) {
  const { t } = useTranslation();
  const player = useReaderPlayer();
  const voices = useQuery({
    queryKey: readerKeys.voices,
    queryFn: ({ signal }) => readerApi.voices(signal),
    staleTime: 60_000,
  });
  const voiceName = player.voice
    ? (voices.data?.find((voice) => voice.id === player.voice)?.name ?? t('reader.voice'))
    : t('reader.voice_default');
  if (!active) {
    return (
      <div className="rd-dock">
        <div className="mx-auto flex max-w-xl items-center gap-3 py-1">
          <p className="min-w-0 flex-1 text-sm text-muted-foreground">
            {t('reader.replace_playing', { title: player.doc?.title ?? '' })}
          </p>
          <button
            type="button"
            className="rd-press inline-flex h-12 shrink-0 items-center gap-2 rounded-full bg-foreground px-5 font-semibold text-background"
            onClick={onActivate}
          >
            <PlayIcon className="size-4 fill-current" aria-hidden="true" />
            {t('reader.listen')}
          </button>
        </div>
      </div>
    );
  }
  const busy = player.status === 'buffering';
  const playing = player.status === 'playing' || busy;
  const last = doc.segments.length - 1;
  return (
    <div className="rd-dock" data-slot="reader-dock">
      <div className="mx-auto max-w-xl">
        {player.status === 'error' && (
          <div
            className="mb-2 flex items-center gap-2 rounded-2xl bg-destructive/10 py-1.5 pl-3 pr-1.5 text-sm text-destructive"
            role="alert"
          >
            <AlertCircleIcon className="size-4 shrink-0" aria-hidden="true" />
            <span className="line-clamp-2 min-w-0 flex-1">{player.error}</span>
            <button
              type="button"
              className="rd-press h-9 shrink-0 rounded-full bg-destructive px-3.5 text-xs font-semibold text-white"
              onClick={() => readerPlayer.retry()}
            >
              {t('reader.retry')}
            </button>
          </div>
        )}
        <Scrubber doc={doc} />
        <div className="mt-1 flex items-center justify-center gap-[clamp(0.25rem,3vw,1.25rem)]">
          <button
            type="button"
            className="rd-icon-btn"
            aria-label={t('reader.back_15')}
            onClick={() => readerPlayer.skip(-15)}
          >
            <RotateCcwIcon className="size-[1.35rem]" aria-hidden="true" />
          </button>
          <button
            type="button"
            className="rd-icon-btn"
            aria-label={t('reader.previous')}
            disabled={player.segment <= 0 && !playing}
            onClick={() => readerPlayer.previous()}
          >
            <SkipBackIcon className="size-6 fill-current" aria-hidden="true" />
          </button>
          <button
            type="button"
            className="rd-play mx-1"
            aria-label={t(playing ? 'reader.pause' : 'reader.play')}
            onClick={() => readerPlayer.toggle()}
          >
            {busy ? (
              <Loader2Icon className="size-7 animate-spin" aria-hidden="true" />
            ) : playing ? (
              <PauseIcon className="size-7 fill-current" aria-hidden="true" />
            ) : (
              <PlayIcon className="ml-1 size-7 fill-current" aria-hidden="true" />
            )}
          </button>
          <button
            type="button"
            className="rd-icon-btn"
            aria-label={t('reader.next')}
            disabled={player.segment >= last}
            onClick={() => readerPlayer.next()}
          >
            <SkipForwardIcon className="size-6 fill-current" aria-hidden="true" />
          </button>
          <button
            type="button"
            className="rd-icon-btn"
            aria-label={t('reader.forward_15')}
            onClick={() => readerPlayer.skip(15)}
          >
            <RotateCwIcon className="size-[1.35rem]" aria-hidden="true" />
          </button>
        </div>
        <div className="mt-1 flex items-center justify-center gap-2">
          <button
            type="button"
            className="rd-chip min-w-[4.25rem]"
            aria-label={`${t('reader.speed')}: ${formatSpeed(player.rate)}`}
            onClick={() => onSheet('speed')}
          >
            {formatSpeed(player.rate)}
          </button>
          <button
            type="button"
            className="rd-chip min-w-0 max-w-[11rem]"
            onClick={() => onSheet('voice')}
            aria-label={`${t('reader.voice')}: ${voiceName}`}
          >
            {player.offline ? (
              <CloudOffIcon className="size-4 shrink-0" aria-hidden="true" />
            ) : (
              <UserRoundIcon className="size-4 shrink-0" aria-hidden="true" />
            )}
            <span className="truncate">{voiceName}</span>
          </button>
          <button
            type="button"
            className="rd-chip"
            data-active={player.sleep.mode !== 'off'}
            aria-label={t('reader.sleep_timer')}
            onClick={() => onSheet('sleep')}
          >
            <MoonIcon className="size-4 shrink-0" aria-hidden="true" />
            <SleepLabel />
          </button>
        </div>
      </div>
    </div>
  );
}
