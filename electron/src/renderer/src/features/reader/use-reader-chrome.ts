/**
 * Auto-hiding chrome for the reading view (rules in player-chrome.ts). Only a
 * `hidden` flip re-renders: scroll accumulation and the idle timer live in refs.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { CHROME_HIDE_MS, CHROME_SHOWN, reduceChrome, type ChromeEvent } from './player-chrome';

/** A scroll this soon after a wheel/touch/key input (or a previous user scroll) is the user's. */
const USER_SCROLL_MS = 220;
const NAV_KEYS = new Set(['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' ']);

export function useReaderChrome({
  canHide,
  scroller,
  chrome,
}: {
  canHide: boolean;
  scroller: RefObject<HTMLElement | null>;
  /** Root element whose `.rd-chrome` children count as "in the chrome". */
  chrome: RefObject<HTMLElement | null>;
}) {
  const [hidden, setHidden] = useState(false);
  const state = useRef(CHROME_SHOWN);
  const hiddenRef = useRef(false);
  const canHideRef = useRef(canHide);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dispatchRef = useRef<(event: ChromeEvent) => void>(() => {});
  const arm = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (canHideRef.current && !state.current.hidden)
      timer.current = setTimeout(() => dispatchRef.current({ type: 'timeout' }), CHROME_HIDE_MS);
  }, []);
  const dispatch = useCallback(
    (event: ChromeEvent) => {
      const before = state.current.hidden;
      const next = reduceChrome(state.current, event, canHideRef.current);
      state.current = next;
      hiddenRef.current = next.hidden;
      setHidden(next.hidden);
      // Scrolls in progress do not restart the idle timer on every frame.
      if (event.type !== 'scroll' || next.hidden !== before || !timer.current) arm();
    },
    [arm],
  );
  dispatchRef.current = dispatch;

  // Paused, a sheet, an error…: show now. Playing again: hide after the delay.
  useEffect(() => {
    canHideRef.current = canHide;
    if (!canHide) dispatch({ type: 'interact' });
    else arm();
  }, [canHide, dispatch, arm]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  // User scrolls (not follow mode's programmatic ones) hide going down and show going up.
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    let inputAt = 0;
    let lastTop = element.scrollTop;
    const input = () => {
      inputAt = performance.now();
    };
    const onKey = (event: KeyboardEvent) => {
      if (NAV_KEYS.has(event.key)) input();
    };
    const onScroll = () => {
      const top = element.scrollTop;
      const dy = top - lastTop;
      lastTop = top;
      const now = performance.now();
      if (now - inputAt > USER_SCROLL_MS) return;
      // Momentum after the finger lifts keeps counting as the user's scroll.
      inputAt = now;
      dispatchRef.current({ type: 'scroll', dy });
    };
    element.addEventListener('wheel', input, { passive: true });
    element.addEventListener('touchmove', input, { passive: true });
    element.addEventListener('keydown', onKey);
    element.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      element.removeEventListener('wheel', input);
      element.removeEventListener('touchmove', input);
      element.removeEventListener('keydown', onKey);
      element.removeEventListener('scroll', onScroll);
    };
  }, [scroller]);

  // Keys anywhere, a mouse moving, or a press inside the chrome keep it up.
  useEffect(() => {
    const root = chrome.current;
    let movedAt = 0;
    const onKey = (event: KeyboardEvent) => {
      if (!['Shift', 'Control', 'Alt', 'Meta'].includes(event.key))
        dispatchRef.current({ type: 'interact' });
    };
    const onMove = (event: globalThis.PointerEvent) => {
      if (event.pointerType !== 'mouse') return;
      const now = performance.now();
      if (now - movedAt < 250) return;
      movedAt = now;
      dispatchRef.current({ type: 'interact' });
    };
    const onDown = (event: globalThis.PointerEvent) => {
      if ((event.target as Element | null)?.closest?.('.rd-chrome'))
        dispatchRef.current({ type: 'interact' });
    };
    window.addEventListener('keydown', onKey);
    root?.addEventListener('pointermove', onMove, { passive: true });
    root?.addEventListener('pointerdown', onDown, { passive: true, capture: true });
    return () => {
      window.removeEventListener('keydown', onKey);
      root?.removeEventListener('pointermove', onMove);
      root?.removeEventListener('pointerdown', onDown, { capture: true });
    };
  }, [chrome]);

  return { hidden, hiddenRef, dispatch };
}

/** Keyboard focus (not a tap's focus) inside the chrome: it must not fade under the user. */
export function useChromeFocus(root: RefObject<HTMLElement | null>): boolean {
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const update = () => {
      const active = document.activeElement;
      setFocused(
        Boolean(
          active &&
          element.contains(active) &&
          active.closest('.rd-chrome') &&
          active.matches(':focus-visible'),
        ),
      );
    };
    element.addEventListener('focusin', update);
    element.addEventListener('focusout', update);
    return () => {
      element.removeEventListener('focusin', update);
      element.removeEventListener('focusout', update);
    };
  }, [root]);
  return focused;
}
