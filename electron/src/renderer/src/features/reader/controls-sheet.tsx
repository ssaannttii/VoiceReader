/** "Controles": skip length, what previous/next do, and double-tap to play. */
import { useTranslation } from 'react-i18next';
import { BookmarkIcon, FastForwardIcon, PointerIcon, TextIcon } from 'lucide-react';
import { ReaderSheet, SheetRow } from './reader-sheet';
import { AutoHideRow } from './reader-menus';
import { setReaderPrefs, SKIP_OPTIONS, useReaderPrefs, type TrackAction } from './reader-prefs';

export function ControlsSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const prefs = useReaderPrefs();
  const actions: { value: TrackAction; icon: typeof TextIcon; label: string }[] = [
    { value: 'sentence', icon: TextIcon, label: t('reader.controls_track_sentence') },
    { value: 'chapter', icon: BookmarkIcon, label: t('reader.controls_track_chapter') },
    {
      value: 'skip',
      icon: FastForwardIcon,
      label: t('reader.controls_track_skip', { seconds: prefs.skipSeconds }),
    },
  ];
  return (
    <ReaderSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t('reader.controls')}
      description={t('reader.controls_hint')}
    >
      <div className="space-y-4 pb-1">
        <section aria-labelledby="reader-skip">
          <h3 id="reader-skip" className="rd-sheet-heading mb-2 px-1">
            {t('reader.controls_skip')}
          </h3>
          <div className="grid grid-cols-4 gap-2">
            {SKIP_OPTIONS.map((seconds) => (
              <button
                key={seconds}
                type="button"
                className="rd-chip"
                aria-pressed={prefs.skipSeconds === seconds}
                onClick={() => setReaderPrefs({ skipSeconds: seconds })}
              >
                {t('reader.controls_seconds', { seconds })}
              </button>
            ))}
          </div>
        </section>
        <section aria-labelledby="reader-track">
          <h3 id="reader-track" className="rd-sheet-heading px-1">
            {t('reader.controls_track')}
          </h3>
          <p className="px-1 pb-1 text-xs text-muted-foreground">
            {t('reader.controls_track_hint')}
          </p>
          <div className="-mx-1 space-y-0.5">
            {actions.map(({ value, icon, label }) => (
              <SheetRow
                key={value}
                icon={icon}
                label={label}
                checked={prefs.trackAction === value}
                onClick={() => setReaderPrefs({ trackAction: value })}
              />
            ))}
          </div>
        </section>
        <div className="-mx-1 border-t border-border/60 pt-2">
          <SheetRow
            icon={PointerIcon}
            label={t('reader.controls_double_tap')}
            detail={t('reader.controls_double_tap_hint')}
            role="switch"
            aria-checked={prefs.doubleTap}
            checked={prefs.doubleTap}
            onClick={() => setReaderPrefs({ doubleTap: !prefs.doubleTap })}
          />
          <AutoHideRow />
        </div>
      </div>
    </ReaderSheet>
  );
}
