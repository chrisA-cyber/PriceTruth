// Billing tests: mock/live mode selection, checkout URL construction, the real
// HMAC webhook verification path (happy / tampered / stale / malformed), and
// applyEvent's entitlement + key-issuance + replay-idempotency behavior.
// These run entirely offline — mock mode + an in-memory db exercise the same
// code paths that real Stripe keys would.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import * as billing from '../src/billing.js';
import { open } from '../src/db.js';

const SECRET = 'whsec_test_secret';

describe('mode + plan catalog', () => {
  const saved = process.env.STRIPE_SECRET_KEY;
  const savedLiveFlag = process.env.ENABLE_LIVE_BILLING;
  afterEach(() => {
    if (saved === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = saved;
    if (savedLiveFlag === undefined) delete process.env.ENABLE_LIVE_BILLING;
    else process.env.ENABLE_LIVE_BILLING = savedLiveFlag;
  });

  it('requires both the explicit opt-in and a valid live secret', () => {
    delete process.env.ENABLE_LIVE_BILLING;
    delete process.env.STRIPE_SECRET_KEY;
    assert.equal(billing.mode(), 'mock');

    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    assert.equal(billing.mode(), 'disabled');

    process.env.STRIPE_SECRET_KEY = `sk_live_${'x'.repeat(16)}`;
    assert.equal(billing.mode(), 'disabled');

    process.env.ENABLE_LIVE_BILLING = '0';
    assert.equal(billing.mode(), 'disabled');

    process.env.ENABLE_LIVE_BILLING = '1';
    assert.equal(billing.mode(), 'live');

    delete process.env.STRIPE_SECRET_KEY;
    assert.equal(billing.mode(), 'disabled');
  });

  it('reports a secret-without-opt-in mismatch as required but unready', () => {
    process.env.ENABLE_LIVE_BILLING = '0';
    process.env.STRIPE_SECRET_KEY = `sk_live_${'y'.repeat(16)}`;
    const report = billing.readiness();
    assert.equal(report.required, true);
    assert.equal(report.mode, 'disabled');
    assert.equal(report.ok, false);
    assert.equal(report.checks.liveBillingEnabled, false);
    assert.ok(report.missing.includes('liveBillingEnabled'));
  });

  it('rejects placeholder or non-public sender and legal-support contacts', () => {
    const names = ['EMAIL_FROM', 'SUPPORT_CONTACT_URL', 'SUPPORT_CONTACT_EMAIL', 'PUBLIC_BASE_URL'];
    const savedContacts = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    try {
      process.env.EMAIL_FROM = 'PriceTruth <alerts@example.test>';
      process.env.SUPPORT_CONTACT_URL = 'https://support.example.com/help';
      process.env.PUBLIC_BASE_URL = 'https://deployment.example.invalid';
      delete process.env.SUPPORT_CONTACT_EMAIL;
      let report = billing.readiness();
      assert.equal(report.checks.emailFrom, false);
      assert.equal(report.checks.legalSupport, false);
      assert.equal(report.checks.publicHttps, false);

      process.env.EMAIL_FROM = 'PriceTruth <alerts@launch-operator.com>';
      process.env.SUPPORT_CONTACT_URL = 'https://support.launch-operator.com/help';
      process.env.PUBLIC_BASE_URL = 'https://app.launch-operator.com';
      report = billing.readiness();
      assert.equal(report.checks.emailFrom, true);
      assert.equal(report.checks.legalSupport, true);
      assert.equal(report.checks.publicHttps, true);

      delete process.env.SUPPORT_CONTACT_URL;
      process.env.SUPPORT_CONTACT_EMAIL = 'support@invalid';
      assert.equal(billing.readiness().checks.legalSupport, false);
    } finally {
      for (const [name, value] of Object.entries(savedContacts)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it('getPlan returns known plans and null for unknown', () => {
    assert.equal(billing.getPlan('premium').kind, 'consumer');
    assert.equal(billing.getPlan('api_starter').tier, 'starter');
    assert.equal(billing.getPlan('api_pro').tier, 'pro');
    assert.equal(billing.getPlan('nope'), null);
    assert.equal(billing.getPlan('__proto__'), null);
  });
});

describe('createCheckout (mock mode)', () => {
  const saved = process.env.STRIPE_SECRET_KEY;
  const savedLiveFlag = process.env.ENABLE_LIVE_BILLING;
  beforeEach(() => { delete process.env.STRIPE_SECRET_KEY; delete process.env.ENABLE_LIVE_BILLING; });
  afterEach(() => {
    if (saved !== undefined) process.env.STRIPE_SECRET_KEY = saved; else delete process.env.STRIPE_SECRET_KEY;
    if (savedLiveFlag !== undefined) process.env.ENABLE_LIVE_BILLING = savedLiveFlag; else delete process.env.ENABLE_LIVE_BILLING;
  });

  it('returns a mock-checkout URL carrying the plan and email', async () => {
    const { url, mock } = await billing.createCheckout({ planId: 'premium', email: 'a@b.com', baseUrl: 'http://x' });
    assert.equal(mock, true);
    assert.ok(url.startsWith('http://x/billing/mock-checkout?'));
    const qs = new URL(url).searchParams;
    assert.equal(qs.get('plan'), 'premium');
    assert.equal(qs.get('email'), 'a@b.com');
  });

  it('rejects an unknown plan with 400', async () => {
    await assert.rejects(
      () => billing.createCheckout({ planId: 'bogus', baseUrl: 'http://x' }),
      (e) => e.status === 400,
    );
  });
});

describe('verifyWebhook', () => {
  it('accepts a correctly signed, fresh payload and returns the parsed event', () => {
    const body = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });
    const sig = billing.signPayload(body, SECRET);
    const event = billing.verifyWebhook(body, sig, SECRET);
    assert.equal(event.id, 'evt_1');
  });

  it('rejects a tampered body (signature no longer matches)', () => {
    const body = JSON.stringify({ id: 'evt_1', amount: 100 });
    const sig = billing.signPayload(body, SECRET);
    const tampered = JSON.stringify({ id: 'evt_1', amount: 999999 });
    assert.throws(() => billing.verifyWebhook(tampered, sig, SECRET), (e) => e.status === 400);
  });

  it('rejects a wrong secret', () => {
    const body = JSON.stringify({ id: 'evt_1' });
    const sig = billing.signPayload(body, SECRET);
    assert.throws(() => billing.verifyWebhook(body, sig, 'whsec_other'), (e) => e.status === 400);
  });

  it('rejects a stale timestamp outside tolerance', () => {
    const body = JSON.stringify({ id: 'evt_1' });
    const oldTs = Math.floor(Date.now() / 1000) - 10_000;
    const sig = billing.signPayload(body, SECRET, oldTs);
    assert.throws(() => billing.verifyWebhook(body, sig, SECRET, 300), (e) => e.status === 400);
  });

  it('rejects a missing/garbage signature header', () => {
    const body = JSON.stringify({ id: 'evt_1' });
    assert.throws(() => billing.verifyWebhook(body, '', SECRET), (e) => e.status === 400);
    assert.throws(() => billing.verifyWebhook(body, 'garbage', SECRET), (e) => e.status === 400);
  });

  it('throws 500 when no secret is configured', () => {
    const body = JSON.stringify({ id: 'evt_1' });
    const sig = billing.signPayload(body, SECRET);
    assert.throws(() => billing.verifyWebhook(body, sig, ''), (e) => e.status === 500);
  });

  it('rejects a valid signature over invalid JSON', () => {
    const body = '{not json';
    const sig = billing.signPayload(body, SECRET);
    assert.throws(() => billing.verifyWebhook(body, sig, SECRET), (e) => e.status === 400);
  });
});

describe('applyEvent', () => {
  let db;
  beforeEach(() => { db = open(':memory:'); });
  afterEach(() => { db.close(); });

  it('a consumer checkout grants premium and records revenue', () => {
    const ev = billing.mockCompletedEvent({ planId: 'premium', email: 'buyer@x.com', sessionId: 'cs_1' });
    const res = billing.applyEvent(ev, db);
    assert.equal(res.handled, true);
    assert.equal(res.granted, 'premium');
    assert.equal(db.isPremium('buyer@x.com'), true);
    const rev = db.revenueSummary();
    assert.equal(rev.gross_cents, 400);
    assert.equal(rev.paid_events, 1);
  });

  it('an API checkout mints a key, stages it for one-time reveal, and marks the account', () => {
    const ev = billing.mockCompletedEvent({ planId: 'api_starter', email: 'dev@x.com', sessionId: 'cs_api' });
    const res = billing.applyEvent(ev, db);
    assert.equal(res.apiKeyIssued, true);
    assert.equal(res.tier, 'starter');
    // Pending key is claimable exactly once.
    const claimed = db.takePendingKey('cs_api');
    assert.ok(claimed && claimed.raw_key.startsWith('pt_starter_'));
    assert.equal(db.takePendingKey('cs_api'), null);
    // The minted key actually authenticates.
    const found = db.findApiKey(claimed.raw_key);
    assert.ok(found && found.tier === 'starter' && found.owner_email === 'dev@x.com');
    assert.equal(db.getAccount('dev@x.com').plan, 'api');
  });

  it('is idempotent: replaying the same event does not double-count revenue', () => {
    const ev = billing.mockCompletedEvent({ planId: 'premium', email: 'buyer@x.com', sessionId: 'cs_2' });
    billing.applyEvent(ev, db);
    const replay = billing.applyEvent(ev, db); // replay (Stripe retries)
    assert.equal(replay.duplicate, true);
    const rev = db.revenueSummary();
    assert.equal(rev.paid_events, 1);
    assert.equal(rev.gross_cents, 400);
  });

  it('is idempotent for key issuance: replaying an API checkout does not mint a second key', () => {
    const ev = billing.mockCompletedEvent({ planId: 'api_starter', email: 'dev@x.com', sessionId: 'cs_dupkey' });
    const first = billing.applyEvent(ev, db);
    assert.equal(first.apiKeyIssued, true);
    const replay = billing.applyEvent(ev, db);
    assert.equal(replay.duplicate, true);
    assert.notEqual(replay.apiKeyIssued, true);
    // Exactly one key exists for this purchase.
    const tiers = Object.fromEntries(db.metrics().keys_by_tier.map((r) => [r.tier, r.n]));
    assert.equal(tiers.starter, 1);
  });

  it('records the actual charged amount (amount_total), not the list price', () => {
    // A promo-code checkout charges less than the plan list price ($4.00).
    const ev = billing.mockCompletedEvent({ planId: 'premium', email: 'promo@x.com', sessionId: 'cs_promo', amount_cents: 300 });
    billing.applyEvent(ev, db);
    assert.equal(db.revenueSummary().gross_cents, 300);
  });

  it('buying an API plan does NOT revoke an existing Premium entitlement', () => {
    const premiumEv = billing.mockCompletedEvent({ planId: 'premium', email: 'both@x.com', sessionId: 'cs_p' });
    billing.applyEvent(premiumEv, db);
    assert.equal(db.isPremium('both@x.com'), true);
    // Same email later buys API Starter.
    const apiEv = billing.mockCompletedEvent({ planId: 'api_starter', email: 'both@x.com', sessionId: 'cs_a' });
    billing.applyEvent(apiEv, db);
    // Premium survives, and the API key was still issued.
    assert.equal(db.isPremium('both@x.com'), true);
    assert.ok(db.takePendingKey('cs_a'));
  });

  it('ignores non-checkout events', () => {
    const res = billing.applyEvent({ id: 'evt_x', type: 'invoice.paid', data: { object: {} } }, db);
    assert.equal(res.handled, false);
  });

  it('ignores informational invoice events without poisoning live reconciliation', () => {
    for (const type of ['invoice.created', 'invoice.finalized', 'invoice.updated', 'invoice.upcoming']) {
      const result = billing.applyEvent({ id: `evt_${type}`, type, livemode: true, data: { object: {} } }, db);
      assert.equal(result.handled, true);
      assert.equal(result.ignored, true);
    }
    assert.equal(db.billingReconciliationMetrics().pending, 0);
  });

  it('recognizes invoice cash once when paid and payment_succeeded both arrive', () => {
    const account = db.verifyAccount(db.getOrCreateAccount('invoice@example.com').id);
    const object = {
      id: 'in_pair_1', customer: 'cus_pair_1', subscription: 'sub_pair_1', amount_paid: 400, currency: 'usd',
      metadata: { plan: 'premium', account_id: account.id },
    };
    db.linkStripeCustomer(account.id, object.customer);
    const first = billing.applyEvent({ id: 'evt_invoice_succeeded', type: 'invoice.payment_succeeded', created: 10, livemode: false, data: { object } }, db);
    const second = billing.applyEvent({ id: 'evt_invoice_paid', type: 'invoice.paid', created: 11, livemode: false, data: { object } }, db);
    assert.equal(first.amount_cents, 400);
    assert.equal(second.amount_cents, 0);
    assert.equal(second.duplicatePayment, true);
    assert.equal(db.revenueSummary().gross_cents, 400);
  });

  it('never lets a late paid invoice resurrect a canceled subscription grant', () => {
    const account = db.verifyAccount(db.getOrCreateAccount('invoice-no-resurrection@example.com').id);
    db.linkStripeCustomer(account.id, 'cus_invoice_no_resurrection');
    db.upsertEntitlement({ accountId: account.id, product: 'premium', status: 'active', sourceRef: 'sub_invoice_no_resurrection', eventCreated: 10 });
    const canceled = billing.applyEvent({
      id: 'evt_sub_canceled_before_invoice', type: 'customer.subscription.deleted', created: 20, livemode: false,
      data: { object: { id: 'sub_invoice_no_resurrection', customer: 'cus_invoice_no_resurrection', status: 'canceled', metadata: { plan: 'premium', account_id: account.id } } },
    }, db);
    assert.equal(canceled.entitlement, 'canceled');

    const invoice = billing.applyEvent({
      id: 'evt_invoice_late_paid', type: 'invoice.paid', created: 30, livemode: false,
      data: { object: {
        id: 'in_late_paid', customer: 'cus_invoice_no_resurrection', subscription: 'sub_invoice_no_resurrection',
        amount_paid: 400, currency: 'usd', metadata: { plan: 'premium', account_id: account.id },
      } },
    }, db);
    assert.equal(invoice.entitlementPolicy, 'subscription-event-authoritative');
    assert.equal(db.getEntitlementBySource(account.id, 'sub_invoice_no_resurrection', 'premium').status, 'canceled');
    assert.equal(db.isPremium(account.id), false);
  });

  it('deauthorizes a known subscription that moves to an unmapped live Price', () => {
    const savedPrice = process.env.STRIPE_PRICE_API_PRO;
    process.env.STRIPE_PRICE_API_PRO = 'price_supported_pro';
    try {
      const account = db.verifyAccount(db.getOrCreateAccount('legacy-price@example.com').id);
      db.linkStripeCustomer(account.id, 'cus_legacy_price');
      db.upsertEntitlement({ accountId: account.id, product: 'api:pro', status: 'active', sourceRef: 'sub_legacy_price', eventCreated: 10 });
      db.syncAccountPlan(account.id);
      const rawKey = db.createApiKey('legacy pro key', 'pro', { ownerEmail: account.email, ownerAccountId: account.id, stripeRef: 'sub_legacy_price' });
      assert.ok(db.findApiKey(rawKey));

      const result = billing.applyEvent({
        id: 'evt_unknown_live_price', type: 'customer.subscription.updated', created: 20, livemode: true,
        data: { object: {
          id: 'sub_legacy_price', customer: 'cus_legacy_price', status: 'active', metadata: { account_id: account.id },
          items: { data: [{ price: { id: 'price_removed_or_legacy' } }] },
        } },
      }, db);
      assert.equal(result.handled, true);
      assert.equal(result.unresolvedPlan, true);
      assert.equal(result.entitlementPolicy, 'fail-closed-unmapped-price');
      assert.equal(db.getEntitlementBySource(account.id, 'sub_legacy_price', 'api:pro').status, 'inactive');
      assert.equal(db.findApiKey(rawKey), null);
      assert.equal(db.billingReconciliationMetrics().pending, 0);
    } finally {
      if (savedPrice === undefined) delete process.env.STRIPE_PRICE_API_PRO;
      else process.env.STRIPE_PRICE_API_PRO = savedPrice;
    }
  });

  it('persists an unmapped subscription watermark even before any grant exists', () => {
    const savedPrice = process.env.STRIPE_PRICE_API_PRO;
    process.env.STRIPE_PRICE_API_PRO = 'price_supported_watermark_pro';
    try {
      const account = db.verifyAccount(db.getOrCreateAccount('watermark-price@example.com').id);
      db.linkStripeCustomer(account.id, 'cus_watermark_price');
      const unknown = billing.applyEvent({
        id: 'evt_unknown_price_first', type: 'customer.subscription.updated', created: 200, livemode: true,
        data: { object: {
          id: 'sub_watermark_price', customer: 'cus_watermark_price', status: 'active', metadata: { account_id: account.id },
          items: { data: [{ price: { id: 'price_removed_first' } }] },
        } },
      }, db);
      assert.equal(unknown.handled, true);
      assert.deepEqual(unknown.deactivated, []);

      const delayedKnown = billing.applyEvent({
        id: 'evt_supported_price_delayed', type: 'customer.subscription.updated', created: 100, livemode: true,
        data: { object: {
          id: 'sub_watermark_price', customer: 'cus_watermark_price', status: 'active', metadata: { account_id: account.id },
          items: { data: [{ price: { id: 'price_supported_watermark_pro' } }] },
        } },
      }, db);
      assert.equal(delayedKnown.handled, true);
      assert.equal(delayedKnown.stale, true);
      assert.equal(db.getEntitlementBySource(account.id, 'sub_watermark_price', 'api:pro'), null);
      assert.equal(db.hasActiveApiEntitlement(account.id), false);
    } finally {
      if (savedPrice === undefined) delete process.env.STRIPE_PRICE_API_PRO;
      else process.env.STRIPE_PRICE_API_PRO = savedPrice;
    }
  });

  it('books cumulative charge refunds as deltas and keeps replays idempotent', () => {
    const account = db.verifyAccount(db.getOrCreateAccount('refund@example.com').id);
    db.linkStripeCustomer(account.id, 'cus_refund_1');
    const make = (id, amount) => ({
      id, type: 'charge.refunded', livemode: false,
      data: { object: { id: 'ch_refund_1', customer: 'cus_refund_1', amount_refunded: amount, currency: 'usd', metadata: { account_id: account.id } } },
    });
    assert.equal(billing.applyEvent(make('evt_refund_1000', 1000), db).amount_cents, -1000);
    assert.equal(billing.applyEvent(make('evt_refund_1500', 1500), db).amount_cents, -500);
    assert.equal(billing.applyEvent(make('evt_refund_1500', 1500), db).duplicate, true);
    assert.equal(db.revenueSummary().refunds_cents, 1500);
    assert.equal(db.revenueSummary().net_cents, -1500);
  });

  it('audits a late live refund without recreating an erased account from mutable email metadata', () => {
    const email = 'erased-refund@example.com';
    const account = db.verifyAccount(db.getOrCreateAccount(email).id);
    assert.equal(db.linkStripeCustomer(account.id, 'cus_erased_refund'), true);
    assert.equal(db.deleteAccount(account.id), true);

    const result = billing.applyEvent({
      id: 'evt_erased_refund', type: 'charge.refunded', livemode: true,
      data: { object: {
        id: 'ch_erased_refund', customer: 'cus_erased_refund', amount_refunded: 400, currency: 'usd',
        metadata: { email },
      } },
    }, db);

    assert.equal(result.handled, true);
    assert.equal(result.deletedAccount, true);
    assert.equal(result.auditOnly, true);
    assert.equal(result.entitlementPolicy, 'no-resurrection');
    assert.equal(result.amount_cents, -400);
    assert.equal(db.getAccount(email), null);
    assert.equal(db.getAccountByStripeCustomer('cus_erased_refund'), null);
    assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM accounts WHERE email=? AND deleted_at IS NULL').get(email).n, 0);
    assert.equal(db.billingReconciliationMetrics().pending, 0);
  });

  it('reconciles premium alerts transactionally when a subscription is canceled', () => {
    const account = db.verifyAccount(db.getOrCreateAccount('downgrade-alerts@example.com').id);
    db.linkStripeCustomer(account.id, 'cus_downgrade_alerts');
    db.upsertProduct({ id: 'p-downgrade', vertical: 'subscription', name: 'Downgrade plan', advertised_cents: 1000 });
    const verification = db.createNotificationVerification(account.id);
    db.verifyNotification(verification.verifyToken);
    db.updatePreferences(account.id, { weekly_digest: true });
    db.upsertEntitlement({ accountId: account.id, product: 'premium', status: 'active', sourceRef: 'sub_downgrade_alerts', eventCreated: 1 });
    db.syncAccountPlan(account.id);

    const alerts = [900, 800, 700].map((threshold) => db.createAlert({
      email: account.email, accountId: account.id, productId: 'p-downgrade', threshold_cents: threshold, status: 'active',
    }));
    for (const alert of alerts) {
      db.enqueueOutbox({
        accountId: account.id, toEmail: account.email, template: 'price-alert', ciphertext: 'sealed', iv: 'iv', tag: 'tag',
        metadata: { alertId: alert.id }, idempotencyKey: `queued-alert-${alert.id}`,
      });
    }
    const digest = db.enqueueOutbox({
      accountId: account.id, toEmail: account.email, template: 'weekly-digest', ciphertext: 'sealed', iv: 'iv', tag: 'tag',
      metadata: {}, idempotencyKey: 'queued-weekly-digest',
    });

    const result = billing.applyEvent({
      id: 'evt_downgrade_alerts', type: 'customer.subscription.deleted', created: 2, livemode: false,
      data: { object: {
        id: 'sub_downgrade_alerts', customer: 'cus_downgrade_alerts', status: 'canceled',
        metadata: { plan: 'premium', account_id: account.id },
      } },
    }, db);

    assert.equal(result.handled, true);
    assert.equal(result.entitlement, 'canceled');
    assert.equal(db.getAccountById(account.id).plan, 'free');
    const stored = alerts.map((alert) => db.getAlert(alert.id, account.id));
    assert.equal(stored.filter((alert) => alert.status === 'active').length, 1);
    assert.equal(stored[0].status, 'active', 'oldest alert is the deterministic free alert');
    assert.deepEqual(stored.slice(1).map((alert) => alert.status), ['paused', 'paused']);
    assert.equal(db.listEvaluableAlerts('p-downgrade').length, 1);
    assert.equal(db.isNotificationDeliveryAllowed(account.id, 'price-alert', { alertId: alerts[0].id }), true);
    assert.equal(db.isNotificationDeliveryAllowed(account.id, 'price-alert', { alertId: alerts[1].id }), false);
    assert.equal(db.getOutbox(digest.id).status, 'canceled');
    assert.equal(db.getOutbox(digest.id).to_email, '');
    assert.equal(db.getOutbox(db.raw.prepare('SELECT id FROM outbox WHERE idempotency_key=?').get(`queued-alert-${alerts[1].id}`).id).status, 'canceled');
    assert.throws(
      () => db.updateAlert(account.id, alerts[1].id, { status: 'active' }),
      (error) => error.status === 402 && error.code === 'ALERT_LIMIT_REACHED',
    );
  });

  it('audits dispute withdrawal and reinstatement without automating entitlements', () => {
    const account = db.verifyAccount(db.getOrCreateAccount('dispute@example.com').id);
    db.linkStripeCustomer(account.id, 'cus_dispute_1');
    const base = { id: 'dp_1', customer: 'cus_dispute_1', amount: 700, currency: 'usd', metadata: { account_id: account.id } };
    const opened = billing.applyEvent({ id: 'evt_dispute_open', type: 'charge.dispute.created', livemode: false, data: { object: { ...base, status: 'needs_response' } } }, db);
    const won = billing.applyEvent({ id: 'evt_dispute_won', type: 'charge.dispute.closed', livemode: false, data: { object: { ...base, status: 'won' } } }, db);
    assert.equal(opened.amount_cents, -700);
    assert.equal(won.amount_cents, 700);
    assert.equal(won.entitlementPolicy, 'unchanged-pending-operator-review');
    assert.equal(db.revenueSummary().net_cents, 0);
  });

  it('does not let an out-of-order dispute-created event regress a later won state', () => {
    const account = db.verifyAccount(db.getOrCreateAccount('ordered-dispute@example.com').id);
    db.linkStripeCustomer(account.id, 'cus_dispute_ordered');
    const object = { id: 'dp_ordered', customer: 'cus_dispute_ordered', amount: 900, currency: 'usd', metadata: { account_id: account.id } };
    const won = billing.applyEvent({ id: 'evt_dispute_won_new', type: 'charge.dispute.closed', created: 200, livemode: false, data: { object: { ...object, status: 'won' } } }, db);
    const stale = billing.applyEvent({ id: 'evt_dispute_open_old', type: 'charge.dispute.created', created: 100, livemode: false, data: { object: { ...object, status: 'needs_response' } } }, db);
    assert.equal(won.amount_cents, 0);
    assert.equal(stale.stale, true);
    assert.equal(stale.amount_cents, 0);
    assert.equal(db.revenueSummary().net_cents, 0);
  });

  it('audits late subscription and invoice events after erasure without resurrecting the account', () => {
    const account = db.verifyAccount(db.getOrCreateAccount('erased-billing@example.com').id);
    assert.equal(db.linkStripeCustomer(account.id, 'cus_erased_lifecycle'), true);
    assert.equal(db.deleteAccount(account.id), true);
    const subscription = billing.applyEvent({
      id: 'evt_erased_subscription', type: 'customer.subscription.deleted', created: 300, livemode: true,
      data: { object: { id: 'sub_erased_lifecycle', customer: 'cus_erased_lifecycle', status: 'canceled', metadata: { account_id: account.id } } },
    }, db);
    const invoice = billing.applyEvent({
      id: 'evt_erased_invoice', type: 'invoice.paid', created: 301, livemode: true,
      data: { object: { id: 'in_erased_lifecycle', customer: 'cus_erased_lifecycle', amount_paid: 400, currency: 'usd', metadata: { account_id: account.id } } },
    }, db);
    assert.equal(subscription.deletedAccount, true);
    assert.equal(invoice.deletedAccount, true);
    assert.equal(invoice.amount_cents, 400);
    assert.equal(db.getAccount('erased-billing@example.com'), null);
    assert.equal(db.getAccountByStripeCustomer('cus_erased_lifecycle'), null);
    assert.equal(db.billingReconciliationMetrics().pending, 0);
  });

  it('ignores a checkout for an unknown plan', () => {
    const ev = billing.mockCompletedEvent({ planId: 'premium', email: 'x@y.com', sessionId: 'cs_3' });
    ev.data.object.metadata.plan = 'ghost';
    ev.data.object.client_reference_id = 'ghost';
    const res = billing.applyEvent(ev, db);
    assert.equal(res.handled, false);
  });
});
