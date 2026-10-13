import { Drawer } from '@base-ui/react/drawer';
import type { ComponentProps, ReactNode } from 'react';
import { CheckIcon, ChevronRightIcon, type LucideIcon } from 'lucide-react';
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
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  /** Track the software keyboard for sheets with text fields. */
  keyboard?: boolean;
  className?: string;
}) {
  // Sheets are portaled out of `.rd-root`, so they carry the Reader appearance themselves.
  const appearance = useAppearanceProps();
  const popup = (
    <Drawer.Portal>
      <Drawer.Backdrop className="rd-sheet-backdrop" />
      <Drawer.Viewport className="rd-sheet-viewport">
        <Drawer.Popup className={cn('rd-sheet', className)} {...appearance}>
          <div className="rd-sheet-handle" aria-hidden="true" />
          <div className="px-5 pb-2 pt-1">
            <Drawer.Title className="text-base font-semibold tracking-tight">{title}</Drawer.Title>
            {description && (
              <Drawer.Description className="mt-0.5 text-sm text-muted-foreground">
                {description}
              </Drawer.Description>
            )}
          </div>
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
      {Icon && (
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
