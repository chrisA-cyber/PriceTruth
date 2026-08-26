import assert from 'node:assert/strict';
import test from 'node:test';

import { config as appConfig, configureNetlifyEnvironment } from '../netlify/functions/app.mjs';
import { config as webhookConfig } from '../netlify/functions/webhooks.mjs';
import { config as scheduleConfig, dispatchWorker } from '../netlify/functions/worker-schedule.mjs';
import {
  config as backgroundConfig,
  runBackgroundWorker,
} from '../netlify/functions/worker-background.mjs';
import {
  WORKER_PATH,
  createWorkerDispatch,
  verifyWorkerRequest,
} from '../netlify/lib/worker-auth.mjs';
import { invokeNodeHandler } from '../netlify/lib/node-http-bridge.mjs';
import { createApp } from '../src/server.js';

const SECRET = 'test-worker-secret-that-is-at-least-32-characters-long';
const MANAGED_ENV = [
  'NODE_ENV', 'PUBLIC_BASE_URL', 'PRICETRUTH_DB', 'NETLIFY_DB_URL',
  'DATABASE_MODE', 'WORKER_MODE', 'ENABLE_DEMO_SEED', 'ENABLE_ACCOUNTS', 'ENABLE_LIVE_BILLING',
  'DISABLE_WORKER', 'WORKER_DISPATCH_SECRET',
];

async function withEnvironment(values, callback) {
  const previous = Object.fromEntries(MANAGED_ENV.map((name) => [name, process.env[name]]));
  for (const name of MANAGED_ENV) delete process.env[name];
  Object.assign(process.env, values);
  try {
    return await callback();
  } finally {
    for (const name of MANAGED_ENV) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
}

test('Netlify routes isolate webhooks and the private worker from public rate limiting', () => {
  assert.deepEqual(appConfig.excludedPath, [
    '/api/billing/webhook',
    '/api/email/webhook',
    WORKER_PATH,
  ]);
  assert.deepEqual(appConfig.rateLimit, {
    action: 'rate_limit', aggregateBy: ['ip'], windowLimit: 300, windowSize: 60,
  });
  assert.deepEqual(webhookConfig, {
    path: ['/api/billing/webhook', '/api/email/webhook'], method: 'POST',
  });
  assert.equal('rateLimit' in webhookConfig, false);
  assert.deepEqual(scheduleConfig, { schedule: '* * * * *' });
  assert.deepEqual(backgroundConfig, {
    path: WORKER_PATH,
    method: 'POST',
    background: true,
    rateLimit: {
      action: 'rate_limit', aggregateBy: ['ip'], windowLimit: 10, windowSize: 60,
    },
  });
});

test('Netlify environment selects managed Postgres and safe demo capabilities automatically', async () => {
  await withEnvironment({ NETLIFY_DB_URL: 'postgresql://example.invalid/pricetruth' }, async () => {
    const selection = configureNetlifyEnvironment(
      new Request('https://pricetruth.netlify.app/api/health'),
      { site: { url: 'https://pricetruth.netlify.app' } },
    );
    assert.equal(selection.dbPath, undefined);
    assert.equal(process.env.DATABASE_MODE, 'netlify');
    assert.equal(process.env.WORKER_MODE, 'netlify-background');
    assert.equal(process.env.ENABLE_DEMO_SEED, '1');
    assert.equal(process.env.ENABLE_ACCOUNTS, '0');
    assert.equal(process.env.ENABLE_LIVE_BILLING, '0');
    assert.equal(process.env.DISABLE_WORKER, '0');
  });
});

test('readiness reports the Netlify worker disabled until dispatch auth exists', async () => {
  await withEnvironment({
    NODE_ENV: 'development',
    WORKER_MODE: 'netlify-background',
    DISABLE_WORKER: '0',
  }, async () => {
    const app = await createApp({ dbPath: ':memory:', startTimers: false });
    try {
      const response = await invokeNodeHandler(
        new Request('http://localhost:4780/api/ready'),
        { ip: '127.0.0.1' },
        app.handle,
      );
      const readiness = await response.json();
      assert.deepEqual(readiness.worker, {
        enabled: false,
        mode: 'netlify-background',
        dispatchConfigured: false,
      });
    } finally {
      await app.db.close();
    }
  });
});

test('worker dispatch authentication rejects tampering and stale requests', () => {
  const timestamp = 1_800_000_000_000;
  const dispatch = createWorkerDispatch({ secret: SECRET, now: timestamp });
  const base = {
    secret: SECRET,
    timestamp: dispatch.headers['x-pricetruth-worker-timestamp'],
    signature: dispatch.headers['x-pricetruth-worker-signature'],
    body: dispatch.body,
    pathname: WORKER_PATH,
  };
  assert.deepEqual(verifyWorkerRequest({ ...base, now: timestamp + 1_000 }), { ok: true, timestamp });
  assert.equal(verifyWorkerRequest({ ...base, body: `${dispatch.body} `, now: timestamp + 1_000 }).reason, 'invalid-signature');
  assert.equal(verifyWorkerRequest({ ...base, now: timestamp + 6 * 60_000 }).reason, 'stale-timestamp');
});

test('scheduled worker dispatch no-ops safely without a secret', async () => {
  await withEnvironment({ DISABLE_WORKER: '0', ENABLE_DEMO_SEED: '1' }, async () => {
    let fetchCalled = false;
    const response = await dispatchWorker(
      new Request('https://pricetruth.netlify.app/.netlify/functions/worker-schedule'),
      { site: { url: 'https://pricetruth.netlify.app' } },
      {
        fetchImpl: async () => { fetchCalled = true; return new Response(null, { status: 202 }); },
        logger: { info() {} },
      },
    );
    assert.equal(response.status, 204);
    assert.equal(fetchCalled, false);
  });
});

test('scheduled worker signs and sends a same-site background request', async () => {
  await withEnvironment({
    DISABLE_WORKER: '0',
    ENABLE_DEMO_SEED: '1',
    WORKER_DISPATCH_SECRET: SECRET,
  }, async () => {
    const timestamp = 1_800_000_000_000;
    let received;
    const response = await dispatchWorker(
      new Request('https://pricetruth.netlify.app/.netlify/functions/worker-schedule'),
      {
        deploy: { context: 'production', published: true },
        site: { url: 'https://pricetruth.netlify.app' },
        requestId: 'schedule-test',
      },
      {
        now: timestamp,
        fetchImpl: async (url, init) => {
          received = { url: String(url), init };
          return new Response(null, { status: 202 });
        },
        logger: { info() {} },
      },
    );
    assert.equal(response.status, 200);
    assert.equal(received.url, `https://pricetruth.netlify.app${WORKER_PATH}`);
    const verification = verifyWorkerRequest({
      secret: SECRET,
      timestamp: received.init.headers['x-pricetruth-worker-timestamp'],
      signature: received.init.headers['x-pricetruth-worker-signature'],
      body: received.init.body,
      pathname: WORKER_PATH,
      now: timestamp,
    });
    assert.equal(verification.ok, true);
  });
});

test('manual preview scheduler cannot run inherited production work', async () => {
  await withEnvironment({
    PUBLIC_BASE_URL: 'https://www.pricetruth.com',
    DISABLE_WORKER: '0',
    ENABLE_DEMO_SEED: '1',
    ENABLE_ACCOUNTS: '1',
    ENABLE_LIVE_BILLING: '1',
    REQUIRE_EMAIL: '1',
    EMAIL_TRANSPORT: 'resend',
    ENABLE_AFFILIATE_LINKS: '1',
    AFFILIATE_RELATIONSHIPS_APPROVED: '1',
    STRIPE_SECRET_KEY: `sk_live_${'s'.repeat(24)}`,
    STRIPE_WEBHOOK_SECRET: `whsec_${'w'.repeat(24)}`,
    RESEND_API_KEY: `re_${'r'.repeat(24)}`,
    RESEND_WEBHOOK_SECRET: 'e'.repeat(32),
    WORKER_DISPATCH_SECRET: SECRET,
  }, async () => {
    const timestamp = 1_800_000_000_000;
    let received;
    const response = await dispatchWorker(
      new Request('https://deploy-preview-42--pricetruth.netlify.app/.netlify/functions/worker-schedule'),
      {
        deploy: { context: 'deploy-preview', published: false },
        site: { url: 'https://www.pricetruth.com' },
        requestId: 'preview-schedule-test',
      },
      {
        now: timestamp,
        fetchImpl: async (url, init) => {
          received = { url: String(url), init };
          return new Response(null, { status: 202 });
        },
        logger: { info() {} },
      },
    );
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('x-pricetruth-worker'), 'skipped-disabled');
    assert.equal(received, undefined);
    assert.equal(process.env.PUBLIC_BASE_URL, 'https://deploy-preview-42--pricetruth.netlify.app');
    assert.equal(process.env.DISABLE_WORKER, '1');
    assert.equal(process.env.WORKER_DISPATCH_SECRET, undefined);
  });
});

test('non-published scheduler rejects unsafe or production request origins before dispatch', async () => {
  await withEnvironment({
    DISABLE_WORKER: '0',
    ENABLE_DEMO_SEED: '1',
    WORKER_DISPATCH_SECRET: SECRET,
  }, async () => {
    let fetchCalled = false;
    const options = {
      fetchImpl: async () => { fetchCalled = true; return new Response(null, { status: 202 }); },
      logger: { info() {} },
    };
    const preview = { deploy: { context: 'deploy-preview', published: false }, site: { url: 'https://pricetruth.netlify.app' } };
    await assert.rejects(
      dispatchWorker(new Request('http://localhost:4780/.netlify/functions/worker-schedule'), preview, options),
      /public origin-only HTTPS URL/,
    );
    await assert.rejects(
      dispatchWorker(new Request('https://pricetruth.netlify.app/.netlify/functions/worker-schedule'), preview, options),
      /cannot use the main production site origin/,
    );
    assert.equal(fetchCalled, false);
  });
});

test('background worker authenticates, runs bounded maintenance, and drains batches', async () => {
  await withEnvironment({
    DISABLE_WORKER: '0',
    ENABLE_DEMO_SEED: '1',
    WORKER_DISPATCH_SECRET: SECRET,
  }, async () => {
    const timestamp = 1_800_000_000_000; // exact 15-minute maintenance bucket
    const dispatch = createWorkerDispatch({ secret: SECRET, now: timestamp });
    const request = new Request(`https://pricetruth.netlify.app${WORKER_PATH}`, {
      method: 'POST', headers: dispatch.headers, body: dispatch.body,
    });
    let maintenanceRuns = 0;
    let scheduleRuns = 0;
    let drainRuns = 0;
    const app = {
      async runMaintenance() { maintenanceRuns += 1; return { ok: true }; },
      async scheduleWorkerJobs() {
        scheduleRuns += 1;
        return { collectionJobs: 3, digestJobs: 2 };
      },
      async drainWorkerQueues() {
        drainRuns += 1;
        if (drainRuns === 1) {
          return { jobs: Array(10).fill({ status: 'completed' }), email: Array(25).fill({ status: 'sent' }), errors: [] };
        }
        return { jobs: [{ status: 'completed' }], email: [], errors: [] };
      },
    };
    const response = await runBackgroundWorker(request, {}, {
      getAppImpl: async () => app,
      now: () => timestamp + 1_000,
      logger: { info() {}, warn() {} },
      maxCycles: 5,
    });
    assert.equal(response.status, 200);
    const summary = await response.json();
    assert.equal(summary.ok, true);
    assert.equal(summary.cycles, 2);
    assert.equal(summary.drained, true);
    assert.equal(summary.processedJobs, 11);
    assert.equal(summary.processedEmail, 25);
    assert.equal(summary.collectionJobs, 3);
    assert.equal(summary.digestJobs, 2);
    assert.equal(summary.maintenance, true);
    assert.equal(maintenanceRuns, 1);
    assert.equal(scheduleRuns, 1);
    assert.equal(drainRuns, 2);
  });
});

test('ordinary one-minute worker dispatch drains queues without rescanning schedules', async () => {
  await withEnvironment({
    DISABLE_WORKER: '0',
    ENABLE_DEMO_SEED: '1',
    WORKER_DISPATCH_SECRET: SECRET,
  }, async () => {
    const timestamp = 1_800_000_000_000 + 60_000;
    const dispatch = createWorkerDispatch({ secret: SECRET, now: timestamp });
    const request = new Request(`https://pricetruth.netlify.app${WORKER_PATH}`, {
      method: 'POST', headers: dispatch.headers, body: dispatch.body,
    });
    let maintenanceRuns = 0;
    let scheduleRuns = 0;
    let drainRuns = 0;
    const app = {
      async runMaintenance() { maintenanceRuns += 1; return { ok: true }; },
      async scheduleWorkerJobs() { scheduleRuns += 1; return { collectionJobs: 99, digestJobs: 99 }; },
      async drainWorkerQueues() {
        drainRuns += 1;
        return { jobs: [], email: [], errors: [] };
      },
    };
    const response = await runBackgroundWorker(request, {}, {
      getAppImpl: async () => app,
      now: () => timestamp + 1_000,
      logger: { info() {}, warn() {} },
      maxCycles: 5,
    });
    assert.equal(response.status, 200);
    const summary = await response.json();
    assert.equal(summary.ok, true);
    assert.equal(summary.cycles, 1);
    assert.equal(summary.drained, true);
    assert.equal(summary.collectionJobs, 0);
    assert.equal(summary.digestJobs, 0);
    assert.equal(summary.maintenance, false);
    assert.equal(maintenanceRuns, 0);
    assert.equal(scheduleRuns, 0);
    assert.equal(drainRuns, 1);
  });
});

test('background worker rejects an invalid signature without initializing the app', async () => {
  await withEnvironment({ WORKER_DISPATCH_SECRET: SECRET }, async () => {
    const timestamp = 1_800_000_000_000;
    const dispatch = createWorkerDispatch({ secret: SECRET, now: timestamp });
    const headers = new Headers(dispatch.headers);
    headers.set('x-pricetruth-worker-signature', `v1=${'0'.repeat(64)}`);
    let initialized = false;
    const response = await runBackgroundWorker(
      new Request(`https://pricetruth.netlify.app${WORKER_PATH}`, { method: 'POST', headers, body: dispatch.body }),
      {},
      {
        getAppImpl: async () => { initialized = true; throw new Error('must not initialize'); },
        now: () => timestamp + 1_000,
        logger: { info() {}, warn() {} },
      },
    );
    assert.equal(response.status, 401);
    assert.equal(initialized, false);
  });
});

test('background worker stops reading an oversized streamed body before app initialization', async () => {
  await withEnvironment({ WORKER_DISPATCH_SECRET: SECRET }, async () => {
    let canceled = false;
    let initialized = false;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(4096));
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() { canceled = true; },
    });
    const response = await runBackgroundWorker(
      new Request(`https://pricetruth.netlify.app${WORKER_PATH}`, {
        method: 'POST',
        body,
        duplex: 'half',
      }),
      {},
      {
        getAppImpl: async () => { initialized = true; throw new Error('must not initialize'); },
        logger: { info() {}, warn() {} },
      },
    );
    assert.equal(response.status, 401);
    assert.equal(initialized, false);
    assert.equal(canceled, true);
    assert.equal((await response.json()).code, 'WORKER_DISPATCH_REJECTED');
  });
});
