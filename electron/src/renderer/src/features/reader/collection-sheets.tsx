import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  EllipsisIcon,
  LibraryBigIcon,
  Loader2Icon,
  MinusIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from 'lucide-react';
import { ApiError, describeError } from '@/lib/api/client';
import {
  createCollection,
  deleteCollection,
  renameCollection,
  toggleInCollection,
  useReaderCollections,
} from './collection-actions';
import { tick } from './haptics';
import {
  cleanCollectionName,
  collectionNameTaken,
  COLLECTION_NAME_MAX,
  membership,
} from './library-collections';
import type { ReaderCollection } from './reader-api';
import { ReaderSheet, SheetRow } from './reader-sheet';

/** Name field with Cancel / Save; refuses empty and duplicate names before asking the PC. */
function CollectionNameForm({
  initial = '',
  exceptId,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial?: string;
  exceptId?: string;
  submitLabel: string;
  /** Resolves when done; a rejection keeps the form open with the error. */
  onSubmit: (name: string) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const { collections } = useReaderCollections();
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clean = cleanCollectionName(name);
  const taken = Boolean(clean) && collectionNameTaken(collections, clean, exceptId);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!clean || taken || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(clean);
    } catch (failure) {
      setError(
        failure instanceof ApiError && failure.status === 409
          ? t('reader.lib_collection_exists')
          : describeError(failure),
      );
      setBusy(false);
    }
  };
  const message = taken ? t('reader.lib_collection_exists') : error;
  return (
    <form className="space-y-3 pb-1" onSubmit={(event) => void submit(event)}>
      <label className="block">
        <span className="mb-1.5 block text-sm font-medium text-muted-foreground">
          {t('reader.lib_collection_name')}
        </span>
        <input
          className="rd-input"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={COLLECTION_NAME_MAX}
          autoFocus
          enterKeyHint="done"
          aria-invalid={Boolean(message) || undefined}
          aria-describedby={message ? 'rd-coll-name-error' : undefined}
        />
      </label>
      {message && (
        <p id="rd-coll-name-error" role="alert" className="text-sm text-destructive">
          {message}
        </p>
      )}
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          className="rd-pill-btn rd-press"
          data-tone="secondary"
          onClick={onCancel}
        >
          {t('reader.cancel')}
        </button>
        <button
          type="submit"
          disabled={busy || !clean || taken}
          className="rd-pill-btn rd-press"
          data-tone="primary"
        >
          {busy && <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />}
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

/**
 * "Add to collection": a checklist of collections for the given documents and
 * "New collection", which creates one with them already in it.
 */
export function CollectionPicker({
  docIds,
  creating,
  onCreatingChange,
}: {
  docIds: readonly string[];
  creating: boolean;
  onCreatingChange: (creating: boolean) => void;
}) {
  const { t } = useTranslation();
  const { collections } = useReaderCollections();
  if (creating)
    return (
      <CollectionNameForm
        submitLabel={t('reader.lib_collection_create')}
        onCancel={() => onCreatingChange(false)}
        onSubmit={async (name) => {
          const created = await createCollection(name, docIds);
          tick();
          toast.success(t('reader.lib_collection_added', { name: created.name }));
          onCreatingChange(false);
        }}
      />
    );
  return (
    <div className="space-y-0.5 pb-1">
      <SheetRow
        icon={PlusIcon}
        label={t('reader.lib_collection_new')}
        onClick={() => onCreatingChange(true)}
      />
      {collections.map((collection) => {
        const state = membership(collection, docIds);
        return (
          <SheetRow
            key={collection.id}
            icon={LibraryBigIcon}
            label={collection.name}
            role="checkbox"
            aria-checked={state === 'all' ? true : state === 'some' ? 'mixed' : false}
            trailing={
              state === 'all' ? (
                <CheckIcon className="size-5 shrink-0 text-primary" aria-hidden="true" />
              ) : state === 'some' ? (
                <MinusIcon className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
              ) : null
            }
            onClick={() => void toggleInCollection(collection, docIds)}
          />
        );
      })}
    </div>
  );
}

/** The picker in a sheet of its own (multi-select). */
export function CollectionPickerSheet({
  docIds,
  onClose,
}: {
  docIds: readonly string[] | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [creating, setCreating] = useState(false);
  const [shown, setShown] = useState(docIds);
  useEffect(() => {
    if (!docIds) return;
    setShown(docIds);
    setCreating(false);
  }, [docIds]);
  return (
    <ReaderSheet
      open={docIds !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t(creating ? 'reader.lib_collection_new' : 'reader.lib_collection_add')}
      keyboard
    >
      <CollectionPicker docIds={shown ?? []} creating={creating} onCreatingChange={setCreating} />
    </ReaderSheet>
  );
}

/** "New collection" from the Collections tab; opens the new (empty) collection. */
export function NewCollectionSheet({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (collection: ReaderCollection) => void;
}) {
  const { t } = useTranslation();
  return (
    <ReaderSheet open={open} onOpenChange={onOpenChange} title={t('reader.lib_collection_new')} keyboard>
      {open && (
        <CollectionNameForm
          submitLabel={t('reader.lib_collection_create')}
          onCancel={() => onOpenChange(false)}
          onSubmit={async (name) => {
            onCreated(await createCollection(name));
            tick();
          }}
        />
      )}
    </ReaderSheet>
  );
}

/** A collection's own menu: rename, delete (its documents stay in the library). */
export function CollectionMenuSheet({
  collection,
  onClose,
  onDeleted,
}: {
  collection: ReaderCollection | null;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { t } = useTranslation();
  const [view, setView] = useState<'menu' | 'rename' | 'delete'>('menu');
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState(collection);
  useEffect(() => {
    if (!collection) return;
    setShown(collection);
    setView('menu');
    setBusy(false);
  }, [collection]);
  if (!shown) return null;
  const remove = async () => {
    setBusy(true);
    try {
      await deleteCollection(shown.id);
      toast.success(t('reader.lib_collection_deleted'), { description: shown.name });
      onDeleted();
    } catch (error) {
      toast.error(describeError(error));
      setBusy(false);
    }
  };
  return (
    <ReaderSheet
      open={collection !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={view === 'delete' ? t('reader.lib_collection_delete_title') : shown.name}
      keyboard={view === 'rename'}
    >
      {view === 'menu' && (
        <div className="space-y-0.5 pb-1">
          <SheetRow icon={PencilIcon} label={t('reader.rename')} onClick={() => setView('rename')} />
          <SheetRow
            icon={Trash2Icon}
            label={t('reader.lib_collection_delete')}
            destructive
            onClick={() => setView('delete')}
          />
        </div>
      )}
      {view === 'rename' && (
        <CollectionNameForm
          initial={shown.name}
          exceptId={shown.id}
          submitLabel={t('reader.save')}
          onCancel={() => setView('menu')}
          onSubmit={async (name) => {
            await renameCollection(shown.id, name);
            onClose();
          }}
        />
      )}
      {view === 'delete' && (
        <div className="space-y-4 pb-1">
          <p className="text-[15px] leading-relaxed text-muted-foreground">
            {t('reader.lib_collection_delete_body', { name: shown.name })}
          </p>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              className="rd-pill-btn rd-press"
              data-tone="secondary"
              onClick={() => setView('menu')}
            >
              {t('reader.cancel')}
            </button>
            <button
              type="button"
              disabled={busy}
              className="rd-pill-btn rd-press"
              data-tone="danger"
              onClick={() => void remove()}
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

/** The Collections tab: one row per collection (name and size), then "New collection". */
export function CollectionList({
  collections,
  counts,
  onOpen,
  onNew,
}: {
  collections: readonly ReaderCollection[];
  /** Documents in each collection that are still in the library. */
  counts: Readonly<Record<string, number>>;
  onOpen: (id: string) => void;
  onNew: () => void;
}) {
  const { t } = useTranslation();
  return (
    <ul className="rd-coll-list" aria-label={t('reader.lib_collections')}>
      {collections.map((collection) => (
        <li key={collection.id}>
          <button
            type="button"
            className="rd-coll-row rd-press"
            onClick={() => {
              tick();
              onOpen(collection.id);
            }}
          >
            <span className="rd-coll-tile" aria-hidden="true">
              <LibraryBigIcon />
            </span>
            <span className="rd-row-text">
              <span className="rd-row-title">{collection.name}</span>
              <span className="rd-row-meta">
                {t('reader.lib_items', { count: counts[collection.id] ?? 0 })}
              </span>
            </span>
            <ChevronRightIcon className="rd-coll-chevron" aria-hidden="true" />
          </button>
        </li>
      ))}
      <li>
        <button type="button" className="rd-coll-row rd-press" onClick={onNew}>
          <span className="rd-coll-tile" data-new="" aria-hidden="true">
            <PlusIcon />
          </span>
          <span className="rd-row-text">
            <span className="rd-row-title">{t('reader.lib_collection_new')}</span>
          </span>
        </button>
      </li>
    </ul>
  );
}

/** Above an open collection: back to all collections, its name and its menu. */
export function CollectionHeader({
  collection,
  count,
  onBack,
  onMore,
}: {
  collection: ReaderCollection;
  count: number;
  onBack: () => void;
  onMore: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="rd-coll-head">
      <button
        type="button"
        className="rd-icon-btn"
        aria-label={t('reader.lib_collection_back')}
        onClick={onBack}
      >
        <ChevronLeftIcon className="size-5" aria-hidden="true" />
      </button>
      <div className="min-w-0 flex-1">
        <h2 className="rd-coll-name">{collection.name}</h2>
        <p className="rd-row-meta">{t('reader.lib_items', { count })}</p>
      </div>
      <button
        type="button"
        className="rd-icon-btn rd-row-more"
        aria-label={t('reader.lib_collection_options', { name: collection.name })}
        onClick={onMore}
      >
        <EllipsisIcon className="size-5" aria-hidden="true" />
      </button>
    </div>
  );
}
