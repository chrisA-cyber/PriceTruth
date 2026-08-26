import { configureNetlifyEnvironment } from './app.mjs';
import { MIN_SECRET_LENGTH, WORKER_PATH, createWorkerDispatch, validSecret } from '../lib/worker-auth.mjs';

function skipped(reason, logger = console) {
  logger.info?.(`[netlify worker schedule] skipped: ${reason}`);
  return new Response(null, {
    status: 204,
    headers: {
      'cache-control': 'no-store',
      'x-pricetruth-worker': `skipped-${reason}`,
    },
  });
}

async function dispatchWorker(request, context = {}, {
  fetchImpl = globalThis.fetch,
  now = Date.now(),
  logger = console,
} = {}) {
  const { publicBaseUrl } = await configureNetlifyEnvironment(request, context, {
    // Scheduled Functions cannot be invoked through a public URL and their
    // automatic clock runs only on the published production deploy.
    trustProductionSchedule: true,
  });
  if (process.env.DISABLE_WORKER === '1') return skipped('disabled', logger);

  const secret = process.env.WORKER_DISPATCH_SECRET;
  if (!secret) return skipped('secret-unset', logger);
  if (!validSecret(secret)) {
    throw new Error(`WORKER_DISPATCH_SECRET must contain at least ${MIN_SECRET_LENGTH} characters`);
  }
  const target = new URL(WORKER_PATH, publicBaseUrl);
  const dispatch = createWorkerDispatch({ secret, now, pathname: target.pathname });
  const response = await fetchImpl(target, {
    method: 'POST',
    headers: dispatch.headers,
    body: dispatch.body,
    redirect: 'error',
  });
  if (response.status !== 202 && !response.ok) {
    throw new Error(`background worker dispatch failed with HTTP ${response.status}`);
  }
  logger.info?.(`[netlify worker schedule] dispatched request ${context.requestId || '(no request id)'}`);
  return Response.json(
    { dispatched: true, accepted: response.status === 202 },
    { headers: { 'cache-control': 'no-store' } },
  );
}

const config = {
  schedule: '* * * * *',
};

export default dispatchWorker;
export { config, dispatchWorker, skipped };
