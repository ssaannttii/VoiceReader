import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
} from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { confirm, tick } from './haptics';
import { LONG_PRESS_MS, LONG_PRESS_SLOP } from './reader-long-press';
import {
  dragOffset,
  pastFull,
  releaseSwipe,
  swipeIntent,
  type SwipeLayout,
  type SwipeSide,
} from './swipe-math';

export interface SwipeAction {
  key: string;
  label: string;
  icon: LucideIcon;
  tone: 'neutral' | 'accent' | 'positive' | 'danger';
  run: () => void;
}

/** Only one row rests open at a time. */
let closeOpenRow: (() => void) | null = null;

/**
 * A list row that slides on touch to reveal actions. `start` actions sit on
 * the left (drag right), `end` actions on the right (drag left); a full swipe
 * runs the edge-most one. Vertical scrolling stays native (`pan-y`), mouse
 * users get no swipe (the row's menu has every action), and a long press
 * calls `onLongPress` (select mode).
 */
export function SwipeRow({
  start = [],
  end = [],
  disabled = false,
  onLongPress,
  className,
  children,
  ...rest
}: {
  start?: SwipeAction[];
  end?: SwipeAction[];
  disabled?: boolean;
  onLongPress?: () => void;
  className?: string;
  children: ReactNode;
  'aria-selected'?: boolean;
  'aria-describedby'?: string;
}) {
  const root = useRef<HTMLLIElement>(null);
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [full, setFull] = useState(false);
  const gesture = useRef<{
    id: number;
    x: number;
    y: number;
    base: number;
    mode: 'pending' | 'drag' | 'scroll';
    full: boolean;
  } | null>(null);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressClick = useRef(false);
  const offsetRef = useRef(0);
  offsetRef.current = offset;

  const layout = useCallback(
    (): SwipeLayout => ({
      start: start.length,
      end: end.length,
      width: root.current?.clientWidth ?? 360,
    }),
    [start.length, end.length],
  );

  const close = useCallback(() => {
    setOffset(0);
    setFull(false);
    if (closeOpenRow === close) closeOpenRow = null;
  }, []);

  const disarmPress = () => {
    if (pressTimer.current) clearTimeout(pressTimer.current);
    pressTimer.current = null;
  };

  // Tapping anywhere else closes an open row.
  useEffect(() => {
    if (!offset || dragging) return;
    if (closeOpenRow && closeOpenRow !== close) closeOpenRow();
    closeOpenRow = close;
    const onDown = (event: globalThis.PointerEvent) => {
      if (root.current?.contains(event.target as Node)) return;
      close();
      // That tap only closes the row; it should not also open whatever it landed on.
      const swallow = (click: MouseEvent) => {
        click.preventDefault();
        click.stopPropagation();
      };
      document.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => document.removeEventListener('click', swallow, true), 600);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [offset, dragging, close]);

  useEffect(() => () => disarmPress(), []);
  useEffect(() => {
    if (disabled) close();
  }, [disabled, close]);

  const run = (action: SwipeAction) => {
    confirm();
    close();
    action.run();
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' || !event.isPrimary) return;
    suppressClick.current = false;
    gesture.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      base: offsetRef.current,
      mode: 'pending',
      full: false,
    };
    if (onLongPress && !offsetRef.current) {
      disarmPress();
      pressTimer.current = setTimeout(() => {
        pressTimer.current = null;
        if (gesture.current?.mode !== 'pending') return;
        gesture.current = null;
        suppressClick.current = true;
        tick();
        onLongPress();
      }, LONG_PRESS_MS);
    }
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = gesture.current;
    if (!current || current.id !== event.pointerId) return;
    const dx = event.clientX - current.x;
    const dy = event.clientY - current.y;
    if (current.mode === 'pending') {
      if (Math.hypot(dx, dy) > LONG_PRESS_SLOP) disarmPress();
      const intent = disabled || (!start.length && !end.length) ? 'vertical' : swipeIntent(dx, dy);
      if (!intent) return;
      if (intent === 'vertical') {
        current.mode = 'scroll';
        return;
      }
      current.mode = 'drag';
      disarmPress();
      setDragging(true);
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
    if (current.mode !== 'drag') return;
    const next = dragOffset(current.base + dx, layout());
    const isFull = pastFull(next, layout());
    if (isFull !== current.full) {
      current.full = isFull;
      setFull(isFull);
      tick();
    }
    setOffset(next);
  };

  const finish = (event: PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const current = gesture.current;
    disarmPress();
    if (!current || current.id !== event.pointerId) return;
    gesture.current = null;
    if (current.mode !== 'drag') return;
    setDragging(false);
    suppressClick.current = true;
    const release = cancelled
      ? { type: 'close' as const }
      : releaseSwipe(offsetRef.current, layout());
    if (release.type === 'commit') {
      const actions = release.side === 'start' ? start : end;
      const edge = release.side === 'start' ? actions[0] : actions[actions.length - 1];
      if (edge) run(edge);
      else close();
      return;
    }
    setFull(false);
    if (release.type === 'open') setOffset(release.offset);
    else close();
  };

  const side: SwipeSide | null = offset > 0 ? 'start' : offset < 0 ? 'end' : null;
  const revealed = Math.abs(offset);
  return (
    <li
      ref={root}
      className={cn('rd-swipe', className)}
      data-swiping={dragging || undefined}
      aria-selected={rest['aria-selected']}
      aria-describedby={rest['aria-describedby']}
    >
      {(['start', 'end'] as const).map((which) => {
        const actions = which === 'start' ? start : end;
        if (!actions.length || side !== which) return null;
        return (
          <div
            key={which}
            className="rd-swipe-actions"
            data-side={which}
            data-full={full || undefined}
            style={{ width: revealed } as CSSProperties}
          >
            {actions.map((action, index) => {
              const edge = which === 'start' ? index === 0 : index === actions.length - 1;
              const Icon = action.icon;
              return (
                <button
                  key={action.key}
                  type="button"
                  className="rd-swipe-action"
                  data-tone={action.tone}
                  data-edge={edge || undefined}
                  tabIndex={dragging ? -1 : 0}
                  onClick={() => run(action)}
                >
                  <Icon aria-hidden="true" />
                  <span>{action.label}</span>
                </button>
              );
            })}
          </div>
        );
      })}
      <div
        className="rd-swipe-content"
        style={{ transform: offset ? `translate3d(${offset}px,0,0)` : undefined }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(event) => finish(event, false)}
        onPointerCancel={(event) => finish(event, true)}
        onContextMenu={(event) => {
          // A touch long press selects; it should not open the link menu.
          if (onLongPress && (suppressClick.current || pressTimer.current)) event.preventDefault();
        }}
        onClickCapture={(event) => {
          if (suppressClick.current || offsetRef.current) {
            event.preventDefault();
            event.stopPropagation();
            suppressClick.current = false;
            if (offsetRef.current) close();
          }
        }}
      >
        {children}
      </div>
    </li>
  );
}
