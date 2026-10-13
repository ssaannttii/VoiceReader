import { Toaster } from '@/components/ui/sonner';
import { useAppearanceProps } from './reader-appearance';
import './reader-toaster.css';

const topOffset = 'calc(env(safe-area-inset-top, 0px) + 8px)';

/**
 * The app's single toaster. Off the Reader it keeps the studio setup; on
 * Reader routes toasts drop from the top (clear of the dock and the mini
 * player) as neutral raised cards with inline text actions, painted in the
 * reading surface. One instance either way, so a toast survives navigation.
 */
export function AppToaster({ reader }: { reader: boolean }) {
  const appearance = useAppearanceProps();
  return (
    <div
      className="contents"
      data-rd-surface={reader ? appearance['data-rd-surface'] : undefined}
      style={reader ? appearance.style : undefined}
    >
      {reader ? (
        <Toaster
          position="top-center"
          offset={{ top: topOffset }}
          mobileOffset={{ top: topOffset, left: '12px', right: '12px' }}
          visibleToasts={2}
          duration={4000}
          className="rd-toaster"
          toastOptions={{
            classNames: {
              toast: 'rd-toast',
              title: 'rd-toast-title',
              description: 'rd-toast-desc',
              icon: 'rd-toast-icon',
              actionButton: 'rd-toast-action',
              cancelButton: 'rd-toast-action',
            },
          }}
        />
      ) : (
        <Toaster richColors position="bottom-right" />
      )}
    </div>
  );
}
