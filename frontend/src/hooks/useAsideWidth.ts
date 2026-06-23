import { useCallback, useEffect, useRef, useState } from 'react';

const STORAGE_KEY = 'invoice-system.aside-width';
const DEFAULT_WIDTH = 420;
export const MIN_WIDTH = 320;
const MAX_FRACTION = 0.9; // never let a drag cover more than 90% of the viewport

const maxDragWidth = () => Math.max(MIN_WIDTH, Math.round(window.innerWidth * MAX_FRACTION));

function clamp(w: number): number {
  return Math.min(maxDragWidth(), Math.max(MIN_WIDTH, w));
}

function readStored(): number {
  const raw = Number(localStorage.getItem(STORAGE_KEY));
  return Number.isFinite(raw) && raw >= MIN_WIDTH ? clamp(raw) : DEFAULT_WIDTH;
}

/**
 * Width controller for the assistant panel, designed to be JITTER-FREE.
 *
 * The core trick: during a drag we DO NOT call setState per pointer move (that
 * re-renders the whole AppShell on every pixel and fights the CSS transition).
 * Instead we write the live width straight to a CSS variable on a ref'd element
 * inside a requestAnimationFrame, so dragging is pure DOM and silky. React state
 * is updated only ONCE, on pointer-up — that's also when the value is persisted.
 *
 * `expanded` is a separate boolean for full-screen (100vw) mode; it never
 * touches the remembered drag width, so collapsing restores it exactly.
 *
 * Usage:
 *   const a = useAsideWidth();
 *   <AppShell aside={{ width: a.expanded ? '100vw' : a.width }} />
 *   <Box ref={a.panelRef} /> // the element whose width var is live-updated
 *   <div onPointerDown={a.startResize} /> // the drag handle
 */
export function useAsideWidth() {
  const [width, setWidth] = useState<number>(readStored);
  const [expanded, setExpanded] = useState(false);
  // The committed width is mirrored in a ref so drag math doesn't need state.
  const widthRef = useRef(width);
  // The AppShell aside DOM node — we set its width directly during a drag.
  const panelRef = useRef<HTMLElement | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    widthRef.current = width;
  }, [width]);

  // Re-clamp on window resize (but only when not full-screen).
  useEffect(() => {
    const onResize = () => {
      if (expanded) return;
      setWidth((w) => clamp(w));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [expanded]);

  const startResize = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      if (expanded) setExpanded(false);

      const panel = panelRef.current;
      let live = widthRef.current;

      const apply = () => {
        rafRef.current = null;
        // Drive the panel width directly — no React render, no transition fight.
        if (panel) panel.style.width = `${live}px`;
      };

      const onMove = (ev: PointerEvent) => {
        // Panel is anchored to the right edge; width = viewportRight - pointerX.
        live = clamp(window.innerWidth - ev.clientX);
        if (rafRef.current == null) rafRef.current = requestAnimationFrame(apply);
      };
      const onUp = () => {
        if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.body.removeAttribute('data-aside-dragging');
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        // Commit once: update React state + persist. The inline style is cleared
        // so the controlled AppShell width takes back over cleanly.
        if (panel) panel.style.width = '';
        widthRef.current = live;
        setWidth(live);
        localStorage.setItem(STORAGE_KEY, String(live));
      };

      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      document.body.setAttribute('data-aside-dragging', 'true');
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [expanded],
  );

  const toggleExpand = useCallback(() => setExpanded((v) => !v), []);

  return { width, expanded, startResize, toggleExpand, panelRef };
}
