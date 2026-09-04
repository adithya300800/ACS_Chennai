import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { api } from '../../lib/api.js';
import { formatTime } from '../../lib/format.js';
import { getBusinessToday } from '../../lib/businessDate.js';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';
import { MapPinIcon, ClockIcon, DocIcon, BookIcon, PlaneIcon, BellIcon } from '../../components/Icons.jsx';
import { isTrainingTerminal } from '../../lib/constants.js';

// SOL-P2#16: employee home dashboard. Lands employees on a single screen
// with their today-check-in status, open DPR draft, training due,
// leave-balance, and recent activity. Keeps Attendance as a separate
// destination for full history. Two-column responsive layout fills the
// empty canvas noted by the audit on desktop.
//
// Data fetched (in parallel on mount + visibilitychange refresh):
//   /attendance/today?localDate=YYYY-MM-DD  → sessions, active check-in
//   /attendance?month=YYYY-MM               → month context (week totals)
//   /dpr?status=DRAFT&limit=1               → any open draft (Resume CTA)
//   /training/enrollments/my               → due-soon / overdue subset
//   /leave/my                               → leave balance widget
//   /dpr/notifications/list                 → last 5 notifications

// LPR-009: terminal-check uses the canonical list — a row in any of the
// four *_COMPLETED evidence states is no longer eligible for overdue/due-soon
// counters.
const isOverdue = (e) => {
  if (!e?.dueDate) return false;
  if (isTrainingTerminal(e.status)) return false;
  const due = String(e.dueDate).split('T')[0];
  return due < getBusinessToday();
};

const isDueSoon = (e) => {
  if (!e?.dueDate) return false;
  if (isTrainingTerminal(e.status)) return false;
  const due = String(e.dueDate).split('T')[0];
  const today = getBusinessToday();
  if (due < today) return false; // overdue already handled separately
  // "Soon" = within 7 days
  const diff = (new Date(due) - new Date(today)) / (1000 * 60 * 60 * 24);
  return diff <= 7;
};

const formatDateShort = (s) => {
  if (!s) return '';
  const [y, m, d] = String(s).split('T')[0].split('-').map(Number);
  if (!y || !m || !d) return s;
  return new Date(y, m - 1, d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
};

const NotificationItem = ({ n }) => {
  // Match NotificationBell's rendering style — title + relative time
  const when = n.createdAt ? new Date(n.createdAt) : null;
  const rel = when ? formatRelativeTime(when) : '';
  return (
    <li className="dashboard-activity-row">
      <span className="dashboard-activity-icon" aria-hidden="true"><BellIcon size={14} /></span>
      <span className="dashboard-activity-body">
        <span className="dashboard-activity-text">{n.title || n.message || 'Update'}</span>
        {n.body && <span className="dashboard-activity-sub">{n.body}</span>}
      </span>
      {rel && <span className="dashboard-activity-time">{rel}</span>}
    </li>
  );
};

function formatRelativeTime(d) {
  const seconds = Math.max(1, Math.floor((Date.now() - d.getTime()) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

const Skeleton = ({ w = '60%', h = 16 }) => (
  <span style={{
    display: 'block',
    width: w,
    height: h,
    background: 'var(--surface, #f1f5f9)',
    borderRadius: 6,
  }} aria-hidden="true" />
);

export default function EmployeeDashboard() {
  useDocumentTitle('Dashboard');
  const { accessToken, employee } = useAuth();
  const { push } = useToast();

  const [loading, setLoading] = useState(true);
  const [todayRecord, setTodayRecord] = useState(null);
  const [draft, setDraft] = useState(null);
  const [training, setTraining] = useState([]);
  const [leaves, setLeaves] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [error, setError] = useState('');
  const [actionLoading, setActionLoading] = useState('');
  const [checkInError, setCheckInError] = useState('');

  const today = getBusinessToday();

  const refresh = useCallback(async (showSpinner = true) => {
    if (showSpinner) setLoading(true);
    setError('');
    try {
      // Parallel fetch — failures on individual widgets are tolerated
      // (catch + empty) so a slow endpoint can't blank the page.
      const [todayRes, draftsRes, trainingRes, leavesRes, notifRes] = await Promise.all([
        api.get(`/attendance/today?localDate=${today}`, accessToken).catch(() => null),
        api.getDprs({ status: 'DRAFT', my: 'true', limit: '1' }, accessToken).catch(() => ({ dprs: [] })),
        api.getMyTraining({}, accessToken).catch(() => ({ enrollments: [] })),
        api.getMyLeaves(accessToken).catch(() => ({ requests: [] })),
        api.getNotifications(null, accessToken).catch(() => ({ notifications: [] })),
      ]);
      setTodayRecord(todayRes);
      setDraft(draftsRes.dprs?.[0] ?? null);
      setTraining(trainingRes.enrollments || []);
      setLeaves(leavesRes.requests || []);
      setNotifications(notifRes.notifications || []);
    } catch (err) {
      setError(err.message || 'Failed to load dashboard');
    } finally {
      if (showSpinner) setLoading(false);
    }
  }, [accessToken, today]);

  useEffect(() => {
    refresh();
    const onVis = () => { if (document.visibilityState === 'visible') refresh(false); };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [refresh]);

  // Derived attendance state. Round-21: attendance moved to check-in-only
  // (DR-024) — a single check-in per day is the whole flow, no check-out.
  // `activeSession` is kept only as a "did the user check in today" signal;
  // we never consume `lastSession.checkOut` again.
  const sessions = todayRecord?.sessions || [];
  const hasAnySession = sessions.length > 0;
  const activeSession = sessions.find((s) => !s.checkOut) || null;
  // `firstCheckIn` = earliest session of today. With check-in-only this is
  // the only check-in the user can have on a given day, so we just take
  // the session that exists (legacy multi-session days still render the
  // earliest).
  const firstCheckIn = (() => {
    if (!sessions.length) return null;
    const sorted = [...sessions].sort((a, b) =>
      new Date(a.checkIn).getTime() - new Date(b.checkIn).getTime());
    return sorted[0];
  })();

  const handleCheckIn = async () => {
    setCheckInError('');
    setActionLoading('checkin');
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      await api.post('/attendance/check-in', {
        clientTime: new Date().toISOString(),
        clientTimezone: tz,
      }, accessToken);
      push('Checked in for today', 'success');
      refresh(false);
    } catch (err) {
      setCheckInError(err.message || 'Check-in failed');
      push(err.message || 'Check-in failed', 'error');
    } finally {
      setActionLoading('');
    }
  };

  const overdueTraining = training.filter(isOverdue);
  const dueSoonTraining = training.filter(isDueSoon);

  const [year, month, day] = today.split('-').map(Number);
  const friendlyDate = new Date(year, month - 1, day).toLocaleDateString('en-IN', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
  const firstName = employee?.name?.split(' ')[0] || 'there';

  return (
    <div className="dpr-page dashboard-page">
      <div className="dpr-page-header">
        <div>
          <h1 className="dpr-page-title">Welcome back, {firstName}</h1>
          <p className="dpr-page-sub" style={{ color: 'var(--steel)', margin: 0, fontSize: '0.9rem' }}>
            {friendlyDate}
          </p>
        </div>
      </div>

      {error && (
        <div className="dashboard-error" role="alert">{error}</div>
      )}

      {/* Top row: attendance check-in hero. Round-21: attendance moved to
          check-in-only (DR-024) — there is no check-out button on this
          dashboard. Once an employee checks in, the only follow-up action
          is to view their full attendance history. The previously-rendered
          Check out button hit `PUT /api/attendance/check-out/:id` with an
          empty body and returned 400 ("latitude and longitude required")
          on every click, so removing it is a strict improvement. */}
      <section className="dashboard-attendance" aria-label="Today's attendance">
        <div className="dashboard-attendance-main">
          <span className="dashboard-attendance-eyebrow">Today's attendance</span>
          {loading ? (
            <>
              <Skeleton w="60%" h={28} />
              <div style={{ marginTop: 12 }}><Skeleton w="40%" h={14} /></div>
            </>
          ) : hasAnySession && firstCheckIn ? (
            <>
              <div className="dashboard-attendance-state">
                <span className="dashboard-state-pill on">
                  Checked in
                </span>
                <span className="dashboard-attendance-time">
                  since {formatTime(firstCheckIn.checkIn)}
                  {firstCheckIn.checkInAddr && (
                    <span className="dashboard-attendance-addr">
                      {' · '}
                      <MapPinIcon size={12} style={{ display: 'inline-block', verticalAlign: '-1px', marginRight: 4 }} />
                      {firstCheckIn.checkInAddr}
                    </span>
                  )}
                </span>
              </div>
              <p className="dashboard-attendance-hint">
                <Link to="/portal/attendance">View full attendance history →</Link>
              </p>
            </>
          ) : (
            <>
              <div className="dashboard-attendance-state">
                <span className="dashboard-state-pill muted">Not checked in</span>
              </div>
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleCheckIn}
                disabled={actionLoading === 'checkin'}
                style={{ marginTop: 16, minHeight: 44 }}
              >
                {actionLoading === 'checkin' ? 'Checking in…' : 'Check in now'}
              </button>
            </>
          )}
          {checkInError && (
            <p className="dashboard-attendance-error" role="alert">{checkInError}</p>
          )}
        </div>
        <aside className="dashboard-attendance-aside">
          <Link to="/portal/attendance" className="dashboard-aside-link">
            <ClockIcon size={16} />
            <span>
              <strong>View month</strong>
              <small>Weekly summary + export</small>
            </span>
          </Link>
        </aside>
      </section>

      {/* Dashboard grid */}
      <div className="dashboard-grid">
        {/* Open draft */}
        <section className="dashboard-card" aria-label="Open DPR draft">
          <header className="dashboard-card-header">
            <h2 className="dashboard-card-title">
              <DocIcon size={16} style={{ verticalAlign: '-3px', marginRight: 6, color: 'var(--steel)' }} />
              Open DPR draft
            </h2>
          </header>
          {loading ? (
            <Skeleton w="80%" h={14} />
          ) : draft ? (
            <div className="dashboard-card-body">
              <div className="dashboard-card-primary">
                {draft.projectName || 'Untitled project'}
              </div>
              <div className="dashboard-card-meta">
                Started {draft.reportDate ? formatDateShort(draft.reportDate) : 'recently'}
              </div>
              <Link to={`/portal/dpr/submit?draftId=${draft.id}`} className="btn btn-primary btn-sm" style={{ marginTop: 12 }}>
                Resume draft →
              </Link>
            </div>
          ) : (
            <div className="dashboard-card-body">
              <p className="dashboard-card-empty">
                No drafts in progress.
              </p>
              <Link to="/portal/dpr/submit" className="btn btn-primary btn-sm" style={{ marginTop: 8 }}>
                Start a new DPR
              </Link>
            </div>
          )}
        </section>

        {/* Training */}
        <section className="dashboard-card" aria-label="Training due">
          <header className="dashboard-card-header">
            <h2 className="dashboard-card-title">
              <BookIcon size={16} style={{ verticalAlign: '-3px', marginRight: 6, color: 'var(--steel)' }} />
              Training due
            </h2>
            <Link to="/portal/training" className="dashboard-card-link">All</Link>
          </header>
          {loading ? (
            <Skeleton w="70%" h={14} />
          ) : overdueTraining.length === 0 && dueSoonTraining.length === 0 ? (
            <p className="dashboard-card-empty">Nothing due in the next week.</p>
          ) : (
            <ul className="dashboard-card-list">
              {overdueTraining.slice(0, 2).map((e) => (
                <li key={e.id} className="dashboard-card-list-row overdue">
                  <span className="dashboard-card-list-text">{e.course?.title || 'Untitled course'}</span>
                  <span className="dashboard-card-list-meta">
                    Overdue · {e.dueDate ? formatDateShort(e.dueDate) : ''}
                  </span>
                </li>
              ))}
              {dueSoonTraining.slice(0, 3 - overdueTraining.length).map((e) => (
                <li key={e.id} className="dashboard-card-list-row">
                  <span className="dashboard-card-list-text">{e.course?.title || 'Untitled course'}</span>
                  <span className="dashboard-card-list-meta">Due {e.dueDate ? formatDateShort(e.dueDate) : ''}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Leave balance / Recent */}
        <section className="dashboard-card" aria-label="Leave balance">
          <header className="dashboard-card-header">
            <h2 className="dashboard-card-title">
              <PlaneIcon size={16} style={{ verticalAlign: '-3px', marginRight: 6, color: 'var(--steel)' }} />
              Leave
            </h2>
            <Link to="/portal/leave" className="dashboard-card-link">All</Link>
          </header>
          {loading ? (
            <Skeleton w="60%" h={14} />
          ) : leaves.length === 0 ? (
            <p className="dashboard-card-empty">No leave history yet.</p>
          ) : (
            <ul className="dashboard-card-list">
              {leaves.slice(0, 3).map((l) => (
                <li key={l.id} className="dashboard-card-list-row">
                  <span className="dashboard-card-list-text">
                    {l.leaveType || 'Leave'} · {l.startDate ? formatDateShort(l.startDate) : ''}
                    {l.endDate && l.endDate !== l.startDate ? `–${formatDateShort(l.endDate)}` : ''}
                  </span>
                  <span className={`dashboard-pill dashboard-pill-${(l.status || 'PENDING').toLowerCase()}`}>
                    {l.status}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Recent notifications */}
        <section className="dashboard-card dashboard-card-wide" aria-label="Recent notifications">
          <header className="dashboard-card-header">
            <h2 className="dashboard-card-title">
              <BellIcon size={16} style={{ verticalAlign: '-3px', marginRight: 6, color: 'var(--steel)' }} />
              Recent updates
            </h2>
          </header>
          {loading ? (
            <Skeleton w="90%" h={14} />
          ) : notifications.length === 0 ? (
            <p className="dashboard-card-empty">No updates yet. Submit a DPR or inspection to see live status here.</p>
          ) : (
            <ul className="dashboard-activity">
              {notifications.slice(0, 5).map((n) => (
                <NotificationItem key={n.id} n={n} />
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
