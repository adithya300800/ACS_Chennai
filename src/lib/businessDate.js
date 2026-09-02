// DR-026 (round-20): training overdue badges were comparing due-date strings
// against `new Date().toISOString().split('T')[0]`, which is the *UTC* day.
// Between 00:00 and 05:29 IST (UTC+5:30) `toISOString()` is still yesterday,
// so any "due today" badge was silently wrong. This module gives the front
// end one place to ask "what is today's business date" in the company TZ
// (Asia/Kolkata), and a React hook that re-renders the consuming component
// on midnight rollover / tab focus so memoized counts stay correct.

import { useEffect, useState } from 'react';

// Default company timezone. ACS Chennai operates in India; the site doesn't
// observe DST, so a fixed offset of +05:30 is correct all year.
const DEFAULT_TIMEZONE = 'Asia/Kolkata';

// Build an Intl formatter that prints YYYY-MM-DD in the target timezone.
// We use 'en-CA' because its date format is ISO-like (YYYY-MM-DD); using
// a custom formatToParts + manual padding is more code and more fragile.
let cachedFormatter = null;
let cachedFormatterTimezone = null;
function getFormatter(timezone) {
  if (cachedFormatter && cachedFormatterTimezone === timezone) return cachedFormatter;
  cachedFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  cachedFormatterTimezone = timezone;
  return cachedFormatter;
}

// `getBusinessToday(now, timezone)` → 'YYYY-MM-DD' for the ACS company day.
// Defaults: now = current wall-clock, timezone = Asia/Kolkata.
// Examples:
//   getBusinessToday(new Date('2026-09-02T18:30:00.000Z'), 'Asia/Kolkata')
//     === '2026-09-03'   (00:00 IST → next calendar day)
//   getBusinessToday(new Date('2026-09-02T18:29:00.000Z'), 'Asia/Kolkata')
//     === '2026-09-02'   (23:59 IST → same calendar day)
export function getBusinessToday(now = new Date(), timezone = DEFAULT_TIMEZONE) {
  return getFormatter(timezone).format(now);
}

// `isOverdue(dueDateStr, optsOrNow)` → true if the due date is strictly
// before today in the business timezone. Accepts either a Date object
// (the simple call form) or `{ now, timezone }` (the explicit form used
// by tests so they can pin both clock + tz).
//
// A due date equal to today is NOT overdue (still has the whole business
// day). A due date in the future is NOT overdue. A missing/empty
// dueDateStr is also not overdue (the caller decides what to render).
export function isOverdue(dueDateStr, optsOrNow) {
  if (!dueDateStr) return false;
  let now = new Date();
  let timezone = DEFAULT_TIMEZONE;
  if (optsOrNow instanceof Date) {
    now = optsOrNow;
  } else if (optsOrNow && typeof optsOrNow === 'object') {
    if (optsOrNow.now instanceof Date) now = optsOrNow.now;
    if (typeof optsOrNow.timezone === 'string') timezone = optsOrNow.timezone;
  }
  // Normalise the due date to a YYYY-MM-DD prefix — DB stores come back as
  // either 'YYYY-MM-DD' or full ISO timestamps.
  const due = String(dueDateStr).split('T')[0];
  const today = getBusinessToday(now, timezone);
  return due < today;
}

// React hook: returns the current `YYYY-MM-DD` business date key and
// forces a re-render whenever the key changes. Two refresh triggers:
//   (a) setInterval(60s) — guarantees a midnight rollover eventually
//   (b) visibilitychange — fixes the "I left the tab open overnight"
//       case on a single tick, regardless of when the user comes back
//
// The hook does NOT change `key` if it hasn't actually rolled over
// (the interval just compares and returns the existing reference), so
// downstream memoizations don't invalidate needlessly.
//
// Caller MUST include `businessDateKey` in useMemo dependency arrays
// for any derived counts/filters that depend on "today".
export function useBusinessDateKey() {
  const [key, setKey] = useState(() => getBusinessToday());

  useEffect(() => {
    const refresh = () => {
      const next = getBusinessToday();
      setKey((prev) => (prev === next ? prev : next));
    };
    const intervalId = setInterval(refresh, 60_000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearInterval(intervalId);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);

  return key;
}
