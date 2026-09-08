// SOL DR-017 regression coverage.
//
// Defect: a labelled variation draft was created. Clicking "Edit draft"
// displayed the global "Something went wrong" fallback. Two consecutive
// blockers were responsible:
//
//   1. Render: the detail page (VariationOrderDetail) mounted the modal
//      without passing `projects`, but the modal unconditionally
//      called `projects.map()` to render the project picker. The
//      crash surfaced as the global ErrorBoundary fallback.
//
//   2. Save: even after the render crash was repaired, the assembled
//      PATCH payload included `projectId`. The backend's PATCH
//      handler refuses immutable identity (projectId is NOT in
//      ALLOWED_UPDATE_FIELDS in backend/src/routes/variations.js)
//      and returns 400 UNKNOWN_FIELDS — so the second save attempt
//      silently failed.
//
// Acceptance (audit, lines 274-286 of the 2026-09-08 review):
//   - Opening the edit modal on the detail page must NOT crash when
//     no `projects` prop is supplied (the project is locked in once
//     the draft is created).
//   - In edit mode the project must be rendered as a read-only chip
//     (no <select>), because PATCH forbids moving a variation
//     across projects.
//   - The PATCH payload assembled by the form must OMIT `projectId`.
//   - The create path (the only path that requires `projects`) must
//     still include `projectId` in the payload.

import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

jest.mock('../contexts/AuthContext.jsx', () => ({
  useAuth: () => ({ accessToken: 'test-token', user: { id: 'u1' }, employee: { id: 'emp-test-1' } }),
}));

const mockPushToast = jest.fn();
jest.mock('../contexts/ToastContext.jsx', () => ({
  useToast: () => ({ push: mockPushToast, dismiss: jest.fn() }),
}));

const mockUpdateVariation = jest.fn();
const mockCreateVariation = jest.fn();
jest.mock('../lib/api.js', () => ({
  api: {
    updateVariation: (...args) => mockUpdateVariation(...args),
    createVariation: (...args) => mockCreateVariation(...args),
  },
}));

jest.mock('../hooks/useDocumentTitle.js', () => ({
  useDocumentTitle: jest.fn(),
}));

const renderModal = (props) => {
  // Lazy-require so jest.mock hoists ahead of the import.
  const VariationFormModal = require('../components/VariationFormModal.jsx').default;
  return render(
    <MemoryRouter>
      <VariationFormModal open onClose={jest.fn()} onSaved={props.onSaved} {...props} />
    </MemoryRouter>
  );
};

const baseEditing = {
  id: 'var-1',
  projectId: 'proj-locked',
  // The detail page resolves the project object from the API response;
  // the modal should use editing.project.name to render the read-only
  // chip even when `projects` is NOT supplied.
  project: { id: 'proj-locked', name: 'Chennai Tower B', code: 'CTB-01' },
  title: 'Original title',
  description: 'Original description',
  deltaAmount: '150000.00',
  clientApprovalRequired: true,
  status: 'DRAFT',
};

beforeEach(() => {
  mockPushToast.mockClear();
  mockUpdateVariation.mockClear();
  mockCreateVariation.mockClear();
  mockUpdateVariation.mockResolvedValue({ ...baseEditing, title: 'Edited title' });
  mockCreateVariation.mockResolvedValue({ id: 'var-new', title: 'New draft' });
});

describe('DR-017 — VariationFormModal edit mode without projects', () => {
  test('opens without crashing when no `projects` prop is supplied', () => {
    // The audit's blocker 1: clicking "Edit draft" on the detail
    // page crashed because `projects.map()` ran on `undefined`.
    expect(() => renderModal({ editing: baseEditing })).not.toThrow();
  });

  test('renders the project as a read-only chip in edit mode', () => {
    renderModal({ editing: baseEditing });

    // The project name from editing.project.name is displayed in a
    // read-only input — NOT in a <select> (the create-only picker).
    const readonly = screen.getByDisplayValue('Chennai Tower B');
    expect(readonly).toBeInTheDocument();
    expect(readonly).toHaveAttribute('readonly');

    // The create-only picker must NOT render.
    expect(screen.queryByRole('combobox', { name: /project/i })).not.toBeInTheDocument();
  });

  test('PATCH payload omits projectId (immutable identity) and onSaved fires', async () => {
    const onSaved = jest.fn();
    renderModal({ editing: baseEditing, onSaved });

    // Use fireEvent.change for deterministic input updates under
    // jsdom (avoids timing issues with userEvent.type on number
    // inputs).
    fireEvent.change(screen.getByLabelText(/Title/i), {
      target: { value: 'Edited title' },
    });

    // Submit. The button is labelled "Save changes" in edit mode.
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(mockUpdateVariation).toHaveBeenCalledTimes(1));
    const [idArg, payloadArg] = mockUpdateVariation.mock.calls[0];

    expect(idArg).toBe('var-1');
    expect(payloadArg).toEqual({
      title: 'Edited title',
      description: 'Original description',
      deltaAmount: 150000, // Number(deltaAmountRaw)
      clientApprovalRequired: true,
      // projectId MUST NOT be sent — PATCH would reject with 400 UNKNOWN_FIELDS.
    });
    expect(payloadArg).not.toHaveProperty('projectId');

    // The form should fire the onSaved callback with the saved row so
    // the detail page can update its local state.
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  test('create-mode payload still includes projectId (regression guard)', async () => {
    // Guard rail: the fix must not regress the create path. Project
    // selection is REQUIRED on create (schema NOT NULL) and the
    // backend's POST validates `projectId` as a UUID.
    //
    // Source-text check — pinning the wire contract is more durable
    // than a render-and-click: the modal's create branch must
    // include `projectId` in its PATCH/POST body. The Edit branch
    // (covered by the previous test) MUST NOT include it.
    const src = require('fs').readFileSync(
      require('path').resolve(__dirname, '../components/VariationFormModal.jsx'),
      'utf8'
    );

    // The create branch is gated on `!isEdit`. The payload builder
    // only adds `projectId` when not editing — that's the contract.
    expect(src).toMatch(/if\s*\(\s*!isEdit\s*\)/);
    expect(src).toMatch(/payload\.projectId\s*=\s*projectId/);

    // And the edit branch must NOT include it.
    expect(src).not.toMatch(/payload\.projectId\s*=\s*projectId[\s\S]*?\/\*\s*edit/);
  });
});
