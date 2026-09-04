import React from 'react';
import { getCurrentIstMonth, formatMonthLabel, shiftMonth } from '../lib/format.js';

// Round-27.5: a small, always-visible month stepper that sits in the
// page header on the two admin browse views (DprAll, InspectionAll).
// The Filters button still holds the MonthFilter dropdown (for power
// users who want to jump multiple months at once or pick "All-time"),
// but admins who only ever want to scroll back one month at a time
// no longer need to open the panel.
//
// Contract:
//   - `value`    : 'YYYY-MM' string (e.g. "2026-09"), or '' for "All-time".
//                  '' is the explicit opt-out from the month default.
//   - `onChange` : called with the new 'YYYY-MM' or ''. Parent owns the
//                  state — we just hand back the next calendar month.
//
// Behavior:
//   - Prev arrow always enabled; walks the value back by one calendar
//     month.
//   - Next arrow enabled iff the current value is a PRIOR month (i.e.
//     not the current IST month and not ''). Disabled state means an
//     admin can't accidentally scroll into the future.
//   - When `value` is '' (All-time), we render the stepper as
//     "All-time" with both arrows disabled. The parent owns the
//     transition back to a real month (via the MonthFilter dropdown).
//   - The component intentionally does not run the month-vs-range
//     guard (that's `handleFilterChange`'s job on the parent). The
//     parent passes whatever onChange emits through its own guard.

export default function MonthStepper({ value, onChange }) {
  const currentMonth = getCurrentIstMonth();
  const isAllTime = !value;
  // For visual purposes we still need a calendar anchor even when the
  // page is in "All-time" mode. We use the current month so the prev
  // arrow (which is disabled in this state anyway) would have something
  // concrete to show in dev tools / a11y tree. No wire call is made
  // until the user actually clicks a button.
  const displayMonth = isAllTime ? currentMonth : value;
  const isCurrentMonth = displayMonth === currentMonth;
  const canGoBack = !isAllTime;
  const canGoForward = !isAllTime && !isCurrentMonth;

  const label = isAllTime ? 'All-time' : formatMonthLabel(displayMonth);

  return (
    <div
      role="group"
      aria-label="Month navigation"
      className="month-stepper"
      style={{
        display: 'inline-flex',
        alignItems: 'stretch',
        border: '1px solid var(--steel)',
        borderRadius: 8,
        background: '#fff',
        overflow: 'hidden',
        height: 32,
      }}
    >
      <button
        type="button"
        onClick={() => onChange(shiftMonth(displayMonth, -1))}
        aria-label="Previous month"
        title="Previous month"
        disabled={!canGoBack}
        style={{
          padding: '0 0.6rem',
          border: 'none',
          borderRight: '1px solid var(--steel)',
          background: 'transparent',
          cursor: canGoBack ? 'pointer' : 'not-allowed',
          opacity: canGoBack ? 1 : 0.4,
          fontSize: '1rem',
          lineHeight: 1,
          color: 'var(--navy)',
        }}
      >
        ‹
      </button>
      <span
        aria-live="polite"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          padding: '0 0.85rem',
          minWidth: 130,
          justifyContent: 'center',
          fontWeight: 600,
          color: 'var(--navy)',
          fontFamily: "'Plus Jakarta Sans', sans-serif",
          fontSize: '0.9rem',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </span>
      <button
        type="button"
        onClick={() => onChange(shiftMonth(displayMonth, +1))}
        aria-label="Next month"
        title="Next month"
        disabled={!canGoForward}
        style={{
          padding: '0 0.6rem',
          border: 'none',
          borderLeft: '1px solid var(--steel)',
          background: 'transparent',
          cursor: canGoForward ? 'pointer' : 'not-allowed',
          opacity: canGoForward ? 1 : 0.4,
          fontSize: '1rem',
          lineHeight: 1,
          color: 'var(--navy)',
        }}
      >
        ›
      </button>
    </div>
  );
}
