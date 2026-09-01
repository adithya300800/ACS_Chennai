# ACS Chennai Portal — Architecture Decisions

Project-specific context for Claude and other agents working on this repo.
For the user's global guidance (generator-verifier loop, MCP servers, Azure↔Render
notes), see `~/.claude/CLAUDE.md`.

---

## AuthProvider + RouterScope (round-17 C-20)

`AuthProvider` lives **outside** the `<BrowserRouter>` (mounted in `src/main.jsx`)
so any module — including toast, fetch wrappers, and Zustand-style stores — can
call `useAuth()` without router caveats. The catch: react-router v6 hooks
(`useNavigate`, `useLocation`) can only be called inside a `<Router>` subtree,
so a context that lives outside the router cannot call them directly.

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
| Put `AuthProvider` inside `<BrowserRouter>`  | Forces every consumer to be inside the router — breaks calls from toast, lib/, etc. |
| `window.location.assign('/portal/login')`    | Full page reload kills SPA state + the logout-toast dedupe + any in-flight work |
| Event bus / `CustomEvent` to a router child  | Brittle ordering, harder to test, two sources of truth        |

`RouterScope` is a tiny bridge: a child of `<BrowserRouter>` that captures
`useNavigate()` + `useLocation()` once and hands them back to `AuthContext`
via a `setRouter(navigate, location)` ref.

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

- [src/contexts/AuthContext.jsx:186-218](src/contexts/AuthContext.jsx#L186-L218) — `setRouter` + `RouterScope`
- [src/main.jsx](src/main.jsx) — provider order: `ToastProvider` > `AuthProvider` > `<BrowserRouter>` > `App`
- The auth-bootstrap sequence is documented in [memory/round4-production-hardening.md](../../.claude/projects/-Users-adithyamohanavel-Documents-Repo-ACS-Chennai/memory/production-hardening-round4.md).

---

## Layering rule (do not violate)

```
<ToastProvider>            ← outside router; any consumer can push toasts
  <AuthProvider>           ← outside router; uses routerRef, not router hooks
    <BrowserRouter>
      <App>
        <PortalLayout>     ← uses ProtectedRoute + AuthContext
          <Outlet />
```

If a future change needs to move `AuthProvider` inside the router, EVERY
`useAuth()` call from outside the router will break — toast, fetch wrappers,
`api.js`. Do not do this without refactoring those first.
