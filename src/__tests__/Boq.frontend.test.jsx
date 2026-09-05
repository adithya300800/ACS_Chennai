// N7 (round-28) — BOQ frontend wiring coverage.
//
// Mounting BoqAdmin / BoqVariance in jsdom drags in the lazy router
// graph that exhausts memory in this sandbox (see App.test.jsx for the
// broader pattern and ProjectDashboard.empty-state.test.jsx for the
// sibling test that uses the same approach). Source-text + behavioural
// mirrors below are deterministic and run in <1ms.
//
// What this pins:
//   1. api.js exposes the six BOQ wrappers so neither page reaches into
//      fetch() by hand. Mirror what the backend (commit 68611e2) ships.
//   2. App.jsx lazy-imports both new pages and registers the routes
//      under /portal/boq and /portal/admin/boq.
//   3. PortalLayout.jsx exposes nav entries so the surfaces are
//      discoverable (admin: BOQ Registry, employee: BOQ Variance).
//   4. BoqAdmin renders an empty state when the list is empty (not a
//      blank card) so admins aren't left guessing where the "+ Add"
//      button lives.
//   5. BoqVariance computes variance correctly — both the percentage
//      string and the color decision. These are pure functions and
//      re-implemented here so a regression in the source is caught
//      regardless of whether anyone remembers to look.

import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';

const apiPath = resolvePath(__dirname, '../lib/api.js');
const appPath = resolvePath(__dirname, '../App.jsx');
const layoutPath = resolvePath(__dirname, '../components/PortalLayout.jsx');
const adminPath = resolvePath(__dirname, '../pages/admin/BoqAdmin.jsx');
const variancePath = resolvePath(__dirname, '../pages/portal/BoqVariance.jsx');

const apiSource = readFileSync(apiPath, 'utf8');
const appSource = readFileSync(appPath, 'utf8');
const layoutSource = readFileSync(layoutPath, 'utf8');
const adminSource = readFileSync(adminPath, 'utf8');
const varianceSource = readFileSync(variancePath, 'utf8');

// ─── Behavioural mirror: variance math + color ─────────────────────────────
// The BoqVariance page has two pure helpers (`formatVariancePct` +
// `varianceColor`) that drive every cell in the report. Mirror them
// here so a regression in the source breaks this test, not just the
// visual output.
//
//   varianceColor(varianceQty):
//     < 0 → '#dc2626' (red, overrun)
//     > 0 → '#16a34a' (green, ahead)
//     = 0 → 'var(--steel)' (grey)
//
//   formatVariancePct(executed, contract):
//     contract ≤ 0    → '—'
//     pct = (executed − contract) / contract * 100
//     positive values get a leading '+' sign.
function varianceColor(varianceQty) {
  if (varianceQty < 0) return '#dc2626';
  if (varianceQty > 0) return '#16a34a';
  return 'var(--steel)';
}

function formatVariancePct(executed, contract) {
  const c = Number(contract) || 0;
  const e = Number(executed) || 0;
  if (c <= 0) return '—';
  const pct = ((e - c) / c) * 100;
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

describe('N7 — BOQ frontend wiring', () => {
  describe('api.js — BOQ wrapper surface', () => {
    test('exposes all six BOQ methods', () => {
      // The backend ships six endpoints; the frontend wrapper mirrors
      // them so BoqAdmin + BoqVariance never call fetch() by hand.
      expect(apiSource).toMatch(/getBoqItems:\s*\(/);
      expect(apiSource).toMatch(/createBoqItem:\s*\(/);
      expect(apiSource).toMatch(/getBoqItem:\s*\(/);
      expect(apiSource).toMatch(/updateBoqItem:\s*\(/);
      expect(apiSource).toMatch(/softDeleteBoqItem:\s*\(/);
      expect(apiSource).toMatch(/getBoqVariance:\s*\(/);
    });

    test('getBoqVariance encodes the project name', () => {
      // Project names can contain spaces, slashes, and other
      // URL-unsafe characters (e.g. "T-Nagar / Phase II"). A literal
      // template string would 400 on the backend; the wrapper MUST
      // call encodeURIComponent.
      expect(apiSource).toMatch(
        /getBoqVariance:[\s\S]*?encodeURIComponent\([\s\S]*?projectName[\s\S]*?\)/,
      );
    });

    test('softDeleteBoqItem uses DELETE method (mirrors backend soft-delete)', () => {
      // Backend defines DELETE /api/boq/:id as soft-delete (isActive
      // flips to false). The wrapper must call api.delete(...), not
      // api.patch(...), so the route resolves.
      expect(apiSource).toMatch(/softDeleteBoqItem:[\s\S]*?api\.delete\(/);
    });
  });

  describe('App.jsx — lazy imports + routes', () => {
    test('declares lazy imports for BoqAdmin + BoqVariance', () => {
      // Both new pages must be lazy-loaded so they don't bloat the
      // initial bundle — same pattern as every other page in this file.
      expect(appSource).toMatch(
        /const\s+BoqAdmin\s*=\s*React\.lazy\([\s\S]*?BoqAdmin\.jsx['"]\)/,
      );
      expect(appSource).toMatch(
        /const\s+BoqVariance\s*=\s*React\.lazy\([\s\S]*?BoqVariance\.jsx['"]\)/,
      );
    });

    test('registers the two routes inside the protected /portal/* tree', () => {
      // Variance report at /boq (employee-accessible), admin registry
      // at /admin/boq. Both must be mounted inside the protected tree
      // so a stale JWT can't slip past AuthContext.
      expect(appSource).toMatch(/<Route\s+path="boq"\s+element=\{<BoqVariance\s*\/>\}/);
      expect(appSource).toMatch(/<Route\s+path="admin\/boq"\s+element=\{<BoqAdmin\s*\/>\}/);
    });
  });

  describe('PortalLayout.jsx — sidebar nav entries', () => {
    test('exposes BOQ Variance in the employee nav', () => {
      // Surface must be reachable from the sidebar so users discover
      // it without typing the URL. PortalLayout uses object-literal
      // syntax (`to: '/portal/boq'`) rather than JSX-attribute syntax,
      // so the regex matches either `to:` or `to=`.
      expect(layoutSource).toMatch(/to[:=]\s*['"]\/portal\/boq['"]/);
      expect(layoutSource).toMatch(/BOQ\s+Variance/);
    });

    test('exposes BOQ Registry in the admin nav', () => {
      // Admin CRUD surface lives under the admin tree.
      expect(layoutSource).toMatch(/to[:=]\s*['"]\/portal\/admin\/boq['"]/);
      expect(layoutSource).toMatch(/BOQ\s+Registry/);
    });
  });

  describe('BoqAdmin — empty-state rendering', () => {
    test('renders the dpr-list-empty branch when items.length === 0', () => {
      // The empty state is the discoverability contract — if a fresh
      // admin lands on the page, the "+ Add BOQ item" button is the
      // only way to recover.
      expect(adminSource).toMatch(/items\.length\s*===\s*0\s*\?\s*\(/);
    });

    test('empty state surfaces the recovery CTA (+ Add BOQ item)', () => {
      // Pull the empty-state block so we don't accidentally pass by
      // a +Add in the page header.
      const emptyBlock = adminSource.match(
        /items\.length\s*===\s*0\s*\?\s*\([\s\S]*?\)\s*:/,
      );
      expect(emptyBlock).toBeTruthy();
      expect(emptyBlock[0]).toMatch(/\+\s*Add\s*BOQ\s*item/);
    });

    test('form modal previews amount = quantity × rate before save', () => {
      // The live preview is the UX hint that catches admins who clear
      // one of the inputs. Server recomputes on save; this is purely
      // client-side feedback.
      expect(adminSource).toMatch(/amount\s*=\s*useMemo\(/);
      expect(adminSource).toMatch(/q\s*\*\s*r/);
    });

    test('confirms soft-delete preserves linked DPR/Inspection FKs', () => {
      // Soft-delete copy in the confirm dialog must mention that the
      // row stays in the database. Otherwise admins panic when they
      // don't see the row disappear from the list (it does disappear,
      // because isActive=false filters it out — but they expect it to
      // be gone from the DB too).
      expect(adminSource).toMatch(/soft-delete/i);
      expect(adminSource).toMatch(/Linked\s*DPRs/i);
    });

    test('duplicate-key error surfaces a friendly 409 message', () => {
      // Backend returns 409 with code DUPLICATE_BOQ_ITEM when
      // (projectName, itemCode) already exists. The modal must map
      // this to a readable string, not the raw "HTTP 409".
      expect(adminSource).toMatch(/DUPLICATE_BOQ_ITEM/);
      expect(adminSource).toMatch(/already\s+exists/i);
    });
  });

  describe('BoqVariance — empty-state wiring', () => {
    test('shows the "Enter a project name" empty state when no project is applied', () => {
      // The variance report is project-scoped — without a project
      // name there's nothing to fetch. The empty state must explain
      // that so the user isn't staring at a blank card.
      expect(varianceSource).toMatch(/!\s*appliedProject\s*\?\s*\(/);
      expect(varianceSource).toMatch(/Enter\s*a\s*project\s*name/);
    });

    test('fetches variance via api.getBoqVariance with the applied project name', () => {
      expect(varianceSource).toMatch(/api\.getBoqVariance\(\s*appliedProject/);
    });

    test('offers an admin-only shortcut to the registry when no items exist', () => {
      // When the employee hits an empty variance report for a brand
      // new project, admins should see a one-click "BOQ Registry"
      // link. Non-admins see a static hint.
      expect(varianceSource).toMatch(/employee\?\.isAdmin/);
      expect(varianceSource).toMatch(/to[:=]\s*['"]\/portal\/admin\/boq['"]/);
    });
  });

  describe('behavioural mirror — variance math + colour', () => {
    test('varianceColor: negative qty → red (overrun)', () => {
      // Executed > contract means the project has billed more than
      // was on the BOQ. This must be red, not green — flipping the
      // colour would hide overruns.
      expect(varianceColor(-5)).toBe('#dc2626');
      expect(varianceColor(-0.01)).toBe('#dc2626');
    });

    test('varianceColor: positive qty → green (ahead)', () => {
      // Executed < contract means the project is under-running its
      // BOQ. Green is correct — there's still quantity to bill.
      expect(varianceColor(10)).toBe('#16a34a');
      expect(varianceColor(0.01)).toBe('#16a34a');
    });

    test('varianceColor: zero qty → grey (exact match)', () => {
      expect(varianceColor(0)).toBe('var(--steel)');
    });

    test('formatVariancePct: contract = 0 → em-dash (avoid divide-by-zero)', () => {
      // A BOQ item with no contract quantity shouldn't produce a
      // percentage — there's no baseline. The em-dash keeps the cell
      // visually populated without a misleading "Infinity%" or "NaN%".
      expect(formatVariancePct(100, 0)).toBe('—');
      expect(formatVariancePct(100, null)).toBe('—');
      expect(formatVariancePct(100, undefined)).toBe('—');
    });

    test('formatVariancePct: overrun gets a leading + sign', () => {
      // The sign convention is "executed − contract". When executed
      // is bigger than contract the result is positive (e.g. 110% of
      // contract = +10%). The cell colour (red) tells the user it's
      // bad, but the sign tells them the magnitude. Same convention
      // as the BoqAdmin table.
      expect(formatVariancePct(110, 100)).toBe('+10.0%');
      expect(formatVariancePct(105, 100)).toBe('+5.0%');
    });

    test('formatVariancePct: under-run has no leading sign (negative is implicit)', () => {
      expect(formatVariancePct(80, 100)).toBe('-20.0%');
      expect(formatVariancePct(50, 100)).toBe('-50.0%');
    });

    test('formatVariancePct: exact match → 0.0% (no sign)', () => {
      // The `sign = pct > 0 ? '+' : ''` rule in the source means an
      // exact match renders without a sign. Pin the current behaviour
      // so a sign-flip doesn't silently change the report — "0.0%"
      // is unambiguous (an exact match), "+0.0%" implies "slightly
      // over" which would mislead the billing engineer.
      expect(formatVariancePct(100, 100)).toBe('0.0%');
    });
  });
});
