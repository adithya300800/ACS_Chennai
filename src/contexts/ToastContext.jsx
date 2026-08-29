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
        style={{
          position: 'fixed',
          top: '1rem',
          right: '1rem',
          zIndex: 9999,
          display: 'flex',
          flexDirection: 'column',
          gap: '0.5rem',
          pointerEvents: 'none',
          maxWidth: 'calc(100vw - 2rem)',
        }}
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`toast toast-${t.type}`}
            role={t.type === 'error' ? 'alert' : 'status'}
            style={{
              pointerEvents: 'auto',
              background: {
                error: '#fef2f2',
                success: '#f0fdf4',
                info: '#eff6ff',
                warning: '#fffbeb',
              }[t.type] || '#f1f5f9',
              color: {
                error: '#991b1b',
                success: '#166534',
                info: '#1e40af',
                warning: '#92400e',
              }[t.type] || '#0f172a',
              borderLeft: `4px solid ${
                {
                  error: '#dc2626',
                  success: '#22c55e',
                  info: '#3b82f6',
                  warning: '#f59e0b',
                }[t.type] || '#94a3b8'
              }`,
              padding: '0.75rem 1rem',
              borderRadius: 6,
              boxShadow: '0 4px 12px rgba(15, 23, 42, 0.12)',
              display: 'flex',
              alignItems: 'flex-start',
              gap: '0.625rem',
              minWidth: 280,
              maxWidth: 420,
              fontSize: '0.875rem',
              lineHeight: 1.4,
              animation: 'toast-in 200ms ease-out',
            }}
          >
            <span aria-hidden="true" style={{ flexShrink: 0 }}>
              {TYPE_TO_ICON[t.type] || '•'}
            </span>
            <span style={{ flex: 1, wordBreak: 'break-word' }}>{t.message}</span>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss"
              style={{
                background: 'none',
                border: 'none',
                color: 'inherit',
                cursor: 'pointer',
                padding: 0,
                fontSize: '1.1rem',
                lineHeight: 1,
                opacity: 0.6,
              }}
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
