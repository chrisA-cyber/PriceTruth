import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { productAlertEligible, catalogNotificationDeliveryAllowed } from '../src/server.js';
import { open } from '../src/db.js';
import { createMailer } from '../src/email.js';

const verifiedProduct = {
  vertical: 'subscription',
  evidence: { refreshable: true, provenance: { alertEligible: true } },
};

describe('subscription catalog notification gate', () => {
  it('allows fresh verified catalog alerts and suppresses them after expiry', () => {
    assert.equal(productAlertEligible(verifiedProduct, { now: Date.parse('2026-08-26T12:00:00.000Z') }), true);
    assert.equal(productAlertEligible(verifiedProduct, { now: Date.parse('2026-11-27T00:00:01.000Z') }), false);
  });

  it('fails closed for an invalid policy without disabling unrelated verified sources', () => {
    const env = { SUBSCRIPTION_CATALOG_MAX_AGE_DAYS: 'not-a-number' };
    assert.equal(productAlertEligible(verifiedProduct, { env, now: Date.parse('2026-08-26T12:00:00.000Z') }), false);
    assert.equal(productAlertEligible({ ...verifiedProduct, vertical: 'retail' }, { env, now: Date.parse('2027-01-01T00:00:00.000Z') }), true);
  });

  it('cancels a queued subscription retry at send time without affecting sign-in or retail mail', async () => {
    const savedTransport = process.env.EMAIL_TRANSPORT;
    process.env.EMAIL_TRANSPORT = 'memory';
    const db = open(':memory:');
    const staleNow = Date.parse('2026-11-27T00:00:01.000Z');
    const mailer = createMailer(db, {
      deliveryGuard: (context) => catalogNotificationDeliveryAllowed(db, { ...context, now: staleNow }),
    });
    try {
      const account = db.verifyAccount(db.getOrCreateAccount('catalog-alert@launch-operator.com').id);
      db.upsertEntitlement({ accountId: account.id, product: 'premium', status: 'active', sourceRef: 'sub_catalog_gate', eventCreated: 1 });
      db.syncAccountPlan(account.id);
      const verification = db.createNotificationVerification(account.id);
      db.verifyNotification(verification.verifyToken);
      db.upsertProduct({
        id: 'stale-catalog-alert', vertical: 'subscription', name: 'Catalog plan', advertised_cents: 999,
        evidence: { refreshable: true, provenance: { alertEligible: true } },
      });
      const catalogPointAt = '2026-08-25T00:00:00.000Z';
      db.addPricePoint('stale-catalog-alert', {
        ts: catalogPointAt, advertised_cents: 999, true_cents: 999, source: 'dataset:test',
        alertEligible: true, evidence: { provenance: { evidenceType: 'catalog_snapshot', asOf: catalogPointAt, maxAgeSeconds: 7_776_000, alertEligible: true } },
      });
      const subscriptionAlert = db.createAlert({
        email: account.email, accountId: account.id, productId: 'stale-catalog-alert', threshold_cents: 1200, status: 'active',
      });
      const queued = await mailer.enqueue({
        accountId: account.id, to: account.email, template: 'price-alert',
        metadata: { alertId: subscriptionAlert.id, productId: 'stale-catalog-alert', pointAt: catalogPointAt, trueCents: 999, requiresFreshSubscriptionCatalog: true },
        data: { productName: 'Catalog plan', truePrice: '$9.99', productLink: 'https://app.launch-operator.com/p/stale-catalog-alert', unsubscribeLink: 'https://app.launch-operator.com/unsubscribe' },
        idempotencyKey: 'stale-catalog-retry', sendNow: false,
      });
      assert.deepEqual(await mailer.processPending(), [{ id: queued.id, status: 'canceled' }]);
      assert.equal(db.getOutbox(queued.id).payload_ciphertext, '');
      assert.equal(mailer.delivered.length, 0);

      await mailer.enqueue({
        accountId: account.id, to: account.email, template: 'magic-link',
        metadata: { requiresFreshSubscriptionCatalog: true },
        data: { link: 'https://app.launch-operator.com/auth/verify#token=safe' },
        idempotencyKey: 'catalog-magic-link',
      });
      assert.equal(mailer.delivered.at(-1).template, 'magic-link');

      const retailPointAt = new Date(staleNow).toISOString();
      const retailProvenance = { source: 'live:test', observed: true, asOf: retailPointAt, maxAgeSeconds: 3600, stale: false, alertEligible: true };
      db.upsertProduct({
        id: 'verified-retail-alert', vertical: 'retail', name: 'Retail item', advertised_cents: 1999,
        source: 'live:test', evidence: { refreshable: true, provenance: retailProvenance },
      });
      db.addPricePoint('verified-retail-alert', {
        ts: retailPointAt, advertised_cents: 1999, true_cents: 1999, source: 'live:test', observed: true,
        alertEligible: true, evidence: { provenance: retailProvenance },
      });
      const retailAlert = db.createAlert({
        email: account.email, accountId: account.id, productId: 'verified-retail-alert', threshold_cents: 2200, status: 'active',
      });
      await mailer.enqueue({
        accountId: account.id, to: account.email, template: 'price-alert',
        metadata: { alertId: retailAlert.id, productId: 'verified-retail-alert', pointAt: retailPointAt, trueCents: 1999 },
        data: { productName: 'Retail item', truePrice: '$19.99', productLink: 'https://app.launch-operator.com/p/verified-retail-alert', unsubscribeLink: 'https://app.launch-operator.com/unsubscribe' },
        idempotencyKey: 'catalog-retail-alert',
      });
      assert.equal(mailer.delivered.at(-1).template, 'price-alert');
    } finally {
      db.close();
      if (savedTransport === undefined) delete process.env.EMAIL_TRANSPORT;
      else process.env.EMAIL_TRANSPORT = savedTransport;
    }
  });
});
