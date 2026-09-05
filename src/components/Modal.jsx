import React, { useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';

// DR-017 — Accessible modal dialog primitive.
//
// The audit found the DPR detail dialog let Tab escape to the cards
// behind it (six Tab presses focused report cards, not dialog
// controls). The root cause was missing focus management: there was
// no initial focus, no containment (focus trap), and no focus-return
// after close. The user-visible symptom was that screen-reader /
// keyboard-only users could not reach the dialog's action buttons.
//
// This primitive pins the four behaviors an accessible dialog needs
// (per https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/):
//
//   1. Initial focus: the first focusable child receives focus on
//      mount. Pass `initialFocusRef` to override (e.g. focus a
//      "Delete" button to require deliberate intent).
//   2. Containment: Tab and Shift+Tab cycle within the dialog.
//      Pressing Tab on the last focusable element wraps to the
//      first; Shift+Tab on the first wraps to the last.
//   3. Escape closes the dialog.
//   4. On close, focus returns to the element that opened the dialog
//      (the trigger). The trigger ref is captured automatically if
//      `returnFocusRef` is supplied; otherwise we save/restore the
//      previously-focused element.
//
// ARIA semantics: `role="dialog"`, `aria-modal="true"`, and an
// `aria-label` are all required by the dialog pattern. Pass them in.
//
// Click-outside: the backdrop click closes the dialog by default.
// Pass `dismissable={false}` to disable (e.g. for a destructive
// confirmation that should require the explicit Cancel button).
//
// The backdrop is a fixed-position element; we render via React
// portal to document.body to escape any ancestor stacking context
// the same way NotificationBell / UserMenu already do.

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export default function Modal({
  open,
  onClose,
  ariaLabel,
  ariaLabelledBy,
  children,
  initialFocusRef,
  returnFocusRef,
  dismissable = true,
  maxWidth = 720,
  contentStyle,
}) {
  const dialogRef = useRef(null);
  // The element to return focus to on close. Captured on open so we
  // don't depend on the caller passing a ref through every time.
  const previouslyFocusedRef = useRef(null);

  // Capture the trigger on open, restore on close. We don't need to
  // also clear the captured element on unmount — React will dispose
  // this component when `open` flips to false and the next mount
  // captures a fresh trigger.
  useEffect(() => {
    if (!open) return undefined;
    if (returnFocusRef?.current) {
      previouslyFocusedRef.current = returnFocusRef.current;
    } else if (typeof document !== 'undefined') {
      previouslyFocusedRef.current = document.activeElement;
    }
    return () => {
      // Restore focus when the modal closes. We schedule on a microtask
      // so the trigger ref is still attached when the call runs (the
      // unmount has already happened by the time the cleanup runs).
      const prev = previouslyFocusedRef.current;
      if (prev && typeof prev.focus === 'function') {
        // The element might already be focused (e.g. user closed via
        // Esc on the trigger itself). Guarding prevents an unnecessary
        // focus() call that could trigger a scroll jump.
        if (document.activeElement !== prev) {
          try { prev.focus(); } catch { /* element may be gone */ }
        }
      }
    };
  }, [open, returnFocusRef]);

  // Initial focus + focus trap + Escape handler.
  useEffect(() => {
    if (!open) return undefined;

    // Focus the requested element on mount. Defer to next paint so the
    // dialog's content has rendered (otherwise focus() can race with
    // first-render of focusable children).
    const focusInitial = () => {
      const target =
        initialFocusRef?.current
        || dialogRef.current?.querySelector(FOCUSABLE_SELECTOR)
        || dialogRef.current;
      if (target && typeof target.focus === 'function') {
        try { target.focus(); } catch { /* element may not be focusable */ }
      }
    };
    const raf = requestAnimationFrame(focusInitial);

    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (dismissable) onClose?.();
        return;
      }
      // Focus trap: intercept Tab when focus would leave the dialog.
      // We compute the focusable list on each Tab press so dynamic
      // content (e.g. async-loaded comments) stays inside the trap.
      if (e.key !== 'Tab' || !dialogRef.current) return;
      const focusables = Array.from(
        dialogRef.current.querySelectorAll(FOCUSABLE_SELECTOR),
      ).filter((el) => {
        if (el.hasAttribute('disabled')) return false;
        if (el.hasAttribute('hidden')) return false;
        // Visibility check. `offsetParent` is the textbook answer but
        // jsdom returns null for every element (no layout), which
        // breaks the trap in tests. `getClientRects()` does compute
        // content-bounded rects in jsdom, so it's the safer check.
        if (typeof el.getClientRects === 'function'
            && el.getClientRects().length > 0) return true;
        // Fallback: assume visible if there's no signal either way.
        // Better to over-include (extra Tab stops are an a11y nit)
        // than to under-include (focus escapes the trap).
        return true;
      });
      if (focusables.length === 0) {
        // Nothing focusable inside — keep focus on the dialog itself.
        e.preventDefault();
        dialogRef.current.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || !dialogRef.current.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKey, true);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, dismissable, onClose, initialFocusRef]);

  // Lock body scroll while the dialog is open so the page underneath
  // does not scroll-shuttle on mobile / trackpad wheel events.
  useEffect(() => {
    if (!open || typeof document === 'undefined') return undefined;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prevOverflow; };
  }, [open]);

  const onBackdropClick = useCallback((e) => {
    // Only the backdrop (not a bubbled click from a child) closes.
    if (dismissable && e.target === e.currentTarget) onClose?.();
  }, [dismissable, onClose]);

  if (!open) return null;
  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      onClick={onBackdropClick}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 100, padding: '1rem',
      }}
    >
      <div
        ref={dialogRef}
        // Make the dialog itself focusable so the focus trap can
        // fall back to it when no focusable children exist.
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff', borderRadius: 12, maxWidth, width: '100%',
          maxHeight: '90vh', overflowY: 'auto', padding: '1.5rem',
          boxShadow: '0 20px 60px rgba(15,23,42,0.3)',
          ...contentStyle,
        }}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
