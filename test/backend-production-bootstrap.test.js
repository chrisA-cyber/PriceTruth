import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/server.js';
import { open } from '../src/db.js';
import { seed, seedSubscriptionCatalog } from '../src/seed.js';

describe('production catalog bootstrap', () => {
  it('rejects stray Stripe webhook configuration when live billing is disabled', async () => {
    const config = {
      NODE_ENV: 'production', PUBLIC_BASE_URL: 'https://catalog.launch-operator.com',
      LAUNCH_VERTICALS: 'subscription', ENABLE_ACCOUNTS: '0', ENABLE_LIVE_BILLING: '0',
      ENABLE_DEMO_SEED: '0', DISABLE_WORKER: '1', STRIPE_WEBHOOK_SECRET: 'whsec_strayproduction123456',
    };
    const names = Object.keys(config).concat(['STRIPE_SECRET_KEY']);
    const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    try {
      for (const [name, value] of Object.entries(config)) process.env[name] = value;
      delete process.env.STRIPE_SECRET_KEY;
      await assert.rejects(() => createApp({ dbPath: ':memory:' }), /launch configuration is incomplete/);
    } finally {
      for (const [name, value] of Object.entries(saved)) value === undefined ? delete process.env[name] : process.env[name] = value;
    }
  });

  it('rejects a loopback HTTP canonical origin in production', async () => {
    const config = {
      NODE_ENV: 'production', PUBLIC_BASE_URL: 'http://localhost:4780',
      LAUNCH_VERTICALS: 'subscription', ENABLE_ACCOUNTS: '0', ENABLE_LIVE_BILLING: '0',
      ENABLE_DEMO_SEED: '0', DISABLE_WORKER: '1',
    };
    const saved = Object.fromEntries(Object.keys(config).map((name) => [name, process.env[name]]));
    try {
      for (const [name, value] of Object.entries(config)) process.env[name] = value;
      await assert.rejects(() => createApp({ dbPath: ':memory:' }), /canonicalPublicBaseUrl/);
    } finally {
      for (const [name, value] of Object.entries(saved)) value === undefined ? delete process.env[name] : process.env[name] = value;
    }
  });

  it('fails startup when a declared production catalog has an invalid freshness policy even without billing', async () => {
    const config = {
      NODE_ENV: 'production', PUBLIC_BASE_URL: 'https://catalog.launch-operator.com',
      LAUNCH_VERTICALS: 'subscription', ENABLE_ACCOUNTS: '0', ENABLE_LIVE_BILLING: '0',
      ENABLE_DEMO_SEED: '0', DISABLE_WORKER: '1', SUBSCRIPTION_CATALOG_MAX_AGE_DAYS: 'not-a-number',
    };
    const saved = Object.fromEntries(Object.keys(config).map((name) => [name, process.env[name]]));
    try {
      for (const [name, value] of Object.entries(config)) process.env[name] = value;
      await assert.rejects(() => createApp({ dbPath: ':memory:' }), /subscriptionCatalogFreshness|launchVerticals/);
    } finally {
      for (const [name, value] of Object.entries(saved)) value === undefined ? delete process.env[name] : process.env[name] = value;
    }
  });

  it('rejects a private retail endpoint at runtime while accepting a public endpoint path and query', async () => {
    const config = {
      NODE_ENV: 'production', PUBLIC_BASE_URL: 'https://catalog.launch-operator.com',
      LAUNCH_VERTICALS: 'retail', ENABLE_ACCOUNTS: '0', ENABLE_LIVE_BILLING: '0',
      ENABLE_DEMO_SEED: '0', DISABLE_WORKER: '1', RETAIL_API_KEY: 'retail-secret',
      RETAIL_API_URL: 'https://127.0.0.1/v1/search',
    };
    const saved = Object.fromEntries(Object.keys(config).map((name) => [name, process.env[name]]));
    try {
      for (const [name, value] of Object.entries(config)) process.env[name] = value;
      await assert.rejects(() => createApp({ dbPath: ':memory:' }), /launchVerticals/);

      process.env.RETAIL_API_URL = 'https://feed.launch-operator.com/v1/search?market=us';
      const app = await createApp({ dbPath: ':memory:' });
      await app.db.close();
    } finally {
      for (const [name, value] of Object.entries(saved)) value === undefined ? delete process.env[name] : process.env[name] = value;
    }
  });

  it('repairs provenance on reserved legacy demo rows without duplicating history', async () => {
    const db = open(':memory:');
    try {
      db.upsertProduct({ id: 'lcc-flight', vertical: 'flight', name: 'Legacy demo', advertised_cents: 18900, context: {} });
      db.addPricePoint('lcc-flight', { ts: '2026-08-01T00:00:00.000Z', advertised_cents: 18900, true_cents: 18900 });
      await seed(db);
      const product = db.getProduct('lcc-flight');
      const point = db.getLatestPoint('lcc-flight', { eligibleOnly: false });
      assert.equal(product.evidence.provenance.demo, true);
      assert.equal(point.evidence.provenance.demo, true);
      assert.match(point.source, /^demo:/);
      assert.equal(db.raw.prepare("SELECT COUNT(*) n FROM price_points WHERE product_id='lcc-flight'").get().n, 1);
    } finally { db.close(); }
  });

  it('reports only the production safety gates that are actually enabled', async () => {
    const names = [
      'NODE_ENV', 'PUBLIC_BASE_URL', 'LAUNCH_VERTICALS', 'ENABLE_ACCOUNTS',
      'ENABLE_LIVE_BILLING', 'STRIPE_SECRET_KEY', 'ADMIN_TOKEN', 'REQUIRE_EMAIL',
    ];
    const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    process.env.NODE_ENV = 'production';
    process.env.LAUNCH_VERTICALS = 'subscription';
    process.env.ENABLE_ACCOUNTS = '0';
    process.env.ENABLE_LIVE_BILLING = '0';
    for (const name of ['PUBLIC_BASE_URL', 'STRIPE_SECRET_KEY', 'ADMIN_TOKEN', 'REQUIRE_EMAIL']) delete process.env[name];
    try {
      await assert.rejects(
        () => createApp({ dbPath: ':memory:' }),
        (error) => {
          assert.match(error.message, /canonicalPublicBaseUrl/);
          assert.doesNotMatch(error.message, /stripeSecret|accounts\.|transactionalEmail|legalOperator/);
          return true;
        },
      );
      process.env.PUBLIC_BASE_URL = 'https://deployment.example.invalid';
      await assert.rejects(() => createApp({ dbPath: ':memory:' }), /canonicalPublicBaseUrl/);
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it('publishes only verified subscription catalog rows unless demo seeding is explicitly enabled', async () => {
    const config = {
      NODE_ENV: 'production',
      PUBLIC_BASE_URL: 'https://catalog.launch-operator.com',
      LAUNCH_VERTICALS: 'subscription',
      ENABLE_ACCOUNTS: '0',
      ENABLE_LIVE_BILLING: '0',
      ENABLE_DEMO_SEED: '0',
      DISABLE_WORKER: '1',
    };
    const names = Object.keys(config).concat([
      'STRIPE_SECRET_KEY', 'ADMIN_TOKEN', 'REQUIRE_EMAIL', 'PRICETRUTH_DB',
    ]);
    const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    for (const [name, value] of Object.entries(config)) process.env[name] = value;
    for (const name of ['STRIPE_SECRET_KEY', 'ADMIN_TOKEN', 'REQUIRE_EMAIL', 'PRICETRUTH_DB']) delete process.env[name];
    const app = await createApp({ dbPath: ':memory:' });
    await new Promise((resolve, reject) => {
      app.server.once('error', reject);
      app.server.listen(0, '127.0.0.1', resolve);
    });
    try {
      const products = app.db.listPublicProducts(20);
      assert.equal(products.length, 4);
      assert.equal(products.some((product) => product.id === 'stream-sub' || product.source?.startsWith('demo:')), false);
      for (const product of products) {
        assert.match(product.id, /^catalog-sub-/);
        assert.equal(product.vertical, 'subscription');
        assert.equal(product.source, 'dataset:plans');
        assert.equal(product.evidence.provenance.evidenceType, 'catalog_snapshot');
        assert.equal(product.evidence.provenance.demo, false);
        assert.equal(product.evidence.provenance.alertEligible, true);
        assert.ok(app.db.getLatestPoint(product.id)?.alertEligible);
      }
      assert.equal(await seedSubscriptionCatalog(app.db), 0, 'catalog bootstrap is idempotent at the same as-of version');
      assert.equal(app.db.raw.prepare('SELECT COUNT(*) n FROM price_points').get().n, 4);

      const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/products`);
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.equal(payload.products.length, 4);
      assert.equal(payload.products.every((entry) => entry.demoData === false && entry.dataKind === 'dataset'), true);
      assert.equal(payload.products.every((entry) => entry.score.score === null && entry.score.label === 'no history'), true,
        'one catalog snapshot must not be presented as a comparative deal');

      const target = products[0];
      const first = app.db.getLatestPoint(target.id);
      assert.equal(app.db.addPricePoint(target.id, {
        ts: first.ts, advertised_cents: first.advertised_cents, true_cents: first.true_cents,
        source: first.source, certainty: first.certainty, alertEligible: true,
        evidence: first.evidence, providerKey: first.source,
      }), false, 'fetching the same immutable snapshot is idempotent');
      const sameDay = new Date(Date.parse(first.ts) + 60 * 60_000).toISOString();
      assert.equal(app.db.addPricePoint(target.id, {
        ts: sameDay, advertised_cents: first.advertised_cents + 1, true_cents: first.true_cents + 1,
        source: first.source, certainty: first.certainty, alertEligible: true,
        evidence: first.evidence, providerKey: first.source,
      }), true);
      let detail = await (await fetch(`http://127.0.0.1:${app.server.address().port}/api/products/${target.id}`)).json();
      assert.equal(detail.stats.n, 2);
      assert.equal(detail.stats.distinct_days, 1);
      assert.equal(detail.score.score, null, 'repeat refreshes on one observation day remain unscored');
      const nextDay = new Date(Date.parse(first.ts) + 25 * 60 * 60_000).toISOString();
      app.db.addPricePoint(target.id, {
        ts: nextDay, advertised_cents: first.advertised_cents + 2, true_cents: first.true_cents + 2,
        source: first.source, certainty: first.certainty, alertEligible: true,
        evidence: first.evidence, providerKey: first.source,
      });
      detail = await (await fetch(`http://127.0.0.1:${app.server.address().port}/api/products/${target.id}`)).json();
      assert.ok(Number.isInteger(detail.score.score), 'distinct dated observations can be scored');

      for (let i = 0; i < 3; i += 1) {
        await fetch(`http://127.0.0.1:${app.server.address().port}/api/meta`);
        await fetch(`http://127.0.0.1:${app.server.address().port}/api/ready`);
        await fetch(`http://127.0.0.1:${app.server.address().port}/api/account`);
      }
      await fetch(`http://127.0.0.1:${app.server.address().port}/api/search`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ vertical: 'subscription', q: 'Netflix Standard' }),
      });
      assert.equal(app.db.readinessProbeStats().integrityChecks, 1,
        'normal readiness, account, meta, and search traffic reuses the startup integrity result');
    } finally {
      await new Promise((resolve) => {
        app.server.close(resolve);
        app.server.closeAllConnections?.();
      });
      await app.db.close();
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});
