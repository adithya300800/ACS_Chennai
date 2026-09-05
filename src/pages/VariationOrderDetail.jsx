import React, { useState, useEffect, useCallback } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useToast } from '../contexts/ToastContext.jsx';
import { api } from '../lib/api.js';
import { formatDateTime } from '../lib/format.js';
import StatusBadge from '../components/StatusBadge.jsx';
import Breadcrumb from '../components/Breadcrumb.jsx';
import BackButton from '../components/BackButton.jsx';
import { useDocumentTitle } from '../hooks/useDocumentTitle.js';
import { BuildingIcon, DocIcon, ClockIcon, UserIcon } from '../components/Icons.jsx';
import VariationFormModal from '../components/VariationFormModal.jsx';

const VARIATION_STATUS_MAP = {
  DRAFT: 'dpr-status-draft',
  SUBMITTED: 'dpr-status-review',
  APPROVED: 'dpr-status-approved',
  REJECTED: 'dpr-status-rejected',
};

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

function formatIndianDateTime(value) {
  if (!value) return '—';
  return formatDateTime(value) || String(value);
}

export default function VariationOrderDetail() {
  useDocumentTitle('Variation Order Detail');
  const { id } = useParams();
  const navigate = useNavigate();
  const { accessToken, employee } = useAuth();
  const toast = useToast();
  const [variation, setVariation] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editOpen, setEditOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [approving, setApproving] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [showRejectForm, setShowRejectForm] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [rejectError, setRejectError] = useState('');

  const isAdmin = !!employee?.isAdmin;
  const isRaiser = variation?.raisedBy?.id === employee?.id;
  const status = variation?.status;
  const canEdit = status === 'DRAFT' && (isAdmin || isRaiser);
  const canSubmit = status === 'DRAFT' && (isAdmin || isRaiser);
  const canApprove = isAdmin && status === 'SUBMITTED';
  const canReject = isAdmin && status === 'SUBMITTED';

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await api.getVariation(id, accessToken);
      setVariation(data);
    } catch (err) {
      if (err.status === 404) setError('Variation not found.');
      else if (err.status === 403) setError('You do not have access to this variation.');
      else setError(err.message || 'Failed to load variation.');
      if (err.status !== 401 && err.status !== 403 && err.status !== 404) {
        toast.push(err.message || 'Failed to load variation.', 'error');
      }
    } finally {
      setLoading(false);
    }
  }, [id, accessToken, toast]);

  useEffect(() => { load(); }, [load]);

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      await api.submitVariation(id, accessToken);
      toast.push('Variation submitted for review.', 'success');
      await load();
    } catch (err) {
      toast.push(err.message || 'Failed to submit variation.', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleApprove = async () => {
    setApproving(true);
    try {
      await api.approveVariation(id, accessToken);
      toast.push('Variation approved.', 'success');
      await load();
    } catch (err) {
      toast.push(err.message || 'Failed to approve variation.', 'error');
    } finally {
      setApproving(false);
    }
  };

  const handleReject = async (e) => {
    e?.preventDefault?.();
    if (!rejectReason.trim()) {
      setRejectError('A reason is required when rejecting.');
      return;
    }
    setRejecting(true);
    try {
      await api.rejectVariation(id, { reason: rejectReason.trim() }, accessToken);
      toast.push('Variation rejected.', 'success');
      setShowRejectForm(false);
      setRejectReason('');
      setRejectError('');
      await load();
    } catch (err) {
      toast.push(err.message || 'Failed to reject variation.', 'error');
    } finally {
      setRejecting(false);
    }
  };

  if (loading) {
    return (
      <div className="dpr-page">
        <div className="dpr-card" aria-hidden="true" style={{ minHeight: 280, opacity: 0.55 }}>
          <div style={{ height: 24, background: '#e2e8f0', borderRadius: 4, width: '40%', marginBottom: 16 }} />
          <div style={{ height: 12, background: '#e2e8f0', borderRadius: 4, width: '80%', marginBottom: 8 }} />
          <div style={{ height: 12, background: '#e2e8f0', borderRadius: 4, width: '60%' }} />
        </div>
      </div>
    );
  }

  if (error || !variation) {
    return (
      <div className="dpr-page">
        <div className="dpr-card" style={{ textAlign: 'center', padding: '3rem' }}>
          <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>⚠️</div>
          <h2 style={{ color: 'var(--navy)', marginBottom: '0.5rem' }}>{error || 'Variation not found'}</h2>
          <BackButton to="/portal/admin/variations" label="Variation Orders" className="btn btn-secondary btn-sm" style={{ marginTop: '1rem' }} />
        </div>
      </div>
    );
  }

  return (
    <div className="dpr-page">
      <div className="dpr-card">
        <Breadcrumb
          items={[
            { label: 'Variation Orders', to: '/portal/admin/variations' },
            { label: variation.title || 'Variation' },
          ]}
        />

        <div className="inspection-detail-header">
          <div style={{ minWidth: 0, flex: 1 }}>
            <h1 className="dpr-page-title" style={{ marginBottom: '0.25rem', overflowWrap: 'anywhere' }}>
              {variation.title}
            </h1>
            <div style={{ color: 'var(--steel)', fontSize: '0.9rem', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
              <BuildingIcon size={14} />
              {variation.project ? (
                <span>{variation.project.name}{variation.project.code ? ` · ${variation.project.code}` : ''}</span>
              ) : (
                <em className="text-placeholder">No project</em>
              )}
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.5rem', flexShrink: 0 }}>
            <StatusBadge status={variation.status} map={VARIATION_STATUS_MAP} />
            <span style={{
              fontFamily: "'Plus Jakarta Sans', sans-serif",
              fontSize: '1.25rem',
              fontWeight: 700,
              color: variation.deltaAmount != null && Number(variation.deltaAmount) < 0 ? 'var(--success, #16a34a)' : 'var(--navy)',
            }}>
              {formatRupees(variation.deltaAmount)}
            </span>
          </div>
        </div>

        {/* Inline rejection banner — same red-tinted alert pattern as
            DprList / InspectionDetail so the visual language is
            consistent across modules. */}
        {variation.status === 'REJECTED' && variation.rejectedReason && (
          <div
            role="alert"
            style={{
              marginBottom: '1rem',
              padding: '0.75rem 0.875rem',
              background: '#fef2f2',
              border: '1px solid #fecaca',
              borderLeft: '3px solid var(--danger, #dc2626)',
              borderRadius: 6,
              fontSize: '0.85rem',
              color: '#7f1d1d',
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: '0.25rem' }}>Rejected</div>
            <div>{variation.rejectedReason}</div>
          </div>
        )}

        {variation.description && (
          <section style={{ marginBottom: '1.25rem' }}>
            <h3 style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontSize: '0.95rem', margin: '0 0 0.5rem', color: 'var(--navy)' }}>
              Description
            </h3>
            <div style={{ background: '#f8fafc', borderRadius: 6, padding: '1rem', borderLeft: '3px solid var(--blue)', whiteSpace: 'pre-wrap', fontSize: '0.9rem' }}>
              {variation.description}
            </div>
          </section>
        )}

        {variation.referenceRfi && (
          <section style={{ marginBottom: '1.25rem' }}>
            <h3 style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontSize: '0.95rem', margin: '0 0 0.5rem', color: 'var(--navy)' }}>
              Reference RFI
            </h3>
            <Link to={`/portal/rfis/${variation.referenceRfi.id}`} className="dpr-card" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', textDecoration: 'none', padding: '0.5rem 0.875rem', color: 'var(--navy)', fontSize: '0.9rem' }}>
              <DocIcon size={14} />
              {variation.referenceRfi.subject || 'View RFI'}
            </Link>
          </section>
        )}

        {/* Approval workflow timeline. Surfaces the canonical events so
            the reviewer can see WHO did WHAT WHEN without leaving the
            detail page. */}
        <section style={{ marginBottom: '1.25rem' }}>
          <h3 style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontSize: '0.95rem', margin: '0 0 0.5rem', color: 'var(--navy)' }}>
            Workflow timeline
          </h3>
          <ol style={{ listStyle: 'none', padding: 0, margin: 0, borderLeft: '2px solid #e2e8f0' }}>
            <li style={{ padding: '0.25rem 0 0.5rem 1rem', position: 'relative' }}>
              <span style={{ position: 'absolute', left: -5, top: 8, width: 8, height: 8, borderRadius: 4, background: 'var(--blue)' }} aria-hidden="true" />
              <div style={{ fontSize: '0.85rem' }}>
                <strong>Created</strong> by {variation.raisedBy?.name || '—'}
              </div>
              <div style={{ fontSize: '0.8rem', color: 'var(--steel)' }}>
                {formatIndianDateTime(variation.createdAt)}
              </div>
            </li>
            {variation.submittedAt && (
              <li style={{ padding: '0.25rem 0 0.5rem 1rem', position: 'relative' }}>
                <span style={{ position: 'absolute', left: -5, top: 8, width: 8, height: 8, borderRadius: 4, background: 'var(--blue)' }} aria-hidden="true" />
                <div style={{ fontSize: '0.85rem' }}>
                  <strong>Submitted</strong> by {variation.raisedBy?.name || '—'}
                </div>
                <div style={{ fontSize: '0.8rem', color: 'var(--steel)' }}>
                  {formatIndianDateTime(variation.submittedAt)}
                </div>
              </li>
            )}
            {variation.status === 'APPROVED' && variation.approvedAt && (
              <li style={{ padding: '0.25rem 0 0.5rem 1rem', position: 'relative' }}>
                <span style={{ position: 'absolute', left: -5, top: 8, width: 8, height: 8, borderRadius: 4, background: 'var(--success, #16a34a)' }} aria-hidden="true" />
                <div style={{ fontSize: '0.85rem' }}>
                  <strong>Approved</strong> by {variation.approvedBy?.name || '—'}
                </div>
                <div style={{ fontSize: '0.8rem', color: 'var(--steel)' }}>
                  {formatIndianDateTime(variation.approvedAt)}
                </div>
              </li>
            )}
            {variation.status === 'REJECTED' && variation.rejectedAt && (
              <li style={{ padding: '0.25rem 0 0.5rem 1rem', position: 'relative' }}>
                <span style={{ position: 'absolute', left: -5, top: 8, width: 8, height: 8, borderRadius: 4, background: 'var(--danger, #dc2626)' }} aria-hidden="true" />
                <div style={{ fontSize: '0.85rem' }}>
                  <strong>Rejected</strong> by {variation.approvedBy?.name || '—'}
                </div>
                <div style={{ fontSize: '0.8rem', color: 'var(--steel)' }}>
                  {formatIndianDateTime(variation.rejectedAt)}
                </div>
              </li>
            )}
          </ol>
        </section>

        <dl className="dl-stacked" style={{ marginBottom: '1rem' }}>
          <dt><UserIcon size={13} /> Raised by:</dt>
          <dd>{variation.raisedBy?.name || '—'}</dd>
          <dt><BuildingIcon size={13} /> Project:</dt>
          <dd>{variation.project?.name || '—'}</dd>
          <dt><ClockIcon size={13} /> Created:</dt>
          <dd>{formatIndianDateTime(variation.createdAt)}</dd>
          {variation.clientApprovalRequired !== undefined && (
            <>
              <dt><ClockIcon size={13} /> Client approval:</dt>
              <dd>{variation.clientApprovalRequired ? 'Required' : 'Not required'}</dd>
            </>
          )}
        </dl>

        {/* Reject-form inline expansion — keeps the admin in flow without
            another modal layer. Required by the backend (reason is the
            rejectedReason column). */}
        {showRejectForm && (
          <form
            onSubmit={handleReject}
            style={{
              marginTop: '1rem',
              padding: '0.75rem 0.875rem',
              background: '#fef2f2',
              border: '1px solid #fecaca',
              borderLeft: '3px solid var(--danger, #dc2626)',
              borderRadius: 6,
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: '0.5rem', color: '#7f1d1d' }}>
              Reject this variation?
            </div>
            <label htmlFor="variation-reject-reason" style={{ display: 'block', fontSize: '0.85rem', marginBottom: '0.25rem', color: '#7f1d1d' }}>
              Reason (required)
            </label>
            <textarea
              id="variation-reject-reason"
              className="form-input"
              value={rejectReason}
              onChange={(e) => { setRejectReason(e.target.value); if (rejectError) setRejectError(''); }}
              rows={3}
              maxLength={1000}
              required
            />
            {rejectError && (
              <div role="alert" style={{ marginTop: '0.5rem', fontSize: '0.8rem', color: '#7f1d1d' }}>
                {rejectError}
              </div>
            )}
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '0.5rem' }}>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => { setShowRejectForm(false); setRejectReason(''); setRejectError(''); }}
                disabled={rejecting}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn btn-sm"
                style={{ background: 'var(--danger, #dc2626)', color: '#fff', border: 'none' }}
                disabled={rejecting || !rejectReason.trim()}
              >
                {rejecting ? 'Rejecting…' : 'Confirm rejection'}
              </button>
            </div>
          </form>
        )}

        <div style={{ borderTop: '1px solid #e2e8f0', paddingTop: '1rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <BackButton to="/portal/admin/variations" label="Variation Orders" className="btn btn-secondary btn-sm" />
          {canEdit && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setEditOpen(true)}
            >
              Edit draft
            </button>
          )}
          {canSubmit && (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={handleSubmit}
              disabled={submitting}
            >
              {submitting ? 'Submitting…' : 'Submit for review'}
            </button>
          )}
          {canApprove && (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={handleApprove}
              disabled={approving}
            >
              {approving ? 'Approving…' : 'Approve'}
            </button>
          )}
          {canReject && !showRejectForm && (
            <button
              type="button"
              className="btn btn-sm"
              style={{ background: 'var(--danger, #dc2626)', color: '#fff', border: 'none' }}
              onClick={() => setShowRejectForm(true)}
            >
              Reject…
            </button>
          )}
        </div>
      </div>

      {editOpen && variation && (
        <VariationFormModal
          open={editOpen}
          onClose={() => setEditOpen(false)}
          onSaved={(updated) => {
            setEditOpen(false);
            if (updated) {
              toast.push('Variation draft updated.', 'success');
              setVariation((prev) => ({ ...(prev || {}), ...updated }));
            }
            load();
          }}
          editing={variation}
          accessToken={accessToken}
        />
      )}
    </div>
  );
}