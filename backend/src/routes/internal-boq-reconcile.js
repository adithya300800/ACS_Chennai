'use strict';

const express = require('express');
const boqClient = require('../lib/boqClient');
const { mapServiceError } = require('../lib/boqErrors');

const router = express.Router();
const MAX_RECONCILE_BATCH = 50;

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function requireInternalToken(req, res, next) {
  const expected = process.env.INTERNAL_API_TOKEN;
  if (!expected) return res.status(404).json({ error: 'Not found' });
  if (req.headers['x-internal-token'] !== expected) return res.status(403).json({ error: 'Forbidden' });
  return next();
}

router.post('/', requireInternalToken, asyncHandler(async (req, res) => {
  const prisma = req.app.get('prisma');
  const jobs = await prisma.boqJob.findMany({
    where: { status: { in: ['SUBMITTED', 'RUNNING', 'COMPLETED_PENDING_EXPORT'] } },
    orderBy: { updatedAt: 'asc' },
    take: MAX_RECONCILE_BATCH,
  });
  const result = { reconciled: 0, completed: 0, pendingExport: 0, lost: 0, failed: 0 };
  for (const job of jobs) {
    result.reconciled += 1;
    if (job.status === 'COMPLETED_PENDING_EXPORT') {
      try {
        await retryCapture(prisma, job, req);
        result.completed += 1;
      } catch (_err) {
        result.pendingExport += 1;
      }
      continue;
    }
    try {
      const serviceJob = await boqClient.getJob({ serviceJobId: job.serviceJobId, requestId: req.id });
      const status = String(serviceJob.status || '').toLowerCase();
      if (status === 'done') {
        const completed = await prisma.boqJob.update({
          where: { id: job.id },
          data: {
            status: 'COMPLETED_PENDING_EXPORT',
            dataStatus: serviceJob.data_status || job.dataStatus,
            productionMode: typeof serviceJob.production_mode === 'boolean' ? serviceJob.production_mode : job.productionMode,
          },
        });
        await retryCapture(prisma, completed, req);
        result.completed += 1;
      } else if (status === 'failed') {
        await prisma.boqJob.update({ where: { id: job.id }, data: { status: 'FAILED', completedAt: new Date() } });
        result.failed += 1;
      } else {
        await prisma.boqJob.update({
          where: { id: job.id },
          data: {
            status: status === 'running' ? 'RUNNING' : 'SUBMITTED',
            dataStatus: serviceJob.data_status || job.dataStatus,
          },
        });
      }
    } catch (err) {
      if (err?.code === 'JOB_NOT_FOUND') {
        await prisma.boqJob.update({ where: { id: job.id }, data: { status: 'LOST', completedAt: new Date() } });
        result.lost += 1;
      } else {
        const mapped = mapServiceError(err);
        if (mapped.status >= 500) result.failed += 1;
      }
    }
  }
  return res.json(result);
}));

async function retryCapture(prisma, job, req) {
  return require('./boqGenerator').captureCompletedServiceJob({ prisma, job, req });
}

module.exports = router;