// Shared blob-upload helper. Used by PhotoUpload.jsx and DprSubmit.jsx.
//
// Why a helper? The original DprSubmit.jsx used a raw
//   await fetch(sasUrl, { method: 'PUT', body: file })
// which has three problems:
//   1. No timeout — if Azure Blob Storage accepts the TCP connection but
//      never sends a response, the browser sits pending indefinitely.
//      The user's "photo upload stuck at 0%" symptom (Aug 29 2026) was
//      exactly this: no progress events, no completion, no error.
//   2. No progress — `fetch()` cannot report upload progress, so the UI
//      showed a binary 0% → 50% → 100% jump instead of a smooth bar.
//   3. No abort path — there's no way for the user to cancel.
//
// PhotoUpload.jsx already used XHR (so it had progress), but it never
// set xhr.timeout — default is 0 (no timeout). So it had the same hang
// risk as the raw fetch, just less visible.
//
// This helper gives every blob upload:
//   - A 60s hard timeout (configurable) with a clear 'Upload timed out' error
//   - Real progress via xhr.upload 'progress' events
//   - AbortSignal support so the caller can cancel mid-upload
//   - Uniform error shape (Error with .message)

export class BlobUploadError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

export const DEFAULT_BLOB_UPLOAD_TIMEOUT_MS = 60_000;

/**
 * PUT a file/blob to an Azure Blob Storage SAS URL with progress + timeout.
 *
 * @param {string} sasUrl       The full SAS-signed blob URL.
 * @param {Blob|File} body       The bytes to upload.
 * @param {object} opts
 * @param {string} opts.contentType  MIME type for the Content-Type header.
 * @param {(pct: number) => void} [opts.onProgress]  Called with 0..100 as bytes upload.
 * @param {number} [opts.timeoutMs]  Override default 60s timeout.
 * @param {AbortSignal} [opts.signal]  External abort signal (e.g. on component unmount).
 * @returns {Promise<void>}  Resolves on 2xx response.
 */
export function uploadBlob(sasUrl, body, {
  contentType,
  onProgress,
  timeoutMs = DEFAULT_BLOB_UPLOAD_TIMEOUT_MS,
  signal,
} = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new BlobUploadError('Upload aborted', 'ABORTED'));
      return;
    }

    const xhr = new XMLHttpRequest();
    let timedOut = false;

    const timeoutId = setTimeout(() => {
      timedOut = true;
      xhr.abort();
    }, timeoutMs);

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    });

    xhr.addEventListener('load', () => {
      clearTimeout(timeoutId);
      if (xhr.status >= 200 && xhr.status < 300) {
        // Final progress at 100% so callers can render a fully-filled bar.
        if (onProgress) onProgress(100);
        resolve();
      } else {
        reject(new BlobUploadError(`Upload failed: HTTP ${xhr.status}`, 'HTTP_ERROR'));
      }
    });

    xhr.addEventListener('error', () => {
      clearTimeout(timeoutId);
      reject(new BlobUploadError('Network error during upload', 'NETWORK_ERROR'));
    });

    xhr.addEventListener('abort', () => {
      clearTimeout(timeoutId);
      if (timedOut) {
        reject(new BlobUploadError(`Upload timed out after ${Math.round(timeoutMs / 1000)}s`, 'TIMEOUT'));
      } else {
        reject(new BlobUploadError('Upload aborted', 'ABORTED'));
      }
    });

    if (signal) {
      const onAbort = () => xhr.abort();
      signal.addEventListener('abort', onAbort, { once: true });
    }

    xhr.open('PUT', sasUrl);
    if (contentType) xhr.setRequestHeader('Content-Type', contentType);
    xhr.send(body);
  });
}

// N3 (Phase F) — Drawing PDF upload helper. Mirrors the inline pattern
// used for DPR photos (see DprSubmit.jsx:445-453): mint a SAS, PUT the
// bytes with progress, then confirm-upload so the server records the
// blob as belonging to the drawing. Returns the { ulid, blobPath, ... }
// shape that POST /api/drawings expects.
//
// `token` is the access token from useAuth(). `api` is passed in (not
// imported) so this module stays free of API surface coupling — keeps
// it testable + lets future upload helpers (e.g. inspection PDFs)
// reuse the same 3-step pattern without a circular import.
//
// `onProgress` is forwarded to the underlying `uploadBlob` call so the
// admin upload zone can render a 0..100 bar.
export async function uploadDrawing(file, token, api, { onProgress, signal, timeoutMs } = {}) {
  if (!file) throw new BlobUploadError('No file provided', 'NO_FILE');
  // /sas-url returns { sasUrl, ulid, blobPath, expiresAt } — the blobPath
  // is the canonical R2 key the server will echo back from
  // /confirm-upload. We capture it up-front so the upload can finish
  // before the parent form attempts to POST /drawings.
  const { sasUrl, ulid, blobPath } = await api.getDrawingSasUrl(file.name, file.type, token);
  await uploadBlob(sasUrl, file, {
    contentType: file.type,
    onProgress,
    signal,
    timeoutMs,
  });
  await api.confirmDrawingUpload(
    ulid, file.name, file.type, file.size, token,
  );
  return {
    ulid,
    blobPath,
    filename: file.name,
    contentType: file.type,
    sizeBytes: file.size,
  };
}
