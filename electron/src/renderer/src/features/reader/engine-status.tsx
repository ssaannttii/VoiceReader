/**
 * Clear states for "why isn't it playing": the PC is unreachable (retrying every
 * 5 s, or playing downloaded audio), the voice engine is loading, or it failed.
 * None of these is a generic error.
 */
import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { AlertCircleIcon, CloudOffIcon, Loader2Icon, WifiOffIcon } from 'lucide-react';
import { ApiError } from '@/lib/api/client';
import { readerApi, readerKeys, type ReaderStatus } from './reader-api';
import { readerPlayer, useReaderPlayer } from './reader-player';
import { useOffline } from './offline-state';

const RETRY_MS = 5000;
const WARMUP_EVERY_MS = 60_000;
let lastWarmup = 0;

const unreachable = (error: unknown) => error instanceof ApiError && error.status === 0;

/** Ask the PC to load its voice engine now, so the first sentence does not wait for it. */
export function warmupEngine(force = false) {
  const now = Date.now();
  if (!force && now - lastWarmup < WARMUP_EVERY_MS) return Promise.resolve();
  lastWarmup = now;
  // Older backends have no warm-up route (404); the first render loads the engine instead.
  return readerApi.warmup().then(
    () => undefined,
    () => undefined,
  );
}

/** Warm the engine when Reader opens. */
export function useReaderWarmup() {
  const client = useQueryClient();
  useEffect(() => {
    void warmupEngine().then(() => client.invalidateQueries({ queryKey: readerKeys.status }));
  }, [client]);
}

export type EngineView =
  | { kind: 'ok' }
  | { kind: 'unreachable'; downloaded: number; total: number }
  | { kind: 'loading' }
  | { kind: 'failed'; message: string | null };

/** Combine `/reader/status` (polled while something is wrong) with the player's own view. */
export function useEngineView(docId: string | null): EngineView {
  const player = useReaderPlayer();
  const offline = useOffline();
  const waiting = player.status === 'buffering' || player.blocked !== null;
  const status = useQuery<ReaderStatus>({
    queryKey: readerKeys.status,
    queryFn: ({ signal }) => readerApi.status(signal),
    retry: false,
    staleTime: 2000,
    refetchInterval: (query) => {
      if (query.state.error) return unreachable(query.state.error) ? RETRY_MS : 15_000;
      const model = query.state.data?.model_state;
      if (model === 'loading') return 2000;
      return waiting ? 3000 : false;
    },
  });
  const pcDown = unreachable(status.error) || player.blocked === 'unreachable';

  // Back online: resume a blocked playback without waiting for its own timer.
  useEffect(() => {
    if (status.isSuccess && player.blocked === 'unreachable') readerPlayer.retryNow();
  }, [status.isSuccess, status.dataUpdatedAt, player.blocked]);

  if (pcDown) {
    const meta = docId ? offline.downloaded[docId] : undefined;
    return { kind: 'unreachable', downloaded: meta?.segments ?? 0, total: meta?.total ?? 0 };
  }
  const model = status.data?.model_state ?? 'ready';
  if (model === 'error') return { kind: 'failed', message: status.data?.model_error ?? null };
  if (
    model === 'loading' ||
    player.blocked === 'engine' ||
    (model === 'unloaded' && player.status === 'buffering')
  )
    return { kind: 'loading' };
  return { kind: 'ok' };
}

/** The dock's status line for the states above (nothing when all is well). */
export function EngineBanner({ view }: { view: EngineView }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const refresh = () => {
    void client.refetchQueries({ queryKey: readerKeys.status });
    readerPlayer.retryNow();
  };
  if (view.kind === 'ok') return null;
  let icon = <Loader2Icon className="size-4 shrink-0 animate-spin" aria-hidden="true" />;
  let title: string;
  let detail: string | null = null;
  let action: { label: string; run: () => void } | null = null;
  if (view.kind === 'unreachable') {
    if (view.downloaded > 0) {
      icon = <CloudOffIcon className="size-4 shrink-0" aria-hidden="true" />;
      title = t('reader.engine_offline');
      detail =
        view.downloaded >= view.total && view.total > 0
          ? t('reader.engine_offline_all')
          : t('reader.engine_offline_count', { count: view.downloaded });
    } else {
      icon = <WifiOffIcon className="size-4 shrink-0" aria-hidden="true" />;
      title = t('reader.engine_unreachable');
      detail = t('reader.engine_retrying');
      action = { label: t('reader.retry_now'), run: refresh };
    }
  } else if (view.kind === 'loading') {
    title = t('reader.engine_loading');
    detail = t('reader.engine_loading_hint');
  } else {
    icon = <AlertCircleIcon className="size-4 shrink-0" aria-hidden="true" />;
    title = t('reader.engine_failed');
    detail = view.message;
    action = {
      label: t('reader.retry'),
      run: () => {
        void warmupEngine(true).then(refresh);
      },
    };
  }
  return (
    <div
      className="mb-2 flex items-center gap-2.5 rounded-2xl bg-foreground/[0.06] py-1.5 pl-3 pr-1.5 text-sm"
      role="status"
      aria-live="polite"
      data-slot="reader-engine-status"
      data-kind={view.kind}
    >
      {icon}
      <span className="min-w-0 flex-1 py-1">
        <span className="block truncate font-medium">{title}</span>
        {detail && <span className="block truncate text-xs text-muted-foreground">{detail}</span>}
      </span>
      {action && (
        <button
          type="button"
          className="rd-press h-9 shrink-0 rounded-full bg-foreground px-3.5 text-xs font-semibold text-background"
          onClick={action.run}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
