import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ActivityIcon, FlagIcon, GaugeIcon } from 'lucide-react';
import {
  markProblem,
  setDebugEnabled,
  setHudVisible,
  useDebugFlags,
  useDebugStats,
} from './reader-debug';
import { readerPlayer, useReaderPlayer } from './reader-player';
import { SheetRow } from './reader-sheet';

/** Live diagnostics overlay, for screenshots. Toggled from the reader menu. */
export function DebugHud() {
  const { hud } = useDebugFlags();
  const stats = useDebugStats();
  useReaderPlayer();
  const [, tick] = useState(0);
  useEffect(() => {
    if (!hud) return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [hud]);
  if (!hud) return null;
  const snap = readerPlayer.debugSnapshot();
  const net = (navigator as Navigator & { connection?: { effectiveType?: string; rtt?: number } })
    .connection;
  const rows: [string, string][] = [
    ['seg', `${snap.segment + 1}/${snap.total} · ${snap.status}`],
    ['ready ahead', `${snap.readyAhead} · ${snap.engine}`],
    ['load ms', `${stats.lastLoadMs ?? '–'} (avg ${stats.avgLoadMs ?? '–'})`],
    ['misses/stalls', `${stats.misses}/${stats.stalls}`],
    ['fps · worst', `${stats.fps || '–'} · ${stats.worstFrameMs || '–'} ms`],
    ['net', net ? `${net.effectiveType ?? '?'} · ${net.rtt ?? '?'} ms` : 'n/a'],
    ['log', `${stats.sent} sent · ${stats.queued} queued · ${stats.errors} err`],
  ];
  return (
    <div
      className="pointer-events-none fixed left-2 z-50 rounded-lg bg-black/80 px-2.5 py-2 font-mono text-[11px] leading-4 text-white"
      style={{ top: 'calc(3.75rem + env(safe-area-inset-top, 0px))' }}
      aria-hidden="true"
    >
      {rows.map(([label, value]) => (
        <div key={label} className="flex gap-2">
          <span className="text-white/60">{label}</span>
          <span className="tabular-nums">{value}</span>
        </div>
      ))}
    </div>
  );
}

/** Reader menu rows: report a moment, show the overlay, turn logging off. */
export function DiagnosticsRows() {
  const { t } = useTranslation();
  const { enabled, hud } = useDebugFlags();
  return (
    <div className="-mx-1 space-y-0.5 border-t border-border/60 pt-2">
      <SheetRow
        icon={FlagIcon}
        label={t('reader.debug_mark')}
        detail={t('reader.debug_mark_hint')}
        disabled={!enabled}
        onClick={() => {
          markProblem();
          toast.success(t('reader.debug_marked'));
        }}
      />
      <SheetRow
        icon={GaugeIcon}
        label={t('reader.debug_hud')}
        checked={hud}
        onClick={() => setHudVisible(!hud)}
      />
      <SheetRow
        icon={ActivityIcon}
        label={t('reader.debug_log')}
        detail={t('reader.debug_log_hint')}
        checked={enabled}
        onClick={() => setDebugEnabled(!enabled)}
      />
    </div>
  );
}
