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

  // Format time in user's timezone
  const formatTime = (dateStr) => {
    if (!dateStr) return '';
    return new Date(dateStr).toLocaleTimeString('en-IN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });
  };

  // Format location as coordinates
  const formatLocation = (lat, lng) => {
    if (!lat || !lng) return '';
    const latDir = lat >= 0 ? 'N' : 'S';
    const lngDir = lng >= 0 ? 'E' : 'W';
    return `${Math.abs(lat).toFixed(4)}°${latDir}, ${Math.abs(lng).toFixed(4)}°${lngDir}`;
  };

  // Get embedded map URL for OpenStreetMap
  const getMapUrl = (lat, lng) => {
    if (!lat || !lng || lat === 0 || lng === 0) return null;
    return `https://www.openstreetmap.org/export/embed.html?bbox=${lng - 0.01},${lat - 0.01},${lng + 0.01},${lat + 0.01}&layer=mapnik&marker=${lat},${lng}`;
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

  // Handle check-in
  const handleCheckIn = async () => {
    setStatus('checking-in');
    setError('');

    try {
      let lat = 0, lng = 0, addr = 'Location unavailable';

      try {
        const coords = await requestLocation();
        lat = coords.latitude;
        lng = coords.longitude;
        addr = formatLocation(lat, lng);
      } catch {
        // Use default if geolocation fails
      }

      const data = await api.post('/attendance/check-in', { latitude: lat, longitude: lng, address: addr }, accessToken);
      setTodayRecord(data);
      setStatus('idle');
      fetchMonth();
    } catch (err) {
      setStatus('idle');
      setError(err.message || 'Check-in failed');
    }
  };

  // Handle check-out
  const handleCheckOut = async () => {
    if (!activeSession?.id) return;
    setStatus('checking-out');
    setError('');

    try {
      let lat = 0, lng = 0, addr = 'Location unavailable';

      try {
        const coords = await requestLocation();
        lat = coords.latitude;
        lng = coords.longitude;
        addr = formatLocation(lat, lng);
      } catch {
        // Use default if geolocation fails
      }

      const data = await api.put(`/attendance/check-out/${activeSession.id}`, { latitude: lat, longitude: lng, address: addr }, accessToken);
      setTodayRecord(data);
      setStatus('idle');
      fetchMonth();
    } catch (err) {
      setStatus('idle');
      setError(err.message || 'Check-out failed');
    }
  };

  // Build calendar data
  const buildCalendar = () => {
    const [year, month] = currentMonth.split('-').map(Number);
    const firstDay = new Date(year, month - 1, 1).getDay();
    const daysInMonth = new Date(year, month, 0).getDate();

    const recordMap = {};
    monthRecords.forEach((r) => {
      const d = new Date(r.date);
      recordMap[d.getDate()] = r;
    });

    const weeks = [];
    let week = Array(firstDay).fill(null);

    for (let day = 1; day <= daysInMonth; day++) {
      week.push({ day, record: recordMap[day] || null });
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
  const monthLabel = new Date(currentMonth + '-01').toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });

  return (
    <div className="attendance-page">
      <div className="attendance-page-header">
        <h2 className="attendance-page-title">Attendance</h2>
        <p className="attendance-page-sub">Mark your daily attendance with location</p>
      </div>

      {/* Check-in / Check-out Card */}
      <div className="attendance-card">
        <div className="attendance-card-date">
          {new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
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
          // Not checked in - show Check In button
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
              {status === 'checking-in' ? 'Checking In...' : 'Check In'}
            </button>
            <p className="attendance-action-hint">
              Your GPS location will be captured when you check in
            </p>
          </div>
        ) : (
          // Checked in - show status with check-out
          <div className="attendance-status">
            <div className="attendance-checkin-info">
              <div className="attendance-checkin-time">
                <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                  <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
                </svg>
                Checked in at {formatTime(activeSession.checkIn)}
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

            {/* Mini Map */}
            {activeSession.checkInLat && activeSession.checkInLng && (
              <div className="attendance-map-mini">
                <iframe
                  title="Check-in location"
                  width="100%"
                  height="150"
                  frameBorder="0"
                  scrolling="no"
                  marginHeight="0"
                  marginWidth="0"
                  src={getMapUrl(parseFloat(activeSession.checkInLat), parseFloat(activeSession.checkInLng))}
                  style={{ border: 0, borderRadius: '8px' }}
                />
              </div>
            )}

            <button
              className="attendance-btn attendance-btn-checkout"
              onClick={handleCheckOut}
              disabled={status === 'checking-out'}
            >
              <span className="attendance-btn-icon">
                <svg width="28" height="28" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                  <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z" /><circle cx="12" cy="10" r="3" />
                </svg>
              </span>
              {status === 'checking-out' ? 'Checking Out...' : 'Check Out'}
            </button>
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
          }} className="attendance-calendar-nav">
            ‹
          </button>
          <span className="attendance-calendar-month">{monthLabel}</span>
          <button onClick={() => {
            const [y, m] = currentMonth.split('-').map(Number);
            const next = new Date(y, m, 1);
            setCurrentMonth(`${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}`);
          }} className="attendance-calendar-nav">
            ›
          </button>
        </div>

        <div className="attendance-calendar-grid">
          {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
            <div key={i} className="attendance-calendar-day-label">{d}</div>
          ))}
          {weeks.flat().map((item, i) => (
            <div key={i} className={`attendance-calendar-cell ${item?.record ? 'attendance-calendar-cell-active' : ''}`}>
              {item?.day || ''}
              {item?.record && (
                <div className="attendance-calendar-dot present" title="Present" />
              )}
            </div>
          ))}
        </div>
      </div>

      <style>{`
        .attendance-page {
          padding: 1.5rem;
          max-width: 600px;
          margin: 0 auto;
        }
        .attendance-page-header {
          margin-bottom: 1.5rem;
        }
        .attendance-page-title {
          font-size: 1.5rem;
          font-weight: 600;
          color: var(--dark);
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
          box-shadow: 0 1px 3px rgba(0,0,0,0.1);
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
          gap: 0.5rem;
          padding: 1rem 2rem;
          border-radius: 12px;
          font-size: 1rem;
          font-weight: 600;
          border: none;
          cursor: pointer;
          transition: all 0.2s;
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
        .attendance-btn-checkout {
          background: var(--green);
          color: white;
          width: 100%;
          justify-content: center;
        }
        .attendance-btn-checkout:hover:not(:disabled) {
          background: #15803D;
        }
        .attendance-btn-icon {
          display: flex;
        }
        .attendance-action-hint {
          font-size: 0.75rem;
          color: var(--steel);
          margin-top: 0.75rem;
        }
        .attendance-status {
          display: flex;
          flex-direction: column;
          gap: 1rem;
        }
        .attendance-checkin-info {
          display: flex;
          flex-direction: column;
          gap: 0.5rem;
        }
        .attendance-checkin-time {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          font-size: 1rem;
          font-weight: 500;
          color: var(--dark);
        }
        .attendance-checkin-loc {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          font-size: 0.875rem;
          color: var(--steel);
        }
        .attendance-map-mini {
          border-radius: 8px;
          overflow: hidden;
          background: #f0f0f0;
        }
        .attendance-calendar {
          background: white;
          border-radius: 16px;
          padding: 1.5rem;
          box-shadow: 0 1px 3px rgba(0,0,0,0.1);
        }
        .attendance-calendar-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 1rem;
        }
        .attendance-calendar-nav {
          background: none;
          border: none;
          font-size: 1.5rem;
          cursor: pointer;
          color: var(--blue);
          padding: 0.5rem;
        }
        .attendance-calendar-month {
          font-weight: 600;
          color: var(--dark);
        }
        .attendance-calendar-grid {
          display: grid;
          grid-template-columns: repeat(7, 1fr);
          gap: 0.25rem;
        }
        .attendance-calendar-day-label {
          text-align: center;
          font-size: 0.75rem;
          font-weight: 600;
          color: var(--steel);
          padding: 0.5rem;
        }
        .attendance-calendar-cell {
          text-align: center;
          font-size: 0.875rem;
          padding: 0.5rem;
          border-radius: 8px;
          min-height: 36px;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          position: relative;
        }
        .attendance-calendar-cell-active {
          background: #EFF6FF;
        }
        .attendance-calendar-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          position: absolute;
          bottom: 4px;
        }
        .attendance-calendar-dot.present {
          background: var(--green);
        }
      `}</style>
    </div>
  );
}
