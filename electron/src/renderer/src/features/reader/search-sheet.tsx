import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PlayIcon, SearchIcon } from 'lucide-react';
import { FOLLOW_EVENT } from './player-sheets';
import type { ReaderDocument } from './reader-api';
import { revealSegment } from './reader-events';
import { readerPlayer } from './reader-player';
import { searchDocument, searchIndexFor, snippetFor, type SearchHit } from './reader-search';
import { ReaderSheet } from './reader-sheet';
import { chapterIndexAt, formatPercent } from './reader-text';
import { SearchField } from './search-field';

const DEBOUNCE_MS = 150;

/** Find words in the open document; a result scrolls the text there or plays from it. */
export function SearchSheet({
  doc,
  open,
  onOpenChange,
}: {
  doc: ReaderDocument;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(query), DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [query]);

  // Focus after the sheet's entry animation starts, so the keyboard opens with it.
  useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => input.current?.focus(), 60);
    return () => window.clearTimeout(id);
  }, [open]);

  // The folded index is built once per document, the first time search opens.
  const index = useMemo(
    () => (open || debounced ? searchIndexFor(doc.segments) : null),
    [open, debounced, doc.segments],
  );
  const result = useMemo(
    () => (index && debounced ? searchDocument(index, debounced) : null),
    [index, debounced],
  );

  const position = (segment: number) => {
    const chapter = doc.chapters[chapterIndexAt(doc.chapters, segment)]?.title;
    const percent = Math.round((segment / Math.max(1, doc.segments.length - 1)) * 100);
    return [chapter, formatPercent(percent)].filter(Boolean).join(' · ');
  };

  const reveal = (hit: SearchHit) => {
    revealSegment(hit.segment);
    onOpenChange(false);
  };

  const listen = (hit: SearchHit) => {
    readerPlayer.unlockFromGesture();
    if (readerPlayer.getState().doc?.id !== doc.id) readerPlayer.load(doc);
    readerPlayer.seekSegment(hit.segment, true);
    revealSegment(hit.segment);
    window.dispatchEvent(new Event(FOLLOW_EVENT));
    onOpenChange(false);
  };

  const pending = query.trim() !== debounced.trim();
  return (
    <ReaderSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t('reader.search_document')}
      keyboard
      className="rd-sheet-tall"
    >
      <div className="pb-1">
        <SearchField
          ref={input}
          value={query}
          onChange={setQuery}
          label={t('reader.search_document_placeholder')}
          clearLabel={t('reader.clear_search')}
          className="sticky top-0 z-[1] bg-popover pb-2"
        />
        <p className="sr-only" aria-live="polite">
          {result && !pending
            ? result.total
              ? t('reader.search_count', { total: result.total })
              : t('reader.search_no_results')
            : ''}
        </p>
        {!result ? (
          <div className="flex flex-col items-center gap-2 px-6 py-10 text-center text-sm text-muted-foreground">
            <SearchIcon className="size-7" aria-hidden="true" />
            {t('reader.search_hint')}
          </div>
        ) : result.total === 0 ? (
          <p className="px-6 py-10 text-center text-sm text-muted-foreground">
            {t('reader.search_no_results')}
          </p>
        ) : (
          <>
            <p className="px-3 pb-1 pt-1 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              {result.total > result.hits.length
                ? t('reader.search_capped', { shown: result.hits.length, total: result.total })
                : t('reader.search_count', { total: result.total })}
            </p>
            <ul className="space-y-0.5" aria-busy={pending}>
              {result.hits.map((hit) => {
                const text = doc.segments[hit.segment]?.text ?? '';
                const snippet = snippetFor(text, hit.start, hit.end);
                return (
                  <li key={hit.segment} className="flex items-center gap-1">
                    <button
                      type="button"
                      className="rd-sheet-row min-w-0 flex-1"
                      onClick={() => reveal(hit)}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="line-clamp-3 text-[0.92rem] leading-snug">
                          {snippet.before}
                          <mark className="rd-mark">{snippet.match}</mark>
                          {snippet.after}
                        </span>
                        <span className="mt-1 block truncate text-xs text-muted-foreground">
                          {position(hit.segment)}
                        </span>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="rd-icon-btn shrink-0 bg-foreground/[0.06]"
                      aria-label={t('reader.listen_from_here')}
                      title={t('reader.listen_from_here')}
                      onClick={() => listen(hit)}
                    >
                      <PlayIcon className="ml-0.5 size-4 fill-current" aria-hidden="true" />
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </ReaderSheet>
  );
}
