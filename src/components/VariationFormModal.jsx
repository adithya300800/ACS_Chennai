import React, { useState, useEffect, useMemo } from 'react';
import Modal from './Modal.jsx';
import { useToast } from '../contexts/ToastContext.jsx';
import { api } from '../lib/api.js';

// Mirror backend/src/routes/variations.js caps.
const MAX_TITLE_LEN = 200;
const MAX_DESCRIPTION_LEN = 4000;
// Matches backend's DELTA_AMOUNT_MIN/MAX (NUMERIC(15,2) ceiling).
const DELTA_AMOUNT_MIN = -999999999999.99;
const DELTA_AMOUNT_MAX = 999999999999.99;

// Format a numeric/string amount as ₹1,23,456.78 (Indian-grouping).
// The backend serializes Decimal as a string (to preserve precision) so
// callers may pass either shape; we parse with Number() here for display
// only — the wire format is always the raw user input.
function formatRupees(value) {
  if (value == null || value === '') return '—';
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) return String(value);
  const formatted = Math.abs(n).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${n < 0 ? '−' : ''}₹${formatted}`;
}

export default function VariationFormModal({
  open,
  onClose,
  onSaved,
  projects,
  accessToken,
  initialProjectId = '',
  // Round-29: `rfis` + `initialReferenceRfiId` removed — the RFI feature
  // is gone and VOs are now standalone work items. The previous
  // Reference-RFI picker was deleted from the form body as well.
  editing = null,
}) {
  const toast = useToast();
  const [projectId, setProjectId] = useState(initialProjectId);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [deltaAmountRaw, setDeltaAmountRaw] = useState('');
  const [clientApprovalRequired, setClientApprovalRequired] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');

  // Round-29: RFI dropdown + referenceRfiId state REMOVED — the RFI
  // feature is gone and VOs are now standalone work items.

  useEffect(() => {
    if (!open) return;
    setFormError('');
  }, [open]);

  // Reset on open + re-seed from props (editing for the DRAFT-edit flow).
  useEffect(() => {
    if (!open) return;
    setProjectId(editing?.projectId || initialProjectId || '');
    setTitle(editing?.title || '');
    setDescription(editing?.description || '');
    setDeltaAmountRaw(
      editing?.deltaAmount == null
        ? ''
        : String(editing.deltaAmount)
    );
    setClientApprovalRequired(
      editing?.clientApprovalRequired == null ? true : !!editing.clientApprovalRequired
    );
  }, [open, editing, initialProjectId]);

  const liveError = useMemo(() => {
    if (!projectId) return 'Project is required.';
    if (title.trim().length === 0) return 'Title is required.';
    if (title.length > MAX_TITLE_LEN) return `Title must be at most ${MAX_TITLE_LEN} characters.`;
    if (description.length > MAX_DESCRIPTION_LEN) return `Description must be at most ${MAX_DESCRIPTION_LEN} characters.`;
    if (deltaAmountRaw === '') return 'Delta amount is required.';
    const n = Number(deltaAmountRaw);
    if (!Number.isFinite(n) || n < DELTA_AMOUNT_MIN || n > DELTA_AMOUNT_MAX) {
      return `Delta amount must be a finite number in [${DELTA_AMOUNT_MIN}, ${DELTA_AMOUNT_MAX}].`;
    }
    return '';
  }, [projectId, title, description, deltaAmountRaw]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (liveError) {
      setFormError(liveError);
      return;
    }
    setSubmitting(true);
    setFormError('');
    try {
      const payload = {
        projectId,
        title: title.trim(),
        description: description.trim() || null,
        // Send the raw number (not Number()) — backend parses either
        // shape; matches the wire contract for /api/variations POST/PATCH.
        deltaAmount: deltaAmountRaw === '' ? null : Number(deltaAmountRaw),
        clientApprovalRequired,
        // Round-29: referenceRfiId removed from payload — the RFI feature
        // is gone. VOs are standalone work items.
      };
      let result;
      if (editing?.id) {
        result = await api.updateVariation(editing.id, payload, accessToken);
        toast.push('Variation draft updated.', 'success');
      } else {
        result = await api.createVariation(payload, accessToken);
        toast.push('Variation draft created.', 'success');
      }
      onSaved?.(result);
    } catch (err) {
      setFormError(err.message || 'Failed to save variation');
      toast.push(err.message || 'Failed to save variation', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      ariaLabel={editing ? 'Edit variation draft' : 'New variation draft'}
      maxWidth={720}
    >
      <h2
        style={{
          fontFamily: "'Plus Jakarta Sans', sans-serif",
          fontSize: '1.1rem',
          fontWeight: 700,
          color: 'var(--navy)',
          margin: '0 0 0.25rem',
        }}
      >
        {editing ? 'Edit variation draft' : 'New variation draft'}
      </h2>
      <p style={{ fontSize: '0.85rem', color: 'var(--steel)', margin: '0 0 1rem' }}>
        {editing
          ? 'Update the editable fields. DRAFT-only — terminal states are read-only.'
          : 'A variation captures a scope change with a budget delta. Drafts can be edited; submitted variations are reviewed by an admin.'}
      </p>

      <form onSubmit={handleSubmit} noValidate>
        <div className="form-group">
          <label htmlFor="variation-form-project">Project</label>
          <select
            id="variation-form-project"
            className="form-input"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            disabled={!!editing} // disallow moving a DRAFT across projects
            required
          >
            <option value="">Select a project…</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>

        <div className="form-group">
          <label htmlFor="variation-form-title">
            Title
            <span style={{ marginLeft: 'auto', fontSize: '0.8rem', color: 'var(--steel)' }}>{title.length}/{MAX_TITLE_LEN}</span>
          </label>
          <input
            id="variation-form-title"
            type="text"
            className="form-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={MAX_TITLE_LEN + 50}
            placeholder="e.g. Additional foundation rebar — block B"
            required
          />
        </div>

        <div className="form-group">
          <label htmlFor="variation-form-description">
            Description
            <span style={{ marginLeft: 'auto', fontSize: '0.8rem', color: 'var(--steel)' }}>{description.length}/{MAX_DESCRIPTION_LEN}</span>
          </label>
          <textarea
            id="variation-form-description"
            className="form-input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={4}
            maxLength={MAX_DESCRIPTION_LEN + 100}
            placeholder="Describe the scope change in detail — what is being added or removed and why."
          />
        </div>

        <div className="form-row">
          <div className="form-group" style={{ flex: 1 }}>
            <label htmlFor="variation-form-delta">
              Delta amount (₹)
            </label>
            <input
              id="variation-form-delta"
              type="number"
              className="form-input"
              value={deltaAmountRaw}
              onChange={(e) => setDeltaAmountRaw(e.target.value)}
              step="0.01"
              placeholder="e.g. 150000 or -50000"
              required
            />
            <span style={{ fontSize: '0.8rem', color: 'var(--steel)' }}>
              Positive = added scope (credit to contractor). Negative = removed scope (credit to client).
            </span>
          </div>
          <div className="form-group" style={{ flex: 1, justifyContent: 'flex-end' }}>
            <label htmlFor="variation-form-approval" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
              <input
                id="variation-form-approval"
                type="checkbox"
                checked={clientApprovalRequired}
                onChange={(e) => setClientApprovalRequired(e.target.checked)}
              />
              Client approval required
            </label>
          </div>
        </div>

        {/* Round-29: Reference-RFI picker REMOVED. VOs are standalone
            work items now (no escalation-from-RFI flow). */}

        {formError && (
          <div
            role="alert"
            style={{
              marginTop: '0.5rem',
              padding: '0.5rem 0.75rem',
              background: '#fef2f2',
              border: '1px solid #fecaca',
              borderLeft: '3px solid var(--danger, #dc2626)',
              borderRadius: 6,
              fontSize: '0.85rem',
              color: '#7f1d1d',
            }}
          >
            {formError}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '1rem', gap: '0.5rem', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '0.8rem', color: 'var(--steel)' }}>
            Preview: {formatRupees(deltaAmountRaw === '' ? 0 : Number(deltaAmountRaw))}
          </span>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={onClose}
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary btn-sm"
              disabled={submitting || !!liveError}
            >
              {submitting ? 'Saving…' : (editing ? 'Save changes' : 'Create draft')}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}