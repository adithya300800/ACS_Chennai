import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { api } from '../../lib/api.js';
import VideoPlayer from '../../components/VideoPlayer.jsx';
import Breadcrumb from '../../components/Breadcrumb.jsx';
import {
  TRAINING_PROGRESS_PING_MS,
  TRAINING_PROVIDER_LABELS,
  TRAINING_STATUSES,
} from '../../lib/constants.js';

const formatDate = (dateStr) => {
  if (!dateStr) return '';
  return new Date(dateStr).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
};

const formatDateTime = (dateStr) => {
  if (!dateStr) return '';
  return new Date(dateStr).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};

/**
 * Single-course player page. Shows the embedded VideoPlayer (provider-aware),
 * surfaces the title/description/dueDate/priority meta, and exposes manual
 * "Mark as Complete" for the employee as a fallback (also required for
 * non-trackable providers like LinkedIn / Coursera / Udemy).
 *
 * Progress pings are throttled to TRAINING_PROGRESS_PING_MS via a ref-based
 * debounce so re-renders from state changes don't double-fire. The player
 * pushes raw events into handleProgress; we hold the latest value and post
 * it on a timer. We also POST immediately on onEnded so a 100% completion
 * doesn't wait for the next interval tick.
 */
export default function TrainingDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { accessToken } = useAuth();
  const { push } = useToast();

  const [enrollment, setEnrollment] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [completing, setCompleting] = useState(false);
  const [pendingPct, setPendingPct] = useState(0);
  const [lastPingAt, setLastPingAt] = useState(0);

  // Latest values buffered from the player. We hold them in refs so the
  // interval tick reads the freshest values without re-creating it.
  const latestRef = useRef({ pct: 0, currentSec: 0 });
  const dirtyRef = useRef(false);

  const fetchEnrollment = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await api.getTrainingEnrollment(id, accessToken);
      setEnrollment(data);
      // Seed the latest ref so a refresh mid-watch resumes at the server's
      // last known position, not 0:00.
      latestRef.current = { pct: data.progressPct || 0, currentSec: data.lastWatchedSec || 0 };
    } catch (err) {
      setError(err.message || 'Failed to load course');
      push(err.message || 'Failed to load course', 'error');
    } finally {
      setLoading(false);
    }
  }, [id, accessToken, push]);

  useEffect(() => {
    fetchEnrollment();
  }, [fetchEnrollment]);

  // Throttled progress POST — runs once every TRAINING_PROGRESS_PING_MS,
  // picking up whatever the latest player event left in latestRef.
  useEffect(() => {
    if (!enrollment) return undefined;
    if (enrollment.status === TRAINING_STATUSES.COMPLETED) return undefined;

    const id = setInterval(async () => {
      if (!dirtyRef.current) return;
      const { pct, currentSec } = latestRef.current;
      dirtyRef.current = false;
      try {
        const updated = await api.updateTrainingProgress(enrollment.id, Math.round(pct), Math.floor(currentSec), accessToken);
        setPendingPct(updated.progressPct || 0);
        setLastPingAt(Date.now());
        // Mirror status into local state so the pill / progress bar update
        // without a full refetch. Important when we transition to COMPLETED
        // mid-watch — the interval must stop firing after that.
        if (updated.status !== enrollment.status) {
          setEnrollment((prev) => ({ ...prev, status: updated.status, progressPct: updated.progressPct }));
          if (updated.status === TRAINING_STATUSES.COMPLETED) {
            push('Course marked complete.', 'success');
          }
        }
      } catch (err) {
        // 409 ENROLLMENT_LOCKED = already completed by another device; treat
        // as success and let the local state catch up on the next refetch.
        if (err?.code === 'ENROLLMENT_LOCKED' || err?.status === 409) {
          setEnrollment((prev) => ({ ...prev, status: TRAINING_STATUSES.COMPLETED, progressPct: 100 }));
        }
        // 429 TRAINING_THROTTLED — silently skip; next tick will try again.
      }
    }, TRAINING_PROGRESS_PING_MS);

    return () => clearInterval(id);
  }, [enrollment, accessToken, push]);

  // Called by VideoPlayer every ~5s (YT/Vimeo native cadence). We buffer
  // the latest values and mark dirty so the interval POST picks them up.
  const handleProgress = useCallback(({ pct, currentSec }) => {
    if (pct == null) return;
    // Monotonic on the client too — never report a lower pct than the last
    // value (protects against weird Vimeo/YT replay events).
    const safePct = Math.max(latestRef.current.pct || 0, pct);
    latestRef.current = { pct: safePct, currentSec: currentSec || 0 };
    setPendingPct(safePct);
    dirtyRef.current = true;
  }, []);

  // Fired by VideoPlayer on the actual `ended` event. We post IMMEDIATELY
  // (not waiting for the interval) so completion is real-time.
  const handleEnded = useCallback(async () => {
    if (!enrollment) return;
    if (enrollment.status === TRAINING_STATUSES.COMPLETED) return;
    try {
      const updated = await api.updateTrainingProgress(enrollment.id, 100, latestRef.current.currentSec || 0, accessToken);
      setEnrollment((prev) => ({ ...prev, status: updated.status, progressPct: updated.progressPct }));
      setPendingPct(100);
      push('Course completed! 🎉', 'success');
    } catch (err) {
      // Even if the POST failed, the UI still shows the player ended; the
      // user can hit "Mark as Complete" as the fallback.
      push(err?.message || 'Could not save completion — try Mark as Complete.', 'error');
    }
  }, [enrollment, accessToken, push]);

  // Manual mark-complete — required for non-trackable providers; also
  // serves as the employee-side safety net if the auto-capture missed
  // the ended event (e.g. browser killed the tab mid-video).
  const handleManualComplete = useCallback(async () => {
    if (!enrollment) return;
    if (enrollment.status === TRAINING_STATUSES.COMPLETED) return;
    if (!window.confirm('Mark this course as complete?')) return;
    setCompleting(true);
    try {
      const updated = await api.markTrainingComplete(enrollment.id, '', accessToken);
      setEnrollment((prev) => ({ ...prev, status: updated.status, progressPct: updated.progressPct }));
      push('Course marked complete.', 'success');
    } catch (err) {
      push(err?.message || 'Failed to mark complete', 'error');
    } finally {
      setCompleting(false);
    }
  }, [enrollment, accessToken, push]);

  if (loading) {
    return (
      <div className="training-page">
        <div className="training-list-state">Loading course…</div>
      </div>
    );
  }

  if (error || !enrollment) {
    return (
      <div className="training-page">
        <button
          type="button"
          className="training-btn training-btn-ghost"
          onClick={() => navigate('/portal/training')}
          style={{ marginBottom: 12 }}
        >
          ← Back to My Learning
        </button>
        <div className="training-list-error" role="alert">
          {error || 'Course not found.'}
        </div>
      </div>
    );
  }

  const course = enrollment.course || {};
  const isComplete = enrollment.status === TRAINING_STATUSES.COMPLETED;

  return (
    <div className="training-page training-detail-page">
      <div className="training-detail-header">
        <Link to="/portal/training" className="training-btn training-btn-ghost training-btn-back">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="19" y1="12" x2="5" y2="12" />
            <polyline points="12 19 5 12 12 5" />
          </svg>
          Back to My Learning
        </Link>
      </div>

      {/* Round-17 B-03: breadcrumb above the H1. Last item is current page (no `to`). */}
      <Breadcrumb
        items={[
          { label: 'My Learning', to: '/portal/training' },
          { label: course.title || 'Untitled course' },
        ]}
      />

      <div className="training-detail-meta">
        <h1 className="training-detail-title">{course.title || 'Untitled course'}</h1>
        <div className="training-detail-sub">
          <span className={`training-pill training-pill-${enrollment.status.toLowerCase()}`}>
            {enrollment.status === 'IN_PROGRESS' ? 'In Progress' : enrollment.status === 'COMPLETED' ? 'Completed' : 'Assigned'}
          </span>
          <span className="training-detail-divider">·</span>
          <span>{TRAINING_PROVIDER_LABELS[course.provider] || 'External'}</span>
          {course.category && (
            <>
              <span className="training-detail-divider">·</span>
              <span>{course.category}</span>
            </>
          )}
          {enrollment.dueDate && (
            <>
              <span className="training-detail-divider">·</span>
              <span>Due {formatDate(enrollment.dueDate)}</span>
            </>
          )}
          {enrollment.assignedBy?.name && (
            <>
              <span className="training-detail-divider">·</span>
              <span>Assigned by {enrollment.assignedBy.name}</span>
            </>
          )}
        </div>
      </div>

      <div className="training-player-region">
        <VideoPlayer
          provider={course.provider}
          externalUrl={course.externalUrl}
          onProgress={handleProgress}
          onEnded={handleEnded}
          initialTime={enrollment.lastWatchedSec || 0}
        />
      </div>

      <div className="training-progress training-progress-large" aria-label={`Progress: ${enrollment.progressPct}%`}>
        <div className="training-progress-bar" style={{ width: `${Math.min(100, Math.max(0, enrollment.progressPct))}%` }} />
        <span className="training-progress-label">{enrollment.progressPct}% watched</span>
      </div>

      <div className="training-detail-actions">
        {isComplete ? (
          <div className="training-detail-completed" role="status">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="20 6 9 17 4 12" />
            </svg>
            Completed {enrollment.completedAt && `on ${formatDateTime(enrollment.completedAt)}`}
          </div>
        ) : (
          <button
            type="button"
            className="training-btn training-btn-primary"
            onClick={handleManualComplete}
            disabled={completing}
          >
            {completing ? 'Saving…' : 'Mark as Complete'}
          </button>
        )}
        <span className="training-detail-ping" aria-live="polite">
          {lastPingAt > 0
            ? `Progress saved ${new Date(lastPingAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`
            : pendingPct > 0
              ? `Tracking ${Math.round(pendingPct)}%…`
              : ''}
        </span>
      </div>

      {course.description && (
        <section className="training-detail-section">
          <h2 className="training-section-title">About this course</h2>
          <p className="training-detail-description">{course.description}</p>
        </section>
      )}
    </div>
  );
}
