import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  CheckIcon,
  Loader2Icon,
  MinusIcon,
  PlayIcon,
  PlusIcon,
  SquareIcon,
  Volume2Icon,
  StarIcon,
} from 'lucide-react';
import { claimPlayback } from '@/lib/audio/playback';
import { createObjectUrl, revokeObjectUrl } from '@/lib/audio/object-url';
import { describeError } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import { readerApi, readerKeys, type ReaderDocument, type ReaderVoice } from './reader-api';
import { readerPlayer, silentWav, useReaderPlayer } from './reader-player';
import { ReaderSheet, SheetRow } from './reader-sheet';
import { SearchField } from './search-field';
import {
  chapterSeconds,
  chapterStates,
  estimatedSecondsAt,
  type ChapterState,
} from './chapter-progress';
import { VoiceAvatar } from './voice-avatar';
import {
  chapterIndexAt,
  clampSpeed,
  formatClock,
  formatPercent,
  formatSpeed,
  SPEED_MAX,
  SPEED_MIN,
} from './reader-text';
import {
  ALL_LANGUAGES,
  defaultVoiceLanguage,
  filterVoices,
  languageName,
  recentVoiceIds,
  rememberVoice,
  VOICE_SEARCH_MIN,
  voiceLanguages,
} from './voice-picker';

type SheetProps = { open: boolean; onOpenChange: (open: boolean) => void };

/** Tappable speed marks under the slider, each at its true position on the track. */
const SPEED_MARKS = [0.5, 1, 1.5, 2, 2.5, 3] as const;

export function SpeedSheet({ open, onOpenChange }: SheetProps) {
  const { t } = useTranslation();
  const { rate } = useReaderPlayer();
  const at = (value: number) => (value - SPEED_MIN) / (SPEED_MAX - SPEED_MIN);
  return (
    <ReaderSheet
      open={open}
      onOpenChange={onOpenChange}
      title={
        <>
          {t('reader.speed')}
          <span className="tabular-nums text-muted-foreground"> · {formatSpeed(rate)}</span>
        </>
      }
    >
      <div className="flex items-start gap-2 pb-2 pt-1">
        <button
          type="button"
          className="rd-icon-btn bg-foreground/[0.07]"
          aria-label={t('reader.slower')}
          disabled={rate <= SPEED_MIN}
          onClick={() => readerPlayer.setRate(rate - 0.1)}
        >
          <MinusIcon className="size-5" aria-hidden="true" />
        </button>
        <div className="min-w-0 flex-1">
          <input
            type="range"
            className="rd-range"
            min={SPEED_MIN}
            max={SPEED_MAX}
            step={0.1}
            value={rate}
            aria-label={t('reader.speed')}
            aria-valuetext={formatSpeed(rate)}
            style={{ '--rd-fill': `${at(rate) * 100}%` } as CSSProperties}
            onChange={(event) => readerPlayer.setRate(clampSpeed(Number(event.target.value)))}
          />
          <div className="rd-speed-marks">
            {SPEED_MARKS.map((mark) => (
              <button
                key={mark}
                type="button"
                className="rd-speed-mark"
                style={{ '--rd-at': at(mark) } as CSSProperties}
                aria-pressed={Math.abs(rate - mark) < 0.05}
                onClick={() => readerPlayer.setRate(mark)}
              >
                {formatSpeed(mark)}
              </button>
            ))}
          </div>
        </div>
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
    </ReaderSheet>
  );
}

const SLEEP_MINUTES = [5, 10, 15, 30, 45, 60, 90, 120] as const;

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

/** Small ring showing how much of a chapter the furthest point covers. */
function ProgressRing({ percent }: { percent: number }) {
  const radius = 6;
  const length = 2 * Math.PI * radius;
  return (
    <svg className="size-3.5 shrink-0 -rotate-90" viewBox="0 0 16 16" aria-hidden="true">
      <circle
        cx="8"
        cy="8"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.2"
        strokeWidth="2.5"
      />
      <circle
        cx="8"
        cy="8"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeDasharray={`${(length * percent) / 100} ${length}`}
      />
    </svg>
  );
}

function ChapterTrailing({ state, seconds }: { state: ChapterState; seconds: number }) {
  const { t } = useTranslation();
  if (state.kind === 'partial')
    return (
      <span className="flex shrink-0 items-center gap-1.5 text-xs tabular-nums">
        <ProgressRing percent={state.percent} />
        {formatPercent(state.percent)}
      </span>
    );
  return (
    <span className="shrink-0 text-[0.8125rem] tabular-nums">
      {state.kind === 'done' && <span className="sr-only">{t('reader.chapter_listened')} · </span>}
      {formatClock(seconds)}
    </span>
  );
}

export function ChaptersSheet({ open, onOpenChange, doc }: SheetProps & { doc: ReaderDocument }) {
  const { t } = useTranslation();
  const player = useReaderPlayer();
  const loaded = player.doc?.id === doc.id;
  const segment = loaded ? player.segment : doc.position_segment;
  const furthest = loaded ? player.furthest : (doc.furthest_segment ?? doc.position_segment);
  const current = chapterIndexAt(doc.chapters, segment);
  const states = useMemo(
    () => chapterStates(doc.chapters, doc.segments.length, segment, furthest),
    [doc.chapters, doc.segments.length, segment, furthest],
  );
  // The player's timings firm up as sentences render; reopening the sheet refreshes them.
  const lengths = useMemo(
    () =>
      open
        ? chapterSeconds(
            doc.chapters,
            doc.segments.length,
            loaded ? (index) => readerPlayer.secondsAt(index) : estimatedSecondsAt(doc.segments),
          )
        : [],
    [open, doc.chapters, doc.segments, loaded],
  );
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    if (!open) return;
    // The drawer mounts its content on open: centre the current chapter once it is there.
    const timer = setTimeout(() => {
      list.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'center' });
    }, 60);
    return () => clearTimeout(timer);
  }, [open]);
  const rate = player.rate || 1;
  return (
    <ReaderSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t('reader.chapters')}
      className={doc.chapters.length > 8 ? 'rd-sheet-tall' : undefined}
    >
      <ol ref={list} className="space-y-0.5 pb-1">
        {doc.chapters.map((chapter, index) => {
          const state = states[index] ?? { kind: 'unread' };
          const now = index === current;
          return (
            <li key={`${chapter.segment}-${index}`}>
              <button
                type="button"
                className="rd-chapter-row"
                data-state={state.kind}
                aria-current={now ? 'true' : undefined}
                onClick={() => {
                  readerPlayer.seekSegment(chapter.segment);
                  window.dispatchEvent(new Event(FOLLOW_EVENT));
                  onOpenChange(false);
                }}
              >
                <span className="rd-chapter-lead" aria-hidden="true">
                  {now ? (
                    <PlayIcon className="size-4 fill-current" />
                  ) : state.kind === 'done' ? (
                    <CheckIcon className="size-4" />
                  ) : null}
                </span>
                <span className="line-clamp-2 min-w-0 flex-1">
                  {now && <span className="sr-only">{t('reader.chapter_now')} · </span>}
                  {chapter.title}
                </span>
                <ChapterTrailing state={state} seconds={(lengths[index] ?? 0) / rate} />
              </button>
            </li>
          );
        })}
      </ol>
    </ReaderSheet>
  );
}

/** Asks the reading view to scroll back to the spoken sentence. */
export const FOLLOW_EVENT = 'reader:follow';

let previewAudio: HTMLAudioElement | null = null;

export function VoiceSheet({ open, onOpenChange, doc }: SheetProps & { doc: ReaderDocument }) {
  const { t, i18n } = useTranslation();
  const player = useReaderPlayer();
  const voices = useQuery({
    queryKey: readerKeys.voices,
    queryFn: ({ signal }) => readerApi.voices(signal),
    enabled: open,
    staleTime: 60_000,
  });
  const client = useQueryClient();
  const defaults = useQuery({
    queryKey: readerKeys.defaultVoices,
    queryFn: ({ signal }) => readerApi.defaultVoices(signal),
    enabled: open && Boolean(doc.language),
    staleTime: 60_000,
  });
  const defaultId = doc.language ? defaults.data?.[doc.language] : undefined;
  const toggleDefault = (voice: ReaderVoice) => {
    if (!doc.language) return;
    const next = defaultId === voice.id ? null : voice.id;
    readerApi
      .setDefaultVoice(doc.language, next)
      .then((saved) => {
        client.setQueryData(readerKeys.defaultVoices, saved);
        if (next) toast.success(t('reader.default_voice_set', { name: voice.name }));
      })
      .catch((error: unknown) => toast.error(describeError(error)));
  };
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
    if (voice) rememberVoice(voice.id);
    readerPlayer.setVoice(voice?.id ?? null, voice?.engine ?? null);
    onOpenChange(false);
  };

  const list = useMemo(() => voices.data ?? [], [voices.data]);
  const [query, setQuery] = useState('');
  // null = the document's language (resolved once voices load).
  const [language, setLanguage] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setLanguage(null);
    setRecent(recentVoiceIds());
  }, [open]);
  const languages = useMemo(() => voiceLanguages(list), [list]);
  const activeLanguage = language ?? defaultVoiceLanguage(list, doc.language);
  const shown = useMemo(
    () => filterVoices(list, activeLanguage, query),
    [list, activeLanguage, query],
  );
  const recentVoices = query.trim()
    ? []
    : recent
        .map((id) => shown.find((voice) => voice.id === id))
        .filter((voice): voice is ReaderVoice => Boolean(voice));
  const groups: [string, ReaderVoice[]][] = [
    ['reader.voices_recent', recentVoices],
    ['reader.voices_mine', shown.filter((voice) => voice.kind === 'profile')],
    ['reader.voices_builtin', shown.filter((voice) => voice.kind === 'preset')],
  ];
  const row = (voice: ReaderVoice) => (
    <li key={voice.id} className="flex items-center gap-1">
      <SheetRow
        className="flex-1"
        leading={<VoiceAvatar id={voice.id} name={voice.name} size={36} />}
        label={voice.name}
        detail={
          [
            defaultId === voice.id ? t('reader.default_voice_badge') : null,
            voice.description,
            voice.language?.toUpperCase(),
          ]
            .filter(Boolean)
            .join(' · ') || undefined
        }
        checked={player.voice === voice.id}
        onClick={() => choose(voice)}
      />
      {doc.language && voice.kind === 'profile' && (
        <button
          type="button"
          className={cn(
            'rd-icon-btn shrink-0',
            defaultId === voice.id ? 'text-amber-500' : 'text-muted-foreground',
          )}
          aria-pressed={defaultId === voice.id}
          aria-label={t(
            defaultId === voice.id ? 'reader.default_voice_clear' : 'reader.default_voice_make',
            { name: voice.name },
          )}
          onClick={() => toggleDefault(voice)}
        >
          <StarIcon
            className={cn('size-4', defaultId === voice.id && 'fill-current')}
            aria-hidden="true"
          />
        </button>
      )}
      <button
        type="button"
        className={cn(
          'rd-icon-btn shrink-0 bg-foreground/[0.06]',
          previewing === voice.id && 'bg-foreground text-background',
        )}
        aria-label={t(previewing === voice.id ? 'reader.stop_preview' : 'reader.preview', {
          name: voice.name,
        })}
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
  );
  const searchable = list.length >= VOICE_SEARCH_MIN;
  return (
    <ReaderSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t('reader.voice')}
      keyboard={searchable}
    >
      <div className="pb-1">
        {searchable && (
          <SearchField
            value={query}
            onChange={setQuery}
            label={t('reader.voice_search')}
            clearLabel={t('reader.clear_search')}
            className="mb-2"
          />
        )}
        {languages.length > 1 && (
          <div
            className="-mx-1 mb-1 flex gap-1.5 overflow-x-auto px-1 pb-1"
            role="group"
            aria-label={t('reader.voice_language')}
          >
            {[ALL_LANGUAGES, ...languages].map((code) => (
              <button
                key={code}
                type="button"
                className="rd-chip shrink-0"
                aria-pressed={activeLanguage === code}
                onClick={() => setLanguage(code)}
              >
                {code === ALL_LANGUAGES
                  ? t('reader.voice_all_languages')
                  : languageName(code, i18n.language)}
              </button>
            ))}
          </div>
        )}
        {!query.trim() && (
          <SheetRow
            leading={<VoiceAvatar id={null} name="" size={36} />}
            label={t('reader.voice_default')}
            detail={t('reader.voice_default_hint')}
            checked={player.voice === null}
            onClick={() => choose(null)}
          />
        )}
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
        {voices.isSuccess && !shown.length && (
          <p className="px-3 py-8 text-center text-sm text-muted-foreground">
            {t('reader.voice_no_results')}
          </p>
        )}
        {groups.map(([label, items]) =>
          items.length ? (
            <section key={label} className="mt-3">
              <h3 className="rd-sheet-heading px-3 pb-1">{t(label)}</h3>
              <ul className="space-y-0.5">{items.map(row)}</ul>
            </section>
          ) : null,
        )}
      </div>
    </ReaderSheet>
  );
}
