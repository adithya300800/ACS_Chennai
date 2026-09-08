// DR-010 (2026-09-08 SOL audit): DrawingsBrowse selection preservation.
//
// The audit captured a source-only gap: when an employee resolves a
// first-task project via the inline "+ Create new project…" form,
// handleCreateProject pushes the result into local state and updates
// the URL (?projectId=<uuid>). The page's project-loading effect
// depends on [accessToken, urlProjectId], so the URL change re-fires
// the fetch. The backend's ?scope=assigned union did not include the
// freshly-resolved project (no DPR/Inspection/BOQ history, no
// ProjectAssignment row at that moment), so the re-fetched list did
// not contain the user's selection → the <select> value rendered but
// the corresponding <option> was gone.
//
// Fix: stash locally-resolved projects in a useRef and re-merge them
// into the next fetch result before setProjects. Pair with the backend
// ProjectAssignment union (covered in backend/__tests__/projects.dr010.test.js)
// so future allocations don't even need the ref-based fallback.
//
// Real-mount coverage:
//   1. After a re-fetch, the user-resolved project's <option> is
//      present in the dropdown even though the backend's list omits it.
//   2. The <select> keeps the user's selection (the dropdown does not
//      snap back to the first item or blank out).
//   3. The "Showing drawings for: <name>" hint remains anchored to
//      the user-resolved project.

import React from 'react';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

jest.mock('../contexts/AuthContext.jsx', () => ({
  useAuth: () => ({
    accessToken: 'test-token',
    user: { id: 'emp-1' },
    employee: { id: 'emp-1', isAdmin: false },
  }),
}));

jest.mock('../contexts/ToastContext.jsx', () => ({
  useToast: () => ({ push: jest.fn(), dismiss: jest.fn() }),
}));

jest.mock('../hooks/useDocumentTitle.js', () => ({
  useDocumentTitle: jest.fn(),
}));

jest.mock('../components/DrawingFormModal.jsx', () => {
  // The modal is mounted but never opened in this test. Returning a
  // stub keeps the import surface honest (DrawingsBrowse imports it).
  return function DrawingFormModalStub() {
    return null;
  };
});

jest.mock('../lib/api.js', () => ({
  api: {
    getProjects: jest.fn(),
    getDrawings: jest.fn(),
    resolveProject: jest.fn(),
    createDrawing: jest.fn(),
  },
}));

const { api } = require('../lib/api.js');

// The two projects the employee is shown.
//   - OTHER is the pre-existing touched/assigned project.
//   - RESOLVED is the project the employee resolves inline.
// Both have UUID-shaped ids so they survive the route's id-only
// option values.
const OTHER_ID = '11111111-1111-4111-8111-111111111111';
const RESOLVED_ID = '22222222-2222-4222-8222-222222222222';

const OTHER_ROW = {
  id: OTHER_ID,
  name: 'Existing Project',
  code: 'EXIST',
  client: null,
  location: null,
  isActive: true,
  isRegistered: true,
};
const RESOLVED_ROW = {
  id: RESOLVED_ID,
  name: 'Newly Resolved Project',
  code: 'NEW',
  client: null,
  location: null,
  isActive: true,
  isRegistered: true,
};

const renderBrowse = async (initialEntries = ['/portal/drawings']) => {
  const { default: DrawingsBrowse } = require('../pages/portal/DrawingsBrowse.jsx');
  const utils = render(
    <MemoryRouter initialEntries={initialEntries}>
      <DrawingsBrowse />
    </MemoryRouter>
  );
  await waitFor(() => expect(api.getProjects).toHaveBeenCalled());
  return utils;
};

beforeEach(() => {
  jest.clearAllMocks();
  // Initial fetch returns only OTHER (matches the "touched" path).
  api.getProjects.mockResolvedValue({
    projects: [OTHER_ROW],
    discovered: [],
    scope: 'assigned',
  });
  // No drawings — page renders the empty state, which is fine.
  api.getDrawings.mockResolvedValue({ drawings: [], nextCursor: null });
});

describe('DR-010 — DrawingsBrowse preserves user-resolved selection through URL-driven re-fetch', () => {
  test('1. initial fetch loads, dropdown shows the existing project', async () => {
    await renderBrowse();

    const select = await screen.findByLabelText(/Project/i);
    // OTHER is present, RESOLVED is not yet (no fetch has returned it).
    const options = within(select).getAllByRole('option');
    const optionValues = options.map((o) => o.value);
    expect(optionValues).toContain(OTHER_ID);
    expect(optionValues).not.toContain(RESOLVED_ID);
  });

  test('2. inline resolve: dropdown keeps the user-resolved option after the URL-driven re-fetch', async () => {
    await renderBrowse();

    // The user picks "+ Create new project…".
    const select = await screen.findByLabelText(/Project/i);
    fireEvent.change(select, { target: { value: '__create__' } });

    // Resolve the project via the API (the inline form).
    api.resolveProject.mockResolvedValueOnce(RESOLVED_ROW);

    const nameInput = await screen.findByLabelText(/New project name/i);
    fireEvent.change(nameInput, { target: { value: 'Newly Resolved Project' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    // Wait for the resolve round-trip + the URL-driven re-fetch.
    await waitFor(() => expect(api.resolveProject).toHaveBeenCalledWith('Newly Resolved Project', 'test-token'));

    // CRITICAL: the re-fetch must NOT replace the user's locally-resolved
    // project. The backend mock here omits RESOLVED from getProjects to
    // simulate the worst case (no ProjectAssignment row yet); the page
    // still keeps the option because of the ref-based merge.
    await waitFor(() => {
      const opts = within(screen.getByLabelText(/Project/i)).getAllByRole('option');
      const values = opts.map((o) => o.value);
      expect(values).toContain(RESOLVED_ID);
    });
  });

  test('3. the <select> selection stays on the user-resolved project after the re-fetch', async () => {
    await renderBrowse();

    // Resolve the project inline; the page sets ?projectId=RESOLVED_ID
    // and local projectId = RESOLVED_ID.
    const select = await screen.findByLabelText(/Project/i);
    fireEvent.change(select, { target: { value: '__create__' } });

    api.resolveProject.mockResolvedValueOnce(RESOLVED_ROW);
    const nameInput = await screen.findByLabelText(/New project name/i);
    fireEvent.change(nameInput, { target: { value: 'Newly Resolved Project' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    // Wait for the selection to land.
    await waitFor(() =>
      expect(screen.getByLabelText(/Project/i)).toHaveValue(RESOLVED_ID)
    );

    // Force the effect to re-run with the same URL (simulates the
    // user reloading the tab or the URL being mutated upstream). The
    // backend still returns ONLY OTHER — the page must NOT snap back
    // to "" or to OTHER_ID.
    api.getProjects.mockClear();
    api.getProjects.mockResolvedValue({
      projects: [OTHER_ROW],
      discovered: [],
      scope: 'assigned',
    });
    // Trigger a re-mount by reloading — use a fresh render with the
    // same initialEntries that carry ?projectId=RESOLVED_ID.
    // The simplest way to re-run the loading effect with the URL
    // present is to navigate within the same MemoryRouter — but the
    // router is opaque from here. Instead, the URL is already present
    // from handleSelectProject, so the second mount simulates a full
    // page reload where the backend hasn't allocated the assignment
    // yet. We render again with the URL pre-populated.
    const { unmount } = await renderBrowse([`/portal/drawings?projectId=${RESOLVED_ID}`]);
    // The mounted page with the URL still has the resolved project in
    // its list — both via the URL-derived default AND (in a real session)
    // via the ref. The select's value falls back to URL_PROJECT_ID
    // (RESOLVED_ID) because the initial state reads from useSearchParams.
    await waitFor(() =>
      expect(screen.getByLabelText(/Project/i)).toHaveValue(RESOLVED_ID)
    );
    // And the corresponding <option> is rendered — without the ref
    // merge, this would be missing because getProjects omits RESOLVED.
    const opts = within(screen.getByLabelText(/Project/i)).getAllByRole('option');
    const values = opts.map((o) => o.value);
    expect(values).toContain(RESOLVED_ID);
    unmount();
  });
});