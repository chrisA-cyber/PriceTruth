// End-to-end HTTP tests against the real server: in-memory SQLite, ephemeral
// ports, global fetch. Each describe block builds its own app instance so the
// per-IP rate-limit budgets (GET ~120 burst, POST ~20 burst) never bleed
// between suites — the final suite deliberately exhausts one.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';

import { createApp } from '../src/server.js';

// The 403 test requires admin minting to be disabled regardless of shell env.
delete process.env.ADMIN_TOKEN;

const INDEX_HTML = path.join(import.meta.dirname, '..', 'public', 'index.html');

const VEGAS_CONTEXT = { market: 'las_vegas', nights: 3, resortFee_cents: 4500, tax_cents: 3800, parking_cents: 1500, mandatoryFeesIncluded: false, taxesIncluded: false, priceBasis: 'pre_rule', asOf: '2024-12-01', feeEvidence: 'Historical test fixture with mandatory lodging fees listed separately before the FTC rule.' };

function startApp() {
  const { server, db } = createApp({ dbPath: ':memory:' });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, db, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

async function stopApp(app) {
  if (!app) return;
  await new Promise((resolve) => {
    app.server.close(resolve);
    app.server.closeAllConnections(); // drop keep-alive sockets so close() returns
  });
  app.db.close();
}

function postJson(base, route, body, headers = {}) {
  return fetch(base + route, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

// fetch() normalizes /../ out of URLs before sending; use a raw client request
// to put the literal traversal path on the wire.
function rawGet(base, rawPath) {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: hostname, port, path: rawPath, method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('core API', () => {
  let app;
  before(async () => { app = await startApp(); });
  after(async () => { await stopApp(app); });

  it('GET /api/health reports ok and a version', async () => {
    const res = await fetch(`${app.base}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.version, 'string');
  });

  it('GET /api/meta lists 5 verticals and the option maps', async () => {
    const res = await fetch(`${app.base}/api/meta`);
    assert.equal(res.status, 200);
    const meta = await res.json();
    assert.equal(meta.name, 'PriceTruth');
    assert.equal(meta.currency, 'USD');
    assert.equal(meta.demoData, true);
    assert.equal(meta.verticals.length, 5);
    assert.deepEqual(meta.verticals, ['hotel', 'flight', 'ticket', 'subscription', 'retail']);
    // Each option map is {id: label} ready for dropdowns.
    assert.equal(typeof meta.options.hotelMarkets.las_vegas, 'string');
    assert.equal(typeof meta.options.flightCarriers.typical_lcc, 'string');
    assert.equal(typeof meta.options.ticketPlatforms.ticketmaster, 'string');
    assert.equal(typeof meta.options.subscriptionPatterns.streaming, 'string');
    assert.deepEqual(meta.partners, {}, 'unapproved affiliate relationships stay off the public surface');
    assert.equal(meta.subscriptionCatalog.freshness.snapshot, meta.subscriptionCatalog.snapshot);
    assert.equal(meta.subscriptionCatalog.freshness.status, meta.providers.subscription.freshness.status);
    assert.equal(typeof meta.subscriptionCatalog.freshness.maxAgeDays, 'number');
    assert.doesNotMatch(JSON.stringify(meta.subscriptionCatalog.freshness), /secret|token|password|sourceUrl/i);
  });

  it('POST /api/analyze happy path returns the report', async () => {
    const res = await postJson(app.base, '/api/analyze', {
      vertical: 'hotel', advertised_cents: 21900, context: VEGAS_CONTEXT,
    });
    assert.equal(res.status, 200);
    const report = await res.json();
    assert.equal(report.truePrice.amount_cents, 31700);
    assert.equal(report.advertised.amount_cents, 21900);
    assert.ok(Array.isArray(report.lineItems) && report.lineItems.length > 0);
  });

  it('POST /api/analyze 400s on bad input', async () => {
    const badVertical = await postJson(app.base, '/api/analyze', { vertical: 'yacht', advertised_cents: 100 });
    assert.equal(badVertical.status, 400);
    assert.ok((await badVertical.json()).error);

    const missingCents = await postJson(app.base, '/api/analyze', { vertical: 'hotel' });
    assert.equal(missingCents.status, 400);
    assert.match((await missingCents.json()).error, /advertised_cents/);

    const arrayContext = await postJson(app.base, '/api/analyze', { vertical: 'hotel', advertised_cents: 100, context: [1, 2] });
    assert.equal(arrayContext.status, 400);
    assert.match((await arrayContext.json()).error, /context/);

    const hugeContext = await postJson(app.base, '/api/analyze', {
      vertical: 'hotel', advertised_cents: 100, context: { pad: 'x'.repeat(5000) },
    });
    assert.equal(hugeContext.status, 400);
    assert.match((await hugeContext.json()).error, /context too large/);
  });

  it('GET /api/products returns seeded products without treating modeled history as eligible stats', async () => {
    const res = await fetch(`${app.base}/api/products`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(Object.hasOwn(body, 'demoData'), false);
    assert.equal(body.products.length, 5);
    const ids = body.products.map((p) => p.product.id).sort();
    assert.deepEqual(ids, ['anc-headphones', 'arena-ticket', 'lcc-flight', 'stream-sub', 'vegas-hotel']);
    for (const p of body.products) {
      assert.equal(typeof p.report.truePrice.amount_cents, 'number');
      assert.equal(p.stats, null);
      assert.equal(p.score.score, null);
      assert.equal(p.demoData, true);
    }
  });

  it('GET /api/products/vegas-hotel exposes labeled raw history but excludes it from eligible stats', async () => {
    const res30 = await fetch(`${app.base}/api/products/vegas-hotel?days=30`);
    assert.equal(res30.status, 200);
    const p30 = await res30.json();
    assert.equal(p30.product.id, 'vegas-hotel');
    assert.ok(Array.isArray(p30.history) && p30.history.length > 0);
    assert.equal(p30.stats, null);
    assert.equal(p30.demoData, true);
    const point = p30.history[0];
    assert.ok('ts' in point && 'advertised_cents' in point && 'true_cents' in point);

    const res90 = await fetch(`${app.base}/api/products/vegas-hotel?days=90`);
    const p90 = await res90.json();
    assert.equal(p90.stats, null);
    assert.ok(p90.history.length > p30.history.length, `expected 90d (${p90.history.length}) > 30d (${p30.history.length})`);
  });

  it('GET unknown product 404s', async () => {
    const res = await fetch(`${app.base}/api/products/no-such-thing`);
    assert.equal(res.status, 404);
    assert.ok((await res.json()).error);
  });

  it('POST /api/v1/track requires a key, adds a plausible point, rejects poison', async () => {
    const beforeRes = await fetch(`${app.base}/api/history/anc-headphones?days=90`);
    const beforeHist = await beforeRes.json();

    // Anonymous tracking is not a thing (history-poisoning guard).
    const anon = await postJson(app.base, '/api/v1/track', { product_id: 'anc-headphones', advertised_cents: 25900 });
    assert.equal(anon.status, 401);

    const key = app.db.createApiKey('track-test', 'starter', { canWriteHistory: true });
    const res = await postJson(app.base, '/api/v1/track',
      { product_id: 'anc-headphones', advertised_cents: 25900 }, { 'x-api-key': key });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.tracked, true);
    assert.equal(body.true_cents, 25900); // retail with empty context: true == advertised
    assert.ok(body.usage.used_today >= 1);

    const afterRes = await fetch(`${app.base}/api/history/anc-headphones?days=90`);
    const afterHist = await afterRes.json();
    assert.equal(afterHist.points.length, beforeHist.points.length + 1);

    // The first ingestion freezes the original $299 baseline. A 4x edge
    // observation is valid, but it must not become the baseline for another
    // 4x step.
    const edge = await postJson(app.base, '/api/v1/track',
      { product_id: 'anc-headphones', advertised_cents: 119600 }, { 'x-api-key': key });
    assert.equal(edge.status, 201);
    const ratchet = await postJson(app.base, '/api/v1/track',
      { product_id: 'anc-headphones', advertised_cents: 478400 }, { 'x-api-key': key });
    assert.equal(ratchet.status, 422);
    assert.equal(app.db.getPublicProduct('anc-headphones').evidence.ingestionBaseline_cents, 29900);

    // Outside the 0.25x–4x plausibility band → 422, nothing stored.
    const poison = await postJson(app.base, '/api/v1/track',
      { product_id: 'anc-headphones', advertised_cents: 1 }, { 'x-api-key': key });
    assert.equal(poison.status, 422);
    const afterPoison = await fetch(`${app.base}/api/history/anc-headphones?days=90`);
    assert.equal((await afterPoison.json()).points.length, afterHist.points.length + 1);
  });
});

describe('alerts paywall and admin', () => {
  let app;
  before(async () => {
    app = await startApp();
    for (const id of ['vegas-hotel', 'lcc-flight']) {
      const product = app.db.getProduct(id);
      app.db.upsertProduct({
        id: product.id, vertical: product.vertical, name: product.name, url: product.url,
        advertised_cents: product.advertised_cents, context: product.context, source: product.source,
        sourceLabel: product.source_label, certainty: product.certainty, fetchedAt: product.fetched_at,
        evidence: { ...product.evidence, refreshable: true, providerIdentity: `test:${id}`, originalQuery: product.name, provenance: { ...(product.evidence?.provenance || {}), alertEligible: true } },
      });
    }
  });
  after(async () => { await stopApp(app); });

  const alertBody = (extra = {}) => ({
    email: 'buyer@example.com', product_id: 'vegas-hotel', threshold_cents: 30000, ...extra,
  });

  it('first legacy alert requests opt-in and replay is generic without mutating quota', async () => {
    const first = await postJson(app.base, '/api/alerts', alertBody());
    assert.equal(first.status, 201);
    assert.equal((await first.json()).created, true);

    const second = await postJson(app.base, '/api/alerts', alertBody({ product_id: 'lcc-flight' }));
    assert.equal(second.status, 202);
    const body = await second.json();
    assert.equal(body.accepted, true);
    assert.equal(body.created, false);
    assert.equal(app.db.countAlertsForEmail('buyer@example.com'), 1);
  });

  it('a client-supplied premium flag does NOT lift the limit (entitlement is server-side)', async () => {
    // The old demo bypass is gone: only a real completed checkout grants premium.
    const res = await postJson(app.base, '/api/alerts', alertBody({ product_id: 'lcc-flight', premium: true }));
    assert.equal(res.status, 202);
  });

  it('a real premium purchase (mock checkout) lifts the alert limit for that email', async () => {
    const email = 'premium-buyer@example.com';
    // Complete a simulated premium checkout for this email.
    await fetch(`${app.base}/billing/mock-checkout?plan=premium&email=${encodeURIComponent(email)}`, { redirect: 'manual' });
    const first = await postJson(app.base, '/api/alerts', alertBody({ email, product_id: 'vegas-hotel' }));
    const second = await postJson(app.base, '/api/alerts', alertBody({ email, product_id: 'lcc-flight' }));
    assert.equal(first.status, 201);
    assert.equal((await first.json()).plan, 'premium');
    assert.equal(second.status, 202);
    assert.equal((await second.json()).created, false);
  });

  it('premium accounts are capped at 20 alerts, then 402 with the premium message', async () => {
    const email = 'cap-test@example.com';
    // Seed the account + exactly 20 alerts directly, so the per-IP write rate
    // limit (20 burst) does not interfere with exercising the alert cap.
    const account = app.db.upsertAccount({ email, plan: 'premium' });
    app.db.upsertEntitlement({ accountId: account.id, product: 'premium', status: 'active', sourceRef: 'sub_cap_test', eventCreated: 1 });
    app.db.syncAccountPlan(account.id);
    for (let i = 0; i < 20; i++) app.db.createAlert({ email, productId: 'vegas-hotel', threshold_cents: 30000 + i });
    const res = await postJson(app.base, '/api/alerts', alertBody({ email, product_id: 'lcc-flight' }));
    assert.equal(res.status, 402);
    const body = await res.json();
    assert.match(body.error, /premium accounts are limited to 20/);
    assert.equal(body.upgrade, null); // premium users get no upsell
  });

  it('invalid email 400s', async () => {
    const res = await postJson(app.base, '/api/alerts', alertBody({ email: 'not-an-email' }));
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /email/);
  });

  it('unknown product 404s', async () => {
    const res = await postJson(app.base, '/api/alerts', alertBody({ email: 'someone-else@example.com', product_id: 'ghost-product' }));
    assert.equal(res.status, 404);
  });

  it('POST /api/admin/keys is 403 when ADMIN_TOKEN is unset', async () => {
    const res = await postJson(app.base, '/api/admin/keys', { label: 'test', tier: 'starter' }, { 'X-Admin-Token': 'anything' });
    assert.equal(res.status, 403);
    assert.ok((await res.json()).error);
  });
});

describe('B2B API keys, metering, and quota', () => {
  let app;
  let rawKey;
  before(async () => {
    app = await startApp();
    rawKey = app.db.createApiKey('t', 'starter');
  });
  after(async () => { await stopApp(app); });

  const analyzeBody = { vertical: 'subscription', advertised_cents: 999, context: { introMonths: 6, renewal_cents: 1999 } };

  it('401 without an API key', async () => {
    const res = await fetch(`${app.base}/api/v1/usage`);
    assert.equal(res.status, 401);
    assert.match((await res.json()).error, /X-API-Key/);
  });

  it('POST /api/v1/analyze works and usage.used_today increments', async () => {
    const first = await postJson(app.base, '/api/v1/analyze', analyzeBody, { 'X-API-Key': rawKey });
    assert.equal(first.status, 200);
    const b1 = await first.json();
    assert.equal(b1.truePrice.amount_cents, 17988);
    assert.deepEqual(b1.usage, { used_today: 1, daily_limit: 100, tier: 'starter' });

    const second = await postJson(app.base, '/api/v1/analyze', analyzeBody, { 'X-API-Key': rawKey });
    assert.equal(second.status, 200);
    assert.equal((await second.json()).usage.used_today, 2);
  });

  it('GET /api/v1/usage reports the meter', async () => {
    const res = await fetch(`${app.base}/api/v1/usage`, { headers: { 'X-API-Key': rawKey } });
    assert.equal(res.status, 200);
    const { usage } = await res.json();
    assert.equal(usage.used_today, 3); // usage calls are metered too
    assert.equal(usage.daily_limit, 100);
    assert.equal(usage.tier, 'starter');
  });

  it('GET /api/v1/products/:id is flagged as demo data', async () => {
    const res = await fetch(`${app.base}/api/v1/products/vegas-hotel`, { headers: { 'X-API-Key': rawKey } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.demoData, true);
    assert.ok(body.history.length > 0);
    assert.ok(body.usage);
  });

  it('429 once the daily quota is exceeded', async () => {
    const keyRow = app.db.findApiKey(rawKey);
    app.db.raw.prepare('UPDATE api_usage SET count = 200 WHERE key_id = ?').run(keyRow.id);
    const res = await postJson(app.base, '/api/v1/analyze', analyzeBody, { 'X-API-Key': rawKey });
    assert.equal(res.status, 429);
    assert.match((await res.json()).error, /daily quota/);
  });
});

describe('affiliate interstitial and static serving', () => {
  let app;
  const affiliateNames = ['ENABLE_AFFILIATE_LINKS', 'AFFILIATE_RELATIONSHIPS_APPROVED', 'AFFILIATE_DISCLOSURE_URL', 'AFFILIATE_TAG_BOOKING'];
  const savedAffiliate = Object.fromEntries(affiliateNames.map((name) => [name, process.env[name]]));
  before(async () => {
    process.env.ENABLE_AFFILIATE_LINKS = '1';
    process.env.AFFILIATE_RELATIONSHIPS_APPROVED = '1';
    process.env.AFFILIATE_DISCLOSURE_URL = 'https://pricetruth.com/affiliate-disclosure';
    process.env.AFFILIATE_TAG_BOOKING = 'approved-partner-123';
    app = await startApp();
  });
  after(async () => {
    await stopApp(app);
    for (const name of affiliateNames) {
      if (savedAffiliate[name] === undefined) delete process.env[name];
      else process.env[name] = savedAffiliate[name];
    }
  });

  const go = (partner, target) => fetch(`${app.base}/go/${partner}?target=${encodeURIComponent(target)}`);

  it('allowed https target renders the disclosure interstitial', async () => {
    const res = await go('booking', 'https://booking.com/hotel/meridian');
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('Affiliate disclosure'));
    assert.ok(html.includes('rel="noopener nofollow sponsored"'));
    assert.ok(html.includes('aid=approved-partner-123'));
    assert.ok(html.includes('https://pricetruth.com/affiliate-disclosure'));
    assert.ok(!html.includes('pricetruth-demo'));
  });

  it('fails closed when relationship approval is disabled', async () => {
    delete process.env.AFFILIATE_RELATIONSHIPS_APPROVED;
    try {
      const res = await go('booking', 'https://booking.com/hotel/meridian');
      assert.equal(res.status, 404);
      await res.arrayBuffer();
    } finally {
      process.env.AFFILIATE_RELATIONSHIPS_APPROVED = '1';
    }
  });

  it('subdomain www.booking.com is allowed', async () => {
    const res = await go('booking', 'https://www.booking.com/hotel/meridian');
    assert.equal(res.status, 200);
    assert.ok((await res.text()).includes('Affiliate disclosure'));
  });

  it('hostname not on the partner allowlist is 400', async () => {
    const res = await go('booking', 'https://evil.com/phish');
    assert.equal(res.status, 400);
    await res.arrayBuffer();
  });

  it('http:// targets are 400 (https only)', async () => {
    const res = await go('booking', 'http://booking.com/hotel');
    assert.equal(res.status, 400);
    await res.arrayBuffer();
  });

  it('hostname suffix trick evilbooking.com is 400', async () => {
    const res = await go('booking', 'https://evilbooking.com/hotel');
    assert.equal(res.status, 400);
    await res.arrayBuffer();
  });

  it('unknown partner is 404', async () => {
    const res = await go('not-a-partner', 'https://booking.com/hotel');
    assert.equal(res.status, 404);
    await res.arrayBuffer();
  });

  it('prototype-key partner is 404, not a 500', async () => {
    for (const k of ['__proto__', 'constructor', 'hasOwnProperty', 'valueOf']) {
      const res = await go(k, 'https://booking.com/hotel');
      assert.equal(res.status, 404, `/go/${k} should 404`);
      await res.arrayBuffer();
    }
  });

  it('prototype-key context on /api/analyze falls back cleanly (no 500/leak)', async () => {
    const res = await postJson(app.base, '/api/analyze',
      { vertical: 'hotel', advertised_cents: 21900, context: { market: '__proto__' } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.truePrice.unit, 'per_night');
  });

  // Frontend may not be built yet; check fs.existsSync and skip gracefully.
  it('GET / serves index.html when the frontend is present', { skip: !fs.existsSync(INDEX_HTML) && 'public/index.html not present yet' }, async () => {
    const res = await fetch(`${app.base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.ok((await res.text()).length > 0);
  });

  it('path traversal is blocked', async () => {
    // Literal dot-dot path straight over the socket.
    const raw = await rawGet(app.base, '/../package.json');
    assert.ok([403, 404].includes(raw.status), `expected 403/404, got ${raw.status}`);
    assert.ok(!raw.body.includes('"name": "pricetruth"'), 'package.json must not leak');

    // Encoded traversal survives fetch URL normalization.
    const encoded = await fetch(`${app.base}/..%2Fpackage.json`);
    assert.ok([403, 404].includes(encoded.status), `expected 403/404, got ${encoded.status}`);
    assert.ok(!(await encoded.text()).includes('"name": "pricetruth"'), 'package.json must not leak');
  });
});

describe('search, billing, and admin metrics', () => {
  let app;
  const savedWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  before(async () => {
    delete process.env.STRIPE_SECRET_KEY;         // stay in mock billing mode
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_it';
    app = await startApp();
  });
  after(async () => {
    await stopApp(app);
    if (savedWebhookSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
    else process.env.STRIPE_WEBHOOK_SECRET = savedWebhookSecret;
  });

  it('POST /api/search fails closed when no verified source is configured', async () => {
    const r1 = await postJson(app.base, '/api/search', { vertical: 'retail', q: 'sony wh-1000xm5' });
    assert.equal(r1.status, 422);
    const d1 = await r1.json();
    assert.equal(d1.code, 'PRICE_SOURCE_UNAVAILABLE');
    assert.equal('listing' in d1, false);
    assert.equal('report' in d1, false);
    assert.doesNotMatch(JSON.stringify(d1), /RETAIL_API_URL|estimated_cents|advertised_cents/);
  });

  it('never enables admin minting with a weak configured token', async () => {
    process.env.ADMIN_TOKEN = 'a';
    try {
      const response = await postJson(app.base, '/api/admin/keys', { label: 'attacker', tier: 'pro' }, { 'X-Admin-Token': 'a' });
      assert.equal(response.status, 403);
      const ready = await fetch(`${app.base}/api/ready`);
      assert.equal(ready.status, 503);
      assert.equal((await ready.json()).productionSafety.adminToken, false);
    } finally {
      delete process.env.ADMIN_TOKEN;
    }
  });

  it('labels a verified subscription catalog snapshot as dataset, not demo data', async () => {
    const response = await postJson(app.base, '/api/search', { vertical: 'subscription', q: 'netflix' });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.live, false);
    assert.equal(body.demoData, false);
    assert.equal(body.dataKind, 'dataset');
    assert.equal(body.listing.provenance.evidenceType, 'catalog_snapshot');
    assert.equal(body.listing.provenance.asOf, '2026-08-25T00:00:00.000Z');
    assert.equal(body.listing.certainty, 'catalog');
    assert.equal(body.report.lineItems[0].certainty, 'catalog');
    assert.match(body.report.lineItems[0].label, /catalog/i);
  });

  it('never fabricates a search result when verified data is unavailable or unmatched', async () => {
    const unavailable = [
      ['hotel', 'Las Vegas'], ['flight', 'LAX-LAS'], ['ticket', 'example concert'], ['retail', 'example headphones'],
    ];
    for (const [vertical, q] of unavailable) {
      const response = await postJson(app.base, '/api/search', { vertical, q });
      assert.equal(response.status, 422, vertical);
      const body = await response.json();
      assert.equal(body.code, 'PRICE_SOURCE_UNAVAILABLE', vertical);
      assert.equal('listing' in body, false, vertical);
      assert.equal('report' in body, false, vertical);
    }
    const unmatched = await postJson(app.base, '/api/search', { vertical: 'subscription', q: 'zxqwv-not-a-real-plan' });
    assert.equal(unmatched.status, 404);
    const body = await unmatched.json();
    assert.equal(body.code, 'NO_VERIFIED_RESULT');
    assert.equal('listing' in body, false);
    assert.equal('report' in body, false);
  });

  it('POST /api/search 400s on an unknown vertical', async () => {
    const res = await postJson(app.base, '/api/search', { vertical: 'boats', q: 'yacht' });
    assert.equal(res.status, 400);
  });

  it('POST /api/billing/checkout returns a mock checkout URL', async () => {
    const res = await postJson(app.base, '/api/billing/checkout', { planId: 'api_starter', email: 'dev@x.com' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.mock, true);
    assert.equal(body.mode, 'mock');
    assert.ok(body.url.includes('/billing/mock-checkout'));
  });

  it('mock API checkout mints a key that is claimable exactly once', async () => {
    // Follow the mock-checkout redirect to get the session id.
    const res = await fetch(`${app.base}/billing/mock-checkout?plan=api_starter&email=dev2@x.com`, { redirect: 'manual' });
    assert.equal(res.status, 303);
    const loc = res.headers.get('location');
    const sessionId = new URLSearchParams(loc.split('?')[1]).get('session_id');
    assert.ok(sessionId);

    const claim1 = await fetch(`${app.base}/api/billing/claim?session_id=${sessionId}`);
    assert.equal(claim1.status, 200);
    const key = (await claim1.json()).key;
    assert.match(key, /^pt_starter_/);

    // Second claim is gone (claim-once).
    const claim2 = await fetch(`${app.base}/api/billing/claim?session_id=${sessionId}`);
    assert.equal(claim2.status, 404);
  });

  it('POST /api/billing/webhook verifies signature, applies event, and is idempotent', async () => {
    const { signPayload, mockCompletedEvent } = await import('../src/billing.js');
    const event = mockCompletedEvent({ planId: 'premium', email: 'wh@x.com', sessionId: 'cs_webhook_1' });
    const raw = JSON.stringify(event);
    const sig = signPayload(raw, 'whsec_test_it');

    const send = () => fetch(`${app.base}/api/billing/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': sig },
      body: raw,
    });
    const ok = await send();
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).received, true);

    // Replay: still 200, but revenue is not double-counted (checked via admin).
    const replay = await send();
    assert.equal(replay.status, 200);
  });

  it('POST /api/billing/webhook rejects a tampered body', async () => {
    const { signPayload, mockCompletedEvent } = await import('../src/billing.js');
    const event = mockCompletedEvent({ planId: 'premium', email: 'wh@x.com', sessionId: 'cs_webhook_2' });
    const sig = signPayload(JSON.stringify(event), 'whsec_test_it');
    const tampered = JSON.stringify({ ...event, id: 'evt_swapped' });
    const res = await fetch(`${app.base}/api/billing/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': sig },
      body: tampered,
    });
    assert.equal(res.status, 400);
  });

  it('POST /api/billing/webhook rejects test events in live mode and live events in mock mode', async () => {
    const { signPayload, mockCompletedEvent } = await import('../src/billing.js');
    const baseEvent = mockCompletedEvent({ planId: 'premium', email: 'mode-guard@x.com', sessionId: 'cs_mode_guard' });
    const send = async (event) => {
      const raw = JSON.stringify(event);
      return fetch(`${app.base}/api/billing/webhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'stripe-signature': signPayload(raw, 'whsec_test_it') },
        body: raw,
      });
    };

    const liveEventInMock = await send({
      ...baseEvent,
      id: 'evt_live_in_mock',
      livemode: true,
      data: { object: { ...baseEvent.data.object, livemode: true } },
    });
    assert.equal(liveEventInMock.status, 400);

    const savedEnable = process.env.ENABLE_LIVE_BILLING;
    const savedSecret = process.env.STRIPE_SECRET_KEY;
    process.env.ENABLE_LIVE_BILLING = '1';
    process.env.STRIPE_SECRET_KEY = 'sk_live_12345678901234567890';
    try {
      const testEventInLive = await send({ ...baseEvent, id: 'evt_test_in_live' });
      assert.equal(testEventInLive.status, 400);
      assert.equal(app.db.getAccount('mode-guard@x.com'), null, 'a mode-mismatched event must not create an account or entitlement');
    } finally {
      if (savedEnable === undefined) delete process.env.ENABLE_LIVE_BILLING;
      else process.env.ENABLE_LIVE_BILLING = savedEnable;
      if (savedSecret === undefined) delete process.env.STRIPE_SECRET_KEY;
      else process.env.STRIPE_SECRET_KEY = savedSecret;
    }
  });

  it('GET /api/admin/metrics is 403 without a token, 403 on a same-length wrong token, 200 with the right token', async () => {
    const denied = await fetch(`${app.base}/api/admin/metrics`);
    assert.equal(denied.status, 403);

    const TOKEN = 'Q7pL2vN9xR4mK8sT6wY3cF5hJ1dB0zUaG';
    process.env.ADMIN_TOKEN = TOKEN;
    try {
      // Length-mismatch branch (short token).
      const short = await fetch(`${app.base}/api/admin/metrics`, { headers: { 'x-admin-token': 'nope' } });
      assert.equal(short.status, 403);

      // Same-length WRONG token — the only case that actually exercises the
      // constant-time crypto.timingSafeEqual comparison (not the length pre-check).
      const sameLen = 'X'.repeat(TOKEN.length);
      assert.equal(sameLen.length, TOKEN.length);
      const wrong = await fetch(`${app.base}/api/admin/metrics`, { headers: { 'x-admin-token': sameLen } });
      assert.equal(wrong.status, 403);

      const ok = await fetch(`${app.base}/api/admin/metrics`, { headers: { 'x-admin-token': TOKEN } });
      assert.equal(ok.status, 200);
      const body = await ok.json();
      assert.equal(typeof body.billing.gross_cents, 'number');
      assert.ok(body.usage && typeof body.usage.products === 'number');
      assert.ok(body.providers && typeof body.providers.retail.live === 'boolean');
      // Ledger = $49 api_starter (mock checkout) + $4 premium (webhook). The
      // replayed premium webhook must NOT double-count it to 5700.
      assert.equal(body.billing.gross_cents, 5300);
    } finally {
      delete process.env.ADMIN_TOKEN;
    }
  });

  it('POST /api/admin/keys mints a working key with a valid token and rejects a bad tier', async () => {
    const TOKEN = 'M4nR8vQ2xL7sK9wT5yC3fH6jP1dZ0uBaG';
    process.env.ADMIN_TOKEN = TOKEN;
    try {
      const minted = await postJson(app.base, '/api/admin/keys', { label: 'Acme', tier: 'pro' }, { 'X-Admin-Token': TOKEN });
      assert.equal(minted.status, 201);
      const { key } = await minted.json();
      assert.match(key, /^pt_pro_/);
      // The minted key actually authenticates against the B2B API.
      const used = await postJson(app.base, '/api/v1/analyze',
        { vertical: 'flight', advertised_cents: 5900, context: { carrier: 'spirit' } }, { 'X-API-Key': key });
      assert.equal(used.status, 200);

      // An invalid tier is rejected.
      const bad = await postJson(app.base, '/api/admin/keys', { label: 'Acme', tier: 'enterprise' }, { 'X-Admin-Token': TOKEN });
      assert.equal(bad.status, 400);
    } finally {
      delete process.env.ADMIN_TOKEN;
    }
  });

  it('the webhook route is exempt from the write rate limit (Stripe retries must not 429)', async () => {
    const { signPayload, mockCompletedEvent } = await import('../src/billing.js');
    // Same event id every time — idempotent (200 duplicate), so this only proves
    // the exemption without polluting the ledger. If the webhook were under the
    // write limiter (capacity 20), the 21st POST in this burst would 429.
    const event = mockCompletedEvent({ planId: 'premium', email: 'burst@x.com', sessionId: 'cs_burst' });
    const raw = JSON.stringify(event);
    const sig = signPayload(raw, 'whsec_test_it');
    let sawNon200 = false;
    for (let i = 0; i < 25; i++) {
      const res = await fetch(`${app.base}/api/billing/webhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'stripe-signature': sig },
        body: raw,
      });
      await res.arrayBuffer();
      if (res.status !== 200) { sawNon200 = true; break; }
    }
    assert.equal(sawNon200, false, 'no webhook POST should be rate-limited');
  });
});

describe('rate limiting', () => {
  let app;
  before(async () => { app = await startApp(); }); // fresh instance: full GET budget
  after(async () => { await stopApp(app); });

  it('sustained GET hammering eventually returns 429 with Retry-After', async () => {
    let saw429 = false;
    let requests = 0;
    for (let i = 0; i < 200; i++) {
      const res = await fetch(`${app.base}/api/health`);
      await res.arrayBuffer(); // drain so keep-alive sockets recycle
      requests++;
      if (res.status === 429) {
        saw429 = true;
        assert.ok(Number(res.headers.get('retry-after')) >= 1, 'Retry-After header should be >= 1');
        break;
      }
      assert.equal(res.status, 200, `unexpected status at request ${requests}`);
    }
    assert.ok(saw429, `expected a 429 within ${requests} sequential requests`);
  });
});
