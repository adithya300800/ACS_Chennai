import React, { useState, useEffect, useCallback } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { api } from '../../lib/api.js';
import { formatShortDate, formatDateTime } from '../../lib/format.js';
import { SUB_WORK_TYPE_OPTIONS } from './WorkTypes.jsx';
import Breadcrumb from '../../components/Breadcrumb.jsx';
import PhotoDownloadButton from '../../components/PhotoDownloadButton.jsx';
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

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await api.getInspection(id, accessToken);
      setRecord(data);
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
          <Link to="/portal/inspection/my" className="btn btn-secondary btn-sm" style={{ marginTop: '1rem' }}>
            ← Back to my records
          </Link>
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
              label: `${typeMeta?.label || record.inspectionType}${record.projectName ? ` · ${record.projectName}` : ''}`,
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
              {record.projectName} · {record.location}
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

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.75rem', marginBottom: '1.5rem', fontSize: '0.85rem' }}>
          <div><strong>Date:</strong> {formatIndianDate(record.reportDate)}</div>
          {record.weather && <div><strong>Weather:</strong> {record.weather}</div>}
          {record.contractor && <div><strong>Contractor:</strong> {record.contractor}</div>}
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
              {record.photos.map((p) => (
                <a
                  key={p.id}
                  href={p.readUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ position: 'relative', display: 'block', aspectRatio: '1', borderRadius: 6, overflow: 'hidden', background: '#f1f5f9' }}
                  title={p.caption || 'Open photo'}
                >
                  <img
                    src={p.readUrl}
                    alt={p.caption || 'Inspection photo'}
                    loading="lazy"
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  />
                  {/* R22.5: per-image download affordance. */}
                  <PhotoDownloadButton photo={p} label="Open inspection photo" />
                </a>
              ))}
            </div>
          </div>
        )}

        <div style={{ borderTop: '1px solid #e2e8f0', paddingTop: '1rem', display: 'flex', gap: '0.5rem' }}>
          <Link to="/portal/inspection/my" className="btn btn-secondary btn-sm">
            ← Back to list
          </Link>
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
