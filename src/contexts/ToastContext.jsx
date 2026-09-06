import React, { createContext, useCallback, useContext, useRef, useState } from 'react';

const ToastCtx = createContext(null);

const TYPE_TO_ICON = {
  error: '⚠️',
  success: '✓',
  info: 'ℹ️',
  warning: '⚠️',
};

// Round-28 #4: dedupe identical (type, message) pairs within a short window
// so admin-guard + auth-context 401 paths don't both push "Admin access
// required" / "Your session has expired" in parallel and stack 16+ toasts.
// 50ms is enough to swallow the parallel-fire race but short enough that
// legitimately distinct events (e.g. submit-then-retry on a stale token)
// still surface normally.
const TOAST_DEDUPE_WINDOW_MS = 50;

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const idRef = useRef(0);
  // Map<`${type}:${message}`, lastPushTs>
  const recentRef = useRef(new Map());
  // Occasional prune so the Map doesn't grow unbounded. Every 50 pushes
  // we drop entries older than 5s — way past the dedupe window.
  const pushCountRef = useRef(0);

  // Public API:
  //   toast.push('message')          → error toast (default, 6s)
  //   toast.push('msg', 'success')   → success toast
  //   toast.push('msg', 'warning', 4000) → custom ttl
  //   toast.dismiss(id)              → manual dismiss
  const push = useCallback((message, type = 'error', ttl = 6000) => {
    const key = `${type}:${message}`;
    const now = Date.now();
    const last = recentRef.current.get(key);
    if (last && now - last < TOAST_DEDUPE_WINDOW_MS) {
      // Same (type, message) within the window — swallow. We still return
      // a non-zero id so callers that try to dismiss it don't crash.
      return -1;
    }
    recentRef.current.set(key, now);
    pushCountRef.current += 1;
    if (pushCountRef.current % 50 === 0) {
      for (const [k, ts] of recentRef.current.entries()) {
        if (now - ts > 5000) recentRef.current.delete(k);
      }
    }
    const id = ++idRef.current;
    setToasts((t) => [...t, { id, message, type }]);
    if (ttl > 0) {
      setTimeout(() => {
        setToasts((t) => t.filter((x) => x.id !== id));
      }, ttl);
    }
    return id;
  }, []);

  const dismiss = useCallback((id) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  return (
    <ToastCtx.Provider value={{ push, dismiss }}>
      {children}
      <div
        className="toast-stack"
        role="region"
        aria-live="polite"
        aria-label="Notifications"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`toast toast-${t.type}`}
            role={t.type === 'error' ? 'alert' : 'status'}
          >
            <span className="toast-icon" aria-hidden="true">
              {TYPE_TO_ICON[t.type] || '•'}
            </span>
            <span className="toast-message">{t.message}</span>
            <button
              type="button"
              className="toast-dismiss"
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastCtx);
  if (!ctx) {
    // No provider mounted — return a no-op so callers don't crash. This
    // protects pages that render outside <ToastProvider> during tests.
    return { push: () => 0, dismiss: () => {} };
  }
  return ctx;
}
