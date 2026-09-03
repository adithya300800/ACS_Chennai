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

function renderDprReviewed({ notification, context, wrapHtml, ctaButton, escapeHtml, portalUrl }) {
  const projectName = context.projectName || 'your project';
  return {
    subject: `Your DPR for ${projectName} was reviewed`,
    html: wrapHtml({
      preheader: `Your DPR was reviewed.`,
      bodyHtml: heading('Daily Progress Report reviewed')
        + paragraph(`Your Daily Progress Report for <strong>${escapeHtml(projectName)}</strong> on <strong>${escapeHtml(context.reportDate || '')}</strong> was reviewed by an admin.`)
        + paragraph(escapeHtml(notification.message || ''))
        + ctaButton({ href: `${portalUrl}/portal/dpr/${escapeHtml(notification.dprId || '')}`, label: 'View DPR' }),
    }),
  };
}

function renderDprApproved({ notification, context, wrapHtml, ctaButton, escapeHtml, portalUrl }) {
  const projectName = context.projectName || 'your project';
  return {
    subject: `Your DPR for ${projectName} was approved`,
    html: wrapHtml({
      preheader: `DPR approved.`,
      bodyHtml: heading('Daily Progress Report approved')
        + paragraph(`Your Daily Progress Report for <strong>${escapeHtml(projectName)}</strong> on <strong>${escapeHtml(context.reportDate || '')}</strong> was approved.`)
        + paragraph(escapeHtml(notification.message || ''))
        + ctaButton({ href: `${portalUrl}/portal/dpr/${escapeHtml(notification.dprId || '')}`, label: 'View DPR' }),
    }),
  };
}

function renderDprRejected({ notification, context, wrapHtml, ctaButton, escapeHtml, portalUrl }) {
  const projectName = context.projectName || 'your project';
  return {
    subject: `Your DPR for ${projectName} was rejected`,
    html: wrapHtml({
      preheader: `DPR rejected — see reason.`,
      bodyHtml: heading('Daily Progress Report rejected')
        + paragraph(`Your Daily Progress Report for <strong>${escapeHtml(projectName)}</strong> on <strong>${escapeHtml(context.reportDate || '')}</strong> was rejected.`)
        + paragraph(escapeHtml(notification.message || ''))
        + ctaButton({ href: `${portalUrl}/portal/dpr/${escapeHtml(notification.dprId || '')}`, label: 'View DPR' }),
    }),
  };
}

function renderInspectionAcknowledged({ notification, wrapHtml, ctaButton, escapeHtml, portalUrl }) {
  return {
    subject: 'Inspection acknowledged',
    html: wrapHtml({
      preheader: 'Inspection acknowledged by admin.',
      bodyHtml: heading('Inspection acknowledged')
        + paragraph(escapeHtml(notification.message || 'An admin acknowledged your inspection.'))
        + (notification.dprId ? ctaButton({ href: `${portalUrl}/portal/inspection/${escapeHtml(notification.id || '')}`, label: 'View inspection' }) : ''),
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
        + ctaButton({ href: `${portalUrl}/portal/inspection`, label: 'View inspections' }),
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
        + ctaButton({ href: `${portalUrl}/portal/inspection`, label: 'View inspections' }),
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
        + ctaButton({ href: `${portalUrl}/portal/leave`, label: 'View leave' }),
    }),
  };
}

function renderTrainingAssigned({ notification, context, wrapHtml, ctaButton, escapeHtml, portalUrl }) {
  const title = context.courseTitle || 'a training course';
  return {
    subject: `New training assigned: ${title}`,
    html: wrapHtml({
      preheader: `New training assigned.`,
      bodyHtml: heading('New training assigned')
        + paragraph(`You have been assigned to <strong>${escapeHtml(title)}</strong>.`)
        + (context.dueDate ? paragraph(`<strong>Due:</strong> ${escapeHtml(context.dueDate)}.`) : '')
        + ctaButton({ href: `${portalUrl}/portal/training/${escapeHtml(notification.trainingEnrollmentId || '')}`, label: 'Start course' }),
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
        + ctaButton({ href: `${portalUrl}/portal/training`, label: 'View my training' }),
    }),
  };
}

function renderTrainingInProgress({ notification, context, wrapHtml, ctaButton, escapeHtml, portalUrl }) {
  const title = context.courseTitle || 'a training course';
  return {
    subject: `You started: ${title}`,
    html: wrapHtml({
      preheader: 'You started a course.',
      bodyHtml: heading('Course started')
        + paragraph(`You started <strong>${escapeHtml(title)}</strong>. Continue whenever you're ready.`)
        + ctaButton({ href: `${portalUrl}/portal/training/${escapeHtml(notification.trainingEnrollmentId || '')}`, label: 'Resume' }),
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
        + ctaButton({ href: `${portalUrl}/portal/training`, label: 'View my training' }),
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
    + ctaButton({ href: `${portalUrl}/portal/notifications`, label: 'View all notifications' });

  return {
    subject,
    html: wrapHtml({
      preheader: `${totalCount} new update${totalCount === 1 ? '' : 's'} in your daily digest.`,
      bodyHtml,
    }),
  };
}

module.exports = { types, renderDigest };
