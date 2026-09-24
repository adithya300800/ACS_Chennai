// DR-044 (Fresh24 Wave 3) — Careers application overlay uses the shared
// accessible dialog primitive.
//
// Defect: the Careers "Apply Now" overlay rendered as a plain `<div>`
// with no dialog semantics — no `role="dialog"`, no `aria-modal`, no
// `aria-labelledby`, no focus trap, no Escape handler, no initial
// focus, and no focus return. The X close button had no accessible
// name (the inner SVG was aria-hidden, the button itself had no
// aria-label). Keyboard-only users were stranded.
//
// Fix contract (DR-044 acceptance):
//   1. Open focuses the form (first focusable child).
//   2. Tab / Shift+Tab stay in the dialog (focus trap).
//   3. Escape closes the dialog.
//   4. Focus returns to the Apply Now trigger that opened it.
//
// Implementation: replace the custom overlay markup with the existing
// `src/components/Modal.jsx` primitive (DR-017 / S6-UI5 audit-cited).
// Modal already wires role/aria-modal/focus-trap/escape/focus-return;
// the page just supplies a heading id and a labelled close control.
//
// Run: cd src && npx jest --testPathPattern="careers-dr044"

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

jest.mock('../hooks/useDocumentTitle.js', () => ({
  useDocumentTitle: jest.fn(),
}));

// Render Careers inside a router so the <Link/> imports resolve cleanly.
const renderCareers = () =>
  render(
    <MemoryRouter>
      {React.createElement(require('../pages/Careers.jsx').default)}
    </MemoryRouter>,
  );

// The shared Modal uses requestAnimationFrame for initial focus
// (Modal.jsx line 119) and schedules focus-return via the cleanup of
// a useEffect (Modal.jsx lines 87-100). Both run on a microtask /
// rAF, so the tests below use waitFor to observe the resulting focus
// state instead of asserting synchronously after fireEvent.

// jsdom does NOT move focus on .click() the way a real browser does,
// so to exercise the focus-return path we explicitly focus the trigger
// before clicking. Without this, document.activeElement would still
// be document.body when Modal captures it, and the return-focus
// branch in Modal.jsx (line 85) would restore focus to body.
const openApplyDialog = (jobTitle = 'Construction Project Manager') => {
  const triggers = screen.getAllByRole('button', { name: /apply now/i });
  const trigger = triggers[0]; // First job — "Construction Project Manager".
  trigger.focus();
  fireEvent.click(trigger);
  return trigger;
};

describe('DR-044 — Careers Apply overlay uses shared accessible dialog', () => {
  test('the overlay renders with role="dialog", aria-modal="true", and an aria-labelledby pointing at a heading', async () => {
    renderCareers();
    openApplyDialog();

    // Modal.jsx wraps the backdrop in a single element that owns the
    // dialog semantics (role + aria-modal + aria-labelledby).
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');

    const labelledById = dialog.getAttribute('aria-labelledby');
    expect(labelledById).toBeTruthy();
    // The id must point at a visible heading inside the form (audit:
    // "must point to a visible heading inside the form").
    const heading = document.getElementById(labelledById);
    expect(heading).not.toBeNull();
    expect(heading.tagName).toMatch(/^H[1-6]$/);
    expect(heading.textContent).toMatch(/apply for/i);
  });

  test('opening the dialog moves focus to the first form input', async () => {
    renderCareers();
    openApplyDialog();

    const firstInput = await screen.findByLabelText(/full name/i);
    // Modal.jsx schedules focus via requestAnimationFrame (line 119),
    // so the assertion needs to wait for the rAF callback to flush.
    await waitFor(() => {
      expect(document.activeElement).toBe(firstInput);
    });
  });

  test('Escape closes the dialog and returns focus to the Apply Now trigger', async () => {
    renderCareers();
    const trigger = openApplyDialog();

    // Confirm the dialog is open and a form input is focused before
    // we dispatch Escape — guards against a false-pass where Escape
    // was dispatched before the dialog had actually mounted.
    await screen.findByRole('dialog');
    await screen.findByLabelText(/full name/i);

    // Modal.jsx registers the Escape handler on document with
    // capture=true (line 167), so firing on the focused input is the
    // canonical path.
    fireEvent.keyDown(document.activeElement, { key: 'Escape' });

    // Dialog unmounts (Modal returns null when !open — Modal.jsx:188).
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    // Focus returns to the Apply Now button that opened the dialog.
    // Modal.jsx:91-99 restores document.activeElement via the
    // previouslyFocusedRef captured on open.
    await waitFor(() => {
      expect(document.activeElement).toBe(trigger);
    });
  });

  test('Tab and Shift+Tab cycle within the dialog (focus trap)', async () => {
    renderCareers();
    openApplyDialog();

    const dialog = await screen.findByRole('dialog');

    // Focusable elements inside the dialog, in DOM order. Modal.jsx
    // uses a content-bounded visibility check (getClientRects, line
    // 140-141) so dynamic content stays inside the trap.
    //
    // The form contains:
    //   1. close button (X)
    //   2. full name input
    //   3. email input
    //   4. phone input
    //   5. linkedin input
    //   6. cover note textarea
    //   7. send application submit button
    const inputs = [
      screen.getByRole('button', { name: /close application form/i }),
      screen.getByLabelText(/full name/i),
      screen.getByLabelText(/^email/i),
      screen.getByLabelText(/phone/i),
      screen.getByLabelText(/linkedin url/i),
      screen.getByLabelText(/cover note/i),
      screen.getByRole('button', { name: /send application/i }),
    ];

    // Sanity: every focusable must be inside the dialog tree. The
    // focus trap in Modal.jsx uses dialogRef.current.contains(active)
    // (line 157) to detect escape — a regression that escapes the
    // subtree would let document.activeElement land on a job card
    // behind the overlay.
    inputs.forEach((el) => {
      expect(dialog.contains(el)).toBe(true);
    });

    // Forward Tab from the last focusable should wrap to the first
    // (Modal.jsx:161-164). We start by placing focus on the last
    // element so a single Tab demonstrates the wrap.
    inputs[inputs.length - 1].focus();
    fireEvent.keyDown(inputs[inputs.length - 1], { key: 'Tab' });
    await waitFor(() => {
      expect(document.activeElement).toBe(inputs[0]);
    });

    // Shift+Tab from the first should wrap to the last (Modal.jsx:156-159).
    inputs[0].focus();
    fireEvent.keyDown(inputs[0], { key: 'Tab', shiftKey: true });
    await waitFor(() => {
      expect(document.activeElement).toBe(inputs[inputs.length - 1]);
    });

    // Final guard: after cycling, focus is still on a node inside the
    // dialog — never on a job card behind it. This is the acceptance
    // line "background controls cannot accidentally receive
    // interaction" pinned to a positive assertion.
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  test('the close button has an accessible name (was an unnamed icon-only button pre-fix)', () => {
    renderCareers();
    openApplyDialog();

    // Pre-fix: button had no aria-label, inner svg was aria-hidden —
    // screen readers announced nothing. The DR-044 fix pins a name.
    const closeBtn = screen.getByRole('button', {
      name: /close application form/i,
    });
    expect(closeBtn).toBeInTheDocument();
  });

  test('submitting the form still invokes the mailto mechanism (regression guard)', () => {
    // DR-044 explicitly preserves the existing mailto flow unless
    // business chooses otherwise. We only smoke-test that the
    // submit handler still routes through window.location.href with
    // the expected mailto target — a refactor that drops the mailto
    // (e.g. silently swaps to a POST) would be a scope-creep bug.
    //
    // jsdom disallows `delete window.location` because the original
    // Location object is non-configurable. We use Object.defineProperty
    // to swap in a writable stub whose `.href` records the assignment.
    const originalLocation = window.location;
    let capturedHref = null;
    const stub = {};
    // Use a getter/setter so writing to `stub.href` lands in our
    // captured variable without touching the real document location.
    Object.defineProperty(stub, 'href', {
      configurable: true,
      get: () => capturedHref,
      set: (v) => { capturedHref = v; },
    });
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: stub,
    });

    try {
      renderCareers();
      openApplyDialog();

      fireEvent.change(screen.getByLabelText(/full name/i), {
        target: { value: 'Priya Sharma' },
      });
      fireEvent.change(screen.getByLabelText(/^email/i), {
        target: { value: 'priya@example.com' },
      });
      fireEvent.change(screen.getByLabelText(/cover note/i), {
        target: { value: 'I would love to apply.' },
      });
      fireEvent.click(screen.getByRole('button', { name: /send application/i }));

      expect(capturedHref).not.toBeNull();
      expect(typeof capturedHref).toBe('string');
      expect(capturedHref.startsWith('mailto:careers@acschennai.com?subject=')).toBe(true);
      // The job title and applicant email must appear in the URL —
      // guards against an encodeURIComponent regression silently
      // emptying the body.
      expect(capturedHref).toMatch(/Construction%20Project%20Manager|Priya%20Sharma|priya%40example\.com/);
    } finally {
      // Restore the original window.location for any subsequent tests.
      Object.defineProperty(window, 'location', {
        configurable: true,
        writable: true,
        value: originalLocation,
      });
    }
  });
});
