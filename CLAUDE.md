# ACS Chennai Portal — Architecture Decisions

Project-specific context for Claude and other agents working on this repo.
For the user's global guidance (generator-verifier loop, MCP servers, Azure↔Render
notes), see `~/.claude/CLAUDE.md`.

> **S4-C (audit, 2026-09-04):** this document was rewritten to match the
> actual `src/main.jsx`. The previous version claimed the providers lived
> *outside* `<BrowserRouter>` — they don't. The portal uses `<HashRouter>`
> (not `BrowserRouter`), and `ToastProvider` + `AuthProvider` are mounted
> *inside* the router. The threat model + `RouterScope` design notes are
> still accurate — `useAuth()` is consumed from outside the router subtree
> (toast, `lib/api.js`, Zustand-style stores), so `AuthContext` cannot call
> `useNavigate()` directly and uses the `setRouter` bridge instead. The
> bridge is wired but redundant for the current tree: because AuthProvider
> is already inside the router, the bridge is unused — but kept so the
> `AuthProvider`-outside-the-router alternative documented below remains a
> one-line refactor away.

---

## AuthProvider + RouterScope (round-17 C-20)

`AuthProvider` exposes a global `useAuth()` hook used by modules that may
not be inside the router subtree — `ToastProvider`'s push handler, the
global `fetch` wrapper in `src/lib/api.js`, and any future Zustand-style
store. The catch: react-router v6 hooks (`useNavigate`, `useLocation`)
can only be called inside a `<Router>` subtree, so `AuthContext` cannot
call them directly. The bridge is `RouterScope` + a `setRouter` ref.

### What happens on session expiry

A 401 from any API call funnels through `AuthContext`'s global `fetch` wrapper.
The wrapper:

1. Marks the session as expired in state.
2. Pushes a "Your session has expired" toast (deduped by reason — round-5).
3. Calls `routerNavigate('/portal/login')` — **not** `useNavigate()`.
4. Clears any in-flight refresh-token timers.

`routerNavigate` is the imperative handle captured by `RouterScope`.

### Why `RouterScope` instead of alternatives

| Alternative                                  | Why rejected                                                 |
|----------------------------------------------|--------------------------------------------------------------|
| `useNavigate()` directly inside `AuthProvider` | `AuthContext` consumers (toast, `lib/api.js`) are outside the router tree; the call site can't see `useNavigate` either. |
| `window.location.assign('/portal/login')`    | Full page reload kills SPA state + the logout-toast dedupe + any in-flight work |
| Event bus / `CustomEvent` to a router child  | Brittle ordering, harder to test, two sources of truth        |

`RouterScope` is a tiny bridge: a child of `<HashRouter>` (rendered inside
`AuthProvider`) that captures `useNavigate()` + `useLocation()` once and
hands them back to `AuthContext` via a `setRouter(navigate, location)` ref.

```jsx
// src/contexts/AuthContext.jsx (excerpt)
function RouterScope({ setRouter, children }) {
  const navigate = useNavigate();
  const location = useLocation();
  React.useEffect(() => { setRouter(navigate, location); }, [setRouter, navigate, location]);
  return children;
}
```

### Threat model

- **`routerNavigate` is untrusted input from a stale ref.** Mitigation: on logout
  we check `currentLocation.pathname !== '/portal/login'` before navigating so
  a double-fire (e.g. two parallel 401s) doesn't push history twice.
- **Ref can be unset if a logout fires before mount.** Mitigation: `routerNavigate`
  guards on `if (!routerRef.current)` and falls back to `window.location.assign`
  only in that one edge case (should never happen in practice — the global fetch
  wrapper only runs after the app has loaded).
- **Memory leak from the captured location.** Mitigation: `RouterScope` re-fires
  `setRouter` only on `navigate` / `location` change; the ref is overwritten in
  place, no listeners accumulate.

### Where to look

- [src/contexts/AuthContext.jsx:270-308](src/contexts/AuthContext.jsx#L270-L308) — `setRouter` + `RouterScope`
- [src/main.jsx](src/main.jsx) — actual provider order: `ErrorBoundary` > `<HashRouter>` > `<ToastProvider>` > `<AuthProvider>` > `<App>`
- The auth-bootstrap sequence is documented in the memory index (see MEMORY.md in the project memory dir).

---

## Layering rule (do not violate)

**Actual order** (matches `src/main.jsx`):

```
<ErrorBoundary>            ← catches render-time crashes; sits above the router
  <HashRouter>             ← actual router (HashRouter, not BrowserRouter)
    <ToastProvider>        ← inside router so useNavigate is available if a toast ever needs it
      <AuthProvider>       ← inside router; uses routerRef + setRouter for router-aware actions
        <App />            ← routes + ProtectedRoute + AuthContext consumers
```

**If you swap to BrowserRouter (not recommended without a deploy contract
review)**, the same nesting still works because `react-router-dom` exports
both as compatible providers. The audit flagged that the previous doc
described a different tree (BrowserRouter with providers outside); do not
follow that diagram if you see it in old PR descriptions.

**If you ever move `AuthProvider` outside `<HashRouter>`** (e.g. to share
state across two routers in a future portal split), `RouterScope` becomes
load-bearing again — its only consumer is the bridge ref inside
`AuthContext`. Every `useAuth()` call from outside the router (toast,
`lib/api.js`) will still work because they only read from the context,
not from router hooks.
