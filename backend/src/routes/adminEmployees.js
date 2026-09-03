/**
 * SOL-P1#12 — Admin employee directory picker.
 *
 *   GET /api/admin/employees
 *     Admin-only directory listing used by the training bulk-assign
 *     picker. Replaces the audit-flagged "paste emails" flow.
 *
 *     Query params (all optional):
 *       ?q=<substring>      filter by name OR email substring (case-insensitive)
 *       ?limit=<n>          cap the result size (default 200, max 500)
 *
 *     Returns: { employees: [{ id, name, email }] }
 *
 *     Auth: requireAuth + requireFreshAdmin. Admin claim alone is not
 *     safe — a stale JWT could grant picker access.
 */
'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth, requireFreshAdmin } = require('../middleware/auth');

// SOL-P1#12: same getPrisma pattern as /routes/storage.js — the Prisma
// client is attached to the express app in index.js so tests can swap a
// mock. Inline the helper here to keep this route file dependency-free.
function getPrisma(req) { return req.app.get('prisma'); }

router.get('/employees', requireAuth, requireFreshAdmin, async (req, res) => {
  const prisma = getPrisma(req);
  const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
  const limitRaw = parseInt(req.query.limit, 10);
  const limit = Math.min(Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 200, 500);

  try {
    // Build a single contains filter across name + email so the picker
    // can find "Anu" whether the admin types the name or partial email.
    // SQLite/Postgres both support `contains` mode: 'insensitive' on
    // Postgres; SQLite is case-insensitive by default for ASCII LIKE.
    const where = q
      ? {
          OR: [
            { name: { contains: q } },
            { email: { contains: q } },
          ],
        }
      : undefined;

    const rows = await prisma.employee.findMany({
      where,
      select: { id: true, name: true, email: true },
      orderBy: [{ name: 'asc' }, { email: 'asc' }],
      take: limit,
    });
    res.json({ employees: rows });
  } catch (err) {
    console.error('[admin/employees] lookup failed', {
      prismaCode: err.code,
      message: err.message?.split('\n')[0],
    });
    res.status(500).json({ error: 'Failed to load employee directory' });
  }
});

module.exports = router;
