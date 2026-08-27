import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';

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

  const formatDate = (d) => new Date(d).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
  const formatTime = (d) => d ? new Date(d).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true }) : '—';

  const getMapUrl = (lat, lng) => {
    if (!lat || !lng || lat === 0 || lng === 0) return null;
    return `https://www.openstreetmap.org/export/embed.html?bbox=${lng - 0.005},${lat - 0.005},${lng + 0.005},${lat + 0.005}&layer=mapnik&marker=${lat},${lng}`;
  };

  // Group by employee
  const byEmployee = records.reduce((acc, r) => {
    const empId = r.employee.id;
    if (!acc[empId]) acc[empId] = { ...r.employee, records: [] };
    acc[empId].records.push(r);
    return acc;
  }, {});

  return (
    <div style={{ padding: '2rem', maxWidth: '1200px', margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
        <div>
          <h1 style={{ fontSize: '1.75rem', fontWeight: '700', color: 'var(--navy)', margin: 0 }}>
            Attendance Dashboard
          </h1>
          <p style={{ color: 'var(--steel)', margin: '0.25rem 0 0', fontSize: '0.9rem' }}>
            Monitor all employees' attendance
          </p>
        </div>
        <input
          type="month"
          value={month}
          onChange={(e) => setMonth(e.target.value)}
          style={{ padding: '0.5rem 1rem', borderRadius: '8px', border: '1px solid #ddd', fontSize: '1rem' }}
        />
      </div>

      {/* Employee Cards */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--steel)' }}>Loading...</div>
      ) : error ? (
        <div style={{ color: '#dc2626', textAlign: 'center', padding: '2rem' }}>{error}</div>
      ) : records.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--steel)' }}>
          No attendance records for this month
        </div>
      ) : (
        <div style={{ display: 'grid', gap: '1.5rem' }}>
          {Object.values(byEmployee).map((emp) => (
            <div key={emp.id} style={{ background: 'white', borderRadius: '12px', padding: '1.5rem', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
              {/* Employee Header */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', borderBottom: '1px solid #eee', paddingBottom: '1rem' }}>
                <div>
                  <h3 style={{ margin: 0, color: 'var(--navy)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <span style={{ width: '32px', height: '32px', borderRadius: '50%', background: 'var(--blue)', color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.875rem' }}>
                      {emp.name.charAt(0)}
                    </span>
                    {emp.name}
                  </h3>
                  <p style={{ margin: '0.25rem 0 0', fontSize: '0.85rem', color: 'var(--steel)' }}>{emp.email}</p>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: '0.85rem', color: 'var(--steel)' }}>{emp.department || 'No department'}</div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--green)', fontWeight: 500 }}>
                    {emp.records.filter(r => r.sessions.length > 0).length} days attended
                  </div>
                </div>
              </div>

              {/* Attendance Grid */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: '0.75rem' }}>
                {emp.records.map((rec) => {
                  const firstSession = rec.sessions[0];
                  const isOpen = rec.sessions.length > 0 && !rec.sessions[rec.sessions.length - 1].checkOut;

                  return (
                    <div
                      key={rec.id}
                      onClick={() => setSelectedRecord({ ...rec, employee: emp })}
                      style={{
                        padding: '0.75rem',
                        borderRadius: '8px',
                        border: selectedRecord?.id === rec.id ? '2px solid var(--blue)' : '1px solid #e5e7eb',
                        cursor: 'pointer',
                        background: selectedRecord?.id === rec.id ? '#f0f9ff' : 'white',
                        transition: 'all 0.2s',
                      }}
                    >
                      <div style={{ fontSize: '0.75rem', color: 'var(--steel)', marginBottom: '0.25rem' }}>
                        {new Date(rec.date).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}
                      </div>
                      <div style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--navy)' }}>
                        {formatTime(firstSession?.checkIn)}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', marginTop: '0.25rem' }}>
                        <span style={{
                          width: '8px', height: '8px', borderRadius: '50%',
                          background: isOpen ? '#f59e0b' : 'var(--green)'
                        }} />
                        <span style={{ fontSize: '0.7rem', color: 'var(--steel)' }}>
                          {isOpen ? 'Open' : 'Complete'}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Detail Modal */}
      {selectedRecord && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 1000, padding: '1rem'
        }} onClick={() => setSelectedRecord(null)}>
          <div style={{
            background: 'white', borderRadius: '16px', padding: '1.5rem', maxWidth: '500px', width: '100%',
            maxHeight: '90vh', overflow: 'auto'
          }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h3 style={{ margin: 0, color: 'var(--navy)' }}>
                {selectedRecord.employee.name} - {new Date(selectedRecord.date).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}
              </h3>
              <button onClick={() => setSelectedRecord(null)} style={{ background: 'none', border: 'none', fontSize: '1.5rem', cursor: 'pointer' }}>×</button>
            </div>

            {/* Check-in Details */}
            {selectedRecord.sessions.map((session, i) => (
              <div key={session.id} style={{ marginBottom: '1rem', padding: '1rem', background: '#f9fafb', borderRadius: '8px' }}>
                <div style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--navy)', marginBottom: '0.5rem' }}>
                  Session {i + 1}
                </div>
                <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--steel)' }}>Check-in</div>
                    <div style={{ fontWeight: 500 }}>{formatTime(session.checkIn)}</div>
                  </div>
                  {session.checkOut && (
                    <div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--steel)' }}>Check-out</div>
                      <div style={{ fontWeight: 500 }}>{formatTime(session.checkOut)}</div>
                    </div>
                  )}
                </div>
                {session.checkInAddr && (
                  <div style={{ marginTop: '0.5rem', fontSize: '0.875rem', color: 'var(--steel)' }}>
                    📍 {session.checkInAddr}
                  </div>
                )}

                {/* Map */}
                {session.checkInLat && session.checkInLng && getMapUrl(parseFloat(session.checkInLat), parseFloat(session.checkInLng)) && (
                  <div style={{ marginTop: '0.75rem', borderRadius: '8px', overflow: 'hidden' }}>
                    <iframe
                      title="Location"
                      width="100%"
                      height="200"
                      frameBorder="0"
                      scrolling="no"
                      marginHeight="0"
                      marginWidth="0"
                      src={getMapUrl(parseFloat(session.checkInLat), parseFloat(session.checkInLng))}
                      style={{ border: 0 }}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
