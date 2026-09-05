// Round-25: per-type email template renderers.
//
// Each renderer returns `{ subject, html }`. Inputs:
//   - `notification` — the Prisma row (id, type, message, dprId, etc.)
//   - `context` — extra fields the call site provides (projectName, courseTitle,
//     decisionAction, reason, etc.)
//   - `recipientEmail` — the address we're sending to
//   - helpers — wrapHtml, ctaButton, escapeHtml, portalUrl
//
// All user-supplied values MUST be passed through escapeHtml.

function paragraph(text) {
  return `<p style="margin:0 0 12px 0;font-size:15px;line-height:1.5;color:#111;">${text}</p>`;
}

function heading(text) {
  return `<h1 style="margin:0 0 12px 0;font-size:18px;line-height:1.3;color:#0a2540;font-weight:600;">${text}</h1>`;
}

// DR-015: route map — every CTA in every template goes through
// portalLinks so the `#/` hash prefix is always present and the
// target is one of the App.jsx routes in the route inventory. Inline
// `${portalUrl}/portal/...` strings were broken on two axes:
//   1. No `#` — the static-site host serves the homepage shell for
//      any non-hash path.
//   2. Some targets didn't exist in App.jsx (e.g. `/portal/dpr/:id`).
const portalLinks = require('../../lib/portalLinks');

function renderDprReviewed({ notification, context, wrapHtml, ctaButton, escapeHtml, portalUrl }) {
  const projectName = context.projectName || 'your project';
  const cta = notification.dprId ? portalLinks.dprDetailHref(notification.dprId) : portalLinks.dprMyHref();
  return {
    subject: `Your DPR for ${projectName} was reviewed`,
    html: wrapHtml({
      preheader: `Your DPR was reviewed.`,
      bodyHtml: heading('Daily Progress Report reviewed')
        + paragraph(`Your Daily Progress Report for <strong>${escapeHtml(projectName)}</strong> on <strong>${escapeHtml(context.reportDate || '')}</strong> was reviewed by an admin.`)
        + paragraph(escapeHtml(notification.message || ''))
        + ctaButton({ href: cta, label: 'View DPR' }),
    }),
  };
}

function renderDprApproved({ notification, context, wrapHtml, ctaButton, escapeHtml, portalUrl }) {
  const projectName = context.projectName || 'your project';
  const cta = notification.dprId ? portalLinks.dprDetailHref(notification.dprId) : portalLinks.dprMyHref();
  return {
    subject: `Your DPR for ${projectName} was approved`,
    html: wrapHtml({
      preheader: `DPR approved.`,
      bodyHtml: heading('Daily Progress Report approved')
        + paragraph(`Your Daily Progress Report for <strong>${escapeHtml(projectName)}</strong> on <strong>${escapeHtml(context.reportDate || '')}</strong> was approved.`)
        + paragraph(escapeHtml(notification.message || ''))
        + ctaButton({ href: cta, label: 'View DPR' }),
    }),
  };
}

function renderDprRejected({ notification, context, wrapHtml, ctaButton, escapeHtml, portalUrl }) {
  const projectName = context.projectName || 'your project';
  const cta = notification.dprId ? portalLinks.dprDetailHref(notification.dprId) : portalLinks.dprMyHref();
  return {
    subject: `Your DPR for ${projectName} was rejected`,
    html: wrapHtml({
      preheader: `DPR rejected — see reason.`,
      bodyHtml: heading('Daily Progress Report rejected')
        + paragraph(`Your Daily Progress Report for <strong>${escapeHtml(projectName)}</strong> on <strong>${escapeHtml(context.reportDate || '')}</strong> was rejected.`)
        + paragraph(escapeHtml(notification.message || ''))
        + ctaButton({ href: cta, label: 'View DPR' }),
    }),
  };
}

function renderInspectionAcknowledged({ notification, wrapHtml, ctaButton, escapeHtml, portalUrl }) {
  // Per inspection.js: the notification row carries the inspection's
  // own ID in `meta.inspectionId` (round-26 fan-out). Fall back to
  // `notification.id` for older rows; if neither is set, route to the
  // employee's list (they can find it there).
  const inspectionId = notification.inspectionId || notification.id;
  const cta = inspectionId ? portalLinks.inspectionDetailHref(inspectionId) : portalLinks.inspectionMyHref();
  return {
    subject: 'Inspection acknowledged',
    html: wrapHtml({
      preheader: 'Inspection acknowledged by admin.',
      bodyHtml: heading('Inspection acknowledged')
        + paragraph(escapeHtml(notification.message || 'An admin acknowledged your inspection.'))
        + ctaButton({ href: cta, label: 'View inspection' }),
    }),
  };
}

function renderInspectionClosed({ notification, wrapHtml, ctaButton, escapeHtml, portalUrl }) {
  return {
    subject: 'Inspection closed',
    html: wrapHtml({
      preheader: 'Inspection closed by admin.',
      bodyHtml: heading('Inspection closed')
        + paragraph(escapeHtml(notification.message || 'An admin closed your inspection.'))
        + ctaButton({ href: portalLinks.inspectionMyHref(), label: 'View inspections' }),
    }),
  };
}

function renderInspectionRejected({ notification, context, wrapHtml, ctaButton, escapeHtml, portalUrl }) {
  return {
    subject: 'Inspection rejected',
    html: wrapHtml({
      preheader: 'Inspection rejected — see reason.',
      bodyHtml: heading('Inspection rejected')
        + paragraph(escapeHtml(notification.message || 'Your inspection was rejected.'))
        + (context.reason ? paragraph(`<strong>Reason:</strong> ${escapeHtml(context.reason)}`) : '')
        + ctaButton({ href: portalLinks.inspectionMyHref(), label: 'View inspections' }),
    }),
  };
}

function renderLeaveDecided({ notification, wrapHtml, ctaButton, escapeHtml, portalUrl }) {
  return {
    subject: 'Leave request update',
    html: wrapHtml({
      preheader: 'Your leave request was decided.',
      bodyHtml: heading('Leave request update')
        + paragraph(escapeHtml(notification.message || 'Your leave request was updated.'))
        + ctaButton({ href: portalLinks.leaveMyHref(), label: 'View leave' }),
    }),
  };
}

function renderTrainingAssigned({ notification, context, wrapHtml, ctaButton, escapeHtml, portalUrl }) {
  const title = context.courseTitle || 'a training course';
  // The notification row carries `trainingEnrollmentId` for player-link
  // routes; fall back to the hub list when the row is older/missing.
  const enrollmentId = notification.trainingEnrollmentId;
  const cta = enrollmentId ? portalLinks.trainingDetailHref(enrollmentId) : portalLinks.trainingMyHref();
  return {
    subject: `New training assigned: ${title}`,
    html: wrapHtml({
      preheader: `New training assigned.`,
      bodyHtml: heading('New training assigned')
        + paragraph(`You have been assigned to <strong>${escapeHtml(title)}</strong>.`)
        + (context.dueDate ? paragraph(`<strong>Due:</strong> ${escapeHtml(context.dueDate)}.`) : '')
        + ctaButton({ href: cta, label: 'Start course' }),
    }),
  };
}

function renderTrainingCancelled({ notification, context, wrapHtml, ctaButton, escapeHtml, portalUrl }) {
  const title = context.courseTitle || 'a training course';
  return {
    subject: `Training unassigned: ${title}`,
    html: wrapHtml({
      preheader: 'A training was unassigned.',
      bodyHtml: heading('Training unassigned')
        + paragraph(`An admin unassigned <strong>${escapeHtml(title)}</strong> from your queue.`)
        + (context.note ? paragraph(`<strong>Reason:</strong> ${escapeHtml(context.note)}`) : '')
        + ctaButton({ href: portalLinks.trainingMyHref(), label: 'View my training' }),
    }),
  };
}

function renderTrainingInProgress({ notification, context, wrapHtml, ctaButton, escapeHtml, portalUrl }) {
  const title = context.courseTitle || 'a training course';
  const enrollmentId = notification.trainingEnrollmentId;
  const cta = enrollmentId ? portalLinks.trainingDetailHref(enrollmentId) : portalLinks.trainingMyHref();
  return {
    subject: `You started: ${title}`,
    html: wrapHtml({
      preheader: 'You started a course.',
      bodyHtml: heading('Course started')
        + paragraph(`You started <strong>${escapeHtml(title)}</strong>. Continue whenever you're ready.`)
        + ctaButton({ href: cta, label: 'Resume' }),
    }),
  };
}

function renderTrainingCompleted({ notification, context, wrapHtml, ctaButton, escapeHtml, portalUrl }) {
  const title = context.courseTitle || 'a training course';
  return {
    subject: `Training completed: ${title}`,
    html: wrapHtml({
      preheader: 'You finished a course.',
      bodyHtml: heading('Training completed 🎉')
        + paragraph(`You completed <strong>${escapeHtml(title)}</strong>.`)
        + ctaButton({ href: portalLinks.trainingMyHref(), label: 'View my training' }),
    }),
  };
}

const types = {
  DPR_REVIEWED: renderDprReviewed,
  DPR_APPROVED: renderDprApproved,
  DPR_REJECTED: renderDprRejected,
  INSPECTION_ACKNOWLEDGED: renderInspectionAcknowledged,
  INSPECTION_CLOSED: renderInspectionClosed,
  INSPECTION_REJECTED: renderInspectionRejected,
  LEAVE_DECIDED: renderLeaveDecided,
  TRAINING_ASSIGNED: renderTrainingAssigned,
  TRAINING_CANCELLED: renderTrainingCancelled,
  TRAINING_IN_PROGRESS: renderTrainingInProgress,
  TRAINING_COMPLETED: renderTrainingCompleted,
  // Round-26: admin-targeted IMMEDIATE types. These bypass the daily digest
  // (they don't go through `notify.js#fanOutEmail`) — `fanOutToAdmins`
  // renders + sends synchronously because the source event (DPR submit,
  // inspection open, etc.) is already the IMPLICIT signal that an admin
  // needs to act.
  ADMIN_DPR_SUBMITTED: renderAdminDprSubmitted,
  ADMIN_INSPECTION_OPENED: renderAdminInspectionOpened,
  ADMIN_LEAVE_REQUESTED: renderAdminLeaveRequested,
  ADMIN_TRAINING_OVERDUE: renderAdminTrainingOverdue,
};

/**
 * Round-25 (M2): daily digest renderer. Different shape from the per-type
 * templates — the digest is a GROUPED LIST of recent activity, not a single
 * event. Lives here (vs. its own file) so the renderer registry stays
 * one-stop for both the immediate templates and the digest.
 *
 * The digest handler in routes/internal-digest.js groups the items by type
 * and passes the already-grouped list to this renderer. We don't re-group
 * here so the handler owns the "what order do the sections appear" decision.
 */
function renderDigest({ context, wrapHtml, ctaButton, escapeHtml, portalUrl }) {
  const employeeName = context.employeeName || 'there';
  const dateLabel = context.dateLabel || '';
  const groups = Array.isArray(context.groups) ? context.groups : [];

  const totalCount = groups.reduce((sum, g) => sum + g.items.length, 0);
  const subject = `Daily digest: ${totalCount} new update${totalCount === 1 ? '' : 's'} · ${dateLabel}`;

  // Build the grouped body. If a group has 0 items the handler shouldn't
  // have passed it; we tolerate empty groups here by rendering nothing.
  const groupSections = groups
    .filter((g) => Array.isArray(g.items) && g.items.length > 0)
    .map((g) => {
      const rows = g.items
        .map((item) => `<li style="margin:0 0 6px 0;font-size:14px;line-height:1.45;color:#111;">${escapeHtml(item.label)}</li>`)
        .join('');
      return `<h2 style="margin:16px 0 8px 0;font-size:15px;line-height:1.3;color:#0a2540;font-weight:600;">${escapeHtml(g.heading)} <span style="color:#6b7280;font-weight:400;">(${g.items.length})</span></h2>`
        + `<ul style="margin:0 0 0 20px;padding:0;">${rows}</ul>`;
    })
    .join('');

  const bodyHtml = `<h1 style="margin:0 0 12px 0;font-size:18px;line-height:1.3;color:#0a2540;font-weight:600;">Your daily digest</h1>`
    + `<p style="margin:0 0 12px 0;font-size:15px;line-height:1.5;color:#111;">Hi ${escapeHtml(employeeName)}, here's what happened on <strong>${escapeHtml(dateLabel)}</strong>.</p>`
    + (totalCount === 0
      ? '<p style="margin:0 0 12px 0;font-size:15px;color:#6b7280;">No new updates — you&rsquo;re all caught up.</p>'
      : groupSections)
    // DR-015: `/portal/notifications` is not a route in App.jsx; the
    // nearest reachable target is the preferences page, which is also
    // the user's logical "notifications inbox" for this digest.
    + ctaButton({ href: portalLinks.notificationsInboxHref(), label: 'View all notifications' });

  return {
    subject,
    html: wrapHtml({
      preheader: `${totalCount} new update${totalCount === 1 ? '' : 's'} in your daily digest.`,
      bodyHtml,
    }),
  };
}

// ─── Round-26: Admin-targeted renderers ──────────────────────────────────
//
// Four IMMEDIATE admin types (DPR_SUBMITTED, INSPECTION_OPENED,
// LEAVE_REQUESTED, TRAINING_OVERDUE) and one DIGEST (ADMIN_ATTENDANCE_DAILY).
// The IMMEDIATE types are registered in the `types` registry below so the
// existing `renderTemplate(type, payload)` dispatch in index.js routes to
// them; the attendance digest is exported separately because, like the
// employee `renderDigest`, it takes pre-grouped data.
//
// All five follow the same chrome as the employee templates (heading +
// paragraph + CTA) but skip the employee-facing "your DPR was approved"
// voice — admins get a terse, action-oriented subject + body so they can
// scan the inbox and decide whether to open the portal.

function renderAdminDprSubmitted({ context, wrapHtml, ctaButton, escapeHtml, portalUrl }) {
  const projectName = context.projectName || 'a project';
  const employeeName = context.employeeName || 'an employee';
  const reportDate = context.reportDate || '';
  return {
    subject: `New DPR: ${projectName} — ${employeeName}${reportDate ? ` · ${reportDate}` : ''}`,
    html: wrapHtml({
      preheader: `New DPR submitted by ${employeeName}.`,
      bodyHtml: heading('New Daily Progress Report submitted')
        + paragraph(`<strong>${escapeHtml(employeeName)}</strong> submitted a DPR for <strong>${escapeHtml(projectName)}</strong>${reportDate ? ` on <strong>${escapeHtml(reportDate)}</strong>` : ''}.`)
        + (context.dprId ? ctaButton({ href: portalLinks.dprDetailHref(context.dprId), label: 'Review DPR' }) : ctaButton({ href: portalLinks.dprQueueAdminHref(), label: 'Open DPR queue' })),
    }),
  };
}

function renderAdminInspectionOpened({ context, wrapHtml, ctaButton, escapeHtml, portalUrl }) {
  const employeeName = context.employeeName || 'an employee';
  const recordTitle = context.recordTitle || 'an inspection';
  const inspectionType = context.inspectionType || '';
  return {
    subject: `New inspection: ${recordTitle} — ${employeeName}`,
    html: wrapHtml({
      preheader: `New inspection opened by ${employeeName}.`,
      bodyHtml: heading('New inspection opened')
        + paragraph(`<strong>${escapeHtml(employeeName)}</strong> opened a new inspection: <strong>${escapeHtml(recordTitle)}</strong>${inspectionType ? ` (${escapeHtml(inspectionType)})` : ''}.`)
        + (context.inspectionId ? ctaButton({ href: portalLinks.inspectionDetailHref(context.inspectionId), label: 'Review inspection' }) : ctaButton({ href: portalLinks.inspectionQueueAdminHref(), label: 'Open inspection queue' })),
    }),
  };
}

function renderAdminLeaveRequested({ context, wrapHtml, ctaButton, escapeHtml, portalUrl }) {
  const employeeName = context.employeeName || 'an employee';
  const fromDate = context.fromDate || '';
  const toDate = context.toDate || '';
  const leaveType = context.leaveType || '';
  const daysCount = context.daysCount;
  return {
    subject: `Leave requested: ${employeeName}${fromDate && toDate ? ` · ${fromDate} → ${toDate}` : ''}`,
    html: wrapHtml({
      preheader: `Leave request from ${employeeName}.`,
      bodyHtml: heading('New leave request')
        + paragraph(`<strong>${escapeHtml(employeeName)}</strong> requested leave${leaveType ? ` (${escapeHtml(leaveType)})` : ''}.`)
        + (fromDate && toDate ? paragraph(`<strong>Dates:</strong> ${escapeHtml(fromDate)} → ${escapeHtml(toDate)}${daysCount ? ` · <strong>${escapeHtml(String(daysCount))}</strong> day${Number(daysCount) === 1 ? '' : 's'}` : ''}.`) : '')
        + ctaButton({ href: portalLinks.leaveMyHref(), label: 'Review leave request' }),
    }),
  };
}

function renderAdminTrainingOverdue({ context, wrapHtml, ctaButton, escapeHtml, portalUrl }) {
  const employeeName = context.employeeName || 'an employee';
  const courseTitle = context.courseTitle || 'a course';
  const dueDate = context.dueDate || '';
  const daysOverdue = context.daysOverdue;
  const priority = context.priority || '';
  return {
    subject: `Overdue: ${courseTitle} — ${employeeName}`,
    html: wrapHtml({
      preheader: `Training course overdue for ${employeeName}.`,
      bodyHtml: heading('Training course overdue')
        + paragraph(`<strong>${escapeHtml(employeeName)}</strong> has not completed <strong>${escapeHtml(courseTitle)}</strong> by the due date.`)
        + (dueDate ? paragraph(`<strong>Due:</strong> ${escapeHtml(dueDate)}${daysOverdue != null ? ` · <strong>${escapeHtml(String(daysOverdue))}</strong> day${Number(daysOverdue) === 1 ? '' : 's'} overdue` : ''}${priority ? ` · <strong>Priority:</strong> ${escapeHtml(priority)}` : ''}.`) : '')
        + (context.enrollmentId ? ctaButton({ href: portalLinks.trainingDetailHref(context.enrollmentId), label: 'Open enrollment' }) : ctaButton({ href: portalLinks.trainingQueueAdminHref(), label: 'Open training queue' })),
    }),
  };
}

/**
 * Round-26: admin-targeted daily attendance digest. Different shape from
 * the employee `renderDigest` — instead of a grouped list of recent
 * notifications, this is a per-employee status grid (Present / On approved
 * leave / Absent). The cron in routes/internal-admin-attendance.js computes
 * the three sections and passes them here.
 *
 * `context` shape:
 *   {
 *     istDateLabel: '3 Sept 2026',
 *     present: [{ name, checkInLabel }],
 *     onLeave: [{ name }],
 *     absent: [{ name }],
 *   }
 */
function renderAdminAttendanceDigest({ context, wrapHtml, ctaButton, escapeHtml, portalUrl }) {
  const dateLabel = context.istDateLabel || '';
  const present = Array.isArray(context.present) ? context.present : [];
  const onLeave = Array.isArray(context.onLeave) ? context.onLeave : [];
  const absent = Array.isArray(context.absent) ? context.absent : [];
  const totalEmployees = present.length + onLeave.length + absent.length;

  function renderSection(headingText, items, emptyText) {
    const headingHtml = `<h2 style="margin:16px 0 8px 0;font-size:15px;line-height:1.3;color:#0a2540;font-weight:600;">${escapeHtml(headingText)} <span style="color:#6b7280;font-weight:400;">(${items.length})</span></h2>`;
    if (items.length === 0) {
      return headingHtml + `<p style="margin:0 0 0 20px;padding:0;font-size:14px;color:#6b7280;font-style:italic;">${escapeHtml(emptyText)}</p>`;
    }
    const rows = items.map((item) => {
      const secondary = item.checkInLabel ? ` <span style="color:#6b7280;">· check-in ${escapeHtml(item.checkInLabel)}</span>` : '';
      return `<li style="margin:0 0 6px 0;font-size:14px;line-height:1.45;color:#111;">${escapeHtml(item.name)}${secondary}</li>`;
    }).join('');
    return headingHtml + `<ul style="margin:0 0 0 20px;padding:0;">${rows}</ul>`;
  }

  const summary = `<p style="margin:0 0 12px 0;font-size:15px;line-height:1.5;color:#111;"><strong>${present.length}</strong> present · <strong>${onLeave.length}</strong> on approved leave · <strong>${absent.length}</strong> absent</p>`;
  const bodyHtml = `<h1 style="margin:0 0 12px 0;font-size:18px;line-height:1.3;color:#0a2540;font-weight:600;">Daily attendance${dateLabel ? ` · ${escapeHtml(dateLabel)}` : ''}</h1>`
    + `<p style="margin:0 0 12px 0;font-size:15px;line-height:1.5;color:#111;">Here is the attendance roll-up for <strong>${escapeHtml(dateLabel)}</strong> (${totalEmployees} active employees).</p>`
    + summary
    + renderSection('Present', present, 'No one checked in today.')
    + renderSection('On approved leave', onLeave, 'No one on approved leave.')
    + renderSection('Absent', absent, 'No one is absent.')
    + ctaButton({ href: portalLinks.attendanceAdminHref(), label: 'View timesheet' });

  return {
    subject: `Daily attendance${dateLabel ? ` · ${dateLabel}` : ''}`,
    html: wrapHtml({
      preheader: `${present.length} present · ${onLeave.length} on leave · ${absent.length} absent`,
      bodyHtml,
    }),
  };
}

module.exports = { types, renderDigest, renderAdminAttendanceDigest };
