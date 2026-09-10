// kpiBuckets — pure aggregation helpers for the Project Dashboard's
// 6 client-side charts. No API calls, no state, no side effects;
// every function is unit-testable with fixture data.
//
// Scope (per the R-38 / Project Dashboard chart plan):
//   1. bucketByDay(rows, days)        → DPR trend area chart
//   2. byLineItemTopN(rows, n)        → BOQ top-10 grouped bar
//   3. byEmployeeWeek(rows, days)     → People workload heatmap
//   4. pendingReviewSparkline(rows)   → Pending Review tile sparkline
//
// Why client-side instead of a backend aggregation endpoint?
//   The KPI endpoint already returns totals. A trend chart needs
//   per-bucket counts which would be a second server round-trip —
//   the dashboard already has the rows in memory (loaded for the
//   inline drill panel) so a pure client-side pass over the same
//   list keeps the wiring simpler and avoids cache invalidation
//   between the KPI totals and the chart shape.
//
// Conventions:
//   - All date strings are treated as YYYY-MM-DD (UTC). Functions that
//     need a Date parse via `new Date(`${date}T00:00:00.000Z`)` so a
//     project in IST doesn't drift the day boundary.
//   - The return shape is `{ rows: [{ ... }] }` so the chart
//     components can destructure once without per-function guards.
//   - Empty / missing inputs return `{ rows: [] }` — never throw. A
//     freshly-registered project (no DPRs yet) is a happy path here.

/**
 * Parse a YYYY-MM-DD date string into a UTC-midnight Date. Returns
 * `null` on unparseable input so callers can `filter(Boolean)` rather
 * than catch. The dashboard never logs here so a single bad row can't
 * poison the whole chart.
 */
function parseDay(day) {
  if (!day || typeof day !== 'string') return null;
  const d = new Date(`${day}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Format a Date as YYYY-MM-DD (UTC). Round-trip helper for the
 * bucketing keys — the same value a DPR row's `reportDate` carries.
 */
function toDayKey(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * Build the contiguous list of YYYY-MM-DD day keys for the last
 * `days` days, ending at `endDay` (defaults to today UTC). The
 * bucketByDay function uses this so a chart always shows a full
 * window — gaps in data render as 0-count rows, not missing
 * X-axis ticks.
 */
function dayKeysForWindow(days, endDay) {
  const end = endDay ? parseDay(endDay) || new Date(`${endDay}T00:00:00.000Z`) : new Date();
  const out = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - i);
    out.push(toDayKey(d));
  }
  return out;
}

/**
 * bucketByDay — bucket a list of records by their day column. Used
 * for the DPR trend chart and (with a different date column) the
 * Pending Review sparkline.
 *
 * @param {Array<object>} rows
 *   Records. Each record must have a YYYY-MM-DD `dateField`.
 * @param {number} days
 *   Window size. Buckets are produced for the contiguous window of
 *   the last `days` days; older rows are silently dropped.
 * @param {string} dateField
 *   Column on each row that carries the day. Default `reportDate`.
 * @param {string} [endDay]
 *   Window end anchor (YYYY-MM-DD, UTC). Defaults to today UTC.
 *   Pass a fixed date in tests to make the output deterministic.
 * @returns {{ rows: Array<{ day: string, count: number }> }}
 *   One row per day in the window, oldest first. `count` is the
 *   number of input rows whose `dateField` matched.
 */
export function bucketByDay(rows, days, dateField = 'reportDate', endDay) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const safeDays = Math.max(1, Number(days) || 30);
  const keys = dayKeysForWindow(safeDays, endDay);
  const counts = Object.create(null);
  keys.forEach((k) => { counts[k] = 0; });

  safeRows.forEach((row) => {
    const v = row && row[dateField];
    if (typeof v !== 'string') return;
    // Accept YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS(.SSS)Z. Slice to 10.
    const day = v.slice(0, 10);
    if (day in counts) counts[day] += 1;
    // Rows outside the window are dropped silently — they belong
    // to a different chart.
  });

  return {
    rows: keys.map((day) => ({ day, count: counts[day] || 0 })),
  };
}

/**
 * byLineItemTopN — rank BOQ line items by absolute variance (so the
 * biggest swings surface first, regardless of over/under). The
 * dashboard shows both the contract value and the variance sign so
 * a single chart can answer "what's the most over-executed line?"
 * at a glance.
 *
 * @param {Array<object>} rows
 *   BOQ line items. Each row must carry an `id` (for the drill link),
 *   a label column (`itemDescription` or fallback `description`),
 *   a numeric `variancePercent` or `{contractValue, executedValue}`
 *   pair.
 * @param {number} n
 *   Top-N to return. Default 10.
 * @returns {{ rows: Array<{ id, label, contractValue, executedValue, variancePercent, absVariance }> }}
 *   Sorted by `absVariance` descending. If a row has no numeric
 *   variance it falls to the bottom (treated as 0).
 */
export function byLineItemTopN(rows, n = 10) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const cap = Math.max(1, Number(n) || 10);

  const enriched = safeRows
    .map((r) => {
      const contractValue = Number(r && r.contractValue) || 0;
      const executedValue = Number(r && r.executedValue) || 0;
      // Prefer the server's variancePercent when present; otherwise
      // derive from the value pair so a backend that hasn't run the
      // variance rollup still renders something useful.
      const reportedVariance = Number(r && r.variancePercent);
      const variancePercent = Number.isFinite(reportedVariance)
        ? reportedVariance
        : (contractValue > 0 ? ((executedValue - contractValue) / contractValue) * 100 : 0);
      const label =
        (r && (r.itemDescription || r.description)) ||
        (r && r.id ? `Item ${String(r.id).slice(0, 8)}` : 'Untitled item');
      return {
        id: r && r.id,
        label,
        contractValue,
        executedValue,
        variancePercent,
        absVariance: Math.abs(Number(variancePercent) || 0),
      };
    })
    .sort((a, b) => b.absVariance - a.absVariance);

  return { rows: enriched.slice(0, cap) };
}

/**
 * byEmployeeWeek — bucket activity (DPR submissions + inspections) by
 * employee × day, then group days into 7-day weeks so the heatmap is
 * small enough to read at-a-glance. The heatmap is rendered as a
 * plain CSS grid (no library) — `byEmployeeWeek` is the data
 * half only.
 *
 * @param {Array<object>} rows
 *   Activity rows (DPR + Inspection in the same shape). Each row
 *   must carry a `dateField` value, an employee identifier, and an
 *   employee display name. We default to `submittedById` /
 *   `submittedByName` for DPRs; the caller can swap to
 *   `inspectedById` / `inspectedByName` for the inspection half.
 * @param {number} days
 *   Window size. Must be a multiple of 7 (we round down). Default 28.
 * @returns {{ rows: Array<{ employeeId, employeeName, weeks: Array<number>, total }>,
 *            weekLabels: Array<string> }}
 *   `weeks[i]` is the count for the i-th 7-day bucket. `weekLabels`
 *   are the inclusive first-day of each 7-day window, in
 *   YYYY-MM-DD. The renderer can decide whether to show the labels
 *   as a header row.
 */
export function byEmployeeWeek(rows, days = 28, endDay) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const safeDays = Math.max(7, Number(days) || 28);
  const weekCount = Math.max(1, Math.floor(safeDays / 7));
  const windowDays = weekCount * 7;

  // Build the contiguous day-key list, then fold it into N weeks.
  // `endDay` lets the caller (and tests) pin the window to a fixed
  // date so output is deterministic regardless of when the function
  // runs. Defaults to today UTC.
  const endDayDate = endDay ? new Date(`${endDay}T00:00:00.000Z`) : new Date();
  const allKeys = dayKeysForWindow(windowDays, toDayKey(endDayDate));
  const weekKeys = [];
  for (let w = 0; w < weekCount; w += 1) {
    weekKeys.push(allKeys.slice(w * 7, (w + 1) * 7));
  }
  const weekLabels = weekKeys.map((wk) => wk[0]); // inclusive first day of the week

  // Per-employee bucket. We key by `employeeId` (when present) so two
  // rows for the same person merge. Rows missing the id are dropped.
  const buckets = new Map();

  safeRows.forEach((row) => {
    if (!row) return;
    const empId = row.submittedById || row.employeeId || row.inspectedById;
    if (!empId) return;
    const empName = row.submittedByName || row.employeeName || row.inspectedByName || String(empId);
    const dateVal = row.reportDate || row.date;
    if (typeof dateVal !== 'string') return;
    const day = dateVal.slice(0, 10);
    // Find which week this day belongs to.
    const weekIdx = weekKeys.findIndex((wk) => wk.includes(day));
    if (weekIdx < 0) return;

    let bucket = buckets.get(empId);
    if (!bucket) {
      bucket = {
        employeeId: empId,
        employeeName: empName,
        weeks: new Array(weekCount).fill(0),
        total: 0,
      };
      buckets.set(empId, bucket);
    }
    bucket.weeks[weekIdx] += 1;
    bucket.total += 1;
  });

  // Top employees by total activity, capped at 8 (heatmap legibility).
  const rows_out = Array.from(buckets.values())
    .sort((a, b) => b.total - a.total)
    .slice(0, 8);

  return { rows: rows_out, weekLabels };
}

/**
 * pendingReviewSparkline — a small slice of bucketByDay over the
 * last 14 days, restricted to SUBMITTED + UNDER_REVIEW rows. Used
 * inside the Pending Review stat tile.
 *
 * @param {Array<object>} rows
 *   DPR rows. Filtered to SUBMITTED + UNDER_REVIEW by the caller;
 *   we keep the function pure.
 * @returns {{ rows: Array<{ day: string, count: number }> }}
 *   Always exactly 14 entries (oldest first) so the sparkline
 *   renders at a fixed width.
 */
export function pendingReviewSparkline(rows) {
  return bucketByDay(rows, 14, 'reportDate');
}

export default {
  bucketByDay,
  byLineItemTopN,
  byEmployeeWeek,
  pendingReviewSparkline,
  // Internal helpers exported for unit tests only — not re-exported
  // from the page.
  _internal: { parseDay, toDayKey, dayKeysForWindow },
};
