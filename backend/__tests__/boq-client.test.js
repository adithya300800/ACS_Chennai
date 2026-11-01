'use strict';

const { BoqServiceError, createClient } = require('../src/lib/boqClient');
const { mapServiceError, mapServiceJobError } = require('../src/lib/boqErrors');

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

describe('BOQ service client', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.BOQ_BASE_URL;
    delete process.env.BOQ_API_TOKEN;
    jest.useRealTimers();
  });

  it('submits JSON with server bearer, request id, derived idempotency key, and service timeout', async () => {
    process.env.BOQ_BASE_URL = 'https://boq.example/';
    process.env.BOQ_API_TOKEN = 'test-only-service-token';
    global.fetch = jest.fn(async () => jsonResponse({ job_id: 'upstream-1', status: 'queued' }, 202));
    const client = createClient();

    const response = await client.submitJob({
      jobId: 'portal-job-1',
      requestId: 'request-1',
      payload: { sources: [], config: { sor_priority: ['TN_PWD_SOR'] } },
    });

    expect(response.job_id).toBe('upstream-1');
    expect(global.fetch).toHaveBeenCalledWith('https://boq.example/jobs', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({
        Authorization: 'Bearer test-only-service-token',
        'Content-Type': 'application/json',
        'X-Request-ID': 'request-1',
        'Idempotency-Key': 'boq:portal-job-1',
      }),
      body: JSON.stringify({ sources: [], config: { sor_priority: ['TN_PWD_SOR'] } }),
      signal: expect.any(AbortSignal),
    }));
    expect(client.timeouts.submit).toBe(180000);
  });

  it('polls the service job and fetches metadata from their contract paths', async () => {
    process.env.BOQ_BASE_URL = 'https://boq.example';
    process.env.BOQ_API_TOKEN = 'test-only-service-token';
    global.fetch = jest.fn()
      .mockResolvedValueOnce(jsonResponse({ job_id: 'upstream-2', status: 'running' }))
      .mockResolvedValueOnce(jsonResponse({ data_status: 'SAMPLE', sor_sources: [] }));
    const client = createClient();

    const job = await client.getJob({ serviceJobId: 'upstream-2', requestId: 'request-2' });
    const meta = await client.getMeta({ requestId: 'request-3' });

    expect(job.status).toBe('running');
    expect(meta.data_status).toBe('SAMPLE');
    expect(global.fetch.mock.calls.map(([url]) => url)).toEqual([
      'https://boq.example/jobs/upstream-2',
      'https://boq.example/meta',
    ]);
    expect(global.fetch.mock.calls[0][1].headers['X-Request-ID']).toBe('request-2');
    expect(client.timeouts).toEqual({ submit: 180000, poll: 75000, meta: 30000 });
  });

  it('fetches snapshots and workbooks, proxies line corrections, and deletes service jobs', async () => {
    process.env.BOQ_BASE_URL = 'https://boq.example';
    process.env.BOQ_API_TOKEN = 'test-only-service-token';
    const snapshot = { schema_version: '1.0', kind: 'acs.boq.snapshot', lines: [] };
    const workbook = Buffer.from('xlsx-binary');
    global.fetch = jest.fn()
      .mockResolvedValueOnce(jsonResponse(snapshot))
      .mockResolvedValueOnce({
        ok: true, status: 200,
        arrayBuffer: async () => workbook.buffer.slice(workbook.byteOffset, workbook.byteOffset + workbook.byteLength),
      })
      .mockResolvedValueOnce(jsonResponse({ correction: { id: 'correction-1' } }))
      .mockResolvedValueOnce(jsonResponse({ deleted: true }));
    const client = createClient();

    await expect(client.getSnapshot({ serviceJobId: 'upstream-3', requestId: 'snapshot-request' })).resolves.toEqual(snapshot);
    await expect(client.getBoqXlsx({ serviceJobId: 'upstream-3', requestId: 'xlsx-request' })).resolves.toEqual(workbook);
    await expect(client.correctLine({
      serviceJobId: 'upstream-3', lineId: 'line-1', requestId: 'correction-request',
      payload: { qty: 2.5, reason: 'Measured on site', requested_by: 'boqjob:portal-3' },
    })).resolves.toEqual({ correction: { id: 'correction-1' } });
    await expect(client.deleteJob({ serviceJobId: 'upstream-3', requestId: 'delete-request' })).resolves.toEqual({ deleted: true });

    expect(global.fetch.mock.calls.map(([url]) => url)).toEqual([
      'https://boq.example/jobs/upstream-3/snapshot',
      'https://boq.example/jobs/upstream-3/boq.xlsx',
      'https://boq.example/jobs/upstream-3/lines/line-1',
      'https://boq.example/jobs/upstream-3',
    ]);
    expect(global.fetch.mock.calls[2][1]).toMatchObject({
      method: 'PATCH',
      body: JSON.stringify({ qty: 2.5, reason: 'Measured on site', requested_by: 'boqjob:portal-3' }),
    });
    expect(global.fetch.mock.calls.every(([, options]) => options.headers.Authorization === 'Bearer test-only-service-token')).toBe(true);
  });

  it('keeps the request deadline active while the response body is being read', async () => {
    process.env.BOQ_BASE_URL = 'https://boq.example';
    process.env.BOQ_API_TOKEN = 'test-only-service-token';
    jest.useFakeTimers();
    global.fetch = jest.fn(async (_url, options) => ({
      ok: true,
      status: 200,
      text: () => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      }),
    }));
    const pending = createClient().getMeta({ requestId: 'request-timeout' });
    const assertion = expect(pending).rejects.toMatchObject({ name: 'BoqServiceError', kind: 'timeout' });
    await jest.advanceTimersByTimeAsync(30000);

    await assertion;
  }, 10000);

  it('rejects non-success service responses as structured errors without embedding credentials', async () => {
    process.env.BOQ_BASE_URL = 'https://boq.example';
    process.env.BOQ_API_TOKEN = 'test-only-service-token';
    global.fetch = jest.fn(async () => jsonResponse({
      error: { code: 'FETCH_HOST_REFUSED', message: 'host refused', details: { host: 'example.test' } },
    }, 400));
    const client = createClient();

    await expect(client.getMeta({ requestId: 'r' })).rejects.toMatchObject({
      name: 'BoqServiceError',
      status: 400,
      code: 'FETCH_HOST_REFUSED',
    });
    expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer test-only-service-token');
  });

  it('classifies missing service configuration as unavailable rather than a network timeout', async () => {
    delete process.env.BOQ_BASE_URL;
    process.env.BOQ_API_TOKEN = 'test-only-service-token';
    const client = createClient();

    await expect(client.getMeta({ requestId: 'request-unconfigured' })).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('maps upstream API and job-record errors to the portal flat error shape', () => {
    expect(mapServiceError(new BoqServiceError({
      status: 400,
      body: { error: { code: 'VALIDATION_ERROR', message: 'bad scale', details: { field: 'drawing_scale' } } },
    }))).toEqual({
      status: 400,
      body: { error: 'BOQ_VALIDATION', code: 'BOQ_VALIDATION', message: 'Some of the drawing details were not accepted: bad scale' },
    });
    expect(mapServiceError(new BoqServiceError({
      status: 502,
      body: { error: { code: 'FETCH_HOST_REFUSED', message: 'blocked', details: { host: 'private.test' } } },
    }))).toMatchObject({
      status: 502,
      body: { error: 'BOQ_FETCH_FAILED', code: 'BOQ_FETCH_FAILED' },
    });
    expect(mapServiceError(new BoqServiceError({ kind: 'timeout' }))).toMatchObject({
      status: 504,
      body: { error: 'BOQ_TIMEOUT', code: 'BOQ_TIMEOUT' },
    });
    expect(mapServiceJobError({ code: 'SOURCE_UNCALIBRATED', message: 'Confirm scale', details: ['floor.dxf'] })).toMatchObject({
      status: 409,
      body: { error: 'BOQ_UNCALIBRATED', code: 'BOQ_UNCALIBRATED' },
      details: ['floor.dxf'],
    });
    expect(mapServiceJobError({
      code: 'DWG_READ_FAILED',
      message: 'DWG conversion failed',
      details: ['plan.dwg: DWG conversion failed'],
    })).toMatchObject({
      status: 409,
      body: { error: 'BOQ_DWG_READ_FAILED', code: 'BOQ_DWG_READ_FAILED' },
      details: ['plan.dwg: DWG conversion failed'],
    });
    expect(mapServiceJobError({
      code: 'NO_MEASURABLE_ITEMS',
      message: 'No measurable BOQ items were produced.',
      details: ["4 entities on layer 'FO AREA' were not measured."],
    })).toMatchObject({
      status: 409,
      body: {
        error: 'BOQ_NO_MEASURABLE_ITEMS',
        code: 'BOQ_NO_MEASURABLE_ITEMS',
        message: expect.stringContaining('layer mapping'),
      },
      details: ["4 entities on layer 'FO AREA' were not measured."],
    });
    expect(mapServiceJobError({
      code: 'SOURCE_UNCALIBRATED',
      message: 'Confirm scale',
      details: ['one.dxf', { internal: true }, ...Array.from({ length: 12 }, (_, index) => `detail-${index}`)],
    }).details).toEqual(['one.dxf', ...Array.from({ length: 9 }, (_, index) => `detail-${index}`)]);
  });

  it('does not echo presigned URLs from an upstream validation message', () => {
    const mapped = mapServiceError(new BoqServiceError({
      status: 400,
      body: { error: { code: 'VALIDATION_ERROR', message: 'Rejected https://r2.example/drawing?X-Amz-Signature=secret' } },
    }));

    expect(mapped.body.message).not.toContain('https://r2.example');
    expect(mapped.body.message).not.toContain('X-Amz-Signature');
    expect(mapped.body.message).toContain('[link redacted]');
  });
});