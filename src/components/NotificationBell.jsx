import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';
import { api } from '../lib/api.js';

const API_BASE = import.meta.env.VITE_API_URL || '';

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function NotifIcon({ type }) {
  if (type === 'DPR_SUBMITTED') {
    return <div className="notification-icon notification-icon-submitted">📤</div>;
  }
  if (type === 'DPR_REVIEWED') {
    return <div className="notification-icon notification-icon-submitted">👁</div>;
  }
  if (type === 'DPR_APPROVED') {
    return <div className="notification-icon notification-icon-approved">✓</div>;
  }
  if (type === 'DPR_REJECTED') {
    return <div className="notification-icon notification-icon-rejected">✗</div>;
  }
  return <div className="notification-icon notification-icon-submitted">🔔</div>;
}

export default function NotificationBell() {
  const { accessToken, employee } = useAuth();
  const navigate = useNavigate();
  const dropdownRef = useRef(null);
  const eventSourceRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);

  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(false);

  // Load initial notifications
  const loadNotifications = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    try {
      const data = await api.getNotifications(null, accessToken);
      // API returns array directly or { notifications: [] }
      const items = Array.isArray(data) ? data : (data.notifications || []);
      setNotifications(items);
      setUnreadCount(items.filter(n => !n.isRead).length);
    } catch (err) {
      console.error('Failed to load notifications:', err);
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  // Connect SSE
  const connectSSE = useCallback(() => {
    if (!accessToken || !employee) return;

    // Close existing connection
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    // Note: EventSource doesn't support custom headers — token passed via query param
    const url = `${API_BASE}/api/dpr/notifications?token=${encodeURIComponent(accessToken)}`;
    const es = new EventSource(url);

    es.onopen = () => {
      setConnected(true);
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
    };

    es.onerror = () => {
      setConnected(false);
      es.close();
      eventSourceRef.current = null;
      // Reconnect with backoff
      reconnectTimeoutRef.current = setTimeout(() => {
        connectSSE();
      }, 5000);
    };

    es.addEventListener('notification', (e) => {
      try {
        const notif = JSON.parse(e.data);
        setNotifications(prev => {
          // Avoid duplicates
          const exists = prev.some(n => n.id === notif.id);
          if (exists) return prev;
          return [notif, ...prev];
        });
        if (!notif.isRead) {
          setUnreadCount(c => c + 1);
        }
      } catch {}
    });

    es.addEventListener('connected', () => {
      setConnected(true);
    });

    es.addEventListener('heartbeat', () => {
      // Just keepalive - nothing to do
    });

    eventSourceRef.current = es;
  }, [accessToken, employee]);

  useEffect(() => {
    loadNotifications();
    connectSSE();
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
    };
  }, [loadNotifications, connectSSE]);

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleNotifClick = async (notif) => {
    // Mark as read locally
    if (!notif.isRead) {
      setNotifications(prev =>
        prev.map(n => n.id === notif.id ? { ...n, isRead: true } : n)
      );
      setUnreadCount(c => Math.max(0, c - 1));
    }
    // Navigate to DPR
    if (notif.dprId) {
      navigate('/portal/dpr/my', { state: { selectedDprId: notif.dprId } });
    }
    setOpen(false);
  };

  const handleMarkAllRead = async () => {
    try {
      await api.markAllNotificationsRead(accessToken);
      setNotifications(prev => prev.map(n => ({ ...n, isRead: true })));
      setUnreadCount(0);
    } catch (err) {
      console.error('Failed to mark all read:', err);
    }
  };

  const displayCount = unreadCount > 9 ? '9+' : unreadCount;

  return (
    <div style={{ position: 'relative' }} ref={dropdownRef}>
      <button
        className={`notification-bell-btn ${open ? 'active' : ''}`}
        onClick={() => setOpen(o => !o)}
        title={`Notifications${connected ? ' (connected)' : ' (offline)'}`}
        style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}
      >
        <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.75" viewBox="0 0 24 24">
          <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0"/>
        </svg>
        {unreadCount > 0 && (
          <span className="notification-badge">{displayCount}</span>
        )}
        {!connected && (
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#f59e0b', position: 'absolute', top: 2, left: 2 }} title="Reconnecting..." />
        )}
      </button>

      {open && (
        <div className="notification-dropdown">
          <div style={{ padding: '0.875rem 1rem', borderBottom: '1px solid #e2e8f0', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ fontWeight: 600, color: 'var(--navy)', fontSize: '0.9rem' }}>
              Notifications
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: connected ? '#22c55e' : '#ef4444' }} title={connected ? 'Connected' : 'Disconnected'} />
              {unreadCount > 0 && (
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={handleMarkAllRead}
                  style={{ fontSize: '0.75rem', padding: '0.25rem 0.5rem' }}
                >
                  Mark all read
                </button>
              )}
            </div>
          </div>

          <div style={{ maxHeight: 380, overflowY: 'auto' }}>
            {loading ? (
              <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--steel)' }}>
                Loading...
              </div>
            ) : notifications.length === 0 ? (
              <div className="notification-empty">
                <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>🔔</div>
                <p>No notifications yet</p>
                <p style={{ fontSize: '0.75rem', marginTop: '0.25rem' }}>You'll be notified when DPRs are reviewed</p>
              </div>
            ) : (
              notifications.map(notif => (
                <div
                  key={notif.id}
                  className={`notification-item ${!notif.isRead ? 'unread' : ''}`}
                  onClick={() => handleNotifClick(notif)}
                >
                  <NotifIcon type={notif.type} />
                  <div className="notification-content">
                    <div className="notification-message">{notif.message}</div>
                    <div className="notification-time">{timeAgo(notif.createdAt)}</div>
                  </div>
                  {!notif.isRead && (
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--blue)', flexShrink: 0, marginTop: '0.5rem' }} />
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
