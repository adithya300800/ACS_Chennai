import React from 'react';
import { Link } from 'react-router-dom';

// B-08 (round-17): shared empty-state placeholder. Replaces ~10 ad-hoc
// inline <div className="X-list-state"> or centered-icon blocks across
// DprList, DprDashboard, InspectionList, InspectionAll, InspectionDashboard,
// Training, TrainingDashboard, LeaveDashboard, NotificationBell, Admin.
//
// `icon` may be an emoji string ("📋") or a JSX node (a decorative <svg>).
// Use either `action` (Link) or `onAction` (callback) — never both. The
// visual layout stays consistent across pages so users recognize it.

export default function EmptyState({ icon, title, message, action, onAction, actionLabel, children }) {
  return (
    <div className="empty-state">
      {icon && <div className="empty-state-icon" aria-hidden="true">{icon}</div>}
      {title && <h3 className="empty-state-title">{title}</h3>}
      {message && <p className="empty-state-message">{message}</p>}
      {children}
      {action && (
        <Link to={action} className="btn btn-primary btn-sm empty-state-cta">{actionLabel}</Link>
      )}
      {onAction && (
        <button type="button" className="btn btn-primary btn-sm empty-state-cta" onClick={onAction}>
          {actionLabel}
        </button>
      )}
    </div>
  );
}
