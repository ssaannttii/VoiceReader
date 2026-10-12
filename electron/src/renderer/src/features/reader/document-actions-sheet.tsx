import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  CircleStopIcon,
  CloudDownloadIcon,
  Loader2Icon,
  PencilIcon,
  Trash2Icon,
} from 'lucide-react';
import { describeError } from '@/lib/api/client';
import {
  cancelOfflineDownload,
  formatBytes,
  removeOfflineDownload,
  useOffline,
} from './offline-state';
import { deleteDocument, downloadDocument, renameDocument } from './reader-actions';
import type { ReaderDocumentSummary } from './reader-api';
import { ReaderSheet, SheetRow } from './reader-sheet';

/** Offline download row shared by the library actions and the reader options. */
export function OfflineRow({ id }: { id: string }) {
  const { t } = useTranslation();
  const offline = useOffline();
  const active = offline.active[id];
  const saved = offline.downloaded[id];
  if (active) {
    const percent = active.total ? Math.round((active.stored / active.total) * 100) : 0;
    return (
      <SheetRow
        icon={CircleStopIcon}
        label={t('reader.cancel_download')}
        detail={t('reader.downloading', { percent })}
        trailing={<Loader2Icon className="size-4 animate-spin text-muted-foreground" />}
        onClick={() => cancelOfflineDownload(id)}
      />
    );
  }
  if (saved?.complete)
    return (
      <SheetRow
        icon={Trash2Icon}
        label={t('reader.remove_download')}
        detail={t('reader.downloaded_size', { size: formatBytes(saved.bytes) })}
        onClick={() => void removeOfflineDownload(id)}
      />
    );
  return (
    <SheetRow
      icon={CloudDownloadIcon}
      label={t(saved ? 'reader.resume_download' : 'reader.download')}
      detail={t('reader.download_hint')}
      onClick={() =>
        void downloadDocument(id).catch((error: unknown) =>
          toast.error(t('reader.download_failed'), { description: describeError(error) }),
        )
      }
    />
  );
}

export function DocumentActionsSheet({
  doc,
  onClose,
}: {
  doc: ReaderDocumentSummary | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [view, setView] = useState<'menu' | 'rename' | 'delete'>('menu');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState(doc);
  useEffect(() => {
    if (!doc) return;
    setShown(doc);
    setView('menu');
    setTitle(doc.title);
    setBusy(false);
  }, [doc]);
  if (!shown) return null;
  const rename = async (event: FormEvent) => {
    event.preventDefault();
    const next = title.trim();
    if (!next || busy) return;
    setBusy(true);
    try {
      await renameDocument(shown.id, next);
      onClose();
    } catch (error) {
      toast.error(describeError(error));
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      await deleteDocument(shown.id);
      onClose();
    } catch (error) {
      toast.error(describeError(error));
      setBusy(false);
    }
  };
  return (
    <ReaderSheet
      open={doc !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={view === 'delete' ? t('reader.delete_title') : shown.title}
      keyboard={view === 'rename'}
    >
      {view === 'menu' && (
        <div className="space-y-0.5 pb-1">
          <SheetRow
            icon={PencilIcon}
            label={t('reader.rename')}
            onClick={() => setView('rename')}
          />
          <OfflineRow id={shown.id} />
          <SheetRow
            icon={Trash2Icon}
            label={t('reader.delete')}
            destructive
            onClick={() => setView('delete')}
          />
        </div>
      )}
      {view === 'rename' && (
        <form className="space-y-3 pb-1" onSubmit={(event) => void rename(event)}>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-muted-foreground">
              {t('reader.rename')}
            </span>
            <input
              className="rd-input"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={200}
              autoFocus
              enterKeyHint="done"
            />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              className="rd-press h-12 rounded-full bg-foreground/[0.07] font-semibold"
              onClick={() => setView('menu')}
            >
              {t('reader.cancel')}
            </button>
            <button
              type="submit"
              disabled={busy || !title.trim()}
              className="rd-press h-12 rounded-full bg-foreground font-semibold text-background disabled:opacity-40"
            >
              {t('reader.save')}
            </button>
          </div>
        </form>
      )}
      {view === 'delete' && (
        <div className="space-y-4 pb-1">
          <p className="text-[15px] leading-relaxed text-muted-foreground">
            {t('reader.delete_body', { title: shown.title })}
          </p>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              className="rd-press h-12 rounded-full bg-foreground/[0.07] font-semibold"
              onClick={() => setView('menu')}
            >
              {t('reader.cancel')}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void remove()}
              className="rd-press flex h-12 items-center justify-center gap-2 rounded-full bg-destructive font-semibold text-white disabled:opacity-50"
            >
              {busy && <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />}
              {t('reader.delete')}
            </button>
          </div>
        </div>
      )}
    </ReaderSheet>
  );
}
