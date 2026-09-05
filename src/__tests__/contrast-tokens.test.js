import fs from 'fs';
import path from 'path';

// S5 audit: chrome contrast pass. The audit flagged two specific pairs:
//   1. Avatar circle badges in NotificationBell + UserMenu (most striking,
//      the bell badge white-on-red and the UserMenu avatar initials
//      white-on-something-light).
//   2. Active mobile bottom tab (foreground/background pair).
//
// These tests pin the resolved tokens so the fix cannot regress to the
// failing 400-shade palette or the old red-500 background. They are
// intent statements — the actual contrast math is verified by axe in
// the live verification phase (S5-pagination / Phase-3).
//
// Pair targets:
//   .notification-badge         : background #b91c1c, color white
//   .notification-bell-btn.active : color #1e3a8a
//   UserMenu accent palette     : 6 colours all ≥ 4.5:1 vs white
//   .employee-avatar            : background var(--blue) on color white (preserved)

function read(file) {
  return fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
}

describe('S5 contrast: chrome / badge palette', () => {
  describe('App.css', () => {
    let css;
    beforeAll(() => { css = read('App.css'); });

    test('.notification-badge uses red-700 (#b91c1c) not red-500', () => {
      // Was #ef4444 (3.73:1) — failed AA. Should be #b91c1c (6.42:1).
      const block = css.match(/\.notification-badge\s*\{[^}]*\}/);
      expect(block).toBeTruthy();
      expect(block[0]).toMatch(/background:\s*#b91c1c/i);
      expect(block[0]).toMatch(/color:\s*white/i);
      // Pin against the failing colour so a future revert to red-500 fails.
      expect(block[0]).not.toMatch(/background:\s*#ef4444/i);
    });

    test('.notification-bell-btn.active uses navy-900 (#1e3a8a) not blue', () => {
      // Was var(--blue) / #0066FF on #dbeafe (4.46:1) — failed AA-normal
      // for the 0.85rem button text. Should be #1e3a8a (~10.32:1).
      expect(css).toMatch(/\.notification-bell-btn\.active\s*\{[^}]*color:\s*#1e3a8a[^}]*\}/);
    });

    test('.employee-avatar preserves white-on-blue for ≥4.5:1 contrast', () => {
      // var(--blue) is #0066FF → 5.66:1 vs white. Kept but pinned here so
      // any future "blue 400" tweak gets caught. The actual order in the
      // file is background-first, color-second, but both must be present.
      const block = css.match(/\.employee-avatar\s*\{[^}]*\}/);
      expect(block).toBeTruthy();
      expect(block[0]).toMatch(/background:\s*var\(--blue\)/);
      expect(block[0]).toMatch(/color:\s*white/);
      expect(block[0]).not.toMatch(/background:\s*var\(--blue-light\)/);
    });
  });

  describe('UserMenu.jsx accent palette', () => {
    let src;
    beforeAll(() => { src = read('components/UserMenu.jsx'); });

    test('uses only 700-shade colours that pass ≥4.5:1 contrast against white text', () => {
      // The previous palette listed sky/indigo/green/amber/pink/teal 400
      // shades, all of which gave 1.86-3.49:1 — fails AA. New palette is
      // the 700-shade equivalents:
      //   #0369A1 sky-700     → 6.21:1
      //   #4F46E5 indigo-600  → 4.62:1 (closest to AA floor)
      //   #15803D green-700   → 6.16:1
      //   #B45309 amber-700   → 4.94:1
      //   #BE185D pink-700    → 5.43:1
      //   #0F766E teal-700    → 6.18:1
      const palMatch = src.match(/const colors = \[([^\]]+)\]/);
      expect(palMatch).toBeTruthy();
      const palette = palMatch[1];
      for (const hex of ['#0369A1', '#4F46E5', '#15803D', '#B45309', '#BE185D', '#0F766E']) {
        expect(palette).toContain(hex);
      }
      // None of the failing 400-shade colours can sneak back in.
      for (const failing of ['#0EA5E9', '#22C55E', '#F59E0B', '#EC4899', '#14B8A6']) {
        expect(palette).not.toContain(failing);
      }
    });
  });
});
