import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { NetlifyDB } from '@netlify/database-dev';
import { invokeNodeHandler } from '../netlify/lib/node-http-bridge.mjs';
import { openPostgres } from '../src/db-postgres.js';
import { createApp } from '../src/server.js';

const migrations = fileURLToPath(new URL('../netlify/database/migrations', import.meta.url));
const origin = 'http://localhost:4780';

function withEnvironment(values) {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === null) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function request(app, path, init = {}) {
  return invokeNodeHandler(
    new Request(`${origin}${path}`, init),
    { ip: '127.0.0.1', requestId: `postgres-app-${crypto.randomUUID()}` },
    app.handle,
  );
}

function cookieHeader(response) {
  return response.headers.getSetCookie().map((value) => value.split(';', 1)[0]).join('; ');
}

test('an explicit memory database keeps build preflight isolated from ambient Netlify Postgres', async () => {
  const restoreEnvironment = withEnvironment({
    NODE_ENV: 'test',
    PUBLIC_BASE_URL: origin,
    EMAIL_TRANSPORT: 'memory',
    OUTBOX_ENCRYPTION_KEY: 'memory-preflight-stable-encryption-key',
    ENABLE_ACCOUNTS: '1',
    ENABLE_LIVE_BILLING: '0',
    DISABLE_WORKER: '1',
    ADMIN_TOKEN: null,
    NETLIFY_DB_URL: 'this-ambient-postgres-url-must-never-be-opened',
  });
  let app;

  try {
    app = await createApp({ dbPath: ':memory:', startTimers: false });
    const readiness = await app.db.checkReady();
    assert.equal(readiness.ok, true);
    assert.equal(readiness.storage, 'memory');
    assert.equal(app.db.listPublicProducts(20).length, 5);
  } finally {
    await app?.db.close();
    restoreEnvironment();
  }
});

test('the native Netlify Postgres stack serves the complete HTTP and worker path', async () => {
  const restoreEnvironment = withEnvironment({
    NODE_ENV: 'test',
    PUBLIC_BASE_URL: origin,
    EMAIL_TRANSPORT: 'memory',
    OUTBOX_ENCRYPTION_KEY: 'postgres-app-integration-stable-encryption-key',
    ENABLE_ACCOUNTS: '1',
    ENABLE_LIVE_BILLING: '0',
    DISABLE_WORKER: '1',
    ADMIN_TOKEN: null,
  });
  const local = new NetlifyDB({ logger: () => {} });
  let app;

  try {
    const connectionString = await local.start();
    await local.applyMigrations(migrations);
    const db = openPostgres({ connectionString });
    app = await createApp({ db, startTimers: false });

    const healthResponse = await request(app, '/api/health');
    assert.equal(healthResponse.status, 200);
    assert.equal((await healthResponse.json()).ok, true);

    const readyResponse = await request(app, '/api/ready');
    assert.equal(readyResponse.status, 200);
    const ready = await readyResponse.json();
    assert.equal(ready.ok, true);
    assert.equal(ready.database.ok, true);
    assert.equal(ready.database.storage, 'postgres');
    assert.equal(ready.database.schemaVersion, 4);

    const productsResponse = await request(app, '/api/products?limit=2');
    assert.equal(productsResponse.status, 200);
    const products = await productsResponse.json();
    assert.equal(products.pagination.total, 5);
    assert.equal(products.products.length, 2);
    assert.equal(products.products.every((entry) => entry.product && !('then' in entry.product)), true);

    const productResponse = await request(app, '/api/products/anc-headphones?days=90');
    assert.equal(productResponse.status, 200);
    const product = await productResponse.json();
    assert.equal(product.product.id, 'anc-headphones');
    assert.equal(product.history.length > 30, true);
    assert.equal(product.provenance.evidence.demo, true);
    assert.equal(product.alertEligible, false);

    const searchResponse = await request(app, '/api/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ vertical: 'subscription', q: 'netflix' }),
    });
    assert.equal(searchResponse.status, 200);
    const search = await searchResponse.json();
    assert.equal(search.persisted, false);
    assert.equal(search.listing.providerIdentity, 'netflix-standard');
    assert.equal(search.report.vertical, 'subscription');

    const anonymousSession = await request(app, '/api/session');
    assert.equal(anonymousSession.status, 200);
    assert.deepEqual(await anonymousSession.json(), { authenticated: false });

    const anonymousAccount = await request(app, '/api/account');
    assert.equal(anonymousAccount.status, 401);
    assert.equal((await anonymousAccount.json()).code, 'AUTH_REQUIRED');

    const authRequest = await request(app, '/api/auth/request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'netlify-postgres@example.com' }),
    });
    assert.equal(authRequest.status, 202);
    assert.equal((await authRequest.json()).delivery.status, 'sent');
    assert.equal(app.mailer.delivered.length, 1);

    const magicLink = new URL(app.mailer.delivered[0].payload.link);
    const token = magicLink.hash.match(/^#token=(.+)$/)?.[1];
    assert.ok(token);
    const verifyResponse = await request(app, '/api/auth/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ token: decodeURIComponent(token) }),
    });
    assert.equal(verifyResponse.status, 200);
    const verified = await verifyResponse.json();
    assert.equal(verified.authenticated, true);
    assert.equal(verified.account.email, 'netlify-postgres@example.com');
    assert.equal(verifyResponse.headers.getSetCookie().length, 2);
    const cookies = cookieHeader(verifyResponse);

    const watchResponse = await request(app, '/api/account/watchlist', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: cookies,
        origin,
        'x-csrf-token': verified.csrfToken,
      },
      body: JSON.stringify({ product_id: 'anc-headphones' }),
    });
    assert.equal(watchResponse.status, 201);
    assert.equal((await watchResponse.json()).item.product_id, 'anc-headphones');

    const accountResponse = await request(app, '/api/account', {
      headers: { cookie: cookies },
    });
    assert.equal(accountResponse.status, 200);
    const account = await accountResponse.json();
    assert.equal(account.account.email, 'netlify-postgres@example.com');
    assert.equal(account.usage.watchlist, 1);

    const worker = await app.runWorkerCycle({ now: new Date('2026-08-26T12:00:00.000Z') });
    assert.equal(worker.collectionJobs, 0);
    assert.equal(worker.digestJobs, 0);
    assert.deepEqual(worker.errors, []);
    assert.equal(Array.isArray(worker.jobs), true);
  } finally {
    if (app) await app.db.close();
    await local.stop().catch(() => {});
    restoreEnvironment();
  }
});
