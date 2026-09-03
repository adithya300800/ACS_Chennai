import React, { useState, useEffect, useRef, useCallback, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useToast } from '../contexts/ToastContext.jsx';
import { api } from '../lib/api.js';

const API_BASE = import.meta.env.VITE_API_URL || '';

// Exponential backoff with cap, and circuit-break after 3 failures so a
// truly dead token doesn't generate a forever-reconnecting log spam
// (the 12× 401 pattern from the original HAR).
const MAX_RECONNECT_ATTEMPTS = 3;
const BASE_RECONNECT_MS = 1000;
const MAX_RECONNECT_MS = 30000;

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
  const toast = useToast();
  const navigate = useNavigate();
  const dropdownRef = useRef(null); // bell-button wrapper (for outside-click)
  const triggerRef = useRef(null); // bell button itself (for portal position)
  const portalDropdownRef = useRef(null); // portalled dropdown (for outside-click)
  const eventSourceRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);
  const reconnectAttemptRef = useRef(0);
  const browserNotifRequestedRef = useRef(false);

  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(false);
  const [connectionLost, setConnectionLost] = useState(false); // circuit-broken, user must refresh
  const [dropdownPos, setDropdownPos] = useState({ top: 0, right: 0 }); // viewport coords; Round-21 portal fix

  // Round-21: dropdown rect recompute on every open/resize/scroll. Coords
  // resolve against the viewport because the dropdown is portalled to
  // <body> — escaping the <header>'s containing block (created by the
  // global `header { backdrop-filter: blur(16px)… }` rule in App.css).
//
// `top` is JS-driven (the bell's `rect.bottom + 8` doesn't generalize
// to CSS). `right` is CSS-driven: App.css pins `.notification-dropdown`
// to `right: 1rem` and the mobile override clamps width to
// `calc(100vw - 2rem)`. JS-computing `right = innerWidth - bell.right`
// correctly aligns to the bell on desktop, but breaks on mobile where
// the bell sits in the middle of the topbar (375px viewport, bell at
// x≈222 → right: 152 → dropdown extends to x=-120). Drop the inline
// right; CSS handles it.
useLayoutEffect(() => {
    if (!open) return undefined;
    const compute = () => {
      const btn = triggerRef.current;
      if (!btn) return;
      const r = btn.getBoundingClientRect();
      setDropdownPos({ top: r.bottom + 8 });
    };
    compute();
    window.addEventListener('resize', compute);
    window.addEventListener('scroll', compute, true);
    return () => {
      window.removeEventListener('resize', compute);
      window.removeEventListener('scroll', compute, true);
    };
  }, [open]);

  // Load initial notifications
  const loadNotifications = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    try {
      const data = await api.getNotifications(null, accessToken);
      const items = Array.isArray(data) ? data : (data.notifications || []);
      setNotifications(items);
      setUnreadCount(items.filter((n) => !n.isRead).length);
    } catch (err) {
      // 401 paths already dispatch auth:logout from the api.js interceptor.
      // Anything else (network/transient) gets a soft toast — don't spam the user.
      if (err.status !== 401 && err.status !== 0) {
        console.error('Failed to load notifications:', err);
      }
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  // Connect SSE via single-use ticket. Replaces the legacy ?token= JWT-in-URL
  // path (Code Reviewer P2-2) — JWT no longer reaches reverse-proxy logs.
  const connectSSE = useCallback(async () => {
    if (!accessToken || !employee) return;

    // Close existing connection before opening a new one
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    let ticket;
    try {
      const res = await api.getNotificationTicket(accessToken);
      ticket = res.ticket;
    } catch (err) {
      // 401 already triggered auth:logout via the api interceptor.
      // A 401 here means the JWT truly is dead — no point reconnecting.
      if (err.status === 401) {
        setConnectionLost(true);
        return;
      }
      // Transient failure on the ticket POST — schedule a reconnect
      // (e.g. backend briefly unreachable, network blip).
      scheduleReconnect();
      return;
    }

    if (!ticket) {
      scheduleReconnect();
      return;
    }

    const url = `${API_BASE}/api/dpr/notifications?ticket=${encodeURIComponent(ticket)}`;
    const es = new EventSource(url);

    es.onopen = () => {
      setConnected(true);
      setConnectionLost(false);
      reconnectAttemptRef.current = 0;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
    };

    es.onerror = () => {
      // EventSource can't tell 401 from a transient drop — close and
      // let the ticket-based reconnect try. The next ticket POST will
      // tell us definitively whether the auth is dead.
      setConnected(false);
      es.close();
      eventSourceRef.current = null;
      scheduleReconnect();
    };

    es.addEventListener('notification', (e) => {
      try {
        const notif = JSON.parse(e.data);
        setNotifications((prev) => {
          const exists = prev.some((n) => n.id === notif.id);
          if (exists) return prev;
          return [notif, ...prev];
        });
        if (!notif.isRead) {
          setUnreadCount((c) => c + 1);
          // Soft in-app toast so background-tab users don't miss events
          if (notif.message) {
            toast.push(notif.message, 'info', 4000);
          }
          // Ask for browser notification permission once, then notify
          if (typeof Notification !== 'undefined' && Notification.permission === 'default' && !browserNotifRequestedRef.current) {
            browserNotifRequestedRef.current = true;
            Notification.requestPermission().catch(() => {});
          } else if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
            try {
              // eslint-disable-next-line no-new
              new Notification('ACS Chennai', { body: notif.message || 'New notification' });
            } catch {}
          }
        }
      } catch {}
    });

    es.addEventListener('connected', () => {
      setConnected(true);
    });

    es.addEventListener('heartbeat', () => {
      // Keepalive — nothing to do
    });

    eventSourceRef.current = es;
  }, [accessToken, employee, toast]);

  // Exponential backoff reconnect — capped at MAX_RECONNECT_MS and
  // circuit-broken after MAX_RECONNECT_ATTEMPTS so a permanently rejected
  // ticket (rotated JWT secret, banned user) doesn't hammer the backend.
  const scheduleReconnect = useCallback(() => {
    if (reconnectAttemptRef.current >= MAX_RECONNECT_ATTEMPTS) {
      setConnectionLost(true);
      return;
    }
    reconnectAttemptRef.current += 1;
    const delay = Math.min(MAX_RECONNECT_MS, BASE_RECONNECT_MS * 2 ** reconnectAttemptRef.current);
    reconnectTimeoutRef.current = setTimeout(connectSSE, delay);
  }, [connectSSE]);

  useEffect(() => {
    loadNotifications();
    reconnectAttemptRef.current = 0;
    setConnectionLost(false);
    connectSSE();
    // If the api interceptor decides the session is dead (TOKEN_INVALID /
    // refresh failed), it fires auth:logout. We don't want the bell to
    // keep reconnecting forever in that case — close the SSE and surface
    // a "session ended" state. The Retry button is a manual opt-in.
    const onLogout = () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      setConnected(false);
      setConnectionLost(true);
    };
    window.addEventListener('auth:logout', onLogout);
    return () => {
      window.removeEventListener('auth:logout', onLogout);
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
    };
    // Re-mount on token change so the ticket request picks up the new JWT
  }, [loadNotifications, connectSSE]);

  // Close dropdown on outside click. Round-21: dropdown is portalled to
  // <body>, so the bell-button wrapper alone isn't enough — also check
  // the portalled dropdown's own ref.
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      const target = e.target;
      if (dropdownRef.current?.contains(target)) return;
      if (portalDropdownRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Close dropdown on Escape (accessibility)
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open]);

  const handleNotifClick = async (notif) => {
    if (!notif.isRead) {
      setNotifications((prev) =>
        prev.map((n) => (n.id === notif.id ? { ...n, isRead: true } : n))
      );
      setUnreadCount((c) => Math.max(0, c - 1));
    }
    if (notif.dprId) {
      navigate('/portal/dpr/my', { state: { selectedDprId: notif.dprId } });
    }
    setOpen(false);
  };

  const handleMarkAllRead = async () => {
    try {
      await api.markAllNotificationsRead(accessToken);
      setNotifications((prev) => prev.map((n) => ({ ...n, isRead: true })));
      setUnreadCount(0);
    } catch (err) {
      toast.push('Could not mark notifications as read.', 'error');
    }
  };

  const handleRetryConnection = () => {
    reconnectAttemptRef.current = 0;
    setConnectionLost(false);
    connectSSE();
  };

  const displayCount = unreadCount > 9 ? '9+' : unreadCount;
  const statusTitle = connectionLost
    ? 'Disconnected — click to retry'
    : connected
      ? 'Connected'
      : 'Reconnecting...';

  return (
    <div style={{ position: 'relative' }} ref={dropdownRef}>
      <button
        ref={triggerRef}
        className={`notification-bell-btn ${open ? 'active' : ''}`}
        onClick={() => setOpen((o) => !o)}
        title={statusTitle}
        aria-label={`Notifications (${unreadCount} unread)`}
        style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}
      >
        <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.75" viewBox="0 0 24 24">
          <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0"/>
        </svg>
        {unreadCount > 0 && (
          <span className="notification-badge">{displayCount}</span>
        )}
        {connectionLost ? (
          <span
            onClick={(e) => { e.stopPropagation(); handleRetryConnection(); }}
            style={{ width: 8, height: 8, borderRadius: '50%', background: '#ef4444', position: 'absolute', top: 2, left: 2, cursor: 'pointer' }}
            title="Click to retry"
          />
        ) : !connected ? (
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#f59e0b', position: 'absolute', top: 2, left: 2 }} title="Reconnecting..." />
        ) : null}
      </button>

      {open && createPortal(
        <div
          ref={portalDropdownRef}
          className="notification-dropdown"
          role="dialog"
          aria-label="Notifications"
          style={{ top: `${dropdownPos.top}px` }}
        >
          <div style={{ padding: '0.875rem 1rem', borderBottom: '1px solid #e2e8f0', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ fontWeight: 600, color: 'var(--navy)', fontSize: '0.9rem' }}>
              Notifications
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <div
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: connectionLost ? '#ef4444' : connected ? '#22c55e' : '#f59e0b',
                }}
                title={statusTitle}
              />
              {connectionLost && (
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={handleRetryConnection}
                  style={{ fontSize: '0.75rem', padding: '0.25rem 0.5rem' }}
                >
                  Retry
                </button>
              )}
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
              notifications.map((notif) => (
                <div
                  key={notif.id}
                  className={`notification-item ${!notif.isRead ? 'unread' : ''}`}
                  onClick={() => handleNotifClick(notif)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleNotifClick(notif); } }}
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
        </div>,
        document.body
      )}
    </div>
  );
}
