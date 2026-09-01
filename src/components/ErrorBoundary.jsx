import React from 'react';

/**
 * Top-level React Error Boundary.
 *
 * Why: without this, any uncaught render error (undefined property access in
 * a component, throw inside a useEffect, etc.) unmounts the entire React root
 * and leaves the user with a blank white page. The 4 hardening rounds added
 * timeouts, toast deduplication, and 401 handlers — but none added a render
 * error boundary, which is the canonical defense against JSX render exceptions.
 *
 * Behavior:
 *   - Catches render-phase errors anywhere in the tree below it.
 *   - Shows a friendly fallback with "Reload" + "Go home" CTAs.
 *   - Logs the error to console.error for ops; future: wire to Sentry / AppInsights.
 *
 * Use ONE wrapper at the top of the tree (in main.jsx) to protect the whole
 * app. Optionally add inner boundaries around risky subtrees (admin dashboards,
 * the SSE notification bell) so a single page crash doesn't kill the layout.
 */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Round-7: surface the error so it's visible in browser console / future
    // remote sink. Don't include the stack in the rendered fallback (it
    // could include PII for some shapes of error).
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary]', { error: error?.message, componentStack: info?.componentStack });
  }

  handleReload = () => {
    // Clear the error so we don't immediately re-throw, then reload.
    this.setState({ error: null });
    window.location.reload();
  };

  handleHome = () => {
    this.setState({ error: null });
    window.location.hash = '#/';
  };

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div
        role="alert"
        aria-live="assertive"
        className="error-boundary"
      >
        <h1 style={{ fontSize: 22, margin: '0 0 8px' }}>Something went wrong</h1>
        <p className="error-boundary-text" style={{ margin: '0 0 16px', lineHeight: 1.5 }}>
          The page hit an unexpected error. Your work is preserved — try reloading, or
          head back to the homepage.
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            onClick={this.handleReload}
            style={{
              padding: '8px 16px',
              borderRadius: 6,
              border: 'none',
              background: '#2563eb',
              color: 'white',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Reload page
          </button>
          <button
            type="button"
            onClick={this.handleHome}
            style={{
              padding: '8px 16px',
              borderRadius: 6,
              border: '1px solid #4b5563',
              background: 'transparent',
              cursor: 'pointer',
            }}
          >
            Go to homepage
          </button>
        </div>
        {process.env.NODE_ENV !== 'production' && (
          <pre className="error-boundary-debug">
            {String(this.state.error?.message || this.state.error)}
          </pre>
        )}
      </div>
    );
  }
}
