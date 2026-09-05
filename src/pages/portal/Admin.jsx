import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { api } from '../../lib/api.js';
import { formatDate, formatFullDate, formatMonthLabel, formatTimeOrDash, getMapUrl } from '../../lib/format.js';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';

// (Round-15+ C-03: format helpers moved to src/lib/format.js. Admin.jsx
// originally returned '—' for null formatTime callsites, so we import
// formatTimeOrDash to preserve that exact behavior.)

const formatTime = formatTimeOrDash;

// Round-17 B-05: helper used both for the initial state and for the
// "Jump to today" button so the two never drift.
function getCurrentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

export default function Admin() {
  useDocumentTitle('All Attendance');
  const { employee, accessToken } = useAuth();
  const { push } = useToast();
  const navigate = useNavigate();
  const [month, setMonth] = useState(getCurrentMonth);
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selectedRecord, setSelectedRecord] = useState(null);
  const [expandedEmployee, setExpandedEmployee] = useState(null);
  const [exporting, setExporting] = useState(false);
  const exportUrlRef = useRef(null);

  // Cleanup blob URLs on unmount — avoid leaking object URLs across navigations.
  useEffect(() => {
    return () => {
      if (exportUrlRef.current) {
        URL.revokeObjectURL(exportUrlRef.current);
        exportUrlRef.current = null;
      }
    };
  }, []);

  // Round-17 D-06: OSM's slippy-map tiles use THREE.WebGLRenderer under the
  // hood and emit noisy "GPU stall" / WebGL fallback warnings in dev mode.
  // These don't indicate a real bug — suppress them only in dev so prod
  // console stays untouched.
  useEffect(() => {
    if (!import.meta.env.DEV) return undefined;
    const origWarn = console.warn;
    console.warn = (...args) => {
      const msg = String(args[0] || '');
      if (msg.includes('THREE.WebGLRenderer') || msg.includes('GPU stall')) return;
      origWarn.apply(console, args);
    };
    return () => {
      console.warn = origWarn;
    };
  }, []);

  const fetchAttendance = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      // Round-7: route through api.js so this fetch inherits the timeout
      // wrapper, the 401 auto-refresh, and the auth:logout dispatch on
      // TOKEN_INVALID. The previous raw fetch would hang on a server stall,
      // surface raw "Failed to fetch" on auth expiry, and bypass the
      // single-fire logout dispatch entirely.
      const data = await api.get(`/attendance/all?month=${month}`, accessToken);
      setRecords(data);
    } catch (err) {
      setError(err.message || 'Failed to load attendance data');
    } finally {
      setLoading(false);
    }
  }, [month, accessToken]);

  useEffect(() => {
    if (!employee?.isAdmin) {
      navigate('/portal/attendance');
      return;
    }
    fetchAttendance();
  }, [month, accessToken, employee?.isAdmin, navigate, fetchAttendance]);

  // Round-13: download the current month as XLSX. The api.download() helper
  // returns a Blob + filename from Content-Disposition; we wrap it in a
  // transient <a download> click and revoke the object URL after.
  const handleExportMonth = async () => {
    setExporting(true);
    try {
      const { blob, filename, format, rowCount } = await api.downloadTimesheet(month, accessToken);
      if (exportUrlRef.current) URL.revokeObjectURL(exportUrlRef.current);
      const url = URL.createObjectURL(blob);
      exportUrlRef.current = url;
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
      const note = format === 'csv-fallback'
        ? `Downloaded as CSV (Excel library unavailable). ${rowCount} rows.`
        : `Downloaded ${rowCount} rows.`;
      push(note, 'success');
    } catch (err) {
      const code = err && err.code;
      let msg = err.message || 'Export failed';
      if (code === 'EXPORT_THROTTLED') msg = 'Too many exports — please wait a minute.';
      else if (err.status === 403) msg = 'Admin access required.';
      push(msg, 'error');
    } finally {
      setExporting(false);
    }
  };

  const handleExportEmployee = async (empId, empName) => {
    setExporting(true);
    try {
      const { blob, filename } = await api.downloadTimesheet(month, accessToken, { employeeId: empId });
      if (exportUrlRef.current) URL.revokeObjectURL(exportUrlRef.current);
      const url = URL.createObjectURL(blob);
      exportUrlRef.current = url;
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
      push(`Downloaded timesheet for ${empName}.`, 'success');
    } catch (err) {
      push(err.message || 'Export failed', 'error');
    } finally {
      setExporting(false);
    }
  };

  // Group by employee
  const byEmployee = records.reduce((acc, r) => {
    const empId = r.employee.id;
    if (!acc[empId]) acc[empId] = { ...r.employee, records: [] };
    acc[empId].records.push(r);
    return acc;
  }, {});

  const monthLabel = formatMonthLabel(month)
    || new Date(`${month}-15`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });

  return (
    <div className="admin-page">
      {/* Header */}
      <div className="admin-header">
        <div>
          <h1 className="header-title" aria-label="All Attendance">All Attendance</h1>
          <p className="header-subtitle">Monitor all employees' attendance</p>
        </div>
        <div className="admin-header-actions">
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="month-input"
            aria-label="Select month"
          />
          {/* Round-17 B-05: shortcut back to the current month so an admin
              doesn't have to remember which month they last picked. Disabled
              when already there to avoid a pointless re-fetch. */}
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => setMonth(getCurrentMonth())}
            disabled={month === getCurrentMonth()}
          >
            Jump to today
          </button>
          <button
            type="button"
            className="admin-export-btn"
            onClick={handleExportMonth}
            disabled={exporting}
            aria-label={`Download ${monthLabel} timesheet as Excel`}
          >
            {exporting ? (
              <>
                <span className="spinner"></span>
                Preparing...
              </>
            ) : (
              <>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                Download Timesheet
              </>
            )}
          </button>
        </div>
      </div>

      {/* Loading */}
      {loading && (
        <div className="loading-state">
          <div className="spinner"></div>
          <span>Loading attendance data...</span>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="error-banner">{error}</div>
      )}

      {/* Empty State */}
      {!loading && !error && records.length === 0 && (
        <div className="empty-state">
          <svg width="48" height="48" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
          </svg>
          <p>No attendance records for {monthLabel}</p>
        </div>
      )}

      {/* Employee Cards */}
      {!loading && !error && Object.values(byEmployee).length > 0 && (
        <div className="employee-list">
          {Object.values(byEmployee).map((emp) => {
            const isExpanded = expandedEmployee === emp.id;
            const daysWorked = emp.records.filter(r => r.sessions.length > 0).length;

            return (
              <div key={emp.id} className="employee-card">
                <div
                  className="employee-header"
                  onClick={() => setExpandedEmployee(isExpanded ? null : emp.id)}
                >
                  <div className="employee-info">
                    <div className="employee-avatar">
                      {emp.name.charAt(0).toUpperCase()}
                    </div>
                    <div className="employee-details">
                      <h3 className="employee-name">{emp.name}</h3>
                      <p className="employee-email">{emp.email}</p>
                    </div>
                  </div>
                  <div className="employee-meta">
                    <span className="employee-dept">{emp.department || 'No dept'}</span>
                    <span className="employee-days">{daysWorked} days</span>
                    <button
                      type="button"
                      className="employee-export-btn"
                      title={`Download ${emp.name}'s timesheet`}
                      aria-label={`Download ${emp.name}'s timesheet as Excel`}
                      onClick={(e) => { e.stopPropagation(); handleExportEmployee(emp.id, emp.name); }}
                      disabled={exporting}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                        <polyline points="7 10 12 15 17 10" />
                        <line x1="12" y1="15" x2="12" y2="3" />
                      </svg>
                    </button>
                    <button
                      className="expand-btn"
                      aria-label={isExpanded ? 'Collapse record' : 'Expand record'}
                      aria-expanded={isExpanded}
                    >
                      {isExpanded ? '▲' : '▼'}
                    </button>
                  </div>
                </div>

                {isExpanded && (
                  <div className="employee-records">
                    <div className="records-header">
                      <span>Date</span>
                      <span>First Check-in</span>
                      <span>Check-ins</span>
                    </div>
                    {emp.records.map((rec) => {
                      const firstSession = rec.sessions[0];
                      const sessionCount = rec.sessions.length;

                      return (
                        <div
                          key={rec.id}
                          className="record-row"
                          onClick={() => setSelectedRecord({ ...rec, employee: emp })}
                        >
                          <span className="record-date">{formatDate(rec.date)}</span>
                          <span className="record-checkin">
                            {firstSession ? formatTime(firstSession.checkIn) : '—'}
                          </span>
                          <span className="record-status status-complete">
                            {sessionCount} {sessionCount === 1 ? 'check-in' : 'check-ins'}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Detail Modal */}
      {selectedRecord && (
        <div className="modal-overlay" onClick={() => setSelectedRecord(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <h3 className="modal-title">{selectedRecord.employee.name}</h3>
                <p className="modal-subtitle">{formatFullDate(selectedRecord.date)}</p>
              </div>
              <button className="modal-close" aria-label="Close modal" onClick={() => setSelectedRecord(null)}>×</button>
            </div>
            <div className="modal-body">
              {selectedRecord.sessions.map((session, i) => (
                <div key={session.id} className="session-card">
                  <div className="session-title">Session {i + 1}</div>
                  <div className="session-times">
                    <div className="session-time-item">
                      <span className="time-label">Check-in</span>
                      <span className="time-value">{formatTime(session.checkIn)}</span>
                    </div>
                    {session.checkOut && (
                      <div className="session-time-item">
                        <span className="time-label">Check-out</span>
                        <span className="time-value">{formatTime(session.checkOut)}</span>
                      </div>
                    )}
                  </div>
                  {session.checkInAddr && (
                    <div className="session-addr">
                      <svg width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" style={{verticalAlign:'middle',marginRight:'4px'}} aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>
                      {session.checkInAddr}
                    </div>
                  )}
                  {session.checkInLat && session.checkInLng && getMapUrl(parseFloat(session.checkInLat), parseFloat(session.checkInLng)) && (
                    <div className="session-map">
                      <iframe
                        title="Location"
                        width="100%"
                        height="160"
                        frameBorder="0"
                        scrolling="no"
                        loading="lazy"
                        src={getMapUrl(parseFloat(session.checkInLat), parseFloat(session.checkInLng))}
                        style={{ border: 0, borderRadius: '8px' }}
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
