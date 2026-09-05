// S5 audit: "loaded-vs-total + cursor next" — the admin browse view
// for DPRs (`/portal/dpr/all`) was loading with `limit: 100` and
// showing "Showing N records" with no way to know if more rows
// existed. This test pins the cursor-pagination wiring added in S5.
//
// Mount-free: DprAll imports the lazy router graph that exhausts
// memory in this sandbox (see App.test.jsx). Source-text checks below
// are deterministic and run in <1ms.

import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';

const path = resolvePath(__dirname, '../pages/portal/DprAll.jsx');
const src = readFileSync(path, 'utf8');

describe('DprAll — S5 cursor pagination', () => {
  describe('cursor state', () => {
    test('declares nextCursor + loadingMore state', () => {
      expect(src).toMatch(/const\s+\[nextCursor,\s*setNextCursor\]\s*=\s*useState\(null\)/);
      expect(src).toMatch(/const\s+\[loadingMore,\s*setLoadingMore\]\s*=\s*useState\(false\)/);
    });

    test('initial load clears nextCursor before fetching', () => {
      // A filter change must reset the cursor so the page count is
      // honest — otherwise a 50-row page from filter A could append
      // onto a partial page from filter B.
      expect(src).toMatch(/setNextCursor\(null\)/);
    });

    test('initial load reads nextCursor from the response', () => {
      expect(src).toMatch(/setNextCursor\(data\.nextCursor\s*\|\|\s*null\)/);
    });
  });

  describe('loadMore handler', () => {
    test('defines a loadMore callback gated by nextCursor + loading flags', () => {
      const fn = src.match(/const\s+loadMore\s*=\s*useCallback[\s\S]*?\}\s*,\s*\[[^\]]+\]\)/);
      expect(fn).toBeTruthy();
      expect(fn[0]).toMatch(/if\s*\(\s*!nextCursor\s*\|\|\s*loadingMore\s*\|\|\s*loading\s*\)\s*return/);
    });

    test('loadMore appends to existing dprs and updates nextCursor', () => {
      expect(src).toMatch(/setDprs\(\(prev\)\s*=>\s*\[\.\.\.prev,\s*\.\.\.\(data\.dprs\s*\|\|\s*\[\]\)\]\)/);
      expect(src).toMatch(/setNextCursor\(data\.nextCursor\s*\|\|\s*null\)/);
    });

    test('loadMore sends cursor param to backend', () => {
      expect(src).toMatch(/const\s+params\s*=\s*\{\s*limit:\s*['"]50['"]\s*,\s*cursor:\s*nextCursor\s*\}/);
    });
  });

  describe('UI affordance', () => {
    test('renders a "Load more" button when nextCursor is truthy', () => {
      // The button is only rendered when there is more to load — the
      // audit found "no way to know if more rows existed".
      expect(src).toMatch(/\{nextCursor\s*&&\s*\(/);
      expect(src).toMatch(/onClick=\{loadMore\}/);
      expect(src).toMatch(/disabled=\{loadingMore\}/);
    });

    test('footer surfaces "more available" vs "all loaded"', () => {
      expect(src).toMatch(/\{nextCursor\s*\?\s*['"]\s*·\s*more available['"]\s*:\s*['"]\s*·\s*all loaded['"]\s*\}/);
    });
  });

  describe('page-size contract', () => {
    test('initial load uses limit=50 (not the previous 100, not the backend default 20)', () => {
      // 50 is the S5 sweet spot: large enough to avoid a flood of
      // "Load more" presses on a busy month, small enough that an
      // admin browsing "All-time" still sees the affordance before
      // the page gets unwieldy.
      expect(src).toMatch(/const\s+params\s*=\s*\{\s*limit:\s*['"]50['"]\s*\}/);
    });
  });
});
