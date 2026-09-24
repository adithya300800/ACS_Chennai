import React, { useState, useEffect, useCallback } from 'react';
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
//
// DR-008 (Fresh24 audit 2026-09-24): per-tile fetch status so a failed
// endpoint renders as "Couldn't load" with a Retry button rather than as
// a zero badge masquerading as "no pending items". The previous
// `.catch(() => ({...empty}))` swallowed failures and made an outage
// look like a healthy empty queue — risky when the badge drives an
// admin's next action. `null` = not yet fetched, `'ok'` = fetched
// (possibly empty), `'error'` = fetch failed. Tiles with `error` keep
// their click-through behaviour but render a "Retry" affordance and a
// muted indicator so an admin can recover without a hard page refresh;
// independent healthy tiles remain usable.
export default function AdminOverview() {
  useDocumentTitle('Admin Overview');
  const { employee, accessToken } = useAuth();
  const [counts, setCounts] = useState({
    dpr: null,        // SUBMITTED reports
    inspection: null, // OPEN records
    leave: null,      // PENDING requests
    training: null,   // total active courses
  });
  // DR-008: parallel to `counts`. `null` = not fetched yet, `'ok'` =
  // fetched (possibly 0), `'error'` = fetch failed. Render branch is
  // gated on this so a downed endpoint doesn't masquerade as an empty
  // queue.
  const [tileStatus, setTileStatus] = useState({
    dpr: null, inspection: null, leave: null, training: null,
  });

  const loadCounts = useCallback(async () => {
    // The list endpoints cap at 100 items. For the overview badge this is
    // a reasonable upper bound — we render "100+" if a queue exceeds it
    // (very unlikely at this scale, and the user can click through to the
    // full queue anyway).
    //
    // DR-008: per-endpoint result wrapped as `{ ok, value }`. A failure
    // no longer collapses into `{ dprs: [] }` (which was the bug — a
    // downed endpoint looked like "no submitted reports"). Tiles with
    // `ok: false` keep the previous `counts` value rather than resetting
    // to 0, so a transient outage doesn't visually zero-out a queue
    // that was known non-empty a moment ago.
    const [dprRes, insRes, leaveRes, courseRes] = await Promise.all([
      api.getDprs({ status: 'SUBMITTED', limit: '100' }, accessToken).then((v) => ({ ok: true, v }), () => ({ ok: false })),
      api.getInspections({ status: 'OPEN', limit: '100' }, accessToken).then((v) => ({ ok: true, v }), () => ({ ok: false })),
      api.getAllLeaves({ status: 'PENDING' }, accessToken).then((v) => ({ ok: true, v }), () => ({ ok: false })),
      api.getTrainingCourses({ isArchived: 'false' }, accessToken).then((v) => ({ ok: true, v }), () => ({ ok: false })),
    ]);
    setCounts((prev) => ({
      dpr: dprRes.ok ? (dprRes.v.dprs?.length ?? 0) : prev.dpr,
      inspection: insRes.ok ? (insRes.v.inspections?.length ?? 0) : prev.inspection,
      leave: leaveRes.ok ? (leaveRes.v.requests?.length ?? 0) : prev.leave,
      training: courseRes.ok ? (courseRes.v.courses?.length ?? 0) : prev.training,
    }));
    setTileStatus({
      dpr: dprRes.ok ? 'ok' : 'error',
      inspection: insRes.ok ? 'ok' : 'error',
      leave: leaveRes.ok ? 'ok' : 'error',
      training: courseRes.ok ? 'ok' : 'error',
    });
  }, [accessToken]);

  useEffect(() => {
    loadCounts();
    // Refresh when the tab regains focus so admins coming back from a
    // review see the updated pending counts without a manual reload.
    const onVis = () => { if (document.visibilityState === 'visible') loadCounts(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { document.removeEventListener('visibilitychange', onVis); };
  }, [loadCounts]);

  // Group tiles by what admins do with them. SOL-P2#15: icons are inline
  // SVGs (line-style, 1.5 stroke) so the overview doesn't mix emoji with
  // the SVG line icon system used elsewhere.
  const ICONS = {
    attendance: (
      <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
        <rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y1="6" /><line x1="8" y1="2" x2="8" y1="6" /><line x1="3" y1="10" x2="21" y1="10" />
      </svg>
    ),
    dpr: (
      <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y1="13" /><line x1="16" y1="17" x2="8" y1="17" /><line x1="10" y1="9" x2="8" y1="9" />
      </svg>
    ),
    inspection: (
      <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y1="16.65" /><path d="M11 8v6" /><path d="M8 11h6" />
      </svg>
    ),
    leave: (
      <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
        <rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y1="6" /><line x1="8" y1="2" x2="8" y1="6" /><line x1="3" y1="10" x2="21" y1="10" /><path d="M9 15l2 2 4-4" />
      </svg>
    ),
    training: (
      <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M22 10v6" /><path d="M2 10l10-5 10 5-10 5z" /><path d="M6 12v5c3 3 9 3 12 0v5" />
      </svg>
    ),
    // N17 — Project dashboard icon (chart bars + axis). Matches the
    // building/chart aesthetic of the ProjectsAdmin page.
    project: (
      <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
        <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="3" y1="9" x2="21" y1="9" /><line x1="9" y1="21" x2="9" y1="9" />
      </svg>
    ),
  };

  // DR-008: each review tile gets a status-aware badge. Healthy + 0 keeps
  // the existing muted dot. Healthy + N keeps the red dot. `error` swaps
  // to a "!" pill so an admin can tell a downed endpoint apart from a
  // genuinely empty queue at a glance.
  const badgeFor = (key, value) => {
    const status = tileStatus[key];
    if (status === 'error') {
      return {
        show: true,
        cls: 'admin-overview-badge-error',
        ariaLabel: 'Could not load count — Retry',
        number: '!',
        label: 'unavailable',
      };
    }
    if (status !== 'ok' || value === null || value === undefined) {
      // Still loading or unknown — keep the badge hidden (matches the
      // pre-fix behaviour; the tile is clickable regardless).
      return { show: false };
    }
    return {
      show: true,
      cls: value === 0 ? 'admin-overview-badge-quiet' : 'admin-overview-badge-action',
      ariaLabel: `${value} ${key === 'training' ? 'courses' : 'pending'}`,
      number: value >= 100 ? '100+' : value,
      label: key === 'training' ? 'courses' : (value === 1 ? 'pending' : 'pending'),
    };
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

  // Helper that yields a tile with status-aware badge + per-tile Retry.
  // DR-008: when a tile's endpoint is in `error`, render an inline Retry
  // button alongside the "!" badge. Clicking Retry only re-fetches the
  // single endpoint (via loadCounts — small overhead, no partial state).
  const reviewTile = (key, tile) => {
    const b = badgeFor(key, counts[key]);
    return {
      ...tile,
      badge: b.show ? b.number : null,
      badgeLabel: b.show ? b.label : null,
      badgeCls: b.cls,
      badgeAriaLabel: b.ariaLabel,
      failed: tileStatus[key] === 'error',
    };
  };

  const reviewTiles = [
    reviewTile('dpr', {
      to: '/portal/admin/dpr',
      icon: ICONS.dpr,
      title: 'Daily Reports to Review',
      sub: 'Field reports queue',
      desc: 'Approve or reject Daily Progress Reports submitted across all projects.',
    }),
    reviewTile('inspection', {
      to: '/portal/admin/inspection',
      icon: ICONS.inspection,
      title: 'Inspections to Review',
      sub: 'Compliance records queue',
      desc: 'Review inspection & compliance records — material receipts, NCRs, safety violations.',
    }),
  ];

  const peopleTiles = [
    reviewTile('leave', {
      to: '/portal/admin/leave',
      icon: ICONS.leave,
      title: 'Leave Approvals',
      sub: 'HR workflow',
      desc: 'Approve or reject leave requests across the team.',
    }),
    reviewTile('training', {
      to: '/portal/admin/training',
      icon: ICONS.training,
      title: 'Training Library',
      sub: 'Course & enrollment management',
      desc: 'Create training courses, assign to employees, override-complete enrollments.',
      // Course count is informational, not an action queue — always quiet
      // when ok. When in error we still render the ! pill so an admin
      // doesn't silently read "0 courses" as truth.
      quiet: true,
    }),
  ];

  // N17 — Project-level dashboard. Lives in Administration because it
  // scopes the existing review queues (DPR/Inspection) to a single
  // project. No badge because the count is project-specific — the
  // tile just lands the PM on the project picker.
  const adminTiles = [
    {
      to: '/portal/admin/project-dashboard',
      icon: ICONS.project,
      title: 'Project Dashboards',
      sub: 'KPI overview per project',
      desc: 'See DPR/Inspection/BOQ-variance counts per project.',
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

      <TileSection title="Attendance" tiles={personalTiles} counts={counts} tileStatus={tileStatus} onRetry={loadCounts} />
      <TileSection title="Field Reports" tiles={reviewTiles} counts={counts} tileStatus={tileStatus} onRetry={loadCounts} />
      <TileSection title="People" tiles={peopleTiles} counts={counts} tileStatus={tileStatus} onRetry={loadCounts} />
      <TileSection title="Administration" tiles={adminTiles} counts={counts} tileStatus={tileStatus} onRetry={loadCounts} />
    </div>
  );
}

// DR-008: TileSection now consumes counts/tileStatus/onRetry props so the
// tile render can branch on per-tile status. Personal/admin tiles don't
// use counts (they're never in error/loading), so missing fields are
// treated as `null` and the badge branch simply hides.
function TileSection({ title, tiles, counts = {}, tileStatus = {}, onRetry }) {
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
        gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
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
                className={`admin-overview-badge ${t.badgeCls || (t.quiet || t.badge === 0 ? 'admin-overview-badge-quiet' : 'admin-overview-badge-action')}`}
                aria-label={t.badgeAriaLabel || `${t.badge} ${t.badgeLabel}`}
                title={t.badgeAriaLabel || `${t.badge} ${t.badgeLabel}`}
              >
                <span className="admin-overview-badge-number">
                  {t.badge}
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
                {/* DR-008: inline Retry button only appears for failed
                    tiles. Distinct click target so an admin can recover
                    without navigating into the (possibly stale) queue
                    page. The Retry stops event propagation so clicking
                    it doesn't also navigate to the tile destination. */}
                {t.failed && onRetry && (
                  <button
                    type="button"
                    className="admin-overview-retry"
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); onRetry(); }}
                    style={{
                      marginTop: '0.5rem',
                      padding: '0.25rem 0.6rem',
                      fontSize: '0.75rem',
                      border: '1px solid var(--steel, #94a3b8)',
                      borderRadius: 6,
                      background: 'transparent',
                      color: 'var(--navy)',
                      cursor: 'pointer',
                    }}
                  >
                    Retry
                  </button>
                )}
              </div>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}