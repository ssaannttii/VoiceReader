import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { CoverTile } from './cover-tile';
import {
  approach,
  flowSpeed,
  noise1,
  orbOutline,
  pulseEnvelope,
  settled,
  targetEnergy,
  wordSeconds,
  wordStrength,
  wordsPerSecond,
} from './orb-math';
import type { ReaderDocument } from './reader-api';
import { readerPlayer, useReaderPlayer } from './reader-player';
import { chapterIndexAt, coverGradient } from './reader-text';
import { useCoverUrl } from './use-reader-data';

/** Outline calm while paused (a still, round orb). */
const REST_CALM = 0.15;
const POINTS = 96;

/**
 * Canvas orb that moves with the reading: pulses on word boundaries (from the
 * highlight channel) with gentle noise, settles when paused, draws nothing
 * while the page is hidden, and stays still with reduced motion.
 */
function OrbCanvas({ playing }: { playing: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const playingRef = useRef(playing);
  const wakeRef = useRef<() => void>(() => {});

  useEffect(() => {
    playingRef.current = playing;
    wakeRef.current();
  }, [playing]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    const reduced =
      typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)')
        : null;
    let raf = 0;
    let last = performance.now();
    let phase = 0;
    let time = 0;
    let energy = 0;
    let calm = playingRef.current ? 1 : REST_CALM;
    let pulseAt = -1;
    let pulseSeconds = 0.3;
    let strength = 0;
    let speed = 1;
    let frames = 0;
    let accent = '#888';
    // The canvas carries `color: var(--rd-accent)`: its computed colour follows the appearance.
    const readColors = () => {
      accent = getComputedStyle(canvas).color || accent;
    };

    const draw = () => {
      const width = canvas.width;
      const height = canvas.height;
      context.clearRect(0, 0, width, height);
      const size = Math.min(width, height);
      const cx = width / 2;
      const cy = height / 2;
      const still = reduced?.matches ?? false;
      const base = size * 0.3 * (still && playingRef.current ? 1.04 : 1);
      const drift = still ? 0 : 0.02 * noise1(time * 0.35, 3) * calm;
      const outline = (scale: number) => {
        context.beginPath();
        for (let index = 0; index <= POINTS; index++) {
          const angle = (index / POINTS) * Math.PI * 2;
          const shape = still ? 1 : orbOutline(angle, phase * (scale > 1 ? 0.8 : 1), energy, calm);
          const radius = base * scale * shape * (1 + drift);
          const x = cx + Math.cos(angle) * radius;
          const y = cy + Math.sin(angle) * radius;
          if (index === 0) context.moveTo(x, y);
          else context.lineTo(x, y);
        }
        context.closePath();
      };
      context.fillStyle = accent;
      // Halo: a faint outer layer that breathes with the speech.
      context.globalAlpha = 0.14 + energy * 0.08;
      outline(1.16 + energy * 0.08);
      context.fill();
      // Body with a soft glow.
      context.save();
      context.globalAlpha = 0.95;
      context.shadowColor = accent;
      context.shadowBlur = size * (0.06 + energy * 0.08);
      outline(1);
      context.fill();
      context.restore();
      // Sheen drifting inside the body gives it depth (white fades on any appearance).
      const sx = cx - base * (0.3 + 0.06 * noise1(time * 0.2, 7));
      const sy = cy - base * (0.34 + 0.06 * noise1(time * 0.2, 11));
      const sheen = context.createRadialGradient(sx, sy, 0, sx, sy, base * 1.1);
      sheen.addColorStop(0, 'rgba(255,255,255,0.42)');
      sheen.addColorStop(1, 'rgba(255,255,255,0)');
      context.globalAlpha = 1;
      context.fillStyle = sheen;
      outline(1);
      context.fill();
    };

    const frame = (now: number) => {
      raf = 0;
      const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
      last = now;
      const isPlaying = playingRef.current;
      const pulse = pulseAt < 0 ? 0 : pulseEnvelope((now - pulseAt) / 1000, pulseSeconds);
      energy = approach(energy, targetEnergy(isPlaying, pulse, strength), dt, 0.09);
      calm = approach(calm, isPlaying ? 1 : REST_CALM, dt, 0.8);
      phase += dt * (isPlaying ? speed : 0.3) * 1.2;
      time += dt;
      if (++frames % 120 === 0) readColors();
      draw();
      // Stop when hidden (no wasted frames in the background) or once settled.
      if (document.hidden || settled(isPlaying, energy, calm, REST_CALM)) return;
      raf = requestAnimationFrame(frame);
    };

    const wake = () => {
      if (reduced?.matches) {
        draw();
        return;
      }
      if (raf || document.hidden) return;
      last = performance.now();
      raf = requestAnimationFrame(frame);
    };
    wakeRef.current = wake;

    const resize = () => {
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(rect.width * ratio));
      canvas.height = Math.max(1, Math.round(rect.height * ratio));
      readColors();
      draw();
    };
    resize();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
    observer?.observe(canvas);

    const unsubscribe = readerPlayer.subscribeHighlight((segment, word) => {
      if (word < 0) return;
      const words = readerPlayer.wordsFor(segment);
      const current = words?.[word];
      if (!words || !current) return;
      const { rate } = readerPlayer.getState();
      pulseAt = performance.now();
      pulseSeconds = wordSeconds(current, rate);
      strength = wordStrength(current);
      speed = flowSpeed(wordsPerSecond(words, rate));
      wake();
    });
    const onVisibility = () => {
      if (document.hidden) {
        cancelAnimationFrame(raf);
        raf = 0;
      } else wake();
    };
    document.addEventListener('visibilitychange', onVisibility);
    reduced?.addEventListener?.('change', wake);
    wake();
    return () => {
      cancelAnimationFrame(raf);
      raf = 0;
      wakeRef.current = () => {};
      unsubscribe();
      observer?.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      reduced?.removeEventListener?.('change', wake);
    };
  }, []);

  return <canvas ref={canvasRef} className="rd-orb-canvas" aria-hidden="true" />;
}

/** Audio-only mode: the text gives way to the cover, title, chapter and the orb. */
export function AudioOnlyView({
  doc,
  active,
  onActivate,
}: {
  doc: ReaderDocument;
  active: boolean;
  onActivate: () => void;
}) {
  const { t } = useTranslation();
  const player = useReaderPlayer();
  const playing = active && (player.status === 'playing' || player.status === 'buffering');
  const segment = active ? player.segment : doc.position_segment;
  const chapter = doc.chapters[chapterIndexAt(doc.chapters, segment)]?.title;
  const meta = chapter || doc.author || doc.source_name;
  const coverUrl = useCoverUrl(doc.id, doc.has_cover);
  return (
    <div className="rd-audio-only" data-slot="reader-audio-only">
      {/* A soft, slowly drifting wash of the cover behind everything. */}
      <div
        className="rd-audio-backdrop"
        style={{
          backgroundImage: coverUrl ? `url("${coverUrl}")` : coverGradient(doc.id + doc.title),
        }}
        aria-hidden="true"
      />
      <div className="relative flex min-w-0 flex-col items-center gap-4 text-center">
        <CoverTile
          id={doc.id}
          title={doc.title}
          hasCover={doc.has_cover}
          size="lg"
          className="aspect-[3/4] h-[clamp(8.75rem,24dvh,15rem)] w-auto rounded-[var(--rd-r-md)] text-6xl shadow-[var(--rd-shadow-float)]"
        />
        <div className="min-w-0 max-w-md">
          <h1 className="line-clamp-2 text-xl font-semibold leading-snug tracking-tight">
            {doc.title}
          </h1>
          {meta && <p className="mt-1 truncate text-sm text-muted-foreground">{meta}</p>}
        </div>
      </div>
      <button
        type="button"
        className="rd-orb relative"
        aria-label={t(playing ? 'reader.pause' : 'reader.play')}
        onClick={() => {
          if (!active) {
            onActivate();
            return;
          }
          readerPlayer.unlockFromGesture();
          readerPlayer.toggle();
        }}
      >
        <OrbCanvas playing={playing} />
      </button>
    </div>
  );
}
