/**
 * Azure Blob Storage helpers for DPR module
 * Requires: @azure/storage-blob
 * Env vars: AZURE_STORAGE_CONNECTION_STRING
 */

const { BlobServiceClient } = require('@azure/storage-blob');

let blobServiceClient = null;

function getClient() {
  if (!blobServiceClient) {
    const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING;
    if (!connStr) {
      throw new Error('AZURE_STORAGE_CONNECTION_STRING env var not set');
    }
    blobServiceClient = BlobServiceClient.fromConnectionString(connStr);
  }
  return blobServiceClient;
}

/**
 * Generate a ULID string
 */
function generateULID() {
  // Simple ULID-like ID using timestamp + random
  const time = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).substring(2, 12).toUpperCase();
  return time + rand;
}

/**
 * Generate SAS URL for uploading a blob (15 min expiry)
 * @param {string} containerName - 'dpr-photos' or 'dpr-documents'
 * @param {string} blobName - full blob name including extension
 * @param {string} contentType - MIME type
 */
async function generateUploadSASUrl(containerName, blobName, contentType) {
  const client = getClient();
  const containerClient = client.getContainerClient(containerName);
  const blockBlobClient = containerClient.getBlockBlobClient(blobName);

  const expiresOn = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

  const sasOptions = {
    containerName,
    blobName,
    permissions: 'rwdlacupitfx', // write + read + delete + list + create + update + process + tag + set immutability
    expiresOn,
    startsOn: new Date(Date.now() - 60 * 1000), // allow 1 min clock skew
    contentType,
  };

  const sasToken = blockBlobClient.generateBlobSASQueryToken(sasOptions);
  const sasUrl = `${blockBlobClient.url}?${sasToken}`;

  return {
    sasUrl,
    ulid: blobName.split('.')[0],
    blobPath: blobName,
    expiresAt: expiresOn.toISOString(),
  };
}

/**
 * Generate SAS URL for reading a blob (1 hour expiry)
 * @param {string} containerName
 * @param {string} blobName
 */
async function generateReadSASUrl(containerName, blobName) {
  const client = getClient();
  const containerClient = client.getContainerClient(containerName);
  const blockBlobClient = containerClient.getBlockBlobClient(blobName);

  const expiresOn = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

  const sasOptions = {
    containerName,
    blobName,
    permissions: 'r', // read only
    expiresOn,
  };

  const sasToken = blockBlobClient.generateBlobSASQueryToken(sasOptions);
  const sasUrl = `${blockBlobClient.url}?${sasToken}`;

  return { sasUrl, expiresAt: expiresOn.toISOString() };
}

/**
 * Verify a blob exists and check its properties
 * @param {string} containerName
 * @param {string} blobName
 */
async function verifyBlobExists(containerName, blobName) {
  const client = getClient();
  const containerClient = client.getContainerClient(containerName);
  const blobClient = containerClient.getBlobClient(blobName);

  try {
    const props = await blobClient.getProperties();
    return {
      exists: true,
      contentType: props.contentType,
      contentLength: props.contentLength,
      lastModified: props.lastModified,
    };
  } catch (err) {
    if (err.statusCode === 404) {
      return { exists: false };
    }
    throw err;
  }
}

/**
 * Upload a buffer directly to blob (used for PDF generation server-side)
 * @param {string} containerName
 * @param {string} blobName
 * @param {Buffer} buffer
 * @param {string} contentType
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
 * Delete a blob
 * @param {string} containerName
 * @param {string} blobName
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
};
