// DR-020: branches /portal/ (empty path) to Admin Overview for admins and
// Attendance for employees. Lives in its own module so:
//   1. App.jsx no longer needs to import every page module via lazy() just
//      to keep this branching rule co-located with the route table.
//   2. Unit tests can import just this file + auth context, instead of
//      dragging in 23 lazy page chunks + PortalLayout + AuthContext's
//      api.js + env.js chain (see src/__tests__/App.test.jsx).
//
// The admin target is passed in as a render prop (`renderAdmin`) rather
// than imported via `React.lazy()` here — the actual lazy import lives
// in App.jsx where it already lazy-chunks the AdminOverview bundle. This
// avoids an additional lazy() boundary that would force jsdom into
// dynamic-import resolution at test time.

import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';

export default function RoleBranchLanding({ renderAdmin }) {
  // Read role from AuthContext — same source of truth as PortalLayout,
  // ProtectedRoute, and PortalLogin's post-login redirect
  // (PortalLogin.jsx:108 — `data.employee?.isAdmin ? '/portal/admin' : ...`).
  // The previous localStorage('acs_employee') read always failed because
  // AuthContext stores the user under `acs_auth`; admins were misrouted to
  // Attendance on first paint after refresh.
  //
  // AuthProvider is mounted above this component in main.jsx, so useAuth()
  // resolves cleanly without violating the layering rule in CLAUDE.md
  // (AuthProvider must stay outside <BrowserRouter>).
  const { employee } = useAuth();
  if (employee?.isAdmin) {
    return renderAdmin ? renderAdmin() : null;
  }
  return <Navigate to="attendance" replace />;
}
