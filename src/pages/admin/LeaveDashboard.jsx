import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { api } from '../../lib/api.js';

const FILTERS = [
  { key: 'PENDING', label: 'Pending' },
  { key: 'APPROVED', label: 'Approved' },
  { key: 'REJECTED', label: 'Rejected' },
  { key: 'CANCELLED', label: 'Cancelled' },
  { key: 'ALL', label: 'All' },
];

const STATUS_LABEL = {
  PENDING: 'Pending',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  CANCELLED: 'Cancelled',
};

const LeaveStatusPill = ({ status }) => {
  const cls = `leave-pill leave-pill-${(status || 'PENDING').toLowerCase()}`;
  return (
    <span className={cls} aria-label={`Status: ${STATUS_LABEL[status] || status}`}>
      {STATUS_LABEL[status] || status}
    </span>
  );
};

const formatDate = (dateStr) => {
  if (!dateStr) return '';
  const [y, m, d] = String(dateStr).split('T')[0].split('-').map(Number);
  if (!y || !m || !d) return dateStr;
  return new Date(y, m - 1, d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
};
const formatDateTime = (dateStr) => {
  if (!dateStr) return '';
  return new Date(dateStr).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};
const inclusiveDayCount = (startStr, endStr) => {
  if (!startStr || !endStr) return 0;
  const [sy, sm, sd] = startStr.split('-').map(Number);
  const [ey, em, ed] = endStr.split('-').map(Number);
  const s = new Date(sy, sm - 1, sd).getTime();
  const e = new Date(ey, em - 1, ed).getTime();
  if (Number.isNaN(s) || Number.isNaN(e) || e < s) return 0;
  return Math.round((e - s) / (1000 * 60 * 60 * 24)) + 1;
};

export default function LeaveDashboard() {
  const { employee, accessToken } = useAuth();
  const { push } = useToast();

  const [filter, setFilter] = useState('PENDING');
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [actionPending, setActionPending] = useState({}); // { [id]: 'approve'|'reject' }
  const [rejectingId, setRejectingId] = useState(null);
  const [rejectNote, setRejectNote] = useState('');

  const fetchRequests = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = filter === 'ALL' ? {} : { status: filter };
      const data = await api.getAllLeaves(params, accessToken);
      setRequests(data.requests || []);
    } catch (err) {
      setError(err.message || 'Failed to load leave requests');
    } finally {
      setLoading(false);
    }
  }, [filter, accessToken]);

  useEffect(() => {
    if (!employee?.isAdmin) return;
    fetchRequests();
  }, [employee?.isAdmin, fetchRequests]);

  const isSelfApproval = (r) => r.employee && employee && r.employee.id === employee.id;

  const handleApprove = async (r) => {
    if (isSelfApproval(r)) {
      push('You cannot approve your own leave request.', 'error');
      return;
    }
    const days = inclusiveDayCount(r.startDate, r.endDate);
    if (days > 7 && !window.confirm(`Approve ${days}-day leave for ${r.employee?.name || 'employee'}?`)) {
      return;
    }
    setActionPending((p) => ({ ...p, [r.id]: 'approve' }));
    try {
      await api.approveLeave(r.id, '', accessToken);
      push(`Approved leave for ${r.employee?.name || 'employee'}.`, 'success');
      // Optimistic remove from current filter view.
      setRequests((prev) => prev.filter((x) => x.id !== r.id));
    } catch (err) {
      push(err.message || 'Failed to approve leave', 'error');
      fetchRequests();
    } finally {
      setActionPending((p) => {
        const np = { ...p };
        delete np[r.id];
        return np;
      });
    }
  };

  const handleRejectSubmit = async (r) => {
    if (isSelfApproval(r)) {
      push('You cannot reject your own leave request.', 'error');
      return;
    }
    const note = rejectNote.trim();
    if (note.length < 5) {
      push('Rejection note must be at least 5 characters.', 'error');
      return;
    }
    setActionPending((p) => ({ ...p, [r.id]: 'reject' }));
    try {
      await api.rejectLeave(r.id, note, accessToken);
      push(`Rejected leave for ${r.employee?.name || 'employee'}.`, 'success');
      setRejectingId(null);
      setRejectNote('');
      setRequests((prev) => prev.filter((x) => x.id !== r.id));
    } catch (err) {
      push(err.message || 'Failed to reject leave', 'error');
      fetchRequests();
    } finally {
      setActionPending((p) => {
        const np = { ...p };
        delete np[r.id];
        return np;
      });
    }
  };

  const counts = useMemo(() => {
    const c = { PENDING: 0, APPROVED: 0, REJECTED: 0, CANCELLED: 0 };
    for (const r of requests) {
      if (c[r.status] != null) c[r.status] += 1;
    }
    return c;
  }, [requests]);

  if (!employee?.isAdmin) {
    return (
      <div className="leave-page">
        <div className="error-banner">Admin access required.</div>
      </div>
    );
  }

  return (
    <div className="leave-page">
      <div className="leave-page-header">
        <h1 className="leave-page-title">Leave Approvals</h1>
        <p className="leave-page-sub">Review and decide on pending leave requests</p>
      </div>

      {/* Filter pills */}
      <div className="leave-filter-row" role="tablist" aria-label="Filter by status">
        {FILTERS.map((f) => {
          const isActive = filter === f.key;
          const count = f.key === 'ALL'
            ? Object.values(counts).reduce((a, b) => a + b, 0)
            : counts[f.key] || 0;
          return (
            <button
              key={f.key}
              type="button"
              role="tab"
              aria-selected={isActive}
              className={`leave-filter-pill ${isActive ? 'active' : ''}`}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
              {count > 0 && <span className="leave-filter-count">{count}</span>}
            </button>
          );
        })}
      </div>

      {loading && <div className="leave-list-state">Loading...</div>}
      {error && <div className="leave-list-error" role="alert">{error}</div>}

      {!loading && !error && requests.length === 0 && (
        <div className="leave-list-state">
          {filter === 'PENDING' ? 'All caught up — no pending leave requests.' : `No ${filter.toLowerCase()} requests.`}
        </div>
      )}

      {!loading && !error && requests.length > 0 && (
        <ul className="leave-list" aria-label={`${filter} leave requests`}>
          {requests.map((r) => {
            const days = inclusiveDayCount(r.startDate, r.endDate);
            const selfApproval = isSelfApproval(r);
            const isApproving = actionPending[r.id] === 'approve';
            const isRejecting = actionPending[r.id] === 'reject';
            const isRejectingThis = rejectingId === r.id;
            return (
              <li key={r.id} className="leave-list-item">
                <div className="leave-list-main">
                  <div className="leave-list-dates">
                    <strong>{r.employee?.name || 'Unknown'}</strong>
                    {r.employee?.department && (
                      <span className="leave-list-dept"> · {r.employee.department}</span>
                    )}
                    <span className="leave-list-dot"> · </span>
                    {formatDate(r.startDate)} – {formatDate(r.endDate)}
                    <span className="leave-list-days"> ({days} day{days === 1 ? '' : 's'})</span>
                  </div>
                  <div className="leave-list-meta">
                    <span className="leave-list-type">{r.leaveType}</span>
                    <span className="leave-list-dot">·</span>
                    <span className="leave-list-submitted">Submitted {formatDateTime(r.createdAt)}</span>
                  </div>
                  <div className="leave-list-reason">{r.reason}</div>
                  {r.reviewNotes && (
                    <div className="leave-list-review">
                      <strong>Review note:</strong> {r.reviewNotes}
                    </div>
                  )}
                  {selfApproval && (
                    <div className="leave-list-warning">
                      ⚠ This is your own leave — you cannot approve or reject it.
                    </div>
                  )}
                  {isRejectingThis && (
                    <div className="leave-reject-form">
                      <label htmlFor={`reject-${r.id}`}>Rejection note (5-500 chars)</label>
                      <textarea
                        id={`reject-${r.id}`}
                        rows={2}
                        value={rejectNote}
                        maxLength={550}
                        onChange={(e) => setRejectNote(e.target.value)}
                        placeholder="Briefly explain why..."
                      />
                      <div className="leave-reject-actions">
                        <button
                          type="button"
                          className="leave-btn leave-btn-danger"
                          onClick={() => handleRejectSubmit(r)}
                          disabled={isRejecting || rejectNote.trim().length < 5}
                        >
                          {isRejecting ? 'Rejecting...' : 'Confirm Reject'}
                        </button>
                        <button
                          type="button"
                          className="leave-btn leave-btn-ghost"
                          onClick={() => { setRejectingId(null); setRejectNote(''); }}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
                <div className="leave-list-side">
                  <LeaveStatusPill status={r.status} />
                  {r.status === 'PENDING' && !isRejectingThis && (
                    <div className="leave-list-actions">
                      <button
                        type="button"
                        className="leave-btn leave-btn-success"
                        onClick={() => handleApprove(r)}
                        disabled={selfApproval || isApproving || isRejecting}
                        title={selfApproval ? 'You cannot approve your own leave' : 'Approve'}
                      >
                        {isApproving ? '...' : 'Approve'}
                      </button>
                      <button
                        type="button"
                        className="leave-btn leave-btn-danger-outline"
                        onClick={() => { setRejectingId(r.id); setRejectNote(''); }}
                        disabled={selfApproval || isApproving || isRejecting}
                        title={selfApproval ? 'You cannot reject your own leave' : 'Reject'}
                      >
                        Reject
                      </button>
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
