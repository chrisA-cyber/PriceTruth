import assert from 'node:assert/strict';
import test from 'node:test';

import { invokeNodeHandler } from '../netlify/lib/node-http-bridge.mjs';
import { createApp } from '../src/server.js';

const origin = 'http://localhost:4780';

function request(app, path, init = {}, ip = '198.51.100.40') {
  return invokeNodeHandler(
    new Request(`${origin}${path}`, init),
    { ip, requestId: `durable-limit-${Math.random().toString(16).slice(2)}` },
    app.handle,
  );
}

function result(rate, ok = true) {
  return {
    ok,
    limit: rate.capacity,
    remaining: ok ? Math.max(0, Math.floor(rate.capacity - 1)) : 0,
    resetSec: 30,
    ...(ok ? {} : { retryAfterSec: 17 }),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

test('HTTP security boundaries use durable limits without DB-binding anonymous reads', async () => {
  const managed = [
    'NODE_ENV', 'PUBLIC_BASE_URL', 'EMAIL_TRANSPORT', 'OUTBOX_ENCRYPTION_KEY',
    'ENABLE_ACCOUNTS', 'DISABLE_WORKER', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_SECRET_KEY',
  ];
  const previous = Object.fromEntries(managed.map((name) => [name, process.env[name]]));
  Object.assign(process.env, {
    NODE_ENV: 'test',
    PUBLIC_BASE_URL: origin,
    EMAIL_TRANSPORT: 'memory',
    OUTBOX_ENCRYPTION_KEY: 'durable-limit-http-contract-key-material',
    ENABLE_ACCOUNTS: '1',
    DISABLE_WORKER: '1',
    STRIPE_WEBHOOK_SECRET: 'whsec_durable_limit_contract',
  });
  delete process.env.STRIPE_SECRET_KEY;
  const app = await createApp({ dbPath: ':memory:', startTimers: false });

  try {
    const calls = [];
    app.db.consumeDurableRateLimit = async (bucket, rate) => {
      calls.push({ bucket, rate });
      return result(rate);
    };

    const publicRead = await request(app, '/api/products?limit=1');
    assert.equal(publicRead.status, 200);
    assert.deepEqual(calls, [], 'ordinary anonymous reads must stay off the database limiter');

    app.db.consumeDurableRateLimit = async (bucket, rate) => {
      calls.push({ bucket, rate });
      return result(rate, !bucket.startsWith('auth-email:email:'));
    };
    const authDenied = await request(app, '/api/auth/request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'durable-denied@example.test' }),
    });
    assert.equal(authDenied.status, 429);
    assert.equal(authDenied.headers.get('retry-after'), '17');
    assert.equal(authDenied.headers.get('ratelimit-limit'), '5');
    assert.equal((await authDenied.json()).code, 'RATE_LIMITED');
    assert.equal(app.mailer.delivered.length, 0);
    assert.ok(calls.some(({ bucket }) => bucket === 'auth-email:global'));

    const account = app.db.verifyAccount(app.db.getOrCreateAccount('durable-account@example.test').id);
    const session = app.db.createSession(account.id, { ip: '198.51.100.41' });
    app.db.consumeDurableRateLimit = async (bucket, rate) => result(rate, !bucket.startsWith('principal-write:account:'));
    const accountDenied = await request(app, '/api/account/watchlist', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `pt_session=${session.token}; pt_csrf=${session.csrfToken}`,
        origin,
        'x-csrf-token': session.csrfToken,
      },
      body: JSON.stringify({ product_id: 'anc-headphones' }),
    }, '198.51.100.41');
    assert.equal(accountDenied.status, 429);
    assert.equal((await accountDenied.json()).code, 'RATE_LIMITED');
    assert.equal(app.db.listWatchlist(account.id).length, 0);

    app.db.consumeDurableRateLimit = async (bucket, rate) => result(rate, !bucket.startsWith('webhook-preauth:email:'));
    const webhookDenied = await request(app, '/api/email/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }, '198.51.100.42');
    assert.equal(webhookDenied.status, 503);
    assert.equal(webhookDenied.headers.get('retry-after'), '17');
    assert.match((await webhookDenied.json()).error, /receiver is busy/);

    const { mockCompletedEvent, signPayload } = await import('../src/billing.js');
    const event = mockCompletedEvent({
      planId: 'premium', email: 'durable-webhook@example.test', sessionId: 'cs_durable_webhook',
    });
    const rawEvent = JSON.stringify(event);
    const webhookCalls = [];
    app.db.consumeDurableRateLimit = async (bucket, rate) => {
      webhookCalls.push(bucket);
      return result(rate, bucket !== 'webhook-budget:billing');
    };
    const budgetDenied = await request(app, '/api/billing/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': signPayload(rawEvent, process.env.STRIPE_WEBHOOK_SECRET),
      },
      body: rawEvent,
    }, '198.51.100.44');
    assert.equal(budgetDenied.status, 503);
    assert.match((await budgetDenied.json()).error, /processing is busy/);
    assert.deepEqual(webhookCalls, [
      'webhook-preauth:billing:198.51.100.44',
      'webhook-budget:billing',
    ]);

    const logs = [];
    const originalError = console.error;
    console.error = (...args) => logs.push(args.join(' '));
    try {
      app.db.consumeDurableRateLimit = async () => { throw new Error('database secret should not be logged'); };
      const unavailable = await request(app, '/api/auth/request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'private-limit-failure@example.test' }),
      }, '198.51.100.43');
      assert.equal(unavailable.status, 503);
      const unavailableBody = await unavailable.json();
      assert.equal(unavailableBody.code, 'RATE_LIMIT_UNAVAILABLE');
      assert.match(unavailableBody.error, /protection is temporarily unavailable/);
      assert.equal(app.mailer.delivered.length, 0);
    } finally {
      console.error = originalError;
    }
    assert.ok(logs.some((line) => line.includes('[durable rate limit]')));
    assert.ok(logs.every((line) => !line.includes('private-limit-failure') && !line.includes('database secret')));
  } finally {
    app.db.close();
    for (const name of managed) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});
