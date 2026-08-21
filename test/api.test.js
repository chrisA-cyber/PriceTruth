'use strict';

// End-to-end HTTP tests against the real server: in-memory SQLite, ephemeral
// ports, global fetch. Each describe block builds its own app instance so the
// per-IP rate-limit budgets (GET ~120 burst, POST ~20 burst) never bleed
// between suites — the final suite deliberately exhausts one.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');

const { createApp } = require('../src/server');

// The 403 test requires admin minting to be disabled regardless of shell env.
delete process.env.ADMIN_TOKEN;

const INDEX_HTML = path.join(__dirname, '..', 'public', 'index.html');

const VEGAS_CONTEXT = { market: 'las_vegas', nights: 3, resortFee_cents: 4500, tax_cents: 3800, parking_cents: 1500 };

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
    assert.equal(typeof meta.partners.booking, 'string');
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

  it('GET /api/products returns the 5 seeded products with reports and scores', async () => {
    const res = await fetch(`${app.base}/api/products`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.demoData, true);
    assert.equal(body.products.length, 5);
    const ids = body.products.map((p) => p.product.id).sort();
    assert.deepEqual(ids, ['anc-headphones', 'arena-ticket', 'lcc-flight', 'stream-sub', 'vegas-hotel']);
    for (const p of body.products) {
      assert.equal(typeof p.report.truePrice.amount_cents, 'number');
      assert.ok(p.stats, `${p.product.id} should have history stats`);
      assert.ok(Number.isInteger(p.score.score) && p.score.score >= 0 && p.score.score <= 100);
      assert.equal(typeof p.score.label, 'string');
    }
  });

  it('GET /api/products/vegas-hotel includes history and stats; days=90 has more points', async () => {
    const res30 = await fetch(`${app.base}/api/products/vegas-hotel?days=30`);
    assert.equal(res30.status, 200);
    const p30 = await res30.json();
    assert.equal(p30.product.id, 'vegas-hotel');
    assert.ok(Array.isArray(p30.history) && p30.history.length > 0);
    assert.ok(p30.stats && p30.stats.n > 0 && p30.stats.low_cents <= p30.stats.high_cents);
    assert.equal(p30.stats.days, 30);
    assert.equal(p30.demoData, true);
    const point = p30.history[0];
    assert.ok('ts' in point && 'advertised_cents' in point && 'true_cents' in point);

    const res90 = await fetch(`${app.base}/api/products/vegas-hotel?days=90`);
    const p90 = await res90.json();
    assert.equal(p90.stats.days, 90);
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

    const key = app.db.createApiKey('track-test', 'starter');
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

    // Outside the 0.25x–4x plausibility band → 422, nothing stored.
    const poison = await postJson(app.base, '/api/v1/track',
      { product_id: 'anc-headphones', advertised_cents: 1 }, { 'x-api-key': key });
    assert.equal(poison.status, 422);
    const afterPoison = await fetch(`${app.base}/api/history/anc-headphones?days=90`);
    assert.equal((await afterPoison.json()).points.length, afterHist.points.length);
  });
});

describe('alerts paywall and admin', () => {
  let app;
  before(async () => { app = await startApp(); });
  after(async () => { await stopApp(app); });

  const alertBody = (extra = {}) => ({
    email: 'buyer@example.com', product_id: 'vegas-hotel', threshold_cents: 30000, ...extra,
  });

  it('first alert is free (201), second hits the 402 paywall with an upgrade offer', async () => {
    const first = await postJson(app.base, '/api/alerts', alertBody());
    assert.equal(first.status, 201);
    assert.equal((await first.json()).created, true);

    const second = await postJson(app.base, '/api/alerts', alertBody({ product_id: 'lcc-flight' }));
    assert.equal(second.status, 402);
    const body = await second.json();
    assert.ok(body.error);
    assert.equal(body.upgrade.plan, 'premium');
    assert.ok(body.upgrade.price);
  });

  it('premium: true lifts the limit for the same email', async () => {
    const res = await postJson(app.base, '/api/alerts', alertBody({ product_id: 'lcc-flight', premium: true }));
    assert.equal(res.status, 201);
    assert.equal((await res.json()).created, true);
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
  before(async () => { app = await startApp(); });
  after(async () => { await stopApp(app); });

  const go = (partner, target) => fetch(`${app.base}/go/${partner}?target=${encodeURIComponent(target)}`);

  it('allowed https target renders the disclosure interstitial', async () => {
    const res = await go('booking', 'https://booking.com/hotel/meridian');
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('Affiliate disclosure'));
    assert.ok(html.includes('rel="noopener nofollow sponsored"'));
    assert.ok(html.includes('aid=pricetruth-demo')); // affiliate tag appended
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
