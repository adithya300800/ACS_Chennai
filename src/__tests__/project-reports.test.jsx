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

  test('8. ProjectExpandedPanel issues api.getProjectAttachments(projectKey) on mount, registered-only', () => {
    expect(panelSrc).toMatch(/api\.getProjectAttachments\(projectKey,\s*\{[^}]*limit:\s*50[^}]*\},\s*accessToken\)/);
    // Discovered (unregistered) rows get an empty list (no FK available).
    // The branch + the load effect's `if (isRegistered)` guard together
    // prove the contract.
    expect(panelSrc).toMatch(/setReports\(\{\s*status:\s*'loading'[\s\S]*?api\.getProjectAttachments/);
    expect(panelSrc).toMatch(/isRegistered[\s\S]*?api\.getProjectAttachments/);
  });

  test('9. ProjectExpandedPanel reruns the fetch when reportsRefreshKey bumps', () => {
    // Same shape as the drawings refresh effect: skip the initial mount
    // (key === 0), re-fetch when the user-triggered key bumps.
    expect(panelSrc).toMatch(/reportsRefreshKey\s*===\s*0/);
    expect(panelSrc).toMatch(
      /api\.getProjectAttachments\(projectKey,\s*\{[^}]*limit:\s*50[^}]*\},\s*accessToken\)[\s\S]*?setReports\(\{\s*status:\s*'ready'/,
    );
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

  test('13. R35.1: discovered (unregistered) projects do NOT show the "register first" gate', () => {
    // Round-35.1 removed the `if (!isRegistered)` early-return from
    // ReportSection — the upload form now renders for both registered
    // and discovered projects. The backend auto-creates the Project
    // row on the first POST (R35.1 server side). Pin the absence of
    // the now-deleted copy so a future refactor can't silently
    // re-introduce the gating.
    expect(panelSrc).not.toMatch(/Register this project first to start uploading reports\./);
    // The render form must reach the JSX without an `isRegistered`
    // guard short-circuiting it. We assert by looking for the upload
    // form's `<select>` element on the report type, which is
    // unconditional in the current implementation.
    expect(panelSrc).toMatch(/value=\{uploadType\}/);
  });
});
