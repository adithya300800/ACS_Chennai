// DR-012 (SOL audit 2026-09-24): DPR error recovery throws again and
// contains an unsafe success fallback.
//
// The original DprSubmit handleSubmit declared `const idempotencyKey`
// inside the createDpr-only else branch (line 1317 originally) and
// then referenced that binding from the OUTER catch (line 1373
// originally). When the resumed-edit publish branch ran instead
// (editingId set, no key minted), the catch's reference to
// `idempotencyKey` threw a ReferenceError on TDZ access — a SECOND
// exception fired before setError / setStatus('idle') / toast could
// run. The user was left with a stuck "submitting" UI and no error
// message.
//
// Additionally, the catch routed transient errors (NETWORK_ERROR /
// TIMEOUT) through a localStorage "ack found" branch that announced
// "DPR submitted successfully", cleared the user's draft, and
// navigated to /portal/dpr/my WITHOUT a server confirmation — so a
// 4xx like PHOTO_BINDING_LOST could silently look like a success.
//
// Minimal fix:
//   1. Own the idempotency key at handler scope (closure variable,
//      not module-scope), so the catch can always reference it
//      without TDZ violations.
//   2. Remove the pre-ack stamp BEFORE the POST; success is only
//      claimed on a confirmed server response.
//   3. Refactor the catch to surface an unambiguous error — no
//      success fallback.
//
// These tests pin those invariants as source-text contracts so a
// future refactor can't silently re-introduce either defect.

import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';

const dprSubmitPath = resolvePath(__dirname, '../pages/portal/DprSubmit.jsx');
const dprSubmitSrc = readFileSync(dprSubmitPath, 'utf8');

describe('DR-012 — DPR error recovery: idempotency key at handler scope, no pre-ack, no fake-success fallback', () => {
  test('1. idempotency key is declared at handler scope (closure variable, not module-scope)', () => {
    // The handler-scope `let` must be declared INSIDE handleSubmit,
    // BEFORE the `try` block, so both the create branch (which assigns
    // to it) and the catch (which references it via buildSubmitAckKey)
    // share the same binding without TDZ violations.
    expect(dprSubmitSrc).toMatch(/let\s+idempotencyKey\s*;/);
    // The declaration must precede the try block in handleSubmit, not
    // be tucked away inside the createDpr-only else branch.
    const handleSubmitMatch = dprSubmitSrc.match(/const handleSubmit = async \(submitStatus\) => \{[\s\S]*?try \{/);
    expect(handleSubmitMatch).not.toBeNull();
    const handleSubmitBody = handleSubmitMatch[0];
    expect(handleSubmitBody).toMatch(/let\s+idempotencyKey\s*;/);
  });

  test('2. the create branch ASSIGNS to the handler-scope key (does not redeclind)', () => {
    // The previous `const idempotencyKey = ...` inside the createDpr
    // else branch is gone — the create branch now assigns to the
    // existing handler-scope binding.
    const createBranch = dprSubmitSrc.match(/}\s*else\s*\{[\s\S]*?await api\.createDpr/);
    expect(createBranch).not.toBeNull();
    expect(createBranch[0]).toMatch(/^\s*idempotencyKey\s*=/m);
    expect(createBranch[0]).not.toMatch(/const\s+idempotencyKey\s*=/);
  });

  test('3. no pre-ack: setSubmitAck is never called inside handleSubmit', () => {
    // The audit forbids equating "request started" with "record
    // saved". A pre-ack stamp BEFORE the POST let the catch claim
    // success without a server confirmation. After the fix, no
    // handleSubmit code path stamps the ack flag.
    const handleSubmitMatch = dprSubmitSrc.match(/const handleSubmit = async \(submitStatus\) => \{[\s\S]*?\n  \};/);
    expect(handleSubmitMatch).not.toBeNull();
    expect(handleSubmitMatch[0]).not.toMatch(/setSubmitAck\(/);
  });

  test('4. the catch never announces fake success on a transient error', () => {
    // The previous "ackFound && isTransient" branch pushed
    // "DPR submitted successfully", cleared the draft, and navigated
    // away without a server confirmation. After the fix, the catch
    // contains no success-side navigation or draft-clearing.
    //
    // Pin the OUTER handleSubmit catch by extracting its body via the
    // matching finally clause (`submittingRef.current = false;`). The
    // outer handleSubmit is the only `} catch (err) {` followed by a
    // `finally { submittingRef.current = false; }` — inner catches
    // (in-flight upload guard, photo upload pipeline, etc.) use other
    // finally bodies. We anchor on the comment marker the fix adds
    // (`DR-012 audit fix: surface an unambiguous error`) so the regex
    // has no ambiguity.
    const catchStart = dprSubmitSrc.indexOf('DR-012 audit fix: surface an unambiguous error');
    expect(catchStart).toBeGreaterThan(-1);
    // Walk backwards to the opening `} catch (err) {` and forwards to
    // the matching `} finally {` so we cover the entire catch body.
    const catchOpen = dprSubmitSrc.lastIndexOf('} catch (err) {', catchStart);
    const finallyOpen = dprSubmitSrc.indexOf('} finally {', catchStart);
    expect(catchOpen).toBeGreaterThan(-1);
    expect(finallyOpen).toBeGreaterThan(catchStart);
    // Strip line comments so the audit-rationale prose doesn't trigger
    // the negative checks below (e.g., the comment mentions "DPR
    // submitted successfully" describing the bug, not emitting it).
    const cbRaw = dprSubmitSrc.slice(catchOpen, finallyOpen);
    const cb = cbRaw.replace(/\/\/[^\n]*/g, '');
    // No fake-success toast.
    expect(cb).not.toMatch(/DPR submitted successfully/);
    // No ackFound check.
    expect(cb).not.toMatch(/ackFound/);
    // No isTransient gate to a success branch.
    expect(cb).not.toMatch(/isTransient/);
    // No draft-clear in the error path.
    expect(cb).not.toMatch(/clearDraftForEmployee/);
    // No navigate('/portal/dpr/my') in the error path — that's the
    // success-side navigation that the audit flagged.
    expect(cb).not.toMatch(/navigate\(['"`]\/portal\/dpr\/my['"`]\)/);
    // The error path always sets the message + idle state.
    expect(cb).toMatch(/setError\(msg\)/);
    expect(cb).toMatch(/setStatus\(\s*['"]idle['"]\s*\)/);
  });

  test('5. the catch has a DR-012 audit comment block', () => {
    // The fix adds a comment block in the catch (and at the handler-
    // scope declaration) citing DR-012 so the rationale survives the
    // next refactor.
    expect(dprSubmitSrc).toMatch(/DR-012 audit fix:\s*surface an unambiguous error/);
  });
});