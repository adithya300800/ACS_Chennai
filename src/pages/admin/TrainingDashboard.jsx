import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { api } from '../../lib/api.js';
import {
  TRAINING_PROVIDER_LABELS,
  TRAINING_STATUSES,
  isTrainingTerminal,
} from '../../lib/constants.js';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';
import { getBusinessToday, useBusinessDateKey } from '../../lib/businessDate.js';

/**
 * Admin training dashboard. Two sections stacked vertically:
 *   1. Course library — list of all training courses (admin creates
 *      a course via TrainingCourseNew, this view shows + lets admin
 *      edit/archive).
 *   2. Enrollment queue — every assignment, filterable by status /
 *      employee / course. Admin can override-complete any row that
 *      didn't auto-complete (e.g. non-trackable provider).
 *
 * Stats tiles at the top mirror the employee hub's strip so the admin
 * gets a single-glance snapshot of the program health.
 */

const STATUS_LABEL = {
  ASSIGNED: 'Assigned',
  IN_PROGRESS: 'In Progress',
  SELF_ATTESTED_COMPLETED: 'Completed',
  PLAYER_OBSERVED_COMPLETED: 'Completed',
  PROVIDER_VERIFIED_COMPLETED: 'Completed',
  ADMIN_OVERRIDE_COMPLETED: 'Completed',
  OVERDUE: 'Overdue',
  CANCELLED: 'Cancelled',
};

// Round-20 (DR-010): each completion carries one of four evidence classes.
// Show a small badge next to the status pill so admins can tell at a glance
// whether the row came from a watched-to-end player, a self-attest click,
// an admin override, or (future) a provider webhook. The full evidence
// taxonomy lives in backend/src/lib/trainingRules.js EVIDENCE_CLASSES.
const EVIDENCE_LABEL = {
  SELF_ATTESTED: 'Self-attested',
  PLAYER_OBSERVED: 'Player-observed',
  PROVIDER_VERIFIED: 'Provider-verified',
  ADMIN_OVERRIDE: 'Admin override',
};

const COMPLETED_STATUSES = new Set([
  'SELF_ATTESTED_COMPLETED',
  'PLAYER_OBSERVED_COMPLETED',
  'PROVIDER_VERIFIED_COMPLETED',
  'ADMIN_OVERRIDE_COMPLETED',
]);

const FILTERS = [
  { key: 'ALL', label: 'All' },
  { key: 'ASSIGNED', label: 'Assigned' },
  { key: 'IN_PROGRESS', label: 'In Progress' },
  { key: 'COMPLETED', label: 'Completed' },
  { key: 'OVERDUE', label: 'Overdue' },
];

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

const isOverdue = (e) => {
  if (!e?.dueDate) return false;
  if (isTrainingTerminal(e.status)) return false;
  const due = String(e.dueDate).split('T')[0];
  const today = getBusinessToday();
  return due < today;
};

const StatusPill = ({ status }) => {
  // Round-20 (DR-010): all four completed-states collapse to one pill label
  // ("Completed") so the queue reads cleanly. The distinguishing info moves
  // to the EvidenceBadge below — see EVIDENCE_LABEL for the four classes.
  const cssStatus = COMPLETED_STATUSES.has(status) ? 'COMPLETED' : status;
  return (
    <span className={`training-pill training-pill-${(cssStatus || 'ASSIGNED').toLowerCase()}`} aria-label={`Status: ${STATUS_LABEL[status] || status}`}>
      {STATUS_LABEL[status] || status}
    </span>
  );
};

// Round-20 (DR-010): badge that surfaces how the row was completed.
// Renders only when the enrollment has a meaningful evidenceClass — i.e.
// for the four completed-states. ARIA label ties the visual badge back to
// the evidence class name so a screen-reader user gets the same info.
const EvidenceBadge = ({ evidenceClass }) => {
  if (!evidenceClass) return null;
  const label = EVIDENCE_LABEL[evidenceClass] || evidenceClass;
  return (
    <span
      className={`training-pill training-pill-evidence training-pill-evidence-${evidenceClass.toLowerCase()}`}
      aria-label={`Evidence: ${label}`}
      title={`Completion evidence: ${label}`}
    >
      {label}
    </span>
  );
};

export default function TrainingDashboard() {
  useDocumentTitle('Training Library');
  const { employee, accessToken } = useAuth();
  const { push } = useToast();
  const navigate = useNavigate();
  // Round-24: courseFilter can arrive via ?courseFilter=<id> from the
  // detail page's "View all in enrollment queue" link. We honor it on
  // mount so the dashboard opens pre-scoped to the right course.
  const [searchParams] = useSearchParams();
  // DR-026: refresh "today" on midnight + tab focus so memoized counts/filters
  // re-evaluate when the business date rolls over (or the user comes back
  // after leaving the tab open overnight).
  const businessDateKey = useBusinessDateKey();

  // Guard — admin only. Mirrors Admin.jsx:91-94 pattern.
  useEffect(() => {
    if (employee && !employee.isAdmin) navigate('/portal/attendance');
  }, [employee, navigate]);

  const [courses, setCourses] = useState([]);
  const [enrollments, setEnrollments] = useState([]);
  const [loadingCourses, setLoadingCourses] = useState(true);
  const [loadingEnrollments, setLoadingEnrollments] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('ALL');
  // Round-24: seed courseFilter from ?courseFilter=<id> so the detail
  // page's "View all in enrollment queue" link opens pre-scoped. Done
  // via lazy initializer so it only fires once.
  const [courseFilter, setCourseFilter] = useState(() => {
    const fromUrl = searchParams.get('courseFilter');
    return fromUrl && fromUrl.length > 0 ? fromUrl : 'ALL';
  });
  const [actionPending, setActionPending] = useState({}); // { [enrollmentId]: 'override' }

  const fetchCourses = useCallback(async () => {
    setLoadingCourses(true);
    try {
      const data = await api.getTrainingCourses({}, accessToken);
      setCourses(data.courses || []);
    } catch (err) {
      setError(err.message || 'Failed to load courses');
    } finally {
      setLoadingCourses(false);
    }
  }, [accessToken]);

  const fetchEnrollments = useCallback(async () => {
    setLoadingEnrollments(true);
    setError('');
    try {
      const params = {};
      if (filter !== 'ALL' && filter !== 'OVERDUE') params.status = filter;
      if (courseFilter !== 'ALL') params.courseId = courseFilter;
      const data = await api.getAllTrainingEnrollments(params, accessToken);
      setEnrollments(data.enrollments || []);
    } catch (err) {
      setError(err.message || 'Failed to load enrollments');
    } finally {
      setLoadingEnrollments(false);
    }
  }, [filter, courseFilter, accessToken]);

  useEffect(() => {
    if (!employee?.isAdmin) return;
    fetchCourses();
  }, [employee?.isAdmin, fetchCourses]);

  useEffect(() => {
    if (!employee?.isAdmin) return;
    fetchEnrollments();
  }, [employee?.isAdmin, fetchEnrollments]);

  // Overdue derived view — client-side filter so the admin can see what
  // needs attention at a glance.
  const visibleEnrollments = useMemo(() => {
    if (filter !== 'OVERDUE') return enrollments;
    return enrollments.filter(isOverdue);
  }, [enrollments, filter, businessDateKey]);

  const counts = useMemo(() => {
    const c = { ALL: enrollments.length, ASSIGNED: 0, IN_PROGRESS: 0, COMPLETED: 0, OVERDUE: 0 };
    enrollments.forEach((e) => {
      if (c[e.status] != null) c[e.status] += 1;
      if (isOverdue(e)) c.OVERDUE += 1;
    });
    return c;
  }, [enrollments, businessDateKey]);

  const courseCounts = useMemo(() => {
    const m = {};
    courses.forEach((c) => { m[c.id] = 0; });
    enrollments.forEach((e) => { if (m[e.courseId] != null) m[e.courseId] += 1; });
    return m;
  }, [courses, enrollments]);

  // Admin override-complete: marks the enrollment COMPLETED on behalf of the
  // employee. Useful when the auto-capture missed (browser killed mid-play)
  // or for non-trackable providers where the employee forgot to click.
  const handleOverrideComplete = useCallback(async (enrollment) => {
    if (!enrollment) return;
    if (!window.confirm(`Mark ${enrollment.employee?.name || 'this employee'}'s enrollment as complete?`)) return;
    setActionPending((p) => ({ ...p, [enrollment.id]: 'override' }));
    try {
      await api.markTrainingComplete(enrollment.id, 'Admin override', accessToken);
      push('Marked complete.', 'success');
      // Optimistic update — remove from current view if it's filter-bound
      // to ASSIGNED/IN_PROGRESS.
      setEnrollments((prev) => prev.map((e) => e.id === enrollment.id ? { ...e, status: 'COMPLETED', progressPct: 100 } : e));
    } catch (err) {
      push(err?.message || 'Failed to mark complete', 'error');
    } finally {
      setActionPending((p) => { const next = { ...p }; delete next[enrollment.id]; return next; });
    }
  }, [accessToken, push]);

  return (
    <div className="training-page training-admin-page">
      <div className="training-page-header">
        <div>
          <h1 className="training-page-title">Training Library</h1>
          <p className="training-page-sub">Manage courses and track employee enrollments</p>
        </div>
        <Link to="/portal/admin/training/new" className="training-btn training-btn-primary">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          New course
        </Link>
      </div>

      {/* KPI tiles */}
      <div className="training-stats training-stats-admin" aria-label="Training program summary">
        <div className="training-stat">
          <div className="training-stat-num">{courses.length}</div>
          <div className="training-stat-label">Courses</div>
        </div>
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

      {/* ── Course library ─────────────────────────────────────────── */}
      <section className="training-section">
        <h2 className="training-section-title">Course library</h2>
        {loadingCourses && <div className="training-list-state">Loading…</div>}
        {!loadingCourses && courses.length === 0 && (
          <div className="training-list-state">
            No courses yet. <Link to="/portal/admin/training/new">Create your first course</Link>.
          </div>
        )}
        {!loadingCourses && courses.length > 0 && (
          <ul className="training-list training-list-courses">
            {courses.map((c) => (
              <li key={c.id} className="training-card training-card-course">
                {/* Round-24: card body is now a Link to the new detail page.
                    Side actions stay as buttons so they don't navigate when
                    clicked (their handlers are different from "open detail"). */}
                <Link
                  to={`/portal/admin/training/${c.id}`}
                  className="training-card-main"
                  style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}
                  aria-label={`Open ${c.title}`}
                >
                  <div className="training-card-title-row">
                    <h3 className="training-card-title">{c.title}</h3>
                    {c.isArchived && <span className="training-pill training-pill-archived">Archived</span>}
                  </div>
                  <div className="training-card-meta">
                    <span>{TRAINING_PROVIDER_LABELS[c.provider] || 'External'}</span>
                    {c.category && (
                      <>
                        <span className="training-card-dot">·</span>
                        <span>{c.category}</span>
                      </>
                    )}
                    <span className="training-card-dot">·</span>
                    <span>{courseCounts[c.id] || 0} assigned</span>
                    <span className="training-card-dot">·</span>
                    <span>Created {formatDate(c.createdAt)}</span>
                  </div>
                  {c.description && <div className="training-card-desc">{c.description}</div>}
                </Link>
                <div className="training-card-side training-card-actions">
                  <button
                    type="button"
                    className="training-btn training-btn-ghost"
                    onClick={() => setCourseFilter(c.id)}
                    aria-label={`Filter enrollments to ${c.title}`}
                  >
                    View enrollments
                  </button>
                  {/* Round-24: reassign deep-links with ?reassign=1 so the
                      detail page auto-opens its modal. Useful when the admin
                      wants to add more people without scrolling to find the
                      button. */}
                  <Link
                    to={`/portal/admin/training/${c.id}?reassign=1`}
                    className="training-btn training-btn-ghost"
                    aria-label={`Reassign ${c.title}`}
                  >
                    Reassign
                  </Link>
                  <Link
                    to={`/portal/admin/training/${c.id}/edit`}
                    className="training-btn training-btn-ghost"
                    aria-label={`Edit ${c.title}`}
                  >
                    Edit
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── Enrollment queue ───────────────────────────────────────── */}
      <section className="training-section">
        <h2 className="training-section-title">Enrollment queue</h2>

        <div className="training-tabs" role="tablist" aria-label="Filter enrollments by status">
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

        {courseFilter !== 'ALL' && (
          <div className="training-active-filter">
            Filtered to one course.{' '}
            <button type="button" className="training-link-btn" onClick={() => setCourseFilter('ALL')}>
              Clear
            </button>
          </div>
        )}

        {loadingEnrollments && <div className="training-list-state">Loading…</div>}
        {error && <div className="training-list-error" role="alert">{error}</div>}
        {!loadingEnrollments && !error && visibleEnrollments.length === 0 && (
          <div className="training-list-state">No enrollments match this filter.</div>
        )}
        {!loadingEnrollments && !error && visibleEnrollments.length > 0 && (
          <ul className="training-list training-list-enrollments">
            {visibleEnrollments.map((e) => (
              <li key={e.id} className="training-card training-card-enrollment">
                <div className="training-card-main">
                  <div className="training-card-title-row">
                    <h3 className="training-card-title">{e.employee?.name || 'Unknown employee'}</h3>
                    <StatusPill status={e.status} />
                    {/* Round-20 (DR-010): show the evidence class for completed rows
                        so admins can tell at a glance whether the row was
                        self-attested, player-observed, provider-verified, or
                        admin-overridden. Renders nothing for in-progress /
                        overdue / cancelled rows. */}
                    {COMPLETED_STATUSES.has(e.status) && (
                      <EvidenceBadge evidenceClass={e.evidenceClass} />
                    )}
                  </div>
                  <div className="training-card-meta">
                    <span className="training-card-employee-email">{e.employee?.email}</span>
                    {e.employee?.department && (
                      <>
                        <span className="training-card-dot">·</span>
                        <span>{e.employee.department}</span>
                      </>
                    )}
                    <span className="training-card-dot">·</span>
                    <span>{e.course?.title || '—'}</span>
                  </div>
                  <div className="training-card-meta training-card-meta-row-2">
                    <span>Assigned {formatDateTime(e.assignedAt)}</span>
                    {e.dueDate && (
                      <>
                        <span className="training-card-dot">·</span>
                        <span className={isOverdue(e) ? 'training-card-due-overdue' : ''}>
                          Due {formatDate(e.dueDate)}
                          {isOverdue(e) && ' (overdue)'}
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
                    {e.completedAt && (
                      <>
                        <span className="training-card-dot">·</span>
                        <span>Completed {formatDateTime(e.completedAt)}</span>
                      </>
                    )}
                  </div>
                  {e.progressPct > 0 && (
                    <div className="training-progress" aria-label={`Progress: ${e.progressPct}%`}>
                      <div className="training-progress-bar" style={{ width: `${Math.min(100, Math.max(0, e.progressPct))}%` }} />
                      <span className="training-progress-label">{e.progressPct}%</span>
                    </div>
                  )}
                </div>
                <div className="training-card-side">
                  {e.status !== 'COMPLETED' && (
                    <button
                      type="button"
                      className="training-btn training-btn-ghost"
                      onClick={() => handleOverrideComplete(e)}
                      disabled={!!actionPending[e.id]}
                      aria-label={`Mark ${e.employee?.name || 'employee'} complete`}
                    >
                      {actionPending[e.id] === 'override' ? 'Saving…' : 'Mark complete'}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
