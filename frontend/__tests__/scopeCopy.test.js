/**
 * DR-016 — "All records" empty-state copy and recovery actions.
 *
 * Background: the audit live-reproduced an empty filtered month
 * displaying "Nothing has been submitted across the org." because the
 * active-filter check in DprAll.jsx (and InspectionAll.jsx) excluded
 * the `month` field. The acceptance criterion is:
 *
 *   "an empty filtered month never claims the organization has no
 *    data; a one-click action reveals history; browser refresh/back/
 *    share retains the intended filter."
 *
 * This file pins the three pure helpers in src/lib/scopeCopy.js:
 *
 *   1. emptyStateMessage — the body copy for each scope branch
 *      (historical month / all-time + filters / all-time bare /
 *      current month + filters / current month default).
 *
 *   2. emptyStateActions — the recovery buttons to render. MUST
 *      always return at least one action so the admin can never be
 *      stranded on an empty view.
 *
 *   3. scopeBadge — the suffix next to "Showing N DPRs" so the admin
 *      can always tell which scope produced the result.
 *
 * (The URL-persistence half of DR-016 lives in DprAll.jsx; this file
 * pins the copy/recovery contract that the audit acceptance criterion
 * actually calls out.)
 */

const {
  emptyStateMessage,
  emptyStateActions,
  scopeBadge,
  isCurrentMonth,
  isHistoricalMonth,
} = require('../../src/lib/scopeCopy.js');

const ENTITY = { entityName: 'DPRs', entityNameSingular: 'DPR' };
const formatMonthLabel = (ym) => {
  // Tiny stub so we can assert on a stable label string instead of
  // the locale-dependent toLocaleDateString output.
  if (!ym || !/^\d{4}-\d{2}$/.test(ym)) return String(ym);
  const [y, m] = ym.split('-').map(Number);
  const names = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${names[m - 1]} ${y}`;
};

describe('DR-016 — emptyStateMessage()', () => {
  test('A1. historical month (the audit\'s main bug) names the month, not the org', () => {
    // The audit: "Selecting January 2026 displayed 'Nothing has been
    // submitted across the org.'" — the new copy names the SPECIFIC
    // month so the admin immediately knows the scope.
    const msg = emptyStateMessage({
      ...ENTITY,
      month: '2026-01',
      currentMonth: '2026-09',
      hasOtherFilters: false,
      formatMonthLabel,
    });
    expect(msg).toBe('No DPRs were submitted in Jan 2026.');
    expect(msg).not.toMatch(/org/);
    expect(msg).not.toMatch(/across/);
  });

  test('A2. all-time + other filters → "match your filters across all records"', () => {
    const msg = emptyStateMessage({
      ...ENTITY,
      month: '',
      currentMonth: '2026-09',
      hasOtherFilters: true,
      formatMonthLabel,
    });
    expect(msg).toBe('No DPRs match your filters across all records.');
  });

  test('A3. all-time bare → "no records ever across the org yet"', () => {
    const msg = emptyStateMessage({
      ...ENTITY,
      month: '',
      currentMonth: '2026-09',
      hasOtherFilters: false,
      formatMonthLabel,
    });
    expect(msg).toBe('No DPRs have been submitted across the org yet.');
  });

  test('A4. current month + other filters → "match your current filters"', () => {
    const msg = emptyStateMessage({
      ...ENTITY,
      month: '2026-09',
      currentMonth: '2026-09',
      hasOtherFilters: true,
      formatMonthLabel,
    });
    expect(msg).toBe('No DPRs match your current filters.');
  });

  test('A5. current month default (cold load) → names the current month', () => {
    const msg = emptyStateMessage({
      ...ENTITY,
      month: '2026-09',
      currentMonth: '2026-09',
      hasOtherFilters: false,
      formatMonthLabel,
    });
    expect(msg).toBe('No DPRs have been submitted this month (Sep 2026) yet.');
  });

  test('A6. unknown entity name is templated in', () => {
    const msg = emptyStateMessage({
      entityName: 'inspection records',
      entityNameSingular: 'inspection record',
      month: '2026-01',
      currentMonth: '2026-09',
      hasOtherFilters: false,
      formatMonthLabel,
    });
    expect(msg).toBe('No inspection records were submitted in Jan 2026.');
  });
});

describe('DR-016 — emptyStateActions()', () => {
  test('B1. ALWAYS returns at least one recovery action (no-stranded-admin rule)', () => {
    // All five scope branches must produce ≥1 action. The audit's
    // acceptance: "a one-click action reveals history."
    const cases = [
      { month: '2026-01', currentMonth: '2026-09', hasOtherFilters: false },
      { month: '', currentMonth: '2026-09', hasOtherFilters: true },
      { month: '', currentMonth: '2026-09', hasOtherFilters: false },
      { month: '2026-09', currentMonth: '2026-09', hasOtherFilters: true },
      { month: '2026-09', currentMonth: '2026-09', hasOtherFilters: false },
    ];
    for (const c of cases) {
      const actions = emptyStateActions({ ...c, formatMonthLabel });
      expect(actions.length).toBeGreaterThanOrEqual(1);
      // Every action must have a non-empty label.
      for (const a of actions) {
        expect(typeof a.label).toBe('string');
        expect(a.label.length).toBeGreaterThan(0);
      }
    }
  });

  test('B2. historical month: "View all records" + (optional) "Reset to <current>"', () => {
    const actions = emptyStateActions({
      month: '2026-01',
      currentMonth: '2026-09',
      hasOtherFilters: false,
      formatMonthLabel,
    });
    const viewAll = actions.find((a) => a.key === 'view-all');
    const reset = actions.find((a) => a.key === 'reset-current');
    expect(viewAll).toBeDefined();
    expect(viewAll.label).toBe('View all records');
    expect(viewAll.targetMonth).toBe('');
    expect(reset).toBeDefined();
    expect(reset.label).toBe('Reset to Sep 2026');
    expect(reset.targetMonth).toBe('2026-09');
  });

  test('B3. historical month + other filters: "View all records" + "Clear all filters"', () => {
    const actions = emptyStateActions({
      month: '2026-01',
      currentMonth: '2026-09',
      hasOtherFilters: true,
      formatMonthLabel,
    });
    expect(actions.find((a) => a.key === 'view-all')).toBeDefined();
    const clearAll = actions.find((a) => a.key === 'clear-all');
    expect(clearAll).toBeDefined();
    expect(clearAll.clearsAllFilters).toBe(true);
    expect(clearAll.label).toBe('Clear all filters');
    // "Reset to current month" is suppressed when other filters are
    // active — the audit distinguishes the two clearly.
    expect(actions.find((a) => a.key === 'reset-current')).toBeUndefined();
  });

  test('B4. all-time + other filters: "Clear all filters" + "Reset to current month"', () => {
    const actions = emptyStateActions({
      month: '',
      currentMonth: '2026-09',
      hasOtherFilters: true,
      formatMonthLabel,
    });
    expect(actions.find((a) => a.key === 'clear-all')).toBeDefined();
    expect(actions.find((a) => a.key === 'reset-current')).toBeDefined();
  });

  test('B5. all-time bare: only "Reset to current month"', () => {
    // Nothing was filtered; the only sensible action is to go back to
    // the bounded default. A "Clear all filters" button would be
    // misleading — there is nothing to clear.
    const actions = emptyStateActions({
      month: '',
      currentMonth: '2026-09',
      hasOtherFilters: false,
      formatMonthLabel,
    });
    expect(actions).toHaveLength(1);
    expect(actions[0].key).toBe('reset-current');
    expect(actions.find((a) => a.key === 'clear-all')).toBeUndefined();
  });

  test('B6. current month + other filters: "Clear all filters" only (no view-all needed)', () => {
    // The current month is already the most permissive view among
    // bounded months; offering "View all records" on top of a
    // filter-only empty result would be redundant — clearing the
    // filters will reveal any data in the current month.
    const actions = emptyStateActions({
      month: '2026-09',
      currentMonth: '2026-09',
      hasOtherFilters: true,
      formatMonthLabel,
    });
    expect(actions).toHaveLength(1);
    expect(actions[0].key).toBe('clear-all');
    expect(actions.find((a) => a.key === 'view-all')).toBeUndefined();
  });

  test('B7. current month default (cold load) + no filters: only "View all records"', () => {
    // The audit: "Refresh reset both to September, showing 14 DPRs /
    // 2 inspections" — the bare default view is the most likely
    // starting state. The only useful recovery when the default view
    // is empty is to expose history.
    const actions = emptyStateActions({
      month: '2026-09',
      currentMonth: '2026-09',
      hasOtherFilters: false,
      formatMonthLabel,
    });
    expect(actions).toHaveLength(1);
    expect(actions[0].key).toBe('view-all');
    expect(actions[0].targetMonth).toBe('');
  });
});

describe('DR-016 — scopeBadge()', () => {
  test('C1. current month → empty string (keeps the count line clean in the common case)', () => {
    expect(scopeBadge({ month: '2026-09', currentMonth: '2026-09', formatMonthLabel })).toBe('');
  });

  test('C2. historical month → "in <Month Label>"', () => {
    expect(scopeBadge({ month: '2026-01', currentMonth: '2026-09', formatMonthLabel }))
      .toBe('in Jan 2026');
  });

  test('C3. all-time (empty string month) → "all-time"', () => {
    expect(scopeBadge({ month: '', currentMonth: '2026-09', formatMonthLabel }))
      .toBe('all-time');
  });

  test('C4. null month (defensive) → "all-time"', () => {
    expect(scopeBadge({ month: null, currentMonth: '2026-09', formatMonthLabel }))
      .toBe('all-time');
  });
});

describe('DR-016 — isCurrentMonth / isHistoricalMonth helpers', () => {
  test('isCurrentMonth distinguishes current from historical', () => {
    expect(isCurrentMonth('2026-09', '2026-09')).toBe(true);
    expect(isCurrentMonth('2026-01', '2026-09')).toBe(false);
    expect(isCurrentMonth('', '2026-09')).toBe(false);
    expect(isCurrentMonth(null, '2026-09')).toBe(false);
  });

  test('isHistoricalMonth distinguishes historical from current/all-time', () => {
    expect(isHistoricalMonth('2026-01', '2026-09')).toBe(true);
    expect(isHistoricalMonth('2026-09', '2026-09')).toBe(false);
    expect(isHistoricalMonth('', '2026-09')).toBe(false);
    expect(isHistoricalMonth(null, '2026-09')).toBe(false);
  });
});
