import React from 'react';

// S5 audit: shared severity badge. Previously every list page defined its
// own local `function SeverityBadge({ severity })` with inline styles — the
// duplicates drifted on colour palette and padding. The shared component
// accepts a `severity` string ("LOW" | "MEDIUM" | "HIGH" | "CRITICAL") and
// renders a text pill with consistent palette + 1px border, matching the
// audit requirement that filtered attributes also appear on browse cards.
//
// Renders nothing for null/undefined/empty so callers can drop in
// `insp.severity` without guarding.

const SEVERITY_CLASS = {
  LOW: 'severity-pill severity-pill-low',
  MEDIUM: 'severity-pill severity-pill-medium',
  HIGH: 'severity-pill severity-pill-high',
  CRITICAL: 'severity-pill severity-pill-critical',
};

const SEVERITY_LABEL = {
  LOW: 'Low',
  MEDIUM: 'Medium',
  HIGH: 'High',
  CRITICAL: 'Critical',
};

export default function SeverityBadge({ severity }) {
  if (!severity) return null;
  const cls = SEVERITY_CLASS[severity] || 'severity-pill severity-pill-medium';
  const label = SEVERITY_LABEL[severity] || severity;
  return (
    <span className={cls} aria-label={`Severity: ${severity}`} title={severity}>
      {label}
    </span>
  );
}
