import React from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';

// P0/A-01: real admin overview — cross-module tiles linking into the
// four admin review queues. Keeps the existing /portal/admin/attendance
// route (org-wide attendance grid) untouched; admins reach it via the
// "All Attendance" tile.
export default function AdminOverview() {
  const { employee } = useAuth();

  // Group tiles by what admins do with them.
  const personalTiles = [
    {
      to: '/portal/admin/attendance',
      icon: '📋',
      title: 'All Attendance',
      sub: 'Org-wide attendance grid',
      desc: 'See every employee\'s check-ins, expand a day for the session map, and export the monthly timesheet.',
    },
  ];

  const reviewTiles = [
    {
      to: '/portal/admin/dpr',
      icon: '📝',
      title: 'Daily Reports to Review',
      sub: 'Field reports queue',
      desc: 'Approve or reject Daily Progress Reports submitted across all projects.',
    },
    {
      to: '/portal/admin/inspection',
      icon: '🔍',
      title: 'Inspections to Review',
      sub: 'Compliance records queue',
      desc: 'Review inspection & compliance records — material receipts, cube tests, NCRs, safety violations.',
    },
  ];

  const peopleTiles = [
    {
      to: '/portal/admin/leave',
      icon: '🏖️',
      title: 'Leave Approvals',
      sub: 'HR workflow',
      desc: 'Approve or reject leave requests across the team.',
    },
    {
      to: '/portal/admin/training',
      icon: '🎓',
      title: 'Training Library',
      sub: 'Course & enrollment management',
      desc: 'Create training courses, assign to employees, override-complete enrollments.',
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
            }}
          >
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.875rem' }}>
              <div style={{
                fontSize: '1.75rem',
                flexShrink: 0,
                width: 44, height: 44,
                background: 'rgba(0,102,255,0.08)',
                borderRadius: 10,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                {t.icon}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
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
