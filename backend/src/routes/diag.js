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

module.exports = router;
