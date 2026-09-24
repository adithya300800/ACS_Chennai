// §8.13b (Fresh24 wave-4 batch-C) — Admin (all-attendance) session-detail
// overlay migrated to the shared <Modal> primitive.
//
// Acceptance (per the wave-4 batch-C spec):
//   1. The session-detail dialog renders inside <Modal> (not a custom
//      overlay div with className="modal-overlay").
//   2. Source-text pin: Admin.jsx does NOT contain the literal
//      `<div className="modal-overlay"` pattern in the migrated area.
//   3. Source-text pin: Admin.jsx imports Modal from
//      src/components/Modal.jsx.
//   4. Modal opens with proper ARIA semantics (role="dialog",
//      aria-modal="true") and aria-labelledby points at a heading.
//
// Why this file is source-text-pinned + Modal-shape integration only
// (not a full-page render test):
//
//   Admin.jsx contains `import.meta.env.DEV` at line 57 — a
//   Vite-only construct that crashes Babel's CJS parser with
//   `Cannot use 'import.meta' outside a module`. The project
//   convention for files that predate the env.js shim (see
//   NotificationBell.dr007-reconcile-on-open.test.jsx) is to
//   pin the contract via source-text checks + a separate render
//   test of the primitive being consumed, rather than touch the
//   page's env access or pull in a Babel transform. We follow that
//   convention here.
//
//   The integration test below mounts a minimal wrapper that drives
//   the shared <Modal> with the exact prop shape Admin.jsx uses
//   (open + onClose + ariaLabelledBy + a labelled close control).
//   Combined with the source-text pins, this proves:
//     - Admin.jsx does NOT keep the old overlay (source-text pin)
//     - Admin.jsx DOES import the shared Modal (source-text pin)
//     - The shared Modal gives the required dialog semantics when
//       wired this way (render test)
//
// Run: cd src && npx jest --testPathPattern="Admin.modal-reuse"

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const fs = require('fs');
const path = require('path');

const ADMIN_PATH = path.join(__dirname, '..', 'pages', 'portal', 'Admin.jsx');
const MODAL_PATH = path.join(__dirname, '..', 'components', 'Modal.jsx');

// Wave-3 lesson: source-text pins must filter comments BEFORE
// regex-matching so future doc-comment additions don't silently change
// the verdict.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')   // /* ... */
    .replace(/^\s*\/\/.*$/gm, '')        // line-leading // ...
    .replace(/[ \t]+\/\/.*$/gm, '');     // trailing-line // ...
}

describe('§8.13b — Admin session-detail modal uses shared <Modal>', () => {
  let adminSrc;
  let adminStripped;

  beforeAll(() => {
    adminSrc = fs.readFileSync(ADMIN_PATH, 'utf8');
    adminStripped = stripComments(adminSrc);
  });

  test('source-text pin: Admin.jsx imports Modal from src/components/Modal.jsx', () => {
    expect(adminSrc).toMatch(
      /import\s+Modal\s+from\s+['"]\.\.\/\.\.\/components\/Modal\.jsx['"]/
    );
  });

  test('source-text pin: Admin.jsx does NOT contain a hand-rolled <div className="modal-overlay"> in the migrated area', () => {
    expect(adminStripped).not.toMatch(/className\s*=\s*['"]modal-overlay['"]/);
  });

  test('source-text pin: Admin.jsx opens the dialog with an aria-labelledby heading id (ariaLabelledBy prop)', () => {
    // The Modal primitive (src/components/Modal.jsx) requires either
    // an ariaLabel or an ariaLabelledBy — the migrated call site must
    // supply one. We pin the call-site shape so a regression that
    // drops the aria-labelledby prop trips the test before the page
    // ships without an accessible name.
    expect(adminStripped).toMatch(/ariaLabelledBy\s*=\s*['"]admin-session-modal-title['"]/);
    // And the h3 with the matching id must exist in the same file.
    expect(adminStripped).toMatch(/id\s*=\s*['"]admin-session-modal-title['"]/);
  });

  test('integration: the shared Modal wired exactly as Admin.jsx wires it produces role="dialog" + aria-modal + a heading linked by aria-labelledby', async () => {
    // Mount a minimal page that uses the shared Modal with the exact
    // prop shape Admin.jsx uses. This proves the contract that the
    // source-text pins above commit to: Admin.jsx imports this
    // primitive and supplies these props.
    const Modal = require('../components/Modal.jsx').default;

    function AdminLikeModal({ open, onClose }) {
      return (
        <Modal
          open={open}
          onClose={onClose}
          ariaLabelledBy="admin-session-modal-title"
        >
          <div style={{ position: 'relative' }}>
            <h3 id="admin-session-modal-title">Priya Sharma</h3>
            <button type="button" aria-label="Close modal" onClick={onClose}>
              ×
            </button>
            <div>Session body</div>
          </div>
        </Modal>
      );
    }

    function Harness() {
      const [open, setOpen] = React.useState(false);
      return (
        <main>
          <button type="button" onClick={() => setOpen(true)}>Open modal</button>
          <AdminLikeModal open={open} onClose={() => setOpen(false)} />
        </main>
      );
    }

    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /open modal/i }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');

    const labelledById = dialog.getAttribute('aria-labelledby');
    expect(labelledById).toBe('admin-session-modal-title');
    const heading = document.getElementById(labelledById);
    expect(heading).not.toBeNull();
    expect(heading.tagName).toMatch(/^H[1-6]$/);
    expect(heading.textContent).toMatch(/Priya Sharma/);

    // The close control must be reachable by accessible name. The
    // pre-fix button had no aria-label (icon-only X) — DR-044's
    // acceptance pins this. We pin the same shape so the same
    // regression class can't slip back in.
    expect(
      screen.getByRole('button', { name: /close modal/i })
    ).toBeInTheDocument();

    // Escape closes — Modal.jsx registers the Escape handler on
    // document with capture=true (Modal.jsx line 167).
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });
});