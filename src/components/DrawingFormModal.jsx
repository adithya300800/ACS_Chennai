// N3 (Phase F) — Drawing create / supersede modal.
//
// One component covers both create + supersede:
//   - Create   → supersedesId is omitted, project dropdown drives the form.
//   - Supersede→ the parent passes `supersedesId` (= the predecessor's
//                drawingId). The modal pre-fills the project + drawing
//                number + title from the predecessor and leaves
//                `revision` blank so the admin types the next revision
//                letter/number. On submit the backend flips the
//                predecessor to SUPERSEDED atomically with the new insert.
//
// Wire contract (POST /api/drawings, all required unless noted):
//   { projectId: UUID, drawingNumber: string (≤60),
//     title?: string (≤200), revision?: string (≤20, default "0",
//                pattern ^[A-Za-z0-9.-]+$), issuedDate?: YYYY-MM-DD,
//                pdfBlobPath?: string (≤1024),
//                supersedesId?: UUID }
//
// Upload flow mirrors the existing photo pattern (DprSubmit.jsx:445):
//   1. Mint SAS via api.getDrawingSasUrl.
//   2. PUT bytes to R2 with progress (uploadDrawing helper).
//   3. Receive blobPath from confirm-upload.
//   4. POST /api/drawings with the blobPath in the payload.
//
// Validation here mirrors backend/src/routes/drawings.js so the user
// sees an error before the round-trip — the server is still the source
// of truth for any final uniqueness / length caps.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { uploadDrawing, DEFAULT_BLOB_UPLOAD_TIMEOUT_MS } from '../lib/blobUpload.js';
import Modal from './Modal.jsx';

const MAX_PDF_BYTES = 10 * 1024 * 1024; // 10MB — matches the spec.
const ACCEPTED_PDF_TYPES = ['application/pdf'];

const REVISION_PATTERN = /^[A-Za-z0-9.-]+$/;
const DRAWING_NUMBER_MAX = 60;
const TITLE_MAX = 200;
const REVISION_MAX = 20;

function validate(form) {
  const errors = {};
  if (!form.projectId) errors.projectId = 'Select a project.';
  if (!form.drawingNumber || !form.drawingNumber.trim()) {
    errors.drawingNumber = 'Drawing number is required.';
  } else if (form.drawingNumber.length > DRAWING_NUMBER_MAX) {
    errors.drawingNumber = `Drawing number must be ${DRAWING_NUMBER_MAX} characters or fewer.`;
  }
  if (form.title && form.title.length > TITLE_MAX) {
    errors.title = `Title must be ${TITLE_MAX} characters or fewer.`;
  }
  const rev = form.revision || '0';
  if (rev.length > REVISION_MAX) {
    errors.revision = `Revision must be ${REVISION_MAX} characters or fewer.`;
  } else if (rev && !REVISION_PATTERN.test(rev)) {
    errors.revision = 'Revision can only contain letters, digits, dots, and dashes.';
  }
  return errors;
}

const todayLocalDate = () => {
  const d = new Date();
  const offset = d.getTimezoneOffset();
  return new Date(d - offset * 60000).toISOString().split('T')[0];
};

export default function DrawingFormModal({
  open,
  onClose,
  onSave,
  accessToken,
  projects = [],
  // [Round-31] When set, the project <select> is pre-filled AND
  // disabled — used by DrawingsBrowse's "+ Add drawing" CTA where
  // the project is already determined by the URL ?projectId=. This
  // is cheaper than building a separate modal mode because the
  // underlying form state machine (validate / submit / onSave) is
  // identical to the admin create flow.
  initialProjectId = '',
  // When present, opens the modal in "supersede" mode. The modal
  // pre-fills the project + drawingNumber + title from the
  // predecessor and surfaces a banner explaining the atomic flip.
  supersedes = null,
  // When present, opens the modal in "edit" mode for the supplied
  // drawing row. Only the editable fields (title, issuedDate,
  // pdfBlobPath, status) are exposed; the natural key
  // (projectId + drawingNumber + revision) is locked.
  editOf = null,
}) {
  const isSupersede = !!(supersedes && supersedes.id);
  const isEdit = !!(editOf && editOf.id);
  const fileInputRef = useRef(null);
  const [form, setForm] = useState({
    projectId: '',
    drawingNumber: '',
    title: '',
    revision: '',
    issuedDate: '',
  });
  const [errors, setErrors] = useState({});
  const [serverError, setServerError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [pendingFile, setPendingFile] = useState(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadPhase, setUploadPhase] = useState(''); // 'sas' | 'uploading' | 'confirming' | ''

  // Reset whenever the modal opens for a new target. Mirrors the
  // BoqFormModal pattern so the form stays in sync with the row
  // being edited or superseded.
  useEffect(() => {
    if (!open) return;
    if (isEdit) {
      setForm({
        projectId: editOf.projectId || '',
        drawingNumber: editOf.drawingNumber || '',
        title: editOf.title || '',
        revision: editOf.revision || '',
        issuedDate: editOf.issuedDate || '',
        status: editOf.status || 'ACTIVE',
      });
    } else if (isSupersede) {
      setForm({
        projectId: supersedes.projectId || '',
        drawingNumber: supersedes.drawingNumber || '',
        title: supersedes.title || '',
        revision: '',
        issuedDate: todayLocalDate(),
      });
    } else {
      setForm({
        projectId: '',
        drawingNumber: '',
        title: '',
        revision: '',
        issuedDate: todayLocalDate(),
      });
    }
    setErrors({});
    setServerError('');
    setSubmitting(false);
    setPendingFile(null);
    setUploadProgress(0);
    setUploadPhase('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [open, supersedes, isSupersede, editOf, isEdit]);

  // Auto-select the only/first project if there is exactly one — saves
  // an admin click when they have a single-site account. When the parent
  // passes `initialProjectId` (Round-31 DrawingsBrowse "+ Add drawing" CTA)
  // we prefer that explicit seed — it reflects the URL ?projectId the user
  // already picked, not the auto-detected single-project convenience.
  useEffect(() => {
    if (!open || isSupersede) return;
    if (!form.projectId) {
      if (initialProjectId) {
        setForm((f) => ({ ...f, projectId: initialProjectId }));
      } else if (projects.length === 1) {
        setForm((f) => ({ ...f, projectId: projects[0].id }));
      }
    }
  }, [open, isSupersede, projects, form.projectId, initialProjectId]);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setForm((f) => ({ ...f, [name]: value }));
    setErrors((prev) => ({ ...prev, [name]: undefined }));
  };

  const handleFileChange = (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) {
      setPendingFile(null);
      return;
    }
    if (!ACCEPTED_PDF_TYPES.includes(file.type)) {
      setServerError('Only PDF files are accepted.');
      setPendingFile(null);
      e.target.value = '';
      return;
    }
    if (file.size > MAX_PDF_BYTES) {
      setServerError(`PDF is too large (max ${MAX_PDF_BYTES / 1024 / 1024}MB).`);
      setPendingFile(null);
      e.target.value = '';
      return;
    }
    setServerError('');
    setPendingFile(file);
    setUploadProgress(0);
    setUploadPhase('');
  };

  const submit = useCallback(async (e) => {
    e?.preventDefault();
    if (submitting) return;
    const v = validate(form);
    if (Object.keys(v).length > 0) {
      setErrors(v);
      return;
    }
    setErrors({});
    setServerError('');
    setSubmitting(true);
    try {
      let pdfBlobPath = null;
      if (pendingFile) {
        setUploadPhase('sas');
        const result = await uploadDrawing(
          pendingFile,
          accessToken,
          api,
          {
            onProgress: (pct) => {
              setUploadPhase('uploading');
              setUploadProgress(pct);
            },
            timeoutMs: DEFAULT_BLOB_UPLOAD_TIMEOUT_MS,
          },
        );
        setUploadPhase('confirming');
        pdfBlobPath = result.blobPath;
      }
      setUploadPhase('');
      const payload = isEdit
        ? {
            // Edit mode: only forward the editable fields. DrawingFormModal
            // locks projectId / drawingNumber / revision in Edit mode so the
            // payload never carries the natural key. The backend's PATCH
            // route rejects unknown keys (UNKNOWN_FIELDS 400), so we filter
            // rather than spread the form.
            title: form.title ? form.title.trim() : null,
            issuedDate: form.issuedDate || null,
            ...(pdfBlobPath ? { pdfBlobPath } : {}),
            ...(form.status ? { status: form.status } : {}),
          }
        : {
            projectId: form.projectId,
            drawingNumber: form.drawingNumber.trim(),
            title: form.title ? form.title.trim() : null,
            revision: form.revision ? form.revision.trim() : '0',
            issuedDate: form.issuedDate || null,
            ...(pdfBlobPath ? { pdfBlobPath } : {}),
            ...(isSupersede ? { supersedesId: supersedes.id } : {}),
          };
      await onSave(payload);
    } catch (err) {
      // Surface a specific message for SAS / upload failures so the
      // admin can retry without resubmitting the form fields.
      const msg = err?.message || 'Failed to save drawing';
      setServerError(msg);
      setSubmitting(false);
      setUploadPhase('');
    }
  }, [form, pendingFile, accessToken, onSave, submitting, isSupersede, supersedes]);

  const submittingLabel = useMemo(() => {
    if (uploadPhase === 'sas') return 'Preparing upload…';
    if (uploadPhase === 'uploading') return `Uploading PDF… ${uploadProgress}%`;
    if (uploadPhase === 'confirming') return 'Confirming upload…';
    if (submitting) return 'Saving drawing…';
    return null;
  }, [uploadPhase, uploadProgress, submitting]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      ariaLabel={isSupersede ? 'Supersede drawing' : 'Add drawing'}
      maxWidth={640}
      dismissable={!submitting}
    >
      <h2 style={{ margin: '0 0 1rem', color: 'var(--navy)', fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
        {isEdit ? 'Edit drawing' : isSupersede ? 'Supersede drawing' : 'Add drawing'}
      </h2>

      {isSupersede && (
        <div
          role="status"
          style={{
            padding: '0.625rem 0.875rem',
            background: '#f0f9ff',
            border: '1px solid #bae6fd',
            borderRadius: 6,
            fontSize: '0.85rem',
            color: '#075985',
            marginBottom: '0.75rem',
          }}
        >
          This new row will atomically flip
          {' '}<strong>{supersedes.drawingNumber} Rev {supersedes.revision}</strong>
          {' '}to SUPERSEDED. Future submissions against the old revision
          still resolve to the historical record.
        </div>
      )}

      <form onSubmit={submit}>
        <div className="form-row">
          <div className="form-group" style={{ flex: 2 }}>
            <label htmlFor="drawing-projectId">Project *</label>
            <select
              id="drawing-projectId"
              name="projectId"
              className="form-input"
              value={form.projectId}
              onChange={handleChange}
              required
              disabled={isSupersede || isEdit || submitting || !!initialProjectId}
              aria-invalid={errors.projectId ? 'true' : 'false'}
            >
              <option value="">— Select project —</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}{p.code ? ` (${p.code})` : ''}
                </option>
              ))}
            </select>
            {errors.projectId && (
              <div className="form-field-error" role="alert">{errors.projectId}</div>
            )}
          </div>
        </div>

        <div className="form-row">
          <div className="form-group" style={{ flex: 2 }}>
            <label htmlFor="drawing-drawingNumber">
              Drawing Number *
              {isSupersede && (
                <span style={{ fontWeight: 400, color: 'var(--steel)' }}>
                  {' '}(pre-filled — change only if the number itself is being revised)
                </span>
              )}
            </label>
            <input
              id="drawing-drawingNumber"
              name="drawingNumber"
              className="form-input"
              value={form.drawingNumber}
              onChange={handleChange}
              maxLength={DRAWING_NUMBER_MAX}
              required
              disabled={isSupersede || submitting}
              placeholder="e.g. STR-101"
              disabled={isSupersede || isEdit || submitting}
              aria-invalid={errors.drawingNumber ? 'true' : 'false'}
            />
            {errors.drawingNumber && (
              <div className="form-field-error" role="alert">{errors.drawingNumber}</div>
            )}
          </div>
          <div className="form-group" style={{ flex: 1 }}>
            <label htmlFor="drawing-revision">Revision *</label>
            <input
              id="drawing-revision"
              name="revision"
              className="form-input"
              value={form.revision}
              onChange={handleChange}
              maxLength={REVISION_MAX}
              required
              disabled={submitting || isEdit || isSupersede}
              placeholder={isSupersede ? 'e.g. R1, A, 1.1' : '0'}
              aria-invalid={errors.revision ? 'true' : 'false'}
            />
            {errors.revision && (
              <div className="form-field-error" role="alert">{errors.revision}</div>
            )}
            <span style={{ fontSize: '0.75rem', color: 'var(--steel)', marginTop: '0.25rem' }}>
              Letters, digits, dots, and dashes only.
            </span>
          </div>
        </div>

        <div className="form-group">
          <label htmlFor="drawing-title">Title (optional)</label>
          <input
            id="drawing-title"
            name="title"
            className="form-input"
            value={form.title}
            onChange={handleChange}
            maxLength={TITLE_MAX}
            disabled={submitting}
            placeholder="e.g. GF Slab Layout — Villa 4"
            aria-invalid={errors.title ? 'true' : 'false'}
          />
          {errors.title && (
            <div className="form-field-error" role="alert">{errors.title}</div>
          )}
        </div>

        <div className="form-row">
          <div className="form-group" style={{ flex: 1 }}>
            <label htmlFor="drawing-issuedDate">Issued Date</label>
            <input
              id="drawing-issuedDate"
              type="date"
              name="issuedDate"
              className="form-input"
              value={form.issuedDate}
              onChange={handleChange}
              disabled={submitting}
            />
          </div>
        </div>

        <div className="form-group">
          <label htmlFor="drawing-file">Drawing PDF (optional)</label>
          <input
            id="drawing-file"
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_PDF_TYPES.join(',')}
            className="form-input"
            onChange={handleFileChange}
            disabled={submitting}
          />
          {pendingFile && (
            <div style={{ marginTop: '0.4rem', fontSize: '0.8rem', color: 'var(--steel)' }}>
              📄 {pendingFile.name} · {Math.round(pendingFile.size / 1024)} KB
            </div>
          )}
          <span style={{ fontSize: '0.75rem', color: 'var(--steel)', marginTop: '0.25rem' }}>
            PDF only, up to {MAX_PDF_BYTES / 1024 / 1024}MB. Stored in the
            drawings/dpr-documents bucket.
          </span>
        </div>

        {submittingLabel && (
          <div
            role="status"
            aria-live="polite"
            style={{
              marginTop: '0.5rem',
              padding: '0.5rem 0.75rem',
              background: '#f0f9ff',
              border: '1px solid #bae6fd',
              borderRadius: 6,
              fontSize: '0.85rem',
              color: '#075985',
            }}
          >
            {submittingLabel}
          </div>
        )}

        {serverError && (
          <div
            className="portal-auth-error"
            role="alert"
            style={{ marginTop: '0.75rem' }}
          >
            {serverError}
          </div>
        )}

        <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '1rem' }}>
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting
              ? (submittingLabel || 'Saving…')
              : (isEdit ? 'Save changes' : isSupersede ? 'Create new revision' : 'Create drawing')}
          </button>
        </div>
      </form>
    </Modal>
  );
}