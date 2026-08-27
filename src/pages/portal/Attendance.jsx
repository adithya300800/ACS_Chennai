import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { api } from '../../lib/api.js';

export default function Attendance() {
  const { accessToken, employee } = useAuth();
  const [todayRecord, setTodayRecord] = useState(null);
  const [monthRecords, setMonthRecords] = useState([]);
  const [currentMonth, setCurrentMonth] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  });
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');
  const [selectedDate, setSelectedDate] = useState(null);

  // Get active (open) session from today's record
  const getActiveSession = () => {
    if (!todayRecord?.sessions) return null;
    return todayRecord.sessions.find(s => !s.checkOut) || null;
  };

  const activeSession = getActiveSession();

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

  // Merge today's record into month records if it's for current month
  useEffect(() => {
    if (!todayRecord) return;
    const todayStr = toDateString(todayRecord.date);
    const [year, month] = currentMonth.split('-').map(Number);
    const todayDate = new Date(todayStr);
    if (todayDate.getFullYear() === year && todayDate.getMonth() + 1 === month) {
      setMonthRecords(prev => {
        const exists = prev.some(r => r.id === todayRecord.id);
        if (exists) return prev;
        return [...prev, todayRecord];
      });
    }
  }, [todayRecord, currentMonth]);

  // Format time in user's timezone
  const formatTime = (dateStr) => {
    if (!dateStr) return '';
    return new Date(dateStr).toLocaleTimeString('en-IN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });
  };

  // Format date for display
  const formatDate = (dateStr) => {
    if (!dateStr) return '';
    return new Date(dateStr).toLocaleDateString('en-IN', {
      weekday: 'short',
      day: 'numeric',
      month: 'short'
    });
  };

  // Get embedded map URL for OpenStreetMap
  const getMapUrl = (lat, lng) => {
    if (!lat || !lng || lat === 0 || lng === 0) return null;
    return `https://www.openstreetmap.org/export/embed.html?bbox=${lng - 0.005},${lat - 0.005},${lng + 0.005},${lat + 0.005}&layer=mapnik&marker=${lat},${lng}`;
  };

  // Request geolocation
  const requestLocation = () => {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error('Geolocation not supported'));
        return;
      }

      navigator.geolocation.getCurrentPosition(
        (pos) => {
          resolve({
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
          });
        },
        (err) => {
          reject(new Error('Unable to get location'));
        },
        { enableHighAccuracy: false, timeout: 15000 }
      );
    });
  };

  // Handle check-in only
  const handleCheckIn = async () => {
    setStatus('checking-in');
    setError('');

    try {
      let lat = 0, lng = 0, addr = 'Location unavailable';

      try {
        const coords = await requestLocation();
        lat = coords.latitude;
        lng = coords.longitude;
        // Format location as coordinates with direction
        const latDir = lat >= 0 ? 'N' : 'S';
        const lngDir = lng >= 0 ? 'E' : 'W';
        addr = `${Math.abs(lat).toFixed(4)}°${latDir}, ${Math.abs(lng).toFixed(4)}°${lngDir}`;
      } catch {
        // Use default if geolocation fails
      }

      // Send local date in YYYY-MM-DD format
      const todayLocal = new Date();
      const localDate = `${todayLocal.getFullYear()}-${String(todayLocal.getMonth() + 1).padStart(2, '0')}-${String(todayLocal.getDate()).padStart(2, '0')}`;

      const data = await api.post('/attendance/check-in', { latitude: lat, longitude: lng, address: addr, date: localDate }, accessToken);
      setTodayRecord(data);
      setStatus('idle');
      fetchMonth();
    } catch (err) {
      setStatus('idle');
      setError(err.message || 'Check-in failed');
    }
  };

  // Normalize date to YYYY-MM-DD string in local timezone
  const toDateString = (date) => {
    const d = new Date(date);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  // Build calendar data
  const buildCalendar = () => {
    const [year, month] = currentMonth.split('-').map(Number);

    // First day of month (0=Sun)
    const firstDay = new Date(year, month - 1, 1).getDay();
    // Days in month
    const daysInMonth = new Date(year, month, 0).getDate();

    // Create a map of date strings to records
    const recordMap = {};
    monthRecords.forEach(r => {
      const dateStr = toDateString(r.date);
      if (!recordMap[dateStr] || r.sessions.length > 0) {
        recordMap[dateStr] = r;
      }
    });

    const weeks = [];
    let week = [];

    // Empty cells before first day
    for (let i = 0; i < firstDay; i++) {
      week.push(null);
    }

    // Days of the month
    for (let day = 1; day <= daysInMonth; day++) {
      const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const record = recordMap[dateStr];
      week.push({ day, record, dateStr });

      if (week.length === 7) {
        weeks.push(week);
        week = [];
      }
    }

    // Fill remaining cells
    while (week.length > 0 && week.length < 7) {
      week.push(null);
    }
    if (week.length > 0) {
      weeks.push(week);
    }

    return weeks;
  };

  const weeks = buildCalendar();
  const [calYear, calMonth] = currentMonth.split('-').map(Number);
  const monthLabel = new Date(calYear, calMonth - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
  const today = new Date();
  const todayDateStr = toDateString(today);

  return (
    <div className="attendance-page">
      <div className="attendance-page-header">
        <h2 className="attendance-page-title">Attendance</h2>
        <p className="attendance-page-sub">Mark your daily attendance with location</p>
      </div>

      {/* Check-in Card */}
      <div className="attendance-card">
        <div className="attendance-card-date">
          {today.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
        </div>

        {error && (
          <div className="attendance-error">
            <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            {error}
          </div>
        )}

        {!activeSession ? (
          <div className="attendance-action">
            <button
              className="attendance-btn attendance-btn-checkin"
              onClick={handleCheckIn}
              disabled={status === 'checking-in'}
            >
              <span className="attendance-btn-icon">
                <svg width="28" height="28" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                  <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z" /><circle cx="12" cy="10" r="3" />
                </svg>
              </span>
              {status === 'checking-in' ? 'Marking...' : 'Mark Attendance'}
            </button>
            <p className="attendance-action-hint">
              Your GPS location will be captured when you mark attendance
            </p>
          </div>
        ) : (
          <div className="attendance-completed">
            <div className="attendance-completed-badge">
              <svg width="20" height="20" fill="none" stroke="#16A34A" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                <path d="M20 6L9 17l-5-5" />
              </svg>
              Attendance Marked
            </div>
            <div className="attendance-checkin-info">
              <div className="attendance-checkin-time">
                <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                  <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
                </svg>
                Marked at {formatTime(activeSession.checkIn)}
              </div>
              {activeSession.checkInAddr && activeSession.checkInAddr !== 'Location unavailable' && (
                <div className="attendance-checkin-loc">
                  <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                    <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z" /><circle cx="12" cy="10" r="3" />
                  </svg>
                  {activeSession.checkInAddr}
                </div>
              )}
            </div>

            {/* Map */}
            {activeSession.checkInLat && activeSession.checkInLng && getMapUrl(parseFloat(activeSession.checkInLat), parseFloat(activeSession.checkInLng)) && (
              <div className="attendance-map">
                <iframe
                  title="Your location"
                  width="100%"
                  height="200"
                  frameBorder="0"
                  scrolling="no"
                  marginHeight="0"
                  marginWidth="0"
                  src={getMapUrl(parseFloat(activeSession.checkInLat), parseFloat(activeSession.checkInLng))}
                  style={{ border: 0, borderRadius: '12px' }}
                />
              </div>
            )}
          </div>
        )}
      </div>

      {/* Calendar */}
      <div className="attendance-calendar">
        <div className="attendance-calendar-header">
          <button onClick={() => {
            const [y, m] = currentMonth.split('-').map(Number);
            const prev = new Date(y, m - 2, 1);
            setCurrentMonth(`${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`);
          }} className="attendance-calendar-nav">‹</button>
          <span className="attendance-calendar-month">{monthLabel}</span>
          <button onClick={() => {
            const [y, m] = currentMonth.split('-').map(Number);
            const next = new Date(y, m, 1);
            setCurrentMonth(`${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}`);
          }} className="attendance-calendar-nav">›</button>
        </div>

        <div className="attendance-calendar-grid">
          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d, i) => (
            <div key={i} className="attendance-calendar-day-label">{d}</div>
          ))}
          {weeks.flat().map((item, i) => {
            if (!item) {
              return <div key={i} className="attendance-calendar-cell attendance-calendar-cell-empty" />;
            }

            const { day, record, dateStr } = item;
            const hasRecord = record?.sessions?.length > 0;
            const isToday = dateStr === todayDateStr;
            const isSelected = selectedDate && toDateString(selectedDate.date) === dateStr;

            return (
              <div
                key={i}
                onClick={() => hasRecord && setSelectedDate(record)}
                className={`attendance-calendar-cell ${hasRecord ? 'has-record' : ''} ${isToday ? 'is-today' : ''} ${isSelected ? 'is-selected' : ''}`}
              >
                <span className="attendance-calendar-day-num">{day}</span>
                {hasRecord && (
                  <div className="attendance-calendar-checkin">
                    {formatTime(record.sessions[0].checkIn)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Date Detail Modal */}
      {selectedDate && (
        <div className="modal-overlay" onClick={() => setSelectedDate(null)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{new Date(selectedDate.date).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</h3>
              <button onClick={() => setSelectedDate(null)} className="modal-close">×</button>
            </div>

            {selectedDate.sessions.map((session, i) => (
              <div key={session.id} className="session-card">
                <div className="session-title">Session {i + 1}</div>
                <div className="session-time">
                  <span>🕐 {formatTime(session.checkIn)}</span>
                  {session.checkOut && <span> → {formatTime(session.checkOut)}</span>}
                </div>
                {session.checkInAddr && (
                  <div className="session-addr">📍 {session.checkInAddr}</div>
                )}

                {session.checkInLat && session.checkInLng && getMapUrl(parseFloat(session.checkInLat), parseFloat(session.checkInLng)) && (
                  <div className="session-map">
                    <iframe
                      title="Session location"
                      width="100%"
                      height="180"
                      frameBorder="0"
                      scrolling="no"
                      marginHeight="0"
                      marginWidth="0"
                      src={getMapUrl(parseFloat(session.checkInLat), parseFloat(session.checkInLng))}
                      style={{ border: 0, borderRadius: '8px' }}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <style>{`
        .attendance-page {
          padding: 1.5rem;
          max-width: 600px;
          margin: 0 auto;
          background: #f8fafc;
          min-height: 100vh;
        }
        .attendance-page-header {
          margin-bottom: 1.5rem;
        }
        .attendance-page-title {
          font-size: 1.5rem;
          font-weight: 600;
          color: var(--navy);
          margin: 0 0 0.25rem 0;
        }
        .attendance-page-sub {
          color: var(--steel);
          font-size: 0.875rem;
          margin: 0;
        }
        .attendance-card {
          background: white;
          border-radius: 16px;
          padding: 1.5rem;
          box-shadow: 0 2px 8px rgba(0,0,0,0.08);
          margin-bottom: 1.5rem;
        }
        .attendance-card-date {
          font-size: 0.875rem;
          color: var(--steel);
          margin-bottom: 1rem;
        }
        .attendance-error {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          color: #DC2626;
          font-size: 0.875rem;
          margin-bottom: 1rem;
          padding: 0.75rem;
          background: #FEF2F2;
          border-radius: 8px;
        }
        .attendance-action {
          text-align: center;
          padding: 1rem 0;
        }
        .attendance-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 0.5rem;
          padding: 1rem 2.5rem;
          border-radius: 12px;
          font-size: 1.1rem;
          font-weight: 600;
          border: none;
          cursor: pointer;
          transition: all 0.2s;
          width: 100%;
        }
        .attendance-btn:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }
        .attendance-btn-checkin {
          background: var(--blue);
          color: white;
        }
        .attendance-btn-checkin:hover:not(:disabled) {
          background: #1D4ED8;
        }
        .attendance-btn-icon {
          display: flex;
        }
        .attendance-action-hint {
          font-size: 0.75rem;
          color: var(--steel);
          margin-top: 0.75rem;
        }
        .attendance-completed {
          text-align: center;
        }
        .attendance-completed-badge {
          display: inline-flex;
          align-items: center;
          gap: 0.5rem;
          padding: 0.5rem 1rem;
          background: #DCFCE7;
          color: #16A34A;
          border-radius: 20px;
          font-size: 0.875rem;
          font-weight: 600;
          margin-bottom: 1rem;
        }
        .attendance-checkin-info {
          display: flex;
          flex-direction: column;
          gap: 0.5rem;
          text-align: left;
        }
        .attendance-checkin-time {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          font-size: 1rem;
          font-weight: 500;
          color: var(--navy);
        }
        .attendance-checkin-loc {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          font-size: 0.875rem;
          color: var(--steel);
        }
        .attendance-map {
          margin-top: 1rem;
          border-radius: 12px;
          overflow: hidden;
          background: #f0f0f0;
        }
        .attendance-calendar {
          background: white;
          border-radius: 16px;
          padding: 1.5rem;
          box-shadow: 0 2px 8px rgba(0,0,0,0.08);
        }
        .attendance-calendar-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 1rem;
        }
        .attendance-calendar-nav {
          background: #f1f5f9;
          border: none;
          font-size: 1.25rem;
          cursor: pointer;
          color: var(--blue);
          padding: 0.5rem 1rem;
          border-radius: 8px;
        }
        .attendance-calendar-month {
          font-weight: 600;
          color: var(--navy);
          font-size: 1rem;
        }
        .attendance-calendar-grid {
          display: grid;
          grid-template-columns: repeat(7, 1fr);
          gap: 0.35rem;
        }
        .attendance-calendar-day-label {
          text-align: center;
          font-size: 0.7rem;
          font-weight: 600;
          color: var(--steel);
          padding: 0.5rem 0;
          text-transform: uppercase;
        }
        .attendance-calendar-cell {
          aspect-ratio: 1;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          border-radius: 10px;
          cursor: default;
          background: #f8fafc;
          min-height: 56px;
          transition: all 0.2s;
        }
        .attendance-calendar-cell-empty {
          background: transparent;
        }
        .attendance-calendar-cell.has-record {
          background: #DCFCE7;
          cursor: pointer;
        }
        .attendance-calendar-cell.has-record:hover {
          background: #bbf7d0;
        }
        .attendance-calendar-cell.is-today {
          border: 2px solid var(--blue);
        }
        .attendance-calendar-cell.is-today.has-record {
          background: #bbf7d0;
        }
        .attendance-calendar-cell.is-selected {
          background: #dbeafe !important;
          border: 2px solid var(--blue);
        }
        .attendance-calendar-day-num {
          font-size: 0.8rem;
          font-weight: 500;
          color: var(--navy);
        }
        .attendance-calendar-cell-empty .attendance-calendar-day-num {
          visibility: hidden;
        }
        .attendance-calendar-checkin {
          font-size: 0.6rem;
          color: #16A34A;
          font-weight: 600;
          margin-top: 2px;
        }
        .modal-overlay {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: rgba(0,0,0,0.5);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 1000;
          padding: 1rem;
        }
        .modal-content {
          background: white;
          border-radius: 16px;
          padding: 1.5rem;
          max-width: 450px;
          width: 100%;
          max-height: 80vh;
          overflow-y: auto;
        }
        .modal-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 1rem;
        }
        .modal-header h3 {
          margin: 0;
          color: var(--navy);
          font-size: 1rem;
        }
        .modal-close {
          background: none;
          border: none;
          font-size: 1.5rem;
          cursor: pointer;
          color: var(--steel);
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
          color: var(--steel);
          margin-bottom: 0.5rem;
        }
        .session-time {
          font-size: 0.9rem;
          font-weight: 500;
          color: var(--navy);
        }
        .session-addr {
          font-size: 0.8rem;
          color: var(--steel);
          margin-top: 0.25rem;
        }
        .session-map {
          margin-top: 0.75rem;
          border-radius: 8px;
          overflow: hidden;
          background: #e5e7eb;
        }
      `}</style>
    </div>
  );
}
