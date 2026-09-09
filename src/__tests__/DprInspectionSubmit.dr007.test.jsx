// SOL DR-007 regression coverage (round-23) for InspectionSubmit +
// DprSubmit. Source-text pin tests + a targeted contract test for the
// DprSubmit Discard→start-fresh semantics. The audit's specific
// defects are:
//
//   1. InspectionSubmit.jsx: the hydration effect stamped the draft
//      ID before awaiting its GET, then used a `cancelled` cleanup
//      flag that blocked state application even on the success path.
//      A token rotation during the GET cancelled the effect, the
//      replacement re-ran and short-circuited at the
//      lastHydratedDraftIdRef guard, and the form was stuck in create
//      mode on an explicit `?draftId=<id>` URL. The fix: replace the
//      `cancelled` flag with a monotonic hydrationRunIdRef (DprSubmit
//      pattern), and add an explicit `hydrationState` so writes can
//      refuse to proceed until the GET settles.
//
//   2. DprSubmit.jsx + InspectionSubmit.jsx: the Discard / start-fresh
//      button cleared text but retained the original edit ID, version,
//      and URL `?draftId=<id>`, so the next Save called PUT against the
//      original draft and overwrote it instead of creating a fresh
//      record. The fix: Discard detaches from the server-side draft by
//      clearing editingId, editingVersion (DPR), the acknowledged-PUT
//      ref (DPR), and the URL `?draftId=<id>` parameter.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const INSPECTION_PATH = resolve(__dirname, '../pages/portal/InspectionSubmit.jsx');
const DPR_PATH = resolve(__dirname, '../pages/portal/DprSubmit.jsx');

const readSource = (path) => readFileSync(path, 'utf8');

describe('SOL DR-007 — InspectionSubmit hydration run-id (replaces cancelled flag)', () => {
  const src = readSource(INSPECTION_PATH);

  test('declares hydrationRunIdRef next to lastHydratedDraftIdRef', () => {
    // The new ref is the cornerstone of the fix — a monotonic counter
    // whose increment signals a fresh hydration attempt. The closure
    // captured by the in-flight IIFE checks this against its own
    // captured runId to decide whether to apply state.
    expect(src).toMatch(/const\s+hydrationRunIdRef\s*=\s*useRef\(\s*0\s*\)/);
  });

  test('drops the legacy `cancelled` cleanup flag in the hydration effect', () => {
    // The pre-DR-007 pattern: `let cancelled = false; ... if (cancelled)
    // return; ... return () => { cancelled = true; };`. The success-path
    // `if (cancelled) return` is what made token rotation strand the
    // form in create mode. We replace it with a runId check inside the
    // IIFE; the cleanup function (if any) no longer needs a flag.
    //
    // Slice the hydration effect out of the file by anchoring on its
    // trailing dep array `[draftId, accessToken, toast, navigate, ...]`
    // — no other effect in this file uses that exact shape (the Retry
    // control added `hydrationNonce` later, so we accept any trailing
    // suffix).
    const hydrationIdx = src.search(/\},\s*\[draftId,\s*accessToken,\s*toast,\s*navigate[\s\S]*?\]\);/);
    expect(hydrationIdx).toBeGreaterThan(0);
    // Walk backwards to the matching opening `useEffect(() => {`.
    const head = src.lastIndexOf('useEffect(() => {', hydrationIdx);
    expect(head).toBeGreaterThan(0);
    const block = src.slice(head, hydrationIdx);
    // Sanity: this is the hydration effect (setEditingId is set in it).
    expect(block).toMatch(/api\.getInspection\(draftId/);
    // The hydration IIFE itself must NOT declare or check a `cancelled`
    // local — that's the pre-fix pattern. Without the cancelled flag
    // the closure's results apply when its runId is still the latest.
    expect(block).not.toMatch(/let\s+cancelled\s*=\s*false/);
    expect(block).not.toMatch(/if\s*\(\s*cancelled\s*\)\s*return/);
    // And it must contain the new runId pattern (sanity).
    expect(block).toMatch(/hydrationRunIdRef\.current\s*!==\s*myRunId/);
  });

  test('uses `hydrationRunIdRef.current !== myRunId` instead of `cancelled`', () => {
    // The runId check appears at least twice in the hydration effect:
    // once on the success path and once in the catch block. Either one
    // alone leaves the other branch unprotected.
    const runIdChecks = src.match(/hydrationRunIdRef\.current\s*!==\s*myRunId/g) || [];
    expect(runIdChecks.length).toBeGreaterThanOrEqual(2);
  });

  test('declares hydrationState + hydrationError with idle/loading/loaded/error modes', () => {
    // The four modes are required so Save/Submit can block writes
    // when the GET is still in-flight or has failed.
    expect(src).toMatch(/useState\('idle'\)/);
    expect(src).toMatch(/setHydrationState\('loading'\)/);
    expect(src).toMatch(/setHydrationState\('loaded'\)/);
    expect(src).toMatch(/setHydrationState\('error'\)/);
  });

  test('handleSubmit refuses to write while hydration is in-flight on a draft URL', () => {
    // The writes-blocking guard is the second half of DR-007: without
    // it, a fast click on Save during the GET races — editingId is
    // still null, the handler falls through to createInspection, and
    // the user ends up with a brand-new record on top of the one they
    // explicitly asked to Resume.
    const guardMatch = src.match(/if\s*\(\s*draftId\s*&&\s*hydrationState\s*===\s*'loading'\s*\)\s*\{[\s\S]*?return\s*;\s*\}/);
    expect(guardMatch).not.toBeNull();
    const errorGuardMatch = src.match(/if\s*\(\s*draftId\s*&&\s*hydrationState\s*===\s*'error'\s*\)\s*\{[\s\S]*?return\s*;\s*\}/);
    expect(errorGuardMatch).not.toBeNull();
  });

  test('handleDiscardDraft detaches from the server-side draft', () => {
    // The pre-DR-007 handler cleared form fields but kept editingId
    // and the URL `?draftId=<id>`, so the next Save was a PUT against
    // the original draft. The fix detaches via setEditingId(null),
    // clears the hydration ref, and strips `draftId` from the URL.
    const discardMatch = src.match(/const handleDiscardDraft\s*=\s*\(\)\s*=>\s*\{[\s\S]*?toast\.push\('Draft discarded\./);
    expect(discardMatch).not.toBeNull();
    expect(discardMatch[0]).toMatch(/setEditingId\(null\)/);
    expect(discardMatch[0]).toMatch(/lastHydratedDraftIdRef\.current\s*=\s*null/);
    expect(discardMatch[0]).toMatch(/setSearchParams/);
    expect(discardMatch[0]).toMatch(/next\.delete\(['"]draftId['"]\)/);
  });

  test('declares hydrationNonce state and Retry handler to recover from a failed GET', () => {
    // The audit's "smallest complete fix" requires allow Retry on a
    // failed hydration. We model this with a nonce the hydration
    // effect depends on so bumping it re-fires the GET.
    expect(src).toMatch(/const\s+\[hydrationNonce,\s*setHydrationNonce\]\s*=\s*useState\(\s*0\s*\)/);
    expect(src).toMatch(/const handleRetryHydration\s*=\s*\(\)\s*=>\s*\{[\s\S]*?setHydrationNonce\(/);
    // The effect's dep array must include hydrationNonce — without it,
    // bumping the nonce is a no-op and the Retry button does nothing.
    expect(src).toMatch(/},\s*\[draftId,\s*accessToken,\s*toast,\s*navigate,\s*hydrationNonce\]\);/);
    // The Retry button must render when in 'error' state. Look for
    // the data-testid so future copy edits don't break the pin.
    expect(src).toMatch(/dr007-retry-hydration/);
    expect(src).toMatch(/dr007-hydration-error/);
  });
});

describe('SOL DR-007 — DprSubmit Discard/start-fresh semantics', () => {
  const src = readSource(DPR_PATH);

  test('handleDiscardDraft clears editingId + editingVersion on server-side drafts', () => {
    // Pre-DR-007 the handler only reset local form state. Save still
    // routed through `if (editingId) { api.updateDpr(editingId, ...) }`
    // and PUT-overwrote the original record.
    const discardMatch = src.match(/const handleDiscardDraft\s*=\s*\(\)\s*=>\s*\{[\s\S]*?toast\.push\('Draft discarded\./);
    expect(discardMatch).not.toBeNull();
    expect(discardMatch[0]).toMatch(/setEditingId\(null\)/);
    expect(discardMatch[0]).toMatch(/setEditingVersion\(null\)/);
  });

  test('handleDiscardDraft clears the acknowledged-PUT ref so it does not leak across sessions', () => {
    // Without this, a stale value from the prior session's PUT could
    // cause the next Submit's GET to short-circuit and skip the
    // version reconciliation step.
    const discardMatch = src.match(/const handleDiscardDraft\s*=\s*\(\)\s*=>\s*\{[\s\S]*?toast\.push\('Draft discarded\./);
    expect(discardMatch).not.toBeNull();
    expect(discardMatch[0]).toMatch(/lastPutVersionRef\.current\s*=\s*null/);
  });

  test('handleDiscardDraft strips `draftId` from the URL on server-side drafts', () => {
    // After Discard the page should no longer claim to be editing the
    // original draft — the URL must drop the query parameter so a
    // future Refresh doesn't try to re-hydrate the discarded session.
    const discardMatch = src.match(/const handleDiscardDraft\s*=\s*\(\)\s*=>\s*\{[\s\S]*?toast\.push\('Draft discarded\./);
    expect(discardMatch).not.toBeNull();
    expect(discardMatch[0]).toMatch(/setSearchParams/);
    expect(discardMatch[0]).toMatch(/next\.delete\(['"]draftId['"]\)/);
  });

  test('handleDiscardDraft invalidates the hydration ref so the same URL re-fetches if revisited', () => {
    // The audit acceptance: a future navigation back to the original
    // ?draftId=<id> URL must re-fetch — i.e. the ref guard at the top
    // of the hydration effect must allow a fresh run.
    const discardMatch = src.match(/const handleDiscardDraft\s*=\s*\(\)\s*=>\s*\{[\s\S]*?toast\.push\('Draft discarded\./);
    expect(discardMatch).not.toBeNull();
    expect(discardMatch[0]).toMatch(/lastHydratedDraftIdRef\.current\s*=\s*null/);
  });
});
