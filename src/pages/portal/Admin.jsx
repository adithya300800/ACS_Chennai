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
  const formatTime = (d) => d ? new Date(d).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '—';

  // Group by employee
  const byEmployee = records.reduce((acc, r) => {
    const empId = r.employee.id;
    if (!acc[empId]) acc[empId] = { ...r.employee, records: [] };
    acc[empId].records.push(r);
    return acc;
  }, {});

  return (
    <div style={{ padding: '2rem', maxWidth: '1200px', margin: '0 auto' }}>
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
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', borderBottom: '1px solid #eee', paddingBottom: '1rem' }}>
                <div>
                  <h3 style={{ margin: 0, color: 'var(--navy)' }}>{emp.name}</h3>
                  <p style={{ margin: '0.25rem 0 0', fontSize: '0.85rem', color: 'var(--steel)' }}>{emp.email}</p>
                </div>
                <div style={{ fontSize: '0.85rem', color: 'var(--steel)' }}>
                  {emp.department || 'No department'}
                </div>
              </div>

              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
                <thead>
                  <tr style={{ color: 'var(--steel)', textAlign: 'left' }}>
                    <th style={{ padding: '0.5rem' }}>Date</th>
                    <th style={{ padding: '0.5rem' }}>Sessions</th>
                    <th style={{ padding: '0.5rem' }}>First In</th>
                    <th style={{ padding: '0.5rem' }}>Last Out</th>
                    <th style={{ padding: '0.5rem' }}>Total Sessions</th>
                  </tr>
                </thead>
                <tbody>
                  {emp.records.map((rec) => (
                    <tr key={rec.id} style={{ borderTop: '1px solid #f0f0f0' }}>
                      <td style={{ padding: '0.5rem' }}>{formatDate(rec.date)}</td>
                      <td style={{ padding: '0.5rem' }}>
                        {rec.sessions.length > 0 ? (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                            {rec.sessions.map((s) => (
                              <div key={s.id} style={{ fontSize: '0.8rem', display: 'flex', gap: '0.5rem' }}>
                                <span style={{ color: '#16a34a' }}>{formatTime(s.checkIn)}</span>
                                <span style={{ color: 'var(--steel)' }}>→</span>
                                <span style={{ color: '#dc2626' }}>{formatTime(s.checkOut)}</span>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <span style={{ color: 'var(--steel)' }}>No sessions</span>
                        )}
                      </td>
                      <td style={{ padding: '0.5rem' }}>
                        {rec.sessions[0] ? (
                          <span style={{ fontSize: '0.8rem' }}>
                            {formatTime(rec.sessions[0].checkIn)}
                            {rec.sessions[0].checkInAddr && (
                              <span style={{ display: 'block', color: 'var(--steel)', fontSize: '0.75rem' }}>
                                📍 {rec.sessions[0].checkInAddr}
                              </span>
                            )}
                          </span>
                        ) : '—'}
                      </td>
                      <td style={{ padding: '0.5rem' }}>
                        {rec.sessions.length > 0 && rec.sessions[rec.sessions.length - 1].checkOut ? (
                          <span style={{ fontSize: '0.8rem' }}>
                            {formatTime(rec.sessions[rec.sessions.length - 1].checkOut)}
                            {rec.sessions[rec.sessions.length - 1].checkOutAddr && (
                              <span style={{ display: 'block', color: 'var(--steel)', fontSize: '0.75rem' }}>
                                📍 {rec.sessions[rec.sessions.length - 1].checkOutAddr}
                              </span>
                            )}
                          </span>
                        ) : '—'}
                      </td>
                      <td style={{ padding: '0.5rem', textAlign: 'center' }}>{rec.sessions.length}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
