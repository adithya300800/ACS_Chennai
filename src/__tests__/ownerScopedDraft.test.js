// SOL DR-003 regression coverage. The original `dpr_draft_v1` and
// `inspection_draft_v1` keys were unscoped — a Shared computer's
// localStorage kept the previous account's draft and the next person to
// log in saw it pre-loaded. These tests pin the new owner-scoped contract.
//
// Acceptance criteria from SOL DR-003:
//   - A -> logout -> B cannot see A's draft.
//   - Expired A -> reauthenticate A can recover it safely.
//   - One-time legacy migration so an existing unscoped draft is NOT lost
//     for the user it belongs to, AND NOT inherited by a different user.

const {
  load,
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

describe('SOL DR-003 — legacy unscoped migration (idempotent)', () => {
  beforeEach(() => localStorage.clear());

  it('migrates a legacy unscoped draft to the first user that reads it', () => {
    localStorage.setItem('dpr_draft_v1', JSON.stringify({ form: { projectName: 'Legacy A' } }));
    expect(load('dpr_draft_v1', 'empA')).toEqual({ form: { projectName: 'Legacy A' } });
    // After migration the unscoped key is gone and the scoped key holds it.
    expect(localStorage.getItem('dpr_draft_v1')).toBeNull();
    expect(localStorage.getItem('dpr_draft_v1:empA')).toBe(
      JSON.stringify({ form: { projectName: 'Legacy A' } }),
    );
    // Migration marker is stamped with the employeeId (NOT `true`) so the
    // next user cannot silently inherit anything.
    const marker = JSON.parse(localStorage.getItem(MIGRATION_MARKER_KEY));
    expect(marker).toEqual({ 'dpr_draft_v1': 'empA' });
  });

  it('returns the legacy draft on subsequent reads for the same user', () => {
    localStorage.setItem('dpr_draft_v1', JSON.stringify({ form: { projectName: 'Legacy A' } }));
    load('dpr_draft_v1', 'empA'); // migrates
    expect(load('dpr_draft_v1', 'empA')).toEqual({ form: { projectName: 'Legacy A' } });
  });

  it('does NOT migrate the same legacy draft to a second user', () => {
    localStorage.setItem('dpr_draft_v1', JSON.stringify({ form: { projectName: 'Legacy A' } }));
    // empA arrives first → grabs the draft.
    expect(load('dpr_draft_v1', 'empA')).toEqual({ form: { projectName: 'Legacy A' } });
    // empB arrives later → nothing for them.
    expect(load('dpr_draft_v1', 'empB')).toBeNull();
  });

  it('different keys migrate independently per user', () => {
    localStorage.setItem('dpr_draft_v1', JSON.stringify({ form: { projectName: 'Legacy DPR' } }));
    localStorage.setItem('inspection_draft_v1', JSON.stringify({ workEntry: { data: 'x' } }));
    load('dpr_draft_v1', 'empA');
    load('inspection_draft_v1', 'empA');
    expect(load('dpr_draft_v1', 'empA')).toEqual({ form: { projectName: 'Legacy DPR' } });
    expect(load('inspection_draft_v1', 'empA')).toEqual({ workEntry: { data: 'x' } });
    const marker = JSON.parse(localStorage.getItem(MIGRATION_MARKER_KEY));
    expect(marker).toEqual({ 'dpr_draft_v1': 'empA', 'inspection_draft_v1': 'empA' });
  });

  it('migration is idempotent for the same user — no double-copy', () => {
    localStorage.setItem('dpr_draft_v1', JSON.stringify({ form: { projectName: 'Legacy A' } }));
    load('dpr_draft_v1', 'empA');
    load('dpr_draft_v1', 'empA');
    // Only ONE scoped key, not three.
    expect(localStorage.getItem('dpr_draft_v1:empA')).toBe(
      JSON.stringify({ form: { projectName: 'Legacy A' } }),
    );
  });

  it('expired A returning to their own machine recovers their draft (acceptance criterion)', () => {
    save('dpr_draft_v1', 'empA', { form: { projectName: 'Site A' } });
    // Session expires — server kicks the user out. localStorage persists.
    // A re-authenticates and lands back on /portal/dpr/submit.
    expect(load('dpr_draft_v1', 'empA')).toEqual({ form: { projectName: 'Site A' } });
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
