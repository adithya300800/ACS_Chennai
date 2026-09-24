import React from 'react';

// §8.12 (Fresh24 wave-4 batch-B): shared record-state badge.
//
// The Fresh24 audit caught archive UX drift across modules:
//   - TrainingCourseDetail had a local `training-pill-archived` pill
//   - DrawingsBrowse rendered an inline archive error string
//   - BillingCertificationsAdmin kept a `STATUS_BADGE_STYLES` map that
//     had DRAFT/CERTIFIED/DISPUTED but no ARCHIVED entry
//   - ProjectsAdmin used a local "Inactive" pill with inline styles
//
// Three distinct record states matter (audit §8.12 acceptance):
//   archived     — record is intentionally preserved but inactive
//   deleted      — record was soft-deleted (often recoverable)
//   unavailable  — record cannot be retrieved (access revoked, never
//                  existed, or hard-removed)
//
// The component renders nothing for null / undefined / empty / unknown
// state so callers can drop in `record.archivedState` directly. Unknown
// states fall back to the `unavailable` palette so a future state added
// to one module cannot silently render as nothing in another.

const RECORD_STATE_CLASS = {
  archived: 'record-status-pill record-status-pill-archived',
  deleted: 'record-status-pill record-status-pill-deleted',
  unavailable: 'record-status-pill record-status-pill-unavailable',
};

const RECORD_STATE_LABEL = {
  archived: 'Archived',
  deleted: 'Deleted',
  unavailable: 'Unavailable',
};

export default function RecordStatusBadge({ state, className = '' }) {
  if (!state) return null;
  const cls = RECORD_STATE_CLASS[state] || RECORD_STATE_CLASS.unavailable;
  const label = RECORD_STATE_LABEL[state] || state;
  return (
    <span
      className={`${cls} ${className}`.trim()}
      aria-label={`Record state: ${state}`}
      title={state}
    >
      {label}
    </span>
  );
}