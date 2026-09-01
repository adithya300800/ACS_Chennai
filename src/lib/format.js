// C-03: shared date/time/coordinate formatters. Previously duplicated in
// Attendance.jsx + Admin.jsx (formatDate, formatTime, formatFullDate,
// getMapUrl, formatCoords, toDateString). Pulled into src/lib so any
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

// Convert any Date to a YYYY-MM-DD local string. The calendar grid uses this
// to bucket "today" by local date, not UTC (round-14 bugfix: an Indian user
// checking in at 1:30am IST was previously counted as the prior day).
export function toDateString(date) {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
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
