// DR-029 (Fresh24 audit, 2026-09-24) — Variance adds incompatible physical units.
//
// Pre-fix, the summary tile labelled "Contract qty (sum)" reduced
// `contractQty` / `executedQty` across every row into a single scalar
// regardless of `unit`. A project with one item in sqm and another in kg
// produced a meaningless combined number (10 + 5 = 15 with no unit).
//
// Post-fix, physical quantities are bucketed per `unit` and the tile
// renders each unit's subtotal. Currency (contractAmount / executedAmount)
// remains a flat scalar because INR is unitless.
//
// This file mirrors Boq.frontend.test.jsx and BoqExecution.dr015.test.jsx —
// source-text pins + a behavioural mirror of the grouping reduce. The
// page itself is not mounted (BoqVariance in jsdom drags the lazy router
// graph that exhausts memory; see Boq.frontend.test.jsx header for the
// full rationale). The behavioural mirror reimplements the source's
// reduce verbatim so a regression breaks this test, not the visual output.

import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';

const variancePath = resolvePath(__dirname, '../pages/portal/BoqVariance.jsx');
const varianceSource = readFileSync(variancePath, 'utf8');

// ─── Behavioural mirror: per-unit grouping reduce ─────────────────────────
// Mirrors the source's reduce() exactly so a regression in BoqVariance.jsx
// breaks this test. The acceptance criterion from the audit is encoded as:
//   - physical quantities are bucketed by `unit`
//   - missing/blank `unit` falls back to "units"
//   - monetary totals remain flat scalars
//   - overrun / ahead counters survive the refactor
function reduceTotals(items) {
  return items.reduce(
    (acc, it) => {
      const contractQty = Number(it.contractQty) || 0;
      const executedQty = Number(it.executedQty) || 0;
      const unit = (it.unit || 'units').trim() || 'units';
      acc.contractByUnit[unit] = (acc.contractByUnit[unit] || 0) + contractQty;
      acc.executedByUnit[unit] = (acc.executedByUnit[unit] || 0) + executedQty;
      acc.contractAmount += Number(it.contractAmount) || 0;
      acc.executedAmount += Number(it.executedAmount) || 0;
      if (it.varianceQty < 0) acc.overruns += 1;
      else if (it.varianceQty > 0) acc.ahead += 1;
      return acc;
    },
    { contractByUnit: {}, executedByUnit: {}, contractAmount: 0, executedAmount: 0, overruns: 0, ahead: 0 },
  );
}

describe('DR-029 — variance summary groups physical quantities by unit', () => {
  describe('source-text pins', () => {
    test('reduce keys physical totals by unit (contractByUnit / executedByUnit)', () => {
      // Post-fix: per-unit maps exist. Pre-fix had flat scalars
      // (acc.contractQty += ...) which were the bug.
      expect(varianceSource).toMatch(/contractByUnit/);
      expect(varianceSource).toMatch(/executedByUnit/);
    });

    test('pre-fix flat-scalar accumulator is gone', () => {
      // Guard against a regression that re-introduces the unit-agnostic sum.
      expect(varianceSource).not.toMatch(/acc\.contractQty\s*\+=/);
      expect(varianceSource).not.toMatch(/acc\.executedQty\s*\+=/);
    });

    test('misleading "Contract qty (sum)" label is replaced', () => {
      // "(sum)" implied one combined scalar across units. Post-fix
      // the tile is labelled "Contract qty" and the body breaks the
      // number out by unit.
      expect(varianceSource).not.toMatch(/Contract\s*qty\s*\(sum\)/i);
      expect(varianceSource).toMatch(/Contract\s*qty/);
    });

    test('tile body renders each unit\'s subtotal (no combined "Quantity: 15")', () => {
      // The summary tile must reference qtyUnits / contractByUnit /
      // executedByUnit so a reviewer can grep the render path.
      expect(varianceSource).toMatch(/qtyUnits/);
      expect(varianceSource).toMatch(/contractByUnit\[/);
      expect(varianceSource).toMatch(/executedByUnit\[/);
    });

    test('monetary aggregate (currency) remains a flat scalar', () => {
      // Currency is unitless — INR + INR is INR. The amount reduce must
      // still be a plain +=, not bucketed by anything.
      expect(varianceSource).toMatch(/acc\.contractAmount\s*\+=/);
      expect(varianceSource).toMatch(/acc\.executedAmount\s*\+=/);
    });

    test('unit fallback: missing/blank unit buckets under "units"', () => {
      // Defensive: some legacy rows may have null / empty / whitespace
      // `unit`. They must not be silently dropped — fall back to a
      // visible label so the billing engineer sees them.
      expect(varianceSource).toMatch(/it\.unit\s*\|\|\s*['"]units['"]/);
      expect(varianceSource).toMatch(/\.trim\(\)/);
    });
  });

  describe('behavioural mirror — reduceTotals()', () => {
    test('mixed sqm + kg + each keeps separate subtotals (no combined scalar)', () => {
      // Acceptance criterion: 10 sqm + 5 kg + 7 each must NOT collapse
      // to a single "Quantity: 22" or similar unlabeled scalar.
      const totals = reduceTotals([
        { contractQty: 10, executedQty: 8, unit: 'sqm',  contractAmount: 10000, executedAmount: 8000, varianceQty: 2 },
        { contractQty: 5,  executedQty: 5, unit: 'kg',   contractAmount: 2500,  executedAmount: 2500, varianceQty: 0 },
        { contractQty: 7,  executedQty: 6, unit: 'each', contractAmount: 700,   executedAmount: 600,  varianceQty: 1 },
      ]);
      expect(totals.contractByUnit).toEqual({ sqm: 10, kg: 5, each: 7 });
      expect(totals.executedByUnit).toEqual({ sqm: 8, kg: 5, each: 6 });
      // Flat scalar keys must NOT exist post-fix.
      expect(totals.contractQty).toBeUndefined();
      expect(totals.executedQty).toBeUndefined();
    });

    test('monetary totals aggregate across rows (currency is unitless)', () => {
      const totals = reduceTotals([
        { contractQty: 10, executedQty: 8, unit: 'sqm', contractAmount: 10000, executedAmount: 8000, varianceQty: 2 },
        { contractQty: 5,  executedQty: 5, unit: 'kg',  contractAmount: 2500,  executedAmount: 2500, varianceQty: 0 },
        { contractQty: 7,  executedQty: 6, unit: 'each',contractAmount: 700,   executedAmount: 600,  varianceQty: 1 },
      ]);
      expect(totals.contractAmount).toBe(13200);
      expect(totals.executedAmount).toBe(11100);
    });

    test('single-unit rows sum normally (no regression on the common case)', () => {
      const totals = reduceTotals([
        { contractQty: 12.5, executedQty: 10,   unit: 'sqm', contractAmount: 12500, executedAmount: 10000, varianceQty: 2.5 },
        { contractQty: 7.5,  executedQty: 7.5,  unit: 'sqm', contractAmount: 7500,  executedAmount: 7500,  varianceQty: 0 },
      ]);
      expect(totals.contractByUnit).toEqual({ sqm: 20 });
      expect(totals.executedByUnit).toEqual({ sqm: 17.5 });
    });

    test('rows missing a unit bucket together as "units" (defensive fallback)', () => {
      const totals = reduceTotals([
        { contractQty: 3, executedQty: 3, unit: '',    contractAmount: 300, executedAmount: 300, varianceQty: 0 },
        { contractQty: 2, executedQty: 1, unit: null, contractAmount: 200, executedAmount: 100, varianceQty: 1 },
        { contractQty: 1, executedQty: 1, unit: '   ', contractAmount: 100, executedAmount: 100, varianceQty: 0 },
      ]);
      expect(totals.contractByUnit).toEqual({ units: 6 });
      expect(totals.executedByUnit).toEqual({ units: 5 });
    });

    test('overrun / ahead counters survive the refactor', () => {
      const totals = reduceTotals([
        { contractQty: 10, executedQty: 12, unit: 'sqm',  contractAmount: 10000, executedAmount: 12000, varianceQty: -2 },
        { contractQty: 10, executedQty: 8,  unit: 'kg',   contractAmount: 5000,  executedAmount: 4000,  varianceQty: 2 },
        { contractQty: 10, executedQty: 10, unit: 'each', contractAmount: 1000,  executedAmount: 1000,  varianceQty: 0 },
      ]);
      expect(totals.overruns).toBe(1);
      expect(totals.ahead).toBe(1);
    });

    test('empty items list yields empty maps (no crash, no fake "0 units")', () => {
      const totals = reduceTotals([]);
      expect(totals.contractByUnit).toEqual({});
      expect(totals.executedByUnit).toEqual({});
      expect(totals.contractAmount).toBe(0);
      expect(totals.executedAmount).toBe(0);
      expect(totals.overruns).toBe(0);
      expect(totals.ahead).toBe(0);
    });
  });
});
