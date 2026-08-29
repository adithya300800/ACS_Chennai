/**
 * Round-8 TEMPORARY diagnostic endpoint — DELETED after F5/F6 root cause found.
 * POST /api/diag/schema — runs raw queries to inspect deployed DB schema.
 *
 * Auth: requires admin token (use POST /api/auth/login with admin creds first).
 *
 * Returns:
 *  - { tables: [{table_name, column_count}], dprColumns: [...], error: '...' }
 *
 * REMOVE THIS ROUTE once F5/F6 are resolved.
 */
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { PrismaClient } = require('@prisma/client');

router.post('/schema', requireAuth, async (req, res) => {
  // Admin-only (avoid leaking schema to non-admins)
  if (!req.isAdmin) {
    return res.status(403).json({ error: 'Admin only' });
  }

  // Use the app's prisma instance
  const prisma = req.app.get('prisma') || new PrismaClient();
  try {
    // List all tables in public schema
    const tables = await prisma.$queryRawUnsafe(`
      SELECT table_name,
             (SELECT COUNT(*) FROM information_schema.columns c
              WHERE c.table_schema='public' AND c.table_name=t.table_name) AS column_count
      FROM information_schema.tables t
      WHERE table_schema='public' AND table_type='BASE TABLE'
      ORDER BY table_name
    `);

    // Detailed dpr table columns
    let dprColumns = null;
    let dprExists = tables.some(t => t.table_name === 'dpr');
    if (dprExists) {
      dprColumns = await prisma.$queryRawUnsafe(`
        SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema='public' AND table_name='dpr'
        ORDER BY ordinal_position
      `);
    }

    // Try a raw SELECT * FROM dpr LIMIT 1 — see what error (if any) Prisma surfaces
    let rawSelectError = null;
    try {
      await prisma.$queryRawUnsafe('SELECT * FROM dpr LIMIT 1');
    } catch (e) {
      rawSelectError = {
        code: e.code,
        message: e.message?.split('\n')[0],
        meta: e.meta,
      };
    }

    res.json({
      tableCount: tables.length,
      tables: tables.map(t => ({ name: t.table_name, columns: Number(t.column_count) })),
      dprExists,
      dprColumns,
      rawSelectError,
      requestId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });
  } catch (err) {
    res.status(500).json({
      error: 'Diagnostic query failed',
      code: err.code,
      message: err.message?.split('\n')[0],
      meta: err.meta,
      requestId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });
  }
});

// Round-8 (debug): POST /api/diag/dpr-create — runs the exact prisma.dPR.create
// the production handler does and returns the underlying error verbatim so we
// can see why POST /api/dpr 500s even after the schema push.
// DELETE after F5/F6 root cause identified.
router.post('/dpr-create', requireAuth, async (req, res) => {
  if (!req.isAdmin) return res.status(403).json({ error: 'Admin only' });
  const prisma = req.app.get('prisma') || new PrismaClient();
  const body = req.body || {};
  try {
    const dpr = await prisma.dPR.create({
      data: {
        projectName: body.projectName || 'diag-test',
        location: body.location || 'diag-loc',
        reportDate: body.reportDate ? new Date(body.reportDate) : new Date('2026-08-29'),
        weather: body.weather ?? null,
        temperature: body.temperature ?? null,
        contractor: body.contractor ?? null,
        workType: body.workType ?? 'MATERIAL_RECEIPT',
        notes: body.notes ?? null,
        workEntries: body.workEntries ?? null,
        status: body.status ?? 'DRAFT',
        version: body.version ?? 1,
        submittedById: req.employeeId,
        submittedAt: body.status === 'SUBMITTED' ? new Date() : null,
      },
    });
    res.json({ ok: true, id: dpr.id });
  } catch (err) {
    res.status(500).json({
      error: 'prisma.dPR.create failed',
      code: err.code,
      name: err.name,
      meta: err.meta,
      message: err.message?.split('\n')?.slice(0, 3),
      stack: err.stack?.split('\n')?.slice(0, 10),
      requestId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });
  }
});

module.exports = router;
