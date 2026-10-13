/**
 * Reader Labs ("Laboratorio"): experimental switches in one place and A/B
 * listening tests the listener runs from the phone. Variants render on the PC
 * through the speech-preview route (the document's voice is never changed) and
 * play on their own <audio>, never through the reading player.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  ActivityIcon,
  ArrowRightIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  EyeOffIcon,
  GaugeIcon,
  Loader2Icon,
  LocateFixedIcon,
  Music2Icon,
  PlayIcon,
  ShuffleIcon,
  SparklesIcon,
  SquareIcon,
  Trash2Icon,
  WavesIcon,
  type LucideIcon,
} from 'lucide-react';
import { claimPlayback } from '@/lib/audio/playback';
import { createObjectUrl, revokeObjectUrl } from '@/lib/audio/object-url';
import { ApiError, describeError, isAbortError } from '@/lib/api/client';
import { EngineBanner, useEngineView } from './engine-status';
import {
  AB_COMPARISONS,
  abVariants,
  blindMapping,
  clearVotes,
  labelOf,
  pickOtherVoice,
  recordVote,
  resolveChoice,
  speakableSegment,
  tallyVotes,
  trialKey,
  useAbVotes,
  type AbChoice,
  type AbComparison,
  type AbMapping,
  type AbSide,
  type AbVariant,
} from './labs-ab';
import { qualitySteps, setLabsPrefs, useLabsPrefs, type VoiceQuality } from './labs-prefs';
import { useListeningPrefs } from './listening-prefs';
import { readerApi, readerKeys, type ReaderDocument, type ReaderVoice } from './reader-api';
import { useAmbienceInfo } from './reader-ambience';
import { dlog, setDebugEnabled, setHudVisible, useDebugFlags } from './reader-debug';
import { readerPlayer, silentWav, useReaderPlayer } from './reader-player';
import { ReaderSheet } from './reader-sheet';
import { soundscapePlayer } from './reader-soundscape';
import { useAmbienceDetail } from './soundscape-sheet';
import { PAUSE_RULE_LABELS, PAUSE_RULES, speechBusy, speechPercent } from './speech';
import { applySpeech, refreshPlayer, statusDetail, useSpeech } from './speech-sheet';
import './labs.css';

type SheetProps = { open: boolean; onOpenChange: (open: boolean) => void };

const COMPARISON_LABELS = {
  prepared: 'reader.labs_cmp_prepared',
  voice: 'reader.labs_cmp_voice',
  quality: 'reader.labs_cmp_quality',
} as const satisfies Record<AbComparison, string>;

function Badge() {
  const { t } = useTranslation();
  return <span className="rd-lab-badge">{t('reader.labs_experimental')}</span>;
}

/** A switch row whose explanation wraps (sheet rows truncate theirs). */
function LabSwitch({
  icon: Icon,
  label,
  detail,
  checked,
  disabled,
  badge,
  busy,
  onToggle,
}: {
  icon?: LucideIcon;
  label: ReactNode;
  detail?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  badge?: boolean;
  busy?: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      className="rd-sheet-row rd-lab-row"
      onClick={onToggle}
    >
      {Icon && <Icon className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />}
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-medium">
          {label}
          {badge && <Badge />}
        </span>
        {detail && <span className="mt-0.5 block text-xs text-muted-foreground">{detail}</span>}
      </span>
      {busy && (
        <Loader2Icon className="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />
      )}
      <span className="rd-lab-switch" aria-hidden="true" />
    </button>
  );
}

function SectionTitle({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h3 id={id} className="rd-sheet-heading px-3 pb-1 pt-4">
      {children}
    </h3>
  );
}

// ── Experiments ──────────────────────────────────────────────────────────────

function PreparedReading({ doc }: { doc: ReaderDocument }) {
  const { t } = useTranslation();
  const speech = useSpeech(doc.id);
  const data = speech.data;
  const [pending, setPending] = useState(false);
  const on = Boolean(data?.enabled);
  const busy = speechBusy(data);
  const run = async (change: Parameters<typeof readerApi.setSpeech>[1], refresh: boolean) => {
    setPending(true);
    try {
      const next = await applySpeech(doc.id, readerApi.setSpeech(doc.id, change));
      // The review sheet (mounted with the reader) refreshes on/off itself;
      // a pause rule changes the audio only while the reading is in use.
      if (refresh && next.enabled && next.ready) refreshPlayer(doc.id);
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setPending(false);
    }
  };
  return (
    <>
      <LabSwitch
        icon={SparklesIcon}
        label={t('reader.speech')}
        detail={statusDetail(t, data)}
        checked={on}
        busy={busy}
        disabled={pending || !data}
        onToggle={() => void run({ enabled: !on }, false)}
      />
      {busy && (
        <div
          className="mx-3 h-1 overflow-hidden rounded-full bg-foreground/10"
          role="progressbar"
          aria-label={t('reader.speech_preparing', { percent: speechPercent(data) })}
          aria-valuenow={speechPercent(data)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className="h-full bg-primary" style={{ width: `${speechPercent(data)}%` }} />
        </div>
      )}
      {on && data && (
        <div className="rd-lab-nested" role="group" aria-label={t('reader.labs_pauses')}>
          <p className="px-3 pb-0.5 pt-1 text-xs font-semibold text-muted-foreground">
            {t('reader.labs_pauses')}
          </p>
          {PAUSE_RULES.map((rule) => (
            <LabSwitch
              key={rule}
              label={t(PAUSE_RULE_LABELS[rule])}
              detail={
                rule === 'dialogue'
                  ? t('reader.labs_dialogue_hint')
                  : data.ready
                    ? t('reader.speech_pause_count', { n: data.pause_counts[rule] ?? 0 })
                    : undefined
              }
              badge={rule === 'dialogue'}
              checked={Boolean(data.pause_rules[rule])}
              disabled={pending}
              onToggle={() => void run({ pause_rules: { [rule]: !data.pause_rules[rule] } }, true)}
            />
          ))}
        </div>
      )}
    </>
  );
}

function AutoAmbience() {
  const { t } = useTranslation();
  const prefs = useListeningPrefs();
  const info = useAmbienceInfo();
  const detail = useAmbienceDetail(info);
  const on = prefs.soundscape === 'auto';
  return (
    <LabSwitch
      icon={WavesIcon}
      label={t('reader.labs_ambience')}
      detail={on ? detail : t('reader.soundscape_auto_hint')}
      badge
      checked={on}
      busy={on && (info.status === 'loading' || info.status === 'computing')}
      onToggle={() => soundscapePlayer.choose(on ? 'off' : 'auto')}
    />
  );
}

function BackgroundMusic() {
  const { t } = useTranslation();
  const labs = useLabsPrefs();
  return (
    <LabSwitch
      icon={Music2Icon}
      label={t('reader.labs_music')}
      detail={t('reader.labs_music_hint')}
      badge
      checked={labs.music}
      onToggle={() => {
        setLabsPrefs({ music: !labs.music });
        dlog('labs_music', { on: !labs.music });
      }}
    />
  );
}

function VoiceQualityPicker() {
  const { t } = useTranslation();
  const labs = useLabsPrefs();
  const choose = (quality: VoiceQuality) => {
    if (quality === labs.voiceQuality) return;
    setLabsPrefs({ voiceQuality: quality });
    dlog('labs_quality', { quality, num_step: qualitySteps(quality) ?? 16 });
    // Upcoming sentences must be rendered again with the new step count.
    if (readerPlayer.getState().doc) readerPlayer.refreshAudio();
  };
  return (
    <section aria-labelledby="rd-lab-quality" className="px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <GaugeIcon className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <h4 id="rd-lab-quality" className="font-medium">
          {t('reader.labs_quality')}
        </h4>
        <Badge />
      </div>
      <div
        className="mt-2 grid grid-cols-2 gap-2"
        role="radiogroup"
        aria-labelledby="rd-lab-quality"
      >
        {(['normal', 'high'] as const).map((quality) => (
          <button
            key={quality}
            type="button"
            role="radio"
            aria-checked={labs.voiceQuality === quality}
            data-active={labs.voiceQuality === quality}
            className="rd-chip w-full"
            onClick={() => choose(quality)}
          >
            {t(quality === 'high' ? 'reader.labs_quality_high' : 'reader.labs_quality_normal')}
          </button>
        ))}
      </div>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        {t('reader.labs_quality_hint')}
      </p>
    </section>
  );
}

function Diagnostics() {
  const { t } = useTranslation();
  const { enabled, hud } = useDebugFlags();
  return (
    <>
      <LabSwitch
        icon={GaugeIcon}
        label={t('reader.debug_hud')}
        detail={t('reader.labs_hud_hint')}
        checked={hud}
        onToggle={() => setHudVisible(!hud)}
      />
      <LabSwitch
        icon={ActivityIcon}
        label={t('reader.debug_log')}
        detail={t('reader.debug_log_hint')}
        checked={enabled}
        onToggle={() => setDebugEnabled(!enabled)}
      />
    </>
  );
}

// ── A/B ──────────────────────────────────────────────────────────────────────

let abAudio: HTMLAudioElement | null = null;
const GAP_MS = 450;

type Urls = Record<AbSide, string>;
interface Trial {
  key: string;
  controller: AbortController;
  promise: Promise<Urls>;
  urls?: Urls;
}

/** Renders a trial's two variants once (cancellable) and plays them on a preview element. */
function useAbAudio(docId: string) {
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState<AbSide | null>(null);
  const [error, setError] = useState<unknown>(null);
  const trial = useRef<Trial | null>(null);
  const token = useRef(0);
  const release = useRef<(() => void) | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stop = () => {
    token.current++;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (abAudio) {
      abAudio.onended = null;
      abAudio.pause();
    }
    release.current?.();
    release.current = null;
    setPlaying(null);
    setLoading(false);
  };

  /** Forget the rendered trial (cancel its renders, free its audio); playback is untouched. */
  const discard = () => {
    const current = trial.current;
    trial.current = null;
    if (!current) return;
    current.controller.abort();
    if (current.urls) {
      revokeObjectUrl(current.urls.a);
      revokeObjectUrl(current.urls.b);
    }
  };
  const drop = () => {
    stop();
    discard();
  };
  useEffect(() => () => drop(), []);

  const ensure = (segment: number, variants: readonly [AbVariant, AbVariant]): Promise<Urls> => {
    const key = trialKey(segment, variants);
    if (trial.current?.key === key) return trial.current.promise;
    // Not stop(): the play() that asked for this trial owns the current token.
    discard();
    const controller = new AbortController();
    const { signal } = controller;
    const promise = (async () => {
      const renders = await Promise.all(
        variants.map((variant) =>
          readerApi.previewSpeech(
            docId,
            segment,
            {
              voice: variant.voice,
              engine: variant.engine,
              language: variant.language,
              num_step: variant.num_step,
            },
            variant.prepared,
            undefined,
            signal,
          ),
        ),
      );
      const blobs = await Promise.all(
        renders.map((render) => readerApi.audio(render.audio_url, signal)),
      );
      const [a, b] = blobs.map((blob) => createObjectUrl(blob));
      if (!a || !b) throw new Error('audio');
      return { a, b };
    })();
    const entry: Trial = { key, controller, promise };
    trial.current = entry;
    promise.then(
      (urls) => {
        if (trial.current === entry) entry.urls = urls;
        else {
          revokeObjectUrl(urls.a);
          revokeObjectUrl(urls.b);
        }
      },
      () => {
        if (trial.current === entry) trial.current = null;
      },
    );
    return promise;
  };

  /** Play `sequence` (A, B or A → B); renders first when needed. */
  const play = async (
    segment: number,
    variants: readonly [AbVariant, AbVariant],
    sequence: readonly AbSide[],
  ) => {
    stop();
    const current = ++token.current;
    // Unlock inside the tap so the samples may play once they have rendered.
    abAudio ??= new Audio();
    abAudio.src = silentWav();
    void abAudio.play().catch(() => {});
    setError(null);
    setLoading(true);
    let urls: Urls;
    try {
      urls = await ensure(segment, variants);
    } catch (failure) {
      if (current !== token.current) return;
      setLoading(false);
      if (!isAbortError(failure)) {
        setError(failure);
        dlog('labs_error', {
          what: 'ab_render',
          seg: segment,
          status: failure instanceof ApiError ? failure.status : -1,
        });
      }
      return;
    }
    if (current !== token.current || !abAudio) return;
    setLoading(false);
    const audio = abAudio;
    release.current = claimPlayback(() => stop(), 'reader-labs-ab');
    const step = (index: number) => {
      const side = sequence[index];
      if (!side || current !== token.current) return;
      audio.src = urls[side];
      setPlaying(side);
      audio.onended = () => {
        if (current !== token.current) return;
        if (index + 1 < sequence.length) {
          timer.current = setTimeout(() => step(index + 1), GAP_MS);
          return;
        }
        release.current?.();
        release.current = null;
        setPlaying(null);
      };
      audio.play().catch(() => {
        if (current === token.current) setPlaying(null);
      });
    };
    step(0);
  };

  return { loading, playing, error, play, stop, drop };
}

function CompareSection({ doc, open }: { doc: ReaderDocument; open: boolean }) {
  const { t } = useTranslation();
  const player = useReaderPlayer();
  const labs = useLabsPrefs();
  const speech = useSpeech(doc.id);
  const votes = useAbVotes();
  const engineView = useEngineView(doc.id);
  const status = useQuery({
    queryKey: readerKeys.status,
    queryFn: ({ signal }) => readerApi.status(signal),
    retry: false,
    staleTime: 10_000,
  });
  const voices = useQuery({
    queryKey: readerKeys.voices,
    queryFn: ({ signal }) => readerApi.voices(signal),
    staleTime: 60_000,
  });
  const voiceList = useMemo(() => voices.data ?? [], [voices.data]);

  const loaded = player.doc?.id === doc.id;
  const currentVoice = loaded ? player.voice : doc.voice_id;
  const currentEngine = loaded ? player.engine : doc.engine;
  const here = () =>
    speakableSegment(doc.segments, loaded ? player.segment : doc.position_segment) ??
    speakableSegment(doc.segments, doc.segments.length - 1, -1);

  const [comparison, setComparison] = useState<AbComparison>('prepared');
  const [scope, setScope] = useState<number | null>(here);
  // undefined = follow the reading voice (A) / the suggested other voice (B).
  const [voiceA, setVoiceA] = useState<string | null | undefined>(undefined);
  const [voiceB, setVoiceB] = useState<string | null | undefined>(undefined);
  const [mapping, setMapping] = useState<AbMapping>(() => blindMapping());
  const [revealed, setRevealed] = useState<{ winner: AbChoice } | null>(null);
  const [readerPaused, setReaderPaused] = useState(false);
  const audio = useAbAudio(doc.id);

  const find = (id: string | null) => voiceList.find((voice) => voice.id === id) ?? null;
  const idA = voiceA === undefined ? currentVoice : voiceA;
  const idB =
    voiceB === undefined ? (pickOtherVoice(voiceList, idA, doc.language)?.id ?? null) : voiceB;
  const prepared = Boolean(speech.data?.enabled && speech.data?.ready);
  const variants = abVariants(comparison, {
    prepared,
    voice: currentVoice,
    engine: currentEngine,
    language: doc.language,
    numStep: qualitySteps(labs.voiceQuality),
    voiceA: { id: idA, engine: find(idA)?.engine ?? null },
    voiceB: { id: idB, engine: find(idB)?.engine ?? null },
  });
  const key = scope === null ? '' : trialKey(scope, variants);

  // Closing the sheet cancels renders in flight and stops the samples.
  useEffect(() => {
    if (!open) audio.drop();
  }, [open]);

  // A new trial: new blind order, nothing revealed, nothing playing.
  useEffect(() => {
    setMapping(blindMapping());
    setRevealed(null);
    audio.stop();
  }, [key]);

  const blind = labs.blind;
  const order: AbSide[] = blind ? [mapping.x, mapping.y] : ['a', 'b'];
  const label = (side: AbSide) =>
    blind ? labelOf(side, mapping).toUpperCase() : side.toUpperCase();

  const variantName = (side: AbSide) => {
    const variant = variants[side === 'a' ? 0 : 1];
    if (comparison === 'prepared')
      return t(variant.prepared ? 'reader.labs_variant_prepared' : 'reader.labs_variant_plain');
    if (comparison === 'quality')
      return t(variant.num_step ? 'reader.labs_quality_high' : 'reader.labs_quality_normal');
    return find(variant.voice ?? null)?.name ?? t('reader.voice_default');
  };
  const tagName = (kind: AbComparison, tag: string) => {
    if (kind === 'prepared')
      return t(tag === 'prepared' ? 'reader.labs_variant_prepared' : 'reader.labs_variant_plain');
    if (kind === 'quality')
      return t(tag === 'normal' ? 'reader.labs_quality_normal' : 'reader.labs_quality_high');
    return tag === 'default' ? t('reader.voice_default') : (find(tag)?.name ?? tag);
  };

  const start = (sequence: AbSide[]) => {
    if (scope === null) return;
    if (readerPlayer.playing) {
      readerPlayer.pause();
      setReaderPaused(true);
    }
    void audio.play(scope, variants, sequence);
  };

  const vote = (choice: AbChoice) => {
    if (scope === null) return;
    const effective: AbMapping = blind ? mapping : { x: 'a', y: 'b' };
    const winner = resolveChoice(choice, effective);
    recordVote({
      at: Date.now(),
      comparison,
      segment: scope,
      winner,
      blind,
      a: variants[0].tag,
      b: variants[1].tag,
    });
    dlog('ab_vote', {
      comparison,
      seg: scope,
      choice,
      winner,
      blind,
      mapping: blind ? effective : null,
      a: variants[0].tag,
      b: variants[1].tag,
    });
    setRevealed({ winner: choice });
  };

  const move = (step: 1 | -1) => {
    if (scope === null) return;
    const next = speakableSegment(doc.segments, scope + step, step);
    if (next !== null) setScope(next);
  };

  const tally = tallyVotes(votes);
  const sameVoices = comparison === 'voice' && idA === idB;
  const engine = currentEngine ?? status.data?.engine ?? null;
  const hint =
    comparison === 'prepared' && !prepared
      ? t('reader.labs_prepared_not_ready')
      : comparison === 'quality' && engine && engine !== 'omnivoice'
        ? t('reader.labs_quality_engine')
        : sameVoices
          ? t('reader.labs_same_voice')
          : null;
  const errorText =
    audio.error instanceof ApiError && audio.error.status === 0
      ? t('reader.engine_unreachable')
      : audio.error
        ? `${t('reader.preview_failed')} · ${describeError(audio.error)}`
        : null;
  const busy = audio.loading;
  const segmentText = scope === null ? '' : (doc.segments[scope]?.text ?? '');

  const voicePicker = (
    id: string,
    value: string | null,
    onChange: (next: string | null) => void,
  ) => (
    <label className="block min-w-0 flex-1">
      <span className="block px-1 pb-1 text-xs font-semibold text-muted-foreground">
        {t(id === 'a' ? 'reader.labs_voice_a' : 'reader.labs_voice_b')}
      </span>
      <select
        className="rd-input rd-lab-select"
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value || null)}
      >
        <option value="">{t('reader.voice_default')}</option>
        {voiceList.map((voice: ReaderVoice) => (
          <option key={voice.id} value={voice.id}>
            {voice.language ? `${voice.name} · ${voice.language.toUpperCase()}` : voice.name}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <section aria-labelledby="rd-lab-compare">
      <SectionTitle id="rd-lab-compare">{t('reader.labs_compare')}</SectionTitle>
      <p className="px-3 pb-2 text-xs leading-relaxed text-muted-foreground">
        {t('reader.labs_compare_hint')}
      </p>
      <div className="space-y-3 px-1">
        <div
          className="flex flex-wrap gap-1.5"
          role="radiogroup"
          aria-label={t('reader.labs_compare_what')}
        >
          {AB_COMPARISONS.map((kind) => (
            <button
              key={kind}
              type="button"
              role="radio"
              aria-checked={comparison === kind}
              data-active={comparison === kind}
              className="rd-chip"
              onClick={() => setComparison(kind)}
            >
              {t(COMPARISON_LABELS[kind])}
            </button>
          ))}
        </div>

        {comparison === 'voice' && (
          <div className="flex flex-col gap-2 min-[400px]:flex-row">
            {voicePicker('a', idA, setVoiceA)}
            {voicePicker('b', idB, setVoiceB)}
          </div>
        )}

        <div className="rd-lab-scope">
          <div className="flex items-center gap-1">
            <span className="min-w-0 flex-1 pl-1 text-xs font-semibold text-muted-foreground">
              {scope === null
                ? t('reader.labs_no_segment')
                : t('reader.labs_scope', { n: scope + 1, total: doc.segments.length })}
            </span>
            <button
              type="button"
              className="rd-icon-btn text-muted-foreground"
              aria-label={t('reader.labs_scope_previous')}
              title={t('reader.labs_scope_previous')}
              disabled={scope === null || speakableSegment(doc.segments, scope - 1, -1) === null}
              onClick={() => move(-1)}
            >
              <ChevronLeftIcon className="size-5" aria-hidden="true" />
            </button>
            <button
              type="button"
              className="rd-icon-btn text-muted-foreground"
              aria-label={t('reader.labs_scope_current')}
              title={t('reader.labs_scope_current')}
              onClick={() => setScope(here())}
            >
              <LocateFixedIcon className="size-5" aria-hidden="true" />
            </button>
            <button
              type="button"
              className="rd-chip"
              disabled={scope === null || speakableSegment(doc.segments, scope + 1) === null}
              onClick={() => move(1)}
            >
              {t('reader.labs_scope_next')}
              <ChevronRightIcon className="size-4" aria-hidden="true" />
            </button>
          </div>
          {segmentText && (
            <p className="rd-lab-snippet" lang={doc.language ?? undefined}>
              {segmentText}
            </p>
          )}
        </div>

        <div className="-mx-1">
          <LabSwitch
            icon={EyeOffIcon}
            label={t('reader.labs_blind')}
            detail={t('reader.labs_blind_hint')}
            checked={blind}
            onToggle={() => {
              setLabsPrefs({ blind: !blind });
              setMapping(blindMapping());
              setRevealed(null);
            }}
          />
        </div>

        {engineView.kind !== 'ok' && <EngineBanner view={engineView} />}
        {hint && (
          <p className="px-1 text-xs leading-relaxed text-muted-foreground" role="note">
            {hint}
          </p>
        )}

        <div className="grid grid-cols-3 gap-2" role="group" aria-label={t('reader.labs_compare')}>
          {order.map((side) => (
            <button
              key={side}
              type="button"
              className="rd-lab-play"
              data-playing={audio.playing === side}
              disabled={scope === null || sameVoices}
              aria-label={t('reader.labs_play', { label: label(side) })}
              onClick={() => (audio.playing === side ? audio.stop() : start([side]))}
            >
              {audio.playing === side ? (
                <SquareIcon className="size-4 fill-current" aria-hidden="true" />
              ) : (
                <PlayIcon className="size-4 fill-current" aria-hidden="true" />
              )}
              <span className="text-base font-bold">{label(side)}</span>
            </button>
          ))}
          <button
            type="button"
            className="rd-lab-play"
            data-playing={audio.playing !== null}
            disabled={scope === null || sameVoices}
            aria-label={t('reader.labs_play_both', {
              first: label(order[0]),
              second: label(order[1]),
            })}
            onClick={() => (audio.playing ? audio.stop() : start(order))}
          >
            {audio.playing ? (
              <SquareIcon className="size-4 fill-current" aria-hidden="true" />
            ) : (
              <span className="flex items-center gap-1 text-base font-bold" aria-hidden="true">
                {label(order[0])}
                <ArrowRightIcon className="size-4" />
                {label(order[1])}
              </span>
            )}
          </button>
        </div>

        <p className="min-h-5 px-1 text-xs text-muted-foreground" aria-live="polite">
          {busy ? (
            <span className="inline-flex items-center gap-1.5">
              <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />
              {t('reader.labs_rendering')}
            </span>
          ) : audio.playing ? (
            t('reader.labs_playing', { label: label(audio.playing) })
          ) : null}
        </p>
        {errorText && (
          <p className="px-1 text-sm text-destructive" role="alert">
            {errorText}
          </p>
        )}

        {revealed ? (
          <div className="rd-lab-reveal" role="status">
            <p className="text-sm font-medium">
              {blind
                ? t('reader.labs_reveal', { x: variantName(mapping.x), y: variantName(mapping.y) })
                : t('reader.labs_reveal_open', { a: variantName('a'), b: variantName('b') })}
            </p>
            <button
              type="button"
              className="rd-chip mt-2"
              onClick={() => {
                setMapping(blindMapping());
                setRevealed(null);
                audio.stop();
              }}
            >
              <ShuffleIcon className="size-4" aria-hidden="true" />
              {t('reader.labs_again')}
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-2" role="group" aria-label={t('reader.labs_vote')}>
            {(blind ? (['x', 'y'] as const) : (['a', 'b'] as const)).map((choice) => (
              <button
                key={choice}
                type="button"
                className="rd-chip w-full"
                disabled={scope === null || sameVoices}
                onClick={() => vote(choice)}
              >
                {t('reader.labs_prefer', { label: choice.toUpperCase() })}
              </button>
            ))}
            <button
              type="button"
              className="rd-chip w-full"
              disabled={scope === null || sameVoices}
              onClick={() => vote('same')}
            >
              {t('reader.labs_same')}
            </button>
          </div>
        )}

        {readerPaused && (
          <button
            type="button"
            className="rd-sheet-row -mx-1 w-[calc(100%+0.5rem)]"
            onClick={() => {
              audio.stop();
              setReaderPaused(false);
              readerPlayer.play();
            }}
          >
            <PlayIcon className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="block font-medium">{t('reader.labs_resume')}</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                {t('reader.labs_resume_hint')}
              </span>
            </span>
          </button>
        )}
      </div>

      <SectionTitle id="rd-lab-history">{t('reader.labs_history')}</SectionTitle>
      <div className="space-y-1 px-1">
        <dl className="rd-lab-tally">
          {AB_COMPARISONS.map((kind) => (
            <div key={kind} className="flex items-baseline justify-between gap-3 px-2 py-1">
              <dt className="min-w-0 truncate text-sm">{t(COMPARISON_LABELS[kind])}</dt>
              <dd className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {t('reader.labs_tally', { ...tally[kind] })}
              </dd>
            </div>
          ))}
        </dl>
        {votes.length === 0 ? (
          <p className="px-2 py-2 text-sm text-muted-foreground">
            {t('reader.labs_history_empty')}
          </p>
        ) : (
          <>
            <ol className="rd-lab-history">
              {votes.map((entry) => (
                <li key={`${entry.at}-${entry.segment}`} className="flex gap-3 px-2 py-1.5">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">
                      {entry.winner === 'same'
                        ? t('reader.labs_same')
                        : t('reader.labs_won', {
                            name: tagName(
                              entry.comparison,
                              entry.winner === 'a' ? entry.a : entry.b,
                            ),
                          })}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {[
                        t(COMPARISON_LABELS[entry.comparison]),
                        t('reader.labs_scope_short', { n: entry.segment + 1 }),
                        entry.blind ? t('reader.labs_blind_short') : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
            <button type="button" className="rd-sheet-row" onClick={clearVotes}>
              <Trash2Icon className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="min-w-0 flex-1 font-medium">{t('reader.labs_history_clear')}</span>
            </button>
          </>
        )}
      </div>
    </section>
  );
}

export function LabSheet({ doc, open, onOpenChange }: SheetProps & { doc: ReaderDocument }) {
  const { t } = useTranslation();
  return (
    <ReaderSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t('reader.labs')}
      description={t('reader.labs_description')}
      className="rd-sheet-tall"
    >
      {/* Content mounts while open: closing unmounts it, which cancels renders and audio. */}
      <div className="-mx-1 pb-2">
        <section aria-labelledby="rd-lab-experiments">
          <SectionTitle id="rd-lab-experiments">{t('reader.labs_experiments')}</SectionTitle>
          <div className="space-y-0.5">
            <PreparedReading doc={doc} />
            <AutoAmbience />
            <BackgroundMusic />
            <VoiceQualityPicker />
            <Diagnostics />
          </div>
        </section>
        <div className="rd-sheet-divider" role="separator" />
        <CompareSection doc={doc} open={open} />
      </div>
    </ReaderSheet>
  );
}
