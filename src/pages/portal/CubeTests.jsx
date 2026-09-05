import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { api } from '../../lib/api.js';
import { formatShortDate } from '../../lib/format.js';
import StatusBadge from '../../components/StatusBadge.jsx';
import MonthStepper from '../../components/MonthStepper.jsx';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';
import { CalendarIcon, MapPinIcon, ClipboardIcon } from '../../components/Icons.jsx';
// Round-28 #6: pull-to-refresh on mobile list views.
import usePullToRefresh from '../../hooks/usePullToRefresh.js';
import PullToRefreshIndicator from '../../components/PullToRefreshIndicator.jsx';

// Round-29 (N5): cube-test list. Mirrors InspectionList.jsx structurally
// — same filter row, same card grid, same pull-to-refresh overlay. The
// status filter uses the cube-test enum (PENDING / SEVEN_DAY_PASSED /
// SEVEN_DAY_FAILED / TWENTY_EIGHT_DAY_PASSED / TWENTY_EIGHT_DAY_FAILED /
// OVERDUE) rather than the inspection enum.
//
// The "Due in next 7 days" section is a thin call to getCubeTestsDueSoon(7)
// at the top — it surfaces admin-relevant items (28-day tests due soon)
// without forcing the list to scope itself entirely to that window.
//
// Concrete grades — IS 456 nominal characteristic strengths. Expected
// strength defaults to the grade number so the form is fast to fill out
// and the cube-test derivation matches IS 456's default test acceptance
// (which is the grade number, e.g. M25 characteristic = 25 N/mm²).

const CONCRETE_GRADES = ['M20', 'M25', 'M30', 'M35', 'M40', 'M50'];

const DEFAULT_EXPECTED_STRENGTH = (grade) => {
  const n = Number(String(grade || '').replace(/^M/i, ''));
  return Number.isFinite(n) ? n : 25;
};

const CUBE_STATUS_FILTERS = [
  { value: '', label: 'All statuses' },
  { value: 'PENDING', label: 'Pending' },
  { value: 'SEVEN_DAY_PASSED', label: '7d passed' },
  { value: 'SEVEN_DAY_FAILED', label: '7d failed' },
  { value: 'TWENTY_EIGHT_DAY_PASSED', label: '28d passed' },
  { value: 'TWENTY_EIGHT_DAY_FAILED', label: '28d failed' },
  { value: 'OVERDUE', label: 'Overdue' },
];

// CubeTestModal — the "+ Record Cube Test" form. Mobile-friendly: on
// viewports <768px it occupies the full screen and pins the action row
// to the bottom. The DPR / casting-inspection pickers are optional
// selects pre-populated with the user's recent rows so a tester on
// site can wire the cube to the right pour in a couple of taps.
function CubeTestModal({ open, onClose, onCreated }) {
  const { accessToken } = useAuth();
  const toast = useToast();
  const [dprs, setDprs] = useState([]);
  const [inspections, setInspections] = useState([]);
  const [loadingRefs, setLoadingRefs] = useState(false);
  const [form, setForm] = useState(() => {
    const today = new Date().toISOString().slice(0, 10);
    return {
      pourLocation: '',
      concreteGrade: 'M25',
      expectedStrength: 25,
      castDate: today,
      dprId: '',
      castingRecordId: '',
      notes: '',
    };
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  // Fetch the user's recent DPRs and cube_casting inspections when the
  // modal opens. Both are bounded to 50 so the picker stays fast on
  // slow connections. We deliberately do NOT fire these on mount of the
  // parent page — most users will land here to view, not file, and a
  // pre-emptive 50-row fetch on every list load is wasteful.
  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setLoadingRefs(true);
    (async () => {
      try {
        const [dprData, inspData] = await Promise.all([
          api.getDprs({ my: 'true', limit: '50' }, accessToken).catch(() => ({ dprs: [] })),
          api.getInspections({ inspectionType: 'cube_casting', limit: '50' }, accessToken).catch(() => ({ inspections: [] })),
        ]);
        if (cancelled) return;
        setDprs(dprData.dprs || []);
        setInspections(inspData.inspections || []);
      } finally {
        if (!cancelled) setLoadingRefs(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, accessToken]);

  const update = (key, value) => setForm((f) => ({ ...f, [key]: value }));

  const handleGradeChange = (grade) => {
    // Auto-suggest expected strength from the grade number — tester can
    // override (e.g. mix design specifies a 30 N/mm² target for M25), but
    // the default is the grade's characteristic strength.
    update('concreteGrade', grade);
    update('expectedStrength', DEFAULT_EXPECTED_STRENGTH(grade));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.pourLocation.trim()) {
      setError('Pour location is required.');
      return;
    }
    if (!Number.isFinite(form.expectedStrength) || form.expectedStrength <= 0) {
      setError('Expected strength must be a positive number.');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const payload = {
        pourLocation: form.pourLocation.trim(),
        concreteGrade: form.concreteGrade,
        castDate: form.castDate,
        expectedStrength: Number(form.expectedStrength),
        notes: form.notes || null,
        dprId: form.dprId || null,
        // N5 spec: "If user provided a DPR, also auto-link the inspection as
        // casting record" — we honour that by passing both only when the
        // user explicitly picked both. Otherwise the castingRecordId is
        // null (a standalone filing) or whatever the user picked.
        castingRecordId: form.castingRecordId || null,
      };
      const created = await api.createCubeTest(payload, accessToken);
      toast.push('Cube test recorded.', 'success');
      onCreated?.(created);
      onClose();
    } catch (err) {
      const code = err?.code;
      let friendly = err.message || 'Failed to save cube test.';
      // R8 parity with DprList: surface backend structured codes as plain
      // English instead of the raw Prisma / validation string.
      if (code === 'INVALID_EXPECTED_STRENGTH') friendly = 'Expected strength must be between 0 and 200 N/mm².';
      else if (code === 'INVALID_CAST_DATE') friendly = 'Cast date must be a valid date.';
      else if (code === 'NOT_OWNER') friendly = 'You can only link a cube test to your own DPR or casting inspection (or be an admin).';
      else if (code === 'INSPECTION_TYPE_INVALID') friendly = 'The selected inspection is not a cube-casting record.';
      else if (code === 'CASTING_INSPECTION_NOT_FOUND' || code === 'DPR_NOT_FOUND') friendly = 'Selected DPR or inspection no longer exists.';
      setError(friendly);
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Record cube test"
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 100, padding: '1rem',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="cube-test-modal-card"
        style={{
          background: 'white', borderRadius: 12, maxWidth: 560, width: '100%',
          maxHeight: '90vh', overflow: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.25)',
        }}
      >
        <div style={{ padding: '1.25rem 1.5rem', borderBottom: '1px solid #e2e8f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h1 style={{ margin: 0, fontSize: '1.15rem', color: 'var(--navy)' }}>Record Cube Test</h1>
          <button onClick={onClose} aria-label="Close" className="btn btn-ghost btn-sm" style={{ fontSize: '1.25rem', lineHeight: 1 }}>×</button>
        </div>

        <form onSubmit={handleSubmit} style={{ padding: '1.25rem 1.5rem' }}>
          {error && (
            <div role="alert" style={{ marginBottom: '0.75rem', padding: '0.5rem 0.75rem', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, color: '#7f1d1d', fontSize: '0.85rem' }}>
              {error}
            </div>
          )}

          <div className="form-row">
            <div className="form-group">
              <label htmlFor="ct-pour-location">Pour location</label>
              <input
                id="ct-pour-location"
                className="form-input"
                value={form.pourLocation}
                onChange={(e) => update('pourLocation', e.target.value)}
                placeholder="e.g. Column C-3, 4th floor"
                required
              />
            </div>
            <div className="form-group">
              <label htmlFor="ct-grade">Concrete grade</label>
              <select
                id="ct-grade"
                className="form-input"
                value={form.concreteGrade}
                onChange={(e) => handleGradeChange(e.target.value)}
              >
                {CONCRETE_GRADES.map((g) => (
                  <option key={g} value={g}>{g}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="form-row">
            <div className="form-group">
              <label htmlFor="ct-expected">Expected strength (N/mm²)</label>
              <input
                id="ct-expected"
                className="form-input"
                type="number"
                min="0.1"
                max="200"
                step="0.1"
                value={form.expectedStrength}
                onChange={(e) => update('expectedStrength', e.target.value)}
              />
            </div>
            <div className="form-group">
              <label htmlFor="ct-cast-date">Cast date</label>
              <input
                id="ct-cast-date"
                className="form-input"
                type="date"
                value={form.castDate}
                onChange={(e) => update('castDate', e.target.value)}
                required
              />
            </div>
          </div>

          <div className="form-row">
            <div className="form-group">
              <label htmlFor="ct-dpr">Linked DPR (optional)</label>
              <select
                id="ct-dpr"
                className="form-input"
                value={form.dprId}
                onChange={(e) => update('dprId', e.target.value)}
                disabled={loadingRefs}
              >
                <option value="">None</option>
                {dprs.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.project?.name || d.projectName} · {formatShortDate(d.reportDate)}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label htmlFor="ct-inspection">Casting inspection (optional)</label>
              <select
                id="ct-inspection"
                className="form-input"
                value={form.castingRecordId}
                onChange={(e) => update('castingRecordId', e.target.value)}
                disabled={loadingRefs}
              >
                <option value="">None</option>
                {inspections.map((i) => (
                  <option key={i.id} value={i.id}>
                    {formatShortDate(i.reportDate)} · {i.location || i.project?.name || i.projectName || 'Cube casting'}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="form-group">
            <label htmlFor="ct-notes">Notes</label>
            <textarea
              id="ct-notes"
              className="form-input"
              rows={3}
              value={form.notes}
              onChange={(e) => update('notes', e.target.value)}
              placeholder="Mix design, ambient conditions, admixtures…"
            />
          </div>

          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '1rem' }}>
            <button type="button" className="btn btn-secondary btn-sm" onClick={onClose} disabled={submitting}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary btn-sm" disabled={submitting}>
              {submitting ? 'Saving…' : 'Save cube test'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function CubeStatusText({ status }) {
  // Map the enum to a friendly label — the StatusBadge already renders
  // an uppercase title-cased string, but a couple of states benefit
  // from extra context (e.g. "Pending" → "Pending · 28d due Sep 12").
  if (!status) return null;
  return <StatusBadge status={status} />;
}

function CubeTestCard({ test }) {
  const projectName = test.dpr?.project?.name || test.dpr?.projectName || test.castingRecord?.project?.name || test.castingRecord?.projectName || 'Cube test';
  return (
    <Link
      to={`/portal/cube-tests/${test.id}`}
      className="dpr-card"
      style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}
    >
      <div className="dpr-card-header">
        <div>
          <h3 className="dpr-card-title">{projectName}</h3>
          <div className="dpr-card-meta" style={{ marginTop: '0.5rem' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
              <MapPinIcon size={13} style={{ color: 'var(--steel)' }} />
              {test.pourLocation}
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
              <CalendarIcon size={13} style={{ color: 'var(--steel)' }} />
              {formatShortDate(test.castDate) || '—'}
            </span>
          </div>
        </div>
        <CubeStatusText status={test.status} />
      </div>

      <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', fontSize: '0.8rem', color: 'var(--steel)' }}>
        <span><strong style={{ color: 'var(--navy)' }}>Grade:</strong> {test.concreteGrade}</span>
        <span><strong style={{ color: 'var(--navy)' }}>Expected:</strong> {test.expectedStrength} N/mm²</span>
        {test.sevenDayResult != null && (
          <span>
            <strong style={{ color: 'var(--navy)' }}>7d:</strong>{' '}
            {test.sevenDayResult} N/mm²
          </span>
        )}
        {test.twentyEightDayResult != null && (
          <span>
            <strong style={{ color: 'var(--navy)' }}>28d:</strong>{' '}
            {test.twentyEightDayResult} N/mm²
          </span>
        )}
      </div>
    </Link>
  );
}

export default function CubeTests() {
  useDocumentTitle('My Cube Tests');
  const { accessToken, employee } = useAuth();
  const toast = useToast();
  const [tests, setTests] = useState([]);
  const [dueSoon, setDueSoon] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  // dueBefore accepts a YYYY-MM-DD value — the list endpoint filters by
  // `twentyEightDayDueDate <= dueBefore`. Empty string = no filter.
  const [dueBefore, setDueBefore] = useState('');
  const [month, setMonth] = useState('');
  const [modalOpen, setModalOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = {};
      // N-3 parity with InspectionList: scope to "my" cube tests — an
      // employee seeing every org cube test on this page would be a
      // scope bug. Admins use the dedicated admin queue for the org view.
      params.my = 'true';
      if (statusFilter) params.status = statusFilter;
      if (dueBefore) params.dueBefore = dueBefore;
      // Month is a client-side filter for now — the backend doesn't
      // expose a `month` shortcut on /api/cube-tests, but castDate is
      // easy to filter in JS for a small list. This keeps the page
      // snappy while we wait for a backend shortcut.
      const data = await api.getCubeTests(params, accessToken);
      let rows = data.tests || [];
      if (month) {
        rows = rows.filter((t) => {
          if (!t.castDate) return false;
          const castMonth = String(t.castDate).slice(0, 7);
          return castMonth === month;
        });
      }
      setTests(rows);

      // The "due in next 7 days" pane is a thin parallel call. If it
      // fails (e.g. the admin-only /due-soon route returns 403 for
      // non-admins), we just hide the section — not a blocker.
      try {
        const dueData = await api.getCubeTestsDueSoon(7, accessToken);
        setDueSoon(dueData.tests || []);
      } catch (dueErr) {
        setDueSoon([]);
      }
    } catch (err) {
      if (err.status !== 401) {
        setError(err.message || 'Failed to load cube tests.');
        toast.push(err.message || 'Failed to load cube tests.', 'error');
      }
    } finally {
      setLoading(false);
    }
  }, [accessToken, statusFilter, dueBefore, month, toast]);

  useEffect(() => { load(); }, [load]);

  // R8 fix: refetch on tab focus so each row's status always reflects
  // backend truth (an admin approving a cube-test entry in another tab
  // would otherwise leave the local React state stale).
  useEffect(() => {
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, dueBefore, month, accessToken]);

  // Round-28 #6: pull-to-refresh on mobile.
  const { pullDistance, isRefreshing } = usePullToRefresh(async () => {
    await load();
  });

  const handleCreated = () => {
    // Force a re-fetch so the new row shows up immediately. The modal
    // already toasted success — no need to re-toast on the refresh.
    load();
  };

  return (
    <div className="dpr-page">
      <PullToRefreshIndicator pullDistance={pullDistance} isRefreshing={isRefreshing} />
      <div className="dpr-page-header">
        <h1 className="dpr-page-title">My Cube Tests</h1>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <MonthStepper value={month} onChange={setMonth} />
          <button
            className="btn btn-primary btn-sm"
            onClick={() => setModalOpen(true)}
            aria-label="Record a new cube test"
          >
            + Record Cube Test
          </button>
          {employee?.isAdmin && (
            <Link to="/portal/admin/cube-tests" className="btn btn-secondary btn-sm">
              All Cube Tests
            </Link>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
        <select
          className="form-input"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          style={{ maxWidth: 220 }}
          aria-label="Filter by status"
        >
          {CUBE_STATUS_FILTERS.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
        <div>
          <label htmlFor="cube-due-before" style={{ fontSize: '0.8rem', color: 'var(--steel)' }}>
            Due before
          </label>
          <input
            id="cube-due-before"
            className="form-input"
            type="date"
            value={dueBefore}
            onChange={(e) => setDueBefore(e.target.value)}
            style={{ maxWidth: 180 }}
          />
        </div>
      </div>

      {error && <div className="portal-auth-error" style={{ marginBottom: '1rem' }}>{error}</div>}

      {/* "Due in next 7 days" — admin-relevant strip. We always render the
          section header so the layout doesn't jump when results come back;
          an empty state just shows "Nothing due in the next week". */}
      <section style={{ marginBottom: '1.5rem' }}>
        <h2 style={{ fontSize: '0.95rem', color: 'var(--navy)', margin: '0 0 0.5rem' }}>
          Due in next 7 days
        </h2>
        {dueSoon.length === 0 ? (
          <div className="dpr-card" style={{ padding: '0.875rem 1rem', color: 'var(--steel)', fontSize: '0.9rem' }}>
            Nothing due in the next week.
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '0.75rem' }}>
            {dueSoon.map((t) => <CubeTestCard key={t.id} test={t} />)}
          </div>
        )}
      </section>

      <h2 style={{ fontSize: '0.95rem', color: 'var(--navy)', margin: '0 0 0.5rem' }}>
        All cube tests
      </h2>

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
      ) : tests.length === 0 ? (
        <div className="dpr-list-empty" style={{ textAlign: 'center', padding: '3rem' }}>
          <div style={{ marginBottom: '1rem', color: 'var(--steel)' }}>
            <ClipboardIcon size={48} />
          </div>
          <h3 style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", color: 'var(--navy)', marginBottom: '0.5rem' }}>
            No cube tests yet
          </h3>
          <p style={{ color: 'var(--steel)', marginBottom: '1rem' }}>
            Record a cube test from your next concrete pour to track 7-day and 28-day results.
          </p>
          <button className="btn btn-primary btn-sm" onClick={() => setModalOpen(true)}>
            + Record Cube Test
          </button>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '1rem' }}>
          {tests.map((t) => <CubeTestCard key={t.id} test={t} />)}
        </div>
      )}

      <CubeTestModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onCreated={handleCreated}
      />
    </div>
  );
}
