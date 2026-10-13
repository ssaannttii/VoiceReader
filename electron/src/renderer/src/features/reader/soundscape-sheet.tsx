import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CoffeeIcon,
  CloudRainIcon,
  FlameIcon,
  Loader2Icon,
  SparklesIcon,
  VolumeXIcon,
  WavesIcon,
  WindIcon,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AmbienceSceneTag } from './ambience-schedule';
import {
  SOUNDSCAPES,
  useListeningPrefs,
  type SoundscapeChoice,
  type SoundscapeId,
} from './listening-prefs';
import { useAmbienceInfo, type AmbienceInfo } from './reader-ambience';
import { soundscapePlayer, useSoundscapeStatus } from './reader-soundscape';
import { ReaderSheet, SheetRow } from './reader-sheet';

const SOUND_ICONS: Record<SoundscapeId, LucideIcon> = {
  rain: CloudRainIcon,
  brown: WavesIcon,
  pink: WindIcon,
  cafe: CoffeeIcon,
  fire: FlameIcon,
};

const SOUND_LABELS: Record<SoundscapeId, string> = {
  rain: 'reader.soundscape_rain',
  brown: 'reader.soundscape_brown',
  pink: 'reader.soundscape_pink',
  cafe: 'reader.soundscape_cafe',
  fire: 'reader.soundscape_fire',
};

const AMBIENCE_LABELS: Record<AmbienceSceneTag, string> = {
  rain: 'reader.ambience_rain',
  storm: 'reader.ambience_storm',
  wind: 'reader.ambience_wind',
  sea: 'reader.ambience_sea',
  forest: 'reader.ambience_forest',
  night: 'reader.ambience_night',
  fire: 'reader.ambience_fire',
  tavern: 'reader.ambience_tavern',
  city: 'reader.ambience_city',
  interior: 'reader.ambience_interior',
  cave: 'reader.ambience_cave',
};

/** Icon of the chosen soundscape (dock chip, options row). */
export function soundscapeIcon(id: SoundscapeChoice): LucideIcon {
  if (id === 'auto') return SparklesIcon;
  return id === 'off' ? WavesIcon : SOUND_ICONS[id];
}

/** "Now: rain" / "Now: silence" / "Reading the text…" under the Automático row. */
export function useAmbienceDetail(info: AmbienceInfo): string {
  const { t } = useTranslation();
  if (info.status === 'loading' || info.status === 'computing')
    return t('reader.ambience_analyzing');
  if (info.status === 'unavailable') return t('reader.ambience_unavailable');
  if (info.tag === 'none') return t('reader.ambience_silence');
  return t('reader.ambience_now', { sound: t(AMBIENCE_LABELS[info.tag]) });
}

export function SoundscapeSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const prefs = useListeningPrefs();
  const status = useSoundscapeStatus();
  const ambience = useAmbienceInfo();
  const ambienceDetail = useAmbienceDetail(ambience);
  const volume = prefs.soundscapeVolume;
  const auto = prefs.soundscape === 'auto';
  return (
    <ReaderSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t('reader.soundscape')}
      description={t('reader.soundscape_hint')}
    >
      <div className="space-y-3 pb-1">
        <div className="space-y-0.5">
          <SheetRow
            icon={VolumeXIcon}
            label={t('reader.soundscape_off')}
            checked={prefs.soundscape === 'off'}
            onClick={() => soundscapePlayer.choose('off')}
          />
          <SheetRow
            icon={SparklesIcon}
            label={t('reader.soundscape_auto')}
            detail={auto ? ambienceDetail : t('reader.soundscape_auto_hint')}
            trailing={
              auto && (ambience.status === 'loading' || ambience.status === 'computing') ? (
                <Loader2Icon
                  className="size-4 animate-spin text-muted-foreground"
                  aria-hidden="true"
                />
              ) : undefined
            }
            checked={auto}
            onClick={() => soundscapePlayer.choose('auto')}
          />
          {SOUNDSCAPES.map((id) => {
            const chosen = prefs.soundscape === id;
            return (
              <SheetRow
                key={id}
                icon={SOUND_ICONS[id]}
                label={t(SOUND_LABELS[id])}
                detail={
                  chosen && status === 'loading'
                    ? t('reader.soundscape_preparing')
                    : chosen && status === 'error'
                      ? t('reader.soundscape_failed')
                      : undefined
                }
                trailing={
                  chosen && status === 'loading' ? (
                    <Loader2Icon
                      className="size-4 animate-spin text-muted-foreground"
                      aria-hidden="true"
                    />
                  ) : undefined
                }
                checked={chosen}
                onClick={() => soundscapePlayer.choose(id)}
              />
            );
          })}
        </div>
        <section
          aria-labelledby="reader-soundscape-volume"
          className={cn(prefs.soundscape === 'off' && 'opacity-50')}
        >
          <h3
            id="reader-soundscape-volume"
            className="px-1 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground"
          >
            {t('reader.soundscape_volume')}
          </h3>
          <input
            type="range"
            className="rd-range"
            min={0}
            max={100}
            step={1}
            value={volume}
            disabled={prefs.soundscape === 'off'}
            aria-label={t('reader.soundscape_volume')}
            aria-valuetext={`${volume}%`}
            style={{ '--rd-fill': `${volume}%` } as CSSProperties}
            onChange={(event) => soundscapePlayer.setVolume(Number(event.target.value))}
          />
        </section>
        <SheetRow
          label={t('reader.soundscape_with_voice')}
          detail={t('reader.soundscape_with_voice_hint')}
          role="switch"
          aria-checked={prefs.soundscapeWithVoice}
          checked={prefs.soundscapeWithVoice}
          onClick={() => soundscapePlayer.setWithVoice(!prefs.soundscapeWithVoice)}
        />
      </div>
    </ReaderSheet>
  );
}
