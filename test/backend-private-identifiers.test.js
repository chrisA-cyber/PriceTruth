import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createApp } from '../src/server.js';

async function startApp() {
  const created = await createApp({ dbPath: ':memory:' });
  await new Promise((resolve, reject) => {
    created.server.once('error', reject);
    created.server.listen(0, '127.0.0.1', resolve);
  });
  return { ...created, base: `http://127.0.0.1:${created.server.address().port}` };
}

async function stopApp(app) {
  if (!app) return;
  await new Promise((resolve) => {
    app.server.close(resolve);
    app.server.closeAllConnections();
  });
  app.db.close();
}

function accountCookie(db, email) {
  const account = db.verifyAccount(db.getOrCreateAccount(email).id);
  const session = db.createSession(account.id);
  return {
    account,
    cookie: `pt_session=${encodeURIComponent(session.token)}; pt_csrf=${encodeURIComponent(session.csrfToken)}`,
    csrf: session.csrfToken,
  };
}

async function search(app, auth, q) {
  const response = await fetch(`${app.base}/api/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: auth.cookie, origin: app.base, 'x-csrf-token': auth.csrf },
    body: JSON.stringify({ vertical: 'subscription', q }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

describe('opaque account-private report identifiers', () => {
  let app;
  let saved;

  before(async () => {
    saved = {
      DISABLE_WORKER: process.env.DISABLE_WORKER,
      ENABLE_ACCOUNTS: process.env.ENABLE_ACCOUNTS,
    };
    process.env.DISABLE_WORKER = '1';
    process.env.ENABLE_ACCOUNTS = '1';
    app = await startApp();
  });

  after(async () => {
    await stopApp(app);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('keeps private query text out of ids, report paths, and request logs', async () => {
    const sensitiveQuery = 'Netflix Standard';
    const owner = accountCookie(app.db, 'private-owner@example.test');
    const other = accountCookie(app.db, 'private-other@example.test');

    const first = await search(app, owner, sensitiveQuery);
    const repeat = await search(app, owner, sensitiveQuery);
    const normalizedRepeat = await search(app, owner, '  Netflix\u00a0  Standard  ');
    const isolated = await search(app, other, sensitiveQuery);

    assert.match(first.product_id, /^p-[a-f0-9]{48}$/);
    assert.equal(repeat.product_id, first.product_id, 'the same owner and normalized query get a stable id');
    assert.equal(normalizedRepeat.product_id, first.product_id, 'NFKC and collapsed whitespace reuse the guarded provider identity');
    assert.notEqual(isolated.product_id, first.product_id, 'the owner account scopes the opaque id');
    assert.doesNotMatch(first.product_id, /netflix|standard/i);

    const reportPath = `/p/${first.product_id}`;
    assert.doesNotMatch(reportPath, /netflix|standard/i);
    const lines = [];
    const originalLog = console.log;
    console.log = (...values) => lines.push(values.join(' '));
    try {
      const report = await fetch(app.base + reportPath, { headers: { cookie: owner.cookie } });
      assert.equal(report.status, 200);
    } finally {
      console.log = originalLog;
    }
    assert.ok(lines.some((line) => line.includes(reportPath)), 'the exercised report path should be logged');
    assert.equal(lines.some((line) => /netflix|standard/i.test(line)), false);

    const ownerRead = await fetch(`${app.base}/api/products/${first.product_id}`, { headers: { cookie: owner.cookie } });
    assert.equal(ownerRead.status, 200);
    const otherRead = await fetch(`${app.base}/api/products/${first.product_id}`, { headers: { cookie: other.cookie } });
    assert.equal(otherRead.status, 404);
  });
});

describe('private report identity boundary', () => {
  it('keeps one-time quotes immutable and rejects a changed stable provider identity', async () => {
    const realNow = Date.now;
    const saved = {
      RETAIL_API_URL: process.env.RETAIL_API_URL,
      RETAIL_API_KEY: process.env.RETAIL_API_KEY,
      DISABLE_WORKER: process.env.DISABLE_WORKER,
      ENABLE_ACCOUNTS: process.env.ENABLE_ACCOUNTS,
      PROVIDER_QUERY_CACHE_SECONDS: process.env.PROVIDER_QUERY_CACHE_SECONDS,
    };
    let clock = Date.parse('2026-08-26T12:00:00.000Z');
    Date.now = () => clock;
    const calls = new Map();
    const feed = http.createServer((req, res) => {
      const q = new URL(req.url, 'http://127.0.0.1').searchParams.get('q');
      const count = (calls.get(q) || 0) + 1;
      calls.set(q, count);
      const stable = q === 'Stable headphones';
      const body = {
        name: q,
        price_cents: stable ? 1999 : count === 1 ? 2999 : 2599,
        currency: 'USD', shipping_cents: 0, taxPct: 0,
        ...(stable ? { id: count === 1 ? 'seller-item-a' : 'seller-item-b' } : {}),
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    await new Promise((resolve, reject) => { feed.once('error', reject); feed.listen(0, '127.0.0.1', resolve); });
    process.env.RETAIL_API_URL = `http://127.0.0.1:${feed.address().port}/quote`;
    process.env.RETAIL_API_KEY = 'test-feed-key';
    process.env.DISABLE_WORKER = '1';
    process.env.ENABLE_ACCOUNTS = '1';
    process.env.PROVIDER_QUERY_CACHE_SECONDS = '5';
    const app = await startApp();
    const owner = accountCookie(app.db, 'snapshot-owner@example.test');
    const retailSearch = (q) => fetch(`${app.base}/api/search`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: owner.cookie, origin: app.base, 'x-csrf-token': owner.csrf },
      body: JSON.stringify({ vertical: 'retail', q }),
    });
    try {
      const firstResponse = await retailSearch('Snapshot headphones');
      assert.equal(firstResponse.status, 200);
      const first = await firstResponse.json();
      assert.equal(first.refreshable, false);

      clock += 6000;
      const secondResponse = await retailSearch('Snapshot headphones');
      assert.equal(secondResponse.status, 200);
      const second = await secondResponse.json();
      assert.notEqual(second.product_id, first.product_id, 'different quote dimensions require a new opaque snapshot');
      assert.equal(app.db.getProduct(first.product_id).advertised_cents, 2999, 'the original report must remain immutable');
      assert.equal(app.db.getProduct(second.product_id).advertised_cents, 2599);

      clock += 6000;
      const stableFirstResponse = await retailSearch('Stable headphones');
      assert.equal(stableFirstResponse.status, 200);
      const stableFirst = await stableFirstResponse.json();
      assert.equal(stableFirst.refreshable, true);
      assert.equal(app.db.getProduct(stableFirst.product_id).evidence.providerIdentity, 'seller-item-a');

      clock += 6000;
      const changedIdentity = await retailSearch('Stable headphones');
      assert.equal(changedIdentity.status, 502);
      assert.equal(app.db.getProduct(stableFirst.product_id).evidence.providerIdentity, 'seller-item-a');
      assert.equal(app.db.raw.prepare('SELECT COUNT(*) n FROM price_points WHERE product_id=?').get(stableFirst.product_id).n, 1);
    } finally {
      Date.now = realNow;
      await stopApp(app);
      await new Promise((resolve) => feed.close(resolve));
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
    }
  });
});
