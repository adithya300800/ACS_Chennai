import { useEffect } from 'react';

// B-09 / D-07 (round-17): traps Tab / Shift+Tab inside `ref` while `active`
// is true. Used by PortalLayout when the mobile drawer is open.
//
// Implementation notes:
// - Stores the previously-focused element on activation so we can restore
//   focus when the trap releases. This matters for modals/drawers that
//   open from a specific trigger — without restoration the focus would
//   land on <body> and the user loses context.
// - The focus querySelector is intentionally scoped to the ref's subtree
//   so embedded iframes / portals don't grab the tab loop.

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export default function useFocusTrap(ref, active) {
  useEffect(() => {
    if (!active || !ref?.current) return undefined;
    const root = ref.current;

    const previouslyFocused = document.activeElement;

    // Move focus to the first focusable element on activation. Falls back
    // to the container itself if it has no focusable descendants.
    const firstFocusable = root.querySelector(FOCUSABLE);
    (firstFocusable || root).focus({ preventScroll: true });

    function handleKeyDown(e) {
      if (e.key !== 'Tab') return;
      const focusables = Array.from(root.querySelectorAll(FOCUSABLE)).filter(
        (el) => !el.hasAttribute('disabled') && el.offsetParent !== null
      );
      if (focusables.length === 0) {
        // No tabbable elements inside — keep focus on the container.
        e.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    root.addEventListener('keydown', handleKeyDown);
    return () => {
      root.removeEventListener('keydown', handleKeyDown);
      // Restore focus to whatever opened the trap.
      if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
        previouslyFocused.focus({ preventScroll: true });
      }
    };
  }, [ref, active]);
}
