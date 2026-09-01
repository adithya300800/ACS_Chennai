import React, { createContext, useCallback, useContext, useRef, useState } from 'react';

const ToastCtx = createContext(null);

const TYPE_TO_ICON = {
  error: '⚠️',
  success: '✓',
  info: 'ℹ️',
  warning: '⚠️',
};

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const idRef = useRef(0);

  // Public API:
  //   toast.push('message')          → error toast (default, 6s)
  //   toast.push('msg', 'success')   → success toast
  //   toast.push('msg', 'warning', 4000) → custom ttl
  //   toast.dismiss(id)              → manual dismiss
  const push = useCallback((message, type = 'error', ttl = 6000) => {
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
