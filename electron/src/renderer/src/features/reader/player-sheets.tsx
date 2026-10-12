import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  BookmarkIcon,
  Loader2Icon,
  MinusIcon,
  PlusIcon,
  SquareIcon,
  UserRoundIcon,
  Volume2Icon,
} from 'lucide-react';
import { claimPlayback } from '@/lib/audio/playback';
import { createObjectUrl, revokeObjectUrl } from '@/lib/audio/object-url';
import { describeError } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import { readerApi, readerKeys, type ReaderDocument, type ReaderVoice } from './reader-api';
import { readerPlayer, silentWav, useReaderClock, useReaderPlayer } from './reader-player';
import { ReaderSheet, SheetRow } from './reader-sheet';
import {
  chapterIndexAt,
  clampSpeed,
  formatClock,
  formatSpeed,
  SPEED_MAX,
  SPEED_MIN,
  SPEED_PRESETS,
} from './reader-text';

type SheetProps = { open: boolean; onOpenChange: (open: boolean) => void };

export function SpeedSheet({ open, onOpenChange }: SheetProps) {
  const { t } = useTranslation();
  const { rate } = useReaderPlayer();
  const fill = ((rate - SPEED_MIN) / (SPEED_MAX - SPEED_MIN)) * 100;
  return (
    <ReaderSheet open={open} onOpenChange={onOpenChange} title={t('reader.speed')}>
      <div className="pb-2">
        <div className="flex items-center justify-between gap-3 py-2">
          <button
            type="button"
            className="rd-icon-btn bg-foreground/[0.07]"
            aria-label={t('reader.slower')}
            disabled={rate <= SPEED_MIN}
            onClick={() => readerPlayer.setRate(rate - 0.1)}
          >
            <MinusIcon className="size-5" aria-hidden="true" />
          </button>
          <output className="text-4xl font-semibold tabular-nums tracking-tight" aria-live="polite">
            {formatSpeed(rate)}
          </output>
          <button
            type="button"
            className="rd-icon-btn bg-foreground/[0.07]"
            aria-label={t('reader.faster')}
            disabled={rate >= SPEED_MAX}
            onClick={() => readerPlayer.setRate(rate + 0.1)}
          >
            <PlusIcon className="size-5" aria-hidden="true" />
          </button>
        </div>
        <input
          type="range"
          className="rd-range"
          min={SPEED_MIN}
          max={SPEED_MAX}
          step={0.1}
          value={rate}
          aria-label={t('reader.speed')}
          aria-valuetext={formatSpeed(rate)}
          style={{ '--rd-fill': `${fill}%` } as CSSProperties}
          onChange={(event) => readerPlayer.setRate(clampSpeed(Number(event.target.value)))}
        />
        <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-6">
          {SPEED_PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              className="rd-chip"
              aria-pressed={Math.abs(rate - preset) < 0.05}
              onClick={() => readerPlayer.setRate(preset)}
            >
              {formatSpeed(preset)}
            </button>
          ))}
        </div>
      </div>
    </ReaderSheet>
  );
}

const SLEEP_MINUTES = [5, 10, 15, 30, 45, 60] as const;

export function SleepSheet({ open, onOpenChange, doc }: SheetProps & { doc: ReaderDocument }) {
  const { t } = useTranslation();
  const { sleep } = useReaderPlayer();
  const choose = (option: Parameters<typeof readerPlayer.setSleep>[0]) => {
    readerPlayer.setSleep(option);
    onOpenChange(false);
  };
  return (
    <ReaderSheet open={open} onOpenChange={onOpenChange} title={t('reader.sleep_timer')}>
      <div className="space-y-0.5 pb-1">
        <SheetRow
          label={t('reader.sleep_off')}
          checked={sleep.mode === 'off'}
          onClick={() => choose({ mode: 'off' })}
        />
        {SLEEP_MINUTES.map((minutes) => (
          <SheetRow
            key={minutes}
            label={t('reader.minutes_total', { minutes })}
            checked={sleep.mode === 'time' && sleep.minutes === minutes}
            onClick={() => choose({ mode: 'time', minutes })}
          />
        ))}
        <SheetRow
          label={t(doc.chapters.length ? 'reader.sleep_chapter' : 'reader.sleep_end')}
          checked={sleep.mode === 'chapter'}
          onClick={() => choose({ mode: 'chapter' })}
        />
      </div>
    </ReaderSheet>
  );
}

/** Remaining sleep time as a compact chip label. */
export function SleepLabel() {
  const { t } = useTranslation();
  const { sleep } = useReaderPlayer();
  const clock = useReaderClock();
  if (sleep.mode === 'off') return <>{t('reader.sleep')}</>;
  if (sleep.mode === 'chapter') return <>{t('reader.sleep_chapter_short')}</>;
  return <>{formatClock((clock.sleepLeft ?? 0) / 1000)}</>;
}

export function ChaptersSheet({ open, onOpenChange, doc }: SheetProps & { doc: ReaderDocument }) {
  const { t } = useTranslation();
  const { segment } = useReaderPlayer();
  const current = chapterIndexAt(doc.chapters, segment);
  return (
    <ReaderSheet open={open} onOpenChange={onOpenChange} title={t('reader.chapters')}>
      <ol className="space-y-0.5 pb-1">
        {doc.chapters.map((chapter, index) => (
          <li key={`${chapter.segment}-${index}`}>
            <SheetRow
              icon={BookmarkIcon}
              label={chapter.title}
              checked={index === current}
              onClick={() => {
                readerPlayer.seekSegment(chapter.segment);
                window.dispatchEvent(new Event(FOLLOW_EVENT));
                onOpenChange(false);
              }}
            />
          </li>
        ))}
      </ol>
    </ReaderSheet>
  );
}

/** Asks the reading view to scroll back to the spoken sentence. */
export const FOLLOW_EVENT = 'reader:follow';

let previewAudio: HTMLAudioElement | null = null;

export function VoiceSheet({ open, onOpenChange, doc }: SheetProps & { doc: ReaderDocument }) {
  const { t } = useTranslation();
  const player = useReaderPlayer();
  const voices = useQuery({
    queryKey: readerKeys.voices,
    queryFn: ({ signal }) => readerApi.voices(signal),
    enabled: open,
    staleTime: 60_000,
  });
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const token = useRef(0);
  const urlRef = useRef<string | null>(null);
  const stopPreview = () => {
    token.current++;
    previewAudio?.pause();
    revokeObjectUrl(urlRef.current);
    urlRef.current = null;
    setPreviewing(null);
    setLoading(null);
  };
  useEffect(() => {
    if (!open) stopPreview();
  }, [open]);
  useEffect(() => () => stopPreview(), []);

  const preview = (voice: ReaderVoice) => {
    if (previewing === voice.id || loading === voice.id) {
      stopPreview();
      return;
    }
    stopPreview();
    const current = ++token.current;
    readerPlayer.pause();
    // Unlock inside the tap so the preview may start once it has rendered.
    previewAudio ??= new Audio();
    previewAudio.src = silentWav();
    void previewAudio.play().catch(() => {});
    setLoading(voice.id);
    const segment = Math.min(player.segment, doc.segments.length - 1);
    readerApi
      .render(doc.id, Math.max(0, segment), {
        voice: voice.id,
        engine: voice.engine,
        language: doc.language,
      })
      .then((render) => readerApi.audio(render.audio_url))
      .then((blob) => {
        if (current !== token.current || !previewAudio) return;
        const url = createObjectUrl(blob);
        if (!url) return;
        urlRef.current = url;
        const audio = previewAudio;
        audio.src = url;
        const release = claimPlayback(() => audio.pause(), 'reader-preview');
        audio.onended = () => {
          release();
          if (current === token.current) setPreviewing(null);
        };
        setLoading(null);
        setPreviewing(voice.id);
        return audio.play();
      })
      .catch((error: unknown) => {
        if (current !== token.current) return;
        setLoading(null);
        toast.error(t('reader.preview_failed'), { description: describeError(error) });
      });
  };

  const choose = (voice: ReaderVoice | null) => {
    stopPreview();
    readerPlayer.setVoice(voice?.id ?? null, voice?.engine ?? null);
    onOpenChange(false);
  };

  const list = voices.data ?? [];
  const groups: [string, ReaderVoice[]][] = [
    ['reader.voices_mine', list.filter((voice) => voice.kind === 'profile')],
    ['reader.voices_builtin', list.filter((voice) => voice.kind === 'preset')],
  ];
  return (
    <ReaderSheet open={open} onOpenChange={onOpenChange} title={t('reader.voice')}>
      <div className="pb-1">
        <SheetRow
          icon={Volume2Icon}
          label={t('reader.voice_default')}
          detail={t('reader.voice_default_hint')}
          checked={player.voice === null}
          onClick={() => choose(null)}
        />
        {voices.isPending && (
          <div className="space-y-2 py-2" aria-hidden="true">
            {[0, 1, 2].map((index) => (
              <div key={index} className="rd-skeleton h-12" />
            ))}
          </div>
        )}
        {voices.isError && (
          <p className="px-3 py-4 text-sm text-destructive" role="alert">
            {describeError(voices.error)}
          </p>
        )}
        {groups.map(([label, items]) =>
          items.length ? (
            <section key={label} className="mt-3">
              <h3 className="px-3 pb-1 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                {t(label)}
              </h3>
              <ul className="space-y-0.5">
                {items.map((voice) => (
                  <li key={voice.id} className="flex items-center gap-1">
                    <SheetRow
                      className="flex-1"
                      icon={UserRoundIcon}
                      label={voice.name}
                      detail={
                        [voice.description, voice.language?.toUpperCase()]
                          .filter(Boolean)
                          .join(' · ') || undefined
                      }
                      checked={player.voice === voice.id}
                      onClick={() => choose(voice)}
                    />
                    <button
                      type="button"
                      className={cn(
                        'rd-icon-btn shrink-0 bg-foreground/[0.06]',
                        previewing === voice.id && 'bg-foreground text-background',
                      )}
                      aria-label={t(
                        previewing === voice.id ? 'reader.stop_preview' : 'reader.preview',
                        { name: voice.name },
                      )}
                      onClick={() => preview(voice)}
                    >
                      {loading === voice.id ? (
                        <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
                      ) : previewing === voice.id ? (
                        <SquareIcon className="size-3.5 fill-current" aria-hidden="true" />
                      ) : (
                        <Volume2Icon className="size-4" aria-hidden="true" />
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null,
        )}
      </div>
    </ReaderSheet>
  );
}
