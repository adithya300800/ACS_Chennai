/**
 * Cloudflare R2 Storage helpers for DPR module
 * Uses AWS S3-compatible API (@aws-sdk/client-s3)
 *
 * R2 is S3-compatible — we use standard AWS SDK calls.
 * Env vars:
 *   R2_ACCOUNT_ID      — Cloudflare account ID (used as endpoint)
 *   R2_ACCESS_KEY_ID  — R2 Access Key ID
 *   R2_SECRET_ACCESS_KEY — R2 Secret Access Key
 */
const { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { randomBytes } = require('crypto');

let s3Client = null;

function getClient() {
  if (s3Client) return s3Client;

  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error(
      'R2 Storage not configured: set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY'
    );
  }

  s3Client = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });

  return s3Client;
}

/**
 * Generate a ULID-like 128-bit identifier (26-char Crockford base32).
 */
function generateULID() {
  const ts = Date.now().toString(36).toUpperCase().padStart(10, '0');
  const rand = randomBytes(10).toString('hex').toUpperCase();
  return (ts + rand).slice(0, 26);
}

const CONTENT_TYPE_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/**
 * Generate a presigned PUT URL for direct browser-to-R2 upload (15 min expiry).
 * Permissions: 'cw' (create + write) — no read, no delete.
 */
async function generateUploadSASUrl(containerName, employeeId, ulid, contentType) {
  const ext = CONTENT_TYPE_EXT[contentType];
  if (!ext) throw new Error(`Unsupported content type: ${contentType}`);

  const client = getClient();
  const blobName = `${employeeId}/${ulid}.${ext}`;

  const command = new PutObjectCommand({
    Bucket: containerName,
    Key: blobName,
    ContentType: contentType,
  });

  // getSignedUrl from @aws-sdk/s3-request-presigner generates an S3-style
  // presigned URL that R2 accepts. Expiry is in seconds.
  const sasUrl = await getSignedUrl(client, command, { expiresIn: 900 }); // 15 min

  return {
    sasUrl,
    ulid,
    blobPath: blobName,
    expiresAt: new Date(Date.now() + 900 * 1000).toISOString(),
  };
}

/**
 * Generate a presigned GET URL for reading a blob (24-hour expiry).
 */
async function generateReadSASUrl(containerName, blobName) {
  const client = getClient();

  const command = new GetObjectCommand({
    Bucket: containerName,
    Key: blobName,
  });

  const sasUrl = await getSignedUrl(client, command, { expiresIn: 86400 }); // 24 hours

  return {
    sasUrl,
    expiresAt: new Date(Date.now() + 86400 * 1000).toISOString(),
  };
}

/**
 * Verify a blob exists by fetching its HEAD metadata (8s timeout).
 */
const VERIFY_BLOB_TIMEOUT_MS = 8_000;

async function verifyBlobExists(containerName, blobName) {
  const client = getClient();

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), VERIFY_BLOB_TIMEOUT_MS);

  try {
    const props = await client.send(
      new HeadObjectCommand({ Bucket: containerName, Key: blobName }),
      { abortSignal: abortController.signal }
    );
    return {
      exists: true,
      contentType: props.ContentType,
      contentLength: props.ContentLength,
      lastModified: props.LastModified,
    };
  } catch (err) {
    if (err.name === 'AbortError' || err.$metadata?.httpStatusCode === 403) {
      // R2 returns 403 for missing blobs on presigned-path buckets
      return { exists: false };
    }
    if (err.$metadata?.httpStatusCode === 404) {
      return { exists: false };
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Upload a buffer directly to R2 (server-side PDF generation).
 */
async function uploadBufferToBlob(containerName, blobName, buffer, contentType) {
  const client = getClient();

  await client.send(
    new PutObjectCommand({
      Bucket: containerName,
      Key: blobName,
      Body: buffer,
      ContentType: contentType,
    })
  );

  const readUrl = await generateReadSASUrl(containerName, blobName);
  return { url: readUrl.sasUrl };
}

/**
 * Delete a blob.
 */
async function deleteBlob(containerName, blobName) {
  const client = getClient();
  await client.send(new DeleteObjectCommand({ Bucket: containerName, Key: blobName }));
}

module.exports = {
  getClient,
  generateULID,
  generateUploadSASUrl,
  generateReadSASUrl,
  verifyBlobExists,
  uploadBufferToBlob,
  deleteBlob,
  CONTENT_TYPE_EXT,
};


