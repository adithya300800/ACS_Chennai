import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { api } from '../../lib/api.js';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';

// P0/A-01: real admin overview — cross-module tiles linking into the
// four admin review queues. Keeps the existing /portal/admin/attendance
// route (org-wide attendance grid) untouched; admins reach it via the
// "All Attendance" tile.
//
// R19 P1#13: each review tile shows a live count of items needing attention
// (submitted DPRs, open inspections, pending leave). Counts fire in parallel
// on mount, refresh when the page becomes visible again (so a quick
// review + back shows the cleared count without a manual reload).
export default function AdminOverview() {
  useDocumentTitle('Admin Overview');
  const { employee, accessToken } = useAuth();
  const [counts, setCounts] = useState({
    dpr: null,        // SUBMITTED reports
    inspection: null, // OPEN records
    leave: null,      // PENDING requests
    training: null,   // total active courses
  });

  useEffect(() => {
    let cancelled = false;
    const loadCounts = async () => {
      try {
        // The list endpoints cap at 100 items. For the overview badge this is
        // a reasonable upper bound — we render "100+" if a queue exceeds it
        // (very unlikely at this scale, and the user can click through to
        // the full queue anyway).
        const [dprRes, insRes, leaveRes, courseRes] = await Promise.all([
          api.getDprs({ status: 'SUBMITTED', limit: '100' }, accessToken).catch(() => ({ dprs: [] })),
          api.getInspections({ status: 'OPEN', limit: '100' }, accessToken).catch(() => ({ inspections: [] })),
          api.getAllLeaves({ status: 'PENDING' }, accessToken).catch(() => ({ requests: [] })),
          api.getTrainingCourses({ isArchived: 'false' }, accessToken).catch(() => ({ courses: [] })),
        ]);
        if (cancelled) return;
        setCounts({
          dpr: dprRes.dprs?.length ?? 0,
          inspection: insRes.inspections?.length ?? 0,
          leave: leaveRes.requests?.length ?? 0,
          training: courseRes.courses?.length ?? 0,
        });
      } catch {
        // counts are best-effort — never block the page from rendering
      }
    };
    loadCounts();
    // Refresh when the tab regains focus so admins coming back from a
    // review see the updated pending counts without a manual reload.
    const onVis = () => { if (document.visibilityState === 'visible') loadCounts(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { cancelled = true; document.removeEventListener('visibilitychange', onVis); };
  }, [accessToken]);

  // Group tiles by what admins do with them. SOL-P2#15: icons are inline
  // SVGs (line-style, 1.5 stroke) so the overview doesn't mix emoji with
  // the SVG line icon system used elsewhere.
  const ICONS = {
    attendance: (
      <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
        <rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" />
      </svg>
    ),
    dpr: (
      <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /><line x1="10" y1="9" x2="8" y2="9" />
      </svg>
    ),
    inspection: (
      <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /><path d="M11 8v6" /><path d="M8 11h6" />
      </svg>
    ),
    leave: (
      <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
        <rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /><path d="M9 15l2 2 4-4" />
      </svg>
    ),
    training: (
      <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M22 10v6" /><path d="M2 10l10-5 10 5-10 5z" /><path d="M6 12v5c3 3 9 3 12 0v-5" />
      </svg>
    ),
  };

  const personalTiles = [
    {
      to: '/portal/admin/attendance',
      icon: ICONS.attendance,
      title: 'All Attendance',
      sub: 'Org-wide attendance grid',
      desc: 'See every employee\'s check-ins, expand a day for the session map, and export the monthly timesheet.',
    },
  ];

  const reviewTiles = [
    {
      to: '/portal/admin/dpr',
      icon: ICONS.dpr,
      title: 'Daily Reports to Review',
      sub: 'Field reports queue',
      desc: 'Approve or reject Daily Progress Reports submitted across all projects.',
      badge: counts.dpr,
      badgeLabel: counts.dpr === 1 ? 'pending' : 'pending',
    },
    {
      to: '/portal/admin/inspection',
      icon: ICONS.inspection,
      title: 'Inspections to Review',
      sub: 'Compliance records queue',
      desc: 'Review inspection & compliance records — material receipts, cube tests, NCRs, safety violations.',
      badge: counts.inspection,
      badgeLabel: 'open',
    },
  ];

  const peopleTiles = [
    {
      to: '/portal/admin/leave',
      icon: ICONS.leave,
      title: 'Leave Approvals',
      sub: 'HR workflow',
      desc: 'Approve or reject leave requests across the team.',
      badge: counts.leave,
      badgeLabel: 'pending',
    },
    {
      to: '/portal/admin/training',
      icon: ICONS.training,
      title: 'Training Library',
      sub: 'Course & enrollment management',
      desc: 'Create training courses, assign to employees, override-complete enrollments.',
      badge: counts.training,
      badgeLabel: 'courses',
      // Course count is informational, not an action queue — always quiet.
      quiet: true,
    },
  ];

  return (
    <div className="dpr-page">
      <div className="dpr-page-header">
        <div>
          <h1 className="dpr-page-title" aria-label="Admin Overview">Admin Overview</h1>
          <p className="dpr-page-sub" style={{ color: 'var(--steel)', margin: 0, fontSize: '0.9rem' }}>
            Welcome back, <strong>{employee?.name?.split(' ')[0] || 'Admin'}</strong>. Pick a module to review.
          </p>
        </div>
      </div>

      <TileSection title="Attendance" tiles={personalTiles} />
      <TileSection title="Field Reports" tiles={reviewTiles} />
      <TileSection title="People" tiles={peopleTiles} />
    </div>
  );
}

function TileSection({ title, tiles }) {
  return (
    <section style={{ marginBottom: '1.5rem' }}>
      <h2 style={{
        fontFamily: "'Plus Jakarta Sans', sans-serif",
        fontSize: '0.8rem',
        fontWeight: 700,
        color: 'var(--steel)',
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        margin: '0 0 0.75rem',
      }}>
        {title}
      </h2>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
        gap: '1rem',
      }}>
        {tiles.map((t) => (
          <Link
            key={t.to}
            to={t.to}
            className="dpr-card"
            style={{
              textDecoration: 'none',
              color: 'inherit',
              display: 'block',
              transition: 'transform 0.15s, box-shadow 0.15s',
              position: 'relative',
            }}
          >
            {/* R19 P1#13: workload badge — shows pending count if known,
                hidden while loading (null). Grey dot for non-actionable
                totals (e.g. course count); red dot for queues that need
                admin action. "100+" suffix when the API cap was hit. */}
            {t.badge !== null && t.badge !== undefined && (
              <div
                className={`admin-overview-badge ${t.quiet || t.badge === 0 ? 'admin-overview-badge-quiet' : 'admin-overview-badge-action'}`}
                aria-label={`${t.badge} ${t.badgeLabel}`}
                title={`${t.badge} ${t.badgeLabel}`}
              >
                <span className="admin-overview-badge-number">
                  {t.badge >= 100 ? '100+' : t.badge}
                </span>
                <span className="admin-overview-badge-label">{t.badgeLabel}</span>
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.875rem' }}>
              <div style={{
                color: '#0066FF',
                flexShrink: 0,
                width: 44, height: 44,
                background: 'rgba(0,102,255,0.08)',
                borderRadius: 10,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                {t.icon}
              </div>
              <div style={{ flex: 1, minWidth: 0, paddingRight: t.badge ? '3rem' : 0 }}>
                <div style={{
                  fontFamily: "'Plus Jakarta Sans', sans-serif",
                  fontWeight: 700,
                  fontSize: '1rem',
                  color: 'var(--navy)',
                  marginBottom: '0.15rem',
                }}>
                  {t.title}
                </div>
                <div style={{ fontSize: '0.78rem', color: 'var(--steel)', marginBottom: '0.5rem' }}>
                  {t.sub}
                </div>
                <div style={{ fontSize: '0.85rem', color: 'var(--steel)', lineHeight: 1.45 }}>
                  {t.desc}
                </div>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}
