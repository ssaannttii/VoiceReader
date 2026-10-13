import {
  Fragment,
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import type { ReaderSegment } from './reader-api';
import { REVEAL_EVENT, type RevealDetail } from './reader-events';
import { readerPlayer } from './reader-player';
import { readerPrefs } from './reader-prefs';
import { createLongPress, wordAtPoint } from './reader-long-press';
import { FOLLOW_EVENT } from './player-sheets';
import { tapOutcome } from './player-chrome';
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

/**
 * The part of the scroller not covered by the floating header and dock: its
 * `scroll-padding` (set from their measured heights while they are shown).
 */
function visibleBand(scroller: HTMLElement): { top: number; height: number } {
  const box = scroller.getBoundingClientRect();
  const style = getComputedStyle(scroller);
  const padTop = parseFloat(style.scrollPaddingTop) || 0;
  const padBottom = parseFloat(style.scrollPaddingBottom) || 0;
  // Never let the chrome squeeze the band below half the screen.
  const height = Math.max(box.height * 0.5, box.height - padTop - padBottom);
  return { top: box.top + Math.min(padTop, box.height - height), height };
}

/** Bring the spoken sentence into the reading band (upper third) when it leaves it. */
export function scrollToSentence(scroller: HTMLElement, element: HTMLElement, force = false) {
  const band = visibleBand(scroller);
  const rect = element.getBoundingClientRect();
  const top = rect.top - band.top;
  const bottom = rect.bottom - band.top;
  if (!force && top >= band.height * 0.12 && bottom <= band.height * 0.72) return;
  const target = scroller.scrollTop + top - band.height * 0.28;
  const far = Math.abs(top) > band.height * 2;
  scroller.scrollTo({ top: target, behavior: far || reducedMotion() ? 'auto' : 'smooth' });
  // Layout can still shift after a long jump (fonts, images); settle on the next frame.
  if (far)
    requestAnimationFrame(() => {
      const settled = element.getBoundingClientRect().top - band.top;
      scroller.scrollTop += settled - band.height * 0.28;
    });
}

/** First sentence whose text is on screen below the header (for "continue from here"), or null. */
export function firstVisibleSegment(scroller: HTMLElement): number | null {
  const top = visibleBand(scroller).top;
  for (const element of scroller.querySelectorAll<HTMLElement>('.rd-sent[data-seg]')) {
    const rect = element.getBoundingClientRect();
    // Mostly visible: its lower half is below the top edge.
    if (rect.bottom - rect.height / 2 > top) return Number(element.dataset.seg);
  }
  return null;
}

/** Briefly mark a sentence shown by search or a bookmark. */
function flash(element: HTMLElement) {
  element.setAttribute('data-revealed', 'true');
  setTimeout(() => element.removeAttribute('data-revealed'), 1700);
}

/** Two taps on the same sentence within this window count as a double tap. */
const DOUBLE_TAP_MS = 350;

/** A word picked by a long press or a right-click (pronunciation sheet). */
export interface WordPress {
  term: string;
  segment: number;
  /** Character offset of the word in the segment text. */
  offset: number;
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
  marked,
  onWordPress,
  chromeHidden,
  onChrome,
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
  /** Bookmarked segments, drawn with a small mark. */
  marked?: ReadonlySet<number>;
  /** Long press (touch) or right-click (mouse) on a word. */
  onWordPress?: (press: WordPress) => void;
  /** The floating controls are faded out (a tap only brings them back). */
  chromeHidden?: RefObject<boolean>;
  /** A tap toggles the controls; a seek or play keeps them up. */
  onChrome?: (event: 'toggle' | 'interact') => void;
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
  /** Segment to scroll to once a re-centred window has rendered (reader:reveal). */
  const pendingReveal = useRef<number | null>(null);
  const lastTap = useRef<{ segment: number; at: number } | null>(null);
  const onWordPressRef = useRef(onWordPress);
  onWordPressRef.current = onWordPress;
  /** Element under the pointer when the current press started. */
  const pressTarget = useRef<Element | null>(null);
  /** The click that ends a long press must not also play. */
  const swallowClick = useRef(false);

  /** Open the pronunciation sheet for the word at a viewport point. */
  const pressWord = (x: number, y: number, target: Element | null): boolean => {
    const handler = onWordPressRef.current;
    const sentence = target?.closest<HTMLElement>('.rd-sent[data-seg]');
    if (!handler || !sentence) return false;
    const found = wordAtPoint(sentence, x, y);
    if (!found) return false;
    handler({ term: found.word, segment: Number(sentence.dataset.seg), offset: found.offset });
    return true;
  };
  const longPress = useMemo(
    () =>
      createLongPress({
        onPress: ({ x, y }) => {
          swallowClick.current = true;
          if (!pressWord(x, y, pressTarget.current)) return;
          // The platform may have started selecting the word under the finger.
          window.getSelection()?.removeAllRanges();
        },
      }),
    [],
  );
  useEffect(() => () => longPress.cancel(), [longPress]);

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
    const reveal = pendingReveal.current;
    pendingReveal.current = null;
    const target = reveal === null ? null : elementOf(reveal);
    if (target && scrollEl) {
      scrollToSentence(scrollEl, target, true);
      flash(target);
    }
  }, [range]);

  // reader:reveal — show a segment (search, bookmarks) without playing it.
  useEffect(() => {
    const onReveal = (event: Event) => {
      const detail = (event as CustomEvent<RevealDetail>).detail;
      if (!detail || !Number.isFinite(detail.segment) || !segments.length) return;
      const segment = Math.min(Math.max(0, Math.round(detail.segment)), segments.length - 1);
      const element = elementOf(segment);
      const scrollEl = scroller.current;
      if (element && scrollEl) {
        scrollToSentence(scrollEl, element, true);
        flash(element);
        return;
      }
      pendingReveal.current = segment;
      anchor.current = null;
      setRange(windowAround(blockOf[segment] ?? 0, blocks.length));
    };
    window.addEventListener(REVEAL_EVENT, onReveal);
    return () => window.removeEventListener(REVEAL_EVENT, onReveal);
  }, [segments, blockOf, blocks, scroller]);

  // "Back to current" after a reveal moved the window away from the spoken sentence.
  useEffect(() => {
    if (!active) return;
    const onFollow = () => {
      const segment = readerPlayer.getState().segment;
      if (elementOf(segment)) return;
      changeWindow(windowAround(blockOf[segment] ?? 0, blocks.length), null);
    };
    window.addEventListener(FOLLOW_EVENT, onFollow);
    return () => window.removeEventListener(FOLLOW_EVENT, onFollow);
  }, [active, blockOf, blocks]);

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
          // Playback or a jump left the window: re-centre on the spoken segment,
          // unless the reader is looking elsewhere (scrolled away, a reveal).
          if (first || follow.current) changeWindow(windowAround(block, blocks.length), null);
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

  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    swallowClick.current = false;
    longPress.consume();
    // Mouse users right-click instead; holding a mouse button starts a selection.
    if (!onWordPress || event.pointerType === 'mouse' || !event.isPrimary) {
      longPress.cancel();
      return;
    }
    pressTarget.current = event.target as Element;
    longPress.down({ x: event.clientX, y: event.clientY });
  };
  const onPointerMove = (event: PointerEvent<HTMLElement>) =>
    longPress.move({ x: event.clientX, y: event.clientY });
  const onPointerEnd = () => longPress.up();

  const onContextMenu = (event: MouseEvent<HTMLElement>) => {
    if (!onWordPress) return;
    // Touch: our timer already handled the press (Android fires contextmenu too).
    if (longPress.fired) {
      event.preventDefault();
      return;
    }
    // A selection keeps the native menu (copy, search…).
    if (window.getSelection()?.toString()) return;
    longPress.cancel();
    if (pressWord(event.clientX, event.clientY, event.target as Element)) {
      event.preventDefault();
      swallowClick.current = true;
    }
  };

  /** Single tap waiting to see whether a second one makes it a double tap. */
  const pendingToggle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelToggle = () => {
    if (pendingToggle.current) clearTimeout(pendingToggle.current);
    pendingToggle.current = null;
  };
  useEffect(() => cancelToggle, []);

  // Tap rules (see tapOutcome): hidden controls → a tap only reveals them;
  // otherwise a tap on a sentence seeks (or, with double tap to play, a single
  // tap toggles the controls and a double tap plays); beside the text it toggles.
  const onClick = (event: MouseEvent<HTMLElement>) => {
    if (swallowClick.current) {
      swallowClick.current = false;
      return;
    }
    const target = event.target as HTMLElement;
    const sentence = target.closest<HTMLElement>('[data-seg]');
    const selected = Boolean(window.getSelection()?.toString());
    // Another document is playing: the dock offers to switch first.
    if (!active) {
      if (!selected) onChrome?.('toggle');
      return;
    }
    const doubleTap = readerPrefs().doubleTap;
    if (!doubleTap && selected) return;
    if (!sentence) {
      if (!selected) onChrome?.('toggle');
      return;
    }
    const segment = Number(sentence.dataset.seg);
    const word = target.closest<HTMLElement>('[data-w]');
    if (doubleTap) {
      // One tap toggles the controls (once it is clearly not a double tap);
      // a second tap on the same sentence plays from it.
      const now = performance.now();
      const last = lastTap.current;
      if (!last || last.segment !== segment || now - last.at > DOUBLE_TAP_MS) {
        cancelToggle();
        lastTap.current = selected ? null : { segment, at: now };
        if (!selected)
          pendingToggle.current = setTimeout(() => {
            pendingToggle.current = null;
            onChrome?.('toggle');
          }, DOUBLE_TAP_MS);
        return;
      }
      cancelToggle();
      lastTap.current = null;
      // A desktop double-click also selects the word under it.
      window.getSelection()?.removeAllRanges();
    } else if (
      tapOutcome({ chromeHidden: Boolean(chromeHidden?.current), doubleTap, onSentence: true }) ===
      'toggle'
    ) {
      onChrome?.('toggle');
      return;
    }
    onChrome?.('interact');
    onSeek();
    if (word && readerPlayer.getState().segment === segment)
      readerPlayer.seekWord(segment, Number(word.dataset.w));
    else readerPlayer.seekSegment(segment, true);
  };

  return (
    <article
      ref={article}
      className="rd-article"
      onClick={onClick}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onContextMenu={onContextMenu}
      lang={lang}
    >
      {range.start === 0 && header}
      <div ref={topSentinel} aria-hidden="true" />
      {blocks.slice(range.start, range.end).map((block) =>
        block.kind === 'h' ? (
          <h2 key={block.key} className="rd-heading">
            <span
              className="rd-sent"
              data-seg={block.segments[0].i}
              data-bookmark={marked?.has(block.segments[0].i) ? '' : undefined}
            >
              {block.segments[0].text}
            </span>
          </h2>
        ) : (
          <p key={block.key}>
            {block.segments.map((segment, index) => (
              <Fragment key={segment.i}>
                {index > 0 && ' '}
                <span
                  className="rd-sent"
                  data-seg={segment.i}
                  data-bookmark={marked?.has(segment.i) ? '' : undefined}
                >
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
