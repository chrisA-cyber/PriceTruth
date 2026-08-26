// Database tests for the monetization tables added on top of the core schema:
// accounts/entitlements, the replay-safe billing ledger, claim-once pending
// keys, API-key ownership, and the admin metrics rollup. In-memory throughout.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { open, privateProductId } from '../src/db.js';

describe('accounts + entitlements', () => {
  let db;
  beforeEach(() => { db = open(':memory:'); });
  afterEach(() => { db.close(); });

  it('defaults to not-premium and flips only on a premium plan', () => {
    assert.equal(db.isPremium('nobody@x.com'), false);
    db.upsertAccount({ email: 'u@x.com', plan: 'free' });
    assert.equal(db.isPremium('u@x.com'), false);
    const account = db.upsertAccount({ email: 'u@x.com', plan: 'premium' });
    db.upsertEntitlement({ accountId: account.id, product: 'premium', status: 'active', sourceRef: 'sub_test_premium', eventCreated: 1 });
    db.syncAccountPlan(account.id);
    assert.equal(db.isPremium('u@x.com'), true);
    // an api-plan account is not "premium" for the consumer paywall
    db.upsertAccount({ email: 'dev@x.com', plan: 'api' });
    assert.equal(db.isPremium('dev@x.com'), false);
  });

  it('upsert preserves an existing stripe_customer when a later upsert omits it', () => {
    db.upsertAccount({ email: 'u@x.com', plan: 'premium', stripeCustomer: 'cus_123' });
    db.upsertAccount({ email: 'u@x.com', plan: 'premium' }); // no customer passed
    assert.equal(db.getAccount('u@x.com').stripe_customer, 'cus_123');
  });

  it('syncAccountPlan atomically reduces a downgraded account to one active alert', () => {
    const account = db.verifyAccount(db.getOrCreateAccount('quota@x.com').id);
    db.upsertProduct({ id: 'quota-product', vertical: 'subscription', name: 'Quota product', advertised_cents: 1000 });
    db.upsertEntitlement({ accountId: account.id, product: 'premium', status: 'active', sourceRef: 'sub_quota', eventCreated: 1 });
    db.syncAccountPlan(account.id);
    const first = db.createAlert({ email: account.email, accountId: account.id, productId: 'quota-product', threshold_cents: 900 });
    const second = db.createAlert({ email: account.email, accountId: account.id, productId: 'quota-product', threshold_cents: 800 });

    db.upsertEntitlement({ accountId: account.id, product: 'premium', status: 'past_due', sourceRef: 'sub_quota', eventCreated: 2 });
    const synced = db.syncAccountPlan(account.id);

    assert.equal(synced.plan, 'free');
    assert.equal(db.getAlert(first.id, account.id).status, 'active');
    assert.equal(db.getAlert(second.id, account.id).status, 'paused');
    assert.equal(db.countActiveAlertsForAccount(account.id), 1);
    assert.equal(db.evaluateAlertCondition(second.id, 700, 'blocked-trigger').reason, 'inactive');
    assert.throws(
      () => db.updateAlert(account.id, second.id, { status: 'active' }),
      (error) => error.status === 402 && error.code === 'ALERT_LIMIT_REACHED' && error.details.limit === 1,
    );
  });

  it('never rotates a suspended key back into an active higher tier', () => {
    const account = db.verifyAccount(db.getOrCreateAccount('suspended-key@x.com').id);
    db.upsertEntitlement({ accountId: account.id, product: 'api:starter', status: 'active', sourceRef: 'sub_active_starter', eventCreated: 1 });
    db.upsertEntitlement({ accountId: account.id, product: 'api:pro', status: 'past_due', sourceRef: 'sub_past_due_pro', eventCreated: 1 });
    const active = db.createApiKeyRecord('Active starter', 'starter', {
      ownerEmail: account.email, ownerAccountId: account.id, stripeRef: 'sub_active_starter',
    });
    const suspended = db.createApiKeyRecord('Past-due pro', 'pro', {
      ownerEmail: account.email, ownerAccountId: account.id, stripeRef: 'sub_past_due_pro',
    });
    db.syncApiKeysForAccount(account.id);

    const suspendedRecord = db.listApiKeys(account.id).find((key) => key.prefix === suspended.record.prefix);
    assert.equal(suspendedRecord.suspended, true);
    assert.equal(db.findApiKey(suspended.key), null);
    assert.equal(db.rotateApiKey(account.id, suspendedRecord.id), null);
    assert.ok(db.findApiKey(active.key));
  });
});

describe('billing ledger is replay-safe', () => {
  let db;
  beforeEach(() => { db = open(':memory:'); });
  afterEach(() => { db.close(); });

  it('a duplicate stripe_ref is ignored (no double revenue) and reports first-time vs replay', () => {
    const first = db.recordBillingEvent({ type: 'checkout.session.completed', plan: 'premium', amount_cents: 400, stripe_ref: 'evt_1' });
    const dup = db.recordBillingEvent({ type: 'checkout.session.completed', plan: 'premium', amount_cents: 400, stripe_ref: 'evt_1' });
    assert.equal(first, true);   // newly recorded
    assert.equal(dup, false);    // duplicate — the idempotency gate applyEvent relies on
    const rev = db.revenueSummary();
    assert.equal(rev.paid_events, 1);
    assert.equal(rev.gross_cents, 400);
  });

  it('revenueSummary sums gross and windows, and lists recent + active plans', () => {
    db.recordBillingEvent({ type: 'checkout.session.completed', plan: 'premium', amount_cents: 400, stripe_ref: 'e1' });
    db.recordBillingEvent({ type: 'checkout.session.completed', plan: 'api_pro', amount_cents: 39900, stripe_ref: 'e2' });
    db.upsertAccount({ email: 'a@x.com', plan: 'premium' });
    db.upsertAccount({ email: 'b@x.com', plan: 'api' });
    const rev = db.revenueSummary(5);
    assert.equal(rev.gross_cents, 40300);
    assert.equal(rev.paid_events, 2);
    assert.equal(rev.last_30d_cents, 40300); // both just inserted
    assert.ok(Array.isArray(rev.recent) && rev.recent.length === 2);
    const plans = Object.fromEntries(rev.active_plans.map((r) => [r.plan, r.n]));
    assert.equal(plans.premium, 1);
    assert.equal(plans.api, 1);
  });
});

describe('claim-once pending keys', () => {
  let db;
  beforeEach(() => { db = open(':memory:'); });
  afterEach(() => { db.close(); });

  it('a staged key is returned exactly once, then gone', () => {
    db.putPendingKey('cs_1', 'pt_starter_rawsecret', 'starter');
    const first = db.takePendingKey('cs_1');
    // SQLite rows are null-prototype objects, so compare fields, not shape.
    assert.equal(first.raw_key, 'pt_starter_rawsecret');
    assert.equal(first.tier, 'starter');
    assert.equal(db.takePendingKey('cs_1'), null);
  });

  it('prune removes staged keys older than the TTL but keeps fresh ones', () => {
    // A negative TTL puts the cutoff in the future, so every stored row is "old".
    db.putPendingKey('cs_fresh', 'pt_starter_a', 'starter');
    db.prunePendingKeys(-1000);
    assert.equal(db.takePendingKey('cs_fresh'), null);
    // A positive TTL keeps rows newer than the window.
    db.putPendingKey('cs_new', 'pt_starter_b', 'starter');
    db.prunePendingKeys(60_000);
    assert.ok(db.takePendingKey('cs_new'));
  });
});

describe('API-key ownership + metrics rollup', () => {
  let db;
  beforeEach(() => { db = open(':memory:'); });
  afterEach(() => { db.close(); });

  it('createApiKey records owner + stripe ref and authenticates', () => {
    const raw = db.createApiKey('checkout:dev@x.com', 'pro', { ownerEmail: 'dev@x.com', stripeRef: 'sub_1' });
    assert.match(raw, /^pt_pro_/);
    const row = db.findApiKey(raw);
    assert.equal(row.owner_email, 'dev@x.com');
    assert.equal(row.stripe_ref, 'sub_1');
    assert.equal(row.tier, 'pro');
  });

  it('metrics() rolls up keys, usage, products, alerts', () => {
    const raw = db.createApiKey('k', 'starter');
    const keyId = db.findApiKey(raw).id;
    db.meterUsage(keyId);
    db.meterUsage(keyId);
    db.upsertProduct({ id: 'p1', vertical: 'retail', name: 'Thing', advertised_cents: 1000 });
    db.addPricePoint('p1', { advertised_cents: 1000, true_cents: 1100 });
    db.createAlert({ email: 'a@x.com', productId: 'p1', threshold_cents: 900 });
    const m = db.metrics();
    assert.equal(m.api_calls_today, 2);
    assert.equal(m.products, 1);
    assert.equal(m.price_points, 1);
    assert.equal(m.alerts, 1);
    const tiers = Object.fromEntries(m.keys_by_tier.map((r) => [r.tier, r.n]));
    assert.equal(tiers.starter, 1);
  });

  it("shares daily quota across an account's keys and preserves it through rotation", () => {
    const account = db.verifyAccount(db.getOrCreateAccount('shared-quota@x.com').id);
    const first = db.createApiKeyRecord('one', 'starter', { ownerEmail: account.email, ownerAccountId: account.id });
    const second = db.createApiKeyRecord('two', 'starter', { ownerEmail: account.email, ownerAccountId: account.id });
    const firstId = db.findApiKey(first.key).id;
    const secondId = db.findApiKey(second.key).id;
    assert.equal(db.meterUsage(firstId), 1);
    assert.equal(db.meterUsage(secondId), 2);

    const rotated = db.rotateApiKey(account.id, firstId);
    assert.ok(rotated);
    assert.equal(db.meterUsage(db.findApiKey(rotated.key).id), 3);
  });
});

describe('account erasure removes user-supplied API metadata and terms records', () => {
  it('exports acceptance first, then deletes key labels, usage, and acceptance', () => {
    const db = open(':memory:');
    try {
      const account = db.verifyAccount(db.getOrCreateAccount('erase@example.test').id);
      db.recordTermsAcceptance(account.id, '2026-08-25-v1', { source: 'live-checkout', planId: 'api_starter' });
      const raw = db.createApiKey('Customer Name — production secret', 'starter', {
        ownerEmail: account.email, ownerAccountId: account.id, stripeRef: 'sub_erase',
      });
      db.meterUsage(db.findApiKey(raw).id);
      const exported = db.exportAccount(account.id);
      assert.equal(exported.termsAcceptances[0].termsVersion, '2026-08-25-v1');
      assert.equal(exported.apiUsage[0].count, 1);

      assert.equal(db.deleteAccount(account.id), true);
      assert.equal(db.findApiKey(raw), null);
      assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM api_keys WHERE label LIKE ?').get('%Customer Name%').n, 0);
      assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM api_usage').get().n, 0);
      assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM account_terms_acceptances WHERE account_id=?').get(account.id).n, 0);
    } finally {
      db.close();
    }
  });

  it('scrubs completed jobs and queued email when one private report is permanently deleted', () => {
    const db = open(':memory:');
    try {
      const account = db.verifyAccount(db.getOrCreateAccount('erase-report@example.test').id);
      const productId = privateProductId(account.id, 'retail', 'Sensitive medication price');
      db.upsertProduct({
        id: productId, vertical: 'retail', name: 'Sensitive medication price', advertised_cents: 2500,
        visibility: 'private', ownerAccountId: account.id,
        evidence: { originalQuery: 'Sensitive medication price', refreshable: true, providerIdentity: 'private-sku-1' },
      });
      const alert = db.createAlert({ email: account.email, accountId: account.id, productId, threshold_cents: 2400, status: 'active' });
      const completedJob = db.enqueueJob('collect-product', { productId, vertical: 'retail', q: 'Sensitive medication price' }, {
        idempotencyKey: `collect:${productId}:Sensitive medication price`,
      });
      db.claimJobs(1);
      db.completeJob(completedJob.id);
      db.enqueueOutbox({
        accountId: account.id, toEmail: account.email, template: 'price-alert', ciphertext: 'encrypted sensitive report', iv: 'iv', tag: 'tag',
        metadata: { alertId: alert.id, productId }, idempotencyKey: 'erase-private-alert-mail',
      });
      db.enqueueOutbox({
        accountId: account.id, toEmail: account.email, template: 'weekly-digest', ciphertext: 'encrypted sensitive digest', iv: 'iv', tag: 'tag',
        metadata: { productSnapshots: [{ productId }] }, idempotencyKey: 'erase-private-digest-mail',
      });

      assert.equal(db.deletePrivateProduct(account.id, productId), true);
      const job = db.raw.prepare('SELECT status,payload_json,idempotency_key FROM jobs WHERE id=?').get(completedJob.id);
      assert.equal(job.status, 'completed');
      assert.equal(job.payload_json, '{}');
      assert.equal(job.idempotency_key, null);
      const messages = db.raw.prepare('SELECT template,status,payload_ciphertext,metadata_json FROM outbox ORDER BY template').all();
      assert.equal(messages.every((row) => row.status === 'canceled' && row.payload_ciphertext === '' && row.metadata_json === '{}'), true);
      assert.equal(db.getProduct(productId), null);
      assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM alerts WHERE id=?').get(alert.id).n, 0);
    } finally {
      db.close();
    }
  });
});

describe('checkout intent provider authority', () => {
  it('keeps an attached Stripe session blocking and idempotent after nominal expiry', () => {
    const db = open(':memory:');
    try {
      const account = db.verifyAccount(db.getOrCreateAccount('delayed-checkout@example.test').id);
      db.linkStripeCustomer(account.id, 'cus_delayed_checkout');
      const intent = db.reserveCheckoutIntent(account.id, 'premium');
      db.updateCheckoutIntent(intent.id, {
        sessionId: 'cs_delayed_checkout',
        url: 'https://checkout.stripe.com/c/pay/test',
        status: 'pending',
        expiresAt: new Date(Date.now() - 86_400_000).toISOString(),
        paymentStatus: 'unpaid',
      });

      const pending = db.listPendingCheckoutIntents(account.id);
      assert.equal(pending.length, 1);
      assert.equal(pending[0].stripe_session_id, 'cs_delayed_checkout');
      const reused = db.reserveCheckoutIntent(account.id, 'premium');
      assert.equal(reused.created, false);
      assert.equal(reused.id, intent.id);
      assert.equal(db.deleteAccount(account.id), false, 'an ambiguous attached session must block account erasure');
      assert.equal(db.completeCheckoutIntent(account.id, 'premium', 'cs_delayed_checkout'), 1,
        'a delayed signed completion remains applicable after nominal expiry');
    } finally { db.close(); }
  });

  it('unblocks deletion only after a provider-confirmed terminal checkout event', () => {
    const db = open(':memory:');
    try {
      const account = db.verifyAccount(db.getOrCreateAccount('expired-checkout@example.test').id);
      const intent = db.reserveCheckoutIntent(account.id, 'premium');
      db.updateCheckoutIntent(intent.id, {
        sessionId: 'cs_provider_expired', status: 'pending',
        expiresAt: new Date(Date.now() - 86_400_000).toISOString(), paymentStatus: 'unpaid',
      });
      assert.equal(db.deleteAccount(account.id), false);
      assert.equal(db.terminalCheckoutIntent(account.id, 'cs_provider_expired', 'expired', 'unpaid'), true);
      assert.equal(db.listPendingCheckoutIntents(account.id).length, 0);
      assert.equal(db.deleteAccount(account.id), true);
    } finally { db.close(); }
  });
});

describe('migrations are idempotent', () => {
  it('opening the same file db twice does not throw on ALTER re-runs', () => {
    const tmp = `${import.meta.dirname}/../data/test-migrate-${process.pid}.db`;
    let a = open(tmp);
    a.createApiKey('k1', 'starter', { ownerEmail: 'x@y.com', stripeRef: 'r1' });
    a.close();
    // Second open re-runs MIGRATIONS; the ADD COLUMN statements must be swallowed.
    let b = open(tmp);
    const raw = b.createApiKey('k2', 'pro', { ownerEmail: 'z@y.com', stripeRef: 'r2' });
    assert.ok(b.findApiKey(raw));
    b.close();
    // cleanup (best effort — WAL sidecars included)
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.rmSync(tmp + suffix); } catch { /* ignore */ }
    }
  });

  it('rekeys existing private report slugs without losing account-owned references', () => {
    const tmp = `${import.meta.dirname}/../data/test-private-id-migrate-${process.pid}.db`;
    const oldId = 's-subscription-sensitive-medication-plan-deadbeef';
    const originalQuery = 'sensitive-medication-plan';
    let accountId;
    let alertId;
    try {
      let legacy = open(tmp);
      const account = legacy.verifyAccount(legacy.getOrCreateAccount('migration-owner@example.test').id);
      accountId = account.id;
      legacy.upsertProduct({
        id: oldId,
        vertical: 'subscription',
        name: 'Private report',
        advertised_cents: 1999,
        visibility: 'private',
        ownerAccountId: account.id,
        evidence: { originalQuery, refreshable: true },
      });
      legacy.addPricePoint(oldId, { advertised_cents: 1999, true_cents: 1999, alertEligible: true });
      legacy.addWatchlist(account.id, oldId);
      alertId = legacy.createAlert({ email: account.email, accountId: account.id, productId: oldId, threshold_cents: 1900 }).id;
      legacy.enqueueJob('collect-product', { productId: oldId, vertical: 'subscription', q: originalQuery }, {
        idempotencyKey: `collect:${oldId}:migration`,
      });
      legacy.enqueueOutbox({
        accountId: account.id,
        toEmail: account.email,
        template: 'price-alert',
        ciphertext: 'encrypted-old-report-link',
        iv: 'iv',
        tag: 'tag',
        metadata: { alertId },
        idempotencyKey: 'migration-alert-mail',
      });
      legacy.enqueueOutbox({
        accountId: account.id,
        toEmail: account.email,
        template: 'weekly-digest',
        ciphertext: 'encrypted-digest-with-old-report-link',
        iv: 'iv',
        tag: 'tag',
        metadata: { week: '2026-W35' },
        idempotencyKey: 'migration-weekly-digest',
      });
      legacy.raw.prepare('DELETE FROM schema_migrations WHERE version=4').run();
      legacy.close();

      const upgraded = open(tmp);
      try {
        const nextId = privateProductId(accountId, 'subscription', originalQuery);
        assert.equal(upgraded.schemaVersion(), 4);
        assert.equal(upgraded.getProduct(oldId), null);
        assert.equal(upgraded.getProduct(nextId)?.owner_account_id, accountId);
        assert.match(nextId, /^p-[a-f0-9]{48}$/);
        assert.doesNotMatch(nextId, /sensitive|medication|plan/i);
        assert.equal(upgraded.raw.prepare('SELECT product_id FROM price_points').get().product_id, nextId);
        assert.equal(upgraded.raw.prepare('SELECT product_id FROM alerts WHERE id=?').get(alertId).product_id, nextId);
        assert.equal(upgraded.raw.prepare('SELECT product_id FROM watchlist WHERE account_id=?').get(accountId).product_id, nextId);

        const job = upgraded.raw.prepare("SELECT payload_json,idempotency_key FROM jobs WHERE type='collect-product'").get();
        assert.equal(JSON.parse(job.payload_json).productId, nextId);
        assert.equal(job.idempotency_key.includes(oldId), false);
        const mail = upgraded.raw.prepare("SELECT template,status,to_email,payload_ciphertext,metadata_json FROM outbox ORDER BY template").all();
        assert.deepEqual(mail.map((row) => ({
          template: row.template, status: row.status, to: row.to_email,
          payload: row.payload_ciphertext, metadata: row.metadata_json,
        })), [
          { template: 'price-alert', status: 'canceled', to: '', payload: '', metadata: '{}' },
          { template: 'weekly-digest', status: 'canceled', to: '', payload: '', metadata: '{}' },
        ]);
        assert.deepEqual(upgraded.raw.prepare('PRAGMA foreign_key_check').all(), []);
      } finally {
        upgraded.close();
      }
    } finally {
      for (const suffix of ['', '-wal', '-shm']) {
        try { fs.rmSync(tmp + suffix); } catch { /* best effort */ }
      }
    }
  });
});
