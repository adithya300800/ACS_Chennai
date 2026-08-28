const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { generateULID, generateUploadSASUrl, generateReadSASUrl, verifyBlobExists } = require('../lib/blobStorage');

// In-memory pending uploads (ulid -> { employeeId, container, filename })
const pendingUploads = new Map();

// SSE connections per employee
const sseConnections = new Map(); // employeeId -> Set<{res, lastNotificationId}>

// All routes require auth
router.use(requireAuth);

// Helper: emit SSE event to all connections for an employee
function emitNotification(employeeId, eventName, data) {
  const connections = sseConnections.get(employeeId);
  if (!connections) return;
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const conn of connections) {
    try {
      conn.res.write(payload);
    } catch (e) {
      // Connection may be closed
    }
  }
}

// Helper: get Prisma
function getPrisma(req) {
  return req.app.get('prisma');
}

// ─── POST /api/dpr/sas-url ────────────────────────────────────────────────────
router.post('/sas-url', async (req, res) => {
  const prisma = getPrisma(req);
  const { filename, contentType, container } = req.body;

  if (!filename || !contentType || !container) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'filename, contentType, container required' });
  }

  const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
  const allowedContainers = ['dpr-photos', 'dpr-documents'];

  if (!allowedTypes.includes(contentType)) {
    return res.status(400).json({ error: 'INVALID_CONTENT_TYPE', message: 'Only image/jpeg, image/png, image/webp allowed' });
  }
  if (!allowedContainers.includes(container)) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid container' });
  }

  const ulid = generateULID();
  const ext = filename.split('.').pop() || 'jpg';
  const blobName = `${ulid}.${ext}`;

  // Generate real SAS URL
  const { sasUrl, ulid: generatedUlid, blobPath, expiresAt } = await generateUploadSASUrl(container, blobName, contentType);

  // Store pending upload
  pendingUploads.set(generatedUlid, {
    employeeId: req.employeeId,
    container,
    filename,
    contentType,
  });

  res.json({ sasUrl, ulid: generatedUlid, blobPath, expiresAt });
});

// ─── POST /api/dpr/confirm-upload ──────────────────────────────────────────
router.post('/confirm-upload', async (req, res) => {
  const { ulid, container, filename, contentType, sizeBytes } = req.body;

  if (!ulid || !container || !filename || !contentType || sizeBytes === undefined) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'All fields required' });
  }

  const pending = pendingUploads.get(ulid);
  if (!pending || pending.employeeId !== req.employeeId) {
    return res.status(404).json({ error: 'BLOB_NOT_FOUND', message: 'Upload not found or unauthorized' });
  }

  // In production: call GetBlobProperties to verify blob exists with matching content-type
  // const props = await containerClient.getBlobClient(blobName).getProperties();
  // if (props.contentType !== contentType) throw new Error('Content type mismatch');

  pendingUploads.delete(ulid);

  res.json({ verified: true });
});

// ─── POST /api/dpr ────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const prisma = getPrisma(req);
  const { projectName, location, reportDate, weather, temperature, contractor, status, photos = [] } = req.body;

  if (!projectName || !location || !reportDate) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'projectName, location, reportDate required' });
  }

  const validStatuses = ['DRAFT', 'SUBMITTED'];
  if (status && !validStatuses.includes(status)) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid status' });
  }

  try {
    // Parse reportDate
    const [year, month, day] = reportDate.split('-').map(Number);
    const dateUTC = new Date(Date.UTC(year, month - 1, day));

    const dpr = await prisma.dPR.create({
      data: {
        projectName,
        location,
        reportDate: dateUTC,
        weather: weather || null,
        temperature: temperature || null,
        contractor: contractor || null,
        status: status || 'DRAFT',
        submittedById: req.employeeId,
        submittedAt: new Date(),
        photos: {
          create: photos.map(p => ({
            ulid: p.ulid,
            container: p.container,
            filename: p.filename,
            contentType: p.contentType,
            sizeBytes: p.sizeBytes,
            caption: p.caption || null,
            location: p.location || null,
            takenAt: p.takenAt ? new Date(p.takenAt) : null,
          })),
        },
      },
      include: {
        photos: true,
        submittedBy: { select: { id: true, name: true, email: true } },
      },
    });

    res.status(201).json(dpr);
  } catch (err) {
    console.error('DPR create error:', err);
    if (err.code === 'P2002') {
      return res.status(409).json({ error: 'DPR already exists for this date', code: 'DUPLICATE_DPR' });
    }
    res.status(500).json({ error: 'Failed to create DPR' });
  }
});

// ─── GET /api/dpr ─────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const prisma = getPrisma(req);
  const { cursor, limit = '20', status: statusFilter } = req.query;

  const take = Math.min(parseInt(limit) || 20, 100);
  let skip = 0;
  let cursorWhere = {};

  if (cursor) {
    // cursor format: base64(reportDate|id)
    try {
      const [cDate, cId] = Buffer.from(cursor, 'base64').toString().split('|');
      cursorWhere = {
        OR: [
          { reportDate: { lt: new Date(cDate) } },
          { reportDate: new Date(cDate), id: { lt: cId } },
        ],
      };
    } catch (e) {
      // Invalid cursor format
    }
  }

  // Check if admin
  const employee = await prisma.employee.findUnique({ where: { id: req.employeeId } });
  const isAdmin = employee && employee.isAdmin;

  const where = {
    ...(isAdmin ? {} : { submittedById: req.employeeId }),
    ...(statusFilter ? { status: statusFilter } : {}),
    ...(cursor ? cursorWhere : {}),
  };

  try {
    const dprs = await prisma.dPR.findMany({
      where,
      include: {
        photos: { select: { id: true, caption: true, contentType: true, ulid: true, container: true } },
        submittedBy: { select: { id: true, name: true, email: true } },
      },
      orderBy: [{ reportDate: 'desc' }, { id: 'desc' }],
      take: take + 1,
      skip,
    });

    const hasMore = dprs.length > take;
    const items = hasMore ? dprs.slice(0, -1) : dprs;
    const lastItem = items[items.length - 1];
    const nextCursor = hasMore && lastItem
      ? Buffer.from(`${lastItem.reportDate.toISOString()}|${lastItem.id}`).toString('base64')
      : null;

    res.setHeader('X-Total-Count', items.length);
    res.setHeader('X-Has-More', hasMore ? 'true' : 'false');
    res.json({ dprs: items, nextCursor });
  } catch (err) {
    console.error('DPR list error:', err);
    res.status(500).json({ error: 'Failed to fetch DPRs' });
  }
});

// ─── GET /api/dpr/:id ────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  const prisma = getPrisma(req);
  const { id } = req.params;

  try {
    const dpr = await prisma.dPR.findUnique({
      where: { id },
      include: {
        photos: true,
        submittedBy: { select: { id: true, name: true, email: true } },
        reviewedBy: { select: { id: true, name: true, email: true } },
        approvedBy: { select: { id: true, name: true, email: true } },
        revisions: {
          orderBy: { version: 'desc' },
          select: { id: true, version: true, changedAt: true, changedById: true },
        },
      },
    });

    if (!dpr) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'DPR not found' });
    }

    // Auth: owner or admin
    const employee = await prisma.employee.findUnique({ where: { id: req.employeeId } });
    const isAdmin = employee && employee.isAdmin;
    if (dpr.submittedById !== req.employeeId && !isAdmin) {
      return res.status(403).json({ error: 'FORBIDDEN', message: 'Not authorized' });
    }

    // Generate read SAS URLs for photos
    const photosWithUrls = await Promise.all(dpr.photos.map(async p => {
      const { sasUrl } = await generateReadSASUrl(p.container, `${p.ulid}.${p.filename.split('.').pop()}`);
      return { ...p, readUrl: sasUrl };
    }));

    res.json({ ...dpr, photos: photosWithUrls });
  } catch (err) {
    console.error('DPR get error:', err);
    res.status(500).json({ error: 'Failed to fetch DPR' });
  }
});

// ─── PUT /api/dpr/:id ────────────────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  const prisma = getPrisma(req);
  const { id } = req.params;
  const { version, ...fields } = req.body;

  if (version === undefined) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'version required for optimistic locking' });
  }

  // Only owner can update
  const existing = await prisma.dPR.findUnique({ where: { id } });
  if (!existing) {
    return res.status(404).json({ error: 'NOT_FOUND', message: 'DPR not found' });
  }
  if (existing.submittedById !== req.employeeId) {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Only owner can update' });
  }

  try {
    const updated = await prisma.dPR.update({
      where: {
        id,
        version: existing.version,
      },
      data: {
        ...fields,
        version: { increment: 1 },
        updatedAt: new Date(),
      },
      include: { photos: true, submittedBy: { select: { id: true, name: true, email: true } } },
    });

    res.json(updated);
  } catch (err) {
    if (err.code === 'P2025') {
      return res.status(409).json({ error: 'VERSION_CONFLICT', message: 'DPR was modified by another request' });
    }
    console.error('DPR update error:', err);
    res.status(500).json({ error: 'Failed to update DPR' });
  }
});

// ─── POST /api/dpr/:id/review ───────────────────────────────────────────────
router.post('/:id/review', async (req, res) => {
  const prisma = getPrisma(req);
  const { id } = req.params;
  const { corrections, adminNotes } = req.body;

  // Admin check
  const employee = await prisma.employee.findUnique({ where: { id: req.employeeId } });
  if (!employee || !employee.isAdmin) {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Admin access required' });
  }

  const dpr = await prisma.dPR.findUnique({
    where: { id },
    include: { photos: true, submittedBy: true },
  });
  if (!dpr) {
    return res.status(404).json({ error: 'NOT_FOUND', message: 'DPR not found' });
  }

  try {
    // Create revision snapshot
    await prisma.dPRRevision.create({
      data: {
        dprId: id,
        version: dpr.version,
        snapshot: dpr,
        changedById: req.employeeId,
      },
    });

    // Update DPR status to UNDER_REVIEW
    const updated = await prisma.dPR.update({
      where: { id },
      data: {
        status: 'UNDER_REVIEW',
        reviewedById: req.employeeId,
        reviewedAt: new Date(),
        version: { increment: 1 },
      },
      include: {
        photos: true,
        submittedBy: { select: { id: true, name: true, email: true } },
        reviewedBy: { select: { id: true, name: true, email: true } },
      },
    });

    // Create notification for DPR owner
    await prisma.notification.create({
      data: {
        employeeId: dpr.submittedById,
        type: 'DPR_REVIEWED',
        dprId: id,
        message: `Your DPR for ${dpr.projectName} on ${dpr.reportDate.toISOString().split('T')[0]} was reviewed by ${employee.name}. ${adminNotes || ''}`.trim(),
      },
    });

    // Emit SSE notification
    emitNotification(dpr.submittedById, 'notification', {
      id: Date.now(),
      type: 'DPR_REVIEWED',
      dprId: id,
      message: `Your DPR for ${dpr.projectName} was reviewed`,
      createdAt: new Date().toISOString(),
    });

    res.json(updated);
  } catch (err) {
    console.error('DPR review error:', err);
    res.status(500).json({ error: 'Failed to review DPR' });
  }
});

// ─── GET /api/dpr/notifications (SSE) ─────────────────────────────────────
router.get('/notifications', async (req, res) => {
  const { lastNotificationId } = req.query;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Send initial connection ack
  res.write(`event: connected\ndata: ${JSON.stringify({ connected: true })}\n\n`);

  // Add this connection to the set
  if (!sseConnections.has(req.employeeId)) {
    sseConnections.set(req.employeeId, new Set());
  }
  const connection = { res, lastNotificationId: lastNotificationId || '0' };
  sseConnections.get(req.employeeId).add(connection);

  // Send heartbeat every 30s
  const heartbeat = setInterval(() => {
    res.write(`event: heartbeat\ndata: ${JSON.stringify({ ts: new Date().toISOString() })}\n\n`);
  }, 30000);

  req.on('close', () => {
    clearInterval(heartbeat);
    const conns = sseConnections.get(req.employeeId);
    if (conns) {
      conns.delete(connection);
      if (conns.size === 0) sseConnections.delete(req.employeeId);
    }
  });
});

// ─── PUT /api/dpr/notifications/read-all ───────────────────────────────────
router.put('/notifications/read-all', async (req, res) => {
  const prisma = getPrisma(req);

  try {
    const result = await prisma.notification.updateMany({
      where: { employeeId: req.employeeId, isRead: false },
      data: { isRead: true },
    });

    res.json({ updated: result.count });
  } catch (err) {
    console.error('Mark read error:', err);
    res.status(500).json({ error: 'Failed to mark notifications read' });
  }
});

// ─── POST /api/dpr/:id/pdf ──────────────────────────────────────────────────
router.post('/:id/pdf', async (req, res) => {
  const prisma = getPrisma(req);
  const { id } = req.params;

  const dpr = await prisma.dPR.findUnique({
    where: { id },
    include: {
      photos: true,
      submittedBy: { select: { name: true, email: true } },
      reviewedBy: { select: { name: true } },
      approvedBy: { select: { name: true } },
    },
  });

  if (!dpr) {
    return res.status(404).json({ error: 'NOT_FOUND', message: 'DPR not found' });
  }

  // Auth check
  const employee = await prisma.employee.findUnique({ where: { id: req.employeeId } });
  const isAdmin = employee && employee.isAdmin;
  if (dpr.submittedById !== req.employeeId && !isAdmin) {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Not authorized' });
  }

  // In production: render Handlebars template + Puppeteer -> PDF buffer -> upload to blob
  // For now, return a placeholder response
  res.json({
    pdfUrl: `/api/dpr/pdf-placeholder/${id}`,
    message: 'PDF generation not yet configured - requires Azure Blob + Puppeteer setup',
  });
});

module.exports = router;
