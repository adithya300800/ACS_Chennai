// §8.10 (Fresh24 Wave 4, 2026-09-24) — Employee "Help & Support" page.
//
// A single, low-noise landing for the most common "where do I get help?"
// questions employees field daily:
//   - Login / credential lockout
//   - Attendance corrections (no checkout step in the field flow)
//   - Leave / Training ownership (admin approves)
//   - Everything else = the /contact form (DR-038 + DR-039 hardened route)
//
// No backend calls. No new endpoints. No data fetching. The page is a
// static, post-login map so a new employee can find the right route
// without having to read the portal sidebar. The sidebar entry (added to
// PortalLayout.jsx in this batch) and the UserMenu "Help & Support" link
// (also retargeted in this batch) both resolve to /portal/support.
//
// Each section is wrapped in a portal-native <div className="dpr-card">
// so the page inherits the same look-and-feel as My Projects / My Reports
// without introducing new CSS. Section headings are <h2>s so screen-reader
// users can navigate by landmark + heading-list, and so a future test can
// assert each section by its accessible role.

import React from 'react';
import { Link } from 'react-router-dom';
import Breadcrumb from '../../components/Breadcrumb.jsx';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';

// Phone number fallback. Real office line (mirrors src/pages/Contact.jsx).
// We deliberately reuse the same number so an employee who happens to see
// both pages doesn't see two different "office" phone numbers and wonder
// which is current. The copy below explicitly says "they route credential
// lockout calls to the on-call admin" so the employee understands this is
// not a customer-facing enquiry line.
const OFFICE_PHONE_DISPLAY = '+91 89395 01843';
const OFFICE_PHONE_TEL = 'tel:+918939501843';

export default function EmployeeSupport() {
  useDocumentTitle('Help & Support');

  return (
    <div className="dpr-page">
      <div className="dpr-page-header">
        <div>
          <Breadcrumb
            items={[
              { label: 'Help & Support' },
            ]}
          />
          <h1 className="dpr-page-title">Help & Support</h1>
          <p
            className="dpr-page-sub"
            style={{ color: 'var(--steel, #64748b)', margin: 0, fontSize: '0.9rem' }}
          >
            One page for the most common "where do I get help?" questions.
            Pick the section that matches your issue — every link below is a
            real route on the portal you already use.
          </p>
        </div>
      </div>

      {/* 1. Login issues
          No self-service credential reset endpoint exists, so the recovery
          path is "contact admin". The phone line is a fallback for the
          case where the employee cannot reach admin by chat/email. */}
      <section
        className="dpr-card"
        style={{ marginBottom: '1rem' }}
        aria-labelledby="support-section-login"
      >
        <div className="dpr-card-header">
          <div>
            <h2
              id="support-section-login"
              className="dpr-card-title"
              style={{ margin: 0 }}
            >
              Login issues
            </h2>
            <div className="dpr-card-meta">
              <span className="dpr-card-meta-item">
                Can't sign in, forgot your password, or were locked out after too many attempts.
              </span>
            </div>
          </div>
        </div>
        <div style={{ padding: '0 1rem 1rem' }}>
          <p
            style={{
              margin: '0 0 0.75rem',
              color: 'var(--ink, #1e293b)',
              fontSize: '0.9rem',
              lineHeight: 1.5,
            }}
          >
            Sign-in happens on the{' '}
            <Link
              to="/portal/login"
              data-testid="support-login-link"
              style={{ color: 'var(--blue, #0066FF)', fontWeight: 600 }}
            >
              /portal/login
            </Link>{' '}
            page. If you've forgotten your password or were locked out, ask
            your administrator directly to reset your credentials — there is
            no self-service password-reset endpoint yet.
          </p>
          <p
            style={{
              margin: 0,
              color: 'var(--steel, #64748b)',
              fontSize: '0.85rem',
            }}
          >
            Phone fallback (Mon–Sat, 9am–6pm IST):{' '}
            <a
              href={OFFICE_PHONE_TEL}
              style={{ color: 'var(--blue, #0066FF)', fontWeight: 600 }}
            >
              {OFFICE_PHONE_DISPLAY}
            </a>
            {' '}— they route credential-lockout calls to the on-call admin.
          </p>
        </div>
      </section>

      {/* 2. Attendance correction
          No checkout step exists in the field flow. No self-service
          attendance-edit endpoint exists either; the only path is admin
          via the all-attendance admin view. */}
      <section
        className="dpr-card"
        style={{ marginBottom: '1rem' }}
        aria-labelledby="support-section-attendance"
      >
        <div className="dpr-card-header">
          <div>
            <h2
              id="support-section-attendance"
              className="dpr-card-title"
              style={{ margin: 0 }}
            >
              Attendance correction
            </h2>
            <div className="dpr-card-meta">
              <span className="dpr-card-meta-item">
                Forgot to mark presence, or your day is showing as unmarked.
              </span>
            </div>
          </div>
        </div>
        <div style={{ padding: '0 1rem 1rem' }}>
          <p
            style={{
              margin: '0 0 0.75rem',
              color: 'var(--ink, #1e293b)',
              fontSize: '0.9rem',
              lineHeight: 1.5,
            }}
          >
            Attendance is check-in only — there is no checkout step in the
            field flow. Mark your daily presence on the{' '}
            <Link
              to="/portal/attendance"
              data-testid="support-attendance-link"
              style={{ color: 'var(--blue, #0066FF)', fontWeight: 600 }}
            >
              My Attendance
            </Link>{' '}
            page. The page asks for GPS location so your check-in is
            auto-attached to a map pin.
          </p>
          <p
            style={{
              margin: 0,
              color: 'var(--steel, #64748b)',
              fontSize: '0.85rem',
            }}
          >
            <strong>If you forgot to mark presence for a day:</strong>{' '}
            there is no self-service attendance-edit endpoint yet — ask your
            administrator to update it for you through the all-attendance
            admin view.
          </p>
        </div>
      </section>

      {/* 3. Leave / training ownership
          Both flows are employee-initiated + admin-approved. Employees
          cannot approve their own requests. 48-hour stall → contact form. */}
      <section
        className="dpr-card"
        style={{ marginBottom: '1rem' }}
        aria-labelledby="support-section-leave-training"
      >
        <div className="dpr-card-header">
          <div>
            <h2
              id="support-section-leave-training"
              className="dpr-card-title"
              style={{ margin: 0 }}
            >
              Leave / training ownership
            </h2>
            <div className="dpr-card-meta">
              <span className="dpr-card-meta-item">
                Who approves, who escalates, and how to follow up.
              </span>
            </div>
          </div>
        </div>
        <div style={{ padding: '0 1rem 1rem' }}>
          <ul
            style={{
              margin: '0 0 0 1.25rem',
              padding: 0,
              color: 'var(--ink, #1e293b)',
              fontSize: '0.9rem',
              lineHeight: 1.6,
            }}
          >
            <li style={{ marginBottom: '0.5rem' }}>
              <strong>Leave requests:</strong> submit and track them on{' '}
              <Link
                to="/portal/leave"
                style={{ color: 'var(--blue, #0066FF)', fontWeight: 600 }}
              >
                My Leave
              </Link>
              . An administrator reviews and approves each request — you
              don't approve your own. If your request sits longer than 48
              hours, escalate via the contact form below.
            </li>
            <li>
              <strong>Training courses:</strong> see assigned courses on{' '}
              <Link
                to="/portal/training"
                style={{ color: 'var(--blue, #0066FF)', fontWeight: 600 }}
              >
                My Training
              </Link>
              . Course assignments are pushed by admin; if you think a
              course is missing or overdue, escalate via the contact form
              below.
            </li>
          </ul>
        </div>
      </section>

      {/* 4. One maintained contact route
          DR-038 hardened the /contact endpoint (provider failure handling).
          DR-039 hardened the UI (inline error summary keeps the form
          mounted on failed submit so a retry doesn't require retyping). */}
      <section
        className="dpr-card"
        style={{ marginBottom: '1rem' }}
        aria-labelledby="support-section-contact"
      >
        <div className="dpr-card-header">
          <div>
            <h2
              id="support-section-contact"
              className="dpr-card-title"
              style={{ margin: 0 }}
            >
              One maintained contact route
            </h2>
            <div className="dpr-card-meta">
              <span className="dpr-card-meta-item">
                For anything not covered above — every submission creates a tracked ticket.
              </span>
            </div>
          </div>
        </div>
        <div style={{ padding: '0 1rem 1rem' }}>
          <p
            style={{
              margin: '0 0 0.75rem',
              color: 'var(--ink, #1e293b)',
              fontSize: '0.9rem',
              lineHeight: 1.5,
            }}
          >
            For anything not covered above, use the{' '}
            <Link
              to="/contact"
              data-testid="support-contact-link"
              style={{ color: 'var(--blue, #0066FF)', fontWeight: 600 }}
            >
              contact form
            </Link>
            {' '}— every submission creates a tracked ticket. The form is the
            same route the public site uses; it's been hardened by DR-038
            (provider-failure handling on send) and DR-039 (inline error
            summary that keeps your last-entered values on a failed submit,
            so a retry doesn't require retyping).
          </p>
          <p
            style={{
              margin: 0,
              color: 'var(--steel, #64748b)',
              fontSize: '0.85rem',
            }}
          >
            Preferred response time: <strong>within 24 hours</strong> on
            business days (Mon–Sat, 9am–6pm IST).
          </p>
        </div>
      </section>
    </div>
  );
}
