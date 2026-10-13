import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { ListOrderedIcon, Loader2Icon, PauseIcon, PlayIcon, RotateCcwIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { CoverTile } from './cover-tile';
import { tick } from './haptics';
import { coverArt, coverShape } from './library-view';
import { QueueSheet } from './queue-sheet';
import { readerPlayer, useReaderClock, useReaderPlayer } from './reader-player';
import { useReaderPrefs } from './reader-prefs';
import { useReaderQueue } from './reader-queue';
// Soundscapes follow the voice wherever playback starts (library included).
import './reader-soundscape';

function MiniProgress() {
  const clock = useReaderClock();
  const fraction = clock.total > 0 ? Math.min(1, clock.elapsed / clock.total) : 0;
  return (
    <div className="rd-mini-progress" aria-hidden="true">
      <span style={{ transform: `scaleX(${fraction})` }} />
    </div>
  );
}

/**
 * Floating card on the library while a document is loaded in the player.
 * `hidden` slides it away (scrolling down the list); it returns on scroll up.
 */
export function MiniPlayer({ hidden = false }: { hidden?: boolean }) {
  const { t } = useTranslation();
  const player = useReaderPlayer();
  const queue = useReaderQueue();
  const { skipSeconds } = useReaderPrefs();
  const [queueOpen, setQueueOpen] = useState(false);
  const doc = player.doc;
  if (!doc) return null;
  const queued = queue.filter((item) => item.id !== doc.id).length;
  const busy = player.status === 'buffering';
  const playing = player.status === 'playing' || busy;
  const subtitle =
    player.status === 'error'
      ? player.error
      : doc.author || doc.source_name || t('reader.source_text');
  return (
    <div className="rd-mini" data-slot="reader-mini-player" data-hidden={hidden || undefined}>
      <div className="rd-mini-card">
        <Link
          to="/reader/$docId"
          params={{ docId: doc.id }}
          className="rd-mini-open"
          aria-label={t('reader.open_player', { title: doc.title })}
          tabIndex={hidden ? -1 : undefined}
        >
          <span className="rd-mini-cover">
            <CoverTile
              id={doc.id}
              title={doc.title}
              hasCover={doc.has_cover}
              shape={coverShape(doc)}
              art={coverArt(doc)}
              size="sm"
            />
          </span>
          <span className="min-w-0 flex-1">
            <span className="rd-mini-title">{doc.title}</span>
            <span className="rd-mini-sub" data-error={player.status === 'error' || undefined}>
              {subtitle}
            </span>
          </span>
        </Link>
        <button
          type="button"
          className="rd-icon-btn relative text-muted-foreground"
          aria-label={t('reader.queue_open', { count: queued })}
          tabIndex={hidden ? -1 : undefined}
          onClick={() => setQueueOpen(true)}
        >
          <ListOrderedIcon className="size-5" aria-hidden="true" />
          {queued > 0 && (
            <span className="rd-chip-badge" aria-hidden="true">
              {queued}
            </span>
          )}
        </button>
        <button
          type="button"
          className="rd-icon-btn relative"
          aria-label={t('reader.back_seconds', { seconds: skipSeconds })}
          tabIndex={hidden ? -1 : undefined}
          onClick={() => readerPlayer.skip(-skipSeconds)}
        >
          <RotateCcwIcon className="size-[1.4rem]" strokeWidth={1.75} aria-hidden="true" />
          <span className="rd-skip-num" aria-hidden="true">
            {skipSeconds}
          </span>
        </button>
        <button
          type="button"
          className="rd-icon-btn"
          aria-label={t(playing ? 'reader.pause' : 'reader.play')}
          tabIndex={hidden ? -1 : undefined}
          onClick={() => {
            tick();
            readerPlayer.toggle();
          }}
        >
          {busy ? (
            <Loader2Icon className="size-6 animate-spin" aria-hidden="true" />
          ) : playing ? (
            <PauseIcon className="size-[26px] fill-current" strokeWidth={0} aria-hidden="true" />
          ) : (
            <PlayIcon
              className="ml-0.5 size-[26px] fill-current"
              strokeWidth={0}
              aria-hidden="true"
            />
          )}
        </button>
        <MiniProgress />
      </div>
      <QueueSheet open={queueOpen} onOpenChange={setQueueOpen} />
    </div>
  );
}
