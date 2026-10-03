// R35: Project Reports — frontend source-text contracts.
//
// Mount-free per App.test.jsx header (PortalLayout exhausts jest memory).
// Pins the wire surface between the new project-attachments backend
// routes, the api helpers in src/lib/api.js, the constants in
// src/lib/constants.js, and the inline Reports sub-section rendered
// inside ProjectExpandedPanel.jsx.
//
// Coverage matrix:
//   1.  api.js exports the 5 new helpers (list, create, read-sas, delete,
//       getReportSasUrl).
//   2.  api.js getReportSasUrl posts to /dpr/sas-url with
//       container:'dpr-documents' + filename:'report/...' prefix.
//   3.  api.js confirmReportUpload mirrors the request shape.
//   4.  constants.js exports MAX_REPORT_BYTES = 25 MB + 13-entry
//       ACCEPTED_REPORT_TYPES list (4 photo + 1 PDF + 6 Office + 2 text).
//   5.  constants.js exports PROJECT_REPORT_TYPES / PROJECT_REPORT_TYPE_LABELS.
//   6.  ProjectExpandedPanel SECTION_IDS contains 'reports' (plus the
//       pre-existing 5).
//   7.  ProjectExpandedPanel renders <Section id="reports" ...> + the
//       ReportSection component.
//   8.  ProjectExpandedPanel issues api.getProjectAttachments(projectKey)
//       on mount, registered-only.
//   9.  ProjectExpandedPanel reruns the fetch when reportsRefreshKey
//       bumps (mirrors drawings' drawingsRefreshKey).
//  10.  ReportSection uploads via getReportSasUrl + uploadBlob +
//       confirmReportUpload + createProjectAttachment.
//  11.  ReportSection delete button gated on isAdmin ||
//       uploadedById === currentEmployeeId.
//  12.  ReportSection client-side validation uses MAX_REPORT_BYTES +
//       ACCEPTED_REPORT_TYPES.
//  13.  Discovered (unregistered) projects show the "register first"
//       copy without an upload form.

import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';
import React from 'react';
import { render, waitFor, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const apiPath = resolvePath(__dirname, '../lib/api.js');
const constantsPath = resolvePath(__dirname, '../lib/constants.js');
const panelPath = resolvePath(__dirname, '../pages/portal/ProjectExpandedPanel.jsx');

const apiSrc = readFileSync(apiPath, 'utf8');
const constantsSrc = readFileSync(constantsPath, 'utf8');
const panelSrc = readFileSync(panelPath, 'utf8');

describe('R35 — Project Reports: api helpers (src/lib/api.js)', () => {
  test('1. api.js exports the 5 new helpers', () => {
    expect(apiSrc).toMatch(/getProjectAttachments\s*:/);
    expect(apiSrc).toMatch(/createProjectAttachment\s*:/);
    expect(apiSrc).toMatch(/getProjectAttachmentReadSas\s*:/);
    expect(apiSrc).toMatch(/deleteProjectAttachment\s*:/);
    expect(apiSrc).toMatch(/getReportSasUrl\s*:/);
  });

  test('2. api.js getReportSasUrl posts to /dpr/sas-url with the right body shape', () => {
    expect(apiSrc).toMatch(
      /getReportSasUrl:\s*\(\s*filename\s*,\s*contentType\s*,\s*token\s*\)\s*=>\s*\n?\s*api\.post\(\s*['"]\/dpr\/sas-url['"]/,
    );
    expect(apiSrc).toMatch(/filename:\s*`report\/\$\{filename\}`/);
    expect(apiSrc).toMatch(/container:\s*['"]dpr-documents['"]/);
  });

  test('3. api.js confirmReportUpload mirrors the request shape', () => {
    expect(apiSrc).toMatch(
      /confirmReportUpload:\s*\(\s*ulid\s*,\s*filename\s*,\s*contentType\s*,\s*sizeBytes\s*,\s*token\s*\)\s*=>\s*\n?\s*api\.post\(\s*['"]\/dpr\/confirm-upload['"]/,
    );
    expect(apiSrc).toMatch(/filename:\s*`report\/\$\{filename\}`/);
  });
});

describe('R35 — Project Reports: constants (src/lib/constants.js)', () => {
  test('4. constants.js exports MAX_REPORT_BYTES = 25 MB + 13-entry ACCEPTED_REPORT_TYPES', () => {
    expect(constantsSrc).toMatch(/MAX_REPORT_BYTES\s*=\s*25\s*\*\s*1024\s*\*\s*1024/);
    // 4 photo types + 1 PDF + 6 office types + 2 text types = 13.
    const acceptMatch = constantsSrc.match(
      /ACCEPTED_REPORT_TYPES\s*=\s*\[([\s\S]*?)\]/,
    );
    expect(acceptMatch).not.toBeNull();
    // Strip line-comments first (the array has comments between groups)
    // so the comma split doesn't pick up "// Photos" etc.
    const cleaned = acceptMatch[1]
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))   // drop trailing // comment
      .join('\n');
    const entries = cleaned
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))   // strip surrounding quotes
      .filter(Boolean);
    expect(entries).toHaveLength(13);
    expect(entries).toEqual(expect.arrayContaining([
      'image/jpeg', 'image/png', 'image/webp', 'image/heic',
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'text/plain', 'text/csv',
    ]));
  });

  test('5. constants.js exports PROJECT_REPORT_TYPES + PROJECT_REPORT_TYPE_LABELS', () => {
    expect(constantsSrc).toMatch(/PROJECT_REPORT_TYPES\s*=\s*Object\.keys\(PROJECT_REPORT_TYPE_LABELS\)/);
    expect(constantsSrc).toMatch(/PROJECT_REPORT_TYPE_LABELS\s*=\s*\{/);
    expect(constantsSrc).toMatch(/WEEKLY_REPORT:/);
    expect(constantsSrc).toMatch(/MONTHLY_REPORT:/);
    expect(constantsSrc).toMatch(/DUE_DILIGENCE_REPORT:/);
    expect(constantsSrc).toMatch(/QUALITY_REPORT:/);
    expect(constantsSrc).toMatch(/OTHER:/);
  });
});

describe('R35 — Project Reports: ProjectExpandedPanel wiring', () => {
  test('6. SECTION_IDS contains reports (plus the 5 pre-existing sections)', () => {
    expect(panelSrc).toMatch(
      /SECTION_IDS\s*=\s*\['overview',\s*'boq',\s*'dprs',\s*'inspections',\s*'drawings',\s*'reports'\]/,
    );
  });

  test('7. ProjectExpandedPanel renders <Section id="reports" ...> + ReportSection', () => {
    expect(panelSrc).toMatch(/id="reports"/);
    expect(panelSrc).toMatch(/<ReportSection\b/);
    // The Reports section wires the same props shape as DrawingSection —
    // isRegistered + projectKey + accessToken + refresh callbacks.
    expect(panelSrc).toMatch(
      /<ReportSection[\s\S]*?isRegistered=\{isRegistered\}[\s\S]*?projectKey=\{projectKey\}[\s\S]*?accessToken=\{accessToken\}[\s\S]*?onUploaded/,
    );
  });
});

// [Behavior tests] Mock setup at file scope so jest's hoisting
// can lift the jest.mock calls to before any require().
jest.mock('../contexts/AuthContext.jsx', () => ({
  useAuth: () => ({
    accessToken: 'test-token',
    employee: { id: 'emp-1', isAdmin: true, name: 'Test' },
  }),
}));

jest.mock('../contexts/ToastContext.jsx', () => ({
  useToast: () => ({ push: jest.fn(), dismiss: jest.fn() }),
}));

const mockGetProjectAttachments = jest.fn().mockResolvedValue({ attachments: [], nextCursor: null });

jest.mock('../lib/api.js', () => ({
  api: {
    getProjectAttachments: mockGetProjectAttachments,
    getProjects: jest.fn().mockResolvedValue([]),
    getBoqItems: jest.fn().mockResolvedValue([]),
    getDprs: jest.fn().mockResolvedValue([]),
    getInspections: jest.fn().mockResolvedValue([]),
    getDrawings: jest.fn().mockResolvedValue([]),
    getProjectParties: jest.fn().mockResolvedValue({}),
  },
}));

beforeEach(() => {
  mockGetProjectAttachments.mockClear();
});

describe('R35 — Project Reports: ProjectExpandedPanel wiring', () => {
  test('8. ProjectExpandedPanel issues api.getProjectAttachments(projectKey) on mount with limit 50 in the params (behavior)', () => {
    // [Behavior test] The original source-text pin locked the literal
    // `{limit: 50}` param shape. R44 added filterType/filterCategory
    // params between the mount and the call, so the params object is
    // now built into a variable (`initialParams`) before the call.
    // Mount the panel and assert the wire shape directly: the call
    // is made with the projectKey, a params object containing
    // `limit: 50`, and the accessToken.
    // Imports (React, render, waitFor, MemoryRouter) are at file top
    // because require()-inside-test triggers @testing-library/react's
    // auto-`afterEach(cleanup)` registration mid-test, which jest
    // rejects with "Hooks cannot be defined inside tests".
    const ProjectExpandedPanel = require('../pages/portal/ProjectExpandedPanel.jsx').default;
    render(
      React.createElement(
        MemoryRouter,
        null,
        React.createElement(ProjectExpandedPanel, {
          project: { id: 'proj-1', name: 'Test Project', isRegistered: true },
          accessToken: 'test-token',
          onClose: () => {},
          onOpenProjectDetail: () => {},
        }),
      ),
    );
    return waitFor(() => {
      expect(mockGetProjectAttachments.mock.calls.length).toBeGreaterThan(0);
      const [projectKey, params] = mockGetProjectAttachments.mock.calls[0];
      expect(projectKey).toBe('proj-1');
      expect(params.limit).toBe(50);
    });
  });

  test('9. ProjectExpandedPanel reruns the fetch when reportsRefreshKey bumps (source-text + behavior guard)', () => {
    // The refresh effect skips the initial mount (key === 0). To
    // exercise the refresh path we'd need to seed a row + click
    // Delete (which bumps reportsRefreshKey via the onDeleted
    // callback). That's covered by the 25/dpr test for the upload
    // path; here we pin the source-text guard so a future
    // refactor can't accidentally run the refresh on mount.
    expect(panelSrc).toMatch(/reportsRefreshKey\s*===\s*0\s*\)\s*return/);
    // The refresh effect must also call getProjectAttachments with
    // the same wire shape (projectKey + accessToken + params).
    expect(panelSrc).toMatch(/api\.getProjectAttachments\(\s*projectKey,\s*refreshParams,\s*accessToken/);
  });
});

describe('R35 — Project Reports: ReportSection component', () => {
  test('10. ReportSection uploads via getReportSasUrl + uploadBlob + confirmReportUpload + createProjectAttachment', () => {
    expect(panelSrc).toMatch(
      /api\.getReportSasUrl\(\s*uploadFile\.name,\s*uploadFile\.type,\s*accessToken,\s*\)/,
    );
    expect(panelSrc).toMatch(
      /await\s+uploadBlob\(\s*sasUrl,\s*uploadFile,\s*\{[\s\S]*?onProgress:\s*\(pct\)\s*=>\s*setUploadProgress\(pct\)/,
    );
    expect(panelSrc).toMatch(
      /await\s+api\.confirmReportUpload\(\s*ulid,\s*uploadFile\.name,\s*uploadFile\.type,\s*uploadFile\.size,\s*accessToken,\s*\)/,
    );
    expect(panelSrc).toMatch(
      /await\s+api\.createProjectAttachment\(\s*projectKey,\s*\{[\s\S]*?type:\s*uploadType[\s\S]*?blobPath/,
    );
  });

  test('11. ReportSection delete button gated on isAdmin || uploadedById === currentEmployeeId', () => {
    expect(panelSrc).toMatch(
      /const\s+canDelete\s*=\s*isAdmin\s*\|\|\s*\(\s*currentEmployeeId\s*&&\s*att\.uploadedById\s*===\s*currentEmployeeId\s*\)/,
    );
    // The Download button is unconditional; Delete is gated by canDelete.
    expect(panelSrc).toMatch(/>\s*Download\s*<\/button>/);
    expect(panelSrc).toMatch(/\{canDelete\s*&&\s*\(/);
  });

  test('12. ReportSection client-side validation uses MAX_REPORT_BYTES + ACCEPTED_REPORT_TYPES', () => {
    expect(panelSrc).toMatch(/file\.size\s*>\s*MAX_REPORT_BYTES/);
    expect(panelSrc).toMatch(/ACCEPTED_REPORT_TYPES\.includes\(\s*file\.type\s*\)/);
  });

  test('13. R35.1: discovered (unregistered) projects do NOT show the "register first" gate inside the Reports section (behavior)', () => {
    // [Behavior test] The original source-text pin looked for the
    // absence of "Register this project first to start uploading
    // reports." copy and the presence of `value={uploadType}` on
    // a `<select>`. R44 replaced the `<select>` with a FilterChip
    // row driven by UNIFIED_TAXONOMY, so `value={uploadType}` no
    // longer matches. Mount the panel with an UNregistered project
    // and assert the upload form (filter chip row) is still
    // present in the Reports section — the gate is gone, the form
    // is unconditional.
    //
    // Scope: the assertion is SCOPED to the Reports section
    // (`data-testid="projects-section-reports"`). The Drawings
    // section still legitimately shows a "Register this project
    // first to start tracking drawing revisions." gate for
    // unregistered projects — that's intentional and is NOT what
    // R35.1 removed. Without scoping, the test would fail on the
    // Drawings copy and conflate two unrelated gates.
    //
    // Imports (React, render, waitFor, screen, MemoryRouter) live
    // at file top because require()-inside-test triggers
    // @testing-library/react's auto-`afterEach(cleanup)` registration
    // mid-test, which jest rejects with "Hooks cannot be defined
    // inside tests".
    const ProjectExpandedPanel = require('../pages/portal/ProjectExpandedPanel.jsx').default;
    render(
      React.createElement(
        MemoryRouter,
        null,
        React.createElement(ProjectExpandedPanel, {
          // Discovered project: no id, only a name. isRegistered
          // resolves to false but the upload form in the Reports
          // section must still mount.
          project: { name: 'Discovered Project' },
          accessToken: 'test-token',
          onClose: () => {},
          onOpenProjectDetail: () => {},
        }),
      ),
    );
    return waitFor(() => {
      const reportsSection = screen.getByTestId('projects-section-reports');
      // The "register this project first" gate must not appear in
      // the Reports section (R35.1 removed it for upload forms).
      // The Drawings section's gate (different copy) is intentional
      // and out of scope here.
      expect(within(reportsSection).queryByText(/register this project first/i)).toBeNull();
      // The filter chip row must render regardless of isRegistered
      // — the gate is gone (R35.1). Use the underlying DOM element
      // for the class-name probe; within() wraps queryByText et al.
      // but does not expose raw querySelector.
      expect(reportsSection.querySelector('.filter-chip-row')).not.toBeNull();
    });
  });
});
