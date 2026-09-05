// N7 (round-28) — employee-facing BOQ variance report.
//
// Read-only view of the contract-vs-executed delta for one project.
// Same data the BoqAdmin page shows in its "Variance" column, but as
// the primary content so employees who don't administer the registry
// can still see whether they're on budget for a given BOQ item.
//
// Color semantics (same as BoqAdmin):
//   - Green = variance > 0  (executed < contract; budget remaining).
//     We display this as "ahead" — there's still quantity to bill.
//   - Red   = variance < 0  (executed > contract; overrunning).
//   - Grey  = variance = 0  (exact match).
//
// The page is reachable from any logged-in user (no admin gate). The
// underlying GET /api/boq/variance only requires auth, so non-admin
// employees get the same view.

import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { api } from '../../lib/api.js';
import Breadcrumb from '../../components/Breadcrumb.jsx';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';
import usePullToRefresh from '../../hooks/usePullToRefresh.js';
import PullToRefreshIndicator from '../../components/PullToRefreshIndicator.jsx';

function formatInr(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 2,
  });
}

function formatVariancePct(executed, contract) {
  const c = Number(contract) || 0;
  const e = Number(executed) || 0;
  if (c <= 0) return '—';
  const pct = ((e - c) / c) * 100;
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

// Variance colour. Negative varianceQty = executed > contract = overrun
// (red). Positive = ahead of contract (green).
function varianceColor(varianceQty) {
  if (varianceQty < 0) return '#dc2626';
  if (varianceQty > 0) return '#16a34a';
  return 'var(--steel)';
}

export default function BoqVariance() {
  useDocumentTitle('BOQ Variance');
  const { accessToken, employee } = useAuth();
  const toast = useToast();

  const [projectName, setProjectName] = useState('');
  const [appliedProject, setAppliedProject] = useState('');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!appliedProject) {
      setItems([]);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const data = await api.getBoqVariance(appliedProject, accessToken);
      setItems(data.items || []);
    } catch (err) {
      setError(err.message || 'Failed to load variance');
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [accessToken, appliedProject]);

  useEffect(() => { load(); }, [load]);

  // Round-28 #6: pull-to-refresh on mobile. Re-runs `load()` on a swipe
  // at the top of the page so field engineers don't have to find a
  // refresh button while standing on site.
  const { pullDistance, isRefreshing } = usePullToRefresh(async () => {
    try {
      await load();
    } catch (err) {
      toast.push(err?.message || 'Refresh failed', 'error');
    }
  });

  // Aggregate totals. Surfaces "of N items, N are over contract" at
  // the top of the report — the billing engineer's headline number.
  const totals = items.reduce(
    (acc, it) => {
      acc.contractQty += Number(it.contractQty) || 0;
      acc.executedQty += Number(it.executedQty) || 0;
      acc.contractAmount += Number(it.contractAmount) || 0;
      acc.executedAmount += Number(it.executedAmount) || 0;
      if (it.varianceQty < 0) acc.overruns += 1;
      else if (it.varianceQty > 0) acc.ahead += 1;
      return acc;
    },
    { contractQty: 0, executedQty: 0, contractAmount: 0, executedAmount: 0, overruns: 0, ahead: 0 },
  );

  return (
    <div className="dpr-page">
      <PullToRefreshIndicator pullDistance={pullDistance} isRefreshing={isRefreshing} />
      <div className="dpr-page-header">
        <div>
          <Breadcrumb items={[{ label: 'BOQ Variance' }]} />
          <h1 className="dpr-page-title">BOQ Variance</h1>
          <p style={{ margin: '0.25rem 0 0', color: 'var(--steel)', fontSize: '0.9rem' }}>
            Compare contract quantity vs. executed quantity (sum of linked DPRs).
          </p>
        </div>
      </div>

      <div className="dpr-card" style={{ marginBottom: '1rem' }}>
        <div className="form-row" style={{ alignItems: 'flex-end' }}>
          <div className="form-group" style={{ flex: 1 }}>
            <label htmlFor="boq-variance-project">Project name</label>
            <input
              id="boq-variance-project"
              type="text"
              className="form-input"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') setAppliedProject(projectName.trim());
              }}
              placeholder="e.g. Metro Station Phase 2"
            />
          </div>
          <div className="form-group" style={{ alignSelf: 'flex-end' }}>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setAppliedProject(projectName.trim())}
              disabled={!projectName.trim()}
            >
              Show variance
            </button>
          </div>
        </div>
        {employee?.isAdmin && (
          <p style={{ margin: '0.75rem 0 0', fontSize: '0.8rem', color: 'var(--steel)' }}>
            Need to add or edit BOQ items?{' '}
            <Link to="/portal/admin/boq">Open BOQ Registry →</Link>
          </p>
        )}
      </div>

      {error && <div className="portal-auth-error" style={{ marginBottom: '1rem' }}>{error}</div>}

      {!appliedProject ? (
        <div className="dpr-list-empty">
          <div style={{ marginBottom: '1rem', color: 'var(--steel)', fontSize: '2rem' }}>📊</div>
          <h3 style={{ color: 'var(--navy)', marginBottom: '0.5rem' }}>Enter a project name to see variance</h3>
          <p style={{ color: 'var(--steel)', marginBottom: 0 }}>
            The variance report is scoped to one project at a time.
          </p>
        </div>
      ) : loading ? (
        <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--steel)' }}>
          <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>⏳</div>
          Loading variance...
        </div>
      ) : items.length === 0 ? (
        <div className="dpr-list-empty">
          <div style={{ marginBottom: '1rem', color: 'var(--steel)', fontSize: '2rem' }}>📭</div>
          <h3 style={{ color: 'var(--navy)', marginBottom: '0.5rem' }}>No BOQ items for this project</h3>
          <p style={{ color: 'var(--steel)', marginBottom: '1.5rem' }}>
            {employee?.isAdmin
              ? <>Add BOQ items in the <Link to="/portal/admin/boq">BOQ Registry</Link> to start tracking variance.</>
              : 'Ask the billing engineer to add BOQ items for this project.'}
          </p>
        </div>
      ) : (
        <>
          {/* Summary tiles — the headline numbers the billing engineer
              wants to see first. Mirrors DprList's stats-card pattern. */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              gap: '0.75rem',
              marginBottom: '1rem',
            }}
          >
            <div className="dpr-card" style={{ padding: '0.875rem 1rem' }}>
              <div style={{ fontSize: '0.75rem', color: 'var(--steel)', textTransform: 'uppercase' }}>Items</div>
              <div style={{ fontSize: '1.4rem', fontWeight: 700, color: 'var(--navy)' }}>{items.length}</div>
              <div style={{ fontSize: '0.75rem', color: 'var(--steel)' }}>
                <span style={{ color: '#dc2626' }}>{totals.overruns} overrun</span>
                {' · '}
                <span style={{ color: '#16a34a' }}>{totals.ahead} ahead</span>
              </div>
            </div>
            <div className="dpr-card" style={{ padding: '0.875rem 1rem' }}>
              <div style={{ fontSize: '0.75rem', color: 'var(--steel)', textTransform: 'uppercase' }}>Contract amount</div>
              <div style={{ fontSize: '1.4rem', fontWeight: 700, color: 'var(--navy)' }}>{formatInr(totals.contractAmount)}</div>
              <div style={{ fontSize: '0.75rem', color: 'var(--steel)' }}>vs. executed {formatInr(totals.executedAmount)}</div>
            </div>
            <div className="dpr-card" style={{ padding: '0.875rem 1rem' }}>
              <div style={{ fontSize: '0.75rem', color: 'var(--steel)', textTransform: 'uppercase' }}>Contract qty (sum)</div>
              <div style={{ fontSize: '1.4rem', fontWeight: 700, color: 'var(--navy)' }}>
                {totals.contractQty.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
              </div>
              <div style={{ fontSize: '0.75rem', color: 'var(--steel)' }}>
                Executed: {totals.executedQty.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
              </div>
            </div>
          </div>

          <div className="dpr-card" style={{ padding: 0, overflow: 'hidden' }}>
            <div
              className="dpr-list-item"
              style={{
                background: '#f8fafc',
                fontWeight: 600,
                fontSize: '0.8rem',
                color: 'var(--steel)',
                padding: '0.75rem 1rem',
                display: 'flex',
              }}
            >
              <div style={{ flex: '0 0 90px' }}>Code</div>
              <div style={{ flex: 2 }}>Description</div>
              <div style={{ flex: '0 0 70px' }}>Unit</div>
              <div style={{ flex: '0 0 110px', textAlign: 'right' }}>Contract</div>
              <div style={{ flex: '0 0 110px', textAlign: 'right' }}>Executed</div>
              <div style={{ flex: '0 0 110px', textAlign: 'right' }}>Variance</div>
              <div style={{ flex: '0 0 100px', textAlign: 'right' }}>Var %</div>
            </div>

            {items.map((it) => (
              <div
                key={it.id}
                className="dpr-list-item"
                style={{ display: 'flex' }}
              >
                <div style={{ flex: '0 0 90px', fontFamily: 'monospace', color: 'var(--navy)' }}>
                  {it.itemCode}
                </div>
                <div style={{ flex: 2, minWidth: 0, color: 'var(--navy)' }}>
                  <div style={{ fontWeight: 500, marginBottom: '0.25rem', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {it.description}
                  </div>
                </div>
                <div style={{ flex: '0 0 70px', fontSize: '0.85rem', color: 'var(--steel)' }}>
                  {it.unit}
                </div>
                <div style={{ flex: '0 0 110px', textAlign: 'right', fontSize: '0.85rem' }}>
                  {Number(it.contractQty).toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                </div>
                <div style={{ flex: '0 0 110px', textAlign: 'right', fontSize: '0.85rem' }}>
                  {Number(it.executedQty).toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                </div>
                <div
                  style={{
                    flex: '0 0 110px',
                    textAlign: 'right',
                    fontSize: '0.85rem',
                    color: varianceColor(it.varianceQty),
                    fontWeight: 600,
                  }}
                >
                  {(it.varianceQty > 0 ? '+' : '')}{Number(it.varianceQty).toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                </div>
                <div
                  style={{
                    flex: '0 0 100px',
                    textAlign: 'right',
                    fontSize: '0.85rem',
                    color: varianceColor(it.varianceQty),
                  }}
                >
                  {formatVariancePct(it.executedQty, it.contractQty)}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
