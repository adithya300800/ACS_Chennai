import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { api } from '../../lib/api.js';
import { formatDate, formatFullDate, formatTime, toDateString, getMapUrl, formatCoords } from '../../lib/format.js';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';

// (Round-15+ C-03: format helpers moved to src/lib/format.js — the file
// is the source of truth. Behavior matches what was here verbatim.)

export default function Attendance() {
  useDocumentTitle('My Attendance');
  const { accessToken } = useAuth();
  const [todayRecord, setTodayRecord] = useState(null);
  const [monthRecords, setMonthRecords] = useState([]);
  const [currentMonth, setCurrentMonth] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  });
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');
  // Round-9 P0 #4: track geolocation permission state so we can disable the
  // check-in button instead of falling back to (0,0). Possible values:
  //   'prompt'    — permission API unsupported or still asking the user
  //   'granted'   — geolocation is allowed (set after first successful fix)
  //   'denied'    — user blocked geolocation; check-in must be disabled
  //   'error'     — geolocation API threw (no navigator.geolocation, etc.)
  //   'unsupported' — navigator.permissions.query rejected the geolocation name
  const [geoState, setGeoState] = useState('prompt');
  const [selectedRecord, setSelectedRecord] = useState(null);
  const modalRef = useRef(null);
  const closeButtonRef = useRef(null);

  // Focus trap for modal
  useEffect(() => {
    if (selectedRecord && closeButtonRef.current) {
      closeButtonRef.current.focus();
    }
  }, [selectedRecord]);

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
      const localDate = toDateString(new Date());
      const data = await api.get(`/attendance/today?localDate=${localDate}`, accessToken);
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

  // Request geolocation with retry.
  // GeolocationPositionError numeric codes (per W3C Geolocation API spec):
  //   1 = PERMISSION_DENIED
  //   2 = POSITION_UNAVAILABLE
  //   3 = TIMEOUT
  // We only retry on TIMEOUT — PERMISSION_DENIED is final (the user denied
  // the site), and POSITION_UNAVAILABLE means the device has no fix.
  const requestLocation = () => {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error('Geolocation not supported'));
        return;
      }

      const tryGetLocation = (attempt) => {
        navigator.geolocation.getCurrentPosition(
          (pos) => resolve({
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
          }),
          (err) => {
            // Round-10 fix: previously compared `err.code === err.TIMEOUT`,
            // but `err.TIMEOUT` is undefined on GeolocationPositionError
            // (it's not a static on the class). The numeric 3 IS the
            // TIMEOUT code per W3C; PERMISSION_DENIED is final.
            const isTimeout = err && err.code === 3;
            if (attempt < 2 && isTimeout) {
              tryGetLocation(attempt + 1);
            } else {
              const reason =
                err && err.code === 1 ? 'permission denied'
                : err && err.code === 2 ? 'position unavailable'
                : err && err.code === 3 ? 'timed out'
                : 'unknown';
              reject(new Error(`Location ${reason}`));
            }
          },
          { enableHighAccuracy: true, timeout: 20000, maximumAge: 30000 }
        );
      };

      tryGetLocation(1);
    });
  };

  // Handle check-in
  const handleCheckIn = async () => {
    setStatus('checking-in');
    setError('');

    // Round-10 fix: never silently fall back to (0,0) when geolocation fails.
    // Backend BE3 removed its (0,0) rejection, but the frontend still passed
    // (0,0,'Location unavailable') on geo failure — that left a stale-looking
    // location on the record. Instead, if GPS isn't available we ABORT the
    // check-in and surface a clear 'enable location' message.
    let lat, lng, addr;
    try {
      const coords = await requestLocation();
      lat = coords.latitude;
      lng = coords.longitude;
      addr = formatCoords(lat, lng);
    } catch (err) {
      setStatus('idle');
      setError(
        err && /permission/i.test(err.message)
          ? 'Location access is required to mark attendance. Please enable location for this site in your browser settings, then tap Mark Attendance again.'
          : `Could not determine your location (${err && err.message ? err.message : 'unknown'}). Move to a spot with clearer sky or enable location, then try again.`
      );
      return;
    }

    try {
      // Get employee's local datetime (ISO string in local timezone).
      // Backend now uses server time as the source of truth for checkInAt;
      // localDateTime is echoed back as `claimedLocalDateTime` for UI.
      // Round-14: also send the IANA timezone so the backend can bucket
      // the attendance row into the user's LOCAL calendar day. Without
      // this, a PST user checking in at 23:00 PST would land in the next
      // IST day — off-by-one date bug fixed in round-14.
      const localDateTime = new Date().toISOString();
      const clientTimezone =
        typeof Intl !== 'undefined'
          ? Intl.DateTimeFormat().resolvedOptions().timeZone
          : undefined;

      const data = await api.post('/attendance/check-in', {
        latitude: lat,
        longitude: lng,
        address: addr,
        localDateTime,
        clientTimezone,
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
      <div className="attendance-page-header">
        <h1 className="attendance-page-title">Attendance</h1>
        <p className="attendance-page-sub">Mark your daily attendance with location</p>
      </div>

      {/* Today's Card */}
      <div className="attendance-card">
        <div className="attendance-card-date">{formatFullDate(todayDateStr)}</div>

        {error && (
          <div className="attendance-error">
            <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            {error}
          </div>
        )}

        {!hasOpenSession ? (
          <div className="attendance-action">
            <button
              className="attendance-btn attendance-btn-checkin"
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
                  <span className="attendance-btn-icon">
                    <svg width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z" /><circle cx="12" cy="10" r="3" />
                    </svg>
                  </span>
                  Mark Attendance
                </>
              )}
            </button>
            <p className="attendance-action-hint">GPS location will be captured automatically</p>
          </div>
        ) : (
          <div className="attendance-completed">
            <div className="attendance-completed-badge">
              <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M20 6L9 17l-5-5" />
              </svg>
              Attendance Marked
            </div>

            <div className="attendance-checkin-info">
              <div className="attendance-checkin-time">
                <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
                </svg>
                Marked at {formatTime(todayRecord.sessions[todayRecord.sessions.length - 1].checkIn)}
              </div>
              {todayRecord.sessions[todayRecord.sessions.length - 1].checkInAddr && (
                <div className="attendance-checkin-loc">
                  <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z" /><circle cx="12" cy="10" r="3" />
                  </svg>
                  {todayRecord.sessions[todayRecord.sessions.length - 1].checkInAddr}
                </div>
              )}
            </div>

            {/* Map */}
            {todayRecord.sessions[todayRecord.sessions.length - 1].checkInLat && (
              <div style={{ marginTop: '1rem', borderRadius: '12px', overflow: 'hidden' }}>
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
      <div className="attendance-calendar">
        <div className="attendance-calendar-header">
          <button
            className="attendance-cal-nav"
            aria-label="Previous month"
            onClick={() => {
              const prev = new Date(calYear, calMonth - 2, 1);
              setCurrentMonth(`${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`);
            }}
          >
            ‹
          </button>
          <span className="attendance-cal-month">{monthLabel}</span>
          <button
            className="attendance-cal-nav"
            aria-label="Next month"
            onClick={() => {
              const next = new Date(calYear, calMonth, 1);
              setCurrentMonth(`${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}`);
            }}
          >
            ›
          </button>
        </div>

        <div className="attendance-cal-grid">
          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => (
            <div key={d} className="attendance-cal-day-header">{d}</div>
          ))}
          {weeks.flat().map((item, i) => {
            if (!item) return <div key={i} className="attendance-cal-cell empty" />;

            const { day, dateStr, record } = item;
            const hasRecord = record?.sessions?.length > 0;
            const isToday = dateStr === todayDateStr;

            return (
              <div
                key={i}
                className={`attendance-cal-cell ${hasRecord ? 'present' : ''} ${isToday ? 'today' : ''}`}
                onClick={() => hasRecord && setSelectedRecord(record)}
              >
                <span className="attendance-cal-num">{day}</span>
                {hasRecord && <span className="attendance-cal-dot" />}
              </div>
            );
          })}
        </div>

        <div className="attendance-cal-legend">
          <span className="legend"><span className="legend-dot" style={{background:'rgba(22,163,74,0.15)'}}></span> Present</span>
          <span className="legend"><span className="legend-dot" style={{background:'rgba(0,102,255,0.08)'}}></span> Today</span>
        </div>
      </div>

      {/* Date Detail Modal */}
      {selectedRecord && (
        <div className="modal-overlay" onClick={() => setSelectedRecord(null)} role="dialog" aria-modal="true" aria-labelledby="modal-title">
          <div className="modal" ref={modalRef} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3 id="modal-title">{formatFullDate(selectedRecord.date)}</h3>
              <button ref={closeButtonRef} className="btn-icon modal-close" aria-label="Close modal" onClick={() => setSelectedRecord(null)}>×</button>
            </div>

            <div className="modal-body">
              {selectedRecord.sessions.map((session, i) => (
                <div key={session.id} className="session-item">
                  <div className="session-header">Session {i + 1}</div>
                  <div className="session-detail">
                    <span className="session-time">
                      <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" style={{verticalAlign:'middle',marginRight:'4px'}} aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                      {formatTime(session.checkIn)}
                    </span>
                    {session.checkOut && (
                      <span className="session-time"> → {formatTime(session.checkOut)}</span>
                    )}
                  </div>
                  {session.checkInAddr && (
                    <div className="session-addr">
                      <svg width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" style={{verticalAlign:'middle',marginRight:'4px'}} aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>
                      {session.checkInAddr}
                    </div>
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
    </div>
  );
}
