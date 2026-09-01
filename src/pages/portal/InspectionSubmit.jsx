import React, { useState, useRef, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { api } from '../../lib/api.js';
import { uploadBlob } from '../../lib/blobUpload.js';
import {
  MAX_PHOTO_BYTES, MAX_PHOTOS_PER_DPR, ACCEPTED_PHOTO_TYPES,
} from '../../lib/constants.js';
import WorkEntryAdder from './WorkEntryAdder.jsx';

const WEATHER_OPTIONS = ['Sunny', 'Cloudy', 'Rainy', 'Windy', 'Haze', 'Foggy'];
const DRAFT_KEY = 'inspection_draft_v1';

const getLocalDate = () => {
  const now = new Date();
  const offset = now.getTimezoneOffset();
  const local = new Date(now - offset * 60000);
  return local.toISOString().split('T')[0];
};

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
    const safe = {
      form: payload.form,
      workEntry: payload.workEntry ? { workType: payload.workEntry.workType } : null,
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

export default function InspectionSubmit() {
  const { accessToken } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const fileInputRef = useRef(null);
  const submittingRef = useRef(false);

  // Optional dprId / reportDate in URL — when an engineer clicks "Create
  // inspection record" from the DPR summary card, we deep-link with both so
  // they don't have to re-pick the date.
  const queryDprId = searchParams.get('dpr') || null;
  const queryDate = searchParams.get('date') || null;

  const initialDraft = loadDraft();
  const [form, setForm] = useState(initialDraft?.form || {
    projectName: '',
    location: '',
    reportDate: queryDate || getLocalDate(),
    weather: '',
    contractor: '',
  });
  const [workEntry, setWorkEntry] = useState(initialDraft?.workEntry || null);
  const [photos, setPhotos] = useState([]);
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');
  const [showDraftBanner, setShowDraftBanner] = useState(!!initialDraft);
  const [uploadStatuses, setUploadStatuses] = useState({});
  const [prefillAttempted, setPrefillAttempted] = useState(false);
  const photoObjectUrlsRef = useRef(new Set());

  // Best-effort pre-fill of project/location from the latest submitted DPR
  // today. Runs once. If no DPR exists for today, the engineer types the
  // values manually (matching the round-12 design — inspections can be
  // filed on holidays / Sundays where no DPR exists).
  useEffect(() => {
    if (prefillAttempted) return;
    if (form.projectName && form.location) {
      setPrefillAttempted(true);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const today = getLocalDate();
        const data = await api.getDprs({ from: today, to: today, limit: '1' }, accessToken);
        const latest = (data.dprs || [])[0];
        if (!cancelled && latest && !form.projectName) {
          setForm((f) => ({
            ...f,
            projectName: latest.projectName || f.projectName,
            location: latest.location || f.location,
            contractor: latest.contractor || f.contractor,
            weather: latest.weather || f.weather,
          }));
        }
      } catch {
        // Non-fatal — engineer can type it.
      } finally {
        if (!cancelled) setPrefillAttempted(true);
      }
    })();
    return () => { cancelled = true; };
    // intentionally only on mount — the user can override the prefill fields
    // afterwards and we don't want to overwrite their edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist draft (debounced 750ms — matches DPR pattern at DprSubmit.jsx:124).
  useEffect(() => {
    const t = setTimeout(() => saveDraft({ form, workEntry, photos }), 750);
    return () => clearTimeout(t);
  }, [form, workEntry, photos]);

  // Cleanup blob URLs on unmount.
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

    const completed = [];
    const failed = [];

    for (const file of valid) {
      const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const previewUrl = URL.createObjectURL(file);
      photoObjectUrlsRef.current.add(previewUrl);
      updateUploadStatus(tempId, { status: 'uploading', progress: 0, filename: file.name });

      try {
        const { sasUrl, ulid } = await api.getInspectionSasUrl(file.name, file.type, accessToken);
        updateUploadStatus(tempId, { status: 'uploading', progress: 0 });

        await uploadBlob(sasUrl, file, {
          contentType: file.type,
          onProgress: (pct) => updateUploadStatus(tempId, { status: 'uploading', progress: pct }),
        });

        await api.confirmInspectionUpload(ulid, file.name, file.type, file.size, accessToken);

        updateUploadStatus(tempId, { status: 'complete', progress: 100 });
        completed.push({
          ulid,
          container: 'inspection-photos',
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
      }
    }

    if (completed.length > 0) setPhotos((p) => [...p, ...completed]);
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

  const handleSubmit = async (submitStatus) => {
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
    if (!workEntry) {
      const msg = 'Please add an inspection record before submitting';
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

    setStatus('submitting');

    try {
      const photosToSubmit = photos
        .filter((p) => p.ulid)
        .map(({ ulid, container, filename, contentType, sizeBytes, caption, location, takenAt }) => ({
          ulid, container, filename, contentType, sizeBytes, caption, location, takenAt,
        }));

      await api.createInspection(
        {
          projectName: form.projectName,
          location: form.location,
          reportDate: form.reportDate,
          weather: form.weather || null,
          contractor: form.contractor || null,
          dprId: queryDprId || null,
          inspectionType: workEntry.workType,
          data: workEntry.data,
          status: submitStatus === 'DRAFT' ? 'OPEN' : 'OPEN',
          // Round-12 MVP: severity is not asked at submit time. The
          // Inspection page surfaces it on the detail view for NCR / safety
          // sub-types where the structured data already implies severity
          // (e.g. `severity` field in the NCR / safety_violation schema).
          severity: null,
          photos: photosToSubmit,
        },
        accessToken
      );

      clearDraft();
      toast.push(submitStatus === 'DRAFT' ? 'Draft saved.' : 'Inspection record submitted.', 'success');
      navigate('/portal/inspection/my');
    } catch (err) {
      const msg = err.message || 'Failed to submit inspection record';
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
      reportDate: queryDate || getLocalDate(),
      weather: '',
      contractor: '',
    });
    setWorkEntry(null);
    setPhotos([]);
    setShowDraftBanner(false);
    toast.push('Draft discarded.', 'info');
  };

  return (
    <div className="dpr-page">
      <div className="dpr-card">
        <h1 className="dpr-page-title">New Inspection / Compliance Record</h1>
        <p style={{ color: 'var(--steel)', marginBottom: '1rem', fontSize: '0.9rem' }}>
          File a structured inspection record — material receipt, cube test, water
          quality, waterproofing, NCR, safety violation, etc. One record per submission.
        </p>

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
              <input
                id="projectName"
                name="projectName"
                className="form-input"
                value={form.projectName}
                onChange={handleChange}
                placeholder="e.g. Metro Station Phase 2"
              />
            </div>
            <div className="form-group" style={{ flex: 1 }}>
              <label htmlFor="reportDate">Report Date *</label>
              <input
                id="reportDate"
                type="date"
                name="reportDate"
                className="form-input"
                value={form.reportDate}
                onChange={handleChange}
              />
            </div>
          </div>

          <div className="form-group">
            <label htmlFor="location">Location *</label>
            <input
              id="location"
              name="location"
              className="form-input"
              value={form.location}
              onChange={handleChange}
              placeholder="Site address or location description"
            />
          </div>

          <div className="form-row">
            <div className="form-group">
              <label htmlFor="weather">Weather</label>
              <select id="weather" name="weather" className="form-input" value={form.weather} onChange={handleChange}>
                <option value="">—</option>
                {WEATHER_OPTIONS.map((w) => <option key={w} value={w}>{w}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label htmlFor="contractor">Contractor</label>
              <input
                id="contractor"
                name="contractor"
                className="form-input"
                value={form.contractor}
                onChange={handleChange}
                placeholder="Contractor name"
              />
            </div>
          </div>

          <div className="form-group">
            <label>Inspection Record *</label>
            {workEntry && (
              <div className="work-entries-list">
                <div className="work-entry-card">
                  <div className="work-entry-card-header">
                    <span className="work-entry-card-title">{workEntry.workType}</span>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => setWorkEntry(null)}
                      aria-label="Remove inspection record"
                    >×</button>
                  </div>
                  <div className="work-entry-card-body">
                    {Object.entries(workEntry.data).slice(0, 4).map(([key, val]) => (
                      <div key={key} className="work-entry-card-field">
                        <span className="work-entry-card-label">{key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase())}:</span>
                        <span className="work-entry-card-value">{Array.isArray(val) ? val.join(', ') : String(val)}</span>
                      </div>
                    ))}
                    {Object.keys(workEntry.data).length > 4 && (
                      <span className="work-entry-card-more">+ {Object.keys(workEntry.data).length - 4} more fields</span>
                    )}
                  </div>
                </div>
              </div>
            )}
            {!workEntry && <WorkEntryAdder onAdd={setWorkEntry} sectionLabel="Add Inspection Record" />}
          </div>

          <div className="form-group">
            <label>Photos (max {MAX_PHOTOS_PER_DPR})</label>
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
              {status === 'submitting' ? 'Submitting...' : 'Submit Record'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
