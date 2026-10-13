/**
 * Prepared reading ("Lectura preparada"): the switch in the reader's actions
 * sheet and the review sheet (changes by chapter, name suggestions, pause
 * rules, original-vs-prepared comparison). Only what the voice says changes;
 * the text on screen never does.
 */
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  BookPlusIcon,
  CheckIcon,
  ClipboardCheckIcon,
  Loader2Icon,
  PencilIcon,
  PlayIcon,
  RefreshCwIcon,
  SparklesIcon,
  SquareIcon,
  Undo2Icon,
  XIcon,
} from 'lucide-react';
import { claimPlayback } from '@/lib/audio/playback';
import { createObjectUrl, revokeObjectUrl } from '@/lib/audio/object-url';
import { describeError } from '@/lib/api/client';
import { queryClient } from '@/lib/query';
import { cn } from '@/lib/utils';
import {
  readerApi,
  readerKeys,
  type ReaderDocument,
  type ReaderPauseRule,
  type ReaderSpeech,
  type ReaderSpeechItem,
} from './reader-api';
import { readerPlayer, silentWav } from './reader-player';
import { ReaderSheet, SheetRow } from './reader-sheet';
import {
  appliedCount,
  groupSpeechChanges,
  nameSuggestions,
  PAUSE_RULE_LABELS,
  PAUSE_RULES,
  SPEECH_KIND_LABELS,
  speechAudioChanged,
  speechBusy,
  speechPercent,
} from './speech';

type SheetProps = { open: boolean; onOpenChange: (open: boolean) => void };

export function useSpeech(docId: string) {
  return useQuery({
    queryKey: readerKeys.speech(docId),
    queryFn: ({ signal }) => readerApi.speech(docId, signal),
    staleTime: 30_000,
    retry: false,
    refetchInterval: (query) => (speechBusy(query.state.data) ? 1500 : false),
  });
}

/** Drop the player's rendered audio when it reads this document. */
export function refreshPlayer(docId: string) {
  if (readerPlayer.getState().doc?.id === docId) readerPlayer.refreshAudio();
}

/** Store a new state; `refresh` when an edit changed what the voice says. */
export async function applySpeech(docId: string, request: Promise<ReaderSpeech>, refresh = false) {
  const next = await request;
  queryClient.setQueryData(readerKeys.speech(docId), next);
  if (refresh && next.enabled && next.ready) refreshPlayer(docId);
  return next;
}

export function statusDetail(
  t: (key: string, options?: Record<string, unknown>) => string,
  speech: ReaderSpeech | undefined,
) {
  if (!speech || !speech.enabled) return t('reader.speech_hint');
  if (speechBusy(speech)) return t('reader.speech_preparing', { percent: speechPercent(speech) });
  if (speech.status === 'error') return t('reader.speech_failed');
  if (speech.stale) return t('reader.speech_stale');
  return t('reader.speech_on');
}

/** Rows for the actions sheet: the switch, and "Review changes" once prepared. */
export function PreparedReadingRows({
  doc,
  onReview,
}: {
  doc: ReaderDocument;
  onReview: () => void;
}) {
  const { t } = useTranslation();
  const speech = useSpeech(doc.id);
  const [busy, setBusy] = useState(false);
  const on = Boolean(speech.data?.enabled);
  const toggle = async () => {
    setBusy(true);
    try {
      await applySpeech(doc.id, readerApi.setSpeech(doc.id, { enabled: !on }));
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <SheetRow
        icon={SparklesIcon}
        label={t('reader.speech')}
        detail={statusDetail(t, speech.data)}
        role="switch"
        aria-checked={on}
        checked={on}
        disabled={busy || speech.isError}
        trailing={
          speechBusy(speech.data) ? (
            <Loader2Icon className="size-4 animate-spin text-muted-foreground" aria-hidden="true" />
          ) : undefined
        }
        onClick={() => void toggle()}
      />
      {speech.data?.ready && (
        <SheetRow
          icon={ClipboardCheckIcon}
          label={t('reader.speech_review')}
          trailing={
            <span className="text-sm tabular-nums text-muted-foreground">
              {appliedCount(speech.data)}
            </span>
          }
          chevron
          onClick={onReview}
        />
      )}
    </>
  );
}

let compareAudio: HTMLAudioElement | null = null;

/** Plays a sentence as written, then prepared ("A then B"). */
function useCompare(doc: ReaderDocument) {
  const { t } = useTranslation();
  const [state, setState] = useState<{ n: number; phase: 'loading' | 'a' | 'b' } | null>(null);
  const token = useRef(0);
  const urls = useRef<string[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stop = () => {
    token.current++;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    compareAudio?.pause();
    urls.current.forEach((url) => revokeObjectUrl(url));
    urls.current = [];
    setState(null);
  };
  useEffect(() => () => stop(), []);

  const compare = async (item: ReaderSpeechItem) => {
    if (state?.n === item.n) {
      stop();
      return;
    }
    stop();
    const current = ++token.current;
    readerPlayer.pause();
    // Unlock inside the tap so the samples may play once they have rendered.
    compareAudio ??= new Audio();
    compareAudio.src = silentWav();
    void compareAudio.play().catch(() => {});
    setState({ n: item.n, phase: 'loading' });
    const player = readerPlayer.getState();
    const loaded = player.doc?.id === doc.id;
    const choice = {
      voice: loaded ? player.voice : doc.voice_id,
      engine: loaded ? player.engine : doc.engine,
      language: doc.language,
    };
    try {
      const [plain, prepared] = await Promise.all([
        readerApi.previewSpeech(doc.id, item.segment, choice, false),
        readerApi.previewSpeech(doc.id, item.segment, choice, true, item.n),
      ]);
      const blobs = await Promise.all([
        readerApi.audio(plain.audio_url),
        readerApi.audio(prepared.audio_url),
      ]);
      if (current !== token.current || !compareAudio) return;
      const [a, b] = blobs.map((blob) => createObjectUrl(blob));
      if (!a || !b) return;
      urls.current = [a, b];
      const audio = compareAudio;
      const release = claimPlayback(() => stop(), 'reader-speech-compare');
      audio.src = a;
      setState({ n: item.n, phase: 'a' });
      audio.onended = () => {
        if (current !== token.current) return release();
        timer.current = setTimeout(() => {
          if (current !== token.current) return release();
          audio.src = b;
          setState({ n: item.n, phase: 'b' });
          audio.onended = () => {
            release();
            if (current === token.current) setState(null);
          };
          void audio.play().catch(() => {});
        }, 450);
      };
      await audio.play();
    } catch (error) {
      if (current !== token.current) return;
      setState(null);
      toast.error(t('reader.preview_failed'), { description: describeError(error) });
    }
  };
  return { state, compare, stop };
}

function IconButton({
  label,
  onClick,
  disabled,
  active,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={cn(
        'rd-icon-btn shrink-0 text-muted-foreground',
        active && 'bg-foreground text-background',
      )}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** The review sheet; mounted with the reader so it also follows the preparation. */
export function SpeechSheet({ doc, open, onOpenChange }: SheetProps & { doc: ReaderDocument }) {
  const { t } = useTranslation();
  const speech = useSpeech(doc.id);
  const data = speech.data;
  const previous = useRef<ReaderSpeech | undefined>(undefined);
  const { state: comparing, compare, stop } = useCompare(doc);
  const [editing, setEditing] = useState<{ n: number; value: string } | null>(null);
  const [pending, setPending] = useState<number | 'switch' | 'prepare' | null>(null);

  // Switched on/off, or results arrived while on: the upcoming sentences
  // must be rendered again (refreshAudio resumes from the current sentence).
  useEffect(() => {
    if (speechAudioChanged(previous.current, data)) refreshPlayer(doc.id);
    previous.current = data;
  }, [data, doc.id]);
  useEffect(() => {
    if (!open) {
      stop();
      setEditing(null);
    }
  }, [open]);

  const run = async (key: number | 'switch' | 'prepare', request: () => Promise<ReaderSpeech>) => {
    setPending(key);
    try {
      await applySpeech(doc.id, request(), typeof key === 'number');
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setPending(null);
    }
  };

  const setRule = (rule: ReaderPauseRule, on: boolean) =>
    void run('switch', async () => {
      const next = await readerApi.setSpeech(doc.id, { pause_rules: { [rule]: on } });
      if (next.enabled && next.ready) refreshPlayer(doc.id);
      return next;
    });

  const toDictionary = async (item: ReaderSpeechItem) => {
    setPending(item.n);
    try {
      const { entry } = await readerApi.speechToDictionary(doc.id, item.n);
      void queryClient.invalidateQueries({ queryKey: ['reader', 'pronunciations'] });
      toast.success(t('reader.speech_added_to_dictionary', { term: entry.term }));
      if (data?.enabled) refreshPlayer(doc.id);
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setPending(null);
    }
  };

  const saveEdit = (event: FormEvent) => {
    event.preventDefault();
    if (!editing) return;
    const value = editing.value.trim();
    const n = editing.n;
    setEditing(null);
    if (value) void run(n, () => readerApi.editSpeechItem(doc.id, n, { spoken: value, all: true }));
  };

  const groups = data ? groupSpeechChanges(data.items, doc.chapters) : [];
  const names = data ? nameSuggestions(data.items) : [];
  const busy = speechBusy(data);

  const said = (item: { spoken: string }) =>
    item.spoken ? (
      item.spoken
    ) : (
      <em className="text-muted-foreground">{t('reader.speech_silent')}</em>
    );

  const itemRow = (
    item: ReaderSpeechItem,
    key: string,
    count: number,
    kindLabel: string,
    actions: ReactNode,
  ) => (
    <li key={key} className="flex items-center gap-1 rounded-xl px-2 py-1.5">
      {editing?.n === item.n ? (
        <form className="flex min-w-0 flex-1 items-center gap-1" onSubmit={saveEdit}>
          <span className="shrink-0 font-medium">{item.original}</span>
          <span className="px-1 text-muted-foreground" aria-hidden="true">
            →
          </span>
          <input
            className="rd-input h-10 min-w-0 flex-1"
            value={editing.value}
            maxLength={200}
            autoFocus
            aria-label={t('reader.speech_edit_label', { term: item.original })}
            onChange={(event) => setEditing({ n: item.n, value: event.target.value })}
          />
          <button
            type="submit"
            className="rd-icon-btn shrink-0 text-muted-foreground"
            aria-label={t('reader.save')}
            title={t('reader.save')}
          >
            <CheckIcon className="size-4" aria-hidden="true" />
          </button>
          <IconButton label={t('reader.cancel')} onClick={() => setEditing(null)}>
            <XIcon className="size-4" aria-hidden="true" />
          </IconButton>
        </form>
      ) : (
        <>
          <span className="min-w-0 flex-1">
            <span
              className={cn(
                'block break-words font-medium',
                item.state !== 'applied' && 'text-muted-foreground',
              )}
            >
              <span className={cn(item.state === 'reverted' && 'line-through')}>
                {item.original}
              </span>
              <span className="px-1.5 text-muted-foreground" aria-hidden="true">
                →
              </span>
              <span className="sr-only">{t('reader.pronounce_as')}</span>
              {said(item)}
              {count > 1 && (
                <span className="ml-1.5 text-xs tabular-nums text-muted-foreground">×{count}</span>
              )}
            </span>
            <span className="mt-0.5 block truncate text-xs text-muted-foreground">
              {kindLabel}
              {item.state === 'reverted' && ` · ${t('reader.speech_state_reverted')}`}
              {item.state === 'suggested' && ` · ${t('reader.speech_state_suggested')}`}
              {item.edited && ` · ${t('reader.speech_state_edited')}`}
            </span>
          </span>
          <IconButton
            label={t(comparing?.n === item.n ? 'reader.speech_stop' : 'reader.speech_compare')}
            active={comparing?.n === item.n && comparing.phase !== 'loading'}
            onClick={() => void compare(item)}
          >
            {comparing?.n === item.n && comparing.phase === 'loading' ? (
              <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
            ) : comparing?.n === item.n ? (
              <span className="text-xs font-bold">{comparing.phase === 'a' ? 'A' : 'B'}</span>
            ) : (
              <PlayIcon className="size-4" aria-hidden="true" />
            )}
          </IconButton>
          {actions}
          {pending === item.n && (
            <Loader2Icon className="size-4 animate-spin text-muted-foreground" aria-hidden="true" />
          )}
        </>
      )}
    </li>
  );

  const editButton = (item: ReaderSpeechItem) => (
    <IconButton
      label={t('reader.speech_edit')}
      disabled={pending !== null}
      onClick={() => setEditing({ n: item.n, value: item.spoken })}
    >
      <PencilIcon className="size-4" aria-hidden="true" />
    </IconButton>
  );
  const dictionaryButton = (item: ReaderSpeechItem) => (
    <IconButton
      label={t('reader.speech_to_dictionary')}
      disabled={pending !== null || !item.spoken}
      onClick={() => void toDictionary(item)}
    >
      <BookPlusIcon className="size-4" aria-hidden="true" />
    </IconButton>
  );

  return (
    <ReaderSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t('reader.speech')}
      description={t('reader.speech_description')}
      keyboard
    >
      <div className="-mx-1 space-y-1 pb-1">
        <SheetRow
          icon={SparklesIcon}
          label={t('reader.speech_use')}
          detail={statusDetail(t, data)}
          role="switch"
          aria-checked={Boolean(data?.enabled)}
          checked={Boolean(data?.enabled)}
          disabled={!data || pending === 'switch'}
          onClick={() =>
            void run('switch', () => readerApi.setSpeech(doc.id, { enabled: !data?.enabled }))
          }
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
            <div
              className="h-full bg-primary transition-[width]"
              style={{ width: `${speechPercent(data)}%` }}
            />
          </div>
        )}
        {data?.error && (
          <p className="px-3 text-sm text-destructive" role="alert">
            {data.error}
          </p>
        )}
        {data?.ready && data.llm && (
          <p className="px-3 text-xs text-muted-foreground">
            {data.llm.status === 'used' && data.llm.model
              ? t('reader.speech_llm_used', { model: data.llm.model })
              : data.llm.status === 'unavailable'
                ? t('reader.speech_llm_unavailable')
                : data.llm.status === 'pending'
                  ? t('reader.speech_llm_pending')
                  : t('reader.speech_rules_only')}
          </p>
        )}
        <SheetRow
          icon={RefreshCwIcon}
          label={t('reader.speech_prepare_again')}
          disabled={busy || pending === 'prepare'}
          onClick={() => void run('prepare', () => readerApi.prepareSpeech(doc.id))}
        />

        {names.length > 0 && (
          <section aria-labelledby="rd-speech-names" className="pt-3">
            <h3 id="rd-speech-names" className="rd-sheet-heading px-3">
              {t('reader.speech_names')}
            </h3>
            <p className="px-3 pb-1 text-xs text-muted-foreground">
              {t('reader.speech_names_hint')}
            </p>
            <ul className="space-y-0.5">
              {names.map((item) =>
                itemRow(
                  item,
                  `name-${item.n}`,
                  item.count,
                  t(SPEECH_KIND_LABELS[item.kind]),
                  <>
                    <IconButton
                      label={t(
                        item.state === 'applied' ? 'reader.speech_revert' : 'reader.speech_accept',
                      )}
                      disabled={pending !== null}
                      onClick={() =>
                        void run(item.n, () =>
                          item.state === 'applied'
                            ? readerApi.editSpeechItem(doc.id, item.n, { state: 'suggested' })
                            : readerApi.editSpeechItem(doc.id, item.n, { state: 'applied' }),
                        )
                      }
                    >
                      {item.state === 'applied' ? (
                        <Undo2Icon className="size-4" aria-hidden="true" />
                      ) : (
                        <CheckIcon className="size-4" aria-hidden="true" />
                      )}
                    </IconButton>
                    {editButton(item)}
                    {dictionaryButton(item)}
                  </>,
                ),
              )}
            </ul>
          </section>
        )}

        <section aria-labelledby="rd-speech-changes" className="pt-3">
          <h3 id="rd-speech-changes" className="rd-sheet-heading px-3">
            {t('reader.speech_changes')}
          </h3>
          {speech.isPending && (
            <div className="space-y-2 py-2" aria-hidden="true">
              {[0, 1].map((index) => (
                <div key={index} className="rd-skeleton h-12" />
              ))}
            </div>
          )}
          {speech.isError && (
            <p className="px-3 py-2 text-sm text-destructive" role="alert">
              {describeError(speech.error)}
            </p>
          )}
          {data && !groups.length && (
            <p className="px-3 py-3 text-sm leading-relaxed text-muted-foreground">
              {data.ready ? t('reader.speech_no_changes') : t('reader.speech_not_prepared')}
            </p>
          )}
          {groups.map((group) => (
            <div key={group.key} className="pt-1">
              {group.title && (
                <p className="truncate px-3 pt-2 text-xs font-semibold text-muted-foreground">
                  {group.title}
                </p>
              )}
              <ul className="space-y-0.5">
                {group.changes.map((change) =>
                  itemRow(
                    change.first,
                    change.key,
                    change.count,
                    t(SPEECH_KIND_LABELS[change.kind]),
                    <>
                      <IconButton
                        label={t(
                          change.state === 'reverted'
                            ? 'reader.speech_restore'
                            : 'reader.speech_revert',
                        )}
                        disabled={pending !== null}
                        onClick={() =>
                          void run(change.first.n, () =>
                            change.state === 'reverted'
                              ? readerApi.editSpeechItem(doc.id, change.first.n, {
                                  state: 'applied',
                                  all: true,
                                })
                              : readerApi.revertSpeechItem(doc.id, change.first.n, true),
                          )
                        }
                      >
                        {change.state === 'reverted' ? (
                          <RefreshCwIcon className="size-4" aria-hidden="true" />
                        ) : (
                          <Undo2Icon className="size-4" aria-hidden="true" />
                        )}
                      </IconButton>
                      {editButton(change.first)}
                      {dictionaryButton(change.first)}
                    </>,
                  ),
                )}
              </ul>
            </div>
          ))}
        </section>

        {data?.ready && (
          <section aria-labelledby="rd-speech-pauses" className="pt-3">
            <h3 id="rd-speech-pauses" className="rd-sheet-heading px-3">
              {t('reader.speech_pauses')}
            </h3>
            {PAUSE_RULES.filter((rule) => data.pause_counts[rule] > 0).map((rule) => (
              <SheetRow
                key={rule}
                label={t(PAUSE_RULE_LABELS[rule])}
                detail={t('reader.speech_pause_count', { n: data.pause_counts[rule] })}
                role="switch"
                aria-checked={data.pause_rules[rule]}
                checked={data.pause_rules[rule]}
                disabled={pending !== null}
                onClick={() => setRule(rule, !data.pause_rules[rule])}
              />
            ))}
          </section>
        )}
        {comparing && comparing.phase !== 'loading' && (
          <p className="px-3 pt-2 text-xs text-muted-foreground" aria-live="polite">
            {t(comparing.phase === 'a' ? 'reader.speech_playing_a' : 'reader.speech_playing_b')}
          </p>
        )}
        {comparing && <SheetRow icon={SquareIcon} label={t('reader.speech_stop')} onClick={stop} />}
      </div>
    </ReaderSheet>
  );
}
