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
        <div className="header-content">
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
                    <button className="expand-btn">
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
              <button className="modal-close" onClick={() => setSelectedRecord(null)}>×</button>
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
                    <div className="session-addr">📍 {session.checkInAddr}</div>
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

      <style>{`
        .admin-page {
          min-height: 100vh;
          background: #f8fafc;
          padding: 1rem;
          padding-bottom: 2rem;
        }
        .admin-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          margin-bottom: 1.5rem;
          gap: 1rem;
          flex-wrap: wrap;
        }
        .header-title {
          font-size: 1.5rem;
          font-weight: 600;
          color: var(--navy, #1e293b);
          margin: 0;
        }
        .header-subtitle {
          font-size: 0.875rem;
          color: var(--steel, #64748b);
          margin: 0.25rem 0 0;
        }
        .month-input {
          padding: 0.5rem 1rem;
          border-radius: 8px;
          border: 1px solid #e5e7eb;
          font-size: 0.875rem;
          background: white;
        }
        .loading-state {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 0.75rem;
          padding: 3rem;
          color: var(--steel, #64748b);
        }
        .spinner {
          width: 24px;
          height: 24px;
          border: 2px solid #e5e7eb;
          border-top-color: var(--blue, #2563eb);
          border-radius: 50%;
          animation: spin 0.8s linear infinite;
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
        .error-banner {
          padding: 1rem;
          background: #fef2f2;
          color: #dc2626;
          border-radius: 10px;
          text-align: center;
          margin-bottom: 1rem;
        }
        .empty-state {
          text-align: center;
          padding: 3rem;
          color: var(--steel, #64748b);
        }
        .empty-state svg {
          margin-bottom: 1rem;
          opacity: 0.5;
        }
        .employee-list {
          display: flex;
          flex-direction: column;
          gap: 1rem;
        }
        .employee-card {
          background: white;
          border-radius: 12px;
          overflow: hidden;
          box-shadow: 0 1px 3px rgba(0,0,0,0.1);
        }
        .employee-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 1rem;
          cursor: pointer;
        }
        .employee-info {
          display: flex;
          align-items: center;
          gap: 0.75rem;
        }
        .employee-avatar {
          width: 40px;
          height: 40px;
          border-radius: 50%;
          background: var(--blue, #2563eb);
          color: white;
          display: flex;
          align-items: center;
          justify-content: center;
          font-weight: 600;
          font-size: 1rem;
        }
        .employee-details {
          min-width: 0;
        }
        .employee-name {
          margin: 0;
          font-size: 0.95rem;
          font-weight: 600;
          color: var(--navy, #1e293b);
        }
        .employee-email {
          margin: 0;
          font-size: 0.8rem;
          color: var(--steel, #64748b);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          max-width: 180px;
        }
        .employee-meta {
          display: flex;
          align-items: center;
          gap: 0.75rem;
        }
        .employee-dept {
          font-size: 0.75rem;
          color: var(--steel, #64748b);
          display: none;
        }
        .employee-days {
          font-size: 0.75rem;
          font-weight: 600;
          color: var(--green, #16a34a);
          background: #dcfce7;
          padding: 0.25rem 0.5rem;
          border-radius: 4px;
        }
        .expand-btn {
          background: none;
          border: none;
          font-size: 0.75rem;
          color: var(--steel, #64748b);
          cursor: pointer;
          padding: 0.25rem;
        }
        .employee-records {
          border-top: 1px solid #e5e7eb;
        }
        .records-header {
          display: grid;
          grid-template-columns: 1fr 1fr 80px;
          padding: 0.75rem 1rem;
          font-size: 0.7rem;
          font-weight: 600;
          color: var(--steel, #64748b);
          text-transform: uppercase;
          background: #f8fafc;
        }
        .record-row {
          display: grid;
          grid-template-columns: 1fr 1fr 80px;
          padding: 0.75rem 1rem;
          border-top: 1px solid #f1f5f9;
          cursor: pointer;
          font-size: 0.875rem;
        }
        .record-row:hover {
          background: #f8fafc;
        }
        .record-date {
          font-weight: 500;
          color: var(--navy, #1e293b);
        }
        .record-checkin {
          color: var(--navy, #1e293b);
        }
        .record-status {
          font-size: 0.75rem;
          font-weight: 600;
          padding: 0.2rem 0.5rem;
          border-radius: 4px;
          text-align: center;
        }
        .status-open {
          background: #fef3c7;
          color: #d97706;
        }
        .status-complete {
          background: #dcfce7;
          color: #16a34a;
        }
        .modal-overlay {
          position: fixed;
          inset: 0;
          background: rgba(0,0,0,0.5);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 1000;
          padding: 1rem;
        }
        .modal {
          background: white;
          border-radius: 16px;
          width: 100%;
          max-width: 440px;
          max-height: 80vh;
          overflow-y: auto;
        }
        .modal-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          padding: 1.25rem;
          border-bottom: 1px solid #e5e7eb;
        }
        .modal-title {
          margin: 0;
          font-size: 1rem;
          font-weight: 600;
          color: var(--navy, #1e293b);
        }
        .modal-subtitle {
          margin: 0.25rem 0 0;
          font-size: 0.875rem;
          color: var(--steel, #64748b);
        }
        .modal-close {
          background: none;
          border: none;
          font-size: 1.5rem;
          cursor: pointer;
          color: var(--steel, #64748b);
          padding: 0;
          line-height: 1;
        }
        .modal-body {
          padding: 1.25rem;
        }
        .session-card {
          padding: 1rem;
          background: #f8fafc;
          border-radius: 12px;
          margin-bottom: 0.75rem;
        }
        .session-title {
          font-size: 0.75rem;
          font-weight: 600;
          color: var(--steel, #64748b);
          margin-bottom: 0.5rem;
        }
        .session-times {
          display: flex;
          gap: 1.5rem;
        }
        .session-time-item {
          display: flex;
          flex-direction: column;
        }
        .time-label {
          font-size: 0.7rem;
          color: var(--steel, #64748b);
        }
        .time-value {
          font-size: 0.9rem;
          font-weight: 600;
          color: var(--navy, #1e293b);
        }
        .session-addr {
          font-size: 0.8rem;
          color: var(--steel, #64748b);
          margin-top: 0.5rem;
        }
        .session-map {
          margin-top: 0.75rem;
          border-radius: 8px;
          overflow: hidden;
          background: #e5e7eb;
        }
        @media (max-width: 480px) {
          .admin-header {
            flex-direction: column;
          }
          .employee-email {
            max-width: 140px;
          }
          .employee-dept {
            display: none !important;
          }
          .records-header,
          .record-row {
            grid-template-columns: 1fr 1fr 60px;
            font-size: 0.8rem;
          }
        }
      `}</style>
    </div>
  );
}
