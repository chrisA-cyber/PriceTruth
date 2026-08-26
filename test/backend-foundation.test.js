import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createApp } from '../src/server.js';
import { open } from '../src/db.js';
import { createMailer, verifyDeliveryWebhook } from '../src/email.js';
import { createJobWorker } from '../src/jobs.js';
import * as billing from '../src/billing.js';

async function startApp() {
  const created = createApp({ dbPath: ':memory:' });
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

function json(base, route, { method = 'GET', body, headers = {} } = {}) {
  return fetch(base + route, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: 'manual',
  });
}

function cookieHeader(response) {
  const values = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')];
  return values.filter(Boolean).map((value) => value.split(';')[0]).join('; ');
}

function fragmentToken(value) {
  return new URLSearchParams(new URL(value).hash.slice(1)).get('token');
}

describe('verified passwordless account HTTP lifecycle', () => {
  let app;
  let saved;
  let cookie;
  let csrf;
  const email = 'launch-user@example.com';

  before(async () => {
    saved = {
      EMAIL_TRANSPORT: process.env.EMAIL_TRANSPORT,
      OUTBOX_ENCRYPTION_KEY: process.env.OUTBOX_ENCRYPTION_KEY,
      DISABLE_WORKER: process.env.DISABLE_WORKER,
    };
    process.env.EMAIL_TRANSPORT = 'memory';
    process.env.OUTBOX_ENCRYPTION_KEY = 'test-only-outbox-key-not-a-production-secret';
    process.env.DISABLE_WORKER = '1';
    app = await startApp();
  });

  after(async () => {
    await stopApp(app);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('requests a generic magic link and stores only its hash outside the encrypted outbox', async () => {
    const response = await json(app.base, '/api/auth/request', { method: 'POST', body: { email } });
    assert.equal(response.status, 202);
    const payload = await response.json();
    assert.equal(payload.accepted, true);
    assert.ok(['sent', 'queued'].includes(payload.delivery.status));
    assert.equal(app.mailer.delivered.length, 1);
    const token = fragmentToken(app.mailer.delivered[0].payload.link);
    const stored = app.db.raw.prepare('SELECT token_hash FROM auth_tokens').get().token_hash;
    assert.notEqual(stored, token);
    assert.equal(stored.length, 64);
    const outbox = app.db.raw.prepare('SELECT payload_ciphertext FROM outbox').get();
    assert.ok(!outbox.payload_ciphertext.includes(token));
  });

  it('a newer magic-link request does not invalidate the recipient\'s earlier link', async () => {
    const concurrentEmail = 'concurrent-links@example.com';
    const start = app.mailer.delivered.length;
    const firstRequest = await json(app.base, '/api/auth/request', { method: 'POST', body: { email: concurrentEmail } });
    const secondRequest = await json(app.base, '/api/auth/request', { method: 'POST', body: { email: concurrentEmail } });
    assert.equal(firstRequest.status, 202);
    assert.equal(secondRequest.status, 202);
    const deliveries = app.mailer.delivered.slice(start).filter((item) => item.template === 'magic-link');
    assert.equal(deliveries.length, 2);
    const firstToken = fragmentToken(deliveries[0].payload.link);
    const secondToken = fragmentToken(deliveries[1].payload.link);
    assert.notEqual(firstToken, secondToken);

    const earlierStillWorks = await json(app.base, '/api/auth/verify', { method: 'POST', body: { token: firstToken } });
    assert.equal(earlierStillWorks.status, 200);
    const siblingAfterLogin = await json(app.base, '/api/auth/verify', { method: 'POST', body: { token: secondToken } });
    assert.equal(siblingAfterLogin.status, 400, 'successful sign-in retires sibling links for the account');
  });

  it('keeps auth responses generic while suppressing all later mail after a complaint', async () => {
    const suppressedEmail = 'complained-signin@example.com';
    const start = app.mailer.delivered.length;
    const first = await json(app.base, '/api/auth/request', { method: 'POST', body: { email: suppressedEmail } });
    assert.equal(first.status, 202);
    const delivery = app.mailer.delivered.slice(start).find((item) => item.template === 'magic-link' && item.to === suppressedEmail);
    assert.ok(delivery);
    assert.equal(app.db.updateNotificationByProvider(delivery.id, 'complained'), true);
    const account = app.db.getAccount(suppressedEmail);
    const tokenCount = app.db.raw.prepare('SELECT COUNT(*) n FROM auth_tokens WHERE account_id=?').get(account.id).n;
    const deliveryCount = app.mailer.delivered.length;

    const second = await json(app.base, '/api/auth/request', { method: 'POST', body: { email: suppressedEmail } });
    assert.equal(second.status, 202);
    assert.match((await second.json()).message, /If the address can receive mail/i);
    assert.equal(app.mailer.delivered.length, deliveryCount);
    assert.equal(app.db.raw.prepare('SELECT COUNT(*) n FROM auth_tokens WHERE account_id=?').get(account.id).n, tokenCount);
    assert.ok(app.db.getAccount(suppressedEmail).email_suppressed_at);
  });

  it('rejects login CSRF and non-JSON forms without consuming the sign-in token', async () => {
    const token = fragmentToken(app.mailer.delivered[0].payload.link);
    const crossSite = await json(app.base, '/api/auth/verify', {
      method: 'POST', body: { token },
      headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site', 'content-type': 'text/plain' },
    });
    assert.equal(crossSite.status, 403);
    assert.equal(crossSite.headers.get('set-cookie'), null);

    const nonJson = await json(app.base, '/api/auth/verify', {
      method: 'POST', body: { token }, headers: { origin: app.base, 'content-type': 'text/plain' },
    });
    assert.equal(nonJson.status, 400);
    assert.equal(nonJson.headers.get('set-cookie'), null);
  });

  it('consumes the link once, sets secure session state, and exposes a CSRF token', async () => {
    const token = fragmentToken(app.mailer.delivered[0].payload.link);
    const response = await json(app.base, '/api/auth/verify', { method: 'POST', body: { token } });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.authenticated, true);
    assert.equal(payload.account.emailVerified, true);
    csrf = payload.csrfToken;
    cookie = cookieHeader(response);
    assert.match(cookie, /pt_session=/);
    assert.match(cookie, /pt_csrf=/);

    const replay = await json(app.base, '/api/auth/verify', { method: 'POST', body: { token } });
    assert.equal(replay.status, 400);
  });

  it('returns account/session state without exposing token hashes', async () => {
    const session = await json(app.base, '/api/session', { headers: { cookie } });
    assert.equal(session.status, 200);
    const sessionBody = await session.json();
    assert.equal(sessionBody.authenticated, true);
    assert.equal(sessionBody.csrfToken, csrf);
    assert.equal(JSON.stringify(sessionBody).includes('token_hash'), false);

    const account = await json(app.base, '/api/account', { headers: { cookie } });
    const body = await account.json();
    assert.equal(account.status, 200);
    assert.equal(body.preferences.timezone, 'UTC');
    assert.equal(body.notificationSubscription.status, 'not_configured');
  });

  it('enforces CSRF and origin, then persists preferences', async () => {
    const missing = await json(app.base, '/api/account/preferences', { method: 'PATCH', body: { timezone: 'America/New_York' }, headers: { cookie, origin: app.base } });
    assert.equal(missing.status, 403);
    const crossSite = await json(app.base, '/api/account/preferences', { method: 'PATCH', body: { timezone: 'America/New_York' }, headers: { cookie, origin: 'https://evil.example', 'x-csrf-token': csrf } });
    assert.equal(crossSite.status, 403);
    const savedResponse = await json(app.base, '/api/account/preferences', { method: 'PATCH', body: { timezone: 'America/New_York', weekly_digest: true }, headers: { cookie, origin: app.base, 'x-csrf-token': csrf } });
    assert.equal(savedResponse.status, 200);
    const prefs = (await savedResponse.json()).preferences;
    assert.equal(prefs.timezone, 'America/New_York');
    assert.equal(prefs.weekly_digest, true);
  });

  it('keeps anonymous search tokenless but protects signed-in private search with CSRF and exact origin', async () => {
    const account = app.db.getAccount(email);
    const before = app.db.countPrivateProducts(account.id);
    const crossSite = await json(app.base, '/api/search', {
      method: 'POST', body: { vertical: 'subscription', q: 'Netflix' },
      headers: { cookie, origin: 'https://evil.example', 'x-csrf-token': csrf },
    });
    assert.equal(crossSite.status, 403);
    assert.equal(app.db.countPrivateProducts(account.id), before);

    const missing = await json(app.base, '/api/search', {
      method: 'POST', body: { vertical: 'subscription', q: 'Netflix' }, headers: { cookie, origin: app.base },
    });
    assert.equal(missing.status, 403);
    assert.equal(app.db.countPrivateProducts(account.id), before);

    const accepted = await json(app.base, '/api/search', {
      method: 'POST', body: { vertical: 'subscription', q: 'Netflix' },
      headers: { cookie, origin: app.base, 'x-csrf-token': csrf },
    });
    assert.equal(accepted.status, 200);
    assert.equal(app.db.countPrivateProducts(account.id), before + 1);
  });

  it('owns a watchlist and creates a pending alert until double opt-in', async () => {
    const headers = { cookie, origin: app.base, 'x-csrf-token': csrf };
    const watched = await json(app.base, '/api/account/watchlist', { method: 'POST', body: { product_id: 'vegas-hotel' }, headers });
    assert.equal(watched.status, 201);
    const list = await json(app.base, '/api/account/watchlist', { headers: { cookie } });
    assert.equal((await list.json()).items[0].product_id, 'vegas-hotel');

    const product = app.db.getProduct('vegas-hotel');
    app.db.upsertProduct({
      id: product.id, vertical: product.vertical, name: product.name, url: product.url,
      advertised_cents: product.advertised_cents, context: product.context, source: product.source,
      sourceLabel: product.source_label, certainty: product.certainty, fetchedAt: product.fetched_at,
      evidence: { ...product.evidence, refreshable: true, providerIdentity: 'test:vegas-hotel', originalQuery: product.name, provenance: { ...(product.evidence?.provenance || {}), alertEligible: true } },
    });

    const alertResponse = await json(app.base, '/api/account/alerts', { method: 'POST', body: { product_id: 'vegas-hotel', threshold_cents: 30000 }, headers });
    assert.equal(alertResponse.status, 201);
    assert.equal((await alertResponse.json()).alert.status, 'pending');
    const verification = app.mailer.delivered.find((item) => item.template === 'verify-alerts');
    assert.ok(verification);
    const verified = await json(app.base, '/api/notifications/email/verify', {
      method: 'POST', body: { token: fragmentToken(verification.payload.verifyLink) },
    });
    assert.equal(verified.status, 200);
    const alerts = await json(app.base, '/api/account/alerts', { headers: { cookie } });
    assert.equal((await alerts.json()).alerts[0].status, 'active');
  });

  it('lists, rotates, and revokes account-owned API keys without leaking hashes', async () => {
    const account = app.db.getAccount(email);
    app.db.upsertEntitlement({ accountId: account.id, product: 'api:starter', status: 'active', sourceRef: 'sub_test_api', eventCreated: 1 });
    app.db.syncAccountPlan(account.id);
    const headers = { cookie, origin: app.base, 'x-csrf-token': csrf };
    const created = await json(app.base, '/api/account/api-keys', { method: 'POST', body: { label: 'Launch key' }, headers });
    assert.equal(created.status, 201);
    const first = await created.json();
    assert.match(first.key, /^pt_starter_/);
    assert.equal(Object.hasOwn(first.record, 'key_hash'), false);

    const rotated = await json(app.base, `/api/account/api-keys/${first.record.id}/rotate`, { method: 'POST', body: {}, headers });
    assert.equal(rotated.status, 201);
    const replacement = await rotated.json();
    assert.notEqual(replacement.key, first.key);
    assert.equal(app.db.findApiKey(first.key), null);
    assert.ok(app.db.findApiKey(replacement.key));

    const revoked = await json(app.base, `/api/account/api-keys/${replacement.record.id}`, { method: 'DELETE', headers });
    assert.equal(revoked.status, 200);
    assert.equal(app.db.findApiKey(replacement.key), null);
    app.db.upsertEntitlement({ accountId: account.id, product: 'api:starter', status: 'canceled', sourceRef: 'sub_test_api', eventCreated: 2 });
    app.db.syncAccountPlan(account.id);
  });

  it('exports user data, tombstones the account, and revokes the session', async () => {
    const headers = { cookie, origin: app.base, 'x-csrf-token': csrf };
    const exported = await json(app.base, '/api/account/export', { method: 'POST', body: {}, headers });
    assert.equal(exported.status, 200);
    const snapshot = await exported.json();
    assert.equal(snapshot.account.email, email);
    assert.equal(snapshot.watchlist.length, 1);

    const deleted = await json(app.base, '/api/account', { method: 'DELETE', body: { confirm: 'DELETE' }, headers });
    assert.equal(deleted.status, 200);
    assert.equal((await deleted.json()).deleted, true);
    const session = await json(app.base, '/api/session', { headers: { cookie } });
    assert.deepEqual(await session.json(), { authenticated: false });
    assert.equal(app.db.getAccount(email), null);
  });

  it('reports liveness, integrity, migration, email, billing, and worker readiness', async () => {
    const response = await json(app.base, '/api/ready');
    assert.equal(response.status, 200);
    const ready = await response.json();
    assert.equal(ready.ok, true);
    assert.equal(ready.database.integrity, 'ok');
    assert.equal(ready.database.schemaVersion, 4);
    assert.equal(ready.email.transport, 'memory');
    assert.equal(ready.worker.enabled, false);
    assert.ok(['fresh', 'stale', 'invalid'].includes(ready.dataSources.subscriptionCatalog.status));
    assert.equal(typeof ready.dataSources.subscriptionCatalog.maxAgeDays, 'number');
    assert.ok(response.headers.get('x-request-id'));
  });

  it('serves the generated OpenAPI contract as no-store JSON', async () => {
    const response = await json(app.base, '/api/openapi');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^application\/json/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const document = await response.json();
    assert.equal(document.openapi, '3.1.0');
  });
});

describe('durable outbox and job primitives', () => {
  it('rolls double-opt-in state back when its durable message cannot be queued', async () => {
    const oldTransport = process.env.EMAIL_TRANSPORT;
    const oldKey = process.env.OUTBOX_ENCRYPTION_KEY;
    const oldWorker = process.env.DISABLE_WORKER;
    process.env.EMAIL_TRANSPORT = 'memory';
    process.env.OUTBOX_ENCRYPTION_KEY = 'transactional-opt-in-test-key-at-least-32-characters';
    process.env.DISABLE_WORKER = '1';
    const isolated = await startApp();
    try {
      const account = isolated.db.verifyAccount(isolated.db.getOrCreateAccount('opt-in-retry@example.com').id);
      const session = isolated.db.createSession(account.id);
      const headers = {
        cookie: `pt_session=${session.token}; pt_csrf=${session.csrfToken}`,
        origin: isolated.base,
        'x-csrf-token': session.csrfToken,
      };
      const originalEnqueueOutbox = isolated.db.enqueueOutbox;
      isolated.db.enqueueOutbox = () => { throw new Error('simulated opt-in outbox failure'); };
      const failed = await json(isolated.base, '/api/account/notifications/email/request', { method: 'POST', body: {}, headers });
      assert.equal(failed.status, 500);
      assert.equal(isolated.db.getNotification(account.id), null);
      assert.equal(isolated.db.raw.prepare("SELECT COUNT(*) n FROM outbox WHERE template='verify-alerts'").get().n, 0);

      isolated.db.enqueueOutbox = originalEnqueueOutbox;
      const retried = await json(isolated.base, '/api/account/notifications/email/request', { method: 'POST', body: {}, headers });
      assert.equal(retried.status, 202);
      assert.equal(isolated.db.getNotification(account.id).status, 'pending');
      assert.equal(isolated.db.raw.prepare("SELECT COUNT(*) n FROM outbox WHERE template='verify-alerts'").get().n, 1);
      assert.equal(isolated.mailer.delivered.filter((item) => item.template === 'verify-alerts').length, 1);
    } finally {
      await stopApp(isolated);
      if (oldTransport === undefined) delete process.env.EMAIL_TRANSPORT; else process.env.EMAIL_TRANSPORT = oldTransport;
      if (oldKey === undefined) delete process.env.OUTBOX_ENCRYPTION_KEY; else process.env.OUTBOX_ENCRYPTION_KEY = oldKey;
      if (oldWorker === undefined) delete process.env.DISABLE_WORKER; else process.env.DISABLE_WORKER = oldWorker;
    }
  });

  it('rolls verification and one-time unsubscribe tokens back when a later state change fails', () => {
    const db = open(':memory:');
    try {
      db.upsertProduct({ id: 'notification-transaction-product', vertical: 'retail', name: 'Transaction item', advertised_cents: 1000 });

      const verifying = db.verifyAccount(db.getOrCreateAccount('verify-transaction@example.com').id);
      const verification = db.createNotificationVerification(verifying.id);
      db.createAlert({ email: verifying.email, accountId: verifying.id, productId: 'notification-transaction-product', threshold_cents: 1200, status: 'pending' });
      db.raw.exec(`CREATE TRIGGER fail_alert_activation BEFORE UPDATE OF status ON alerts
        WHEN NEW.status='active' BEGIN SELECT RAISE(ABORT,'simulated alert activation failure'); END`);
      assert.throws(() => db.verifyNotification(verification.verifyToken), /simulated alert activation failure/);
      assert.equal(db.getNotification(verifying.id).status, 'pending');
      assert.ok(db.raw.prepare('SELECT verify_token_hash FROM notification_subscriptions WHERE account_id=?').get(verifying.id).verify_token_hash);
      db.raw.exec('DROP TRIGGER fail_alert_activation');
      assert.equal(db.verifyNotification(verification.verifyToken).status, 'active');

      const notificationToken = db.createNotificationUnsubscribeToken(verifying.id);
      const originalCancelNotifications = db.cancelNotificationOutbox;
      db.cancelNotificationOutbox = () => { throw new Error('simulated notification cancel failure'); };
      assert.throws(() => db.unsubscribeNotification(notificationToken), /simulated notification cancel failure/);
      assert.equal(db.getNotification(verifying.id).status, 'active');
      assert.equal(db.raw.prepare('SELECT used_at FROM notification_unsubscribe_tokens WHERE token_hash IS NOT NULL').get().used_at, null);
      db.cancelNotificationOutbox = originalCancelNotifications;
      assert.equal(db.unsubscribeNotification(notificationToken).status, 'unsubscribed');

      const alertAccount = db.verifyAccount(db.getOrCreateAccount('alert-transaction@example.com').id);
      const alertVerification = db.createNotificationVerification(alertAccount.id);
      db.verifyNotification(alertVerification.verifyToken);
      const alert = db.createAlert({ email: alertAccount.email, accountId: alertAccount.id, productId: 'notification-transaction-product', threshold_cents: 1200, status: 'active' });
      const alertToken = db.createAlertUnsubscribeToken(alertAccount.id, alert.id);
      const originalCancelAlert = db.cancelAlertOutbox;
      db.cancelAlertOutbox = () => { throw new Error('simulated alert cancel failure'); };
      assert.throws(() => db.unsubscribeAlert(alertToken), /simulated alert cancel failure/);
      assert.equal(db.getAlert(alert.id, alertAccount.id).status, 'active');
      assert.equal(db.raw.prepare('SELECT used_at FROM alert_unsubscribe_tokens WHERE alert_id=?').get(alert.id).used_at, null);
      db.cancelAlertOutbox = originalCancelAlert;
      assert.equal(db.unsubscribeAlert(alertToken).status, 'paused');
    } finally {
      db.close();
    }
  });

  it('verifies Resend/Svix raw-body signatures and rejects tampering', () => {
    const key = crypto.randomBytes(32);
    const secret = `whsec_${key.toString('base64')}`;
    const body = JSON.stringify({ type: 'email.bounced', data: { email_id: 'mail_1' } });
    const id = 'msg_test_123', timestamp = String(Math.floor(Date.now() / 1000));
    const signature = crypto.createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
    const headers = { 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': `v1,${signature}` };
    assert.equal(verifyDeliveryWebhook(body, headers, secret).type, 'email.bounced');
    assert.throws(() => verifyDeliveryWebhook(body + ' ', headers, secret), (error) => error.status === 400);
  });

  it('encrypts queued mail, tracks delivery, and deduplicates idempotency keys', async () => {
    const oldTransport = process.env.EMAIL_TRANSPORT;
    process.env.EMAIL_TRANSPORT = 'memory';
    const db = open(':memory:');
    try {
      const mailer = createMailer(db);
      const first = await mailer.enqueue({ to: 'mail@example.com', template: 'magic-link', data: { link: 'https://example.com/secret-token' }, idempotencyKey: 'mail-once', sendNow: false });
      const duplicate = await mailer.enqueue({ to: 'mail@example.com', template: 'magic-link', data: { link: 'https://example.com/different' }, idempotencyKey: 'mail-once', sendNow: false });
      assert.equal(first.id, duplicate.id);
      assert.ok(!db.getOutbox(first.id).payload_ciphertext.includes('secret-token'));
      const result = await mailer.processPending();
      assert.equal(result[0].status, 'sent');
      assert.equal(db.getOutbox(first.id).status, 'sent');
    } finally {
      db.close();
      if (oldTransport === undefined) delete process.env.EMAIL_TRANSPORT; else process.env.EMAIL_TRANSPORT = oldTransport;
    }
  });

  it('rechecks alert state and preferences before retries and hard-erases deleted alert data', async () => {
    const oldTransport = process.env.EMAIL_TRANSPORT;
    process.env.EMAIL_TRANSPORT = 'memory';
    const db = open(':memory:');
    try {
      const mailer = createMailer(db);
      const account = db.verifyAccount(db.getOrCreateAccount('suppression@example.com').id);
      const verification = db.createNotificationVerification(account.id);
      db.verifyNotification(verification.verifyToken);
      db.upsertProduct({ id: 'suppression-product', vertical: 'retail', name: 'Suppression product', advertised_cents: 1000 });
      const alert = db.createAlert({ email: account.email, accountId: account.id, productId: 'suppression-product', threshold_cents: 1200, status: 'active' });
      db.createAlertUnsubscribeToken(account.id, alert.id);
      const queued = await mailer.enqueue({
        accountId: account.id, to: account.email, template: 'price-alert', metadata: { alertId: alert.id },
        data: { productName: 'Suppression product', truePrice: '$10.00', productLink: 'https://example.test/p', unsubscribeLink: 'https://example.test/u' },
        idempotencyKey: 'suppression-alert', sendNow: false,
      });
      db.raw.prepare("UPDATE outbox SET status='retry',available_at=? WHERE id=?").run(new Date(0).toISOString(), queued.id);
      assert.equal(db.deleteAlert(account.id, alert.id), true);
      assert.equal(db.getAlert(alert.id, account.id), null);
      assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM alert_unsubscribe_tokens WHERE alert_id=?').get(alert.id).n, 0);
      const canceled = db.getOutbox(queued.id);
      assert.equal(canceled.status, 'canceled');
      assert.equal(canceled.to_email, '');
      assert.equal(canceled.payload_ciphertext, '');
      assert.equal((await mailer.processPending()).length, 0);
      assert.equal(mailer.delivered.length, 0);

      const paused = db.createAlert({ email: account.email, accountId: account.id, productId: 'suppression-product', threshold_cents: 1100, status: 'active' });
      const pauseMail = await mailer.enqueue({
        accountId: account.id, to: account.email, template: 'price-alert', metadata: { alertId: paused.id },
        data: { productName: 'Suppression product', truePrice: '$10.00', productLink: 'https://example.test/p', unsubscribeLink: 'https://example.test/u' },
        idempotencyKey: 'paused-alert', sendNow: false,
      });
      db.updateAlert(account.id, paused.id, { status: 'paused' });
      assert.equal(db.getOutbox(pauseMail.id).status, 'canceled');

      const weekly = await mailer.enqueue({
        accountId: account.id, to: account.email, template: 'weekly-digest', data: { items: [], unsubscribeLink: 'https://example.test/u' },
        idempotencyKey: 'disabled-weekly', sendNow: false,
      });
      db.updatePreferences(account.id, { email_alerts: false, weekly_digest: false });
      assert.equal(db.getOutbox(weekly.id).status, 'canceled');
      assert.equal(db.isNotificationDeliveryAllowed(account.id, 'verify-alerts'), false);
      assert.equal(db.deleteAccount(account.id), true);
      assert.equal(db.isNotificationDeliveryAllowed(account.id, 'magic-link'), false);
    } finally {
      db.close();
      if (oldTransport === undefined) delete process.env.EMAIL_TRANSPORT; else process.env.EMAIL_TRANSPORT = oldTransport;
    }
  });

  it('retains exhausted price-alert mail, confirms only actual delivery, and retargets a newer crossing', async () => {
    const saved = {
      transport: process.env.EMAIL_TRANSPORT,
      resend: process.env.RESEND_API_KEY,
      from: process.env.EMAIL_FROM,
      fetch: globalThis.fetch,
    };
    process.env.EMAIL_TRANSPORT = 'resend';
    process.env.RESEND_API_KEY = 're_test_alert_redrive';
    process.env.EMAIL_FROM = 'PriceTruth <alerts@launch-operator.com>';
    globalThis.fetch = async () => { throw new TypeError('simulated network outage'); };
    const db = open(':memory:');
    try {
      const mailer = createMailer(db);
      const account = db.verifyAccount(db.getOrCreateAccount('alert-redrive@example.com').id);
      const verification = db.createNotificationVerification(account.id);
      db.verifyNotification(verification.verifyToken);
      db.upsertProduct({ id: 'alert-redrive-product', vertical: 'retail', name: 'Redrive item', advertised_cents: 1000 });
      const alert = db.createAlert({ email: account.email, accountId: account.id, productId: 'alert-redrive-product', threshold_cents: 1200, status: 'active' });

      const firstKey = 'alert-redrive-product:2026-08-26T12:00:00.000Z:1000';
      assert.equal(db.evaluateAlertCondition(alert.id, 1000, firstKey).notify, true);
      const first = db.enqueueOutbox({
        ...mailer.prepare({
          accountId: account.id, to: account.email, template: 'price-alert',
          metadata: { alertId: alert.id, triggerKey: firstKey },
          data: { productName: 'Redrive item', truePrice: '$10.00', productLink: 'https://example.test/p', unsubscribeLink: 'https://example.test/u' },
          idempotencyKey: 'alert-redrive-first',
        }),
        maxAttempts: 1,
      });
      const failed = await mailer.complete(first);
      assert.equal(failed.status, 'retry', 'exhausted paid alert remains durably queued for a later redrive');
      assert.equal(db.getAlert(alert.id).last_notified_at, null);
      assert.equal(db.getAlert(alert.id).condition_active, 1);

      const secondKey = 'alert-redrive-product:2026-08-26T12:05:00.000Z:900';
      const retargeted = db.evaluateAlertCondition(alert.id, 900, secondKey);
      assert.equal(retargeted.notify, true);
      assert.equal(retargeted.reason, 'retargeted-pending-crossing');
      assert.equal(db.getOutbox(first.id).status, 'canceled');
      const second = db.enqueueOutbox(mailer.prepare({
        accountId: account.id, to: account.email, template: 'price-alert',
        metadata: { alertId: alert.id, triggerKey: secondKey },
        data: { productName: 'Redrive item', truePrice: '$9.00', productLink: 'https://example.test/p', unsubscribeLink: 'https://example.test/u' },
        idempotencyKey: 'alert-redrive-second',
      }));
      process.env.EMAIL_TRANSPORT = 'memory';
      globalThis.fetch = saved.fetch;
      const delivered = await mailer.complete(second);
      assert.equal(delivered.status, 'sent');
      const finalAlert = db.getAlert(alert.id);
      assert.ok(finalAlert.last_notified_at);
      assert.equal(finalAlert.last_delivered_trigger_key, secondKey);

      const pendingKey = 'alert-redrive-product:2026-08-26T12:10:00.000Z:800';
      db.evaluateAlertCondition(alert.id, 1300, 'above-threshold');
      assert.equal(db.evaluateAlertCondition(alert.id, 800, pendingKey).notify, true);
      const pending = db.enqueueOutbox(mailer.prepare({
        accountId: account.id, to: account.email, template: 'price-alert', metadata: { alertId: alert.id, triggerKey: pendingKey },
        data: { productName: 'Redrive item', truePrice: '$8.00', productLink: 'https://example.test/p', unsubscribeLink: 'https://example.test/u' },
        idempotencyKey: 'alert-threshold-reset',
      }));
      db.updateAlert(account.id, alert.id, { threshold_cents: 700 });
      assert.equal(db.getOutbox(pending.id).status, 'canceled');
      assert.equal(db.getAlert(alert.id).condition_active, 0);
      assert.equal(db.evaluateAlertCondition(alert.id, 600, 'below-new-threshold').notify, true);
    } finally {
      db.close();
      if (saved.transport === undefined) delete process.env.EMAIL_TRANSPORT; else process.env.EMAIL_TRANSPORT = saved.transport;
      if (saved.resend === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = saved.resend;
      if (saved.from === undefined) delete process.env.EMAIL_FROM; else process.env.EMAIL_FROM = saved.from;
      globalThis.fetch = saved.fetch;
    }
  });

  it('treats a permanent email-provider 4xx as terminal and releases the alert crossing', async () => {
    const saved = {
      transport: process.env.EMAIL_TRANSPORT,
      resend: process.env.RESEND_API_KEY,
      from: process.env.EMAIL_FROM,
      fetch: globalThis.fetch,
    };
    process.env.EMAIL_TRANSPORT = 'resend';
    process.env.RESEND_API_KEY = 're_test_permanent_rejection';
    process.env.EMAIL_FROM = 'PriceTruth <alerts@launch-operator.com>';
    globalThis.fetch = async () => new Response(JSON.stringify({ message: 'recipient rejected' }), {
      status: 422,
      headers: { 'content-type': 'application/json' },
    });
    const db = open(':memory:');
    try {
      const mailer = createMailer(db);
      const account = db.verifyAccount(db.getOrCreateAccount('terminal-alert@example.com').id);
      const verification = db.createNotificationVerification(account.id);
      db.verifyNotification(verification.verifyToken);
      db.upsertProduct({ id: 'terminal-alert-product', vertical: 'retail', name: 'Terminal item', advertised_cents: 1000 });
      const alert = db.createAlert({ email: account.email, accountId: account.id, productId: 'terminal-alert-product', threshold_cents: 1200, status: 'active' });
      const triggerKey = 'terminal-alert-product:2026-08-26T13:00:00.000Z:1000';
      assert.equal(db.evaluateAlertCondition(alert.id, 1000, triggerKey).notify, true);
      const queued = db.enqueueOutbox({
        ...mailer.prepare({
          accountId: account.id, to: account.email, template: 'price-alert',
          metadata: { alertId: alert.id, triggerKey },
          data: { productName: 'Terminal item', truePrice: '$10.00', productLink: 'https://example.test/p', unsubscribeLink: 'https://example.test/u' },
          idempotencyKey: 'terminal-alert-rejection',
        }),
        maxAttempts: 5,
      });

      const result = await mailer.complete(queued);
      assert.equal(result.status, 'failed');
      assert.equal(db.getOutbox(queued.id).attempts, 1, 'permanent rejection must not consume retry attempts');
      assert.match(db.getOutbox(queued.id).last_error, /422/);
      assert.equal(db.getAlert(alert.id).condition_active, 0);
      assert.equal(db.getAlert(alert.id).last_notified_at, null);
      assert.equal((await mailer.processPending()).length, 0, 'terminal mail must not be automatically redriven');
      assert.equal(db.evaluateAlertCondition(alert.id, 900, 'terminal-alert-product:later:900').notify, true);
    } finally {
      db.close();
      if (saved.transport === undefined) delete process.env.EMAIL_TRANSPORT; else process.env.EMAIL_TRANSPORT = saved.transport;
      if (saved.resend === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = saved.resend;
      if (saved.from === undefined) delete process.env.EMAIL_FROM; else process.env.EMAIL_FROM = saved.from;
      globalThis.fetch = saved.fetch;
    }
  });

  it('expires abandoned sign-in and legacy opt-in PII without deleting verified accounts', () => {
    const db = open(':memory:');
    try {
      const signIn = db.getOrCreateAccount('abandoned-signin@example.com');
      db.createAuthToken(signIn.id, 'login', -1);

      const optIn = db.getOrCreateAccount('abandoned-optin@example.com');
      db.createNotificationVerification(optIn.id, 'email', -1);
      db.upsertProduct({ id: 'abandoned-alert-product', vertical: 'retail', name: 'Abandoned alert product', advertised_cents: 1000 });
      db.createAlert({ email: optIn.email, accountId: null, productId: 'abandoned-alert-product', threshold_cents: 900, status: 'pending' });

      const verified = db.verifyAccount(db.getOrCreateAccount('verified-kept@example.com').id);
      const result = db.pruneAuth();

      assert.equal(result.authTokens, 1);
      assert.equal(result.expiredPending, 1);
      assert.equal(result.abandonedAccounts, 2);
      assert.equal(db.getAccount(signIn.email), null);
      assert.equal(db.getAccount(optIn.email), null);
      assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM alerts WHERE email=?').get(optIn.email).n, 0);
      assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM notification_subscriptions WHERE account_id=?').get(optIn.id).n, 0);
      assert.equal(db.getAccount(verified.email).email_verified, 1);
    } finally { db.close(); }
  });

  it('leases jobs, retries failures, and completes successful handlers once', async () => {
    const db = open(':memory:');
    try {
      const first = db.enqueueJob('work', { value: 4 }, { idempotencyKey: 'same-work' });
      const duplicate = db.enqueueJob('work', { value: 9 }, { idempotencyKey: 'same-work' });
      assert.equal(first.id, duplicate.id);
      let total = 0;
      const worker = createJobWorker(db, { work: ({ value }) => { total += value; } });
      const result = await worker.tick();
      assert.equal(result[0].status, 'completed');
      assert.equal(total, 4);
      assert.equal((await worker.tick()).length, 0);
    } finally { db.close(); }
  });
});

describe('billing lifecycle and launch gate', () => {
  it('rolls the event ledger and account grant back together if a side effect fails', () => {
    const db = open(':memory:');
    const original = db.upsertEntitlement;
    db.upsertEntitlement = () => { throw new Error('simulated entitlement write failure'); };
    try {
      const event = billing.mockCompletedEvent({ planId: 'premium', email: 'rollback@example.com', sessionId: 'cs_rollback' });
      assert.throws(() => billing.applyEvent(event, db), /simulated entitlement/);
      assert.equal(db.revenueSummary().paid_events, 0);
      assert.equal(db.getAccount('rollback@example.com'), null);
    } finally {
      db.upsertEntitlement = original;
      db.close();
    }
  });

  it('updates and revokes entitlements on subscription lifecycle events', () => {
    const db = open(':memory:');
    try {
      billing.applyEvent(billing.mockCompletedEvent({ planId: 'premium', email: 'subscriber@example.com', sessionId: 'cs_lifecycle' }), db);
      const account = db.getAccount('subscriber@example.com');
      const deleted = billing.applyEvent({
        id: 'evt_subscription_deleted', type: 'customer.subscription.deleted', livemode: false,
        data: { object: { id: 'sub_mock_cs_lifecycle', customer: 'cus_mock_cs_lifecycle', status: 'canceled', metadata: { plan: 'premium' } } },
      }, db);
      assert.equal(deleted.handled, true);
      assert.equal(deleted.entitlement, 'canceled');
      assert.equal(db.isPremium(account.id), false);
      assert.equal(db.listEntitlements(account.id).find((entry) => entry.source_ref === 'sub_mock_cs_lifecycle').status, 'canceled');
    } finally { db.close(); }
  });

  it('requires the entire paid stack when live billing is explicitly enabled', () => {
    const saved = {};
    const names = ['ENABLE_LIVE_BILLING', 'ENABLE_DEMO_SEED', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_PRICE_PREMIUM', 'STRIPE_PRICE_API_STARTER', 'STRIPE_PRICE_API_PRO', 'PUBLIC_BASE_URL', 'PRICETRUTH_DB'];
    for (const name of names) { saved[name] = process.env[name]; delete process.env[name]; }
    process.env.ENABLE_LIVE_BILLING = '1';
    try {
      const result = billing.readiness({ email: { ok: false } });
      assert.equal(result.ok, false);
      assert.ok(result.missing.includes('demoSeedDisabled'));
      assert.ok(result.missing.includes('webhookSecret'));
      assert.ok(result.missing.includes('durableDbConfigured'));
      assert.throws(() => createApp({ dbPath: ':memory:' }), /launch configuration is incomplete/);
    } finally {
      for (const name of names) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
    }
  });
});
