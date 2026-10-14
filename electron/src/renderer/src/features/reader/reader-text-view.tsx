import {
  Fragment,
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { useTranslation } from 'react-i18next';
import { ImageOffIcon } from 'lucide-react';
import { createObjectUrl, revokeObjectUrl } from '@/lib/audio/object-url';
import { readerApi, type ReaderSegment } from './reader-api';
import { offlineAsset } from './offline-state';
import { REVEAL_EVENT, type RevealDetail } from './reader-events';
import { readerPlayer } from './reader-player';
import { readerPrefs } from './reader-prefs';
import { createLongPress, wordAtPoint } from './reader-long-press';
import { FOLLOW_EVENT } from './player-sheets';
import { tapOutcome } from './player-chrome';
import {
  blockIndexBySegment,
  formatPercent,
  groupBlocks,
  layoutBlocks,
  splitWords,
  windowAround,
  type BlockWindow,
  type LayoutNode,
  type ListNode,
  type ReaderBlock,
} from './reader-text';
import { Pager } from './reader-pager';
import {
  charOffsets,
  clampPage,
  EDGE_ZONE,
  estimatePagesBefore,
  growWindow,
  PAGED_MAX,
  pagedWindow,
  pageKeyDelta,
  percentRead,
  swipeTurn,
  SPREAD_EDGE_ZONE,
  tapZone,
  windowEdge,
} from './reader-pages';
import { swipeIntent } from './swipe-math';

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
  const pages = scroller.querySelector<HTMLElement>('.rd-pages');
  if (pages) {
    // Pages: the first sentence that still has a line on the page shown.
    const left = pages.getBoundingClientRect().left;
    for (const element of scroller.querySelectorAll<HTMLElement>('.rd-sent[data-seg]')) {
      const rects = element.getClientRects();
      const last = rects[rects.length - 1];
      if (last && last.right > left + 1) return Number(element.dataset.seg);
    }
    return null;
  }
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

/** Typing, or inside a sheet: reading-view shortcuts stay out of the way. */
export const editableTarget = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    target.matches('input, textarea, select') ||
    Boolean(target.closest('.rd-sheet')));

/** Controls inside the reading surface keep their own taps. */
const INTERACTIVE = 'button, a, input, select, textarea, [role="button"]';

/** A wheel gesture (a notch run, a trackpad swipe and its momentum) ends after this pause. */
const WHEEL_IDLE_MS = 200;
/** Wheel travel that turns the page, once per gesture. */
const WHEEL_TURN_PX = 40;
/** The click a swipe ends with must not also turn or play. */
const SWIPE_CLICK_MS = 400;

/** Where the shown page starts, to put the reader back on the same text after a re-layout. */
interface PageAnchor {
  /** First sentence (or image) starting on the page, else the one running across it. */
  segment: number;
  /** Pages between where that segment starts and the page. */
  delta: number;
  /** The page number shown on it. */
  number: number;
}

/** What the page indicator shows. */
interface PageInfo {
  number: number;
  percent: number;
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
  paged = false,
  pageKey,
  onBrowse,
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
  /** Screen-sized pages turned by taps, swipes and keys instead of scrolling. */
  paged?: boolean;
  /** Changes whenever the text reflows (size, font): pages are laid out again. */
  pageKey?: string;
  /** Pages: the reader turned away from the spoken page (true) or back to it (false). */
  onBrowse?: (away: boolean) => void;
}) {
  const article = useRef<HTMLElement>(null);
  const topSentinel = useRef<HTMLDivElement>(null);
  const bottomSentinel = useRef<HTMLDivElement>(null);
  const blocks = useMemo(() => groupBlocks(segments), [segments]);
  const blockOf = useMemo(
    () => blockIndexBySegment(blocks, segments.length),
    [blocks, segments.length],
  );
  /** Characters before each segment: page numbers and the percentage read. */
  const chars = useMemo(
    () => charOffsets(segments.map((segment) => segment.text.length)),
    [segments],
  );
  const data = useRef({ blocks, blockOf, chars });
  data.current = { blocks, blockOf, chars };
  const pagedRef = useRef(paged);
  pagedRef.current = paged;
  const activeRef = useRef(active);
  activeRef.current = active;
  const onBrowseRef = useRef(onBrowse);
  onBrowseRef.current = onBrowse;
  /** Pages render a smaller window: every change lays out all of its columns again. */
  const windowFor = (index: number, total: number) =>
    pagedRef.current ? pagedWindow(index, total) : windowAround(index, total);
  const startSegment = () =>
    Math.min(
      Math.max(0, active ? readerPlayer.getState().segment : position),
      Math.max(0, segments.length - 1),
    );
  const [range, setRange] = useState<BlockWindow>(() =>
    windowFor(blockOf[startSegment()] ?? 0, blocks.length),
  );
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const nodes = useMemo(
    () => layoutBlocks(blocks.slice(range.start, range.end)),
    [blocks, range.start, range.end],
  );
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

  // ── Pages ──────────────────────────────────────────────────────────────────
  const pagesRef = useRef<HTMLDivElement>(null);
  const pager = useRef<Pager | null>(null);
  /** Where the shown page starts (kept current), to come back to after a re-layout. */
  const pageAnchor = useRef<PageAnchor | null>(null);
  /** Pages before the rendered window (exact when it starts the document, else estimated). */
  const pagesBefore = useRef(0);
  const indicator = useRef<((info: PageInfo | null) => void) | null>(null);
  /** Watches images of the window: one without a known size grows once loaded. */
  const figureObserver = useRef<ResizeObserver | null>(null);

  /** Where `page` starts in the text: the first item starting on it (binary search). */
  const anchorAt = (p: Pager, page: number): PageAnchor | null => {
    const items = Array.from(article.current?.querySelectorAll<HTMLElement>('[data-seg]') ?? []);
    if (!items.length) return null;
    let low = 0;
    let high = items.length - 1;
    let found = items.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (p.pageOf(items[mid]) >= page) {
        found = mid;
        high = mid - 1;
      } else low = mid + 1;
    }
    // Nothing starts on the page: the sentence before runs across it.
    if (found > 0 && p.pageOf(items[found]) > page) found -= 1;
    const element = items[found];
    return {
      segment: Number(element.dataset.seg),
      delta: page - p.pageOf(element),
      number: pagesBefore.current + page + 1,
    };
  };

  /** Remember where the shown page starts and update the page indicator. */
  const settle = (p: Pager) => {
    pageAnchor.current = anchorAt(p, p.page);
    const { blocks, chars } = data.current;
    const total = chars[chars.length - 1] ?? 0;
    let done = total;
    if (p.page + 1 < p.count) {
      const next = anchorAt(p, p.page + 1);
      if (next) done = chars[next.segment] ?? total;
    } else {
      const after = blocks[rangeRef.current.end]?.segments[0]?.i;
      if (after !== undefined) done = chars[after] ?? total;
    }
    indicator.current?.({
      number: pagesBefore.current + p.page + 1,
      percent: percentRead(done, total),
    });
  };

  /**
   * Measure the window's pages and put the reader back on the same text. Page
   * numbers carry on across a window change; a reflow (size, font) estimates them
   * again, as every page boundary moved.
   */
  const relayout = (p: Pager, cause: 'window' | 'resize' | 'reflow') => {
    const saved = pageAnchor.current;
    const before = p.count;
    const resized = p.fit();
    p.measure(bottomSentinel.current);
    const element = saved ? elementOf(saved.segment) : null;
    let page: number;
    if (saved && element) {
      page = p.pageOf(element) + saved.delta;
      // Reflowed: stay inside the sentence the page was in the middle of.
      if (cause !== 'window' && saved.delta > 0) page = Math.min(page, p.pageOf(element, true));
    } else {
      const start = elementOf(startSegment());
      page = start ? p.pageOf(start) : 0;
    }
    page = clampPage(page, p.count);
    const renumber =
      !saved ||
      !element ||
      cause === 'reflow' ||
      (cause === 'resize' && (resized || p.count !== before));
    const { chars, blocks } = data.current;
    const { start, end } = rangeRef.current;
    const at = (index: number) => chars[blocks[index]?.segments[0]?.i ?? chars.length - 1] ?? 0;
    if (start === 0) pagesBefore.current = 0;
    else if (renumber)
      pagesBefore.current = estimatePagesBefore(at(start), at(end) - at(start), p.count);
    else if (saved) pagesBefore.current = Math.max(0, saved.number - 1 - page);
    p.show(page, false);
    settle(p);
  };

  /** Show `target`, rendering more text first when it nears an edge of the window. */
  const turnTo = (target: number, animate: boolean) => {
    const p = pager.current;
    if (!p) return;
    const page = clampPage(target, p.count);
    const motion = animate && !reducedMotion();
    const { blocks, blockOf } = data.current;
    const range = rangeRef.current;
    const edge = windowEdge(page, p.count, {
      before: range.start > 0,
      after: range.end < blocks.length,
    });
    const anchorHere = edge ? anchorAt(p, page) : null;
    if (edge && anchorHere) {
      const next = growWindow(range, edge, blocks.length, blockOf[anchorHere.segment] ?? 0);
      if (next.start !== range.start || next.end !== range.end) {
        // Text added after this page leaves it in place: slide now. Text added
        // before moves every page: the layout effect shows the anchor's page.
        if (next.start === range.start) p.show(page, motion);
        pageAnchor.current = anchorHere;
        anchor.current = null;
        setRange(next);
        return;
      }
    }
    p.show(page, motion);
    settle(p);
  };

  /** The spoken word (or sentence) is on page `page`. */
  const spokenOn = (p: Pager, page: number, sentence: Element, word: Element | null) =>
    word ? p.pageOf(word) === page : p.pageOf(sentence) <= page && page <= p.pageOf(sentence, true);

  /** Turn to the spoken word when it is off the page (sliding only to a neighbour). */
  const showSpoken = (animate: boolean, sentence?: Element | null, word?: Element | null) => {
    const p = pager.current;
    const spoken = sentence ?? article.current?.querySelector('[data-seg][data-active]');
    if (!p || !spoken) return;
    const spokenWord = sentence ? (word ?? null) : spoken.querySelector('[data-w][data-active]');
    if (spokenOn(p, p.page, spoken, spokenWord)) return;
    const target = p.pageOf(spokenWord ?? spoken);
    turnTo(target, animate && Math.abs(target - p.page) === 1);
  };

  /** The reader turned the page (tap zone, swipe, wheel, key). */
  const userTurn = (delta: number) => {
    const p = pager.current;
    if (!p) return;
    const target = p.page + delta;
    if (target < 0 || target >= p.count) {
      // First or last page of the document: settle back.
      p.show(p.page, true);
      return;
    }
    const spoken = activeRef.current
      ? article.current?.querySelector('[data-seg][data-active]')
      : null;
    const back = Boolean(
      spoken && spokenOn(p, target, spoken, spoken.querySelector('[data-w][data-active]')),
    );
    turnTo(target, true);
    // Away from the voice: stop following it until "Back to current"; onto its page: follow again.
    onBrowseRef.current?.(!back);
  };

  const changeWindow = (next: BlockWindow, anchorSegment: number | null) => {
    const current = rangeRef.current;
    if (next.start === current.start && next.end === current.end) return;
    // Pages keep their own anchor (pageAnchor).
    if (pagedRef.current) {
      anchor.current = null;
      setRange(next);
      return;
    }
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
    pageAnchor.current = null;
    setRange(windowFor(blockOf[startSegment()] ?? 0, blocks.length));
  }, [docId, blocks, blockOf]);

  // Pages: lay the window out as pages, and again whenever the page size, the
  // fonts or an image's size change. The viewport itself never scrolls.
  useLayoutEffect(() => {
    const viewport = pagesRef.current;
    const element = article.current;
    if (!paged || !viewport || !element) return;
    const p = new Pager(viewport, element);
    pager.current = p;
    pageAnchor.current = null;
    relayout(p, 'window');
    // A window grown while scrolling is larger than pages lay out comfortably.
    const { start, end } = rangeRef.current;
    if (end - start > PAGED_MAX) {
      const { blocks, blockOf } = data.current;
      setRange(pagedWindow(blockOf[startSegment()] ?? 0, blocks.length));
    }
    let frame = 0;
    const later = (cause: 'resize' | 'reflow') => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (pager.current !== p) return;
        relayout(p, cause);
        if (activeRef.current && follow.current) showSpoken(false);
      });
    };
    const onFonts = () => later('reflow');
    const resize =
      typeof ResizeObserver === 'function' ? new ResizeObserver(() => later('resize')) : null;
    resize?.observe(viewport);
    const heights = new WeakMap<Element, number>();
    const figures =
      typeof ResizeObserver === 'function'
        ? new ResizeObserver((entries) => {
            let changed = false;
            for (const entry of entries) {
              const before = heights.get(entry.target);
              heights.set(entry.target, entry.contentRect.height);
              if (before !== undefined && Math.abs(before - entry.contentRect.height) > 0.5)
                changed = true;
            }
            if (changed) later('reflow');
          })
        : null;
    figureObserver.current = figures;
    element.querySelectorAll('.rd-figure').forEach((figure) => figures?.observe(figure));
    document.fonts?.addEventListener?.('loadingdone', onFonts);
    const pin = () => {
      viewport.scrollLeft = 0;
      viewport.scrollTop = 0;
    };
    viewport.addEventListener('scroll', pin, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      resize?.disconnect();
      figures?.disconnect();
      figureObserver.current = null;
      document.fonts?.removeEventListener?.('loadingdone', onFonts);
      viewport.removeEventListener('scroll', pin);
      if (pager.current === p) pager.current = null;
      indicator.current?.(null);
    };
  }, [paged]);

  // The text size or font changed: every page boundary moves.
  const laidOutKey = useRef(pageKey);
  useLayoutEffect(() => {
    if (laidOutKey.current === pageKey) return;
    laidOutKey.current = pageKey;
    const p = pager.current;
    if (!p) return;
    relayout(p, 'reflow');
    if (activeRef.current && follow.current) showSpoken(false);
  }, [pageKey]);

  // Keep the anchor element where it was on screen, then refresh the highlight.
  useLayoutEffect(() => {
    const scrollEl = scroller.current;
    const saved = anchor.current;
    anchor.current = null;
    const p = pager.current;
    if (p) {
      relayout(p, 'window');
      const figures = figureObserver.current;
      figures?.disconnect();
      article.current?.querySelectorAll('.rd-figure').forEach((figure) => figures?.observe(figure));
    } else if (saved && scrollEl) {
      const el = elementOf(saved.segment);
      if (el)
        scrollEl.scrollTop +=
          el.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top - saved.offset;
    }
    resync.current();
    const reveal = pendingReveal.current;
    pendingReveal.current = null;
    const target = reveal === null ? null : elementOf(reveal);
    if (target && p) {
      turnTo(p.pageOf(target), false);
      flash(target);
    } else if (target && scrollEl) {
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
        const p = pager.current;
        if (p) turnTo(p.pageOf(element), false);
        else scrollToSentence(scrollEl, element, true);
        flash(element);
        return;
      }
      pendingReveal.current = segment;
      anchor.current = null;
      setRange(windowFor(blockOf[segment] ?? 0, blocks.length));
    };
    window.addEventListener(REVEAL_EVENT, onReveal);
    return () => window.removeEventListener(REVEAL_EVENT, onReveal);
  }, [segments, blockOf, blocks, scroller]);

  // "Back to current" after a reveal moved the window away from the spoken sentence.
  useEffect(() => {
    if (!active) return;
    const onFollow = () => {
      const segment = readerPlayer.getState().segment;
      if (elementOf(segment)) {
        if (pager.current) showSpoken(false);
        return;
      }
      changeWindow(windowFor(blockOf[segment] ?? 0, blocks.length), null);
    };
    window.addEventListener(FOLLOW_EVENT, onFollow);
    return () => window.removeEventListener(FOLLOW_EVENT, onFollow);
  }, [active, blockOf, blocks]);

  // Grow the window when the reader scrolls near either edge.
  useEffect(() => {
    const root = scroller.current;
    const top = topSentinel.current;
    const bottom = bottomSentinel.current;
    // Pages grow the window on page turns instead (turnTo).
    if (paged || !root || !top || !bottom || typeof IntersectionObserver !== 'function') return;
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
  }, [blocks, scroller, paged]);

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
      /** Pages: bring the spoken text onto the page (a jump shows it at once). */
      let turn: 'jump' | 'slide' | null = null;
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
          if (first || follow.current) changeWindow(windowFor(block, blocks.length), null);
          return;
        }
        const scrollEl = scroller.current;
        if (paged) {
          // Pages: shown below, once the spoken word is known.
          if (sentence && (first || follow.current)) turn = first || fromWindow ? 'jump' : 'slide';
        } else {
          if (sentence && scrollEl && !fromWindow && (first ? segment > 0 : follow.current))
            scrollToSentence(scrollEl, sentence, first);
          // Re-centred around a jump: bring the new position into view.
          if (sentence && scrollEl && fromWindow && (first || follow.current))
            scrollToSentence(scrollEl, sentence, true);
        }
        if (sentence) first = false;
      }
      // Reading close to the window's end: extend ahead (or re-centre when following).
      // Pages grow it on page turns instead (turnTo).
      if (!paged && !fromWindow && block >= end - NEAR_EDGE && end < blocks.length) {
        if (follow.current && end - start > MAX_WINDOW)
          changeWindow(windowAround(block, blocks.length), segment);
        else changeWindow({ start, end: Math.min(blocks.length, end + EXTEND) }, segment);
      }
      if (sentence && split !== segment) splitSentence(segment);
      const next =
        wordIndex >= 0 && split === segment && sentence
          ? sentence.querySelector<HTMLElement>(`[data-w="${wordIndex}"]`)
          : null;
      const moved = next !== word;
      if (moved) {
        word?.removeAttribute('data-active');
        next?.setAttribute('data-active', 'true');
        word = next;
      }
      // Pages: the page turns when the spoken word leaves it.
      if (paged && sentence && (turn || (moved && follow.current)))
        showSpoken(turn !== 'jump', sentence, word);
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
  }, [active, docId, segments, blockOf, blocks, scroller, follow, paged]);

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

  // Pages: the outer quarters of the screen turn the page (the middle reads and
  // toggles the controls as in scrolling), and so do swipes, the wheel and keys.
  useEffect(() => {
    const root = scroller.current;
    if (!paged || !root) return;
    let gesture: { id: number; x: number; y: number; at: number; dragging: boolean } | null = null;
    let swipedAt = -Infinity;
    let wheelAt = -Infinity;
    let wheelSum = 0;
    let wheelTurned = false;
    const onDown = (event: globalThis.PointerEvent) => {
      gesture = null;
      // Mouse users click the edges or use the wheel: dragging a mouse selects text.
      if (!event.isPrimary || event.pointerType === 'mouse') return;
      if ((event.target as Element | null)?.closest?.(INTERACTIVE)) return;
      gesture = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        at: event.timeStamp,
        dragging: false,
      };
    };
    const onMove = (event: globalThis.PointerEvent) => {
      if (!gesture || event.pointerId !== gesture.id) return;
      const dx = event.clientX - gesture.x;
      if (!gesture.dragging) {
        const intent = swipeIntent(dx, event.clientY - gesture.y);
        if (intent === null) return;
        if (intent === 'vertical') {
          gesture = null;
          return;
        }
        gesture.dragging = true;
        longPress.cancel();
      }
      if (!reducedMotion()) pager.current?.drag(dx);
    };
    const onUp = (event: globalThis.PointerEvent) => {
      const done = gesture;
      if (!done || event.pointerId !== done.id) return;
      gesture = null;
      if (!done.dragging) return;
      swipedAt = performance.now();
      const turn = swipeTurn(
        event.clientX - done.x,
        event.clientY - done.y,
        event.timeStamp - done.at,
      );
      const p = pager.current;
      if (turn) userTurn(turn);
      else p?.show(p.page, true);
    };
    const onCancel = (event: globalThis.PointerEvent) => {
      if (!gesture || event.pointerId !== gesture.id) return;
      const p = pager.current;
      if (gesture.dragging) p?.show(p.page, true);
      gesture = null;
    };
    // Capture: decided before the article reads the tap as "play from here".
    const onClickCapture = (event: globalThis.MouseEvent) => {
      if (performance.now() - swipedAt < SWIPE_CLICK_MS) {
        event.stopPropagation();
        return;
      }
      // A long press (pronunciation) or a selection ends in this click: the article handles it.
      if (swallowClick.current || window.getSelection()?.toString()) return;
      if ((event.target as Element | null)?.closest?.(INTERACTIVE)) return;
      const box = root.getBoundingClientRect();
      const edge = pager.current?.columns === 2 ? SPREAD_EDGE_ZONE : EDGE_ZONE;
      const zone = tapZone(event.clientX - box.left, box.width, edge);
      if (zone === 'centre') return;
      event.stopPropagation();
      userTurn(zone === 'next' ? 1 : -1);
    };
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey) return; // Pinch-zoom on a trackpad.
      const now = performance.now();
      if (now - wheelAt > WHEEL_IDLE_MS) {
        wheelSum = 0;
        wheelTurned = false;
      }
      wheelAt = now;
      if (wheelTurned) return;
      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? root.clientHeight : 1;
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      wheelSum += delta * scale;
      if (Math.abs(wheelSum) < WHEEL_TURN_PX) return;
      wheelTurned = true;
      userTurn(wheelSum > 0 ? 1 : -1);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.shiftKey || editableTarget(event.target)) return;
      const delta = pageKeyDelta(event.key);
      if (!delta) return;
      event.preventDefault();
      userTurn(delta);
    };
    root.addEventListener('pointerdown', onDown, { passive: true });
    root.addEventListener('pointermove', onMove, { passive: true });
    root.addEventListener('pointerup', onUp, { passive: true });
    root.addEventListener('pointercancel', onCancel, { passive: true });
    root.addEventListener('click', onClickCapture, { capture: true });
    root.addEventListener('wheel', onWheel, { passive: true });
    window.addEventListener('keydown', onKey);
    return () => {
      root.removeEventListener('pointerdown', onDown);
      root.removeEventListener('pointermove', onMove);
      root.removeEventListener('pointerup', onUp);
      root.removeEventListener('pointercancel', onCancel);
      root.removeEventListener('click', onClickCapture, { capture: true });
      root.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKey);
    };
  }, [paged, scroller, longPress]);

  const text = (
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
      {nodes.map((node) => renderNode(node, docId, marked))}
      <div ref={bottomSentinel} aria-hidden="true" />
    </article>
  );
  if (!paged) return text;
  return (
    <>
      <div ref={pagesRef} className="rd-pages">
        {text}
      </div>
      <PageIndicator bind={indicator} />
    </>
  );
});

/** Pages: "Page 12 · 37 %" under the text; page numbers before the rendered window are estimated. */
function PageIndicator({ bind }: { bind: { current: ((info: PageInfo | null) => void) | null } }) {
  const { t, i18n } = useTranslation();
  const [info, setInfo] = useState<PageInfo | null>(null);
  // Bound before the text view's own layout effects run (children's come first).
  useLayoutEffect(() => {
    bind.current = setInfo;
    return () => {
      bind.current = null;
    };
  }, [bind]);
  if (!info) return null;
  return (
    <p className="rd-page-indicator">
      {t('reader.page_number', { page: info.number })}
      <span aria-hidden="true"> · </span>
      {formatPercent(info.percent, i18n.language)}
    </p>
  );
}

/** The sentences of one paragraph, each a highlightable `.rd-sent`. */
function sentences(block: ReaderBlock, marked: ReadonlySet<number> | undefined) {
  return block.segments.map((segment, index) => (
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
  ));
}

function renderList(list: ListNode, marked: ReadonlySet<number> | undefined) {
  const Tag = list.ordered ? 'ol' : 'ul';
  return (
    <Tag
      key={list.key}
      className="rd-list"
      data-depth={list.depth || undefined}
      style={list.depth ? ({ '--rd-list-depth': list.depth } as CSSProperties) : undefined}
    >
      {list.items.map((item) => (
        <li key={item.key} value={list.ordered ? item.n : undefined}>
          {item.blocks.map((block) => (
            <p key={block.key}>{sentences(block, marked)}</p>
          ))}
          {item.lists.map((child) => renderList(child, marked))}
        </li>
      ))}
    </Tag>
  );
}

function renderNode(node: LayoutNode, docId: string, marked: ReadonlySet<number> | undefined) {
  if (node.type === 'list') return renderList(node, marked);
  if (node.type === 'quote')
    return (
      <blockquote key={node.key} className="rd-quote">
        {node.blocks.map((block) => (
          <p key={block.key}>{sentences(block, marked)}</p>
        ))}
      </blockquote>
    );
  const { block } = node;
  if (block.kind === 'h')
    return (
      <h2 key={block.key} className="rd-heading">
        <span
          className="rd-sent"
          data-seg={block.segments[0].i}
          data-bookmark={marked?.has(block.segments[0].i) ? '' : undefined}
        >
          {block.segments[0].text}
        </span>
      </h2>
    );
  if (block.kind === 'img')
    return (
      <ReaderFigure
        key={block.key}
        docId={docId}
        segment={block.segments[0]}
        bookmarked={Boolean(marked?.has(block.segments[0].i))}
      />
    );
  return <p key={block.key}>{sentences(block, marked)}</p>;
}

/**
 * An image segment: loads its picture (or the downloaded copy offline) once it
 * comes near the screen, reserving its size meanwhile. The figure carries
 * `data-seg`, so taps, reveals and the playback highlight treat it like a sentence.
 */
const ReaderFigure = memo(function ReaderFigure({
  docId,
  segment,
  bookmarked,
}: {
  docId: string;
  segment: ReaderSegment;
  bookmarked: boolean;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLElement>(null);
  const [near, setNear] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const src = segment.src;

  useEffect(() => {
    const element = ref.current;
    if (!element || near) return;
    if (typeof IntersectionObserver !== 'function') {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      { rootMargin: '600px 0px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [near]);

  useEffect(() => {
    if (!near || !src) return;
    const controller = new AbortController();
    let objectUrl: string | null = null;
    setFailed(false);
    void (async () => {
      let blob: Blob | null = null;
      try {
        blob = await readerApi.asset(src, controller.signal);
      } catch {
        if (controller.signal.aborted) return;
        blob = await offlineAsset(docId, src);
      }
      if (controller.signal.aborted) return;
      objectUrl = blob ? createObjectUrl(blob) : null;
      if (objectUrl) setUrl(objectUrl);
      else setFailed(true);
    })();
    return () => {
      controller.abort();
      revokeObjectUrl(objectUrl);
      setUrl(null);
    };
  }, [near, docId, src]);

  const width = segment.w && segment.w > 0 ? segment.w : undefined;
  const height = segment.h && segment.h > 0 ? segment.h : undefined;
  const label = segment.caption || segment.alt;
  return (
    <figure
      ref={ref}
      className="rd-figure"
      data-seg={segment.i}
      data-bookmark={bookmarked ? '' : undefined}
      data-state={url ? 'ready' : failed ? 'failed' : 'loading'}
    >
      <div
        className="rd-figure-frame"
        style={
          {
            // Pages keep a tall image within the page height (reader.css).
            '--rd-img-ratio': width && height ? width / height : undefined,
            aspectRatio: width && height ? `${width} / ${height}` : undefined,
            maxWidth: width ? `min(100%, ${width}px)` : undefined,
          } as CSSProperties
        }
      >
        {url ? (
          <img src={url} alt={segment.alt ?? ''} width={width} height={height} draggable={false} />
        ) : failed ? (
          <span className="rd-figure-missing">
            <ImageOffIcon aria-hidden="true" />
            <span className="sr-only">{t('reader.image_unavailable')}</span>
          </span>
        ) : (
          <span className="sr-only">{segment.alt || t('reader.image')}</span>
        )}
      </div>
      {label && <figcaption>{label}</figcaption>}
    </figure>
  );
});

/** Paragraphs added when the reader scrolls near an edge of the window. */
const EXTEND = 100;
/** Playback within this many paragraphs of the window's end extends it. */
const NEAR_EDGE = 25;
/** A followed reading re-centres instead of growing past this many paragraphs. */
const MAX_WINDOW = 400;
