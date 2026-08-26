import { getApp } from './app.mjs';
import {
  WORKER_PATH,
  WORKER_SIGNATURE_HEADER,
  WORKER_TIMESTAMP_HEADER,
  verifyWorkerRequest,
} from '../lib/worker-auth.mjs';

const MAX_BODY_BYTES = 4 * 1024;
const MAX_RUNTIME_MS = 12 * 60 * 1000;
const MAX_CYCLES = 500;
const JOB_BATCH_SIZE = 10;
const OUTBOX_BATCH_SIZE = 25;

function rejected(reason, logger = console) {
  logger.warn?.(`[netlify background worker] rejected: ${reason}`);
  return Response.json(
    { error: 'invalid worker dispatch', code: 'WORKER_DISPATCH_REJECTED' },
    { status: 401, headers: { 'cache-control': 'no-store' } },
  );
}

async function readBoundedBody(request, maxBytes = MAX_BODY_BYTES) {
  const contentLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) return null;
  if (!request.body) return '';

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maxBytes) {
        await reader.cancel('body-too-large').catch(() => {});
        return null;
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

function parseDispatch(body, verifiedTimestamp) {
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return null;
  }
  if (payload?.kind !== 'pricetruth-worker-cycle' ||
      payload.timestamp !== verifiedTimestamp ||
      typeof payload.maintenance !== 'boolean') return null;
  return payload;
}

function cycleIsDrained(result) {
  const jobs = Array.isArray(result?.jobs) ? result.jobs.length : 0;
  const email = Array.isArray(result?.email) ? result.email.length : 0;
  return jobs < JOB_BATCH_SIZE && email < OUTBOX_BATCH_SIZE;
}

async function runBackgroundWorker(request, context = {}, {
  getAppImpl = getApp,
  now = Date.now,
  logger = console,
  maxRuntimeMs = MAX_RUNTIME_MS,
  maxCycles = MAX_CYCLES,
} = {}) {
  if (request.method !== 'POST') return rejected('method', logger);
  const body = await readBoundedBody(request);
  if (body === null) return rejected('body-too-large', logger);

  const verification = verifyWorkerRequest({
    secret: process.env.WORKER_DISPATCH_SECRET,
    timestamp: request.headers.get(WORKER_TIMESTAMP_HEADER),
    signature: request.headers.get(WORKER_SIGNATURE_HEADER),
    body,
    method: request.method,
    pathname: new URL(request.url).pathname,
    now: now(),
  });
  if (!verification.ok) return rejected(verification.reason, logger);
  const dispatch = parseDispatch(body, verification.timestamp);
  if (!dispatch) return rejected('invalid-payload', logger);

  const startedAt = now();
  const deadline = startedAt + Math.max(1_000, Math.min(MAX_RUNTIME_MS, Number(maxRuntimeMs) || MAX_RUNTIME_MS));
  const app = await getAppImpl(request, context);
  if (process.env.DISABLE_WORKER === '1') {
    return Response.json({ skipped: true, reason: 'disabled' }, { headers: { 'cache-control': 'no-store' } });
  }

  let maintenance = null;
  if (dispatch.maintenance) maintenance = await app.runMaintenance();
  // Scheduling scans the tracked catalog and digest recipients. The scheduler
  // marks one dispatch every 15 minutes for maintenance, which is also the
  // minimum supported collection cadence. Only that dispatch performs the
  // scan; every minute's dispatch can still drain bounded queue batches.
  const scheduled = dispatch.maintenance && now() < deadline
    ? await app.scheduleWorkerJobs()
    : { collectionJobs: 0, digestJobs: 0 };
  let cycles = 0;
  let drained = false;
  let processedJobs = 0;
  let processedEmail = 0;
  const errors = [];

  while (cycles < Math.max(1, Math.min(MAX_CYCLES, Number(maxCycles) || MAX_CYCLES)) && now() < deadline) {
    const result = await app.drainWorkerQueues();
    cycles += 1;
    processedJobs += Array.isArray(result?.jobs) ? result.jobs.length : 0;
    processedEmail += Array.isArray(result?.email) ? result.email.length : 0;
    if (Array.isArray(result?.errors) && result.errors.length) {
      errors.push(...result.errors.slice(0, 20));
      break;
    }
    drained = cycleIsDrained(result);
    if (drained) break;
  }

  const summary = {
    ok: errors.length === 0,
    cycles,
    drained,
    processedJobs,
    processedEmail,
    collectionJobs: Number(scheduled?.collectionJobs) || 0,
    digestJobs: Number(scheduled?.digestJobs) || 0,
    maintenance: Boolean(maintenance),
    errors,
    elapsedMs: Math.max(0, now() - startedAt),
  };
  logger.info?.(`[netlify background worker] ${JSON.stringify(summary)}`);
  return Response.json(summary, { headers: { 'cache-control': 'no-store' } });
}

const config = {
  // Netlify's static config extractor cannot resolve imported constants here.
  // Keep this literal in sync with WORKER_PATH so the route reaches the
  // packaged background function in the deploy manifest.
  path: '/api/internal/worker',
  method: 'POST',
  background: true,
  rateLimit: {
    action: 'rate_limit',
    aggregateBy: ['ip'],
    windowLimit: 10,
    windowSize: 60,
  },
};

export default runBackgroundWorker;
export {
  JOB_BATCH_SIZE,
  MAX_BODY_BYTES,
  MAX_CYCLES,
  MAX_RUNTIME_MS,
  OUTBOX_BATCH_SIZE,
  config,
  cycleIsDrained,
  parseDispatch,
  readBoundedBody,
  rejected,
  runBackgroundWorker,
};
