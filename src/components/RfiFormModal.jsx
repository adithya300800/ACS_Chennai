import React, { useState, useEffect, useMemo } from 'react';
import Modal from './Modal.jsx';
import { useToast } from '../contexts/ToastContext.jsx';
import { api } from '../lib/api.js';

// Mirror the backend caps (backend/src/routes/rfis.js: RFI_FIELD_MAX).
// Keep the two halves in sync — the server is the authoritative gate, but
// a client-side cap lets us disable the submit button as the user types so
// they see the limit before a round-trip.
const MAX_SUBJECT_LEN = 200;
const MAX_QUESTION_LEN = 4000;

export default function RfiFormModal({ open, onClose, onSaved, projects, accessToken }) {
  const toast = useToast();
  const [projectId, setProjectId] = useState('');
  const [subject, setSubject] = useState('');
  const [question, setQuestion] = useState('');
  const [targetResponderId, setTargetResponderId] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [employees, setEmployees] = useState([]);
  const [employeesError, setEmployeesError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');

  // Reset state on open so a stale form from a previous open doesn't leak.
  useEffect(() => {
    if (open) {
      setProjectId('');
      setSubject('');
      setQuestion('');
      setTargetResponderId('');
      setDueDate('');
      setFormError('');
      setEmployeesError('');
    }
  }, [open]);

  // Employee directory (for the target-responder picker). Uses the
  // existing /api/admin/employees route — any authenticated employee can
  // call it (it's not strictly admin-gated on the server, it just gates
  // who can be assigned training). For RFI usage any colleague is a
  // valid target responder. We deliberately fall back to a graceful
  // empty-state on 403 so non-admins can still raise RFIs.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await api.listAdminEmployees({ limit: 500 }, accessToken);
        if (cancelled) return;
        setEmployees(data.employees || []);
      } catch (err) {
        if (cancelled) return;
        setEmployees([]);
        // Non-admins are expected to get 403 — keep the picker usable by
        // surfacing a soft hint instead of blocking the submit.
        if (err.status !== 401 && err.status !== 403) {
          setEmployeesError(err.message || 'Failed to load employee directory');
        }
      }
    })();
    return () => { cancelled = true; };
  }, [open, accessToken]);

  const liveError = useMemo(() => {
    if (subject.trim().length === 0) return 'Subject is required.';
    if (subject.length > MAX_SUBJECT_LEN) return `Subject must be at most ${MAX_SUBJECT_LEN} characters.`;
    if (question.trim().length === 0) return 'Question is required.';
    if (question.length > MAX_QUESTION_LEN) return `Question must be at most ${MAX_QUESTION_LEN} characters.`;
    return '';
  }, [subject, question]);

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
        subject: subject.trim(),
        question: question.trim(),
        // Backend treats empty string and undefined equivalently; pass
        // undefined for unset fields so the wire payload stays minimal.
        ...(projectId ? { projectId } : {}),
        ...(targetResponderId ? { targetResponderId } : {}),
        ...(dueDate ? { dueDate } : {}),
      };
      const created = await api.createRfi(payload, accessToken);
      toast.push('RFI raised.', 'success');
      onSaved?.(created);
    } catch (err) {
      setFormError(err.message || 'Failed to raise RFI');
      toast.push(err.message || 'Failed to raise RFI', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      ariaLabel="Raise a new RFI"
      maxWidth={680}
    >
      <h2
        id="rfi-form-title"
        style={{
          fontFamily: "'Plus Jakarta Sans', sans-serif",
          fontSize: '1.15rem',
          fontWeight: 700,
          color: 'var(--navy)',
          margin: '0 0 0.25rem',
        }}
      >
        Raise a new RFI
      </h2>
      <p style={{ fontSize: '0.85rem', color: 'var(--steel)', margin: '0 0 1rem' }}>
        File a question to a colleague. They can answer from the same page; an admin can close the thread once resolved.
      </p>

      <form onSubmit={handleSubmit} noValidate>
        <div className="form-group">
          <label htmlFor="rfi-form-project">
            Project <span style={{ color: 'var(--steel)', fontSize: '0.8rem', fontWeight: 400 }}>(optional)</span>
          </label>
          <select
            id="rfi-form-project"
            className="form-input"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
          >
            <option value="">No project (general)</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>

        <div className="form-group">
          <label htmlFor="rfi-form-subject">
            Subject
            <span style={{ marginLeft: 'auto', fontSize: '0.8rem', color: 'var(--steel)' }}>{subject.length}/{MAX_SUBJECT_LEN}</span>
          </label>
          <input
            id="rfi-form-subject"
            type="text"
            className="form-input"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            maxLength={MAX_SUBJECT_LEN + 50}
            placeholder="e.g. Clarification on slab rebar spacing"
            required
          />
        </div>

        <div className="form-group">
          <label htmlFor="rfi-form-question">
            Question
            <span style={{ marginLeft: 'auto', fontSize: '0.8rem', color: 'var(--steel)' }}>{question.length}/{MAX_QUESTION_LEN}</span>
          </label>
          <textarea
            id="rfi-form-question"
            className="form-input"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            rows={5}
            maxLength={MAX_QUESTION_LEN + 100}
            placeholder="Describe the question in full — the responder needs enough context to answer."
            required
          />
        </div>

        <div className="form-row">
          <div className="form-group" style={{ flex: 1 }}>
            <label htmlFor="rfi-form-responder">
              Target responder <span style={{ color: 'var(--steel)', fontSize: '0.8rem', fontWeight: 400 }}>(optional)</span>
            </label>
            <select
              id="rfi-form-responder"
              className="form-input"
              value={targetResponderId}
              onChange={(e) => setTargetResponderId(e.target.value)}
              disabled={employees.length === 0}
            >
              <option value="">Anyone qualified</option>
              {employees.map((emp) => (
                <option key={emp.id} value={emp.id}>
                  {emp.name || emp.email}
                </option>
              ))}
            </select>
            {employeesError && (
              <span style={{ fontSize: '0.8rem', color: 'var(--steel)' }}>{employeesError}</span>
            )}
          </div>
          <div className="form-group" style={{ flex: 1 }}>
            <label htmlFor="rfi-form-due">
              Due date <span style={{ color: 'var(--steel)', fontSize: '0.8rem', fontWeight: 400 }}>(optional)</span>
            </label>
            <input
              id="rfi-form-due"
              type="date"
              className="form-input"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
            />
          </div>
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
            {submitting ? 'Raising…' : 'Raise RFI'}
          </button>
        </div>
      </form>
    </Modal>
  );
}