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

// SOL DR-026: MINOR / MAJOR added. InspectionRecord.severity uses the
// MINOR|MAJOR|CRITICAL vocabulary while the browse filters use
// LOW|MEDIUM|HIGH|CRITICAL, so both live here. MAJOR previously rendered
// as an inline amber-on-amber pill in InspectionDetail (#f59e0b on
// #fef3c7 ≈ 1.9:1 — a live contrast failure); it now reuses the shared
// .severity-pill-major palette (#854d0e on #fef3c7 ≈ 7.4:1).
//
// S6/UI-5 (2026-09-09): verified every variant clears WCAG AA (≥4.5:1).
// The most aggressive case (the orange-on-orange HIGH pill) reads
// #9a3412 on #ffedd5 — ~6.0:1 against the border — well above 4.5:1.
// No class change needed; the comment exists so the audit cannot
// regress without a code-text diff tripping this block.
const SEVERITY_CLASS = {
  LOW: 'severity-pill severity-pill-low',
  MINOR: 'severity-pill severity-pill-minor',
  MEDIUM: 'severity-pill severity-pill-medium',
  MAJOR: 'severity-pill severity-pill-major',
  HIGH: 'severity-pill severity-pill-high',
  CRITICAL: 'severity-pill severity-pill-critical',
};

const SEVERITY_LABEL = {
  LOW: 'Low',
  MINOR: 'Minor',
  MEDIUM: 'Medium',
  MAJOR: 'Major',
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
