import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { api } from '../../lib/api.js';

// Format date string to local display
const formatDate = (dateStr) => {
  if (!dateStr) return '';
  return new Date(dateStr).toLocaleDateString('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short'
  });
};

// Format full date for modal
const formatFullDate = (dateStr) => {
  if (!dateStr) return '';
  return new Date(dateStr).toLocaleDateString('en-IN', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  });
};

// Format time in 12-hour format
const formatTime = (dateStr) => {
  if (!dateStr) return '';
  return new Date(dateStr).toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });
};

// Convert Date to YYYY-MM-DD local string
const toDateString = (date) => {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

// Get OpenStreetMap embed URL
const getMapUrl = (lat, lng) => {
  if (!lat || !lng || lat === 0 || lng === 0) return null;
  return `https://www.openstreetmap.org/export/embed.html?bbox=${lng - 0.005},${lat - 0.005},${lng + 0.005},${lat + 0.005}&layer=mapnik&marker=${lat},${lng}`;
};

// Format coordinates as readable string
const formatCoords = (lat, lng) => {
  if (!lat || !lng || lat === 0 || lng === 0) return '';
  const latDir = lat >= 0 ? 'N' : 'S';
  const lngDir = lng >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(4)}°${latDir}, ${Math.abs(lng).toFixed(4)}°${lngDir}`;
};

export default function Attendance() {
  const { accessToken } = useAuth();
  const [todayRecord, setTodayRecord] = useState(null);
  const [monthRecords, setMonthRecords] = useState([]);
  const [currentMonth, setCurrentMonth] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  });
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');
  const [selectedRecord, setSelectedRecord] = useState(null);

  // Parse month for display
  const [calYear, calMonth] = currentMonth.split('-').map(Number);
  const monthLabel = new Date(calYear, calMonth - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });

  // Get today's date string
  const todayDateStr = toDateString(new Date());

  // Check if an open session exists
  const hasOpenSession = todayRecord?.sessions?.some(s => !s.checkOut);

  // Fetch today's attendance
  const fetchToday = useCallback(async () => {
    try {
      const data = await api.get('/attendance/today', accessToken);
      setTodayRecord(data);
    } catch {
      setTodayRecord(null);
    }
  }, [accessToken]);

  // Fetch month records
  const fetchMonth = useCallback(async () => {
    try {
      const data = await api.get(`/attendance?month=${currentMonth}`, accessToken);
      setMonthRecords(data || []);
    } catch {
      setMonthRecords([]);
    }
  }, [accessToken, currentMonth]);

  useEffect(() => {
    fetchToday();
    fetchMonth();
  }, [fetchToday, fetchMonth]);

  // Merge today's record into month display if same month
  useEffect(() => {
    if (!todayRecord) return;
    const todayStr = toDateString(todayRecord.date);
    if (todayStr.startsWith(currentMonth)) {
      setMonthRecords(prev => {
        const exists = prev.some(r => r.id === todayRecord.id);
        if (exists) return prev;
        return [...prev, todayRecord];
      });
    }
  }, [todayRecord, currentMonth]);

  // Request geolocation
  const requestLocation = () => {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error('Geolocation not supported'));
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
        }),
        (err) => reject(new Error('Unable to get location')),
        { enableHighAccuracy: false, timeout: 15000 }
      );
    });
  };

  // Handle check-in
  const handleCheckIn = async () => {
    setStatus('checking-in');
    setError('');

    let lat = 0, lng = 0, addr = 'Location unavailable';

    try {
      const coords = await requestLocation();
      lat = coords.latitude;
      lng = coords.longitude;
      addr = formatCoords(lat, lng);
    } catch {
      // Use default
    }

    try {
      const data = await api.post('/attendance/check-in', {
        latitude: lat,
        longitude: lng,
        address: addr
      }, accessToken);
      setTodayRecord(data);
      setStatus('idle');
      fetchMonth();
    } catch (err) {
      setStatus('idle');
      setError(err.message || 'Check-in failed');
    }
  };

  // Build calendar grid
  const buildCalendar = () => {
    const firstDay = new Date(calYear, calMonth - 1, 1).getDay();
    const daysInMonth = new Date(calYear, calMonth, 0).getDate();

    // Map records by date string
    const recordMap = {};
    monthRecords.forEach(r => {
      const dateStr = toDateString(r.date);
      recordMap[dateStr] = r;
    });

    const weeks = [];
    let week = Array(firstDay).fill(null);

    for (let day = 1; day <= daysInMonth; day++) {
      const dateStr = `${calYear}-${String(calMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      week.push({ day, dateStr, record: recordMap[dateStr] });
      if (week.length === 7) {
        weeks.push(week);
        week = [];
      }
    }

    if (week.length > 0) {
      while (week.length < 7) week.push(null);
      weeks.push(week);
    }

    return weeks;
  };

  const weeks = buildCalendar();

  return (
    <div className="attendance-page">
      {/* Header */}
      <div className="page-header">
        <h1 className="page-title">Attendance</h1>
        <p className="page-subtitle">Mark your daily attendance with location</p>
      </div>

      {/* Today's Card */}
      <div className="card today-card">
        <div className="card-date">{formatFullDate(todayDateStr)}</div>

        {error && (
          <div className="error-banner">
            <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            {error}
          </div>
        )}

        {!hasOpenSession ? (
          <div className="action-section">
            <button
              className="btn btn-primary btn-lg btn-block"
              onClick={handleCheckIn}
              disabled={status === 'checking-in'}
            >
              {status === 'checking-in' ? (
                <>
                  <span className="spinner"></span>
                  Marking...
                </>
              ) : (
                <>
                  <svg width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z" /><circle cx="12" cy="10" r="3" />
                  </svg>
                  Mark Attendance
                </>
              )}
            </button>
            <p className="hint-text">GPS location will be captured automatically</p>
          </div>
        ) : (
          <div className="marked-section">
            <div className="success-badge">
              <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                <path d="M20 6L9 17l-5-5" />
              </svg>
              Attendance Marked
            </div>

            <div className="attendance-detail">
              <div className="detail-row">
                <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
                </svg>
                <span>Marked at {formatTime(todayRecord.sessions[todayRecord.sessions.length - 1].checkIn)}</span>
              </div>
              {todayRecord.sessions[todayRecord.sessions.length - 1].checkInAddr && (
                <div className="detail-row">
                  <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z" /><circle cx="12" cy="10" r="3" />
                  </svg>
                  <span>{todayRecord.sessions[todayRecord.sessions.length - 1].checkInAddr}</span>
                </div>
              )}
            </div>

            {/* Map */}
            {todayRecord.sessions[todayRecord.sessions.length - 1].checkInLat && (
              <div className="map-container">
                <iframe
                  title="Your location"
                  width="100%"
                  height="180"
                  frameBorder="0"
                  scrolling="no"
                  src={getMapUrl(
                    parseFloat(todayRecord.sessions[todayRecord.sessions.length - 1].checkInLat),
                    parseFloat(todayRecord.sessions[todayRecord.sessions.length - 1].checkInLng)
                  )}
                  style={{ border: 0, borderRadius: '12px' }}
                />
              </div>
            )}
          </div>
        )}
      </div>

      {/* Calendar */}
      <div className="card calendar-card">
        <div className="calendar-header">
          <button
            className="btn-icon"
            onClick={() => {
              const prev = new Date(calYear, calMonth - 2, 1);
              setCurrentMonth(`${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`);
            }}
          >
            ‹
          </button>
          <span className="calendar-month-label">{monthLabel}</span>
          <button
            className="btn-icon"
            onClick={() => {
              const next = new Date(calYear, calMonth, 1);
              setCurrentMonth(`${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}`);
            }}
          >
            ›
          </button>
        </div>

        <div className="calendar-grid">
          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => (
            <div key={d} className="calendar-day-label">{d}</div>
          ))}
          {weeks.flat().map((item, i) => {
            if (!item) return <div key={i} className="calendar-cell calendar-cell-empty" />;

            const { day, dateStr, record } = item;
            const hasRecord = record?.sessions?.length > 0;
            const isToday = dateStr === todayDateStr;

            return (
              <div
                key={i}
                className={`calendar-cell ${hasRecord ? 'calendar-cell-marked' : ''} ${isToday ? 'calendar-cell-today' : ''}`}
                onClick={() => hasRecord && setSelectedRecord(record)}
              >
                <span className="calendar-day-num">{day}</span>
                {hasRecord && (
                  <span className="calendar-checkin-time">
                    {formatTime(record.sessions[0].checkIn)}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Date Detail Modal */}
      {selectedRecord && (
        <div className="modal-overlay" onClick={() => setSelectedRecord(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{formatFullDate(selectedRecord.date)}</h3>
              <button className="btn-icon modal-close" onClick={() => setSelectedRecord(null)}>×</button>
            </div>

            <div className="modal-body">
              {selectedRecord.sessions.map((session, i) => (
                <div key={session.id} className="session-item">
                  <div className="session-header">Session {i + 1}</div>
                  <div className="session-detail">
                    <span className="session-time">🕐 {formatTime(session.checkIn)}</span>
                    {session.checkOut && (
                      <span className="session-time"> → {formatTime(session.checkOut)}</span>
                    )}
                  </div>
                  {session.checkInAddr && (
                    <div className="session-addr">📍 {session.checkInAddr}</div>
                  )}
                  {session.checkInLat && (
                    <div className="session-map">
                      <iframe
                        title="Location"
                        width="100%"
                        height="150"
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
        .attendance-page {
          min-height: 100vh;
          background: #f8fafc;
          padding: 1rem;
          padding-bottom: 2rem;
        }
        .page-header {
          margin-bottom: 1rem;
        }
        .page-title {
          font-size: 1.5rem;
          font-weight: 600;
          color: var(--navy, #1e293b);
          margin: 0;
        }
        .page-subtitle {
          font-size: 0.875rem;
          color: var(--steel, #64748b);
          margin: 0.25rem 0 0;
        }
        .card {
          background: white;
          border-radius: 16px;
          padding: 1.25rem;
          box-shadow: 0 1px 3px rgba(0,0,0,0.1);
          margin-bottom: 1rem;
        }
        .card-date {
          font-size: 0.875rem;
          color: var(--steel, #64748b);
          margin-bottom: 1rem;
        }
        .error-banner {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          color: #dc2626;
          font-size: 0.875rem;
          padding: 0.75rem;
          background: #fef2f2;
          border-radius: 8px;
          margin-bottom: 1rem;
        }
        .action-section {
          text-align: center;
          padding: 0.5rem 0;
        }
        .btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 0.5rem;
          padding: 0.75rem 1.5rem;
          border-radius: 10px;
          font-size: 1rem;
          font-weight: 600;
          border: none;
          cursor: pointer;
          transition: all 0.2s;
        }
        .btn:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }
        .btn-primary {
          background: var(--blue, #2563eb);
          color: white;
        }
        .btn-primary:hover:not(:disabled) {
          background: #1d4ed8;
        }
        .btn-lg {
          padding: 1rem 2rem;
          font-size: 1.1rem;
        }
        .btn-block {
          width: 100%;
        }
        .btn-icon {
          background: #f1f5f9;
          border: none;
          font-size: 1.25rem;
          cursor: pointer;
          color: var(--blue, #2563eb);
          padding: 0.5rem 1rem;
          border-radius: 8px;
        }
        .spinner {
          width: 18px;
          height: 18px;
          border: 2px solid rgba(255,255,255,0.3);
          border-top-color: white;
          border-radius: 50%;
          animation: spin 0.8s linear infinite;
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
        .hint-text {
          font-size: 0.75rem;
          color: var(--steel, #64748b);
          margin-top: 0.75rem;
        }
        .marked-section {
          text-align: center;
        }
        .success-badge {
          display: inline-flex;
          align-items: center;
          gap: 0.5rem;
          padding: 0.5rem 1rem;
          background: #dcfce7;
          color: #16a34a;
          border-radius: 20px;
          font-size: 0.875rem;
          font-weight: 600;
          margin-bottom: 1rem;
        }
        .attendance-detail {
          text-align: left;
          padding: 0.75rem;
          background: #f8fafc;
          border-radius: 10px;
        }
        .detail-row {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          font-size: 0.875rem;
          color: var(--navy, #1e293b);
          padding: 0.25rem 0;
        }
        .map-container {
          margin-top: 1rem;
          border-radius: 12px;
          overflow: hidden;
          background: #e5e7eb;
        }
        .calendar-card {
          padding: 1rem;
        }
        .calendar-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 1rem;
        }
        .calendar-month-label {
          font-weight: 600;
          color: var(--navy, #1e293b);
        }
        .calendar-grid {
          display: grid;
          grid-template-columns: repeat(7, 1fr);
          gap: 0.35rem;
        }
        .calendar-day-label {
          text-align: center;
          font-size: 0.7rem;
          font-weight: 600;
          color: var(--steel, #64748b);
          padding: 0.5rem 0;
          text-transform: uppercase;
        }
        .calendar-cell {
          aspect-ratio: 1;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          border-radius: 10px;
          background: #f8fafc;
          min-height: 50px;
          cursor: default;
        }
        .calendar-cell-empty {
          background: transparent;
        }
        .calendar-cell-marked {
          background: #dcfce7;
          cursor: pointer;
        }
        .calendar-cell-marked:hover {
          background: #bbf7d0;
        }
        .calendar-cell-today {
          border: 2px solid var(--blue, #2563eb);
        }
        .calendar-cell-today.marked {
          background: #bbf7d0;
        }
        .calendar-day-num {
          font-size: 0.8rem;
          font-weight: 500;
          color: var(--navy, #1e293b);
        }
        .calendar-checkin-time {
          font-size: 0.55rem;
          color: #16a34a;
          font-weight: 600;
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
          max-width: 420px;
          max-height: 80vh;
          overflow-y: auto;
        }
        .modal-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 1.25rem;
          border-bottom: 1px solid #e5e7eb;
        }
        .modal-header h3 {
          margin: 0;
          font-size: 1rem;
          color: var(--navy, #1e293b);
        }
        .modal-close {
          font-size: 1.5rem;
          background: none;
          padding: 0;
        }
        .modal-body {
          padding: 1.25rem;
        }
        .session-item {
          padding: 1rem;
          background: #f8fafc;
          border-radius: 12px;
          margin-bottom: 0.75rem;
        }
        .session-header {
          font-size: 0.75rem;
          font-weight: 600;
          color: var(--steel, #64748b);
          margin-bottom: 0.5rem;
        }
        .session-detail {
          font-size: 0.9rem;
          font-weight: 500;
          color: var(--navy, #1e293b);
        }
        .session-addr {
          font-size: 0.8rem;
          color: var(--steel, #64748b);
          margin-top: 0.25rem;
        }
        .session-map {
          margin-top: 0.75rem;
          border-radius: 8px;
          overflow: hidden;
          background: #e5e7eb;
        }
        @media (max-width: 480px) {
          .attendance-page {
            padding: 0.75rem;
          }
          .card {
            padding: 1rem;
            border-radius: 12px;
          }
          .calendar-cell {
            min-height: 44px;
          }
          .calendar-day-num {
            font-size: 0.75rem;
          }
          .calendar-checkin-time {
            font-size: 0.5rem;
          }
        }
      `}</style>
    </div>
  );
}
