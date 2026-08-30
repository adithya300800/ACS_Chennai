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

// Canonical project categories — used to bucket the (free-text) projectType
// the form sends into an enum for analytics / routing. The frontend sends
// descriptive strings (e.g. "PMC / Project Management Consultancy") which
// are preserved verbatim; this map only classifies them.
const PROJECT_CATEGORIES = new Set([
  'Chemical',
  'Pharmaceutical',
  'Residential',
  'Industrial',
  'Logistics',
  'Commercial',
  'Consulting',
  'Audit',
  'Planning',
  'Other',
]);

function deriveProjectCategory(rawProjectType) {
  if (!rawProjectType || typeof rawProjectType !== 'string') return null;
  const text = rawProjectType.toLowerCase();

  // Order matters — more specific patterns first.
  if (text.includes('pmc') || text.includes('project management consultancy')) return 'Consulting';
  if (text.includes('chemical') || text.includes('pharmaceutical')) return 'Chemical';
  if (text.includes('residential') || text.includes('township')) return 'Residential';
  if (text.includes('commercial')) return 'Commercial';
  if (text.includes('warehouse') || text.includes('logistics')) return 'Logistics';
  if (text.includes('industrial') || text.includes('factory')) return 'Industrial';
  if (text.includes('quantity') || text.includes('billing') || text.includes('audit')) return 'Audit';
  if (text.includes('qa') || text.includes('qc') || text.includes('consulting')) return 'Consulting';
  if (text.includes('planning') || text.includes('scheduling')) return 'Planning';

  // Direct enum-name match (legacy allowlist callers)
  const direct = rawProjectType.trim();
  if (PROJECT_CATEGORIES.has(direct)) return direct;

  return null;
}

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

  const { name, company, email, phone, projectType, message, website } = req.body || {};

  if (!name || !email || !message) {
    return res.status(400).json({ error: 'Name, email, and message are required' });
  }

  // Honeypot: bots typically auto-fill every visible input including
  // hidden ones. A non-empty `website` field is a strong spam signal.
  // Silently succeed so the bot doesn't retry or adapt.
  if (typeof website === 'string' && website.trim().length > 0) {
    console.warn('[contact] honeypot triggered, dropping submission');
    return res.json({ success: true });
  }

  // Length limits to prevent abuse
  const MAX = { name: 120, company: 200, email: 254, phone: 30, projectType: 200, message: 4000 };
  for (const [k, max] of Object.entries(MAX)) {
    if (req.body[k] && String(req.body[k]).length > max) {
      return res.status(400).json({ error: `${k} exceeds ${max} chars` });
    }
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: 'Invalid email format' });
  }

  // Preserve the user's raw projectType verbatim (P0-5 fix). Derive a
  // canonical category for analytics, but do NOT silently null it.
  const rawProjectType = (typeof projectType === 'string' && projectType.trim().length > 0)
    ? projectType.trim()
    : null;
  const projectCategory = deriveProjectCategory(rawProjectType);

  try {
    await resendClient.emails.send({
      from: 'info@acschennai.com',
      to: 'info@acschennai.com',
      replyTo: email,
      subject: `Project Enquiry${rawProjectType ? ` — ${rawProjectType}` : ''} from ${escapeHtml(name)}`,
      html: `<h2>New Project Enquiry</h2>
<p><strong>Name:</strong> ${escapeHtml(name)}</p>
<p><strong>Company:</strong> ${escapeHtml(company) || 'N/A'}</p>
<p><strong>Email:</strong> ${escapeHtml(email)}</p>
<p><strong>Phone:</strong> ${escapeHtml(phone) || 'N/A'}</p>
<p><strong>Project Type:</strong> ${escapeHtml(rawProjectType) || 'Not specified'}</p>
<p><strong>Project Category:</strong> ${escapeHtml(projectCategory) || 'Unclassified'}</p>
<hr />
<p><strong>Message:</strong></p>
<p>${escapeHtml(message).replace(/\n/g, '<br/>')}</p>`,
    });

    res.json({ success: true, projectCategory });
  } catch (err) {
    console.error('[contact] Resend error', err.message);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

module.exports = router;
