import crypto from 'node:crypto';

const WORKER_PATH = '/api/internal/worker';
const WORKER_SIGNATURE_HEADER = 'x-pricetruth-worker-signature';
const WORKER_TIMESTAMP_HEADER = 'x-pricetruth-worker-timestamp';
const MIN_SECRET_LENGTH = 32;
const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000;
const DEFAULT_FUTURE_SKEW_MS = 30 * 1000;

function validSecret(secret) {
  return typeof secret === 'string' && secret.length >= MIN_SECRET_LENGTH;
}

function canonicalRequest({ timestamp, body, method = 'POST', pathname = WORKER_PATH }) {
  return ['v1', method.toUpperCase(), pathname, String(timestamp), String(body)].join('\n');
}

function signWorkerRequest({ secret, timestamp, body, method = 'POST', pathname = WORKER_PATH }) {
  if (!validSecret(secret)) {
    throw new Error(`WORKER_DISPATCH_SECRET must contain at least ${MIN_SECRET_LENGTH} characters`);
  }
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
    throw new TypeError('worker dispatch timestamp must be a positive epoch millisecond integer');
  }
  const digest = crypto
    .createHmac('sha256', secret)
    .update(canonicalRequest({ timestamp, body, method, pathname }))
    .digest('hex');
  return `v1=${digest}`;
}

function verifyWorkerRequest({
  secret,
  timestamp,
  signature,
  body,
  method = 'POST',
  pathname = WORKER_PATH,
  now = Date.now(),
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  futureSkewMs = DEFAULT_FUTURE_SKEW_MS,
}) {
  if (!validSecret(secret)) return { ok: false, reason: 'secret-unavailable' };
  const parsedTimestamp = Number(timestamp);
  if (!Number.isSafeInteger(parsedTimestamp) || parsedTimestamp <= 0) {
    return { ok: false, reason: 'invalid-timestamp' };
  }
  const clock = Number(now);
  if (!Number.isFinite(clock) || clock - parsedTimestamp > maxAgeMs || parsedTimestamp - clock > futureSkewMs) {
    return { ok: false, reason: 'stale-timestamp' };
  }
  if (typeof signature !== 'string' || !/^v1=[a-f0-9]{64}$/i.test(signature)) {
    return { ok: false, reason: 'invalid-signature' };
  }
  const expected = signWorkerRequest({
    secret,
    timestamp: parsedTimestamp,
    body,
    method,
    pathname,
  });
  const suppliedBuffer = Buffer.from(signature.toLowerCase(), 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  if (suppliedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(suppliedBuffer, expectedBuffer)) {
    return { ok: false, reason: 'invalid-signature' };
  }
  return { ok: true, timestamp: parsedTimestamp };
}

function createWorkerDispatch({ secret, now = Date.now(), pathname = WORKER_PATH } = {}) {
  const timestamp = Number(now);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
    throw new TypeError('worker dispatch clock must return epoch milliseconds');
  }
  const body = JSON.stringify({
    kind: 'pricetruth-worker-cycle',
    timestamp,
    maintenance: Math.floor(timestamp / 60_000) % 15 === 0,
  });
  const signature = signWorkerRequest({ secret, timestamp, body, pathname });
  return {
    body,
    headers: {
      'content-type': 'application/json',
      [WORKER_TIMESTAMP_HEADER]: String(timestamp),
      [WORKER_SIGNATURE_HEADER]: signature,
    },
  };
}

export {
  DEFAULT_FUTURE_SKEW_MS,
  DEFAULT_MAX_AGE_MS,
  MIN_SECRET_LENGTH,
  WORKER_PATH,
  WORKER_SIGNATURE_HEADER,
  WORKER_TIMESTAMP_HEADER,
  canonicalRequest,
  createWorkerDispatch,
  signWorkerRequest,
  validSecret,
  verifyWorkerRequest,
};
