import React from 'react';

// SOL-P1#11: progressive-disclosure progress indicator for long forms.
// Each section reports `complete: boolean`; the strip shows a check or
// empty dot, plus a percentage. Anchored to the existing section
// skip-nav so clicking a step jumps to the form section.
export default function FormProgress({ sections, label = 'Form progress' }) {
  const total = sections.length;
  const done = sections.filter((s) => s.complete).length;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);

  return (
    <nav className="form-progress" aria-label={label}>
      <div className="form-progress-meta">
        <span className="form-progress-label">{label}</span>
        <span className="form-progress-count" aria-live="polite">
          {done} of {total} complete
        </span>
      </div>
      <div
        className="form-progress-bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label={`${pct}% complete`}
      >
        <div className="form-progress-bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <ol className="form-progress-steps">
        {sections.map((s, i) => (
          <li key={s.id} className={`form-progress-step ${s.complete ? 'complete' : ''}`}>
            <a href={`#${s.id}`} aria-current={s.complete ? 'false' : undefined}>
              <span className="form-progress-step-num" aria-hidden="true">
                {s.complete ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                ) : (
                  i + 1
                )}
              </span>
              <span className="form-progress-step-label">{s.label}</span>
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}
