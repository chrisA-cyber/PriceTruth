import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../src/server.js';

async function startApp(dbPath) {
  const mailer = {
    readiness: () => ({ ok: true, transport: 'resend' }),
    enqueue: async () => ({ status: 'queued' }),
    processPending: async () => ({ processed: 0 }),
  };
  const created = createApp({ dbPath, mailer, priceCatalogVerification: { ok: true } });
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

function request(app, route, { method = 'GET', cookie, csrf, body, origin = app.base } = {}) {
  return fetch(app.base + route, {
    method,
    redirect: 'manual',
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(csrf ? { 'x-csrf-token': csrf } : {}),
      ...(origin ? { origin } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe('checkout return frontend-to-live-handler contract', () => {
  let app;
  let saved;
  let owner;
  let stranger;
  let dbPath;

  before(async () => {
    const config = {
      ENABLE_LIVE_BILLING: '1',
      ENABLE_DEMO_SEED: '0',
      STRIPE_SECRET_KEY: 'sk_live_frontendcontract123456',
      STRIPE_AUTOMATIC_TAX: '1',
      STRIPE_WEBHOOK_SECRET: 'whsec_frontendcontract123456',
      STRIPE_PRICE_PREMIUM: 'price_premiumcontract123',
      STRIPE_PRICE_API_STARTER: 'price_startercontract123',
      STRIPE_PRICE_API_PRO: 'price_procontract123456',
      STRIPE_PRODUCT_PREMIUM: 'prod_premiumcontract123',
      STRIPE_PRODUCT_API_STARTER: 'prod_startercontract123',
      STRIPE_PRODUCT_API_PRO: 'prod_procontract123456',
      PUBLIC_BASE_URL: 'https://checkout.launch-operator.com',
      EMAIL_TRANSPORT: 'resend',
      RESEND_API_KEY: 're_frontendcontract123456',
      EMAIL_FROM: 'PriceTruth <service@launch-operator.com>',
      OUTBOX_ENCRYPTION_KEY: 'checkout-contract-outbox-key-32-characters-minimum',
      RESEND_WEBHOOK_SECRET: 'checkout-contract-webhook-secret-24-minimum',
      LEGAL_OPERATOR_NAME: 'Checkout Contract Operator',
      LEGAL_JURISDICTION: 'Checkout Contract Jurisdiction',
      SUPPORT_CONTACT_EMAIL: 'support@launch-operator.com',
      LEGAL_EFFECTIVE_DATE: '2026-08-25',
      LEGAL_TERMS_VERSION: '2026-08-25-v1',
      LEGAL_APPROVED: '1',
      ENABLE_ACCOUNTS: '1',
      ADMIN_TOKEN: 'R8vQ2xL7sK9wT5yC3fH6jP1dZ0uBaG4mN',
      LAUNCH_VERTICALS: 'subscription',
      NODE_ENV: 'production',
    };
    saved = Object.fromEntries(Object.keys(config).concat(['DISABLE_WORKER', 'PRICETRUTH_DB'])
      .map((key) => [key, process.env[key]]));
    for (const [key, value] of Object.entries(config)) process.env[key] = value;
    delete process.env.DISABLE_WORKER;
    dbPath = path.join(os.tmpdir(), `pricetruth-checkout-contract-${process.pid}-${Date.now()}.sqlite`);
    process.env.PRICETRUTH_DB = dbPath;
    // Valid-looking launch configuration selects the live handler branches.
    // Completed webhook state is seeded directly; this test never contacts Stripe.
    app = await startApp(dbPath);

    const ownerAccount = app.db.verifyAccount(app.db.getOrCreateAccount('checkout-owner@example.test').id);
    const strangerAccount = app.db.verifyAccount(app.db.getOrCreateAccount('checkout-stranger@example.test').id);
    const ownerSession = app.db.createSession(ownerAccount.id);
    const strangerSession = app.db.createSession(strangerAccount.id);
    owner = {
      account: ownerAccount,
      session: ownerSession,
      cookie: `pt_session=${ownerSession.token}; pt_csrf=${ownerSession.csrfToken}`,
    };
    stranger = {
      account: strangerAccount,
      session: strangerSession,
      cookie: `pt_session=${strangerSession.token}; pt_csrf=${strangerSession.csrfToken}`,
    };

    const sessionId = 'cs_live_owned_api_123';
    const rawKey = app.db.createApiKey('checkout-contract', 'starter', {
      ownerEmail: ownerAccount.email,
      ownerAccountId: ownerAccount.id,
      stripeRef: sessionId,
    });
    app.db.putPendingKey(sessionId, rawKey, 'starter', ownerAccount.id);
    app.db.registerCheckoutClaim({
      sessionId, accountId: ownerAccount.id, plan: 'api_starter', tier: 'starter', status: 'claimable',
    });
    app.db.registerCheckoutClaim({
      sessionId: 'cs_live_consumer_123', accountId: ownerAccount.id, plan: 'premium', status: 'complete',
    });
  });

  after(async () => {
    await stopApp(app);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (dbPath && path.dirname(dbPath) === os.tmpdir()) fs.rmSync(dbPath, { force: true });
  });

  it('publishes and durably records the exact accepted terms version before checkout', async () => {
    const metaResponse = await request(app, '/api/meta', { origin: null });
    assert.equal(metaResponse.status, 200);
    const meta = await metaResponse.json();
    assert.equal(meta.legal.termsVersion, '2026-08-25-v1');
    assert.equal(meta.legal.approved, true);

    const common = {
      method: 'POST', cookie: owner.cookie, csrf: owner.session.csrfToken,
      origin: process.env.PUBLIC_BASE_URL,
    };
    assert.equal((await request(app, '/api/billing/checkout', { ...common, body: { planId: 'premium' } })).status, 400);
    assert.equal((await request(app, '/api/billing/checkout', {
      ...common, body: { planId: 'premium', acceptTerms: true, acceptedTermsVersion: 'old-version' },
    })).status, 400);
    assert.deepEqual(app.db.listTermsAcceptances(owner.account.id), []);

    app.db.recordBillingReconciliation({
      eventId: 'evt_checkout_gate_pending', eventType: 'invoice.paid', reason: 'test unresolved mapping',
      payload: { accountId: owner.account.id },
    });
    const gatedMeta = await (await request(app, '/api/meta', { origin: null })).json();
    assert.equal(gatedMeta.capabilities.billing, false);
    const gated = await request(app, '/api/billing/checkout', {
      ...common, body: { planId: 'premium', acceptTerms: true, acceptedTermsVersion: '2026-08-25-v1' },
    });
    assert.equal(gated.status, 503);
    assert.equal((await gated.json()).code, 'BILLING_NOT_READY');
    app.db.resolveBillingReconciliation('evt_checkout_gate_pending');
    assert.equal(app.db.linkStripeCustomer(owner.account.id, 'cus_contract_owner123'), true);

    const realFetch = globalThis.fetch;
    let checkoutRequestBody = '';
    globalThis.fetch = async (input, init) => {
      if (String(input).startsWith('https://api.stripe.com/v1/checkout/sessions')) {
        checkoutRequestBody = String(init.body || '');
        return new Response(JSON.stringify({
          id: 'cs_live_terms_acceptance_123', url: 'https://checkout.stripe.test/session/terms',
          expires_at: Math.floor(Date.now() / 1000) + 1800, payment_status: 'unpaid',
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return realFetch(input, init);
    };
    try {
      const response = await request(app, '/api/billing/checkout', {
        ...common,
        body: { planId: 'premium', acceptTerms: true, acceptedTermsVersion: '2026-08-25-v1' },
      });
      assert.equal(response.status, 200, await response.text());
    } finally {
      globalThis.fetch = realFetch;
    }
    const [acceptance] = app.db.listTermsAcceptances(owner.account.id);
    assert.equal(acceptance.termsVersion, '2026-08-25-v1');
    assert.deepEqual(acceptance.context, { source: 'live-checkout', planId: 'premium' });
    assert.equal(app.db.raw.prepare('SELECT terms_version FROM checkout_intents WHERE account_id=? AND plan=?').get(owner.account.id, 'premium').terms_version, '2026-08-25-v1');
    const checkoutParams = new URLSearchParams(checkoutRequestBody);
    assert.equal(checkoutParams.get('automatic_tax[enabled]'), 'true');
    assert.equal(checkoutParams.get('billing_address_collection'), 'required');
    assert.equal(checkoutParams.get('customer'), 'cus_contract_owner123');
    assert.equal(checkoutParams.get('customer_update[address]'), 'auto');
  });

  it('serializes cross-plan checkout and blocks every recoverable subscription state', async () => {
    const makeOwner = (email) => {
      const account = app.db.verifyAccount(app.db.getOrCreateAccount(email).id);
      const session = app.db.createSession(account.id);
      return { account, session, cookie: `pt_session=${session.token}; pt_csrf=${session.csrfToken}` };
    };
    const fresh = makeOwner('serialized-checkout@example.test');
    const common = {
      method: 'POST', cookie: fresh.cookie, csrf: fresh.session.csrfToken,
      origin: process.env.PUBLIC_BASE_URL,
    };
    const realFetch = globalThis.fetch;
    let stripeCalls = 0;
    let firstBody = '';
    globalThis.fetch = async (input, init) => {
      if (String(input).startsWith('https://api.stripe.com/v1/checkout/sessions')) {
        stripeCalls += 1;
        firstBody ||= String(init.body || '');
        return new Response(JSON.stringify({
          id: `cs_live_serialized_${stripeCalls}`, url: `https://checkout.stripe.test/session/${stripeCalls}`,
          expires_at: Math.floor(Date.now() / 1000) + 1800, payment_status: 'unpaid',
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return realFetch(input, init);
    };
    try {
      const first = await request(app, '/api/billing/checkout', {
        ...common, body: { planId: 'premium', acceptTerms: true, acceptedTermsVersion: '2026-08-25-v1' },
      });
      assert.equal(first.status, 200, await first.text());
      assert.equal(new URLSearchParams(firstBody).get('customer_email'), fresh.account.email);
      assert.equal(app.db.getAccountById(fresh.account.id).stripe_customer, null);

      const concurrent = await request(app, '/api/billing/checkout', {
        ...common, body: { planId: 'api_starter', acceptTerms: true, acceptedTermsVersion: '2026-08-25-v1' },
      });
      assert.equal(concurrent.status, 409);
      assert.equal((await concurrent.json()).code, 'CHECKOUT_PENDING');
      assert.equal(stripeCalls, 1, 'a second Stripe Customer/session must not be created');

      const recovering = makeOwner('recovering-subscription@example.test');
      app.db.upsertEntitlement({
        accountId: recovering.account.id, product: 'premium', status: 'past_due',
        sourceRef: 'sub_recovering_premium', eventCreated: 10,
      });
      const blocked = await request(app, '/api/billing/checkout', {
        method: 'POST', cookie: recovering.cookie, csrf: recovering.session.csrfToken,
        origin: process.env.PUBLIC_BASE_URL,
        body: { planId: 'premium', acceptTerms: true, acceptedTermsVersion: '2026-08-25-v1' },
      });
      assert.equal(blocked.status, 409);
      assert.equal((await blocked.json()).code, 'ACTIVE_SUBSCRIPTION');
      assert.equal(stripeCalls, 1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('disables advertised billing and checkout when a launch data source becomes unusable', async () => {
    const previousMaxAge = process.env.SUBSCRIPTION_CATALOG_MAX_AGE_DAYS;
    const realFetch = globalThis.fetch;
    let stripeCalls = 0;
    process.env.SUBSCRIPTION_CATALOG_MAX_AGE_DAYS = 'not-a-number';
    globalThis.fetch = async (input, init) => {
      if (String(input).startsWith('https://api.stripe.com/')) {
        stripeCalls += 1;
        throw new Error('Stripe must not be called while a launch data source is unavailable');
      }
      return realFetch(input, init);
    };
    try {
      const metaResponse = await request(app, '/api/meta', { origin: null });
      assert.equal(metaResponse.status, 200);
      const meta = await metaResponse.json();
      assert.equal(meta.subscriptionCatalog.freshness.ok, false);
      assert.equal(meta.capabilities.billing, false);
      assert.equal(meta.searchVerticals.includes('subscription'), false);
      assert.equal(meta.readiness.ok, false);

      const response = await request(app, '/api/billing/checkout', {
        method: 'POST', cookie: owner.cookie, csrf: owner.session.csrfToken,
        origin: process.env.PUBLIC_BASE_URL,
        body: { planId: 'premium', acceptTerms: true, acceptedTermsVersion: '2026-08-25-v1' },
      });
      assert.equal(response.status, 503);
      assert.equal((await response.json()).code, 'BILLING_NOT_READY');
      assert.equal(stripeCalls, 0);
    } finally {
      globalThis.fetch = realFetch;
      if (previousMaxAge === undefined) delete process.env.SUBSCRIPTION_CATALOG_MAX_AGE_DAYS;
      else process.env.SUBSCRIPTION_CATALOG_MAX_AGE_DAYS = previousMaxAge;
    }
  });

  it('keeps pending and consumer status non-consuming and account-owned', async () => {
    const anonymous = await request(app, '/api/billing/checkout/status?session_id=cs_live_unknown_123', { origin: null });
    assert.equal(anonymous.status, 401);

    const pending = await request(app, '/api/billing/checkout/status?session_id=cs_live_unknown_123', {
      cookie: owner.cookie, origin: null,
    });
    assert.equal(pending.status, 202);
    assert.deepEqual(await pending.json(), {
      status: 'pending', complete: false, claimable: false, plan: null, tier: null,
    });

    const consumer = await request(app, '/api/billing/checkout/status?session_id=cs_live_consumer_123', {
      cookie: owner.cookie, origin: null,
    });
    assert.equal(consumer.status, 200);
    assert.deepEqual(await consumer.json(), {
      status: 'complete', complete: true, claimable: false, plan: 'premium', tier: null,
    });

    const wrongOwner = await request(app, '/api/billing/checkout/status?session_id=cs_live_consumer_123', {
      cookie: stranger.cookie, origin: null,
    });
    assert.equal(wrongOwner.status, 404);
  });

  it('keeps paid claim and portal ownership enforced while billing is disabled', async () => {
    const savedFlag = process.env.ENABLE_LIVE_BILLING;
    const savedSecret = process.env.STRIPE_SECRET_KEY;
    const sessionId = 'cs_disabled_incident_123';
    const rawKey = app.db.createApiKey('Incident-safe claim', 'starter', {
      ownerEmail: owner.account.email, ownerAccountId: owner.account.id, stripeRef: sessionId,
    });
    app.db.putPendingKey(sessionId, rawKey, 'starter', owner.account.id);
    app.db.registerCheckoutClaim({
      sessionId, accountId: owner.account.id, plan: 'api_starter', tier: 'starter', status: 'claimable',
    });
    process.env.ENABLE_LIVE_BILLING = '0';
    delete process.env.STRIPE_SECRET_KEY;
    try {
      assert.equal((await request(app, `/api/billing/checkout/status?session_id=${sessionId}`, { origin: null })).status, 401);
      assert.equal((await request(app, '/api/billing/claim', { method: 'POST', body: { session_id: sessionId } })).status, 401);
      assert.equal((await request(app, '/api/billing/claim', {
        method: 'POST', cookie: stranger.cookie, csrf: stranger.session.csrfToken,
        origin: process.env.PUBLIC_BASE_URL, body: { session_id: sessionId },
      })).status, 404);
      assert.equal((await request(app, '/api/billing/portal', {
        method: 'POST', body: { email: owner.account.email }, origin: process.env.PUBLIC_BASE_URL,
      })).status, 401, 'disabled mode must not fall back to email lookup');
      assert.equal((await request(app, '/api/billing/webhook', { method: 'POST', body: {} })).status, 503);

      const claimed = await request(app, '/api/billing/claim', {
        method: 'POST', cookie: owner.cookie, csrf: owner.session.csrfToken,
        origin: process.env.PUBLIC_BASE_URL, body: { session_id: sessionId },
      });
      assert.equal(claimed.status, 200);
      assert.equal((await claimed.json()).key, rawKey);
    } finally {
      if (savedFlag === undefined) delete process.env.ENABLE_LIVE_BILLING; else process.env.ENABLE_LIVE_BILLING = savedFlag;
      if (savedSecret === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = savedSecret;
    }
  });

  it('requires owner session, same origin, and CSRF before revealing one-time API key', async () => {
    const route = '/api/billing/claim';
    const body = { session_id: 'cs_live_owned_api_123' };

    assert.equal((await request(app, route, { method: 'POST', body })).status, 401);
    assert.equal((await request(app, route, { method: 'POST', cookie: owner.cookie, body })).status, 403);
    assert.equal((await request(app, route, {
      method: 'POST', cookie: owner.cookie, csrf: owner.session.csrfToken, origin: 'https://foreign.example', body,
    })).status, 403);
    const wrongOwner = await request(app, route, {
      method: 'POST', cookie: stranger.cookie, csrf: stranger.session.csrfToken,
      origin: process.env.PUBLIC_BASE_URL, body,
    });
    const wrongOwnerBody = await wrongOwner.json();
    assert.equal(wrongOwner.status, 404, JSON.stringify(wrongOwnerBody));

    const claim = await request(app, route, {
      method: 'POST', cookie: owner.cookie, csrf: owner.session.csrfToken,
      origin: process.env.PUBLIC_BASE_URL, body,
    });
    assert.equal(claim.status, 200);
    const revealed = await claim.json();
    assert.equal(revealed.status, 'claimed');
    assert.equal(revealed.plan, 'api_starter');
    assert.equal(revealed.tier, 'starter');
    assert.match(revealed.key, /^pt_starter_/);

    const status = await request(app, '/api/billing/checkout/status?session_id=cs_live_owned_api_123', {
      cookie: owner.cookie, origin: null,
    });
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), {
      status: 'claimed', complete: true, claimable: false, plan: 'api_starter', tier: 'starter',
    });

    const second = await request(app, route, {
      method: 'POST', cookie: owner.cookie, csrf: owner.session.csrfToken,
      origin: process.env.PUBLIC_BASE_URL, body,
    });
    assert.equal(second.status, 409);
  });
});
