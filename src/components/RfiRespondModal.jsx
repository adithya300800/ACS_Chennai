import React, { useState, useEffect, useMemo } from 'react';
import Modal from './Modal.jsx';
import { useToast } from '../contexts/ToastContext.jsx';
import { api } from '../lib/api.js';

// Mirror backend/src/routes/rfis.js: RFI_FIELD_MAX.response.
const MAX_RESPONSE_LEN = 4000;

export default function RfiRespondModal({
  open,
  onClose,
  onSaved,
  rfiId,
  existingResponse = '',
  accessToken,
}) {
  const toast = useToast();
  const [response, setResponse] = useState(existingResponse);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');

  // Re-seed the textarea each time the modal opens so a previous open's
  // edits don't bleed in. existingResponse is the row's stored response
  // (empty string when not yet answered); that's the right starting
  // point so a "re-answer" flow lands on the previous text.
  useEffect(() => {
    if (open) {
      setResponse(existingResponse || '');
      setFormError('');
    }
  }, [open, existingResponse]);

  const liveError = useMemo(() => {
    if (response.trim().length === 0) return 'Response is required.';
    if (response.length > MAX_RESPONSE_LEN) return `Response must be at most ${MAX_RESPONSE_LEN} characters.`;
    return '';
  }, [response]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (liveError) {
      setFormError(liveError);
      return;
    }
    setSubmitting(true);
    setFormError('');
    try {
      await api.respondRfi(rfiId, { response: response.trim() }, accessToken);
      toast.push('Response recorded.', 'success');
      onSaved?.();
    } catch (err) {
      setFormError(err.message || 'Failed to record response');
      toast.push(err.message || 'Failed to record response', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      ariaLabel="Record a response to this RFI"
      maxWidth={640}
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
        Respond to RFI
      </h2>
      <p style={{ fontSize: '0.85rem', color: 'var(--steel)', margin: '0 0 1rem' }}>
        {existingResponse
          ? 'Replace the previous response. The status will move back to RESPONDED.'
          : 'Your answer is recorded as the RFI response. An admin will close the thread once the issue is resolved.'}
      </p>

      <form onSubmit={handleSubmit} noValidate>
        <div className="form-group">
          <label htmlFor="rfi-respond-textarea">
            Response
            <span style={{ marginLeft: 'auto', fontSize: '0.8rem', color: 'var(--steel)' }}>{response.length}/{MAX_RESPONSE_LEN}</span>
          </label>
          <textarea
            id="rfi-respond-textarea"
            className="form-input"
            value={response}
            onChange={(e) => setResponse(e.target.value)}
            rows={6}
            maxLength={MAX_RESPONSE_LEN + 100}
            placeholder="Answer the question with enough context for the requester to act."
            required
          />
        </div>

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

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '1rem' }}>
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
            {submitting ? 'Saving…' : 'Save response'}
          </button>
        </div>
      </form>
    </Modal>
  );
}