const express = require('express');
const router = express.Router();
const { Resend } = require('resend');

const RESEND_API_KEY = process.env.RESEND_API_KEY;

const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

// POST /api/contact - Send contact form email
router.post('/', async (req, res) => {
  if (!resend) {
    return res.status(503).json({ error: 'Email service not configured' });
  }

  const { name, company, email, phone, projectType, message } = req.body;

  // Validate required fields
  if (!name || !email || !message) {
    return res.status(400).json({ error: 'Name, email, and message are required' });
  }

  // Validate email format
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: 'Invalid email format' });
  }

  try {
    await resend.emails.send({
      from: 'info@acschennai.com',
      to: 'info@acschennai.com',
      subject: `Project Enquiry${projectType ? ` — ${projectType}` : ''} from ${name}`,
      html: `<h2>New Project Enquiry</h2>
<p><strong>Name:</strong> ${name}</p>
<p><strong>Company:</strong> ${company || 'N/A'}</p>
<p><strong>Email:</strong> ${email}</p>
<p><strong>Phone:</strong> ${phone || 'N/A'}</p>
<p><strong>Project Type:</strong> ${projectType || 'Not specified'}</p>
<hr />
<p><strong>Message:</strong></p>
<p>${message.replace(/\n/g, '<br/>')}</p>`,
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Contact email error:', err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

module.exports = router;
