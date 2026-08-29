/**
 * Blob Upload Helper Tests
 *
 * Exercises the XHR + timeout + progress logic in src/lib/blobUpload.js.
 * The helper itself is the contract; we don't reach into the SDK.
 *
 * These tests guard against the regression that caused the Aug 29 2026
 * "photo upload stuck forever at 0%" bug — namely, an upload that has
 * no timeout and never fires any terminal event.
 */

// We mock XMLHttpRequest so the tests don't actually hit Azure. The mock
// gives us a programmatic way to drive the helper through its full
// lifecycle (open → send → progress → load/error/timeout/abort).

class FakeXHR {
  constructor() {
    this.readyState = 0;
    this.status = 0;
    this.responseText = '';
    this._listeners = {};
    // Real XHR exposes xhr.upload as a separate target with its own
    // addEventListener. Mirror that shape so the helper can attach to it.
    this.upload = {
      _listeners: {},
      addEventListener: (name, fn) => (this.upload._listeners[name] ||= []).push(fn),
    };
    this._sent = null;
    this._aborted = false;
  }

  addEventListener(name, fn) { (this._listeners[name] ||= []).push(fn); }
  setRequestHeader() {}
  open() {}
  send(body) { this._sent = body; }
  abort() { this._aborted = true; this._fire('abort'); }

  // Test helpers — drive events as if from a real server.
  _fire(name) { (this._listeners[name] || []).forEach((fn) => fn({})); }
  _uploadFire(name, e = {}) { (this.upload._listeners[name] || []).forEach((fn) => fn(e)); }
}

let xhrInstances = [];
function installXHRMock() {
  xhrInstances = [];
  global.XMLHttpRequest = function () {
    const xhr = new FakeXHR();
    xhrInstances.push(xhr);
    return xhr;
  };
}

// Mock setTimeout/clearTimeout to a fake clock so timeout tests are fast.
function installFakeTimers() {
  jest.useFakeTimers({ legacyFakeTimers: false });
}
function uninstallFakeTimers() {
  jest.useRealTimers();
}

describe('uploadBlob — happy path', () => {
  beforeEach(() => installXHRMock());
  afterEach(() => uninstallFakeTimers());

  it('resolves on 200 and fires final progress at 100%', async () => {
    const { uploadBlob } = require('../../src/lib/blobUpload.js');
    const progressValues = [];
    const p = uploadBlob('https://example/blob?sas=1', new Blob(['x']), {
      contentType: 'image/png',
      onProgress: (p) => progressValues.push(p),
    });

    const xhr = xhrInstances[0];
    // Simulate a single 100% progress event then a 200 response.
    xhr._uploadFire('progress', { lengthComputable: true, loaded: 1024, total: 1024 });
    xhr.status = 200;
    xhr._fire('load');

    await expect(p).resolves.toBeUndefined();
    expect(progressValues).toEqual([100, 100]);
  });

  it('rejects on non-2xx', async () => {
    const { uploadBlob, BlobUploadError } = require('../../src/lib/blobUpload.js');
    const p = uploadBlob('https://example/blob', new Blob(['x']), { contentType: 'image/png' });
    const xhr = xhrInstances[0];
    xhr.status = 403;
    xhr._fire('load');
    await expect(p).rejects.toBeInstanceOf(BlobUploadError);
    await expect(p).rejects.toMatchObject({ code: 'HTTP_ERROR' });
  });

  it('calls open("PUT", url) and sets Content-Type header', () => {
    const { uploadBlob } = require('../../src/lib/blobUpload.js');
    const openSpy = jest.fn();
    const setHeaderSpy = jest.fn();
    global.XMLHttpRequest = function () {
      const x = new FakeXHR();
      x.open = openSpy;
      x.setRequestHeader = setHeaderSpy;
      xhrInstances.push(x);
      return x;
    };
    uploadBlob('https://example/blob?sas=abc', new Blob(['x']), { contentType: 'image/jpeg' });
    expect(openSpy).toHaveBeenCalledWith('PUT', 'https://example/blob?sas=abc');
    expect(setHeaderSpy).toHaveBeenCalledWith('Content-Type', 'image/jpeg');
  });
});

describe('uploadBlob — failure modes', () => {
  beforeEach(() => {
    installXHRMock();
    installFakeTimers();
  });
  afterEach(() => uninstallFakeTimers());

  it('rejects with NETWORK_ERROR on a network error event', async () => {
    const { uploadBlob, BlobUploadError } = require('../../src/lib/blobUpload.js');
    const p = uploadBlob('https://example/blob', new Blob(['x']), { contentType: 'image/png' });
    xhrInstances[0]._fire('error');
    await expect(p).rejects.toBeInstanceOf(BlobUploadError);
    await expect(p).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });

  it('rejects with TIMEOUT if the upload exceeds the timeout window', async () => {
    const { uploadBlob, BlobUploadError } = require('../../src/lib/blobUpload.js');
    const p = uploadBlob('https://example/blob', new Blob(['x']), {
      contentType: 'image/png',
      timeoutMs: 1000,
    });

    // Advance fake time past the timeout
    jest.advanceTimersByTime(1500);
    // The helper should have called xhr.abort() which fires 'abort'
    expect(xhrInstances[0]._aborted).toBe(true);

    await expect(p).rejects.toBeInstanceOf(BlobUploadError);
    await expect(p).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('rejects with ABORTED if an external signal is provided and triggered', async () => {
    const { uploadBlob, BlobUploadError } = require('../../src/lib/blobUpload.js');
    const controller = new AbortController();
    const p = uploadBlob('https://example/blob', new Blob(['x']), {
      contentType: 'image/png',
      signal: controller.signal,
    });
    controller.abort();
    expect(xhrInstances[0]._aborted).toBe(true);
    await expect(p).rejects.toBeInstanceOf(BlobUploadError);
    await expect(p).rejects.toMatchObject({ code: 'ABORTED' });
  });

  it('rejects with ABORTED if the signal was already aborted at start', async () => {
    const { uploadBlob, BlobUploadError } = require('../../src/lib/blobUpload.js');
    const controller = new AbortController();
    controller.abort();
    const p = uploadBlob('https://example/blob', new Blob(['x']), {
      signal: controller.signal,
    });
    await expect(p).rejects.toMatchObject({ code: 'ABORTED' });
  });
});

describe('uploadBlob — progress reporting', () => {
  beforeEach(() => installXHRMock());
  afterEach(() => uninstallFakeTimers());

  it('reports rounded percentages across multiple progress events', () => {
    const { uploadBlob } = require('../../src/lib/blobUpload.js');
    const seen = [];
    const p = uploadBlob('https://example/blob', new Blob(['x']), {
      contentType: 'image/png',
      onProgress: (pct) => seen.push(pct),
    });
    const xhr = xhrInstances[0];
    xhr._uploadFire('progress', { lengthComputable: true, loaded: 1, total: 4 });
    xhr._uploadFire('progress', { lengthComputable: true, loaded: 2, total: 4 });
    xhr._uploadFire('progress', { lengthComputable: true, loaded: 3, total: 4 });
    xhr.status = 200;
    xhr._fire('load');
    return p.then(() => {
      expect(seen).toEqual([25, 50, 75, 100]);
    });
  });

  it('ignores progress events where length is not computable', () => {
    const { uploadBlob } = require('../../src/lib/blobUpload.js');
    const seen = [];
    const p = uploadBlob('https://example/blob', new Blob(['x']), {
      contentType: 'image/png',
      onProgress: (pct) => seen.push(pct),
    });
    const xhr = xhrInstances[0];
    xhr._uploadFire('progress', { lengthComputable: false });
    xhr.status = 200;
    xhr._fire('load');
    return p.then(() => {
      expect(seen).toEqual([100]);
    });
  });
});
