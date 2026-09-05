// ─────────────────────────────────────────────────────────────────────────────
// N7 (round-28) — Bill of Quantities (BOQ) CRUD + variance report
// ─────────────────────────────────────────────────────────────────────────────
//
// Half-step to N1 (Project Master). Lets the billing engineer trace a DPR /
// Inspection line back to a bill-of-quantities item so executed quantity can
// be checked against the contract quantity.
//
// Endpoints
// ---------
//   GET    /api/boq?variance=1&projectName=…       — variance report
//   GET    /api/boq?projectName=…&isActive=…       — list with filters
//   POST   /api/boq                                — create
//   GET    /api/boq/:id                            — detail
//   PATCH  /api/boq/:id                            — update (creator or admin)
//   DELETE /api/boq/:id                            — soft-delete (creator or admin)
//
// Auth model
// ----------
//   - Read endpoints (list / detail / variance): requireAuth (any employee).
//   - Write endpoints (create / update / delete): requireAuth. Update / delete
//     additionally gated on (createdById === req.employeeId || isAdmin).
//
// Variance calculation
// --------------------
//   executedQty per BOQ item is the SUM of DPR quantities linked to it. The
//   DPR `workEntries` JSON does not currently carry an executed-quantity per
//   sub-work type, so v1 of the variance report sums the DPR `quantity` field
//   on linked rows — a placeholder. Round-29 will replace this with the
//   CubeTest / InspectionTypeFields executed-quantity roll-up once those
//   land. The contract (variance = contract_qty - executed_qty) is stable.
//
// Storage of `amount`
// -------------------
//   amount = quantity × rate is computed and stored on every write. The
//   server recomputes from quantity × rate (never trusts the client), so
//   a malicious payload sending amount=9999999 won't poison the column.
//
// Why soft-delete instead of hard-delete
// --------------------------------------
//   DPR and InspectionRecord both reference boq_item via FK with
//   onDelete: SetNull. The audit trail (which DPRs referenced which BOQ
//   item when) survives the BOQ being removed from active use. isActive
//   flips to false; the row stays.
//
// Order in file
// -------------
//   /variance MUST be declared BEFORE /:id or Express routes the literal
//   string "variance" through the :id handler and 404s. Same bug that
//   bit /api/dpr/stats and /api/inspection/stats in round-20 — see the
//   "LIVE-DISCOVERED" comment above dprStatsAdminGuard.

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { mapPrismaError } = require('../lib/errors');

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function getPrisma(req) {
  return req.app.get('prisma');
}

// Cap common string fields. The BOQ item is engineering metadata, not
// free-form copy — keep the column lengths bounded so a buggy client
// can't poison the table with multi-MB descriptions.
const MAX = {
  projectName: 200,
  itemCode: 60,
  description: 1000,
  unit: 20,
  category: 60,
};

// Cap on list page size — the BOQ list is read-mostly and 100 items is
// more than any single project will have in the foreseeable future.
const LIST_MAX = 100;

// All routes require auth.
router.use(requireAuth);

// ─── Variance report ────────────────────────────────────────────────────────
// Must be declared BEFORE /:id. See the file header comment for the bug.
router.get('/variance', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  const projectName = typeof req.query.projectName === 'string' ? req.query.projectName.trim() : '';

  if (!projectName) {
    return res.status(400).json({
      error: 'projectName is required',
      code: 'PROJECT_NAME_REQUIRED',
    });
  }
  if (projectName.length > MAX.projectName) {
    return res.status(400).json({
      error: `projectName exceeds ${MAX.projectName} chars`,
      code: 'PROJECT_NAME_TOO_LONG',
    });
  }

  try {
    const items = await prisma.boqItem.findMany({
      where: { projectName, isActive: true },
      orderBy: { itemCode: 'asc' },
    });

    // SUM(dpr.quantity) grouped by boq_item_id. v1 of the variance model
    // uses the DPR.quantity field as a placeholder for "executed
    // quantity" — see the file header for the round-29 swap-in.
    //
    // Done in JS (not Prisma groupBy) so we can keep the route
    // dependency-free of Prisma's groupBy raw-shape decisions, and so a
    // missing item (zero DPR rows) lands as executedQty=0 not "absent
    // from the map".
    const linkedDprs = await prisma.dPR.findMany({
      where: {
        projectName,
        boqItemId: { not: null },
      },
      select: { boqItemId: true, quantity: true },
    });

    const executedByItem = new Map();
    for (const d of linkedDprs) {
      executedByItem.set(
        d.boqItemId,
        (executedByItem.get(d.boqItemId) || 0) + (Number(d.quantity) || 0),
      );
    }

    const report = items.map((it) => {
      const executed = executedByItem.get(it.id) || 0;
      const variance = it.quantity - executed;
      return {
        id: it.id,
        itemCode: it.itemCode,
        description: it.description,
        unit: it.unit,
        contractQty: it.quantity,
        executedQty: executed,
        varianceQty: variance,
        contractAmount: it.amount,
        // Executed amount is computed at request time (no stored
        // column). Multiply executed quantity by the contract rate —
        // billing engineers want both views.
        executedAmount: executed * it.rate,
      };
    });

    res.json({ projectName, items: report });
  } catch (err) {
    console.error('BOQ variance error', {
      employeeHash: req.employeeId ? require('../lib/pii').hashIdentifier(req.employeeId) : undefined,
      prismaCode: err.code,
      message: err.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to compute BOQ variance' });
  }
}));

// ─── List ────────────────────────────────────────────────────────────────────
router.get('/', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  const { projectName, isActive, limit = '50' } = req.query;

  const take = Math.min(parseInt(limit) || 50, LIST_MAX);

  const where = {};
  if (projectName) {
    if (typeof projectName !== 'string') {
      return res.status(400).json({ error: 'projectName must be a string' });
    }
    where.projectName = projectName.trim();
  }
  if (isActive !== undefined) {
    if (isActive !== 'true' && isActive !== 'false') {
      return res.status(400).json({ error: 'isActive must be "true" or "false"' });
    }
    where.isActive = isActive === 'true';
  }

  try {
    const items = await prisma.boqItem.findMany({
      where,
      orderBy: [{ projectName: 'asc' }, { itemCode: 'asc' }],
      take,
      include: {
        createdBy: { select: { id: true, name: true, email: true } },
      },
    });
    res.json({ items });
  } catch (err) {
    console.error('BOQ list error', {
      prismaCode: err.code,
      message: err.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to list BOQ items' });
  }
}));

// ─── Create ──────────────────────────────────────────────────────────────────
router.post('/', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  const {
    projectName, itemCode, description, unit, quantity, rate,
    category,
  } = req.body || {};

  // Type guards — reject before Prisma so a non-string `projectName`
  // becomes a clean 400 instead of an opaque 500 (mirror of dpr.js
  // P1-2 / inspection.js).
  if (typeof projectName !== 'string' || !projectName.trim()) {
    return res.status(400).json({ error: 'projectName is required' });
  }
  if (typeof itemCode !== 'string' || !itemCode.trim()) {
    return res.status(400).json({ error: 'itemCode is required' });
  }
  if (typeof description !== 'string' || !description.trim()) {
    return res.status(400).json({ error: 'description is required' });
  }
  if (typeof unit !== 'string' || !unit.trim()) {
    return res.status(400).json({ error: 'unit is required' });
  }
  if (!Number.isFinite(quantity) || quantity < 0) {
    return res.status(400).json({ error: 'quantity must be a non-negative number' });
  }
  if (!Number.isFinite(rate) || rate < 0) {
    return res.status(400).json({ error: 'rate must be a non-negative number' });
  }
  if (category !== undefined && category !== null && typeof category !== 'string') {
    return res.status(400).json({ error: 'category must be a string or null' });
  }

  // Length caps. Apply BEFORE the existence check so a malicious client
  // can't probe valid itemCodes by sending a 60 KB string.
  const values = { projectName, itemCode, description, unit };
  if (category !== undefined) values.category = category;
  for (const [k, cap] of Object.entries(MAX)) {
    if (values[k] != null && typeof values[k] === 'string' && values[k].length > cap) {
      return res.status(400).json({ error: `${k} exceeds ${cap} chars` });
    }
  }

  // Server computes amount = quantity × rate. NEVER trust the client
  // value — even if the field is absent in the request, we set it
  // from the two trusted numerics.
  const amount = Number(quantity) * Number(rate);

  try {
    const created = await prisma.boqItem.create({
      data: {
        projectName: projectName.trim(),
        itemCode: itemCode.trim(),
        description: description.trim(),
        unit: unit.trim(),
        quantity,
        rate,
        amount,
        category: category ? category.trim() : null,
        createdById: req.employeeId,
      },
      include: {
        createdBy: { select: { id: true, name: true, email: true } },
      },
    });
    res.status(201).json(created);
  } catch (err) {
    console.error('BOQ create error', {
      employeeHash: require('../lib/pii').hashIdentifier(req.employeeId),
      prismaCode: err.code,
      meta: err.meta,
      message: err.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) {
      // Specialise the duplicate error — the generic message is opaque;
      // the client knows (projectName, itemCode) is the unique pair.
      if (mapped.code === 'DUPLICATE') {
        return res.status(409).json({
          error: 'A BOQ item with this itemCode already exists for this projectName',
          code: 'DUPLICATE_BOQ_ITEM',
          meta: err.meta,
        });
      }
      return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    }
    res.status(500).json({ error: 'Failed to create BOQ item' });
  }
}));

// ─── Detail ──────────────────────────────────────────────────────────────────
router.get('/:id', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  const { id } = req.params;

  try {
    const item = await prisma.boqItem.findUnique({
      where: { id },
      include: {
        createdBy: { select: { id: true, name: true, email: true } },
        // Include counts so the detail view can show "linked to N DPRs /
        // M inspections" without a second roundtrip.
        _count: {
          select: { dprs: true, inspections: true },
        },
      },
    });
    if (!item) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'BOQ item not found' });
    }
    res.json(item);
  } catch (err) {
    console.error('BOQ get error', {
      prismaCode: err.code,
      message: err.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to fetch BOQ item' });
  }
}));

// ─── Update ──────────────────────────────────────────────────────────────────
// Allowlist. Same IDOR defence as dpr.js P0-1 — the client must not be
// able to mutate createdById (transfer ownership), isActive (soft-delete
// only via DELETE), or the audit timestamps.
const ALLOWED_UPDATE_FIELDS = [
  'projectName', 'itemCode', 'description', 'unit',
  'quantity', 'rate', 'category',
];

router.patch('/:id', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  const { id } = req.params;
  const fields = req.body || {};

  const unknown = Object.keys(fields).filter(k => !ALLOWED_UPDATE_FIELDS.includes(k));
  if (unknown.length) {
    return res.status(400).json({
      error: 'UNKNOWN_FIELDS',
      message: `Fields not allowed: ${unknown.join(', ')}`,
      fields: unknown,
    });
  }

  // Length caps.
  for (const [k, cap] of Object.entries(MAX)) {
    if (fields[k] != null && typeof fields[k] === 'string' && fields[k].length > cap) {
      return res.status(400).json({ error: `${k} exceeds ${cap} chars` });
    }
  }

  // Numeric guards on the two amounts.
  if (fields.quantity !== undefined && (!Number.isFinite(fields.quantity) || fields.quantity < 0)) {
    return res.status(400).json({ error: 'quantity must be a non-negative number' });
  }
  if (fields.rate !== undefined && (!Number.isFinite(fields.rate) || fields.rate < 0)) {
    return res.status(400).json({ error: 'rate must be a non-negative number' });
  }
  if (fields.category !== undefined && fields.category !== null && typeof fields.category !== 'string') {
    return res.status(400).json({ error: 'category must be a string or null' });
  }

  try {
    const existing = await prisma.boqItem.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'BOQ item not found' });
    }

    // Authorisation: creator or admin. Inline `isAdmin` re-read mirrors
    // LPR-007 — we don't trust req.isAdmin from a stale JWT.
    const fresh = await prisma.employee.findUnique({
      where: { id: req.employeeId },
      select: { isAdmin: true },
    });
    const isAdmin = !!(fresh && fresh.isAdmin);
    if (existing.createdById !== req.employeeId && !isAdmin) {
      return res.status(403).json({ error: 'FORBIDDEN', message: 'Only the creator or an admin can update a BOQ item' });
    }

    // Server recomputes amount on every write — see the create route's
    // rationale. We need both quantity and rate to compute it; if only
    // one is being patched, fall back to the existing value.
    const newQuantity = fields.quantity !== undefined ? fields.quantity : existing.quantity;
    const newRate = fields.rate !== undefined ? fields.rate : existing.rate;
    const newAmount = newQuantity * newRate;

    const updated = await prisma.boqItem.update({
      where: { id },
      data: {
        ...fields,
        // Always recompute; never trust a client-supplied amount.
        amount: newAmount,
        updatedAt: new Date(),
      },
      include: {
        createdBy: { select: { id: true, name: true, email: true } },
      },
    });
    res.json(updated);
  } catch (err) {
    console.error('BOQ update error', {
      employeeHash: require('../lib/pii').hashIdentifier(req.employeeId),
      prismaCode: err.code,
      meta: err.meta,
      message: err.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) {
      if (mapped.code === 'DUPLICATE') {
        return res.status(409).json({
          error: 'A BOQ item with this itemCode already exists for this projectName',
          code: 'DUPLICATE_BOQ_ITEM',
          meta: err.meta,
        });
      }
      return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    }
    res.status(500).json({ error: 'Failed to update BOQ item' });
  }
}));

// ─── Soft-delete ─────────────────────────────────────────────────────────────
// isActive flips to false; the row stays. Linked DPR / Inspection rows
// keep their FK reference (boqItemId stays valid; the BOQ is just
// "archived" not "deleted"). The next list call with isActive=true will
// hide it; the variance report already filters isActive=true.
router.delete('/:id', asyncHandler(async (req, res) => {
  const prisma = getPrisma(req);
  const { id } = req.params;

  try {
    const existing = await prisma.boqItem.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'BOQ item not found' });
    }

    if (!existing.isActive) {
      // Idempotent — a second DELETE returns 200 with the unchanged row
      // so a mobile retry after a network blip doesn't 404 the client.
      return res.json({ ...existing, alreadyDeleted: true });
    }

    const fresh = await prisma.employee.findUnique({
      where: { id: req.employeeId },
      select: { isAdmin: true },
    });
    const isAdmin = !!(fresh && fresh.isAdmin);
    if (existing.createdById !== req.employeeId && !isAdmin) {
      return res.status(403).json({ error: 'FORBIDDEN', message: 'Only the creator or an admin can delete a BOQ item' });
    }

    const updated = await prisma.boqItem.update({
      where: { id },
      data: { isActive: false },
      include: {
        createdBy: { select: { id: true, name: true, email: true } },
      },
    });
    res.json({ ...updated, deleted: true });
  } catch (err) {
    console.error('BOQ delete error', {
      employeeHash: require('../lib/pii').hashIdentifier(req.employeeId),
      prismaCode: err.code,
      message: err.message?.split('\n')[0],
    });
    const mapped = mapPrismaError(err);
    if (mapped) return res.status(mapped.status).json({ error: mapped.message, code: mapped.code });
    res.status(500).json({ error: 'Failed to delete BOQ item' });
  }
}));

module.exports = router;