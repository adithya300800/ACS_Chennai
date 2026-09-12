// S7/MyReports (2026-09-12): Cross-project employee "Project Reports" page.
//
// Surfaces the per-project ProjectAttachment upload/list flow that previously
// lived only inside the My Projects accordion (R35). The page fetches every
// project the employee is assigned to via the existing
//   GET /api/projects?scope=assigned
// then fans out per-project list calls and merges the rows into a single
// cross-project "My Reports" view. Upload uses the existing 3-step pipeline
// (getReportSasUrl → R2 PUT → confirmReportUpload → createProjectAttachment).
//
// ZERO new backend endpoints, ZERO schema changes, ZERO new dependencies.
// Reuses everything R35 / R36 / R37 already shipped:
//   - PROJECT_REPORT_TYPES, PROJECT_REPORT_TYPE_LABELS, MAX_REPORT_BYTES,
//     ACCEPTED_REPORT_TYPES from src/lib/constants.js
//   - api.getProjects / getProjectAttachments / getProjectAttachmentReadSas
//     / deleteProjectAttachment / getReportSasUrl / confirmReportUpload
//     / createProjectAttachment from src/lib/api.js
//   - uploadBlob + BlobUploadError from src/lib/blobUpload.js
//   - REPORT_ICON from src/components/PortalLayout.jsx (used in sidebar)
//
// UX:
//   - Single self-contained page (no tabs — matches the user's "My Reports
//     tab" reading; a tab strip would have been over-engineering for a
//     5-type filter that's already chip-served).
//   - Project picker dropdown (required for uploads) shows the employee's
//     assigned projects only — matches existing ?scope=assigned semantics.
//   - 5 type chips (All / Weekly / Monthly / Due diligence / Quality /
//     Other). The backend enum is PROJECT_REPORT_TYPE — no SAFETY type
//     today; this page reflects what's actually supported.
//   - Upload form mirrors the in-accordion ReportSection 3-step state
//     machine so any backend contract change here is also a change
//     ReportSection needs to pick up (single source of truth on the wire).

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { api } from '../../lib/api.js';
import { formatShortDate, formatBytes } from '../../lib/format.js';
import {
  MAX_REPORT_BYTES,
  ACCEPTED_REPORT_TYPES,
  PROJECT_REPORT_TYPES,
  PROJECT_REPORT_TYPE_LABELS,
} from '../../lib/constants.js';
import { uploadBlob, BlobUploadError } from '../../lib/blobUpload.js';
import Breadcrumb from '../../components/Breadcrumb.jsx';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';

// Build the file-accept string from ACCEPTED_REPORT_TYPES — mirrors the
// helper inline in ReportSection (ProjectExpandedPanel.jsx). Same MIME list,
// same extension mapping. Kept local so the two upload surfaces stay
// independent of each other; if one changes, the other should too.
function buildFileAccept() {
  return ACCEPTED_REPORT_TYPES.map((t) => {
    if (t.startsWith('image/')) return t;
    if (t === 'text/plain') return '.txt';
    if (t === 'text/csv') return '.csv';
    if (t === 'application/pdf') return '.pdf';
    if (t === 'application/msword') return '.doc';
    if (t.includes('wordprocessingml')) return '.docx';
    if (t === 'application/vnd.ms-excel') return '.xls';
    if (t.includes('spreadsheetml')) return '.xlsx';
    if (t === 'application/vnd.ms-powerpoint') return '.ppt';
    if (t.includes('presentationml')) return '.pptx';
    return t;
  }).join(',');
}

const FILE_ACCEPT = buildFileAccept();

export default function MyProjectReports() {
  useDocumentTitle('Project Reports');
  const { accessToken, employee } = useAuth();
  const toast = useToast();

  // ─── State ─────────────────────────────────────────────────────────────
  // Projects: list of assigned projects (the employee may belong to many).
  // selectedProjectId: chosen for upload. Reports list always shows rows
  // from every assigned project; the picker is required only for upload.
  const [projects, setProjects] = useState([]);
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [filterType, setFilterType] = useState(''); // '' = all
  const [reports, setReports] = useState([]);
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [loadingReports, setLoadingReports] = useState(true);
  const [error, setError] = useState('');

  // Upload form state. 3-step state machine mirrors the in-accordion
  // ReportSection (R35): idle → sas → uploading → confirming → idle.
  const [uploadType, setUploadType] = useState(PROJECT_REPORT_TYPES[0]);
  const [uploadFile, setUploadFile] = useState(null);
  const [uploadTitle, setUploadTitle] = useState('');
  const [uploadPhase, setUploadPhase] = useState('idle');
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState(null);

  // ─── Data loaders ──────────────────────────────────────────────────────
  // Load assigned projects once on mount. The picker auto-selects the
  // first project so the upload form is usable immediately.
  const loadProjects = useCallback(async () => {
    setLoadingProjects(true);
    try {
      const data = await api.getProjects({ scope: 'assigned' }, accessToken);
      const list = Array.isArray(data) ? data : (data?.projects || data?.items || []);
      setProjects(list);
      if (list.length > 0) setSelectedProjectId((cur) => cur || list[0].id || list[0].name || '');
    } catch (err) {
      const msg = err?.message || 'Failed to load projects.';
      setError(msg);
      if (err?.status !== 401) toast.push(msg, 'error');
    } finally {
      setLoadingProjects(false);
    }
  }, [accessToken, toast]);

  // Load reports across every assigned project. Per-project calls run in
  // parallel via Promise.allSettled so one project's 404 doesn't sink the
  // rest (mirrors the pattern used in the My Projects accordion loader).
  const loadReports = useCallback(async () => {
    setLoadingReports(true);
    setError('');
    try {
      if (projects.length === 0) {
        setReports([]);
        return;
      }
      const results = await Promise.allSettled(
        projects.map((p) => api.getProjectAttachments(
          p.id || p.name,
          {},
          accessToken,
        )),
      );
      const merged = [];
      results.forEach((res, idx) => {
        if (res.status !== 'fulfilled') return;
        const project = projects[idx];
        const rows = Array.isArray(res.value) ? res.value : (res.value?.attachments || res.value?.items || []);
        rows.forEach((r) => {
          if (r && r.deletedAt) return; // soft-deleted rows are filtered by backend already, but double-check
          merged.push({ ...r, projectName: project.name || project.code || project.id });
        });
      });
      // Newest first.
      merged.sort((a, b) => {
        const aT = new Date(a.uploadedAt || a.createdAt || 0).getTime();
        const bT = new Date(b.uploadedAt || b.createdAt || 0).getTime();
        return bT - aT;
      });
      setReports(merged);
    } catch (err) {
      const msg = err?.message || 'Failed to load reports.';
      setError(msg);
      if (err?.status !== 401) toast.push(msg, 'error');
    } finally {
      setLoadingReports(false);
    }
  }, [projects, accessToken, toast]);

  useEffect(() => { loadProjects(); }, [loadProjects]);
  useEffect(() => { if (!loadingProjects) loadReports(); }, [loadProjects, loadReports, loadingProjects]);

  // ─── Filter ────────────────────────────────────────────────────────────
  // Memoised filter so the chip-change doesn't recompute the sort/merge.
  const filteredReports = useMemo(() => {
    if (!filterType) return reports;
    return reports.filter((r) => r.type === filterType);
  }, [reports, filterType]);

  // ─── Upload handler ────────────────────────────────────────────────────
  function validateFile(file) {
    if (!file) return 'Please pick a file first.';
    if (file.size > MAX_REPORT_BYTES) {
      return `File too large. Max ${Math.round(MAX_REPORT_BYTES / (1024 * 1024))} MB.`;
    }
    if (!ACCEPTED_REPORT_TYPES.includes(file.type)) {
      return `File type "${file.type || 'unknown'}" not supported. Use PDF, Office, photo, text, or CSV.`;
    }
    return null;
  }

  async function handleUpload() {
    const errMsg = validateFile(uploadFile);
    if (errMsg) { setUploadError(errMsg); return; }
    if (!selectedProjectId) { setUploadError('Please pick a project first.'); return; }
    setUploadError(null);
    try {
      // Step 1: mint a presigned PUT URL.
      setUploadPhase('sas');
      const { sasUrl, ulid, blobPath } = await api.getReportSasUrl(
        uploadFile.name, uploadFile.type, accessToken,
      );
      // Step 2: PUT bytes direct-to-R2 with progress.
      setUploadPhase('uploading');
      setUploadProgress(0);
      await uploadBlob(sasUrl, uploadFile, {
        contentType: uploadFile.type,
        onProgress: (pct) => setUploadProgress(pct),
      });
      // Step 3: confirm-upload — flips PENDING → CONFIRMED so the orphan
      // sweeper won't evict the bytes.
      setUploadPhase('confirming');
      await api.confirmReportUpload(
        ulid, uploadFile.name, uploadFile.type, uploadFile.size, accessToken,
      );
      // Step 4: insert the ProjectAttachment row.
      await api.createProjectAttachment(selectedProjectId, {
        type: uploadType,
        title: uploadTitle.trim() || null,
        filename: uploadFile.name,
        contentType: uploadFile.type,
        sizeBytes: uploadFile.size,
        blobPath,
      }, accessToken);
      // Reset + refresh.
      setUploadPhase('idle');
      setUploadProgress(0);
      setUploadFile(null);
      setUploadTitle('');
      toast.push('Report uploaded', 'success');
      loadReports();
    } catch (err) {
      setUploadPhase('idle');
      setUploadProgress(0);
      const message =
        err instanceof BlobUploadError
          ? err.message
          : (err?.message || 'Upload failed');
      setUploadError(message);
      if (toast) toast.push(message, 'error');
    }
  }

  // ─── Download / Delete ────────────────────────────────────────────────
  async function handleDownload(att) {
    try {
      const projectId = att.projectId || projects.find((p) => p.name === att.projectName)?.id;
      const { sasUrl } = await api.getProjectAttachmentReadSas(
        projectId || att.projectName, att.id, accessToken,
      );
      window.open(sasUrl, '_blank', 'noopener,noreferrer');
    } catch (err) {
      const message = err?.message || 'Could not open file';
      toast.push(message, 'error');
    }
  }

  async function handleDelete(att) {
    if (!window.confirm(`Delete "${att.filename}"? This can be undone only by an admin restoring the row.`)) {
      return;
    }
    try {
      const projectId = att.projectId || projects.find((p) => p.name === att.projectName)?.id;
      await api.deleteProjectAttachment(
        projectId || att.projectName, att.id, accessToken,
      );
      toast.push('Report deleted', 'success');
      loadReports();
    } catch (err) {
      const message = err?.message || 'Could not delete report';
      toast.push(message, 'error');
    }
  }

  // ─── Render ───────────────────────────────────────────────────────────
  const isAdmin = !!employee?.isAdmin;
  const isUploading = uploadPhase !== 'idle';

  return (
    <div className="dpr-page">
      <div className="dpr-card">
        <Breadcrumb
          items={[
            { label: 'Project Reports' },
          ]}
        />
        <h1 className="dpr-page-title" style={{ marginBottom: '0.25rem' }}>
          Project Reports
        </h1>
        <div style={{ color: 'var(--steel)', fontSize: '0.9rem', marginBottom: '1.5rem' }}>
          Upload and review weekly, monthly, due-diligence, and quality reports across your projects.
        </div>

        {/* Upload form */}
        <div
          style={{
            marginBottom: '1.5rem',
            padding: '1rem',
            background: '#f8fafc',
            borderRadius: 6,
            border: '1px solid #e2e8f0',
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: '0.75rem', color: 'var(--navy)' }}>
            Upload a report
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
              gap: '0.75rem',
              alignItems: 'end',
            }}
          >
            <div>
              <label htmlFor="mpr-project" style={{ display: 'block', fontSize: '0.8rem', color: 'var(--steel)', marginBottom: 4 }}>
                Project
              </label>
              <select
                id="mpr-project"
                className="form-select"
                value={selectedProjectId}
                onChange={(e) => setSelectedProjectId(e.target.value)}
                disabled={loadingProjects || isUploading}
                style={{ width: '100%', padding: '0.4rem 0.5rem', borderRadius: 4, border: '1px solid #cbd5e1' }}
              >
                {projects.length === 0 && (
                  <option value="">{loadingProjects ? 'Loading…' : 'No assigned projects'}</option>
                )}
                {projects.map((p) => (
                  <option key={p.id || p.name} value={p.id || p.name}>
                    {p.name || p.code || p.id}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="mpr-type" style={{ display: 'block', fontSize: '0.8rem', color: 'var(--steel)', marginBottom: 4 }}>
                Type
              </label>
              <select
                id="mpr-type"
                className="form-select"
                value={uploadType}
                onChange={(e) => setUploadType(e.target.value)}
                disabled={isUploading}
                style={{ width: '100%', padding: '0.4rem 0.5rem', borderRadius: 4, border: '1px solid #cbd5e1' }}
              >
                {PROJECT_REPORT_TYPES.map((t) => (
                  <option key={t} value={t}>{PROJECT_REPORT_TYPE_LABELS[t]?.label || t}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="mpr-title" style={{ display: 'block', fontSize: '0.8rem', color: 'var(--steel)', marginBottom: 4 }}>
                Title (optional)
              </label>
              <input
                id="mpr-title"
                type="text"
                value={uploadTitle}
                onChange={(e) => setUploadTitle(e.target.value)}
                disabled={isUploading}
                placeholder="e.g. Week 37 progress"
                maxLength={200}
                style={{ width: '100%', padding: '0.4rem 0.5rem', borderRadius: 4, border: '1px solid #cbd5e1' }}
              />
            </div>
            <div>
              <label htmlFor="mpr-file" style={{ display: 'block', fontSize: '0.8rem', color: 'var(--steel)', marginBottom: 4 }}>
                File
              </label>
              <input
                id="mpr-file"
                type="file"
                accept={FILE_ACCEPT}
                onChange={(e) => setUploadFile(e.target.files?.[0] || null)}
                disabled={isUploading}
                style={{ width: '100%' }}
              />
            </div>
            <div>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={handleUpload}
                disabled={isUploading || !uploadFile || !selectedProjectId}
                style={{ width: '100%' }}
              >
                {uploadPhase === 'sas' && 'Preparing…'}
                {uploadPhase === 'uploading' && `Uploading ${Math.round(uploadProgress)}%`}
                {uploadPhase === 'confirming' && 'Confirming…'}
                {uploadPhase === 'idle' && 'Upload'}
              </button>
            </div>
          </div>
          {uploadError && (
            <div
              role="alert"
              style={{
                marginTop: '0.5rem',
                fontSize: '0.85rem',
                color: '#b91c1c',
                background: '#fef2f2',
                padding: '0.4rem 0.6rem',
                borderRadius: 4,
                border: '1px solid #fecaca',
              }}
            >
              {uploadError}
            </div>
          )}
        </div>

        {/* Type chip filter */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '1rem' }}>
          <button
            type="button"
            className={`btn btn-sm ${filterType === '' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setFilterType('')}
          >
            All
          </button>
          {PROJECT_REPORT_TYPES.map((t) => (
            <button
              key={t}
              type="button"
              className={`btn btn-sm ${filterType === t ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setFilterType(t)}
            >
              {PROJECT_REPORT_TYPE_LABELS[t]?.short || t}
            </button>
          ))}
        </div>

        {/* Reports list */}
        {loadingReports ? (
          <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--steel)' }}>Loading reports…</div>
        ) : filteredReports.length === 0 ? (
          <div
            style={{
              padding: '2rem',
              textAlign: 'center',
              color: 'var(--steel)',
              background: '#f8fafc',
              borderRadius: 6,
              border: '1px dashed #cbd5e1',
            }}
          >
            {projects.length === 0
              ? 'No projects assigned to you yet.'
              : filterType
                ? `No ${PROJECT_REPORT_TYPE_LABELS[filterType]?.label || filterType} reports yet.`
                : 'No reports uploaded yet.'}
          </div>
        ) : (
          <div style={{ display: 'grid', gap: '0.5rem' }}>
            {filteredReports.map((r) => {
              const canDelete = isAdmin || (employee && r.uploadedById === employee.id);
              const typeLabel = PROJECT_REPORT_TYPE_LABELS[r.type]?.short || r.type;
              return (
                <div
                  key={r.id}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'auto 1fr auto auto',
                    gap: '0.75rem',
                    alignItems: 'center',
                    padding: '0.6rem 0.75rem',
                    background: '#fff',
                    border: '1px solid #e2e8f0',
                    borderRadius: 6,
                  }}
                >
                  <span
                    style={{
                      fontSize: '0.75rem',
                      fontWeight: 600,
                      color: '#1e40af',
                      background: '#dbeafe',
                      padding: '0.15rem 0.5rem',
                      borderRadius: 999,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {typeLabel}
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 500, color: 'var(--navy)', overflowWrap: 'anywhere' }}>
                      {r.title || r.filename}
                    </div>
                    <div style={{ fontSize: '0.8rem', color: 'var(--steel)' }}>
                      {r.projectName}
                      {r.uploadedBy?.name ? ` · ${r.uploadedBy.name}` : ''}
                      {` · ${formatShortDate(r.uploadedAt || r.createdAt) || '—'}`}
                      {r.sizeBytes ? ` · ${formatBytes(r.sizeBytes)}` : ''}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => handleDownload(r)}
                  >
                    Download
                  </button>
                  {canDelete && (
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => handleDelete(r)}
                      title="Delete this report"
                    >
                      Delete
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {error && !loadingReports && (
          <div role="alert" style={{ marginTop: '1rem', fontSize: '0.85rem', color: '#b91c1c' }}>
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
