import { useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertCircleIcon,
  BookmarkPlusIcon,
  ChevronDownIcon,
  ListIcon,
  ListOrderedIcon,
  Loader2Icon,
  MoonIcon,
  PauseIcon,
  PlayIcon,
  RotateCcwIcon,
  RotateCwIcon,
  SearchIcon,
  SkipBackIcon,
  SkipForwardIcon,
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { readerApi, readerKeys, type ReaderDocument } from './reader-api';
import { readerPlayer, useReaderClock, useReaderPlayer } from './reader-player';
import { FOLLOW_EVENT } from './player-sheets';
import { useReaderPrefs } from './reader-prefs';
import { chapterIndexAt, formatClock, formatSpeed, segmentLabel } from './reader-text';
import { EngineBanner, useEngineView } from './engine-status';
import { useListeningPrefs } from './listening-prefs';
import { useReaderQueue } from './reader-queue';
import { soundscapeIcon } from './soundscape-sheet';
import { durationParts, scrubRange, scrubTimes, snapToMark } from './player-chrome';
import { VoiceAvatar } from './voice-avatar';
import { tick } from './haptics';

export type DockSheet =
  | 'speed'
  | 'voice'
  | 'sleep'
  | 'queue'
  | 'soundscape'
  | 'search'
  | 'chapters';

/** "2 h 14 min" / "14 min" for the scrubber's remaining time. */
export function useDuration() {
  const { t } = useTranslation();
  return (seconds: number) => {
    const { hours, minutes } = durationParts(seconds);
    return hours > 0
      ? t('reader.duration_hm', { hours, minutes })
      : t('reader.minutes_total', { minutes });
  };
}

/** Thumb travel is inset by half its width (1rem thumb) on both ends of the track. */
const THUMB_PX = 16;

function Scrubber({ doc }: { doc: ReaderDocument }) {
  const { t } = useTranslation();
  const duration = useDuration();
  const { segment, rate, furthest, sleep } = useReaderPlayer();
  const clock = useReaderClock();
  const [preview, setPreview] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const snapped = useRef(false);
  const count = Math.max(1, doc.segments.length);
  // The range follows the playhead, not the drag: a drag stays inside its chapter.
  const range = scrubRange(doc.chapters, count, segment);
  const span = range.end - range.start;
  const within = clock.duration > 0 ? Math.min(0.999, clock.time / clock.duration) : 0;
  const value = preview ?? Math.min(range.end, Math.max(range.start, segment + within));
  const previewSegment =
    preview === null ? null : Math.min(range.end - 1, Math.max(range.start, Math.floor(preview)));
  const elapsed = previewSegment === null ? clock.elapsed : readerPlayer.secondsAt(previewSegment);
  const total = clock.total || doc.est_duration_s;
  const times = scrubTimes(range, elapsed, total, rate, (index) => readerPlayer.secondsAt(index));
  const fraction = (at: number) => Math.min(1, Math.max(0, (at - range.start) / span));
  const markShown = furthest > segment && furthest >= range.start && furthest < range.end;

  const commit = () => {
    snapped.current = false;
    setDragging(false);
    if (previewSegment !== null) {
      readerPlayer.seekSegment(previewSegment);
      window.dispatchEvent(new Event(FOLLOW_EVENT));
    }
    setPreview(null);
  };
  const onInput = (input: HTMLInputElement, next: number) => {
    if (markShown) {
      const usable = Math.max(1, input.getBoundingClientRect().width - THUMB_PX);
      const stick = snapToMark(
        fraction(next) * usable,
        fraction(furthest) * usable,
        snapped.current,
      );
      if (stick && !snapped.current) tick();
      snapped.current = stick;
      if (stick) {
        setPreview(furthest);
        return;
      }
    }
    setPreview(next);
  };
  const startDrag = (event: PointerEvent<HTMLInputElement>) => {
    if (event.isPrimary) setDragging(true);
  };

  const sleepLabel =
    sleep.mode === 'time'
      ? formatClock((clock.sleepLeft ?? 0) / 1000)
      : sleep.mode === 'chapter'
        ? t('reader.sleep_chapter_short')
        : null;
  return (
    <div className="rd-scrub" data-dragging={dragging || undefined}>
      {previewSegment !== null && (
        <div className="pointer-events-none absolute inset-x-0 bottom-full mb-2 flex justify-center">
          <p className="line-clamp-2 max-w-md rounded-xl bg-popover px-3 py-2 text-center font-[family-name:var(--rd-serif)] text-sm shadow-lg ring-1 ring-border">
            {segmentLabel(doc.segments[previewSegment], t('reader.image'))}
          </p>
        </div>
      )}
      <div className="relative">
        <input
          type="range"
          className="rd-range block"
          min={range.start}
          max={range.end}
          step="any"
          value={value}
          aria-label={t('reader.position')}
          aria-valuetext={`${formatClock(times.left)} / ${formatClock(times.right)}`}
          style={{ '--rd-fill': `${fraction(value) * 100}%` } as CSSProperties}
          onChange={(event) => onInput(event.currentTarget, Number(event.currentTarget.value))}
          onPointerDown={startDrag}
          onPointerUp={commit}
          onPointerCancel={commit}
          onKeyUp={commit}
          onBlur={() => {
            setDragging(false);
            setPreview(null);
          }}
        />
        {markShown && (
          <span
            className="rd-furthest-dot"
            data-snapped={(preview !== null && snapped.current) || undefined}
            style={{ '--rd-at': fraction(furthest) } as CSSProperties}
            aria-hidden="true"
          />
        )}
      </div>
      <div className="rd-scrub-times">
        <span>{formatClock(times.left)}</span>
        <span className="flex min-w-0 items-center justify-center gap-1.5">
          <span className="truncate">
            {t('reader.time_left', { time: duration(times.remaining) })}
          </span>
          {sleepLabel && (
            <span className="flex shrink-0 items-center gap-1" data-slot="reader-sleep-left">
              <span aria-hidden="true">·</span>
              <MoonIcon className="size-3" aria-hidden="true" />
              <span className="sr-only">{t('reader.sleep_timer')}:</span>
              {sleepLabel}
            </span>
          )}
        </span>
        <span className="text-right">
          {times.rightIsRemaining ? '−' : ''}
          {formatClock(times.right)}
        </span>
      </div>
    </div>
  );
}

/** "≡ Chapter title": opens the chapters list. */
function ChapterChip({ doc, onOpen }: { doc: ReaderDocument; onOpen: () => void }) {
  const { t } = useTranslation();
  const { segment } = useReaderPlayer();
  const title = doc.chapters[chapterIndexAt(doc.chapters, segment)]?.title;
  return (
    <div className="flex justify-center">
      <button
        type="button"
        className="rd-chapter-chip"
        aria-label={title ? `${t('reader.chapters')}: ${title}` : t('reader.chapters')}
        onClick={onOpen}
      >
        <ListIcon className="size-4 shrink-0" aria-hidden="true" />
        <span className="truncate">{title ?? t('reader.chapters')}</span>
      </button>
    </div>
  );
}

function VoicePill({ onOpen }: { onOpen: () => void }) {
  const { t } = useTranslation();
  const player = useReaderPlayer();
  const voices = useQuery({
    queryKey: readerKeys.voices,
    queryFn: ({ signal }) => readerApi.voices(signal),
    staleTime: 60_000,
  });
  const name = player.voice
    ? (voices.data?.find((voice) => voice.id === player.voice)?.name ?? t('reader.voice'))
    : t('reader.voice_default');
  return (
    <button
      type="button"
      className="rd-voice-pill"
      aria-label={`${t('reader.voice')}: ${name}`}
      onClick={onOpen}
    >
      <VoiceAvatar id={player.voice} name={name} offline={player.offline} />
      <span className="min-w-0 truncate">{name}</span>
      <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" aria-hidden="true" />
    </button>
  );
}

export function PlayerDock({
  doc,
  active,
  onSheet,
  onActivate,
  onBookmark,
}: {
  doc: ReaderDocument;
  /** This document is loaded in the player. */
  active: boolean;
  onSheet: (sheet: DockSheet) => void;
  /** Load this document (replacing whatever plays) and start it. */
  onActivate: () => void;
  onBookmark: () => void;
}) {
  const { t } = useTranslation();
  const player = useReaderPlayer();
  const prefs = useReaderPrefs();
  const engineView = useEngineView(doc.id);
  const { soundscape } = useListeningPrefs();
  const queued = useReaderQueue().filter((item) => item.id !== doc.id).length;
  if (!active) {
    return (
      <div className="rd-dock" data-slot="reader-dock-inactive">
        <div className="rd-dock-inner flex items-center gap-3 py-1">
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
  const ended = player.status === 'ended';
  const last = doc.segments.length - 1;
  const seconds = prefs.skipSeconds;
  const byChapter = prefs.trackAction === 'chapter' && doc.chapters.length > 0;
  const showTrack = prefs.trackAction !== 'skip';
  const sleeping = player.sleep.mode !== 'off';
  const SoundIcon = soundscapeIcon(soundscape);
  return (
    <div className="rd-dock" data-slot="reader-dock">
      <div className="rd-dock-inner">
        {player.status !== 'error' && <EngineBanner view={engineView} />}
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
        {doc.chapters.length > 0 && <ChapterChip doc={doc} onOpen={() => onSheet('chapters')} />}
        <Scrubber doc={doc} />
        <div className="rd-transport">
          <button
            type="button"
            className="rd-icon-btn rd-sleep-btn"
            data-active={sleeping || undefined}
            aria-label={t('reader.sleep_timer')}
            aria-pressed={sleeping}
            onClick={() => onSheet('sleep')}
          >
            <MoonIcon
              className={sleeping ? 'size-6 fill-current' : 'size-6'}
              strokeWidth={1.8}
              aria-hidden="true"
            />
          </button>
          <button
            type="button"
            className="rd-icon-btn relative"
            aria-label={t('reader.back_seconds', { seconds })}
            onClick={() => readerPlayer.skip(-seconds)}
          >
            <RotateCcwIcon className="size-[1.75rem]" strokeWidth={1.6} aria-hidden="true" />
            <span className="rd-skip-num" aria-hidden="true">
              {seconds}
            </span>
          </button>
          {showTrack && (
            <button
              type="button"
              className="rd-icon-btn rd-track-btn"
              aria-label={t(byChapter ? 'reader.previous_chapter' : 'reader.previous')}
              disabled={player.segment <= 0 && !playing}
              onClick={() => readerPlayer.trackPrevious()}
            >
              <SkipBackIcon className="size-5 fill-current" aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            className="rd-play"
            aria-label={t(ended ? 'reader.restart' : playing ? 'reader.pause' : 'reader.play')}
            onClick={() => readerPlayer.toggle()}
          >
            {busy ? (
              <Loader2Icon className="size-7 animate-spin" aria-hidden="true" />
            ) : playing ? (
              <PauseIcon className="size-7 fill-current" aria-hidden="true" />
            ) : ended ? (
              <RotateCcwIcon className="size-7" strokeWidth={2.2} aria-hidden="true" />
            ) : (
              <PlayIcon className="ml-1 size-7 fill-current" aria-hidden="true" />
            )}
          </button>
          {showTrack && (
            <button
              type="button"
              className="rd-icon-btn rd-track-btn"
              aria-label={t(byChapter ? 'reader.next_chapter' : 'reader.next')}
              disabled={player.segment >= last}
              onClick={() => readerPlayer.trackNext()}
            >
              <SkipForwardIcon className="size-5 fill-current" aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            className="rd-icon-btn relative"
            aria-label={t('reader.forward_seconds', { seconds })}
            onClick={() => readerPlayer.skip(seconds)}
          >
            <RotateCwIcon className="size-[1.75rem]" strokeWidth={1.6} aria-hidden="true" />
            <span className="rd-skip-num" aria-hidden="true">
              {seconds}
            </span>
          </button>
          <button
            type="button"
            className="rd-icon-btn rd-speed-btn"
            aria-label={`${t('reader.speed')}: ${formatSpeed(player.rate)}`}
            onClick={() => onSheet('speed')}
          >
            {formatSpeed(player.rate)}
          </button>
        </div>
        <div className="rd-actions-row">
          <div className="flex items-center">
            <button
              type="button"
              className="rd-icon-btn rd-quiet-btn"
              data-active={soundscape !== 'off' || undefined}
              aria-label={t('reader.soundscape')}
              onClick={() => onSheet('soundscape')}
            >
              <SoundIcon className="size-5" aria-hidden="true" />
            </button>
            <button
              type="button"
              className="rd-icon-btn rd-quiet-btn"
              aria-label={t('reader.search_document')}
              onClick={() => onSheet('search')}
            >
              <SearchIcon className="size-5" aria-hidden="true" />
            </button>
          </div>
          <VoicePill onOpen={() => onSheet('voice')} />
          <div className="flex items-center justify-end">
            <button
              type="button"
              className="rd-icon-btn rd-quiet-btn"
              aria-label={t('reader.bookmark_add')}
              disabled={!doc.segments.length}
              onClick={onBookmark}
            >
              <BookmarkPlusIcon className="size-5" aria-hidden="true" />
            </button>
            <button
              type="button"
              className="rd-icon-btn rd-quiet-btn relative"
              data-active={queued > 0 || undefined}
              aria-label={t('reader.queue_open', { count: queued })}
              onClick={() => onSheet('queue')}
            >
              <ListOrderedIcon className="size-5" aria-hidden="true" />
              {queued > 0 && (
                <span className="rd-chip-badge" aria-hidden="true">
                  {queued}
                </span>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
