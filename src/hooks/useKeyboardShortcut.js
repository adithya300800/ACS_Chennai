import { useEffect } from 'react';

// B-07 (round-17): register a single global keyboard shortcut while the
// component is mounted. Used by PortalLayout for Shift+A → Attendance.
//
// `key`: case-insensitive single character ("a", "Escape", etc.). "Escape"
// is normalized to "Escape" so callers can pass either "Escape" or "esc".
// `modifiers`: array subset of ["Shift", "Control", "Alt", "Meta"].
// `handler`: called with the KeyboardEvent when matched. `event.defaultPrevented`
// is respected so a focused input that already swallowed the key isn't
// re-handled globally.
//
// Skips firing while the user is typing in an input/textarea/contenteditable.

const EDITABLE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

function isEditableTarget(target) {
  if (!target) return false;
  if (EDITABLE_TAGS.has(target.tagName)) return true;
  if (target.isContentEditable) return true;
  return false;
}

function normalizeKey(k) {
  if (!k) return k;
  if (k.length === 1) return k.toLowerCase();
  return k; // "Escape", "Tab", etc.
}

export default function useKeyboardShortcut({ key, modifiers = [], handler }) {
  useEffect(() => {
    if (!handler) return undefined;
    const want = normalizeKey(key);
    const wantMods = new Set(modifiers);

    function onKeyDown(e) {
      if (e.defaultPrevented) return;
      if (want === 'Escape' && isEditableTarget(e.target)) return; // don't fight form inputs
      if (want !== 'Escape' && isEditableTarget(e.target)) return;
      if (e.key !== want && e.key.toLowerCase() !== want) return;
      const mods = new Set();
      if (e.shiftKey) mods.add('Shift');
      if (e.ctrlKey) mods.add('Control');
      if (e.altKey) mods.add('Alt');
      if (e.metaKey) mods.add('Meta');
      if (mods.size !== wantMods.size) return;
      for (const m of wantMods) if (!mods.has(m)) return;
      e.preventDefault();
      handler(e);
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [key, modifiers, handler]);
}
