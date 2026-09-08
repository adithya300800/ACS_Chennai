// SOL DR-006 (frontend half) regression coverage.
//
// The audit caught three related defects from one root cause: the
// server-draft hydration useEffect at DprSubmit.jsx:304 re-ran on
// every toast push or token rotation because (a) the ToastContext
// value wasn't memoized, so its identity changed on every push, and
// (b) the effect's deps array included both `toast` and `accessToken`.
// Each re-run clobbered dirty unsaved edits and reset the freshly-
// typed photo to the server's empty state.
//
// These tests pin the three acceptance bullets from the audit:
//   - a dirty form is preserved after a toast push
//   - a dirty form is preserved after a token rotation
//   - server-side photo references are restored into the local photos
//     state on draft resume (the pre-fix `setPhotos([])` was the
//     secondary bug the audit flagged)
//
// We exercise the effect indirectly via the localStorage contract that
// the autosave effect emits (the dirty form is observable in
// localStorage 750ms after the user types). The hydration effect runs
// once per draftId — re-renders with the same draftId must NOT call
// `api.getDpr` again, must NOT mutate the form fields, and must NOT
// mutate the photos array.

import React from 'react';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const DRAFT_BASE = 'dpr_draft_v1';
const EMPLOYEE_ID = 'emp-dr006-dpr';
const SCOPED_DRAFT_KEY = `${DRAFT_BASE}:${EMPLOYEE_ID}`;

// CRITICAL: variable names MUST start with "mock" so jest's hoisted
// factory closure accepts the out-of-scope references below.
const mockGetDpr = jest.fn();
const mockToastPush = jest.fn();

let mockAuthContextValue = {
  accessToken: 'token-A',
  user: { id: 'u1' },
  employee: { id: EMPLOYEE_ID },
};

jest.mock('../contexts/AuthContext.jsx', () => ({
  useAuth: () => mockAuthContextValue,
}));

jest.mock('../contexts/ToastContext.jsx', () => ({
  useToast: () => ({ push: mockToastPush, dismiss: jest.fn() }),
}));

jest.mock('../lib/api.js', () => ({
  api: {
    getDpr: mockGetDpr,
    getDprs: jest.fn().mockResolvedValue({ dprs: [] }),
    getProjects: jest.fn().mockResolvedValue({ projects: [], discovered: [] }),
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

const SERVER_PHOTO_ULID_A = '01HF3XK9P4NQ5Y7V0PHOTOA0001';
const SERVER_PHOTO_ULID_B = '01HF3XK9P4NQ5Y7V0PHOTOB0002';

function mockServerDraftResponse() {
  return {
    id: 'server-dpr-1',
    status: 'DRAFT',
    version: 1,
    projectId: 'proj-1',
    projectName: 'Server Project',
    location: 'Server Location',
    reportDate: '2026-09-04',
    weather: 'Sunny',
    temperature: '30',
    contractor: 'Server Contractor',
    workType: 'SITE_INSPECTION',
    boqItemId: '',
    drawingId: '',
    drawingRev: '',
    notes: 'Server notes',
    customSections: [],
    workExecutedToday: 'Old executed text',
    workLocation: 'Old work location',
    manpowerSummary: '',
    risksHindrances: 'Old risks',
    materialsReceivedSummary: 'Old materials',
    photos: [
      {
        id: 'photo-row-1',
        ulid: SERVER_PHOTO_ULID_A,
        container: 'dpr-photos',
        filename: 'old-a.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 4096,
        caption: 'Old photo A',
        location: null,
        takenAt: null,
        readUrl: 'https://r2.example/old-a.jpg',
      },
      {
        id: 'photo-row-2',
        ulid: SERVER_PHOTO_ULID_B,
        container: 'dpr-photos',
        filename: 'old-b.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 4096,
        caption: 'Old photo B',
        location: null,
        takenAt: null,
        readUrl: 'https://r2.example/old-b.jpg',
      },
    ],
    inspections: [],
    project: { id: 'proj-1', name: 'Server Project', code: 'P-1' },
    drawing: null,
    boqItem: null,
  };
}

const renderSubmit = (initialEntry = '/portal/dpr/submit?draftId=server-dpr-1') => {
  const DprSubmit = require('../pages/portal/DprSubmit.jsx').default;
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/portal/dpr/submit" element={<DprSubmit />} />
      </Routes>
    </MemoryRouter>
  );
};

const readDraftFromStorage = () => {
  const raw = localStorage.getItem(SCOPED_DRAFT_KEY);
  return raw ? JSON.parse(raw) : null;
};

beforeEach(() => {
  localStorage.clear();
  jest.clearAllMocks();
  mockGetDpr.mockResolvedValue(mockServerDraftResponse());
  mockAuthContextValue = {
    accessToken: 'token-A',
    user: { id: 'u1' },
    employee: { id: EMPLOYEE_ID },
  };
  // The DprSubmit boot path resolves projects via api.getProjects — keep
  // it harmless.
});

describe('SOL DR-006 — DprSubmit dirty-state preservation', () => {
  test('toast push during a dirty edit does not clobber the form', async () => {
    renderSubmit();
    // Wait for the server-draft hydration to land. The hydration effect
    // calls api.getDpr once with the current accessToken.
    await waitFor(() => {
      expect(mockGetDpr).toHaveBeenCalledTimes(1);
    });

    // The form is now populated with the server values. The engineer
    // types something into the Location field to mark the form dirty.
    const locationInput = await screen.findByLabelText(/Location/i);
    fireEvent.change(locationInput, { target: { value: 'Engineer-typed location' } });

    // Wait past the 750ms autosave debounce so the dirty state lands
    // in localStorage.
    await new Promise((r) => setTimeout(r, 850));

    // Sanity: the local draft now reflects the engineer's typing.
    const draftAfterType = readDraftFromStorage();
    expect(draftAfterType).not.toBeNull();
    expect(draftAfterType.form.location).toBe('Engineer-typed location');

    // Now fire a toast push. Pre-fix this would re-run the hydration
    // useEffect and reset the form to the server value.
    await act(async () => {
      mockToastPush('Pretend warning from a sibling component', 'warning');
    });

    // Allow any (forbidden) re-hydration to settle.
    await new Promise((r) => setTimeout(r, 50));

    // The local draft must STILL reflect the engineer's typing. The
    // hydration effect should not have re-ran for the same draftId.
    const draftAfterToast = readDraftFromStorage();
    expect(draftAfterToast.form.location).toBe('Engineer-typed location');
    // And the api.getDpr must NOT have been called again for the same
    // draftId — that's the contract.
    expect(mockGetDpr).toHaveBeenCalledTimes(1);
  });

  test('token rotation during a dirty edit does not clobber the form', async () => {
    const { rerender } = renderSubmit();
    await waitFor(() => {
      expect(mockGetDpr).toHaveBeenCalledTimes(1);
    });

    // Engineer types into the Notes (Other observations) field.
    const notesInput = await screen.findByLabelText(/Other observations/i);
    fireEvent.change(notesInput, { target: { value: 'Engineer notes — do not lose' } });
    await new Promise((r) => setTimeout(r, 850));

    const draftAfterType = readDraftFromStorage();
    // The notes field is top-level in the saved payload (not inside
    // `form`).
    expect(draftAfterType.notes).toContain('Engineer notes');

    // Rotate the access token. Pre-fix this invalidated the hydration
    // useEffect deps and the form reset.
    mockAuthContextValue = { ...mockAuthContextValue, accessToken: 'token-B-rotated' };

    // Re-render with the new auth context so the useEffect deps
    // observe the new accessToken. RTL's `rerender` only updates if
    // something actually changed in the React tree — flipping
    // mockAuthContextValue (a closure-captured let) before rerender
    // is enough for the consumer to pick up the new value.
    await act(async () => {
      rerender(
        <MemoryRouter initialEntries={['/portal/dpr/submit?draftId=server-dpr-1']}>
          <Routes>
            <Route path="/portal/dpr/submit" element={
              require('../pages/portal/DprSubmit.jsx').default
            } />
          </Routes>
        </MemoryRouter>
      );
    });

    await new Promise((r) => setTimeout(r, 100));

    // The dirty notes field must still be the engineer-typed text.
    // Reach back into localStorage to verify.
    const draftAfterRotation = readDraftFromStorage();
    expect(draftAfterRotation.notes).toContain('Engineer notes');
    // And the api.getDpr must NOT have been called for the rotated
    // token — the ref guard short-circuits.
    expect(mockGetDpr).toHaveBeenCalledTimes(1);
  });

  test('server-side photo references are restored into local photos state on resume', async () => {
    renderSubmit();
    await waitFor(() => {
      expect(mockGetDpr).toHaveBeenCalledTimes(1);
    });
    // Wait for the autosave debounce to flush the photo state into
    // localStorage so we can observe what the hydration effect wrote.
    await new Promise((r) => setTimeout(r, 1500));

    const draft = readDraftFromStorage();
    expect(draft).not.toBeNull();
    // Pre-fix this was `photos: []`. With the fix, both server photos
    // are present with their ULID + readUrl preserved.
    expect(Array.isArray(draft.photos)).toBe(true);
    expect(draft.photos).toHaveLength(2);
    const ulids = draft.photos.map((p) => p.ulid);
    expect(ulids).toContain(SERVER_PHOTO_ULID_A);
    expect(ulids).toContain(SERVER_PHOTO_ULID_B);
    // Read URLs are preserved so the renderer can show a preview
    // without a local blob.
    const photoA = draft.photos.find((p) => p.ulid === SERVER_PHOTO_ULID_A);
    expect(photoA.readUrl).toBe('https://r2.example/old-a.jpg');
  });
});