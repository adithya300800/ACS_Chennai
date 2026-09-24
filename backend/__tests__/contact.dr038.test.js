// ─────────────────────────────────────────────────────────────────────────────
// DR-038 — Contact can report success after a resolved email-provider rejection
//
// Resend 4.x's `emails.send()` resolves with `{data, error}` for HTTP/transport
// failures rather than always throwing. The pre-fix handler awaited the call
// but ignored the result, so a Resend rejection (validation, rate limit, auth,
// etc.) was reported back to the visitor as success, leaving no working retry.
//
// These tests pin the new contract:
//   - DR-038-A: provider returns `{data, error}` → 502 EMAIL_PROVIDER_REJECTED.
//   - DR-038-B: provider returns `{data, error}` with a 422 statusCode → 502.
//   - DR-038-C: provider throws (network/SDK error) → 500 (existing path).
//   - DR-038-D: provider returns `{data: {id: ...}, error: null}` → 200 with
//     correlation id and `accepted: true` (phrased as accepted, not "sent").
//   - DR-038-E: provider returns a malformed envelope (no data, no error) →
//     502 EMAIL_PROVIDER_REJECTED (rejected without an acceptance id).
//
// The route's pre-existing paths (validation, honeypot, 503) are out of scope;
// DR-038 is specifically about the post-send result handling.
// ─────────────────────────────────────────────────────────────────────────────

process.env.NODE_ENV = 'test';
process.env.RESEND_API_KEY = 'test-resend-key-must-be-long-enough';
process.env.RESEND_FROM_EMAIL = 'info@acschennai.com';
process.env.RESEND_FROM_NAME = 'ACS Chennai';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-must-be-at-least-32-chars-long-AAAA';
process.env.ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || 'http://localhost:3000';

const express = require('express');
const request = require('supertest');

const mockSend = jest.fn();
jest.mock('resend', () => {
  return {
    Resend: jest.fn().mockImplementation(() => ({
      emails: { send: (...args) => mockSend(...args) },
    })),
  };
});

// Require AFTER the mock is registered. contact.js builds its client at
// module-load time inside the `if (RESEND_API_KEY)` block; the mocked
// constructor returns our stub so the route mounts.
const contactRouter = require('../src/routes/contact');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/contact', contactRouter);
  return app;
}

const VALID_PAYLOAD = {
  name: 'Priya Visitor',
  company: 'Visitor Co',
  email: 'priya@example.com',
  phone: '+91 99999 99999',
  projectType: 'PMC / Project Management Consultancy',
  message: 'Looking for a PMC partner for our upcoming industrial build.',
};

beforeEach(() => {
  mockSend.mockReset();
});

describe('DR-038 — contact must not report success after a Resend rejection', () => {
  test('DR-038-A: provider resolves with {data:null, error:...} → 502 EMAIL_PROVIDER_REJECTED', async () => {
    mockSend.mockResolvedValueOnce({
      data: null,
      error: { name: 'validation_error', message: 'Invalid `from` field' },
    });

    const res = await request(buildApp())
      .post('/api/contact')
      .send(VALID_PAYLOAD);

    expect(res.status).toBe(502);
    expect(res.body).toEqual(
      expect.objectContaining({
        code: 'EMAIL_PROVIDER_REJECTED',
      })
    );
    expect(res.body.error).toMatch(/couldn'?t send your message/i);
    expect(res.body.error).toMatch(/info@acschennai\.com/);
    expect(res.body).not.toHaveProperty('success');
  });

  test('DR-038-B: provider returns structured error with non-2xx statusCode → 502', async () => {
    mockSend.mockResolvedValueOnce({
      data: null,
      error: { statusCode: 422, name: 'invalid_request_error', message: 'Recipient blocked' },
    });

    const res = await request(buildApp())
      .post('/api/contact')
      .send(VALID_PAYLOAD);

    expect(res.status).toBe(502);
    expect(res.body.code).toBe('EMAIL_PROVIDER_REJECTED');
  });

  test('DR-038-C: provider throws (network/SDK) → 500 with generic failure', async () => {
    mockSend.mockRejectedValueOnce(new Error('ECONNRESET'));

    const res = await request(buildApp())
      .post('/api/contact')
      .send(VALID_PAYLOAD);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to send message' });
  });

  test('DR-038-D: provider returns accepted email → 200 with correlation id and accepted:true', async () => {
    mockSend.mockResolvedValueOnce({
      data: { id: 'resend-msg-abc123' },
      error: null,
    });

    const res = await request(buildApp())
      .post('/api/contact')
      .send(VALID_PAYLOAD);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        success: true,
        accepted: true,
        id: 'resend-msg-abc123',
      })
    );
    // Don't echo visitor content back in the success body.
    expect(res.body).not.toHaveProperty('message');
    expect(res.body).not.toHaveProperty('email');
    expect(res.body).not.toHaveProperty('name');
  });

  test('DR-038-E: provider returns a malformed envelope (no data, no error) → 502', async () => {
    // Some SDK failure modes resolve with neither `data` nor `error` populated.
    // Without an acceptance id we cannot tell the visitor their message landed.
    mockSend.mockResolvedValueOnce({});

    const res = await request(buildApp())
      .post('/api/contact')
      .send(VALID_PAYLOAD);

    expect(res.status).toBe(502);
    expect(res.body.code).toBe('EMAIL_PROVIDER_REJECTED');
  });
});