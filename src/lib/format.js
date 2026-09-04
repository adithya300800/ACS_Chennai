// C-03: shared date/time/coordinate formatters. Previously duplicated in
// Attendance.jsx + Admin.jsx (formatDate, formatTime, formatFullDate,
// getMapUrl, formatCoords). Pulled into src/lib so any
// future page that needs them imports from one place.
//
// Behavior matches the originals pixel-for-pixel — verified against the
// round-15 live deploy by feeding identical inputs to the global toLocale*.

// "Tue, 1 Sept" — used by attendance grid + admin modal headers.
export function formatDate(dateStr) {
  if (!dateStr) return '';
  const [year, month, day] = String(dateStr).split('T')[0].split('-').map(Number);
  const localDate = new Date(year, month - 1, day);
  return localDate.toLocaleDateString('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short'
  });
}

// "Tuesday, 1 September 2026" — used by the admin attendance detail modal.
export function formatFullDate(dateStr) {
  if (!dateStr) return '';
  const [year, month, day] = String(dateStr).split('T')[0].split('-').map(Number);
  const localDate = new Date(year, month - 1, day);
  return localDate.toLocaleDateString('en-IN', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  });
}

// "08:42 PM" — used by check-in/check-out rows. The two original callers
// had different fallback behavior (Attendance.jsx returned '', Admin.jsx
// returned '—') so we expose both: this one returns '' for null, and
// `formatTimeOrDash` below returns '—'. Callers should pick whichever
// matches their rendered context.
export function formatTime(dateStr) {
  if (!dateStr) return '';
  return new Date(dateStr).toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });
}

// Same as formatTime but returns '—' for null — used by Admin.jsx where
// the rendered cell would otherwise be a blank gap in a table row.
export function formatTimeOrDash(dateStr) {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });
}

// DR-032 (round-20): format a *date-only* value without the UTC-midnight
// timezone shift that bites `new Date('YYYY-MM-DD').toLocaleDateString(...)`
// in negative-offset locales (e.g. America/Los_Angeles: 2026-09-02 prints
// as 9/1/2026 because the bare ISO string is parsed as UTC 00:00, which
// is still the previous calendar day locally).
//
// Three input shapes are supported:
//   1. string matching `YYYY-MM-DD`             → split into components
//   2. string matching `YYYY-MM-DDTHH:MM:SS...` → also split the date half
//      (DBs commonly return DateTime columns as ISO with a time component
//      that happens to be midnight; we want calendar correctness either way)
//   3. Date instance whose time is 00:00:00.000 → use local calendar components
//      (matches `new Date(year, 0, 1)` and round-tripped calendar dates)
// Anything else (a real timestamp, an unparseable string) falls through to
// the regular `new Date(...).toLocaleDateString(...)` path so callers that
// previously relied on that behaviour keep working.
//
// Returns '' for null/undefined and '' for unparseable strings — matches the
// `formatDate`/`formatTime` convention used throughout the codebase.
export function formatDateOnly(value, options) {
  if (value == null || value === '') return '';

  // Strings: extract the calendar-date prefix.
  if (typeof value === 'string') {
    const dateOnlyMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
    if (dateOnlyMatch) {
      const year = Number(dateOnlyMatch[1]);
      const month = Number(dateOnlyMatch[2]);
      const day = Number(dateOnlyMatch[3]);
      return new Date(year, month - 1, day).toLocaleDateString('en-IN', options);
    }
    // Unparseable — keep the same defensive behaviour as formatTime: return ''.
    return '';
  }

  // Date instances with a midnight time component → treat as calendar date.
  if (value instanceof Date) {
    if (
      value.getHours() === 0 &&
      value.getMinutes() === 0 &&
      value.getSeconds() === 0 &&
      value.getMilliseconds() === 0
    ) {
      return new Date(
        value.getFullYear(),
        value.getMonth(),
        value.getDate()
      ).toLocaleDateString('en-IN', options);
    }
    // Real timestamp — fall back to the original toLocaleDateString call
    // so callers passing an explicit timestamp still get timezone-correct
    // rendering (unchanged behaviour for IST/PST/UTC browsers).
    return value.toLocaleDateString('en-IN', options);
  }

  return '';
}

// OpenStreetMap embed iframe src. Returns null when coords are missing or
// (0,0) (the sentinel for "permission was denied; we couldn't get a fix").
export function getMapUrl(lat, lng) {
  if (!lat || !lng || lat === 0 || lng === 0) return null;
  return `https://www.openstreetmap.org/export/embed.html?bbox=${lng - 0.005},${lat - 0.005},${lng + 0.005},${lat + 0.005}&layer=mapnik&marker=${lat},${lng}`;
}

// "47.7220°N, 122.1869°W" — used by the post-check-in card under the map.
export function formatCoords(lat, lng) {
  if (!lat || !lng || lat === 0 || lng === 0) return '';
  const latDir = lat >= 0 ? 'N' : 'S';
  const lngDir = lng >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(4)}°${latDir}, ${Math.abs(lng).toFixed(4)}°${lngDir}`;
}

// Round-27: mirror of backend/src/lib/dateOnly.js:getBusinessToday() for
// the client. Returns the current calendar month in IST as `YYYY-MM`.
// The two helpers are intentionally separate so the client never has
// to talk to the server to know which month to default the list filters
// to — and so the backend stays the only source of truth for any date
// math that ends up in the database.
//
// We deliberately use `Intl.DateTimeFormat` rather than relying on the
// browser's `Date` timezone because some users (and many QA rigs) run in
// non-IST locales — without an explicit timezone, `new Date().getMonth()`
// can return a value that disagrees with the company's calendar day.
export function getCurrentIstMonth(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now);
  const year = parts.find((p) => p.type === 'year').value;
  const month = parts.find((p) => p.type === 'month').value;
  return `${year}-${month}`;
}

// Round-27: human-friendly label for a `YYYY-MM` month string.
// "2026-09" → "September 2026", "2026-01" → "January 2026".
export function formatMonthLabel(yearMonth) {
  if (!yearMonth || !/^\d{4}-\d{2}$/.test(String(yearMonth))) return '';
  const [y, m] = yearMonth.split('-').map(Number);
  if (!y || !m || m < 1 || m > 12) return '';
  // Anchor on the 15th so any locale's TZ never accidentally flips to
  // the previous or next month via a midnight edge (mid-month is safe).
  const local = new Date(y, m - 1, 15);
  return local.toLocaleDateString('en-GB', {
    month: 'long',
    year: 'numeric',
  });
}

// Round-27: shift a YYYY-MM string by ±N months. Pure calendar math; no
// timezone interpolation needed because we always re-anchor on day 15 of
// the resulting calendar month.
export function shiftMonth(yearMonth, delta) {
  if (!yearMonth || !/^\d{4}-\d{2}$/.test(String(yearMonth))) return yearMonth;
  const [y, m] = yearMonth.split('-').map(Number);
  if (!y || !m || m < 1 || m > 12) return yearMonth;
  const d = new Date(y, m - 1 + delta, 15);
  const newY = d.getFullYear();
  const newM = String(d.getMonth() + 1).padStart(2, '0');
  return `${newY}-${newM}`;
}
