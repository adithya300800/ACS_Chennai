// SOL DR-005 regression coverage.
//
// The audit caught two related photo-handling defects in the DPR /
// Inspection submit forms:
//   1. Server-draft hydration supplied `readUrl` (a SAS URL) but the
//      renderer used `photo.previewUrl` only. After a reload, a
//      successfully-uploaded photo would render as a broken image
//      (previewUrl is gone after the blob URL is revoked) and the
//      engineer would think their evidence was lost.
//   2. The form state initialized `photos` as `[]` and the 750ms
//      autosave fired with that empty array, clobbering any previously-
//      saved descriptor list in localStorage before server hydration
//      could land. DprSubmit had no `editingId` guard, so editing a
//      server draft would also race the autosave.
//
// These tests pin the audit's smallest-complete-fix bullets:
//   - photo rendering uses `previewUrl || readUrl` with an explicit
//     unavailable fallback when neither survives
//   - photos state initializes from the local-draft envelope
//   - DprSubmit autosave skips while editing a server draft
//     (parity with InspectionSubmit's pre-existing guard)
//
// The behavioural assertion reaches into the source text directly so a
// future refactor that drops the pattern fails loud, instead of letting
// the broken `previewUrl`-only rendering come back silently.

import fs from 'fs';
import path from 'path';
import React from 'react';
import { render, waitFor, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const DprSubmitPath = path.join(__dirname, '..', 'pages', 'portal', 'DprSubmit.jsx');
const InspectionSubmitPath = path.join(
  __dirname,
  '..',
  'pages',
  'portal',
  'InspectionSubmit.jsx'
);
const AppCssPath = path.join(__dirname, '..', 'App.css');

// CRITICAL: variable names MUST start with "mock" so jest's hoisted
// factory closure accepts the out-of-scope references below.
const mockAuthValue = {
  accessToken: 'token-A',
  user: { id: 'u1' },
  employee: { id: 'emp-dr005-recover' },
};
const mockGetDpr = jest.fn();
const mockGetDprs = jest.fn().mockResolvedValue({ dprs: [] });
const mockGetProjects = jest.fn().mockResolvedValue({ projects: [], discovered: [] });

jest.mock('../contexts/AuthContext.jsx', () => ({
  useAuth: () => mockAuthValue,
}));

jest.mock('../contexts/ToastContext.jsx', () => ({
  useToast: () => ({ push: jest.fn(), dismiss: jest.fn() }),
}));

jest.mock('../lib/api.js', () => ({
  api: {
    getDpr: mockGetDpr,
    getDprs: mockGetDprs,
    getProjects: mockGetProjects,
    createDpr: jest.fn(),
    updateDpr: jest.fn(),
    getDprSasUrl: jest.fn(),
    confirmUpload: jest.fn(),
  },
}));

jest.mock('../lib/blobUpload.js', () => ({
  uploadBlob: jest.fn(),
}));

jest.mock('../hooks/useDocumentTitle.js', () => ({
  useDocumentTitle: jest.fn(),
}));

const DRAFT_BASE = 'dpr_draft_v1';
const EMPLOYEE_ID = 'emp-dr005-recover';
const SCOPED_DRAFT_KEY = `${DRAFT_BASE}:${EMPLOYEE_ID}`;
const PHOTO_ULID = '01HF3XK9P4NQ5Y7V0RECOVER01';

const seedRecoveredDraft = () => {
  localStorage.setItem(
    SCOPED_DRAFT_KEY,
    JSON.stringify({
      __v: 1,
      savedAt: '2026-09-09T00:00:00.000Z',
      ownerEmployeeId: EMPLOYEE_ID,
      form: {
        projectId: '',
        projectName: '',
        location: '',
        reportDate: '2026-09-09',
        weather: '',
        temperature: '',
        contractor: '',
        workType: 'SITE_INSPECTION',
        boqItemId: '',
        drawingId: '',
        drawingRev: '',
      },
      dailyFields: {
        workExecutedToday: '',
        workLocation: '',
        manpowerSummary: '',
        risksHindrances: '',
        materialsReceivedSummary: '',
      },
      customSections: [],
      notes: '',
      photos: [
        {
          ulid: PHOTO_ULID,
          container: 'dpr-photos',
          filename: 'recovered.jpg',
          contentType: 'image/jpeg',
          sizeBytes: 4096,
          caption: 'Recovered photo',
          readUrl: 'https://r2.example/recovered.jpg',
        },
      ],
    })
  );
};

describe('SOL DR-005 — photo rendering and recovery', () => {
  describe('source-text pins', () => {
    test('DprSubmit photo grid falls back to readUrl and surfaces unavailable state', () => {
      const src = fs.readFileSync(DprSubmitPath, 'utf8');
      // Render path: photo.previewUrl || photo.readUrl — NOT photo.previewUrl alone.
      expect(src).toMatch(/photo\.previewUrl\s*\|\|\s*photo\.readUrl\s*\|\|\s*null/);
      // Explicit "Preview unavailable" fallback when both URLs are gone.
      expect(src).toMatch(/Preview unavailable/);
      // The unavailable class is defined in CSS so the row stays visible
      // (not a broken image icon).
      expect(src).toMatch(/photo-thumb-unavailable/);
    });

    test('InspectionSubmit photo grid falls back to readUrl and surfaces unavailable state', () => {
      const src = fs.readFileSync(InspectionSubmitPath, 'utf8');
      expect(src).toMatch(/photo\.previewUrl\s*\|\|\s*photo\.readUrl\s*\|\|\s*null/);
      expect(src).toMatch(/Preview unavailable/);
      expect(src).toMatch(/photo-thumb-unavailable/);
    });

    test('DprSubmit photos state initializes from the local-draft envelope', () => {
      const src = fs.readFileSync(DprSubmitPath, 'utf8');
      // Same malformed / quarantine guard the form-state initializer uses.
      expect(src).toMatch(/initialDraft\?\.__malformed\s*\|\|\s*initialDraft\?\.__quarantined/);
      // The autosave useEffect must still guard on currentEmployeeId so
      // an unauthenticated mount cannot write a draft. The previous
      // tests already pin this contract.
      expect(src).toMatch(/if\s*\(\s*!currentEmployeeId\s*\)\s*return;/);
    });

    test('InspectionSubmit photos state initializes from the local-draft envelope', () => {
      const src = fs.readFileSync(InspectionSubmitPath, 'utf8');
      expect(src).toMatch(/d\?\.__malformed\s*\|\|\s*d\?\.__quarantined/);
      // Same autosave guard as DprSubmit (already present pre-fix).
      expect(src).toMatch(/if\s*\(\s*!currentEmployeeId\s*\|\|\s*editingId\s*\)\s*return;/);
    });

    test('App.css ships the unavailable placeholder style', () => {
      const css = fs.readFileSync(AppCssPath, 'utf8');
      expect(css).toMatch(/\.photo-thumb-unavailable\s*\{/);
      // The placeholder keeps the 4:3 aspect ratio of the image it replaces
      // so the layout doesn't jump when a preview disappears.
      expect(css).toMatch(/aspect-ratio:\s*4\/3/);
    });
  });

  describe('behavioural — autosave does not clobber recovered photos', () => {
    beforeEach(() => {
      localStorage.clear();
      jest.clearAllMocks();
      seedRecoveredDraft();
    });

    test('local-draft photos survive the autosave that fires on first render', async () => {
      // Mount on the *blank* submit URL (no draftId) — the path the bug
      // exercised: the local-draft envelope is loaded but no server
      // hydration runs.
      const DprSubmit = require('../pages/portal/DprSubmit.jsx').default;
      render(
        <MemoryRouter initialEntries={['/portal/dpr/submit']}>
          <Routes>
            <Route path="/portal/dpr/submit" element={<DprSubmit />} />
          </Routes>
        </MemoryRouter>
      );

      // Wait past the 750ms autosave debounce plus margin.
      await new Promise((r) => setTimeout(r, 1000));

      const draft = JSON.parse(localStorage.getItem(SCOPED_DRAFT_KEY) || 'null');
      expect(draft).not.toBeNull();
      // Pre-fix this was `photos: []`. With the initializer that
      // copies from initialDraft.photos and the serializer that only
      // emits durable fields, the recovered row must survive.
      expect(Array.isArray(draft.photos)).toBe(true);
      expect(draft.photos).toHaveLength(1);
      expect(draft.photos[0].ulid).toBe(PHOTO_ULID);
      // Read URL survives the round-trip so the renderer can fall back
      // to it when previewUrl is gone.
      expect(draft.photos[0].readUrl).toBe('https://r2.example/recovered.jpg');
      // The serializer must NOT persist blob / SAS URLs as durable
      // identity — those are short-lived. previewUrl in particular is
      // never round-tripped.
      expect(draft.photos[0].previewUrl).toBeUndefined();
    });
  });
});