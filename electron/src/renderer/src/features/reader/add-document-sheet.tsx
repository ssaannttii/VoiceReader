import { useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ClipboardPasteIcon,
  FileTextIcon,
  FileUpIcon,
  Link2Icon,
  Loader2Icon,
  PenLineIcon,
  ScanTextIcon,
  TriangleAlertIcon,
  type LucideIcon,
} from 'lucide-react';
import { describeError } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import { clipboardLink, linkHost, linkPreview, normalizeUrl } from './add-link';
import { formatBytes } from './offline-state';
import { isTouchDevice } from './reader-chrome';
import {
  READER_ACCEPTED_FILES,
  readerApi,
  readerKeys,
  type ReaderDocumentSummary,
} from './reader-api';
import { ReaderSheet } from './reader-sheet';
import { ScanPanel } from './scan-panel';

type Step = 'choose' | 'link' | 'file' | 'scan' | 'text';
type Input =
  | { mode: 'text'; text: string; title: string }
  | { mode: 'file'; file: File }
  | { mode: 'scan'; files: File[]; title: string }
  | { mode: 'url'; url: string };

const STEP_TITLES: Record<Exclude<Step, 'choose'>, string> = {
  link: 'reader.lib_add_link',
  file: 'reader.lib_add_file',
  scan: 'reader.lib_add_scan',
  text: 'reader.lib_add_text',
};

/** Clipboard text, only when the browser already allows reading it (no prompt). */
async function readClipboardQuietly(): Promise<string | null> {
  try {
    const status = await navigator.permissions?.query({ name: 'clipboard-read' as PermissionName });
    if (status?.state !== 'granted') return null;
    return await navigator.clipboard.readText();
  } catch {
    return null;
  }
}

/**
 * "Add to Reader": a chooser (paste a link, upload a file, scan pages, write
 * text) where each choice slides to a focused step. File and scan imports run
 * in the background; the sheet closes as soon as the PC accepts them.
 */
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
  const [step, setStep] = useState<Step>('choose');
  const [direction, setDirection] = useState<'forward' | 'back'>('forward');
  const [text, setText] = useState('');
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [urlTouched, setUrlTouched] = useState(false);
  const [clip, setClip] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
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
      setFile(null);
      setUrlTouched(false);
      onCreated(doc);
    },
  });
  const pending = create.isPending;

  // Back to the chooser whenever the sheet opens; offer a copied link if reading it needs no prompt.
  useEffect(() => {
    if (!open) return;
    setStep('choose');
    setClip(null);
    let cancelled = false;
    void readClipboardQuietly().then((value) => {
      if (!cancelled) setClip(clipboardLink(value));
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const go = (next: Step) => {
    create.reset();
    setDirection(next === 'choose' ? 'back' : 'forward');
    setStep(next);
  };
  const upload = (picked: File | undefined) => {
    if (!picked || pending) return;
    setFile(picked);
    create.mutate({ mode: 'file', file: picked });
  };
  const pickFile = () => {
    // Opened inside the tap so the browser allows the picker.
    fileInput.current?.click();
    go('file');
  };
  const openLink = (prefill?: string | null) => {
    if (prefill) setUrl(prefill);
    else if (clip && !url) setUrl(clip);
    go('link');
  };
  const pasteFromClipboard = async () => {
    try {
      const value = clipboardLink(await navigator.clipboard.readText());
      if (value) {
        setUrl(value);
        setUrlTouched(true);
      }
    } catch {
      /* Clipboard access refused; the field stays as it is. */
    }
  };
  const submitLink = (event: FormEvent) => {
    event.preventDefault();
    setUrlTouched(true);
    if (pending || !linkHost(url)) return;
    create.mutate({ mode: 'url', url });
  };
  const submitText = (event: FormEvent) => {
    event.preventDefault();
    if (pending || !text.trim()) return;
    create.mutate({ mode: 'text', text, title });
  };
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    upload(event.dataTransfer.files[0]);
  };
  const urlInvalid = urlTouched && url.trim() !== '' && !linkHost(url);

  return (
    <ReaderSheet
      open={open}
      onOpenChange={(next) => {
        if (!next) create.reset();
        onOpenChange(next);
      }}
      title={step === 'choose' ? t('reader.add_title') : t(STEP_TITLES[step])}
      description={step === 'choose' ? t('reader.lib_add_desc') : undefined}
      closeLabel={t('reader.lib_close')}
      headerStart={
        step === 'choose' ? undefined : (
          <button
            type="button"
            className="rd-icon-btn"
            aria-label={t('reader.lib_back')}
            onClick={() => go('choose')}
          >
            <ChevronLeftIcon className="size-5" aria-hidden="true" />
          </button>
        )
      }
      keyboard
    >
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
      <div key={step} className="rd-step" data-direction={direction}>
        {step === 'choose' && (
          <div className="pb-1">
            {clip && (
              <button
                type="button"
                className="rd-press rd-clip-chip"
                onClick={() => {
                  if (pending) return;
                  setUrl(clip);
                  go('link');
                  create.mutate({ mode: 'url', url: clip });
                }}
              >
                <ClipboardPasteIcon className="size-4 shrink-0" aria-hidden="true" />
                <span className="truncate">
                  {t('reader.lib_paste_clip', { link: linkPreview(clip) })}
                </span>
              </button>
            )}
            <button type="button" className="rd-press rd-add-hero" onClick={() => openLink()}>
              <Link2Icon className="size-6 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="block text-base font-medium">{t('reader.lib_add_link')}</span>
                <span className="block text-sm text-muted-foreground">
                  {t('reader.lib_add_link_hint')}
                </span>
              </span>
              <ChevronRightIcon className="rd-add-chevron" aria-hidden="true" />
            </button>
            <div className="rd-add-rows">
              <ChooserRow
                icon={FileUpIcon}
                label={t('reader.lib_add_file')}
                detail={t('reader.file_types')}
                onClick={pickFile}
              />
              <ChooserRow
                icon={ScanTextIcon}
                label={t('reader.lib_add_scan')}
                detail={t('reader.lib_add_scan_hint')}
                onClick={() => go('scan')}
              />
              <ChooserRow
                icon={PenLineIcon}
                label={t('reader.lib_add_text')}
                onClick={() => go('text')}
              />
            </div>
          </div>
        )}

        {step === 'link' && (
          <form className="space-y-3 pb-1" onSubmit={submitLink} noValidate>
            <div className="flex items-center gap-2">
              <label className="block min-w-0 flex-1">
                <span className="sr-only">{t('reader.url_placeholder')}</span>
                <input
                  className="rd-input"
                  type="url"
                  inputMode="url"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  enterKeyHint="go"
                  autoFocus={!isTouchDevice()}
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  onBlur={() => setUrlTouched(true)}
                  placeholder={t('reader.url_placeholder')}
                  disabled={pending}
                  aria-invalid={urlInvalid || undefined}
                  aria-describedby={urlInvalid ? 'rd-url-error' : undefined}
                />
              </label>
              {typeof navigator.clipboard?.readText === 'function' && (
                <button
                  type="button"
                  className="rd-press rd-soft-btn"
                  disabled={pending}
                  onClick={() => void pasteFromClipboard()}
                >
                  <ClipboardPasteIcon className="size-4" aria-hidden="true" />
                  {t('reader.lib_paste')}
                </button>
              )}
            </div>
            {urlInvalid && (
              <p id="rd-url-error" className="rd-field-error">
                {t('reader.lib_url_invalid')}
              </p>
            )}
            <SubmitButton pending={pending} disabled={!url.trim()} />
          </form>
        )}

        {step === 'file' && (
          <div className="space-y-3 pb-1">
            {file ? (
              <div className="rd-file-card">
                <span className="rd-file-icon">
                  {pending ? (
                    <Loader2Icon className="size-5 animate-spin" aria-hidden="true" />
                  ) : (
                    <FileTextIcon className="size-5" aria-hidden="true" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-base font-medium">{file.name}</span>
                  <span className="block text-sm text-muted-foreground">
                    {pending ? t('reader.lib_file_uploading') : formatBytes(file.size)}
                  </span>
                </span>
              </div>
            ) : null}
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
              className={cn('rd-press rd-drop', dragging && 'rd-drop-active')}
              data-compact={file ? '' : undefined}
            >
              <FileUpIcon className="size-7 text-muted-foreground" aria-hidden="true" />
              <span className="text-base font-medium">
                {t(file ? 'reader.lib_file_change' : 'reader.choose_file')}
              </span>
              {!file && (
                <span className="text-sm text-muted-foreground">
                  {t('reader.file_types')}
                  {!isTouchDevice() && <> · {t('reader.lib_file_drop')}</>}
                </span>
              )}
            </button>
          </div>
        )}

        {step === 'scan' && (
          <ScanPanel
            pending={pending}
            onSubmit={(files, scanTitle) =>
              create.mutateAsync({ mode: 'scan', files, title: scanTitle })
            }
          />
        )}

        {step === 'text' && (
          <form className="space-y-3 pb-1" onSubmit={submitText}>
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
                className="rd-input min-h-[30dvh] resize-none leading-relaxed"
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder={t('reader.paste_placeholder')}
                disabled={pending}
              />
            </label>
            <SubmitButton pending={pending} disabled={!text.trim()} />
          </form>
        )}

        {create.isError && (
          <p className="rd-callout mt-3" role="alert">
            <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>
              {t('reader.import_failed')} {describeError(create.error)}
            </span>
          </p>
        )}
      </div>
    </ReaderSheet>
  );
}

function ChooserRow({
  icon: Icon,
  label,
  detail,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  detail?: string;
  onClick: () => void;
}) {
  return (
    <button type="button" className="rd-add-row" onClick={onClick}>
      <Icon className="size-[22px] shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-base font-medium">{label}</span>
        {detail && <span className="block truncate text-sm text-muted-foreground">{detail}</span>}
      </span>
      <ChevronRightIcon className="rd-add-chevron" aria-hidden="true" />
    </button>
  );
}

function SubmitButton({ pending, disabled }: { pending: boolean; disabled: boolean }) {
  const { t } = useTranslation();
  return (
    <button
      type="submit"
      disabled={disabled || pending}
      className="rd-press rd-pill-btn w-full"
      data-tone="primary"
    >
      {pending && <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />}
      {t(pending ? 'reader.importing' : 'reader.add_to_library')}
    </button>
  );
}
