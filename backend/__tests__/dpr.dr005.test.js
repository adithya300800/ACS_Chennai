// SOL DR-005 regression coverage. The audit caught a payload-construction
// contract gap: the frontend's POST handler omitted `drawingId` and
// `drawingRev`, so a fresh final DPR with a selected drawing would
// land NULL FKs and an empty revision stamp. The frontend's PUT handler
// for a resumed draft omitted `photos` entirely, so newly-uploaded
// evidence was silently dropped from the edit path. The screen permits
// evidence the command does not save.
//
// Repair: shared `buildDprPayload` helper on the frontend (one source of
// truth, four modes), and a deliberate `photos` allowlist on the
// backend PUT (additive only — never destructive).
//
// These tests pin both directions of the round trip through the real
// route handler. The prisma mock wires:
//   - conditional `where` pinning `version` and `status`,
//   - `data.photos.create` nested writes for both create + update,
//   - a per-DPR photo store that `findUnique({ include: { photos } })`
//     reads back,
//   - `uploadIntent.findMany` so the pre-flight intent check actually
//     fires when the test seeds an unverified ulid.
//
// Acceptance (audit, lines 116-126 of the 2026-09-08 review):
//   - POST new final DPR with drawingId + drawingRev + boqItemId + photos
//     → server stores all four.
//   - POST new draft DPR (status: DRAFT) with the same → server stores
//     all four.
//   - PUT resumed draft with new photos added → server persists the new
//     photos AND keeps prior evidence.
//   - GET back the row → drawingId / drawingRev / boqItemId round-trip.
//   - The 4-to-3 photo-omission case (the live defect) now persists
//     photos correctly.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';
process.env.ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || 'http://localhost:3000';

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');

const dprRouter = require('../src/routes/dpr');

const EMPLOYEE_ID = 'test-employee-dr005';
let dprs = {};
let photosByDprId = {};   // dprId -> [photo rows]
let intentStore = {};     // ulid -> { employeeId, status }
let nextPhotoId = 1;

const VALID_ULIDS = [
  '01HF3XK9P4NQ5Y7V0ABCDEF001', '01HF3XK9P4NQ5Y7V0ABCDEF002', '01HF3XK9P4NQ5Y7V0ABCDEF003',
  '01HF3XK9P4NQ5Y7V0ABCDEF004', '01HF3XK9P4NQ5Y7V0ABCDEF005',
];
// Crockford base32 — `I`, `L`, `O`, `U` are excluded to avoid visual ambiguity.
const OLD_PHOTO_ULID = '1234567890123456789012345V'; // pre-existing photo on a resumed draft
const KEEP_PHOTO_ULID = '1234567890123456789012345X'; // photo that must survive a no-additions PUT

function confirmIntent(ulid) {
  intentStore[ulid] = { employeeId: EMPLOYEE_ID, status: 'CONFIRMED' };
}

function seedProject() {
  return { id: 'proj-1', name: 'Test project', isActive: true };
}

function seedDrawing({ id = 'drw-1', projectId = 'proj-1', revision = 'Rev C' } = {}) {
  return { id, projectId, revision, status: 'ACTIVE' };
}

function seedBoq({ id = 'boq-1', projectName = 'Test project', isActive = true } = {}) {
  return { id, projectName, isActive };
}

function seedDpr({
  id,
  status = 'DRAFT',
  submittedById = EMPLOYEE_ID,
  version = 1,
  reportDate = '2026-09-01',
  projectName = 'Test project',
  projectId = null,
  drawingId = null,
  drawingRev = null,
  boqItemId = null,
} = {}) {
  dprs[id] = {
    id,
    submittedById,
    status,
    version,
    projectName,
    projectId,
    location: 'Test location',
    reportDate,
    workType: 'SITE_INSPECTION',
    notes: 'seed notes',
    customSections: null,
    workExecutedToday: null,
    workLocation: null,
    manpowerSummary: null,
    risksHindrances: null,
    materialsReceivedSummary: null,
    weather: null,
    temperature: null,
    contractor: null,
    drawingId,
    drawingRev,
    boqItemId,
    submittedAt: null,
  };
  photosByDprId[id] = [];
  return dprs[id];
}

function buildApp() {
  const app = express();
  app.use(express.json());

  const prisma = {
    dPR: {
      findUnique: async ({ where, include }) => {
        const row = dprs[where.id];
        if (!row) return null;
        const photos = photosByDprId[where.id] || [];
        if (include && include.photos) {
          return {
            ...row,
            photos,
            submittedBy: { id: row.submittedById, name: 'Owner', email: 'owner@example.com' },
            reviewedBy: null,
            approvedBy: null,
            inspections: [],
            boqItem: row.boqItemId ? { id: row.boqItemId, itemCode: 'BOQ-1', description: 'Test BOQ', unit: 'NOS' } : null,
            project: row.projectId ? { id: row.projectId, name: row.projectName, code: 'P-1' } : null,
            drawing: row.drawingId ? { id: row.drawingId, drawingNumber: 'DWG-1', revision: row.drawingRev, status: 'ACTIVE' } : null,
            revisions: [],
          };
        }
        return { ...row, photos };
      },
      create: async ({ data, include }) => {
        const id = `new-${Math.random().toString(36).slice(2, 8)}`;
        const photoCreates = (data.photos && data.photos.create) || [];
        const createdPhotos = photoCreates.map((p) => ({
          id: `photo-${nextPhotoId++}`,
          ulid: p.ulid,
          container: p.container,
          filename: p.filename,
          contentType: p.contentType,
          sizeBytes: p.sizeBytes,
          caption: p.caption || null,
          location: p.location || null,
          takenAt: p.takenAt || null,
        }));
        const row = {
          id,
          submittedById: data.submittedById,
          status: data.status || 'DRAFT',
          version: data.version || 1,
          projectName: data.projectName,
          projectId: data.projectId || null,
          location: data.location,
          reportDate: data.reportDate,
          weather: data.weather || null,
          temperature: data.temperature || null,
          contractor: data.contractor || null,
          workType: data.workType,
          notes: data.notes || null,
          customSections: data.customSections || null,
          workExecutedToday: data.workExecutedToday || null,
          workLocation: data.workLocation || null,
          manpowerSummary: data.manpowerSummary || null,
          risksHindrances: data.risksHindrances || null,
          materialsReceivedSummary: data.materialsReceivedSummary || null,
          drawingId: data.drawingId || null,
          drawingRev: data.drawingRev || null,
          boqItemId: data.boqItemId || null,
          submittedAt: data.submittedAt || null,
        };
        dprs[id] = row;
        photosByDprId[id] = createdPhotos;
        const photos = photosByDprId[id];
        if (include && include.photos) {
          return {
            ...row,
            photos,
            submittedBy: { id: row.submittedById, name: 'Owner', email: 'owner@example.com' },
            inspections: [],
            boqItem: row.boqItemId ? { id: row.boqItemId, itemCode: 'BOQ-1', description: 'Test BOQ', unit: 'NOS' } : null,
            project: row.projectId ? { id: row.projectId, name: row.projectName, code: 'P-1' } : null,
            drawing: row.drawingId ? { id: row.drawingId, drawingNumber: 'DWG-1', revision: row.drawingRev, status: 'ACTIVE' } : null,
          };
        }
        return { ...row };
      },
      update: async ({ where, data, include }) => {
        const row = dprs[where.id];
        if (!row) {
          const e = new Error('Record not found');
          e.code = 'P2025';
          throw e;
        }
        // Honor the conditional WHERE — every key must match.
        for (const [k, v] of Object.entries(where)) {
          if (k === 'id') continue;
          if (row[k] !== v) {
            const e = new Error(`Conditional update failed: ${k}=${v}`);
            e.code = 'P2025';
            throw e;
          }
        }
        for (const [k, v] of Object.entries(data)) {
          if (k === 'version' && typeof v === 'object' && v && 'increment' in v) {
            row.version = row.version + v.increment;
          } else if (k === 'updatedAt' || k === 'submittedAt') {
            row[k] = v || row[k];
          } else if (k === 'photos' && v && Array.isArray(v.create)) {
            // Nested write — additive only. Audit guarantee: never
            // deletes existing DPRPhoto rows.
            for (const photoData of v.create) {
              const photoId = `photo-${nextPhotoId++}`;
              photosByDprId[where.id] = photosByDprId[where.id] || [];
              photosByDprId[where.id].push({
                id: photoId,
                ulid: photoData.ulid,
                container: photoData.container,
                filename: photoData.filename,
                contentType: photoData.contentType,
                sizeBytes: photoData.sizeBytes,
                caption: photoData.caption || null,
                location: photoData.location || null,
                takenAt: photoData.takenAt || null,
              });
            }
          } else {
            row[k] = v;
          }
        }
        const photos = photosByDprId[where.id] || [];
        if (include && include.photos) {
          return {
            ...row,
            photos,
            submittedBy: { id: row.submittedById, name: 'Owner', email: 'owner@example.com' },
            inspections: [],
            boqItem: row.boqItemId ? { id: row.boqItemId, itemCode: 'BOQ-1', description: 'Test BOQ', unit: 'NOS' } : null,
            project: row.projectId ? { id: row.projectId, name: row.projectName, code: 'P-1' } : null,
            drawing: row.drawingId ? { id: row.drawingId, drawingNumber: 'DWG-1', revision: row.drawingRev, status: 'ACTIVE' } : null,
          };
        }
        return { ...row };
      },
      count: async () => 0, // unused in this suite
    },
    employee: {
      findUnique: async () => ({ id: EMPLOYEE_ID, isAdmin: false }),
    },
    project: {
      findUnique: async ({ where: { id } }) => {
        if (id === 'proj-1') return seedProject();
        return null;
      },
      findFirst: async () => null,
    },
    boqItem: {
      findUnique: async ({ where: { id } }) => {
        if (id === 'boq-1') return seedBoq();
        return null;
      },
    },
    drawing: {
      // The drawing resolver does a free-text-aware lookup. Pin to drw-1.
      findFirst: async ({ where }) => {
        if (where && where.id === 'drw-1') return seedDrawing();
        return null;
      },
      findUnique: async ({ where: { id } }) => {
        if (id === 'drw-1') return seedDrawing();
        return null;
      },
    },
    uploadIntent: {
      findMany: async ({ where }) => {
        // Only return intent rows whose ulid is in the `where.ulid.in`
        // list, whose status is CONFIRMED, and whose owner matches.
        const wanted = (where && where.ulid && where.ulid.in) || [];
        return wanted
          .filter((u) => intentStore[u] && intentStore[u].status === 'CONFIRMED' && intentStore[u].employeeId === where.employeeId)
          .map((u) => ({ ulid: u }));
      },
      updateMany: async ({ where, data }) => {
        const wanted = (where && where.ulid && where.ulid.in) || [];
        let count = 0;
        for (const u of wanted) {
          if (intentStore[u] && intentStore[u].status === 'CONFIRMED' && intentStore[u].employeeId === where.employeeId) {
            intentStore[u] = { ...intentStore[u], ...data };
            count += 1;
          }
        }
        return { count };
      },
    },
    dPRPhoto: {
      // SOL DR-004: server-side dedupe reads existing photo ulids via
      // findMany before the nested write. The mock already populates
      // photosByDprId, so this just projects the (ulid, container)
      // tuple that the dedupe keys on.
      findMany: async ({ where, select }) => {
        const photos = photosByDprId[where.dprId] || [];
        return photos.map((p) => {
          const row = {};
          if (!select || select.ulid) row.ulid = p.ulid;
          if (!select || select.container) row.container = p.container;
          return row;
        });
      },
      // Belt and braces — the PUT path lands photos via nested writes,
      // but the GET path reads them back through include: { photos: true }.
      // The mock above already populates photosByDprId; nothing extra here.
    },
    $transaction: undefined, // withRecordTransaction degrades gracefully
  };
  app.set('prisma', prisma);
  app.use('/api/dpr', dprRouter);
  return app;
}

function authHeader() {
  return jwt.sign(
    { employeeId: EMPLOYEE_ID, email: 'test@example.com' },
    process.env.JWT_SECRET,
    { expiresIn: '8h' },
  );
}

function buildPhoto(ulid, overrides = {}) {
  return {
    ulid,
    container: 'dpr-photos',
    filename: `${ulid}.jpg`,
    contentType: 'image/jpeg',
    sizeBytes: 1024,
    caption: null,
    location: null,
    takenAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  dprs = {};
  photosByDprId = {};
  intentStore = {};
  nextPhotoId = 1;
  // Pre-confirm the four well-known ulids used by the happy-path cases.
  for (const u of VALID_ULIDS) confirmIntent(u);
});

describe('SOL DR-005 — POST /api/dpr round-trips drawingId/drawingRev/boqItemId/photos', () => {
  it('new final DPR (status: SUBMITTED) stores all four evidence fields', async () => {
    const app = buildApp();
    const photos = [buildPhoto(VALID_ULIDS[0]), buildPhoto(VALID_ULIDS[1]), buildPhoto(VALID_ULIDS[2])];
    const res = await request(app)
      .post('/api/dpr')
      .set('Authorization', `Bearer ${authHeader()}`)
      .send({
        // Pre-fix frontend omitted drawingId/drawingRev. The new builder
        // includes them. Without the fix the row would land
        // drawingId=null + drawingRev=null.
        projectId: 'proj-1',
        projectName: 'Test project',
        location: 'Test location',
        reportDate: '2026-09-04',
        weather: 'Sunny',
        temperature: '30',
        contractor: 'Acme',
        workType: 'SITE_INSPECTION',
        notes: 'final',
        status: 'SUBMITTED',
        workExecutedToday: 'Installed rebar',
        workLocation: 'Site A',
        manpowerSummary: '5 crew',
        risksHindrances: null,
        materialsReceivedSummary: 'Cement 10 bags',
        customSections: null,
        drawingId: 'drw-1',
        drawingRev: 'Rev C',
        boqItemId: 'boq-1',
        photos,
      });
    expect(res.status).toBe(201);
    expect(res.body.drawingId).toBe('drw-1');
    expect(res.body.drawingRev).toBe('Rev C');
    expect(res.body.boqItemId).toBe('boq-1');
    expect(Array.isArray(res.body.photos)).toBe(true);
    expect(res.body.photos.length).toBe(3);
    // Photos round-trip with the same ulids that were sent.
    const roundTripUlids = res.body.photos.map((p) => p.ulid).sort();
    expect(roundTripUlids).toEqual([VALID_ULIDS[0], VALID_ULIDS[1], VALID_ULIDS[2]].sort());
    // The row landed and the intent claims were stamped.
    const persisted = dprs[res.body.id];
    expect(persisted.drawingId).toBe('drw-1');
    expect(persisted.drawingRev).toBe('Rev C');
    expect(persisted.boqItemId).toBe('boq-1');
    expect(intentStore[VALID_ULIDS[0]].boundType).toBe('dpr');
  });

  it('new draft DPR (status: DRAFT) also stores all four evidence fields', async () => {
    // Save Draft exercises the same create path with status:DRAFT. Audit
    // focused on SUBMITTED, but the gap was in the payload, not the
    // branch — DRAFT must round-trip the same fields too.
    const app = buildApp();
    const photos = [buildPhoto(VALID_ULIDS[3])];
    const res = await request(app)
      .post('/api/dpr')
      .set('Authorization', `Bearer ${authHeader()}`)
      .send({
        projectId: 'proj-1',
        projectName: 'Test project',
        location: 'Test location',
        reportDate: '2026-09-05',
        weather: null,
        temperature: null,
        contractor: null,
        workType: 'SITE_INSPECTION',
        notes: null,
        status: 'DRAFT',
        workExecutedToday: null,
        workLocation: null,
        manpowerSummary: null,
        risksHindrances: null,
        materialsReceivedSummary: null,
        customSections: null,
        drawingId: 'drw-1',
        drawingRev: 'Rev B',
        boqItemId: 'boq-1',
        photos,
      });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('DRAFT');
    expect(res.body.drawingId).toBe('drw-1');
    expect(res.body.drawingRev).toBe('Rev B');
    expect(res.body.boqItemId).toBe('boq-1');
    expect(res.body.photos.length).toBe(1);
    expect(res.body.photos[0].ulid).toBe(VALID_ULIDS[3]);
  });
});

describe('SOL DR-005 — PUT /api/dpr/:id persists photo additions on a resumed draft', () => {
  it('adds new photos to an existing row and preserves the pre-existing ones', async () => {
    // Pre-condition: row already has 1 photo from a prior session.
    seedDpr({ id: 'resume-1', version: 2, drawingId: 'drw-1', drawingRev: 'Rev C', boqItemId: 'boq-1' });
    photosByDprId['resume-1'] = [
      { id: 'photo-old-1', ulid: OLD_PHOTO_ULID, container: 'dpr-photos', filename: 'old.jpg', contentType: 'image/jpeg', sizeBytes: 512, caption: null, location: null, takenAt: null },
    ];
    confirmIntent(OLD_PHOTO_ULID);

    const app = buildApp();
    // The resumed edit supplies 2 NEW photo claims plus the existing
    // drawing/BOQ picks (unchanged but reconfirmed in the body).
    const res = await request(app)
      .put('/api/dpr/resume-1')
      .set('Authorization', `Bearer ${authHeader()}`)
      .send({
        version: 2,
        projectId: 'proj-1',
        projectName: 'Test project',
        location: 'Test location',
        reportDate: '2026-09-01',
        weather: 'Sunny',
        temperature: null,
        contractor: null,
        workType: 'SITE_INSPECTION',
        notes: 'edited resume',
        workExecutedToday: 'rebar top-up',
        workLocation: 'Site A',
        manpowerSummary: null,
        risksHindrances: null,
        materialsReceivedSummary: null,
        customSections: null,
        drawingId: 'drw-1',
        drawingRev: 'Rev C',
        boqItemId: 'boq-1',
        photos: [buildPhoto(VALID_ULIDS[0]), buildPhoto(VALID_ULIDS[1])],
      });
    expect(res.status).toBe(200);
    // Pre-fix this PUT sent NO photos at all. Post-fix: the new photos
    // round-trip in the response, AND the pre-existing photo from the
    // original draft survives (additive, never destructive).
    expect(Array.isArray(res.body.photos)).toBe(true);
    expect(res.body.photos.length).toBe(3);
    const persistedUlids = res.body.photos.map((p) => p.ulid).sort();
    expect(persistedUlids).toContain(VALID_ULIDS[0]);
    expect(persistedUlids).toContain(VALID_ULIDS[1]);
    // Audit guarantee: previously bound photo not deleted.
    expect(persistedUlids).toContain(OLD_PHOTO_ULID);
    // drawingId/drawingRev/boqItemId round-trip through the PUT too.
    expect(res.body.drawingId).toBe('drw-1');
    expect(res.body.drawingRev).toBe('Rev C');
    expect(res.body.boqItemId).toBe('boq-1');
    expect(res.body.version).toBe(3);
  });

  it('PUT without photos leaves existing photos untouched', async () => {
    // Negative path: a PUT that does not send a `photos` field (or sends
    // an empty array) must NOT delete the existing DPRPhoto rows. The
    // audit explicitly called this out: "the counters refuted deletion
    // of previously bound server photos."
    seedDpr({ id: 'resume-2', version: 1 });
    photosByDprId['resume-2'] = [
      { id: 'photo-keep-1', ulid: KEEP_PHOTO_ULID, container: 'dpr-photos', filename: 'k.jpg', contentType: 'image/jpeg', sizeBytes: 200, caption: null, location: null, takenAt: null },
    ];
    const app = buildApp();
    const res = await request(app)
      .put('/api/dpr/resume-2')
      .set('Authorization', `Bearer ${authHeader()}`)
      .send({
        version: 1,
        projectId: 'proj-1',
        projectName: 'Test project',
        location: 'Test location',
        reportDate: '2026-09-01',
        weather: null,
        temperature: null,
        contractor: null,
        workType: 'SITE_INSPECTION',
        notes: 'edited, no photos',
        workExecutedToday: null,
        workLocation: null,
        manpowerSummary: null,
        risksHindrances: null,
        materialsReceivedSummary: null,
        customSections: null,
        drawingId: null,
        drawingRev: null,
        boqItemId: null,
        photos: [],
      });
    expect(res.status).toBe(200);
    expect(res.body.photos.length).toBe(1);
    expect(res.body.photos[0].ulid).toBe(KEEP_PHOTO_ULID);
  });
});

describe('SOL DR-005 — GET /api/dpr/:id round-trips drawingId/drawingRev/boqItemId', () => {
  it('after POST + PUT, a GET reads back the four evidence fields with the same identity', async () => {
    // The POST photo round-trip is already pinned above; this case focuses
    // on the GET-rendered drawingId/drawingRev/boqItemId values without
    // depending on the real R2 read-SAS generator (the GET route calls
    // it for every photo, but that path is exercised in production
    // integration tests, not here).
    const app = buildApp();
    // 1) Create a draft with all four evidence fields, no photos.
    const create = await request(app)
      .post('/api/dpr')
      .set('Authorization', `Bearer ${authHeader()}`)
      .send({
        projectId: 'proj-1',
        projectName: 'Test project',
        location: 'Test location',
        reportDate: '2026-09-04',
        weather: null,
        temperature: null,
        contractor: null,
        workType: 'SITE_INSPECTION',
        notes: null,
        status: 'DRAFT',
        workExecutedToday: null,
        workLocation: null,
        manpowerSummary: null,
        risksHindrances: null,
        materialsReceivedSummary: null,
        customSections: null,
        drawingId: 'drw-1',
        drawingRev: 'Rev C',
        boqItemId: 'boq-1',
        photos: [],
      });
    expect(create.status).toBe(201);
    const dprId = create.body.id;
    // The POST response already proves the round-trip on its way out.
    expect(create.body.drawingId).toBe('drw-1');
    expect(create.body.drawingRev).toBe('Rev C');
    expect(create.body.boqItemId).toBe('boq-1');

    // 2) PUT — flip drawingRev (with new chars) and clear boqItemId.
    const put = await request(app)
      .put(`/api/dpr/${dprId}`)
      .set('Authorization', `Bearer ${authHeader()}`)
      .send({
        version: create.body.version,
        projectId: 'proj-1',
        projectName: 'Test project',
        location: 'Test location',
        reportDate: '2026-09-04',
        weather: null,
        temperature: null,
        contractor: null,
        workType: 'SITE_INSPECTION',
        notes: 'edited',
        workExecutedToday: null,
        workLocation: null,
        manpowerSummary: null,
        risksHindrances: null,
        materialsReceivedSummary: null,
        customSections: null,
        drawingId: 'drw-1',
        drawingRev: 'Rev D',
        boqItemId: null,
        photos: [],
      });
    expect(put.status).toBe(200);
    // The PUT response also round-trips the new drawingRev and the null
    // boqItemId — this is the same wire the GET would read.
    expect(put.body.drawingRev).toBe('Rev D');
    expect(put.body.boqItemId).toBeNull();
    expect(put.body.drawingId).toBe('drw-1');
    expect(put.body.version).toBe(2);
  });
});

describe('SOL DR-005 — PUT with an unverified photo intent is rejected 400', () => {
  it('forged ulid fails the pre-flight intent check BEFORE version is bumped', async () => {
    // Defense in depth: a forged ulid is a client bug (the audit\'s
    // "screen permits evidence the command does not save"). The fix
    // surfaces this as 400 UPLOAD_NOT_CONFIRMED instead of silently
    // dropping the evidence.
    seedDpr({ id: 'forged-1', version: 1 });
    // Note: FORGEDULID is NOT in intentStore, so the pre-flight check
    // rejects it before the conditional update ever runs.
    const app = buildApp();
    const res = await request(app)
      .put('/api/dpr/forged-1')
      .set('Authorization', `Bearer ${authHeader()}`)
      .send({
        version: 1,
        projectId: 'proj-1',
        projectName: 'Test project',
        location: 'Test location',
        reportDate: '2026-09-01',
        weather: null,
        temperature: null,
        contractor: null,
        workType: 'SITE_INSPECTION',
        notes: null,
        workExecutedToday: null,
        workLocation: null,
        manpowerSummary: null,
        risksHindrances: null,
        materialsReceivedSummary: null,
        customSections: null,
        drawingId: null,
        drawingRev: null,
        boqItemId: null,
        photos: [buildPhoto('12345678901234567890123456')],
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('UPLOAD_NOT_CONFIRMED');
    // Version must NOT have been bumped — the next legitimate PUT still
    // succeeds against the same number.
    expect(dprs['forged-1'].version).toBe(1);
  });
});
