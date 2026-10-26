'use strict';

// BOQ drawings and artifacts use a separate private R2 bucket and credential
// set from the portal's general-purpose blobStorage client.
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { randomBytes } = require('crypto');

const UPLOAD_TTL_SECONDS = 900;
const READ_TTL_SECONDS = 600;
const DEFAULT_BUCKET = 'boq-generator';
let s3Client;

function bucketName() {
  return process.env.R2_BOQ_BUCKET || DEFAULT_BUCKET;
}

function getClient() {
  if (s3Client) return s3Client;
  const accountId = process.env.R2_BOQ_ACCOUNT_ID;
  const accessKeyId = process.env.R2_BOQ_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_BOQ_SECRET_ACCESS_KEY;
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error('BOQ storage is not configured');
  }
  s3Client = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
  return s3Client;
}

function generateULID() {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let timestamp = BigInt(Date.now());
  let timePart = '';
  for (let i = 0; i < 10; i += 1) {
    timePart = alphabet[Number(timestamp & 31n)] + timePart;
    timestamp >>= 5n;
  }
  const random = BigInt(`0x${randomBytes(10).toString('hex')}`);
  let randomPart = '';
  for (let i = 0; i < 16; i += 1) {
    randomPart = alphabet[Number((random >> BigInt(i * 5)) & 31n)] + randomPart;
  }
  return timePart + randomPart;
}

async function createUploadUrl({ projectId, employeeId, uploadId, extension }) {
  const key = `drawings/${projectId}/${employeeId}/${uploadId}.${extension}`;
  const command = new PutObjectCommand({
    Bucket: bucketName(),
    Key: key,
    ContentType: 'application/octet-stream',
  });
  const sasUrl = await getSignedUrl(getClient(), command, { expiresIn: UPLOAD_TTL_SECONDS });
  return {
    sasUrl,
    blobPath: key,
    expiresAt: new Date(Date.now() + UPLOAD_TTL_SECONDS * 1000).toISOString(),
  };
}

async function verifyUpload(blobPath) {
  const s3 = getClient();
  const head = await s3.send(new HeadObjectCommand({ Bucket: bucketName(), Key: blobPath }));
  const response = await s3.send(new GetObjectCommand({
    Bucket: bucketName(),
    Key: blobPath,
    Range: 'bytes=0-31',
  }));
  const chunks = [];
  let length = 0;
  for await (const chunk of response.Body) {
    const bytes = Buffer.from(chunk);
    const remaining = 32 - length;
    chunks.push(bytes.subarray(0, remaining));
    length += Math.min(bytes.length, remaining);
    if (length >= 32) break;
  }
  return {
    contentLength: head.ContentLength,
    contentType: head.ContentType,
    prefix: Buffer.concat(chunks),
  };
}

async function createReadUrl(blobPath) {
  const command = new GetObjectCommand({ Bucket: bucketName(), Key: blobPath });
  const sasUrl = await getSignedUrl(getClient(), command, { expiresIn: READ_TTL_SECONDS });
  return {
    sasUrl,
    expiresAt: new Date(Date.now() + READ_TTL_SECONDS * 1000).toISOString(),
  };
}

async function readSnapshot(blobPath) {
  const response = await getClient().send(new GetObjectCommand({ Bucket: bucketName(), Key: blobPath }));
  const chunks = [];
  let size = 0;
  for await (const chunk of response.Body) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 5 * 1024 * 1024) throw new Error('BOQ snapshot exceeds the 5 MB read limit');
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function deleteBlob(blobPath) {
  await getClient().send(new DeleteObjectCommand({ Bucket: bucketName(), Key: blobPath }));
}

function resetClientForTests() {
  if (s3Client) s3Client.destroy();
  s3Client = null;
}

module.exports = {
  UPLOAD_TTL_SECONDS,
  READ_TTL_SECONDS,
  DEFAULT_BUCKET,
  bucketName,
  generateULID,
  createUploadUrl,
  verifyUpload,
  createReadUrl,
  readSnapshot,
  deleteBlob,
  resetClientForTests,
};