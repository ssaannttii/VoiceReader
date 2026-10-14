import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { coverGradient } from './reader-text';

/** A curved shelf of generated covers, fading out at the edges (no artwork assets). */
export function CoverWall() {
  const tiles = Array.from({ length: 15 }, (_, index) => index);
  return (
    <div className="rd-wall" aria-hidden="true">
      {tiles.map((index) => {
        const column = index % 5;
        const row = Math.floor(index / 5);
        return (
          <span
            key={index}
            className="rd-wall-tile"
            data-square={(index * 7) % 3 === 0 || undefined}
            style={
              {
                '--col': column - 2,
                '--row': row,
                '--tilt': `${((index * 37) % 9) - 4}deg`,
                background: coverGradient(`wall-${index * 13}`),
              } as CSSProperties
            }
          />
        );
      })}
    </div>
  );
}

/** Two tilted cards with placeholder lines: the art for quiet, empty tabs. */
export function StackedCards({ icon: Icon }: { icon?: LucideIcon }) {
  return (
    <div className="rd-cards" aria-hidden="true">
      <span className="rd-cards-card" data-back="">
        <i />
        <i />
      </span>
      <span className="rd-cards-card">
        {Icon ? <Icon className="rd-cards-icon" /> : null}
        <i />
        <i />
        <i />
      </span>
    </div>
  );
}

/** One layout for every empty, error and no-results state. */
export function EmptyState({
  art,
  title,
  body,
  primary,
  secondary,
  tertiary,
  role,
  compact = false,
}: {
  art: ReactNode;
  title: ReactNode;
  body?: ReactNode;
  primary?: { label: string; icon?: LucideIcon; onClick: () => void };
  secondary?: { label: string; icon?: LucideIcon; onClick: () => void };
  tertiary?: { label: string; icon?: LucideIcon; onClick: () => void };
  role?: 'alert' | 'status';
  compact?: boolean;
}) {
  return (
    <div className="rd-empty" data-compact={compact || undefined} role={role}>
      {art}
      <p className="rd-empty-title">{title}</p>
      {body && <p className="rd-empty-body">{body}</p>}
      {(primary || secondary || tertiary) && (
        <div className="rd-empty-actions">
          {primary && <PillButton {...primary} tone="primary" />}
          {secondary && <PillButton {...secondary} tone="secondary" />}
          {tertiary && <PillButton {...tertiary} tone="secondary" />}
        </div>
      )}
    </div>
  );
}

function PillButton({
  label,
  icon: Icon,
  onClick,
  tone,
}: {
  label: string;
  icon?: LucideIcon;
  onClick: () => void;
  tone: 'primary' | 'secondary';
}) {
  return (
    <button type="button" className={cn('rd-pill-btn rd-press')} data-tone={tone} onClick={onClick}>
      {Icon && <Icon className="size-[18px]" aria-hidden="true" />}
      {label}
    </button>
  );
}

/** Rows shaped like the real list, with a staggered shimmer; waits 250ms to avoid a flash. */
export function LibrarySkeleton({ label }: { label: string }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShown(true), 250);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div className="rd-skel-list" role="status" aria-label={label} data-shown={shown || undefined}>
      {[0, 1, 2, 3, 4].map((index) => (
        <div
          key={index}
          className="rd-skel-row"
          style={{ '--i': index } as CSSProperties}
          aria-hidden="true"
        >
          <span className="rd-skel" data-shape={index % 3 === 1 ? 'square' : 'book'} />
          <span className="rd-skel-lines">
            <span className="rd-skel" style={{ width: '72%' }} />
            <span className="rd-skel" style={{ width: '45%' }} />
            <span className="rd-skel" style={{ width: '30%' }} />
          </span>
        </div>
      ))}
    </div>
  );
}
