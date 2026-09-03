import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { api } from '../../lib/api.js';
import {
  TRAINING_PROVIDER_LABELS,
} from '../../lib/constants.js';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';
import Breadcrumb from '../../components/Breadcrumb.jsx';

// Round-24: edit existing course. Pre-fills the form fields from
// GET /api/training/courses/:id, saves via PUT. NO employee picker (you
// can't reassign via this form — use the Reassign modal on the detail
// page). NO isArchived toggle — that's a one-click action on the detail
// page so admins can archive without re-saving all fields.
//
// KEEP IN SYNC with TrainingCourseNew.jsx: the course-details field
// section (title, externalUrl, provider, category, description) is
// duplicated here rather than extracted to a shared component (rule of
// three — only two consumers today).

const MAX_TITLE_LEN = 160;
const MAX_DESCRIPTION_LEN = 4000;
const MAX_CATEGORY_LEN = 60;
const MAX_URL_LEN = 2048;

function detectProviderClient(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  let url;
  try { url = new URL(rawUrl); } catch { return null; }
  if (!/^https?:$/.test(url.protocol)) return null;
  const host = url.hostname.toLowerCase();
  if (host === 'youtube.com' || host === 'www.youtube.com' || host === 'youtu.be' || host === 'm.youtube.com' || host === 'youtube-nocookie.com' || host === 'www.youtube-nocookie.com') return 'YOUTUBE';
  if (host === 'vimeo.com' || host === 'www.vimeo.com' || host === 'player.vimeo.com') return 'VIMEO';
  if (host === 'linkedin.com' || host === 'www.linkedin.com') return 'LINKEDIN_LEARNING';
  if (host === 'coursera.org' || host === 'www.coursera.org') return 'COURSERA';
  if (host === 'udemy.com' || host === 'www.udemy.com') return 'UDEMY';
  return null;
}

export default function TrainingCourseEdit() {
  useDocumentTitle('Edit Training Course');
  const { id } = useParams();
  const navigate = useNavigate();
  const { employee, accessToken } = useAuth();
  const { push } = useToast();

  // Admin guard.
  useEffect(() => {
    if (employee && !employee.isAdmin) navigate('/portal/attendance');
  }, [employee, navigate]);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [externalUrl, setExternalUrl] = useState('');
  const [provider, setProvider] = useState('OTHER');
  const [providerAuto, setProviderAuto] = useState(true);
  const [category, setCategory] = useState('');

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [courseTitle, setCourseTitle] = useState(''); // for breadcrumb + page title
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');

  // Pre-fill from GET /api/training/courses/:id.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api.getTrainingCourse(id, accessToken);
        if (cancelled) return;
        setTitle(data.title || '');
        setDescription(data.description || '');
        setExternalUrl(data.externalUrl || '');
        setCategory(data.category || '');
        // Seed provider from the URL on first paint, then respect any
        // subsequent manual override.
        const detected = detectProviderClient(data.externalUrl);
        setProvider(detected || data.provider || 'OTHER');
        setProviderAuto(true);
        const t = data.title || 'Course';
        setCourseTitle(t);
        // Update doc title to include the loaded course name. Done via
        // direct DOM write (not useDocumentTitle) because hooks must run
        // at the top level — re-running useDocumentTitle here would
        // violate Rules of Hooks. The top-level useDocumentTitle call
        // above sets the initial 'Edit Training Course' tab label.
        document.title = `Edit · ${t} · ACS Chennai`;
      } catch (err) {
        if (cancelled) return;
        setLoadError(err.message || 'Failed to load course');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [id, accessToken]);

  // URL → provider auto-detection. If the admin manually picks a provider
  // from the dropdown, we lock to their choice until they edit the URL again.
  useEffect(() => {
    if (!providerAuto) return;
    const detected = detectProviderClient(externalUrl);
    if (detected) setProvider(detected);
    else if (externalUrl.trim().length === 0) setProvider('OTHER');
  }, [externalUrl, providerAuto]);

  const handleProviderChange = (val) => {
    setProvider(val);
    setProviderAuto(false);
  };

  const liveError = useMemo(() => {
    if (title.trim().length === 0) return 'Course title is required.';
    if (title.length > MAX_TITLE_LEN) return `Title must be at most ${MAX_TITLE_LEN} characters.`;
    if (description.length > MAX_DESCRIPTION_LEN) return `Description must be at most ${MAX_DESCRIPTION_LEN} characters.`;
    if (category.length > MAX_CATEGORY_LEN) return `Category must be at most ${MAX_CATEGORY_LEN} characters.`;
    if (externalUrl.trim().length === 0) return 'Course URL is required.';
    if (externalUrl.length > MAX_URL_LEN) return `URL must be at most ${MAX_URL_LEN} characters.`;
    try {
      const u = new URL(externalUrl);
      if (!/^https?:$/.test(u.protocol)) return 'URL must use http or https.';
    } catch {
      return 'URL is not a valid http(s) URL.';
    }
    return '';
  }, [title, description, category, externalUrl]);

  const handleSubmit = useCallback(async (e) => {
    e.preventDefault();
    if (liveError) {
      setFormError(liveError);
      return;
    }
    setSubmitting(true);
    setFormError('');
    try {
      // Round-24: PUT is a strict allowlist on the backend — only the
      // fields we explicitly send are persisted. We send only the
      // editable fields; archive state is owned by the detail page.
      const patch = {
        title: title.trim(),
        description: description.trim() || null,
        externalUrl: externalUrl.trim(),
        provider,
        category: category.trim() || null,
      };
      await api.updateTrainingCourse(id, patch, accessToken);
      push('Course saved.', 'success');
      navigate(`/portal/admin/training/${id}`);
    } catch (err) {
      setFormError(err.message || 'Failed to save course');
      push(err.message || 'Failed to save course', 'error');
    } finally {
      setSubmitting(false);
    }
  }, [id, title, description, externalUrl, provider, category, accessToken, push, liveError, navigate]);

  if (loading) {
    return (
      <div className="training-page">
        <div className="training-list-state">Loading course…</div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="training-page">
        <div className="training-card" style={{ textAlign: 'center', padding: '3rem' }}>
          <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>⚠️</div>
          <h2 style={{ color: 'var(--navy)', marginBottom: '0.5rem' }}>{loadError}</h2>
          <Link to="/portal/admin/training" className="btn btn-secondary btn-sm" style={{ marginTop: '1rem' }}>
            ← Back to Training Library
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="training-page training-edit-course-page">
      <Breadcrumb
        items={[
          { label: 'Training Library', to: '/portal/admin/training' },
          { label: courseTitle, to: `/portal/admin/training/${id}` },
          { label: 'Edit' },
        ]}
      />

      <div className="training-page-header">
        <div>
          <h1 className="training-page-title">Edit Course</h1>
          <p className="training-page-sub">Update course details. Archive / unarchive lives on the course page.</p>
        </div>
        <button
          type="button"
          className="training-btn training-btn-ghost"
          onClick={() => navigate(`/portal/admin/training/${id}`)}
        >
          Cancel
        </button>
      </div>

      <form onSubmit={handleSubmit} className="training-new-form" noValidate>
        {/* Course details — KEEP IN SYNC with TrainingCourseNew.jsx */}
        <section className="training-form-card">
          <h2 className="training-section-title">Course details</h2>

          <div className="training-field">
            <label htmlFor="course-title">
              Title
              <span className="training-counter">{title.length}/{MAX_TITLE_LEN}</span>
            </label>
            <input
              id="course-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={MAX_TITLE_LEN + 50}
              placeholder="e.g. Project Safety Essentials"
              required
            />
          </div>

          <div className="training-field">
            <label htmlFor="course-url">
              Course URL
              <span className="training-hint">
                Paste a YouTube, Vimeo, LinkedIn Learning, Coursera, or Udemy link
              </span>
            </label>
            <input
              id="course-url"
              type="url"
              value={externalUrl}
              onChange={(e) => { setExternalUrl(e.target.value); setProviderAuto(true); }}
              maxLength={MAX_URL_LEN}
              placeholder="https://www.youtube.com/watch?v=..."
              required
            />
            {externalUrl && (
              <span className="training-field-detected">
                Detected: <strong>{TRAINING_PROVIDER_LABELS[provider] || 'External'}</strong>
                {!providerAuto && ' (manually overridden)'}
              </span>
            )}
          </div>

          <div className="training-field">
            <label htmlFor="course-provider">Provider</label>
            <select
              id="course-provider"
              value={provider}
              onChange={(e) => handleProviderChange(e.target.value)}
            >
              {Object.entries(TRAINING_PROVIDER_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
            <span className="training-hint">
              YouTube and Vimeo play inside the portal with auto progress capture.
              Other providers open in a new tab — the employee marks complete manually.
            </span>
          </div>

          <div className="training-field">
            <label htmlFor="course-category">Category (optional)</label>
            <input
              id="course-category"
              type="text"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              maxLength={MAX_CATEGORY_LEN + 10}
              placeholder="e.g. Safety, Technical, Compliance"
            />
          </div>

          <div className="training-field">
            <label htmlFor="course-description">
              Description (optional)
              <span className="training-counter">{description.length}/{MAX_DESCRIPTION_LEN}</span>
            </label>
            <textarea
              id="course-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              maxLength={MAX_DESCRIPTION_LEN + 100}
              placeholder="Brief description shown on the course detail page"
            />
          </div>
        </section>

        {formError && (
          <div className="training-form-error" role="alert">{formError}</div>
        )}

        <div className="training-form-actions">
          <button
            type="button"
            className="training-btn training-btn-ghost"
            onClick={() => navigate(`/portal/admin/training/${id}`)}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="training-btn training-btn-primary"
            disabled={submitting || !!liveError}
          >
            {submitting ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </form>
    </div>
  );
}
