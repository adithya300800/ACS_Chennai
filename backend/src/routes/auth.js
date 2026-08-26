const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'change-me-refresh-in-production';

// Zoho OAuth config
const ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID;
const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
const ZOHO_REDIRECT_URI = process.env.ZOHO_REDIRECT_URI;
const ZOHO_DOMAIN = process.env.ZOHO_DOMAIN || 'https://accounts.zoho.com';

// GET /api/auth/zoho - Initiate Zoho OAuth
router.get('/zoho', (req, res) => {
  if (!ZOHO_CLIENT_ID || !ZOHO_REDIRECT_URI) {
    return res.status(503).json({ error: 'Zoho OAuth not configured' });
  }

  const scopes = 'ZohoOAuth.userinfo.profile.READ';
  const state = Math.random().toString(36).substring(7);

  const authUrl = `${ZOHO_DOMAIN}/oauth/v2/auth?` +
    `response_type=code&` +
    `client_id=${ZOHO_CLIENT_ID}&` +
    `redirect_uri=${encodeURIComponent(ZOHO_REDIRECT_URI)}&` +
    `scope=${encodeURIComponent(scopes)}&` +
    `state=${state}&` +
    `access_type=offline`;

  res.json({ authUrl });
});

// GET /api/auth/zoho/callback - Zoho redirects here with code
router.get('/zoho/callback', async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.send('<html><body><script>window.opener.postMessage({error: "No code received"}, "*"); window.close();</script><p>No authorization code received. Please close this window and try again.</p></body></html>');
  }

  // Send code to opener window and close
  res.send(`<html><body><script>
    window.opener.postMessage({ code: "${code}" }, "*");
    setTimeout(function() { window.close(); }, 1000);
  </script><p>Authentication successful! Closing...</p></body></html>`);
});

// POST /api/auth/zoho/callback - Exchange code for tokens and login
router.post('/zoho/callback', async (req, res) => {
  const { code } = req.body;

  if (!code) {
    return res.status(400).json({ error: 'Authorization code required' });
  }

  if (!ZOHO_CLIENT_ID || !ZOHO_CLIENT_SECRET || !ZOHO_REDIRECT_URI) {
    return res.status(503).json({ error: 'Zoho OAuth not configured' });
  }

  try {
    // Exchange code for tokens
    const tokenRes = await fetch(`${ZOHO_DOMAIN}/oauth/v2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: ZOHO_CLIENT_ID,
        client_secret: ZOHO_CLIENT_SECRET,
        redirect_uri: ZOHO_REDIRECT_URI,
        code,
      }),
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      console.error('Zoho token error:', err);
      return res.status(401).json({ error: 'Failed to authenticate with Zoho' });
    }

    const tokens = await tokenRes.json();
    const { access_token, refresh_token } = tokens;

    // Get user info from Zoho
    const userRes = await fetch(`${ZOHO_DOMAIN}/oauth/userinfo`, {
      headers: { Authorization: `Bearer ${access_token}` },
    });

    if (!userRes.ok) {
      return res.status(401).json({ error: 'Failed to get user info from Zoho' });
    }

    const zohoUser = await userRes.json();
    const email = zohoUser.email;

    if (!email) {
      return res.status(400).json({ error: 'Could not get email from Zoho' });
    }

    const prisma = req.app.get('prisma');

    // Find or create employee
    let employee = await prisma.employee.findUnique({ where: { email } });

    if (!employee) {
      const nameParts = email.split('@')[0].replace(/[._]/g, ' ').split(' ');
      const name = nameParts.map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(' ');

      employee = await prisma.employee.create({
        data: {
          email,
          name,
          zohoAccessToken: access_token,
          zohoRefreshToken: refresh_token,
        },
      });
    } else {
      // Update tokens
      employee = await prisma.employee.update({
        where: { email },
        data: {
          zohoAccessToken: access_token,
          zohoRefreshToken: refresh_token,
        },
      });
    }

    // Generate JWT
    const jwtToken = jwt.sign(
      { employeeId: employee.id, email: employee.email },
      JWT_SECRET,
      { expiresIn: '8h' }
    );

    const refreshToken = jwt.sign(
      { employeeId: employee.id },
      JWT_REFRESH_SECRET,
      { expiresIn: '7d' }
    );

    const { password: _, ...employeeData } = employee;

    res.json({
      accessToken: jwtToken,
      refreshToken,
      employee: employeeData,
    });
  } catch (err) {
    console.error('Zoho OAuth error:', err);
    res.status(500).json({ error: 'Zoho authentication failed' });
  }
});

// POST /api/auth/login

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const prisma = req.app.get('prisma');
  const { email, password } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  try {
    let employee = await prisma.employee.findUnique({ where: { email } });

    // Auto-create employee on first login (for Zoho SSO flow)
    if (!employee) {
      // Extract name from email prefix (e.g., "john.doe@acschennai.com" -> "John Doe")
      const nameParts = email.split('@')[0].replace(/[._]/g, ' ').split(' ');
      const name = nameParts.map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(' ');

      employee = await prisma.employee.create({
        data: {
          email,
          name,
          password: null, // No password for SSO users
        },
      });
    } else if (password) {
      // Login with password (for admin users with password)
      const valid = await bcrypt.compare(password, employee.password);
      if (!valid) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }
    } else if (!employee.password) {
      // Employee exists but has no password (SSO user) and no password provided
      return res.status(401).json({ error: 'Please use Zoho SSO to login' });
    }

    const accessToken = jwt.sign(
      { employeeId: employee.id, email: employee.email },
      JWT_SECRET,
      { expiresIn: '8h' }
    );

    const refreshToken = jwt.sign(
      { employeeId: employee.id },
      JWT_REFRESH_SECRET,
      { expiresIn: '7d' }
    );

    // Don't send password back
    const { password: _, ...employeeData } = employee;

    res.json({
      accessToken,
      refreshToken,
      employee: employeeData,
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// POST /api/auth/refresh
router.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body;

  if (!refreshToken) {
    return res.status(400).json({ error: 'Refresh token required' });
  }

  try {
    const decoded = jwt.verify(refreshToken, JWT_REFRESH_SECRET);
    const prisma = req.app.get('prisma');

    const employee = await prisma.employee.findUnique({
      where: { id: decoded.employeeId },
    });

    if (!employee) {
      return res.status(401).json({ error: 'Employee not found' });
    }

    const accessToken = jwt.sign(
      { employeeId: employee.id, email: employee.email },
      JWT_SECRET,
      { expiresIn: '8h' }
    );

    res.json({ accessToken });
  } catch (err) {
    res.status(401).json({ error: 'Invalid refresh token' });
  }
});

// GET /api/auth/me
router.get('/me', requireAuth, async (req, res) => {
  const prisma = req.app.get('prisma');

  try {
    const employee = await prisma.employee.findUnique({
      where: { id: req.employeeId },
      select: {
        id: true,
        email: true,
        name: true,
        designation: true,
        department: true,
        createdAt: true,
      },
    });

    if (!employee) {
      return res.status(404).json({ error: 'Employee not found' });
    }

    res.json(employee);
  } catch (err) {
    console.error('Me error:', err);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// Middleware: require auth
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization required' });
  }

  const token = authHeader.slice(7);

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.employeeId = decoded.employeeId;
    req.email = decoded.email;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = router;
// Zoho OAuth trigger
