import React, { useMemo } from 'react';
import { CalendarIcon } from './Icons.jsx';
import { getCurrentIstMonth, formatMonthLabel, shiftMonth } from '../lib/format.js';

// Round-27: month-wise filter used by the two admin list pages
// (DprAll.jsx, InspectionAll.jsx). Encapsulates the IST month selection
// UX so the two pages render the same control identically.
//
// Contract:
//   - `value`        : 'YYYY-MM' string (e.g. "2026-09"), or '' for "All-time".
//                       Empty is the explicit "no month filter" opt-out.
//   - `onChange(v)`  : called with the new 'YYYY-MM' or '' when the user
//                       changes the dropdown. Parent owns the state.
//   - `id`           : optional DOM id for the <select> (so the existing
//                       patterns that wire label[htmlFor] keep working).
//   - `label`        : visible label text; defaults to "Month".
//   - `historyDepth` : how many prior months to show in the dropdown,
//                       default 24. Cap at 60 — past two years of monthly
//                       history is plenty for an admin browsing view; more
//                       would bloat the rendered <option> list.
//
// The dropdown walks backwards from the current IST month (e.g. on a date
// of 2026-09-15 IST the options are 2026-09, 2026-08, 2026-07, …) and
// prepends a sentinel "All-time" row that maps to the empty string. This
// matches the plan: month is the default, "All-time" is the opt-out.

function MonthFilter({ value, onChange, id, label = 'Month', historyDepth = 24 }) {
  // Compute the option list once. getCurrentIstMonth() reads the wall
  // clock on every render so a user keeping the tab open across a midnight
  // IST boundary next month gets the bumped month as soon as they
  // interact. Acceptable cost — Intl.DateTimeFormat is cheap.
  const options = useMemo(() => {
    const cap = Math.min(Math.max(historyDepth, 1), 60);
    const current = getCurrentIstMonth();
    const out = [{ value: '', label: 'All-time' }];
    for (let i = 0; i < cap; i += 1) {
      const ym = shiftMonth(current, -i);
      out.push({
        value: ym,
        label: i === 0 ? `${formatMonthLabel(ym)} (current)` : formatMonthLabel(ym),
      });
    }
    return out;
  }, [historyDepth]);

  // Defensive normalisation: parent might briefly hold a value that no
  // longer exists in the option list (e.g. admin picked a future month
  // before this component recomputed). Fall back to the current month so
  // the dropdown never lands on a blank.
  const safeValue = useMemo(() => {
    if (value === '' || value == null) return '';
    if (options.some((o) => o.value === value)) return value;
    return getCurrentIstMonth();
  }, [value, options]);

  return (
    <div className="form-group">
      <label htmlFor={id} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
        <CalendarIcon size={13} style={{ color: 'var(--steel)' }} />
        {label}
      </label>
      <select
        id={id}
        className="form-input"
        value={safeValue}
        onChange={(e) => onChange(e.target.value)}
        aria-label={`${label} filter`}
      >
        {options.map((o) => (
          <option key={o.value || 'all-time'} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export default MonthFilter;
