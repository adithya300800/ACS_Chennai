import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { api } from '../../lib/api.js';
import { uploadBlob } from '../../lib/blobUpload.js';
import { clear as clearScopedDraft, load as loadScopedDraft, save as saveScopedDraft } from '../../lib/ownerScopedDraft.js';
import Breadcrumb from '../../components/Breadcrumb.jsx';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';

const POLL_INTERVAL_MS = 5000;
const MAX_FILES = 20;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const PENDING_UPLOAD_DRAFT = 'boq_pending_uploads_v1';
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
  if (err?.code === 'BOQ_SERVICE_UNAVAILABLE') return 'The BOQ processor connection is not configured. Ask an administrator to check BOQ_BASE_URL and BOQ_API_TOKEN on the ACS_Chennai Render service. If you have selected drawings, keep this page open; they remain listed here for retry after setup is fixed.';
  if (err?.code === 'BOQ_SERVICE_AUTH_FAILED') return 'The BOQ processor rejected the portal credentials. Ask an administrator to verify that BOQ_API_TOKEN matches on both Render services. If you have selected drawings, keep this page open; they remain listed here for retry after setup is fixed.';
  if (err?.code === 'BOQ_TIMEOUT' || err?.code === 'TIMEOUT') return 'The service is taking longer than expected. Your run is saved; check Recent runs in a moment.';
  return err?.message || 'Something went wrong. Please try again.';
}

export default function BoqGenerator() {
  useDocumentTitle('BOQ Generator');
  const { accessToken, employee, isAdmin } = useAuth();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState(searchParams.get('projectId') || '');
  const [newProjectName, setNewProjectName] = useState('');
  const [creatingProject, setCreatingProject] = useState(false);
  const [showProjectForm, setShowProjectForm] = useState(false);
  const [resolvingProject, setResolvingProject] = useState(false);
  const [files, setFiles] = useState([]);
  const [confirmedUploads, setConfirmedUploads] = useState([]);
  const [pendingUploadProjectId, setPendingUploadProjectId] = useState('');
  const [scaleByFileId, setScaleByFileId] = useState({});
  const [confirmedScaleFileIds, setConfirmedScaleFileIds] = useState([]);
  const wastagePct = '0';
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

  useEffect(() => {
    const draft = loadScopedDraft(PENDING_UPLOAD_DRAFT, employee?.id);
    if (!employee?.id || !draft || draft.__quarantined || !Array.isArray(draft.files)) return;
    const restoredFiles = draft.files.filter((file) => file && typeof file.id === 'string' && typeof file.uploadId === 'string' && typeof file.filename === 'string')
      .map((file) => ({ ...file, progress: 0 }));
    if (!restoredFiles.length) return;
    const restoredProject = { id: draft.projectId, name: draft.projectName, isActive: true, allocationPending: true };
    localProjectsRef.current.set(draft.projectId, restoredProject);
    setProjects((current) => current.some((project) => project.id === draft.projectId) ? current : [...current, restoredProject]);
    setFiles(restoredFiles);
    setConfirmedUploads(restoredFiles.map(({ id, uploadId }) => ({ fileId: id, uploadId })));
    setProjectId(draft.projectId || '');
    setPendingUploadProjectId(draft.projectId || '');
    setScaleByFileId(draft.scaleByFileId || {});
    setConfirmedScaleFileIds(draft.confirmedScaleFileIds || []);
    setNotice('Restored privately uploaded drawings from this browser. They remain available until cleaned up; if an upload has expired, select the file again.');
    if (!draft.projectName) return;
    let active = true;
    api.resolveProject(draft.projectName, accessToken).then((project) => {
      if (!active || project.id !== draft.projectId) return;
      localProjectsRef.current.set(project.id, project);
      setProjects((current) => current.map((candidate) => candidate.id === project.id ? project : candidate));
      setPendingUploadProjectId(project.allocationPending ? project.id : '');
      if (!project.allocationPending) {
        setNotice('Your project assignment is active. You can generate a BOQ using the drawings uploaded earlier.');
        saveScopedDraft(PENDING_UPLOAD_DRAFT, employee?.id, { ...draft, projectPending: false });
      }
    }).catch(() => {});
    return () => { active = false; };
  }, [accessToken, employee?.id]);

  useEffect(() => {
    const clearDraft = (event) => {
      if (!employee?.id || event.detail?.employeeId !== employee.id) return;
      clearScopedDraft(PENDING_UPLOAD_DRAFT, employee.id);
      setFiles([]);
      setConfirmedUploads([]);
      setPendingUploadProjectId('');
    };
    window.addEventListener('draft:clear-current', clearDraft);
    return () => window.removeEventListener('draft:clear-current', clearDraft);
  }, [employee?.id]);

  useEffect(() => {
    if (pendingUploadProjectId && projectId !== pendingUploadProjectId) {
      const draft = loadScopedDraft(PENDING_UPLOAD_DRAFT, employee?.id);
      if (draft?.projectId !== projectId && draft?.projectPending !== true) setPendingUploadProjectId('');
    }
  }, [employee?.id, pendingUploadProjectId, projectId]);

  const loadJobs = useCallback(async (forProject = projectId) => {
    try {
      const response = await api.boqGenerator.listJobs(forProject, accessToken);
      setJobs(response.jobs || []);
    } catch (err) {
      setError(cleanError(err));
    }
  }, [accessToken]);

  const refreshProjects = async (projectIdToRefresh = projectId) => {
    try {
      const selected = projects.find((project) => project.id === projectIdToRefresh);
      if (selected?.allocationPending) {
        const resolved = await api.resolveProject(selected.name, accessToken);
        if (resolved.id !== projectIdToRefresh) return;
        const updated = { ...selected, ...resolved };
        localProjectsRef.current.set(projectIdToRefresh, updated);
        setProjects((current) => current.map((project) => project.id === projectIdToRefresh ? updated : project));
        setNotice(resolved.allocationPending
          ? (resolved.uploadsAllowed ? 'You can upload drawings now; BOQ generation remains assignment-gated.' : 'This project is assigned to another employee. You cannot upload or generate BOQs until you are assigned.')
          : 'Your project assignment is active. You can generate a BOQ now.');
        return;
      }
      const response = await api.getProjects({ scope: 'assigned' }, accessToken);
      setProjects((current) => [
        ...(response.projects || []),
        ...current.filter((project) => !(response.projects || []).some((assigned) => assigned.id === project.id)),
      ]);
      if ((response.projects || []).some((project) => project.id === projectIdToRefresh)) {
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
        if (original.status === 'LOST') setBoq(null);
        setSearchParams({ projectId: retried.projectId, jobId: retried.id });
        return;
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
        if (fromQuery && !assigned.some((project) => project.id === fromQuery)) {
          setResolvingProject(true);
          const urlDraft = loadScopedDraft(PENDING_UPLOAD_DRAFT, employee?.id);
          const draftName = urlDraft?.projectId === fromQuery ? urlDraft.projectName : '';
          const lookup = draftName
            ? api.resolveProject(draftName, accessToken)
            : api.getProject(fromQuery, accessToken).then((project) => project?.name
              ? api.resolveProject(project.name, accessToken)
              : project);
          lookup.then((project) => {
            if (!alive || !project?.id) return;
            if (!isAdmin && !project.allocationPending) {
              setProjectId('');
              setSearchParams({});
              return;
            }
            const pendingProject = project.allocationPending && !isAdmin;
            const resolvedProject = { ...project, allocationPending: pendingProject, uploadsAllowed: pendingProject && project.uploadsAllowed === true };
            localProjectsRef.current.set(project.id, resolvedProject);
            setProjects((current) => [...current.filter((candidate) => candidate.id !== project.id), resolvedProject]);
            setProjectId(project.id);
            if (pendingProject) setPendingUploadProjectId(project.id);
            if (urlDraft?.projectId === project.id && Array.isArray(urlDraft.files)) {
              const restoredFiles = urlDraft.files.filter((file) => file && typeof file.uploadId === 'string').map((file) => ({ ...file, progress: 0 }));
              setFiles(restoredFiles);
              setConfirmedUploads(restoredFiles.map(({ id: fileId, uploadId }) => ({ fileId, uploadId })));
            }
          }).catch((err) => {
            if (alive && err?.code !== 'PROJECT_NOT_FOUND') setError(cleanError(err));
            if (alive) setSearchParams({});
          }).finally(() => { if (alive) setResolvingProject(false); });
        } else if (fromQuery) setProjectId(fromQuery);
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
    if (id !== pendingUploadProjectId) {
      const draft = loadScopedDraft(PENDING_UPLOAD_DRAFT, employee?.id);
      if (draft?.projectId !== id && draft?.projectPending !== true) setPendingUploadProjectId('');
    }
    setProjectId(id);
    setJob(null);
    setBoq(null);
    setFiles([]);
    setConfirmedUploads([]);
    setScaleByFileId({});
    setConfirmedScaleFileIds([]);
    setOnlyFlagged(true);
    setExpandedLineId('');
    setAcknowledgedRevision(null);
    setError('');
    setNotice('');
    const draft = id && loadScopedDraft(PENDING_UPLOAD_DRAFT, employee?.id);
    if (draft?.projectId === id && Array.isArray(draft.files)) {
      const restoredFiles = draft.files.filter((file) => file && typeof file.uploadId === 'string').map((file) => ({ ...file, progress: 0 }));
      setFiles(restoredFiles);
      setConfirmedUploads(restoredFiles.map(({ id: fileId, uploadId }) => ({ fileId, uploadId })));
      setScaleByFileId(draft.scaleByFileId || {});
      setConfirmedScaleFileIds(draft.confirmedScaleFileIds || []);
      if (draft.projectPending) setPendingUploadProjectId(id);
      setNotice('Restored privately uploaded drawings for this project.');
    }
    if (id) setSearchParams({ projectId: id });
    else setSearchParams({});
  };

  const loadCreatedProjectAndContinue = async (project) => {
    submissionRef.current = null;
    openedJobIdRef.current = '';
    const previousProjectId = projectId;
    const savedDraft = loadScopedDraft(PENDING_UPLOAD_DRAFT, employee?.id);
    const savedFiles = savedDraft?.projectId === project.id && Array.isArray(savedDraft.files)
      ? savedDraft.files.filter((file) => file && typeof file.uploadId === 'string').map((file) => ({ ...file, progress: 0 }))
      : [];
    if (savedFiles.length || project.allocationPending) setPendingUploadProjectId(project.id);
    localProjectsRef.current.set(project.id, project);
    setProjects((current) => [...current.filter((candidate) => candidate.id !== project.id), project]);
    setShowProjectForm(false);
    setNewProjectName('');
    setProjectId(project.id);
    setJob(null);
    setBoq(null);
    setFiles(savedFiles);
    setConfirmedUploads(savedFiles.map(({ id, uploadId }) => ({ fileId: id, uploadId })));
    setScaleByFileId(savedDraft?.projectId === project.id ? savedDraft.scaleByFileId || {} : {});
    setConfirmedScaleFileIds(savedDraft?.projectId === project.id ? savedDraft.confirmedScaleFileIds || [] : []);
    if (savedDraft?.projectId && savedDraft.projectId !== project.id) clearScopedDraft(PENDING_UPLOAD_DRAFT, employee?.id);
    if (savedFiles.length && previousProjectId !== project.id) setNotice('Restored privately uploaded drawings from this browser. They remain available until cleaned up; if an upload has expired, select the file again.');
    setOnlyFlagged(true);
    setExpandedLineId('');
    setAcknowledgedRevision(null);
    setError('');
    setSearchParams({ projectId: project.id });
    setJobs([]);
    if (project.allocationPending && !isAdmin) {
      localProjectsRef.current.set(project.id, { ...project, allocationPending: true });
      const uploadsAllowed = project.uploadsAllowed !== false;
      if (savedDraft?.projectId && savedDraft.projectId !== project.id) {
        clearScopedDraft(PENDING_UPLOAD_DRAFT, employee?.id);
        setFiles([]);
        setConfirmedUploads([]);
      }
      setPendingUploadProjectId(project.id);
      setProjects((current) => current.map((candidate) => candidate.id === project.id ? { ...project, allocationPending: true, uploadsAllowed } : candidate));
      toast.push(`Project “${project.name}” is pending administrator allocation.`, 'info');
      return;
    }
    if (savedFiles.length) {
      setPendingUploadProjectId('');
      setNotice('Your project assignment is active. You can generate a BOQ using the drawings uploaded earlier.');
      saveScopedDraft(PENDING_UPLOAD_DRAFT, employee?.id, { ...savedDraft, projectPending: false });
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
    const newFiles = accepted.filter((next) => !files.some((file) => file.id === next.id && file.file));
    const replacedFiles = newFiles.filter((next) => files.some((file) => file.id === next.id && !file.file));
    if (files.length + newFiles.length - replacedFiles.length > MAX_FILES) {
      setError(`A run can include up to ${MAX_FILES} drawings. Remove some files or start another run.`);
      return;
    }
    if (rejected.length) setError(rejected.join(' '));
    setScaleByFileId((current) => ({ ...current, ...Object.fromEntries(newFiles.map((item) => [item.id, '1'])) }));
    setConfirmedScaleFileIds((current) => current.filter((id) => files.some((file) => file.id === id)));
    setFiles((current) => [...current.filter((file) => !newFiles.some((next) => next.id === file.id)), ...newFiles]);
    if (replacedFiles.length) {
      setConfirmedUploads((current) => current.filter((upload) => !replacedFiles.some((file) => file.id === upload.fileId)));
              if (selectedProject?.allocationPending && selectedProject.uploadsAllowed !== false) {
        const keptUploads = confirmedUploads.filter((upload) => !replacedFiles.some((file) => file.id === upload.fileId));
        if (keptUploads.length) saveScopedDraft(PENDING_UPLOAD_DRAFT, employee?.id, {
          projectId,
          projectName: selectedProject.name,
          projectPending: true,
          files: files.filter((file) => !replacedFiles.some((next) => next.id === file.id)).map((file) => ({
            id: file.id,
            filename: file.filename || file.file?.name,
            sizeBytes: file.sizeBytes ?? file.file?.size,
            lastModified: file.lastModified ?? file.file?.lastModified,
            uploadId: keptUploads.find((upload) => upload.fileId === file.id)?.uploadId,
          })).filter((file) => file.uploadId),
          scaleByFileId,
        });
        else clearScopedDraft(PENDING_UPLOAD_DRAFT, employee?.id);
      }
    }
    if (accepted.length) setError('');
  };

  const prepareUploads = async () => {
    const confirmedFileIds = new Set(confirmedUploads.map((upload) => upload.fileId));
    const uploadsByFileId = new Map(confirmedUploads.map((upload) => [upload.fileId, upload.uploadId]));
    for (const item of files) {
      if (confirmedFileIds.has(item.id)) continue;
      if (!item.file) throw new Error(`Re-select ${item.filename} to upload it again; the saved upload is no longer available.`);
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
      const nextUploads = [...confirmedFileIds].map((fileId) => ({ fileId, uploadId: uploadsByFileId.get(fileId) }));
      setConfirmedUploads(nextUploads);
      if (selectedProject?.allocationPending && selectedProject.uploadsAllowed !== false) {
        setPendingUploadProjectId(projectId);
        saveScopedDraft(PENDING_UPLOAD_DRAFT, employee?.id, {
          projectId,
          projectName: selectedProject.name,
          projectPending: true,
          files: files.map((file) => ({
            id: file.id,
            filename: file.file?.name || file.filename,
            sizeBytes: file.file?.size ?? file.sizeBytes,
            lastModified: file.file?.lastModified ?? file.lastModified,
            uploadId: uploadsByFileId.get(file.id),
          })).filter((file) => file.uploadId),
          scaleByFileId,
          confirmedScaleFileIds,
        });
      }
    }
    return files.map((file) => ({ uploadId: uploadsByFileId.get(file.id), file })).filter(({ uploadId }) => uploadId);
  };

  const generate = async (event) => {
    event.preventDefault();
    if (!projectId || !files.length || submitting || uploading) return;
    if (files.some((file) => !file.file && (file.fileType || file.filename.split('.').pop()).toLowerCase() === 'dxf' && (!confirmedScaleFileIds.includes(file.id) || !(Number(scaleByFileId[file.id]) > 0)))) {
      setError('Confirm the scale factor for every DXF drawing before generating the BOQ.');
      return;
    }
    setSubmitting(true);
    setUploading(true);
    setProgress(0);
    try {
      if (selectedProject?.allocationPending && selectedProject.uploadsAllowed !== false) {
        await prepareUploads();
        setUploading(false);
        setNotice(selectedProject.uploadsAllowed
          ? `Drawings for “${selectedProject.name}” are uploaded privately. BOQ generation will be available after you are assigned. If allocation takes longer than an hour, you may need to upload the drawings again.`
          : `Drawings for “${selectedProject.name}” are saved. You can use them after you are assigned.`);
        return;
      }
      if (selectedProject?.allocationPending && !selectedProject.uploadsAllowed && !isAdmin) {
        setUploading(false);
        setNotice('This project is assigned to another employee. You cannot upload or generate a BOQ until you are assigned.');
        return;
      }
      if (!submissionRef.current) {
        const uploadsByScale = await prepareUploads();
        if (!uploadsByScale.length) throw new Error('The selected drawings could not be confirmed. Choose them again and retry.');
        submissionRef.current = {
          key: typeof crypto !== 'undefined' && crypto.randomUUID
            ? crypto.randomUUID()
            : `boq-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          batches: Object.values(uploadsByScale.reduce((batches, upload) => {
            const filename = upload.file.file?.name || upload.file.filename;
            const key = filename.toLowerCase().endsWith('.dxf') ? String(scaleByFileId[upload.file.id] || 1) : 'ifc';
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
      clearScopedDraft(PENDING_UPLOAD_DRAFT, employee?.id);
      setPendingUploadProjectId('');
      setScaleByFileId({});
      setConfirmedScaleFileIds([]);
      setSearchParams({ projectId, jobId: created.id });
      await loadJobs(projectId);
    } catch (err) {
      setError(cleanError(err));
    } finally {
      setUploading(false);
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

  if (loading || resolvingProject) return <div className="dpr-page"><p role="status">{resolvingProject ? 'Loading selected project…' : 'Loading BOQ Generator…'}</p></div>;

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
        {selectedProject?.allocationPending && !isAdmin && <div role="status" style={{ color: '#78350F', background: '#FFFBEB', border: '1px solid #FCD34D', borderRadius: 10, padding: '0.75rem 1rem', marginTop: '0.75rem' }}><p style={{ margin: 0 }}><strong>Pending administrator allocation.</strong> {selectedProject.uploadsAllowed === false ? 'The project is assigned to another employee. You cannot upload or generate a BOQ until you are assigned.' : 'You can upload drawings now; BOQ generation will be available after you are assigned. Unprocessed uploads are cleaned up after an hour, so you may need to upload them again if allocation takes longer.'}</p><button type="button" className="btn btn-secondary" style={{ marginTop: '0.5rem' }} onClick={() => refreshProjects(projectId)}>Check allocation</button></div>}
        {selectedProject && !selectedProject.allocationPending && <p style={{ color: 'var(--steel)', marginBottom: 0, marginTop: '0.5rem' }}>Your project and uploads are private to your portal account.</p>}
      </section>

      <section className="dpr-card" aria-labelledby="boq-drawings-heading" style={{ padding: '1.25rem', marginBottom: '1rem', opacity: projectId ? 1 : 0.7 }}>
        <h2 id="boq-drawings-heading" style={{ marginTop: 0 }}>2. Add model drawings</h2>
        <p style={{ color: 'var(--steel)', marginTop: 0 }}>Choose {acceptedExtensions.map((type) => type.toUpperCase()).join(' or ')} files from your device. PDF sheets can be kept in the drawing register, but cannot be measured here.</p>
        <input ref={fileInputRef} aria-label="Select model drawings" type="file" accept={acceptedExtensions.map((type) => `.${type}`).join(',')} multiple disabled={!projectId} onChange={(event) => { addFiles(event.target.files); event.target.value = ''; }} style={{ position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none' }} />
        <button
          type="button"
          className="boq-upload-dropzone"
          disabled={!projectId}
          aria-label={`Choose ${acceptedExtensions.map((type) => type.toUpperCase()).join(' or ')} drawing files`}
          onClick={() => projectId && fileInputRef.current?.click()}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => { event.preventDefault(); if (projectId) addFiles(event.dataTransfer.files); }}
          style={{ display: 'block', width: '100%', border: '2px dashed #94A3B8', borderRadius: 12, padding: '1.5rem', textAlign: 'center', cursor: projectId ? 'pointer' : 'not-allowed', background: '#F8FAFC', color: 'inherit', font: 'inherit' }}
        >
          <strong>{projectId ? `Drop ${acceptedExtensions.map((type) => type.toUpperCase()).join('/')} files here or browse` : 'Choose a project first'}</strong>
          <div style={{ color: 'var(--steel)', fontSize: 14, marginTop: 4 }}>Up to {MAX_FILES} files · 50 MB each</div>
        </button>
        {files.length > 0 && <ul aria-label="Selected drawings" style={{ listStyle: 'none', padding: 0, margin: '0.75rem 0' }}>
          {files.map((item) => <li key={item.id} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap', padding: '0.55rem 0', borderBottom: '1px solid var(--border)' }}>
            <span style={{ flex: 1 }}>{item.file?.name || item.filename} <span style={{ color: 'var(--steel)' }}>({formatBytes(item.file?.size ?? item.sizeBytes)})</span></span>
            {(item.file?.name || item.filename).toLowerCase().endsWith('.dxf') && <label>Scale factor
              <input className="form-input" aria-label={`Scale factor for ${item.file?.name || item.filename}`} type="number" min="0.000001" step="any" value={scaleByFileId[item.id] ?? '1'} onChange={(event) => setFileScale(item.id, event.target.value)} />
            </label>}
            {(item.file?.name || item.filename).toLowerCase().endsWith('.dxf') && <label><input type="checkbox" aria-label={`Confirm scale for ${item.file?.name || item.filename}`} checked={confirmedScaleFileIds.includes(item.id)} onChange={(event) => setConfirmedScaleFileIds((current) => event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id))} /> Confirm scale</label>}
            {uploading && <span aria-label="Upload progress">{progress}%</span>}
            <button type="button" className="btn btn-secondary" onClick={() => {
              submissionRef.current = null;
              setFiles((current) => current.filter((file) => file.id !== item.id));
              const remainingUploads = confirmedUploads.filter((upload) => upload.fileId !== item.id);
              setConfirmedUploads(remainingUploads);
              if (selectedProject?.allocationPending && selectedProject.uploadsAllowed !== false) {
                if (remainingUploads.length) {
                  const currentDraft = loadScopedDraft(PENDING_UPLOAD_DRAFT, employee?.id);
                  const draftFiles = files.filter((file) => file.id !== item.id).map((file) => ({
                    id: file.id,
                    filename: file.file?.name || file.filename,
                    sizeBytes: file.file?.size ?? file.sizeBytes,
                    lastModified: file.file?.lastModified ?? file.lastModified,
                    uploadId: remainingUploads.find((upload) => upload.fileId === file.id)?.uploadId,
                  })).filter((file) => file.uploadId);
                  saveScopedDraft(PENDING_UPLOAD_DRAFT, employee?.id, {
                  projectId,
                  projectName: selectedProject.name,
                  projectPending: true,
                    files: currentDraft?.projectId === projectId
                      ? currentDraft.files.filter((file) => file.id !== item.id).filter((file) => draftFiles.some((next) => next.id === file.id))
                      : draftFiles,
                  scaleByFileId,
                  confirmedScaleFileIds,
                  });
                } else clearScopedDraft(PENDING_UPLOAD_DRAFT, employee?.id);
              }
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
        <button type="button" className="btn btn-primary" style={{ marginTop: '1rem' }} disabled={!projectId || !files.length || submitting || (selectedProject?.allocationPending && !isAdmin && selectedProject.uploadsAllowed === false) || (!(selectedProject?.allocationPending && !isAdmin && selectedProject.uploadsAllowed !== false) && files.some((file) => (file.file?.name || file.filename).toLowerCase().endsWith('.dxf') && (!(Number(scaleByFileId[file.id]) > 0) || !confirmedScaleFileIds.includes(file.id))))} onClick={generate}>
          {uploading ? 'Uploading drawings…' : submitting ? 'Starting take-off…' : selectedProject?.allocationPending && !isAdmin && selectedProject.uploadsAllowed !== false ? 'Upload drawings' : 'Generate BOQ'}
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