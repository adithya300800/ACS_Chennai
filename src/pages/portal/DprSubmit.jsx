import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { api } from '../../lib/api.js';
import { uploadBlob } from '../../lib/blobUpload.js';
import { MAX_PHOTO_BYTES, MAX_PHOTOS_PER_DPR, ACCEPTED_PHOTO_TYPES } from '../../lib/constants.js';
import DprCustomSection from './DprCustomSection.jsx';

const WEATHER_OPTIONS = ['Sunny', 'Cloudy', 'Rainy', 'Windy', 'Haze', 'Foggy'];
const DRAFT_KEY = 'dpr_draft_v1';

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

// Round-12: DPR's `workType` is now a category tag, not a derived value.
// All 15 sub-work-types moved to Inspection & Compliance Records, so the
// DPR's workType just needs to classify the day's narrative. Keep the
// backend's required-allowlist intact.
const WORK_TYPE_OPTIONS = [
  { value: 'MATERIAL_RECEIPT', label: 'Material Receipt' },
  { value: 'QUALITY_TESTING', label: 'Quality / Testing' },
  { value: 'SITE_INSPECTION', label: 'Site Inspection' },
  { value: 'EXCEPTIONS_SAFETY', label: 'Exceptions / Safety' },
];

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
      dailyFields: payload.dailyFields,
      notes: payload.notes,
      customSections: payload.customSections,
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

function formatIndianDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function DprSubmit() {
  const { accessToken } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const fileInputRef = useRef(null);
  const submittingRef = useRef(false);

  const initialDraft = loadDraft();
  const [form, setForm] = useState(initialDraft?.form || {
    projectName: '',
    location: '',
    reportDate: getLocalDate(),
    weather: 'Sunny',
    temperature: '',
    contractor: '',
    workType: 'SITE_INSPECTION',
  });
  // Round-12: 5 daily-narrative fields every site engineer records at end
  // of day. Backend caps match the route validator.
  const [dailyFields, setDailyFields] = useState(initialDraft?.dailyFields || {
    workExecutedToday: '',
    workLocation: '',
    manpowerSummary: '',
    risksHindrances: '',
    materialsReceivedSummary: '',
  });
  const [customSections, setCustomSections] = useState(initialDraft?.customSections || []);
  const [photos, setPhotos] = useState([]);
  const [notes, setNotes] = useState(initialDraft?.notes || '');
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');
  const [showDraftBanner, setShowDraftBanner] = useState(!!initialDraft);
  const [uploadStatuses, setUploadStatuses] = useState({});
  const [todayInspections, setTodayInspections] = useState([]);
  const [todayInspectionsLoaded, setTodayInspectionsLoaded] = useState(false);
  const photoObjectUrlsRef = useRef(new Set());

  // Persist draft on every meaningful change. 750ms debounce matches the
  // pre-Round-12 behaviour at the original DprSubmit.jsx:124.
  useEffect(() => {
    const t = setTimeout(
      () => saveDraft({ form, dailyFields, notes, customSections, photos }),
      750
    );
    return () => clearTimeout(t);
  }, [form, dailyFields, notes, customSections, photos]);

  // Revoke any blob URLs we created when the component unmounts.
  useEffect(() => {
    return () => {
      photoObjectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      photoObjectUrlsRef.current.clear();
    };
  }, []);

  // Load today's inspection records so the summary card shows real data
  // while the engineer fills in the DPR. If none exist, the empty state
  // promotes the "Create inspection record →" link.
  const loadTodayInspections = useCallback(async () => {
    if (!accessToken) return;
    setTodayInspectionsLoaded(true);
    try {
      const data = await api.getInspections(
        { reportDate: form.reportDate, limit: '20' },
        accessToken
      );
      setTodayInspections(data.inspections || []);
    } catch {
      setTodayInspections([]);
    }
  }, [accessToken, form.reportDate]);

  useEffect(() => {
    loadTodayInspections();
  }, [loadTodayInspections]);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setForm((f) => ({ ...f, [name]: value }));
  };

  const handleDailyChange = (e) => {
    const { name, value } = e.target;
    setDailyFields((f) => ({ ...f, [name]: value }));
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
        const { sasUrl, ulid } = await api.getDprSasUrl(file.name, file.type, 'dpr-photos', accessToken);
        updateUploadStatus(tempId, { status: 'uploading', progress: 0 });

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
    if (!form.workType) {
      const msg = 'Primary work category is required';
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
      if (photosToSubmit.length === 0 && Object.values(uploadStatuses).some((s) => s.status === 'error')) {
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
          workType: form.workType,
          notes: notes || null,
          status: submitStatus,
          // Round-12: 5 daily-narrative fields.
          workExecutedToday: dailyFields.workExecutedToday || null,
          workLocation: dailyFields.workLocation || null,
          manpowerSummary: dailyFields.manpowerSummary || null,
          risksHindrances: dailyFields.risksHindrances || null,
          materialsReceivedSummary: dailyFields.materialsReceivedSummary || null,
          // User-added ad-hoc text + table sections.
          customSections: Array.isArray(customSections) && customSections.length > 0 ? customSections : null,
          photos: photosToSubmit,
          // workEntries intentionally omitted — moved to Inspection & Compliance Records.
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
      workType: 'SITE_INSPECTION',
    });
    setDailyFields({
      workExecutedToday: '',
      workLocation: '',
      manpowerSummary: '',
      risksHindrances: '',
      materialsReceivedSummary: '',
    });
    setCustomSections([]);
    setNotes('');
    setShowDraftBanner(false);
    toast.push('Draft discarded.', 'info');
  };

  return (
    <div className="dpr-page">
      <div className="dpr-card">
        <h1 className="dpr-page-title">Submit Daily Progress Report</h1>
        <p style={{ color: 'var(--steel)', fontSize: '0.9rem', marginBottom: '1rem' }}>
          Daily narrative for the cover page. Detailed material receipts, cube
          tests, NCRs, and safety records go on the
          {' '}<Link to="/portal/inspection/submit">Inspection &amp; Compliance</Link> page.
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
          {/* Project metadata */}
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

          {/* Primary work category — backend-required tag for filtering on the admin dashboard. */}
          <div className="form-group">
            <label htmlFor="workType">Primary Work Category *</label>
            <select id="workType" name="workType" className="form-input" value={form.workType} onChange={handleChange}>
              {WORK_TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <span style={{ fontSize: '0.75rem', color: 'var(--steel)', marginTop: '0.25rem' }}>
              Classifies today's narrative. Detailed material / QC / safety records
              are filed separately on the Inspection &amp; Compliance page.
            </span>
          </div>

          {/* Round-12: 5 daily-narrative PMC fields. */}
          <fieldset
            style={{
              border: '1px solid #e2e8f0',
              borderRadius: 8,
              padding: '1rem',
              margin: '1.5rem 0',
              background: '#fafbfc',
            }}
          >
            <legend style={{ padding: '0 0.5rem', fontWeight: 600, color: 'var(--navy)', fontSize: '0.9rem' }}>
              Daily Narrative
            </legend>

            <div className="form-group">
              <label htmlFor="workExecutedToday">
                Short notes on today's work
                <span style={{ fontWeight: 400, color: 'var(--steel)' }}> (optional)</span>
              </label>
              <textarea
                id="workExecutedToday"
                name="workExecutedToday"
                className="form-input"
                rows={3}
                value={dailyFields.workExecutedToday}
                onChange={handleDailyChange}
                placeholder="e.g. Villa 4 GF slab casting completed (8 m³ M25); Villa 7 FF columns up to lintel level."
                style={{ resize: 'vertical', minHeight: '80px' }}
              />
              <span style={{ fontSize: '0.75rem', color: 'var(--steel)', marginTop: '0.25rem' }}>
                3–5 sentences. What was actually executed today.
              </span>
            </div>

            <div className="form-group">
              <label htmlFor="workLocation">
                Area of inspection carried out
                <span style={{ fontWeight: 400, color: 'var(--steel)' }}> (optional)</span>
              </label>
              <input
                id="workLocation"
                name="workLocation"
                className="form-input"
                value={dailyFields.workLocation}
                onChange={handleDailyChange}
                placeholder="e.g. Villa 4 – GF Slab & Villa 7 – FF Columns"
              />
              <span style={{ fontSize: '0.75rem', color: 'var(--steel)', marginTop: '0.25rem' }}>
                Villa / block / floor or area reference.
              </span>
            </div>

            <div className="form-group">
              <label htmlFor="manpowerSummary">
                Man power
                <span style={{ fontWeight: 400, color: 'var(--steel)' }}> (optional)</span>
              </label>
              <textarea
                id="manpowerSummary"
                name="manpowerSummary"
                className="form-input"
                rows={2}
                value={dailyFields.manpowerSummary}
                onChange={handleDailyChange}
                placeholder="Mason — 6 nos — 8 hrs | Helper — 4 nos — 8 hrs | Electrician — 1 no — 4 hrs"
              />
              <span style={{ fontSize: '0.75rem', color: 'var(--steel)', marginTop: '0.25rem' }}>
                One trade per line: Trade — count — hours. Pipe-separate multiple trades.
              </span>
            </div>

            <div className="form-group">
              <label htmlFor="risksHindrances">
                Any risks
                <span style={{ fontWeight: 400, color: 'var(--steel)' }}> (optional)</span>
              </label>
              <textarea
                id="risksHindrances"
                name="risksHindrances"
                className="form-input"
                rows={3}
                value={dailyFields.risksHindrances}
                onChange={handleDailyChange}
                placeholder="Heavy rain forecast 14:00 — slab pour may need to reschedule. Plastering at Villa 9 awaiting client shade approval."
                style={{ resize: 'vertical', minHeight: '80px' }}
              />
              <span style={{ fontSize: '0.75rem', color: 'var(--steel)', marginTop: '0.25rem' }}>
                Weather, labour, material, equipment, statutory, client — anything
                that could affect tomorrow's plan.
              </span>
            </div>

            <div className="form-group">
              <label htmlFor="materialsReceivedSummary">
                Any materials received
                <span style={{ fontWeight: 400, color: 'var(--steel)' }}> (optional)</span>
              </label>
              <textarea
                id="materialsReceivedSummary"
                name="materialsReceivedSummary"
                className="form-input"
                rows={2}
                value={dailyFields.materialsReceivedSummary}
                onChange={handleDailyChange}
                placeholder="OPC 53 cement — 50 bags (ACC); M-sand — 4 Cu.m (ABC quarry); 12 mm TMT — 1.2 MT (TATA)"
              />
              <span style={{ fontSize: '0.75rem', color: 'var(--steel)', marginTop: '0.25rem' }}>
                High-level rollup. Detailed material inspections go on the
                Inspection &amp; Compliance page.
              </span>
            </div>
          </fieldset>

          {/* Kept for backward-compat — generic notes catchall. */}
          <div className="form-group">
            <label htmlFor="notes">
              Other observations
              <span style={{ fontWeight: 400, color: 'var(--steel)' }}> (optional)</span>
            </label>
            <textarea
              id="notes"
              name="notes"
              className="form-input"
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Anything else worth recording for this report..."
              style={{ resize: 'vertical', minHeight: '60px' }}
            />
          </div>

          {/* Photos */}
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

          {/* User-added ad-hoc sections (text + tables). */}
          <div style={{ marginTop: '1.5rem' }}>
            <DprCustomSection value={customSections} onChange={setCustomSections} />
          </div>

          {/* Today's inspection records summary card — links to the Inspection & Compliance page. */}
          <div
            className="dpr-card"
            style={{
              marginTop: '1.5rem',
              background: '#f8fafc',
              borderLeft: '3px solid var(--blue)',
            }}
          >
            <h3 style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontSize: '1rem', marginBottom: '0.5rem', color: 'var(--navy)' }}>
              Today's Inspection &amp; Compliance Records
            </h3>
            {todayInspectionsLoaded && todayInspections.length === 0 ? (
              <p style={{ color: 'var(--steel)', fontSize: '0.9rem', margin: 0 }}>
                None filed yet for {formatIndianDate(form.reportDate)}.
                {' '}
                <Link to={`/portal/inspection/submit?date=${form.reportDate}`}>
                  Create inspection record →
                </Link>
              </p>
            ) : !todayInspectionsLoaded ? (
              <p style={{ color: 'var(--steel)', fontSize: '0.9rem', margin: 0 }}>Loading…</p>
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                {todayInspections.slice(0, 5).map((insp) => (
                  <li key={insp.id} style={{ fontSize: '0.9rem' }}>
                    <Link to={`/portal/inspection/${insp.id}`}>{insp.inspectionType}</Link>
                    {' · '}
                    <span style={{ color: 'var(--steel)' }}>{insp.location}</span>
                    {' · '}
                    <span style={{ color: 'var(--steel)' }}>{insp.status}</span>
                  </li>
                ))}
                {todayInspections.length > 5 && (
                  <li style={{ color: 'var(--steel)', fontSize: '0.85rem' }}>
                    + {todayInspections.length - 5} more on the Inspection page.
                  </li>
                )}
                <li style={{ marginTop: '0.5rem' }}>
                  <Link to={`/portal/inspection/submit?date=${form.reportDate}`}>
                    + Create inspection record
                  </Link>
                </li>
              </ul>
            )}
          </div>

          <div className="dpr-form-actions" style={{ marginTop: '1.5rem' }}>
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
