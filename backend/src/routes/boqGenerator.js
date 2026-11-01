'use strict';

const express = require('express');
const { randomUUID } = require('crypto');
const { requireAuth } = require('../middleware/auth');
const boqStorage = require('../lib/boqStorage');
const boqClient = require('../lib/boqClient');
const { mapServiceError, mapServiceJobError } = require('../lib/boqErrors');
const {
  reserve: reserveIdempotency,
  complete: completeIdempotency,
  release: releaseIdempotency,
} = require('../lib/idempotency');
const { boqUploadLimiter, boqApiLimiter, boqApiIpLimiter, boqJobLimiter, boqWriteLimiter } = require('../middleware/rateLimit');

const router = express.Router();
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_BYTES = 500 * 1024 * 1024;
const MAX_FILES = 20;
const MAX_FILENAME_LENGTH = 200;
const MAX_EMPLOYEE_IN_FLIGHT_JOBS = 2;
const IN_FLIGHT_STATUSES = ['SUBMITTED', 'RUNNING', 'COMPLETED_PENDING_EXPORT'];
const LISTABLE_STATUSES = [...IN_FLIGHT_STATUSES, 'DRAFT', 'COMPLETED', 'FAILED', 'LOST'];
const ALLOWED_EXTENSIONS = new Set(['dxf', 'ifc', 'dwg']);
const DWG_SIGNATURES = new Set([
  'AC1002', 'AC1003', 'AC1004', 'AC1006', 'AC1009', 'AC1012', 'AC1014',
  'AC1015', 'AC1018', 'AC1021', 'AC1024', 'AC1027', 'AC1032',
]);
const META_CACHE_TTL_MS = 5 * 60 * 1000;
let metaCache = null;

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function getPrisma(req) {
  return req.app.get('prisma');
}

function errorBody(error, message, extra = {}) {
  return { error, code: error, message, ...extra };
}

function sanitizeFilename(filename) {
  if (typeof filename !== 'string' || !filename.trim() || filename.length > 1024) return null;
  const basename = filename.replace(/\\/g, '/').split('/').pop().trim().replace(/[\u0000-\u001f\u007f]/g, '');
  if (!basename || basename.length > MAX_FILENAME_LENGTH) return null;
  const extension = basename.includes('.') ? basename.split('.').pop().toLowerCase() : '';
  if (!ALLOWED_EXTENSIONS.has(extension)) return null;
  return { filename: basename, extension };
}

function sniffFile(prefix, extension) {
  const bytes = Buffer.isBuffer(prefix) ? prefix : Buffer.from(prefix || '');
  const text = bytes.toString('utf8');
  let detected;
  if (text.startsWith('AutoCAD Binary DXF')) detected = 'dxf';
  else if (DWG_SIGNATURES.has(bytes.subarray(0, 6).toString('ascii'))) detected = 'dwg';
  else if (text.startsWith('ISO-10303-21')) detected = 'ifc';
  else if (/^\s*0[\r\n]+\s*SECTION\b/i.test(text)) detected = 'dxf';
  else if (text.startsWith('%PDF-')) return { error: 'PDF_NOT_SUPPORTED' };
  else return { error: 'UNSUPPORTED_FILE_TYPE' };
  return detected === extension ? { fileType: detected } : { error: 'FILE_EXTENSION_MISMATCH' };
}

async function activeProjectAccess(prisma, projectId, employeeId, allowCreatorUpload = false) {
  const [project, employee] = await Promise.all([
    prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, isActive: true, createdById: true },
    }),
    prisma.employee.findUnique({ where: { id: employeeId }, select: { id: true, isAdmin: true } }),
  ]);
  if (!project?.isActive || !employee) return false;
  if (employee.isAdmin) return true;
  if (allowCreatorUpload && project.createdById === employeeId) {
    const [assignments, creatorAssignment] = await Promise.all([
      prisma.projectAssignment.findMany({ where: { projectId }, select: { employeeId: true } }),
      prisma.projectAssignment.findUnique({
        where: { projectId_employeeId: { projectId, employeeId } },
        select: { id: true },
      }),
    ]);
    return assignments.length === 0 || Boolean(creatorAssignment);
  }
  const assignment = await prisma.projectAssignment.findUnique({
    where: { projectId_employeeId: { projectId, employeeId } },
    select: { id: true },
  });
  return Boolean(assignment);
}

async function canReadJob(prisma, job, employeeId) {
  if (!job) return false;
  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { id: true, isAdmin: true },
  });
  return Boolean(employee && (employee.isAdmin || job.employeeId === employee.id));
}

async function respondUnauthorizedProject(res) {
  return res.status(404).json(errorBody('NOT_FOUND', 'Resource not found'));
}

async function rejectReservedRequest(prisma, reservation, res, status, body) {
  await releaseIdempotency({ prisma, reservation });
  return res.status(status).json(body);
}

function sanitizeJob(job) {
  const advisory = job.settingsJson?.serviceAdvisory || {};
  const userSettings = job.settingsJson ? { ...job.settingsJson } : null;
  if (userSettings) {
    delete userSettings.serviceAdvisory;
    delete userSettings.deletion;
    delete userSettings.pendingSnapshotRevision;
    delete userSettings.serviceSubmissionKey;
  }
  return {
    id: job.id,
    projectId: job.projectId,
    status: job.status,
    dataStatus: job.dataStatus,
    productionMode: job.productionMode,
    dxfScale: job.dxfScale,
    revision: job.revision,
    settings: userSettings,
    needsScaleCheck: Boolean(advisory.needs_scale_check),
    scaleDiagnostics: Array.isArray(advisory.scale_diagnostics) ? advisory.scale_diagnostics : [],
    scaleSuggestion: advisory.scale_suggestion ?? null,
    flags: Array.isArray(advisory.flags) ? advisory.flags : [],
    files: Array.isArray(job.inputFiles) ? job.inputFiles.map((file) => ({
      uploadId: file.uploadId,
      filename: file.filename,
      fileType: file.fileType,
      sizeBytes: file.sizeBytes,
    })) : [],
    error: job.errorCode ? { code: job.errorCode, message: job.errorMessage } : null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
  };
}

function sanitizeSnapshot(snapshot) {
  if (!snapshot) return null;
  return {
    revision: snapshot.revision,
    dataStatus: snapshot.dataStatus,
    productionMode: snapshot.productionMode,
    currency: snapshot.currency,
    totalsAmount: snapshot.totalsAmount,
    lineCount: snapshot.lineCount,
    withheldCount: snapshot.withheldCount,
    pricedLineCount: snapshot.pricedLineCount ?? null,
    unpricedLineCount: snapshot.unpricedLineCount ?? null,
    dxfScale: snapshot.dxfScale,
    acknowledgedAt: snapshot.acknowledgedAt,
  };
}

function serviceStatus(status) {
  switch (String(status || '').toLowerCase()) {
    case 'queued': return 'SUBMITTED';
    case 'running': return 'RUNNING';
    case 'done': return 'COMPLETED_PENDING_EXPORT';
    case 'failed': return 'FAILED';
    default: return 'RUNNING';
  }
}

const SNAPSHOT_SCHEMA_VERSION = '1.0';

function snapshotMetadata(document, snapshotBlobPath, exportBlobPath, job, savedById) {
  const totals = document.totals || {};
  return {
    revision: job.revision || 1,
    schemaVersion: document.schema_version,
    kind: document.kind || 'acs.boq.snapshot',
    serviceVersion: document.converter?.version || null,
    dataStatus: document.data_status || job.dataStatus || 'SAMPLE',
    productionMode: job.productionMode ?? false,
    currency: totals.currency || 'INR',
    totalsAmount: Number.isFinite(totals.amount) ? totals.amount : null,
    lineCount: Number.isInteger(totals.line_count) ? totals.line_count : (document.lines || []).length,
    withheldCount: Number.isInteger(totals.withheld_count) ? totals.withheld_count : (document.withheld || []).length,
    pricedLineCount: Number.isInteger(totals.priced_line_count) ? totals.priced_line_count : null,
    unpricedLineCount: Number.isInteger(totals.unpriced_line_count) ? totals.unpriced_line_count : null,
    snapshotBlobPath,
    exportBlobPath,
    dxfScale: document.scale?.factor ?? job.dxfScale ?? null,
    scaleConfirmedBy: document.scale?.confirmed_by || job.scaleConfirmedBy || null,
    savedById,
  };
}

async function captureCompletedServiceJob({ prisma, job, req }) {
  let snapshot = await prisma.boqSnapshot.findFirst({
    where: { boqJobId: job.id },
    orderBy: { revision: 'desc' },
  });

  if (!snapshot) {
    const document = await boqClient.getSnapshot({ serviceJobId: job.serviceJobId, requestId: requestId(req) });
    if (document?.schema_version !== SNAPSHOT_SCHEMA_VERSION) {
      const unsupported = new Error(`Unsupported BOQ snapshot schema version: ${String(document?.schema_version || 'missing')}`);
      unsupported.kind = 'snapshot-version';
      throw unsupported;
    }
    const revision = job.settingsJson?.pendingSnapshotRevision || job.revision || 1;
    const snapshotBlobPath = `snapshots/${job.projectId}/${job.id}/rev-${revision}.json`;
    await boqStorage.writeSnapshot({ blobPath: snapshotBlobPath, document });
    snapshot = await prisma.boqSnapshot.create({
      data: {
        id: randomUUID(),
        boqJobId: job.id,
        ...snapshotMetadata(document, snapshotBlobPath, null, { ...job, revision }, job.employeeId),
      },
    });
  }

  if (!snapshot.exportBlobPath) {
    const workbook = await boqClient.getBoqXlsx({ serviceJobId: job.serviceJobId, requestId: requestId(req) });
    const exportBlobPath = `exports/${job.projectId}/${job.id}/boq-${job.id}-rev-${snapshot.revision}.xlsx`;
    await boqStorage.writeExport({ blobPath: exportBlobPath, buffer: workbook });
    await prisma.boqSnapshot.update({
      where: { id: snapshot.id },
      data: { exportBlobPath },
    });
  }

  return prisma.boqJob.update({
    where: { id: job.id },
    data: {
      status: 'COMPLETED',
      completedAt: new Date(),
      ...(job.settingsJson?.pendingSnapshotRevision ? {
        settingsJson: Object.fromEntries(Object.entries(job.settingsJson).filter(([key]) => key !== 'pendingSnapshotRevision')),
      } : {}),
    },
  });
}

async function captureCorrectionRevision({ prisma, job, req, baseSnapshot }) {
  const document = await boqClient.getSnapshot({ serviceJobId: job.serviceJobId, requestId: requestId(req) });
  if (document?.schema_version !== SNAPSHOT_SCHEMA_VERSION) {
    const unsupported = new Error(`Unsupported BOQ snapshot schema version: ${String(document?.schema_version || 'missing')}`);
    unsupported.kind = 'snapshot-version';
    throw unsupported;
  }
  const revision = baseSnapshot.revision + 1;
  const snapshotBlobPath = `snapshots/${job.projectId}/${job.id}/rev-${revision}.json`;
  await boqStorage.writeSnapshot({ blobPath: snapshotBlobPath, document });
  const workbook = await boqClient.getBoqXlsx({ serviceJobId: job.serviceJobId, requestId: requestId(req) });
  const exportBlobPath = `exports/${job.projectId}/${job.id}/boq-${job.id}-rev-${revision}.xlsx`;
  await boqStorage.writeExport({ blobPath: exportBlobPath, buffer: workbook });
  await prisma.boqSnapshot.create({
    data: {
      id: randomUUID(),
      boqJobId: job.id,
      ...snapshotMetadata(document, snapshotBlobPath, exportBlobPath, { ...job, revision }, job.employeeId),
    },
  });
  await prisma.boqJob.update({ where: { id: job.id }, data: { revision } });
  return revision;
}

async function capturePendingCorrectionRevision({ prisma, job, req, baseSnapshot, revision }) {
  const document = await boqClient.getSnapshot({ serviceJobId: job.serviceJobId, requestId: requestId(req) });
  if (document?.schema_version !== SNAPSHOT_SCHEMA_VERSION) {
    const unsupported = new Error(`Unsupported BOQ snapshot schema version: ${String(document?.schema_version || 'missing')}`);
    unsupported.kind = 'snapshot-version';
    throw unsupported;
  }
  const snapshotBlobPath = `snapshots/${job.projectId}/${job.id}/rev-${revision}.json`;
  await boqStorage.writeSnapshot({ blobPath: snapshotBlobPath, document });
  const workbook = await boqClient.getBoqXlsx({ serviceJobId: job.serviceJobId, requestId: requestId(req) });
  const exportBlobPath = `exports/${job.projectId}/${job.id}/boq-${job.id}-rev-${revision}.xlsx`;
  await boqStorage.writeExport({ blobPath: exportBlobPath, buffer: workbook });
  await prisma.boqSnapshot.create({
    data: {
      id: randomUUID(),
      boqJobId: job.id,
      ...snapshotMetadata(document, snapshotBlobPath, exportBlobPath, { ...job, revision }, job.employeeId),
    },
  });
  return prisma.boqJob.update({
    where: { id: job.id },
    data: {
      revision,
      settingsJson: Object.fromEntries(Object.entries(job.settingsJson || {}).filter(([key]) => key !== 'pendingSnapshotRevision')),
      status: 'COMPLETED',
      completedAt: new Date(),
    },
  });
}

async function buildRegeneratedWorkbook({ document, job, revision }) {
  const ExcelJS = require('exceljs');
  const workbook = new ExcelJS.Workbook();
  const isReal = document.data_status === 'REAL' && job.productionMode === true;
  const banner = isReal ? 'REAL RATES' : `${document.data_status || 'SAMPLE'} RATES — NOT A VALUED BOQ`;
  const footer = isReal ? 'REVIEW REQUIRED BEFORE ISSUE' : 'NOT FOR TENDER • NOT FOR CLIENT ISSUE • NOT FOR CONSTRUCTION';
  const addSafetyLabels = (sheet) => {
    sheet.headerFooter.oddHeader = `&B${banner}&B`;
    sheet.headerFooter.oddFooter = `&B${footer}&B`;
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
  };

  const boq = workbook.addWorksheet('BOQ');
  addSafetyLabels(boq);
  boq.columns = [
    { header: 'Line ID', key: 'line_id', width: 24 },
    { header: 'Group', key: 'group_name', width: 24 },
    { header: 'Item', key: 'item_code', width: 16 },
    { header: 'Description', key: 'description', width: 48 },
    { header: 'Unit', key: 'unit', width: 12 },
    { header: 'Quantity', key: 'qty_rounded', width: 14 },
    { header: isReal ? 'Rate' : 'Rate (sample rate)', key: 'rate', width: 14 },
    { header: isReal ? 'Amount' : 'Amount (sample rate)', key: 'amount', width: 16 },
  ];
  for (const line of document.lines || []) boq.addRow(line);

  const abstract = workbook.addWorksheet('ABSTRACT');
  addSafetyLabels(abstract);
  abstract.addRow([isReal ? 'Total' : 'Sample total — placeholder rates, not an estimate', document.totals?.amount ?? 0]);
  abstract.addRow(['Total of priced items only — NOT THE PROJECT COST']);
  const abstractTotalLines = Number.isInteger(document.totals?.line_count) ? document.totals.line_count : (document.lines || []).length;
  const abstractPricedCount = Number.isInteger(document.totals?.priced_line_count)
    ? document.totals.priced_line_count
    : Number.isInteger(document.totals?.unpriced_line_count)
      ? Math.max(0, abstractTotalLines - document.totals.unpriced_line_count)
      : Math.max(0, abstractTotalLines - (Number(document.totals?.withheld_count) || (document.withheld || []).length));
  abstract.addRow([`${abstractPricedCount} of ${abstractTotalLines} lines priced`]);
  abstract.addRow(['Not included: site works, earthwork, doors and windows, finishes, preliminaries, escalation, GST, contingency.']);

  const coverage = workbook.addWorksheet('COVERAGE');
  addSafetyLabels(coverage);
  const totalLines = Number.isInteger(document.totals?.line_count) ? document.totals.line_count : (document.lines || []).length;
  const pricedCount = Number.isInteger(document.totals?.priced_line_count)
    ? document.totals.priced_line_count
    : Number.isInteger(document.totals?.unpriced_line_count)
      ? Math.max(0, totalLines - document.totals.unpriced_line_count)
      : Math.max(0, totalLines - (Number(document.totals?.withheld_count) || (document.withheld || []).length));
  const unpricedCount = Number.isInteger(document.totals?.unpriced_line_count)
    ? document.totals.unpriced_line_count
    : Math.max(0, totalLines - pricedCount);
  const withheldCounts = new Map();
  for (const item of document.withheld || []) {
    const reason = item.reason_code || 'OTHER';
    withheldCounts.set(reason, (withheldCounts.get(reason) || 0) + 1);
  }
  coverage.addRows([
    ['WHAT THIS NUMBER COVERS'],
    ['Total of priced items only — NOT THE PROJECT COST.'],
    [`${pricedCount} of ${totalLines} lines priced (${totalLines ? Math.round((unpricedCount / totalLines) * 100) : 0}% unpriced).`],
    ...[...withheldCounts].map(([reason, count]) => [`Kept out of total: ${reason} — ${count}`]),
    [`Files measured: ${(document.inputs || []).length}`],
    ['Not included: site works, earthwork, doors and windows, finishes, preliminaries, escalation, GST, contingency.'],
    [`Additional exclusions (your note): ${job.settingsJson?.additionalExclusions || 'None specified'}`],
    [`Calibration: ${document.scale?.factor ?? 'Not stated'}, confirmed by ${document.scale?.confirmed_by || job.scaleConfirmedBy || 'Not recorded'}.`],
    ...(document.needs_scale_check ? [['Scale plausibility: verify the scale diagnostics before issue.']] : []),
    ['Regenerated from the saved snapshot; not byte-identical to the service workbook.'],
  ]);

  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  return {
    buffer,
    filename: `boq-${job.id}-rev-${revision}-regenerated-from-saved-snapshot.xlsx`,
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
}

function requestId(req) {
  return typeof req.id === 'string' && req.id.length <= 128 ? req.id : undefined;
}

async function submitServiceJob({ prisma, job, req, serviceAttempt = 0 }) {
  const meta = await getServiceMeta(req);
  const inputFiles = Array.isArray(job.inputFiles) ? job.inputFiles : [];
  const sources = await Promise.all(inputFiles.map(async (file) => {
    const signed = await boqStorage.createReadUrl(file.blobPath);
    return { url: signed.sasUrl, filename: file.filename, size: file.sizeBytes };
  }));
  const settings = job.settingsJson || {};
  const project = await prisma.project.findUnique({ where: { id: job.projectId }, select: { name: true } });
  const employee = await prisma.employee.findUnique({ where: { id: job.employeeId }, select: { name: true } });
  const payload = {
    sources,
    config: {
      name: project?.name || String(job.projectId),
      project_ref: job.projectId,
      sor_priority: [settings.rateSource || 'TN_PWD_SOR'],
      location_factor: 1.0,
      wastage_pct: settings.wastagePct ?? 0,
      drawing_scale: job.dxfScale ?? null,
      requested_by: employee?.name || job.employeeId,
    },
  };
  const persistedSettings = { ...(job.settingsJson || {}) };
  delete persistedSettings.serviceSubmissionKey;
  const serviceSubmissionKey = job.settingsJson?.serviceSubmissionKey ||
    (serviceAttempt ? `${job.id}:retry:${serviceAttempt}` : job.id);
  const serviceJob = await boqClient.submitJob({
    jobId: serviceSubmissionKey,
    requestId: requestId(req),
    payload,
  });
  if (!serviceJob || typeof serviceJob.job_id !== 'string') {
    const invalid = new Error('BOQ service returned an invalid job response');
    invalid.kind = 'invalid-response';
    throw invalid;
  }
  return prisma.boqJob.update({
    where: { id: job.id },
    data: {
      serviceJobId: serviceJob.job_id,
      status: serviceStatus(serviceJob.status),
      dataStatus: serviceJob.data_status || meta.dataStatus || job.dataStatus || null,
      productionMode: typeof serviceJob.production_mode === 'boolean'
        ? serviceJob.production_mode
        : (typeof meta.productionMode === 'boolean' ? meta.productionMode : job.productionMode),
      settingsJson: {
        ...persistedSettings,
        ...(serviceAttempt ? { retryAttempt: serviceAttempt } : {}),
        serviceAdvisory: {
          ...(job.settingsJson?.serviceAdvisory || {}),
          ...(typeof serviceJob.needs_scale_check === 'boolean' ? { needs_scale_check: serviceJob.needs_scale_check } : {}),
          ...(Array.isArray(serviceJob.scale_diagnostics) ? { scale_diagnostics: serviceJob.scale_diagnostics } : {}),
          ...(serviceJob.scale_suggestion !== undefined ? { scale_suggestion: serviceJob.scale_suggestion } : {}),
          ...(Array.isArray(serviceJob.flags) ? { flags: serviceJob.flags } : {}),
        },
      },
      startedAt: job.startedAt || new Date(),
      completedAt: null,
      errorCode: null,
      errorMessage: null,
    },
  });
}

async function respondWithServiceSubmission({ prisma, job, req, res, statusCode = 200 }) {
  try {
    const persisted = job.serviceJobId ? job : await submitServiceJob({ prisma, job, req });
    const body = sanitizeJob(persisted);
    body.projectId = job.projectId;
    body.files = (job.inputFiles || []).map(({ uploadId, filename, fileType, sizeBytes }) => ({
      uploadId, filename, fileType, sizeBytes,
    }));
    return res.status(statusCode).json(body);
  } catch (err) {
    const mapped = mapServiceError(err);
    await Promise.all([
      prisma.boqJob.update({
        where: { id: job.id },
        data: {
          status: 'FAILED',
          completedAt: new Date(),
          errorCode: mapped.body.code,
          errorMessage: mapped.body.message,
          settingsJson: err?.kind === 'network' || err?.kind === 'timeout'
            ? { ...(job.settingsJson || {}), serviceSubmissionKey: job.settingsJson?.serviceSubmissionKey || job.id }
            : job.settingsJson,
        },
      }),
      prisma.uploadIntent.updateMany({
        where: { employeeId: job.employeeId, ulid: { in: (job.inputFiles || []).map((file) => file.uploadId) }, boundType: 'boq_job', boundAt: { not: null } },
        data: { boundAt: new Date() },
      }),
    ]);
    return res.status(mapped.status).json(mapped.body);
  }
}

async function retryServiceSubmission({ prisma, job, req, serviceAttempt, failedStatus }) {
  const serviceSubmissionKey = job.settingsJson?.serviceSubmissionKey || `${job.id}:retry:${serviceAttempt}`;
  const retryableJob = {
    ...job,
    serviceJobId: null,
    status: 'DRAFT',
    settingsJson: { ...(job.settingsJson || {}), retryAttempt: serviceAttempt, serviceSubmissionKey },
  };
  try {
    const submitted = await submitServiceJob({ prisma, job: retryableJob, req, serviceAttempt });
    return { job: submitted };
  } catch (err) {
    const mapped = mapServiceError(err);
    const ambiguous = err?.kind === 'network' || err?.kind === 'timeout';
    await prisma.boqJob.update({
      where: { id: job.id },
      data: {
        status: failedStatus,
        settingsJson: ambiguous
          ? retryableJob.settingsJson
          : Object.fromEntries(Object.entries(retryableJob.settingsJson).filter(([key]) => key !== 'serviceSubmissionKey')),
        errorCode: mapped.body.code,
        errorMessage: mapped.body.message,
      },
    });
    return { error: mapped };
  }
}

async function getServiceMeta(req) {
  if (metaCache && metaCache.expiresAt > Date.now()) return metaCache.value;
  const upstream = await boqClient.getMeta({ requestId: requestId(req) });
  const meta = projectServiceMeta(upstream);
  metaCache = { value: meta, expiresAt: Date.now() + META_CACHE_TTL_MS };
  return meta;
}

function projectServiceMeta(upstream = {}) {
  const limits = upstream.limits || {};
  const dataStatus = upstream.data_status || null;
  const productionMode = typeof upstream.production_mode === 'boolean' ? upstream.production_mode : null;
  const scaleSuggestion = typeof upstream.scale_suggestion === 'number' && Number.isFinite(upstream.scale_suggestion)
    ? upstream.scale_suggestion
    : null;
  return {
    schemaVersion: upstream.schema_version || null,
    service: {
      name: upstream.service?.name || 'acs-boq',
      version: upstream.service?.version || null,
    },
    dataStatus,
    effectiveStatus: dataStatus === 'REAL' && productionMode === true ? 'REAL' : dataStatus,
    dataStatusNotes: Array.isArray(upstream.data_status_notes) ? upstream.data_status_notes : [],
    productionMode,
    rateSources: (Array.isArray(upstream.sor_sources) ? upstream.sor_sources : []).map((source) => ({
      name: source.name || '',
      edition: source.edition ?? null,
      isSample: Boolean(source.is_sample),
      rateCount: Number.isFinite(source.rate_count) ? source.rate_count : 0,
      regions: Array.isArray(source.regions) ? source.regions : [],
      effectiveFrom: source.effective_from || null,
      effectiveDates: Array.isArray(source.effective_dates) ? source.effective_dates : [],
    })),
    wbsGroups: (Array.isArray(upstream.wbs_groups) ? upstream.wbs_groups : []).map((group) => ({
      code: group.code || '',
      name: group.name || '',
      order: Number.isFinite(group.order) ? group.order : null,
      sorChapters: Array.isArray(group.sor_chapters) ? group.sor_chapters : [],
    })),
    units: {
      canonical: Array.isArray(upstream.units?.canonical) ? upstream.units.canonical : [],
      aliases: upstream.units?.aliases && typeof upstream.units.aliases === 'object' ? upstream.units.aliases : {},
    },
    scalePresets: (Array.isArray(upstream.scale_presets) ? upstream.scale_presets : []).map((preset) => ({
      id: preset.id || '',
      drawingScale: preset.drawing_scale ?? null,
      requiresRatio: Boolean(preset.requires_ratio),
      guidance: preset.guidance || '',
    })),
    scaleGuidance: upstream.scale_guidance || '',
    scaleSuggestion,
    scalePlausibility: {
      modelExtentMinM: upstream.scale_plausibility?.model_extent_min_m ?? null,
      modelExtentMaxM: upstream.scale_plausibility?.model_extent_max_m ?? null,
      modelExtentCheckEnabled: Boolean(upstream.scale_plausibility?.model_extent_check_enabled),
      mappedDoorWindowWidthMinM: upstream.scale_plausibility?.mapped_door_window_width_min_m ?? null,
      mappedDoorWindowWidthMaxM: upstream.scale_plausibility?.mapped_door_window_width_max_m ?? null,
      guidance: upstream.scale_plausibility?.guidance || '',
      outcome: {
        jobStatus: upstream.scale_plausibility?.outcome?.job_status || null,
        needsScaleCheck: upstream.scale_plausibility?.outcome?.needs_scale_check || null,
        flag: upstream.scale_plausibility?.outcome?.flag || null,
      },
    },
    supportedInputTypes: Array.isArray(upstream.supported_input_types) ? upstream.supported_input_types : [],
    limits: {
      maxUploadBytes: Number.isFinite(limits.max_upload_bytes) ? limits.max_upload_bytes : null,
      maxSourcesPerJob: Number.isFinite(limits.max_sources_per_job) ? limits.max_sources_per_job : null,
    },
  };
}

router.use(boqApiIpLimiter);
router.use(requireAuth, boqApiLimiter);

function pilotAccess(req, isAdmin = req.isAdmin) {
  const configured = process.env.BOQ_PILOT_EMPLOYEE_IDS;
  const allowed = (configured || '').split(',').map((id) => id.trim()).filter(Boolean);
  return { pilotEnabled: true, isPilot: Boolean(isAdmin) || allowed.includes(req.employeeId) };
}

function requirePilot(req, res, next) {
  return getPrisma(req).employee.findUnique({ where: { id: req.employeeId }, select: { id: true, isAdmin: true } })
    .then((employee) => {
      if (!employee) return respondUnauthorizedProject(res);
      if (!pilotAccess(req, employee.isAdmin).isPilot) {
        return res.status(403).json(errorBody('BOQ_PILOT_ACCESS', 'This tool is in pilot and is not available to your account'));
      }
      return next();
    })
    .catch(next);
}

router.get('/access', asyncHandler(async (req, res) => {
  const employee = await getPrisma(req).employee.findUnique({ where: { id: req.employeeId }, select: { isAdmin: true } });
  if (!employee) return respondUnauthorizedProject(res);
  return res.json(pilotAccess({ ...req, isAdmin: employee.isAdmin }));
}));

router.use(requirePilot);

router.get('/meta', asyncHandler(async (req, res) => {
  try {
    const meta = await getServiceMeta(req);
    return res.json(meta);
  } catch (err) {
    const mapped = mapServiceError(err);
    return res.status(mapped.status).json(mapped.body);
  }
}));

router.post('/uploads/presign', boqUploadLimiter, asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  const employee = await prisma.employee.findUnique({ where: { id: req.employeeId }, select: { id: true } });
  if (!employee) return respondUnauthorizedProject(res);
  const { projectId, filename, sizeBytes } = req.body || {};
  const safeName = sanitizeFilename(filename);
  if (typeof projectId !== 'string' || !projectId || !safeName) {
    return res.status(400).json(errorBody('VALIDATION_ERROR', 'projectId and a .dxf, .ifc or .dwg filename are required'));
  }
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    return res.status(400).json(errorBody('INVALID_SIZE', 'sizeBytes must be a positive integer'));
  }
  if (sizeBytes > MAX_FILE_BYTES) {
    return res.status(413).json(errorBody('BOQ_FILE_TOO_LARGE', `Each drawing must be no larger than ${MAX_FILE_BYTES} bytes`));
  }
  if (!await activeProjectAccess(prisma, projectId, req.employeeId, true)) return respondUnauthorizedProject(res);

  const uploadId = boqStorage.generateULID();
  const signed = await boqStorage.createUploadUrl({
    projectId,
    employeeId: req.employeeId,
    uploadId,
    extension: safeName.extension,
  });
  await prisma.uploadIntent.create({
    data: {
      employeeId: req.employeeId,
      ulid: uploadId,
      container: boqStorage.bucketName(),
      blobPath: signed.blobPath,
      contentType: 'application/octet-stream',
      expectedSizeBytes: sizeBytes,
      projectId,
      originalFilename: safeName.filename,
      status: 'PENDING',
      expiresAt: new Date(signed.expiresAt),
    },
  });
  return res.status(201).json({ uploadId, sasUrl: signed.sasUrl, blobPath: signed.blobPath, expiresAt: signed.expiresAt });
}));

router.post('/uploads/confirm', boqUploadLimiter, asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  const { uploadId } = req.body || {};
  if (typeof uploadId !== 'string' || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(uploadId)) {
    return res.status(400).json(errorBody('VALIDATION_ERROR', 'uploadId must be a valid upload id'));
  }
  const intent = await prisma.uploadIntent.findUnique({
    where: { employeeId_ulid: { employeeId: req.employeeId, ulid: uploadId } },
  });
  if (!intent || intent.container !== boqStorage.bucketName() || !intent.projectId ||
      !await activeProjectAccess(prisma, intent.projectId, req.employeeId, true)) {
    return respondUnauthorizedProject(res);
  }
  if (intent.status === 'CONFIRMED' && intent.verifiedAt && intent.verifiedSizeBytes === intent.expectedSizeBytes) {
    return res.json({ uploadId, verified: true, sizeBytes: intent.verifiedSizeBytes });
  }
  if (intent.status !== 'PENDING' || intent.expiresAt <= new Date()) {
    return res.status(409).json(errorBody('UPLOAD_INTENT_EXPIRED', 'The upload intent is no longer available; upload the file again'));
  }

  let verified;
  try {
    verified = await boqStorage.verifyUpload(intent.blobPath);
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404) {
      return res.status(400).json(errorBody('UPLOAD_NOT_FOUND', 'The uploaded object was not found'));
    }
    console.warn('[boq-generator] upload verification failed', { code: err?.name, status: err?.$metadata?.httpStatusCode });
    return res.status(502).json(errorBody('UPLOAD_VERIFY_FAILED', 'Could not verify the uploaded drawing; retry shortly'));
  }
  if (verified.contentLength !== intent.expectedSizeBytes) {
    return res.status(400).json(errorBody('UPLOAD_SIZE_MISMATCH', 'Uploaded size does not match the declared size', {
      expectedSizeBytes: intent.expectedSizeBytes,
      actualSizeBytes: verified.contentLength,
    }));
  }
  if (verified.contentType !== 'application/octet-stream') {
    return res.status(400).json(errorBody('UPLOAD_CONTENT_TYPE_MISMATCH', 'The upload must use application/octet-stream'));
  }
  const detected = sniffFile(verified.prefix, intent.originalFilename.split('.').pop().toLowerCase());
  if (detected.error) {
    const message = detected.error === 'PDF_NOT_SUPPORTED'
      ? 'PDF drawings are not supported; upload DXF, IFC or DWG'
      : 'The uploaded bytes do not match a supported DXF, IFC or DWG file';
    return res.status(400).json(errorBody(detected.error, message));
  }

  const verifiedAt = new Date();
  const result = await prisma.uploadIntent.updateMany({
    where: {
      id: intent.id,
      employeeId: req.employeeId,
      container: boqStorage.bucketName(),
      projectId: intent.projectId,
      status: 'PENDING',
      boundAt: null,
      expiresAt: { gt: verifiedAt },
    },
    data: {
      status: 'CONFIRMED',
      confirmedAt: verifiedAt,
      verifiedAt,
      verifiedSizeBytes: verified.contentLength,
      verifiedContentType: 'application/octet-stream',
    },
  });
  if (!result || result.count !== 1) {
    const current = await prisma.uploadIntent.findUnique({
      where: { employeeId_ulid: { employeeId: req.employeeId, ulid: uploadId } },
    });
    if (current?.status === 'CONFIRMED' && current.verifiedAt && current.verifiedSizeBytes === current.expectedSizeBytes) {
      return res.json({ uploadId, verified: true, sizeBytes: current.verifiedSizeBytes });
    }
    return res.status(409).json(errorBody('UPLOAD_INTENT_CHANGED', 'The upload intent changed during verification; retry'));
  }
  return res.json({ uploadId, verified: true, sizeBytes: verified.contentLength, fileType: detected.fileType });
}));

router.post('/jobs', boqJobLimiter, asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  const body = req.body || {};
  const { projectId, uploads, dxfScale, rateSource, wastagePct } = body;
  const idempotencyKey = req.headers['idempotency-key'];
  if (typeof idempotencyKey !== 'string' || !idempotencyKey.length || idempotencyKey.length > 128) {
    return res.status(400).json(errorBody('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required and must be at most 128 characters'));
  }
  if (typeof projectId !== 'string' || !projectId || !Array.isArray(uploads) || uploads.length < 1 || uploads.length > MAX_FILES ||
      uploads.some((uploadId) => typeof uploadId !== 'string' || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(uploadId)) ||
      new Set(uploads).size !== uploads.length) {
    return res.status(400).json(errorBody('VALIDATION_ERROR', `projectId and 1-${MAX_FILES} unique upload ids are required`));
  }
  if (dxfScale !== undefined && dxfScale !== null && (typeof dxfScale !== 'number' || !Number.isFinite(dxfScale) || dxfScale <= 0)) {
    return res.status(400).json(errorBody('VALIDATION_ERROR', 'dxfScale must be a positive finite number'));
  }
  if (wastagePct !== undefined && wastagePct !== null && (typeof wastagePct !== 'number' || !Number.isFinite(wastagePct) || wastagePct < 0 || wastagePct > 100)) {
    return res.status(400).json(errorBody('VALIDATION_ERROR', 'wastagePct must be between 0 and 100'));
  }
  if (rateSource !== undefined && rateSource !== null && (typeof rateSource !== 'string' || rateSource.length > 100)) {
    return res.status(400).json(errorBody('VALIDATION_ERROR', 'rateSource must be a string up to 100 characters'));
  }
  if (!await activeProjectAccess(prisma, projectId, req.employeeId)) return respondUnauthorizedProject(res);

  const reservation = await reserveIdempotency({ prisma, route: 'boqGenerator.create', req });
  if (reservation.mismatch) return res.status(409).json(errorBody('IDEMPOTENCY_MISMATCH', 'Idempotency-Key was used for a different request body'));
  if (reservation.replay && reservation.cached) {
    const replayedId = reservation.cached.body?.id || reservation.cached.body?.recordId;
    if (replayedId) {
      const existingJob = await prisma.boqJob.findUnique({ where: { id: replayedId } });
      if (existingJob && existingJob.employeeId === req.employeeId && ['DRAFT', 'FAILED'].includes(existingJob.status) && !existingJob.serviceJobId) return respondWithServiceSubmission({ prisma, job: existingJob, req, res });
      if (existingJob && existingJob.employeeId === req.employeeId) {
        const replayBody = {
          ...sanitizeJob(existingJob),
          projectId: existingJob.projectId,
          files: (existingJob.inputFiles || []).map((file) => ({
            uploadId: file.uploadId,
            filename: file.filename,
            fileType: file.fileType,
            sizeBytes: file.sizeBytes,
          })),
        };
        return res.set('Idempotent-Replay', 'true').status(reservation.cached.status || 201).json(replayBody);
      }
    }
    return res.set('Idempotent-Replay', 'true').status(reservation.cached.status || 201).json(reservation.cached.body);
  }
  if (reservation.conflict) {
    return res.status(409).json(errorBody('IDEMPOTENCY_CONFLICT', reservation.poisoned
      ? 'A previous request with this Idempotency-Key failed; use a new key'
      : 'A request with this Idempotency-Key is already in progress'));
  }

  const activeJobs = await prisma.boqJob.count({
    where: { employeeId: req.employeeId, status: { in: IN_FLIGHT_STATUSES } },
  });
  if (activeJobs >= MAX_EMPLOYEE_IN_FLIGHT_JOBS) {
    return rejectReservedRequest(prisma, reservation, res, 429,
      errorBody('BOQ_EMPLOYEE_JOB_LIMIT', 'You already have two BOQ jobs in progress. Wait for one to finish before starting another.'));
  }

  let intents;
  try {
    intents = await prisma.uploadIntent.findMany({
      where: {
        employeeId: req.employeeId,
        ulid: { in: uploads },
        container: boqStorage.bucketName(),
        projectId,
        status: 'CONFIRMED',
        boundAt: null,
      },
      select: {
        id: true, ulid: true, employeeId: true, projectId: true, container: true,
        blobPath: true, originalFilename: true, expectedSizeBytes: true,
        verifiedSizeBytes: true, verifiedAt: true,
      },
    });
  } catch (err) {
    await releaseIdempotency({ prisma, reservation });
    throw err;
  }
  if (intents.length !== uploads.length || intents.some((intent) =>
    !intent.verifiedAt || !Number.isSafeInteger(intent.expectedSizeBytes) ||
    intent.expectedSizeBytes !== intent.verifiedSizeBytes || intent.verifiedSizeBytes <= 0 || intent.verifiedSizeBytes > MAX_FILE_BYTES)) {
    return rejectReservedRequest(prisma, reservation, res, 400,
      errorBody('UPLOAD_NOT_CONFIRMED', 'Every upload must be verified, confirmed, and belong to this project'));
  }
  const totalBytes = intents.reduce((total, intent) => total + intent.verifiedSizeBytes, 0);
  if (totalBytes > MAX_TOTAL_BYTES) {
    return rejectReservedRequest(prisma, reservation, res, 413,
      errorBody('BOQ_TOTAL_TOO_LARGE', `Combined drawings must be no larger than ${MAX_TOTAL_BYTES} bytes`));
  }
  const byUlid = new Map(intents.map((intent) => [intent.ulid, intent]));
  const orderedIntents = uploads.map((uploadId) => byUlid.get(uploadId));
  const settings = {
    ...(rateSource !== undefined ? { rateSource } : {}),
    ...(wastagePct !== undefined ? { wastagePct } : {}),
  };
  const inputFiles = orderedIntents.map((intent) => ({
    uploadId: intent.ulid,
    filename: intent.originalFilename,
    fileType: intent.originalFilename.split('.').pop().toLowerCase(),
    contentType: 'application/octet-stream',
    sizeBytes: intent.verifiedSizeBytes,
    blobPath: intent.blobPath,
  }));
  const jobId = randomUUID();
  const now = new Date();
  const job = {
    id: jobId,
    employeeId: req.employeeId,
    projectId,
    status: 'DRAFT',
    dxfScale: dxfScale ?? null,
    scaleConfirmedBy: dxfScale != null ? req.employeeId : null,
    scaleConfirmedAt: dxfScale != null ? now : null,
    idempotencyKey,
    settingsJson: settings,
    inputFiles,
    updatedAt: now,
  };
  const responseBody = {
    id: jobId,
    projectId,
    status: 'DRAFT',
    dxfScale: dxfScale ?? null,
    settings,
    files: inputFiles.map(({ uploadId, filename, fileType, sizeBytes }) => ({ uploadId, filename, fileType, sizeBytes })),
    createdAt: now,
  };
  try {
    const createJob = async (db) => {
      const employeeActiveJobs = await db.boqJob.count({
        where: { employeeId: req.employeeId, status: { in: IN_FLIGHT_STATUSES } },
      });
      if (employeeActiveJobs >= MAX_EMPLOYEE_IN_FLIGHT_JOBS) {
        const capped = new Error('Employee BOQ concurrency limit reached');
        capped.code = 'BOQ_EMPLOYEE_JOB_LIMIT';
        throw capped;
      }
      const claim = await db.uploadIntent.updateMany({
        where: {
          employeeId: req.employeeId,
          ulid: { in: uploads },
          container: boqStorage.bucketName(),
          projectId,
          status: 'CONFIRMED',
          boundAt: null,
          verifiedAt: { not: null },
          verifiedSizeBytes: { gt: 0 },
        },
        data: { boundType: 'boq_job', boundAt: now },
      });
      if (!claim || claim.count !== uploads.length) {
        const lost = new Error('BOQ upload binding was lost');
        lost.code = 'BOQ_UPLOAD_BINDING_LOST';
        throw lost;
      }
      const created = await db.boqJob.create({ data: job });
      if (reservation.namespacedKey && !reservation.legacy && db.requestDedupe) {
        await completeIdempotency({
          prisma: db,
          reservation,
          status: 201,
          body: responseBody,
          recordKind: 'boqJob',
          recordId: jobId,
        });
      }
      return created;
    };

    if (typeof prisma.$transaction === 'function') {
      await prisma.$transaction((tx) => createJob(tx), { isolationLevel: 'Serializable' });
    } else {
      await createJob(prisma);
    }
    if (reservation.legacy || !reservation.namespacedKey) {
      await completeIdempotency({ prisma, reservation, status: 201, body: responseBody, recordKind: 'boqJob', recordId: jobId });
    }

    const savedJob = await prisma.boqJob.findUnique({ where: { id: jobId } });
    return respondWithServiceSubmission({ prisma, job: savedJob || job, req, res, statusCode: 201 });
  } catch (err) {
    try {
      await releaseIdempotency({ prisma, reservation });
    } catch (releaseError) {
      console.warn('[boq-generator] idempotency reservation release failed', { code: releaseError?.code });
    }
    if (err?.code === 'BOQ_UPLOAD_BINDING_LOST' || err?.code === 'P2002' || err?.code === 'P2034') {
      return res.status(409).json(errorBody(err.code === 'BOQ_UPLOAD_BINDING_LOST' ? 'UPLOAD_ALREADY_CLAIMED' : 'IDEMPOTENCY_CONFLICT',
        'The upload or request was claimed by another request; retry with a fresh upload or key'));
    }
    if (err?.code === 'BOQ_EMPLOYEE_JOB_LIMIT') {
      return rejectReservedRequest(prisma, reservation, res, 429,
        errorBody('BOQ_EMPLOYEE_JOB_LIMIT', 'You already have two BOQ jobs in progress. Wait for one to finish before starting another.'));
    }
    throw err;
  }
}));

router.post('/jobs/:boqJobId/retry', boqJobLimiter, asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  const job = await prisma.boqJob.findUnique({ where: { id: req.params.boqJobId } });
  if (!job || !await canReadJob(prisma, job, req.employeeId)) return respondUnauthorizedProject(res);
  if (job.status === 'DRAFT' && !job.serviceJobId) return respondWithServiceSubmission({ prisma, job, req, res });
  if (job.status === 'LOST') {
    if (!job.inputFiles?.length) return res.status(409).json(errorBody('BOQ_NOT_RETRYABLE', 'This lost run has no stored drawing files. Select and upload the drawings again'));
    const attempt = (job.settingsJson?.retryAttempt || 0) + 1;
    const result = await retryServiceSubmission({ prisma, job, req, serviceAttempt: attempt, failedStatus: 'LOST' });
    return result.error ? res.status(result.error.status).json(result.error.body) : res.json(sanitizeJob(result.job));
  }
  if (job.status !== 'FAILED') return res.status(409).json(errorBody('BOQ_NOT_RETRYABLE', 'Only failed or lost runs can be retried'));
  const attempt = (job.settingsJson?.retryAttempt || 0) + 1;
  const result = await retryServiceSubmission({ prisma, job, req, serviceAttempt: attempt, failedStatus: 'FAILED' });
  return result.error ? res.status(result.error.status).json(result.error.body) : res.json(sanitizeJob(result.job));
}));

router.post('/jobs/search', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  const employee = await prisma.employee.findUnique({ where: { id: req.employeeId }, select: { id: true, isAdmin: true } });
  if (!employee) return respondUnauthorizedProject(res);
  req.isAdmin = Boolean(employee.isAdmin);
  const filters = req.body || {};
  const where = {};
  if (!employee.isAdmin) {
    where.employeeId = req.employeeId;
    if (typeof filters.projectId === 'string' && filters.projectId) where.projectId = filters.projectId;
  } else {
    if (typeof filters.projectId === 'string' && filters.projectId) where.projectId = filters.projectId;
  }
  if (typeof filters.status === 'string' && LISTABLE_STATUSES.includes(filters.status)) {
    where.status = filters.status;
  } else if (!employee.isAdmin) {
    where.status = { in: LISTABLE_STATUSES };
  }
  const parsedLimit = Number.parseInt(filters.limit, 10);
  const take = Number.isInteger(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 100) : 50;
  const jobs = await prisma.boqJob.findMany({ where, orderBy: { createdAt: 'desc' }, take });
  const snapshots = jobs.length ? await prisma.boqSnapshot.findMany({
    where: { boqJobId: { in: jobs.map((job) => job.id) } },
    orderBy: { revision: 'desc' },
  }) : [];
  const latestSnapshotByJob = new Map();
  for (const snapshot of snapshots) {
    if (!latestSnapshotByJob.has(snapshot.boqJobId)) latestSnapshotByJob.set(snapshot.boqJobId, snapshot);
  }
  const sanitizedJobs = jobs.map((job) => ({
    ...sanitizeJob(job),
    snapshot: sanitizeSnapshot(latestSnapshotByJob.get(job.id)),
    ...(employee.isAdmin ? { employeeId: job.employeeId } : {}),
  }));
  if (employee.isAdmin && sanitizedJobs.length) {
    const employees = await prisma.employee.findMany({
      where: { id: { in: [...new Set(jobs.map((job) => job.employeeId))] } },
      select: { id: true, name: true, email: true },
    });
    const employeeById = new Map(employees.map((row) => [row.id, row]));
    for (const job of sanitizedJobs) job.employee = employeeById.get(job.employeeId) || null;
  }
  return res.json({ jobs: sanitizedJobs });
}));

router.get('/jobs', (req, res) => res.status(405).json(errorBody('METHOD_NOT_ALLOWED', 'Use POST /jobs/search to list BOQ runs')));

router.get('/jobs/:boqJobId', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  const job = await prisma.boqJob.findUnique({ where: { id: req.params.boqJobId } });
  if (!await canReadJob(prisma, job, req.employeeId)) return respondUnauthorizedProject(res);
  const snapshot = await prisma.boqSnapshot.findFirst({
    where: { boqJobId: job.id },
    orderBy: { revision: 'desc' },
  });
  const respondWithJob = (result) => res.json({ ...sanitizeJob(result), snapshot: sanitizeSnapshot(snapshot) });
  if (job.serviceJobId && job.status === 'COMPLETED_PENDING_EXPORT') {
    try {
      const completed = await captureCompletedServiceJob({ prisma, job, req });
      const completedSnapshot = await prisma.boqSnapshot.findFirst({
        where: { boqJobId: job.id }, orderBy: { revision: 'desc' },
      });
      return res.json({ ...sanitizeJob(completed), snapshot: sanitizeSnapshot(completedSnapshot) });
    } catch (_captureError) {
      return respondWithJob(job);
    }
  }
  if (job.serviceJobId && ['SUBMITTED', 'RUNNING'].includes(job.status)) {
    try {
      const serviceJob = await boqClient.getJob({ serviceJobId: job.serviceJobId, requestId: requestId(req) });
      const mappedStatus = serviceStatus(serviceJob.status);
      const update = {
        status: mappedStatus,
        dataStatus: serviceJob.data_status || job.dataStatus,
        productionMode: typeof serviceJob.production_mode === 'boolean' ? serviceJob.production_mode : job.productionMode,
      };
      if (serviceJob.needs_scale_check !== undefined || serviceJob.scale_diagnostics !== undefined ||
          serviceJob.scale_suggestion !== undefined || serviceJob.flags !== undefined) {
        update.settingsJson = {
          ...(job.settingsJson || {}),
          serviceAdvisory: {
            ...(job.settingsJson?.serviceAdvisory || {}),
            ...(typeof serviceJob.needs_scale_check === 'boolean' ? { needs_scale_check: serviceJob.needs_scale_check } : {}),
            ...(Array.isArray(serviceJob.scale_diagnostics) ? { scale_diagnostics: serviceJob.scale_diagnostics } : {}),
            ...(serviceJob.scale_suggestion !== undefined ? { scale_suggestion: serviceJob.scale_suggestion } : {}),
            ...(Array.isArray(serviceJob.flags) ? { flags: serviceJob.flags } : {}),
          },
        };
      }
      if (mappedStatus === 'RUNNING' && !job.startedAt) update.startedAt = new Date();
      if (mappedStatus === 'FAILED') {
        const mappedError = mapServiceJobError(serviceJob.error);
        if (mappedError) {
          update.errorCode = mappedError.body.code;
          update.errorMessage = mappedError.body.message;
          update.errorDetails = mappedError.details;
        }
      }
      if (mappedStatus === 'COMPLETED_PENDING_EXPORT' || mappedStatus === 'FAILED') update.completedAt = new Date();
      if (serviceJob.status && String(serviceJob.status).toLowerCase() === 'done') update.completedAt = new Date();
      const persisted = await prisma.boqJob.update({ where: { id: job.id }, data: update });
      if (mappedStatus === 'COMPLETED_PENDING_EXPORT') {
        try {
          const completed = await captureCompletedServiceJob({ prisma, job: persisted, req });
          const completedSnapshot = await prisma.boqSnapshot.findFirst({
            where: { boqJobId: job.id }, orderBy: { revision: 'desc' },
          });
          return res.json({ ...sanitizeJob(completed), snapshot: sanitizeSnapshot(completedSnapshot) });
        } catch (captureError) {
          if (captureError.kind === 'snapshot-version') {
            return res.status(502).json(errorBody(
              'BOQ_SNAPSHOT_VERSION_UNSUPPORTED',
              'The drawing service returned a BOQ snapshot version this portal cannot save.',
            ));
          }
          return respondWithJob(persisted);
        }
      }
      return respondWithJob(persisted);
    } catch (err) {
      if (err?.code === 'JOB_NOT_FOUND') {
        const lost = await prisma.boqJob.update({
          where: { id: job.id },
          data: { status: 'LOST', completedAt: new Date() },
        });
        return respondWithJob(lost);
      }
      const mapped = mapServiceError(err);
      return res.status(mapped.status).json(mapped.body);
    }
  }
  return respondWithJob(job);
}));

router.get('/jobs/:boqJobId/boq', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  const job = await prisma.boqJob.findUnique({
    where: { id: req.params.boqJobId },
    select: { id: true, projectId: true, employeeId: true },
  });
  if (!await canReadJob(prisma, job, req.employeeId)) return respondUnauthorizedProject(res);
  const snapshot = await prisma.boqSnapshot.findFirst({
    where: { boqJobId: job.id },
    orderBy: { revision: 'desc' },
  });
  if (!snapshot) return res.status(404).json(errorBody('BOQ_NOT_SAVED', 'No saved BOQ snapshot is available'));
  const document = await boqStorage.readSnapshot(snapshot.snapshotBlobPath);
  return res.json(document);
}));

router.post('/jobs/:boqJobId/save', boqWriteLimiter, asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  const job = await prisma.boqJob.findUnique({ where: { id: req.params.boqJobId } });
  if (!await canReadJob(prisma, job, req.employeeId)) return respondUnauthorizedProject(res);
  if (!job.serviceJobId || !['COMPLETED_PENDING_EXPORT', 'COMPLETED'].includes(job.status)) {
    return res.status(409).json(errorBody('BOQ_NOT_READY', 'Only completed BOQ jobs can be saved'));
  }
  if (job.settingsJson?.pendingSnapshotRevision) {
    const baseSnapshot = await prisma.boqSnapshot.findFirst({
      where: { boqJobId: job.id },
      orderBy: { revision: 'desc' },
    });
    if (!baseSnapshot) return res.status(409).json(errorBody('BOQ_NOT_SAVED', 'The original snapshot is missing'));
    const persisted = await capturePendingCorrectionRevision({
      prisma,
      job,
      req,
      baseSnapshot,
      revision: job.settingsJson.pendingSnapshotRevision,
    });
    return res.json({ ...sanitizeJob(persisted), revision: job.settingsJson.pendingSnapshotRevision, saved: true });
  }
  const persisted = await captureCompletedServiceJob({ prisma, job, req });
  const snapshot = await prisma.boqSnapshot.findFirst({ where: { boqJobId: job.id }, orderBy: { revision: 'desc' } });
  return res.json({ ...sanitizeJob(persisted), revision: snapshot?.revision || job.revision || 1, saved: true });
}));

router.post('/jobs/:boqJobId/lines/:lineId/corrections', boqWriteLimiter, asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  const job = await prisma.boqJob.findUnique({ where: { id: req.params.boqJobId } });
  if (!await canReadJob(prisma, job, req.employeeId)) return respondUnauthorizedProject(res);
  if (!job.serviceJobId || !['COMPLETED_PENDING_EXPORT', 'COMPLETED'].includes(job.status)) {
    return res.status(409).json(errorBody('BOQ_NOT_READY', 'The BOQ must be complete before a line can be corrected'));
  }
  const body = req.body || {};
  if (typeof body.reason !== 'string' || body.reason.trim().length < 4) {
    return res.status(400).json(errorBody('VALIDATION_ERROR', 'A correction reason of at least four characters is required'));
  }
  if (body.kind === 'override_rate' && (job.dataStatus !== 'REAL' || job.productionMode !== true)) {
    return res.status(409).json(errorBody('BOQ_RATE_CORRECTION_DISABLED', 'Rate corrections are unavailable until real rates are enabled'));
  }
  const kinds = {
    override_qty: ['qty'],
    override_rate: ['rate'],
    reclassify: ['item_code'],
    pick_alternative: ['alternative_code', 'alternative_source'],
  };
  const requiredFields = kinds[body.kind];
  if (!requiredFields || requiredFields.some((field) => body[field] === undefined || body[field] === null || body[field] === '')) {
    return res.status(400).json(errorBody('VALIDATION_ERROR', 'Correction kind and its required value are invalid'));
  }
  if (['qty', 'rate'].some((field) => body[field] !== undefined &&
      (typeof body[field] !== 'number' || !Number.isFinite(body[field]) || body[field] < 0))) {
    return res.status(400).json(errorBody('VALIDATION_ERROR', 'Quantity and rate corrections must be non-negative finite numbers'));
  }
  const { requested_by: _clientRequestedBy, ...correction } = body;
  correction.requested_by = `boqjob:${job.id}`;
  try {
    const result = await boqClient.correctLine({
      serviceJobId: job.serviceJobId,
      lineId: req.params.lineId,
      requestId: requestId(req),
      payload: correction,
    });
    const baseSnapshot = await prisma.boqSnapshot.findFirst({
      where: { boqJobId: job.id },
      orderBy: { revision: 'desc' },
    });
    if (baseSnapshot) {
      try {
        const revision = await captureCorrectionRevision({ prisma, job, req, baseSnapshot });
        result.revision = revision;
      } catch (_captureError) {
        await prisma.boqJob.update({
          where: { id: job.id },
          data: { settingsJson: { ...(job.settingsJson || {}), pendingSnapshotRevision: baseSnapshot.revision + 1 } },
        });
        return res.status(202).json({
          ...result,
          revision: baseSnapshot.revision,
          snapshotPending: true,
          message: 'The correction was accepted; the revised snapshot and export are still being saved.',
        });
      }
    }
  const portalResult = Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'job_id'));
    return res.json(portalResult);
  } catch (err) {
    const mapped = mapServiceError(err);
    return res.status(mapped.status).json(mapped.body);
  }
}));

router.delete('/jobs/:boqJobId', boqWriteLimiter, asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  const job = await prisma.boqJob.findUnique({ where: { id: req.params.boqJobId } });
  if (!await canReadJob(prisma, job, req.employeeId)) return respondUnauthorizedProject(res);

  const deletion = job.settingsJson?.deletion || {};
  if (job.serviceJobId && !deletion.serviceDeleted) {
    try {
      await boqClient.deleteJob({ serviceJobId: job.serviceJobId, requestId: requestId(req) });
    } catch (err) {
      if (err?.code !== 'JOB_NOT_FOUND') {
        const mapped = mapServiceError(err);
        return res.status(mapped.status).json(mapped.body);
      }
    }
    await prisma.boqJob.update({
      where: { id: job.id },
      data: { settingsJson: { ...(job.settingsJson || {}), deletion: { ...deletion, serviceDeleted: true } } },
    });
  }

  const snapshots = await prisma.boqSnapshot.findMany({ where: { boqJobId: job.id } });
  const artifacts = [
    ...snapshots.map((snapshot) => snapshot.snapshotBlobPath),
    ...snapshots.map((snapshot) => snapshot.exportBlobPath).filter(Boolean),
    ...(Array.isArray(job.inputFiles) ? job.inputFiles.map((file) => file.blobPath) : []),
  ];
  const results = await Promise.allSettled(artifacts.map((blobPath) => boqStorage.deleteBlob(blobPath)));
  const failedArtifacts = results.filter((result) => result.status === 'rejected');
  if (failedArtifacts.length) {
    return res.status(503).json(errorBody('BOQ_CLEANUP_PENDING', 'The BOQ could not be fully removed from storage; retry the delete request.'));
  }

  const uploadIds = (Array.isArray(job.inputFiles) ? job.inputFiles : [])
    .map((file) => file.uploadId)
    .filter(Boolean);
  if (uploadIds.length) {
    await prisma.uploadIntent.updateMany({
      where: { employeeId: job.employeeId, ulid: { in: uploadIds }, boundType: 'boq_job' },
      data: { status: 'EXPIRED', boundType: null, boundAt: null },
    });
  }
  await prisma.boqSnapshot.deleteMany({ where: { boqJobId: job.id } });
  await prisma.boqJob.delete({ where: { id: job.id } });
  return res.json({ id: job.id, deleted: true });
}));

router.post('/jobs/:boqJobId/export/acknowledge', boqWriteLimiter, asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  const job = await prisma.boqJob.findUnique({ where: { id: req.params.boqJobId } });
  if (!await canReadJob(prisma, job, req.employeeId)) return respondUnauthorizedProject(res);
  if (req.body?.acknowledged !== true) {
    return res.status(400).json(errorBody('VALIDATION_ERROR', 'Explicit export acknowledgement is required'));
  }
  const snapshot = await prisma.boqSnapshot.findFirst({
    where: { boqJobId: job.id },
    orderBy: { revision: 'desc' },
  });
  if (!snapshot) return res.status(409).json(errorBody('BOQ_NOT_SAVED', 'Save the BOQ snapshot before acknowledging export'));
  const persisted = await prisma.boqSnapshot.update({
    where: { id: snapshot.id },
    data: { acknowledgedById: req.employeeId, acknowledgedAt: new Date() },
  });
  return res.json({ acknowledged: true, acknowledgedAt: persisted.acknowledgedAt });
}));

router.get('/jobs/:boqJobId/export', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  const job = await prisma.boqJob.findUnique({ where: { id: req.params.boqJobId } });
  if (!await canReadJob(prisma, job, req.employeeId)) return respondUnauthorizedProject(res);
  const snapshot = await prisma.boqSnapshot.findFirst({
    where: { boqJobId: job.id },
    orderBy: { revision: 'desc' },
  });
  if (!snapshot) return res.status(404).json(errorBody('BOQ_NOT_SAVED', 'No saved BOQ snapshot is available'));
  if (!snapshot.acknowledgedAt || !snapshot.acknowledgedById) {
    return res.status(409).json(errorBody('BOQ_EXPORT_ACK_REQUIRED', 'Acknowledge the sample-rate warning before downloading this workbook'));
  }
  if (snapshot.exportBlobPath && await boqStorage.blobExists(snapshot.exportBlobPath)) {
    const signed = await boqStorage.createReadUrl(snapshot.exportBlobPath);
    return res.json({ downloadUrl: signed.sasUrl, expiresAt: signed.expiresAt, filename: `boq-${job.id}-rev-${snapshot.revision}.xlsx` });
  }
  try {
    const document = await boqStorage.readSnapshot(snapshot.snapshotBlobPath);
    if (document?.schema_version !== SNAPSHOT_SCHEMA_VERSION) throw new Error('unsupported snapshot version');
    const regenerated = await buildRegeneratedWorkbook({ document, job, revision: snapshot.revision });
    const exportBlobPath = `exports/${job.projectId}/${job.id}/rev-${snapshot.revision}-regenerated.xlsx`;
    await boqStorage.writeExport({ blobPath: exportBlobPath, buffer: regenerated.buffer });
    await prisma.boqSnapshot.update({ where: { id: snapshot.id }, data: { exportBlobPath } });
    const signed = await boqStorage.createReadUrl(exportBlobPath);
    return res.json({
      downloadUrl: signed.sasUrl,
      expiresAt: signed.expiresAt,
      filename: regenerated.filename,
      regenerated: true,
    });
  } catch (_err) {
    return res.status(410).json(errorBody('BOQ_EXPORT_GONE', 'The saved workbook is no longer available and could not be regenerated'));
  }
}));

router.post('/jobs/:boqJobId/export/regenerate', boqWriteLimiter, asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  const job = await prisma.boqJob.findUnique({ where: { id: req.params.boqJobId } });
  if (!await canReadJob(prisma, job, req.employeeId)) return respondUnauthorizedProject(res);
  const snapshot = await prisma.boqSnapshot.findFirst({
    where: { boqJobId: job.id },
    orderBy: { revision: 'desc' },
  });
  if (!snapshot) return res.status(404).json(errorBody('BOQ_NOT_SAVED', 'No saved BOQ snapshot is available'));
  if (!snapshot.acknowledgedAt || !snapshot.acknowledgedById) {
    return res.status(409).json(errorBody('BOQ_EXPORT_ACK_REQUIRED', 'Acknowledge the sample-rate warning before regenerating this workbook'));
  }
  try {
    const document = await boqStorage.readSnapshot(snapshot.snapshotBlobPath);
    if (document?.schema_version !== SNAPSHOT_SCHEMA_VERSION) {
      return res.status(502).json(errorBody('BOQ_SNAPSHOT_VERSION_UNSUPPORTED', 'The saved BOQ snapshot version cannot be regenerated by this portal'));
    }
    const workbook = await buildRegeneratedWorkbook({ document, job, revision: snapshot.revision });
    const exportBlobPath = `exports/${job.projectId}/${job.id}/rev-${snapshot.revision}-regenerated.xlsx`;
    await boqStorage.writeExport({ blobPath: exportBlobPath, buffer: workbook.buffer });
    await prisma.boqSnapshot.update({ where: { id: snapshot.id }, data: { exportBlobPath } });
    return res.json({
      regenerated: true,
      filename: workbook.filename,
      exportBlobPath,
      downloadUrl: (await boqStorage.createReadUrl(exportBlobPath)).sasUrl,
    });
  } catch (_err) {
    return res.status(410).json(errorBody('BOQ_EXPORT_GONE', 'The saved workbook is no longer available and could not be regenerated'));
  }
}));

router.resetMetaCacheForTests = () => { metaCache = null; };
router.resetRateLimitsForTests = async (employeeIds = [], ipAddresses = []) => {
  await Promise.all([boqUploadLimiter, boqApiLimiter, boqJobLimiter, boqWriteLimiter].map(async (limiter) => {
    await Promise.all(employeeIds.map((employeeId) => limiter.resetKey(`emp:${employeeId}`)));
  }));
  await Promise.all(ipAddresses.map((ipAddress) => boqApiIpLimiter.resetKey(ipAddress)));
};
router.captureCompletedServiceJob = captureCompletedServiceJob;

module.exports = router;