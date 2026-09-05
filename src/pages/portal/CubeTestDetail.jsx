import React, { useState, useEffect, useCallback } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { api } from '../../lib/api.js';
import { formatShortDate, formatDateTime } from '../../lib/format.js';
import Breadcrumb from '../../components/Breadcrumb.jsx';
import StatusBadge from '../../components/StatusBadge.jsx';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';

function formatIndianDate(iso) {
  if (!iso) return '—';
  return formatShortDate(iso) || String(iso);
}

function formatIndianDateTime(iso) {
  if (!iso) return '—';
  return formatDateTime(iso) || String(iso);
}

// Result banner — derives a human-readable verdict from the cube's
// current result + expected strength. Mirrors the spec acceptance
// signal the backend uses (result >= expected ⇒ pass). Returns null
// when no result is on file yet so the caller can short-circuit.
function ResultBanner({ label, result, expected, testedAt }) {
  if (result == null) {
    return (
      <div
        role="status"
        style={{
          padding: '0.75rem 0.875rem',
          background: '#f8fafc',
          border: '1px solid #e2e8f0',
          borderRadius: 6,
          fontSize: '0.85rem',
          color: 'var(--steel)',
        }}
      >
        <strong style={{ color: 'var(--navy)' }}>{label}:</strong> pending test
        {testedAt ? ` · result recorded ${formatIndianDateTime(testedAt)}` : ''}
      </div>
    );
  }
  const passed = result >= expected;
  return (
    <div
      role="status"
      style={{
        padding: '0.75rem 0.875rem',
        background: passed ? '#f0fdf4' : '#fef2f2',
        border: '1px solid',
        borderColor: passed ? '#bbf7d0' : '#fecaca',
        borderLeft: `3px solid ${passed ? '#16a34a' : 'var(--danger, #dc2626)'}`,
        borderRadius: 6,
        fontSize: '0.85rem',
        color: passed ? '#14532d' : '#7f1d1d',
      }}
    >
      <strong>{label}:</strong>{' '}
      {passed ? 'PASSED' : 'FAILED'} ({result} N/mm² {passed ? '≥' : '<'} {expected} N/mm²)
      {testedAt ? ` · tested ${formatIndianDateTime(testedAt)}` : ''}
    </div>
  );
}

export default function CubeTestDetail() {
  useDocumentTitle('Cube Test Detail');
  const { id } = useParams();
  const { accessToken, employee } = useAuth();
  const toast = useToast();
  const [test, setTest] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // Edit-result modal state. Two modes: '7d' | '28d'. The form is local
  // to the modal so the parent page doesn't re-render on each keystroke.
  const [editing, setEditing] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await api.getCubeTest(id, accessToken);
      setTest(data);
    } catch (err) {
      if (err.status === 404) setError('Cube test not found.');
      else if (err.status === 403) setError('You do not have access to this cube test.');
      else setError(err.message || 'Failed to load cube test.');
      if (err.status !== 401 && err.status !== 403 && err.status !== 404) {
        toast.push(err.message || 'Failed to load cube test.', 'error');
      }
    } finally {
      setLoading(false);
    }
  }, [id, accessToken, toast]);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <div className="dpr-page">
        <div className="dpr-card" aria-hidden="true" style={{ minHeight: 280, opacity: 0.55 }}>
          <div style={{ height: 24, background: '#e2e8f0', borderRadius: 4, width: '40%', marginBottom: 16 }} />
          <div style={{ height: 12, background: '#e2e8f0', borderRadius: 4, width: '80%', marginBottom: 8 }} />
          <div style={{ height: 12, background: '#e2e8f0', borderRadius: 4, width: '60%' }} />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="dpr-page">
        <div className="dpr-card" style={{ textAlign: 'center', padding: '3rem' }}>
          <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>⚠️</div>
          <h2 style={{ color: 'var(--navy)', marginBottom: '0.5rem' }}>{error}</h2>
          <Link to="/portal/cube-tests" className="btn btn-secondary btn-sm" style={{ marginTop: '1rem' }}>
            ← Back to cube tests
          </Link>
        </div>
      </div>
    );
  }

  if (!test) return null;

  const projectName = test.dpr?.project?.name || test.dpr?.projectName || test.castingRecord?.project?.name || test.castingRecord?.projectName || 'Cube test';
  const isOwnerOrAdmin = test.submittedById === employee?.id || employee?.isAdmin;

  return (
    <div className="dpr-page">
      <div className="dpr-card">
        <Breadcrumb
          items={[
            { label: 'My Cube Tests', to: '/portal/cube-tests' },
            { label: `${projectName} · ${formatIndianDate(test.castDate)}` },
          ]}
        />

        <div className="inspection-detail-header">
          <div style={{ minWidth: 0 }}>
            <h1 className="dpr-page-title" style={{ marginBottom: '0.25rem' }}>
              {projectName}
            </h1>
            <div style={{ color: 'var(--steel)', fontSize: '0.9rem', overflowWrap: 'anywhere' }}>
              {test.pourLocation} · {test.concreteGrade} · expected {test.expectedStrength} N/mm²
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.5rem', flexShrink: 0 }}>
            <StatusBadge status={test.status} />
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.75rem', marginBottom: '1.5rem', fontSize: '0.85rem' }}>
          <div><strong>Cast date:</strong> {formatIndianDate(test.castDate)}</div>
          <div><strong>7d due:</strong> {formatIndianDate(test.sevenDayDueDate)}</div>
          <div><strong>28d due:</strong> {formatIndianDate(test.twentyEightDayDueDate)}</div>
          <div><strong>Filed by:</strong> {test.submittedBy?.name || '—'}</div>
          <div><strong>Filed at:</strong> {formatIndianDateTime(test.createdAt)}</div>
        </div>

        {/* Status banners — one per lab result. Drives the "do we have a
            verdict on this pour?" question without a separate status
            table; the same pattern is used on DPR detail. */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '1.5rem' }}>
          <ResultBanner
            label="7d"
            result={test.sevenDayResult}
            expected={test.expectedStrength}
            testedAt={test.sevenDayTestedAt}
          />
          <ResultBanner
            label="28d"
            result={test.twentyEightDayResult}
            expected={test.expectedStrength}
            testedAt={test.twentyEightDayTestedAt}
          />
        </div>

        {/* Linked records — DPR + casting inspection. Each card is a
            deep-link to the corresponding detail page so the user can
            navigate the cube → pour → report graph without returning
            to the list. */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '0.75rem', marginBottom: '1.5rem' }}>
          {test.dpr && (
            <Link
              to={`/portal/dpr/my`}
              className="dpr-card"
              style={{ textDecoration: 'none', color: 'inherit', display: 'block', padding: '0.75rem 1rem' }}
              title="Open linked DPR"
            >
              <div style={{ fontSize: '0.8rem', color: 'var(--steel)', marginBottom: '0.25rem' }}>
                Linked DPR
              </div>
              <div style={{ fontWeight: 600, color: 'var(--navy)', marginBottom: '0.25rem' }}>
                {test.dpr.project?.name || test.dpr.projectName}
              </div>
              <div style={{ fontSize: '0.85rem', color: 'var(--steel)' }}>
                {formatIndianDate(test.dpr.reportDate)} · {test.dpr.location}
              </div>
            </Link>
          )}
          {test.castingRecord && (
            <Link
              to={`/portal/inspection/${test.castingRecord.id}`}
              className="dpr-card"
              style={{ textDecoration: 'none', color: 'inherit', display: 'block', padding: '0.75rem 1rem' }}
              title="Open casting inspection"
            >
              <div style={{ fontSize: '0.8rem', color: 'var(--steel)', marginBottom: '0.25rem' }}>
                Casting inspection
              </div>
              <div style={{ fontWeight: 600, color: 'var(--navy)', marginBottom: '0.25rem' }}>
                {test.castingRecord.project?.name || test.castingRecord.projectName}
              </div>
              <div style={{ fontSize: '0.85rem', color: 'var(--steel)' }}>
                {formatIndianDate(test.castingRecord.reportDate)} · {test.castingRecord.inspectionType}
              </div>
            </Link>
          )}
        </div>

        {test.notes && (
          <div style={{ marginBottom: '1.5rem' }}>
            <h3 style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontSize: '1rem', marginBottom: '0.5rem', color: 'var(--navy)' }}>
              Notes
            </h3>
            <div style={{ background: '#f8fafc', borderRadius: 6, padding: '0.75rem 1rem', borderLeft: '3px solid var(--blue)', fontSize: '0.9rem', whiteSpace: 'pre-wrap' }}>
              {test.notes}
            </div>
          </div>
        )}

        <div style={{ borderTop: '1px solid #e2e8f0', paddingTop: '1rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <Link to="/portal/cube-tests" className="btn btn-secondary btn-sm">
            ← Back to cube tests
          </Link>
          {isOwnerOrAdmin && (
            <>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => setEditing('7d')}
              >
                Record 7d result
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => setEditing('28d')}
              >
                Record 28d result
              </button>
            </>
          )}
        </div>
      </div>

      {editing && (
        <ResultEditModal
          mode={editing}
          test={test}
          accessToken={accessToken}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
    </div>
  );
}

// Inline result-edit modal. Two fields: result (N/mm²) and testedAt
// (datetime-local). Submits via api.updateCubeTest. Status is
// server-derived so we don't send it.
function ResultEditModal({ mode, test, accessToken, onClose, onSaved }) {
  const is7d = mode === '7d';
  const [result, setResult] = useState(
    is7d ? test.sevenDayResult ?? '' : test.twentyEightDayResult ?? ''
  );
  const [testedAt, setTestedAt] = useState(() => {
    const existing = is7d ? test.sevenDayTestedAt : test.twentyEightDayTestedAt;
    if (existing) {
      // Convert to YYYY-MM-DDTHH:MM for datetime-local input.
      const d = new Date(existing);
      if (!isNaN(d.getTime())) {
        const tzOffset = d.getTimezoneOffset() * 60000;
        return new Date(d - tzOffset).toISOString().slice(0, 16);
      }
    }
    return new Date().toISOString().slice(0, 16);
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const toast = useToast();

  const handleSubmit = async (e) => {
    e.preventDefault();
    const numeric = Number(result);
    if (!Number.isFinite(numeric) || numeric <= 0 || numeric > 200) {
      setError('Result must be a finite number between 0 and 200 N/mm².');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const payload = is7d
        ? { sevenDayResult: numeric, sevenDayTestedAt: testedAt ? new Date(testedAt).toISOString() : null }
        : { twentyEightDayResult: numeric, twentyEightDayTestedAt: testedAt ? new Date(testedAt).toISOString() : null };
      await api.updateCubeTest(test.id, payload, accessToken);
      toast.push(`${is7d ? '7d' : '28d'} result recorded.`, 'success');
      onSaved();
    } catch (err) {
      const code = err?.code;
      let friendly = err.message || 'Failed to save result.';
      if (code === 'INVALID_RESULT') friendly = 'Result must be a finite number between 0 and 200 N/mm².';
      else if (code === 'INVALID_TESTED_AT') friendly = 'Tested-at must be a valid date and time.';
      else if (code === 'TESTED_AT_WITHOUT_RESULT') friendly = 'A tested-at timestamp requires a result.';
      setError(friendly);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Record ${mode} result`}
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 100, padding: '1rem',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'white', borderRadius: 12, maxWidth: 440, width: '100%',
          boxShadow: '0 20px 60px rgba(0,0,0,0.25)',
        }}
      >
        <div style={{ padding: '1rem 1.25rem', borderBottom: '1px solid #e2e8f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h1 style={{ margin: 0, fontSize: '1.05rem', color: 'var(--navy)' }}>
            Record {is7d ? '7-day' : '28-day'} result
          </h1>
          <button onClick={onClose} aria-label="Close" className="btn btn-ghost btn-sm" style={{ fontSize: '1.25rem', lineHeight: 1 }}>×</button>
        </div>

        <form onSubmit={handleSubmit} style={{ padding: '1rem 1.25rem' }}>
          {error && (
            <div role="alert" style={{ marginBottom: '0.75rem', padding: '0.5rem 0.75rem', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, color: '#7f1d1d', fontSize: '0.85rem' }}>
              {error}
            </div>
          )}
          <div className="form-group">
            <label htmlFor="result-value">Result (N/mm²)</label>
            <input
              id="result-value"
              className="form-input"
              type="number"
              min="0.1"
              max="200"
              step="0.1"
              value={result}
              onChange={(e) => setResult(e.target.value)}
              required
            />
            <small style={{ color: 'var(--steel)', fontSize: '0.8rem', marginTop: '0.25rem', display: 'block' }}>
              Expected: {test.expectedStrength} N/mm² · pass = result ≥ expected
            </small>
          </div>
          <div className="form-group">
            <label htmlFor="result-tested-at">Tested at</label>
            <input
              id="result-tested-at"
              className="form-input"
              type="datetime-local"
              value={testedAt}
              onChange={(e) => setTestedAt(e.target.value)}
              required
            />
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '0.5rem' }}>
            <button type="button" className="btn btn-secondary btn-sm" onClick={onClose} disabled={submitting}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary btn-sm" disabled={submitting}>
              {submitting ? 'Saving…' : 'Save result'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
