// DR-034 (audit, 2026-09-08) — dashboard + BoqVariance + Project
// Overview render truthful load/empty/error states.
//
// Audit findings:
//   1. Dashboard widget failures were silently swallowed by
//      `.catch(() => ({...empty}))`, making unavailable widgets look
//      like healthy empty cards.
//   2. BoqVariance rendered "No BOQ items for this project" alongside
//      the error banner when a fetch failed.
//   3. Project Overview told users to "add contract value in the
//      project registry" but the admin ProjectForm does NOT expose
//      a contractValue input — the promise was unimplementable.
//
// Source-text contracts pin the three fixes:
//   - widgetStatus state tracks per-section ok/error
//   - BoqVariance error branch renders a focused "Couldn't load" card
//   - ProjectExpandedPanel copy lists only fields the admin form exposes
//
// Run: cd src && npx jest __tests__/dr034-truthful-empty-states.test.jsx
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';

const dashPath = resolvePath(__dirname, '../pages/portal/EmployeeDashboard.jsx');
const boqPath = resolvePath(__dirname, '../pages/portal/BoqVariance.jsx');
const panelPath = resolvePath(__dirname, '../pages/portal/ProjectExpandedPanel.jsx');
const projectFormPath = resolvePath(__dirname, '../pages/admin/ProjectForm.jsx');

const dashSrc = readFileSync(dashPath, 'utf8');
const boqSrc = readFileSync(boqPath, 'utf8');
const panelSrc = readFileSync(panelPath, 'utf8');
const formSrc = readFileSync(projectFormPath, 'utf8');

describe('DR-034 — truthful widget load/empty/error states', () => {
  test('1. EmployeeDashboard tracks per-widget ok/error state', () => {
    expect(dashSrc).toMatch(/\[widgetStatus,\s*setWidgetStatus\]\s*=\s*useState/);
    // Status map covers all five widgets.
    expect(dashSrc).toMatch(/today:\s*null,\s*draft:\s*null,\s*training:\s*null,\s*leaves:\s*null,\s*notifications:\s*null/);
    // Parallel fetch records each result's ok flag.
    expect(dashSrc).toMatch(/\.then\(\(v\)\s*=>\s*\(\{\s*ok:\s*true,\s*v\s*\}\),\s*\(\)\s*=>\s*\(\{\s*ok:\s*false\s*\}\)/);
    // setWidgetStatus is called after the parallel fetch.
    expect(dashSrc).toMatch(/setWidgetStatus\(\{/);
  });

  test('2. Attendance widget renders "Couldn\'t load" + Retry on widget error', () => {
    expect(dashSrc).toMatch(/widgetStatus\.today\s*===\s*['"]error['"][\s\S]*?Couldn['’]t load attendance/);
    expect(dashSrc).toMatch(/Retry/);
  });

  test('3. Open DPR draft widget renders "Couldn\'t load drafts" on error', () => {
    expect(dashSrc).toMatch(/widgetStatus\.draft\s*===\s*['"]error['"][\s\S]*?Couldn['’]t load drafts/);
  });

  test('4. Training widget renders "Couldn\'t load training" on error', () => {
    expect(dashSrc).toMatch(/widgetStatus\.training\s*===\s*['"]error['"][\s\S]*?Couldn['’]t load training/);
  });

  test('5. Leave widget renders "Couldn\'t load leave" on error', () => {
    expect(dashSrc).toMatch(/widgetStatus\.leaves\s*===\s*['"]error['"][\s\S]*?Couldn['’]t load leave/);
  });

  test('6. Notifications widget renders "Couldn\'t load notifications" on error', () => {
    expect(dashSrc).toMatch(/widgetStatus\.notifications\s*===\s*['"]error['"][\s\S]*?Couldn['’]t load notifications/);
  });

  test('7. BoqVariance: error state replaces the "No BOQ items" empty card', () => {
    // The order of branches must check error BEFORE items.length === 0,
    // so a failed fetch shows "Couldn't load variance" + Retry, not
    // "No BOQ items" (which would be misleading).
    const errorIdx = boqSrc.indexOf("error ?");
    const emptyIdx = boqSrc.indexOf("items.length === 0 ?");
    expect(errorIdx).toBeGreaterThan(-1);
    expect(emptyIdx).toBeGreaterThan(-1);
    expect(errorIdx).toBeLessThan(emptyIdx);
    expect(boqSrc).toMatch(/Couldn['’]t load variance/);
  });

  test('8. Project Overview copy no longer promises contract-value authoring', () => {
    // The previous copy mentioned "contract value" as a registry-editable
    // field, but the admin ProjectForm doesn't expose it. The fix
    // lists only fields an admin can actually author.
    expect(panelSrc).not.toMatch(/add client, location, and contract value in\s+the project registry/);
    // The new copy mentions only client + location.
    expect(panelSrc).toMatch(/an admin can add client and location/);
  });

  test('9. admin ProjectForm does NOT expose contractValue (regression guard)', () => {
    // Pin the absence so a future round doesn't add the field back
    // without also wiring the copy + a schema migration.
    expect(formSrc).not.toMatch(/contractValue/);
  });
});
