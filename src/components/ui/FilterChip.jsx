// Tiny chip used by the type-filter row + future inline filters.
//
// Lifted from ProjectExpandedPanel.jsx#FilterChip (round-35) so the
// category-chip row on the upload form + the admin Reports page's
// second chip row can share the same pill styling without redefining
// the inline styles. Pill style is intentionally identical to the
// original — visual parity with the existing chips is the whole
// reason this was extracted.
//
// Usage:
//   <FilterChip label="All" active={filterType === null} onClick={...} />
//   <FilterChip label={label} active={isActive} onClick={() => toggle(c)} />
//
// Props:
//   label      — visible text (string)
//   active     — true → brand blue + tinted bg; false → steel grey + white
//   onClick    — handler; called once per click
//   disabled   — optional; greys the chip and suppresses onClick when true
export default function FilterChip({ label, active, onClick, disabled = false }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      style={{
        fontSize: '0.72rem',
        fontWeight: 600,
        padding: '0.2rem 0.6rem',
        borderRadius: 999,
        border: '1px solid ' + (active ? 'var(--brand, #0066ff)' : '#cbd5e1'),
        background: active ? 'rgba(0, 102, 255, 0.08)' : 'white',
        color: active ? 'var(--brand, #0066ff)' : 'var(--steel, #64748b)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {label}
    </button>
  );
}