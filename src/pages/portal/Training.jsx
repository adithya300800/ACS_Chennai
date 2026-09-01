import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { api } from '../../lib/api.js';
import { TRAINING_PROVIDER_LABELS, TRAINING_STATUSES, TRACKABLE_PROVIDERS } from '../../lib/constants.js';

// "My Learning" hub for the employee. Mirrors the Leave page's
// structure (state, fetch + error/loading/empty triple, pill pattern)
// but is read-only — assignments come from admin; this page just lists
// them with a status filter.

const STATUS_LABELS = {
  ASSIGNED: 'Assigned',
  IN_PROGRESS: 'In Progress',
  COMPLETED: 'Completed',
};

// Filter tabs at the top. "Overdue" is a derived view (assigned/in-progress
// with a past dueDate) — we don't add a column, just compute on the client
// so the user can surface what needs attention.
const FILTERS = [
  { key: 'ALL', label: 'All' },
  { key: 'ASSIGNED', label: 'Assigned' },
  { key: 'IN_PROGRESS', label: 'In Progress' },
  { key: 'COMPLETED', label: 'Completed' },
  { key: 'OVERDUE', label: 'Overdue' },
];

const formatDueDate = (dateStr) => {
  if (!dateStr) return '';
  const [y, m, d] = String(dateStr).split('T')[0].split('-').map(Number);
  if (!y || !m || !d) return dateStr;
  return new Date(y, m - 1, d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
};

const isOverdue = (enrollment) => {
  if (!enrollment?.dueDate) return false;
  if (enrollment.status === TRAINING_STATUSES.COMPLETED) return false;
  const due = String(enrollment.dueDate).split('T')[0];
  const today = new Date().toISOString().split('T')[0];
  return due < today;
};

const TrainingStatusPill = ({ status }) => {
  const cls = `training-pill training-pill-${(status || 'ASSIGNED').toLowerCase()}`;
  return (
    <span className={cls} aria-label={`Status: ${STATUS_LABELS[status] || status}`}>
      {STATUS_LABELS[status] || status}
    </span>
  );
};

export default function Training() {
  const { accessToken } = useAuth();
  const { push } = useToast();

  const [enrollments, setEnrollments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('ALL');

  const fetchEnrollments = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await api.getMyTraining({}, accessToken);
      setEnrollments(data.enrollments || []);
    } catch (err) {
      setError(err.message || 'Failed to load training');
      push(err.message || 'Failed to load training', 'error');
    } finally {
      setLoading(false);
    }
  }, [accessToken, push]);

  useEffect(() => {
    fetchEnrollments();
  }, [fetchEnrollments]);

  // Tab counts shown in the filter header. Drives the "5 overdue" callout.
  const counts = useMemo(() => {
    const c = { ALL: enrollments.length, ASSIGNED: 0, IN_PROGRESS: 0, COMPLETED: 0, OVERDUE: 0 };
    enrollments.forEach((e) => {
      if (c[e.status] != null) c[e.status] += 1;
      if (isOverdue(e)) c.OVERDUE += 1;
    });
    return c;
  }, [enrollments]);

  const visible = useMemo(() => {
    if (filter === 'ALL') return enrollments;
    if (filter === 'OVERDUE') return enrollments.filter(isOverdue);
    return enrollments.filter((e) => e.status === filter);
  }, [enrollments, filter]);

  return (
    <div className="training-page">
      <div className="training-page-header">
        <div>
          <h1 className="training-page-title">My Learning</h1>
          <p className="training-page-sub">Watch assigned courses and track your progress</p>
        </div>
      </div>

      {/* Stats strip — three KPIs. Mirrors the Leave dashboard pattern. */}
      <div className="training-stats" aria-label="Training summary">
        <div className="training-stat">
          <div className="training-stat-num">{counts.IN_PROGRESS}</div>
          <div className="training-stat-label">In progress</div>
        </div>
        <div className="training-stat">
          <div className="training-stat-num">{counts.COMPLETED}</div>
          <div className="training-stat-label">Completed</div>
        </div>
        <div className={`training-stat ${counts.OVERDUE > 0 ? 'training-stat-warn' : ''}`}>
          <div className="training-stat-num">{counts.OVERDUE}</div>
          <div className="training-stat-label">Overdue</div>
        </div>
      </div>

      {/* Filter tabs — role=tablist so screen readers announce them as a group. */}
      <div className="training-tabs" role="tablist" aria-label="Filter training by status">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            role="tab"
            aria-selected={filter === f.key}
            className={`training-tab ${filter === f.key ? 'active' : ''}`}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
            {counts[f.key] != null && <span className="training-tab-count">{counts[f.key]}</span>}
          </button>
        ))}
      </div>

      {/* List */}
      <div className="training-list-card">
        {loading && <div className="training-list-state">Loading…</div>}
        {error && <div className="training-list-error" role="alert">{error}</div>}
        {!loading && !error && visible.length === 0 && (
          <div className="training-list-state">
            {filter === 'ALL'
              ? 'No trainings assigned yet. Check back later.'
              : `No trainings match this filter.`}
          </div>
        )}
        {!loading && !error && visible.length > 0 && (
          <ul className="training-list" aria-label="My training enrollments">
            {visible.map((e) => (
              <li key={e.id} className="training-card">
                <div className="training-card-main">
                  <div className="training-card-title-row">
                    <h3 className="training-card-title">{e.course?.title || 'Untitled course'}</h3>
                    <TrainingStatusPill status={e.status} />
                  </div>
                  <div className="training-card-meta">
                    <span className="training-card-provider">
                      {TRAINING_PROVIDER_LABELS[e.course?.provider] || 'External'}
                    </span>
                    {e.course?.category && (
                      <>
                        <span className="training-card-dot">·</span>
                        <span className="training-card-cat">{e.course.category}</span>
                      </>
                    )}
                    {e.dueDate && (
                      <>
                        <span className="training-card-dot">·</span>
                        <span className={`training-card-due ${isOverdue(e) ? 'training-card-due-overdue' : ''}`}>
                          {isOverdue(e) ? 'Overdue · ' : 'Due '}{formatDueDate(e.dueDate)}
                        </span>
                      </>
                    )}
                    {e.priority && e.priority !== 'NORMAL' && (
                      <>
                        <span className="training-card-dot">·</span>
                        <span className={`training-card-priority training-card-priority-${e.priority.toLowerCase()}`}>
                          {e.priority}
                        </span>
                      </>
                    )}
                  </div>
                  {/* Progress bar — only when progress > 0 OR status is IN_PROGRESS/COMPLETED.
                      We deliberately don't show 0% bars (visual noise for "haven't started"). */}
                  {(e.progressPct > 0 || e.status !== TRAINING_STATUSES.ASSIGNED) && (
                    <div className="training-progress" aria-label={`Progress: ${e.progressPct}%`}>
                      <div className="training-progress-bar" style={{ width: `${Math.min(100, Math.max(0, e.progressPct))}%` }} />
                      <span className="training-progress-label">{e.progressPct}% watched</span>
                    </div>
                  )}
                </div>
                <div className="training-card-side">
                  <Link
                    to={`/portal/training/${e.id}`}
                    className="training-btn training-btn-primary"
                    aria-label={`${e.status === 'COMPLETED' ? 'Review' : 'Continue'} ${e.course?.title || 'course'}`}
                  >
                    {e.status === 'COMPLETED' ? 'Review' : e.status === 'ASSIGNED' ? 'Start' : 'Continue'}
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <line x1="5" y1="12" x2="19" y2="12" />
                      <polyline points="12 5 19 12 12 19" />
                    </svg>
                  </Link>
                  {!TRACKABLE_PROVIDERS.has(e.course?.provider) && (
                    <a
                      className="training-btn training-btn-ghost"
                      href={e.course?.externalUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`Open ${e.course?.title || 'course'} in new tab`}
                    >
                      Open course
                    </a>
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
