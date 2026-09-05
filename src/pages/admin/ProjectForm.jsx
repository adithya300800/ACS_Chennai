import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate, useParams, useSearchParams, Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { api } from '../../lib/api.js';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';

// N17 — Project form (create + edit). Single component reused for both
// modes — the URL determines which: /admin/projects/new creates, and
// /admin/projects/:id/edit fetches + patches.
//
// Edit mode intentionally does NOT expose isActive — the backend routes
// soft-delete through DELETE on a dedicated endpoint so the audit trail
// (createdById, createdAt) stays intact. We add a single "Archive
// project" link in edit mode that navigates back to ProjectsAdmin where
// the confirmation modal lives.

// ──── Field validation ────────────────────────────────────────────────────
// Mirrors the backend's allowlist (name required, code optional, dates
// YYYY-MM-DD, endDate >= startDate). We re-run it client-side so the
// user gets immediate feedback rather than waiting for the network
// round-trip; the server is still the source of truth for any final
// uniqueness / length caps.
function validate(form) {
  const errors = {};
  if (!form.name || !String(form.name).trim()) {
    errors.name = 'Name is required.';
  } else if (String(form.name).length > 200) {
    errors.name = 'Name is too long (max 200 chars).';
  }
  if (form.code && String(form.code).length > 60) {
    errors.code = 'Code is too long (max 60 chars).';
  }
  if (form.client && String(form.client).length > 200) {
    errors.client = 'Client is too long (max 200 chars).';
  }
  if (form.location && String(form.location).length > 200) {
    errors.location = 'Location is too long (max 200 chars).';
  }
  if (form.startDate && form.expectedEndDate && form.expectedEndDate < form.startDate) {
    errors.expectedEndDate = 'Expected end date must be on or after the start date.';
  }
  return errors;
}

export default function ProjectForm() {
  const isEdit = Boolean(useParams().id);
  useDocumentTitle(isEdit ? 'Edit Project' : 'New Project');
  const { accessToken } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const { id: editId } = useParams();
  const [searchParams] = useSearchParams();

  // Form state — all fields held as strings so a blank input shows as
  // "" rather than "undefined". We convert to null on submit when the
  // field is empty (matches the backend's contract).
  const [form, setForm] = useState({
    name: '',
    code: '',
    client: '',
    location: '',
    startDate: '',
    expectedEndDate: '',
  });
  const [errors, setErrors] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [loading, setLoading] = useState(isEdit);
  const [serverError, setServerError] = useState('');
  const mountedRef = useRef(true);

  // Edit-mode initial load. Resolve the project, then patch the form
  // state. /portal/admin/projects/new never hits this — it uses the
  // optional ?name=<discovered> query param to pre-fill the name field
  // so an admin can promote an auto-discovered project to a registered
  // one without retyping.
  const loadProject = useCallback(async (projectId) => {
    setLoading(true);
    setServerError('');
    try {
      const p = await api.getProject(projectId, accessToken);
      if (!mountedRef.current) return;
      setForm({
        name: p.name || '',
        code: p.code || '',
        client: p.client || '',
        location: p.location || '',
        startDate: p.startDate || '',
        expectedEndDate: p.expectedEndDate || '',
      });
    } catch (err) {
      if (!mountedRef.current) return;
      setServerError(err?.message || 'Failed to load project');
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    mountedRef.current = true;
    if (isEdit && editId) {
      loadProject(editId);
    } else {
      // Pre-fill name from ?name=<discovered> when creating from a
      // "Discovered" row on the projects list.
      const prefilledName = searchParams.get('name');
      if (prefilledName) {
        setForm((f) => ({ ...f, name: prefilledName }));
      }
    }
    return () => { mountedRef.current = false; };
  }, [isEdit, editId, loadProject, searchParams]);

  // Submit handler. Runs client-side validation first; on failure the
  // server's specific 4xx response (UNIQUE constraint, etc.) gets
  // surfaced inline.
  const handleSubmit = async (e) => {
    e.preventDefault();
    setServerError('');
    const v = validate(form);
    if (Object.keys(v).length > 0) {
      setErrors(v);
      return;
    }
    setErrors({});
    setSubmitting(true);
    try {
      // Convert empty strings to null so the backend gets the same
      // shape the database expects (optional fields default to null).
      const payload = {
        name: form.name.trim(),
        code: form.code ? form.code.trim() : null,
        client: form.client ? form.client.trim() : null,
        location: form.location ? form.location.trim() : null,
        startDate: form.startDate || null,
        expectedEndDate: form.expectedEndDate || null,
      };
      if (isEdit) {
        await api.updateProject(editId, payload, accessToken);
        if (!mountedRef.current) return;
        toast.pushToast({ message: `Project "${payload.name}" updated`, tone: 'success' });
      } else {
        const created = await api.createProject(payload, accessToken);
        if (!mountedRef.current) return;
        toast.pushToast({ message: `Project "${created.name}" registered`, tone: 'success' });
      }
      navigate('/portal/admin/projects');
    } catch (err) {
      if (!mountedRef.current) return;
      const msg = err?.message || 'Failed to save project';
      setServerError(msg);
      // 409 — duplicate name — surface inline on the name field.
      if (err?.code === 'DUPLICATE' || /duplicate/i.test(msg)) {
        setErrors({ name: 'A project with this name already exists.' });
      }
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="dpr-page">
        <div className="dpr-card" style={{ padding: '2rem', textAlign: 'center', color: 'var(--steel, #64748b)' }}>
          Loading project&hellip;
        </div>
      </div>
    );
  }

  return (
    <div className="dpr-page">
      <div className="dpr-page-header">
        <div>
          <h1 className="dpr-page-title" aria-label={isEdit ? 'Edit Project' : 'New Project'}>
            {isEdit ? 'Edit Project' : 'New Project'}
          </h1>
          <p className="dpr-page-sub" style={{ color: 'var(--steel)', margin: 0, fontSize: '0.9rem' }}>
            {isEdit
              ? 'Update project metadata. Use Archive on the project list to retire it.'
              : 'Register a new project so the PM dashboard can scope KPIs to it.'}
          </p>
        </div>
        <Link
          to="/portal/admin/projects"
          className="dpr-card"
          style={{
            padding: '0.5rem 0.875rem',
            textDecoration: 'none',
            color: 'var(--steel, #64748b)',
            background: 'white',
            fontWeight: 600,
            fontSize: '0.85rem',
            borderRadius: 8,
            border: '1px solid var(--steel, #cbd5e1)',
          }}
        >
          ← Back to projects
        </Link>
      </div>

      {serverError && !errors.name ? (
        <div
          className="dpr-card"
          role="alert"
          style={{
            padding: '0.75rem 1rem',
            color: 'var(--red, #dc2626)',
            background: 'rgba(220,38,38,0.06)',
            marginBottom: '1rem',
            fontSize: '0.85rem',
          }}
        >
          {serverError}
        </div>
      ) : null}

      <form onSubmit={handleSubmit} className="dpr-card" style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <FormField
          id="name"
          label="Project name"
          required
          value={form.name}
          error={errors.name}
          onChange={(v) => setForm((f) => ({ ...f, name: v }))}
          placeholder="T-Nagar Residential Complex"
          maxLength={200}
        />
        <FormField
          id="code"
          label="Code (optional)"
          value={form.code}
          error={errors.code}
          onChange={(v) => setForm((f) => ({ ...f, code: v }))}
          placeholder="TNR-01"
          maxLength={60}
          hint="Short reference code — used in exports and dropdowns."
        />
        <FormField
          id="client"
          label="Client"
          value={form.client}
          error={errors.client}
          onChange={(v) => setForm((f) => ({ ...f, client: v }))}
          placeholder="ABC Builders Pvt Ltd"
          maxLength={200}
        />
        <FormField
          id="location"
          label="Location"
          value={form.location}
          error={errors.location}
          onChange={(v) => setForm((f) => ({ ...f, location: v }))}
          placeholder="T-Nagar, Chennai"
          maxLength={200}
        />
        {/* Date row — start + expected end side-by-side on desktop, stacked
            on mobile. Both inputs are <input type="date"> so the browser
            gives a native calendar widget. */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0.75rem' }}>
          <FormField
            id="startDate"
            label="Start date"
            type="date"
            value={form.startDate}
            error={errors.startDate}
            onChange={(v) => setForm((f) => ({ ...f, startDate: v }))}
          />
          <FormField
            id="expectedEndDate"
            label="Expected end date"
            type="date"
            value={form.expectedEndDate}
            error={errors.expectedEndDate}
            onChange={(v) => setForm((f) => ({ ...f, expectedEndDate: v }))}
          />
        </div>

        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem', flexWrap: 'wrap' }}>
          <button
            type="submit"
            disabled={submitting}
            style={{
              padding: '0.625rem 1rem',
              background: 'var(--blue, #0066FF)',
              color: 'white',
              border: 'none',
              borderRadius: 8,
              fontSize: '0.9rem',
              fontWeight: 600,
              cursor: submitting ? 'not-allowed' : 'pointer',
              opacity: submitting ? 0.6 : 1,
            }}
          >
            {submitting ? 'Saving…' : (isEdit ? 'Save changes' : 'Register project')}
          </button>
          <button
            type="button"
            onClick={() => navigate('/portal/admin/projects')}
            disabled={submitting}
            style={{
              padding: '0.625rem 1rem',
              border: '1px solid var(--steel, #cbd5e1)',
              background: 'white',
              borderRadius: 8,
              fontSize: '0.9rem',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

// ──── FormField ───────────────────────────────────────────────────────────
// Single labelled text/date input with optional hint + error text.
// Inline error uses the reserved red so it reads as a status, not a
// brand colour.
function FormField({ id, label, required, value, onChange, error, type: inputType = 'text', placeholder, maxLength, hint }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
      <label
        htmlFor={id}
        style={{
          fontFamily: "'Plus Jakarta Sans', sans-serif",
          fontSize: '0.82rem',
          fontWeight: 600,
          color: 'var(--navy, #0f172a)',
        }}
      >
        {label}
        {required ? <span style={{ color: 'var(--red, #dc2626)', marginLeft: 4 }} aria-hidden="true">*</span> : null}
      </label>
      <input
        id={id}
        type={inputType}
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        maxLength={maxLength}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${id}-error` : (hint ? `${id}-hint` : undefined)}
        style={{
          padding: '0.5rem 0.75rem',
          border: `1px solid ${error ? 'var(--red, #dc2626)' : 'var(--steel, #cbd5e1)'}`,
          borderRadius: 8,
          fontSize: '0.9rem',
          background: 'white',
          fontFamily: 'inherit',
        }}
      />
      {hint && !error ? (
        <div id={`${id}-hint`} style={{ fontSize: '0.75rem', color: 'var(--steel, #64748b)' }}>{hint}</div>
      ) : null}
      {error ? (
        <div id={`${id}-error`} role="alert" style={{ fontSize: '0.75rem', color: 'var(--red, #dc2626)' }}>{error}</div>
      ) : null}
    </div>
  );
}