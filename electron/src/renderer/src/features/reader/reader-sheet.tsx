import { Drawer } from '@base-ui/react/drawer';
import type { ComponentProps, ReactNode } from 'react';
import { CheckIcon, ChevronRightIcon, XIcon, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAppearanceProps } from './reader-appearance';

/** Swipe-to-dismiss bottom sheet: the Reader's replacement for menus and dialogs. */
export function ReaderSheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  keyboard = false,
  className,
  headerStart,
  closeLabel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  /** Track the software keyboard for sheets with text fields. */
  keyboard?: boolean;
  className?: string;
  /** Control before the title (a back button in multi-step sheets). */
  headerStart?: ReactNode;
  /** Shows a 44px close button with this accessible name. */
  closeLabel?: string;
}) {
  // Sheets are portaled out of `.rd-root`, so they carry the Reader appearance themselves.
  const appearance = useAppearanceProps();
  const heading = (
    <>
      <Drawer.Title className="text-base font-semibold tracking-tight">{title}</Drawer.Title>
      {description && (
        <Drawer.Description className="mt-0.5 text-sm text-muted-foreground">
          {description}
        </Drawer.Description>
      )}
    </>
  );
  const popup = (
    <Drawer.Portal>
      <Drawer.Backdrop className="rd-sheet-backdrop" />
      <Drawer.Viewport className="rd-sheet-viewport">
        <Drawer.Popup className={cn('rd-sheet', className)} {...appearance}>
          <div className="rd-sheet-handle" aria-hidden="true" />
          {headerStart || closeLabel ? (
            <div className="flex items-center gap-1 pb-2 pl-2 pr-2">
              {headerStart ?? <span className="w-3 shrink-0" />}
              <div className="min-w-0 flex-1 py-1">{heading}</div>
              {closeLabel && (
                <Drawer.Close className="rd-icon-btn text-muted-foreground" aria-label={closeLabel}>
                  <XIcon className="size-5" aria-hidden="true" />
                </Drawer.Close>
              )}
            </div>
          ) : (
            <div className="px-5 pb-2 pt-1">{heading}</div>
          )}
          <Drawer.Content className="rd-sheet-body">{children}</Drawer.Content>
        </Drawer.Popup>
      </Drawer.Viewport>
    </Drawer.Portal>
  );
  return (
    <Drawer.Root open={open} onOpenChange={(next) => onOpenChange(next)}>
      {keyboard ? <Drawer.VirtualKeyboardProvider>{popup}</Drawer.VirtualKeyboardProvider> : popup}
    </Drawer.Root>
  );
}

/** Full-width 52px sheet row with an icon, label, optional detail and trailing state. */
export function SheetRow({
  icon: Icon,
  leading,
  label,
  detail,
  trailing,
  checked,
  chevron,
  destructive,
  className,
  ...props
}: Omit<ComponentProps<'button'>, 'children'> & {
  icon?: LucideIcon;
  /** Shown instead of the icon (an avatar, a state glyph). */
  leading?: ReactNode;
  label: ReactNode;
  detail?: ReactNode;
  trailing?: ReactNode;
  checked?: boolean;
  chevron?: boolean;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      aria-current={checked ? 'true' : undefined}
      className={cn('rd-sheet-row', destructive && 'text-destructive', className)}
      {...props}
    >
      {leading}
      {Icon && !leading && (
        <Icon
          className={cn('size-5 shrink-0', destructive ? '' : 'text-muted-foreground')}
          aria-hidden="true"
        />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{label}</span>
        {detail && (
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">{detail}</span>
        )}
      </span>
      {trailing}
      {checked && <CheckIcon className="size-5 shrink-0 text-primary" aria-hidden="true" />}
      {chevron && (
        <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      )}
    </button>
  );
}
