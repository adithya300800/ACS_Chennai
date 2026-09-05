import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { api } from '../../lib/api.js';
import {
  TRAINING_PROVIDER_LABELS,
  TRAINING_STATUSES,
  TRAINING_PRIORITIES,
} from '../../lib/constants.js';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';
import { getBusinessToday, useBusinessDateKey } from '../../lib/businessDate.js';
import { formatShortDate, formatDateTime } from '../../lib/format.js';
import Breadcrumb from '../../components/Breadcrumb.jsx';
import BackButton from '../../components/BackButton.jsx';

// Round-24: admin course detail page. The dashboard used to be the only way
// to see a course — a one-line card with title + provider + category. This
// page is the "viewable for future reference" half of the round: read-only
// metadata + per-course enrollment stats + recent enrollments + Edit /
// Reassign / Archive actions. Reassign is an inline modal (no shared <Modal>
// component exists in this repo — mirrors the hand-rolled pattern from
// DprDashboard.jsx:690–764).

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

const RECENT_ENROLLMENTS_LIMIT = 10;
const MAX_EMPLOYEE_IDS_PER_BULK = 500;

const isOverdue = (e) => {
  if (!e?.dueDate) return false;
  if (COMPLETED_STATUSES.has(e.status)) return false;
  const due = String(e.dueDate).split('T')[0];
  const today = getBusinessToday();
  return due < today;
};

const StatusPill = ({ status }) => {
  const cssStatus = COMPLETED_STATUSES.has(status) ? 'COMPLETED' : status;
  return (
    <span className={`training-pill training-pill-${(cssStatus || 'ASSIGNED').toLowerCase()}`} aria-label={`Status: ${STATUS_LABEL[status] || status}`}>
      {STATUS_LABEL[status] || status}
    </span>
  );
};

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

const todayInputValue = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const addDaysInputValue = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export default function TrainingCourseDetail() {
  useDocumentTitle('Course Detail');
  const { id } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { employee, accessToken } = useAuth();
  const { push } = useToast();
  const businessDateKey = useBusinessDateKey();

  // Admin-only guard. Mirrors TrainingDashboard.jsx:126 — non-admins get
  // bounced to /portal/attendance on mount.
  useEffect(() => {
    if (employee && !employee.isAdmin) navigate('/portal/attendance');
  }, [employee, navigate]);

  const [course, setCourse] = useState(null);
  const [enrollments, setEnrollments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionPending, setActionPending] = useState(false);
  // Per-row cancel-in-flight map keyed by enrollmentId — needed because
  // multiple rows can show a Cancel button at once and each row needs its
  // own disabled state (vs actionPending which is a single boolean for
  // the page-level Archive/Reassign toggles).
  const [cancelPending, setCancelPending] = useState({});
  const [showReassignModal, setShowReassignModal] = useState(false);

  // Auto-open the reassign modal when arriving via `?reassign=1`. Lets the
  // dashboard's Reassign button be a deep-link rather than a separate UX.
  useEffect(() => {
    if (searchParams.get('reassign') === '1') setShowReassignModal(true);
  }, [searchParams]);

  const fetchCourse = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await api.getTrainingCourse(id, accessToken);
      setCourse(data);
    } catch (err) {
      setError(err.message || 'Failed to load course');
    } finally {
      setLoading(false);
    }
  }, [id, accessToken]);

  const fetchEnrollments = useCallback(async () => {
    try {
      const data = await api.getAllTrainingEnrollments({ courseId: id }, accessToken);
      setEnrollments(data.enrollments || []);
    } catch (err) {
      // Don't blow up the page if enrollment fetch fails — course card still
      // renders. Stats will show 0/0/0/0.
      console.error('[training/course-detail] enrollments fetch failed', err?.message);
    }
  }, [id, accessToken]);

  useEffect(() => {
    if (!employee?.isAdmin) return;
    fetchCourse();
    fetchEnrollments();
  }, [employee?.isAdmin, fetchCourse, fetchEnrollments]);

  // Bucketed stats — mirrors the dashboard's `counts` memo so behavior matches.
  const counts = useMemo(() => {
    const c = { ENROLLED: enrollments.length, COMPLETED: 0, IN_PROGRESS: 0, OVERDUE: 0 };
    enrollments.forEach((e) => {
      if (COMPLETED_STATUSES.has(e.status)) c.COMPLETED += 1;
      else if (e.status === 'IN_PROGRESS') c.IN_PROGRESS += 1;
      if (isOverdue(e)) c.OVERDUE += 1;
    });
    return c;
  }, [enrollments, businessDateKey]);

  const recentEnrollments = useMemo(
    () => enrollments.slice(0, RECENT_ENROLLMENTS_LIMIT),
    [enrollments]
  );

  // ── Action handlers ────────────────────────────────────────────────────

  const handleArchiveToggle = useCallback(async () => {
    if (!course) return;
    const nextArchived = !course.isArchived;
    const verb = nextArchived ? 'Archive' : 'Unarchive';
    if (!window.confirm(`${verb} "${course.title}"? ${nextArchived ? 'New assignments will be blocked until you unarchive.' : ''}`)) return;
    setActionPending(true);
    try {
      const updated = await api.updateTrainingCourse(course.id, { isArchived: nextArchived }, accessToken);
      setCourse(updated);
      push(`${verb}d.`, 'success');
    } catch (err) {
      push(err?.message || `Failed to ${verb.toLowerCase()}`, 'error');
    } finally {
      setActionPending(false);
    }
  }, [course, accessToken, push]);

  const handleReassignSuccess = useCallback(async (result) => {
    const created = (result?.created || []).length;
    const skipped = (result?.skipped || []).length;
    const invalid = (result?.invalidIds || []).length;
    let msg = `Assigned to ${created} employee${created === 1 ? '' : 's'}.`;
    if (skipped > 0) msg += ` ${skipped} already had it.`;
    if (invalid > 0) msg += ` ${invalid} id${invalid === 1 ? ' was' : 's were'} not recognised.`;
    push(msg, 'success');
    setShowReassignModal(false);
    await fetchEnrollments();
  }, [push, fetchEnrollments]);

  // Soft-cancel (unassign) an active enrollment. Backend refuses if the
  // row is already CANCELLED or in a *_COMPLETED state, so the button is
  // also hidden in those cases below. The optional reason is collected
  // via window.prompt — same UX as Round-13's DPR bulk cancel — and is
  // stored in employeeNote (existing column).
  const handleCancelEnrollment = useCallback(async (enrollment) => {
    if (!enrollment) return;
    const name = enrollment.employee?.name || 'this employee';
    if (!window.confirm(`Unassign ${name} from "${course?.title || 'this course'}"? The row stays for audit (status=Cancelled).`)) return;
    // window.prompt returns the typed string OR null if cancelled. Empty
    // string also treated as "no reason" — toast + backend both cope.
    const rawReason = window.prompt(`Why? (optional, stored as a note)`, '');
    const reason = rawReason == null ? null : rawReason.trim() || null;
    setCancelPending((p) => ({ ...p, [enrollment.id]: true }));
    try {
      await api.cancelTrainingEnrollment(enrollment.id, reason, accessToken);
      push(`Unassigned ${name}.`, 'success');
      await fetchEnrollments();
    } catch (err) {
      push(err?.message || 'Failed to unassign', 'error');
    } finally {
      setCancelPending((p) => { const next = { ...p }; delete next[enrollment.id]; return next; });
    }
  }, [course, accessToken, push, fetchEnrollments]);

  if (loading) {
    return (
      <div className="training-page">
        <div className="training-list-state">Loading course…</div>
      </div>
    );
  }

  if (error || !course) {
    return (
      <div className="training-page">
        <div className="training-card" style={{ textAlign: 'center', padding: '3rem' }}>
          <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>⚠️</div>
          <h2 style={{ color: 'var(--navy)', marginBottom: '0.5rem' }}>{error || 'Course not found'}</h2>
          <BackButton to="/portal/admin/training" label="Training Library" className="btn btn-secondary btn-sm" style={{ marginTop: '1rem' }} />
        </div>
      </div>
    );
  }

  const isArchived = Boolean(course.isArchived);

  return (
    <div className="training-page training-admin-page">
      {/* Round-24: first admin page to use Breadcrumb. Matches the portal
          TrainingDetail.jsx convention (Training Library › {course}). */}
      <Breadcrumb
        items={[
          { label: 'Training Library', to: '/portal/admin/training' },
          { label: course.title },
        ]}
      />

      <div className="training-page-header">
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            <h1 className="training-page-title">{course.title}</h1>
            {isArchived && <span className="training-pill training-pill-archived">Archived</span>}
          </div>
          <p className="training-page-sub">
            {TRAINING_PROVIDER_LABELS[course.provider] || 'External'}
            {course.category ? ` · ${course.category}` : ''}
            {' · '}
            Created {formatShortDate(course.createdAt)}
            {course.createdBy?.name ? ` by ${course.createdBy.name}` : ''}
          </p>
        </div>
        <Link to="/portal/admin/training" className="training-btn training-btn-ghost">
          ← Back
        </Link>
      </div>

      {/* Action bar */}
      <div className="training-card-actions" role="toolbar" aria-label="Course actions">
        <Link to={`/portal/admin/training/${course.id}/edit`} className="training-btn training-btn-secondary">
          Edit
        </Link>
        <button
          type="button"
          className="training-btn training-btn-secondary"
          onClick={() => setShowReassignModal(true)}
          disabled={isArchived}
          title={isArchived ? 'Unarchive this course before reassigning' : 'Assign this course to more employees'}
          aria-label={isArchived ? 'Reassign (course is archived)' : 'Reassign course to additional employees'}
        >
          Reassign
        </button>
        <button
          type="button"
          className={`training-btn ${isArchived ? 'training-btn-secondary' : 'training-btn-ghost'}`}
          onClick={handleArchiveToggle}
          disabled={actionPending}
          aria-label={isArchived ? 'Unarchive course' : 'Archive course'}
        >
          {actionPending ? 'Saving…' : isArchived ? 'Unarchive' : 'Archive'}
        </button>
      </div>

      {/* Stats tiles — mirror dashboard's training-stats so visuals match. */}
      <div className="training-stats training-stats-admin" aria-label="Enrollment stats for this course">
        <div className="training-stat">
          <div className="training-stat-num">{counts.ENROLLED}</div>
          <div className="training-stat-label">Enrolled</div>
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

      {/* Course metadata card */}
      <section className="training-section">
        <h2 className="training-section-title">Course details</h2>
        <div className="training-card">
          {course.description && (
            <p style={{ marginTop: 0, color: 'var(--steel)', whiteSpace: 'pre-wrap' }}>{course.description}</p>
          )}
          <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '0.5rem 1rem', margin: 0 }}>
            <dt style={{ fontWeight: 600, color: 'var(--steel)' }}>URL:</dt>
            <dd style={{ margin: 0 }}>
              <a href={course.externalUrl} target="_blank" rel="noopener noreferrer">{course.externalUrl}</a>
            </dd>
            <dt style={{ fontWeight: 600, color: 'var(--steel)' }}>Provider:</dt>
            <dd style={{ margin: 0 }}>{TRAINING_PROVIDER_LABELS[course.provider] || course.provider}</dd>
            {course.category && (
              <>
                <dt style={{ fontWeight: 600, color: 'var(--steel)' }}>Category:</dt>
                <dd style={{ margin: 0 }}>{course.category}</dd>
              </>
            )}
            <dt style={{ fontWeight: 600, color: 'var(--steel)' }}>Status:</dt>
            <dd style={{ margin: 0 }}>{isArchived ? 'Archived (no new assignments)' : 'Active'}</dd>
          </dl>
        </div>
      </section>

      {/* Recent enrollments */}
      <section className="training-section">
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
          <h2 className="training-section-title" style={{ margin: 0 }}>Recent enrollments</h2>
          {enrollments.length > RECENT_ENROLLMENTS_LIMIT && (
            <Link
              to={`/portal/admin/training?courseFilter=${encodeURIComponent(course.id)}`}
              className="training-link-btn"
            >
              View all {enrollments.length} in enrollment queue →
            </Link>
          )}
        </div>
        {enrollments.length === 0 ? (
          <div className="training-list-state">No enrollments yet.</div>
        ) : (
          <ul className="training-list training-list-enrollments">
            {recentEnrollments.map((e) => (
              <li key={e.id} className="training-card training-card-enrollment">
                <div className="training-card-main">
                  <div className="training-card-title-row">
                    <h3 className="training-card-title">{e.employee?.name || 'Unknown employee'}</h3>
                    <StatusPill status={e.status} />
                    {COMPLETED_STATUSES.has(e.status) && <EvidenceBadge evidenceClass={e.evidenceClass} />}
                  </div>
                  <div className="training-card-meta">
                    <span className="training-card-employee-email">{e.employee?.email}</span>
                    {e.employee?.department && (
                      <>
                        <span className="training-card-dot">·</span>
                        <span>{e.employee.department}</span>
                      </>
                    )}
                  </div>
                  <div className="training-card-meta training-card-meta-row-2">
                    <span>Assigned {formatDateTime(e.assignedAt)}</span>
                    {e.dueDate && (
                      <>
                        <span className="training-card-dot">·</span>
                        <span className={isOverdue(e) ? 'training-card-due-overdue' : ''}>
                          Due {formatShortDate(e.dueDate)}
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
                </div>
                {/* Round-24 follow-up: per-row Cancel (unassign) action. Same
                    pattern as TrainingDashboard's "Mark complete" button —
                    hidden when the row is already terminal (CANCELLED or in
                    a *_COMPLETED state). Backend also refuses those via
                    canTransition, so this is a UX shortcut, not a security
                    gate. */}
                {!COMPLETED_STATUSES.has(e.status) && e.status !== 'CANCELLED' && (
                  <div className="training-card-side">
                    <button
                      type="button"
                      className="training-btn training-btn-ghost"
                      onClick={() => handleCancelEnrollment(e)}
                      disabled={!!cancelPending[e.id]}
                      aria-label={`Unassign ${e.employee?.name || 'this employee'} from this course`}
                    >
                      {cancelPending[e.id] ? 'Cancelling…' : 'Cancel assignment'}
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {showReassignModal && (
        <ReassignModal
          course={course}
          onClose={() => setShowReassignModal(false)}
          onSuccess={handleReassignSuccess}
        />
      )}
    </div>
  );
}

// ─── Reassign modal (inline — no shared <Modal> exists in this repo) ───

function ReassignModal({ course, onClose, onSuccess }) {
  const { accessToken } = useAuth();
  const { push } = useToast();
  const dialogRef = useRef(null);

  const [allEmployees, setAllEmployees] = useState([]);
  const [employeesLoading, setEmployeesLoading] = useState(true);
  const [employeesError, setEmployeesError] = useState('');
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [employeeQuery, setEmployeeQuery] = useState('');
  const [dueDate, setDueDate] = useState(addDaysInputValue(14));
  const [priority, setPriority] = useState('NORMAL');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api.listAdminEmployees({ limit: 500 }, accessToken);
        if (cancelled) return;
        setAllEmployees(data.employees || []);
      } catch (err) {
        if (cancelled) return;
        setEmployeesError(err.message || 'Failed to load employee directory');
      } finally {
        if (!cancelled) setEmployeesLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [accessToken]);

  // ESC to close — mirrors DprDashboard modal pattern.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const filteredEmployees = useMemo(() => {
    const q = employeeQuery.trim().toLowerCase();
    if (!q) return allEmployees.slice(0, 50);
    return allEmployees.filter(
      (e) => e.name?.toLowerCase().includes(q) || e.email?.toLowerCase().includes(q)
    ).slice(0, 50);
  }, [allEmployees, employeeQuery]);

  const selectedEmployees = useMemo(
    () => allEmployees.filter((e) => selectedIds.has(e.id)),
    [allEmployees, selectedIds]
  );

  const toggleEmployee = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectedCount = selectedIds.size;
  const liveError = selectedCount === 0
    ? 'Pick at least one employee to assign.'
    : selectedCount > MAX_EMPLOYEE_IDS_PER_BULK
      ? `Too many employees (max ${MAX_EMPLOYEE_IDS_PER_BULK}).`
      : '';

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (liveError) {
      setSubmitError(liveError);
      return;
    }
    setSubmitting(true);
    setSubmitError('');
    try {
      const result = await api.assignTraining(
        course.id,
        Array.from(selectedIds),
        { dueDate, priority, byEmail: false },
        accessToken
      );
      await onSuccess(result);
    } catch (err) {
      setSubmitError(err?.message || 'Failed to assign course');
      push(err?.message || 'Failed to assign course', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="training-modal-backdrop"
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={dialogRef}
        className="training-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="reassign-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="training-modal-header">
          <h2 id="reassign-modal-title" className="training-modal-title">
            Reassign “{course.title}”
          </h2>
          <button
            type="button"
            className="training-modal-close"
            onClick={onClose}
            aria-label="Close reassign dialog"
          >
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit} className="training-modal-body">
          {/* Employee picker */}
          <div className="training-field">
            <label htmlFor="reassign-employee-search">
              Assign to employees
              <span className="training-counter">{selectedCount} selected</span>
            </label>
            <input
              id="reassign-employee-search"
              type="search"
              value={employeeQuery}
              onChange={(e) => setEmployeeQuery(e.target.value)}
              placeholder="Search by name or email"
              aria-label="Search employees"
              aria-controls="reassign-employee-listbox"
            />
            {employeesLoading && <div className="training-hint">Loading employee directory…</div>}
            {employeesError && <div className="training-form-error" role="alert">{employeesError}</div>}
            {!employeesLoading && !employeesError && (
              <ul
                id="reassign-employee-listbox"
                className="training-employee-picker"
                aria-label="Employees"
                style={{ maxHeight: 240, overflowY: 'auto' }}
              >
                {filteredEmployees.length === 0 && (
                  <li className="training-employee-picker-empty">No employees match “{employeeQuery}”.</li>
                )}
                {filteredEmployees.map((emp) => {
                  const isSelected = selectedIds.has(emp.id);
                  return (
                    <li key={emp.id} className={`training-employee-picker-row ${isSelected ? 'selected' : ''}`}>
                      <label className="training-employee-picker-label">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleEmployee(emp.id)}
                          aria-label={`Assign course to ${emp.name || emp.email}`}
                        />
                        <span className="training-employee-picker-name">{emp.name || '—'}</span>
                        <span className="training-employee-picker-email">{emp.email}</span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
            {selectedEmployees.length > 0 && (
              <div className="training-emails-preview" aria-live="polite">
                {selectedEmployees.slice(0, 12).map((e) => (
                  <span key={e.id} className="training-email-chip">
                    {e.name || e.email}
                    <button
                      type="button"
                      onClick={() => toggleEmployee(e.id)}
                      aria-label={`Remove ${e.name || e.email}`}
                      className="training-email-chip-remove"
                    >
                      ×
                    </button>
                  </span>
                ))}
                {selectedEmployees.length > 12 && (
                  <span className="training-email-chip training-email-chip-more">
                    +{selectedEmployees.length - 12} more
                  </span>
                )}
              </div>
            )}
          </div>

          <div className="training-form-row">
            <div className="training-field">
              <label htmlFor="reassign-due">Due date (optional)</label>
              <input
                id="reassign-due"
                type="date"
                value={dueDate}
                min={todayInputValue()}
                onChange={(e) => setDueDate(e.target.value)}
              />
            </div>
            <div className="training-field">
              <label htmlFor="reassign-priority">Priority</label>
              <select
                id="reassign-priority"
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
              >
                {Object.entries(TRAINING_PRIORITIES).map(([k, v]) => (
                  <option key={k} value={k}>{v.charAt(0) + v.slice(1).toLowerCase()}</option>
                ))}
              </select>
            </div>
          </div>

          {submitError && (
            <div className="training-form-error" role="alert">{submitError}</div>
          )}
        </form>

        <div className="training-modal-footer">
          <button
            type="button"
            className="training-btn training-btn-ghost"
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="button"
            className="training-btn training-btn-primary"
            onClick={handleSubmit}
            disabled={submitting || !!liveError}
          >
            {submitting ? 'Assigning…' : `Assign to ${selectedCount} ${selectedCount === 1 ? 'employee' : 'employees'}`}
          </button>
        </div>
      </div>
    </div>
  );
}
