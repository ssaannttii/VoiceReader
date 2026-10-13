import type { KeyboardEvent, Ref } from 'react';
import { SearchIcon, XIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Rounded search input with a 44px clear button, shared by Reader lists and sheets. */
export function SearchField({
  value,
  onChange,
  label,
  clearLabel,
  className,
  ref,
  onKeyDown,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Placeholder and accessible name. */
  label: string;
  clearLabel: string;
  className?: string;
  ref?: Ref<HTMLInputElement>;
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
}) {
  return (
    <label className={cn('relative block', className)}>
      <span className="sr-only">{label}</span>
      <SearchIcon
        className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden="true"
      />
      <input
        ref={ref}
        type="search"
        className="rd-input rounded-full bg-foreground/[0.05] pl-10 pr-11"
        placeholder={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        enterKeyHint="search"
        autoComplete="off"
      />
      {value && (
        <button
          type="button"
          className="rd-icon-btn absolute right-0.5 top-1/2 -translate-y-1/2 text-muted-foreground"
          aria-label={clearLabel}
          onClick={() => onChange('')}
        >
          <XIcon className="size-4" aria-hidden="true" />
        </button>
      )}
    </label>
  );
}
