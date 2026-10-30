'use strict';

const FETCH_CODES = new Set([
  'FETCH_URL_INVALID', 'FETCH_SCHEME_REFUSED', 'FETCH_HOST_REFUSED',
  'FETCH_ADDRESS_REFUSED', 'FETCH_REDIRECT_REFUSED', 'FETCH_TIMEOUT',
  'FETCH_STATUS_ERROR', 'FETCH_TOO_LARGE', 'FETCH_HASH_MISMATCH',
  'FETCH_SIZE_MISMATCH', 'FETCH_NOT_CONFIGURED',
]);

const ERROR_MAP = Object.freeze({
  AUTH_REQUIRED: [502, 'BOQ_SERVICE_UNAVAILABLE', 'The drawing service rejected our request. Please tell your admin.'],
  VALIDATION_ERROR: [400, 'BOQ_VALIDATION', 'Some of the drawing details were not accepted'],
  NOT_FOUND: [409, 'BOQ_LINE_GONE', 'That line is no longer in the drawing set. Reload the BOQ.'],
  JOB_NOT_FOUND: [409, 'BOQ_JOB_LOST', 'The drawing service forgot this job. Run it again.'],
  UNSUPPORTED_FILE_TYPE: [400, 'BOQ_UNSUPPORTED_FILE', 'We can measure IFC and DXF files only.'],
  PDF_NOT_SUPPORTED: [400, 'BOQ_PDF_UNSUPPORTED', 'PDF drawings cannot be measured yet.'],
  UPLOAD_TOO_LARGE: [413, 'BOQ_FILE_TOO_LARGE', 'The file is over the service upload limit.'],
  REQUEST_TOO_LARGE: [413, 'BOQ_FILE_TOO_LARGE', 'The request is over the service upload limit.'],
  TOO_MANY_SOURCES: [400, 'BOQ_TOO_MANY_FILES', 'A run may contain at most 20 files.'],
  PRODUCTION_DATA_BLOCKED: [409, 'BOQ_PRODUCTION_BLOCKED', 'The drawing service is configured to refuse this data. Tell your admin.'],
  JOB_NOT_READY: [409, 'BOQ_NOT_READY', 'The BOQ is not ready yet.'],
  JOB_FAILED: [409, 'BOQ_JOB_FAILED', 'The drawing service could not complete this job.'],
  CORRECTION_REFUSED: [409, 'BOQ_CORRECTION_REFUSED', 'That change was not accepted.'],
  RATE_LIMITED: [429, 'BOQ_SERVICE_BUSY', 'The drawing service is busy. Try again shortly.'],
  IDEMPOTENCY_CONFLICT: [409, 'BOQ_CONFLICT', 'This job request conflicts with an earlier attempt.'],
  INTERNAL_ERROR: [502, 'BOQ_SERVICE_ERROR', 'Something went wrong in the drawing service. Try again.'],
  SOURCE_UNCALIBRATED: [409, 'BOQ_UNCALIBRATED', 'The drawing scale was not confirmed, so this drawing could not be measured.'],
  JOB_INTERRUPTED: [409, 'BOQ_INTERRUPTED', 'The drawing service restarted while this was running. Run it again.'],
});

function flat(status, code, message) {
  return { status, body: { error: code, code, message } };
}

function mapServiceError(error) {
  if (error?.kind === 'timeout' || error?.kind === 'network') {
    return flat(504, 'BOQ_TIMEOUT', 'The drawing service took too long to answer. It may still be working — try again shortly.');
  }
  if (error?.kind === 'unavailable') {
    return flat(503, 'BOQ_SERVICE_UNAVAILABLE', 'The drawing service is not configured. Please tell your admin.');
  }

  const code = error?.code;
  if (typeof code === 'string' && code.startsWith('FETCH_')) {
    return flat(502, 'BOQ_FETCH_FAILED', 'The drawing service could not read the file we sent it. Try again.');
  }
  if (FETCH_CODES.has(code)) {
    return flat(502, 'BOQ_FETCH_FAILED', 'The drawing service could not read the file we sent it. Try again.');
  }
  const mapping = ERROR_MAP[code];
  if (!mapping) {
    return flat(502, 'BOQ_SERVICE_ERROR', 'Something went wrong in the drawing service. Try again.');
  }

  let message = mapping[2];
  if (code === 'VALIDATION_ERROR' && typeof error.message === 'string' && error.message) {
    const safeDetail = error.message
      .replace(/https?:\/\/[^\s"'<>]+/gi, '[link redacted]')
      .replace(/\b(?:X-Amz-[A-Za-z0-9-]+|Signature|sig)=[^&\s]+/gi, '[signature redacted]')
      .slice(0, 240);
    message = `${message}: ${safeDetail}`;
  }
  return flat(mapping[0], mapping[1], message);
}

function mapServiceJobError(error) {
  if (!error || typeof error !== 'object') return null;
  const code = typeof error.code === 'string' ? error.code : '';
  const normalized = { code, message: typeof error.message === 'string' ? error.message : '' };
  // Job details are a list of strings, unlike API-envelope details objects.
  const details = Array.isArray(error.details)
    ? error.details.filter((item) => typeof item === 'string').slice(0, 10)
    : [];
  return { ...mapServiceError(normalized), details };
}

module.exports = { mapServiceError, mapServiceJobError };