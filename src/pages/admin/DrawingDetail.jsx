// N3 (Phase F) — Drawing detail page.
//
// Renders one drawing revision with everything the admin needs to
// audit its lifecycle:
//
//   - Header     : drawing number, revision, status badge, title.
//   - PDF preview: <iframe src={pdfSasUrl} /> when the backend
//                  exposes a read SAS; falls back to a clear
//                  "preview pending" state until the endpoint ships.
//   - Stamp panel: "Referenced by N DPRs (Rev X)" + N Inspections —
//                  each entry links straight to the filing record so
//                  the admin can confirm the stamp before superseding.
//   - Chain      : the `supersedesChain` returned by GET /api/drawings/:id
//                  walks backward; the page also surfaces "Superseded
//                  by" when this row has been flipped.
//   - Actions    : Edit / Supersede / Archive (admin only).
//
// UX notes
// ────────
//   - The Edit modal opens the same DrawingFormModal used on the
//     registry page but pre-fills the editable fields. We intentionally
//     keep drawingNumber / revision / projectId locked (backend
//     refuses changes — see ALLOWED_PATCH_FIELDS in drawings.js) and
//     let the admin tweak title / issuedDate / pdfBlobPath / status.
//   - The preview iframe is wrapped in a sandboxed container so a
//     rogue PDF can't navigate the parent shell. We only attach the
//     read SAS URL on mount + on URL refresh — switching drawings
//     navigates through a `key` change so the iframe remounts.

import React, { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { api } from '../../lib/api.js';
import Breadcrumb from '../../components/Breadcrumb.jsx';
import BackButton from '../../components/BackButton.jsx';
import StatusBadge from '../../components/StatusBadge.jsx';
import DrawingFormModal from '../../components/DrawingFormModal.jsx';
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

export default function DrawingDetail() {
  const { id } = useParams();
  useDocumentTitle('Drawing');
  const { accessToken } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();

  const [drawing, setDrawing] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [pdfUrl, setPdfUrl] = useState(null);
  const [pdfPreviewState, setPdfPreviewState] = useState('loading'); // 'loading' | 'ready' | 'unavailable'
  const [formOpen, setFormOpen] = useState(false);
  // Tracks which mode the modal opens in:
  //   - null       = closed
  //   - 'edit'     = edit current drawing (uses DrawingFormModal editOf)
  //   - 'supersede'= supersede current drawing (uses supersedes prop)
  const [formMode, setFormMode] = useState(null);
  const [projects, setProjects] = useState([]);

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

  // Pull the curated project list so the Edit modal has a dropdown to
  // render with. We always pass projects to the modal even in Edit mode
  // because the field is disabled — but having the list keeps the
  // projectName resolution visible in the dropdown.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api.getProjects(accessToken);
        if (!cancelled) setProjects((data?.projects || []).filter((p) => p.isActive));
      } catch { /* non-fatal — Edit will surface its own error */ }
    })();
    return () => { cancelled = true; };
  }, [accessToken]);

  // Mint a read SAS for the iframe. The endpoint is NOT shipped yet —
  // until it lands we render a "preview pending" placeholder instead
  // of a 404 iframe. When the backend ships, setPdfPreviewState('ready')
  // is the only change needed.
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

  // The Edit button on the header opens the modal in "edit" mode via
  // the `editOf` prop (added to DrawingFormModal). The modal pre-fills
  // editable fields (title, issuedDate) and locks the natural key.
  // The PATCH payload is filtered to only the editable fields because
  // the backend rejects unknown keys (UNKNOWN_FIELDS 400).
  const handleEditSave = async (payload) => {
    await api.updateDrawing(drawing.id, {
      title: payload.title ?? drawing.title,
      issuedDate: payload.issuedDate ?? drawing.issuedDate,
      pdfBlobPath: payload.pdfBlobPath ?? drawing.pdfBlobPath,
      status: payload.status ?? drawing.status,
    }, accessToken);
    toast.push('Drawing updated.', 'success');
    setFormOpen(false);
    await load();
  };

  // [DR-002] Supersede must CREATE a new drawing row that points back at
  // the predecessor — the backend (POST /api/drawings/:id/supersede)
  // then atomically flips the predecessor to SUPERSEDED inside the same
  // transaction. The modal's payload is supersede-shaped (projectId /
  // drawingNumber / supersedesId included for the create-with-id path),
  // but the explicit supersede endpoint only accepts { revision, title?,
  // issuedDate?, pdfBlobPath? } — projectId / drawingNumber / issuedById
  // are inherited from the predecessor, NOT in the body. Strip the
  // supersede-relevant fields here and forward.
  const handleSupersedeSave = async (payload) => {
    const result = await api.supersedeDrawing(drawing.id, {
      revision: payload.revision,
      ...(payload.title != null ? { title: payload.title } : {}),
      ...(payload.issuedDate != null ? { issuedDate: payload.issuedDate } : {}),
      ...(payload.pdfBlobPath ? { pdfBlobPath: payload.pdfBlobPath } : {}),
    }, accessToken);
    toast.push(`Superseded — new revision ${result.successor.revision} created.`, 'success');
    setFormOpen(false);
    navigate(`/portal/admin/drawings/${result.successor.id}`);
  };

  const handleSupersedeFromHere = () => {
    // Open the same modal in supersede mode — the modal pre-fills
    // project + drawingNumber + title from the current row.
    setFormMode('supersede');
    setFormOpen(true);
  };

  const handleArchive = async () => {
    if (!drawing) return;
    const ok = window.confirm(
      `Archive ${drawing.drawingNumber} Rev ${drawing.revision}? Linked DPRs and Inspections keep their reference.`,
    );
    if (!ok) return;
    try {
      await api.softDeleteDrawing(drawing.id, accessToken);
      toast.push('Drawing archived.', 'success');
      navigate('/portal/admin/drawings');
    } catch (err) {
      toast.push(err?.message || 'Failed to archive drawing', 'error');
    }
  };

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
              { label: 'Admin Overview', to: '/portal/admin' },
              { label: 'Drawings', to: '/portal/admin/drawings' },
              { label: 'Not found' },
            ]}
          />
          <h1 className="dpr-page-title">Drawing not found</h1>
          <p style={{ color: 'var(--steel)' }}>{error || 'The drawing may have been deleted.'}</p>
          <BackButton to="/portal/admin/drawings" label="Drawing Register" className="btn btn-secondary" />
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
              { label: 'Admin Overview', to: '/portal/admin' },
              { label: 'Drawings', to: '/portal/admin/drawings' },
              { label: `${drawing.drawingNumber} Rev ${drawing.revision}` },
            ]}
          />
          <h1 className="dpr-page-title" style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
            <span style={{ fontFamily: 'monospace' }}>{drawing.drawingNumber}</span>
            <span style={{ fontSize: '0.85em', color: 'var(--steel)', fontWeight: 500 }}>
              Rev {drawing.revision}
            </span>
            {/* S6/UI-3: surface that this row is the CURRENT revision (vs.
                historical entries in the supersedes chain below). The page
                renders a single revision at a time, but a viewer landing
                here from a stale link benefits from seeing "Current" up
                top before they audit the PDF + stamps. */}
            {drawing.status !== 'SUPERSEDED' && (
              <span
                aria-label="Current revision"
                title="Current revision — supersedes any prior revisions listed below"
                style={{
                  fontSize: '0.7rem',
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                  color: '#fff',
                  background: 'var(--success, #16a34a)',
                  padding: '0.15rem 0.45rem',
                  borderRadius: 4,
                }}
              >
                Current
              </span>
            )}
            <StatusBadge status={drawing.status} map={DRAWING_STATUS_MAP} />
          </h1>
          {drawing.title && (
            <p style={{ color: 'var(--steel)', margin: 0 }}>{drawing.title}</p>
          )}
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button className="btn btn-secondary btn-sm" onClick={() => { setFormMode('edit'); setFormOpen(true); }}>Edit</button>
          {drawing.status === 'ACTIVE' && (
            <button className="btn btn-primary btn-sm" onClick={handleSupersedeFromHere}>
              Supersede
            </button>
          )}
          {drawing.status !== 'SUPERSEDED' && (
            <button
              className="btn btn-sm"
              style={{ background: 'var(--danger)', color: '#fff', border: 'none' }}
              onClick={handleArchive}
            >
              Archive
            </button>
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
                  <div style={{ fontSize: '0.85rem', marginTop: '0.5rem' }}>
                    The PDF read endpoint is on the roadmap. The drawing is
                    still linked to its DPR / Inspection stamps below.
                  </div>
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
                    <Link to={`/portal/dpr/${d.id}`} style={{ fontFamily: 'monospace', color: 'var(--navy)' }}>
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
                    <Link to={`/portal/inspection/${i.id}`} style={{ color: 'var(--navy)' }}>
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

          {/* Supersedes chain */}
          {chain.length > 0 && (
            <div className="dpr-card">
              <h3 style={{ fontSize: '0.95rem', color: 'var(--navy)', margin: '0 0 0.5rem' }}>
                Supersedes
              </h3>
              {/* S6/UI-3: each prior revision is a HISTORICAL stamp of
                  this drawing number. The label sits in the section
                  header so a viewer doesn't mistake a chain entry for
                  the current revision above. */}
              <div style={{ fontSize: '0.75rem', color: 'var(--steel)', marginBottom: '0.5rem' }}>
                Historical revisions (no longer in effect)
              </div>
              <ol style={{ paddingLeft: '1.1rem', margin: 0, display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                {chain.map((p) => (
                  <li key={p.id} style={{ fontSize: '0.85rem' }}>
                    <Link to={`/portal/admin/drawings/${p.id}`} style={{ fontFamily: 'monospace', color: 'var(--navy)' }}>
                      {p.drawingNumber}
                    </Link>
                    <span style={{ color: 'var(--steel)' }}> · Rev {p.revision} · {p.status}</span>
                    <span style={{ color: 'var(--steel)' }}> · {formatDate(p.issuedDate)}</span>
                    <span
                      aria-label="Historical revision"
                      title="Historical revision — superseded by the current row above"
                      style={{
                        marginLeft: '0.4rem',
                        fontSize: '0.65rem',
                        fontWeight: 600,
                        textTransform: 'uppercase',
                        letterSpacing: '0.04em',
                        color: 'var(--steel)',
                        background: '#f1f5f9',
                        padding: '0.1rem 0.35rem',
                        borderRadius: 3,
                      }}
                    >
                      Historical
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      </div>

      <DrawingFormModal
        open={formOpen}
        onClose={() => { setFormOpen(false); setFormMode(null); }}
        // [DR-002] supersede → POST /api/drawings (creates new row +
        // flips predecessor atomically); edit → PATCH /api/drawings/:id.
        // Same modal, different wire path keyed off formMode.
        onSave={formMode === 'supersede' ? handleSupersedeSave : handleEditSave}
        accessToken={accessToken}
        projects={projects}
        supersedes={formMode === 'supersede' ? drawing : null}
        editOf={formMode === 'edit' ? drawing : null}
      />
    </div>
  );
}