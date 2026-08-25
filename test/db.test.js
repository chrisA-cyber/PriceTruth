// Database tests for the monetization tables added on top of the core schema:
// accounts/entitlements, the replay-safe billing ledger, claim-once pending
// keys, API-key ownership, and the admin metrics rollup. In-memory throughout.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { open } from '../src/db.js';

describe('accounts + entitlements', () => {
  let db;
  beforeEach(() => { db = open(':memory:'); });
  afterEach(() => { db.close(); });

  it('defaults to not-premium and flips only on a premium plan', () => {
    assert.equal(db.isPremium('nobody@x.com'), false);
    db.upsertAccount({ email: 'u@x.com', plan: 'free' });
    assert.equal(db.isPremium('u@x.com'), false);
    db.upsertAccount({ email: 'u@x.com', plan: 'premium' });
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
});
