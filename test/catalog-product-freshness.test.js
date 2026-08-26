import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/server.js';
import { seedSubscriptionCatalog } from '../src/seed.js';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

async function close(server) {
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  });
}

describe('catalog product response freshness', () => {
  it('recomputes stale provenance at response time and suppresses expired comparison stats', async () => {
    const realNow = Date.now;
    const savedMaxAge = process.env.SUBSCRIPTION_CATALOG_MAX_AGE_DAYS;
    process.env.SUBSCRIPTION_CATALOG_MAX_AGE_DAYS = '30';
    Date.now = () => Date.parse('2026-08-26T12:00:00.000Z');
    const app = createApp({ dbPath: ':memory:' });
    seedSubscriptionCatalog(app.db);
    const base = await listen(app.server);
    try {
      const freshResponse = await fetch(`${base}/api/products/catalog-sub-netflix-standard?days=30`);
      assert.equal(freshResponse.status, 200);
      const fresh = await freshResponse.json();
      assert.equal(fresh.provenance.evidence.provenance.stale, false);

      Date.now = () => Date.parse('2026-10-01T00:00:01.000Z');
      const staleResponse = await fetch(`${base}/api/products/catalog-sub-netflix-standard?days=90`);
      assert.equal(staleResponse.status, 200);
      const stale = await staleResponse.json();
      const provenance = stale.provenance.evidence.provenance;
      assert.equal(provenance.stale, true);
      assert.equal(provenance.alertEligible, false);
      assert.ok(provenance.ageSeconds > provenance.maxAgeSeconds);
      assert.match(provenance.freshThrough, /^2026-09-/);
      assert.equal(stale.alertEligible, false);
      assert.equal(stale.stats, null, 'expired catalog points must not drive a current deal score');
      assert.equal(stale.score.score, null);
      assert.ok(stale.history.length > 0);
      assert.equal(stale.history.every((point) => point.evidence.provenance.stale === true), true);
    } finally {
      Date.now = realNow;
      if (savedMaxAge === undefined) delete process.env.SUBSCRIPTION_CATALOG_MAX_AGE_DAYS;
      else process.env.SUBSCRIPTION_CATALOG_MAX_AGE_DAYS = savedMaxAge;
      await close(app.server);
      app.db.close();
    }
  });

  it('fails every public and paid product surface closed after a launched catalog expires', async () => {
    const realNow = Date.now;
    const names = [
      'NODE_ENV', 'PUBLIC_BASE_URL', 'LAUNCH_VERTICALS', 'ENABLE_ACCOUNTS',
      'ENABLE_LIVE_BILLING', 'ENABLE_DEMO_SEED', 'DISABLE_WORKER',
      'SUBSCRIPTION_CATALOG_MAX_AGE_DAYS', 'STRIPE_SECRET_KEY',
    ];
    const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    Object.assign(process.env, {
      NODE_ENV: 'production', PUBLIC_BASE_URL: 'https://catalog.launch-operator.com',
      LAUNCH_VERTICALS: 'subscription', ENABLE_ACCOUNTS: '0', ENABLE_LIVE_BILLING: '0',
      ENABLE_DEMO_SEED: '0', DISABLE_WORKER: '1', SUBSCRIPTION_CATALOG_MAX_AGE_DAYS: '30',
    });
    delete process.env.STRIPE_SECRET_KEY;
    Date.now = () => Date.parse('2026-08-26T12:00:00.000Z');
    const app = createApp({ dbPath: ':memory:' });
    const base = await listen(app.server);
    try {
      const key = app.db.createApiKey('catalog-runtime-gate', 'starter');
      assert.equal((await fetch(`${base}/api/v1/products/catalog-sub-netflix-standard`, { headers: { 'x-api-key': key } })).status, 200);

      Date.now = () => Date.parse('2026-10-01T00:00:01.000Z');
      const list = await fetch(`${base}/api/products`);
      assert.equal(list.status, 200);
      assert.deepEqual(await list.json(), { products: [], pagination: { limit: 20, offset: 0, total: 0, nextOffset: null } });
      assert.equal((await fetch(`${base}/api/products/catalog-sub-netflix-standard`)).status, 503);
      const paid = await fetch(`${base}/api/v1/products/catalog-sub-netflix-standard`, { headers: { 'x-api-key': key } });
      assert.equal(paid.status, 503);
      assert.equal((await paid.json()).code, 'VERTICAL_UNAVAILABLE');
    } finally {
      Date.now = realNow;
      await close(app.server);
      app.db.close();
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
    }
  });
});
