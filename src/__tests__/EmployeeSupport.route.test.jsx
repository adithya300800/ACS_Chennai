// §8.10 (Fresh24 Wave 4, 2026-09-24) — Employee "Help & Support" portal
// page route + content contracts.
//
// The page is a static, post-login landing for the most common "where do
// I get help?" questions — login issues, attendance correction,
// leave/training ownership, and a maintained /contact route for
// everything else. It lives inside the protected /portal/* tree at
// /portal/support and is reachable via the new sidebar entry (under
// "My Work") and the UserMenu "Help & Support" link.
//
// Coverage:
//   1. Page mounts at /portal/support without error (no mocked
//      useAuth needed — the page does not consume auth state).
//   2. All four section headings render with their spec-mandated copy:
//        - "Login issues"
//        - "Attendance correction"
//        - "Leave / training ownership"
//        - "One maintained contact route"
//   3. The contact link points to /contact (the DR-038 / DR-039 hardened
//      public form).
//   4. The attendance link points to /portal/attendance (the field-flow
//      check-in page).
//   5. (Auxiliary) The login link points to /portal/login so the
//      credential-lockout recovery path lands where the employee expects.
//   6. (Auxiliary) The leave and training links both point to their
//      respective /portal/* routes so the ownership copy doesn't decay.
//
// Run: cd src && npx jest --testPathPattern="EmployeeSupport.route"

import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// useDocumentTitle just touches document.title — jsdom supports it. No
// need to mock, but a no-op mock keeps the test surface area smaller.
jest.mock('../hooks/useDocumentTitle.js', () => ({
  useDocumentTitle: jest.fn(),
}));

const EmployeeSupport = require('../pages/portal/EmployeeSupport.jsx').default;

const renderSupport = () =>
  render(
    <MemoryRouter initialEntries={['/portal/support']}>
      <EmployeeSupport />
    </MemoryRouter>,
  );

// Each section is a <section aria-labelledby="support-section-…"> wrapping
// an <h2> with the same id. Look up by accessible role so the test
// survives any presentational CSS class renames.
const sectionHeading = (name) => screen.getByRole('heading', { level: 2, name });

describe('§8.10 — EmployeeSupport portal page', () => {
  test('1. page mounts at /portal/support without error', () => {
    // Smoke render — if anything throws (link resolution, breadcrumb
    // import, doc-title effect in jsdom), this fails loudly.
    expect(() => renderSupport()).not.toThrow();
    // Page title is the <h1>; Breadcrumb renders it too, so we use
    // getAllByRole and pick the <h1>.
    const h1s = screen.getAllByRole('heading', { level: 1, name: /help & support/i });
    expect(h1s.length).toBeGreaterThanOrEqual(1);
  });

  test('2. all four section headings render with the spec vocabulary', () => {
    renderSupport();
    // Exact spec strings — these are the four headings the audit's
    // §8.10 acceptance lists. A future refactor that changes the
    // heading copy (or drops a section) trips this test.
    expect(sectionHeading(/^Login issues$/)).toBeInTheDocument();
    expect(sectionHeading(/^Attendance correction$/)).toBeInTheDocument();
    expect(sectionHeading(/^Leave \/ training ownership$/)).toBeInTheDocument();
    expect(sectionHeading(/^One maintained contact route$/)).toBeInTheDocument();
  });

  test('3. the contact link points to /contact', () => {
    renderSupport();
    // The page uses data-testid anchors on the three inter-portal links
    // so the assertion is independent of the surrounding prose. The
    // /contact link is the surfaced one with "contact form" copy.
    const link = screen.getByTestId('support-contact-link');
    expect(link).toBeInTheDocument();
    expect(link.getAttribute('href')).toBe('/contact');
    // Sanity: the link text mentions "contact form" so a future text
    // refactor doesn't accidentally silence the call-to-action.
    expect(link.textContent.toLowerCase()).toMatch(/contact form/);
  });

  test('4. the attendance link points to /portal/attendance', () => {
    renderSupport();
    const link = screen.getByTestId('support-attendance-link');
    expect(link).toBeInTheDocument();
    expect(link.getAttribute('href')).toBe('/portal/attendance');
  });

  test('5. the login link points to /portal/login', () => {
    // Auxiliary — pins the credential-lockout recovery target so a
    // future refactor that drops the link to the login surface (or
    // moves it to /login which doesn't exist) is caught here.
    renderSupport();
    const link = screen.getByTestId('support-login-link');
    expect(link).toBeInTheDocument();
    expect(link.getAttribute('href')).toBe('/portal/login');
  });

  test('6. the leave + training sub-bullets both link to their /portal/* routes', () => {
    // Pinned by walking the Leave / training ownership section so we
    // don't accidentally match the page-top filter-row links (which
    // don't exist on this page anyway, but be defensive).
    renderSupport();
    const section = screen
      .getByRole('heading', { level: 2, name: /^Leave \/ training ownership$/ })
      .closest('section');
    expect(section).not.toBeNull();
    const links = within(section).getAllByRole('link');
    const hrefs = links.map((l) => l.getAttribute('href')).sort();
    expect(hrefs).toEqual(['/portal/leave', '/portal/training']);
  });
});
