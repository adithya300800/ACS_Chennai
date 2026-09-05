// N3 (Phase F) — Drawing picker dropdown.
//
// Embedded in the DPR + Inspection submit forms so an engineer filing a
// record can stamp it against a specific drawing revision. The picker
// reads the active register for the selected project and emits both
// `drawingId` and `drawingRev` via onChange so the parent form can
// forward both fields to the wire contract.
//
// Props:
//   projectId      — UUID of the project the engineer is filing against.
//                    When empty / falsy the picker shows the "Pick a
//                    project first" placeholder and is disabled.
//   value          — currently selected drawingId (string | null).
//   onChange       — (drawingId, drawingRev) => void. Pass `drawingId =
//                    null` to clear the selection.
//   accessToken    — bearer token for the GET /api/drawings call.
//   limit          — page size for the register read (default 100, the
//                    admin registry rarely has more than a handful of
//                    active drawings per project).
//   disabled       — local override; usually unused.
//   ariaInvalid    — propagated to <select> for WCAG 3.3.1 error styling.
//
// Why a separate component (vs inline)?
//   - Reused by DPR + Inspection submit + the future RFI / Variation
//     pickers (N2 already calls out drawings as a stamp target).
//   - Encapsulates the cancel-on-unmount refetch logic so the parent
//     stays focused on form state.
//   - Keeps the picker height + label aligned with the BOQ picker
//     beside it (same flex layout, same disabled-state copy).
import React, { useEffect, useState, useRef } from 'react';
import { api } from '../lib/api.js';

export default function DrawingPicker({
  projectId,
  value,
  onChange,
  accessToken,
  limit = 100,
  disabled,
  ariaInvalid,
}) {
  const [drawings, setDrawings] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const cancelledRef = useRef(false);

  // Refetch whenever the project changes. The 300ms debounce keeps a
  // fast project-picker click from firing a request per re-render —
  // same pattern as the BOQ picker (see DprSubmit.jsx:357-378).
  useEffect(() => {
    cancelledRef.current = false;
    if (!projectId) {
      setDrawings([]);
      setLoading(false);
      setError('');
      return undefined;
    }
    setLoading(true);
    setError('');
    const t = setTimeout(async () => {
      try {
        const data = await api.getDrawings(
          { projectId, status: 'ACTIVE', limit: String(limit) },
          accessToken,
        );
        if (cancelledRef.current) return;
        setDrawings(data.drawings || []);
      } catch (err) {
        if (cancelledRef.current) return;
        setError(err?.message || 'Failed to load drawings');
        setDrawings([]);
      } finally {
        if (!cancelledRef.current) setLoading(false);
      }
    }, 300);
    return () => {
      cancelledRef.current = true;
      clearTimeout(t);
    };
  }, [projectId, accessToken, limit]);

  const handleChange = (e) => {
    const nextId = e.target.value || null;
    if (!nextId) {
      onChange(null, null);
      return;
    }
    const found = drawings.find((d) => d.id === nextId);
    onChange(nextId, found ? found.revision : null);
  };

  // Empty states mirror the BOQ picker contract so the user sees a
  // consistent pattern between the two stamp fields.
  if (!projectId) {
    return (
      <select
        className="form-input"
        disabled
        aria-label="Drawing (pick a project first)"
      >
        <option>Pick a project first to see drawings</option>
      </select>
    );
  }
  if (loading) {
    return (
      <select className="form-input" disabled aria-busy="true" aria-label="Loading drawings">
        <option>Loading drawings…</option>
      </select>
    );
  }
  if (error) {
    return (
      <div
        role="alert"
        style={{
          padding: '0.5rem 0.75rem',
          background: '#fef2f2',
          border: '1px solid #fecaca',
          borderRadius: 6,
          fontSize: '0.85rem',
          color: '#991b1b',
        }}
      >
        Couldn't load drawings: {error}
      </div>
    );
  }
  if (drawings.length === 0) {
    return (
      <div
        style={{
          padding: '0.5rem 0.75rem',
          background: '#f8fafc',
          border: '1px solid #e2e8f0',
          borderRadius: 6,
          fontSize: '0.85rem',
          color: 'var(--steel)',
        }}
      >
        No drawings on file for this project. Ask the design lead to
        upload one via Drawings Register.
      </div>
    );
  }

  return (
    <select
      className="form-input"
      value={value || ''}
      onChange={handleChange}
      disabled={disabled}
      aria-invalid={ariaInvalid ? 'true' : 'false'}
      aria-label="Drawing"
    >
      <option value="">— No drawing link —</option>
      {drawings.map((d) => (
        <option key={d.id} value={d.id}>
          {d.drawingNumber}{d.title ? ` — ${d.title}` : ''} (Rev {d.revision})
        </option>
      ))}
    </select>
  );
}