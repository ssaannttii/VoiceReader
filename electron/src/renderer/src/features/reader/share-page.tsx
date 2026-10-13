import { useEffect, useRef } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Loader2Icon } from 'lucide-react';
import { describeError } from '@/lib/api/client';
import { readerApi, readerKeys, type ReaderDocumentSummary } from './reader-api';
import { useAppearanceProps } from './reader-appearance';
import { parseShareSearch, shareRequest } from './reader-share';
import './reader.css';

/**
 * `#/reader/share`: where Android's share sheet lands (via the service
 * worker). Links and text become documents here; files were already
 * uploaded by the service worker and only need a notice.
 */
export function ReaderSharePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const appearance = useAppearanceProps();
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    // Raw query (the router's parser would turn "2024" or "true" into non-strings).
    const query = new URLSearchParams(window.location.hash.split('?')[1] ?? '');
    const request = shareRequest(parseShareSearch(Object.fromEntries(query)));
    const toLibrary = () => void navigate({ to: '/reader', replace: true });
    if (!request) {
      toast.error(t('reader.share_empty'));
      toLibrary();
      return;
    }
    if (request.kind === 'files') {
      void queryClient.invalidateQueries({ queryKey: readerKeys.documents });
      if (request.files > 0) toast(t('reader.share_files_started', { files: request.files }));
      if (request.failed > 0)
        toast.error(t('reader.share_files_failed', { files: request.failed }), {
          description: request.error,
        });
      toLibrary();
      return;
    }
    const create =
      request.kind === 'url'
        ? readerApi.createFromUrl(request.url)
        : readerApi.createFromText(request.text, request.title);
    create
      .then((doc: ReaderDocumentSummary) => {
        void queryClient.invalidateQueries({ queryKey: readerKeys.documents });
        void navigate({ to: '/reader/$docId', params: { docId: doc.id }, replace: true });
      })
      .catch((error: unknown) => {
        toast.error(t('reader.import_failed'), { description: describeError(error) });
        toLibrary();
      });
  }, []);

  return (
    <div className="rd-root" data-slot="reader-share" {...appearance}>
      <main className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <Loader2Icon className="size-8 animate-spin text-muted-foreground" aria-hidden="true" />
        <p className="text-base font-semibold" role="status">
          {t('reader.share_adding')}
        </p>
      </main>
    </div>
  );
}
