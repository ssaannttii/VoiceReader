/**
 * Reader diagnostics: a small, local-only event log for tuning Reader on a real phone.
 *
 * Events are buffered in memory and sent to the PC's own backend
 * (`POST /reader/debug/events`), which appends them to
 * `%APPDATA%\OmniVoice\reader-debug\YYYY-MM-DD.jsonl`. Nothing leaves the user's
 * machines and no document text is recorded — only indices, timings and states.
 *
 * On by default in this personal build; the reader menu turns it off and shows a
 * live overlay (HUD) for screenshots.
 */
import { useSyncExternalStore } from 'react';
import { apiFetch } from '@/lib/api/client';

const ENABLED_KEY = 'reader-debug';
const HUD_KEY = 'reader-debug-hud';
const FLUSH_MS = 5000;
const MAX_BUFFER = 400;

type DebugEvent = Record<string, unknown> & { t: number; type: string };

export interface DebugStats {
  sent: number;
  queued: number;
  lastLoadMs: number | null;
  avgLoadMs: number | null;
  loads: number;
  misses: number;
  stalls: number;
  worstFrameMs: number;
  fps: number;
  errors: number;
}

const session =
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);

let buffer: DebugEvent[] = [];
let installed = false;
let deviceSent = false;
let timer: ReturnType<typeof setInterval> | null = null;
let stats: DebugStats = {
  sent: 0,
  queued: 0,
  lastLoadMs: null,
  avgLoadMs: null,
  loads: 0,
  misses: 0,
  stalls: 0,
  worstFrameMs: 0,
  fps: 0,
  errors: 0,
};
const listeners = new Set<() => void>();

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Diagnostics settings are a convenience; blocked storage keeps the defaults.
  }
}

export function debugEnabled(): boolean {
  return read(ENABLED_KEY) !== 'off';
}
export function setDebugEnabled(on: boolean) {
  write(ENABLED_KEY, on ? 'on' : 'off');
  if (on) installDebug();
  emit();
}
export function hudVisible(): boolean {
  return read(HUD_KEY) === 'on';
}
export function setHudVisible(on: boolean) {
  write(HUD_KEY, on ? 'on' : 'off');
  emit();
}

function emit() {
  stats = { ...stats, queued: buffer.length };
  listeners.forEach((listener) => listener());
}

/** Record one event. Cheap no-op when diagnostics are off. */
export function dlog(type: string, data: Record<string, unknown> = {}) {
  if (!debugEnabled()) return;
  buffer.push({ t: Date.now(), p: Math.round(performance.now()), type, ...data });
  if (buffer.length > MAX_BUFFER) buffer = buffer.slice(-MAX_BUFFER);
  if (type === 'seg_load' && typeof data.total_ms === 'number') {
    const loads = stats.loads + 1;
    stats = {
      ...stats,
      loads,
      lastLoadMs: data.total_ms,
      avgLoadMs: Math.round(((stats.avgLoadMs ?? 0) * stats.loads + data.total_ms) / loads),
    };
  }
  if (type === 'start' && data.ready === false && data.autoplay)
    stats = { ...stats, misses: stats.misses + 1 };
  if (type === 'waiting') stats = { ...stats, stalls: stats.stalls + 1 };
  if (type === 'error' || type === 'fail' || type === 'rejection')
    stats = { ...stats, errors: stats.errors + 1 };
  emit();
}

function device() {
  const nav = navigator as Navigator & {
    connection?: { effectiveType?: string; rtt?: number; downlink?: number; saveData?: boolean };
    deviceMemory?: number;
  };
  return {
    ua: nav.userAgent,
    viewport: `${window.innerWidth}x${window.innerHeight}@${window.devicePixelRatio}`,
    cores: nav.hardwareConcurrency,
    memory_gb: nav.deviceMemory,
    net: nav.connection
      ? {
          type: nav.connection.effectiveType,
          rtt: nav.connection.rtt,
          downlink: nav.connection.downlink,
          save_data: nav.connection.saveData,
        }
      : null,
    standalone: window.matchMedia?.('(display-mode: standalone)').matches ?? false,
    secure: window.isSecureContext,
    origin: window.location.origin,
  };
}

async function flush(keepalive = false) {
  if (!buffer.length || !debugEnabled()) return;
  const events = buffer;
  buffer = [];
  const body = JSON.stringify({ session, device: deviceSent ? null : device(), events });
  try {
    // apiFetch adds the PIN / session / CSRF headers the LAN gate expects.
    const res = await apiFetch('/reader/debug/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: keepalive && body.length < 60_000,
    });
    if (!res.ok) throw new Error(String(res.status));
    deviceSent = true;
    stats = { ...stats, sent: stats.sent + events.length };
  } catch {
    // PC unreachable: keep the newest events for the next attempt.
    buffer = [...events, ...buffer].slice(-MAX_BUFFER);
  }
  emit();
}

/** Mark "something felt wrong right now" so the log can be read around it. */
export function markProblem(note = '') {
  dlog('user_marker', { note: note.slice(0, 500) });
  void flush();
}

function startFrameSampler() {
  // Frame gaps over 50 ms are visible stutter; report the worst per 10 s window.
  let last = performance.now();
  let frames = 0;
  let worst = 0;
  let windowStart = last;
  const tick = (now: number) => {
    const gap = now - last;
    last = now;
    if (document.visibilityState === 'visible') {
      frames += 1;
      worst = Math.max(worst, gap);
    }
    if (now - windowStart >= 10_000) {
      const fps = Math.round((frames * 1000) / (now - windowStart));
      stats = { ...stats, fps, worstFrameMs: Math.round(worst) };
      if (worst > 50) dlog('jank', { worst_ms: Math.round(worst), fps });
      else emit();
      frames = 0;
      worst = 0;
      windowStart = now;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** Install global capture once (errors, long tasks, load timing, flushing). */
export function installDebug() {
  if (installed || typeof window === 'undefined' || !debugEnabled()) return;
  installed = true;
  window.addEventListener('error', (event) =>
    dlog('error', {
      message: String(event.message).slice(0, 300),
      source: event.filename,
      line: event.lineno,
    }),
  );
  window.addEventListener('unhandledrejection', (event) =>
    dlog('rejection', {
      reason: String((event.reason as Error)?.message ?? event.reason).slice(0, 300),
    }),
  );
  const originalError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    dlog('console_error', { message: args.map(String).join(' ').slice(0, 300) });
    originalError(...args);
  };
  try {
    new PerformanceObserver((list) =>
      list.getEntries().forEach((entry) => dlog('longtask', { ms: Math.round(entry.duration) })),
    ).observe({ type: 'longtask', buffered: true });
  } catch {
    // Safari has no long-task timing; frame gaps still cover stutter.
  }
  const reportLoad = () => {
    const nav = performance.getEntriesByType('navigation')[0] as
      | PerformanceNavigationTiming
      | undefined;
    const transferred = performance
      .getEntriesByType('resource')
      .reduce((sum, entry) => sum + ((entry as PerformanceResourceTiming).transferSize || 0), 0);
    dlog('page_load', {
      ttfb_ms: nav ? Math.round(nav.responseStart) : null,
      dom_ready_ms: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
      load_ms: nav ? Math.round(nav.loadEventEnd) : null,
      transferred_kb: Math.round(transferred / 1024),
      resources: performance.getEntriesByType('resource').length,
    });
  };
  if (document.readyState === 'complete') setTimeout(reportLoad, 0);
  else window.addEventListener('load', () => setTimeout(reportLoad, 0), { once: true });
  startFrameSampler();
  timer ??= setInterval(() => void flush(), FLUSH_MS);
  document.addEventListener('visibilitychange', () => {
    dlog('visibility', { state: document.visibilityState });
    if (document.visibilityState === 'hidden') void flush(true);
  });
  window.addEventListener('pagehide', () => void flush(true));
}

export function useDebugStats(): DebugStats {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    () => stats,
    () => stats,
  );
}

export function useDebugFlags(): { enabled: boolean; hud: boolean } {
  useDebugStats();
  return { enabled: debugEnabled(), hud: hudVisible() };
}
