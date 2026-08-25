import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { open } from './db.js';
import { seed } from './seed.js';
import { analyze, VERTICALS } from './engine/analyze.js';
import { dealQuality } from './engine/score.js';
import { applySecurityHeaders, RateLimiter, HttpError, readJsonBody, readRawBody, validate, escapeHtml } from './security.js';
import { zip } from './extzip.js';
import { searchListing, providerStatus, SEARCH_VERTICALS } from './providers/index.js';
import * as billing from './billing.js';
import { catalog as subscriptionCatalog, snapshot as subscriptionSnapshot } from './providers/subscriptions.js';

import PKG from '../package.json' with { type: 'json' };
import HOTEL from './data/fees/hotel.json' with { type: 'json' };
import FLIGHT from './data/fees/flight.json' with { type: 'json' };
import TICKET from './data/fees/ticket.json' with { type: 'json' };
import SUBSCRIPTION from './data/fees/subscription.json' with { type: 'json' };
import partnersData from './data/partners.json' with { type: 'json' };

const PARTNERS = partnersData.partners;
const EXTENSION_DIR = path.join(import.meta.dirname, '..', 'extension');
const PUBLIC_DIR = path.join(import.meta.dirname, '..', 'public');
const PORT = Number(process.env.PORT) || 4780;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const B2B_DAILY_LIMIT = { starter: 100, pro: 10_000 };
const FREE_ALERT_LIMIT = 1;
const PREMIUM_ALERT_LIMIT = 20;

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function sendHtml(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function productPayload(db, product, { days = 30, includeHistory = false } = {}) {
  const report = analyze({
    vertical: product.vertical,
    advertised_cents: product.advertised_cents,
    context: product.context,
  });
  const stats = db.getStats(product.id, days);
  const latest = db.getLatestPoint(product.id);
  const score = stats
    ? dealQuality({
        current_cents: latest.true_cents,
        low_cents: stats.low_cents,
        high_cents: stats.high_cents,
        avg_cents: stats.avg_cents,
        feeLoadPct: report.feeLoadPct,
      })
    : dealQuality({});
  const payload = {
    product: { id: product.id, vertical: product.vertical, name: product.name, url: product.url },
    report,
    stats: stats ? { days, ...stats } : null,
    score,
  };
  if (includeHistory) payload.history = db.getHistory(product.id, days);
  return payload;
}

function buildMeta() {
  const labelMap = (obj) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, v.label]));
  const plans = Object.fromEntries(Object.entries(billing.PLANS).map(([id, p]) => [id, { id, label: p.label, price: p.price, kind: p.kind, tier: p.tier || null }]));
  return {
    name: 'PriceTruth',
    version: PKG.version,
    currency: 'USD',
    demoData: true,
    verticals: VERTICALS,
    searchVerticals: SEARCH_VERTICALS,
    providers: providerStatus(),
    billing: { mode: billing.mode(), plans },
    subscriptionCatalog: { snapshot: subscriptionSnapshot, plans: subscriptionCatalog() },
    options: {
      hotelMarkets: labelMap(HOTEL.markets),
      flightCarriers: labelMap(FLIGHT.carriers),
      ticketPlatforms: labelMap(TICKET.platforms),
      subscriptionPatterns: labelMap(SUBSCRIPTION.patterns),
    },
    partners: labelMap(PARTNERS),
  };
}

// Base URL for building Stripe redirect/return links. Honors an explicit
// PUBLIC_BASE_URL, else derives it from the request (proxy-aware).
function baseUrlFor(req) {
  const env = process.env.PUBLIC_BASE_URL;
  if (env && /^https?:\/\//.test(env)) return env.replace(/\/+$/, '');
  return requestOrigin(req).origin;
}

// Constant-time admin auth from the X-Admin-Token header.
function isAdmin(req) {
  const adminToken = process.env.ADMIN_TOKEN;
  const provided = req.headers['x-admin-token'];
  return Boolean(adminToken) && typeof provided === 'string' &&
    provided.length === adminToken.length &&
    crypto.timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(adminToken, 'utf8'));
}

function affiliateUrl(partner, target) {
  const url = new URL(target);
  url.searchParams.set(partner.tagParam, partner.tagValue);
  return url.toString();
}

function hostAllowed(hostname, domains) {
  const host = hostname.toLowerCase();
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
}

function interstitialHtml(partnerLabel, outUrl) {
  const safeUrl = escapeHtml(outUrl);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Leaving PriceTruth</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/styles.css"></head>
<body class="interstitial"><main class="card" style="max-width:34rem;margin:4rem auto;padding:2rem">
<h1>You're leaving PriceTruth</h1>
<p>You're heading to <strong>${escapeHtml(partnerLabel)}</strong>.</p>
<p class="disclosure"><strong>Affiliate disclosure:</strong> this is an affiliate link — if you book or buy after clicking,
PriceTruth may earn a commission at no extra cost to you. That never changes the prices, fees, or scores we show.</p>
<p><a class="btn" href="${safeUrl}" rel="noopener nofollow sponsored">Continue to ${escapeHtml(partnerLabel)}</a></p>
<p><a href="/">Back to PriceTruth</a></p>
</main></body></html>`;
}

function mockPortalHtml() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Billing portal (simulated)</title>
<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/styles.css"></head>
<body class="interstitial"><main class="card" style="max-width:34rem;margin:4rem auto;padding:2rem">
<h1>Billing portal <span class="chip chip-demo">simulated</span></h1>
<p>Stripe isn't configured on this deployment, so there is no real billing portal.
In production (with <code>STRIPE_SECRET_KEY</code> set) this button opens Stripe's hosted
portal where a customer can update their card, view invoices, or cancel.</p>
<p><a class="btn" href="/account">Back to your account</a></p>
</main></body></html>`;
}

// The extension is downloadable as a .zip built on demand. When served from a
// deployed site we rewrite the extension's app URL and demo-host so the copy a
// user installs links back to *this* site and its on-site demo, instead of the
// localhost default baked into the source.
const EXTENSION_FILES = ['manifest.json', 'feemodel.js', 'content.js', 'overlay.css', 'popup.html', 'popup.js', 'popup.css', 'README.md'];
const extZipCache = new Map(); // origin -> Buffer

function buildExtensionZip(origin, hostname) {
  const cached = extZipCache.get(origin);
  if (cached) return cached;

  const entries = EXTENSION_FILES.map((name) => {
    let data = fs.readFileSync(path.join(EXTENSION_DIR, name), 'utf8');
    if (name === 'content.js') {
      data = data
        .replace("var APP_URL = 'http://localhost:4780';", `var APP_URL = '${origin}';`)
        .replace("var PT_DEMO_HOST = 'localhost';", `var PT_DEMO_HOST = '${hostname}';`);
    } else if (name === 'popup.html') {
      data = data.replaceAll('http://localhost:4780', origin);
    } else if (name === 'manifest.json') {
      const m = JSON.parse(data);
      const pattern = `*://${hostname}/extension-demo.html*`;
      const matches = m.content_scripts[0].matches;
      if (!matches.includes(pattern)) matches.push(pattern);
      data = JSON.stringify(m, null, 2);
    }
    return { name: `pricetruth-extension/${name}`, data };
  });

  const buf = zip(entries);
  if (extZipCache.size < 32) extZipCache.set(origin, buf);
  return buf;
}

// Derive a safe origin (scheme://host) from the request, honoring the proxy's
// X-Forwarded-Proto (Render/Railway terminate TLS in front of us).
function requestOrigin(req) {
  const rawHost = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost');
  const host = /^[a-z0-9.\-]+(:\d+)?$/i.test(rawHost) ? rawHost : 'localhost';
  const xfProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const proto = xfProto === 'https' ? 'https' : xfProto === 'http' ? 'http' : 'http';
  return { origin: `${proto}://${host}`, hostname: host.split(':')[0] };
}

function createApp({ dbPath } = {}) {
  const db = open(dbPath);
  if (db.listProducts().length === 0) seed(db);

  const readLimiter = new RateLimiter({ capacity: 120, refillPerSec: 2 });
  const writeLimiter = new RateLimiter({ capacity: 20, refillPerSec: 0.2 });
  const b2bLimiter = new RateLimiter({ capacity: 30, refillPerSec: 0.5 });

  // Sweep idle rate-limit buckets every 5 min so an idle IP is dropped from
  // memory within ~15 min of its last request (prune evicts buckets idle >10
  // min) — this is what makes the privacy policy's "held only transiently" true
  // even at low traffic, not just under saturation. unref() so it never keeps
  // the process alive.
  const sweep = setInterval(() => {
    readLimiter.prune();
    writeLimiter.prune();
    b2bLimiter.prune();
    db.prunePendingKeys(); // drop unclaimed once-shown keys after their TTL
  }, 5 * 60 * 1000);
  if (typeof sweep.unref === 'function') sweep.unref();

  async function handle(req, res) {
    const started = Date.now();
    const ip = req.socket.remoteAddress || 'unknown';
    applySecurityHeaders(res);
    let pathname = req.url || '/';
    let isApi = false;

    try {
      let url;
      try {
        url = new URL(req.url, 'http://localhost');
        pathname = decodeURIComponent(url.pathname);
      } catch {
        throw new HttpError(400, 'malformed request path');
      }
      isApi = pathname.startsWith('/api/');
      if (isApi) res.setHeader('Cache-Control', 'no-store');
      // The Stripe webhook is exempt: Stripe retries with backoff, and a 429
      // there would drop legitimate billing events. Its own signature check is
      // the gate. Everything else that mutates or costs work is rate-limited.
      const isWebhook = pathname === '/api/billing/webhook';
      if ((isApi && !isWebhook) || pathname.startsWith('/go/') || pathname.startsWith('/download/')) {
        const limiter = req.method === 'GET' ? readLimiter : writeLimiter;
        const rl = limiter.check(ip);
        if (!rl.ok) {
          res.setHeader('Retry-After', String(rl.retryAfterSec));
          throw new HttpError(429, 'rate limit exceeded; slow down');
        }
      }

      if (pathname.startsWith('/api/v1/')) {
        await handleB2b(req, res, url, pathname, ip);
      } else if (isApi) {
        await handleApi(req, res, url, pathname);
      } else if (pathname.startsWith('/go/')) {
        handleAffiliate(res, url, pathname);
      } else if (pathname === '/download/extension.zip') {
        handleExtensionDownload(req, res);
      } else if (pathname.startsWith('/billing/mock-')) {
        await handleMockBilling(req, res, url, pathname);
      } else if (req.method === 'GET' || req.method === 'HEAD') {
        serveStatic(req, res, pathname);
      } else {
        throw new HttpError(405, 'method not allowed');
      }
    } catch (err) {
      // HttpError is authoritative. Otherwise honor a well-formed client-error
      // status (4xx) carried on the error — the provider/billing layers throw
      // plain Errors with err.status (e.g. a bad webhook signature is a 400, a
      // too-short search query is a 400) and those messages are intentional and
      // non-sensitive. Anything else is an unexpected 500 with a generic body.
      const carried = Number.isInteger(err?.status) && err.status >= 400 && err.status <= 499 ? err.status : null;
      const status = err instanceof HttpError ? err.status : (carried ?? 500);
      const message = (err instanceof HttpError || carried) ? err.message : 'internal server error';
      if (status === 500) console.error(`[error] ${req.method} ${pathname}:`, err);
      if (res.headersSent) { res.end(); }
      else if (isApi) sendJson(res, status, { error: message });
      else sendHtml(res, status, `<!doctype html><meta charset="utf-8"><title>${status}</title><h1>${status}</h1><p>${escapeHtml(message)}</p>`);
    } finally {
      // Sanitized before logging: printable ASCII only, capped length (log-injection guard).
      const safePath = pathname.replace(/[^\x20-\x7e]/g, '?').slice(0, 200);
      console.log(`${req.method} ${safePath} ${res.statusCode} ${Date.now() - started}ms`);
    }
  }

  async function handleApi(req, res, url, pathname) {
    if (req.method === 'GET' && pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, version: PKG.version });
    }
    if (req.method === 'GET' && pathname === '/api/meta') {
      return sendJson(res, 200, buildMeta());
    }
    if (req.method === 'POST' && pathname === '/api/analyze') {
      const body = await readJsonBody(req);
      return sendJson(res, 200, runAnalyze(body));
    }
    if (req.method === 'GET' && pathname === '/api/products') {
      const items = db.listProducts().map((p) => productPayload(db, p));
      return sendJson(res, 200, { products: items, demoData: true });
    }
    const productMatch = pathname.match(/^\/api\/products\/([a-z0-9-]{1,64})$/);
    if (req.method === 'GET' && productMatch) {
      const product = db.getProduct(productMatch[1]);
      if (!product) throw new HttpError(404, 'unknown product');
      const days = url.searchParams.get('days') === '90' ? 90 : 30;
      return sendJson(res, 200, { ...productPayload(db, product, { days, includeHistory: true }), demoData: true });
    }
    const historyMatch = pathname.match(/^\/api\/history\/([a-z0-9-]{1,64})$/);
    if (req.method === 'GET' && historyMatch) {
      const product = db.getProduct(historyMatch[1]);
      if (!product) throw new HttpError(404, 'unknown product');
      const days = url.searchParams.get('days') === '90' ? 90 : 30;
      return sendJson(res, 200, { points: db.getHistory(product.id, days), stats: db.getStats(product.id, days), days });
    }
    if (req.method === 'POST' && pathname === '/api/alerts') {
      const body = await readJsonBody(req);
      const email = validate.email(body.email);
      const id = validate.id(body.product_id, 'product_id');
      const threshold = validate.cents(body.threshold_cents, 'threshold_cents');
      if (!db.getProduct(id)) throw new HttpError(404, 'unknown product');
      // Entitlement is the account's real plan — set by a completed checkout
      // (Stripe live) or the mock checkout flow. No client-supplied override.
      const premium = db.isPremium(email);
      const existing = db.countAlertsForEmail(email);
      const limit = premium ? PREMIUM_ALERT_LIMIT : FREE_ALERT_LIMIT;
      if (existing >= limit) {
        return sendJson(res, 402, {
          error: premium ? `premium accounts are limited to ${PREMIUM_ALERT_LIMIT} alerts` : 'free accounts get 1 price alert',
          upgrade: premium ? null : { planId: 'premium', price: '$4/month', includes: `${PREMIUM_ALERT_LIMIT} alerts, deal-quality digests, price-drop push`, checkout: '/api/billing/checkout' },
        });
      }
      db.createAlert({ email, productId: id, threshold_cents: threshold });
      return sendJson(res, 201, {
        created: true,
        plan: premium ? 'premium' : 'free',
        note: 'Alerts are stored server-side. Email delivery is enabled when a mail provider is configured (double opt-in); until then alerts are recorded and visible via the API.',
      });
    }
    if (req.method === 'POST' && pathname === '/api/admin/keys') {
      const adminToken = process.env.ADMIN_TOKEN;
      const provided = req.headers['x-admin-token'];
      const authed = Boolean(adminToken) && typeof provided === 'string' &&
        provided.length === adminToken.length &&
        crypto.timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(adminToken, 'utf8'));
      if (!authed) {
        throw new HttpError(403, 'admin key minting is disabled; use `npm run keygen` locally');
      }
      const body = await readJsonBody(req);
      const label = validate.string(body.label, 'label', 100);
      const tier = validate.enum(body.tier || 'starter', 'tier', Object.keys(B2B_DAILY_LIMIT));
      return sendJson(res, 201, { key: db.createApiKey(label, tier), tier, note: 'shown once; only a hash is stored' });
    }

    // ---- live search: fetch a real (or labeled-estimate) listing, analyze it,
    // and record a true-price point so history accrues from real observations.
    if (req.method === 'POST' && pathname === '/api/search') {
      const body = await readJsonBody(req);
      const vertical = validate.enum(body.vertical, 'vertical', SEARCH_VERTICALS);
      const q = validate.string(body.q, 'q', 120);
      return sendJson(res, 200, await runSearch(vertical, q));
    }

    // ---- billing ----
    if (req.method === 'POST' && pathname === '/api/billing/checkout') {
      const body = await readJsonBody(req);
      const planId = validate.enum(body.planId, 'planId', Object.keys(billing.PLANS));
      const email = body.email === undefined ? undefined : validate.email(body.email);
      const { url: checkoutUrl, mock } = await billing.createCheckout({ planId, email, baseUrl: baseUrlFor(req) });
      return sendJson(res, 200, { url: checkoutUrl, mock, mode: billing.mode() });
    }
    if (req.method === 'GET' && pathname === '/api/billing/claim') {
      const sessionId = url.searchParams.get('session_id') || '';
      if (!/^[A-Za-z0-9_]{6,200}$/.test(sessionId)) throw new HttpError(400, 'invalid session_id');
      const pending = db.takePendingKey(sessionId);
      if (!pending) throw new HttpError(404, 'no key to claim for this session (already claimed or not an API purchase)');
      return sendJson(res, 200, { key: pending.raw_key, tier: pending.tier, note: 'shown once; store it now' });
    }
    if (req.method === 'POST' && pathname === '/api/billing/portal') {
      const body = await readJsonBody(req);
      const email = validate.email(body.email);
      const acct = db.getAccount(email);
      if (!acct || !acct.stripe_customer) {
        if (billing.mode() === 'mock') return sendJson(res, 200, { url: `${baseUrlFor(req)}/billing/mock-portal`, mock: true });
        throw new HttpError(404, 'no billing account for that email');
      }
      const { url: portalUrl, mock } = await billing.createPortal({ customerId: acct.stripe_customer, baseUrl: baseUrlFor(req) });
      return sendJson(res, 200, { url: portalUrl, mock });
    }
    if (req.method === 'POST' && pathname === '/api/billing/webhook') {
      const raw = await readRawBody(req);
      const event = billing.verifyWebhook(raw, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
      const result = billing.applyEvent(event, db);
      return sendJson(res, 200, { received: true, ...result });
    }

    // ---- admin metrics (revenue + usage), token-gated ----
    if (req.method === 'GET' && pathname === '/api/admin/metrics') {
      if (!isAdmin(req)) throw new HttpError(403, 'admin token required');
      return sendJson(res, 200, {
        billing: { mode: billing.mode(), ...db.revenueSummary(12) },
        usage: db.metrics(),
        providers: providerStatus(),
        generatedAt: new Date().toISOString(),
      });
    }

    throw new HttpError(404, 'unknown API route');
  }

  // Fetch a listing via the provider layer, analyze it, upsert it as a tracked
  // product, and append a real true-price point so history builds over time.
  async function runSearch(vertical, q) {
    const listing = await searchListing({ vertical, q });
    const report = analyze({ vertical, advertised_cents: listing.advertised_cents, context: listing.context });
    const id = searchProductId(vertical, listing.name, q);
    db.upsertProduct({
      id, vertical, name: listing.name, url: listing.url,
      advertised_cents: listing.advertised_cents, context: listing.context,
    });
    db.addPricePoint(id, { advertised_cents: listing.advertised_cents, true_cents: report.truePrice.amount_cents });
    const stats = db.getStats(id, 90);
    const score = stats
      ? dealQuality({ current_cents: report.truePrice.amount_cents, low_cents: stats.low_cents, high_cents: stats.high_cents, avg_cents: stats.avg_cents, feeLoadPct: report.feeLoadPct })
      : dealQuality({});
    return { product_id: id, listing, report, stats: stats ? { days: 90, ...stats } : null, score, live: !listing.source.startsWith('estimated') };
  }

  // Deterministic, slug-safe id for a searched listing (vertical + name/query).
  function searchProductId(vertical, name, q) {
    const basis = `${name || q}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
    const suffix = crypto.createHash('sha256').update(`${vertical}:${name}:${q}`).digest('hex').slice(0, 8);
    const id = `s-${vertical}-${basis || 'q'}-${suffix}`.slice(0, 64);
    return id;
  }

  // Mock billing pages (only reachable when STRIPE is unconfigured). They
  // simulate the Stripe flow so the whole purchase → entitlement/key path is
  // exercisable without keys, and are clearly labeled as simulations.
  async function handleMockBilling(req, res, url, pathname) {
    if (billing.mode() !== 'mock') throw new HttpError(404, 'not found');
    if (pathname === '/billing/mock-portal') {
      return sendHtml(res, 200, mockPortalHtml());
    }
    if (pathname === '/billing/mock-checkout') {
      const planId = url.searchParams.get('plan') || '';
      const plan = billing.getPlan(planId);
      if (!plan) throw new HttpError(400, 'unknown plan');
      const email = url.searchParams.get('email') || null;
      const sessionId = `cs_mock_${crypto.randomBytes(12).toString('hex')}`;
      const event = billing.mockCompletedEvent({ planId, email, sessionId });
      billing.applyEvent(event, db);
      // 303 back to the SPA success page, which claims any minted key.
      res.writeHead(303, { Location: `/billing/success?session_id=${sessionId}&mock=1` });
      return res.end();
    }
    throw new HttpError(404, 'not found');
  }

  async function handleB2b(req, res, url, pathname, ip) {
    const rawKey = req.headers['x-api-key'];
    const key = typeof rawKey === 'string' ? db.findApiKey(rawKey) : null;
    if (!key) throw new HttpError(401, 'missing or invalid X-API-Key');
    const rl = b2bLimiter.check(`key:${key.id}:${ip}`);
    if (!rl.ok) {
      res.setHeader('Retry-After', String(rl.retryAfterSec));
      throw new HttpError(429, 'per-minute rate limit exceeded');
    }
    const usedToday = db.meterUsage(key.id);
    const limit = B2B_DAILY_LIMIT[key.tier] ?? B2B_DAILY_LIMIT.starter;
    if (usedToday > limit) throw new HttpError(429, `daily quota exceeded for ${key.tier} tier (${limit}/day)`);
    const usage = { used_today: usedToday, daily_limit: limit, tier: key.tier };

    if (req.method === 'POST' && pathname === '/api/v1/analyze') {
      const body = await readJsonBody(req);
      // analyze on caller-supplied inputs isn't demo data; product-backed reads are.
      return sendJson(res, 200, { ...runAnalyze(body), usage });
    }
    if (req.method === 'POST' && pathname === '/api/v1/track') {
      const body = await readJsonBody(req);
      const id = validate.id(body.product_id, 'product_id');
      const advertised = validate.cents(body.advertised_cents, 'advertised_cents');
      const product = db.getProduct(id);
      if (!product) throw new HttpError(404, 'unknown product');
      // Plausibility band: keyed clients still can't poison history with junk points.
      const ref = product.advertised_cents;
      if (advertised < Math.floor(ref / 4) || advertised > ref * 4) {
        throw new HttpError(422, 'price point rejected: outside the plausible band for this product');
      }
      const report = analyze({ vertical: product.vertical, advertised_cents: advertised, context: product.context });
      db.addPricePoint(id, { advertised_cents: advertised, true_cents: report.truePrice.amount_cents });
      return sendJson(res, 201, { tracked: true, true_cents: report.truePrice.amount_cents, demoData: true, usage });
    }
    const productMatch = pathname.match(/^\/api\/v1\/products\/([a-z0-9-]{1,64})$/);
    if (req.method === 'GET' && productMatch) {
      const product = db.getProduct(productMatch[1]);
      if (!product) throw new HttpError(404, 'unknown product');
      return sendJson(res, 200, { ...productPayload(db, product, { includeHistory: true }), demoData: true, usage });
    }
    if (req.method === 'GET' && pathname === '/api/v1/usage') {
      return sendJson(res, 200, { usage });
    }
    throw new HttpError(404, 'unknown API route');
  }

  function runAnalyze(body) {
    const vertical = validate.enum(body.vertical, 'vertical', VERTICALS);
    const advertised = validate.cents(body.advertised_cents, 'advertised_cents');
    let context = {};
    if (body.context !== undefined) {
      if (!body.context || typeof body.context !== 'object' || Array.isArray(body.context)) {
        throw new HttpError(400, 'context must be an object');
      }
      if (JSON.stringify(body.context).length > 4096) throw new HttpError(400, 'context too large');
      context = body.context;
    }
    try {
      return analyze({ vertical, advertised_cents: advertised, context });
    } catch (err) {
      if (err instanceof RangeError || err instanceof TypeError) throw new HttpError(400, err.message);
      throw err;
    }
  }

  function handleExtensionDownload(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method not allowed');
    const { origin, hostname } = requestOrigin(req);
    const buf = buildExtensionZip(origin, hostname);
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': buf.length,
      'Content-Disposition': 'attachment; filename="pricetruth-extension.zip"',
      'Cache-Control': 'no-store',
    });
    if (req.method === 'HEAD') return res.end();
    res.end(buf);
  }

  function handleAffiliate(res, url, pathname) {
    const partnerId = pathname.slice('/go/'.length);
    // Object.hasOwn guard: prototype keys like __proto__ must 404, not resolve.
    const partner = Object.hasOwn(PARTNERS, partnerId) ? PARTNERS[partnerId] : null;
    if (!partner) throw new HttpError(404, 'unknown partner');
    const target = url.searchParams.get('target');
    if (!target) throw new HttpError(400, 'missing target URL');
    let parsed;
    try {
      parsed = new URL(target);
    } catch {
      throw new HttpError(400, 'target must be an absolute URL');
    }
    if (parsed.protocol !== 'https:' || !hostAllowed(parsed.hostname, partner.domains)) {
      throw new HttpError(400, 'target not allowed for this partner');
    }
    sendHtml(res, 200, interstitialHtml(partner.label, affiliateUrl(partner, target)));
  }

  function serveStatic(req, res, pathname) {
    let rel = pathname === '/' ? 'index.html' : pathname.slice(1);
    // The staff dashboard is a separate page from the public SPA.
    if (pathname === '/admin' || pathname === '/admin/') rel = 'admin.html';
    // SPA-friendly: extensionless paths fall through to the app shell.
    else if (!rel.includes('.')) rel = 'index.html';
    const filePath = path.resolve(PUBLIC_DIR, rel);
    if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
      throw new HttpError(403, 'forbidden');
    }
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      throw new HttpError(404, 'not found');
    }
    if (!stat.isFile()) throw new HttpError(404, 'not found');
    const mime = MIME[path.extname(filePath).toLowerCase()];
    if (!mime) throw new HttpError(404, 'not found');
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': stat.size,
      'Cache-Control': filePath.endsWith('index.html') ? 'no-cache' : 'public, max-age=300',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).pipe(res);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error('[fatal handler error]', err);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal server error' });
      else res.end();
    });
  });
  server.on('close', () => clearInterval(sweep));

  return { server, db };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { server, db } = createApp();
  // Bind loopback locally so a dev box is never exposed to the LAN. On a hosted
  // platform (Render/Railway/Fly/Heroku set their own PORT, and Render sets
  // RENDER=true; NODE_ENV=production is the general signal) the app MUST bind
  // 0.0.0.0 or the platform's port scan finds nothing and fails the deploy.
  // An explicit HOST always wins.
  const onHost =
    !!process.env.RENDER ||
    process.env.NODE_ENV === 'production' ||
    !!process.env.RAILWAY_ENVIRONMENT ||
    !!process.env.FLY_APP_NAME ||
    !!process.env.DYNO; // Heroku
  const HOST = process.env.HOST || (onHost ? '0.0.0.0' : '127.0.0.1');
  server.listen(PORT, HOST, () => {
    console.log(`PriceTruth listening on http://${HOST}:${PORT}`);
  });
  const shutdown = () => {
    console.log('shutting down…');
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

export { createApp };
