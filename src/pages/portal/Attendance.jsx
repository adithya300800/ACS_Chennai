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
  const [status, setStatus] = useState('idle'); // idle | loading | checking-in | checking-out | error
  const [locationStatus, setLocationStatus] = useState(''); // '' | 'requesting' | 'granted' | 'denied'
  const [location, setLocation] = useState(null);
  const [error, setError] = useState('');
  const [manualAddr, setManualAddr] = useState('');
  const [showManual, setShowManual] = useState(false);

  // Fetch today's attendance
  const fetchToday = useCallback(async () => {
    try {
      const data = await api.get('/attendance/today', accessToken);
      setTodayRecord(data);
    } catch {
      // No record yet today — that's fine
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

  // Request geolocation
  const requestLocation = () => {
    console.log('requestLocation called');
    return new Promise((resolve, reject) => {
      setLocationStatus('requesting');
      if (!navigator.geolocation) {
        console.log('Geolocation not supported');
        setLocationStatus('denied');
        reject(new Error('Geolocation not supported'));
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          console.log('Geolocation success:', pos.coords);
          const coords = {
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
          };
          setLocationStatus('granted');
          setLocation(coords);
          resolve(coords);
        },
        (err) => {
          console.log('Geolocation error:', err.message);
          setLocationStatus('denied');
          reject(err);
        },
        { enableHighAccuracy: true, timeout: 10000 }
      );
    });
  };

  // Reverse geocode (simple: just show lat/lng as string — no external API needed)
  const formatLocation = (lat, lng) => {
    if (!lat || !lng) return '';
    return `${parseFloat(lat).toFixed(4)}°N, ${parseFloat(lng).toFixed(4)}°E`;
  };

  // Handle check-in
  const handleCheckIn = async () => {
    console.log('handleCheckIn called, status:', status);
    setStatus('checking-in');
    setError('');

    try {
      let lat, lng, addr;
      try {
        console.log('Requesting location...');
        const coords = await requestLocation();
        console.log('Got coords:', coords);
        lat = coords.latitude;
        lng = coords.longitude;
        addr = formatLocation(lat, lng);
      } catch (err) {
        console.log('Geolocation error:', err.message);
        // Geolocation failed — use manual entry or defaults
        if (showManual && manualAddr.trim()) {
          addr = manualAddr.trim();
          lat = 0;
          lng = 0;
        } else {
          addr = 'Location unavailable';
          lat = 0;
          lng = 0;
        }
      }

      console.log('Check-in with lat:', lat, 'lng:', lng, 'addr:', addr);
      const data = await api.post('/attendance/check-in', { latitude: lat, longitude: lng, address: addr }, accessToken);
      console.log('Check-in success:', data);
      setTodayRecord(data);
      setStatus('idle');
      fetchMonth();
    } catch (err) {
      console.error('Check-in error:', err);
      setStatus('error');
      setError(err.message || 'Check-in failed');
    }
  };

  // Handle check-out
  const handleCheckOut = async () => {
    if (!todayRecord?.id) return;
    setStatus('checking-out');
    setError('');

    try {
      let lat, lng, addr;
      try {
        const coords = await requestLocation();
        lat = coords.latitude;
        lng = coords.longitude;
        addr = formatLocation(lat, lng);
      } catch {
        addr = 'Location unavailable';
        lat = 0;
        lng = 0;
      }

      const data = await api.put(`/attendance/check-out/${todayRecord.id}`, { latitude: lat, longitude: lng, address: addr }, accessToken);
      setTodayRecord(data);
      setStatus('idle');
      fetchMonth();
    } catch (err) {
      setStatus('error');
      setError(err.message || 'Check-out failed');
    }
  };

  // Build calendar data
  const buildCalendar = () => {
    const [year, month] = currentMonth.split('-').map(Number);
    const firstDay = new Date(year, month - 1, 1).getDay(); // 0=Sun
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

  const isCheckedIn = !!todayRecord?.checkIn;
  const isCheckedOut = !!todayRecord?.checkOut;

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

        {!isCheckedIn ? (
          // Not checked in yet
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
        ) : !isCheckedOut ? (
          // Checked in but not out
          <div className="attendance-status">
            <div className="attendance-checkin-info">
              <div className="attendance-checkin-time">
                <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                  <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
                </svg>
                Checked in at {new Date(todayRecord.checkIn).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
              </div>
              {todayRecord.checkInAddr && (
                <div className="attendance-checkin-loc">
                  <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                    <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z" /><circle cx="12" cy="10" r="3" />
                  </svg>
                  {todayRecord.checkInAddr}
                </div>
              )}
            </div>
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
        ) : (
          // Fully checked in and out
          <div className="attendance-completed">
            <div className="attendance-completed-badge">
              <svg width="20" height="20" fill="none" stroke="#16A34A" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                <path d="M20 6L9 17l-5-5" />
              </svg>
              Attendance Complete
            </div>
            <div className="attendance-times">
              <div>
                <span className="attendance-time-label">In</span>
                <span className="attendance-time-val">{new Date(todayRecord.checkIn).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</span>
              </div>
              <div>
                <span className="attendance-time-label">Out</span>
                <span className="attendance-time-val">{new Date(todayRecord.checkOut).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Calendar */}
      <div className="attendance-calendar">
        <div className="attendance-calendar-header">
          <button
            className="attendance-cal-nav"
            onClick={() => {
              const [y, m] = currentMonth.split('-').map(Number);
              const d = new Date(y, m - 2, 1);
              setCurrentMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
            }}
          >
            <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6" /></svg>
          </button>
          <span className="attendance-cal-month">{monthLabel}</span>
          <button
            className="attendance-cal-nav"
            onClick={() => {
              const [y, m] = currentMonth.split('-').map(Number);
              const d = new Date(y, m, 1);
              setCurrentMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
            }}
          >
            <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M9 18l6-6-6-6" /></svg>
          </button>
        </div>

        <div className="attendance-cal-grid">
          {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
            <div key={i} className="attendance-cal-day-header">{d}</div>
          ))}
          {weeks.flat().map((cell, i) => {
            if (!cell) return <div key={`empty-${i}`} className="attendance-cal-cell empty" />;
            const { day, record } = cell;
            const isToday = new Date().getDate() === day &&
              new Date().getMonth() + 1 === parseInt(currentMonth.split('-')[1]) &&
              new Date().getFullYear() === parseInt(currentMonth.split('-')[0]);
            const isPresent = record?.checkIn;
            const isAbsent = !record && !isToday;

            return (
              <div
                key={day}
                className={`attendance-cal-cell ${isToday ? 'today' : ''} ${isPresent ? 'present' : ''} ${isAbsent ? 'absent' : ''}`}
              >
                <span className="attendance-cal-num">{day}</span>
                {isPresent && <span className="attendance-cal-dot" />}
              </div>
            );
          })}
        </div>

        <div className="attendance-cal-legend">
          <span><span className="legend present" /> Present</span>
          <span><span className="legend absent" /> Absent/No record</span>
        </div>
      </div>
    </div>
  );
}
