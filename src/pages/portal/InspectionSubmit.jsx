import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { api } from '../../lib/api.js';
import { uploadBlob } from '../../lib/blobUpload.js';
import {
  MAX_PHOTO_BYTES, MAX_PHOTOS_PER_DPR, ACCEPTED_PHOTO_TYPES,
} from '../../lib/constants.js';
import WorkEntryAdder from './WorkEntryAdder.jsx';
import FormProgress from '../../components/FormProgress.jsx';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';
import { loadDiagnostic as loadScopedDraft, save as saveScopedDraft, clear as clearScopedDraft } from '../../lib/ownerScopedDraft.js';

const WEATHER_OPTIONS = ['Sunny', 'Cloudy', 'Rainy', 'Windy', 'Haze', 'Foggy'];
const DRAFT_BASE = 'inspection_draft_v1';
// SOL DR-001: bumped to v2 after a serializer bug dropped workEntry.data
// during autosave. v1 drafts (no __v, workEntry.data missing) are surfaced as
// "malformed" so the user can discard instead of crashing on reload.
const DRAFT_SCHEMA_VERSION = 2;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// A-11: section skip-nav anchors. Keep in sync with the <section id>
// attributes below — used by the sticky in-form nav at the top of the page.
const INSPECTION_SECTIONS = [
  { id: 'inspection-section-site', label: 'Site Info' },
  { id: 'inspection-section-record', label: 'Inspection Record' },
  { id: 'inspection-section-photos', label: 'Photos' },
];

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

// SOL DR-003: the owner-scoped draft helpers wrap the raw localStorage
// access so the per-user scoping + one-time legacy migration stay in one
// place. The `loadDraft`/`saveDraft`/`clearDraft` wrappers below just
// thread the current employee id through.
function loadDraftForEmployee(employeeId) {
  // Diagnostic read so we can surface a malformed-draft banner when the
  // underlying localStorage entry exists but is unreadable. `load` alone
  // collapses "no draft" and "corrupt JSON" into the same null result,
  // which silently loses the user's data instead of telling them.
  const { value: raw, corrupt } = loadScopedDraft(DRAFT_BASE, employeeId);
  if (corrupt) return { __malformed: true, reason: 'corrupt-storage' };
  if (raw === null) return null;
  // SOL DR-001: detect v1 drafts that lost structured workEntry.data.
  // A well-formed v2 draft always has __v === 2 and, if workEntry is set,
  // includes a `data` object. Anything else is treated as malformed so the
  // user sees an explicit recover/discard banner instead of a crash on
  // render.
  if (!isObject(raw)) return { __malformed: true, reason: 'corrupt-shape' };
  const version = raw.__v;
  if (version !== DRAFT_SCHEMA_VERSION) {
    return { __malformed: true, reason: 'legacy-shape', payload: raw };
  }
  if (raw.workEntry !== null && raw.workEntry !== undefined) {
    if (!isObject(raw.workEntry) || !isObject(raw.workEntry.data)) {
      return { __malformed: true, reason: 'workentry-data-missing', payload: raw };
    }
  }
  return raw;
}

function saveDraftForEmployee(employeeId, payload) {
  const safe = {
    __v: DRAFT_SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    form: payload.form,
    // SOL DR-001: previous serializer only kept `workType`, dropping the
    // structured field data the renderer needs (see render at lines ~473).
    // Persist the full entry — `data` is required for the inspection card
    // and for submit.
    workEntry: payload.workEntry
      ? {
          workType: payload.workEntry.workType,
          data: payload.workEntry.data || {},
          addedAt: payload.workEntry.addedAt || null,
        }
      : null,
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
  saveScopedDraft(DRAFT_BASE, employeeId, safe);
}

function clearDraftForEmployee(employeeId) {
  clearScopedDraft(DRAFT_BASE, employeeId);
}

// No-employee wrappers retained for the legacy `Discard` button which is
// triggered before the user explicitly clicks "new draft". In practice the
// component always has an employee id by the time the user reaches a
// working draft, but if a draft was loaded pre-login (it shouldn't be) we
// still want the explicit Discard path to wipe something.
function loadDraft() { return loadDraftForEmployee(null); }
function saveDraft() {/* no-op: never write an unscoped draft */}
function clearDraft() {/* no-op: never wipe an unscoped draft */}

export default function InspectionSubmit() {
  useDocumentTitle('New Inspection / Compliance Record');
  const { accessToken, employee } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const fileInputRef = useRef(null);
  const submittingRef = useRef(false);
  // S5 audit: per-field refs so validation failure can move focus to the
  // first invalid input (WCAG 3.3.1 — Error Identification). The form
  // has six inputs grouped in three sections; only the three that are
  // validated-on-submit (projectName, location, reportDate) + the
  // workEntry region need a ref for focus-to-first-invalid to work.
  const projectNameRef = useRef(null);
  const locationRef = useRef(null);
  const reportDateRef = useRef(null);
  const workEntryRef = useRef(null);

  // Optional dprId / reportDate in URL — when an engineer clicks "Create
  // inspection record" from the DPR summary card, we deep-link with both so
  // they don't have to re-pick the date.
  const queryDprId = searchParams.get('dpr') || null;
  const queryDate = searchParams.get('date') || null;

  // SOL DR-003: every draft read/write is keyed by employeeId. If the
  // auth context has not populated yet (very first render), we treat that
  // as "no draft" — once `employee` becomes truthy the autosave useEffect
  // below will pick it up on the next state change.
  const currentEmployeeId = employee && employee.id ? employee.id : null;

  // SOL DR-001: compute draft + malformed flag ONCE on mount via useState
  // initializers. A regular const would re-evaluate on every render, which
  // means after `clearDraft()` runs in a useEffect a later re-render would
  // see empty localStorage and silently drop the malformed banner. Pinning
  // the values to state preserves the user-visible recovery state across
  // subsequent renders and state updates.
  const [malformedReason] = useState(() => {
    const d = loadDraftForEmployee(currentEmployeeId);
    return d?.__malformed ? d.reason : null;
  });
  const [initialForm] = useState(() => {
    const d = loadDraftForEmployee(currentEmployeeId);
    if (d?.__malformed || !d) {
      return {
        projectName: '',
        location: '',
        reportDate: queryDate || getLocalDate(),
        weather: '',
        contractor: '',
      };
    }
    return d.form || {
      projectName: '',
      location: '',
      reportDate: queryDate || getLocalDate(),
      weather: '',
      contractor: '',
    };
  });
  const [initialWorkEntry] = useState(() => {
    const d = loadDraftForEmployee(currentEmployeeId);
    if (d?.__malformed || !d) return null;
    return d.workEntry || null;
  });
  const [showDraftBannerInitial] = useState(() => {
    const d = loadDraftForEmployee(currentEmployeeId);
    return !d?.__malformed && !!d;
  });
  const [form, setForm] = useState(initialForm);
  const [workEntry, setWorkEntry] = useState(initialWorkEntry);
  const [photos, setPhotos] = useState([]);
  const [status, setStatus] = useState('idle');
  // S5 audit: split single-string error into per-field + banner model.
  //   formError   — banner text for non-field errors (upload-in-flight,
  //                 toast duplicates, generic submit failures).
  //   fieldErrors — { projectName?, location?, reportDate?, workEntry? }
  //                 map; presence triggers `aria-invalid` + an inline
  //                 error div on the matching input + a clickable entry
  //                 in the top-level summary banner that focuses the
  //                 field. Cleared by `clearErrors()` at the start of
  //                 every submission attempt.
  const [formError, setFormError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [showDraftBanner, setShowDraftBanner] = useState(showDraftBannerInitial);
  const [uploadStatuses, setUploadStatuses] = useState({});
  const [prefillAttempted, setPrefillAttempted] = useState(false);
  const photoObjectUrlsRef = useRef(new Set());

  // [DR-006 client] Live count of photos still going through the SAS / PUT
  // / confirm-upload pipeline. Submit is blocked while this is > 0 so a
  // record can never be created referencing an upload that hasn't reached
  // CONFIRMED yet. Re-evaluated on every render — cheap because uploadStatuses
  // is small and most entries settle to 'complete' / 'error' quickly.
  const hasInFlightUploads = useMemo(
    () => Object.values(uploadStatuses).some(
      (s) => s && (s.status === 'requesting-sas' || s.status === 'uploading' || s.status === 'confirming'),
    ),
    [uploadStatuses],
  );

  // On mount, clear any malformed legacy draft so we never show it again
  // and don't keep crashing the user on every reload.
  useEffect(() => {
    if (malformedReason && currentEmployeeId) clearDraftForEmployee(currentEmployeeId);
  }, [malformedReason, currentEmployeeId]);

  // SOL DR-003: subscribe to logout / session-expiry and clear the current
  // user's draft so a Shared computer does not retain it.
  useEffect(() => {
    const handler = (e) => {
      const cleared = e && e.detail && e.detail.employeeId;
      if (!cleared || cleared !== currentEmployeeId) return;
      clearDraftForEmployee(cleared);
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
    };
    window.addEventListener('draft:clear-current', handler);
    return () => window.removeEventListener('draft:clear-current', handler);
  }, [currentEmployeeId, queryDate]);

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
    if (!currentEmployeeId) return;
    const t = setTimeout(
      () => saveDraftForEmployee(currentEmployeeId, { form, workEntry, photos }),
      750
    );
    return () => clearTimeout(t);
  }, [form, workEntry, photos, currentEmployeeId]);

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
      setFormError(msg);
      toast.push(msg, 'warning');
      return;
    }
    if (photos.length + valid.length > MAX_PHOTOS_PER_DPR) {
      const msg = `Max ${MAX_PHOTOS_PER_DPR} photos allowed`;
      setFormError(msg);
      toast.push(msg, 'warning');
      return;
    }

    setFormError('');

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

  // S5 audit: per-field error rendering. Each validation branch sets the
  // field-level error (via `setFieldError(key, msg)`) which drives the
  // inline error message, the aria-invalid flag, and a clickable entry
  // in the top-level summary list. The first invalid field is also
  // focus'd + scrolled into view (WCAG 3.3.1 + 3.3.3).
  const clearErrors = useCallback(() => {
    setFormError('');
    setFieldErrors({});
  }, []);

  const setFieldError = useCallback((key, msg) => {
    setFieldErrors((prev) => ({ ...prev, [key]: msg }));
  }, []);

  const focusFirstInvalid = useCallback((errors) => {
    // Order matches the top-to-bottom layout of the form so the focus
    // move is predictable for users who tab through top-down.
    const order = ['projectName', 'location', 'reportDate', 'workEntry'];
    const first = order.find((k) => errors[k]);
    if (!first) return;
    const refMap = {
      projectName: projectNameRef,
      location: locationRef,
      reportDate: reportDateRef,
      workEntry: workEntryRef,
    };
    const node = refMap[first]?.current;
    if (node && typeof node.focus === 'function') {
      node.focus({ preventScroll: false });
      if (typeof node.scrollIntoView === 'function') {
        node.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  }, []);

  const handleSubmit = async (submitStatus) => {
    if (submittingRef.current) return;
    submittingRef.current = true;

    clearErrors();
    // [DR-006 client] Refuse to submit while any photo is still uploading
    // or awaiting CONFIRMED intent. Without this, the user can submit a
    // report that drops photos mid-upload — the backend now rolls the
    // record back (409 PHOTO_BINDING_LOST) and the user is left wondering
    // why their report vanished. Block the submit instead and surface a
    // concrete reason.
    const inFlightUploads = Object.values(uploadStatuses).filter(
      (s) => s && (s.status === 'requesting-sas' || s.status === 'uploading' || s.status === 'confirming'),
    );
    if (inFlightUploads.length > 0) {
      const msg = `${inFlightUploads.length} photo${inFlightUploads.length !== 1 ? 's are' : ' is'} still uploading — please wait for them to finish before submitting.`;
      setFormError(msg);
      toast.push(msg, 'warning');
      submittingRef.current = false;
      return;
    }
    const newFieldErrors = {};
    if (!form.projectName) newFieldErrors.projectName = 'Project name is required';
    if (!form.location)    newFieldErrors.location    = 'Location is required';
    if (!form.reportDate)  newFieldErrors.reportDate  = 'Date is required';
    if (Object.keys(newFieldErrors).length > 0) {
      setFieldErrors(newFieldErrors);
      setFormError('Please fix the highlighted fields and try again.');
      toast.push('Please fill in the highlighted fields.', 'warning');
      focusFirstInvalid(newFieldErrors);
      submittingRef.current = false;
      return;
    }
    if (!workEntry) {
      setFieldError('workEntry', 'Please add an inspection record before submitting');
      setFormError('Please fix the highlighted fields and try again.');
      toast.push('Please add an inspection record before submitting.', 'warning');
      focusFirstInvalid({ workEntry: true });
      submittingRef.current = false;
      return;
    }
    // SOL DR-001: belt-and-braces — refuse to submit a workEntry whose
    // structured data has been lost. A correct serializer keeps `data` intact,
    // so reaching this branch means the in-memory draft was constructed
    // unsafely.
    if (!workEntry.data || typeof workEntry.data !== 'object') {
      const msg = 'This inspection record is missing its structured fields. Please re-add the record before submitting.';
      setFieldError('workEntry', msg);
      setFormError(msg);
      toast.push(msg, 'warning');
      focusFirstInvalid({ workEntry: true });
      submittingRef.current = false;
      return;
    }
    const dateErr = validateReportDate(form.reportDate);
    if (dateErr) {
      setFieldError('reportDate', dateErr);
      setFormError(dateErr);
      toast.push(dateErr, 'warning');
      focusFirstInvalid({ reportDate: dateErr });
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

      // DR-012: mint a fresh idempotency key per submit intent. The
      // backend stores (employeeId, Idempotency-Key, bodyHash) → 201
      // for 5 minutes so a NETWORK_ERROR retry (api.js:168-178) replays
      // the same key + body and returns the cached row instead of
      // creating a duplicate inspection + duplicate admin notification
      // email. Submitting twice intentionally must mint TWO keys (a
      // second submit click is a fresh user intent, not a retry).
      const idempotencyKey = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
        ? crypto.randomUUID()
        : `insp-${Date.now()}-${Math.random().toString(36).slice(2)}`;

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
          // SOL DR-005: the two buttons finally diverge. "Save as Draft"
          // stores an owner-visible DRAFT row that does NOT trigger admin
          // fan-out (backend/src/routes/inspection.js ALLOWED_STATUSES).
          // "Submit Record" creates an OPEN row as before. Previously
          // both routes sent 'OPEN', so "Save as Draft" silently
          // published into the admin review queue.
          status: submitStatus === 'DRAFT' ? 'DRAFT' : 'OPEN',
          // Round-12 MVP: severity is not asked at submit time. The
          // Inspection page surfaces it on the detail view for NCR / safety
          // sub-types where the structured data already implies severity
          // (e.g. `severity` field in the NCR / safety_violation schema).
          severity: null,
          photos: photosToSubmit,
        },
        accessToken,
        idempotencyKey
      );

      clearDraftForEmployee(currentEmployeeId);
      toast.push(submitStatus === 'DRAFT' ? 'Draft saved.' : 'Inspection record submitted.', 'success');
      navigate('/portal/inspection/my');
    } catch (err) {
      // [DR-006 client] Surface a specific message when the server rolls
      // back because a photo claim was lost mid-submit. Generic
      // "Failed to submit…" would leave the user thinking the form was
      // broken; the real story is "photos were orphaned by the sweep,
      // re-attach and resubmit".
      const isPhotoBindingLost = err?.code === 'PHOTO_BINDING_LOST'
        || (err?.message || '').toLowerCase().includes('photo binding');
      const msg = isPhotoBindingLost
        ? 'Photo upload was lost mid-submit — please re-attach your photos and try again.'
        : (err.message || 'Failed to submit inspection record');
      setFormError(msg);
      setStatus('idle');
      if (err.status !== 401) toast.push(msg, 'error');
    } finally {
      submittingRef.current = false;
    }
  };

  const handleDiscardDraft = () => {
    clearDraftForEmployee(currentEmployeeId);
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

        {/* SOL-P1#11: progressive-disclosure progress strip — mirrors the
            DPR form so users see how many of the three sections they've
            filled before they can hit Submit. */}
        <FormProgress
          label="Inspection completion"
          sections={[
            {
              id: 'inspection-section-site',
              label: INSPECTION_SECTIONS[0].label,
              complete: Boolean(form.projectName && form.location && form.reportDate),
            },
            {
              id: 'inspection-section-record',
              label: INSPECTION_SECTIONS[1].label,
              complete: Boolean(workEntry && workEntry.workType),
            },
            {
              id: 'inspection-section-photos',
              label: INSPECTION_SECTIONS[2].label,
              complete: photos.length > 0,
            },
          ]}
        />

        {showDraftBanner && (
          <div
            role="status"
            className="draft-banner"
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

        {/* SOL DR-001: an older draft saved before the serializer fix has lost
            its structured workEntry.data. We cannot restore those fields, but
            we also must not crash the page or pretend the work is preserved. */}
        {malformedReason && (
          <div
            role="alert"
            className="portal-auth-error"
            style={{ marginBottom: '1rem' }}
          >
            <strong>We couldn't restore your previous draft.</strong>
            <p style={{ margin: '0.5rem 0 0 0' }}>
              A saved draft from a previous visit was found, but its structured
              fields could not be recovered. Your uploaded photos are no longer
              attached. Start a new entry below — your entries are not lost from
              reports you already submitted.
            </p>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              style={{ marginTop: '0.75rem' }}
              onClick={handleDiscardDraft}
            >
              Discard old draft and start fresh
            </button>
          </div>
        )}

        {/* S5 audit: replaced the single banner with a structured error
            summary that lists every invalid field as a clickable link
            which focuses + scrolls the corresponding input (WCAG 3.3.1
            Error Identification + 3.3.3 Error Suggestion). The summary
            only appears when at least one field-level error exists; the
            plain banner remains for non-field failures (e.g. an upload
            in flight, or a 409 PHOTO_BINDING_LOST). */}
        {(() => {
          const errKeys = Object.keys(fieldErrors).filter((k) => fieldErrors[k]);
          if (errKeys.length === 0 && !formError) return null;
          const FIELD_LABELS = {
            projectName: 'Project name',
            location: 'Location',
            reportDate: 'Date',
            workEntry: 'Inspection record',
          };
          // Order matches the focusFirstInvalid order so the listed
          // links descend the same path as Tab navigation would.
          const orderedKeys = ['projectName', 'location', 'reportDate', 'workEntry']
            .filter((k) => errKeys.includes(k));
          return (
            <div
              id="inspection-form-error-summary"
              role="alert"
              aria-live="polite"
              className="portal-auth-error inspection-form-summary"
              style={{ marginBottom: '1rem' }}
            >
              <strong>
                {formError || 'Please fix the highlighted fields and try again.'}
              </strong>
              {orderedKeys.length > 0 && (
                <ul className="inspection-form-summary-list">
                  {orderedKeys.map((k) => (
                    <li key={k}>
                      <button
                        type="button"
                        className="inspection-form-summary-link"
                        onClick={() => focusFirstInvalid({ [k]: true })}
                      >
                        {FIELD_LABELS[k] || k}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })()}

        <div className="dpr-form">
          {/* A-11: section anchor — see INSPECTION_SECTIONS for the matching skip-nav target. */}
          <section id="inspection-section-site" className="dpr-form-section">
          <div className="form-row">
            <div className="form-group" style={{ flex: 2 }}>
              <label htmlFor="projectName">Project Name *</label>
              <input
                id="projectName"
                ref={projectNameRef}
                name="projectName"
                className={`form-input${fieldErrors.projectName ? ' form-input-invalid' : ''}`}
                value={form.projectName}
                onChange={handleChange}
                aria-invalid={fieldErrors.projectName ? 'true' : 'false'}
                aria-describedby={fieldErrors.projectName ? 'projectName-error' : undefined}
                placeholder="e.g. Metro Station Phase 2"
              />
              {fieldErrors.projectName && (
                <div id="projectName-error" className="form-field-error" role="alert">
                  {fieldErrors.projectName}
                </div>
              )}
            </div>
            <div className="form-group" style={{ flex: 1 }}>
              <label htmlFor="reportDate">Report Date *</label>
              <input
                id="reportDate"
                ref={reportDateRef}
                type="date"
                name="reportDate"
                className={`form-input${fieldErrors.reportDate ? ' form-input-invalid' : ''}`}
                value={form.reportDate}
                onChange={handleChange}
                aria-invalid={fieldErrors.reportDate ? 'true' : 'false'}
                aria-describedby={fieldErrors.reportDate ? 'reportDate-error' : undefined}
              />
              {fieldErrors.reportDate && (
                <div id="reportDate-error" className="form-field-error" role="alert">
                  {fieldErrors.reportDate}
                </div>
              )}
            </div>
          </div>

          <div className="form-group">
            <label htmlFor="location">Location *</label>
            <input
              id="location"
              ref={locationRef}
              name="location"
              className={`form-input${fieldErrors.location ? ' form-input-invalid' : ''}`}
              value={form.location}
              onChange={handleChange}
              aria-invalid={fieldErrors.location ? 'true' : 'false'}
              aria-describedby={fieldErrors.location ? 'location-error' : undefined}
              placeholder="Site address or location description"
            />
            {fieldErrors.location && (
              <div id="location-error" className="form-field-error" role="alert">
                {fieldErrors.location}
              </div>
            )}
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
          </section>

          {/* A-11: section anchor — structured inspection record adder. */}
          <section id="inspection-section-record" className="dpr-form-section">
          <div className="form-group">
            <label>Inspection Record *</label>
            <div
              ref={workEntryRef}
              tabIndex={-1}
              role="group"
              aria-labelledby="inspection-record-error"
              aria-invalid={fieldErrors.workEntry ? 'true' : 'false'}
            />
            {fieldErrors.workEntry && (
              <div id="inspection-record-error" className="form-field-error" role="alert">
                {fieldErrors.workEntry}
              </div>
            )}
            {workEntry && workEntry.data && (
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
            {!workEntry && <WorkEntryAdder onAdd={setWorkEntry} sectionLabel="Add Inspection Record" submitLabel="Add Inspection Record" />}
          </div>
          </section>

          {/* A-11: section anchor — photo upload + preview grid. */}
          <section id="inspection-section-photos" className="dpr-form-section">
          <div className="form-group">
            <label>Photos (max {MAX_PHOTOS_PER_DPR})</label>
            {/* Round-17 B-14: photo previews via URL.createObjectURL — verified in
                handleFiles() (previewUrl stored on each photo + rendered in photo-grid below). */}
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
              <svg width="32" height="32" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg>
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
          </section>

          <div className="dpr-form-actions dpr-form-actions-sticky">
            <button type="button" className="btn btn-secondary" onClick={() => handleSubmit('DRAFT')} disabled={status === 'submitting' || hasInFlightUploads}>
              {status === 'submitting' ? 'Saving...' : 'Save as Draft'}
            </button>
            <button type="button" className="btn btn-primary" onClick={() => handleSubmit('SUBMITTED')} disabled={status === 'submitting' || hasInFlightUploads}>
              {status === 'submitting' ? 'Submitting...' : hasInFlightUploads ? 'Waiting for photos…' : 'Submit Record'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
