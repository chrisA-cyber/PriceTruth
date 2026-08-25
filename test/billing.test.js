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
  afterEach(() => {
    if (saved === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = saved;
  });

  it('mock without a secret, live with one', () => {
    delete process.env.STRIPE_SECRET_KEY;
    assert.equal(billing.mode(), 'mock');
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    assert.equal(billing.mode(), 'live');
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
  beforeEach(() => { delete process.env.STRIPE_SECRET_KEY; });
  afterEach(() => { if (saved !== undefined) process.env.STRIPE_SECRET_KEY = saved; });

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

  it('ignores a checkout for an unknown plan', () => {
    const ev = billing.mockCompletedEvent({ planId: 'premium', email: 'x@y.com', sessionId: 'cs_3' });
    ev.data.object.metadata.plan = 'ghost';
    ev.data.object.client_reference_id = 'ghost';
    const res = billing.applyEvent(ev, db);
    assert.equal(res.handled, false);
  });
});
