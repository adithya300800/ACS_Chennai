import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';

const formatDate = (dateStr) => {
  if (!dateStr) return '';
  // Handle both YYYY-MM-DD and ISO strings
  const [year, month, day] = dateStr.split('T')[0].split('-').map(Number);
  const localDate = new Date(year, month - 1, day);
  return localDate.toLocaleDateString('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short'
  });
};

const formatFullDate = (dateStr) => {
  if (!dateStr) return '';
  // Handle both YYYY-MM-DD and ISO strings
  const [year, month, day] = dateStr.split('T')[0].split('-').map(Number);
  const localDate = new Date(year, month - 1, day);
  return localDate.toLocaleDateString('en-IN', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  });
};

const formatTime = (dateStr) => {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });
};

const getMapUrl = (lat, lng) => {
  if (!lat || !lng || lat === 0 || lng === 0) return null;
  return `https://www.openstreetmap.org/export/embed.html?bbox=${lng - 0.005},${lat - 0.005},${lng + 0.005},${lat + 0.005}&layer=mapnik&marker=${lat},${lng}`;
};

export default function Admin() {
  const { employee, accessToken } = useAuth();
  const navigate = useNavigate();
  const [month, setMonth] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  });
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selectedRecord, setSelectedRecord] = useState(null);
  const [expandedEmployee, setExpandedEmployee] = useState(null);

  useEffect(() => {
    if (!employee?.isAdmin) {
      navigate('/portal/attendance');
      return;
    }
    fetchAttendance();
  }, [month]);

  const fetchAttendance = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL}/api/attendance/all?month=${month}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) throw new Error('Failed to fetch');
      const data = await res.json();
      setRecords(data);
    } catch (err) {
      setError('Failed to load attendance data');
    } finally {
      setLoading(false);
    }
  };

  // Group by employee
  const byEmployee = records.reduce((acc, r) => {
    const empId = r.employee.id;
    if (!acc[empId]) acc[empId] = { ...r.employee, records: [] };
    acc[empId].records.push(r);
    return acc;
  }, {});

  const monthLabel = new Date(month + '-01').toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });

  return (
    <div className="admin-page">
      {/* Header */}
      <div className="admin-header">
        <div>
          <h1 className="header-title">Attendance Dashboard</h1>
          <p className="header-subtitle">Monitor all employees' attendance</p>
        </div>
        <input
          type="month"
          value={month}
          onChange={(e) => setMonth(e.target.value)}
          className="month-input"
        />
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
          <svg width="48" height="48" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
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
                      <svg width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" style={{verticalAlign:'middle',marginRight:'4px'}}><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>
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
