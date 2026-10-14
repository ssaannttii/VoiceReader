/** One first-run card above the dock: "choose your voice" for a new language, then reading tips. */
import { useEffect, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { describeError } from '@/lib/api/client';
import { LightbulbIcon, MicIcon } from 'lucide-react';
import {
  markTip,
  markVoiceAsked,
  nextTip,
  sampleLanguage,
  shouldAskVoice,
  useFirstRun,
  type Tip,
} from './first-run';
import { readerApi, readerKeys, type ReaderDocument } from './reader-api';
import { isTouchDevice } from './reader-chrome';
import { useReaderPrefs } from './reader-prefs';
import { languageKey, languageName } from './voice-picker';

export function FirstRunCard({
  doc,
  hidden,
  onChooseVoice,
}: {
  doc: ReaderDocument;
  /** A sheet is open or the text is not shown: keep quiet. */
  hidden: boolean;
  onChooseVoice: () => void;
}) {
  const { t, i18n } = useTranslation();
  const state = useFirstRun();
  const prefs = useReaderPrefs();
  const key = languageKey(doc.language);
  // Only ask the PC when the card could be offered at all.
  const askable = Boolean(key) && !doc.voice_id && !state.voiceAsked.includes(key);
  const defaults = useQuery({
    queryKey: readerKeys.defaultVoices,
    queryFn: ({ signal }) => readerApi.defaultVoices(signal),
    enabled: askable,
    staleTime: 60_000,
  });
  const voices = useQuery({
    queryKey: readerKeys.voices,
    queryFn: ({ signal }) => readerApi.voices(signal),
    enabled: askable,
    staleTime: 60_000,
  });
  const askVoice =
    askable &&
    shouldAskVoice({
      state,
      language: doc.language,
      voiceId: doc.voice_id,
      defaults: defaults.data,
      voices: voices.data,
    });
  const tip = askVoice ? null : nextTip(state);

  // Picking a voice some other way answers the question too.
  useEffect(() => {
    if (key && doc.voice_id) markVoiceAsked(key);
  }, [key, doc.voice_id]);

  if (hidden || (!askVoice && !tip)) return null;

  if (askVoice) {
    const language = languageName(key, i18n.language, { inSentence: true });
    return (
      <Card
        icon={<MicIcon className="size-4 shrink-0" aria-hidden="true" />}
        title={t('reader.first_voice_title', { language })}
        detail={t('reader.first_voice_body', { language })}
        primary={{
          label: t('reader.first_voice_action'),
          run: () => {
            markVoiceAsked(key);
            onChooseVoice();
          },
        }}
        secondary={{ label: t('reader.first_later'), run: () => markVoiceAsked(key) }}
      />
    );
  }

  const text = tipText(tip as Tip, { doubleTap: prefs.doubleTap, touch: isTouchDevice() });
  return (
    <Card
      icon={<LightbulbIcon className="size-4 shrink-0" aria-hidden="true" />}
      title={t(text)}
      primary={{ label: t('reader.tip_got_it'), run: () => markTip(tip as Tip) }}
    />
  );
}

/** Creates the welcome document in the UI language and hands it to `onCreated`. */
export function useCreateSample(onCreated: (id: string) => void) {
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const create = useMutation({
    mutationFn: () =>
      readerApi.createFromText(
        t('reader.sample_text'),
        t('reader.sample_title'),
        sampleLanguage(i18n.language),
      ),
    onSuccess: (doc) => {
      void client.invalidateQueries({ queryKey: readerKeys.documents });
      onCreated(doc.id);
    },
    onError: (error: unknown) => toast.error(describeError(error)),
  });
  return () => {
    if (!create.isPending) create.mutate();
  };
}

/** The i18n key for a tip on this device. */
export function tipText(tip: Tip, { doubleTap, touch }: { doubleTap: boolean; touch: boolean }) {
  if (tip === 'tap') return doubleTap ? 'reader.tip_double_tap' : 'reader.tip_tap';
  if (tip === 'press') return touch ? 'reader.tip_press' : 'reader.tip_right_click';
  return 'reader.tip_menu';
}

function Card({
  icon,
  title,
  detail,
  primary,
  secondary,
}: {
  icon: ReactNode;
  title: string;
  detail?: string;
  primary: { label: string; run: () => void };
  secondary?: { label: string; run: () => void };
}) {
  return (
    <div className="rd-first-run" role="status" aria-live="polite" data-slot="reader-first-run">
      {icon}
      <span className="min-w-0 flex-1 py-1">
        <span className="block font-medium">{title}</span>
        {detail && <span className="block text-xs text-muted-foreground">{detail}</span>}
      </span>
      {secondary && (
        <button
          type="button"
          className="rd-press h-9 shrink-0 rounded-full px-3 text-xs font-semibold text-muted-foreground"
          onClick={secondary.run}
        >
          {secondary.label}
        </button>
      )}
      <button
        type="button"
        className="rd-press h-9 shrink-0 rounded-full bg-foreground px-3.5 text-xs font-semibold text-background"
        onClick={primary.run}
      >
        {primary.label}
      </button>
    </div>
  );
}
