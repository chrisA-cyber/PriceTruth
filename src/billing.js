// Billing — Stripe with zero dependencies. Talks to the Stripe REST API with
// Node 24's global fetch and verifies webhooks with node:crypto HMAC-SHA256,
// exactly as the Stripe SDK does, so dropping in real keys makes it genuinely
// live. With no STRIPE_SECRET_KEY it runs in MOCK mode: the same checkout →
// webhook → entitlement/key-issuance flow works locally and in tests, clearly
// labeled as a simulation so nothing is ever presented as a real charge.

import crypto from 'node:crypto';

const STRIPE_API = 'https://api.stripe.com/v1';

// Plan catalog. amount_cents is used only for the mock ledger + display; in live
// mode the real amount comes from Stripe. priceEnv names the Stripe Price id.
export const PLANS = {
  premium:     { id: 'premium',     kind: 'consumer', label: 'Premium',     price: '$4/month',   amount_cents: 400,   priceEnv: 'STRIPE_PRICE_PREMIUM',     grantsPlan: 'premium' },
  api_starter: { id: 'api_starter', kind: 'api',      label: 'API Starter', price: '$49/month',  amount_cents: 4900,  priceEnv: 'STRIPE_PRICE_API_STARTER', tier: 'starter' },
  api_pro:     { id: 'api_pro',     kind: 'api',      label: 'API Pro',     price: '$399/month', amount_cents: 39900, priceEnv: 'STRIPE_PRICE_API_PRO',     tier: 'pro' },
};

export function mode() {
  return process.env.STRIPE_SECRET_KEY ? 'live' : 'mock';
}

export function getPlan(planId) {
  return Object.hasOwn(PLANS, planId) ? PLANS[planId] : null;
}

// Flatten nested objects/arrays into Stripe's bracketed form encoding.
function formEncode(obj, prefix = '') {
  const parts = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') parts.push(formEncode(v, key));
    else parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return parts.filter(Boolean).join('&');
}

async function stripe(path, params) {
  const res = await fetch(`${STRIPE_API}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: formEncode(params),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data && data.error && data.error.message ? data.error.message : `Stripe HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = 502;
    throw err;
  }
  return data;
}

// Create a checkout session. Returns { url, mock }. In mock mode the url points
// at our own /billing/mock-checkout page that simulates the whole flow.
export async function createCheckout({ planId, email, baseUrl }) {
  const plan = getPlan(planId);
  if (!plan) {
    const err = new Error('unknown plan');
    err.status = 400;
    throw err;
  }
  if (mode() === 'mock') {
    const qs = new URLSearchParams({ plan: plan.id });
    if (email) qs.set('email', email);
    return { url: `${baseUrl}/billing/mock-checkout?${qs.toString()}`, mock: true };
  }
  const priceId = process.env[plan.priceEnv];
  if (!priceId) {
    const err = new Error(`missing ${plan.priceEnv} for plan ${plan.id}`);
    err.status = 500;
    throw err;
  }
  const session = await stripe('/checkout/sessions', {
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${baseUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/pricing?checkout=cancelled`,
    client_reference_id: plan.id,
    metadata: { plan: plan.id },
    ...(email ? { customer_email: email } : {}),
    subscription_data: { metadata: { plan: plan.id } },
    allow_promotion_codes: true,
  });
  return { url: session.url, mock: false };
}

// Create a billing-portal session so a customer can self-serve manage/cancel.
export async function createPortal({ customerId, baseUrl }) {
  if (mode() === 'mock') {
    return { url: `${baseUrl}/billing/mock-portal`, mock: true };
  }
  const session = await stripe('/billing_portal/sessions', {
    customer: customerId,
    return_url: `${baseUrl}/account`,
  });
  return { url: session.url, mock: false };
}

// Verify a Stripe webhook signature (scheme: t=<ts>,v1=<hmac>). Returns the
// parsed event. Throws on a bad/absent signature or stale timestamp.
export function verifyWebhook(rawBody, sigHeader, secret, toleranceSec = 300) {
  if (!secret) {
    const err = new Error('webhook secret not configured');
    err.status = 500;
    throw err;
  }
  const parts = String(sigHeader || '').split(',').reduce((acc, kv) => {
    const i = kv.indexOf('=');
    if (i > 0) acc[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
    return acc;
  }, {});
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !v1) {
    const err = new Error('missing signature');
    err.status = 400;
    throw err;
  }
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`, 'utf8').digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(v1, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    const err = new Error('signature verification failed');
    err.status = 400;
    throw err;
  }
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(t));
  if (!Number.isFinite(age) || age > toleranceSec) {
    const err = new Error('signature timestamp outside tolerance');
    err.status = 400;
    throw err;
  }
  try {
    return JSON.parse(rawBody);
  } catch {
    const err = new Error('invalid webhook JSON');
    err.status = 400;
    throw err;
  }
}

// Sign a payload the way Stripe would — used only by mock mode + tests to
// exercise the real verification path end to end.
export function signPayload(rawBody, secret, timestamp = Math.floor(Date.now() / 1000)) {
  const v1 = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex');
  return `t=${timestamp},v1=${v1}`;
}

// Apply a verified event to the database. Fully idempotent: the billing ledger's
// UNIQUE stripe_ref is the gate, so a replayed event (Stripe delivers at least
// once) is recorded once AND performs its entitlement/key side effects exactly
// once. Returns a summary of what changed (and, for API plans, the session id
// whose key was minted).
export function applyEvent(event, db) {
  if (!event || event.type !== 'checkout.session.completed') {
    return { handled: false, type: event && event.type };
  }
  const session = event.data && event.data.object ? event.data.object : {};
  const planId = (session.metadata && session.metadata.plan) || session.client_reference_id;
  const plan = getPlan(planId);
  if (!plan) return { handled: false, reason: 'unknown plan in session' };

  const email = (session.customer_details && session.customer_details.email) || session.customer_email || null;
  const amount = Number.isInteger(session.amount_total) ? session.amount_total : plan.amount_cents;
  const currency = session.currency || 'usd';
  const livemode = event.livemode ? 1 : 0;

  // Idempotency gate. If this stripe_ref was already recorded, this is a replay:
  // return without granting entitlements or minting another key.
  const firstTime = db.recordBillingEvent({
    type: event.type, email, plan: plan.id, amount_cents: amount, currency, livemode, stripe_ref: event.id,
  });
  if (!firstTime) {
    return { handled: true, duplicate: true, plan: plan.id, email };
  }

  const result = { handled: true, plan: plan.id, email, amount_cents: amount };

  if (plan.kind === 'consumer' && plan.grantsPlan && email) {
    db.upsertAccount({ email, plan: plan.grantsPlan, stripeCustomer: session.customer || null });
    result.granted = plan.grantsPlan;
  } else if (plan.kind === 'api') {
    const raw = db.createApiKey(email ? `checkout:${email}` : `checkout:${plan.id}`, plan.tier, {
      ownerEmail: email, stripeRef: session.subscription || session.id || event.id,
    });
    if (session.id) db.putPendingKey(session.id, raw, plan.tier);
    if (email) {
      // Distinct entitlements share one accounts row: API access is granted by
      // the api_keys row above, not by accounts.plan, so buying API must never
      // clobber an existing 'premium' plan (which drives the alert paywall).
      const existing = db.getAccount(email);
      const acctPlan = existing && existing.plan === 'premium' ? 'premium' : 'api';
      db.upsertAccount({ email, plan: acctPlan, stripeCustomer: session.customer || null });
    }
    result.apiKeyIssued = true;
    result.tier = plan.tier;
  }
  return result;
}

// Build a synthetic checkout.session.completed event (mock mode + tests).
export function mockCompletedEvent({ planId, email, sessionId, amount_cents }) {
  const plan = getPlan(planId);
  return {
    id: `evt_mock_${sessionId}`,
    type: 'checkout.session.completed',
    livemode: false,
    data: {
      object: {
        id: sessionId,
        object: 'checkout.session',
        mode: 'subscription',
        amount_total: Number.isInteger(amount_cents) ? amount_cents : (plan ? plan.amount_cents : 0),
        currency: 'usd',
        customer: `cus_mock_${sessionId}`,
        customer_email: email || null,
        customer_details: email ? { email } : null,
        client_reference_id: planId,
        metadata: { plan: planId },
        subscription: `sub_mock_${sessionId}`,
      },
    },
  };
}
