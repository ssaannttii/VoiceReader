import { Link } from '@tanstack/react-router';
import { Loader2Icon, PauseIcon, PlayIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { CoverTile } from './cover-tile';
import { readerPlayer, useReaderClock, useReaderPlayer } from './reader-player';

function MiniProgress() {
  const clock = useReaderClock();
  const fraction = clock.total > 0 ? Math.min(1, clock.elapsed / clock.total) : 0;
  return (
    <div className="rd-progress absolute inset-x-4 bottom-0 h-[2px]" aria-hidden="true">
      <span style={{ transform: `scaleX(${fraction})` }} />
    </div>
  );
}

/** Persistent bar on the library while a document is loaded in the player. */
export function MiniPlayer() {
  const { t } = useTranslation();
  const player = useReaderPlayer();
  const doc = player.doc;
  if (!doc) return null;
  const busy = player.status === 'buffering';
  const playing = player.status === 'playing' || busy;
  const sentence = doc.segments[player.segment]?.text ?? '';
  return (
    <div className="rd-mini" data-slot="reader-mini-player">
      <div className="relative flex items-center gap-2 overflow-hidden rounded-2xl bg-card/95 p-2 pl-2.5 shadow-[0_16px_40px_-18px_rgb(0_0_0/0.55)] ring-1 ring-border/80 backdrop-blur-xl">
        <Link
          to="/reader/$docId"
          params={{ docId: doc.id }}
          className="rd-press flex min-w-0 flex-1 items-center gap-3 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={t('reader.open_player', { title: doc.title })}
        >
          <CoverTile id={doc.id} title={doc.title} hasCover={doc.has_cover} size="sm" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold">{doc.title}</span>
            <span className="block truncate text-xs text-muted-foreground">
              {player.status === 'error' ? player.error : sentence}
            </span>
          </span>
        </Link>
        <button
          type="button"
          className="rd-icon-btn bg-foreground text-background"
          aria-label={t(playing ? 'reader.pause' : 'reader.play')}
          onClick={() => readerPlayer.toggle()}
        >
          {busy ? (
            <Loader2Icon className="size-5 animate-spin" aria-hidden="true" />
          ) : playing ? (
            <PauseIcon className="size-5 fill-current" aria-hidden="true" />
          ) : (
            <PlayIcon className="ml-0.5 size-5 fill-current" aria-hidden="true" />
          )}
        </button>
        <MiniProgress />
      </div>
    </div>
  );
}
