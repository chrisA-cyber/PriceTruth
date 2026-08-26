import assert from 'node:assert/strict';
import test from 'node:test';

import handler, { config, configureNetlifyEnvironment, getApp, initializeApp } from '../netlify/functions/app.mjs';
import { invokeNodeHandler } from '../netlify/lib/node-http-bridge.mjs';

const MANAGED_ENV = [
  'NODE_ENV', 'PUBLIC_BASE_URL', 'PRICETRUTH_DB', 'NETLIFY_DB_URL',
  'DATABASE_MODE', 'WORKER_MODE', 'ENABLE_DEMO_SEED', 'ENABLE_ACCOUNTS',
  'ENABLE_LIVE_BILLING', 'DISABLE_WORKER', 'NETLIFY_DEV', 'REQUIRE_EMAIL',
  'EMAIL_TRANSPORT', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET',
  'RESEND_API_KEY', 'RESEND_WEBHOOK_SECRET', 'WORKER_DISPATCH_SECRET',
  'ENABLE_AFFILIATE_LINKS', 'AFFILIATE_RELATIONSHIPS_APPROVED',
  'AFFILIATE_DISCLOSURE_URL', 'AFFILIATE_TAG_BOOKING',
];

test('Netlify v2 function boots in an explicit stateless demo mode and serves API routes', async () => {
  const previous = Object.fromEntries(MANAGED_ENV.map((name) => [name, process.env[name]]));
  for (const name of MANAGED_ENV) delete process.env[name];
  const context = {
    ip: '192.0.2.25',
    requestId: 'netlify-function-test',
    site: { url: 'https://pricetruth.netlify.app' },
  };
  let app;
  try {
    assert.deepEqual(config.path, ['/api/*', '/go/*', '/download/*', '/billing/*']);
    assert.deepEqual(config.excludedPath, [
      '/api/billing/webhook', '/api/email/webhook', '/api/internal/worker',
    ]);
    assert.deepEqual(config.rateLimit.aggregateBy, ['ip']);
    const response = await handler(new Request('https://pricetruth.netlify.app/api/ready'), context);
    assert.equal(response.status, 200);
    const readiness = await response.json();
    assert.equal(readiness.ok, true);
    assert.equal(readiness.database.storage, 'memory');
    assert.equal(readiness.capabilities.accounts.enabled, false);
    assert.equal(readiness.worker.enabled, false);
    assert.equal(process.env.PUBLIC_BASE_URL, 'https://pricetruth.netlify.app');

    const billingReturn = await handler(
      new Request('https://pricetruth.netlify.app/billing/success?session_id=cs_test'),
      context,
    );
    assert.equal(billingReturn.status, 200);
    assert.match(billingReturn.headers.get('content-type') || '', /^text\/html/);
    assert.match(await billingReturn.text(), /<main id="app"/);
    app = await getApp(new Request('https://pricetruth.netlify.app/api/health'), context);
  } finally {
    app?.db.close();
    for (const name of MANAGED_ENV) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test('Netlify preview and branch functions use their current deploy origin, not the main site', () => {
  const previous = Object.fromEntries(MANAGED_ENV.map((name) => [name, process.env[name]]));
  try {
    process.env.PUBLIC_BASE_URL = 'https://www.pricetruth.com';
    for (const [deployContext, hostname, published] of [
      ['deploy-preview', 'deploy-preview-42--pricetruth.netlify.app', false],
      // The explicit branch context remains authoritative even if a future
      // runtime uses "published" to mean published at the branch alias.
      ['branch-deploy', 'staging--pricetruth.netlify.app', true],
    ]) {
      const result = configureNetlifyEnvironment(
        new Request(`https://${hostname}/api/health`),
        {
          deploy: { context: deployContext, published },
          site: { url: 'https://www.pricetruth.com' },
        },
      );
      assert.equal(result.publicBaseUrl, `https://${hostname}`);
      assert.equal(process.env.PUBLIC_BASE_URL, `https://${hostname}`);
    }
  } finally {
    for (const name of MANAGED_ENV) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test('non-published Netlify code cannot inherit live billing, email, accounts, workers, or affiliate monetization', async () => {
  const previous = Object.fromEntries(MANAGED_ENV.map((name) => [name, process.env[name]]));
  const request = new Request('https://deploy-preview-42--pricetruth.netlify.app/api/ready');
  const context = {
    ip: '192.0.2.42',
    requestId: 'netlify-hostile-preview-test',
    deploy: { context: 'deploy-preview', published: false },
    site: { url: 'https://pricetruth.netlify.app' },
  };
  let app;
  try {
    Object.assign(process.env, {
      ENABLE_DEMO_SEED: '1',
      ENABLE_ACCOUNTS: '1',
      ENABLE_LIVE_BILLING: '1',
      REQUIRE_EMAIL: '1',
      EMAIL_TRANSPORT: 'resend',
      DISABLE_WORKER: '0',
      ENABLE_AFFILIATE_LINKS: '1',
      AFFILIATE_RELATIONSHIPS_APPROVED: '1',
      AFFILIATE_DISCLOSURE_URL: 'https://legal.launch-operator.com/affiliate-disclosure',
      AFFILIATE_TAG_BOOKING: 'production-booking-tag',
      STRIPE_SECRET_KEY: `sk_live_${'s'.repeat(24)}`,
      STRIPE_WEBHOOK_SECRET: `whsec_${'w'.repeat(24)}`,
      RESEND_API_KEY: `re_${'r'.repeat(24)}`,
      RESEND_WEBHOOK_SECRET: 'e'.repeat(32),
      WORKER_DISPATCH_SECRET: 'd'.repeat(48),
    });

    app = await initializeApp(request, context);
    const response = await invokeNodeHandler(request, context, app.handle);
    assert.equal(response.status, 200);
    const readiness = await response.json();
    assert.equal(readiness.paidLaunch.mode, 'disabled');
    assert.equal(readiness.paidLaunch.required, false);
    assert.equal(readiness.capabilities.accounts.requested, false);
    assert.equal(readiness.capabilities.accounts.enabled, false);
    assert.equal(readiness.worker.enabled, false);
    assert.equal(readiness.worker.dispatchConfigured, false);
    assert.equal(app.mailer.readiness().transport, 'memory');
    assert.equal(process.env.ENABLE_AFFILIATE_LINKS, '0');
    assert.equal(process.env.AFFILIATE_RELATIONSHIPS_APPROVED, '0');
    const affiliate = await invokeNodeHandler(
      new Request('https://deploy-preview-42--pricetruth.netlify.app/go/booking?target=https%3A%2F%2Fwww.booking.com%2Fhotel%2Fus%2Fexample.html'),
      context,
      app.handle,
    );
    assert.equal(affiliate.status, 404);
    for (const name of [
      'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'RESEND_API_KEY',
      'RESEND_WEBHOOK_SECRET', 'WORKER_DISPATCH_SECRET',
    ]) assert.equal(process.env[name], undefined, name);
  } finally {
    await app?.db.close();
    for (const name of MANAGED_ENV) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test('published Netlify production uses a validated configured or main site origin', () => {
  const previous = Object.fromEntries(MANAGED_ENV.map((name) => [name, process.env[name]]));
  try {
    delete process.env.PUBLIC_BASE_URL;
    const context = {
      deploy: { context: 'production', published: true },
      site: { url: 'https://www.pricetruth.com' },
    };
    const result = configureNetlifyEnvironment(
      new Request('https://1234abcd--pricetruth.netlify.app/api/health'),
      context,
    );
    assert.equal(result.publicBaseUrl, 'https://www.pricetruth.com');

    process.env.PUBLIC_BASE_URL = 'https://app.pricetruth.com';
    assert.equal(configureNetlifyEnvironment(
      new Request('https://1234abcd--pricetruth.netlify.app/api/health'),
      context,
    ).publicBaseUrl, 'https://app.pricetruth.com');

    process.env.PUBLIC_BASE_URL = 'http://127.0.0.1:4780';
    assert.throws(() => configureNetlifyEnvironment(
      new Request('https://pricetruth.netlify.app/api/health'),
      context,
    ), /PUBLIC_BASE_URL must be a public origin-only HTTPS URL/);
  } finally {
    for (const name of MANAGED_ENV) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test('Netlify Dev permits only its independently attested HTTP loopback origin', () => {
  const previous = Object.fromEntries(MANAGED_ENV.map((name) => [name, process.env[name]]));
  try {
    process.env.NETLIFY_DEV = 'true';
    process.env.PUBLIC_BASE_URL = 'https://www.pricetruth.com';
    const context = {
      deploy: { context: 'dev', published: false },
      site: { url: 'http://localhost:4791' },
    };
    const result = configureNetlifyEnvironment(
      new Request('http://127.0.0.1:4791/api/health'),
      context,
    );
    assert.equal(result.publicBaseUrl, 'http://127.0.0.1:4791');
    assert.equal(process.env.PUBLIC_BASE_URL, 'http://127.0.0.1:4791');
    assert.equal(process.env.NODE_ENV, 'development');

    delete process.env.NETLIFY_DEV;
    assert.throws(() => configureNetlifyEnvironment(
      new Request('http://localhost:4791/api/health'),
      context,
    ), /public origin-only HTTPS URL/);

    process.env.NETLIFY_DEV = 'true';
    assert.throws(() => configureNetlifyEnvironment(
      new Request('http://localhost:4792/api/health'),
      context,
    ), /same loopback port/);
  } finally {
    for (const name of MANAGED_ENV) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});
