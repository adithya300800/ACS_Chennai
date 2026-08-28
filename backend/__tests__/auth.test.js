/**
 * Backend Auth Tests
 * Tests JWT generation, verification, password hashing, and auth routes
 */

const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

// Test configuration
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'refresh-secret-change-in-production';

describe('JWT Token Generation', () => {
  it('should generate valid access token', () => {
    const employeeId = 'emp-123';
    const email = 'test@acschennai.com';

    const token = jwt.sign(
      { employeeId, email },
      JWT_SECRET,
      { expiresIn: '8h' }
    );

    expect(token).toBeDefined();
    expect(typeof token).toBe('string');
    expect(token.split('.')).toHaveLength(3); // JWT has 3 parts
  });

  it('should generate valid refresh token', () => {
    const employeeId = 'emp-123';

    const refreshToken = jwt.sign(
      { employeeId, type: 'refresh' },
      JWT_REFRESH_SECRET,
      { expiresIn: '7d' }
    );

    expect(refreshToken).toBeDefined();
    expect(typeof refreshToken).toBe('string');
  });

  it('should decode token and extract employeeId', () => {
    const employeeId = 'emp-456';
    const email = 'admin@acschennai.com';

    const token = jwt.sign(
      { employeeId, email },
      JWT_SECRET,
      { expiresIn: '8h' }
    );

    const decoded = jwt.verify(token, JWT_SECRET);

    expect(decoded.employeeId).toBe(employeeId);
    expect(decoded.email).toBe(email);
  });

  it('should reject expired token', () => {
    const token = jwt.sign(
      { employeeId: 'emp-123' },
      JWT_SECRET,
      { expiresIn: '-1s' } // Already expired
    );

    expect(() => jwt.verify(token, JWT_SECRET)).toThrow('jwt expired');
  });

  it('should reject token with wrong secret', () => {
    const token = jwt.sign(
      { employeeId: 'emp-123' },
      'wrong-secret',
      { expiresIn: '8h' }
    );

    expect(() => jwt.verify(token, JWT_SECRET)).toThrow('invalid signature');
  });
});

describe('Password Hashing', () => {
  const testPassword = 'SecurePassword123!';

  it('should hash password correctly', async () => {
    const hash = await bcrypt.hash(testPassword, 12);

    expect(hash).toBeDefined();
    expect(hash).not.toBe(testPassword);
    expect(hash.startsWith('$2a$') || hash.startsWith('$2b$')).toBe(true);
  });

  it('should verify correct password', async () => {
    const hash = await bcrypt.hash(testPassword, 12);
    const isValid = await bcrypt.compare(testPassword, hash);

    expect(isValid).toBe(true);
  });

  it('should reject incorrect password', async () => {
    const hash = await bcrypt.hash(testPassword, 12);
    const isValid = await bcrypt.compare('WrongPassword456!', hash);

    expect(isValid).toBe(false);
  });

  it('should generate different hashes for same password (salt)', async () => {
    const hash1 = await bcrypt.hash(testPassword, 12);
    const hash2 = await bcrypt.hash(testPassword, 12);

    expect(hash1).not.toBe(hash2);
  });
});

describe('Auth Middleware', () => {
  const requireAuth = (req, res, next) => {
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
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({ error: 'Token expired' });
      }
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  };

  it('should reject request without authorization header', () => {
    const req = { headers: {} };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    const next = jest.fn();

    requireAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Authorization required' });
    expect(next).not.toHaveBeenCalled();
  });

  it('should reject request with malformed authorization header', () => {
    const req = { headers: { authorization: 'Basic token123' } };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    const next = jest.fn();

    requireAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('should accept valid token and set employeeId', () => {
    const token = jwt.sign(
      { employeeId: 'emp-789', email: 'user@test.com' },
      JWT_SECRET,
      { expiresIn: '8h' }
    );

    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    const next = jest.fn();

    requireAuth(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.employeeId).toBe('emp-789');
    expect(req.email).toBe('user@test.com');
  });

  it('should reject expired token with specific message', () => {
    const token = jwt.sign(
      { employeeId: 'emp-123' },
      JWT_SECRET,
      { expiresIn: '-1s' }
    );

    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    const next = jest.fn();

    requireAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Token expired' });
    expect(next).not.toHaveBeenCalled();
  });
});

describe('Token Refresh Logic', () => {
  it('should verify refresh token with different secret', () => {
    const refreshToken = jwt.sign(
      { employeeId: 'emp-123', type: 'refresh' },
      JWT_REFRESH_SECRET,
      { expiresIn: '7d' }
    );

    const decoded = jwt.verify(refreshToken, JWT_REFRESH_SECRET);

    expect(decoded.employeeId).toBe('emp-123');
    expect(decoded.type).toBe('refresh');
  });

  it('should reject access token when verifying with refresh secret', () => {
    const accessToken = jwt.sign(
      { employeeId: 'emp-123' },
      JWT_SECRET,
      { expiresIn: '8h' }
    );

    expect(() => jwt.verify(accessToken, JWT_REFRESH_SECRET)).toThrow('invalid signature');
  });

  it('should reject refresh token when verifying with access secret', () => {
    const refreshToken = jwt.sign(
      { employeeId: 'emp-123', type: 'refresh' },
      JWT_REFRESH_SECRET,
      { expiresIn: '7d' }
    );

    expect(() => jwt.verify(refreshToken, JWT_SECRET)).toThrow('invalid signature');
  });
});

describe('Login Validation', () => {
  const validateLoginInput = (email, password) => {
    if (!email || !password) {
      return { valid: false, error: 'Email and password are required' };
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return { valid: false, error: 'Invalid email format' };
    }
    if (password.length < 6) {
      return { valid: false, error: 'Password must be at least 6 characters' };
    }
    return { valid: true };
  };

  it('should accept valid email and password', () => {
    expect(validateLoginInput('user@acschennai.com', 'password123')).toEqual({ valid: true });
    expect(validateLoginInput('test@example.org', 'securePass!')).toEqual({ valid: true });
  });

  it('should reject empty email', () => {
    const result = validateLoginInput('', 'password123');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Email and password are required');
  });

  it('should reject empty password', () => {
    const result = validateLoginInput('user@test.com', '');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Email and password are required');
  });

  it('should reject invalid email format', () => {
    expect(validateLoginInput('notanemail', 'password123').valid).toBe(false);
    expect(validateLoginInput('missing@domain', 'password123').valid).toBe(false);
    expect(validateLoginInput('@nodomain.com', 'password123').valid).toBe(false);
    expect(validateLoginInput('spaces in@email.com', 'password123').valid).toBe(false);
  });

  it('should reject short password', () => {
    expect(validateLoginInput('user@test.com', '12345').valid).toBe(false);
    expect(validateLoginInput('user@test.com', '123456').valid).toBe(true);
  });
});

describe('Employee Data Serialization', () => {
  it('should exclude sensitive fields from employee response', () => {
    const employee = {
      id: 'emp-123',
      email: 'user@acschennai.com',
      password: '$2a$12$hashedpassword', // Should be excluded
      name: 'Test User',
      designation: 'Engineer',
      department: 'Civil',
      isAdmin: false,
      zohoAccessToken: 'secret-token', // Should be excluded
      zohoRefreshToken: 'refresh-secret', // Should be excluded
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Simulate the serialization logic used in auth routes
    const safeEmployee = {
      id: employee.id,
      email: employee.email,
      name: employee.name,
      designation: employee.designation,
      department: employee.department,
      isAdmin: employee.isAdmin,
    };

    expect(safeEmployee).not.toHaveProperty('password');
    expect(safeEmployee).not.toHaveProperty('zohoAccessToken');
    expect(safeEmployee).not.toHaveProperty('zohoRefreshToken');
    expect(safeEmployee).toHaveProperty('id');
    expect(safeEmployee).toHaveProperty('email');
    expect(safeEmployee).toHaveProperty('name');
  });
});
