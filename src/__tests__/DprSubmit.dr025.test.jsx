// DR-025 (SOL audit 2026-09-08): honest loading / empty / error states +
// authoring copy that matches what the destination actually does.
//
// Coverage:
//   1. source: DprSubmit tri-state inspection summary — `loading` / `ok`
//      / `error` — never conflates "no records" with "fetch failed".
//   2. source: DprSubmit uses prettyInspectionType (not raw enum slugs)
//      for inspection rows in the summary card.
//   3. source: ProjectExpandedPanel Overview no longer promises an admin
//      will add `contract value` (the admin form doesn't expose it).
//   4. source: ProjectDetail Overview no longer promises an admin will
//      add `contract value`.
//   5. source: EmployeeDashboard attendance aside relabels the
//      `/portal/attendance` link away from the false "Weekly summary +
//      export" promise.
//   6. source: ProjectDashboard (admin) KPI subtitle no longer claims
//      "Cube Tests" coverage — that tile section was removed in round-29.

import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';

const dprSubmitPath = resolvePath(__dirname, '../pages/portal/DprSubmit.jsx');
const projPanelPath = resolvePath(__dirname, '../pages/portal/ProjectExpandedPanel.jsx');
const projDetailPath = resolvePath(__dirname, '../pages/portal/ProjectDetail.jsx');
const dashPath = resolvePath(__dirname, '../pages/portal/EmployeeDashboard.jsx');
const projDashPath = resolvePath(__dirname, '../pages/admin/ProjectDashboard.jsx');

const dprSubmitSrc = readFileSync(dprSubmitPath, 'utf8');
const projPanelSrc = readFileSync(projPanelPath, 'utf8');
const projDetailSrc = readFileSync(projDetailPath, 'utf8');
const dashSrc = readFileSync(dashPath, 'utf8');
const projDashSrc = readFileSync(projDashPath, 'utf8');

describe('DR-025 — honest loading / empty / error + authoring copy', () => {
  test('1. DprSubmit tri-state inspection summary (loading/ok/error)', () => {
    expect(dprSubmitSrc).toMatch(/todayInspectionsStatus/);
    // Three branches render in the summary card.
    expect(dprSubmitSrc).toMatch(/todayInspectionsStatus\s*===\s*['"]loading['"]/);
    expect(dprSubmitSrc).toMatch(/todayInspectionsStatus\s*===\s*['"]error['"]/);
    expect(dprSubmitSrc).toMatch(/Couldn't load today[’']s inspections/);
    expect(dprSubmitSrc).toMatch(/>\s*Retry\s*</);
  });

  test('1b. DprSubmit rejects the conflated `loaded` flag', () => {
    // The old boolean `todayInspectionsLoaded` is gone.
    expect(dprSubmitSrc).not.toMatch(/todayInspectionsLoaded/);
  });

  test('2. DprSubmit renders inspection rows via prettyInspectionType', () => {
    // The helper must exist in the module and be used at the render site.
    expect(dprSubmitSrc).toMatch(/function\s+prettyInspectionType\s*\(/);
    // The summary card's link uses the helper, not the raw slug.
    expect(dprSubmitSrc).toMatch(/prettyInspectionType\(insp\.inspectionType\)/);
    // And the raw enum slug is NOT directly rendered into the link.
    expect(dprSubmitSrc).not.toMatch(/>\{insp\.inspectionType\}<\/Link>/);
  });

  test('3. ProjectExpandedPanel Overview drops the contract-value promise', () => {
    expect(projPanelSrc).toMatch(/Auto-discovered project[\s\S]{0,400}formally register it\s*\(client,\s*location\)/);
    expect(projPanelSrc).not.toMatch(/client,\s*location,\s*contract value/);
  });

  test('4. ProjectDetail Overview drops the contract-value + sites promise', () => {
    // S6/UI-8: sites is API-only; only (client, location, dates) are admin-editable via ProjectForm.
    expect(projDetailSrc).toMatch(/client,\s*location,\s*dates/);
    expect(projDetailSrc).not.toMatch(/client,\s*contract value/);
    expect(projDetailSrc).not.toMatch(/client,\s*location,\s*sites/);
  });

  test('5. EmployeeDashboard attendance aside relabels the false promise', () => {
    // Old misleading copy is gone.
    expect(dashSrc).not.toMatch(/Weekly summary \+ export/);
    // New honest copy points at the calendar / marking destination.
    expect(dashSrc).toMatch(/Mark attendance[\s\S]{0,40}calendar history/);
  });

  test('6. ProjectDashboard KPI subtitle drops the Cube Tests claim', () => {
    expect(projDashSrc).toMatch(/KPIs across DPR, Inspections, BOQ, and People/);
    expect(projDashSrc).not.toMatch(/KPIs across DPR, Inspections, Cube Tests, BOQ, and People/);
  });
});