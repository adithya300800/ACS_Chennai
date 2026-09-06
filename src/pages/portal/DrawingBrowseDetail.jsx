// N3-employee — Drawing detail, employee-facing read-only view.
//
// Renders one drawing revision with the same layout the admin sees on
// /portal/admin/drawings/:id, minus the Edit / Supersede / Archive
// actions. The point is: when a DPR or Inspection record references
// drawing X rev Y, the field engineer clicks through to a page that
// shows the PDF, the supersedes chain, and the stamps — enough to
// confirm "yes, this is the revision I meant" without exposing
// curation actions.
//
// Differences from admin DrawingDetail:
//   - No Edit / Supersede / Archive buttons.
//   - No DrawingFormModal.
//   - Breadcrumb lands on /portal/drawings (employee list), not the
//     admin register.
//   - DPR / Inspection stamp links point at the EMPLOYEE detail pages
//     (DprList modal, InspectionDetail) instead of admin-only routes.
//
// Auth: backend GET /api/drawings/:id + GET /api/drawings/:id/read-sas
// are both requireAuth, so no client-side gating is needed.

import React, { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { api } from '../../lib/api.js';
import Breadcrumb from '../../components/Breadcrumb.jsx';
import BackButton from '../../components/BackButton.jsx';
import StatusBadge from '../../components/StatusBadge.jsx';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';
import { formatShortDate } from '../../lib/format.js';

const DRAWING_STATUS_MAP = {
  ACTIVE: 'dpr-status-approved',
  SUPERSEDED: 'dpr-status-rejected',
};

function formatDate(value) {
  if (!value) return '—';
  const out = formatShortDate(value);
  return out || String(value);
}

export default function DrawingBrowseDetail() {
  const { id } = useParams();
  useDocumentTitle('Drawing');
  const { accessToken } = useAuth();
  const toast = useToast();

  const [drawing, setDrawing] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [pdfUrl, setPdfUrl] = useState(null);
  // 'loading' | 'ready' | 'no-pdf' | 'unavailable'
  const [pdfPreviewState, setPdfPreviewState] = useState('loading');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await api.getDrawing(id, accessToken);
      setDrawing(data);
    } catch (err) {
      setError(err?.message || 'Failed to load drawing');
      setDrawing(null);
    } finally {
      setLoading(false);
    }
  }, [id, accessToken]);

  useEffect(() => {
    load();
  }, [load]);

  // Mint a read SAS for the iframe. The admin page wires the same way;
  // shared on the backend (`/api/drawings/:id/read-sas`, requireAuth).
  useEffect(() => {
    if (!drawing || !drawing.pdfBlobPath) {
      setPdfUrl(null);
      setPdfPreviewState(drawing && !drawing.pdfBlobPath ? 'no-pdf' : 'loading');
      return undefined;
    }
    let cancelled = false;
    setPdfPreviewState('loading');
    (async () => {
      try {
        const data = await api.getDrawingReadSas(drawing.id, accessToken);
        if (cancelled) return;
        if (data && (data.sasUrl || data.url)) {
          setPdfUrl(data.sasUrl || data.url);
          setPdfPreviewState('ready');
        } else {
          setPdfPreviewState('unavailable');
        }
      } catch {
        if (cancelled) return;
        setPdfPreviewState('unavailable');
      }
    })();
    return () => { cancelled = true; };
  }, [drawing, accessToken]);

  if (loading) {
    return (
      <div className="dpr-page" style={{ padding: '3rem', textAlign: 'center', color: 'var(--steel)' }}>
        <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>⏳</div>
        Loading drawing…
      </div>
    );
  }

  if (error || !drawing) {
    return (
      <div className="dpr-page">
        <div className="dpr-card">
          <Breadcrumb
            items={[
              { label: 'My Drawings', to: '/portal/drawings' },
              { label: 'Not found' },
            ]}
          />
          <h1 className="dpr-page-title">Drawing not found</h1>
          <p style={{ color: 'var(--steel)' }}>{error || 'The drawing may have been deleted.'}</p>
          <BackButton to="/portal/drawings" label="My Drawings" className="btn btn-secondary" />
        </div>
      </div>
    );
  }

  const chain = Array.isArray(drawing.supersedesChain) ? drawing.supersedesChain : [];

  return (
    <div className="dpr-page">
      <div className="dpr-page-header">
        <div>
          <Breadcrumb
            items={[
              { label: 'My Drawings', to: '/portal/drawings' },
              { label: `${drawing.drawingNumber} Rev ${drawing.revision}` },
            ]}
          />
          <h1 className="dpr-page-title" style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
            <span style={{ fontFamily: 'monospace' }}>{drawing.drawingNumber}</span>
            <span style={{ fontSize: '0.85em', color: 'var(--steel)', fontWeight: 500 }}>
              Rev {drawing.revision}
            </span>
            <StatusBadge status={drawing.status} map={DRAWING_STATUS_MAP} />
          </h1>
          {drawing.title && (
            <p style={{ color: 'var(--steel)', margin: 0 }}>{drawing.title}</p>
          )}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(280px, 1fr)', gap: '1rem' }}>
        {/* PDF preview */}
        <div className="dpr-card" style={{ minHeight: 540, padding: 0, overflow: 'hidden' }}>
          {pdfPreviewState === 'ready' && pdfUrl ? (
            <iframe
              key={pdfUrl}
              src={pdfUrl}
              title={`${drawing.drawingNumber} Rev ${drawing.revision}`}
              style={{ width: '100%', height: 540, border: 'none', display: 'block' }}
              sandbox="allow-same-origin"
            />
          ) : (
            <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--steel)' }}>
              {pdfPreviewState === 'loading' && (
                <>
                  <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>⏳</div>
                  Preparing preview…
                </>
              )}
              {pdfPreviewState === 'no-pdf' && (
                <>
                  <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>📄</div>
                  No PDF uploaded for this revision.
                </>
              )}
              {pdfPreviewState === 'unavailable' && (
                <>
                  <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>🔒</div>
                  Preview is unavailable right now.
                </>
              )}
            </div>
          )}
        </div>

        {/* Side panel — stamps + chain + meta */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div className="dpr-card">
            <h3 style={{ fontSize: '0.95rem', color: 'var(--navy)', margin: '0 0 0.5rem' }}>
              Drawing metadata
            </h3>
            <dl style={{ margin: 0, fontSize: '0.85rem', color: 'var(--steel)', display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '0.35rem 0.75rem' }}>
              <dt>Project</dt>
              <dd style={{ margin: 0, color: 'var(--navy)' }}>{drawing.projectId}</dd>
              <dt>Issued</dt>
              <dd style={{ margin: 0 }}>{formatDate(drawing.issuedDate)}</dd>
              <dt>References</dt>
              <dd style={{ margin: 0 }}>{drawing.referencedByCount ?? 0}</dd>
            </dl>
          </div>

          {/* Stamp: DPRs */}
          <div className="dpr-card">
            <h3 style={{ fontSize: '0.95rem', color: 'var(--navy)', margin: '0 0 0.5rem' }}>
              Referenced by {drawing.referencedBy?.dprs?.length || 0} DPR
              {(drawing.referencedBy?.dprs?.length || 0) === 1 ? '' : 's'}
            </h3>
            {(!drawing.referencedBy?.dprs || drawing.referencedBy.dprs.length === 0) ? (
              <p style={{ fontSize: '0.85rem', color: 'var(--steel)', margin: 0 }}>
                No DPRs have stamped against this revision yet.
              </p>
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                {drawing.referencedBy.dprs.map((d) => (
                  <li key={d.id} style={{ fontSize: '0.85rem' }}>
                    <Link to={`/portal/dpr/my?id=${d.id}`} style={{ fontFamily: 'monospace', color: 'var(--navy)' }}>
                      DPR · {formatDate(d.reportDate)}
                    </Link>
                    <span style={{ color: 'var(--steel)' }}> · {d.projectName} · {d.status}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Stamp: Inspections */}
          <div className="dpr-card">
            <h3 style={{ fontSize: '0.95rem', color: 'var(--navy)', margin: '0 0 0.5rem' }}>
              Referenced by {drawing.referencedBy?.inspections?.length || 0} Inspection
              {(drawing.referencedBy?.inspections?.length || 0) === 1 ? '' : 's'}
            </h3>
            {(!drawing.referencedBy?.inspections || drawing.referencedBy.inspections.length === 0) ? (
              <p style={{ fontSize: '0.85rem', color: 'var(--steel)', margin: 0 }}>
                No Inspection records have stamped against this revision yet.
              </p>
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                {drawing.referencedBy.inspections.map((i) => (
                  <li key={i.id} style={{ fontSize: '0.85rem' }}>
                    <Link to={`/portal/inspection/my?id=${i.id}`} style={{ color: 'var(--navy)' }}>
                      {i.inspectionType}
                    </Link>
                    <span style={{ color: 'var(--steel)' }}>
                      {' '}· {formatDate(i.reportDate)} · {i.projectName} · {i.status}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Supersedes chain — links to the employee detail page so
              walking the chain stays inside the employee portal. */}
          {chain.length > 0 && (
            <div className="dpr-card">
              <h3 style={{ fontSize: '0.95rem', color: 'var(--navy)', margin: '0 0 0.5rem' }}>
                Supersedes
              </h3>
              <ol style={{ paddingLeft: '1.1rem', margin: 0, display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                {chain.map((p) => (
                  <li key={p.id} style={{ fontSize: '0.85rem' }}>
                    <Link to={`/portal/drawings/${p.id}`} style={{ fontFamily: 'monospace', color: 'var(--navy)' }}>
                      {p.drawingNumber}
                    </Link>
                    <span style={{ color: 'var(--steel)' }}> · Rev {p.revision} · {p.status}</span>
                    <span style={{ color: 'var(--steel)' }}> · {formatDate(p.issuedDate)}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
