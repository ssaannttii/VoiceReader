import { useTranslation } from 'react-i18next';
import { HeadphonesIcon, ListOrderedIcon } from 'lucide-react';
import { setListeningPrefs, useListeningPrefs } from './listening-prefs';
import type { ReaderDocument } from './reader-api';
import { QueueRow } from './queue-sheet';
import { SheetRow } from './reader-sheet';
import { soundscapeIcon } from './soundscape-sheet';

const SOUND_LABELS = {
  off: 'reader.soundscape_off',
  rain: 'reader.soundscape_rain',
  brown: 'reader.soundscape_brown',
  pink: 'reader.soundscape_pink',
  cafe: 'reader.soundscape_cafe',
  fire: 'reader.soundscape_fire',
} as const;

/** Reader options rows for long listening: audio-only mode, soundscape and queue. */
export function ListeningOptionRows({
  doc,
  active,
  onSheet,
}: {
  doc: ReaderDocument;
  /** This document is the one in the player (queueing it would be a no-op). */
  active: boolean;
  onSheet: (sheet: 'queue' | 'soundscape') => void;
}) {
  const { t } = useTranslation();
  const prefs = useListeningPrefs();
  return (
    <div className="-mx-1 space-y-0.5 border-t border-border/60 pt-2">
      <SheetRow
        icon={HeadphonesIcon}
        label={t('reader.audio_only')}
        detail={t('reader.audio_only_hint')}
        role="switch"
        aria-checked={prefs.audioOnly}
        checked={prefs.audioOnly}
        onClick={() => setListeningPrefs({ audioOnly: !prefs.audioOnly })}
      />
      <SheetRow
        icon={soundscapeIcon(prefs.soundscape)}
        label={t('reader.soundscape')}
        detail={t(SOUND_LABELS[prefs.soundscape])}
        chevron
        onClick={() => onSheet('soundscape')}
      />
      {!active && <QueueRow doc={doc} />}
      <SheetRow
        icon={ListOrderedIcon}
        label={t('reader.queue')}
        chevron
        onClick={() => onSheet('queue')}
      />
    </div>
  );
}
