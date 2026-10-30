import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { api } from '../../lib/api.js';
import { uploadBlob } from '../../lib/blobUpload.js';
import Breadcrumb from '../../components/Breadcrumb.jsx';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';

const POLL_INTERVAL_MS = 5000;
const MAX_FILES = 20;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const RATE_NOTICE = 'Sample rates are placeholders. This take-off is not an estimate or project cost. Check every quantity before use.';

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  return bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatCurrency(value, currency = 'INR') {
  if (!Number.isFinite(Number(value))) return '—';
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(Number(value));
}

function cleanError(err) {
  if (err?.code === 'BOQ_SERVICE_UNAVAILABLE') return 'The drawing service is not available right now. Your upload is safe; try again shortly.';
  if (err?.code === 'BOQ_TIMEOUT' || err?.code === 'TIMEOUT') return 'The service is taking longer than expected. Your run is saved; check Recent runs in a moment.';
  return err?.message || 'Something went wrong. Please try again.';
}

export default function BoqGenerator() {
  useDocumentTitle('BOQ Generator');
  const { accessToken, employee } = useAuth();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState(searchParams.get('projectId') || '');
  const [newProjectName, setNewProjectName] = useState('');
  const [creatingProject, setCreatingProject] = useState(false);
  const [showProjectForm, setShowProjectForm] = useState(false);
  const [files, setFiles] = useState([]);
  const [confirmedUploads, setConfirmedUploads] = useState([]);
  const [confirmedForJob, setConfirmedForJob] = useState([]);
  const [scaleByFileId, setScaleByFileId] = useState({});
  const [confirmedScaleFileIds, setConfirmedScaleFileIds] = useState([]);
  const [wastagePct, setWastagePct] = useState('0');
  const [meta, setMeta] = useState(null);
  const [metaLoading, setMetaLoading] = useState(true);
  const [jobs, setJobs] = useState([]);
  const [job, setJob] = useState(null);
  const [boq, setBoq] = useState(null);
  const [loading, setLoading] = useState(true);
  const [pilotAccess, setPilotAccess] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [expandedLineId, setExpandedLineId] = useState('');
  const [correctionQty, setCorrectionQty] = useState('');
  const [correctionReason, setCorrectionReason] = useState('Measured on site');
  const [savingCorrection, setSavingCorrection] = useState(false);
  const [onlyFlagged, setOnlyFlagged] = useState(true);
  const [acknowledgedRevision, setAcknowledgedRevision] = useState(null);
  const currentRevision = job?.snapshot?.revision || job?.revision || 1;
  const acknowledged = acknowledgedRevision === currentRevision;
  const [submitting, setSubmitting] = useState(false);
  const openedJobIdRef = useRef('');
  const submissionRef = useRef(null);
  const fileInputRef = useRef(null);
  const localProjectsRef = useRef(new Map());

  const selectedProject = projects.find((project) => project.id === projectId);
  const rateSources = meta?.rateSources || [];
  const activeRateSource = rateSources[0]?.name || 'TN_PWD_SOR';
  const completedJob = ['COMPLETED', 'COMPLETED_PENDING_EXPORT'].includes(job?.status);
  const isSample = job?.snapshot
    ? job.snapshot.dataStatus !== 'REAL' || job.snapshot.productionMode !== true
    : completedJob
      ? job.dataStatus !== 'REAL' || job.productionMode !== true
      : !meta || meta.effectiveStatus !== 'REAL' || meta.productionMode !== true;
  const supportedTypes = (meta?.supportedInputTypes || ['ifc', 'dxf']).filter((type) => ['ifc', 'dxf'].includes(type));
  const acceptedExtensions = supportedTypes.length ? supportedTypes : ['ifc', 'dxf'];

  const loadJobs = useCallback(async (forProject = projectId) => {
    try {
      const response = await api.boqGenerator.listJobs(forProject, accessToken);
      setJobs(response.jobs || []);
    } catch (err) {
      setError(cleanError(err));
    }
  }, [accessToken]);

  const refreshProjects = async () => {
    try {
      const response = await api.getProjects({ scope: 'assigned' }, accessToken);
      setProjects((current) => [
        ...(response.projects || []),
        ...current.filter((project) => !(response.projects || []).some((assigned) => assigned.id === project.id)),
      ]);
      if ((response.projects || []).some((project) => project.id === projectId)) {
        setNotice('Your project assignment is active. You can upload drawings now.');
      }
    } catch (err) {
      setError(cleanError(err));
    }
  };

  const loadJob = useCallback(async (id) => {
    const next = await api.boqGenerator.getJob(id, accessToken);
    setJob(next);
    setOnlyFlagged(true);
    setExpandedLineId('');
    setAcknowledgedRevision(null);
    if (['COMPLETED', 'COMPLETED_PENDING_EXPORT'].includes(next.status)) setBoq(await api.boqGenerator.getBoq(id, accessToken));
    else setBoq(null);
    return next;
  }, [accessToken]);

  const retryJob = async (run) => {
    setError('');
    try {
      const original = await api.boqGenerator.getJob(run.id, accessToken);
      if (['DRAFT', 'LOST'].includes(original.status)) {
        const retried = await api.boqGenerator.retryJob(run.id, accessToken);
        setJob(retried);
        setSearchParams({ projectId: retried.projectId, jobId: retried.id });
        return;
      if (original.status === 'LOST') {
        const retried = await api.boqGenerator.retryJob(run.id, accessToken);
        setJob(retried);
        setBoq(null);
        setSearchParams({ projectId: retried.projectId, jobId: retried.id });
        return;
      }
      }
      setNotice(`The original files for this ${run.status.toLowerCase()} run are not in this browser. Select and upload them again to create a new run.`);
      setSearchParams({ projectId: original.projectId });
    } catch (err) {
      setError(cleanError(err));
    }
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      const [projectsResult, accessResult] = await Promise.allSettled([
        api.getProjects({ scope: 'assigned' }, accessToken),
        api.boqGenerator.access(accessToken),
      ]);
      if (!alive) return;
      if (projectsResult.status === 'fulfilled') {
        const assigned = projectsResult.value.projects || [];
        localProjectsRef.current.forEach((project) => {
          if (!assigned.some((candidate) => candidate.id === project.id)) assigned.push(project);
        });
        setProjects(assigned);
        const fromQuery = searchParams.get('projectId');
        if (fromQuery && assigned.some((project) => project.id === fromQuery)) setProjectId(fromQuery);
        else if (!projectId && assigned.length === 1) setProjectId(assigned[0].id);
      } else setError(cleanError(projectsResult.reason));
      if (accessResult.status === 'fulfilled') setPilotAccess(accessResult.value);
      else setError(cleanError(accessResult.reason));
      setLoading(false);
      if (accessResult.status === 'fulfilled' && !accessResult.value.isPilot) { setMetaLoading(false); return; }
      try { setMeta(await api.boqGenerator.meta(accessToken)); } catch (err) { setError(cleanError(err)); }
      finally { setMetaLoading(false); }
      if (alive) setLoading(false);
    })();
    return () => { alive = false; };
  }, [accessToken]);

  useEffect(() => {
    loadJobs(projectId);
  }, [loadJobs, projectId]);

  useEffect(() => {
    const requestedJobId = searchParams.get('jobId');
    if (!requestedJobId || requestedJobId === openedJobIdRef.current) return undefined;
    let active = true;
    openedJobIdRef.current = requestedJobId;
    (async () => {
      try {
      const opened = await api.boqGenerator.getJob(requestedJobId, accessToken);
      setJob(opened);
      setOnlyFlagged(true);
      setExpandedLineId('');
      setAcknowledgedRevision(null);
      if (['COMPLETED', 'COMPLETED_PENDING_EXPORT'].includes(opened.status)) setBoq(await api.boqGenerator.getBoq(requestedJobId, accessToken));
      else setBoq(null);
      } catch (err) {
        if (active) {
          openedJobIdRef.current = '';
          setError(cleanError(err));
        }
      }
    })();
    return () => { active = false; };
  }, [accessToken, searchParams]);

  useEffect(() => {
    if (!job?.id || !['DRAFT', 'SUBMITTING', 'SUBMITTED', 'RUNNING', 'COMPLETED_PENDING_EXPORT'].includes(job.status)) return undefined;
    let active = true;
    let timer;
    const poll = async () => {
      try {
        const next = await api.boqGenerator.getJob(job.id, accessToken);
        if (!active) return;
        setJob(next);
        if (next.status === 'FAILED' || next.status === 'LOST') {
          if (next.error?.message) setError(next.error.message);
          await loadJobs(next.projectId || projectId);
          return;
        }
        if (next.status === 'COMPLETED' || next.status === 'COMPLETED_PENDING_EXPORT') {
          try {
            setBoq(await api.boqGenerator.getBoq(next.id, accessToken));
          } catch (err) {
            if (err?.code !== 'BOQ_NOT_SAVED') setError(cleanError(err));
          }
          await loadJobs(next.projectId || projectId);
          return;
        }
      } catch (err) {
        setError(cleanError(err));
      }
      if (active) timer = window.setTimeout(poll, POLL_INTERVAL_MS);
    };
    timer = window.setTimeout(poll, POLL_INTERVAL_MS);
    return () => { active = false; window.clearTimeout(timer); };
  }, [job?.id, job?.status, accessToken, loadJobs]);

  const selectProject = (id) => {
    submissionRef.current = null;
    openedJobIdRef.current = '';
    setProjectId(id);
    setJob(null);
    setBoq(null);
    setFiles([]);
    setConfirmedUploads([]);
    setConfirmedForJob([]);
    setScaleByFileId({});
    setConfirmedScaleFileIds([]);
    setOnlyFlagged(true);
    setExpandedLineId('');
    setAcknowledgedRevision(null);
    setError('');
    setNotice('');
    if (id) setSearchParams({ projectId: id });
    else setSearchParams({});
  };

  const loadCreatedProjectAndContinue = async (project) => {
    submissionRef.current = null;
    openedJobIdRef.current = '';
    localProjectsRef.current.set(project.id, project);
    setProjects((current) => current.some((candidate) => candidate.id === project.id)
      ? current
      : [...current, project]);
    setShowProjectForm(false);
    setNewProjectName('');
    setProjectId(project.id);
    setJob(null);
    setBoq(null);
    setFiles([]);
    setConfirmedUploads([]);
    setConfirmedForJob([]);
    setScaleByFileId({});
    setConfirmedScaleFileIds([]);
    setOnlyFlagged(true);
    setExpandedLineId('');
    setAcknowledgedRevision(null);
    setError('');
    setSearchParams({ projectId: project.id });
    setJobs([]);
    if (project.allocationPending) {
      localProjectsRef.current.set(project.id, { ...project, allocationPending: true });
      setNotice(`“${project.name}” is pending administrator allocation. Choose an assigned project, or wait until an administrator assigns you before uploading drawings.`);
      localProjectsRef.current.set(project.id, { ...project, allocationPending: true });
      toast.push(`Project “${project.name}” is pending administrator allocation.`, 'info');
      return;
    }
    if (project.linkedTotal > 0) setNotice(`${project.linkedTotal} existing record${project.linkedTotal === 1 ? '' : 's'} linked to this project.`);
    toast.push(`Project “${project.name}” is ready. Add your IFC or DXF drawings below.`, 'success');
  };

  const createProject = async (event) => {
    event.preventDefault();
    const name = newProjectName.trim();
    if (!name || creatingProject) return;
    setCreatingProject(true);
    setError('');
    try {
      const project = await api.resolveProject(name, accessToken);
      await loadCreatedProjectAndContinue(project);
    } catch (err) {
      setError(err?.code === 'PROJECT_INACTIVE'
        ? 'That project is archived. Ask an administrator to reactivate it.'
        : cleanError(err));
    } finally {
      setCreatingProject(false);
    }
  };

  const addFiles = (incoming) => {
    submissionRef.current = null;
    const accepted = [];
    const rejected = [];
    for (const file of Array.from(incoming || [])) {
      const extension = file.name.split('.').pop().toLowerCase();
      if (!acceptedExtensions.includes(extension)) rejected.push(`${file.name}: the service does not support ${extension.toUpperCase()} files.`);
      else if (file.size <= 0 || file.size > MAX_FILE_BYTES) rejected.push(`${file.name}: maximum file size is 50 MB.`);
      else accepted.push({ file, id: `${file.name}-${file.size}-${file.lastModified}`, progress: 0 });
    }
    const newFiles = accepted.filter((next) => !files.some((file) => file.id === next.id));
    if (files.length + newFiles.length > MAX_FILES) {
      setError(`A run can include up to ${MAX_FILES} drawings. Remove some files or start another run.`);
      return;
    }
    if (rejected.length) setError(rejected.join(' '));
    setScaleByFileId((current) => ({ ...current, ...Object.fromEntries(newFiles.map((item) => [item.id, '1'])) }));
    setConfirmedScaleFileIds((current) => current.filter((id) => files.some((file) => file.id === id)));
    setFiles((current) => [...current, ...newFiles]);
    if (accepted.length) setError('');
  };

  const prepareUploads = async () => {
    const confirmedFileIds = new Set(confirmedUploads.map((upload) => upload.fileId));
    const uploadsByFileId = new Map(confirmedUploads.map((upload) => [upload.fileId, upload.uploadId]));
    for (const item of files) {
      if (confirmedFileIds.has(item.id)) continue;
      const signed = await api.boqGenerator.presignUpload({
        projectId,
        filename: item.file.name,
        sizeBytes: item.file.size,
      }, accessToken);
      await uploadBlob(signed.sasUrl, item.file, {
        contentType: 'application/octet-stream',
        timeoutMs: Math.max(60_000, Math.ceil(item.file.size / (1024 * 1024)) * 10_000),
        onProgress: (pct) => {
          const total = files.reduce((sum, file) => sum + (file.id === item.id ? pct : file.progress), 0);
          item.progress = pct;
          setProgress(Math.round(total / files.length));
        },
      });
      await api.boqGenerator.confirmUpload(signed.uploadId, accessToken);
      confirmedFileIds.add(item.id);
      uploadsByFileId.set(item.id, signed.uploadId);
      setConfirmedUploads((current) => [...current.filter((upload) => upload.fileId !== item.id), { fileId: item.id, uploadId: signed.uploadId }]);
      setConfirmedForJob((current) => [...current.filter((upload) => upload.fileId !== item.id), { fileId: item.id, uploadId: signed.uploadId }]);
    }
    return files.map((file) => ({ uploadId: uploadsByFileId.get(file.id), file })).filter(({ uploadId }) => uploadId);
  };

  const generate = async (event) => {
    event.preventDefault();
    if (!projectId || !files.length || submitting || uploading) return;
    setSubmitting(true);
    setUploading(true);
    setError('');
    setProgress(0);
    try {
      if (!submissionRef.current) {
        const uploadsByScale = await prepareUploads();
        if (!uploadsByScale.length) throw new Error('The selected drawings could not be confirmed. Choose them again and retry.');
        submissionRef.current = {
          key: typeof crypto !== 'undefined' && crypto.randomUUID
            ? crypto.randomUUID()
            : `boq-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          batches: Object.values(uploadsByScale.reduce((batches, upload) => {
            const key = upload.file.file.name.toLowerCase().endsWith('.dxf') ? String(scaleByFileId[upload.file.id] || 1) : 'ifc';
            batches[key] ||= { projectId, uploads: [], dxfScale: key === 'ifc' ? null : Number(key), rateSource: activeRateSource, wastagePct: Number(wastagePct) || 0 };
            batches[key].uploads.push(upload.uploadId);
            return batches;
          }, {})),
          index: 0,
          job: job?.status === 'DRAFT' ? job : null,
        };
      }
      setUploading(false);
      let created = submissionRef.current.job;
      for (let index = submissionRef.current.index; index < submissionRef.current.batches.length; index += 1) {
        const batch = submissionRef.current.batches[index];
        created = await api.boqGenerator.createJob(batch, accessToken, `${submissionRef.current.key}-${index}`);
        submissionRef.current.job = created;
        submissionRef.current.index = index + 1;
      }
      submissionRef.current = null;
      openedJobIdRef.current = created.id;
      setJob(created);
      setOnlyFlagged(true);
      setExpandedLineId('');
      setAcknowledgedRevision(null);
      setBoq(null);
      setFiles([]);
      setConfirmedUploads([]);
      setConfirmedForJob([]);
      setScaleByFileId({});
      setConfirmedScaleFileIds([]);
      setSearchParams({ projectId, jobId: created.id });
      await loadJobs(projectId);
    } catch (err) {
      setError(cleanError(err));
    } finally {
      setSubmitting(false);
    }
  };

  const openJob = async (run) => {
    setError('');
    try {
      if (run.projectId !== projectId) selectProject(run.projectId);
      openedJobIdRef.current = run.id;
      const next = await loadJob(run.id);
      setSearchParams({ ...(next.projectId ? { projectId: next.projectId } : {}), jobId: run.id });
    } catch (err) {
      setError(cleanError(err));
    }
  };

  const saveExport = async () => {
    if (!job || !acknowledged) return;
    setError('');
    try {
      await api.boqGenerator.save(job.id, accessToken);
      await api.boqGenerator.acknowledgeExport(job.id, accessToken);
      const download = await api.boqGenerator.downloadExport(job.id, accessToken);
      const anchor = document.createElement('a');
      anchor.href = download.downloadUrl;
      anchor.download = download.filename || `boq-${job.id}.xlsx`;
      anchor.rel = 'noopener';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      toast.push('BOQ workbook downloaded.', 'success');
    } catch (err) {
      setError(cleanError(err));
    }
  };

  const setFileScale = (fileId, value) => {
    setScaleByFileId((current) => ({ ...current, [fileId]: value }));
    setConfirmedScaleFileIds((current) => current.filter((id) => id !== fileId));
  };

  const correctLine = async (line) => {
    const quantity = Number(correctionQty);
    if (!Number.isFinite(quantity) || quantity < 0 || correctionReason.trim().length < 4) {
      setError('Enter a non-negative quantity and choose a correction reason.');
      return;
    }
    setSavingCorrection(true);
    setError('');
    try {
      const correction = await api.boqGenerator.correctLine(job.id, line.line_id, {
        kind: 'override_qty', qty: quantity, reason: correctionReason,
      }, accessToken);
      const revised = await api.boqGenerator.getBoq(job.id, accessToken);
      const priorCorrections = boq?.corrections || [];
      setBoq({ ...revised, corrections: [...priorCorrections, correction.correction].filter(Boolean) });
      setAcknowledgedRevision(null);
      setJob((current) => ({ ...current, revision: correction.revision || (current.revision || 1) + 1, snapshot: { ...current.snapshot, revision: correction.revision || (current.snapshot?.revision || current.revision || 1) + 1, acknowledgedAt: null } }));
      setExpandedLineId('');
      toast.push('Quantity correction saved to the audit trail.', 'success');
    } catch (err) {
      setError(cleanError(err));
    } finally {
      setSavingCorrection(false);
    }
  };

  const lines = useMemo(() => boq?.lines || [], [boq]);
  const reviewLines = useMemo(() => {
    const flaggedIds = new Set((boq?.flags || []).map((flag) => flag.line_id || flag.element_id).filter(Boolean));
    const unpricedIds = new Set((boq?.withheld || []).map((item) => item.line_id || item.element_id).filter(Boolean));
    return lines.filter((line) => flaggedIds.has(line.line_id) || flaggedIds.has(line.element_id) || line.element_ids?.some((id) => flaggedIds.has(id)) ||
      unpricedIds.has(line.line_id) || line.element_ids?.some((id) => unpricedIds.has(id)) ||
      line.rate == null);
  }, [boq, lines]);
  const shownLines = onlyFlagged ? reviewLines : lines;
  const flaggedCount = reviewLines.length;
  const isInProgress = job && ['DRAFT', 'SUBMITTING', 'SUBMITTED', 'RUNNING', 'COMPLETED_PENDING_EXPORT'].includes(job.status);

  useEffect(() => {
    if (!loading && searchParams.get('jobId') && !job && !error) {
      api.boqGenerator.getJob(searchParams.get('jobId'), accessToken)
        .then(setJob)
        .catch((err) => setError(cleanError(err)));
    }
  }, [loading, searchParams, job, error, accessToken]);

  if (loading) return <div className="dpr-page"><p role="status">Loading BOQ Generator…</p></div>;

  if (pilotAccess && !pilotAccess.isPilot) return <main className="dpr-page"><h1>BOQ Generator</h1><p role="status">This tool is in pilot and is not available to your account.</p></main>;

  return (
    <main className="dpr-page" aria-labelledby="boq-generator-title">
      <div className="dpr-page-header">
        <Breadcrumb items={[{ label: 'Tools' }, { label: 'BOQ Generator' }]} />
        <h1 id="boq-generator-title" className="dpr-page-title">BOQ Generator</h1>
        <p style={{ color: 'var(--steel)', maxWidth: 760, marginTop: 0 }}>
          Upload an IFC or DXF model to create a quantity take-off. Review the measured lines before saving a workbook.
        </p>
      </div>

      {error && <div role="alert" style={{ padding: '0.85rem 1rem', marginBottom: '1rem', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 10, color: '#991B1B' }}>{error}</div>}
      {notice && <div role="status" style={{ padding: '0.75rem 1rem', marginBottom: '1rem', background: '#EFF6FF', border: '1px solid #BFDBFE', borderRadius: 10 }}>{notice}</div>}

      {metaLoading && pilotAccess?.pilotEnabled && <div role="status">Checking BOQ data status…</div>}
      {pilotAccess?.pilotEnabled && isSample && !completedJob && <div role="status" style={{ background: '#FEF3C7', color: '#78350F', border: '1px solid #F59E0B', borderRadius: 10, padding: '0.85rem 1rem', marginBottom: '1rem', fontWeight: 600 }}>
        SAMPLE DATA — {RATE_NOTICE}
      </div>}

      <section className="dpr-card" aria-labelledby="boq-drawings-heading" style={{ padding: '1.25rem', marginBottom: '1rem' }}>
        <h2 id="boq-project-heading" style={{ marginTop: 0 }}>1. Choose a project</h2>
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '1rem' }}>
          <label htmlFor="boq-project-select" style={{ fontWeight: 600 }}>Project</label>
          <select id="boq-project-select" className="form-input" style={{ flex: '1 1 260px', maxWidth: 560 }} value={projectId} onChange={(event) => { selectProject(event.target.value); setNotice(''); }}>
            <option value="">Select an assigned project…</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
          <button type="button" className="btn btn-secondary" onClick={() => setShowProjectForm((show) => !show)}>
            {showProjectForm ? 'Cancel' : '+ Add project'}
          </button>
        </div>
        {showProjectForm && <form onSubmit={createProject} style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.8rem', maxWidth: 720 }}>
          <label htmlFor="boq-new-project" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>New project name</label>
          <input id="boq-new-project" className="form-input" value={newProjectName} maxLength={200} onChange={(event) => setNewProjectName(event.target.value)} placeholder="Enter project name" required />
          <button type="submit" className="btn btn-primary" disabled={creatingProject}>{creatingProject ? 'Creating…' : 'Create project'}</button>
        </form>}
        {projects.length === 0 && !showProjectForm && <p style={{ color: 'var(--steel)', marginBottom: 0 }}>No assigned projects yet. Add a project to get started.</p>}
        {selectedProject?.allocationPending && <div role="status" style={{ color: 'var(--steel)', marginTop: '0.5rem' }}><p style={{ margin: 0 }}>This project is pending administrator allocation. Choose an assigned project or ask an administrator to assign you before uploading drawings.</p><button type="button" className="btn btn-secondary" style={{ marginTop: '0.5rem' }} onClick={refreshProjects}>Check allocation</button></div>}
        {selectedProject && !selectedProject.allocationPending && <p style={{ color: 'var(--steel)', marginBottom: 0, marginTop: '0.5rem' }}>Your project and uploads are private to your portal account.</p>}
      </section>

      <section className="dpr-card" aria-labelledby="boq-drawings-heading" style={{ padding: '1.25rem', marginBottom: '1rem', opacity: projectId ? 1 : 0.7 }}>
        <h2 id="boq-drawings-heading" style={{ marginTop: 0 }}>2. Add model drawings</h2>
        <p style={{ color: 'var(--steel)', marginTop: 0 }}>Choose {acceptedExtensions.map((type) => type.toUpperCase()).join(' or ')} files from your device. PDF sheets can be kept in the drawing register, but cannot be measured here.</p>
        <input ref={fileInputRef} aria-label="Select model drawings" type="file" accept={acceptedExtensions.map((type) => `.${type}`).join(',')} multiple disabled={!projectId || selectedProject?.allocationPending} onChange={(event) => { addFiles(event.target.files); event.target.value = ''; }} style={{ position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none' }} />
        <button
          type="button"
          className="boq-upload-dropzone"
          disabled={!projectId || selectedProject?.allocationPending}
          aria-label={`Choose ${acceptedExtensions.map((type) => type.toUpperCase()).join(' or ')} drawing files`}
          onClick={() => projectId && !selectedProject?.allocationPending && fileInputRef.current?.click()}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => { event.preventDefault(); if (projectId && !selectedProject?.allocationPending) addFiles(event.dataTransfer.files); }}
          style={{ display: 'block', width: '100%', border: '2px dashed #94A3B8', borderRadius: 12, padding: '1.5rem', textAlign: 'center', cursor: projectId ? 'pointer' : 'not-allowed', background: '#F8FAFC', color: 'inherit', font: 'inherit' }}
        >
          <strong>{projectId ? `Drop ${acceptedExtensions.map((type) => type.toUpperCase()).join('/')} files here or browse` : 'Choose a project first'}</strong>
          <div style={{ color: 'var(--steel)', fontSize: 14, marginTop: 4 }}>Up to {MAX_FILES} files · 50 MB each</div>
        </button>
        {files.length > 0 && <ul aria-label="Selected drawings" style={{ listStyle: 'none', padding: 0, margin: '0.75rem 0' }}>
          {files.map((item) => <li key={item.id} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap', padding: '0.55rem 0', borderBottom: '1px solid var(--border)' }}>
            <span style={{ flex: 1 }}>{item.file?.name || item.filename} <span style={{ color: 'var(--steel)' }}>({formatBytes(item.file?.size ?? item.sizeBytes)})</span></span>
            {item.file?.name.toLowerCase().endsWith('.dxf') && <label>Scale factor
              <input className="form-input" aria-label={`Scale factor for ${item.file.name}`} type="number" min="0.000001" step="any" value={scaleByFileId[item.id] ?? '1'} onChange={(event) => setFileScale(item.id, event.target.value)} />
            </label>}
            {item.file?.name.toLowerCase().endsWith('.dxf') && <label><input type="checkbox" aria-label={`Confirm scale for ${item.file.name}`} checked={confirmedScaleFileIds.includes(item.id)} onChange={(event) => setConfirmedScaleFileIds((current) => event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id))} /> Confirm scale</label>}
            {uploading && <span aria-label="Upload progress">{progress}%</span>}
            <button type="button" className="btn btn-secondary" onClick={() => {
              submissionRef.current = null;
              setFiles((current) => current.filter((file) => file.id !== item.id));
              setConfirmedUploads((current) => current.filter((upload) => upload.fileId !== item.id));
              setConfirmedForJob((current) => current.filter((upload) => upload.fileId !== item.id));
              setScaleByFileId((current) => { const next = { ...current }; delete next[item.id]; return next; });
              setConfirmedScaleFileIds((current) => current.filter((id) => id !== item.id));
            }} disabled={uploading} aria-label={`Remove ${item.file?.name || item.filename}`}>Remove</button>
          </li>)}
        </ul>}
        {projectId && <details style={{ marginTop: '1rem' }}>
          <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Rate settings</summary>
          <label style={{ display: 'block', marginTop: '0.75rem' }}>Rate source
            {rateSources.length > 1 ? <select className="form-input" value={activeRateSource} onChange={(event) => setMeta((current) => ({ ...current, rateSources: [current.rateSources.find((source) => source.name === event.target.value), ...current.rateSources.filter((source) => source.name !== event.target.value)] }))}>
              {rateSources.map((source) => <option key={source.name} value={source.name}>{source.name}{source.isSample ? ' (sample)' : ''}</option>)}
            </select> : <span style={{ display: 'block', padding: '0.6rem 0' }}>{activeRateSource}{rateSources[0]?.isSample || isSample ? ' — sample rates' : ''}</span>}
          </label>
        </details>}
        <button type="button" className="btn btn-primary" style={{ marginTop: '1rem' }} disabled={!projectId || selectedProject?.allocationPending || !files.length || submitting || files.some((file) => file.file?.name.toLowerCase().endsWith('.dxf') && (!(Number(scaleByFileId[file.id]) > 0) || !confirmedScaleFileIds.includes(file.id)))} onClick={generate}>
          {uploading ? 'Uploading drawings…' : submitting ? 'Starting take-off…' : 'Generate BOQ'}
        </button>
      </section>

      {isInProgress && <section className="dpr-card" aria-live="polite" style={{ padding: '1.25rem', marginBottom: '1rem' }}>
        <h2 style={{ marginTop: 0 }}>Measuring your drawings</h2>
        <p>{job.status === 'DRAFT' || job.status === 'SUBMITTING' ? 'Starting the drawing service…' : 'Your take-off is processing. You can leave this page; your run will be in Recent runs.'}</p>
        <div role="progressbar" aria-label="BOQ processing" aria-valuemin="0" aria-valuemax="100" aria-valuenow={job.status === 'DRAFT' || job.status === 'SUBMITTING' ? 10 : 60} style={{ height: 8, background: '#E2E8F0', borderRadius: 99 }}>
          <div style={{ width: `${job.status === 'DRAFT' || job.status === 'SUBMITTING' ? 10 : 60}%`, height: '100%', background: 'var(--blue)', borderRadius: 99 }} />
        </div>
        <p style={{ color: 'var(--steel)', marginBottom: 0 }}>Status: {job.status.replaceAll('_', ' ').toLowerCase()}</p>
      </section>}

      {boq && completedJob && <section className="dpr-card" aria-labelledby="boq-results-heading" style={{ padding: '1.25rem', marginBottom: '1rem' }}>
        {isSample && <div role="alert" style={{ background: '#FEF3C7', color: '#78350F', borderRadius: 8, padding: '0.75rem', marginBottom: '1rem' }}><strong>SAMPLE DATA — NOT AN ESTIMATE.</strong> {RATE_NOTICE}</div>}
        {(boq.flags || []).length > 0 && <div role="status" aria-label="Result flags" style={{ background: '#FFF7ED', color: '#9A3412', borderRadius: 8, padding: '0.75rem', marginBottom: '1rem' }}>
          <strong>Review flags — quantities are unchanged unless noted:</strong>
          <ul style={{ marginBottom: 0 }}>{boq.flags.map((flag, index) => <li key={`${flag.reason_code || 'flag'}-${index}`}>
            <strong>{flag.reason_code || 'Review'}</strong>{flag.description ? ` — ${flag.description}` : ''}{flag.detail ? `: ${flag.detail}` : ''}
          </li>)}</ul>
        </div>}
        {(boq.corrections || []).length > 0 && <details><summary>Correction history ({boq.corrections.length})</summary><ol>{boq.corrections.map((correction, index) => <li key={correction.id || index}>{correction.reason || correction.kind} — {correction.kind} {correction.old_qty != null && `from ${correction.old_qty} to ${correction.qty}`}</li>)}</ol></details>}
        {(boq.withheld || []).some((item) => !item.line_id) && <p role="status" style={{ color: 'var(--steel)' }}>Some diagnostics or material flags are listed with unpriced items; they are not all unpriced BOQ lines.</p>}
        <h2 id="boq-results-heading" style={{ marginTop: 0 }}>Review your take-off</h2>
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
          <span>{flaggedCount} flagged or unpriced of {lines.length} lines</span>
          {onlyFlagged
            ? <button type="button" className="btn btn-secondary" onClick={() => setOnlyFlagged(false)}>Show all {lines.length} lines</button>
            : <button type="button" className="btn btn-secondary" onClick={() => setOnlyFlagged(true)}>Show flagged and unpriced only ({flaggedCount})</button>}
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 680 }}>
            <thead><tr>{['Level', 'Item', 'Description', 'Unit', 'Quantity', 'Rate', 'Amount', ''].map((heading) => <th key={heading} scope="col" style={{ textAlign: 'left', padding: '0.65rem', borderBottom: '2px solid var(--border)' }}>{heading}</th>)}</tr></thead>
            <tbody>{shownLines.map((line) => <React.Fragment key={line.line_id}>
              <tr>
                <td style={{ padding: '0.65rem', borderBottom: '1px solid var(--border)' }}>{line.level || '—'}</td>
                <td style={{ padding: '0.65rem', borderBottom: '1px solid var(--border)' }}>{line.item_code}</td>
                <td style={{ padding: '0.65rem', borderBottom: '1px solid var(--border)' }}>{line.description}</td>
                <td style={{ padding: '0.65rem', borderBottom: '1px solid var(--border)' }}>{line.unit}</td>
                <td style={{ padding: '0.65rem', borderBottom: '1px solid var(--border)' }}>{line.qty_rounded ?? line.qty}</td>
                <td style={{ padding: '0.65rem', borderBottom: '1px solid var(--border)' }}>{line.rate == null ? '—' : formatCurrency(line.rate, boq.totals?.currency)}</td>
                <td style={{ padding: '0.65rem', borderBottom: '1px solid var(--border)' }}>{line.amount == null ? '—' : formatCurrency(line.amount, boq.totals?.currency)}</td>
                <td style={{ padding: '0.65rem', borderBottom: '1px solid var(--border)' }}><button type="button" className="btn btn-secondary" onClick={() => { setExpandedLineId(expandedLineId === line.line_id ? '' : line.line_id); setCorrectionQty(String(line.qty_rounded ?? line.qty ?? '')); }}>Review</button></td>
              </tr>
              {expandedLineId === line.line_id && <tr><td colSpan="8" style={{ background: '#F8FAFC', padding: '1rem' }}>
                <p style={{ marginTop: 0 }}>How measured: {(line.reason_codes || []).join(', ') || 'not stated'} · From {line.source_group || line.provenance?.source_group || 'drawing take-off'}{line.provenance?.sor_code ? ` · SOR code: ${line.provenance.sor_code}` : ''}</p>
                {Array.isArray(line.alternatives) && line.alternatives.length > 0 && <details style={{ marginBottom: '0.75rem' }}>
                  <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Alternative rates ({line.alternatives.length})</summary>
                  <ul>{line.alternatives.map((alternative, index) => <li key={`${alternative.code || alternative.source}-${index}`}>
                    {alternative.code || 'Uncoded'} — {alternative.description || 'Alternative rate'}: {formatCurrency(alternative.rate, boq.totals?.currency)} ({alternative.source || 'source'}{alternative.score != null ? `, score ${alternative.score}` : ''})
                  </li>)}</ul>
                </details>}
                <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'end' }}>
                  <label>Correct quantity<input className="form-input" type="number" min="0" step="any" value={correctionQty} onChange={(event) => setCorrectionQty(event.target.value)} /></label>
                  <label>Reason<select className="form-input" value={correctionReason} onChange={(event) => setCorrectionReason(event.target.value)}>
                    {['Measured on site', 'Scale was wrong', 'Duplicate', 'Includes openings', 'Other correction'].map((reason) => <option key={reason}>{reason}</option>)}
                  </select></label>
                  <button type="button" className="btn btn-primary" disabled={savingCorrection} onClick={() => correctLine(line)}>{savingCorrection ? 'Saving…' : 'Apply correction'}</button>
                  <button type="button" className="btn btn-secondary" onClick={() => setExpandedLineId('')}>Cancel</button>
                </div>
              </td></tr>}
            </React.Fragment>)}</tbody>
          </table>
        </div>
        {(boq.withheld || []).length > 0 && <details style={{ marginTop: '1rem' }}>
          <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Unpriced items and diagnostics ({boq.withheld.length})</summary>
          <p>Withheld records include unpriced quantities and diagnostic or material flags. Only unpriced BOQ lines are excluded from the line total.</p>
          <ul>{boq.withheld.map((item, index) => <li key={`${item.item_code || item.description}-${index}`}>{item.item_code || 'Unmatched'} — {item.description} ({item.reason_code || 'not priced'})</li>)}</ul>
        </details>}
        <div style={{ marginTop: '1.25rem', padding: '1rem', background: '#FFF7ED', border: '1px solid #FDBA74', borderRadius: 10 }}>
          <strong>Take-off total — not project cost</strong>
          <div style={{ fontSize: 24, fontWeight: 700, margin: '0.35rem 0' }}>{formatCurrency(boq.totals?.amount, boq.totals?.currency)}</div>
          <div>{boq.totals?.line_count ?? lines.length} measured lines · {Number.isInteger(boq.totals?.unpriced_line_count) ? boq.totals.unpriced_line_count : lines.filter((line) => line.rate == null).length} unpriced · {activeRateSource}</div>
          {Number.isInteger(job.snapshot?.pricedLineCount) && <div>Saved coverage: {job.snapshot.pricedLineCount} priced · {job.snapshot.unpricedLineCount} unpriced</div>}
        </div>
        {isSample && <p><strong>Sample rates</strong> — these are placeholders, not project cost.</p>}
        <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'start', marginTop: '1rem' }}>
          <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledgedRevision(event.target.checked ? currentRevision : null)} />
          <span>I have reviewed revision {job.snapshot?.revision || job.revision || 1}, understand rates may be samples, and will check quantities before use.</span>
        </label>
        <button type="button" className="btn btn-primary" style={{ marginTop: '0.75rem' }} disabled={!acknowledged} onClick={saveExport}>Save & download Excel</button>
        {job.status === 'COMPLETED_PENDING_EXPORT' && <p role="status" style={{ color: 'var(--steel)' }}>Your BOQ is saved. The workbook is still being prepared; this page will keep checking.</p>}
      </section>}

      <section className="dpr-card" aria-labelledby="boq-recent-heading" style={{ padding: '1.25rem' }}>
        <h2 id="boq-recent-heading" style={{ marginTop: 0 }}>Recent runs</h2>
        {jobs.length === 0 ? <p style={{ color: 'var(--steel)', marginBottom: 0 }}>{projectId ? 'No runs for this project yet.' : 'Choose or create a project to see its runs.'}</p> : <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {jobs.map((run) => <li key={run.id} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap', padding: '0.6rem 0', borderBottom: '1px solid var(--border)' }}>
            <span style={{ flex: 1 }}>{projects.find((project) => project.id === run.projectId)?.name || run.projectId} · {new Date(run.createdAt).toLocaleString()}</span>
            <span>{String(run.status || 'unknown').replaceAll('_', ' ').toLowerCase()}</span>
            <button type="button" className="btn btn-secondary" onClick={() => openJob(run)}>Open</button>
            {['DRAFT', 'LOST'].includes(run.status) && <button type="button" className="btn btn-secondary" onClick={() => retryJob(run)}>Run again</button>}
          </li>)}
        </ul>}
        <button type="button" className="btn btn-secondary" style={{ marginTop: '0.75rem' }} onClick={() => loadJobs(projectId)}>Refresh runs</button>
      </section>
    </main>
  );
}