import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { api } from '../../lib/api.js';

const LEAVE_TYPES = ['CASUAL', 'SICK', 'EARNED', 'UNPAID', 'OPTIONAL'];

// Local-date helpers (server is Asia/Kolkata; browser local TZ may differ —
// use the local YYYY-MM-DD the user picked and let the server re-bucket).
const toDateInputValue = (d) => {
  if (!d) return '';
  const dt = new Date(d);
  const yyyy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
};
const todayInputValue = () => toDateInputValue(new Date());
const addDaysInputValue = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return toDateInputValue(d);
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

// Compute inclusive day count between two YYYY-MM-DD strings.
const inclusiveDayCount = (startStr, endStr) => {
  if (!startStr || !endStr) return 0;
  const [sy, sm, sd] = startStr.split('-').map(Number);
  const [ey, em, ed] = endStr.split('-').map(Number);
  const s = new Date(sy, sm - 1, sd).getTime();
  const e = new Date(ey, em - 1, ed).getTime();
  if (Number.isNaN(s) || Number.isNaN(e) || e < s) return 0;
  return Math.round((e - s) / (1000 * 60 * 60 * 24)) + 1;
};

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

export default function Leave() {
  const { accessToken } = useAuth();
  const { push } = useToast();

  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Form state
  const today = todayInputValue();
  const maxFuture = addDaysInputValue(365);
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState(today);
  const [leaveType, setLeaveType] = useState('CASUAL');
  const [reason, setReason] = useState('');
  const [formError, setFormError] = useState('');

  const fetchRequests = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await api.getMyLeaves(accessToken);
      setRequests(data.requests || []);
    } catch (err) {
      setError(err.message || 'Failed to load leave requests');
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    fetchRequests();
  }, [fetchRequests]);

  const dayCount = useMemo(() => inclusiveDayCount(startDate, endDate), [startDate, endDate]);

  // Live form validation — surfaces errors inline so the user fixes them
  // before submit. Server still re-validates (never trust the client).
  const liveError = useMemo(() => {
    if (!startDate || !endDate) return '';
    if (endDate < startDate) return 'End date must be on or after start date.';
    const days = inclusiveDayCount(startDate, endDate);
    if (days > 90) return `Leave duration (${days} days) exceeds the 90-day maximum.`;
    if (reason.trim().length === 0) return 'Reason is required.';
    if (reason.trim().length < 5) return 'Reason must be at least 5 characters.';
    if (reason.trim().length > 1000) return 'Reason must be at most 1000 characters.';
    return '';
  }, [startDate, endDate, reason]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (liveError) {
      setFormError(liveError);
      return;
    }
    setSubmitting(true);
    setFormError('');
    try {
      await api.createLeave(
        { startDate, endDate, leaveType, reason: reason.trim() },
        accessToken
      );
      push('Leave request submitted for review.', 'success');
      setStartDate(today);
      setEndDate(today);
      setLeaveType('CASUAL');
      setReason('');
      fetchRequests();
    } catch (err) {
      const msg = err.message || 'Failed to submit leave request';
      setFormError(msg);
      push(msg, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = async (id) => {
    if (!window.confirm('Cancel this leave request?')) return;
    try {
      await api.cancelLeave(id, accessToken);
      push('Leave request cancelled.', 'success');
      fetchRequests();
    } catch (err) {
      push(err.message || 'Failed to cancel leave request', 'error');
    }
  };

  return (
    <div className="leave-page">
      <div className="leave-page-header">
        <h1 className="leave-page-title">My Leave</h1>
        <p className="leave-page-sub">Submit a leave request and track its status</p>
      </div>

      {/* Submit form */}
      <div className="leave-form-card">
        <h2 className="leave-section-title">Request Leave</h2>
        <form onSubmit={handleSubmit} className="leave-form" noValidate>
          <div className="leave-form-row">
            <div className="leave-field">
              <label htmlFor="leave-start">Start date</label>
              <input
                id="leave-start"
                type="date"
                value={startDate}
                min={today}
                max={maxFuture}
                onChange={(e) => setStartDate(e.target.value)}
                required
                aria-invalid={liveError && endDate < startDate ? 'true' : 'false'}
              />
            </div>
            <div className="leave-field">
              <label htmlFor="leave-end">End date</label>
              <input
                id="leave-end"
                type="date"
                value={endDate}
                min={startDate || today}
                max={maxFuture}
                onChange={(e) => setEndDate(e.target.value)}
                required
              />
            </div>
            <div className="leave-field">
              <label htmlFor="leave-type">Leave type</label>
              <select
                id="leave-type"
                value={leaveType}
                onChange={(e) => setLeaveType(e.target.value)}
              >
                {LEAVE_TYPES.map((t) => (
                  <option key={t} value={t}>{t.charAt(0) + t.slice(1).toLowerCase()}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="leave-field">
            <label htmlFor="leave-reason">
              Reason
              <span className={`leave-reason-counter ${reason.length > 1000 ? 'over-limit' : ''}`}>
                {reason.length}/1000
              </span>
            </label>
            <textarea
              id="leave-reason"
              rows={3}
              value={reason}
              maxLength={1100}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Briefly describe the reason for leave (5-1000 chars)"
              aria-describedby="leave-reason-help"
            />
            <span id="leave-reason-help" className="leave-field-hint">
              {dayCount > 0 ? `${dayCount} day${dayCount === 1 ? '' : 's'} selected.` : 'Select a date range.'}
            </span>
          </div>

          {formError && (
            <div className="leave-form-error" role="alert">{formError}</div>
          )}

          <div className="leave-form-actions">
            <button
              type="submit"
              className="leave-btn leave-btn-primary"
              disabled={submitting || !!liveError || !reason.trim()}
            >
              {submitting ? 'Submitting...' : 'Submit Request'}
            </button>
          </div>
        </form>
      </div>

      {/* My requests */}
      <div className="leave-list-card">
        <h2 className="leave-section-title">My Requests</h2>
        {loading && <div className="leave-list-state">Loading...</div>}
        {error && <div className="leave-list-error" role="alert">{error}</div>}
        {!loading && !error && requests.length === 0 && (
          <div className="leave-list-state">
            No leave requests yet. Submit one above.
          </div>
        )}
        {!loading && !error && requests.length > 0 && (
          <ul className="leave-list" aria-label="My leave requests">
            {requests.map((r) => (
              <li key={r.id} className="leave-list-item">
                <div className="leave-list-main">
                  <div className="leave-list-dates">
                    {formatDate(r.startDate)} – {formatDate(r.endDate)}
                    <span className="leave-list-days">({inclusiveDayCount(r.startDate, r.endDate)} day{inclusiveDayCount(r.startDate, r.endDate) === 1 ? '' : 's'})</span>
                  </div>
                  <div className="leave-list-meta">
                    <span className="leave-list-type">{r.leaveType}</span>
                    <span className="leave-list-dot">·</span>
                    <span className="leave-list-submitted">Submitted {formatDateTime(r.createdAt)}</span>
                  </div>
                  {r.reason && <div className="leave-list-reason">{r.reason}</div>}
                  {r.reviewNotes && (
                    <div className="leave-list-review">
                      <strong>Review note:</strong> {r.reviewNotes}
                    </div>
                  )}
                </div>
                <div className="leave-list-side">
                  <LeaveStatusPill status={r.status} />
                  {r.status === 'PENDING' && (
                    <button
                      type="button"
                      className="leave-btn leave-btn-ghost"
                      onClick={() => handleCancel(r.id)}
                      aria-label={`Cancel leave request for ${formatDate(r.startDate)}`}
                    >
                      Cancel
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
