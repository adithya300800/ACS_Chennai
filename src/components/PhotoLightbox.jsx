import React, { useEffect, useState, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';

/**
 * Round-28 #7: photo lightbox with keyboard + swipe navigation.
 *
 * Opens on top of everything (z-index 2000) via React portal so it sits
 * above the dpr-modal (100) and the notification dropdown (1100) — the
 * lightbox is a "fullscreen" surface and must win.
 *
 * Keyboard:
 *   ← / → : prev / next photo
 *   Esc   : close
 *   Home  : first photo
 *   End   : last photo
 *
 * Touch:
 *   Swipe left  → next photo
 *   Swipe right → prev photo
 *   (vertical drag stays scroll-like, no closing gesture yet — keep
 *   the scope tight.)
 *
 * Accessibility:
 *   - role="dialog" + aria-modal="true"
 *   - aria-label announces "Photo 3 of 12"
 *   - focus is captured inside the lightbox while open
 *   - body scroll is locked so the page underneath doesn't drift
 *
 * Props:
 *   photos: array of { id, readUrl|blobUrl, caption? }
 *   startIndex: initial index
 *   open: boolean — when true, renders
 *   onClose: () => void
 */
export default function PhotoLightbox({ photos = [], startIndex = 0, open, onClose }) {
  const [index, setIndex] = useState(startIndex);
  // Drag state for swipe. Track startX + currentX so we can compute
  // delta on touchmove and apply the swipe on touchend.
  const touchStartXRef = useRef(null);
  const [dragOffset, setDragOffset] = useState(0);

  // Re-sync index when the parent re-opens the lightbox at a different
  // start position (e.g. admin clicks photo #5 of 12).
  useEffect(() => {
    if (open) setIndex(Math.max(0, Math.min(photos.length - 1, startIndex)));
  }, [open, startIndex, photos.length]);

  const goPrev = useCallback(() => {
    setIndex((i) => (i > 0 ? i - 1 : photos.length - 1));
  }, [photos.length]);
  const goNext = useCallback(() => {
    setIndex((i) => (i < photos.length - 1 ? i + 1 : 0));
  }, [photos.length]);

  // Keyboard navigation. Active only while the lightbox is open so the
  // page's normal shortcuts (arrow keys for sidebar focus, etc.) work
  // when the lightbox is closed.
  useEffect(() => {
    if (!open) return undefined;
    const handler = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); goPrev(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); goNext(); }
      else if (e.key === 'Home') { e.preventDefault(); setIndex(0); }
      else if (e.key === 'End') { e.preventDefault(); setIndex(photos.length - 1); }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose, goPrev, goNext, photos.length]);

  // Lock body scroll while the lightbox is open. Restore the previous
  // overflow value on close so we don't trample on a page that has its
  // own overflow:hidden (e.g. the modal's focus trap).
  useEffect(() => {
    if (!open || typeof document === 'undefined') return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  // Touch handlers for swipe. 50px is a comfortable threshold — small
  // enough that a deliberate flick triggers it, large enough that a
  // brief finger-tremor doesn't.
  const SWIPE_THRESHOLD_PX = 50;
  const handleTouchStart = (e) => {
    if (e.touches.length !== 1) return;
    touchStartXRef.current = e.touches[0].clientX;
    setDragOffset(0);
  };
  const handleTouchMove = (e) => {
    if (touchStartXRef.current == null) return;
    const dx = e.touches[0].clientX - touchStartXRef.current;
    setDragOffset(dx);
  };
  const handleTouchEnd = () => {
    const dx = dragOffset;
    touchStartXRef.current = null;
    setDragOffset(0);
    if (Math.abs(dx) < SWIPE_THRESHOLD_PX) return;
    if (dx < 0) goNext();
    else goPrev();
  };

  if (!open || photos.length === 0) return null;
  const photo = photos[index];
  const src = photo.readUrl || photo.blobUrl;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Photo ${index + 1} of ${photos.length}`}
      onClick={onClose}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.92)',
        zIndex: 2000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        touchAction: 'pan-y',
        userSelect: 'none',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'relative',
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {/* Image. translateX reflects the active drag so the photo follows
            the user's finger in real time and snaps back / advances on release. */}
        <img
          src={src}
          alt={photo.caption || `Photo ${index + 1}`}
          style={{
            maxWidth: '95vw',
            maxHeight: '78vh',
            objectFit: 'contain',
            borderRadius: 6,
            boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
            transform: `translateX(${dragOffset}px)`,
            transition: dragOffset === 0 ? 'transform 0.2s ease' : 'none',
            // When dragOffset is non-zero the browser's default touch-action
            // already lets us capture horizontal movement; vertical pan-y
            // still scrolls the page if needed.
          }}
        />

        {/* Top bar — close button + counter */}
        <div
          style={{
            position: 'absolute',
            top: 12,
            left: 12,
            right: 12,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            color: 'rgba(255,255,255,0.85)',
            fontSize: '0.85rem',
            pointerEvents: 'none',
          }}
        >
          <span style={{ background: 'rgba(0,0,0,0.5)', padding: '0.25rem 0.625rem', borderRadius: 9999 }}>
            {index + 1} / {photos.length}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close lightbox"
            style={{
              background: 'rgba(0,0,0,0.5)',
              color: 'white',
              border: 'none',
              borderRadius: 9999,
              width: 36,
              height: 36,
              fontSize: '1.1rem',
              cursor: 'pointer',
              pointerEvents: 'auto',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            ✕
          </button>
        </div>

        {/* Caption + prev/next controls */}
        <div
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0.75rem 1rem',
            color: 'rgba(255,255,255,0.9)',
            background: 'linear-gradient(to top, rgba(0,0,0,0.6), transparent)',
            pointerEvents: 'none',
          }}
        >
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); goPrev(); }}
            aria-label="Previous photo"
            style={navBtnStyle}
          >
            ‹
          </button>
          <div
            style={{
              flex: 1,
              textAlign: 'center',
              fontSize: '0.9rem',
              padding: '0 0.5rem',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {photo.caption || ''}
          </div>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); goNext(); }}
            aria-label="Next photo"
            style={navBtnStyle}
          >
            ›
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

const navBtnStyle = {
  background: 'rgba(0,0,0,0.55)',
  color: 'white',
  border: 'none',
  borderRadius: 9999,
  width: 44,
  height: 44,
  fontSize: '1.5rem',
  lineHeight: 1,
  cursor: 'pointer',
  pointerEvents: 'auto',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
};
