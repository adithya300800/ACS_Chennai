import { useEffect, useRef, useState, useCallback } from 'react';

/**
 * Round-28 #6: pull-to-refresh hook.
 *
 * Fires `onRefresh` when the user touches the top of the document and
 * drags down past a threshold, then releases. Standard mobile pattern
 * that field engineers on a Chennai site expect in 2026 — manually
 * hunting a refresh icon while standing in sun and dust is friction.
 *
 * Constraints:
 *   - Only fires when `window.scrollY === 0` (page is already at top).
 *   - Only fires on coarse-pointer devices (touch). Mouse-wheel "refresh"
 *     on desktop would be wrong.
 *   - Suppresses the native overscroll pull-to-refresh (Android Chrome
 *     shows its own chrome if we don't `preventDefault`). We DO NOT
 *     preventDefault on touchmove unconditionally — that breaks scroll.
 *     Instead, we preventDefault only while a pull is in progress.
 *   - Visual feedback: a small "Release to refresh" indicator that drops
 *     down from the top with the user's drag distance, then snaps back
 *     on refresh-complete.
 *   - Touchstart registers only when not currently pulling; pulls in
 *     progress don't double-fire.
 *
 * Returns:
 *   - { pullDistance, isRefreshing } — visual state for the caller to
 *     render the indicator overlay (caller's responsibility).
 *
 * Usage:
 *   const { pullDistance, isRefreshing } = usePullToRefresh(async () => {
 *     await reload();
 *   });
 */
export default function usePullToRefresh(onRefresh) {
  const startYRef = useRef(null);
  const pullingRef = useRef(false);
  const [pullDistance, setPullDistance] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const THRESHOLD = 70;       // px of pull that triggers refresh
  const MAX_PULL = 140;       // px — clamp visual feedback so it doesn't
                              // yank the whole page when the user drags hard

  // Stable ref to onRefresh so the listener doesn't capture a stale closure.
  const onRefreshRef = useRef(onRefresh);
  useEffect(() => { onRefreshRef.current = onRefresh; }, [onRefresh]);

  const finishRefresh = useCallback(() => {
    setIsRefreshing(false);
    setPullDistance(0);
    pullingRef.current = false;
    startYRef.current = null;
  }, []);

  useEffect(() => {
    // Only wire touch listeners on touch-capable viewports.
    if (typeof window === 'undefined') return undefined;
    const isCoarsePointer = window.matchMedia('(pointer: coarse)').matches;
    if (!isCoarsePointer) return undefined;

    const handleTouchStart = (e) => {
      // Only register when the page is scrolled to the very top.
      if (window.scrollY > 0 || isRefreshing) return;
      // Only one finger — two-finger gestures are pinch / scroll elsewhere.
      if (e.touches.length !== 1) return;
      startYRef.current = e.touches[0].clientY;
      pullingRef.current = false;
    };

    const handleTouchMove = (e) => {
      if (startYRef.current == null) return;
      const dy = e.touches[0].clientY - startYRef.current;
      if (dy <= 0) {
        // User is scrolling up — let normal scroll happen.
        return;
      }
      // User is pulling DOWN at scroll-top. Only kick into "pulling"
      // mode past a small dead-zone (5px) so taps and tiny movements
      // don't trigger the overlay.
      if (!pullingRef.current && dy > 5) {
        pullingRef.current = true;
      }
      if (!pullingRef.current) return;
      // While pulling, suppress the native overscroll glow + page bounce.
      if (e.cancelable) e.preventDefault();
      // Apply a resistance curve so a 200px drag feels like ~100px —
      // keeps the visual feedback in a sane band.
      const damped = Math.min(MAX_PULL, dy * 0.5);
      setPullDistance(damped);
    };

    const handleTouchEnd = async () => {
      if (!pullingRef.current) {
        startYRef.current = null;
        return;
      }
      const dy = pullDistance;
      pullingRef.current = false;
      startYRef.current = null;
      if (dy < THRESHOLD) {
        // Released before threshold — snap back.
        setPullDistance(0);
        return;
      }
      // Trigger refresh. Snap the indicator to the threshold so the user
      // sees a stable "refreshing" state until onRefresh resolves.
      setPullDistance(THRESHOLD);
      setIsRefreshing(true);
      try {
        await onRefreshRef.current?.();
      } catch {
        // Caller is responsible for surfacing refresh failures via toast.
        // We still finish the indicator either way.
      } finally {
        finishRefresh();
      }
    };

    // Use passive: false on touchmove so we can preventDefault during pull.
    document.addEventListener('touchstart', handleTouchStart, { passive: true });
    document.addEventListener('touchmove', handleTouchMove, { passive: false });
    document.addEventListener('touchend', handleTouchEnd, { passive: true });
    document.addEventListener('touchcancel', handleTouchEnd, { passive: true });
    return () => {
      document.removeEventListener('touchstart', handleTouchStart);
      document.removeEventListener('touchmove', handleTouchMove);
      document.removeEventListener('touchend', handleTouchEnd);
      document.removeEventListener('touchcancel', handleTouchEnd);
    };
    // isRefreshing is captured by handleTouchEnd's `if (startYRef.current
    // == null) return` guard via the touchStart handler; intentionally not
    // a dep here so the listeners don't churn every state change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finishRefresh]);

  return { pullDistance, isRefreshing };
}
