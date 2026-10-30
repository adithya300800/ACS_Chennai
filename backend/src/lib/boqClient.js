'use strict';

const TIMEOUTS = Object.freeze({ submit: 180000, poll: 75000, meta: 30000 });

class BoqServiceError extends Error {
  constructor({ status, body, kind = 'http' }) {
    const upstream = body && body.error;
    const code = typeof upstream?.code === 'string' ? upstream.code : null;
    const message = typeof upstream?.message === 'string' ? upstream.message : '';
    super(kind === 'timeout' ? 'BOQ service request timed out' : (message || 'BOQ service request failed'));
    this.name = 'BoqServiceError';
    this.status = status || null;
    this.code = code;
    this.details = upstream?.details;
    this.kind = kind;
  }
}

function normalizeBaseUrl() {
  const configured = process.env.BOQ_BASE_URL;
  if (!configured) throw new BoqServiceError({ kind: 'unavailable' });
  let url;
  try {
    url = new URL(configured);
  } catch (_err) {
    throw new BoqServiceError({ kind: 'unavailable' });
  }
  if (url.protocol !== 'https:' && process.env.NODE_ENV !== 'test') {
    throw new BoqServiceError({ kind: 'unavailable' });
  }
  return url.toString().replace(/\/$/, '');
}

function createClient({ fetchImpl = (...args) => fetch(...args) } = {}) {
  async function request(path, { timeout, requestId, method = 'GET', body, idempotencyKey, responseType = 'json' } = {}) {
    const token = process.env.BOQ_API_TOKEN;
    if (!token) throw new BoqServiceError({ kind: 'unavailable' });
    const baseUrl = normalizeBaseUrl();

    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'X-Request-ID': typeof requestId === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(requestId)
        ? requestId : 'boq-portal',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
    } catch (err) {
      const kind = err?.name === 'AbortError' ? 'timeout' : 'network';
      clearTimeout(timeoutId);
      throw new BoqServiceError({ kind });
    }

    let payload;
    try {
      if (responseType === 'arrayBuffer') {
        payload = Buffer.from(await response.arrayBuffer());
      } else {
        const text = await response.text();
        payload = text ? JSON.parse(text) : {};
      }
    } catch (err) {
      if (err?.name === 'AbortError') {
        clearTimeout(timeoutId);
        throw new BoqServiceError({ kind: 'timeout' });
      }
      payload = {};
    } finally {
      clearTimeout(timeoutId);
    }
    if (!response.ok) throw new BoqServiceError({ status: response.status, body: payload });
    return payload;
  }

  return {
    timeouts: TIMEOUTS,
    submitJob: ({ jobId, requestId, payload }) => request('/jobs', {
      method: 'POST',
      timeout: TIMEOUTS.submit,
      requestId,
      idempotencyKey: `boq:${jobId}`,
      body: payload,
    }),
    getJob: ({ serviceJobId, requestId }) => request(`/jobs/${encodeURIComponent(serviceJobId)}`, {
      timeout: TIMEOUTS.poll,
      requestId,
    }),
    getSnapshot: ({ serviceJobId, requestId }) => request(`/jobs/${encodeURIComponent(serviceJobId)}/snapshot`, {
      timeout: TIMEOUTS.poll,
      requestId,
    }),
    getBoqXlsx: ({ serviceJobId, requestId }) => request(`/jobs/${encodeURIComponent(serviceJobId)}/boq.xlsx`, {
      timeout: TIMEOUTS.poll,
      requestId,
      responseType: 'arrayBuffer',
    }),
    correctLine: ({ serviceJobId, lineId, requestId, payload }) => request(
      `/jobs/${encodeURIComponent(serviceJobId)}/lines/${encodeURIComponent(lineId)}`,
      { method: 'PATCH', timeout: TIMEOUTS.poll, requestId, body: payload },
    ),
    deleteJob: ({ serviceJobId, requestId }) => request(`/jobs/${encodeURIComponent(serviceJobId)}`, {
      method: 'DELETE',
      timeout: TIMEOUTS.poll,
      requestId,
    }),
    getMeta: ({ requestId }) => request('/meta', { timeout: TIMEOUTS.meta, requestId }),
  };
}

const defaultClient = createClient();

module.exports = { ...defaultClient, BoqServiceError, TIMEOUTS, createClient };