import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import QRCode from 'qrcode';
import { readerApi, readerKeys } from './reader-api';
import { ReaderSheet } from './reader-sheet';

/** Phone link for the Reader, as a QR code, from the backend's LAN address. */
export function readerPhoneUrl(lanUrl: string): string | null {
  try {
    const url = new URL(lanUrl);
    url.hash = '/reader';
    return url.toString();
  } catch {
    return null;
  }
}

export function PhoneSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const status = useQuery({
    queryKey: readerKeys.status,
    queryFn: ({ signal }) => readerApi.status(signal),
    enabled: open,
    staleTime: 30_000,
  });
  const phoneUrl = status.data?.lan_url ? readerPhoneUrl(status.data.lan_url) : null;
  const [qr, setQr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setQr(null);
    if (phoneUrl)
      void QRCode.toDataURL(phoneUrl)
        .then((data) => live && setQr(data))
        .catch(() => {});
    return () => {
      live = false;
    };
  }, [phoneUrl]);
  return (
    <ReaderSheet open={open} onOpenChange={onOpenChange} title={t('reader.phone_title')}>
      <div className="flex flex-col items-center gap-4 pb-2 text-center">
        {phoneUrl ? (
          <>
            <p className="text-sm text-muted-foreground">{t('reader.phone_body')}</p>
            <div className="rounded-2xl bg-white p-3 shadow-sm ring-1 ring-border">
              {qr ? (
                <img src={qr} alt="" className="size-48" />
              ) : (
                <div className="rd-skeleton size-48" />
              )}
            </div>
            <code className="max-w-full break-all rounded-lg bg-muted px-3 py-2 text-xs">
              {phoneUrl}
            </code>
          </>
        ) : status.isPending ? (
          <div className="rd-skeleton h-48 w-48" />
        ) : (
          <>
            <p className="text-sm text-muted-foreground">{t('reader.phone_sharing_off')}</p>
            <Link
              to="/settings/sharing"
              className="rd-press inline-flex h-11 items-center rounded-full bg-foreground px-5 text-sm font-semibold text-background"
            >
              {t('reader.open_sharing')}
            </Link>
          </>
        )}
      </div>
    </ReaderSheet>
  );
}
