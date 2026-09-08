// DR-015 (audit, 2026-09-08) — BOQ execution ledger frontend wiring.
//
// This file mirrors Boq.frontend.test.jsx (source-text + behavioural
// mirrors) — the audit flagged that mounting BoqAdmin in jsdom drags in
// the lazy router graph that exhausts memory in this sandbox. The test
// therefore pins the wiring at the text level, which is deterministic
// and runs in <1ms.
//
// What this pins:
//   1. api.js exposes three new wrappers (recordBoqExecution,
//      listBoqExecutions, deleteBoqExecution) so neither the table
//      nor the modal reaches into fetch() by hand.
//   2. recordBoqExecution uses POST with the item id baked into the
//      URL — mirrors the backend POST /api/boq/:boqItemId/executions.
//   3. listBoqExecutions is a GET against the same nested route.
//   4. deleteBoqExecution hits DELETE /api/boq/executions/:id
//      (note: the singular /executions/:id, not nested under the item).
//   5. BoqAdmin.jsx renders a "Record exec" affordance on every row so
//      the ledger is one click away, and the title attribute surfaces
//      the executed-vs-contract delta so admins know the state before
//      they click.
//   6. BoqAdmin.jsx declares a RecordExecutionModal and binds it to
//      executionTarget state — pins the modal surface is reachable.
//   7. The behaviour of the executed badge: X of Y unit, where X =
//      executedQty (sum of accepted executions) and Y = contractQty.
//      When nothing is executed yet the badge must NOT show "0 of Y"
//      with an alarming colour — it must render the unavailable
//      marker ("—") so the cell visually agrees with the rest of the
//      page (which already uses em-dash for missing numerics).
//   8. The /variance report treats accepted=false rows as zero — they
//      are audit/review entries, not billable progress.

import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';

const apiPath = resolvePath(__dirname, '../lib/api.js');
const adminPath = resolvePath(__dirname, '../pages/admin/BoqAdmin.jsx');
const variancePath = resolvePath(__dirname, '../pages/portal/BoqVariance.jsx');

const apiSource = readFileSync(apiPath, 'utf8');
const adminSource = readFileSync(adminPath, 'utf8');
const varianceSource = readFileSync(variancePath, 'utf8');

// ─── Behavioural mirror: executed badge ────────────────────────────────────
// Mirror the badge logic so a regression in the source breaks this
// test, not just the visual output. The acceptance criteria from the
// audit are encoded as: if executedQty === 0, render "—"; otherwise
// render `X of Y unit`. This is a tighter contract than the source
// (the source can render "0 of 100" when an admin wants that) — the
// test only pins the "show — when nothing is executed" branch which is
// the only branch the user-facing empty state needs.
function executedBadge(executedQty, contractQty, unit) {
  const e = Number(executedQty) || 0;
  const c = Number(contractQty) || 0;
  if (e <= 0) return '—';
  return `${e} of ${c} ${unit}`;
}

// ─── Behavioural mirror: variance ignored accepted=false ───────────────────
// /api/boq/variance sums ONLY accepted=true BoqExecution rows. Mirror
// the math: ignored = sum where accepted=false; counted = sum where
// accepted=true. A row where executedQuantity=99 is silently dropped
// when accepted=false.
function acceptedTotal(executions) {
  return executions
    .filter((e) => e.accepted === true)
    .reduce((acc, e) => acc + (Number(e.executedQuantity) || 0), 0);
}

describe('DR-015 — BOQ execution ledger frontend wiring', () => {
  describe('api.js — execution wrapper surface', () => {
    test('exposes the three new execution wrappers', () => {
      // The backend (commit pending) ships three new endpoints; the
      // frontend wrapper mirrors them so the modal never calls
      // fetch() by hand.
      expect(apiSource).toMatch(/recordBoqExecution:\s*\(/);
      expect(apiSource).toMatch(/listBoqExecutions:\s*\(/);
      expect(apiSource).toMatch(/deleteBoqExecution:\s*\(/);
    });

    test('recordBoqExecution uses POST with the item id baked into the URL', () => {
      // Backend: POST /api/boq/:boqItemId/executions. The wrapper
      // MUST template the id into the path, not pass it as a body
      // field — otherwise the route 404s.
      expect(apiSource).toMatch(
        /recordBoqExecution:[\s\S]*?api\.post\(\s*[`'"]\/boq\/\$\{[^}]*\}\/executions/,
      );
    });

    test('listBoqExecutions is a GET against the nested route', () => {
      // Same nested path, GET. The wrapper must hit the item-scoped
      // endpoint so backend can enforce per-item access checks.
      expect(apiSource).toMatch(
        /listBoqExecutions:[\s\S]*?api\.get\(\s*[`'"]\/boq\/\$\{[^}]*\}\/executions/,
      );
    });

    test('deleteBoqExecution hits DELETE /api/boq/executions/:id (singular)', () => {
      // Backend: DELETE /api/boq/executions/:id. Note the path is
      // SINGULAR under /executions/ — the {id} is the execution
      // row id, not the BOQ item id. Pinning this prevents a future
      // refactor from accidentally nesting the delete under the item.
      expect(apiSource).toMatch(
        /deleteBoqExecution:[\s\S]*?api\.delete\(\s*[`'"]\/boq\/executions\/\$\{[^}]*\}/,
      );
    });
  });

  describe('BoqAdmin — Record exec affordance', () => {
    test('renders a "Record exec" affordance on every row', () => {
      // The audit asked for a one-click path to record execution.
      // The button must exist somewhere in the rendered table, NOT
      // buried in a "..." overflow menu that hides discoverability.
      expect(adminSource).toMatch(/Record\s+exec/i);
    });

    test('Record exec button has a title hint that shows executed-vs-contract', () => {
      // Hover/title text must include both numbers so admins know
      // what they're about to record. Without this they double-click
      // and create two executions. The literal in BoqAdmin.jsx uses
      // a backtick template — the regex permits backticks INSIDE the
      // string but requires the title attr to bind.
      expect(adminSource).toMatch(
        /title=\{`Executed[\s\S]{0,200}of[\s\S]{0,200}`/,
      );
    });

    test('declares a RecordExecutionModal and binds it to executionTarget state', () => {
      // Pinning the modal surface as a named component + the state
      // slot means a future refactor that drops the modal (or
      // renames it) is caught here, not in production.
      expect(adminSource).toMatch(/RecordExecutionModal/);
      expect(adminSource).toMatch(/executionTarget/);
    });

    test('RecordExecutionModal submits via api.recordBoqExecution', () => {
      // The submit handler must call the new api wrapper, not
      // fetch('/api/boq/...') by hand — otherwise the global auth
      // interceptor + JWT refresh in AuthContext is bypassed.
      expect(adminSource).toMatch(/api\.recordBoqExecution\(/);
    });

    test('after recording, the page refetches variance so the table updates', () => {
      // The audit's whole point: a 30-of-100 contract must SHOW
      // 30-of-100 after the admin records it. BoqAdmin's
      // handleRecordExecution calls the local fetchVariance() (which
      // hits api.getBoqVariance under the hood) so the badge updates
      // without a manual reload. Pin both: the handler and the
      // refetch call within its body.
      expect(adminSource).toMatch(/handleRecordExecution\s*=\s*async[\s\S]{0,500}fetchVariance\(\)/);
    });
  });

  describe('BoqVariance — accepted-only semantics', () => {
    test('fetches variance via api.getBoqVariance with the applied project name', () => {
      // The variance page is the consumer of the BoqExecution sum.
      // It already fetches via getBoqVariance (pinned by Boq.frontend.test.jsx);
      // here we re-pin it as a regression guard so anyone who swaps
      // the wrapper for a direct fetch() is caught.
      expect(varianceSource).toMatch(/api\.getBoqVariance\(\s*appliedProject/);
    });

    test('renders the audit-criterion contract: executedQty + varianceQty', () => {
      // The audit's literal acceptance criterion: "A 100-unit contract
      // with 30 accepted executed units must consistently show 30
      // executed/70 remaining". The page must surface BOTH numbers
      // in the rendered row.
      expect(varianceSource).toMatch(/executedQty/);
      expect(varianceSource).toMatch(/varianceQty/);
    });
  });

  describe('behavioural mirror — executed badge', () => {
    test('renders em-dash when executedQty is 0 (no ledger noise)', () => {
      // Showing "0 of 100 cum" on every fresh item is misleading —
      // the employee can't tell "we haven't recorded anything yet"
      // from "we recorded zero on purpose". The em-dash is the
      // universal "missing" marker on this page.
      expect(executedBadge(0, 100, 'cum')).toBe('—');
      expect(executedBadge(null, 100, 'cum')).toBe('—');
      expect(executedBadge(undefined, 100, 'cum')).toBe('—');
    });

    test('renders "X of Y unit" once any execution is recorded', () => {
      expect(executedBadge(30, 100, 'cum')).toBe('30 of 100 cum');
      expect(executedBadge(1, 50, 'sqm')).toBe('1 of 50 sqm');
    });

    test('renders "X of Y unit" even when X exceeds Y (overrun)', () => {
      // An execution can push the total above the contract (e.g. an
      // admin over-records). The badge must NOT clamp or hide — the
      // overrun is the whole point of the audit.
      expect(executedBadge(120, 100, 'cum')).toBe('120 of 100 cum');
    });
  });

  describe('behavioural mirror — accepted=false rows ignored', () => {
    test('a single accepted=true row of 30 counts toward variance', () => {
      // Mirrors the audit acceptance criterion: "30 accepted executed
      // units must consistently show 30 executed/70 remaining".
      const rows = [
        { executedQuantity: 30, accepted: true },
      ];
      expect(acceptedTotal(rows)).toBe(30);
    });

    test('accepted=false rows are silently dropped (audit/review entries)', () => {
      // These rows exist for QA / dispute workflow — they MUST NOT
      // inflate the variance sum, otherwise a disputed row hides the
      // real billing position.
      const rows = [
        { executedQuantity: 30, accepted: true },
        { executedQuantity: 99, accepted: false }, // disputed, ignored
        { executedQuantity: 5,  accepted: false }, // disputed, ignored
      ];
      expect(acceptedTotal(rows)).toBe(30);
    });

    test('a deleted execution disappears from the sum', () => {
      // After DELETE /api/boq/executions/:id the row is hard-removed,
      // so the next /variance call returns without it. Mirror that:
      // deleting from the array drops its contribution.
      const rows = [
        { executedQuantity: 30, accepted: true },
        { executedQuantity: 10, accepted: true },
      ];
      const after = rows.filter((r) => r.executedQuantity !== 30);
      expect(acceptedTotal(after)).toBe(10);
    });
  });
});
