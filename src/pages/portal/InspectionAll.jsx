import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { api } from '../../lib/api.js';
import { SUB_WORK_TYPE_OPTIONS } from './WorkTypes.jsx';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';
import { MapPinIcon, BuildingIcon, ClipboardIcon } from '../../components/Icons.jsx';

// P0/A-13: admin cross-org inspection list. The previous dead link at
// /portal/inspection/all (rendered for admins in InspectionList.jsx)
// bounced users out of the portal. This route fixes that — admins see
// every inspection record across the org.
export default function InspectionAll() {
  useDocumentTitle('All Inspection Records');
  const { accessToken } = useAuth();
  const toast = useToast();
  const [inspections, setInspections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      // /api/inspection returns the current user's records by default; for
      // an admin "all" view we add my=false to get every org record.
      const data = await api.getInspections({ limit: '100', my: 'false' }, accessToken);
      setInspections(data.inspections || []);
    } catch (err) {
      if (err.status !== 401) {
        setError(err.message || 'Failed to load all inspection records.');
        toast.push(err.message || 'Failed to load all inspection records.', 'error');
      }
    } finally {
      setLoading(false);
    }
  }, [accessToken, toast]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="dpr-page">
      <div className="dpr-page-header">
        <div>
          <h1 className="dpr-page-title">All Inspection Records</h1>
          <p className="dpr-page-sub" style={{ color: 'var(--steel)', margin: 0, fontSize: '0.9rem' }}>
            Every inspection & compliance record across the organization.
          </p>
        </div>
        <Link to="/portal/admin/inspection" className="btn btn-secondary btn-sm">
          ← Back to admin review queue
        </Link>
      </div>

      {error && <div className="portal-auth-error" style={{ marginBottom: '1rem' }}>{error}</div>}

      {loading ? (
        <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--steel)' }}>
          <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>⏳</div>
          Loading records…
        </div>
      ) : inspections.length === 0 ? (
        <div className="dpr-list-empty" style={{ textAlign: 'center', padding: '3rem' }}>
          <div style={{ marginBottom: '1rem', color: 'var(--steel)' }}>
            <ClipboardIcon size={48} />
          </div>
          <h3 style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", color: 'var(--navy)' }}>
            No inspection records yet
          </h3>
          <p style={{ color: 'var(--steel)' }}>Nothing has been submitted across the org.</p>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '1rem' }}>
          {inspections.map((insp) => {
            const typeLabel = SUB_WORK_TYPE_OPTIONS.find(s => s.value === insp.inspectionType)?.label || insp.inspectionType;
            return (
              <Link
                key={insp.id}
                to={`/portal/inspection/${insp.id}`}
                className="dpr-card"
                style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}
              >
                <div className="dpr-card-header">
                  <div>
                    <h3 className="dpr-card-title">{typeLabel}</h3>
                    <div className="dpr-card-meta" style={{ marginTop: '0.5rem' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                        <MapPinIcon size={13} style={{ color: 'var(--steel)' }} />
                        {insp.location}
                      </span>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                        <BuildingIcon size={13} style={{ color: 'var(--steel)' }} />
                        {insp.projectName}
                      </span>
                    </div>
                  </div>
                </div>
                <div style={{ fontSize: '0.8rem', color: 'var(--steel)' }}>
                  Submitted by <strong>{insp.submittedBy?.name || '—'}</strong>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
