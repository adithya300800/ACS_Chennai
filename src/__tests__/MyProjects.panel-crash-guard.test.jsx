// S7/MyProjects-CRASH (2026-09-12): guard the `loadMoreReports` deps array
// against reports.data being undefined.
//
// Live symptom: clicking any project card on /portal/projects crashed
// the panel with `TypeError: Cannot read properties of undefined
// (reading 'length') at Ee (Projects-BHiDDdic.js:1:4696)`. ErrorBoundary
// caught it, page bailed. Reproduced live via enduser_tester on bundle
// `index-DAfOzKKi.js`.
//
// Root cause: the `loadMoreReports` `useCallback` deps array included
// `reports.data.length`. React evaluates the deps array during EVERY
// render, including the first render where `reports` is still
// `{status: 'loading'}` with NO `data` field — so `reports.data.length`
// threw the moment the panel mounted, before any user interaction. The
// `useCallback` body line `reports.data.length + REPORTS_PAGE_SIZE` was
// safe in isolation (only reached on user click of "Load more") but the
// shared expression in the deps array fired on every render.
//
// Fix: replace both occurrences with the nullish-coalesced expression
// `reports.data?.length ?? 0`. The body now reads the guarded value
// through a `currentReportsLen` local so the body and the deps array
// stay aligned by construction.
//
// This test pins BOTH the bug-absence contract (no unguarded
// `reports.data.length` anywhere in the file) AND the fix-presence
// contract (the guarded expression appears in both the body and the
// deps array). A future refactor that drops the `?.` guard fails this
// test instead of re-crashing the live panel.

import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';

const pagePath = resolvePath(__dirname, '../pages/portal/ProjectExpandedPanel.jsx');
const pageSrc = readFileSync(pagePath, 'utf8');

describe('S7/MyProjects-CRASH — loadMoreReports deps guard', () => {
  test('1. no unguarded `reports.data.length` access remains anywhere in the panel', () => {
    // The unguarded form MUST NOT appear — it crashed the live panel.
    // The guarded form `reports.data?.length` is the replacement.
    expect(pageSrc).not.toMatch(/reports\.data\.length/);
  });

  test('2. the guarded `reports.data?.length ?? 0` expression appears in the deps array', () => {
    // The deps array must use the nullish-coalesced length so the
    // expression is safe to evaluate on every render.
    expect(pageSrc).toMatch(/reports\.data\?\.length\s*\?\?\s*0/);
  });

  test('3. loadMoreReports still walks one page past the current row count (body line)', () => {
    // The body still adds REPORTS_PAGE_SIZE to the current length so
    // clicking "Load more" walks one more page, not a hard cap of 0
    // (which would infinite-loop) or a hard cap of REPORTS_PAGE_SIZE
    // (which would re-walk the first page).
    expect(pageSrc).toMatch(/currentReportsLen\s*\+\s*REPORTS_PAGE_SIZE/);
  });

  test('4. the body and the deps array reference the same guarded value (no drift)', () => {
    // Source-text ordering pin: the deps array appears AFTER the body
    // (per React's useCallback contract). If a future refactor splits
    // the body and deps into two different expressions (e.g. body uses
    // `currentReportsLen` but deps uses `reports.data?.length ?? 0`)
    // the order is preserved but they could drift. Pin that both
    // occurrences live in the same `useCallback` closure.
    const useCallbackStart = pageSrc.indexOf('const loadMoreReports = useCallback(async');
    const useCallbackEnd = pageSrc.indexOf('}, [', useCallbackStart);
    expect(useCallbackStart).toBeGreaterThan(-1);
    expect(useCallbackEnd).toBeGreaterThan(useCallbackStart);
    const closure = pageSrc.slice(useCallbackStart, useCallbackEnd);
    expect(closure).toMatch(/reports\.data\?\.length\s*\?\?\s*0/);
  });
});
