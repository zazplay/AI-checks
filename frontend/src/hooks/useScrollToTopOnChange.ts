import { useEffect, useRef } from 'react';

/**
 * Offset (px) to leave above the scroll anchor so it clears the sticky header
 * (AppShell.Header height is 56) plus a little breathing room. Shared by every
 * `useScrollToTopOnChange` anchor.
 */
export const SCROLL_ANCHOR_OFFSET = 64;

/**
 * Scroll the returned anchor element into view whenever `dep` *actually changes*
 * (e.g. the current page number). Anchors at the top of a list so flipping pages
 * brings the user back to the start instead of leaving them mid-scroll.
 *
 * It tracks the previous `dep` value rather than a "first run" flag, so it never
 * fires on mount — and, crucially, survives React 18 StrictMode's
 * mount→unmount→remount cycle, where a `firstRun` ref would already be cleared
 * by the second mount and scroll on plain load. Honors `prefers-reduced-motion`
 * (jumps instantly instead of smooth-scrolling). `scrollIntoView` finds the real
 * scroll container itself, so it works whether the page scrolls the window or an
 * inner AppShell.Main.
 */
export function useScrollToTopOnChange(dep: unknown) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const prevDep = useRef(dep);

  useEffect(() => {
    if (prevDep.current === dep) return;
    prevDep.current = dep;
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    anchorRef.current?.scrollIntoView({
      block: 'start',
      behavior: reduceMotion ? 'auto' : 'smooth',
    });
  }, [dep]);

  return anchorRef;
}
