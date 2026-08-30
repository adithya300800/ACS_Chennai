import React, { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { api } from '../../lib/api.js';
import { uploadBlob } from '../../lib/blobUpload.js';
import { MAX_PHOTO_BYTES, MAX_PHOTOS_PER_DPR, ACCEPTED_PHOTO_TYPES } from '../../lib/constants.js';
import DprWorkEntryAdder from './DprWorkEntryAdder.jsx';
import { SUB_WORK_TYPE_OPTIONS } from './DprWorkTypes.jsx';

const WEATHER_OPTIONS = ['Sunny', 'Cloudy', 'Rainy', 'Windy', 'Haze', 'Foggy'];
const DRAFT_KEY = 'dpr_draft_v1';

// Auto-set date to user's local timezone (no manual selection)
const getLocalDate = () => {
  const now = new Date();
  const offset = now.getTimezoneOffset();
  const local = new Date(now.getTime() - offset * 60000);
  return local.toISOString().split('T')[0];
};

// Reject future-dated and malformed dates before they hit the backend.
// Backend already validates this server-side (parseStrictISODate in
// backend/src/lib/errors.js), but a client-side check turns the error
// into a friendly toast instead of a 400 response the user has to
// decipher.
const validateReportDate = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return 'Report date must be in YYYY-MM-DD format. Please refresh the page.';
  }
  const today = new Date();
  today.setHours(23, 59, 59, 999);
  if (new Date(value) > today) return 'Report date cannot be in the future.';
  return null;
};

function loadDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveDraft(payload) {
  try {
    // Strip blobs (don't serialize) and blob URLs (don't persist)
    const safe = {
      form: payload.form,
      notes: payload.notes,
      workEntries: payload.workEntries,
      photos: (payload.photos || []).map((p) => ({
        ulid: p.ulid,
        container: p.container,
        filename: p.filename,
        contentType: p.contentType,
        sizeBytes: p.sizeBytes,
        caption: p.caption,
        location: p.location,
        takenAt: p.takenAt,
      })),
    };
    localStorage.setItem(DRAFT_KEY, JSON.stringify(safe));
  } catch {}
}

function clearDraft() {
  try { localStorage.removeItem(DRAFT_KEY); } catch {}
}

// Backend allowlist (must match backend/src/routes/dpr.js validWorkTypes).
// Production-readiness P0-3: the backend silently defaults workType to
// MATERIAL_RECEIPT if the field is absent, so every DPR was being mis-tagged.
// We derive the top-level workType from the first work entry's section —
// this keeps the frontend source-of-truth (one entry == one section) in
// sync with the database column.
const ALLOWED_WORK_TYPES = ['MATERIAL_RECEIPT', 'QUALITY_TESTING', 'SITE_INSPECTION', 'EXCEPTIONS_SAFETY'];

function deriveTopLevelWorkType(workEntries) {
  if (!Array.isArray(workEntries) || workEntries.length === 0) return null;
  const firstType = workEntries[0]?.workType;
  if (!firstType) return null;
  const found = SUB_WORK_TYPE_OPTIONS.find((s) => s.value === firstType);
  const section = found?.section;
  return ALLOWED_WORK_TYPES.includes(section) ? section : null;
}

export default function DprSubmit() {
  const { accessToken } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const fileInputRef = useRef(null);
  // Production-readiness P0-11 / P1-2: prevent double-click from firing two
  // parallel POSTs. State (`status`) is updated async after the first click
  // and React batches the state-set + button-disable, leaving a 1-2 frame
  // window where the user can click the second button. A useRef guard is
  // synchronous and immune to React render scheduling.
  const submittingRef = useRef(false);

  const initialDraft = loadDraft();
  const [form, setForm] = useState(initialDraft?.form || {
    projectName: '',
    location: '',
    reportDate: getLocalDate(),
    weather: 'Sunny',
    temperature: '',
    contractor: '',
  });
  const [photos, setPhotos] = useState([]); // previewUrl is rebuilt on mount from scratch
  const [workEntries, setWorkEntries] = useState(initialDraft?.workEntries || []);
  const [notes, setNotes] = useState(initialDraft?.notes || '');
  const [status, setStatus] = useState('idle'); // idle | uploading | submitting | error
  const [error, setError] = useState('');
  const [showDraftBanner, setShowDraftBanner] = useState(!!initialDraft);
  // Per-file upload status: { id: { status, progress, error } }
  const [uploadStatuses, setUploadStatuses] = useState({});
  const photoObjectUrlsRef = useRef(new Set());

  // Persist draft on every meaningful change. Don't include previewUrl /
  // file / blob refs — JSON.stringify would either drop them or store
  // useless data. Save at most every 750ms to avoid disk thrash.
  useEffect(() => {
    const t = setTimeout(() => saveDraft({ form, notes, workEntries, photos }), 750);
    return () => clearTimeout(t);
  }, [form, notes, workEntries, photos]);

  // Revoke any blob URLs we created when the component unmounts so the
  // tab doesn't leak memory on long-running sessions.
  useEffect(() => {
    return () => {
      photoObjectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      photoObjectUrlsRef.current.clear();
    };
  }, []);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setForm((f) => ({ ...f, [name]: value }));
  };

  const removePhoto = (idx) => {
    setPhotos((p) => {
      const removed = p[idx];
      if (removed?.previewUrl) {
        URL.revokeObjectURL(removed.previewUrl);
        photoObjectUrlsRef.current.delete(removed.previewUrl);
      }
      return p.filter((_, i) => i !== idx);
    });
    setUploadStatuses((s) => {
      const next = { ...s };
      delete next[idx];
      return next;
    });
  };

  const updateUploadStatus = (tempId, patch) => {
    setUploadStatuses((s) => ({ ...s, [tempId]: { ...(s[tempId] || {}), ...patch } }));
  };

  const handleFiles = async (files) => {
    const arr = Array.from(files);
    const valid = arr.filter(
      (f) => ACCEPTED_PHOTO_TYPES.includes(f.type) && f.size <= MAX_PHOTO_BYTES
    );
    if (valid.length === 0) {
      const msg = `Select valid images (jpg/png/webp, max ${MAX_PHOTO_BYTES / 1024 / 1024}MB each)`;
      setError(msg);
      toast.push(msg, 'warning');
      return;
    }
    if (photos.length + valid.length > MAX_PHOTOS_PER_DPR) {
      const msg = `Max ${MAX_PHOTOS_PER_DPR} photos allowed`;
      setError(msg);
      toast.push(msg, 'warning');
      return;
    }

    setError('');

    // Per-file statuses tracked separately so one failed upload doesn't
    // poison the rest of the batch (Bug #5). Successful files still get
    // added; failed ones surface inline + as a toast.
    const completed = [];
    const failed = [];

    for (const file of valid) {
      const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const previewUrl = URL.createObjectURL(file);
      photoObjectUrlsRef.current.add(previewUrl);
      updateUploadStatus(tempId, { status: 'uploading', progress: 0, filename: file.name });

      try {
        const { sasUrl, ulid } = await api.getDprSasUrl(file.name, file.type, 'dpr-photos', accessToken);
        updateUploadStatus(tempId, { status: 'uploading', progress: 0 });

        // PUT to blob with real progress + 60s timeout. Previously a raw
        // fetch() with no timeout and no progress — the bar would jump
        // 0% → 50% → 100% and would never resolve if Azure hung (Aug 29
        // 2026 user report: "uploading photo struck forever at 0%").
        await uploadBlob(sasUrl, file, {
          contentType: file.type,
          onProgress: (pct) => updateUploadStatus(tempId, { status: 'uploading', progress: pct }),
        });

        await api.confirmUpload(ulid, 'dpr-photos', file.name, file.type, file.size, accessToken);

        updateUploadStatus(tempId, { status: 'complete', progress: 100 });
        completed.push({
          ulid,
          container: 'dpr-photos',
          filename: file.name,
          contentType: file.type,
          sizeBytes: file.size,
          caption: '',
          location: '',
          takenAt: new Date().toISOString(),
          previewUrl,
        });
      } catch (err) {
        updateUploadStatus(tempId, { status: 'error', error: err.message, filename: file.name });
        failed.push({ filename: file.name, error: err.message });
        // Continue with the rest of the batch
      }
    }

    // Append successful uploads in original order; failed ones keep their
    // status entry but no photo entry — user can re-select them.
    if (completed.length > 0) {
      setPhotos((p) => [...p, ...completed]);
    }
    if (failed.length > 0) {
      const summary = failed.length === 1
        ? `Failed to upload ${failed[0].filename}: ${failed[0].error}`
        : `Failed to upload ${failed.length} photo${failed.length !== 1 ? 's' : ''}.`;
      toast.push(summary, 'error');
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    handleFiles(e.dataTransfer.files);
  };

  const handleAddWorkEntry = (entry) => {
    setWorkEntries((prev) => [...prev, entry]);
  };

  const handleRemoveWorkEntry = (idx) => {
    setWorkEntries((prev) => prev.filter((_, i) => i !== idx));
  };

  const getWorkEntryLabel = (workType) => {
    const found = SUB_WORK_TYPE_OPTIONS.find((s) => s.value === workType);
    return found ? found.label : workType;
  };

  const handleSubmit = async (submitStatus) => {
    // Production-readiness P0-11: synchronous re-entry guard. React's
    // onClick → setState → re-render path is async, so without this ref a
    // second click before the re-render reaches the disabled button would
    // fire a duplicate POST. A ref is checked synchronously and cleared
    // in the finally block so retries work after errors.
    if (submittingRef.current) return;
    submittingRef.current = true;

    setError('');
    if (!form.projectName || !form.location || !form.reportDate) {
      const msg = 'Project name, location, and date are required';
      setError(msg);
      toast.push(msg, 'warning');
      submittingRef.current = false;
      return;
    }
    if (workEntries.length === 0) {
      const msg = 'Please add at least one work entry before submitting';
      setError(msg);
      toast.push(msg, 'warning');
      submittingRef.current = false;
      return;
    }
    const dateErr = validateReportDate(form.reportDate);
    if (dateErr) {
      setError(dateErr);
      toast.push(dateErr, 'warning');
      submittingRef.current = false;
      return;
    }

    // Production-readiness P0-3: derive top-level workType from the first
    // work entry's section. Backend allowlist is the source of truth; the
    // SUB_WORK_TYPE_OPTIONS list maps each entry to one of the 4 sections.
    const topLevelWorkType = deriveTopLevelWorkType(workEntries);
    if (!topLevelWorkType) {
      const msg = 'Could not determine DPR workType from the work entries.';
      setError(msg);
      toast.push(msg, 'warning');
      submittingRef.current = false;
      return;
    }

    setStatus('submitting');

    try {
      const photosToSubmit = photos
        .filter((p) => p.ulid) // only successfully uploaded photos
        .map(({ ulid, container, filename, contentType, sizeBytes, caption, location, takenAt }) => ({
          ulid, container, filename, contentType, sizeBytes, caption, location, takenAt,
        }));
      if (photosToSubmit.length === 0 && uploadStatuses && Object.values(uploadStatuses).some((s) => s.status === 'error')) {
        // All uploads failed — don't pretend the form is submittable.
        const msg = 'All photo uploads failed. Please re-add photos before submitting.';
        setError(msg);
        setStatus('idle');
        toast.push(msg, 'error');
        submittingRef.current = false;
        return;
      }

      await api.createDpr(
        {
          projectName: form.projectName,
          location: form.location,
          reportDate: form.reportDate,
          weather: form.weather,
          temperature: form.temperature,
          contractor: form.contractor,
          workType: topLevelWorkType,
          notes: notes || null,
          status: submitStatus,
          photos: photosToSubmit,
          workEntries: workEntries.map(({ workType, data, addedAt }) => ({ workType, data, addedAt })),
        },
        accessToken
      );

      clearDraft();
      toast.push(submitStatus === 'DRAFT' ? 'Draft saved.' : 'DPR submitted successfully.', 'success');
      navigate('/portal/dpr/my');
    } catch (err) {
      const msg = err.message || 'Failed to submit DPR';
      setError(msg);
      setStatus('idle');
      if (err.status !== 401) toast.push(msg, 'error');
    } finally {
      submittingRef.current = false;
    }
  };

  const handleDiscardDraft = () => {
    clearDraft();
    setForm({
      projectName: '',
      location: '',
      reportDate: getLocalDate(),
      weather: 'Sunny',
      temperature: '',
      contractor: '',
    });
    setWorkEntries([]);
    setNotes('');
    setShowDraftBanner(false);
    toast.push('Draft discarded.', 'info');
  };

  return (
    <div className="dpr-page">
      <div className="dpr-card">
        <h1 className="dpr-page-title">Submit Daily Progress Report</h1>

        {showDraftBanner && (
          <div
            role="status"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.75rem',
              padding: '0.75rem 1rem',
              background: '#eff6ff',
              border: '1px solid #bfdbfe',
              borderRadius: 6,
              marginBottom: '1rem',
              fontSize: '0.875rem',
              color: '#1e40af',
            }}
          >
            <span style={{ flex: 1 }}>📝 Restored unsaved draft from your previous visit.</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowDraftBanner(false)}>
              Dismiss
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={handleDiscardDraft}>
              Discard
            </button>
          </div>
        )}

        {error && <div className="portal-auth-error" style={{ marginBottom: '1rem' }}>{error}</div>}

        <div className="dpr-form">
          <div className="form-row">
            <div className="form-group" style={{ flex: 2 }}>
              <label htmlFor="projectName">Project Name *</label>
              <input id="projectName" name="projectName" className="form-input" value={form.projectName} onChange={handleChange} placeholder="e.g. Metro Station Phase 2" />
            </div>
            <div className="form-group" style={{ flex: 1 }}>
              <label htmlFor="reportDate">Report Date</label>
              <input id="reportDate" type="date" name="reportDate" className="form-input" value={form.reportDate} readOnly style={{ background: '#f1f5f9', cursor: 'default' }} />
              <span style={{ fontSize: '0.75rem', color: 'var(--steel)', marginTop: '0.25rem' }}>Auto-set to your local date</span>
            </div>
          </div>

          <div className="form-group">
            <label htmlFor="location">Location *</label>
            <input id="location" name="location" className="form-input" value={form.location} onChange={handleChange} placeholder="Site address or location description" />
          </div>

          <div className="form-row">
            <div className="form-group">
              <label htmlFor="weather">Weather</label>
              <select id="weather" name="weather" className="form-input" value={form.weather} onChange={handleChange}>
                {WEATHER_OPTIONS.map((w) => <option key={w} value={w}>{w}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label htmlFor="temperature">Temperature</label>
              <input id="temperature" name="temperature" className="form-input" value={form.temperature} onChange={handleChange} placeholder="e.g. 32°C" />
            </div>
            <div className="form-group">
              <label htmlFor="contractor">Contractor</label>
              <input id="contractor" name="contractor" className="form-input" value={form.contractor} onChange={handleChange} placeholder="Contractor name" />
            </div>
          </div>

          <div className="form-group">
            <label htmlFor="notes">Notes / Comments <span style={{ fontWeight: 400, color: 'var(--steel)' }}>(optional)</span></label>
            <textarea
              id="notes"
              name="notes"
              className="form-input"
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Additional observations, remarks, or issues noted on site..."
              style={{ resize: 'vertical', minHeight: '80px' }}
            />
          </div>

          <div className="form-group">
            <label>Work Entries *</label>
            {workEntries.length > 0 && (
              <div className="work-entries-list">
                {workEntries.map((entry, idx) => (
                  <div key={idx} className={`work-entry-card ${entry.data.overallStatus === 'Fail' || entry.data.result === 'Fail' || entry.data.overallStatus === 'Unapproved' ? 'entry-critical' : ''}`}>
                    <div className="work-entry-card-header">
                      <span className="work-entry-card-title">{getWorkEntryLabel(entry.workType)}</span>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => handleRemoveWorkEntry(idx)} aria-label="Remove work entry">×</button>
                    </div>
                    <div className="work-entry-card-body">
                      {Object.entries(entry.data).slice(0, 4).map(([key, val]) => (
                        <div key={key} className="work-entry-card-field">
                          <span className="work-entry-card-label">{key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase())}:</span>
                          <span className="work-entry-card-value">{Array.isArray(val) ? val.join(', ') : String(val)}</span>
                        </div>
                      ))}
                      {Object.keys(entry.data).length > 4 && (
                        <span className="work-entry-card-more">+ {Object.keys(entry.data).length - 4} more fields</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
            <DprWorkEntryAdder onAdd={handleAddWorkEntry} />
          </div>

          <div className="form-group">
            <label>Site Photos (max {MAX_PHOTOS_PER_DPR})</label>
            <div
              className="photo-upload-zone"
              onDrop={handleDrop}
              onDragOver={(e) => e.preventDefault()}
              onClick={() => fileInputRef.current?.click()}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInputRef.current?.click(); } }}
              aria-label="Add photos"
            >
              <svg width="32" height="32" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg>
              <p>Drag &amp; drop photos or click to browse</p>
              <span>JPG, PNG, WebP — max {MAX_PHOTO_BYTES / 1024 / 1024}MB each</span>
            </div>
            <input ref={fileInputRef} type="file" accept={ACCEPTED_PHOTO_TYPES.join(',')} multiple style={{ display: 'none' }} onChange={(e) => handleFiles(e.target.files)} />

            {photos.length > 0 && (
              <div className="photo-grid">
                {photos.map((photo, idx) => (
                  <div key={photo.ulid || idx} className="photo-thumb">
                    <img src={photo.previewUrl} alt={photo.caption || 'Site photo'} />
                    <button type="button" className="photo-remove" onClick={() => removePhoto(idx)} aria-label="Remove photo">×</button>
                    <input
                      className="photo-caption-input"
                      placeholder="Caption..."
                      value={photo.caption}
                      onChange={(e) => {
                        const updated = [...photos];
                        updated[idx] = { ...updated[idx], caption: e.target.value };
                        setPhotos(updated);
                      }}
                      aria-label="Photo caption"
                    />
                  </div>
                ))}
              </div>
            )}

            {/* Per-file status (visible only during an in-progress batch) */}
            {Object.values(uploadStatuses).some((s) => s.status === 'uploading' || s.status === 'error') && (
              <div style={{ marginTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                {Object.entries(uploadStatuses).map(([id, s]) =>
                  s.status === 'uploading' || s.status === 'error' ? (
                    <div
                      key={id}
                      style={{
                        fontSize: '0.8rem',
                        color: s.status === 'error' ? '#dc2626' : 'var(--steel)',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.5rem',
                      }}
                    >
                      <span>{s.status === 'uploading' ? '⏳' : '⚠️'}</span>
                      <span>{s.filename}</span>
                      {s.status === 'uploading' && <span>{s.progress}%</span>}
                      {s.status === 'error' && <span style={{ opacity: 0.85 }}>— {s.error}</span>}
                    </div>
                  ) : null
                )}
              </div>
            )}
          </div>

          <div className="dpr-form-actions">
            <button type="button" className="btn btn-secondary" onClick={() => handleSubmit('DRAFT')} disabled={status === 'submitting'}>
              {status === 'submitting' ? 'Saving...' : 'Save as Draft'}
            </button>
            <button type="button" className="btn btn-primary" onClick={() => handleSubmit('SUBMITTED')} disabled={status === 'submitting'}>
              {status === 'submitting' ? 'Submitting...' : 'Submit Report'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
