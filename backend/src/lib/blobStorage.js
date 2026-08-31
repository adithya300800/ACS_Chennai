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
const { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand, PutBucketCorsCommand, CreateBucketCommand, HeadBucketCommand } = require('@aws-sdk/client-s3');
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

// R2 buckets we own — CORS policy must allow the frontend origin so the
// browser's preflight (OPTIONS) on a presigned PUT URL doesn't return 403
// and abort the upload before the bytes leave. Without this, the frontend
// gets a generic "Network error during upload" because the XHR error event
// fires on preflight failure, not on the PUT itself.
//
// Discovery: round-13. R2 buckets had no CORS rule at all, so the browser
// preflight from https://acschennai.com → <bucket>.<account>.r2... returned
// 403 with no Access-Control-Allow-* headers, killing the upload. Backend
// code was correct; only the bucket policy was missing.
const ALLOWED_R2_BUCKETS = [
  process.env.R2_BUCKET_DPR_PHOTOS        || 'dpr-photos',
  process.env.R2_BUCKET_DPR_DOCUMENTS     || 'dpr-documents',
  process.env.R2_BUCKET_INSPECTION_PHOTOS || 'inspection-photos',
].filter(Boolean);

/**
 * Apply a permissive-yet-scoped CORS policy to every R2 bucket we use, so
 * the browser's preflight to the presigned PUT URL succeeds. Also auto-
 * creates any missing bucket first (round-13 finding: round-12 added the
 * `inspection-photos` route but the bucket was never provisioned in R2,
 * so uploads silently failed with "Network error during upload").
 *
 * Idempotent — safe to call on every boot. CreateBucket errors with
 * `BucketAlreadyOwnedByYou` / `BucketAlreadyExists` are treated as success
 * (the bucket is there, which is what we wanted).
 *
 * Non-fatal at the boot layer: caller logs errors and continues serving
 * traffic even if a bucket can't be created (operator must add the
 * missing permissions to the R2 access key, or create buckets manually
 * via the Cloudflare dashboard / wrangler CLI).
 */
async function applyR2Cors(allowedOrigins) {
  const client = getClient();
  const origins = (Array.isArray(allowedOrigins) && allowedOrigins.length > 0)
    ? allowedOrigins
    : ['https://acschennai.com']; // safe default if env not set
  const rules = [{
    AllowedOrigins: origins,
    AllowedMethods: ['PUT', 'GET', 'HEAD'],
    AllowedHeaders: ['*'],
    ExposeHeaders:  ['ETag'],
    MaxAgeSeconds:  300,
  }];
  const results = [];
  for (const Bucket of ALLOWED_R2_BUCKETS) {
    let bucketReady = true;
    let createErr = null;
    try {
      // Step 1: ensure the bucket exists. CreateBucket is idempotent — an
      // existing bucket just returns BucketAlreadyOwnedByYou (HTTP 200
      // with a body marker). The R2 S3-compatible API accepts the same
      // call shape as AWS S3; location constraint is omitted since R2
      // chooses the bucket's region itself.
      await client.send(new CreateBucketCommand({ Bucket }));
    } catch (err) {
      const code = err?.$metadata?.httpStatusCode;
      const name = err?.name || err?.Code || '';
      if (name === 'BucketAlreadyOwnedByYou' || name === 'BucketAlreadyExists' || code === 409) {
        // Already exists — that's what we wanted.
      } else {
        bucketReady = false;
        createErr = err;
      }
    }

    if (!bucketReady) {
      results.push({ Bucket, ok: false, error: `create: ${createErr?.$metadata?.httpStatusCode || createErr?.name || createErr?.message}` });
      continue;
    }

    // Step 2: apply (or refresh) the CORS policy.
    try {
      await client.send(new PutBucketCorsCommand({ Bucket, CORSConfiguration: { CORSRules: rules } }));
      results.push({ Bucket, ok: true });
    } catch (err) {
      results.push({ Bucket, ok: false, error: `cors: ${err?.$metadata?.httpStatusCode || err?.name || err?.message}` });
    }
  }
  return results;
}

module.exports = {
  getClient,
  generateULID,
  generateUploadSASUrl,
  generateReadSASUrl,
  verifyBlobExists,
  uploadBufferToBlob,
  deleteBlob,
  applyR2Cors,
  ALLOWED_R2_BUCKETS,
  CONTENT_TYPE_EXT,
};


