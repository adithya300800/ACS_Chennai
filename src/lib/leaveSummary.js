// There is no leave entitlement data in the portal, so only summarize
// approved and pending requests; never imply a remaining balance.
export function inclusiveDayCount(startStr, endStr) {
  if (!startStr || !endStr) return 0;
  const [sy, sm, sd] = String(startStr).split('-').map(Number);
  const [ey, em, ed] = String(endStr).split('-').map(Number);
  const start = new Date(sy, sm - 1, sd).getTime();
  const end = new Date(ey, em - 1, ed).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return 0;
  return Math.round((end - start) / 86_400_000) + 1;
}

export function summariseLeave(requests, today) {
  const rows = Array.isArray(requests) ? requests : [];
  const year = String(today || '').slice(0, 4) || String(new Date().getFullYear());
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;
  let daysTaken = 0;
  let pendingCount = 0;

  for (const request of rows) {
    if (!request) continue;
    const status = String(request.status || '').toUpperCase();
    if (status === 'PENDING') pendingCount += 1;
    if (status !== 'APPROVED') continue;

    const start = String(request.startDate || '').split('T')[0];
    const end = String(request.endDate || '').split('T')[0];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) continue;
    if (end < yearStart || start > yearEnd) continue;
    const clippedStart = start < yearStart ? yearStart : start;
    const clippedEnd = end > yearEnd ? yearEnd : end;
    daysTaken += inclusiveDayCount(clippedStart, clippedEnd);
  }

  return { daysTaken, pendingCount, year };
}