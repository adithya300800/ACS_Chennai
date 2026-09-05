import React, { useState, useEffect, useCallback } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { api } from '../../lib/api.js';
import { formatShortDate, formatDateTime } from '../../lib/format.js';
import { SUB_WORK_TYPE_OPTIONS } from './WorkTypes.jsx';
import Breadcrumb from '../../components/Breadcrumb.jsx';
import BackButton from '../../components/BackButton.jsx';
import PhotoDownloadButton from '../../components/PhotoDownloadButton.jsx';
// Round-28 #7: full-screen photo lightbox with keyboard + swipe nav.
import PhotoLightbox from '../../components/PhotoLightbox.jsx';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';

function formatIndianDate(iso) {
  if (!iso) return '—';
  return formatShortDate(iso) || String(iso);
}

function formatIndianDateTime(iso) {
  if (!iso) return '—';
  return formatDateTime(iso) || String(iso);
}

function labelize(key) {
  return key.replace(/([A-Z])/g, ' $1').replace(/^./, (s) => s.toUpperCase());
}

function renderValue(value) {
  if (value == null || value === '') return <span className="text-placeholder">—</span>;
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export default function InspectionDetail() {
  useDocumentTitle('Inspection Detail');
  const { id } = useParams();
  const navigate = useNavigate();
  const { accessToken, employee } = useAuth();
  const toast = useToast();
  const [record, setRecord] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // Round-28 #7: lightbox state. Null = closed. Number = open at index.
  const [lightboxIndex, setLightboxIndex] = useState(null);
  // N5: linked cube tests for cube_casting inspections. Fetched after
  // the record loads; non-cube-casting records leave this null so the
  // conditional render below short-circuits cleanly.
  const [linkedCubeTests, setLinkedCubeTests] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await api.getInspection(id, accessToken);
      setRecord(data);
      // N5: only cube_casting inspections can have linked cube tests —
      // the backend rejects non-cube-casting FKs at create time. Skip the
      // round-trip for other inspection types. Failures are silent; the
      // section just won't appear.
      if (data?.inspectionType === 'cube_casting') {
        api.getCubeTests({ castingRecordId: id, limit: '100' }, accessToken)
          .then((res) => setLinkedCubeTests(res.tests || []))
          .catch(() => setLinkedCubeTests([]));
      } else {
        setLinkedCubeTests(null);
      }
    } catch (err) {
      if (err.status === 404) setError('Inspection record not found.');
      else if (err.status === 403) setError('You do not have access to this record.');
      else setError(err.message || 'Failed to load inspection record.');
      if (err.status !== 401 && err.status !== 403 && err.status !== 404) {
        toast.push(err.message || 'Failed to load inspection record.', 'error');
      }
    } finally {
      setLoading(false);
    }
  }, [id, accessToken, toast]);

  useEffect(() => { load(); }, [load]);

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

  if (error) {
    return (
      <div className="dpr-page">
        <div className="dpr-card" style={{ textAlign: 'center', padding: '3rem' }}>
          <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>⚠️</div>
          <h2 style={{ color: 'var(--navy)', marginBottom: '0.5rem' }}>{error}</h2>
          <BackButton to="/portal/inspection/my" label="My Inspection Records" className="btn btn-secondary btn-sm" style={{ marginTop: '1rem' }} />
        </div>
      </div>
    );
  }

  if (!record) return null;

  const typeMeta = SUB_WORK_TYPE_OPTIONS.find((s) => s.value === record.inspectionType);

  return (
    <div className="dpr-page">
      <div className="dpr-card">
        {/* Round-17 B-03: breadcrumb above H1. Last item is current page (no `to`). */}
        <Breadcrumb
          items={[
            { label: 'My Inspection Records', to: '/portal/inspection/my' },
            {
              // Match the H1 below so the breadcrumb's current-page label is
              // consistent with the page title. Falls back to project name
              // when no typeMeta label exists (defensive — `typeMeta` lookup
              // covers SUB_WORK_TYPE_OPTIONS enum values).
              label: `${typeMeta?.label || record.inspectionType}${(record.project?.name || record.projectName) ? ` · ${record.project?.name || record.projectName}` : ''}`,
            },
          ]}
        />
        {/* SOL-P1#6: on mobile the status badge wraps below the title
            instead of being truncated beside it. The wrapper uses
            flex-wrap so the layout collapses gracefully. */}
        <div className="inspection-detail-header">
          <div style={{ minWidth: 0 }}>
            <h1 className="dpr-page-title" style={{ marginBottom: '0.25rem' }}>
              {typeMeta?.label || record.inspectionType}
            </h1>
            <div style={{ color: 'var(--steel)', fontSize: '0.9rem', overflowWrap: 'anywhere' }}>
              {record.project?.name || record.projectName} · {record.location}
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.5rem', flexShrink: 0 }}>
            <span className={`dpr-status-badge dpr-status-${(record.status || 'open').toLowerCase()}`}>
              {(record.status || 'OPEN').replace(/_/g, ' ')}
            </span>
            {record.severity && (
              <span style={{
                padding: '2px 10px',
                borderRadius: 12,
                fontSize: '0.75rem',
                fontWeight: 600,
                color: record.severity === 'CRITICAL' ? '#dc2626' : record.severity === 'MAJOR' ? '#f59e0b' : '#64748b',
                background: record.severity === 'CRITICAL' ? '#fee2e2' : record.severity === 'MAJOR' ? '#fef3c7' : '#f1f5f9',
              }}>
                {record.severity}
              </span>
            )}
          </div>
        </div>

        {/* Round-28 #5: inline rejection reason so the reviewer can see WHY
            the inspection was sent back without leaving the detail page.
            Mirror the DPR modal banner — same red-tinted alert pattern so
            the visual language is consistent across modules. */}
        {record.status === 'REJECTED' && (record.rejectionReason || record.adminNotes) && (
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
            {record.rejectionReason && (
              <div style={{ marginBottom: record.adminNotes ? '0.5rem' : 0 }}>
                {record.rejectionReason}
              </div>
            )}
            {record.adminNotes && (
              <div style={{ fontSize: '0.8rem', color: '#991b1b', fontStyle: 'italic' }}>
                Admin note: {record.adminNotes}
              </div>
            )}
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.75rem', marginBottom: '1.5rem', fontSize: '0.85rem' }}>
          <div><strong>Date:</strong> {formatIndianDate(record.reportDate)}</div>
          {record.weather && <div><strong>Weather:</strong> {record.weather}</div>}
          {record.contractor && <div><strong>Contractor:</strong> {record.contractor}</div>}
          {/* N7: linked BOQ item, same convention as the DPR detail
              modal. Read-only here — the deep-link routes to the
              variance report so reviewers can see the executed-qty
              delta without leaving the page. */}
          <div>
            <strong>BOQ Item:</strong>{' '}
            {record.boqItem ? (
              <>
                <span style={{ fontFamily: 'monospace' }}>{record.boqItem.itemCode}</span>
                {' — '}
                <span>{record.boqItem.description}</span>
                {' · '}
                <Link to={`/portal/boq?projectName=${encodeURIComponent((record.project?.name || record.projectName) || '')}`}>
                  View variance
                </Link>
              </>
            ) : (
              <em className="text-placeholder">Not linked</em>
            )}
          </div>
          {record.dpr && (
            <div>
              <strong>Linked DPR:</strong>{' '}
              <Link to={`/portal/dpr/my`}>{formatIndianDate(record.dpr.reportDate)}</Link>
            </div>
          )}
          <div><strong>Filed by:</strong> {record.submittedBy?.name || '—'}</div>
          <div><strong>Filed at:</strong> {formatIndianDateTime(record.createdAt)}</div>
        </div>

        {/* Structured fields — renders whatever `data` holds, labelized. */}
        {record.data && Object.keys(record.data).length > 0 && (
          <div style={{ marginBottom: '1.5rem' }}>
            <h3 style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontSize: '1rem', marginBottom: '0.5rem', color: 'var(--navy)' }}>
              Details
            </h3>
            <div style={{ background: '#f8fafc', borderRadius: 6, padding: '1rem', borderLeft: '3px solid var(--blue)' }}>
              {/* SOL-P1#6: single-column dl on narrow screens so dates and
                  values aren't split / clipped. CSS class `dl-stacked`
                  collapses the grid at ≤640px. */}
              <dl className="dl-stacked">
                {Object.entries(record.data).map(([key, value]) => (
                  <React.Fragment key={key}>
                    <dt>{labelize(key)}:</dt>
                    <dd>{renderValue(value)}</dd>
                  </React.Fragment>
                ))}
              </dl>
            </div>
          </div>
        )}

        {/* Photos */}
        {record.photos && record.photos.length > 0 && (
          <div style={{ marginBottom: '1.5rem' }}>
            <h3 style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontSize: '1rem', marginBottom: '0.5rem', color: 'var(--navy)' }}>
              Photos ({record.photos.length})
            </h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: '0.5rem' }}>
              {record.photos.map((p, i) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setLightboxIndex(i)}
                  style={{
                    position: 'relative',
                    display: 'block',
                    aspectRatio: '1',
                    borderRadius: 6,
                    overflow: 'hidden',
                    background: '#f1f5f9',
                    padding: 0,
                    border: 'none',
                    cursor: 'pointer',
                  }}
                  aria-label={`Open photo ${i + 1} of ${record.photos.length}`}
                  title={p.caption || 'Open photo'}
                >
                  <img
                    src={p.readUrl}
                    alt={p.caption || 'Inspection photo'}
                    loading="lazy"
                    style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                  />
                  {/* R22.5: per-image download affordance. */}
                  <PhotoDownloadButton photo={p} label="Open inspection photo" />
                </button>
              ))}
            </div>
          </div>
        )}

        {/* N5: linked cube tests for cube_casting inspections. Other
            inspection types have no cube-test relationship so we hide
            the section entirely. Empty array (no cubes yet) renders a
            small helper line so the user knows cubes can be linked. */}
        {record.inspectionType === 'cube_casting' && Array.isArray(linkedCubeTests) && (
          <div style={{ marginBottom: '1.5rem' }}>
            <h3 style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontSize: '1rem', marginBottom: '0.5rem', color: 'var(--navy)' }}>
              Linked Cube Tests ({linkedCubeTests.length})
            </h3>
            {linkedCubeTests.length === 0 ? (
              <div style={{ background: '#f8fafc', borderRadius: 6, padding: '0.625rem 0.875rem', fontSize: '0.85rem', color: 'var(--steel)', borderLeft: '3px solid var(--blue)' }}>
                No cube tests have been linked to this casting record yet.
              </div>
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                {linkedCubeTests.map((ct) => (
                  <li key={ct.id} style={{ fontSize: '0.9rem' }}>
                    <Link to={`/portal/cube-tests/${ct.id}`}>
                      {ct.concreteGrade} · {ct.pourLocation}
                    </Link>
                    {' · '}
                    <span style={{ color: 'var(--steel)' }}>{ct.status.replace(/_/g, ' ').toLowerCase()}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Round-28 #7: full-screen lightbox with keyboard + swipe nav.
            Rendered unconditionally; it's a portal so it lives at <body>
            level and the dialog role + z-index 2000 puts it above the
            breadcrumb / page chrome. */}
        <PhotoLightbox
          photos={record.photos || []}
          startIndex={lightboxIndex ?? 0}
          open={lightboxIndex !== null}
          onClose={() => setLightboxIndex(null)}
        />

        <div style={{ borderTop: '1px solid #e2e8f0', paddingTop: '1rem', display: 'flex', gap: '0.5rem' }}>
          <BackButton to="/portal/inspection/my" label="My Inspection Records" className="btn btn-secondary btn-sm" />
          {record.dpr && (
            <Link to={`/portal/dpr/my`} className="btn btn-secondary btn-sm">
              View linked DPR
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
