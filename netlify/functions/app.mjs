import { createApp } from '../../src/server.js';
import * as billing from '../../src/billing.js';
import { resolveDeploymentOrigin } from '../lib/deployment-origin.mjs';
import { invokeNodeHandler } from '../lib/node-http-bridge.mjs';

let appPromise = null;

function setDefault(name, value) {
  if (!String(process.env[name] || '').trim()) process.env[name] = value;
}

function enforceNonPublishedSafety(deployment) {
  if (deployment.localDev || deployment.published !== false) return false;
  // Preview/branch code must never inherit production side effects. Clear the
  // credentials that otherwise make billing readiness fail merely by being
  // present; the remaining explicit flags keep every trusted runtime path off.
  Object.assign(process.env, {
    ENABLE_LIVE_BILLING: '0',
    ENABLE_ACCOUNTS: '0',
    REQUIRE_EMAIL: '0',
    EMAIL_TRANSPORT: 'memory',
    DISABLE_WORKER: '1',
    WORKER_MODE: 'netlify-background',
    ENABLE_AFFILIATE_LINKS: '0',
    AFFILIATE_RELATIONSHIPS_APPROVED: '0',
  });
  for (const name of [
    'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET',
    'RESEND_API_KEY', 'RESEND_WEBHOOK_SECRET',
    'WORKER_DISPATCH_SECRET',
  ]) delete process.env[name];
  return true;
}

function configureNetlifyEnvironment(request, context = {}) {
  // A deployed Function is always a production security boundary. Do not let
  // an accidental dashboard value disable launch validation. The Netlify CLI
  // is the sole exception and is recognized through independent trusted
  // context, process, request, and site-origin signals.
  const deployment = resolveDeploymentOrigin(request, context);
  process.env.NODE_ENV = deployment.localDev ? 'development' : 'production';
  const publicBaseUrl = deployment.origin;
  process.env.PUBLIC_BASE_URL = publicBaseUrl;

  const netlifyDatabase = Boolean(String(process.env.NETLIFY_DB_URL || '').trim());
  const configuredDb = String(process.env.PRICETRUTH_DB || '').trim();
  if (!netlifyDatabase && configuredDb && configuredDb !== ':memory:') {
    throw new Error('native Netlify Functions require NETLIFY_DB_URL; filesystem PRICETRUTH_DB paths are not durable');
  }

  // Safe defaults also apply when Netlify auto-provisions Postgres. The demo
  // catalog may be durable, but customer accounts, delivery, and charging stay
  // off until an operator explicitly promotes the deployment.
  setDefault('ENABLE_DEMO_SEED', '1');
  setDefault('ENABLE_ACCOUNTS', '0');
  setDefault('ENABLE_LIVE_BILLING', '0');
  if (netlifyDatabase) {
    process.env.DATABASE_MODE = 'netlify';
    process.env.WORKER_MODE = 'netlify-background';
    setDefault('DISABLE_WORKER', '0');
  } else {
    setDefault('DISABLE_WORKER', '1');
  }
  const previewSafe = enforceNonPublishedSafety(deployment);
  const ephemeralDatabase = !netlifyDatabase;
  return { dbPath: ephemeralDatabase ? ':memory:' : undefined, publicBaseUrl, previewSafe };
}

async function initializeApp(request, context = {}) {
  const { dbPath } = configureNetlifyEnvironment(request, context);
  const priceCatalogVerification = billing.mode() === 'live'
    ? await billing.verifyLivePriceCatalog()
    : null;
  const assetRoot = process.env.LAMBDA_TASK_ROOT || process.cwd();
  return createApp({
    dbPath,
    priceCatalogVerification,
    startTimers: false,
    assetRoot,
  });
}

function getApp(request, context = {}) {
  if (!appPromise) {
    appPromise = initializeApp(request, context).catch((error) => {
      appPromise = null;
      throw error;
    });
  }
  return appPromise;
}

async function handler(request, context = {}) {
  try {
    const app = await getApp(request, context);
    return await invokeNodeHandler(request, context, app.handle);
  } catch (error) {
    console.error('[netlify function]', error);
    return Response.json(
      { error: 'service initialization or request handling failed', code: 'FUNCTION_UNAVAILABLE' },
      {
        status: 503,
        headers: {
          'Cache-Control': 'no-store',
          ...(context.requestId ? { 'X-Request-Id': String(context.requestId) } : {}),
        },
      },
    );
  }
}

const config = {
  path: ['/api/*', '/go/*', '/download/*', '/billing/*'],
  excludedPath: [
    '/api/billing/webhook',
    '/api/email/webhook',
    '/api/internal/worker',
  ],
  rateLimit: {
    action: 'rate_limit',
    aggregateBy: ['ip'],
    windowLimit: 300,
    windowSize: 60,
  },
};

export default handler;
export { config, configureNetlifyEnvironment, enforceNonPublishedSafety, getApp, initializeApp };
