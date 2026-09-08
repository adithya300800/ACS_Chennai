import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';

export default function ProtectedRoute({ children, requireAdmin = false }) {
  const { isAuthenticated, isAdmin, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh' }}>
        <div style={{ color: 'var(--steel)', fontSize: '0.9rem' }}>Loading...</div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/portal/login" state={{ from: location }} replace />;
  }

  // [DR-018] Admin-labelled routes must require isAdmin on top of
  // authentication. A non-admin who navigates to e.g. /portal/admin/billing-certifications
  // is bounced to the employee dashboard rather than rendered the admin
  // chrome (the page-level render-time guard is still in place as
  // defence-in-depth — see BillingCertificationsAdmin.jsx).
  if (requireAdmin && !isAdmin) {
    return <Navigate to="/portal/dashboard" replace />;
  }

  return children;
}
