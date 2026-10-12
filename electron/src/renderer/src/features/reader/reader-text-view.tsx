import {
  Fragment,
  memo,
  useEffect,
  useMemo,
  useRef,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import type { ReaderSegment } from './reader-api';
import { readerPlayer } from './reader-player';
import { groupBlocks, splitWords } from './reader-text';

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
  // Paragraphs off-screen use estimated heights (content-visibility); settle after a jump.
  if (far)
    requestAnimationFrame(() => {
      const settled = element.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      scroller.scrollTop += settled - box.height * 0.28;
    });
}

/**
 * The document text. Rendered once per document; playback highlighting is
 * applied imperatively (attribute toggles, word spans only inside the active
 * sentence) so a long book never re-renders while it plays.
 */
export const ReaderTextView = memo(function ReaderTextView({
  docId,
  segments,
  active,
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
  scroller: RefObject<HTMLElement | null>;
  follow: RefObject<boolean>;
  onSeek: () => void;
  header: ReactNode;
  lang?: string;
}) {
  const article = useRef<HTMLElement>(null);
  const blocks = useMemo(() => groupBlocks(segments), [segments]);

  useEffect(() => {
    const root = article.current;
    if (!root || !active) return;
    const sentences = new Map<number, HTMLElement>();
    root.querySelectorAll<HTMLElement>('[data-seg]').forEach((element) => {
      sentences.set(Number(element.dataset.seg), element);
    });
    let sentence: HTMLElement | null = null;
    let current = -1;
    let split = -1;
    let word: HTMLElement | null = null;
    const unsplit = () => {
      if (sentence && split >= 0) sentence.textContent = segments[split]?.text ?? '';
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
    let first = true;
    const unsubscribe = readerPlayer.subscribeHighlight((segment, wordIndex) => {
      if (segment !== current) {
        sentence?.removeAttribute('data-active');
        unsplit();
        current = segment;
        sentence = sentences.get(segment) ?? null;
        sentence?.setAttribute('data-active', 'true');
        const scrollEl = scroller.current;
        // On open, jump to the saved position; afterwards follow only when asked to.
        if (sentence && scrollEl && (first ? segment > 0 : follow.current))
          scrollToSentence(scrollEl, sentence, first);
        first = false;
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
    });
    return () => {
      unsubscribe();
      sentence?.removeAttribute('data-active');
      unsplit();
    };
  }, [active, docId, segments, scroller, follow]);

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
      {header}
      {blocks.map((block) =>
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
    </article>
  );
});
