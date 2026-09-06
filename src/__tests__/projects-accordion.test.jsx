// [Round-33] My Projects accordion expansion.
//
// User feedback: clicking Overview / BOQ / DPRs / Inspections / Drawings
// tabs on ProjectDetail bounces to /portal/dpr/all, /portal/boq, etc.
// — and the destination pages "don't show anything relevant to the
// project". The fix is to make the My Projects list itself expandable:
// each project card grows an inline panel with 5 sub-sections (Overview
// + BOQ + DPRs + Inspections + Drawings), all loaded in place.
//
// Source-text contracts (no mount, per App.test.jsx header — PortalLayout
// exhausts jest memory). Pin:
//   1. Projects.jsx renders ProjectExpandedPanel inline beneath an
//      expanded card; the panel renders all 5 sub-sections in place.
//   2. ProjectExpandedPanel issues the right API calls with the right
//      params (parties via getProjectParties; DPR/Inspection via
//      projectId; Drawing via projectId REQUIRED; BOQ via projectName).
//   3. The panel is wired with accessibility: aria-expanded on the
//      chevron, role="region" on the panel, section buttons toggle.
//   4. Anti-regression: the legacy `navigate(/portal/projects/:id)`
//      onOpen handler is gone — clicking a card now expands inline.

import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';

const projectsPath = resolvePath(__dirname, '../pages/portal/Projects.jsx');
const panelPath = resolvePath(__dirname, '../pages/portal/ProjectExpandedPanel.jsx');
const projectsSrc = readFileSync(projectsPath, 'utf8');
const panelSrc = readFileSync(panelPath, 'utf8');

describe('Round-33 — My Projects accordion expansion', () => {
  test('Projects.jsx renders ProjectExpandedPanel inline beneath the expanded card', () => {
    // The expanded panel is rendered as a sibling of the card inside the
    // grid, with gridColumn: '1 / -1' so it spans the full row. Pin
    // both: the import + the JSX usage.
    expect(projectsSrc).toMatch(/import\s+ProjectExpandedPanel\s+from\s+['"]\.\/ProjectExpandedPanel\.jsx['"]/);
    expect(projectsSrc).toMatch(/<ProjectExpandedPanel\b/);
    expect(projectsSrc).toMatch(/gridColumn:\s*['"]1 \/ -1['"]/);
  });

  test('Projects.jsx is accordion-driven (only one card expanded at a time)', () => {
    // State machine: `expandedKey` holds the active card's id||name.
    // Click a card → setExpandedKey(key) → panel renders; click again
    // → setExpandedKey(null) → panel collapses.
    expect(projectsSrc).toMatch(/expandedKey/);
    expect(projectsSrc).toMatch(/setExpandedKey/);
    // The card's onToggle handler is the accordion flip, NOT a
    // navigation. Pin the handler shape so a future refactor can't
    // silently re-introduce the "click card → navigate to
    // ProjectDetail" anti-pattern.
    expect(projectsSrc).toMatch(/onToggle=\{[^}]*setExpandedKey/);
    // The legacy ProjectDetail deep-link is still reachable via the
    // "Open project details →" button inside the expanded panel —
    // NOT via clicking the card itself.
  });

  test('Projects.jsx card has aria-expanded + aria-controls for screen readers', () => {
    // The chevron toggle must announce its state to assistive tech.
    // Without these attrs the panel is invisible to keyboard / SR users.
    expect(projectsSrc).toMatch(/aria-expanded=\{isExpanded\}/);
    expect(projectsSrc).toMatch(/aria-controls=\{`projects-card-body-/);
  });

  test('ProjectExpandedPanel lazy-loads parties + DPRs + Inspections + Drawings + BOQ in parallel', () => {
    // Five fetch calls. Order doesn't matter but each one must be
    // present with the right API helper. The DPR + Inspection calls
    // spread `projectIdOrName` (which carries either projectId or
    // projectName depending on registration) — match the spread
    // shape, not a flat literal.
    expect(panelSrc).toMatch(/api\.getProjectParties\(projectKey,\s*accessToken\)/);
    expect(panelSrc).toMatch(/api\.getDprs\(\{\s*\.\.\.projectIdOrName,\s*limit:\s*25\s*\},\s*accessToken\)/);
    expect(panelSrc).toMatch(/api\.getInspections\(\{\s*\.\.\.projectIdOrName,\s*limit:\s*25\s*\},\s*accessToken\)/);
    expect(panelSrc).toMatch(/api\.getDrawings\(\{\s*projectId:\s*projectKey,\s*status:\s*['"]ACTIVE['"],\s*limit:\s*25\s*\},\s*accessToken\)/);
    expect(panelSrc).toMatch(/api\.getBoqItems\(\{\s*projectName,\s*limit:\s*50\s*\},\s*accessToken\)/);
  });

  test('ProjectExpandedPanel falls back to projectName for unregistered (discovered) projects', () => {
    // Discovered projects have no id. The DPR + Inspection + Drawing
    // endpoints require projectId — so the panel must skip those
    // calls (Drawing literally 400s without it) and render empty
    // states instead. BOQ is keyed by projectName so it works for
    // both. The fallback branch + the isRegistered guard together
    // prove the contract.
    expect(panelSrc).toMatch(/const\s+projectIdOrName\s*=\s*isRegistered\s*\?\s*\{\s*projectId:[^}]+\}\s*:\s*\{\s*projectName\s*\}/);
    expect(panelSrc).toMatch(/if\s*\(\s*isRegistered\s*\)\s*\{[^}]*api\.getDrawings/);
    expect(panelSrc).toMatch(/api\.getBoqItems\(\{\s*projectName/);
  });

  test('ProjectExpandedPanel renders all five sub-section toggles (Overview / BOQ / DPRs / Inspections / Drawings)', () => {
    // Each section is a collapsible button with aria-expanded; the
    // SECTION_IDS list is the canonical source.
    expect(panelSrc).toMatch(/SECTION_IDS\s*=\s*\['overview',\s*'boq',\s*'dprs',\s*'inspections',\s*'drawings'\]/);
    // The Section component builds its testid + aria-controls from the
    // `id` prop (template literal). Pin the pattern so a future
    // refactor can't silently rename it.
    expect(panelSrc).toMatch(/data-testid=\{`projects-section-\$\{id\}`\}/);
    expect(panelSrc).toMatch(/aria-controls=\{`projects-section-body-\$\{id\}`\}/);
    // And the canonical five IDs appear in the SECTION_IDS list — so
    // the Section component is actually instantiated once per section.
    expect(panelSrc).toMatch(/id="overview"/);
    expect(panelSrc).toMatch(/id="boq"/);
    expect(panelSrc).toMatch(/id="dprs"/);
    expect(panelSrc).toMatch(/id="inspections"/);
    expect(panelSrc).toMatch(/id="drawings"/);
  });

  test('ProjectExpandedPanel DPR + Inspection rows are themselves expandable tiles', () => {
    // Each row is a button with aria-expanded so the user can drill
    // into a single DPR / Inspection without losing the panel context.
    // The expanded body shows the summary + admin notes.
    expect(panelSrc).toMatch(/ResourceTile/);
    expect(panelSrc).toMatch(/aria-expanded=\{isExpanded\}/);
  });

  test('ProjectExpandedPanel DPR body renders the real DPR content fields (notes + 5 PMC + workType)', () => {
    // Round-12 split DPRs into 15 sub-work-types; the persistent fields
    // are notes + workExecutedToday + workLocation + manpowerSummary +
    // risksHindrances + materialsReceivedSummary + workType + workEntries
    // + customSections. The original body only checked summary /
    // workSummary / workDone / description — none of which exist on
    // real DPRs — so expanded tiles showed an empty body. Pin the real
    // field names so the bug can't silently regress.
    expect(panelSrc).toMatch(/d\.notes/);
    expect(panelSrc).toMatch(/d\.workExecutedToday/);
    expect(panelSrc).toMatch(/d\.workLocation/);
    expect(panelSrc).toMatch(/d\.manpowerSummary/);
    expect(panelSrc).toMatch(/d\.risksHindrances/);
    expect(panelSrc).toMatch(/d\.materialsReceivedSummary/);
    expect(panelSrc).toMatch(/d\.workType/);
    expect(panelSrc).toMatch(/d\.workEntries/);
    expect(panelSrc).toMatch(/d\.customSections/);
  });

  test('ProjectExpandedPanel Inspection body renders nested data JSONB fields', () => {
    // Inspection rich content lives in `data: { inspectedBy,
    // observations, checklistItems[], ... }`. The original body only
    // checked summary / findings / description — none of which exist
    // on real inspections. Pin that the body iterates over the
    // data object's entries.
    expect(panelSrc).toMatch(/const\s+dObj\s*=\s*i\.data\s*&&\s*typeof\s+i\.data\s*===\s*['"]object['"]\s*\?\s*i\.data\s*:\s*\{\}/);
    expect(panelSrc).toMatch(/for\s*\(\s*const\s*\[\s*key\s*,\s*value\s*\]\s*of\s*Object\.entries\(\s*dObj\s*\)/);
    // Known inspection data fields get friendly labels.
    expect(panelSrc).toMatch(/inspectedBy:\s*['"]Inspected by['"]/);
    expect(panelSrc).toMatch(/observations:\s*['"]Observations['"]/);
    expect(panelSrc).toMatch(/checklistItems:\s*['"]Checklist['"]/);
    expect(panelSrc).toMatch(/complianceStatus:\s*['"]Compliance status['"]/);
    expect(panelSrc).toMatch(/activitiesInspected:\s*['"]Activities inspected['"]/);
    expect(panelSrc).toMatch(/stageOfConstruction:\s*['"]Stage of construction['"]/);
    expect(panelSrc).toMatch(/overallStatus:\s*['"]Overall status['"]/);
    expect(panelSrc).toMatch(/activityType:\s*['"]Activity type['"]/);
    expect(panelSrc).toMatch(/villaUnitNumber:\s*['"]Villa \/ unit['"]/);
  });

  test('ProjectExpandedPanel has generic FieldGrid + BlockField renderers used by DPR + Inspection', () => {
    // The renderers consume [label, value] tuples and render label /
    // value pairs. FieldGrid handles compact two-up rows (Contractor,
    // Location, audit); BlockField handles long-form text (Notes,
    // Observations, Checklist). Pin both so the design is locked.
    expect(panelSrc).toMatch(/function\s+FieldGrid\s*\(/);
    expect(panelSrc).toMatch(/function\s+BlockField\s*\(/);
    expect(panelSrc).toMatch(/<FieldGrid\s+rows=\{inlineRows\}/);
    expect(panelSrc).toMatch(/<FieldGrid\s+rows=\{auditRows\}\s+compact/);
    expect(panelSrc).toMatch(/<BlockField\s+key=\{label\}/);
  });

  test('ProjectExpandedPanel a11y: role="region" + aria-label on the panel + section body', () => {
    // The whole panel is a landmark so SR users can jump to it. Each
    // section body is also a labeled region so the user knows what
    // they landed on after a toggle.
    expect(panelSrc).toMatch(/role="region"/);
    expect(panelSrc).toMatch(/aria-label=\{`Project details for \$\{projectName\}`\}/);
    expect(panelSrc).toMatch(/aria-label=\{`\$\{title\} content`\}/);
  });

  test('ProjectExpandedPanel drawings link to the drawing detail page (not expand inline)', () => {
    // Drawings need a full PDF preview surface — they can't be
    // expanded inline like DPRs. Each row has a "View →" link to
    // /portal/drawings/:id. Pin the link shape so a future refactor
    // can't silently break the navigation.
    expect(panelSrc).toMatch(/to=\{`\/portal\/drawings\/\$\{d\.id\}`\}/);
  });

  test('Projects.jsx /portal/projects route still exists (regression guard)', () => {
    // The accordion lives on /portal/projects — that route must remain
    // mounted. The existing employee-scope test already pins this; we
    // add a duplicate here so the accordion + the route can't
    // silently get split apart.
    const appSrc = readFileSync(resolvePath(__dirname, '../App.jsx'), 'utf8');
    expect(appSrc).toMatch(/path=["']projects["']/);
    expect(appSrc).toMatch(/path=["']projects\/:id["']/);
  });
});
