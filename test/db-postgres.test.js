import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { NetlifyDB } from '@netlify/database-dev';
import { openPostgres, privateProductId } from '../src/db-postgres.js';

const migrations = fileURLToPath(new URL('../netlify/database/migrations', import.meta.url));

test('Netlify Postgres migrations and repository concurrency invariants', async (t) => {
  const local = new NetlifyDB({ logger: () => {} });
  const connectionString = await local.start();
  await local.applyMigrations(migrations);
  const db = openPostgres({ connectionString });
  t.after(async () => {
    await db.close();
    await local.stop();
  });

  assert.deepEqual(await db.checkReady(), {
    ok: true,
    integrity: 'ok',
    schemaVersion: 4,
    storage: 'postgres',
    checkedAt: (await db.checkReady()).checkedAt,
  });

  const accounts = await Promise.all(Array.from({ length: 8 }, () => db.getOrCreateAccount('parallel@example.com')));
  assert.equal(new Set(accounts.map((account) => account.id)).size, 1);
  const account = accounts[0];

  const authTokens = await Promise.all(Array.from({ length: 9 }, () => db.createAuthToken(account.id)));
  assert.equal(authTokens.filter((entry) => !entry.suppressed).length, 5);
  assert.equal(authTokens.filter((entry) => entry.suppressed).length, 4);
  assert.ok(await db.consumeAuthToken(authTokens.find((entry) => entry.token).token));
  assert.equal((await db.createAuthToken(account.id)).suppressed, false);

  await db.upsertProduct({
    id: 'postgres-product', vertical: 'retail', name: 'Postgres product', advertised_cents: 2500,
  });

  const duplicatePoints = await Promise.all(Array.from({ length: 8 }, () => db.addPricePoint('postgres-product', {
    ts: '2026-08-26T12:00:00.000Z', advertised_cents: 2500, true_cents: 2900,
    source: 'test', providerKey: 'one-observation', observed: true, alertEligible: true,
  })));
  assert.equal(duplicatePoints.filter(Boolean).length, 1);
  assert.equal((await db.getStats('postgres-product', 3650)).n, 1);

  const alertResults = await Promise.allSettled(Array.from({ length: 8 }, () => db.createAlert({
    email: account.email, accountId: account.id, productId: 'postgres-product', threshold_cents: 2000,
  })));
  assert.equal(alertResults.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(await db.countAlertsForAccount(account.id), 1);

  const reservations = await Promise.all(Array.from({ length: 12 }, () => db.reserveProviderCall('integration', 3)));
  assert.equal(reservations.filter((reservation) => reservation.allowed).length, 3);
  assert.equal((await db.providerUsageToday())[0].calls, 3);

  // Independent repository instances model separately warm Netlify Functions.
  // Their shared bucket must admit exactly the configured burst under a race.
  const competingDb = openPostgres({ connectionString });
  t.after(async () => competingDb.close());
  const sensitiveBucket = 'auth-email:email:private-person@example.com';
  const durableAttempts = await Promise.all(Array.from({ length: 24 }, (_, index) =>
    (index % 2 ? db : competingDb).consumeDurableRateLimit(sensitiveBucket, {
      capacity: 3,
      refillPerSec: 1 / 3600,
      ttlMs: 86_400_000,
    })));
  assert.equal(durableAttempts.filter((attempt) => attempt.ok).length, 3);
  const denied = durableAttempts.find((attempt) => !attempt.ok);
  assert.equal(denied.limit, 3);
  assert.equal(denied.remaining, 0);
  assert.ok(denied.retryAfterSec > 0);
  const { rows: storedBuckets } = await local.query('SELECT bucket,expires_at FROM durable_rate_limits');
  assert.equal(storedBuckets.length, 1);
  assert.doesNotMatch(storedBuckets[0].bucket, /private-person|example\.com|auth-email/);
  assert.ok(Date.parse(storedBuckets[0].expires_at) > Date.now());
  await local.exec("UPDATE durable_rate_limits SET tokens=0,updated_at_ms=0,expires_at='2000-01-01T00:00:00.000Z'");
  const renewed = await competingDb.consumeDurableRateLimit(sensitiveBucket, {
    capacity: 3, refillPerSec: 1 / 3600, ttlMs: 86_400_000,
  });
  assert.equal(renewed.ok, true);
  assert.equal(renewed.remaining, 2, 'an expired bucket starts with a fresh burst');
  await db.pruneOperationalData();
  assert.equal((await local.query('SELECT bucket FROM durable_rate_limits')).rows.length, 1,
    'maintenance must retain a live bucket');
  await local.exec("UPDATE durable_rate_limits SET expires_at='2000-01-01T00:00:00.000Z'");
  await db.pruneOperationalData();
  assert.equal((await local.query('SELECT bucket FROM durable_rate_limits')).rows.length, 0,
    'maintenance removes expired buckets');

  // A contender can calculate its database timestamp before waiting for a
  // newer conflicting write. Simulate that stale timestamp directly: the
  // accepted debit must retain the later stored clock/expiry, otherwise the
  // following request can refill time that was already accounted for.
  const monotonicBucket = 'auth-email:email:monotonic-clock@example.com';
  assert.equal((await db.consumeDurableRateLimit(monotonicBucket, {
    capacity: 2, refillPerSec: 1000, cost: 1, ttlMs: 120_000,
  })).ok, true);
  const [{ bucket: monotonicStorageBucket }] = (await local.query('SELECT bucket FROM durable_rate_limits')).rows;
  const seededClock = (await local.query(`UPDATE durable_rate_limits SET tokens=1,
      updated_at_ms=floor(extract(epoch FROM clock_timestamp())*1000)::bigint+60000,
      expires_at=to_char((clock_timestamp()+interval '3 minutes') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      WHERE bucket=$1 RETURNING updated_at_ms,expires_at`, [monotonicStorageBucket])).rows[0];
  const staleDebit = await competingDb.consumeDurableRateLimit(monotonicBucket, {
    capacity: 2, refillPerSec: 1000, cost: 1, ttlMs: 120_000,
  });
  assert.equal(staleDebit.ok, true);
  assert.equal(staleDebit.remaining, 0);
  const monotonicState = (await local.query('SELECT tokens,updated_at_ms,expires_at FROM durable_rate_limits WHERE bucket=$1', [monotonicStorageBucket])).rows[0];
  assert.equal(String(monotonicState.updated_at_ms), String(seededClock.updated_at_ms));
  assert.equal(monotonicState.expires_at, seededClock.expires_at);
  assert.equal(Number(monotonicState.tokens), 0);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((await db.consumeDurableRateLimit(monotonicBucket, {
    capacity: 2, refillPerSec: 1000, cost: 1, ttlMs: 120_000,
  })).ok, false, 'a stale contender must not mint refill credit by rewinding the bucket clock');

  await db.transaction(async () => {
    await db.upsertProduct({ id: 'outer-commit', vertical: 'retail', name: 'Outer', advertised_cents: 1 });
    await assert.rejects(db.transaction(async () => {
      await db.upsertProduct({ id: 'inner-rollback', vertical: 'retail', name: 'Inner', advertised_cents: 1 });
      throw new Error('rollback savepoint');
    }), /rollback savepoint/);
  });
  assert.ok(await db.getProduct('outer-commit'));
  assert.equal(await db.getProduct('inner-rollback'), null);

  const [checkoutA, checkoutB] = await Promise.all([
    db.reserveCheckoutIntent(account.id, 'premium'),
    competingDb.reserveCheckoutIntent(account.id, 'premium'),
  ]);
  assert.equal(checkoutA.id, checkoutB.id);
  assert.equal([checkoutA.created, checkoutB.created].filter(Boolean).length, 1);

  const checkoutRaceAccount = await db.getOrCreateAccount('cross-plan-checkout@example.com');
  const crossPlan = await Promise.allSettled([
    db.reserveCheckoutIntent(checkoutRaceAccount.id, 'premium'),
    competingDb.reserveCheckoutIntent(checkoutRaceAccount.id, 'api_pro'),
  ]);
  assert.equal(crossPlan.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(crossPlan.filter((result) => result.status === 'rejected').length, 1);
  const rejectedCheckout = crossPlan.find((result) => result.status === 'rejected').reason;
  assert.equal(rejectedCheckout.status, 409);
  assert.equal(rejectedCheckout.code, 'CHECKOUT_PENDING');
  const pendingCrossPlan = (await local.query(`SELECT plan FROM checkout_intents
    WHERE account_id=$1 AND status IN ('pending','awaiting_payment')`, [checkoutRaceAccount.id])).rows;
  assert.equal(pendingCrossPlan.length, 1);
  assert.deepEqual(rejectedCheckout.details, { pendingPlans: [pendingCrossPlan[0].plan] });

  await db.putPendingKey('checkout-session', 'pt_starter_secret', 'starter', account.id);
  const claimed = await Promise.all([
    db.takePendingKey('checkout-session', account.id),
    db.takePendingKey('checkout-session', account.id),
  ]);
  assert.equal(claimed.filter(Boolean).length, 1);
  assert.equal(claimed.find(Boolean).raw_key, 'pt_starter_secret');

  const job = await db.enqueueJob('integration', { accountId: account.id });
  const competingClaims = await Promise.all([db.claimJobs(1), db.claimJobs(1)]);
  assert.equal(competingClaims.flat().length, 1);
  const claimedJob = competingClaims.flat()[0];
  assert.equal(claimedJob.id, job.id);
  assert.equal(await db.completeJob(job.id, 'stale-lease'), false);
  assert.equal(await db.completeJob(job.id, claimedJob.lease_token), true);

  const outbox = await db.enqueueOutbox({
    accountId: account.id, toEmail: account.email, template: 'login', ciphertext: 'cipher', iv: 'iv', tag: 'tag',
  });
  const [claimedOutbox] = await db.claimOutbox(1);
  assert.equal(claimedOutbox.id, outbox.id);
  assert.equal(await db.markOutboxSent(outbox.id, 'provider-id', 'stale-lease'), false);
  assert.equal(await db.markOutboxSent(outbox.id, 'provider-id', claimedOutbox.lease_token), true);

  const active = await db.upsertEntitlement({
    accountId: account.id, product: 'premium', sourceRef: 'sub_integration', status: 'active', eventCreated: 100,
  });
  assert.equal(active.applied, true);
  assert.deepEqual(await db.deactivateEntitlementsBySource(account.id, 'sub_integration', 'canceled', 101), ['premium']);
  const stale = await db.upsertEntitlement({
    accountId: account.id, product: 'premium', sourceRef: 'sub_integration', status: 'active', eventCreated: 100,
  });
  assert.equal(stale.stale, true);
  assert.equal((await db.getEntitlementBySource(account.id, 'sub_integration', 'premium')).status, 'canceled');
});

test('Netlify Postgres repository preserves operational return shapes', async (t) => {
  const local = new NetlifyDB({ logger: () => {} });
  const connectionString = await local.start();
  await local.applyMigrations(migrations);
  const db = openPostgres({ connectionString });
  t.after(async () => {
    await db.close();
    await local.stop();
  });

  const account = await db.getOrCreateAccount('shapes@example.com');
  assert.equal((await db.verifyAccount(account.id)).email_verified, 1);
  assert.deepEqual(await db.updatePreferences(account.id, { weekly_digest: true, timezone: 'America/New_York' }), {
    email_alerts: true,
    weekly_digest: true,
    timezone: 'America/New_York',
    created_at: (await db.getPreferences(account.id)).created_at,
    updated_at: (await db.getPreferences(account.id)).updated_at,
  });
  const acceptance = await db.recordTermsAcceptance(account.id, 'terms-2026.08', { surface: 'integration' });
  assert.equal(acceptance.context.surface, 'integration');
  assert.equal((await db.listTermsAcceptances(account.id)).length, 1);

  const session = await db.createSession(account.id, { userAgent: 'integration-agent', ip: '127.0.0.1' });
  const loadedSession = await db.getSession(session.token, { touch: false });
  assert.equal(await db.verifyCsrf(loadedSession, session.csrfToken), true);
  const rotatedCsrf = await db.rotateSessionCsrf(session.id);
  assert.equal(typeof rotatedCsrf, 'string');
  assert.equal(await db.revokeSession(session.token), true);

  await db.upsertProduct({ id: 'operational-product', vertical: 'retail', name: 'Operational', advertised_cents: 3000 });
  assert.equal((await db.addWatchlist(account.id, 'operational-product')).product_id, 'operational-product');
  assert.equal((await db.listWatchlist(account.id)).length, 1);
  assert.equal(await db.removeWatchlist(account.id, 'operational-product'), true);

  const verification = await db.createNotificationVerification(account.id);
  assert.equal(verification.status, 'pending');
  assert.equal((await db.verifyNotification(verification.verifyToken)).status, 'active');
  const alert = await db.createAlert({
    email: account.email, accountId: account.id, productId: 'operational-product', threshold_cents: 2500,
  });
  assert.equal(await db.isNotificationDeliveryAllowed(account.id, 'price-alert', { alertId: alert.id }), true);
  assert.deepEqual(await db.evaluateAlertCondition(alert.id, 2400, 'trigger-one'), { notify: true, reason: 'crossed-below' });
  const queued = await db.enqueueOutbox({
    accountId: account.id, toEmail: account.email, template: 'price-alert', ciphertext: 'cipher', iv: 'iv', tag: 'tag',
    metadata: { alertId: alert.id }, idempotencyKey: 'shape-mail',
  });
  assert.equal((await db.enqueueOutbox({
    accountId: account.id, toEmail: account.email, template: 'price-alert', ciphertext: 'other', iv: 'iv', tag: 'tag',
    metadata: { alertId: alert.id }, idempotencyKey: 'shape-mail',
  })).id, queued.id);
  const [mail] = await db.claimOutbox(1);
  assert.equal(await db.confirmAlertDelivery(alert.id, 'trigger-one'), true);
  assert.equal(await db.markOutboxSent(mail.id, 'message-shape', mail.lease_token), true);
  assert.equal(await db.recordDeliveryEvent({ provider: 'test', providerEventId: 'delivery-shape', providerMessageId: 'message-shape', type: 'delivered' }), true);
  assert.equal(await db.recordDeliveryEvent({ provider: 'test', providerEventId: 'delivery-shape', providerMessageId: 'message-shape', type: 'delivered' }), false);
  const alertUnsubscribe = await db.createAlertUnsubscribeToken(account.id, alert.id);
  assert.equal((await db.unsubscribeAlert(alertUnsubscribe)).status, 'paused');
  const notificationUnsubscribe = await db.createNotificationUnsubscribeToken(account.id);
  assert.equal((await db.unsubscribeNotification(notificationUnsubscribe)).status, 'unsubscribed');

  const apiKey = await db.createApiKeyRecord('shape key', 'starter', { ownerAccountId: account.id, ownerEmail: account.email, canWriteHistory: true });
  assert.equal((await db.findApiKey(apiKey.key)).id, apiKey.record.id);
  assert.equal(await db.meterUsage(apiKey.record.id), 1);
  const rotatedKey = await db.rotateApiKey(account.id, apiKey.record.id);
  assert.equal(typeof rotatedKey.key, 'string');
  assert.equal(await db.revokeApiKey(account.id, rotatedKey.record.id), true);

  assert.equal(await db.recordBillingEvent({
    type: 'invoice.paid', email: account.email, accountId: account.id, plan: 'premium', amount_cents: 400,
    stripe_ref: 'evt-shape-paid', payload: { objectId: 'inv_shape', eventCreated: 10 },
  }), true);
  assert.equal(await db.recordBillingEvent({
    type: 'invoice.paid', email: account.email, accountId: account.id, plan: 'premium', amount_cents: 400,
    stripe_ref: 'evt-shape-paid', payload: { objectId: 'inv_shape', eventCreated: 10 },
  }), false);
  assert.equal(await db.hasRecognizedInvoicePayment('inv_shape'), true);
  assert.equal(await db.billingObjectAmount('inv_shape', ['invoice.paid']), 400);
  assert.equal((await db.latestBillingObjectEvent('inv_shape', ['invoice.paid'])).type, 'invoice.paid');
  await db.recordBillingEvent({
    type: 'charge.refunded', accountId: account.id, amount_cents: -125, stripe_ref: 'evt-shape-refund',
    payload: { objectId: 'ch_shape', cumulativeRefunded: 125, eventCreated: 11 },
  });
  assert.equal(await db.refundedTotalForCharge('ch_shape'), 125);
  await db.recordBillingReconciliation({
    eventId: 'evt-unmapped', eventType: 'unknown', reason: 'shape check', payload: { accountId: account.id, customer: 'cus_shape' },
  });
  assert.equal((await db.billingReconciliationMetrics()).pending, 1);
  assert.equal((await db.listPendingBillingReconciliation(account.id, 'cus_shape')).length, 1);
  assert.equal(await db.resolveBillingReconciliation('evt-unmapped'), true);

  const checkout = await db.reserveCheckoutIntent(account.id, 'premium', { termsVersion: 'terms-2026.08' });
  const attachedCheckout = await db.updateCheckoutIntent(checkout.id, { sessionId: 'cs_shape', status: 'awaiting_payment' });
  assert.equal((await db.getCheckoutIntentBySession(account.id, 'cs_shape')).id, attachedCheckout.id);
  assert.equal(await db.terminalCheckoutIntent(account.id, 'cs_shape', 'expired'), true);
  assert.equal((await db.listPendingCheckoutIntents(account.id)).length, 0);
  assert.equal((await db.registerCheckoutClaim({ sessionId: 'cs_claim_shape', accountId: account.id, plan: 'premium' })).status, 'complete');

  const privateId = privateProductId(account.id, 'retail', 'Private shape query');
  await db.upsertProduct({
    id: privateId, vertical: 'retail', name: 'Private shape', advertised_cents: 1000, visibility: 'private',
    ownerAccountId: account.id, evidence: { originalQuery: 'Private shape query', refreshable: true },
  });
  assert.equal((await db.findPrivateProductByQuery(account.id, 'retail', 'Private shape query')).id, privateId);
  await db.addPricePoint(privateId, { ts: '2020-01-01T00:00:00.000Z', advertised_cents: 1000, true_cents: 1100 });
  assert.equal(await db.prunePrivateProductHistory(privateId, { maxDays: 30 }), 1);
  assert.equal(await db.deletePrivateProduct(account.id, privateId), true);

  const exported = await db.exportAccount(account.id);
  assert.equal(exported.account.email, account.email);
  assert.equal(exported.termsAcceptances.length, 1);
  assert.equal((await db.revenueSummary()).net_cents, 275);
  assert.equal((await db.metrics()).products, 1);
  assert.equal(await db.deleteAccount(account.id), true);
  assert.equal((await db.getDeletedAccountForBilling({ accountId: account.id })).id, account.id);
});
