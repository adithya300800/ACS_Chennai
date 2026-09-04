// Round-25: Email template registry.
//
// Maps each notification type to a renderer that returns `{ subject, html }`.
// Per-type templates live in `./types.js` to keep this file as a tiny
// dispatch table.
//
// The renderer contract:
//   - input: { notification: <Prisma row>, context: <extra fields the call
//     site supplies — projectName, courseTitle, etc.>, recipientEmail }
//   - output: { subject: string, html: string }
//
// Templates MUST escape all user-supplied values via escapeHtml (re-exported
// from lib/email.js). The HTML body is intentionally simple — no React Email,
// no MJML, no inline CSS frameworks. The brand chrome (header bar, CTA
// button, footer) is shared via `wrapHtml` so a future style change is a
// single-file edit.

const { escapeHtml } = require('../../lib/email');
const { types, renderDigest, renderAdminAttendanceDigest } = require('./types');

const PORTAL_URL = process.env.FRONTEND_URL || 'https://acschennai.com';

function subjectPrefix() {
  return 'ACS Chennai';
}

/**
 * Brand chrome shared by all templates. Wraps the per-type body in a
 * centered single-column table with the acschennai.com header, the
 * notification content, and a footer linking to the portal preferences.
 */
function wrapHtml({ preheader, bodyHtml }) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(subjectPrefix())}</title>
  </head>
  <body style="margin:0;padding:0;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#111;">
    <span style="display:none;visibility:hidden;mso-hide:all;font-size:1px;color:#f5f5f7;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escapeHtml(preheader || '')}</span>
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:#f5f5f7;padding:24px 0;">
      <tr>
        <td align="center">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="560" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.06);">
            <tr>
              <td style="background:#0a2540;padding:16px 24px;color:#ffffff;font-size:14px;font-weight:600;letter-spacing:0.02em;">
                ${escapeHtml(subjectPrefix())} — ACS Portal
              </td>
            </tr>
            <tr>
              <td style="padding:24px;font-size:15px;line-height:1.5;color:#111;">
                ${bodyHtml}
              </td>
            </tr>
            <tr>
              <td style="padding:16px 24px;background:#fafbfc;border-top:1px solid #ececef;font-size:12px;color:#6b7280;line-height:1.5;">
                You can change which notifications we email you from
                <a href="${escapeHtml(PORTAL_URL)}/portal/notifications/preferences" style="color:#0a2540;">your preferences</a>.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

/**
 * Render a CTA button. `label` is the visible text, `href` is the click
 * target. Renders as a simple styled anchor inside a table cell so it
 * survives email clients that strip <div> or <button>.
 */
function ctaButton({ href, label }) {
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:20px 0 4px 0;">
    <tr>
      <td style="background:#0a2540;border-radius:8px;">
        <a href="${escapeHtml(href)}" style="display:inline-block;padding:10px 18px;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;">${escapeHtml(label)}</a>
      </td>
    </tr>
  </table>`;
}

function renderTemplate(type, payload) {
  const renderer = types[type];
  if (!renderer) {
    throw new Error(`No email template registered for notification type "${type}"`);
  }
  return renderer({ ...payload, wrapHtml, ctaButton, escapeHtml, portalUrl: PORTAL_URL });
}

/**
 * Round-25 (M2): daily-digest renderer. Separate from `renderTemplate` so the
 * immediate-type path keeps its simple `type -> renderer` mapping; the
 * digest is a fundamentally different shape (grouped list, not a single
 * event) and gets its own entry point.
 */
function renderDigestTemplate(payload) {
  return renderDigest({ ...payload, wrapHtml, ctaButton, escapeHtml, portalUrl: PORTAL_URL });
}

module.exports = { renderTemplate, renderDigestTemplate, renderAdminAttendanceDigest, wrapHtml, ctaButton, escapeHtml, PORTAL_URL };
