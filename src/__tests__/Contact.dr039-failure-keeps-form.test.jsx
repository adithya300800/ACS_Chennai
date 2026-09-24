// DR-039 — contact form failure must keep the inquiry form visible so the
// visitor can correct/retry without reloading or retyping.
//
// Audit evidence: src/pages/Contact.jsx:145-150. Pre-fix, the page
// mounted one of three mutually-exclusive blocks:
//   - 'success' → green confirmation card
//   - 'error'   → red banner + "try again" prose
//   - otherwise → the actual <form>
// On a 502/503/etc the form unmounted and React state was discarded
// from view, leaving the visitor with no working input surface and no
// retry affordance. The existing <button type="submit"> existed only
// inside the unmounted form.
//
// Fix contract (the four bullets below pin the post-fix behaviour):
//   1. Error branch renders an INLINE alert summary (role="alert",
//      aria-live="polite") ABOVE the form, never instead of it.
//   2. Form fields keep the user's last-typed values (React state stays
//      untouched on failure; the success branch is the only one that
//      resets).
//   3. Keyboard focus moves to the alert summary the moment the failure
//      surfaces, so a screen reader announces it AND a keyboard-only user
//      lands on the affordance without hunting.
//   4. The existing <button type="submit"> — which is always inside the
//      still-mounted form — acts as the Retry action without any extra
//      control.
//
// Run: cd src && npx jest --testPathPattern="Contact.dr039"

import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

// CRITICAL: variable names MUST start with "mock" so jest's hoisted
// factory closure accepts the out-of-scope reference (jest.mock factories
// are hoisted above the surrounding `import` statements).
const mockPost = jest.fn();
jest.mock('../lib/api.js', () => ({
  api: {
    post: mockPost,
  },
}));

jest.mock('../hooks/useDocumentTitle.js', () => ({
  useDocumentTitle: jest.fn(),
}));

const renderContact = () => {
  const Contact = require('../pages/Contact.jsx').default;
  return render(<Contact />);
};

// Drive a controlled form submission — the inputs are required, so we
// use fireEvent.change (not the more thorough user-event) to keep the
// test fast and deterministic. Validation isn't the focus here.
const fillRequiredFields = (overrides = {}) => {
  fireEvent.change(screen.getByLabelText(/Full Name/), {
    target: { value: overrides.name ?? 'Rajesh Kumar' },
  });
  fireEvent.change(screen.getByLabelText(/Email Address/), {
    target: { value: overrides.email ?? 'rajesh@kumarinfra.com' },
  });
  fireEvent.change(screen.getByLabelText(/Project Brief/), {
    target: { value: overrides.message ?? 'Build a 2000 sqft warehouse in Oragadam.' },
  });
};

describe('DR-039 — Contact form failure keeps the form visible (alert above, not instead of)', () => {
  beforeEach(() => {
    mockPost.mockReset();
    mockPost.mockResolvedValue({ success: true });
  });

  test('1. 503-failure-keeps-form — 502/503 from /contact renders the alert summary WITH the form (not instead of it)', async () => {
    // Mirror DR-038's structured error response shape. We don't import
    // ApiError from the jest-mocked module (the factory only exports
    // `api`), so we use a plain Error with a realistic message — the
    // form-preservation contract doesn't depend on the error class.
    mockPost.mockRejectedValueOnce(
      new Error('Email provider rejected the message'),
    );

    renderContact();
    fillRequiredFields();
    fireEvent.click(screen.getByRole('button', { name: /Send Enquiry/i }));

    // The error summary must be present …
    await waitFor(() => {
      const alert = screen.getByRole('alert');
      expect(alert).toBeInTheDocument();
      // Pin the visible title so the assertion reads on the audit's
      // exact wording (and not on a generic `<div role="alert">`).
      expect(alert).toHaveTextContent(/Failed to send message/);
    });
    // … AND the form must still be in the tree (inputs keep their values).
    expect(screen.getByLabelText(/Full Name/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Email Address/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Project Brief/)).toBeInTheDocument();
    // The button text must read 'Send Enquiry' (not 'Sending...'), which
    // proves status='loading' has cleared back to 'error' and the button
    // is enabled — i.e. the existing button doubles as the Retry action.
    expect(
      screen.getByRole('button', { name: /Send Enquiry/i }),
    ).not.toBeDisabled();
    // The user's typed name MUST survive the failure so they don't have
    // to retype it on retry. Pin the value-preservation contract here
    // (the structural one is asserted via "form still in tree" above).
    expect(screen.getByLabelText(/Full Name/)).toHaveValue('Rajesh Kumar');
    expect(screen.getByLabelText(/Email Address/)).toHaveValue('rajesh@kumarinfra.com');
    expect(screen.getByLabelText(/Project Brief/)).toHaveValue(
      'Build a 2000 sqft warehouse in Oragadam.',
    );
  });

  test('2. error-summary carries correct a11y wiring (role=alert, aria-live=polite, tabIndex=-1)', async () => {
    // The same alert region must double as both a screen-reader announcement
    // AND a focus target (it's tabIndex=-1 so the keyboard focus effect can
    // land on it programmatically; aria-live=polite so JAWS/NVDA speak
    // the message without interrupting the user). Pin all three.
    mockPost.mockRejectedValueOnce(new Error('Boom'));
    renderContact();
    fillRequiredFields();
    fireEvent.click(screen.getByRole('button', { name: /Send Enquiry/i }));

    const alert = await waitFor(() => screen.getByRole('alert'));
    expect(alert).toHaveAttribute('aria-live', 'polite');
    expect(alert).toHaveAttribute('tabindex', '-1');
    // The body line must point the user at the Retry button — the audit's
    // "no working Retry/Edit" complaint is closed by surfacing the action
    // in plain prose, not by adding another button.
    expect(alert.textContent).toMatch(/Send Enquiry/);
  });

  test('3. focus-routes-to-error-summary — keyboard focus moves to the alert the moment the failure surfaces', async () => {
    // Sighted keyboard users land on the affordance so they don't have to
    // tab through the form to find it. Screen readers announce via
    // aria-live (test 2). The shouldFocusAlertRef guard ensures we don't
    // yank focus on first mount.
    mockPost.mockRejectedValueOnce(new Error('Network down'));
    renderContact();
    fillRequiredFields();
    // Baseline: focus is on document.body (jsdom default) before submit.
    expect(document.activeElement).toBe(document.body);
    fireEvent.click(screen.getByRole('button', { name: /Send Enquiry/i }));

    await waitFor(() => {
      const alert = screen.getByRole('alert');
      expect(document.activeElement).toBe(alert);
    });
  });

  test('4. success-clears-form — the success branch is the ONLY branch that resets fields', async () => {
    // The structural fix relies on the success path unmounting the form
    // (the green confirmation replaces it). On success, the form inputs
    // MUST be gone and the confirmation MUST be visible. On failure
    // (already covered by test 1), the form stays.
    mockPost.mockResolvedValueOnce({ success: true, accepted: true, id: 'inquiry_1' });
    renderContact();
    fillRequiredFields();
    fireEvent.click(screen.getByRole('button', { name: /Send Enquiry/i }));

    await waitFor(() => {
      expect(
        screen.getByText(/Enquiry sent successfully/i),
      ).toBeInTheDocument();
    });
    // Inputs gone — the form unmounted in favour of the confirmation.
    expect(screen.queryByLabelText(/Full Name/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Send Enquiry/i })).not.toBeInTheDocument();
  });

  test('5. retry-after-failure — calling Submit a second time re-invokes /contact with the kept values', async () => {
    // The form is still mounted, so a subsequent click is a real Retry —
    // not a no-op. The audit acceptance ("a visitor can correct/retry
    // without reloading or retyping") hinges on this: the second POST
    // must carry the SAME payload the user originally typed. We don't
    // have to mutate the fields to prove the contract — the assertion
    // is that two distinct POSTs land within the same mount.
    mockPost
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce({ success: true, accepted: true, id: 'inquiry_2' });

    renderContact();
    fillRequiredFields();
    fireEvent.click(screen.getByRole('button', { name: /Send Enquiry/i }));

    await waitFor(() => screen.getByRole('alert'));
    fireEvent.click(screen.getByRole('button', { name: /Send Enquiry/i }));

    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledTimes(2);
    });
    // Both POSTs carried the same user-typed payload. Strict deep equality
    // so any field drifted between the two calls fails the test.
    const firstBody = mockPost.mock.calls[0][1];
    const secondBody = mockPost.mock.calls[1][1];
    expect(secondBody).toEqual(firstBody);
    expect(secondBody.name).toBe('Rajesh Kumar');
    expect(secondBody.email).toBe('rajesh@kumarinfra.com');
  });

  test('6. validation-style-error-keeps-form — backend 400 / generic error keeps the form the same way', async () => {
    // Audit said the form was "replaced by error text" for ANY non-2xx;
    // pin that we handle the whole non-2xx range, not just 5xx. The
    // contact backend returns 200 with a JSON contract, so a generic
    // failure covers every code path the user might hit (validation,
    // provider-bounce, timeout-as-ApiError).
    mockPost.mockRejectedValueOnce(new Error('Validation failed: name is required'));
    renderContact();
    fillRequiredFields();
    fireEvent.click(screen.getByRole('button', { name: /Send Enquiry/i }));

    await waitFor(() => screen.getByRole('alert'));
    // Form still present, error message from the rejection is rendered.
    expect(screen.getByLabelText(/Full Name/)).toHaveValue('Rajesh Kumar');
    expect(screen.getByText(/Validation failed/)).toBeInTheDocument();
  });
});
