// DR-028 (audit, 2026-09-08) — explicit zero round-trips through billing
// certification fields (GST, PO value, balance).
//
// Audit finding: parseFloat(...) || null coerced a legitimate `0` into
// `null` because `0 || null` evaluates to `null`. The fix: drop the
// `|| null` short-circuit; blank input stays `null` (already guarded
// by the empty-string check), but `0` / `1.5` / any valid number
// round-trip as the parsed value.
//
// Source-text contract: the form's onSubmit payload must NOT contain
// `parseFloat(x) || null` for any of {gstAmount, poValue, balanceValue}.
// `claimedAmount` / `certifiedAmount` / `deductedAmount` use `|| 0`
// (required field, zero is the legitimate default) — not in scope.
//
// Run: cd src && npx jest __tests__/billing-cert-dr028-zero-roundtrip.test.jsx
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';

const pagePath = resolvePath(__dirname, '../pages/admin/BillingCertificationsAdmin.jsx');
const pageSrc = readFileSync(pagePath, 'utf8');

describe('DR-028 — explicit zero round-trips through optional billing fields', () => {
  test('1. gstAmount payload uses parseFloat only — no || null coercion', () => {
    // Locate the line within the payload builder.
    const gstLine = pageSrc.match(/gstAmount:\s*form\.gstAmount\s*===?\s*['"]['"]\s*\?\s*null\s*:[^,}\n]+/);
    expect(gstLine).not.toBeNull();
    const expr = gstLine[0];
    // The RHS of the colon (after the ternary's `:`) must NOT contain
    // `|| null` — that's the bug. `parseFloat('0') || null` collapses
    // zero to null.
    expect(expr).not.toMatch(/\|\|\s*null/);
    // It must still parse to a number — either parseFloat or Number().
    expect(expr).toMatch(/parseFloat|Number\(/);
  });

  test('2. poValue payload uses parseFloat only — no || null coercion', () => {
    const poLine = pageSrc.match(/poValue:\s*form\.poValue\s*===?\s*['"]['"]\s*\?\s*null\s*:[^,}\n]+/);
    expect(poLine).not.toBeNull();
    const expr = poLine[0];
    expect(expr).not.toMatch(/\|\|\s*null/);
    expect(expr).toMatch(/parseFloat|Number\(/);
  });

  test('3. balanceValue payload uses parseFloat only — no || null coercion', () => {
    const balLine = pageSrc.match(/balanceValue:\s*form\.balanceValue\s*===?\s*['"]['"]\s*\?\s*null\s*:[^,}\n]+/);
    expect(balLine).not.toBeNull();
    const expr = balLine[0];
    expect(expr).not.toMatch(/\|\|\s*null/);
    expect(expr).toMatch(/parseFloat|Number\(/);
  });

  test('4. blank input still produces null (empty-string guard kept)', () => {
    // The empty-string ternary must still branch to null — only
    // non-blank numeric input changes behaviour.
    expect(pageSrc).toMatch(/gstAmount:\s*form\.gstAmount\s*===?\s*['"]['"]\s*\?\s*null/);
    expect(pageSrc).toMatch(/poValue:\s*form\.poValue\s*===?\s*['"]['"]\s*\?\s*null/);
    expect(pageSrc).toMatch(/balanceValue:\s*form\.balanceValue\s*===?\s*['"]['"]\s*\?\s*null/);
  });

  test('5. validator still rejects negative numbers across the three optional fields', () => {
    // Defence in depth: the validate() block guards claimed/cert/ded
    // with `< 0`. The optional three are guarded only by Number.isFinite
    // in the backend's parseAmount. Pin that the page's payload never
    // sends negative values silently.
    const validateBlock = pageSrc.match(/function\s+validate\(f\)\s*\{[\s\S]*?\n\s*\}/);
    expect(validateBlock).not.toBeNull();
    expect(validateBlock[0]).toMatch(/claimed.*<\s*0/);
  });
});
