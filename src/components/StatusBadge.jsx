import React from 'react';

// C-06: shared status badge. Previously every dashboard/list page defined
// its own local `function StatusBadge({ status })` that mapped a status
// string to a CSS class + a lowercase label. We had 4 near-identical
// copies (DprList, InspectionList, DprDashboard, InspectionDashboard).
//
// The DEFAULT mapping below covers all status values seen across the
// four call sites. A page can still pass a custom `map` prop if its
// statuses don't fit (e.g. if a new module adds its own enum).

const DEFAULT_STATUS_MAP = {
  // DPR states
  DRAFT: 'dpr-status-draft',
  SUBMITTED: 'dpr-status-review',
  REVIEWED: 'dpr-status-review',
  APPROVED: 'dpr-status-approved',
  REJECTED: 'dpr-status-rejected',

  // Inspection & compliance states
  OPEN: 'dpr-status-draft',
  ACKNOWLEDGED: 'dpr-status-review',
  IN_PROGRESS: 'dpr-status-review',
  PENDING_VERIFICATION: 'dpr-status-review',
  CLOSED: 'dpr-status-approved',

  // Leave
  PENDING: 'dpr-status-review',
  CANCELLED: 'dpr-status-rejected',

  // Training
  ASSIGNED: 'dpr-status-draft',
  COMPLETED: 'dpr-status-approved',
  OVERDUE: 'dpr-status-rejected',
};

export default function StatusBadge({ status, map, className = '' }) {
  if (!status) return null;
  const statusMap = map || DEFAULT_STATUS_MAP;
  const cls = statusMap[status] || 'dpr-status-draft';
  const label = String(status).replace(/_/g, ' ').toLowerCase();
  return (
    <span className={`dpr-status-badge ${cls} ${className}`.trim()}>
      {label.charAt(0).toUpperCase() + label.slice(1)}
    </span>
  );
}
