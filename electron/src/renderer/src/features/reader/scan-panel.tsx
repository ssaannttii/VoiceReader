import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CameraIcon,
  ImagesIcon,
  Loader2Icon,
  ScanTextIcon,
  XIcon,
} from 'lucide-react';
import { createObjectUrl, revokeObjectUrl } from '@/lib/audio/object-url';
import { addPages, MAX_SCAN_PAGES, moveItem } from './scan-pages';

interface Page {
  id: number;
  file: File;
  url: string | null;
}

let nextId = 0;

/**
 * "Scan pages": photos from the camera or the gallery, in reading order,
 * sent to the PC for OCR as one document (POST /reader/documents/scan).
 */
export function ScanPanel({
  pending,
  onSubmit,
}: {
  pending: boolean;
  onSubmit: (files: File[], title: string) => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const camera = useRef<HTMLInputElement>(null);
  const gallery = useRef<HTMLInputElement>(null);
  const [pages, setPages] = useState<Page[]>([]);
  const [title, setTitle] = useState('');
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  useEffect(() => () => pagesRef.current.forEach((page) => revokeObjectUrl(page.url)), []);

  const add = (list: FileList | null) => {
    const images = Array.from(list ?? []).filter(
      (file) => !file.type || file.type.startsWith('image/'),
    );
    if (!images.length) return;
    const added = images.map((file) => ({ id: nextId++, file, url: createObjectUrl(file) }));
    const { pages: next, dropped } = addPages(pagesRef.current, added);
    added.slice(added.length - dropped).forEach((page) => revokeObjectUrl(page.url));
    setPages(next);
    if (dropped) toast.warning(t('reader.scan_limit', { max: MAX_SCAN_PAGES }));
  };
  const remove = (id: number) => {
    const page = pages.find((item) => item.id === id);
    revokeObjectUrl(page?.url);
    setPages(pages.filter((item) => item.id !== id));
  };
  const move = (from: number, to: number) => setPages(moveItem(pages, from, to));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!pages.length || pending) return;
    const sent = pages;
    onSubmit(
      sent.map((page) => page.file),
      title,
    )
      .then(() => {
        sent.forEach((page) => revokeObjectUrl(page.url));
        setPages([]);
        setTitle('');
      })
      .catch(() => {
        /* The sheet shows the error; the pages stay for another try. */
      });
  };

  const picker = (input: HTMLInputElement | null) => input?.click();
  return (
    <form className="space-y-3" onSubmit={submit}>
      <input
        ref={camera}
        type="file"
        accept="image/*"
        capture="environment"
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          add(event.target.files);
          event.target.value = '';
        }}
      />
      <input
        ref={gallery}
        type="file"
        accept="image/*"
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          add(event.target.files);
          event.target.value = '';
        }}
      />
      <div className="grid grid-cols-2 gap-2">
        {(
          [
            [camera, CameraIcon, 'reader.scan_camera'],
            [gallery, ImagesIcon, 'reader.scan_choose'],
          ] as const
        ).map(([ref, Icon, label]) => (
          <button
            key={label}
            type="button"
            disabled={pending || pages.length >= MAX_SCAN_PAGES}
            onClick={() => picker(ref.current)}
            className="rd-press flex min-h-24 flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-border px-3 py-4 text-center text-sm font-semibold disabled:opacity-40"
          >
            <Icon className="size-6 text-muted-foreground" aria-hidden="true" />
            {t(label)}
          </button>
        ))}
      </div>

      {pages.length === 0 ? (
        <p className="flex items-start gap-2 px-1 text-sm leading-relaxed text-muted-foreground">
          <ScanTextIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {t('reader.scan_hint')}
        </p>
      ) : (
        <ol className="max-h-[38dvh] space-y-1 overflow-y-auto" aria-label={t('reader.scan_pages')}>
          {pages.map((page, index) => {
            const n = index + 1;
            return (
              <li
                key={page.id}
                className="flex items-center gap-1 rounded-2xl bg-foreground/[0.04] py-1 pl-1.5"
              >
                {page.url ? (
                  <img
                    src={page.url}
                    alt=""
                    className="h-14 w-11 shrink-0 rounded-lg object-cover ring-1 ring-border/70"
                  />
                ) : (
                  <span className="h-14 w-11 shrink-0 rounded-lg bg-foreground/[0.08]" />
                )}
                <span className="min-w-0 flex-1 px-1.5">
                  <span className="block text-sm font-semibold">
                    {t('reader.scan_page', { n })}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {page.file.name}
                  </span>
                </span>
                <button
                  type="button"
                  className="rd-icon-btn shrink-0 text-muted-foreground"
                  aria-label={t('reader.scan_move_up', { n })}
                  disabled={pending || index === 0}
                  onClick={() => move(index, index - 1)}
                >
                  <ArrowUpIcon className="size-4" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="rd-icon-btn shrink-0 text-muted-foreground"
                  aria-label={t('reader.scan_move_down', { n })}
                  disabled={pending || index === pages.length - 1}
                  onClick={() => move(index, index + 1)}
                >
                  <ArrowDownIcon className="size-4" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="rd-icon-btn shrink-0 text-muted-foreground"
                  aria-label={t('reader.scan_remove', { n })}
                  disabled={pending}
                  onClick={() => remove(page.id)}
                >
                  <XIcon className="size-4" aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ol>
      )}

      <label className="block">
        <span className="sr-only">{t('reader.title_optional')}</span>
        <input
          className="rd-input"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder={t('reader.title_optional')}
          maxLength={200}
          disabled={pending}
        />
      </label>
      <button
        type="submit"
        disabled={!pages.length || pending}
        className="rd-press flex h-12 w-full items-center justify-center gap-2 rounded-full bg-foreground text-[15px] font-semibold text-background disabled:opacity-40"
      >
        {pending && <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />}
        {t(pending ? 'reader.importing' : 'reader.scan_submit')}
      </button>
    </form>
  );
}
