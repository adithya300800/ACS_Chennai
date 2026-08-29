const express = require('express');
const router = express.Router();

let Resend;
let resendClient = null;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
if (RESEND_API_KEY) {
  try {
    Resend = require('resend').Resend;
    resendClient = new Resend(RESEND_API_KEY);
  } catch (e) {
    // resend dep not installed — fall back to 503
    console.warn('[contact] resend package not installed; contact form disabled');
  }
}

// Project type allowlist (AppSec #17 — input validation)
const ALLOWED_PROJECT_TYPES = new Set([
  'Chemical',
  'Pharmaceutical',
  'Residential',
  'Industrial',
  'Logistics',
  'Other',
]);

// Minimal HTML escape for user-supplied values interpolated into HTML email body.
// Email clients vary in built-in sanitization — escape explicitly to be safe.
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// POST /api/contact — send contact form email
router.post('/', async (req, res) => {
  if (!resendClient) {
    return res.status(503).json({ error: 'Email service not configured' });
  }

  const { name, company, email, phone, projectType, message } = req.body || {};

  if (!name || !email || !message) {
    return res.status(400).json({ error: 'Name, email, and message are required' });
  }

  // Length limits to prevent abuse
  const MAX = { name: 120, company: 200, email: 254, phone: 30, message: 4000 };
  for (const [k, max] of Object.entries(MAX)) {
    if (req.body[k] && String(req.body[k]).length > max) {
      return res.status(400).json({ error: `${k} exceeds ${max} chars` });
    }
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: 'Invalid email format' });
  }

  const safeProjectType = ALLOWED_PROJECT_TYPES.has(projectType) ? projectType : null;

  try {
    await resendClient.emails.send({
      from: 'info@acschennai.com',
      to: 'info@acschennai.com',
      replyTo: email,
      subject: `Project Enquiry${safeProjectType ? ` — ${safeProjectType}` : ''} from ${escapeHtml(name)}`,
      html: `<h2>New Project Enquiry</h2>
<p><strong>Name:</strong> ${escapeHtml(name)}</p>
<p><strong>Company:</strong> ${escapeHtml(company) || 'N/A'}</p>
<p><strong>Email:</strong> ${escapeHtml(email)}</p>
<p><strong>Phone:</strong> ${escapeHtml(phone) || 'N/A'}</p>
<p><strong>Project Type:</strong> ${escapeHtml(safeProjectType) || 'Not specified'}</p>
<hr />
<p><strong>Message:</strong></p>
<p>${escapeHtml(message).replace(/\n/g, '<br/>')}</p>`,
    });

    res.json({ success: true });
  } catch (err) {
    console.error('[contact] Resend error', err.message);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

module.exports = router;
