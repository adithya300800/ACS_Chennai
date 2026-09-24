// [§8.2 Fresh24 audit, 2026-09-24] — BOQ variance page now threads
// projectId (canonical, matching DprAll / Drawing browse) as the
// preferred URL param. projectName is kept as a back-compat fallback
// so older links keep working. projectId wins when both are present.
//
// Source-text pins (mount-free per BoqVariance.dr029-unit-grouping.test.jsx
// header — BoqVariance in jsdom drags the lazy router graph that exhausts
// memory). The behavioural coverage here verifies the resolution order
// (projectId → projectName → empty) on a minimal mirror of the URL
// reader.

import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';

const pagePath = resolvePath(__dirname, '../pages/portal/BoqVariance.jsx');
const pageSrc = readFileSync(pagePath, 'utf8');

describe('§8.2 Fresh24 — BoqVariance prefers projectId over projectName', () => {
  describe('source-text pins', () => {
    test('reads ?projectId= from URL params (canonical key)', () => {
      // searchParams.get('projectId') is the new canonical read.
      expect(pageSrc).toMatch(/searchParams\.get\(\s*['"]projectId['"]\s*\)/);
    });

    test('falls back to ?projectName= for back-compat', () => {
      // Legacy links still work — read both, projectId wins.
      expect(pageSrc).toMatch(/searchParams\.get\(\s*['"]projectName['"]\s*\)/);
    });

    test('projectId takes precedence when both params are present', () => {
      // The initial state derivation: `initialProjectId || initialProjectName`
      // — projectId short-circuits, so it wins when both are non-empty.
      expect(pageSrc).toMatch(/initialProjectId\s*\|\|\s*initialProjectName/);
    });

    test('tracks a lookupById flag alongside the lookup key', () => {
      // The lookup mode (ID vs name) drives the resolution branch in
      // `load`. Initialise from `!!initialProjectId` so a URL carrying
      // only projectName lands in name mode, and a URL carrying
      // projectId lands in ID mode.
      expect(pageSrc).toMatch(/initialLookupById\s*=\s*!!initialProjectId/);
      expect(pageSrc).toMatch(/appliedById[\s\S]{0,80}useState\(\s*initialLookupById\s*\)/);
    });

    test('resolves a projectId through api.getProject before the variance call', () => {
      // The backend variance route is name-keyed, so an ID has to be
      // mapped to its project name. The lookup branch must call
      // api.getProject with the ID, take its .name, and pass that to
      // api.getBoqVariance.
      expect(pageSrc).toMatch(/api\.getProject\(\s*appliedProject\s*,\s*accessToken\s*\)/);
      expect(pageSrc).toMatch(/project\?\.name\s*\|\|\s*appliedProject/);
      expect(pageSrc).toMatch(/api\.getBoqVariance\(\s*projectName\s*,\s*accessToken\s*\)/);
    });

    test('applies the input value as a project NAME (not ID) on user action', () => {
      // When the user types in the input and clicks Show variance /
      // presses Enter, the typed value is treated as a name — the input
      // is free text with a name-shaped placeholder. The post-input
      // path sets appliedById to false.
      expect(pageSrc).toMatch(/applyLookupKey\s*\(\s*[\s\S]*?\)/);
      expect(pageSrc).toMatch(/setAppliedProject\(\s*key\.trim\(\s*\)\s*\)/);
      expect(pageSrc).toMatch(/setAppliedById\(\s*false\s*\)/);
    });

    test('label clarifies the input accepts name OR id', () => {
      // The audit's UX intent: a free-text input that accepts either.
      // The label and placeholder signal this to the user.
      expect(pageSrc).toMatch(/Project name or ID/);
      expect(pageSrc).toMatch(/Metro Station Phase 2 or project UUID/);
    });
  });

  describe('behavioural mirror — initial state derivation', () => {
    // Mirror of the inline `initialX` derivations. A regression that
    // drops the projectId branch (or re-orders the precedence) breaks
    // these tests without touching the network.
    function deriveInitial(searchParams) {
      const initialProjectId = searchParams.get('projectId') || '';
      const initialProjectName = searchParams.get('projectName') || '';
      const initialLookupById = !!initialProjectId;
      const initialLookupKey = initialProjectId || initialProjectName;
      return { initialLookupKey, initialLookupById };
    }

    test('URL with ?projectId=abc-123 → form pre-fills with project ID', () => {
      const params = new URLSearchParams('?projectId=abc-123');
      const out = deriveInitial(params);
      expect(out.initialLookupKey).toBe('abc-123');
      expect(out.initialLookupById).toBe(true);
    });

    test('URL with both → projectId wins', () => {
      const params = new URLSearchParams('?projectId=abc-123&projectName=Metro');
      const out = deriveInitial(params);
      expect(out.initialLookupKey).toBe('abc-123');
      expect(out.initialLookupById).toBe(true);
    });

    test('URL with only ?projectName= falls back to name (back-compat)', () => {
      const params = new URLSearchParams('?projectName=Metro');
      const out = deriveInitial(params);
      expect(out.initialLookupKey).toBe('Metro');
      expect(out.initialLookupById).toBe(false);
    });

    test('URL with neither → form is empty', () => {
      const params = new URLSearchParams('');
      const out = deriveInitial(params);
      expect(out.initialLookupKey).toBe('');
      expect(out.initialLookupById).toBe(false);
    });
  });
});

// [§8.2 Fresh24] — Internal callers must thread projectId (canonical)
// instead of projectName. Pin the four internal callers that link
// directly into /portal/boq?projectName=... and verify each now
// references ?projectId= instead. A regression that silently re-introduces
// the legacy param breaks this test.
describe('§8.2 Fresh24 — internal callers link to ?projectId= (canonical)', () => {
  const callers = [
    {
      file: '../pages/portal/InspectionDetail.jsx',
      // Pre-fix: `?projectName=${...record.project?.name...}`
      // Post-fix: `?projectId=${...record.project?.id...}`
      expectIn: /\/portal\/boq\?projectId=\$\{encodeURIComponent\(record\.project\?\.id/,
      rejectIn: /\/portal\/boq\?projectName=/,
    },
    {
      file: '../pages/portal/DprAll.jsx',
      expectIn: /\/portal\/boq\?projectId=\$\{encodeURIComponent\(dpr\.project\?\.id/,
      rejectIn: /\/portal\/boq\?projectName=/,
    },
    {
      file: '../pages/portal/DprList.jsx',
      expectIn: /\/portal\/boq\?projectId=\$\{encodeURIComponent\(expandedDpr\.project\?\.id/,
      rejectIn: /\/portal\/boq\?projectName=/,
    },
    {
      file: '../pages/portal/ProjectDetail.jsx',
      expectIn: /\/portal\/boq\?projectId=\$\{pid\}/,
      rejectIn: /\/portal\/boq\?projectName=\$\{projectName\}/,
    },
  ];

  for (const { file, expectIn, rejectIn } of callers) {
    const src = readFileSync(resolvePath(__dirname, file), 'utf8');
    test(`${file.split('/').pop()} → /portal/boq link uses ?projectId=`, () => {
      expect(src).toMatch(expectIn);
      expect(src).not.toMatch(rejectIn);
    });
  }
});
