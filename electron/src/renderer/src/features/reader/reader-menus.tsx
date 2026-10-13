/** The reading view's two menus: "⋯" actions and the "Aa" appearance sheet. */
import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BookMarkedIcon,
  BookmarkPlusIcon,
  EyeOffIcon,
  GaugeIcon,
  HeadphonesIcon,
  ListIcon,
  ListOrderedIcon,
  MoonIcon,
  RotateCcwIcon,
  SearchIcon,
  SlidersHorizontalIcon,
  SpeechIcon,
  UserRoundIcon,
} from 'lucide-react';
import { AppearanceOptions, AppearancePreview, SheetSection } from './appearance-options';
import { CoverTile } from './cover-tile';
import { distinctSource } from './player-chrome';
import { DiagnosticsRows } from './debug-hud';
import { OfflineRow } from './document-actions-sheet';
import { setListeningPrefs, useListeningPrefs } from './listening-prefs';
import { QueueRow } from './queue-sheet';
import type { ReaderDocument } from './reader-api';
import { DEFAULT_APPEARANCE, setReaderAppearance } from './reader-appearance';
import { useReaderPlayer } from './reader-player';
import {
  autoHideOn,
  DEFAULT_PREFS,
  setReaderPrefs,
  TEXT_SIZE_MAX,
  TEXT_SIZE_MIN,
  useReaderPrefs,
} from './reader-prefs';
import { useReaderQueue } from './reader-queue';
import { ReaderSheet, SheetRow } from './reader-sheet';
import { formatSpeed } from './reader-text';
import { soundscapeIcon } from './soundscape-sheet';

/** Sheets the menus open. */
export type MenuSheet =
  | 'chapters'
  | 'bookmarks'
  | 'search'
  | 'pronunciations'
  | 'voice'
  | 'sleep'
  | 'speed'
  | 'controls'
  | 'soundscape'
  | 'queue';

const SOUND_LABELS = {
  off: 'reader.soundscape_off',
  rain: 'reader.soundscape_rain',
  brown: 'reader.soundscape_brown',
  pink: 'reader.soundscape_pink',
  cafe: 'reader.soundscape_cafe',
  fire: 'reader.soundscape_fire',
} as const;

/** "Hide controls while playing" switch (Aa sheet and Controls sheet). */
export function AutoHideRow() {
  const { t } = useTranslation();
  const prefs = useReaderPrefs();
  const on = autoHideOn(prefs);
  return (
    <SheetRow
      icon={EyeOffIcon}
      label={t('reader.auto_hide')}
      detail={t('reader.auto_hide_hint')}
      role="switch"
      aria-checked={on}
      checked={on}
      onClick={() => setReaderPrefs({ autoHide: !on })}
    />
  );
}

const Divider = () => <div className="rd-sheet-divider" role="separator" />;

export function ActionsSheet({
  doc,
  active,
  open,
  onOpenChange,
  onSheet,
  onAddBookmark,
}: {
  doc: ReaderDocument;
  active: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSheet: (sheet: MenuSheet) => void;
  onAddBookmark: () => void;
}) {
  const { t } = useTranslation();
  const listening = useListeningPrefs();
  const player = useReaderPlayer();
  const queued = useReaderQueue().filter((item) => item.id !== doc.id).length;
  const subtitle = doc.author || distinctSource(doc.title, doc.source_name);
  return (
    <ReaderSheet
      open={open}
      onOpenChange={onOpenChange}
      title={
        <span className="flex min-w-0 items-center gap-3">
          <CoverTile id={doc.id} title={doc.title} hasCover={doc.has_cover} size="sm" />
          <span className="min-w-0">
            <span className="line-clamp-2 block">{doc.title}</span>
            {subtitle && (
              <span className="block truncate text-sm font-normal text-muted-foreground">
                {subtitle}
              </span>
            )}
          </span>
        </span>
      }
    >
      <div className="-mx-1 space-y-0.5 pb-1">
        {doc.chapters.length > 0 && (
          <SheetRow
            icon={ListIcon}
            label={t('reader.chapters')}
            chevron
            onClick={() => onSheet('chapters')}
          />
        )}
        <SheetRow
          icon={BookmarkPlusIcon}
          label={t('reader.bookmark_add')}
          disabled={!doc.segments.length}
          onClick={onAddBookmark}
        />
        <SheetRow
          icon={BookMarkedIcon}
          label={t('reader.bookmarks')}
          chevron
          onClick={() => onSheet('bookmarks')}
        />
        <SheetRow
          icon={SearchIcon}
          label={t('reader.search_document')}
          chevron
          onClick={() => onSheet('search')}
        />
        <Divider />
        <SheetRow
          icon={UserRoundIcon}
          label={t('reader.voice')}
          chevron
          onClick={() => onSheet('voice')}
        />
        <SheetRow
          icon={GaugeIcon}
          label={t('reader.speed')}
          trailing={
            <span className="text-sm tabular-nums text-muted-foreground">
              {formatSpeed(player.rate)}
            </span>
          }
          chevron
          onClick={() => onSheet('speed')}
        />
        <SheetRow
          icon={MoonIcon}
          label={t('reader.sleep_timer')}
          chevron
          onClick={() => onSheet('sleep')}
        />
        <SheetRow
          icon={SpeechIcon}
          label={t('reader.pronunciations')}
          detail={t('reader.pronunciations_hint')}
          chevron
          onClick={() => onSheet('pronunciations')}
        />
        <SheetRow
          icon={SlidersHorizontalIcon}
          label={t('reader.controls')}
          chevron
          onClick={() => onSheet('controls')}
        />
        <Divider />
        <SheetRow
          icon={HeadphonesIcon}
          label={t('reader.audio_only')}
          detail={t('reader.audio_only_hint')}
          role="switch"
          aria-checked={listening.audioOnly}
          checked={listening.audioOnly}
          onClick={() => setListeningPrefs({ audioOnly: !listening.audioOnly })}
        />
        <SheetRow
          icon={soundscapeIcon(listening.soundscape)}
          label={t('reader.soundscape')}
          detail={t(SOUND_LABELS[listening.soundscape])}
          chevron
          onClick={() => onSheet('soundscape')}
        />
        {!active && <QueueRow doc={doc} />}
        <SheetRow
          icon={ListOrderedIcon}
          label={t('reader.queue')}
          trailing={
            queued > 0 ? (
              <span className="text-sm tabular-nums text-muted-foreground">{queued}</span>
            ) : undefined
          }
          chevron
          onClick={() => onSheet('queue')}
        />
        <Divider />
        <OfflineRow id={doc.id} />
      </div>
      <DiagnosticsRows />
    </ReaderSheet>
  );
}

export function AppearanceSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const prefs = useReaderPrefs();
  const fill = ((prefs.textSize - TEXT_SIZE_MIN) / (TEXT_SIZE_MAX - TEXT_SIZE_MIN)) * 100;
  return (
    <ReaderSheet open={open} onOpenChange={onOpenChange} title={t('reader.appearance')}>
      <div className="space-y-5 pb-1">
        <AppearancePreview textSize={prefs.textSize} />
        <SheetSection
          id="reader-text-size"
          title={t('reader.text_size')}
          aside={
            <span className="text-sm font-semibold tabular-nums text-muted-foreground">
              {prefs.textSize}
            </span>
          }
        >
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="rd-icon-btn font-[family-name:var(--rd-serif)] text-sm"
              aria-label={t('reader.text_smaller')}
              disabled={prefs.textSize <= TEXT_SIZE_MIN}
              onClick={() => setReaderPrefs({ textSize: prefs.textSize - 1 })}
            >
              A
            </button>
            <input
              type="range"
              className="rd-range flex-1"
              min={TEXT_SIZE_MIN}
              max={TEXT_SIZE_MAX}
              step={1}
              value={prefs.textSize}
              aria-label={t('reader.text_size')}
              aria-valuetext={String(prefs.textSize)}
              style={{ '--rd-fill': `${fill}%` } as CSSProperties}
              onChange={(event) => setReaderPrefs({ textSize: Number(event.target.value) })}
            />
            <button
              type="button"
              className="rd-icon-btn font-[family-name:var(--rd-serif)] text-[1.375rem]"
              aria-label={t('reader.text_larger')}
              disabled={prefs.textSize >= TEXT_SIZE_MAX}
              onClick={() => setReaderPrefs({ textSize: prefs.textSize + 1 })}
            >
              A
            </button>
          </div>
        </SheetSection>
        <AppearanceOptions />
        <div className="-mx-1 space-y-0.5">
          <Divider />
          <AutoHideRow />
          <SheetRow
            icon={RotateCcwIcon}
            label={t('reader.reset_appearance')}
            onClick={() => {
              setReaderAppearance(DEFAULT_APPEARANCE);
              setReaderPrefs({ textSize: DEFAULT_PREFS.textSize });
            }}
          />
        </div>
      </div>
    </ReaderSheet>
  );
}
