import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { api } from '../../lib/api.js';
import { formatShortDate } from '../../lib/format.js';
import StatusBadge from '../../components/StatusBadge.jsx';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';
import { CalendarIcon, MapPinIcon, ClipboardIcon, ClockIcon } from '../../components/Icons.jsx';

// Round-29 (N5): admin cube-test review queue.
//
// Mirrors the InspectionDashboard structure (filter chips + card grid)
// but the data source is `/api/cube-tests/due-soon?days=N` instead of
// the inspection list. We deliberately scope this to "due soon" so an
// admin's first-load view is action-oriented (what 28-day tests need
// attention this week) rather than a flat unfiltered dump.
//
// "Overdue" rows are surfaced with a red badge — the backend sets the
// OVERDUE enum when the cron sweep catches a stale row, so the colour
// comes straight from the row's status.

const DAYS_OPTIONS = [
  { value: 7, label: 'Next 7 days' },
  { value: 14, label: 'Next 14 days' },
  { value: 30, label: 'Next 30 days' },
  { value: 60, label: 'Next 60 days' },
  { value: 90, label: 'Next 90 days' },
];

const STATUS_FILTERS = [
  { value: '', label: 'All statuses' },
  { value: 'PENDING', label: 'Pending' },
  { value: 'SEVEN_DAY_PASSED', label: '7d passed' },
  { value: 'SEVEN_DAY_FAILED', label: '7d failed' },
  { value: 'TWENTY_EIGHT_DAY_PASSED', label: '28d passed' },
  { value: 'TWENTY_EIGHT_DAY_FAILED', label: '28d failed' },
  { value: 'OVERDUE', label: 'Overdue' },
];

function formatIndianDate(iso) {
  if (!iso) return '—';
  return formatShortDate(iso) || String(iso);
}

function StatCard({ number, label, color }) {
  return (
    <div className="dpr-stat-card">
      <div className="dpr-stat-number" style={color ? { color } : {}}>{number}</div>
      <div className="dpr-stat-label">{label}</div>
    </div>
  );
}

export default function CubeTestDashboard() {
  useDocumentTitle('Cube Tests Review');
  const { accessToken } = useAuth();
  const toast = useToast();
  const [tests, setTests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [days, setDays] = useState(7);
  const [statusFilter, setStatusFilter] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await api.getCubeTestsDueSoon(days, accessToken);
      setTests(data.tests || []);
    } catch (err) {
      if (err.status !== 401) {
        setError(err.message || 'Failed to load cube-test review queue.');
        toast.push(err.message || 'Failed to load cube-test review queue.', 'error');
      }
    } finally {
      setLoading(false);
    }
  }, [accessToken, days, toast]);

  useEffect(() => { load(); }, [load]);

  // Counts for the stat tiles. Filtered by status client-side — the
  // backend intentionally returns every status (admin wants to see
  // PASSED rows in the roll-up) and the chips narrow the rendered grid.
  const counts = {
    total: tests.length,
    overdue: tests.filter((t) => t.status === 'OVERDUE').length,
    pending: tests.filter((t) => t.status === 'PENDING').length,
    failed: tests.filter((t) => t.status?.endsWith('_FAILED')).length,
  };

  const filtered = statusFilter
    ? tests.filter((t) => t.status === statusFilter)
    : tests;

  return (
    <div className="dpr-page">
      <div className="dpr-page-header">
        <div>
          <h1 className="dpr-page-title">Cube Tests Review</h1>
          <p className="dpr-page-sub" style={{ color: 'var(--steel)', margin: 0, fontSize: '0.9rem' }}>
            28-day cube tests coming due in the next {days} days across the organization.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <Link to="/portal/cube-tests" className="btn btn-secondary btn-sm">
            ← My cube tests
          </Link>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: '0.75rem', marginBottom: '1rem' }}>
        <StatCard number={counts.total} label="Due in window" />
        <StatCard number={counts.pending} label="Pending" color="var(--blue)" />
        <StatCard number={counts.overdue} label="Overdue" color="var(--danger, #dc2626)" />
        <StatCard number={counts.failed} label="Failed (7d or 28d)" color="#f59e0b" />
      </div>

      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
        <div>
          <label htmlFor="cube-days" style={{ fontSize: '0.8rem', color: 'var(--steel)' }}>
            Window
          </label>
          <select
            id="cube-days"
            className="form-input"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            style={{ maxWidth: 180 }}
          >
            {DAYS_OPTIONS.map((d) => (
              <option key={d.value} value={d.value}>{d.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="cube-status" style={{ fontSize: '0.8rem', color: 'var(--steel)' }}>
            Status
          </label>
          <select
            id="cube-status"
            className="form-input"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            style={{ maxWidth: 220 }}
          >
            {STATUS_FILTERS.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </div>
      </div>

      {error && <div className="portal-auth-error" style={{ marginBottom: '1rem' }}>{error}</div>}

      {loading ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '1rem' }}>
          {[1, 2, 3].map((i) => (
            <div key={i} className="dpr-card" aria-hidden="true" style={{ minHeight: 160, opacity: 0.55 }}>
              <div style={{ height: 16, background: '#e2e8f0', borderRadius: 4, width: '60%', marginBottom: 12 }} />
              <div style={{ height: 12, background: '#e2e8f0', borderRadius: 4, width: '80%', marginBottom: 8 }} />
              <div style={{ height: 12, background: '#e2e8f0', borderRadius: 4, width: '40%' }} />
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="dpr-list-empty" style={{ textAlign: 'center', padding: '3rem' }}>
          <div style={{ marginBottom: '1rem', color: 'var(--steel)' }}>
            <ClipboardIcon size={48} />
          </div>
          <h3 style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", color: 'var(--navy)', marginBottom: '0.5rem' }}>
            Nothing in this window
          </h3>
          <p style={{ color: 'var(--steel)', marginBottom: '0.5rem' }}>
            No cube tests are due in the next {days} days{statusFilter ? ` matching the status filter` : ''}.
          </p>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '1rem' }}>
          {filtered.map((t) => {
            const projectName = t.dpr?.projectName || t.castingRecord?.projectName || 'Cube test';
            const isOverdue = t.status === 'OVERDUE';
            return (
              <Link
                key={t.id}
                to={`/portal/cube-tests/${t.id}`}
                className="dpr-card"
                style={{
                  textDecoration: 'none',
                  color: 'inherit',
                  display: 'block',
                  borderLeft: isOverdue ? '3px solid var(--danger, #dc2626)' : undefined,
                }}
              >
                <div className="dpr-card-header">
                  <div>
                    <h3 className="dpr-card-title">{projectName}</h3>
                    <div className="dpr-card-meta" style={{ marginTop: '0.5rem' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                        <MapPinIcon size={13} style={{ color: 'var(--steel)' }} />
                        {t.pourLocation}
                      </span>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                        <CalendarIcon size={13} style={{ color: 'var(--steel)' }} />
                        {formatIndianDate(t.castDate)}
                      </span>
                    </div>
                  </div>
                  <StatusBadge status={t.status} />
                </div>
                <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', fontSize: '0.8rem', color: 'var(--steel)' }}>
                  <span><strong style={{ color: 'var(--navy)' }}>Grade:</strong> {t.concreteGrade}</span>
                  <span><strong style={{ color: 'var(--navy)' }}>Expected:</strong> {t.expectedStrength} N/mm²</span>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                    <ClockIcon size={13} style={{ color: isOverdue ? 'var(--danger, #dc2626)' : 'var(--steel)' }} />
                    28d due {formatIndianDate(t.twentyEightDayDueDate)}
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
