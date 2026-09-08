// SOL DR-006-symmetric regression coverage for InspectionSubmit.
//
// Mirrors src/__tests__/DprSubmit.dr006.test.jsx. The symmetric
// hydration refactor in InspectionSubmit.jsx (lastHydratedDraftIdRef
// guard + serverPhoto setPhotos restore) was applied after the
// equivalent fix on DprSubmit. These tests pin the three
// acceptance bullets from the audit for the inspector path:
//   - a dirty form is preserved after a token rotation (the audit's
//     canonical re-render trigger)
//   - the hydration effect runs only once per draftId even when
//     re-rendered
//   - server-side photo references are restored into the local photos
//     state on draft resume (the pre-fix `setPhotos([])` was the
//     secondary bug the audit flagged)
//
// TEST-MOCK NOTE: useToast is intentionally memoized at a module-level
// `mockStableToast` reference. The real ToastContext memoizes its
// value (see src/contexts/ToastContext.jsx:64-72). If the test mock
// returned a fresh `{ push, dismiss }` object on every render the
// `cancelled` cleanup branch in the hydration effect's async IIFE
// would short-circuit the first-await's setState calls (state would
// never be populated). Mirroring the production memoization keeps the
// test honest about what production actually does.
//
// We observe the photos-restored case via the rendered DOM (the
// `.photo-thumb` grid) rather than localStorage because DR-007's
// autosave gate (`if (editingId) return;`) prevents the autosave
// useEffect from mirroring server-restored photos into localStorage
// while we're editing a server-side draft.

import React from 'react';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const EMPLOYEE_ID = 'emp-dr006-ins';
const DRAFT_BASE = 'inspection_draft_v1';
const SCOPED_DRAFT_KEY = `${DRAFT_BASE}:${EMPLOYEE_ID}`;

// CRITICAL: variable names MUST start with "mock" so jest's hoisted
// factory closure accepts the out-of-scope references below.
const mockGetInspection = jest.fn();
const mockStableToast = { push: jest.fn(), dismiss: jest.fn() };

let mockAuthContextValue = {
  accessToken: 'token-A',
  user: { id: 'u1' },
  employee: { id: EMPLOYEE_ID },
};

jest.mock('../contexts/AuthContext.jsx', () => ({
  useAuth: () => mockAuthContextValue,
}));

jest.mock('../contexts/ToastContext.jsx', () => ({
  useToast: () => mockStableToast,
}));

jest.mock('../lib/api.js', () => ({
  api: {
    getInspection: mockGetInspection,
    getInspections: jest.fn().mockResolvedValue({ inspections: [] }),
    getProjects: jest.fn().mockResolvedValue({ projects: [], discovered: [] }),
    getDprs: jest.fn().mockResolvedValue({ dprs: [] }),
    getBoqItems: jest.fn().mockResolvedValue({ items: [] }),
    createInspection: jest.fn(),
    updateInspection: jest.fn(),
    getInspectionSasUrl: jest.fn(),
    confirmInspectionUpload: jest.fn(),
  },
}));

jest.mock('../lib/blobUpload.js', () => ({
  uploadBlob: jest.fn(),
}));

jest.mock('../hooks/useDocumentTitle.js', () => ({
  useDocumentTitle: jest.fn(),
}));

const SERVER_PHOTO_ULID_A = '01HF3XK9P4NQ5Y7V0INSPHOTOA01';
const SERVER_PHOTO_ULID_B = '01HF3XK9P4NQ5Y7V0INSPHOTOB02';

function mockServerDraftResponse() {
  return {
    id: 'server-ins-1',
    status: 'DRAFT',
    version: 1,
    projectId: 'proj-1',
    projectName: 'Server Inspection Project',
    location: 'Server Inspection Location',
    reportDate: '2026-09-04',
    weather: 'Sunny',
    contractor: 'Server Contractor',
    boqItemId: '',
    drawingId: '',
    drawingRev: '',
    inspectionType: 'material_inspection',
    data: { supplier: 'ServerCo', quantityKg: '100' },
    photos: [
      {
        id: 'photo-row-1',
        ulid: SERVER_PHOTO_ULID_A,
        container: 'inspection-photos',
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
        container: 'inspection-photos',
        filename: 'old-b.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 4096,
        caption: 'Old photo B',
        location: null,
        takenAt: null,
        readUrl: 'https://r2.example/old-b.jpg',
      },
    ],
    project: { id: 'proj-1', name: 'Server Inspection Project', code: 'P-1' },
  };
}

const renderSubmit = (initialEntry = '/portal/inspection/submit?draftId=server-ins-1') => {
  const InspectionSubmit = require('../pages/portal/InspectionSubmit.jsx').default;
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/portal/inspection/submit" element={<InspectionSubmit />} />
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
  mockGetInspection.mockResolvedValue(mockServerDraftResponse());
  mockAuthContextValue = {
    accessToken: 'token-A',
    user: { id: 'u1' },
    employee: { id: EMPLOYEE_ID },
  };
});

describe('SOL DR-006 — InspectionSubmit dirty-state preservation', () => {
  test('hydration runs once and does not re-run on a sibling re-render', async () => {
    const { rerender } = renderSubmit();
    // Wait for the server-draft hydration to land. The hydration effect
    // calls api.getInspection once with the current accessToken.
    await waitFor(() => {
      expect(mockGetInspection).toHaveBeenCalledTimes(1);
    });
    // State populated from the server response — proves the await chain
    // completed and the setForm/setPhotos setStates applied.
    const locationInput = await screen.findByDisplayValue('Server Inspection Location');
    expect(locationInput).toBeInTheDocument();

    // Force a re-render via token rotation (the canonical trigger that
    // changes the effect's `accessToken` dep and historically caused
    // the hydration effect to re-run and clobber dirty edits).
    mockAuthContextValue = { ...mockAuthContextValue, accessToken: 'token-B-rotated' };
    await act(async () => {
      rerender(
        <MemoryRouter initialEntries={['/portal/inspection/submit?draftId=server-ins-1']}>
          <Routes>
            <Route path="/portal/inspection/submit" element={
              React.createElement(require('../pages/portal/InspectionSubmit.jsx').default)
            } />
          </Routes>
        </MemoryRouter>
      );
    });
    // The ref guard short-circuits the second render's hydration — no
    // second GET against the same draftId.
    await new Promise((r) => setTimeout(r, 100));
    expect(mockGetInspection).toHaveBeenCalledTimes(1);
  });

  test('token rotation during a dirty edit does not clobber the form', async () => {
    const { rerender } = renderSubmit();
    await waitFor(() => {
      expect(mockGetInspection).toHaveBeenCalledTimes(1);
    });

    // Engineer types into the Location field, replacing the hydrated
    // server value with their own dirty text.
    const locationInput = await screen.findByLabelText(/Location/i);
    fireEvent.change(locationInput, { target: { value: 'Engineer-typed-do-not-lose' } });
    expect(locationInput.value).toBe('Engineer-typed-do-not-lose');

    // Rotate the access token. Pre-fix this invalidated the hydration
    // useEffect deps and the form reset.
    mockAuthContextValue = { ...mockAuthContextValue, accessToken: 'token-B-rotated' };
    await act(async () => {
      rerender(
        <MemoryRouter initialEntries={['/portal/inspection/submit?draftId=server-ins-1']}>
          <Routes>
            <Route path="/portal/inspection/submit" element={
              React.createElement(require('../pages/portal/InspectionSubmit.jsx').default)
            } />
          </Routes>
        </MemoryRouter>
      );
    });
    await new Promise((r) => setTimeout(r, 100));

    // The dirty location field must still be the engineer-typed text.
    // NOTE: DR-007's autosave gate (`if (editingId) return`) prevents
    // the autosave from mirroring form state to localStorage while
    // editing a server-side draft — so we observe the DOM input value
    // directly. (DprSubmit's autosave isn't gated, which is why that
    // sibling test can verify via localStorage.)
    const locationAfterRotation = screen.getByDisplayValue('Engineer-typed-do-not-lose');
    expect(locationAfterRotation).toBeInTheDocument();
    // And the api.getInspection must NOT have been called for the
    // rotated token — the ref guard short-circuits.
    expect(mockGetInspection).toHaveBeenCalledTimes(1);
  });

  test('server-side photo references are restored into local photos state on resume', async () => {
    const { container } = renderSubmit();
    await waitFor(() => {
      expect(mockGetInspection).toHaveBeenCalledTimes(1);
    });
    // Wait for the hydration effect's setPhotos(serverPhotos.map(...))
    // to commit and the renderer to lay out the .photo-thumb elements.
    // NOTE: DR-007's autosave gate (`if (editingId) return`) prevents
    // the autosave useEffect from mirroring the restored photos into
    // localStorage while we're editing a server-side draft — so we
    // observe the in-memory state via the rendered DOM instead.
    await waitFor(() => {
      const thumbs = container.querySelectorAll('.photo-thumb');
      expect(thumbs).toHaveLength(2);
    });
    // Caption inputs are keyed on photo.ulid — asserting their values
    // confirms the server-side entries landed with the expected shape.
    const captionInputs = container.querySelectorAll('.photo-caption-input');
    expect(captionInputs).toHaveLength(2);
    const captionValues = Array.from(captionInputs).map((el) => el.value);
    expect(captionValues).toEqual(
      expect.arrayContaining(['Old photo A', 'Old photo B'])
    );
  });
});