import React, { useState, useEffect, useCallback } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useToast } from '../contexts/ToastContext.jsx';
import { api } from '../lib/api.js';
import { formatShortDate, formatDateTime } from '../lib/format.js';
import StatusBadge from '../components/StatusBadge.jsx';
import Breadcrumb from '../components/Breadcrumb.jsx';
import BackButton from '../components/BackButton.jsx';
import { useDocumentTitle } from '../hooks/useDocumentTitle.js';
import { ClipboardIcon, BuildingIcon, UserIcon, ClockIcon } from '../components/Icons.jsx';
import RfiRespondModal from '../components/RfiRespondModal.jsx';
import VariationFormModal from '../components/VariationFormModal.jsx';

// Per-page status map mirroring Rfis.jsx so OPEN/RESPONDED/CLOSED/OVERDUE
// render with consistent colours across list + detail surfaces.
const RFI_STATUS_MAP = {
  OPEN: 'dpr-status-draft',
  RESPONDED: 'dpr-status-review',
  CLOSED: 'dpr-status-approved',
  OVERDUE: 'dpr-status-rejected',
};

function formatIndianDate(value) {
  if (!value) return '—';
  return formatShortDate(value) || String(value);
}
function formatIndianDateTime(value) {
  if (!value) return '—';
  return formatDateTime(value) || String(value);
}

export default function RfiDetail() {
  useDocumentTitle('RFI Detail');
  const { id } = useParams();
  const navigate = useNavigate();
  const { accessToken, employee } = useAuth();
  const toast = useToast();
  const [rfi, setRfi] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [respondOpen, setRespondOpen] = useState(false);
  const [escalateOpen, setEscalateOpen] = useState(false);
  const [escalating, setEscalating] = useState(false);
  const [closing, setClosing] = useState(false);

  const isAdmin = !!employee?.isAdmin;
  const isRaiser = rfi?.raisedBy?.id === employee?.id;
  const isTargetResponder = rfi?.targetResponder?.id === employee?.id;
  const canRespond = !!rfi && (rfi.status === 'OPEN' || rfi.status === 'RESPONDED') &&
    (isAdmin || isRaiser || isTargetResponder);
  const canClose = isAdmin && rfi?.status === 'RESPONDED';
  const canEscalate = isAdmin && rfi?.status !== 'CLOSED';

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await api.getRfi(id, accessToken);
      setRfi(data);
    } catch (err) {
      if (err.status === 404) setError('RFI not found.');
      else if (err.status === 403) setError('You do not have access to this RFI.');
      else setError(err.message || 'Failed to load RFI.');
      if (err.status !== 401 && err.status !== 403 && err.status !== 404) {
        toast.push(err.message || 'Failed to load RFI.', 'error');
      }
    } finally {
      setLoading(false);
    }
  }, [id, accessToken, toast]);

  useEffect(() => { load(); }, [load]);

  const handleCloseRfi = async () => {
    setClosing(true);
    try {
      await api.closeRfi(id, accessToken);
      toast.push('RFI closed.', 'success');
      await load();
    } catch (err) {
      toast.push(err.message || 'Failed to close RFI.', 'error');
    } finally {
      setClosing(false);
    }
  };

  // Escalation: backend POST /api/rfis/:id/escalate-to-variation returns
  // a freshly-created Variation Order DRAFT. The user expects to land on
  // the new VO's detail page so they can fill in the description and
  // deltaAmount — opening VariationFormModal in "edit" mode keeps the
  // editorial flow in one place.
  const handleEscalate = async (createdVo) => {
    setEscalateOpen(false);
    if (createdVo?.id) {
      toast.push('RFI escalated to a Variation Order draft.', 'success');
      navigate(`/portal/admin/variations/${createdVo.id}`);
    } else {
      toast.push('RFI escalated.', 'success');
      await load();
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

  if (error || !rfi) {
    return (
      <div className="dpr-page">
        <div className="dpr-card" style={{ textAlign: 'center', padding: '3rem' }}>
          <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>⚠️</div>
          <h2 style={{ color: 'var(--navy)', marginBottom: '0.5rem' }}>{error || 'RFI not found'}</h2>
          <BackButton to="/portal/rfis" label="My RFIs" className="btn btn-secondary btn-sm" style={{ marginTop: '1rem' }} />
        </div>
      </div>
    );
  }

  const displayStatus = rfi.displayStatus || rfi.status;
  const isOverdueRow = displayStatus === 'OVERDUE';

  return (
    <div className="dpr-page">
      <div className="dpr-card">
        <Breadcrumb
          items={[
            { label: 'My RFIs', to: '/portal/rfis' },
            { label: rfi.subject || 'RFI' },
          ]}
        />

        <div className="inspection-detail-header">
          <div style={{ minWidth: 0 }}>
            <h1 className="dpr-page-title" style={{ marginBottom: '0.25rem', overflowWrap: 'anywhere' }}>
              {rfi.subject || '(no subject)'}
            </h1>
            <div style={{ color: 'var(--steel)', fontSize: '0.9rem', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
              <BuildingIcon size={14} />
              {rfi.project ? (
                <span>{rfi.project.name}{rfi.project.code ? ` · ${rfi.project.code}` : ''}</span>
              ) : (
                <em className="text-placeholder">No project linked</em>
              )}
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.5rem', flexShrink: 0 }}>
            <StatusBadge status={displayStatus} map={RFI_STATUS_MAP} />
            {isOverdueRow && (
              <span style={{ fontSize: '0.75rem', color: 'var(--danger, #dc2626)', fontWeight: 600 }}>
                Past due date
              </span>
            )}
          </div>
        </div>

        {/* Question card — the "ask" half of the thread. */}
        <section style={{ marginBottom: '1.25rem' }}>
          <h3 style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontSize: '0.95rem', margin: '0 0 0.5rem', color: 'var(--navy)' }}>
            Question
          </h3>
          <div style={{ background: '#f8fafc', borderRadius: 6, padding: '1rem', borderLeft: '3px solid var(--blue)', whiteSpace: 'pre-wrap', fontSize: '0.9rem' }}>
            {rfi.question || <em className="text-placeholder">—</em>}
          </div>
        </section>

        {/* Response card — only rendered when a response has been filed. */}
        {rfi.response ? (
          <section style={{ marginBottom: '1.25rem' }}>
            <h3 style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontSize: '0.95rem', margin: '0 0 0.5rem', color: 'var(--navy)' }}>
              Response
            </h3>
            <div style={{ background: '#f0fdf4', borderRadius: 6, padding: '1rem', borderLeft: '3px solid var(--success, #16a34a)', whiteSpace: 'pre-wrap', fontSize: '0.9rem' }}>
              {rfi.response}
            </div>
            {rfi.responder && (
              <div style={{ marginTop: '0.5rem', fontSize: '0.8rem', color: 'var(--steel)', display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
                <UserIcon size={12} /> Responded by {rfi.responder.name}
                {rfi.respondedAt ? ` on ${formatIndianDateTime(rfi.respondedAt)}` : ''}
              </div>
            )}
          </section>
        ) : (
          <section style={{ marginBottom: '1.25rem' }}>
            <h3 style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontSize: '0.95rem', margin: '0 0 0.5rem', color: 'var(--navy)' }}>
              Response
            </h3>
            <div style={{ background: '#f8fafc', borderRadius: 6, padding: '0.75rem 1rem', fontSize: '0.85rem', color: 'var(--steel)' }}>
              Awaiting response.
            </div>
          </section>
        )}

        <dl className="dl-stacked" style={{ marginBottom: '1rem' }}>
          <dt><ClipboardIcon size={13} /> Status:</dt>
          <dd><StatusBadge status={displayStatus} map={RFI_STATUS_MAP} /></dd>
          <dt><UserIcon size={13} /> Raised by:</dt>
          <dd>{rfi.raisedBy?.name || '—'}{rfi.raisedBy?.email ? ` <${rfi.raisedBy.email}>` : ''}</dd>
          <dt><UserIcon size={13} /> Target responder:</dt>
          <dd>{rfi.targetResponder ? `${rfi.targetResponder.name}${rfi.targetResponder.email ? ` <${rfi.targetResponder.email}>` : ''}` : <em className="text-placeholder">Anyone</em>}</dd>
          <dt><ClockIcon size={13} /> Due date:</dt>
          <dd style={isOverdueRow ? { color: 'var(--danger, #dc2626)', fontWeight: 600 } : {}}>
            {formatIndianDate(rfi.dueDate)}
          </dd>
          <dt><ClockIcon size={13} /> Created:</dt>
          <dd>{formatIndianDateTime(rfi.createdAt)}</dd>
        </dl>

        {/* Reference RFI link is only present on variations escalated from
            an RFI, not on the RFI itself — but if the row carries
            variations_count we surface it as a soft signal. */}
        {typeof rfi._count?.variations === 'number' && rfi._count.variations > 0 && (
          <div style={{ marginBottom: '1rem', padding: '0.5rem 0.75rem', background: '#f8fafc', borderRadius: 6, fontSize: '0.85rem', color: 'var(--steel)' }}>
            This RFI has been escalated to <strong>{rfi._count.variations}</strong> variation order{rfi._count.variations === 1 ? '' : 's'}.
          </div>
        )}

        <div style={{ borderTop: '1px solid #e2e8f0', paddingTop: '1rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <BackButton to="/portal/rfis" label="My RFIs" className="btn btn-secondary btn-sm" />
          {canRespond && (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => setRespondOpen(true)}
            >
              Respond
            </button>
          )}
          {canClose && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={handleCloseRfi}
              disabled={closing}
            >
              {closing ? 'Closing…' : 'Close RFI'}
            </button>
          )}
          {canEscalate && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setEscalateOpen(true)}
              disabled={escalating}
            >
              Escalate to Variation Order
            </button>
          )}
        </div>
      </div>

      {/* Inline edit modal — pulls the same pre-fill contract as the
          RFI form modal so future enhancements (e.g. clarify-question)
          share one editor. */}
      <RfiRespondModal
        open={respondOpen}
        onClose={() => setRespondOpen(false)}
        rfiId={rfi.id}
        existingResponse={rfi.response}
        onSaved={() => {
          setRespondOpen(false);
          load();
        }}
        accessToken={accessToken}
      />

      {/* Escalation flow: open the Variation Form modal with the project
          pre-filled from the RFI so the admin only has to fill in
          title / description / deltaAmount. The form posts via
          api.createVariation — escalation as a backend shortcut isn't
          required for v1. */}
      {escalateOpen && rfi && (
        <VariationFormModal
          open={escalateOpen}
          onClose={() => setEscalateOpen(false)}
          onSaved={(created) => {
            setEscalateOpen(false);
            handleEscalate(created);
          }}
          initialProjectId={rfi.projectId || ''}
          initialReferenceRfiId={rfi.id}
          accessToken={accessToken}
          // The escalation path is admin-only — gate the picker so a
          // non-admin landing here (shouldn't be possible but defensive)
          // can't see the company directory.
        />
      )}
    </div>
  );
}