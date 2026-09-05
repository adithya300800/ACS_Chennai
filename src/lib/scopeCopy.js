// DR-016 — pure helpers for the "All records" empty-state copy and
// recovery actions.
//
// Why pure: the previous inline ternary in DprAll.jsx / InspectionAll.jsx
// silently regressed to "Nothing has been submitted across the org."
// when the admin picked a non-current month because the active-filter
// check excluded the `month` field. The audit's acceptance criterion
// is "an empty filtered month never claims the organization has no
// data; a one-click action reveals history."
//
// Pure functions are easy to unit-test in isolation; the JSX layer
// just renders the strings returned by these helpers.

const MONTH_ALL_TIME = '';
const NO_LABEL = ''; // empty-month sentinel for tests that don't care

function isCurrentMonth(month, currentMonth) {
  return !!month && month === currentMonth;
}

function isHistoricalMonth(month, currentMonth) {
  return !!month && month !== currentMonth;
}

/**
 * Pick the human-readable empty-state message based on the active
 * scope. The function returns the BODY text only (no heading); the
 * JSX layer wraps it in a <p>.
 *
 * @param {object} opts
 * @param {string} opts.entityName      "DPRs" / "inspection records" / ...
 * @param {string} opts.entityNameSingular "DPR" / "inspection record" / ...
 * @param {string} opts.month           YYYY-MM, '' for all-time, or null
 * @param {string} opts.currentMonth    YYYY-MM (the implicit default)
 * @param {boolean} opts.hasOtherFilters any non-month filter is set
 * @param {function} [opts.formatMonthLabel] (YYYY-MM) => 'Month YYYY'
 * @returns {string}
 */
export function emptyStateMessage({
  entityName,
  entityNameSingular,
  month,
  currentMonth,
  hasOtherFilters,
  formatMonthLabel = (m) => m,
}) {
  if (month && month !== '' && month !== currentMonth) {
    // Historical month — most important fix from the audit. The admin
    // is filtering to a SPECIFIC month; an empty result means "no
    // records were submitted in <Month>" — NOT "the org has no data".
    return `No ${entityName} were submitted in ${formatMonthLabel(month)}.`;
  }
  if (month === '' && hasOtherFilters) {
    return `No ${entityName} match your filters across all records.`;
  }
  if (month === '') {
    return `No ${entityName} have been submitted across the org yet.`;
  }
  if (hasOtherFilters) {
    return `No ${entityName} match your current filters.`;
  }
  // Default (current month, no other filters).
  return `No ${entityName} have been submitted this month (${formatMonthLabel(currentMonth)}) yet.`;
}

/**
 * Pick which recovery actions to show on the empty state. Each action
 * is a `{ key, label, targetMonth, clearsAllFilters }` object that the
 * JSX layer renders as a button. We ALWAYS return at least one action
 * so the admin can never be stranded on an empty view.
 *
 * @returns {Array<{ key, label, targetMonth?, clearsAllFilters? }>}
 */
export function emptyStateActions({
  month,
  currentMonth,
  hasOtherFilters,
  formatMonthLabel = (m) => m,
}) {
  const actions = [];

  const isAllTime = month === '';
  const isHistorical = !!month && month !== currentMonth;
  const isCurrent = !!month && month === currentMonth;

  if (isHistorical) {
    // The headline recovery: "View all records". Clicking switches
    // out of the empty historical month into the unbounded view.
    actions.push({ key: 'view-all', label: 'View all records', targetMonth: '' });
    if (!hasOtherFilters) {
      // No other filters in play — offer a soft reset back to the
      // default (current month).
      actions.push({
        key: 'reset-current',
        label: `Reset to ${formatMonthLabel(currentMonth)}`,
        targetMonth: currentMonth,
      });
    }
  } else if (isAllTime) {
    // All-time view empty — usually a "nothing has ever been submitted"
    // case, but offer the reset as a quick way back to the default.
    actions.push({
      key: 'reset-current',
      label: `Reset to ${formatMonthLabel(currentMonth)}`,
      targetMonth: currentMonth,
    });
  }

  if (hasOtherFilters) {
    // Non-month filters are present (status / from / to / etc). The
    // recovery is "Clear all filters" — distinct from the soft "Reset
    // to current month" which only touches the month.
    actions.push({ key: 'clear-all', label: 'Clear all filters', clearsAllFilters: true });
  }

  if (isCurrent && !hasOtherFilters) {
    // Cold load on the default current month with zero rows and no
    // other filters — the only useful recovery is to expose all-time
    // so the admin can see the historic activity.
    actions.push({ key: 'view-all', label: 'View all records', targetMonth: '' });
  }

  return actions;
}

/**
 * Build the scope-badge text appended beside the row count.
 * Returns '' for the default (current-month) view so the count line
 * stays clean in the common case.
 */
export function scopeBadge({ month, currentMonth, formatMonthLabel = (m) => m }) {
  if (!month || month === '') return 'all-time';
  if (month === currentMonth) return '';
  return `in ${formatMonthLabel(month)}`;
}

export { isCurrentMonth, isHistoricalMonth, MONTH_ALL_TIME, NO_LABEL };
