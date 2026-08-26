const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'change-me-refresh-in-production';

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
