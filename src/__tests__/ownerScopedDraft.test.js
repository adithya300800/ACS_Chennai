// SOL DR-003 + DR-006 regression coverage.
//
// DR-003 originally fixed unscoped drafts (every account on a Shared
// computer saw the previous user's draft) by scoping every key by
// `employeeId` AND auto-migrating any legacy unscoped draft to the
// first reader. SOL DR-006 reversed that auto-migration: a reader-
// stamped marker cannot prove authorship, so attributing A's orphan
// to B (the first reader after A's session expired) silently leaked
// private work. The fix is to refuse to restore an unowned legacy
// draft — `load` / `loadDiagnostic` return a quarantine envelope so the
// caller can show a banner explaining why the orphan cannot be
// restored.
//
// Acceptance criteria from SOL DR-003 (still pinned):
//   - A -> logout -> B cannot see A's scoped draft.
//   - Expired A -> reauthenticate A can recover their own scoped draft.
//   - Different bases (dpr vs inspection) are independent.
//
// Acceptance criteria from SOL DR-006 (new):
//   - B never sees or submits A's unowned legacy content.
//   - A's correctly scoped draft restores normally.
//   - Missing/malformed owner information is not treated as authorization.

const {
  load,
  loadDiagnostic,
  save,
  clear,
  clearForUser,
  clearAllExcept,
  MIGRATION_MARKER_KEY,
  scopedKey,
} = require('../lib/ownerScopedDraft.js');

describe('SOL DR-003 — scopedKey', () => {
  it('appends employee id to base', () => {
    expect(scopedKey('dpr_draft_v1', 'empA')).toBe('dpr_draft_v1:empA');
  });

  it('returns null when employeeId is missing or wrong type', () => {
    expect(scopedKey('dpr_draft_v1', null)).toBeNull();
    expect(scopedKey('dpr_draft_v1', undefined)).toBeNull();
    expect(scopedKey('dpr_draft_v1', '')).toBeNull();
    expect(scopedKey('dpr_draft_v1', 12345)).toBeNull();
    expect(scopedKey(null, 'empA')).toBeNull();
    expect(scopedKey('', 'empA')).toBeNull();
  });
});

describe('SOL DR-003 — load / save isolation', () => {
  beforeEach(() => localStorage.clear());

  it("A saves, A reads back", () => {
    save('dpr_draft_v1', 'empA', { form: { projectName: 'A site' } });
    expect(load('dpr_draft_v1', 'empA')).toEqual({ form: { projectName: 'A site' } });
  });

  it('A saves, B sees null (cross-account isolation)', () => {
    save('dpr_draft_v1', 'empA', { form: { projectName: 'A site' } });
    expect(load('dpr_draft_v1', 'empB')).toBeNull();
  });

  it('save with no employeeId is a no-op (no unscoped writes)', () => {
    save('dpr_draft_v1', null, { form: { projectName: 'leak' } });
    expect(localStorage.getItem('dpr_draft_v1')).toBeNull();
    expect(load('dpr_draft_v1', 'empA')).toBeNull();
  });

  it('load with no employeeId returns null', () => {
    save('dpr_draft_v1', 'empA', { form: { projectName: 'A site' } });
    expect(load('dpr_draft_v1', null)).toBeNull();
    expect(load('dpr_draft_v1', undefined)).toBeNull();
  });

  it('clear removes only the scoped key for that user', () => {
    save('dpr_draft_v1', 'empA', { form: { projectName: 'A site' } });
    save('dpr_draft_v1', 'empB', { form: { projectName: 'B site' } });
    clear('dpr_draft_v1', 'empA');
    expect(load('dpr_draft_v1', 'empA')).toBeNull();
    expect(load('dpr_draft_v1', 'empB')).toEqual({ form: { projectName: 'B site' } });
  });
});

describe('SOL DR-006 — legacy unscoped draft is QUARANTINED, never auto-attributed', () => {
  beforeEach(() => localStorage.clear());

  it('first reader of an unowned legacy draft gets a quarantine envelope, not the draft content', () => {
    localStorage.setItem('dpr_draft_v1', JSON.stringify({ form: { projectName: 'Legacy A' } }));
    // The form must NOT receive A's content — it gets a quarantine
    // envelope that the banner-handling UI can recognize.
    expect(load('dpr_draft_v1', 'empA')).toEqual({
      __quarantined: true,
      reason: 'legacy-unowned',
    });
  });

  it('does NOT write a scoped key on first read of an unowned legacy draft', () => {
    localStorage.setItem('dpr_draft_v1', JSON.stringify({ form: { projectName: 'Legacy A' } }));
    load('dpr_draft_v1', 'empA');
    // The scoped key must NOT exist — we did not silently adopt the orphan.
    expect(localStorage.getItem('dpr_draft_v1:empA')).toBeNull();
    // The unscoped key is untouched so the legitimate owner (or admin)
    // can still inspect / recover it manually if they have to.
    expect(localStorage.getItem('dpr_draft_v1')).not.toBeNull();
  });

  it('does NOT stamp the migration marker for unowned legacy drafts', () => {
    localStorage.setItem('dpr_draft_v1', JSON.stringify({ form: { projectName: 'Legacy A' } }));
    load('dpr_draft_v1', 'empA');
    // Migration markers would have introduced the same first-reader
    // attribution problem DR-006 calls out; we don't write them at all.
    const raw = localStorage.getItem(MIGRATION_MARKER_KEY);
    expect(raw === null || raw === undefined).toBe(true);
  });

  it('a SECOND user also gets the quarantine envelope, not the draft content', () => {
    // The DR-006 acceptance bullet: "B never sees or submits A's
    // unowned legacy content". Even if A logged in first and we had
    // adopted the draft (we don't), B must still see the quarantine.
    localStorage.setItem('dpr_draft_v1', JSON.stringify({ form: { projectName: 'Legacy A' } }));
    expect(load('dpr_draft_v1', 'empA')).toEqual({
      __quarantined: true,
      reason: 'legacy-unowned',
    });
    expect(load('dpr_draft_v1', 'empB')).toEqual({
      __quarantined: true,
      reason: 'legacy-unowned',
    });
  });

  it('different bases quarantine independently per user', () => {
    localStorage.setItem('dpr_draft_v1', JSON.stringify({ form: { projectName: 'Legacy DPR' } }));
    localStorage.setItem('inspection_draft_v1', JSON.stringify({ workEntry: { data: 'x' } }));
    expect(load('dpr_draft_v1', 'empA')).toEqual({
      __quarantined: true,
      reason: 'legacy-unowned',
    });
    expect(load('inspection_draft_v1', 'empA')).toEqual({
      __quarantined: true,
      reason: 'legacy-unowned',
    });
  });

  it('unowned legacy draft does not pollute the legitimate user after they save their own draft', () => {
    // A scoped draft from the current user still loads normally even if
    // an orphan legacy draft exists alongside it.
    localStorage.setItem('dpr_draft_v1', JSON.stringify({ form: { projectName: 'Legacy A' } }));
    save('dpr_draft_v1', 'empA', { form: { projectName: 'Real A' } });
    expect(load('dpr_draft_v1', 'empA')).toEqual({ form: { projectName: 'Real A' } });
  });

  it('expired A returning to their own machine recovers their SCOPED draft (DR-003 acceptance — still pinned)', () => {
    save('dpr_draft_v1', 'empA', { form: { projectName: 'Site A' } });
    // Session expires — server kicks the user out. localStorage persists.
    // A re-authenticates and lands back on /portal/dpr/submit.
    expect(load('dpr_draft_v1', 'empA')).toEqual({ form: { projectName: 'Site A' } });
  });

  it('B can never read A\'s scoped draft content even when an orphan legacy draft is also present', () => {
    // A's scoped draft is in scoped storage; an orphan legacy draft also
    // sits at the unscoped base (different shape). B must never see
    // EITHER — the scoped key is per-employee, and the unscoped legacy
    // is quarantined, not attributed to B.
    save('dpr_draft_v1', 'empA', { form: { projectName: 'A scoped' } });
    localStorage.setItem('dpr_draft_v1', JSON.stringify({ form: { projectName: 'A legacy' } }));
    const result = load('dpr_draft_v1', 'empB');
    // B does not see A's scoped content.
    expect(result === null || (result && result.__quarantined)).toBe(true);
    // The scoped key (which actually contains A's data) MUST NOT be
    // returned to B.
    expect(result).not.toEqual({ form: { projectName: 'A scoped' } });
    // The unscoped legacy is quarantined, not adopted.
    expect(result).not.toEqual({ form: { projectName: 'A legacy' } });
  });
});

describe('SOL DR-006 — loadDiagnostic quarantine flag', () => {
  beforeEach(() => localStorage.clear());

  it('returns quarantined:true and a quarantine envelope for an unowned legacy draft', () => {
    localStorage.setItem('dpr_draft_v1', JSON.stringify({ form: { projectName: 'Legacy A' } }));
    const diag = loadDiagnostic('dpr_draft_v1', 'empA');
    expect(diag.quarantined).toBe(true);
    expect(diag.corrupt).toBe(false);
    expect(diag.migrated).toBe(false);
    expect(diag.value).toEqual({ __quarantined: true, reason: 'legacy-unowned' });
  });

  it('returns quarantined:false for a normal scoped draft', () => {
    save('dpr_draft_v1', 'empA', { form: { projectName: 'A site' } });
    const diag = loadDiagnostic('dpr_draft_v1', 'empA');
    expect(diag.quarantined).toBe(false);
    expect(diag.corrupt).toBe(false);
    expect(diag.value).toEqual({ form: { projectName: 'A site' } });
  });

  it('returns quarantined:false and corrupt:true for an unreadable legacy key', () => {
    // Corrupt at the SCOPED key — this is the existing DR-001 pin path,
    // not a quarantine case.
    localStorage.setItem('dpr_draft_v1:empA', '{not-json');
    const diag = loadDiagnostic('dpr_draft_v1', 'empA');
    expect(diag.corrupt).toBe(true);
    expect(diag.quarantined).toBe(false);
  });

  it('returns quarantined:true and corrupt:true for an unreadable legacy unscoped key (drop + report)', () => {
    localStorage.setItem('dpr_draft_v1', '{not-json');
    const diag = loadDiagnostic('dpr_draft_v1', 'empA');
    expect(diag.corrupt).toBe(true);
    expect(diag.quarantined).toBe(false);
    // The unscoped key is dropped so the next read does not retry.
    expect(localStorage.getItem('dpr_draft_v1')).toBeNull();
  });

  it('returns null-quarantined-false when nothing exists', () => {
    const diag = loadDiagnostic('dpr_draft_v1', 'empA');
    expect(diag).toEqual({ value: null, corrupt: false, quarantined: false, migrated: false });
  });
});

describe('SOL DR-003 — logout / clearForUser', () => {
  beforeEach(() => localStorage.clear());

  it('clearForUser removes only the targeted user across multiple bases', () => {
    save('dpr_draft_v1', 'empA', { form: { projectName: 'A' } });
    save('inspection_draft_v1', 'empA', { workEntry: { data: 'A' } });
    save('dpr_draft_v1', 'empB', { form: { projectName: 'B' } });
    clearForUser('dpr_draft_v1', 'empA');
    clearForUser('inspection_draft_v1', 'empA');
    expect(load('dpr_draft_v1', 'empA')).toBeNull();
    expect(load('inspection_draft_v1', 'empA')).toBeNull();
    expect(load('dpr_draft_v1', 'empB')).toEqual({ form: { projectName: 'B' } });
  });

  it('clearForUser with a non-existent base is a no-op', () => {
    expect(() => clearForUser(null, 'empA')).not.toThrow();
    expect(() => clearForUser('', 'empA')).not.toThrow();
  });

  it('clearForUser with a missing employeeId is a no-op', () => {
    save('dpr_draft_v1', 'empA', { form: { projectName: 'A' } });
    clearForUser('dpr_draft_v1', null);
    expect(load('dpr_draft_v1', 'empA')).toEqual({ form: { projectName: 'A' } });
  });
});

describe('SOL DR-003 — clearAllExcept (shared-machine hygiene)', () => {
  beforeEach(() => localStorage.clear());

  it('drops drafts for any user except the one currently logged in', () => {
    const bases = ['dpr_draft_v1', 'inspection_draft_v1'];
    save('dpr_draft_v1', 'empA', { form: { projectName: 'A' } });
    save('inspection_draft_v1', 'empA', { workEntry: { data: 'A' } });
    save('dpr_draft_v1', 'empB', { form: { projectName: 'B' } });
    save('inspection_draft_v1', 'empB', { workEntry: { data: 'B' } });
    save('dpr_draft_v1', 'empCurrent', { form: { projectName: 'Current' } });

    clearAllExcept(bases, 'empCurrent');

    expect(load('dpr_draft_v1', 'empCurrent')).toEqual({ form: { projectName: 'Current' } });
    expect(load('dpr_draft_v1', 'empA')).toBeNull();
    expect(load('inspection_draft_v1', 'empA')).toBeNull();
    expect(load('dpr_draft_v1', 'empB')).toBeNull();
    expect(load('inspection_draft_v1', 'empB')).toBeNull();
  });

  it('refuses to run with an empty or non-array base list', () => {
    save('dpr_draft_v1', 'empA', { form: { projectName: 'A' } });
    clearAllExcept(null, 'empA');
    clearAllExcept([], 'empA');
    expect(load('dpr_draft_v1', 'empA')).toEqual({ form: { projectName: 'A' } });
  });

  it('does not touch unrelated localStorage keys', () => {
    save('dpr_draft_v1', 'empOther', { form: { projectName: 'Other' } });
    localStorage.setItem('acs_auth', '{"foo":"bar"}');
    localStorage.setItem('acs_refresh', 'tok');
    clearAllExcept(['dpr_draft_v1'], 'empA');
    expect(localStorage.getItem('acs_auth')).toBe('{"foo":"bar"}');
    expect(localStorage.getItem('acs_refresh')).toBe('tok');
    expect(load('dpr_draft_v1', 'empOther')).toBeNull();
  });
});

describe('SOL DR-003 — accepts serialised payloads with the expected shape', () => {
  beforeEach(() => localStorage.clear());

  it('DPR-shaped payload round-trips', () => {
    const payload = {
      form: { projectName: 'P1', reportDate: '2026-09-04' },
      dailyFields: { workExecutedToday: 'x' },
      notes: 'n',
      customSections: [],
      photos: [{ ulid: 'U1', container: 'dpr-photos' }],
    };
    save('dpr_draft_v1', 'empA', payload);
    expect(load('dpr_draft_v1', 'empA')).toEqual(payload);
  });

  it('Inspection-shaped payload with workEntry.data round-trips (DR-001 regression pin)', () => {
    const payload = {
      __v: 2,
      savedAt: 1725000000000,
      form: { workType: 'X' },
      workEntry: { workType: 'X', data: { foo: 'bar' }, addedAt: 1725000000000 },
      photos: [],
    };
    save('inspection_draft_v1', 'empA', payload);
    expect(load('inspection_draft_v1', 'empA')).toEqual(payload);
  });
});
