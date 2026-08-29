/**
 * Azure Blob Storage helpers for DPR module
 *
 * Supports two authentication modes (prefer #2):
 *   1. AZURE_STORAGE_CONNECTION_STRING (single connection string — easier dev setup)
 *   2. AZURE_STORAGE_ACCOUNT_NAME + AZURE_STORAGE_ACCOUNT_KEY (SharedKey — production-safe;
 *      can be swapped for DefaultAzureCredential / managed identity later)
 */
const { BlobServiceClient, StorageSharedKeyCredential } = require('@azure/storage-blob');
const { randomBytes } = require('crypto');

let blobServiceClient = null;

function getClient() {
  if (blobServiceClient) return blobServiceClient;

  const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING;
  const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME;
  const accountKey = process.env.AZURE_STORAGE_ACCOUNT_KEY;

  if (connStr) {
    blobServiceClient = BlobServiceClient.fromConnectionString(connStr);
    return blobServiceClient;
  }

  if (accountName && accountKey) {
    const credential = new StorageSharedKeyCredential(accountName, accountKey);
    blobServiceClient = new BlobServiceClient(
      `https://${accountName}.blob.core.windows.net`,
      credential
    );
    return blobServiceClient;
  }

  throw new Error(
    'Azure Storage not configured: set AZURE_STORAGE_CONNECTION_STRING or ' +
      '(AZURE_STORAGE_ACCOUNT_NAME + AZURE_STORAGE_ACCOUNT_KEY)'
  );
}

/**
 * Generate a ULID-like 128-bit identifier (26-char Crockford base32).
 * Uses cryptographic randomness so ULIDs are unpredictable to attackers
 * trying to enumerate blob names.
 */
function generateULID() {
  // 48-bit timestamp (ms) + 80-bit randomness
  const ts = Date.now().toString(36).toUpperCase().padStart(10, '0');
  const rand = randomBytes(10).toString('hex').toUpperCase();
  return (ts + rand).slice(0, 26);
}

/**
 * Map a validated MIME type to its safe file extension.
 * The extension comes ONLY from the validated contentType — never from
 * the user-supplied filename — to prevent stored-XSS via crafted extensions
 * like `.php` or `.html` landing in our blob namespace.
 */
const CONTENT_TYPE_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/**
 * Generate SAS URL for uploading a blob.
 *
 * Security hardening:
 *  - Permissions are 'cw' ONLY (create + write). No read, no delete, no list,
 *    no immutability. A leaked SAS cannot enumerate, read, or destroy blobs.
 *  - Blob name is scoped under `${employeeId}/${ulid}.${ext}` so a leaked SAS
 *    for one user can never overwrite or affect another user's uploads.
 *  - 15-minute expiry.
 *
 * @param {string} containerName    'dpr-photos' or 'dpr-documents'
 * @param {string} employeeId       Owning employee — used for blob-path isolation
 * @param {string} ulid             Unique blob ID (returned to caller)
 * @param {string} contentType      Must be in CONTENT_TYPE_EXT
 */
async function generateUploadSASUrl(containerName, employeeId, ulid, contentType) {
  const ext = CONTENT_TYPE_EXT[contentType];
  if (!ext) throw new Error(`Unsupported content type: ${contentType}`);

  const client = getClient();
  const containerClient = client.getContainerClient(containerName);
  const blobName = `${employeeId}/${ulid}.${ext}`;
  const blockBlobClient = containerClient.getBlockBlobClient(blobName);

  const expiresOn = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

  const sasOptions = {
    containerName,
    blobName,
    permissions: 'cw', // create + write ONLY — no read, delete, list, process, tag
    expiresOn,
    startsOn: new Date(Date.now() - 60 * 1000), // 1-minute clock-skew tolerance
    contentType,
  };

  const sasToken = blockBlobClient.generateBlobSASQueryToken(sasOptions);
  const sasUrl = `${blockBlobClient.url}?${sasToken}`;

  return {
    sasUrl,
    ulid,
    blobPath: blobName,
    expiresAt: expiresOn.toISOString(),
  };
}

/**
 * Generate a read-only SAS URL for a single blob (24-hour expiry).
 * Read SAS is longer-lived than upload so users can revisit their DPRs the
 * same day without re-fetching SAS tokens; after 24h a refresh is required.
 */
async function generateReadSASUrl(containerName, blobName) {
  const client = getClient();
  const containerClient = client.getContainerClient(containerName);
  const blockBlobClient = containerClient.getBlockBlobClient(blobName);

  const expiresOn = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

  const sasOptions = {
    containerName,
    blobName,
    permissions: 'r', // read-only
    expiresOn,
  };

  const sasToken = blockBlobClient.generateBlobSASQueryToken(sasOptions);
  const sasUrl = `${blockBlobClient.url}?${sasToken}`;

  return { sasUrl, expiresAt: expiresOn.toISOString() };
}

/**
 * Verify a blob exists and return its properties (size, content-type, lastModified).
 * Throws if blob is missing.
 *
 * Hard 8s timeout via AbortSignal so a stuck Azure Storage call cannot pin
 * the Express request indefinitely. The @azure/storage-blob v12 client
 * has no default request timeout (Backend Architect agent diagnosis, Aug
 * 29 2026) — without this, an Azure-side stall would hold the request open
 * until the platform's own connection drop (~2 min) and surface to the
 * client as a 504 / hang.
 */
const VERIFY_BLOB_TIMEOUT_MS = 8_000;

async function verifyBlobExists(containerName, blobName) {
  const client = getClient();
  const containerClient = client.getContainerClient(containerName);
  const blobClient = containerClient.getBlobClient(blobName);

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), VERIFY_BLOB_TIMEOUT_MS);

  try {
    const props = await blobClient.getProperties({ abortSignal: abortController.signal });
    return {
      exists: true,
      contentType: props.contentType,
      contentLength: props.contentLength,
      lastModified: props.lastModified,
    };
  } catch (err) {
    if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) {
      throw new Error(`Blob verification timed out after ${VERIFY_BLOB_TIMEOUT_MS}ms`);
    }
    if (err.statusCode === 404) {
      return { exists: false };
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Upload a buffer directly to blob (used for server-side PDF generation).
 */
async function uploadBufferToBlob(containerName, blobName, buffer, contentType) {
  const client = getClient();
  const containerClient = client.getContainerClient(containerName);
  const blockBlobClient = containerClient.getBlockBlobClient(blobName);

  await blockBlobClient.uploadData(buffer, {
    blobHTTPHeaders: { blobContentType: contentType },
  });

  const readUrl = await generateReadSASUrl(containerName, blobName);
  return { url: readUrl.sasUrl };
}

/**
 * Delete a blob (used by server-side cleanup paths).
 */
async function deleteBlob(containerName, blobName) {
  const client = getClient();
  const containerClient = client.getContainerClient(containerName);
  const blobClient = containerClient.getBlobClient(blobName);
  await blobClient.delete();
}

module.exports = {
  generateULID,
  generateUploadSASUrl,
  generateReadSASUrl,
  verifyBlobExists,
  uploadBufferToBlob,
  deleteBlob,
  CONTENT_TYPE_EXT,
};
