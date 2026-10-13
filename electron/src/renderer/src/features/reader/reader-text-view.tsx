import {
  Fragment,
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import type { ReaderSegment } from './reader-api';
import { readerPlayer } from './reader-player';
import {
  blockIndexBySegment,
  groupBlocks,
  splitWords,
  windowAround,
  type BlockWindow,
} from './reader-text';

const reducedMotion = () =>
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Bring the spoken sentence into the reading band (upper third) when it leaves it. */
export function scrollToSentence(scroller: HTMLElement, element: HTMLElement, force = false) {
  const box = scroller.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  const top = rect.top - box.top;
  const bottom = rect.bottom - box.top;
  if (!force && top >= box.height * 0.12 && bottom <= box.height * 0.72) return;
  const target = scroller.scrollTop + top - box.height * 0.28;
  const far = Math.abs(top) > box.height * 2;
  scroller.scrollTo({ top: target, behavior: far || reducedMotion() ? 'auto' : 'smooth' });
  // Layout can still shift after a long jump (fonts, images); settle on the next frame.
  if (far)
    requestAnimationFrame(() => {
      const settled = element.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      scroller.scrollTop += settled - box.height * 0.28;
    });
}

/**
 * The document text, rendered as a window of blocks around the reading position.
 *
 * A long book (15,000+ segments) must never be in the DOM at once: Chrome checks
 * every `content-visibility: auto` paragraph on every frame, which kept a phone's
 * main thread ~90% busy during playback. Only ~200 paragraphs are rendered; the
 * window grows when the reader scrolls near an edge and re-centres when playback
 * or a jump moves outside it. Every change keeps an anchor element at the same
 * screen position, so the text never jumps.
 *
 * Playback highlighting stays imperative (attribute toggles, word spans only in
 * the active segment) so the text never re-renders while it plays.
 */
export const ReaderTextView = memo(function ReaderTextView({
  docId,
  segments,
  active,
  position,
  scroller,
  follow,
  onSeek,
  header,
  lang,
}: {
  docId: string;
  segments: ReaderSegment[];
  /** This document is the one loaded in the player. */
  active: boolean;
  /** Saved reading position, used when the document is not the player's. */
  position: number;
  scroller: RefObject<HTMLElement | null>;
  follow: RefObject<boolean>;
  onSeek: () => void;
  header: ReactNode;
  lang?: string;
}) {
  const article = useRef<HTMLElement>(null);
  const topSentinel = useRef<HTMLDivElement>(null);
  const bottomSentinel = useRef<HTMLDivElement>(null);
  const blocks = useMemo(() => groupBlocks(segments), [segments]);
  const blockOf = useMemo(
    () => blockIndexBySegment(blocks, segments.length),
    [blocks, segments.length],
  );
  const startSegment = () =>
    Math.min(
      Math.max(0, active ? readerPlayer.getState().segment : position),
      Math.max(0, segments.length - 1),
    );
  const [range, setRange] = useState<BlockWindow>(() =>
    windowAround(blockOf[startSegment()] ?? 0, blocks.length),
  );
  const rangeRef = useRef(range);
  rangeRef.current = range;
  /** Element (by segment) whose on-screen offset must survive the next window change. */
  const anchor = useRef<{ segment: number; offset: number } | null>(null);
  /** Re-applies the highlight after the window changed (set by the highlight effect). */
  const resync = useRef<() => void>(() => {});

  const elementOf = (segment: number) =>
    article.current?.querySelector<HTMLElement>(`[data-seg="${segment}"]`) ?? null;

  const changeWindow = (next: BlockWindow, anchorSegment: number | null) => {
    const current = rangeRef.current;
    if (next.start === current.start && next.end === current.end) return;
    const scrollEl = scroller.current;
    const el = anchorSegment === null ? null : elementOf(anchorSegment);
    anchor.current =
      el && scrollEl && anchorSegment !== null
        ? {
            segment: anchorSegment,
            offset: el.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top,
          }
        : null;
    setRange(next);
  };

  // A different document (or regrouped segments) starts from its own position.
  useEffect(() => {
    anchor.current = null;
    setRange(windowAround(blockOf[startSegment()] ?? 0, blocks.length));
  }, [docId, blocks, blockOf]);

  // Keep the anchor element where it was on screen, then refresh the highlight.
  useLayoutEffect(() => {
    const scrollEl = scroller.current;
    const saved = anchor.current;
    anchor.current = null;
    if (saved && scrollEl) {
      const el = elementOf(saved.segment);
      if (el)
        scrollEl.scrollTop +=
          el.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top - saved.offset;
    }
    resync.current();
  }, [range]);

  // Grow the window when the reader scrolls near either edge.
  useEffect(() => {
    const root = scroller.current;
    const top = topSentinel.current;
    const bottom = bottomSentinel.current;
    if (!root || !top || !bottom || typeof IntersectionObserver !== 'function') return;
    const observer = new IntersectionObserver(
      (entries) => {
        const { start, end } = rangeRef.current;
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          if (entry.target === bottom && end < blocks.length) {
            changeWindow({ start, end: Math.min(blocks.length, end + EXTEND) }, null);
          } else if (entry.target === top && start > 0) {
            // Content is added above: hold the first rendered paragraph in place.
            changeWindow(
              { start: Math.max(0, start - EXTEND), end },
              blocks[start]?.segments[0]?.i ?? null,
            );
          }
        }
      },
      { root, rootMargin: '800px 0px' },
    );
    observer.observe(top);
    observer.observe(bottom);
    return () => observer.disconnect();
  }, [blocks, scroller]);

  useEffect(() => {
    const root = article.current;
    if (!root || !active) return;
    let sentence: HTMLElement | null = null;
    let current = -1;
    let split = -1;
    let word: HTMLElement | null = null;
    let lastWord = -1;
    let first = true;
    const unsplit = () => {
      if (sentence && split >= 0 && sentence.isConnected)
        sentence.textContent = segments[split]?.text ?? '';
      split = -1;
      word = null;
    };
    const splitSentence = (segment: number) => {
      const words = readerPlayer.wordsFor(segment);
      if (!sentence || !words?.length) return;
      const fragment = document.createDocumentFragment();
      for (const part of splitWords(segments[segment]?.text ?? '', words)) {
        if (part.word === null) {
          fragment.append(part.text);
          continue;
        }
        const span = document.createElement('span');
        span.className = 'rd-word';
        span.dataset.w = String(part.word);
        span.textContent = part.text;
        fragment.append(span);
      }
      sentence.replaceChildren(fragment);
      split = segment;
    };
    const apply = (segment: number, wordIndex: number, fromWindow: boolean) => {
      lastWord = wordIndex;
      const block = blockOf[segment] ?? 0;
      const { start, end } = rangeRef.current;
      if (segment !== current || !sentence?.isConnected) {
        if (segment !== current) {
          sentence?.removeAttribute('data-active');
          unsplit();
        } else {
          // Same segment re-rendered by a window change: rebuild its word spans.
          split = -1;
          word = null;
        }
        current = segment;
        sentence = elementOf(segment);
        sentence?.setAttribute('data-active', 'true');
        if (!sentence && !fromWindow) {
          // Playback or a jump left the window: re-centre on the spoken segment.
          changeWindow(windowAround(block, blocks.length), null);
          return;
        }
        const scrollEl = scroller.current;
        if (sentence && scrollEl && !fromWindow && (first ? segment > 0 : follow.current))
          scrollToSentence(scrollEl, sentence, first);
        // Re-centred around a jump: bring the new position into view.
        if (sentence && scrollEl && fromWindow && (first || follow.current))
          scrollToSentence(scrollEl, sentence, true);
        if (sentence) first = false;
      }
      // Reading close to the window's end: extend ahead (or re-centre when following).
      if (!fromWindow && block >= end - NEAR_EDGE && end < blocks.length) {
        if (follow.current && end - start > MAX_WINDOW)
          changeWindow(windowAround(block, blocks.length), segment);
        else changeWindow({ start, end: Math.min(blocks.length, end + EXTEND) }, segment);
      }
      if (sentence && split !== segment) splitSentence(segment);
      const next =
        wordIndex >= 0 && split === segment && sentence
          ? sentence.querySelector<HTMLElement>(`[data-w="${wordIndex}"]`)
          : null;
      if (next !== word) {
        word?.removeAttribute('data-active');
        next?.setAttribute('data-active', 'true');
        word = next;
      }
    };
    resync.current = () => {
      if (current >= 0) apply(current, lastWord, true);
    };
    const unsubscribe = readerPlayer.subscribeHighlight((segment, wordIndex) =>
      apply(segment, wordIndex, false),
    );
    return () => {
      unsubscribe();
      resync.current = () => {};
      sentence?.removeAttribute('data-active');
      unsplit();
    };
  }, [active, docId, segments, blockOf, blocks, scroller, follow]);

  const onClick = (event: MouseEvent<HTMLElement>) => {
    if (window.getSelection()?.toString()) return;
    const target = event.target as HTMLElement;
    const sentence = target.closest<HTMLElement>('[data-seg]');
    if (!sentence) return;
    const segment = Number(sentence.dataset.seg);
    const word = target.closest<HTMLElement>('[data-w]');
    onSeek();
    if (word && readerPlayer.getState().segment === segment)
      readerPlayer.seekWord(segment, Number(word.dataset.w));
    else readerPlayer.seekSegment(segment, true);
  };

  return (
    <article ref={article} className="rd-article" onClick={onClick} lang={lang}>
      {range.start === 0 && header}
      <div ref={topSentinel} aria-hidden="true" />
      {blocks.slice(range.start, range.end).map((block) =>
        block.kind === 'h' ? (
          <h2 key={block.key} className="rd-heading">
            <span className="rd-sent" data-seg={block.segments[0].i}>
              {block.segments[0].text}
            </span>
          </h2>
        ) : (
          <p key={block.key}>
            {block.segments.map((segment, index) => (
              <Fragment key={segment.i}>
                {index > 0 && ' '}
                <span className="rd-sent" data-seg={segment.i}>
                  {segment.text}
                </span>
              </Fragment>
            ))}
          </p>
        ),
      )}
      <div ref={bottomSentinel} aria-hidden="true" />
    </article>
  );
});

/** Paragraphs added when the reader scrolls near an edge of the window. */
const EXTEND = 100;
/** Playback within this many paragraphs of the window's end extends it. */
const NEAR_EDGE = 25;
/** A followed reading re-centres instead of growing past this many paragraphs. */
const MAX_WINDOW = 400;
