import { useRef, useState, type DragEvent, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ClipboardTypeIcon, FileUpIcon, LinkIcon, Loader2Icon, ScanTextIcon } from 'lucide-react';
import { describeError } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import {
  READER_ACCEPTED_FILES,
  readerApi,
  readerKeys,
  type ReaderDocumentSummary,
} from './reader-api';
import { ReaderSheet } from './reader-sheet';
import { ScanPanel } from './scan-panel';

type Mode = 'text' | 'file' | 'url' | 'scan';
type Input =
  | { mode: 'text'; text: string; title: string }
  | { mode: 'file'; file: File }
  | { mode: 'scan'; files: File[]; title: string }
  | {
      mode: 'url';
      url: string;
    };

const modes: { mode: Mode; icon: typeof LinkIcon; label: string }[] = [
  { mode: 'text', icon: ClipboardTypeIcon, label: 'reader.add_text' },
  { mode: 'file', icon: FileUpIcon, label: 'reader.add_file' },
  { mode: 'url', icon: LinkIcon, label: 'reader.add_url' },
  { mode: 'scan', icon: ScanTextIcon, label: 'reader.add_scan' },
];

function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  return /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export function AddDocumentSheet({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (doc: ReaderDocumentSummary) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<Mode>('text');
  const [text, setText] = useState('');
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const create = useMutation({
    mutationFn: (input: Input) =>
      input.mode === 'text'
        ? readerApi.createFromText(input.text, input.title)
        : input.mode === 'file'
          ? readerApi.createFromFile(input.file)
          : input.mode === 'scan'
            ? readerApi.createFromScan(input.files, input.title)
            : readerApi.createFromUrl(normalizeUrl(input.url)),
    onSuccess: (doc) => {
      // Background imports (file, scan) show up in the library at once and
      // report progress there; the list polls until they finish.
      if (doc.import_status === 'importing')
        queryClient.setQueryData<ReaderDocumentSummary[]>(readerKeys.documents, (list) =>
          list && !list.some((item) => item.id === doc.id) ? [doc, ...list] : list,
        );
      void queryClient.invalidateQueries({ queryKey: readerKeys.documents });
      setText('');
      setTitle('');
      setUrl('');
      onCreated(doc);
    },
  });
  const pending = create.isPending;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    if (mode === 'text' && text.trim()) create.mutate({ mode, text, title });
    if (mode === 'url' && url.trim()) create.mutate({ mode, url });
  };
  const upload = (file: File | undefined) => {
    if (file && !pending) create.mutate({ mode: 'file', file });
  };
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    upload(event.dataTransfer.files[0]);
  };
  const canSubmit = mode === 'text' ? Boolean(text.trim()) : Boolean(url.trim());
  return (
    <ReaderSheet
      open={open}
      onOpenChange={(next) => {
        if (!next) create.reset();
        onOpenChange(next);
      }}
      title={t('reader.add_title')}
      keyboard
    >
      <div
        className="mb-4 grid grid-cols-4 gap-1 rounded-full bg-foreground/[0.06] p-1"
        role="group"
        aria-label={t('reader.add_title')}
      >
        {modes.map(({ mode: value, icon: Icon, label }) => (
          <button
            key={value}
            type="button"
            aria-pressed={mode === value}
            onClick={() => {
              setMode(value);
              create.reset();
            }}
            className={cn(
              'rd-press flex min-h-11 flex-col items-center justify-center gap-0.5 rounded-full px-1.5 text-xs font-medium text-muted-foreground min-[420px]:flex-row min-[420px]:gap-1.5 min-[420px]:text-sm',
              mode === value && 'bg-background text-foreground shadow-sm ring-1 ring-border/70',
            )}
          >
            <Icon className="size-4 shrink-0" aria-hidden="true" />
            <span className="max-w-full truncate">{t(label)}</span>
          </button>
        ))}
      </div>

      {mode === 'scan' ? (
        <ScanPanel
          pending={pending}
          onSubmit={(files, scanTitle) =>
            create.mutateAsync({ mode: 'scan', files, title: scanTitle })
          }
        />
      ) : mode === 'file' ? (
        <div>
          <input
            ref={fileInput}
            type="file"
            accept={READER_ACCEPTED_FILES}
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(event) => {
              upload(event.target.files?.[0]);
              event.target.value = '';
            }}
          />
          <button
            type="button"
            disabled={pending}
            onClick={() => fileInput.current?.click()}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={cn(
              'rd-press flex min-h-48 w-full flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-border px-6 py-8 text-center',
              dragging && 'border-primary bg-primary/5',
            )}
          >
            {pending ? (
              <Loader2Icon className="size-8 animate-spin text-muted-foreground" />
            ) : (
              <FileUpIcon className="size-8 text-muted-foreground" aria-hidden="true" />
            )}
            <span className="text-base font-semibold">
              {t(pending ? 'reader.importing' : 'reader.choose_file')}
            </span>
            <span className="text-sm text-muted-foreground">{t('reader.file_types')}</span>
          </button>
        </div>
      ) : (
        <form className="space-y-3" onSubmit={submit}>
          {mode === 'text' ? (
            <>
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
              <label className="block">
                <span className="sr-only">{t('reader.paste_placeholder')}</span>
                <textarea
                  className="rd-input min-h-[34dvh] resize-none leading-relaxed"
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  placeholder={t('reader.paste_placeholder')}
                  disabled={pending}
                />
              </label>
            </>
          ) : (
            <label className="block">
              <span className="sr-only">{t('reader.url_placeholder')}</span>
              <input
                className="rd-input"
                type="url"
                inputMode="url"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="go"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder={t('reader.url_placeholder')}
                disabled={pending}
              />
            </label>
          )}
          <button
            type="submit"
            disabled={!canSubmit || pending}
            className="rd-press flex h-12 w-full items-center justify-center gap-2 rounded-full bg-foreground text-[15px] font-semibold text-background disabled:opacity-40"
          >
            {pending && <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />}
            {t(pending ? 'reader.importing' : 'reader.add_to_library')}
          </button>
        </form>
      )}
      {create.isError && (
        <p
          className="mt-3 rounded-xl bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
          role="alert"
        >
          {t('reader.import_failed')} {describeError(create.error)}
        </p>
      )}
    </ReaderSheet>
  );
}
