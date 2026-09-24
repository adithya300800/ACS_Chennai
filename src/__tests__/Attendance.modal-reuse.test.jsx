// §8.13a (Fresh24 wave-4 batch-C) — Attendance date-detail overlay
// migrated to the shared <Modal> primitive.
//
// Acceptance (per the wave-4 batch-C spec):
//   1. The date-detail dialog renders inside <Modal> (not a custom
//      overlay div with className="modal-overlay").
//   2. Source-text pin: Attendance.jsx does NOT contain the literal
//      `<div className="modal-overlay"` pattern in the migrated area.
//   3. Source-text pin: Attendance.jsx imports Modal from
//      src/components/Modal.jsx.
//   4. Modal opens with proper ARIA semantics (role="dialog",
//      aria-modal="true") and aria-labelledby points at a heading.
//
// The render-time test mocks api.get so a calendar cell has a record,
// clicks that cell to open the modal, then asserts the dialog
// semantics — the same shape as careers-dr044's open-dialog test.
//
// Run: cd src && npx jest --testPathPattern="Attendance.modal-reuse"

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// CRITICAL: variable names MUST start with "mock" so jest's hoisted
// factory closure accepts the out-of-scope references.
const mockGet = jest.fn();

jest.mock('../contexts/AuthContext.jsx', () => ({
  useAuth: () => ({
    accessToken: 'test-token',
    employee: { id: 'emp-§8.13a' },
  }),
}));

jest.mock('../lib/api.js', () => ({
  api: {
    get: mockGet,
    post: jest.fn(),
  },
}));

jest.mock('../hooks/useDocumentTitle.js', () => ({
  useDocumentTitle: jest.fn(),
}));

// getBusinessToday is called on mount to seed `todayRecord`'s fetch
// and to drive the calendar's "today" highlight. We freeze it so the
// test is deterministic regardless of when CI runs it.
jest.mock('../lib/businessDate.js', () => ({
  getBusinessToday: () => '2026-09-15',
}));

beforeEach(() => {
  // /attendance/today returns null when no check-in has happened yet.
  // /attendance?month=... returns the list of records that drives the
  // calendar grid. We seed ONE record on day 15 (matches getBusinessToday
  // above) so a single click opens the date-detail modal.
  mockGet.mockImplementation((url) => {
    if (url.startsWith('/attendance/today')) {
      return Promise.resolve(null);
    }
    if (url.startsWith('/attendance?month=')) {
      return Promise.resolve([
        {
          id: 'rec-1',
          date: '2026-09-15',
          sessions: [
            {
              id: 'sess-1',
              checkIn: '2026-09-15T09:00:00Z',
              checkOut: '2026-09-15T17:30:00Z',
              checkInAddr: 'ACS Site Office',
              checkInLat: '13.0827',
              checkInLng: '80.2707',
            },
          ],
        },
      ]);
    }
    return Promise.resolve(null);
  });
});

const renderAttendance = () => {
  const Attendance = require('../pages/portal/Attendance.jsx').default;
  return render(
    <MemoryRouter initialEntries={['/portal/attendance']}>
      <Attendance />
    </MemoryRouter>
  );
};

// Wave-3 lesson: source-text pins must filter comments BEFORE
// regex-matching so future doc-comment additions don't silently change
// the verdict. Both block (`/* ... */`) and line (`// ...`) comments
// must go — the migration rationale above each import mentions the
// pre-fix pattern by name in prose, which would otherwise trip the
// negative-lookbehind pin.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')   // /* ... */
    .replace(/^\s*\/\/.*$/gm, '')        // line-leading // ...
    .replace(/[ \t]+\/\/.*$/gm, '');     // trailing-line // ...
}

describe('§8.13a — Attendance date-detail modal uses shared <Modal>', () => {
  test('source-text pin: Attendance.jsx imports Modal from src/components/Modal.jsx', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'pages', 'portal', 'Attendance.jsx'),
      'utf8'
    );
    expect(src).toMatch(
      /import\s+Modal\s+from\s+['"]\.\.\/\.\.\/components\/Modal\.jsx['"]/
    );
  });

  test('source-text pin: Attendance.jsx does NOT contain a hand-rolled <div className="modal-overlay"> in the migrated area', () => {
    // The pre-migration overlay pattern is the literal string
    // `className="modal-overlay"`. Comments that mention the migration
    // can legitimately include the phrase in prose — strip them first
    // so doc updates never flip this pin to a false-fail.
    const fs = require('fs');
    const path = require('path');
    const raw = fs.readFileSync(
      path.join(__dirname, '..', 'pages', 'portal', 'Attendance.jsx'),
      'utf8'
    );
    const stripped = stripComments(raw);
    // No JSX attribute named modal-overlay should remain. The migration
    // narrative in the comment block was already stripped, so a hit
    // here means someone reintroduced the custom overlay.
    expect(stripped).not.toMatch(/className\s*=\s*['"]modal-overlay['"]/);
  });

  test('clicking a calendar cell with a record opens a dialog with role="dialog", aria-modal="true", and aria-labelledby pointing at a heading', async () => {
    renderAttendance();

    // Wait for the calendar to render — month fetch resolves on mount.
    // The seeded record is for 2026-09-15 (matches getBusinessToday mock
    // so the cell is also flagged as "today"). The cell becomes
    // clickable once `monthStatus` flips to 'success' and the calendar
    // re-renders with `hasRecord = true`.
    const presentCell = await screen.findByText('15');
    const cell = presentCell.closest('.attendance-cal-cell');
    expect(cell).not.toBeNull();
    expect(cell.className).toContain('present');

    fireEvent.click(cell);

    // Modal.jsx renders into a portal on document.body with role=dialog.
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');

    const labelledById = dialog.getAttribute('aria-labelledby');
    expect(labelledById).toBeTruthy();
    const heading = document.getElementById(labelledById);
    expect(heading).not.toBeNull();
    expect(heading.tagName).toMatch(/^H[1-6]$/);
    // The seeded date renders the full date string in the heading via
    // formatFullDate. Loose substring match — the exact format depends
    // on the Intl locale and is not the contract we're pinning.
    expect(heading.textContent).toMatch(/2026/);
  });

  test('Escape closes the modal (Modal primitive owns Escape handling)', async () => {
    renderAttendance();

    const presentCell = await screen.findByText('15');
    const cell = presentCell.closest('.attendance-cal-cell');
    fireEvent.click(cell);

    // Confirm the dialog is mounted before we dispatch Escape.
    await screen.findByRole('dialog');

    // Modal.jsx registers the Escape handler on document with
    // capture=true (Modal.jsx line 167). Dispatch on the dialog itself
    // — the focused element after the dialog opens is the close button.
    const dialog = screen.getByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });
});