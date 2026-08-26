// Billing — Stripe with zero dependencies. Talks to the Stripe REST API with
// Node 24's global fetch and verifies webhooks with node:crypto HMAC-SHA256,
// exactly as the Stripe SDK does. Live commerce is deliberately fail-closed:
// the explicit enable flag, verified Stripe catalog, webhook, tax, legal,
// email, worker, and durable-storage checks must all pass. With live billing
// disabled, non-production runs in MOCK mode so the same checkout → webhook
// → entitlement/key-issuance flow can be exercised locally and in tests.

import crypto from 'node:crypto';
import path from 'node:path';
import { isPublicHostname } from './security.js';

const STRIPE_API = 'https://api.stripe.com/v1';

// Plan catalog. amount_cents is used only for the mock ledger + display; in live
// mode the real amount comes from Stripe. priceEnv names the Stripe Price id.
export const PLANS = {
  premium:     { id: 'premium',     kind: 'consumer', label: 'Premium',     price: '$4/month',   amount_cents: 400,   priceEnv: 'STRIPE_PRICE_PREMIUM',     productEnv: 'STRIPE_PRODUCT_PREMIUM',     lookupKey: 'pricetruth_premium_monthly', grantsPlan: 'premium' },
  api_starter: { id: 'api_starter', kind: 'api',      label: 'API Starter', price: '$49/month',  amount_cents: 4900,  priceEnv: 'STRIPE_PRICE_API_STARTER', productEnv: 'STRIPE_PRODUCT_API_STARTER', lookupKey: 'pricetruth_api_starter_monthly', tier: 'starter' },
  api_pro:     { id: 'api_pro',     kind: 'api',      label: 'API Pro',     price: '$399/month', amount_cents: 39900, priceEnv: 'STRIPE_PRICE_API_PRO',     productEnv: 'STRIPE_PRODUCT_API_PRO',     lookupKey: 'pricetruth_api_pro_monthly', tier: 'pro' },
};

export function mode() {
  const optedIn = process.env.ENABLE_LIVE_BILLING === '1';
  const hasSecret = Boolean(process.env.STRIPE_SECRET_KEY);
  const validLiveSecret = /^sk_live_[A-Za-z0-9_]{12,}$/.test(process.env.STRIPE_SECRET_KEY || '');
  if (optedIn && validLiveSecret) return 'live';
  // A partial/mismatched live configuration must never silently fall back to
  // mock billing. readiness() reports the mismatch and production startup
  // refuses it.
  if (optedIn || hasSecret) return 'disabled';
  return process.env.NODE_ENV === 'production' ? 'disabled' : 'mock';
}

function httpsOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && isPublicHostname(url.hostname) && !url.username && !url.password &&
      (url.pathname === '' || url.pathname === '/') && !url.search && !url.hash;
  } catch { return false; }
}

function publicEmailAddress(value, { displayName = false } = {}) {
  const clean = String(value || '').trim();
  const bracketed = clean.match(/^.{1,100}<([^<>]+)>$/);
  if (bracketed && !displayName) return false;
  const address = bracketed ? bracketed[1].trim() : clean;
  const match = address.match(/^[^\s@<>]{1,64}@([A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?)$/);
  return Boolean(match && isPublicHostname(match[1]));
}

function senderAddress(value) {
  return publicEmailAddress(value, { displayName: true });
}

function legalText(value) {
  const clean = String(value || '').trim();
  return clean.length >= 2 && clean.length <= 160 && !/^(?:tbd|todo|placeholder|your\b|example\b|unknown\b)/i.test(clean);
}

function legalTermsVersion(value) {
  const clean = String(value || '').trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(clean) &&
    !/^(?:tbd|todo|placeholder|example|unknown|latest|current)$/i.test(clean);
}

function adminTokenConfigured(value) {
  const token = String(value || '');
  return token.length >= 32 && token.length <= 512 && /^[\x21-\x7E]+$/.test(token) &&
    new Set(token).size >= 8 && !/(?:changeme|password|placeholder|example|admin[_-]?token|test[_-]?token)/i.test(token);
}

function supportContact() {
  const url = process.env.SUPPORT_CONTACT_URL;
  if (url) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'https:' && !parsed.username && !parsed.password && isPublicHostname(parsed.hostname);
    } catch { return false; }
  }
  return publicEmailAddress(process.env.SUPPORT_CONTACT_EMAIL);
}

// A Stripe secret alone is not enough to accept money safely. The launch gate
// is opt-in so local/demo mode remains useful, while ENABLE_LIVE_BILLING=1
// refuses startup until the complete lifecycle can be handled durably.
export function readiness({ email = { ok: true }, database = null, priceCatalog = null } = {}) {
  const required = process.env.ENABLE_LIVE_BILLING === '1' || Boolean(process.env.STRIPE_SECRET_KEY) ||
    (process.env.NODE_ENV === 'production' && Boolean(process.env.STRIPE_WEBHOOK_SECRET));
  const effectiveDate = process.env.LEGAL_EFFECTIVE_DATE || '';
  const parsedEffectiveDate = /^\d{4}-\d{2}-\d{2}$/.test(effectiveDate) ? Date.parse(`${effectiveDate}T00:00:00Z`) : NaN;
  const checks = {
    liveBillingEnabled: process.env.ENABLE_LIVE_BILLING === '1',
    // Paid fulfillment may never coexist with synthetic demo inventory.
    // Requiring an explicit zero also prevents an omitted deployment setting
    // from silently changing behavior across platforms.
    demoSeedDisabled: process.env.ENABLE_DEMO_SEED === '0',
    accountsEnabled: process.env.ENABLE_ACCOUNTS === '1',
    adminToken: adminTokenConfigured(process.env.ADMIN_TOKEN),
    stripeAutomaticTax: process.env.STRIPE_AUTOMATIC_TAX === '1',
    stripeSecret: /^sk_live_[A-Za-z0-9_]{12,}$/.test(process.env.STRIPE_SECRET_KEY || ''),
    webhookSecret: /^whsec_[A-Za-z0-9_]{12,}$/.test(process.env.STRIPE_WEBHOOK_SECRET || ''),
    premiumPrice: /^price_[A-Za-z0-9_]{8,}$/.test(process.env.STRIPE_PRICE_PREMIUM || ''),
    apiStarterPrice: /^price_[A-Za-z0-9_]{8,}$/.test(process.env.STRIPE_PRICE_API_STARTER || ''),
    apiProPrice: /^price_[A-Za-z0-9_]{8,}$/.test(process.env.STRIPE_PRICE_API_PRO || ''),
    premiumProduct: /^prod_[A-Za-z0-9_]{8,}$/.test(process.env.STRIPE_PRODUCT_PREMIUM || ''),
    apiStarterProduct: /^prod_[A-Za-z0-9_]{8,}$/.test(process.env.STRIPE_PRODUCT_API_STARTER || ''),
    apiProProduct: /^prod_[A-Za-z0-9_]{8,}$/.test(process.env.STRIPE_PRODUCT_API_PRO || ''),
    priceCatalogVerified: priceCatalog?.ok === true,
    publicHttps: httpsOrigin(process.env.PUBLIC_BASE_URL || ''),
    durableDbConfigured: database?.storage === 'postgres' || Boolean(
      process.env.PRICETRUTH_DB && path.isAbsolute(process.env.PRICETRUTH_DB) && process.env.PRICETRUTH_DB !== ':memory:' &&
      (!database || database.storage !== 'memory')
    ),
    transactionalEmail: Boolean(email.ok && email.transport === 'resend'),
    resendApiKey: /^re_[A-Za-z0-9_-]{12,}$/.test(process.env.RESEND_API_KEY || ''),
    emailFrom: senderAddress(process.env.EMAIL_FROM),
    outboxEncryption: String(process.env.OUTBOX_ENCRYPTION_KEY || '').length >= 32,
    emailWebhookSecret: String(process.env.RESEND_WEBHOOK_SECRET || '').length >= 24,
    workerEnabled: process.env.DISABLE_WORKER !== '1',
    workerDispatchSecret: process.env.WORKER_MODE !== 'netlify-background' || String(process.env.WORKER_DISPATCH_SECRET || '').length >= 32,
    legalOperator: legalText(process.env.LEGAL_OPERATOR_NAME),
    legalJurisdiction: legalText(process.env.LEGAL_JURISDICTION),
    legalSupport: supportContact(),
    legalEffectiveDate: Number.isFinite(parsedEffectiveDate) && parsedEffectiveDate <= Date.now(),
    legalApproved: process.env.LEGAL_APPROVED === '1',
    legalTermsVersion: legalTermsVersion(process.env.LEGAL_TERMS_VERSION),
  };
  const missing = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  return { ok: !required || missing.length === 0, required, mode: mode(), checks, missing };
}

// Verify the configured Stripe catalog against live provider objects before a
// paid process starts. The returned summary contains plan names and check
// labels only; it never exposes keys, Price ids, or Product ids.
export async function verifyLivePriceCatalog({ env = process.env, fetchImpl = fetch } = {}) {
  const checkedAt = new Date().toISOString();
  const timeoutMs = Math.min(30_000, Math.max(1_000, Number(env.STRIPE_TIMEOUT_MS) || 10_000));
  const verifyPlan = async (plan) => {
    const failures = [];
    const priceId = env[plan.priceEnv], expectedProduct = env[plan.productEnv];
    if (!/^price_[A-Za-z0-9_]{8,}$/.test(priceId || '')) failures.push('price-id');
    if (!/^prod_[A-Za-z0-9_]{8,}$/.test(expectedProduct || '')) failures.push('product-id');
    if (failures.length) return { plan: plan.id, ok: false, failures };
    let response, price;
    try {
      const url = `${STRIPE_API}/prices/${encodeURIComponent(priceId)}?expand%5B%5D=product`;
      response = await fetchImpl(url, { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` }, signal: AbortSignal.timeout(timeoutMs) });
      price = await response.json().catch(() => ({}));
    } catch {
      return { plan: plan.id, ok: false, failures: ['provider-unreachable'] };
    }
    if (!response.ok) failures.push('provider-rejected');
    if (price?.object !== 'price' || price.active !== true) failures.push('price-active');
    if (price?.livemode !== true) failures.push('price-live');
    if (String(price?.currency || '').toLowerCase() !== 'usd') failures.push('currency');
    if (price?.type !== 'recurring' || price?.recurring?.interval !== 'month' || Number(price?.recurring?.interval_count) !== 1) failures.push('monthly-recurring');
    if (price?.unit_amount !== plan.amount_cents) failures.push('amount');
    if (price?.lookup_key !== plan.lookupKey) failures.push('lookup-key');
    const product = typeof price?.product === 'object' ? price.product : null;
    if (!product || product.id !== expectedProduct || product.active !== true || product.livemode !== true) failures.push('product-mapping');
    return { plan: plan.id, ok: failures.length === 0, failures: [...new Set(failures)] };
  };
  const plans = await Promise.all(Object.values(PLANS).map(verifyPlan));
  return { ok: plans.every((entry) => entry.ok), checkedAt, plans };
}

export function getPlan(planId) {
  return Object.hasOwn(PLANS, planId) ? PLANS[planId] : null;
}

export function entitlementProduct(planId) {
  const plan = getPlan(planId);
  return plan ? (plan.kind === 'consumer' ? plan.grantsPlan : `api:${plan.tier}`) : null;
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

async function stripe(pathname, params, { idempotencyKey = null } = {}) {
  const timeoutMs = Math.min(30_000, Math.max(1_000, Number(process.env.STRIPE_TIMEOUT_MS) || 10_000));
  const headers = {
    Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  let res;
  try {
    res = await fetch(`${STRIPE_API}${pathname}`, {
      method: 'POST',
      headers,
      body: formEncode(params),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    const err = new Error(`Stripe request failed: ${cause?.name === 'TimeoutError' ? 'timeout' : 'network error'}`);
    err.status = 502;
    throw err;
  }
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
export async function createCheckout({ planId, email, accountId = null, customerId = null, baseUrl, idempotencyKey = null }) {
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
  if (mode() === 'disabled') {
    const err = new Error('billing is not enabled on this deployment');
    err.status = 503;
    throw err;
  }
  const priceId = process.env[plan.priceEnv];
  if (!priceId) {
    const err = new Error(`missing ${plan.priceEnv} for plan ${plan.id}`);
    err.status = 500;
    throw err;
  }
  if (process.env.STRIPE_AUTOMATIC_TAX !== '1') {
    const err = new Error('live checkout requires the approved automatic-tax configuration');
    err.status = 503;
    throw err;
  }
  const session = await stripe('/checkout/sessions', {
    mode: 'subscription',
    payment_method_types: ['card'],
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${baseUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/pricing?checkout=cancelled`,
    client_reference_id: plan.id,
    metadata: { plan: plan.id, ...(accountId ? { account_id: accountId } : {}) },
    ...(customerId ? { customer: customerId } : email ? { customer_email: email } : {}),
    automatic_tax: { enabled: true },
    billing_address_collection: 'required',
    ...(customerId ? { customer_update: { address: 'auto' } } : {}),
    ...(plan.kind === 'api' ? { tax_id_collection: { enabled: true } } : {}),
    subscription_data: { metadata: { plan: plan.id, ...(accountId ? { account_id: accountId, email } : {}) } },
    allow_promotion_codes: true,
  }, { idempotencyKey });
  return {
    url: session.url, id: session.id || null, mock: false,
    expiresAt: Number.isInteger(session.expires_at) ? new Date(session.expires_at * 1000).toISOString() : null,
    paymentStatus: typeof session.payment_status === 'string' ? session.payment_status : null,
  };
}

// Create a billing-portal session so a customer can self-serve manage/cancel.
export async function createPortal({ customerId, baseUrl }) {
  if (mode() === 'mock') {
    return { url: `${baseUrl}/billing/mock-portal`, mock: true };
  }
  if (mode() === 'disabled') {
    const err = new Error('billing is not enabled on this deployment');
    err.status = 503;
    throw err;
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
    if (i > 0) {
      const key = kv.slice(0, i).trim(), value = kv.slice(i + 1).trim();
      if (!acc[key]) acc[key] = [];
      acc[key].push(value);
    }
    return acc;
  }, {});
  const t = parts.t?.[0];
  const signatures = parts.v1 || [];
  if (!t || signatures.length === 0) {
    const err = new Error('missing signature');
    err.status = 400;
    throw err;
  }
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`, 'utf8').digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const valid = signatures.some((candidate) => {
    const b = Buffer.from(candidate, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
  if (!valid) {
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
const SUBSCRIPTION_EVENTS = new Set([
  'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted',
  'customer.subscription.paused', 'customer.subscription.resumed',
]);
const INVOICE_EVENTS = new Set(['invoice.paid', 'invoice.payment_succeeded', 'invoice.payment_failed']);
const CHECKOUT_EVENTS = new Set([
  'checkout.session.completed', 'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed', 'checkout.session.expired',
]);
const DISPUTE_EVENTS = new Set(['charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed']);
const REFUND_AUDIT_EVENTS = new Set(['refund.created', 'refund.updated', 'refund.failed']);
const CRITICAL_EVENTS = new Set([
  ...SUBSCRIPTION_EVENTS, ...INVOICE_EVENTS, ...CHECKOUT_EVENTS, ...DISPUTE_EVENTS,
  ...REFUND_AUDIT_EVENTS, 'charge.refunded',
]);

// Related Stripe event ids can describe the same immutable business object
// (for example invoice.paid + invoice.payment_succeeded, or successive
// cumulative charge.refunded events). Take exactly one canonical lock per
// event so read/compute/write decisions serialize without multi-lock ordering
// hazards. The Postgres adapter implements this as a transaction-scoped
// advisory lock; SQLite is already serialized by its guarded connection.
function billingObjectLock(event) {
  const object = event?.data?.object;
  if (!object || typeof object !== 'object') return null;
  if (INVOICE_EVENTS.has(event.type) && typeof object.id === 'string') {
    return { scope: 'invoice', objectId: object.id };
  }
  if (event.type === 'charge.refunded' && typeof object.id === 'string') {
    return { scope: 'charge', objectId: object.id };
  }
  if (REFUND_AUDIT_EVENTS.has(event.type)) {
    if (typeof object.charge === 'string') return { scope: 'charge', objectId: object.charge };
    if (typeof object.id === 'string') return { scope: 'refund', objectId: object.id };
  }
  if (DISPUTE_EVENTS.has(event.type) && typeof object.id === 'string') {
    return { scope: 'dispute', objectId: object.id };
  }
  if (SUBSCRIPTION_EVENTS.has(event.type) && typeof object.id === 'string') {
    return { scope: 'subscription', objectId: object.id };
  }
  if (CHECKOUT_EVENTS.has(event.type) && typeof object.id === 'string') {
    return { scope: 'checkout', objectId: object.id };
  }
  return null;
}

export async function applyEvent(event, db) {
  return db.transaction(async () => {
    const objectLock = billingObjectLock(event);
    if (objectLock) await db.lockBillingObject(objectLock.scope, objectLock.objectId);
    const result = await applyEventTransaction(event, db);
    const critical = Boolean(event?.livemode) && CRITICAL_EVENTS.has(event?.type);
    if (result.handled) await db.resolveBillingReconciliation(event.id);
    else if (critical && result.reason !== 'awaiting asynchronous payment confirmation') {
      const reconciliation = await db.recordBillingReconciliation({ eventId: event.id, eventType: event.type, reason: result.reason || 'event could not be mapped', payload: billingPayload(event) });
      return { ...result, retryable: true, reconciliationId: reconciliation.event_id };
    }
    return result;
  });
}

async function applyEventTransaction(event, db) {
  if (!event || typeof event.type !== 'string' || typeof event.id !== 'string') return { handled: false, type: event && event.type };
  if (event.type.startsWith('customer.subscription.')) {
    return SUBSCRIPTION_EVENTS.has(event.type) ? await applySubscriptionEvent(event, db) : { handled: true, ignored: true, type: event.type };
  }
  if (event.type.startsWith('invoice.')) {
    return INVOICE_EVENTS.has(event.type) ? await applyInvoiceEvent(event, db) : { handled: true, ignored: true, type: event.type };
  }
  if (event.type === 'charge.refunded') return applyRefundEvent(event, db);
  if (DISPUTE_EVENTS.has(event.type)) return applyDisputeEvent(event, db);
  if (event.type.startsWith('refund.')) {
    return REFUND_AUDIT_EVENTS.has(event.type) ? await applyRefundAuditEvent(event, db) : { handled: true, ignored: true, type: event.type };
  }
  if (['checkout.session.expired', 'checkout.session.async_payment_failed'].includes(event.type) ||
      (event.type === 'checkout.session.completed' && event.data?.object?.payment_status === 'unpaid')) {
    const session = event.data?.object || {};
    const plan = getPlan(session?.metadata?.plan || session.client_reference_id);
    const account = await accountForObject(session, db, { enforceCustomer: Boolean(event.livemode) });
    const deleted = !account && await db.getDeletedAccountForBilling({ accountId: session?.metadata?.account_id, customerId: session.customer });
    if (deleted && typeof session.id === 'string') {
      const first = await db.recordBillingEvent({
        type: event.type, plan: plan?.id || null, amount_cents: 0, currency: session.currency || 'usd',
        livemode: event.livemode, stripe_ref: event.id,
        payload: { objectId: session.id, status: 'post-deletion-checkout-terminal' },
      });
      return { handled: true, duplicate: !first, deletedAccount: true, auditOnly: true, entitlementPolicy: 'no-resurrection' };
    }
    if (!plan || !account || typeof session.id !== 'string') {
      return { handled: false, type: event.type, reason: 'checkout terminal state is not linked to a known account, intent, and plan' };
    }
    const intent = await db.getCheckoutIntentBySession(account.id, session.id);
    if (event.livemode && (!intent || intent.plan !== plan.id || typeof session?.metadata?.account_id !== 'string')) {
      return { handled: false, type: event.type, reason: 'checkout terminal state does not match an account-owned intent' };
    }
    const first = await db.recordBillingEvent({
      type: event.type, email: account.email, accountId: account.id, plan: plan.id,
      amount_cents: 0, currency: session.currency || 'usd', livemode: event.livemode,
      stripe_ref: event.id, payload: billingPayload(event),
    });
    if (!first) return { handled: true, duplicate: true, plan: plan.id, email: account.email };
    const expiresAt = Number.isInteger(session.expires_at) ? new Date(session.expires_at * 1000).toISOString() : null;
    const terminal = event.type === 'checkout.session.expired' ? 'expired'
      : event.type === 'checkout.session.async_payment_failed' ? 'failed' : 'awaiting_payment';
    await db.terminalCheckoutIntent(account.id, session.id, terminal, session.payment_status || (terminal === 'failed' ? 'failed' : 'unpaid'), expiresAt);
    return { handled: true, plan: plan.id, email: account.email, checkoutStatus: terminal };
  }
  if (!['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) return { handled: false, type: event.type };
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
  const resolvedAccount = await accountForObject(session, db, { enforceCustomer: Boolean(event.livemode) });
  const account = resolvedAccount || (!event.livemode && email ? await db.getOrCreateAccount(email.toLowerCase()) : null);
  const deleted = !account && await db.getDeletedAccountForBilling({ accountId: session?.metadata?.account_id, customerId: session.customer });
  if (event.livemode && deleted && typeof session.id === 'string') {
    const first = await db.recordBillingEvent({
      type: event.type, plan: plan.id, amount_cents: 0, currency, livemode,
      stripe_ref: event.id, payload: { objectId: session.id, status: 'post-deletion-checkout-completion' },
    });
    return { handled: true, duplicate: !first, deletedAccount: true, auditOnly: true, entitlementPolicy: 'no-resurrection' };
  }
  if (event.livemode && typeof session?.metadata?.account_id !== 'string') {
    return { handled: false, reason: 'live checkout is missing immutable metadata.account_id' };
  }
  if (event.livemode && !account) return { handled: false, reason: 'checkout account no longer exists or ownership does not match' };
  if (event.livemode) {
    const intent = typeof session.id === 'string' && account ? await db.getCheckoutIntentBySession(account.id, session.id) : null;
    const subtotal = session.amount_subtotal, total = session.amount_total;
    const discount = session.total_details?.amount_discount ?? 0;
    const tax = session.total_details?.amount_tax ?? 0;
    const shipping = session.total_details?.amount_shipping ?? 0;
    if (session.livemode !== true || session.mode !== 'subscription' || !['paid', 'no_payment_required'].includes(session.payment_status)) {
      return { handled: false, reason: 'live checkout is not a completed paid subscription session' };
    }
    if (String(session.currency || '').toLowerCase() !== 'usd' || !Number.isInteger(subtotal) || subtotal !== plan.amount_cents ||
        !Number.isInteger(total) || total < 0 || !Number.isInteger(discount) || discount < 0 || discount > subtotal ||
        !Number.isInteger(tax) || tax < 0 || !Number.isInteger(shipping) || shipping < 0 || total !== subtotal - discount + tax + shipping) {
      return { handled: false, reason: 'live checkout amount, currency, or promotion totals do not match the configured plan' };
    }
    if (!intent || intent.plan !== plan.id) return { handled: false, reason: 'live checkout does not match an account-owned checkout intent' };
    if (typeof session.subscription !== 'string' || typeof session.customer !== 'string') return { handled: false, reason: 'live checkout is missing subscription ownership references' };
  }
  if (account && typeof session.customer === 'string' && !await db.linkStripeCustomer(account.id, session.customer) && event.livemode) {
    return { handled: false, reason: 'Stripe customer is linked to a different account' };
  }
  const firstTime = await db.recordBillingEvent({
    // Stripe Checkout proves fulfillment but invoice/charge events are the cash
    // ledger. Live checkout is audit-only to avoid counting the first invoice
    // twice; local mock mode keeps its synthetic amount for demo metrics.
    type: event.type, email, accountId: account?.id || null, plan: plan.id, amount_cents: event.livemode ? 0 : amount, currency, livemode,
    stripe_ref: event.id, payload: billingPayload(event),
  });
  if (!firstTime) {
    return { handled: true, duplicate: true, plan: plan.id, email };
  }

  const result = { handled: true, plan: plan.id, email, amount_cents: amount };
  const sourceRef = session.subscription || session.id || event.id;
  const staleEntitlement = Boolean(account && await db.isStaleEntitlementEvent(account.id, sourceRef, event.created));

  if (plan.kind === 'consumer' && plan.grantsPlan && (account || email)) {
    const current = account || await db.getOrCreateAccount(email.toLowerCase());
    let grantApplied = false;
    if (!staleEntitlement) {
      const entitlement = await db.upsertEntitlement({
        accountId: current.id,
        product: plan.grantsPlan,
        status: 'active',
        sourceRef,
        metadata: { checkoutSession: session.id || null, plan: plan.id },
        eventCreated: event.created,
      });
      if (!entitlement.applied) return { handled: true, stale: true, plan: plan.id, email: current.email, entitlement: entitlement.status };
      await db.retireOtherEntitlements(current.id, sourceRef, plan.grantsPlan, event.created);
      await db.syncAccountPlan(current.id);
      grantApplied = ['active', 'trialing'].includes(entitlement.status);
    }
    if (session.id) await db.registerCheckoutClaim({ sessionId: session.id, accountId: current.id, plan: plan.id, status: 'complete' });
    if (session.id) await db.completeCheckoutIntent(current.id, plan.id, session.id);
    if (grantApplied) result.granted = plan.grantsPlan;
    if (staleEntitlement) result.stale = true;
  } else if (plan.kind === 'api') {
    let activeForCheckout = !account;
    if (account) {
      if (staleEntitlement) {
        const current = await db.getEntitlementBySource(account.id, sourceRef, `api:${plan.tier}`);
        activeForCheckout = Boolean(current && ['active', 'trialing'].includes(current.status));
      } else {
        const entitlement = await db.upsertEntitlement({
          accountId: account.id,
          product: `api:${plan.tier}`,
          status: 'active',
          sourceRef,
          metadata: { checkoutSession: session.id || null, plan: plan.id },
          eventCreated: event.created,
        });
        if (!entitlement.applied) return { handled: true, stale: true, plan: plan.id, email: account.email, entitlement: entitlement.status };
        await db.retireOtherEntitlements(account.id, sourceRef, `api:${plan.tier}`, event.created);
        await db.syncApiKeysForAccount(account.id);
        activeForCheckout = ['active', 'trialing'].includes(entitlement.status);
      }
    }
    if (!activeForCheckout) return { handled: true, stale: staleEntitlement, plan: plan.id, email: account?.email || email, apiKeyIssued: false };
    const existingClaim = session.id ? await db.getCheckoutClaim(session.id) : null;
    if (existingClaim) return { handled: true, duplicateCheckout: true, stale: staleEntitlement, plan: plan.id, email: account?.email || email, apiKeyIssued: existingClaim.status !== 'complete', tier: plan.tier };
    const raw = await db.createApiKey(email ? `checkout:${email}` : `checkout:${plan.id}`, plan.tier, {
      ownerEmail: email, ownerAccountId: account?.id || null, stripeRef: session.subscription || session.id || event.id,
    });
    if (session.id) await db.putPendingKey(session.id, raw, plan.tier, account?.id || null);
    if (account) {
      await db.syncAccountPlan(account.id);
    }
    if (session.id) await db.registerCheckoutClaim({ sessionId: session.id, accountId: account?.id || null, plan: plan.id, tier: plan.tier, status: 'claimable' });
    if (session.id && account) await db.completeCheckoutIntent(account.id, plan.id, session.id);
    result.apiKeyIssued = true;
    result.tier = plan.tier;
    if (staleEntitlement) result.stale = true;
  }
  return result;
}

function billingPayload(event) {
  const object = event?.data?.object || {};
  // Persist lifecycle/audit fields, not an unbounded provider payload that may
  // contain payment details or surprise PII.
  return {
    objectId: typeof object.id === 'string' ? object.id : null,
    customer: typeof object.customer === 'string' ? object.customer : null,
    subscription: typeof object.subscription === 'string' ? object.subscription : null,
    status: typeof object.status === 'string' ? object.status : null,
    accountId: typeof object?.metadata?.account_id === 'string'
      ? object.metadata.account_id
      : (typeof object?.subscription_details?.metadata?.account_id === 'string' ? object.subscription_details.metadata.account_id : null),
  };
}

function planFromMetadata(object) {
  const id = object?.metadata?.plan || object?.client_reference_id ||
    object?.subscription_details?.metadata?.plan ||
    object?.parent?.subscription_details?.metadata?.plan ||
    object?.lines?.data?.[0]?.metadata?.plan;
  return getPlan(id);
}

function priceIdsFromObject(object) {
  const items = Array.isArray(object?.items?.data) ? object.items.data : Array.isArray(object?.lines?.data) ? object.lines.data : [];
  return [...new Set(items.map((item) => {
    if (typeof item?.price === 'string') return item.price;
    if (typeof item?.price?.id === 'string') return item.price.id;
    if (typeof item?.pricing?.price_details?.price === 'string') return item.pricing.price_details.price;
    return null;
  }).filter(Boolean))];
}

function resolvePlanFromObject(object, live = false, { allowMultipleAudit = false } = {}) {
  if (!live) return { plan: planFromMetadata(object), reason: null };
  const ids = priceIdsFromObject(object);
  const supported = ids.map((id) => Object.values(PLANS).find((plan) => process.env[plan.priceEnv] === id)).filter(Boolean);
  if (allowMultipleAudit && ids.length > 1 && supported.length === ids.length) {
    return { plan: null, auditOnly: true, metadataPlan: planFromMetadata(object), reason: null };
  }
  if (ids.length !== 1 || supported.length !== 1) {
    return { plan: null, reason: ids.length > 1 ? 'billing object contains multiple recurring prices' : 'billing object price is not a configured PriceTruth plan' };
  }
  // Portal upgrades do not reliably rewrite subscription metadata. The actual
  // Stripe Price is authoritative; metadata remains useful only as audit
  // context and must never pin an account to the prior tier.
  return { plan: supported[0], metadataPlan: planFromMetadata(object), reason: null };
}

async function accountForObject(object, db, { enforceCustomer = false } = {}) {
  const accountId = object?.metadata?.account_id || object?.subscription_details?.metadata?.account_id || object?.parent?.subscription_details?.metadata?.account_id;
  if (typeof accountId === 'string') {
    const account = await db.getAccountById(accountId);
    if (!account) return null;
    if (typeof object?.customer === 'string') {
      const owner = await db.getAccountByStripeCustomer(object.customer);
      if (enforceCustomer && ((owner && owner.id !== account.id) || (account.stripe_customer && account.stripe_customer !== object.customer))) return null;
    }
    return account;
  }
  if (typeof object?.customer === 'string') {
    const account = await db.getAccountByStripeCustomer(object.customer);
    if (account) return account;
  }
  // Live fulfillment is ownership-bound to immutable account metadata or an
  // already-linked Stripe customer. Never recreate an erased/new account from
  // mutable billing email fields on a late webhook.
  if (enforceCustomer) return null;
  const email = object?.customer_email || object?.customer_details?.email || object?.metadata?.email;
  if (typeof email !== 'string') return null;
  const account = await db.getOrCreateAccount(email.toLowerCase());
  if (enforceCustomer && typeof object?.customer === 'string' && account.stripe_customer && account.stripe_customer !== object.customer) return null;
  return account;
}

function entitlementStatus(status, deleted = false) {
  if (deleted) return 'canceled';
  if (['active', 'trialing'].includes(status)) return status;
  if (['past_due', 'unpaid', 'paused', 'incomplete', 'incomplete_expired', 'canceled'].includes(status)) return status;
  return 'inactive';
}

async function applySubscriptionEvent(event, db) {
  const subscription = event.data?.object || {};
  const resolvedPlan = resolvePlanFromObject(subscription, Boolean(event.livemode));
  const plan = resolvedPlan.plan;
  const account = await accountForObject(subscription, db, { enforceCustomer: Boolean(event.livemode) });
  const deleted = !account && await db.getDeletedAccountForBilling({ accountId: subscription?.metadata?.account_id, customerId: subscription.customer });
  if (deleted && typeof subscription.id === 'string') {
    const first = await db.recordBillingEvent({
      type: event.type, plan: plan?.id || null, amount_cents: 0, currency: subscription.currency || 'usd',
      livemode: event.livemode, stripe_ref: event.id,
      payload: { objectId: subscription.id, status: 'post-deletion-subscription', eventCreated: Number.isInteger(event.created) ? event.created : null },
    });
    return { handled: true, duplicate: !first, deletedAccount: true, auditOnly: true, entitlementPolicy: 'no-resurrection' };
  }
  if (!account || typeof subscription.id !== 'string') return { handled: false, type: event.type, reason: resolvedPlan.reason || 'subscription is not linked to a known account and plan' };
  if (typeof subscription.customer === 'string' && !await db.linkStripeCustomer(account.id, subscription.customer) && event.livemode) {
    return { handled: false, type: event.type, reason: 'Stripe customer is linked to a different account' };
  }
  // A signed lifecycle event for a known subscription is authoritative even
  // when its current Price is no longer in our launch configuration. Fail
  // closed: suspend every grant sourced from that subscription and restore it
  // only after a later lifecycle event maps to one exact supported Price.
  if (!plan) {
    const first = await db.recordBillingEvent({
      type: event.type, email: account.email, accountId: account.id, plan: null,
      livemode: event.livemode, stripe_ref: event.id, payload: billingPayload(event),
    });
    if (!first) return { handled: true, duplicate: true, plan: null, email: account.email };
    if (await db.isStaleEntitlementEvent(account.id, subscription.id, event.created)) {
      return { handled: true, stale: true, plan: null, email: account.email, entitlementPolicy: 'fail-closed-unmapped-price' };
    }
    const deactivated = await db.deactivateEntitlementsBySource(account.id, subscription.id, 'inactive', event.created);
    await db.syncApiKeysForAccount(account.id);
    await db.syncAccountPlan(account.id);
    return {
      handled: true, plan: null, email: account.email, entitlement: 'inactive', deactivated,
      unresolvedPlan: true, entitlementPolicy: 'fail-closed-unmapped-price',
    };
  }
  const status = entitlementStatus(subscription.status, event.type === 'customer.subscription.deleted');
  const product = plan.kind === 'consumer' ? plan.grantsPlan : `api:${plan.tier}`;
  const first = await db.recordBillingEvent({ type: event.type, email: account.email, accountId: account.id, plan: plan.id, livemode: event.livemode, stripe_ref: event.id, payload: billingPayload(event) });
  if (!first) return { handled: true, duplicate: true, plan: plan.id, email: account.email };
  if (await db.isStaleEntitlementEvent(account.id, subscription.id, event.created)) {
    return { handled: true, stale: true, plan: plan.id, email: account.email };
  }
  const entitlement = await db.upsertEntitlement({
    accountId: account.id, product, status, sourceRef: subscription.id,
    currentPeriodEnd: Number.isInteger(subscription.current_period_end)
      ? new Date(subscription.current_period_end * 1000).toISOString()
      : Number.isInteger(subscription.items?.data?.[0]?.current_period_end)
        ? new Date(subscription.items.data[0].current_period_end * 1000).toISOString()
        : null,
    cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end), metadata: { plan: plan.id }, eventCreated: event.created,
  });
  if (!entitlement.applied) return { handled: true, stale: true, plan: plan.id, email: account.email, entitlement: entitlement.status };
  await db.retireOtherEntitlements(account.id, subscription.id, product, event.created);
  if (plan.kind === 'api') await db.syncApiKeysForAccount(account.id);
  await db.syncAccountPlan(account.id);
  return { handled: true, plan: plan.id, email: account.email, entitlement: status };
}

async function applyInvoiceEvent(event, db) {
  const invoice = event.data?.object || {};
  // Empty or unrelated invoice events remain ignored for backward compatibility.
  const account = await accountForObject(invoice, db, { enforceCustomer: Boolean(event.livemode) });
  const resolvedPlan = resolvePlanFromObject(invoice, Boolean(event.livemode), { allowMultipleAudit: true });
  const plan = resolvedPlan.plan;
  const paid = ['invoice.paid', 'invoice.payment_succeeded'].includes(event.type);
  const failed = event.type === 'invoice.payment_failed';
  const deleted = !account && await db.getDeletedAccountForBilling({
    accountId: invoice?.metadata?.account_id || invoice?.subscription_details?.metadata?.account_id || invoice?.parent?.subscription_details?.metadata?.account_id,
    customerId: invoice.customer,
  });
  if (deleted && typeof invoice.id === 'string' && (paid || failed)) {
    const duplicatePayment = paid && await db.hasRecognizedInvoicePayment(invoice.id);
    const amount = paid && !duplicatePayment && Number.isInteger(invoice.amount_paid) ? invoice.amount_paid : 0;
    const first = await db.recordBillingEvent({
      type: event.type, plan: plan?.id || null, amount_cents: amount, currency: invoice.currency || 'usd',
      livemode: event.livemode, stripe_ref: event.id,
      payload: { objectId: invoice.id, status: 'post-deletion-invoice', eventCreated: Number.isInteger(event.created) ? event.created : null },
    });
    return { handled: true, duplicate: !first, duplicatePayment, deletedAccount: true, auditOnly: true, amount_cents: amount, entitlementPolicy: 'no-resurrection' };
  }
  if (!account || typeof invoice.id !== 'string') return { handled: false, type: event.type, reason: resolvedPlan.reason || 'invoice is not linked to a known account' };
  if (!paid && !failed) return { handled: false, type: event.type };
  // Stripe emits both invoice.payment_succeeded and invoice.paid for the same
  // successful invoice. Keep both lifecycle events, but recognize cash once
  // per immutable invoice object id.
  const duplicatePayment = paid && await db.hasRecognizedInvoicePayment(invoice.id);
  const amount = paid && !duplicatePayment && Number.isInteger(invoice.amount_paid) ? invoice.amount_paid : 0;
  if (typeof invoice.customer === 'string' && !await db.linkStripeCustomer(account.id, invoice.customer) && event.livemode) {
    return { handled: false, type: event.type, reason: 'Stripe customer is linked to a different account' };
  }
  const first = await db.recordBillingEvent({ type: event.type, email: account.email, accountId: account.id, plan: plan?.id || null, amount_cents: amount, currency: invoice.currency || 'usd', livemode: event.livemode, stripe_ref: event.id, payload: billingPayload(event) });
  if (!first) return { handled: true, duplicate: true, plan: plan?.id || null, email: account.email };
  // Invoice events are cash/audit evidence, not subscription lifecycle
  // authority. In particular, a late invoice.paid must never resurrect a
  // canceled subscription, and payment_failed alone must not infer which
  // grants Stripe has actually suspended. customer.subscription.* events own
  // every entitlement/key transition.
  return {
    handled: true,
    auditOnly: true,
    duplicatePayment,
    plan: plan?.id || null,
    email: account.email,
    amount_cents: amount,
    entitlementPolicy: 'subscription-event-authoritative',
    unresolvedPlan: !plan && !resolvedPlan.auditOnly,
  };
}

async function applyRefundEvent(event, db) {
  const charge = event.data?.object || {};
  const account = await accountForObject(charge, db, { enforceCustomer: Boolean(event.livemode) });
  if (typeof charge.id !== 'string') return { handled: false, type: event.type };
  if (!Number.isInteger(charge.amount_refunded) || charge.amount_refunded < 0) return { handled: false, type: event.type, reason: 'refund has no valid cumulative amount' };
  const previous = await db.refundedTotalForCharge(charge.id);
  const cumulative = Math.max(previous, charge.amount_refunded);
  const amount = -(cumulative - previous);
  const payload = { ...billingPayload(event), cumulativeRefunded: cumulative };
  if (!account) {
    const deleted = await db.getDeletedAccountForBilling({ accountId: charge?.metadata?.account_id, customerId: charge.customer });
    if (!deleted) return { handled: false, type: event.type };
    const first = await db.recordBillingEvent({ type: event.type, amount_cents: amount, currency: charge.currency || 'usd', livemode: event.livemode, stripe_ref: event.id, payload: { ...payload, status: 'post-deletion-refund' } });
    return { handled: true, duplicate: !first, deletedAccount: true, auditOnly: true, amount_cents: amount, entitlementPolicy: 'no-resurrection' };
  }
  const first = await db.recordBillingEvent({ type: event.type, email: account.email, accountId: account.id, amount_cents: amount, currency: charge.currency || 'usd', livemode: event.livemode, stripe_ref: event.id, payload });
  return { handled: true, duplicate: !first, email: account.email, amount_cents: amount };
}

async function applyRefundAuditEvent(event, db) {
  const refund = event.data?.object || {};
  if (typeof refund.id !== 'string' || typeof refund.charge !== 'string') {
    return { handled: false, type: event.type, reason: 'refund lifecycle event is missing immutable identifiers' };
  }
  const first = await db.recordBillingEvent({
    type: event.type,
    amount_cents: 0,
    currency: refund.currency || 'usd',
    livemode: event.livemode,
    stripe_ref: event.id,
    payload: { objectId: refund.id, charge: refund.charge, status: refund.status || null },
  });
  return { handled: true, duplicate: !first, auditOnly: true, entitlementPolicy: 'unchanged' };
}

async function applyDisputeEvent(event, db) {
  const dispute = event.data?.object || {};
  if (typeof dispute.id !== 'string' || !Number.isInteger(dispute.amount) || dispute.amount < 0) {
    return { handled: false, type: event.type, reason: 'dispute event is missing a valid id or amount' };
  }
  const account = await accountForObject(dispute, db, { enforceCustomer: Boolean(event.livemode) });
  const deleted = !account && await db.getDeletedAccountForBilling({ accountId: dispute?.metadata?.account_id, customerId: dispute.customer });
  if (!account && !deleted && event.livemode) return { handled: false, type: event.type, reason: 'dispute is not linked to a known or deleted account' };
  const types = [...DISPUTE_EVENTS];
  const latest = await db.latestBillingObjectEvent(dispute.id, types);
  const incomingCreated = Number.isInteger(event.created) ? event.created : null;
  const latestCreated = Number.isInteger(latest?.payload?.eventCreated) ? latest.payload.eventCreated : null;
  const priority = (type) => type === 'charge.dispute.closed' ? 3 : type === 'charge.dispute.updated' ? 2 : 1;
  const stale = latest && incomingCreated !== null && latestCreated !== null && (
    incomingCreated < latestCreated || (incomingCreated === latestCreated && priority(event.type) <= priority(latest.type))
  );
  const currentImpact = await db.billingObjectAmount(dispute.id, types);
  let desiredImpact = currentImpact;
  if (!stale && event.type === 'charge.dispute.created') desiredImpact = -dispute.amount;
  if (!stale && event.type === 'charge.dispute.closed' && dispute.status === 'won') desiredImpact = 0;
  if (!stale && event.type === 'charge.dispute.closed' && dispute.status === 'lost') desiredImpact = -dispute.amount;
  const amount = desiredImpact - currentImpact;
  const first = await db.recordBillingEvent({
    type: event.type,
    email: account?.email || null,
    accountId: account?.id || null,
    amount_cents: amount,
    currency: dispute.currency || 'usd',
    livemode: event.livemode,
    stripe_ref: event.id,
    payload: { ...billingPayload(event), objectId: dispute.id, charge: dispute.charge || null, status: dispute.status || null, eventCreated: incomingCreated },
  });
  return {
    handled: true,
    duplicate: !first,
    deletedAccount: Boolean(deleted),
    amount_cents: amount,
    stale: Boolean(stale),
    auditOnly: true,
    entitlementPolicy: 'unchanged-pending-operator-review',
  };
}

// Build a synthetic checkout.session.completed event (mock mode + tests).
export function mockCompletedEvent({ planId, email, sessionId, amount_cents }) {
  const plan = getPlan(planId);
  return {
    id: `evt_mock_${sessionId}`,
    type: 'checkout.session.completed',
    livemode: false,
    created: Math.floor(Date.now() / 1000),
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
