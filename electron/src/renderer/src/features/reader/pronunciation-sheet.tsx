import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Loader2Icon, PlusIcon, SquareIcon, Trash2Icon, Volume2Icon } from 'lucide-react';
import { claimPlayback } from '@/lib/audio/playback';
import { createObjectUrl, revokeObjectUrl } from '@/lib/audio/object-url';
import { describeError } from '@/lib/api/client';
import { queryClient } from '@/lib/query';
import { existingEntry, findTerm, previewWindow } from './pronunciation';
import { readerApi, readerKeys, type ReaderDocument, type ReaderPronunciation } from './reader-api';
import { readerPlayer, silentWav } from './reader-player';
import { ReaderSheet, SheetRow } from './reader-sheet';
import type { WordPress } from './reader-text-view';
import { languageName } from './voice-picker';

type SheetProps = { open: boolean; onOpenChange: (open: boolean) => void };

/** A word to (re)define; `segment` null when opened from the list or "Add". */
export type PronounceTarget = { term: string; segment: number | null; offset: number };

export function pressTarget(press: WordPress): PronounceTarget {
  return { term: press.term, segment: press.segment, offset: press.offset };
}

export function usePronunciations(language: string | null, enabled: boolean) {
  return useQuery({
    queryKey: readerKeys.pronunciations(language),
    queryFn: ({ signal }) => readerApi.pronunciations(language, signal),
    enabled,
    staleTime: 60_000,
  });
}

/**
 * The dictionary changed: refresh the lists and drop the player's rendered
 * audio for documents it can affect, so no sentence plays the old reading.
 */
function pronunciationsChanged(language: string) {
  void queryClient.invalidateQueries({ queryKey: ['reader', 'pronunciations'] });
  const loaded = readerPlayer.getState().doc;
  if (loaded && (language === '*' || !loaded.language || loaded.language === language))
    readerPlayer.refreshAudio();
}

let previewAudio: HTMLAudioElement | null = null;

/** "Pronunciar como": respell one word for the document's language. */
export function PronounceSheet({
  doc,
  target,
  onClose,
}: {
  doc: ReaderDocument;
  target: PronounceTarget | null;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const language = doc.language ?? null;
  const entries = usePronunciations(language, target !== null);
  const [shown, setShown] = useState(target);
  const [term, setTerm] = useState('');
  const [replacement, setReplacement] = useState('');
  const [busy, setBusy] = useState<'preview' | 'save' | null>(null);
  const [playing, setPlaying] = useState(false);
  /** Entry a preview saved and the one it replaced, until the sheet is saved or closed. */
  const trial = useRef<{
    applied: ReaderPronunciation;
    before: ReaderPronunciation | null;
  } | null>(null);
  const token = useRef(0);
  const urlRef = useRef<string | null>(null);
  const filled = useRef(false);

  const stopPreview = () => {
    token.current++;
    previewAudio?.pause();
    revokeObjectUrl(urlRef.current);
    urlRef.current = null;
    setPlaying(false);
  };

  useEffect(() => {
    if (!target) return;
    setShown(target);
    setTerm(target.term);
    setReplacement(target.term);
    setBusy(null);
    trial.current = null;
    filled.current = false;
  }, [target]);

  // Prefill with the saved respelling once the list arrives.
  useEffect(() => {
    if (!target || filled.current || !entries.data) return;
    filled.current = true;
    const entry = existingEntry(entries.data, target.term, language);
    if (entry) setReplacement(entry.replacement);
  }, [target, entries.data, language]);

  useEffect(() => () => stopPreview(), []);

  /** Closed without saving: put back what a preview changed. */
  const revertTrial = () => {
    const { applied, before } = trial.current ?? {};
    trial.current = null;
    if (!applied) return;
    const restore =
      before && before.id === applied.id
        ? readerApi.savePronunciation(before.term, before.replacement, before.language)
        : readerApi.deletePronunciation(applied.id);
    void restore.catch(() => {}).finally(() => pronunciationsChanged(applied.language));
  };

  const close = () => {
    stopPreview();
    revertTrial();
    onClose();
  };

  const cleanTerm = term.trim();
  const cleanReplacement = replacement.trim();
  const valid = Boolean(cleanTerm && cleanReplacement);
  const where = useMemo(() => {
    if (!shown || !cleanTerm) return null;
    if (shown.segment !== null && cleanTerm === shown.term)
      return { segment: shown.segment, offset: shown.offset };
    return findTerm(doc.segments, cleanTerm, readerPlayer.getState().segment);
  }, [shown, cleanTerm, doc.segments]);

  const preview = async () => {
    if (playing || busy === 'preview') {
      stopPreview();
      setBusy(null);
      return;
    }
    if (!valid || !where || busy || !entries.data) return;
    stopPreview();
    // Previewing another word: put the previous one back first.
    if (
      trial.current &&
      trial.current.applied.term.toLocaleLowerCase() !== cleanTerm.toLocaleLowerCase()
    )
      revertTrial();
    const before = trial.current?.before ?? existingEntry(entries.data, cleanTerm, language);
    const current = ++token.current;
    readerPlayer.pause();
    // Unlock inside the tap so the sample may play once it has rendered.
    previewAudio ??= new Audio();
    previewAudio.src = silentWav();
    void previewAudio.play().catch(() => {});
    setBusy('preview');
    try {
      const applied = await readerApi.savePronunciation(cleanTerm, cleanReplacement, language);
      trial.current = {
        applied,
        before: before && before.language === applied.language ? before : null,
      };
      const player = readerPlayer.getState();
      const loaded = player.doc?.id === doc.id;
      const render = await readerApi.render(doc.id, where.segment, {
        voice: loaded ? player.voice : doc.voice_id,
        engine: loaded ? player.engine : doc.engine,
        language,
      });
      const blob = await readerApi.audio(render.audio_url);
      if (current !== token.current || !previewAudio) return;
      const url = createObjectUrl(blob);
      if (!url) return;
      urlRef.current = url;
      const audio = previewAudio;
      const span = previewWindow(render.words, where.offset, render.duration_s);
      const release = claimPlayback(() => audio.pause(), 'reader-pronunciation');
      const finish = () => {
        release();
        audio.ontimeupdate = null;
        audio.onended = null;
        if (current === token.current) setPlaying(false);
      };
      audio.src = url;
      audio.onended = finish;
      audio.ontimeupdate = () => {
        if (audio.currentTime >= span.end) {
          audio.pause();
          finish();
        }
      };
      audio.onloadedmetadata = () => {
        audio.currentTime = span.start;
      };
      setBusy(null);
      setPlaying(true);
      await audio.play();
    } catch (error) {
      if (current !== token.current) return;
      setBusy(null);
      setPlaying(false);
      toast.error(t('reader.preview_failed'), { description: describeError(error) });
    }
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid || busy === 'save') return;
    stopPreview();
    setBusy('save');
    try {
      const saved = await readerApi.savePronunciation(cleanTerm, cleanReplacement, language);
      // A preview of a different word would leave its trial entry behind.
      if (trial.current && trial.current.applied.id !== saved.id) revertTrial();
      trial.current = null;
      pronunciationsChanged(saved.language);
      toast.success(t('reader.pronunciation_saved', { term: saved.term }));
      onClose();
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setBusy(null);
    }
  };

  const scope = language ? languageName(language, i18n.language) : null;
  return (
    <ReaderSheet
      open={target !== null}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      title={t('reader.pronounce_title')}
      description={
        scope ? t('reader.pronounce_scope', { language: scope }) : t('reader.pronounce_scope_all')
      }
      keyboard
    >
      <form className="space-y-3 pb-1" onSubmit={(event) => void save(event)}>
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-muted-foreground">
            {t('reader.pronounce_word')}
          </span>
          <input
            className="rd-input"
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            maxLength={200}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-muted-foreground">
            {t('reader.pronounce_as')}
          </span>
          <input
            className="rd-input"
            value={replacement}
            onChange={(event) => setReplacement(event.target.value)}
            maxLength={500}
            autoFocus
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="done"
          />
        </label>
        <p className="px-1 text-xs leading-relaxed text-muted-foreground">
          {t('reader.pronounce_hint')}
        </p>
        <div className="grid grid-cols-2 gap-2 pt-1">
          <button
            type="button"
            className="rd-press flex h-12 items-center justify-center gap-2 rounded-full bg-foreground/[0.07] font-semibold disabled:opacity-40"
            disabled={!valid || !where || !entries.data || busy === 'save'}
            title={where ? undefined : t('reader.pronounce_no_sample')}
            onClick={() => void preview()}
          >
            {busy === 'preview' ? (
              <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
            ) : playing ? (
              <SquareIcon className="size-3.5 fill-current" aria-hidden="true" />
            ) : (
              <Volume2Icon className="size-4" aria-hidden="true" />
            )}
            {t(playing ? 'reader.pronounce_stop' : 'reader.pronounce_try')}
          </button>
          <button
            type="submit"
            disabled={!valid || busy === 'save'}
            className="rd-press flex h-12 items-center justify-center gap-2 rounded-full bg-foreground font-semibold text-background disabled:opacity-40"
          >
            {busy === 'save' && <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />}
            {t('reader.save')}
          </button>
        </div>
      </form>
    </ReaderSheet>
  );
}

/** "Pronunciaciones": the entries that apply to the document's language. */
export function PronunciationsSheet({
  doc,
  open,
  onOpenChange,
  onEdit,
}: SheetProps & { doc: ReaderDocument; onEdit: (target: PronounceTarget) => void }) {
  const { t } = useTranslation();
  const language = doc.language ?? null;
  const entries = usePronunciations(language, open);
  const [deleting, setDeleting] = useState<string | null>(null);
  const remove = async (entry: ReaderPronunciation) => {
    setDeleting(entry.id);
    try {
      await readerApi.deletePronunciation(entry.id);
      queryClient.setQueryData<ReaderPronunciation[]>(readerKeys.pronunciations(language), (list) =>
        list?.filter((item) => item.id !== entry.id),
      );
      pronunciationsChanged(entry.language);
      toast.success(t('reader.pronunciation_deleted', { term: entry.term }), {
        action: {
          label: t('reader.undo'),
          onClick: () =>
            void readerApi
              .savePronunciation(entry.term, entry.replacement, entry.language)
              .then(() => pronunciationsChanged(entry.language))
              .catch((error: unknown) => toast.error(describeError(error))),
        },
      });
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setDeleting(null);
    }
  };
  const list = entries.data ?? [];
  return (
    <ReaderSheet open={open} onOpenChange={onOpenChange} title={t('reader.pronunciations')}>
      <div className="pb-1">
        <SheetRow
          icon={PlusIcon}
          label={t('reader.pronunciation_add')}
          onClick={() => onEdit({ term: '', segment: null, offset: 0 })}
        />
        {entries.isPending && (
          <div className="space-y-2 py-2" aria-hidden="true">
            {[0, 1].map((index) => (
              <div key={index} className="rd-skeleton h-12" />
            ))}
          </div>
        )}
        {entries.isError && (
          <p className="px-3 py-4 text-sm text-destructive" role="alert">
            {describeError(entries.error)}
          </p>
        )}
        {entries.isSuccess && !list.length && (
          <p className="px-6 py-8 text-center text-sm leading-relaxed text-muted-foreground">
            {t('reader.pronunciations_empty')}
          </p>
        )}
        {list.length > 0 && (
          <ul className="mt-1 space-y-0.5">
            {list.map((entry) => (
              <li key={entry.id} className="flex items-center gap-1">
                <SheetRow
                  className="flex-1"
                  label={
                    <>
                      {entry.term}
                      <span className="px-1.5 text-muted-foreground" aria-hidden="true">
                        →
                      </span>
                      <span className="sr-only">{t('reader.pronounce_as')}</span>
                      {entry.replacement}
                    </>
                  }
                  detail={entry.language === '*' ? t('reader.pronunciation_global') : undefined}
                  onClick={() => onEdit({ term: entry.term, segment: null, offset: 0 })}
                />
                <button
                  type="button"
                  className="rd-icon-btn shrink-0 text-muted-foreground"
                  aria-label={t('reader.pronunciation_delete', { term: entry.term })}
                  disabled={deleting === entry.id}
                  onClick={() => void remove(entry)}
                >
                  {deleting === entry.id ? (
                    <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <Trash2Icon className="size-4" aria-hidden="true" />
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </ReaderSheet>
  );
}
