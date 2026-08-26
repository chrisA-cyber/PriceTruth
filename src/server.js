import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { open, privateProductId } from './db.js';
import { seed, seedSubscriptionCatalog, removeDemoSeed } from './seed.js';
import { analyze, VERTICALS } from './engine/analyze.js';
import { dealQuality } from './engine/score.js';
import {
  applySecurityHeaders, RateLimiter, HttpError, readJsonBody, readRawBody, validate, escapeHtml,
  parseCookies, serializeCookie, requestId as makeRequestId, assertSameOrigin,
  isPublicHostname, isPublicHttpsUrl, isPublicHttpsOrigin,
} from './security.js';
import { zip, prepareExtensionManifest } from './extzip.js';
import { searchListing, providerStatus, SEARCH_VERTICALS, validateProviderQuery } from './providers/index.js';
import * as billing from './billing.js';
import { createMailer, verifyDeliveryWebhook } from './email.js';
import { createJobWorker } from './jobs.js';
import {
  catalog as subscriptionCatalog,
  snapshot as subscriptionSnapshot,
  catalogFreshness as subscriptionCatalogFreshness,
} from './providers/subscriptions.js';

import PKG from '../package.json' with { type: 'json' };
import HOTEL from './data/fees/hotel.json' with { type: 'json' };
import FLIGHT from './data/fees/flight.json' with { type: 'json' };
import TICKET from './data/fees/ticket.json' with { type: 'json' };
import SUBSCRIPTION from './data/fees/subscription.json' with { type: 'json' };
import partnersData from './data/partners.json' with { type: 'json' };

const PARTNERS = partnersData.partners;
const PROJECT_ROOT = path.join(import.meta.dirname, '..');
const EXTENSION_DIR = path.join(PROJECT_ROOT, 'extension');
const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');
const OPENAPI_PATH = path.join(PROJECT_ROOT, 'openapi', 'openapi.json');
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

function launchVerticalConfiguration() {
  const supplied = Object.hasOwn(process.env, 'LAUNCH_VERTICALS');
  const requested = String(process.env.LAUNCH_VERTICALS || '').split(',').map((value) => value.trim()).filter(Boolean);
  const unknown = requested.filter((value) => !VERTICALS.includes(value));
  const verticals = [...new Set(requested.filter((value) => VERTICALS.includes(value)))];
  return { supplied, requested, unknown, verticals };
}

function affiliateConfiguration(partnerId, partner, env = process.env) {
  if (env.ENABLE_AFFILIATE_LINKS !== '1' || env.AFFILIATE_RELATIONSHIPS_APPROVED !== '1') return null;
  const tag = String(env[`AFFILIATE_TAG_${String(partnerId).toUpperCase().replace(/[^A-Z0-9]/g, '_')}`] || '').trim();
  if (tag.length < 2 || tag.length > 160 || /(?:demo|test|placeholder|example)/i.test(tag)) return null;
  let disclosureUrl;
  try {
    disclosureUrl = new URL(env.AFFILIATE_DISCLOSURE_URL || '');
    if (disclosureUrl.protocol !== 'https:' || !isPublicHostname(disclosureUrl.hostname) || disclosureUrl.username || disclosureUrl.password) return null;
  } catch { return null; }
  return { tag, disclosureUrl: disclosureUrl.toString() };
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function errorCode(status) {
  return ({ 400: 'INVALID_REQUEST', 401: 'AUTH_REQUIRED', 402: 'PAYMENT_REQUIRED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 408: 'REQUEST_TIMEOUT', 409: 'CONFLICT', 410: 'GONE', 413: 'PAYLOAD_TOO_LARGE', 422: 'UNPROCESSABLE', 429: 'RATE_LIMITED', 503: 'SERVICE_UNAVAILABLE' })[status] || 'INTERNAL_ERROR';
}

function applyRateHeaders(res, result) {
  if (!result || !Number.isFinite(result.limit)) return;
  res.setHeader('RateLimit-Limit', String(result.limit));
  res.setHeader('RateLimit-Remaining', String(result.remaining));
  res.setHeader('RateLimit-Reset', String(result.resetSec));
  // Compatibility while clients migrate to the IETF field names.
  res.setHeader('X-RateLimit-Limit', String(result.limit));
  res.setHeader('X-RateLimit-Remaining', String(result.remaining));
  res.setHeader('X-RateLimit-Reset', String(result.resetSec));
}

function sendHtml(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function dataClassification({ source = null, evidence = {}, observed = false } = {}) {
  const provenance = evidence?.provenance || {};
  const normalizedSource = String(source || provenance.source || '').toLowerCase();
  const evidenceType = String(provenance.evidenceType || '').toLowerCase();
  const demo = provenance.demo === true || evidence?.demo === true ||
    /^(demo|seed|estimated):/.test(normalizedSource) ||
    ['model_estimate', 'synthetic_demo', 'seed'].includes(evidenceType);
  if (demo) return { dataKind: 'demo', demoData: true };
  if (normalizedSource.startsWith('dataset:') || evidenceType === 'catalog_snapshot') {
    return { dataKind: 'dataset', demoData: false };
  }
  if (observed || evidenceType === 'provider_quote') return { dataKind: 'observed', demoData: false };
  return { dataKind: 'unverified', demoData: false };
}

function engineBaseCertainty(certainty, dataKind = null) {
  if (certainty === 'live' || certainty === 'listed') return 'listed';
  if (certainty === 'catalog') return 'catalog';
  if (certainty === 'typical') return 'typical';
  if (certainty === 'estimated') return 'estimated';
  if (dataKind === 'demo') return 'estimated';
  if (dataKind === 'dataset') return 'catalog';
  return 'listed';
}

function scoreFromHistory(stats, { currentCents, feeLoadPct }) {
  // Multiple refreshes of one snapshot are not a historical window. Require
  // at least two eligible observations on distinct UTC dates before assigning
  // a comparative deal rating.
  if (!stats || stats.n < 2 || stats.distinct_observations < 2 || stats.distinct_days < 2 || stats.first_ts === stats.last_ts) {
    return dealQuality({});
  }
  return dealQuality({
    current_cents: currentCents,
    low_cents: stats.low_cents,
    high_cents: stats.high_cents,
    avg_cents: stats.avg_cents,
    feeLoadPct,
  });
}

function productAlertEligible(product, { env = process.env, now = Date.now() } = {}) {
  const evidence = currentSourceEvidence(product, { env, now });
  const eligible = evidence?.refreshable === true && evidence?.pricingComplete !== false && evidence?.provenance?.alertEligible === true;
  if (!eligible) return false;
  return product.vertical !== 'subscription' || subscriptionCatalogFreshness({ env, now }).ok;
}

async function catalogNotificationDeliveryAllowed(db, { record, metadata = {}, env = process.env, now = Date.now() } = {}) {
  if (!['price-alert', 'weekly-digest'].includes(record?.template)) return true;
  const snapshotIsCurrent = async (snapshot, product) => {
    if (!snapshot || !product || snapshot.productId !== product.id) return false;
    if (!productAlertEligible(product, { env, now })) return false;
    const latest = await db.getLatestPoint(product.id, { eligibleOnly: false });
    if (!latest || latest.alertEligible !== true || latest.ts !== snapshot.pointAt || latest.true_cents !== snapshot.trueCents) return false;
    const evidence = currentSourceEvidence({ ...product, evidence: {
      ...latest.evidence,
      refreshable: product.evidence?.refreshable === true,
    } }, { env, now });
    return evidence?.provenance?.alertEligible === true && evidence?.provenance?.stale !== true;
  };
  if (record.template === 'price-alert') {
    const alertId = Number(metadata.alertId);
    const alert = Number.isSafeInteger(alertId) && alertId > 0 ? await db.getAlert(alertId, record.account_id) : null;
    const product = alert ? await db.getProduct(alert.product_id) : null;
    const snapshot = {
      productId: metadata.productId,
      pointAt: metadata.pointAt,
      trueCents: Number(metadata.trueCents),
    };
    return Boolean(alert && product && alert.product_id === snapshot.productId && await snapshotIsCurrent(snapshot, product));
  }
  const snapshots = Array.isArray(metadata.productSnapshots) ? metadata.productSnapshots.slice(0, 20) : [];
  if (snapshots.length === 0 || !record.account_id) return false;
  const watched = new Set((await db.listWatchlist(record.account_id)).map((product) => product.product_id));
  for (const raw of snapshots) {
    const snapshot = { productId: raw?.productId, pointAt: raw?.pointAt, trueCents: Number(raw?.trueCents) };
    if (!watched.has(snapshot.productId)) return false;
    if (!await snapshotIsCurrent(snapshot, await db.getProduct(snapshot.productId))) return false;
  }
  return true;
}

function currentSourceEvidence(product, { env = process.env, now = Date.now() } = {}) {
  const evidence = structuredClone(product?.evidence || {});
  const provenance = evidence.provenance && typeof evidence.provenance === 'object'
    ? evidence.provenance
    : null;
  if (!provenance) return evidence;
  const catalogBacked = product?.vertical === 'subscription' && (
    provenance.evidenceType === 'catalog_snapshot' || String(provenance.source || product.source || '').startsWith('dataset:')
  );
  const sourceBacked = catalogBacked || provenance.observed === true || String(provenance.source || product.source || '').startsWith('live:');
  if (!sourceBacked) return evidence;

  const freshness = catalogBacked ? subscriptionCatalogFreshness({ env, now }) : null;
  const asOfMs = Date.parse(provenance.asOf || '');
  const maxAgeSeconds = Number.isInteger(freshness?.maxAgeSeconds) && freshness.maxAgeSeconds > 0
    ? freshness.maxAgeSeconds
    : Number(provenance.maxAgeSeconds) || 0;
  const ageSeconds = Number.isFinite(asOfMs) ? Math.max(0, Math.floor((Number(now) - asOfMs) / 1000)) : null;
  const stale = (catalogBacked && freshness?.ok !== true) || ageSeconds === null || maxAgeSeconds < 1 || ageSeconds > maxAgeSeconds;
  provenance.maxAgeSeconds = maxAgeSeconds;
  provenance.ageSeconds = ageSeconds;
  provenance.stale = stale;
  provenance.freshThrough = Number.isFinite(asOfMs) && maxAgeSeconds > 0
    ? new Date(asOfMs + maxAgeSeconds * 1000).toISOString()
    : null;
  provenance.alertEligible = provenance.alertEligible === true && !stale;
  if ('alertEligible' in evidence || product?.evidence?.refreshable === true) {
    evidence.alertEligible = product?.evidence?.refreshable === true && provenance.alertEligible;
  }
  return evidence;
}

async function productPayload(db, product, { days = 30, includeHistory = false } = {}) {
  const currentEvidence = currentSourceEvidence(product);
  const sourceStale = currentEvidence?.provenance?.stale === true;
  const stats = sourceStale ? null : await db.getStats(product.id, days);
  const rawLatest = await db.getLatestPoint(product.id, { eligibleOnly: !sourceStale });
  const latest = rawLatest ? { ...rawLatest, evidence: currentSourceEvidence({ ...product, evidence: {
    ...rawLatest.evidence,
    refreshable: product.evidence?.refreshable === true,
  } }) } : null;
  const classification = dataClassification({
    source: latest?.source || product.source,
    evidence: latest?.evidence || currentEvidence,
    observed: Boolean(latest?.observed),
  });
  const report = analyze({
    vertical: product.vertical,
    advertised_cents: product.advertised_cents,
    context: product.context,
    baseCertainty: engineBaseCertainty(latest?.certainty || product.certainty, classification.dataKind),
  });
  const score = scoreFromHistory(stats, { currentCents: latest?.true_cents, feeLoadPct: report.feeLoadPct });
  const payload = {
    product: {
      id: product.id, vertical: product.vertical, name: product.name, url: product.url,
      refreshable: currentEvidence?.refreshable === true,
      alertEligible: productAlertEligible({ ...product, evidence: currentEvidence }),
    },
    refreshable: currentEvidence?.refreshable === true,
    alertEligible: productAlertEligible({ ...product, evidence: currentEvidence }),
    provenance: {
      source: product.source || null,
      sourceLabel: product.source_label || null,
      certainty: product.certainty || null,
      fetchedAt: product.fetched_at || null,
      evidence: currentEvidence,
    },
    report,
    stats: stats ? { days, ...stats } : null,
    score,
    ...classification,
  };
  if (includeHistory) {
    payload.history = (await db.getHistory(product.id, days)).map((point) => {
      const evidence = currentSourceEvidence({ ...product, evidence: {
        ...point.evidence,
        refreshable: product.evidence?.refreshable === true,
      } });
      return {
        ...point,
        alertEligible: point.alertEligible === true && evidence?.provenance?.alertEligible === true && evidence?.provenance?.stale !== true,
        evidence,
      };
    });
  }
  return payload;
}

function buildMeta(readiness = null, availableVerticals = VERTICALS, publicBaseUrl = null) {
  const labelMap = (obj) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, v.label]));
  const plans = Object.fromEntries(Object.entries(billing.PLANS).map(([id, p]) => [id, { id, label: p.label, price: p.price, kind: p.kind, tier: p.tier || null }]));
  const providers = providerStatus();
  const requireLaunchReadySources = readiness?.paidLaunch?.required === true ||
    (process.env.NODE_ENV === 'production' && process.env.ENABLE_DEMO_SEED !== '1');
  const legalChecks = readiness?.paidLaunch?.checks || {};
  const support = process.env.SUPPORT_CONTACT_URL || process.env.SUPPORT_CONTACT_EMAIL || null;
  const legalConfigured = Boolean(legalChecks.legalOperator && legalChecks.legalJurisdiction && legalChecks.legalSupport && legalChecks.legalEffectiveDate && legalChecks.legalApproved && legalChecks.legalTermsVersion);
  return {
    name: 'PriceTruth',
    version: PKG.version,
    currency: 'USD',
    publicBaseUrl,
    demoData: true,
    verticals: availableVerticals,
    searchVerticals: SEARCH_VERTICALS.filter((vertical) => availableVerticals.includes(vertical) && (!requireLaunchReadySources || providers[vertical]?.truthUsable)),
    providers,
    capabilities: {
      accounts: Boolean(readiness?.capabilities?.accounts?.enabled),
      billing: billing.mode() === 'live' && Boolean(
        readiness?.paidLaunch?.ok && readiness?.database?.ok && readiness?.billingReconciliation?.ok &&
        readiness?.productionSafety?.launchVerticals?.ok
      ),
    },
    billing: { mode: billing.mode(), plans },
    legal: {
      configured: legalConfigured,
      operatorName: legalConfigured ? process.env.LEGAL_OPERATOR_NAME.trim() : null,
      jurisdiction: legalConfigured ? process.env.LEGAL_JURISDICTION.trim() : null,
      supportContact: legalConfigured ? support : null,
      effectiveDate: legalConfigured ? process.env.LEGAL_EFFECTIVE_DATE : null,
      termsVersion: legalConfigured ? process.env.LEGAL_TERMS_VERSION.trim() : null,
      approved: legalConfigured,
    },
    readiness,
    subscriptionCatalog: { snapshot: subscriptionSnapshot, freshness: providers.subscription.freshness, plans: subscriptionCatalog() },
    options: {
      hotelMarkets: labelMap(HOTEL.markets),
      flightCarriers: labelMap(FLIGHT.carriers),
      ticketPlatforms: labelMap(TICKET.platforms),
      subscriptionPatterns: labelMap(SUBSCRIPTION.patterns),
    },
    partners: Object.fromEntries(Object.entries(PARTNERS)
      .filter(([id, partner]) => affiliateConfiguration(id, partner))
      .map(([id, partner]) => [id, partner.label])),
  };
}

const SITEMAP_ROUTES = [
  ['/', 'weekly', '1.0'],
  ['/find', 'weekly', '0.9'],
  ['/analyze', 'monthly', '0.8'],
  ['/pricing', 'monthly', '0.8'],
  ['/api-docs', 'monthly', '0.7'],
  ['/extension', 'monthly', '0.6'],
  ['/legal.html', 'yearly', '0.3'],
];
const CANONICAL_APP_ROUTES = new Set(['/', '/find', '/analyze', '/compare', '/pricing', '/api-docs', '/extension', '/legal.html']);

function robotsText(origin) {
  return `User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /go/\nDisallow: /admin\nDisallow: /account\nDisallow: /billing/\nDisallow: /download/\n\nSitemap: ${origin}/sitemap.xml\n`;
}

function sitemapText(origin) {
  const urls = SITEMAP_ROUTES.map(([route, frequency, priority]) =>
    `  <url><loc>${origin}${route}</loc><changefreq>${frequency}</changefreq><priority>${priority}</priority></url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

function injectCanonicalMeta(html, canonicalUrl) {
  const safeUrl = escapeHtml(canonicalUrl);
  const canonical = `<link rel="canonical" href="${safeUrl}">`;
  const openGraph = `<meta property="og:url" content="${safeUrl}">`;
  let output = /<link\s+rel=["']canonical["'][^>]*>/i.test(html)
    ? html.replace(/<link\s+rel=["']canonical["'][^>]*>/i, canonical)
    : html.replace('</head>', `  ${canonical}\n</head>`);
  output = /<meta\s+property=["']og:url["'][^>]*>/i.test(output)
    ? output.replace(/<meta\s+property=["']og:url["'][^>]*>/i, openGraph)
    : output.replace('</head>', `  ${openGraph}\n</head>`);
  return output;
}

// Base URL for building Stripe redirect/return links. Honors an explicit
// PUBLIC_BASE_URL, else derives it from the request (proxy-aware).
function baseUrlFor(req) {
  const env = process.env.PUBLIC_BASE_URL;
  if (env) {
    try {
      const parsed = new URL(env);
      const validSchemeAndHost = process.env.NODE_ENV === 'production'
        ? isPublicHttpsOrigin(env)
        : ['http:', 'https:'].includes(parsed.protocol);
      if (validSchemeAndHost && !parsed.username && !parsed.password &&
          (parsed.pathname === '' || parsed.pathname === '/') && !parsed.search && !parsed.hash) return parsed.origin;
    } catch { /* startup/readiness reports the invalid canonical origin */ }
  }
  if (process.env.NODE_ENV === 'production') throw new HttpError(503, 'canonical PUBLIC_BASE_URL is not configured');
  return requestOrigin(req).origin;
}

function isSafeAdminConfiguration(adminToken = process.env.ADMIN_TOKEN) {
  return typeof adminToken === 'string' && adminToken.length >= 32 && adminToken.length <= 512 &&
    /^[\x21-\x7E]+$/.test(adminToken) && new Set(adminToken).size >= 8 &&
    !/(?:changeme|password|placeholder|example|admin[_-]?token|test[_-]?token)/i.test(adminToken);
}

// Constant-time admin auth from the X-Admin-Token header.
function isAdmin(req) {
  const adminToken = process.env.ADMIN_TOKEN;
  const provided = req.headers['x-admin-token'];
  return isSafeAdminConfiguration(adminToken) && typeof provided === 'string' &&
    provided.length === adminToken.length &&
    crypto.timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(adminToken, 'utf8'));
}

function affiliateUrl(partner, target, tag) {
  const url = new URL(target);
  url.searchParams.set(partner.tagParam, tag);
  return url.toString();
}

function hostAllowed(hostname, domains) {
  const host = hostname.toLowerCase();
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
}

function interstitialHtml(partnerLabel, outUrl, disclosureUrl) {
  const safeUrl = escapeHtml(outUrl);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Leaving PriceTruth</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/styles.css"></head>
<body class="interstitial"><main class="card" style="max-width:34rem;margin:4rem auto;padding:2rem">
<h1>You're leaving PriceTruth</h1>
<p>You're heading to <strong>${escapeHtml(partnerLabel)}</strong>.</p>
<p class="disclosure"><strong>Affiliate disclosure:</strong> this is an affiliate link — if you book or buy after clicking,
PriceTruth may earn a commission at no extra cost to you. That never changes the prices, fees, or scores we show.</p>
<p><a href="${escapeHtml(disclosureUrl)}" rel="noopener">Read the full affiliate disclosure</a></p>
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
const EXTENSION_FILES = [
  'manifest.json', 'config.js', 'adapters.js', 'feemodel.js', 'content.js', 'overlay.css',
  'popup.html', 'popup.js', 'popup.css', 'options.html', 'options.js', 'options.css',
  'icons/icon-16.png', 'icons/icon-32.png', 'icons/icon-48.png', 'icons/icon-128.png',
  'README.md', 'PRIVACY.md',
];
const extZipCache = new Map(); // origin -> Buffer

function buildExtensionZip(origin, extensionDir = EXTENSION_DIR) {
  const cacheKey = `${extensionDir}\0${origin}`;
  const cached = extZipCache.get(cacheKey);
  if (cached) return cached;
  const { hostname } = new URL(origin);

  const entries = EXTENSION_FILES.map((name) => {
    const binary = name.endsWith('.png');
    let data = fs.readFileSync(path.join(extensionDir, name), binary ? undefined : 'utf8');
    if (name === 'config.js') {
      data = data
        .replace("appUrl: 'http://localhost:4780'", `appUrl: '${origin}'`)
        .replace("demoHost: 'localhost'", `demoHost: '${hostname}'`);
    } else if (name === 'manifest.json') {
      const m = JSON.parse(data);
      data = JSON.stringify(prepareExtensionManifest(m, origin), null, 2);
    }
    return { name: `pricetruth-extension/${name}`, data };
  });

  const buf = zip(entries);
  if (extZipCache.size < 32) extZipCache.set(cacheKey, buf);
  return buf;
}

// Derive a safe origin (scheme://host) from the request, honoring the proxy's
// X-Forwarded-Proto (Render/Railway terminate TLS in front of us).
function requestOrigin(req) {
  const trustProxy = process.env.TRUST_PROXY === '1';
  const rawHost = String((trustProxy && req.headers['x-forwarded-host']) || req.headers.host || 'localhost');
  const host = /^[a-z0-9.\-]+(:\d+)?$/i.test(rawHost) ? rawHost : 'localhost';
  const xfProto = trustProxy ? String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() : '';
  const proto = xfProto === 'https' ? 'https' : 'http';
  return { origin: `${proto}://${host}`, hostname: host.split(':')[0] };
}

function clientIp(req) {
  if (process.env.TRUST_PROXY === '1') {
    const candidate = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (/^[0-9a-f:.]{3,64}$/i.test(candidate)) return candidate;
  }
  return req.socket.remoteAddress || 'unknown';
}

async function createApp({
  dbPath,
  db: suppliedDb,
  mailer: suppliedMailer,
  priceCatalogVerification = null,
  startTimers = true,
  assetRoot = null,
} = {}) {
  const resolvedAssetRoot = assetRoot ? path.resolve(assetRoot) : PROJECT_ROOT;
  const extensionDir = path.join(resolvedAssetRoot, 'extension');
  const publicDir = path.join(resolvedAssetRoot, 'public');
  const openapiPath = path.join(resolvedAssetRoot, 'openapi', 'openapi.json');
  let db = suppliedDb;
  if (!db && dbPath !== undefined) {
    db = open(dbPath);
  }
  if (!db) {
    if (String(process.env.NETLIFY_DB_URL || '').trim()) {
      const { openPostgres } = await import('./db-postgres.js');
      db = openPostgres({ connectionString: process.env.NETLIFY_DB_URL });
    } else {
      db = open();
    }
  }
  const productionWithoutDemo = process.env.NODE_ENV === 'production' && process.env.ENABLE_DEMO_SEED !== '1';
  if (productionWithoutDemo) {
    await removeDemoSeed(db);
    const launchVerticals = String(process.env.LAUNCH_VERTICALS || '').split(',').map((value) => value.trim()).filter(Boolean);
    if (launchVerticals.includes('subscription')) await seedSubscriptionCatalog(db);
  } else {
    // Seed is idempotent and also repairs provenance on reserved legacy demo
    // rows, even when a developer database already contains other products.
    await seed(db);
  }
  const mailer = suppliedMailer || createMailer(db, {
    deliveryGuard: (context) => catalogNotificationDeliveryAllowed(db, context),
  });

  const readLimiter = new RateLimiter({ capacity: 120, refillPerSec: 2 });
  // Mutations are scoped to the authenticated principal when one is present.
  // A single office, school, or household NAT must not make unrelated signed-in
  // customers consume one another's write budget. Anonymous traffic remains
  // IP-scoped and sensitive routes retain their tighter dedicated limiters.
  const writeRate = { capacity: 60, refillPerSec: 1 };
  const writeLimiter = new RateLimiter(writeRate);
  const b2bRate = { capacity: 30, refillPerSec: 0.5 };
  const b2bLimiter = new RateLimiter(b2bRate);
  const authEmailRate = { capacity: 5, refillPerSec: 1 / 720 };
  const authLimiter = new RateLimiter(authEmailRate);
  const authIpRate = {
    capacity: Math.min(20, Math.max(1, Number(process.env.AUTH_EMAIL_IP_BURST) || 5)),
    refillPerSec: 1 / Math.min(86_400, Math.max(60, Number(process.env.AUTH_EMAIL_IP_REFILL_SECONDS) || 1800)),
  };
  const authIpLimiter = new RateLimiter(authIpRate);
  const notificationEmailRate = { capacity: 5, refillPerSec: 1 / 720 };
  const notificationEmailLimiter = new RateLimiter(notificationEmailRate);
  const notificationIpRate = {
    capacity: Math.min(100, Math.max(5, Number(process.env.NOTIFICATION_EMAIL_IP_BURST) || 20)),
    refillPerSec: 1 / Math.min(86_400, Math.max(60, Number(process.env.NOTIFICATION_EMAIL_IP_REFILL_SECONDS) || 1800)),
  };
  const notificationIpLimiter = new RateLimiter(notificationIpRate);
  // The email-only alert endpoint is retired in production. Its local-only
  // compatibility path gets a separate, still-bounded IP budget so exercising
  // old clients cannot consume the real passwordless sign-in budget.
  const legacyOptInIpRate = {
    capacity: Math.min(100, Math.max(1, Number(process.env.LEGACY_OPT_IN_IP_BURST) || 20)),
    refillPerSec: 1 / Math.min(86_400, Math.max(60, Number(process.env.LEGACY_OPT_IN_IP_REFILL_SECONDS) || 1800)),
  };
  const legacyOptInIpLimiter = new RateLimiter(legacyOptInIpRate);
  const authGlobalRate = {
    capacity: Math.min(10_000, Math.max(10, Number(process.env.AUTH_EMAIL_GLOBAL_BURST) || 100)),
    refillPerSec: Math.min(10, Math.max(1 / 86_400, Number(process.env.AUTH_EMAIL_GLOBAL_DAILY_BUDGET) || 100) / 86_400),
    maxBuckets: 2,
  };
  const authGlobalLimiter = new RateLimiter(authGlobalRate);
  const accountSearchRate = {
    capacity: Math.min(120, Math.max(1, Number(process.env.ACCOUNT_SEARCH_BURST) || 10)),
    refillPerSec: 1 / Math.min(3600, Math.max(1, Number(process.env.ACCOUNT_SEARCH_REFILL_SECONDS) || 30)),
  };
  const accountSearchLimiter = new RateLimiter(accountSearchRate);
  const tokenMutationRate = {
    capacity: Math.min(120, Math.max(2, Number(process.env.TOKEN_MUTATION_BURST) || 20)),
    refillPerSec: 1 / Math.min(3600, Math.max(1, Number(process.env.TOKEN_MUTATION_REFILL_SECONDS) || 60)),
  };
  const tokenMutationLimiter = new RateLimiter(tokenMutationRate);
  const webhookBudgetCapacity = Math.min(1000, Math.max(1, Number(process.env.WEBHOOK_BURST) || 100));
  const webhookBudgetRefillPerSecond = Math.min(100, Math.max(0.1, Number(process.env.WEBHOOK_REFILL_PER_SECOND) || 5));
  const webhookBudget = new RateLimiter({
    capacity: webhookBudgetCapacity,
    refillPerSec: webhookBudgetRefillPerSecond,
    maxBuckets: 2,
  });
  const webhookPreauthRate = {
    capacity: Math.min(1000, Math.max(2, Number(process.env.WEBHOOK_PREAUTH_BURST) || 30)),
    refillPerSec: Math.min(20, Math.max(0.1, Number(process.env.WEBHOOK_PREAUTH_REFILL_PER_SECOND) || 1)),
  };
  const stripeWebhookPreauthLimiter = new RateLimiter(webhookPreauthRate);
  const emailWebhookPreauthLimiter = new RateLimiter(webhookPreauthRate);
  const webhookPreauthActive = new Map();
  const providerCache = new Map();
  const webhookConcurrencyLimit = Math.min(64, Math.max(1, Number(process.env.WEBHOOK_MAX_CONCURRENCY) || 8));
  const webhookPreauthLimitPerIp = Math.min(8, Math.max(1, Number(process.env.WEBHOOK_PREAUTH_MAX_CONCURRENCY_PER_IP) || 2));
  const routeTelemetry = () => ({
    preauthActive: 0, preauthPeak: 0, active: 0, peakActive: 0,
    verified: 0, accepted: 0, rejected: 0,
    rejections: { preauth: 0, body: 0, signature: 0, budget: 0, concurrency: 0, processing: 0 },
  });
  const webhookState = {
    active: 0, peakActive: 0, verified: 0, accepted: 0, rejected: 0,
    preauth: { active: 0, peakActive: 0 },
    routes: { billing: routeTelemetry(), email: routeTelemetry() },
  };
  const launchConfig = launchVerticalConfiguration();
  const productionVerticals = process.env.NODE_ENV === 'production' && launchConfig.supplied ? launchConfig.verticals : VERTICALS;
  const runtimeSearchVerticals = SEARCH_VERTICALS.filter((vertical) => productionVerticals.includes(vertical));

  async function readinessReport() {
    const database = await db.checkReady();
    const email = mailer.readiness();
    const paidLaunch = billing.readiness({ email, database, priceCatalog: priceCatalogVerification });
    const billingReconciliation = await db.billingReconciliationMetrics();
    const emailRequired = process.env.REQUIRE_EMAIL === '1';
    const accountsRequested = process.env.NODE_ENV !== 'production'
      ? process.env.ENABLE_ACCOUNTS !== '0'
      : process.env.ENABLE_ACCOUNTS === '1';
    let canonicalOrigin = true;
    if (process.env.NODE_ENV === 'production') {
      canonicalOrigin = isPublicHttpsOrigin(process.env.PUBLIC_BASE_URL);
    }
    const legal = paidLaunch.checks;
    const accountChecks = {
      enabledFlag: accountsRequested,
      canonicalOrigin,
      durableDatabase: process.env.NODE_ENV !== 'production' || paidLaunch.checks.durableDbConfigured,
      transactionalEmail: process.env.NODE_ENV !== 'production' || (
        paidLaunch.checks.transactionalEmail && paidLaunch.checks.resendApiKey && paidLaunch.checks.emailFrom &&
        paidLaunch.checks.outboxEncryption && paidLaunch.checks.emailWebhookSecret && paidLaunch.checks.workerEnabled &&
        paidLaunch.checks.workerDispatchSecret
      ),
      approvedLegal: process.env.NODE_ENV !== 'production' || Boolean(
        legal.legalOperator && legal.legalJurisdiction && legal.legalSupport && legal.legalEffectiveDate && legal.legalApproved && legal.legalTermsVersion
      ),
    };
    const accountMissing = Object.entries(accountChecks).filter(([, ok]) => !ok).map(([name]) => name);
    const accounts = {
      requested: accountsRequested,
      enabled: process.env.NODE_ENV !== 'production'
        ? accountsRequested
        : accountsRequested && accountMissing.length === 0,
      checks: accountChecks,
      missing: accountMissing,
    };
    const providerStates = providerStatus();
    let amadeusProductionHost = true;
    const requireLaunchSources = paidLaunch.required || productionWithoutDemo;
    if (requireLaunchSources && productionVerticals.some((vertical) => vertical === 'hotel' || vertical === 'flight')) {
      try {
        const amadeus = new URL(process.env.AMADEUS_HOST || '');
        amadeusProductionHost = amadeus.origin === 'https://api.amadeus.com' && amadeus.href === 'https://api.amadeus.com/';
      } catch { amadeusProductionHost = false; }
      amadeusProductionHost = amadeusProductionHost && Boolean(process.env.AMADEUS_CLIENT_ID && process.env.AMADEUS_CLIENT_SECRET);
    }
    let retailProvider = true;
    if (requireLaunchSources && productionVerticals.includes('retail')) {
      retailProvider = isPublicHttpsUrl(process.env.RETAIL_API_URL) && Boolean(process.env.RETAIL_API_KEY);
    }
    const launchVerticalsOk = launchConfig.unknown.length === 0 && amadeusProductionHost && retailProvider &&
      (!requireLaunchSources || (launchConfig.supplied && productionVerticals.length > 0 && productionVerticals.every((vertical) => providerStates[vertical]?.truthUsable)));
    const productionSafety = {
      canonicalOrigin,
      adminToken: !process.env.ADMIN_TOKEN || isSafeAdminConfiguration(),
      launchVerticals: {
        configured: launchConfig.supplied,
        available: productionVerticals,
        unknown: launchConfig.unknown,
        amadeusProductionHost,
        retailProvider,
        ok: launchVerticalsOk,
      },
    };
    const accountsSafe = !accountsRequested || accounts.enabled;
    return {
      ok: database.ok && canonicalOrigin && productionSafety.adminToken && paidLaunch.ok && accountsSafe && launchVerticalsOk && (!emailRequired || email.ok) && (!paidLaunch.required || billingReconciliation.ok),
      version: PKG.version,
      database,
      email,
      paidLaunch,
      billingReconciliation,
      dataSources: { subscriptionCatalog: providerStates.subscription?.freshness || null },
      productionSafety,
      capabilities: { accounts },
      webhooks: webhookTelemetry(),
      worker: {
        enabled: process.env.DISABLE_WORKER !== '1' && (
          process.env.WORKER_MODE !== 'netlify-background' ||
          String(process.env.WORKER_DISPATCH_SECRET || '').length >= 32
        ),
        mode: process.env.WORKER_MODE === 'netlify-background' ? 'netlify-background' : 'in-process',
        dispatchConfigured: process.env.WORKER_MODE !== 'netlify-background' ||
          String(process.env.WORKER_DISPATCH_SECRET || '').length >= 32,
      },
      checkedAt: new Date().toISOString(),
    };
  }

  const initialReadiness = await readinessReport();
  if (!initialReadiness.database.ok || !initialReadiness.paidLaunch.ok || !initialReadiness.productionSafety.canonicalOrigin || !initialReadiness.productionSafety.adminToken ||
      !initialReadiness.productionSafety.launchVerticals.ok ||
      (initialReadiness.capabilities.accounts.requested && !initialReadiness.capabilities.accounts.enabled) ||
      (process.env.REQUIRE_EMAIL === '1' && !initialReadiness.email.ok)) {
    await db.close();
    const missing = [
      ...(initialReadiness.database.ok ? [] : ['databaseIntegrity']),
      ...(initialReadiness.paidLaunch.required && !initialReadiness.paidLaunch.ok
        ? initialReadiness.paidLaunch.missing
        : []),
      ...(initialReadiness.productionSafety.canonicalOrigin ? [] : ['canonicalPublicBaseUrl']),
      ...(initialReadiness.productionSafety.adminToken ? [] : ['adminToken']),
      ...((initialReadiness.paidLaunch.required || productionWithoutDemo) && productionVerticals.includes('subscription') && !initialReadiness.dataSources.subscriptionCatalog?.ok
        ? ['subscriptionCatalogFreshness']
        : []),
      ...(initialReadiness.productionSafety.launchVerticals.ok ? [] : ['launchVerticals']),
      ...(initialReadiness.capabilities.accounts.requested && !initialReadiness.capabilities.accounts.enabled
        ? initialReadiness.capabilities.accounts.missing.map((name) => `accounts.${name}`)
        : []),
      ...(process.env.REQUIRE_EMAIL === '1' && !initialReadiness.email.ok ? ['requiredEmail'] : []),
    ].join(', ');
    throw new Error(`production launch configuration is incomplete: ${missing}`);
  }

  function publicAccount(account) {
    return {
      id: account.id || account.account_id,
      email: account.email,
      emailVerified: Boolean(account.email_verified),
      plan: account.plan,
      createdAt: account.created_at || account.account_created_at,
      verifiedAt: account.verified_at || null,
    };
  }

  function cookieSecure(req) {
    return process.env.NODE_ENV === 'production' || baseUrlFor(req).startsWith('https://');
  }

  function setAuthCookies(req, res, session, csrfToken) {
    const ttlDays = Math.min(90, Math.max(1, Number(process.env.SESSION_TTL_DAYS) || 30));
    const common = { maxAge: ttlDays * 86_400, secure: cookieSecure(req), sameSite: 'Lax' };
    res.setHeader('Set-Cookie', [
      serializeCookie('pt_session', session.token, { ...common, httpOnly: true }),
      serializeCookie('pt_csrf', csrfToken, { ...common, httpOnly: false, sameSite: 'Strict' }),
    ]);
  }

  function clearAuthCookies(req, res) {
    const common = { maxAge: 0, expires: new Date(0), secure: cookieSecure(req), sameSite: 'Lax' };
    res.setHeader('Set-Cookie', [
      serializeCookie('pt_session', '', { ...common, httpOnly: true }),
      serializeCookie('pt_csrf', '', { ...common, httpOnly: false, sameSite: 'Strict' }),
    ]);
  }

  async function currentSession(req, res, { issueCsrf = false } = {}) {
    const cookies = parseCookies(req.headers.cookie);
    const session = await db.getSession(cookies.pt_session);
    if (!session) return null;
    let csrfToken = cookies.pt_csrf;
    if (issueCsrf && !await db.verifyCsrf(session, csrfToken)) {
      csrfToken = await db.rotateSessionCsrf(session.id);
      res.setHeader('Set-Cookie', serializeCookie('pt_csrf', csrfToken, {
        maxAge: Math.max(1, Math.floor((Date.parse(session.expires_at) - Date.now()) / 1000)),
        secure: cookieSecure(req), httpOnly: false, sameSite: 'Strict',
      }));
      session.csrf_hash = crypto.createHash('sha256').update(csrfToken).digest('hex');
    }
    return { session, token: cookies.pt_session, csrfToken };
  }

  async function requireSession(req, res, { csrf = false } = {}) {
    const auth = await currentSession(req, res, { issueCsrf: !csrf });
    if (!auth) throw new HttpError(401, 'sign in is required');
    if (csrf) {
      assertSameOrigin(req, new URL(baseUrlFor(req)).origin);
      const provided = req.headers['x-csrf-token'];
      if (!await db.verifyCsrf(auth.session, provided)) throw new HttpError(403, 'invalid or missing CSRF token');
    }
    return auth;
  }

  async function requireAccountCapability() {
    const capability = await accountCapability();
    if (!capability.enabled) {
      throw new HttpError(503, 'accounts and notifications are not enabled on this deployment', {
        code: 'CAPABILITY_UNAVAILABLE', details: { capability: 'accounts' },
      });
    }
  }

  async function durableRateCheck(req, bucket, rate, label) {
    if (typeof db.consumeDurableRateLimit !== 'function') return null;
    try {
      return await db.consumeDurableRateLimit(bucket, rate);
    } catch (error) {
      // Never log the bucket: it may be derived from an email or IP address.
      // The request id and operation label are enough to correlate the full
      // platform/database trace without leaking the protected principal.
      const safeLabel = String(label || 'sensitive-request').replace(/[^a-z0-9_-]/gi, '?').slice(0, 64);
      const safeRequestId = String(req.priceTruthRequestId || req.headers['x-request-id'] || 'unknown')
        .replace(/[^a-z0-9_-]/gi, '?').slice(0, 128);
      console.error(`[durable rate limit] ${safeLabel} request=${safeRequestId} unavailable (${error?.name || 'Error'})`);
      throw new HttpError(503, 'request protection is temporarily unavailable; retry later', {
        code: 'RATE_LIMIT_UNAVAILABLE',
      });
    }
  }

  function rejectRateLimit(res, result, message, status = 429) {
    applyRateHeaders(res, result);
    res.setHeader('Retry-After', String(result?.retryAfterSec || 1));
    throw new HttpError(status, message);
  }

  async function enforceEmailRequestLimits(req, res, email, { legacyOptIn = false, notificationOptIn = false } = {}) {
    const purpose = legacyOptIn ? 'legacy-opt-in' : notificationOptIn ? 'notification-email' : 'auth-email';
    const emailRate = notificationOptIn ? notificationEmailRate : authEmailRate;
    const emailLimiter = notificationOptIn ? notificationEmailLimiter : authLimiter;
    const ipRate = legacyOptIn ? legacyOptInIpRate : notificationOptIn ? notificationIpRate : authIpRate;
    const ipLimiter = legacyOptIn ? legacyOptInIpLimiter : notificationOptIn ? notificationIpLimiter : authIpLimiter;
    const checks = [
      emailLimiter.check(`email:${email}`),
      ipLimiter.check(clientIp(req)),
      authGlobalLimiter.check('global'),
    ];
    // Keep the in-memory buckets as an inexpensive first line of defense. A
    // request that passes them is then charged to the shared database buckets,
    // making the quota exact across cold starts and concurrently warm hosts.
    if (checks.every((entry) => entry.ok) && typeof db.consumeDurableRateLimit === 'function') {
      const durable = await Promise.all([
        durableRateCheck(req, `${purpose}:email:${email}`, emailRate, 'email-address'),
        durableRateCheck(req, `${purpose}:ip:${clientIp(req)}`, ipRate, 'email-ip'),
        durableRateCheck(req, `${purpose}:global`, authGlobalRate, 'email-global'),
      ]);
      checks.push(...durable.filter(Boolean));
    }
    const limited = checks.find((entry) => !entry.ok) || checks.reduce((lowest, entry) => entry.remaining < lowest.remaining ? entry : lowest);
    applyRateHeaders(res, limited);
    if (!checks.every((entry) => entry.ok)) {
      res.setHeader('Retry-After', String(Math.max(...checks.filter((entry) => !entry.ok).map((entry) => entry.retryAfterSec || 1))));
      throw new HttpError(429, 'too many email requests; try again later');
    }
  }

  // Production capability configuration is immutable for the lifetime of the
  // process. Development retains the useful ENABLE_ACCOUNTS runtime toggle,
  // but derives it without running readiness/database probes.
  async function accountCapability() {
    if (process.env.NODE_ENV === 'production') {
      const databaseOk = (await db.checkReady()).ok;
      return databaseOk ? initialReadiness.capabilities.accounts : {
        ...initialReadiness.capabilities.accounts,
        enabled: false,
        checks: { ...initialReadiness.capabilities.accounts.checks, databaseIntegrity: false },
        missing: [...new Set([...initialReadiness.capabilities.accounts.missing, 'databaseIntegrity'])],
      };
    }
    const requested = process.env.ENABLE_ACCOUNTS !== '0';
    return {
      ...initialReadiness.capabilities.accounts,
      requested,
      enabled: requested,
      checks: { ...initialReadiness.capabilities.accounts.checks, enabledFlag: requested },
      missing: requested ? [] : ['enabledFlag'],
    };
  }

  async function accountsEnabled() { return (await accountCapability()).enabled; }

  function webhookTelemetry() {
    const activeIpBuckets = (route) => [...webhookPreauthActive.keys()]
      .filter((key) => key.startsWith(`/api/${route}/webhook:`)).length;
    return {
      active: webhookState.active,
      peakActive: webhookState.peakActive,
      verified: webhookState.verified,
      accepted: webhookState.accepted,
      rejected: webhookState.rejected,
      concurrencyLimit: webhookConcurrencyLimit,
      budget: { perRouteBurst: webhookBudgetCapacity, refillPerSecond: webhookBudgetRefillPerSecond },
      preauth: {
        active: webhookState.preauth.active,
        peakActive: webhookState.preauth.peakActive,
        activeIpBuckets: webhookPreauthActive.size,
        perIpLimit: webhookPreauthLimitPerIp,
      },
      routes: {
        billing: { ...webhookState.routes.billing, preauthActiveIpBuckets: activeIpBuckets('billing'), rejections: { ...webhookState.routes.billing.rejections } },
        email: { ...webhookState.routes.email, preauthActiveIpBuckets: activeIpBuckets('email'), rejections: { ...webhookState.routes.email.rejections } },
      },
    };
  }

  function recordWebhookRejection(context) {
    if (!context || context.rejectionRecorded) return;
    context.rejectionRecorded = true;
    const route = webhookState.routes[context.route];
    const reason = Object.hasOwn(route.rejections, context.phase) ? context.phase : 'processing';
    webhookState.rejected += 1;
    route.rejected += 1;
    route.rejections[reason] += 1;
  }

  function markWebhookVerified(context) {
    webhookState.verified += 1;
    webhookState.routes[context.route].verified += 1;
  }

  function beginWebhookProcessing(context) {
    context.phase = 'concurrency';
    if (webhookState.active >= webhookConcurrencyLimit) {
      throw new HttpError(503, 'webhook processing concurrency is full; retry with backoff');
    }
    webhookState.active += 1;
    webhookState.peakActive = Math.max(webhookState.peakActive, webhookState.active);
    const route = webhookState.routes[context.route];
    route.active += 1;
    route.peakActive = Math.max(route.peakActive, route.active);
    context.phase = 'processing';
    return () => {
      webhookState.active = Math.max(0, webhookState.active - 1);
      route.active = Math.max(0, route.active - 1);
    };
  }

  function recordWebhookAccepted(context) {
    webhookState.accepted += 1;
    webhookState.routes[context.route].accepted += 1;
  }

  async function requireLiveCommerceReady() {
    if (billing.mode() !== 'live') return;
    const database = await db.checkReady();
    const reconciliation = await db.billingReconciliationMetrics();
    const providerStates = providerStatus();
    const unavailableVerticals = productionVerticals.filter((vertical) => providerStates[vertical]?.truthUsable !== true);
    if (!database.ok || !reconciliation.ok || unavailableVerticals.length > 0) {
      throw new HttpError(503, 'checkout is temporarily unavailable while billing integrity is being reconciled', {
        code: 'BILLING_NOT_READY',
        details: unavailableVerticals.length > 0 ? { unavailableVerticals } : undefined,
      });
    }
  }

  function requireRuntimeVertical(vertical) {
    if (!productionVerticals.includes(vertical)) {
      throw new HttpError(503, `the ${vertical} vertical is not available on this deployment`, {
        code: 'VERTICAL_UNAVAILABLE', details: { vertical, availableVerticals: productionVerticals },
      });
    }
    const providerStates = providerStatus();
    const provider = providerStates[vertical];
    if ((billing.mode() === 'live' || productionWithoutDemo) && provider?.truthUsable === false) {
      const availableVerticals = productionVerticals.filter((entry) => providerStates[entry]?.truthUsable);
      throw new HttpError(503, `the ${vertical} vertical is temporarily unavailable because its verified source is not launch-ready`, {
        code: 'VERTICAL_UNAVAILABLE', details: { vertical, availableVerticals },
      });
    }
    return vertical;
  }

  async function accountPayload(accountId) {
    const account = await db.getAccountById(accountId);
    if (!account) return null;
    const notification = await db.getNotification(accountId);
    return {
      account: publicAccount(account),
      preferences: await db.getPreferences(accountId),
      notificationSubscription: notification ? {
        channel: notification.channel, status: notification.status, verifiedAt: notification.verified_at,
        unsubscribedAt: notification.unsubscribed_at, bouncedAt: notification.bounced_at,
      } : { channel: 'email', status: 'not_configured' },
      usage: {
        alerts: await db.countAlertsForAccount(accountId),
        watchlist: (await db.listWatchlist(accountId)).length,
        apiKeys: (await db.listApiKeys(accountId)).filter((key) => !key.revoked_at).length,
      },
    };
  }

  async function apiAccess(accountId) {
    const active = (await db.listEntitlements(accountId)).filter((entry) => ['active', 'trialing'].includes(entry.status));
    const pro = active.some((entry) => entry.product === 'api:pro');
    const entitled = pro || active.some((entry) => entry.product === 'api:starter');
    const developmentBypass = process.env.ALLOW_SELF_SERVICE_API_KEYS === '1' &&
      process.env.NODE_ENV !== 'production' && process.env.ENABLE_LIVE_BILLING !== '1';
    return { pro, allowed: entitled || developmentBypass };
  }

  async function requestEmailOptIn(req, res, account, {
    allowResubscribe = false,
    legacyOptIn = false,
    limitsEnforced = false,
  } = {}) {
    if (!limitsEnforced) await enforceEmailRequestLimits(req, res, account.email, {
      legacyOptIn,
      notificationOptIn: !legacyOptIn,
    });
    const base = baseUrlFor(req);
    let tokens;
    let outbox;
    await db.transaction(async () => {
      tokens = await db.createNotificationVerification(account.id, 'email', 24 * 60 * 60_000, { allowResubscribe });
      if (!tokens.verifyToken || !tokens.unsubscribeToken) return;
      // The only usable raw tokens live inside the encrypted outbox payload.
      // Persist that payload in the same transaction as their hashes so a
      // crash can never strand a 24-hour pending subscription without mail.
      outbox = await db.enqueueOutbox(mailer.prepare({
        accountId: account.id,
        to: account.email,
        template: 'verify-alerts',
        data: {
          verifyLink: `${base}/email/verify#token=${encodeURIComponent(tokens.verifyToken)}`,
          unsubscribeLink: `${base}/email/unsubscribe#token=${encodeURIComponent(tokens.unsubscribeToken)}`,
        },
        idempotencyKey: `verify-alerts:${account.id}:${tokens.expiresAt}`,
      }));
    });
    if (!tokens.verifyToken || !tokens.unsubscribeToken) {
      return { status: tokens.status, skipped: true, reason: tokens.alreadyActive ? 'already-active' : tokens.alreadyPending ? 'already-pending' : 'suppressed' };
    }
    return mailer.complete(outbox);
  }

  const jobWorker = createJobWorker(db, {
    'collect-product': async ({ productId, vertical, q }) => {
      requireRuntimeVertical(vertical);
      const product = productId ? await db.getProduct(productId) : null;
      // A refresh job always targets an existing immutable product identity.
      // If deletion won the race, completing the job must be a no-op rather
      // than recreating its query as a new/global product.
      if (productId && !product) return;
      if (product?.owner_account_id && !await accountsEnabled()) return;
      if (product && product.evidence?.refreshable !== true) return;
      await runSearch(vertical, product?.evidence?.originalQuery || q, productId || null);
    },
    'deliver-email': async () => { await mailer.processPending(25); },
    'evaluate-alerts': async ({ productId, trueCents, pointAt, eligible = false, stale = true }) => {
      if (!await accountsEnabled()) return;
      if (!eligible || stale) return;
      const product = await db.getProduct(productId);
      if (!product) return;
      if (!productAlertEligible(product)) return;
      const latest = await db.getLatestPoint(productId, { eligibleOnly: false });
      const latestEvidence = latest ? currentSourceEvidence({ ...product, evidence: {
        ...latest.evidence,
        refreshable: product.evidence?.refreshable === true,
      } }) : null;
      if (!latest || !latest.alertEligible || latestEvidence?.provenance?.alertEligible !== true ||
          latestEvidence?.provenance?.stale === true || latest.true_cents !== trueCents || latest.ts !== pointAt) return;
      const base = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
      for (const alert of await db.listEvaluableAlerts(productId)) {
        const triggerKey = `${productId}:${pointAt}:${trueCents}`;
        let evaluation;
        let outbox;
        await db.transaction(async () => {
          evaluation = await db.evaluateAlertCondition(alert.id, trueCents, triggerKey, pointAt);
          if (!evaluation.notify) return;
          const unsubscribeToken = await db.createAlertUnsubscribeToken(alert.account_id, alert.id);
          // The threshold state, unsubscribe capability, and durable message
          // are one commit. A failed enqueue rolls the crossing back so the
          // leased job can retry without losing a paid alert.
          outbox = await db.enqueueOutbox(mailer.prepare({
            accountId: alert.account_id, to: alert.account_email, template: 'price-alert',
            metadata: {
              alertId: alert.id, triggerKey, productId, pointAt, trueCents,
              requiresFreshSubscriptionCatalog: product.vertical === 'subscription',
            },
            data: {
              productName: product.name,
              truePrice: new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(trueCents / 100),
              productLink: `${base}/p/${encodeURIComponent(productId)}`,
              provenanceLabel: product.source_label || 'verified price source',
              unsubscribeLink: `${base}/alerts/unsubscribe#token=${encodeURIComponent(unsubscribeToken)}`,
            },
            idempotencyKey: `price-alert:${alert.id}:${triggerKey}`,
          }));
        });
        if (!evaluation.notify) continue;
        await mailer.complete(outbox);
      }
    },
    'weekly-digest': async ({ accountId, week }) => {
      if (!await accountsEnabled()) return;
      if (!await db.isWeeklyDigestEligible(accountId)) return;
      const account = await db.getAccountById(accountId);
      if (!account) return;
      const base = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
      const watchlist = (await db.listWatchlist(accountId)).slice(0, 20);
      let includesFreshSubscriptionCatalog = false;
      const productSnapshots = [];
      const items = [];
      for (const product of watchlist) {
        const latest = await db.getLatestPoint(product.product_id, { eligibleOnly: false });
        const latestEvidence = latest ? currentSourceEvidence({ ...product, evidence: {
          ...latest.evidence,
          refreshable: product.evidence?.refreshable === true,
        } }) : null;
        if (!productAlertEligible(product) || !latest?.alertEligible ||
            latestEvidence?.provenance?.alertEligible !== true || latestEvidence?.provenance?.stale === true) continue;
        if (product.vertical === 'subscription') includesFreshSubscriptionCatalog = true;
        productSnapshots.push({ productId: product.product_id, pointAt: latest.ts, trueCents: latest.true_cents });
        items.push({
          name: product.name,
          currentPrice: new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(latest.true_cents / 100),
          link: `${base}/p/${encodeURIComponent(product.product_id)}`,
        });
      }
      if (items.length === 0) return;
      const unsubscribeToken = await db.createNotificationUnsubscribeToken(accountId);
      if (!unsubscribeToken) return;
      await mailer.enqueue({
        accountId, to: account.email, template: 'weekly-digest',
        metadata: { requiresFreshSubscriptionCatalog: includesFreshSubscriptionCatalog, productSnapshots },
        data: { items, unsubscribeLink: `${base}/email/unsubscribe#token=${encodeURIComponent(unsubscribeToken)}` },
        idempotencyKey: `weekly-digest:${accountId}:${week}`,
      });
    },
  });

  // Kept as callable work units so request-scoped hosts can run them from
  // scheduled functions without relying on a frozen setInterval callback.
  async function runMaintenance() {
    readLimiter.prune();
    writeLimiter.prune();
    b2bLimiter.prune();
    authLimiter.prune();
    authIpLimiter.prune();
    notificationEmailLimiter.prune();
    notificationIpLimiter.prune();
    legacyOptInIpLimiter.prune();
    accountSearchLimiter.prune();
    tokenMutationLimiter.prune();
    stripeWebhookPreauthLimiter.prune();
    emailWebhookPreauthLimiter.prune();
    await db.prunePendingKeys(); // drop unclaimed once-shown keys after their TTL
    await db.pruneAuth();
    await db.pruneOperationalData({
      completedJobDays: Math.max(1, Number(process.env.JOB_RETENTION_DAYS) || 14),
      deliveryEventDays: Math.max(1, Number(process.env.DELIVERY_EVENT_RETENTION_DAYS) || 90),
      outboxDays: Math.max(1, Number(process.env.OUTBOX_RETENTION_DAYS) || 30),
    });
    await db.pruneAllPrivateProductHistory({
      maxPoints: Math.min(5000, Math.max(10, Number(process.env.PRIVATE_HISTORY_MAX_POINTS) || 500)),
      maxDays: Math.min(3650, Math.max(1, Number(process.env.PRIVATE_HISTORY_RETENTION_DAYS) || 365)),
    });
    const cacheCutoff = Date.now();
    for (const [key, entry] of providerCache) if (entry.expiresAt <= cacheCutoff) providerCache.delete(key);
    // Full SQLite integrity probes are intentionally not scheduled in this
    // synchronous HTTP process: on a multi-GB database even a low-frequency
    // PRAGMA quick_check can freeze webhook and request handling. The startup
    // result remains cached for readiness; operators run additional checks on
    // a backup/offline copy as part of the documented maintenance workflow.
    return { providerCacheEntries: providerCache.size, completedAt: new Date().toISOString() };
  }

  async function scheduleWorkerJobs({ now = new Date() } = {}) {
    const intervalMinutes = Math.min(1440, Math.max(15, Number(process.env.COLLECTION_INTERVAL_MINUTES) || 60));
    const nowMs = now instanceof Date ? now.getTime() : Number(now);
    if (!Number.isFinite(nowMs)) throw new TypeError('worker schedule now must be a Date or epoch milliseconds');
    const cycleDate = new Date(nowMs);
    const bucket = Math.floor(nowMs / (intervalMinutes * 60_000));
    const accountProcessing = await accountsEnabled();
    let collectionJobs = 0;
    for (const product of (await db.listTrackedProducts()).filter((entry) => productionVerticals.includes(entry.vertical) && entry.evidence?.refreshable === true && (accountProcessing || !entry.owner_account_id))) {
      await db.enqueueJob('collect-product', { productId: product.id, vertical: product.vertical, q: product.name.slice(0, 120) }, {
        idempotencyKey: `collect:${product.id}:${bucket}`,
      });
      collectionJobs += 1;
    }
    const configuredDigestDay = Number(process.env.DIGEST_WEEKDAY_UTC);
    const digestWeekday = Number.isInteger(configuredDigestDay) ? Math.min(6, Math.max(0, configuredDigestDay)) : 1;
    let digestJobs = 0;
    if (accountProcessing && cycleDate.getUTCDay() === digestWeekday) {
      const thursday = new Date(Date.UTC(cycleDate.getUTCFullYear(), cycleDate.getUTCMonth(), cycleDate.getUTCDate()));
      thursday.setUTCDate(thursday.getUTCDate() + 4 - (thursday.getUTCDay() || 7));
      const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
      const week = `${thursday.getUTCFullYear()}-W${String(Math.ceil((((thursday - yearStart) / 86_400_000) + 1) / 7)).padStart(2, '0')}`;
      for (const account of await db.listWeeklyDigestRecipients()) {
        await db.enqueueJob('weekly-digest', { accountId: account.id, week }, { idempotencyKey: `weekly-digest-job:${account.id}:${week}` });
        digestJobs += 1;
      }
    }
    return { collectionJobs, digestJobs };
  }

  async function drainWorkerQueues() {
    const accountProcessing = await accountsEnabled();
    const errors = [];
    const emailPromise = accountProcessing
      ? mailer.processPending(25).catch((error) => {
        console.error('[email worker]', error.message);
        errors.push({ worker: 'email', message: error.message });
        return null;
      })
      : Promise.resolve(null);
    const jobsPromise = jobWorker.tick().catch((error) => {
      console.error('[job worker]', error.message);
      errors.push({ worker: 'jobs', message: error.message });
      return [];
    });
    const [email, jobs] = await Promise.all([emailPromise, jobsPromise]);
    return { email, jobs, errors, completedAt: new Date().toISOString() };
  }

  async function runWorkerCycle({ now = new Date() } = {}) {
    const scheduled = await scheduleWorkerJobs({ now });
    const drained = await drainWorkerQueues();
    return { ...scheduled, ...drained };
  }

  // Sweep idle rate-limit buckets every 5 min so an idle IP is dropped from
  // memory within ~15 min of its last request (prune evicts buckets idle >10
  // min) — this is what makes the privacy policy's "held only transiently" true
  // even at low traffic, not just under saturation. unref() so it never keeps
  // the process alive.
  const sweep = startTimers ? setInterval(() => {
    runMaintenance().catch((error) => console.error('[maintenance]', error.message));
  }, 5 * 60 * 1000) : null;
  if (sweep && typeof sweep.unref === 'function') sweep.unref();

  const workerTimer = startTimers && process.env.DISABLE_WORKER !== '1' ? setInterval(() => {
    runWorkerCycle().catch((error) => console.error('[worker cycle]', error.message));
  }, 5000) : null;
  if (workerTimer && typeof workerTimer.unref === 'function') workerTimer.unref();

  async function handle(req, res) {
    const started = Date.now();
    const ip = clientIp(req);
    const requestId = makeRequestId(req.headers['x-request-id']);
    req.priceTruthRequestId = requestId;
    res.setHeader('X-Request-Id', requestId);
    applySecurityHeaders(res);
    let pathname = req.url || '/';
    let isApi = false;
    let webhookPreauthKey = null;
    let webhookPreauthRoute = null;
    let webhookContext = null;

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
      const isWebhook = pathname === '/api/billing/webhook' || pathname === '/api/email/webhook';
      if (isWebhook) {
        webhookContext = {
          route: pathname === '/api/billing/webhook' ? 'billing' : 'email',
          phase: 'preauth',
          rejectionRecorded: false,
        };
        req.webhookContext = webhookContext;
        if (req.method !== 'POST') throw new HttpError(405, 'method not allowed');
        webhookContext.phase = 'body';
        const routeLimit = pathname === '/api/billing/webhook'
          ? Math.min(512 * 1024, Math.max(16 * 1024, Number(process.env.STRIPE_WEBHOOK_BODY_LIMIT_BYTES) || 256 * 1024))
          : Math.min(256 * 1024, Math.max(8 * 1024, Number(process.env.EMAIL_WEBHOOK_BODY_LIMIT_BYTES) || 128 * 1024));
        const contentLength = req.headers['content-length'];
        if (contentLength !== undefined) {
          const bytes = Number(contentLength);
          if (!Number.isSafeInteger(bytes) || bytes < 0) throw new HttpError(400, 'invalid Content-Length');
          if (bytes > routeLimit) throw new HttpError(413, `webhook body exceeds ${routeLimit} bytes`);
        }
        webhookContext.phase = 'preauth';
        const preauthLimiter = pathname === '/api/billing/webhook' ? stripeWebhookPreauthLimiter : emailWebhookPreauthLimiter;
        const preauth = preauthLimiter.check(ip);
        const candidatePreauthKey = `${pathname}:${ip}`;
        if (!preauth.ok || (webhookPreauthActive.get(candidatePreauthKey) || 0) >= webhookPreauthLimitPerIp) {
          res.setHeader('Retry-After', String(preauth.retryAfterSec || 1));
          throw new HttpError(503, 'webhook receiver is busy; retry with backoff');
        }
        const durablePreauth = await durableRateCheck(
          req,
          `webhook-preauth:${webhookContext.route}:${ip}`,
          webhookPreauthRate,
          `webhook-${webhookContext.route}-preauth`,
        );
        if (durablePreauth && !durablePreauth.ok) {
          rejectRateLimit(res, durablePreauth, 'webhook receiver is busy; retry with backoff', 503);
        }
        webhookPreauthActive.set(candidatePreauthKey, (webhookPreauthActive.get(candidatePreauthKey) || 0) + 1);
        webhookPreauthKey = candidatePreauthKey;
        webhookPreauthRoute = webhookContext.route;
        webhookState.preauth.active += 1;
        webhookState.preauth.peakActive = Math.max(webhookState.preauth.peakActive, webhookState.preauth.active);
        const routeState = webhookState.routes[webhookPreauthRoute];
        routeState.preauthActive += 1;
        routeState.preauthPeak = Math.max(routeState.preauthPeak, routeState.preauthActive);
        webhookContext.phase = 'body';
      }
      // /billing/mock-* performs DB writes (mints keys, records events), so it is
      // rate-limited too — treated as a write regardless of HTTP method.
      const isMockBilling = pathname.startsWith('/billing/mock-');
      if ((isApi && !isWebhook) || isMockBilling || pathname.startsWith('/go/') || pathname.startsWith('/download/')) {
        const limiter = (req.method === 'GET' && !isMockBilling) ? readLimiter : writeLimiter;
        let rateKey = ip;
        if (limiter === writeLimiter) {
          const auth = await currentSession(req, res);
          if (auth?.session?.account_id) {
            rateKey = `account:${auth.session.account_id}`;
          } else if (typeof req.headers['x-api-key'] === 'string') {
            const key = await db.findApiKey(req.headers['x-api-key']);
            if (key) rateKey = key.owner_account_id ? `account:${key.owner_account_id}` : `api-key:${key.id}`;
          } else if (isAdmin(req)) {
            rateKey = `admin:${crypto.createHash('sha256').update(req.headers['x-admin-token']).digest('hex')}`;
          }
        }
        const rl = limiter.check(rateKey);
        applyRateHeaders(res, rl);
        if (!rl.ok) {
          res.setHeader('Retry-After', String(rl.retryAfterSec));
          throw new HttpError(429, 'rate limit exceeded; slow down');
        }
        if (limiter === writeLimiter && rateKey !== ip && !pathname.startsWith('/api/v1/')) {
          const durableWrite = await durableRateCheck(req, `principal-write:${rateKey}`, writeRate, 'principal-write');
          if (durableWrite && !durableWrite.ok) {
            rejectRateLimit(res, durableWrite, 'rate limit exceeded; slow down');
          }
          applyRateHeaders(res, durableWrite);
        }
      }

      const tokenMutation = req.method === 'POST' && [
        '/api/auth/verify',
        '/api/notifications/email/verify',
        '/api/notifications/email/unsubscribe',
        '/api/alerts/unsubscribe',
      ].includes(pathname);
      if (tokenMutation) {
        const localTokenLimit = tokenMutationLimiter.check(`${pathname}:${ip}`);
        applyRateHeaders(res, localTokenLimit);
        if (!localTokenLimit.ok) rejectRateLimit(res, localTokenLimit, 'too many token attempts; try again later');
        const durableTokenLimit = await durableRateCheck(req, `token-mutation:${pathname}:${ip}`, tokenMutationRate, 'token-mutation');
        if (durableTokenLimit && !durableTokenLimit.ok) {
          rejectRateLimit(res, durableTokenLimit, 'too many token attempts; try again later');
        }
        applyRateHeaders(res, durableTokenLimit);
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
      if (webhookContext) recordWebhookRejection(webhookContext);
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
      else if (isApi) sendJson(res, status, { error: message, code: err?.code || errorCode(status), requestId, ...(err?.details && typeof err.details === 'object' ? err.details : {}) });
      else sendHtml(res, status, `<!doctype html><meta charset="utf-8"><title>${status}</title><h1>${status}</h1><p>${escapeHtml(message)}</p>`);
    } finally {
      if (webhookPreauthKey) {
        const active = Math.max(0, (webhookPreauthActive.get(webhookPreauthKey) || 1) - 1);
        if (active === 0) webhookPreauthActive.delete(webhookPreauthKey);
        else webhookPreauthActive.set(webhookPreauthKey, active);
        webhookState.preauth.active = Math.max(0, webhookState.preauth.active - 1);
        const routeState = webhookState.routes[webhookPreauthRoute];
        routeState.preauthActive = Math.max(0, routeState.preauthActive - 1);
      }
      // Sanitized before logging: printable ASCII only, capped length (log-injection guard).
      const safePath = pathname.replace(/[^\x20-\x7e]/g, '?').slice(0, 200);
      console.log(`${requestId} ${req.method} ${safePath} ${res.statusCode} ${Date.now() - started}ms`);
    }
  }

  async function handleApi(req, res, url, pathname) {
    if (req.method === 'GET' && pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, version: PKG.version, uptimeSeconds: Math.floor(process.uptime()) });
    }
    if (req.method === 'GET' && pathname === '/api/ready') {
      const readiness = await readinessReport();
      return sendJson(res, readiness.ok ? 200 : 503, readiness);
    }
    if (req.method === 'GET' && pathname === '/api/openapi') {
      let document;
      try { document = fs.readFileSync(openapiPath); }
      catch { throw new HttpError(503, 'OpenAPI document is unavailable'); }
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': document.length,
        'Cache-Control': 'no-store',
      });
      return res.end(document);
    }
    if (req.method === 'GET' && pathname === '/api/meta') {
      return sendJson(res, 200, buildMeta(await readinessReport(), productionVerticals, baseUrlFor(req)));
    }

    // Tokens are emitted only in URL fragments by current email templates.
    // Query-string bridge routes are intentionally gone: even a non-consuming
    // redirect would leave a reusable bearer token in proxy/CDN access logs.
    if (req.method === 'GET' && ['/api/auth/verify', '/api/notifications/email/verify', '/api/notifications/email/unsubscribe', '/api/alerts/unsubscribe'].includes(pathname)) {
      throw new HttpError(410, 'query-token links are no longer accepted; open the original fragment-based email link');
    }

    const usesAccounts = pathname.startsWith('/api/auth/') || pathname === '/api/session' ||
      pathname.startsWith('/api/account') || pathname.startsWith('/api/notifications/') ||
      (pathname === '/api/alerts' && req.method === 'POST') ||
      (process.env.NODE_ENV === 'production' && /^\/api\/billing\/(?:checkout|claim|portal)/.test(pathname)) ||
      (billing.mode() === 'live' && pathname.startsWith('/api/billing/'));
    if (usesAccounts) await requireAccountCapability();

    // ---- passwordless identity and session lifecycle ----
    if (req.method === 'POST' && ['/api/auth/request', '/api/auth/request-link'].includes(pathname)) {
      const body = await readJsonBody(req);
      const email = validate.email(body.email);
      await enforceEmailRequestLimits(req, res, email);
      const account = await db.getOrCreateAccount(email);
      const authToken = await db.createAuthToken(account.id);
      const delivery = authToken.suppressed ? { status: 'queued' } : await mailer.enqueue({
        accountId: account.id,
        to: account.email,
        template: 'magic-link',
        data: { link: `${baseUrlFor(req)}/auth/verify#token=${encodeURIComponent(authToken.token)}` },
        idempotencyKey: `magic-link:${account.id}:${authToken.id}`,
      });
      return sendJson(res, 202, {
        accepted: true,
        delivery: { status: delivery.status === 'sent' ? 'sent' : delivery.status === 'failed' ? 'disabled' : 'queued' },
        message: 'If the address can receive mail, a sign-in link is on its way.',
      });
    }
    if (req.method === 'POST' && pathname === '/api/auth/verify') {
      // Consuming a magic link establishes ambient cookie credentials. Reject
      // login-CSRF attempts before reading or consuming the one-time token so a
      // hostile origin cannot log a victim into the attacker's account (or
      // burn the link with a simple cross-site form/text request).
      assertSameOrigin(req, new URL(baseUrlFor(req)).origin);
      if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) {
        throw new HttpError(400, 'sign-in verification requires application/json');
      }
      const token = validate.token((await readJsonBody(req)).token);
      const verified = await db.consumeAuthToken(token);
      if (!verified) throw new HttpError(400, 'sign-in link is invalid, expired, or already used');
      const ttlDays = Math.min(90, Math.max(1, Number(process.env.SESSION_TTL_DAYS) || 30));
      const session = await db.createSession(verified.account_id, {
        ttlMs: ttlDays * 86_400_000,
        userAgent: String(req.headers['user-agent'] || '').slice(0, 500), ip: clientIp(req),
      });
      setAuthCookies(req, res, session, session.csrfToken);
      return sendJson(res, 200, { authenticated: true, csrfToken: session.csrfToken, account: publicAccount(verified.account) });
    }
    if (req.method === 'GET' && pathname === '/api/session') {
      const auth = await currentSession(req, res, { issueCsrf: true });
      if (!auth) return sendJson(res, 200, { authenticated: false });
      return sendJson(res, 200, { authenticated: true, csrfToken: auth.csrfToken, account: publicAccount(auth.session) });
    }
    if (req.method === 'DELETE' && pathname === '/api/session') {
      const auth = await requireSession(req, res, { csrf: true });
      await db.revokeSession(auth.token);
      clearAuthCookies(req, res);
      return sendJson(res, 200, { authenticated: false });
    }

    // ---- account-owned data ----
    if (req.method === 'GET' && pathname === '/api/account') {
      const auth = await requireSession(req, res);
      return sendJson(res, 200, await accountPayload(auth.session.account_id));
    }
    if (req.method === 'PATCH' && pathname === '/api/account/preferences') {
      const auth = await requireSession(req, res, { csrf: true });
      const body = await readJsonBody(req);
      const patch = {};
      if (body.email_alerts !== undefined) patch.email_alerts = validate.bool(body.email_alerts, 'email_alerts');
      if (body.weekly_digest !== undefined) patch.weekly_digest = validate.bool(body.weekly_digest, 'weekly_digest');
      if (body.timezone !== undefined) patch.timezone = validate.timezone(body.timezone);
      if (Object.keys(patch).length === 0) throw new HttpError(400, 'provide at least one preference');
      return sendJson(res, 200, { preferences: await db.updatePreferences(auth.session.account_id, patch) });
    }
    if (req.method === 'GET' && pathname === '/api/account/watchlist') {
      const auth = await requireSession(req, res);
      const items = (await db.listWatchlist(auth.session.account_id)).map((row) => {
        const evidence = currentSourceEvidence(row);
        return {
          product_id: row.product_id,
          created_at: row.created_at,
          product: {
            id: row.product_id, vertical: row.vertical, name: row.name, url: row.url,
            refreshable: evidence?.refreshable === true,
            alertEligible: productAlertEligible({ ...row, evidence }),
            deletable: row.visibility === 'private' && row.owner_account_id === auth.session.account_id,
          },
          provenance: { source: row.source, sourceLabel: row.source_label, certainty: row.certainty, fetchedAt: row.fetched_at, evidence },
        };
      });
      return sendJson(res, 200, { items });
    }
    if (req.method === 'POST' && pathname === '/api/account/watchlist') {
      const auth = await requireSession(req, res, { csrf: true });
      const body = await readJsonBody(req);
      const productId = validate.id(body.product_id, 'product_id');
      const visibleProduct = await db.getVisibleProduct(productId, auth.session.account_id);
      if (!visibleProduct || !productionVerticals.includes(visibleProduct.vertical)) throw new HttpError(404, 'unknown product');
      const row = await db.addWatchlist(auth.session.account_id, productId);
      const tracked = await db.getVisibleProduct(productId, auth.session.account_id);
      const trackedEvidence = currentSourceEvidence(tracked);
      if (trackedEvidence?.refreshable === true && trackedEvidence?.provenance?.stale !== true) {
        const intervalMinutes = Math.min(1440, Math.max(15, Number(process.env.COLLECTION_INTERVAL_MINUTES) || 60));
        const bucket = Math.floor(Date.now() / (intervalMinutes * 60_000));
        await db.enqueueJob('collect-product', { productId, vertical: tracked.vertical, q: tracked.evidence?.originalQuery || tracked.name.slice(0, 120) }, { idempotencyKey: `collect:${productId}:${bucket}` });
      }
      return sendJson(res, 201, { created: true, item: { product_id: row.product_id, created_at: row.created_at, product: {
        id: row.product_id, name: row.name, vertical: row.vertical, url: row.url,
        refreshable: trackedEvidence?.refreshable === true,
        alertEligible: productAlertEligible({ ...tracked, evidence: trackedEvidence }),
        deletable: tracked.visibility === 'private' && tracked.owner_account_id === auth.session.account_id,
      } } });
    }
    const watchlistMatch = pathname.match(/^\/api\/account\/watchlist\/([a-z0-9-]{1,64})$/);
    if (req.method === 'DELETE' && watchlistMatch) {
      const auth = await requireSession(req, res, { csrf: true });
      const deleted = await db.removeWatchlist(auth.session.account_id, watchlistMatch[1]);
      if (!deleted) throw new HttpError(404, 'watchlist item not found');
      return sendJson(res, 200, { deleted: true });
    }
    const privateProductMatch = pathname.match(/^\/api\/account\/products\/([a-z0-9-]{1,64})$/);
    if (req.method === 'DELETE' && privateProductMatch) {
      const auth = await requireSession(req, res, { csrf: true });
      if (!await db.deletePrivateProduct(auth.session.account_id, privateProductMatch[1])) throw new HttpError(404, 'private product not found');
      return sendJson(res, 200, { deleted: true });
    }
    if (req.method === 'GET' && pathname === '/api/account/alerts') {
      const auth = await requireSession(req, res);
      const premium = await db.isPremium(auth.session.account_id);
      return sendJson(res, 200, { alerts: await db.listAlerts(auth.session.account_id), limit: premium ? PREMIUM_ALERT_LIMIT : FREE_ALERT_LIMIT, plan: premium ? 'premium' : 'free' });
    }
    if (req.method === 'POST' && pathname === '/api/account/alerts') {
      const auth = await requireSession(req, res, { csrf: true });
      const body = await readJsonBody(req);
      const productId = validate.id(body.product_id, 'product_id');
      const threshold = validate.cents(body.threshold_cents, 'threshold_cents');
      const alertProduct = await db.getVisibleProduct(productId, auth.session.account_id);
      if (!alertProduct || !productionVerticals.includes(alertProduct.vertical)) throw new HttpError(404, 'unknown product');
      if (!productAlertEligible(alertProduct)) throw new HttpError(409, 'alerts require a fresh, verified source with a stable refresh identity');
      const premium = await db.isPremium(auth.session.account_id);
      const limit = premium ? PREMIUM_ALERT_LIMIT : FREE_ALERT_LIMIT;
      if (await db.countAlertsForAccount(auth.session.account_id) >= limit) throw new HttpError(402, premium ? `premium accounts are limited to ${limit} alerts` : 'free accounts get 1 price alert');
      const account = await db.getAccountById(auth.session.account_id);
      const notification = await db.getNotification(account.id);
      if (notification && ['bounced', 'complained'].includes(notification.status)) {
        throw new HttpError(409, 'email delivery is suppressed; contact support before creating alerts');
      }
      const status = notification?.status === 'active' ? 'active' : 'pending';
      if (status === 'pending') await enforceEmailRequestLimits(req, res, account.email, { notificationOptIn: true });
      const alert = await db.createAlert({ email: account.email, accountId: account.id, productId, threshold_cents: threshold, status });
      const delivery = status === 'pending' ? await requestEmailOptIn(req, res, account, {
        allowResubscribe: notification?.status === 'unsubscribed', limitsEnforced: true,
      }) : null;
      return sendJson(res, 201, { created: true, alert, verificationDelivery: delivery && { status: delivery.status } });
    }
    const alertMatch = pathname.match(/^\/api\/account\/alerts\/(\d+)$/);
    if (req.method === 'PATCH' && alertMatch) {
      const auth = await requireSession(req, res, { csrf: true });
      const body = await readJsonBody(req), patch = {};
      if (body.threshold_cents !== undefined) patch.threshold_cents = validate.cents(body.threshold_cents, 'threshold_cents');
      if (body.status !== undefined) patch.status = validate.enum(body.status, 'status', ['active', 'paused']);
      const alert = await db.updateAlert(auth.session.account_id, Number(alertMatch[1]), patch);
      if (!alert) throw new HttpError(404, 'alert not found');
      return sendJson(res, 200, { alert });
    }
    if (req.method === 'DELETE' && alertMatch) {
      const auth = await requireSession(req, res, { csrf: true });
      if (!await db.deleteAlert(auth.session.account_id, Number(alertMatch[1]))) throw new HttpError(404, 'alert not found');
      return sendJson(res, 200, { deleted: true });
    }
    if (req.method === 'POST' && pathname === '/api/account/notifications/email/request') {
      const auth = await requireSession(req, res, { csrf: true });
      const delivery = await requestEmailOptIn(req, res, await db.getAccountById(auth.session.account_id), { allowResubscribe: true });
      return sendJson(res, 202, { accepted: true, delivery: { status: delivery.status } });
    }
    if (req.method === 'POST' && pathname === '/api/notifications/email/verify') {
      const subscription = await db.verifyNotification(validate.token((await readJsonBody(req)).token));
      if (!subscription) throw new HttpError(400, 'verification link is invalid, expired, or already used');
      return sendJson(res, 200, { verified: true, channel: subscription.channel, status: subscription.status });
    }
    if (req.method === 'POST' && pathname === '/api/notifications/email/unsubscribe') {
      const subscription = await db.unsubscribeNotification(validate.token((await readJsonBody(req)).token));
      if (!subscription) throw new HttpError(400, 'unsubscribe link is invalid');
      return sendJson(res, 200, { unsubscribed: true, channel: subscription.channel, status: subscription.status });
    }
    if (req.method === 'POST' && pathname === '/api/alerts/unsubscribe') {
      const alert = await db.unsubscribeAlert(validate.token((await readJsonBody(req)).token));
      if (!alert) throw new HttpError(400, 'unsubscribe link is invalid');
      return sendJson(res, 200, { unsubscribed: true, alertId: alert.id, status: alert.status });
    }

    if (req.method === 'GET' && pathname === '/api/account/api-keys') {
      const auth = await requireSession(req, res);
      return sendJson(res, 200, { keys: await db.listApiKeys(auth.session.account_id) });
    }
    if (req.method === 'POST' && pathname === '/api/account/api-keys') {
      const auth = await requireSession(req, res, { csrf: true });
      const body = await readJsonBody(req), account = await db.getAccountById(auth.session.account_id);
      const access = await apiAccess(account.id);
      if (!access.allowed) throw new HttpError(403, 'an active API subscription is required');
      if ((await db.listApiKeys(account.id)).filter((key) => !key.revoked_at).length >= 5) throw new HttpError(409, 'revoke an existing key before creating another');
      const tier = validate.enum(body.tier || (access.pro ? 'pro' : 'starter'), 'tier', access.pro ? ['starter', 'pro'] : ['starter']);
      const label = validate.string(body.label, 'label', 100);
      const { key, record } = await db.createApiKeyRecord(label, tier, { ownerEmail: account.email, ownerAccountId: account.id });
      return sendJson(res, 201, { key, record, note: 'shown once; only a hash is stored' });
    }
    const keyMatch = pathname.match(/^\/api\/account\/api-keys\/(\d+)$/);
    const rotateMatch = pathname.match(/^\/api\/account\/api-keys\/(\d+)\/rotate$/);
    if (req.method === 'POST' && rotateMatch) {
      const auth = await requireSession(req, res, { csrf: true });
      if (!(await apiAccess(auth.session.account_id)).allowed) throw new HttpError(403, 'an active API subscription is required');
      const body = await readJsonBody(req);
      const result = await db.rotateApiKey(auth.session.account_id, Number(rotateMatch[1]), { label: body.label === undefined ? null : validate.string(body.label, 'label', 100) });
      if (!result) throw new HttpError(404, 'active API key not found');
      return sendJson(res, 201, { ...result, note: 'replacement shown once; the previous key is revoked' });
    }
    if (req.method === 'DELETE' && keyMatch) {
      const auth = await requireSession(req, res, { csrf: true });
      if (!await db.revokeApiKey(auth.session.account_id, Number(keyMatch[1]))) throw new HttpError(404, 'active API key not found');
      return sendJson(res, 200, { revoked: true });
    }
    if (req.method === 'POST' && pathname === '/api/account/export') {
      const auth = await requireSession(req, res, { csrf: true });
      return sendJson(res, 200, await db.exportAccount(auth.session.account_id));
    }
    if (req.method === 'DELETE' && pathname === '/api/account') {
      const auth = await requireSession(req, res, { csrf: true });
      const body = await readJsonBody(req);
      if (body.confirm !== 'DELETE') throw new HttpError(400, 'confirm must equal DELETE');
      const active = await db.listActivePaidEntitlements(auth.session.account_id);
      const pending = await db.listPendingCheckoutIntents(auth.session.account_id);
      const account = await db.getAccountById(auth.session.account_id);
      const reconciliation = await db.listPendingBillingReconciliation(auth.session.account_id, account?.stripe_customer || null);
      if (active.length || pending.length || reconciliation.length) {
        const deletionBlock = active.length
          ? 'cancel active billing in the customer portal before deleting this account'
          : pending.length
            ? 'wait for the pending checkout to complete or expire before deleting this account'
            : 'billing reconciliation is pending; contact support before deleting this account';
        throw new HttpError(409, deletionBlock, {
          code: 'ACTIVE_SUBSCRIPTION',
          details: {
            requiresBillingCancellation: active.length > 0,
            portal: '/api/billing/portal',
            activeProducts: active.map((entry) => entry.product),
            pendingPlans: pending.map((entry) => entry.plan),
            pendingBillingReconciliation: reconciliation.map((entry) => entry.event_id),
          },
        });
      }
      if (!await db.deleteAccount(auth.session.account_id)) throw new HttpError(409, 'account cannot be deleted while billing work is pending');
      clearAuthCookies(req, res);
      return sendJson(res, 200, { deleted: true });
    }
    if (req.method === 'POST' && pathname === '/api/analyze') {
      const body = await readJsonBody(req);
      return sendJson(res, 200, runAnalyze(body));
    }
    if (req.method === 'GET' && pathname === '/api/products') {
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 20));
      const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
      const availableVerticals = productionWithoutDemo
        ? productionVerticals.filter((vertical) => providerStatus()[vertical]?.truthUsable === true)
        : productionVerticals;
      const total = await db.countPublicProducts(availableVerticals);
      const items = await Promise.all((await db.listPublicProducts(limit, offset, availableVerticals)).map((p) => productPayload(db, p)));
      return sendJson(res, 200, { products: items, pagination: { limit, offset, total, nextOffset: offset + items.length < total ? offset + items.length : null } });
    }
    const productMatch = pathname.match(/^\/api\/products\/([a-z0-9-]{1,64})$/);
    if (req.method === 'GET' && productMatch) {
      const auth = await accountsEnabled() ? await currentSession(req, res) : null;
      const product = await db.getVisibleProduct(productMatch[1], auth?.session.account_id || null);
      if (!product || !productionVerticals.includes(product.vertical)) throw new HttpError(404, 'unknown product');
      requireRuntimeVertical(product.vertical);
      const days = url.searchParams.get('days') === '90' ? 90 : 30;
      return sendJson(res, 200, await productPayload(db, product, { days, includeHistory: true }));
    }
    const historyMatch = pathname.match(/^\/api\/history\/([a-z0-9-]{1,64})$/);
    if (req.method === 'GET' && historyMatch) {
      const auth = await accountsEnabled() ? await currentSession(req, res) : null;
      const product = await db.getVisibleProduct(historyMatch[1], auth?.session.account_id || null);
      if (!product || !productionVerticals.includes(product.vertical)) throw new HttpError(404, 'unknown product');
      requireRuntimeVertical(product.vertical);
      const days = url.searchParams.get('days') === '90' ? 90 : 30;
      const current = await productPayload(db, product, { days, includeHistory: true });
      const stats = current.stats ? Object.fromEntries(Object.entries(current.stats).filter(([key]) => key !== 'days')) : null;
      return sendJson(res, 200, { points: current.history, stats, days });
    }
    if (req.method === 'POST' && pathname === '/api/alerts') {
      if (process.env.NODE_ENV === 'production') {
        throw new HttpError(410, 'email-only alert signup is retired; sign in and create an account-owned alert');
      }
      const body = await readJsonBody(req);
      const email = validate.email(body.email);
      await enforceEmailRequestLimits(req, res, email, { legacyOptIn: true });
      const id = validate.id(body.product_id, 'product_id');
      const threshold = validate.cents(body.threshold_cents, 'threshold_cents');
      const legacyProduct = await db.getPublicProduct(id);
      if (!legacyProduct || !productionVerticals.includes(legacyProduct.vertical)) throw new HttpError(404, 'unknown product');
      if (!productAlertEligible(legacyProduct)) throw new HttpError(409, 'alerts require a fresh, verified source with a stable refresh identity');
      // Entitlement is the account's real plan — set by a completed checkout
      // (Stripe live) or the mock checkout flow. No client-supplied override.
      const account = await db.getOrCreateAccount(email);
      const notification = await db.getNotification(account.id);
      if (notification) {
        // Email-only compatibility callers never gain ownership merely by
        // knowing an address, and cannot append alerts to a verified,
        // suppressed, or already-pending account. Return a generic accepted
        // response without mutating quota or notification state.
        return sendJson(res, 202, {
          accepted: true, created: false, status: 'pending',
          verificationDelivery: { status: notification.status },
          note: 'Use the signed-in account alert flow to manage alerts.',
        });
      }
      const premium = await db.isPremium(email);
      const existing = await db.countAlertsForEmail(email);
      const limit = premium ? PREMIUM_ALERT_LIMIT : FREE_ALERT_LIMIT;
      if (existing >= limit) {
        return sendJson(res, 402, {
          error: premium ? `premium accounts are limited to ${PREMIUM_ALERT_LIMIT} alerts` : 'free accounts get 1 price alert',
          upgrade: premium ? null : { planId: 'premium', price: '$4/month', includes: `${PREMIUM_ALERT_LIMIT} alerts, weekly deal-quality digests, price-drop email alerts`, checkout: '/api/billing/checkout' },
        });
      }
      // Legacy email-only callers can request an opt-in, but do not own account
      // data merely by knowing an address. Ownership is attached only when the
      // recipient follows the verification link.
      await db.createAlert({ email, accountId: null, productId: id, threshold_cents: threshold, status: 'pending' });
      const delivery = await requestEmailOptIn(req, res, account, { legacyOptIn: true, limitsEnforced: true });
      return sendJson(res, 201, {
        created: true,
        plan: premium ? 'premium' : 'free',
        status: 'pending',
        verificationDelivery: { status: delivery.status },
        note: 'Confirm the emailed double-opt-in link before notifications are activated.',
      });
    }
    if (req.method === 'POST' && pathname === '/api/admin/keys') {
      if (!isAdmin(req)) {
        throw new HttpError(403, 'admin key minting is disabled; use `npm run keygen` locally');
      }
      const body = await readJsonBody(req);
      const label = validate.string(body.label, 'label', 100);
      const tier = validate.enum(body.tier || 'starter', 'tier', Object.keys(B2B_DAILY_LIMIT));
      const canWriteHistory = body.can_write_history === undefined ? false : validate.bool(body.can_write_history, 'can_write_history');
      return sendJson(res, 201, { key: await db.createApiKey(label, tier, { canWriteHistory }), tier, canWriteHistory, note: 'shown once; only a hash is stored' });
    }

    // ---- live search: fetch a real (or labeled-estimate) listing, analyze it,
    // and record a true-price point so history accrues from real observations.
    if (req.method === 'POST' && pathname === '/api/search') {
      const body = await readJsonBody(req);
      const vertical = validate.enum(body.vertical, 'vertical', runtimeSearchVerticals);
      const q = validate.string(body.q, 'q', 120);
      let auth = await accountsEnabled() ? await currentSession(req, res) : null;
      // Anonymous discovery remains tokenless. Once a valid session cookie is
      // present the same request becomes an account mutation (private product
      // creation/provider budget), so it must satisfy the normal origin+CSRF
      // boundary used by every other account write.
      if (auth) auth = await requireSession(req, res, { csrf: true });
      let trackedProductId = null;
      if (auth) {
        const perAccount = accountSearchLimiter.check(`account:${auth.session.account_id}`);
        applyRateHeaders(res, perAccount);
        if (!perAccount.ok) {
          res.setHeader('Retry-After', String(perAccount.retryAfterSec));
          throw new HttpError(429, 'account search rate limit exceeded');
        }
        const durableSearch = await durableRateCheck(
          req,
          `account-search:${auth.session.account_id}`,
          accountSearchRate,
          'account-search',
        );
        if (durableSearch && !durableSearch.ok) {
          rejectRateLimit(res, durableSearch, 'account search rate limit exceeded');
        }
        applyRateHeaders(res, durableSearch);
        const cap = Math.min(10_000, Math.max(1, Number(process.env.PRIVATE_PRODUCT_LIMIT_PER_ACCOUNT) || 100));
        const existingQuery = await db.findPrivateProductByQuery(auth.session.account_id, vertical, q);
        const reusableExisting = existingQuery?.evidence?.refreshable === true &&
          typeof existingQuery.evidence?.providerIdentity === 'string' && existingQuery.evidence.providerIdentity.trim().length > 0;
        trackedProductId = reusableExisting ? existingQuery.id : null;
        if (!reusableExisting && await db.countPrivateProducts(auth.session.account_id) >= cap) {
          throw new HttpError(429, `private product limit reached (${cap}); delete an older private result before adding another`, { code: 'PRIVATE_PRODUCT_LIMIT' });
        }
      }
      return sendJson(res, 200, await runSearch(vertical, q, trackedProductId, { ownerAccountId: auth?.session.account_id || null }));
    }

    // ---- billing ----
    if (req.method === 'POST' && pathname === '/api/billing/checkout') {
      await requireLiveCommerceReady();
      const body = await readJsonBody(req);
      const planId = validate.enum(body.planId, 'planId', Object.keys(billing.PLANS));
      let account = null;
      if (billing.mode() === 'live') account = await db.getAccountById((await requireSession(req, res, { csrf: true })).session.account_id);
      else {
        const auth = await currentSession(req, res);
        account = auth ? await db.getAccountById(auth.session.account_id) : null;
      }
      const email = account?.email || (body.email === undefined ? undefined : validate.email(body.email));
      let intent = null;
      if (billing.mode() === 'live') {
        const termsVersion = String(process.env.LEGAL_TERMS_VERSION || '').trim();
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(termsVersion) || /^(?:tbd|todo|placeholder|example|unknown|latest|current)$/i.test(termsVersion)) {
          throw new HttpError(503, 'checkout is unavailable until an approved terms version is configured');
        }
        if (body.acceptTerms !== true) throw new HttpError(400, 'acceptTerms must be true for live checkout');
        if (typeof body.acceptedTermsVersion !== 'string' || body.acceptedTermsVersion !== termsVersion) {
          throw new HttpError(400, 'acceptedTermsVersion must match the currently published terms version');
        }
        const plan = billing.getPlan(planId);
        const product = billing.entitlementProduct(planId);
        // A recoverable subscription (past_due, unpaid, paused, or incomplete)
        // is still capable of charging again. Treat every nonterminal Stripe
        // entitlement as blocking and route changes through the portal.
        const nonterminalEntitlements = await db.listActivePaidEntitlements(account.id);
        const activeProducts = nonterminalEntitlements.map((entry) => entry.product);
        const conflicts = plan.kind === 'api'
          ? activeProducts.filter((entry) => entry.startsWith('api:'))
          : activeProducts.filter((entry) => entry === product);
        if (conflicts.length) {
          throw new HttpError(409, plan.kind === 'api' && !conflicts.includes(product)
            ? 'manage API plan upgrades or downgrades in the customer portal'
            : 'this account already has an active subscription for that plan', {
            code: 'ACTIVE_SUBSCRIPTION', details: { portal: '/api/billing/portal', activeProducts: conflicts },
          });
        }
        const pendingPlans = (await db.listPendingCheckoutIntents(account.id)).map((entry) => entry.plan);
        const crossPlanPending = pendingPlans.filter((entry) => entry !== planId);
        if (crossPlanPending.length) {
          // Until a signed completion links the account to one Stripe Customer,
          // two plan sessions can create two customers and strand one payment.
          // Serializing all cross-plan checkouts is safer even after linkage.
          throw new HttpError(409, 'another checkout is already pending; finish or let it expire before choosing a different plan', {
            code: 'CHECKOUT_PENDING', details: { pendingPlans },
          });
        }
        await db.recordTermsAcceptance(account.id, termsVersion, { source: 'live-checkout', planId });
        intent = await db.reserveCheckoutIntent(account.id, planId, { termsVersion });
        if (intent.checkout_url) return sendJson(res, 200, { url: intent.checkout_url, mock: false, mode: billing.mode(), reused: true });
      }
      const checkout = await billing.createCheckout({
        planId, email, accountId: account?.id || null, customerId: account?.stripe_customer || null,
        baseUrl: baseUrlFor(req), idempotencyKey: intent?.idempotency_key || null,
      });
      if (intent) await db.updateCheckoutIntent(intent.id, {
        sessionId: checkout.id, url: checkout.url, expiresAt: checkout.expiresAt, paymentStatus: checkout.paymentStatus,
      });
      const { url: checkoutUrl, mock } = checkout;
      return sendJson(res, 200, { url: checkoutUrl, mock, mode: billing.mode() });
    }
    if (req.method === 'GET' && pathname === '/api/billing/checkout/status') {
      const sessionId = url.searchParams.get('session_id') || '';
      if (!/^[A-Za-z0-9_]{6,200}$/.test(sessionId)) throw new HttpError(400, 'invalid session_id');
      const ownershipRequired = billing.mode() !== 'mock';
      const auth = ownershipRequired ? await requireSession(req, res) : await currentSession(req, res);
      const claim = await db.getCheckoutClaim(sessionId);
      if (claim && ownershipRequired && claim.account_id !== auth.session.account_id) throw new HttpError(404, 'checkout session not found');
      if (!claim) {
        const intent = ownershipRequired ? await db.getCheckoutIntentBySession(auth.session.account_id, sessionId) : null;
        if (intent && ['expired', 'failed'].includes(intent.status)) {
          throw new HttpError(409, `checkout ${intent.status}; start a new checkout`, {
            code: 'CHECKOUT_TERMINAL', details: { checkoutStatus: intent.status, requiresAction: true, plan: intent.plan },
          });
        }
        return sendJson(res, 202, { status: 'pending', complete: false, claimable: false, plan: intent?.plan || null, tier: null });
      }
      const status = claim.status === 'claimable' ? 'claimable' : claim.status === 'claimed' ? 'claimed' : 'complete';
      return sendJson(res, 200, { status, complete: true, claimable: status === 'claimable', plan: claim.plan, tier: claim.tier || null });
    }
    if (req.method === 'POST' && pathname === '/api/billing/claim') {
      const body = await readJsonBody(req), sessionId = body.session_id || '';
      if (!/^[A-Za-z0-9_]{6,200}$/.test(sessionId)) throw new HttpError(400, 'invalid session_id');
      const ownershipRequired = billing.mode() !== 'mock';
      const auth = ownershipRequired ? await requireSession(req, res, { csrf: true }) : await currentSession(req, res);
      const claim = await db.getCheckoutClaim(sessionId);
      if (claim && ownershipRequired && claim.account_id !== auth.session.account_id) throw new HttpError(404, 'checkout session not found');
      if (!claim) return sendJson(res, 202, { status: 'pending', complete: false, claimable: false, plan: null, tier: null });
      if (claim.status === 'claimed') throw new HttpError(409, 'the API key for this checkout was already claimed');
      if (claim.status !== 'claimable') throw new HttpError(404, 'this checkout did not create an API key');
      const pending = await db.takePendingKey(sessionId, ownershipRequired ? auth.session.account_id : undefined);
      if (!pending) throw new HttpError(409, 'the API key is no longer claimable');
      return sendJson(res, 200, { key: pending.raw_key, tier: pending.tier, plan: claim.plan, status: 'claimed', note: 'shown once; store it now' });
    }
    if (req.method === 'GET' && pathname === '/api/billing/claim') {
      if (billing.mode() !== 'mock') throw new HttpError(405, 'use POST /api/billing/claim');
      const sessionId = url.searchParams.get('session_id') || '';
      if (!/^[A-Za-z0-9_]{6,200}$/.test(sessionId)) throw new HttpError(400, 'invalid session_id');
      const pending = await db.takePendingKey(sessionId);
      if (!pending) throw new HttpError(404, 'no key to claim for this session (already claimed or not an API purchase)');
      return sendJson(res, 200, { key: pending.raw_key, tier: pending.tier, note: 'shown once; store it now' });
    }
    if (req.method === 'POST' && pathname === '/api/billing/portal') {
      const body = await readJsonBody(req);
      let acct;
      if (billing.mode() !== 'mock') acct = await db.getAccountById((await requireSession(req, res, { csrf: true })).session.account_id);
      else {
        const auth = await currentSession(req, res);
        acct = auth ? await db.getAccountById(auth.session.account_id) : await db.getAccount(validate.email(body.email));
      }
      if (!acct || !acct.stripe_customer) {
        if (billing.mode() === 'mock') return sendJson(res, 200, { url: `${baseUrlFor(req)}/billing/mock-portal`, mock: true });
        throw new HttpError(404, 'no billing account for that email');
      }
      const { url: portalUrl, mock } = await billing.createPortal({ customerId: acct.stripe_customer, baseUrl: baseUrlFor(req) });
      return sendJson(res, 200, { url: portalUrl, mock });
    }
    if (req.method === 'POST' && pathname === '/api/billing/webhook') {
      if (process.env.NODE_ENV === 'production' && billing.mode() !== 'live') {
        throw new HttpError(503, 'billing webhooks are disabled until live billing passes readiness');
      }
      const telemetry = req.webhookContext;
      telemetry.phase = 'body';
      const raw = await readRawBody(req, {
        limitBytes: Math.min(512 * 1024, Math.max(16 * 1024, Number(process.env.STRIPE_WEBHOOK_BODY_LIMIT_BYTES) || 256 * 1024)),
        timeoutMs: Number(process.env.WEBHOOK_BODY_TIMEOUT_MS) || 10_000,
      });
      let event;
      telemetry.phase = 'signature';
      event = billing.verifyWebhook(raw, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
      markWebhookVerified(telemetry);
      const expectsLiveEvent = billing.mode() === 'live';
      if (event?.livemode !== expectsLiveEvent) {
        throw new HttpError(400, 'billing webhook mode does not match this deployment');
      }
      telemetry.phase = 'budget';
      const budget = webhookBudget.check('stripe');
      if (!budget.ok) throw new HttpError(503, 'billing webhook processing is busy; retry with backoff');
      const durableBudget = await durableRateCheck(req, 'webhook-budget:billing', {
        capacity: webhookBudgetCapacity,
        refillPerSec: webhookBudgetRefillPerSecond,
      }, 'webhook-billing-budget');
      if (durableBudget && !durableBudget.ok) {
        rejectRateLimit(res, durableBudget, 'billing webhook processing is busy; retry with backoff', 503);
      }
      const release = beginWebhookProcessing(telemetry);
      try {
        const result = await billing.applyEvent(event, db);
        if (result.retryable) throw new HttpError(503, 'billing event is queued for reconciliation and should be retried');
        sendJson(res, 200, { received: true, ...result });
        recordWebhookAccepted(telemetry);
        return;
      } finally {
        release();
      }
    }
    if (req.method === 'POST' && pathname === '/api/email/webhook') {
      const telemetry = req.webhookContext;
      telemetry.phase = 'body';
      const raw = await readRawBody(req, {
        limitBytes: Math.min(256 * 1024, Math.max(8 * 1024, Number(process.env.EMAIL_WEBHOOK_BODY_LIMIT_BYTES) || 128 * 1024)),
        timeoutMs: Number(process.env.WEBHOOK_BODY_TIMEOUT_MS) || 10_000,
      });
      let event;
      telemetry.phase = 'signature';
      event = verifyDeliveryWebhook(raw, req.headers);
      markWebhookVerified(telemetry);
      telemetry.phase = 'budget';
      const budget = webhookBudget.check('email');
      if (!budget.ok) throw new HttpError(503, 'email webhook processing is busy; retry with backoff');
      const durableBudget = await durableRateCheck(req, 'webhook-budget:email', {
        capacity: webhookBudgetCapacity,
        refillPerSec: webhookBudgetRefillPerSecond,
      }, 'webhook-email-budget');
      if (durableBudget && !durableBudget.ok) {
        rejectRateLimit(res, durableBudget, 'email webhook processing is busy; retry with backoff', 503);
      }
      const release = beginWebhookProcessing(telemetry);
      try {
        const type = String(event.type || '').replace(/^email\./, '');
        const data = event.data || {};
        const messageId = data.email_id || data.id || null;
        const recorded = await db.recordDeliveryEvent({
          provider: 'resend', providerEventId: req.headers['svix-id'] || req.headers['webhook-id'] || event.id,
          providerMessageId: messageId, type, payload: { created_at: event.created_at || null },
          occurredAt: event.created_at && !Number.isNaN(Date.parse(event.created_at)) ? new Date(event.created_at).toISOString() : new Date().toISOString(),
        });
        // A provider can race its delivery webhook ahead of the send response
        // that attaches provider_message_id to our outbox row. Retry the mapping
        // even for a deduplicated replay; markOutboxSent also reconciles events
        // that arrived first.
        if (['bounced', 'complained'].includes(type)) await db.updateNotificationByProvider(messageId, type);
        sendJson(res, 200, { received: true, duplicate: !recorded });
        recordWebhookAccepted(telemetry);
        return;
      } finally {
        release();
      }
    }

    // ---- admin metrics (revenue + usage), token-gated ----
    if (req.method === 'GET' && pathname === '/api/admin/metrics') {
      if (!isAdmin(req)) throw new HttpError(403, 'admin token required');
      return sendJson(res, 200, {
        billing: { mode: billing.mode(), ...await db.revenueSummary(12) },
        usage: await db.metrics(),
        providers: providerStatus(),
        generatedAt: new Date().toISOString(),
      });
    }

    throw new HttpError(404, 'unknown API route');
  }

  // Fetch a listing via the provider layer, analyze it, upsert it as a tracked
  // product, and append a real true-price point so history builds over time.
  async function searchWithProviderControls(vertical, q) {
    if (!validateProviderQuery({ vertical, q })) throw new HttpError(400, `query is not valid for the ${vertical} provider`);
    const ttlMs = Math.min(60 * 60_000, Math.max(5_000, Number(process.env.PROVIDER_QUERY_CACHE_SECONDS) * 1000 || 5 * 60_000));
    const cacheKey = crypto.createHash('sha256').update(`${vertical}:${String(q).trim().toLowerCase()}`).digest('hex');
    const cached = providerCache.get(cacheKey);
    const state = providerStatus()[vertical];
    if (cached && cached.expiresAt > Date.now()) {
      const value = structuredClone(cached.value);
      const provenance = value?.provenance || {};
      const asOfMs = Date.parse(provenance.asOf || value?.fetchedAt || '');
      const maxAgeSeconds = Number(provenance.maxAgeSeconds) || 0;
      const ageSeconds = Number.isFinite(asOfMs) ? Math.max(0, Math.floor((Date.now() - asOfMs) / 1000)) : null;
      const stale = ageSeconds === null || maxAgeSeconds < 1 || ageSeconds > maxAgeSeconds;
      if (state?.truthUsable === true && !stale) {
        provenance.ageSeconds = ageSeconds;
        provenance.stale = false;
        provenance.alertEligible = provenance.alertEligible === true && value.refreshable === true;
        value.alertEligible = provenance.alertEligible;
        return value;
      }
      providerCache.delete(cacheKey);
    }

    let allowLive = true, reservation = null;
    if (state?.kind === 'live') {
      const name = `PROVIDER_DAILY_BUDGET_${vertical.toUpperCase()}`;
      const dailyLimit = Math.min(1_000_000, Math.max(1, Number(process.env[name]) || Number(process.env.PROVIDER_DAILY_BUDGET) || 1000));
      reservation = await db.reserveProviderCall(vertical, dailyLimit);
      if (!reservation.allowed) {
        allowLive = false;
      }
    }
    let listing;
    try {
      listing = await searchListing({ vertical, q, allowLive });
    } catch (err) {
      if (reservation?.allowed) {
        await db.recordProviderResult(vertical, {
          // A verified no-match still consumed the upstream request budget,
          // but it proves the provider is reachable and must not trip the
          // availability circuit.
          ok: err?.code === 'NO_VERIFIED_RESULT',
          circuitFailures: Math.min(100, Math.max(1, Number(process.env.PROVIDER_CIRCUIT_FAILURES) || 5)),
          circuitMs: Math.min(60 * 60_000, Math.max(1_000, Number(process.env.PROVIDER_CIRCUIT_OPEN_SECONDS) * 1000 || 5 * 60_000)),
        });
      }
      throw err;
    }
    if (reservation?.allowed) {
      await db.recordProviderResult(vertical, {
        ok: true,
        circuitFailures: Math.min(100, Math.max(1, Number(process.env.PROVIDER_CIRCUIT_FAILURES) || 5)),
        circuitMs: Math.min(60 * 60_000, Math.max(1_000, Number(process.env.PROVIDER_CIRCUIT_OPEN_SECONDS) * 1000 || 5 * 60_000)),
      });
    }
    const maxEntries = Math.min(10_000, Math.max(10, Number(process.env.PROVIDER_QUERY_CACHE_MAX) || 1000));
    while (providerCache.size >= maxEntries) providerCache.delete(providerCache.keys().next().value);
    providerCache.set(cacheKey, { expiresAt: Date.now() + ttlMs, value: structuredClone(listing) });
    return listing;
  }

  async function runSearch(vertical, q, trackedProductId = null, { ownerAccountId = null } = {}) {
    requireRuntimeVertical(vertical);
    const existingProduct = trackedProductId ? await db.getProduct(trackedProductId) : null;
    if (trackedProductId && !existingProduct) throw new HttpError(404, 'tracked product no longer exists');
    if (existingProduct && !productionVerticals.includes(existingProduct.vertical)) throw new HttpError(404, 'unknown product');
    if (existingProduct && existingProduct.evidence?.refreshable !== true) throw new HttpError(409, 'this result has no stable provider identity and cannot be refreshed');
    const originalQuery = existingProduct?.evidence?.originalQuery || q;
    const listing = await searchWithProviderControls(vertical, originalQuery);
    const expectedIdentity = existingProduct?.evidence?.providerIdentity || null;
    if (expectedIdentity && listing.providerIdentity !== expectedIdentity) {
      throw new HttpError(502, 'the provider returned a different listing identity; history was not changed');
    }
    let report;
    try {
      report = analyze({ vertical, advertised_cents: listing.advertised_cents, context: listing.context, baseCertainty: engineBaseCertainty(listing.certainty) });
    } catch (err) {
      // A provider handed us a value the engine can't price (out-of-range fee,
      // implausible amount). Report it as an upstream data problem, not a 500.
      if (err instanceof RangeError || err instanceof TypeError) {
        throw new HttpError(502, 'the data source returned a value that could not be priced');
      }
      throw err;
    }
    const pricingComplete = report.completeness?.status === 'complete';
    const alertEligible = Boolean(listing.alertEligible && listing.provenance?.alertEligible && !listing.provenance?.stale && pricingComplete);
    listing.alertEligible = alertEligible;
    listing.provenance = { ...listing.provenance, alertEligible };
    const persisted = Boolean(trackedProductId || ownerAccountId);
    if (!persisted) {
      return { product_id: null, persisted: false, refreshable: Boolean(listing.refreshable), alertEligible: Boolean(listing.alertEligible), listing, report, stats: null, score: dealQuality({}), live: listing.provenance.observed, ...dataClassification({ source: listing.source, evidence: { provenance: listing.provenance }, observed: listing.provenance.observed }) };
    }
    const pointAt = listing.provenance?.asOf || listing.fetchedAt || new Date().toISOString();
    const { id, stored, pointInserted } = await db.transaction(async () => {
      let currentProduct = existingProduct;
      if (trackedProductId) {
        currentProduct = await db.getProduct(trackedProductId);
        const sameTarget = currentProduct &&
          currentProduct.owner_account_id === existingProduct.owner_account_id &&
          currentProduct.visibility === existingProduct.visibility &&
          currentProduct.vertical === existingProduct.vertical &&
          currentProduct.evidence?.providerIdentity === existingProduct.evidence?.providerIdentity;
        if (!sameTarget) throw new HttpError(409, 'tracked product changed or was deleted while refreshing');
      }
      const effectiveOwner = currentProduct?.owner_account_id || ownerAccountId;
      if (effectiveOwner && !await db.getAccountById(effectiveOwner)) {
        throw new HttpError(409, 'the owning account was deleted while refreshing');
      }
      const id = trackedProductId || (listing.refreshable
        ? searchProductId(vertical, listing.name, q, effectiveOwner)
        : searchSnapshotProductId(vertical, q, listing, effectiveOwner));
      await db.upsertProduct({
        id, vertical, name: listing.name, url: listing.url,
        advertised_cents: listing.advertised_cents, context: listing.context,
        source: listing.source, sourceLabel: listing.sourceLabel, certainty: listing.certainty,
        fetchedAt: listing.fetchedAt, evidence: {
          provenance: listing.provenance, items: listing.evidence,
          originalQuery, providerIdentity: listing.providerIdentity, refreshable: Boolean(listing.refreshable),
          alertEligible, pricingComplete,
        },
        visibility: currentProduct?.visibility || 'private', ownerAccountId: effectiveOwner,
      });
      const stored = await db.getProduct(id);
      if (!stored || (effectiveOwner && stored.owner_account_id !== effectiveOwner)) throw new HttpError(409, 'private product ownership conflict');
      const pointInserted = await db.addPricePoint(id, {
        ts: pointAt,
        advertised_cents: listing.advertised_cents, true_cents: report.truePrice.amount_cents,
        source: listing.source, sourceLabel: listing.sourceLabel, certainty: listing.certainty,
        observed: listing.provenance.observed, fetchedAt: listing.fetchedAt,
        alertEligible,
        evidence: { provenance: listing.provenance, items: listing.evidence }, providerKey: listing.source,
      });
      return { id, stored, pointInserted };
    });
    if (stored.visibility === 'private') await db.prunePrivateProductHistory(id, {
      maxPoints: Math.min(5000, Math.max(10, Number(process.env.PRIVATE_HISTORY_MAX_POINTS) || 500)),
      maxDays: Math.min(3650, Math.max(1, Number(process.env.PRIVATE_HISTORY_RETENTION_DAYS) || 365)),
    });
    const stats = await db.getStats(id, 90);
    const score = scoreFromHistory(stats, { currentCents: report.truePrice.amount_cents, feeLoadPct: report.feeLoadPct });
    if (pointInserted && alertEligible) {
      await db.enqueueJob('evaluate-alerts', { productId: id, trueCents: report.truePrice.amount_cents, pointAt, eligible: true, stale: false }, {
        idempotencyKey: `evaluate-alerts:${id}:${pointAt}`,
      });
    }
    return { product_id: id, persisted: true, refreshable: Boolean(listing.refreshable), alertEligible, listing, report, stats: stats ? { days: 90, ...stats } : null, score, live: listing.provenance.observed, ...dataClassification({ source: listing.source, evidence: { provenance: listing.provenance }, observed: listing.provenance.observed }) };
  }

  // Private ids are opaque so owner query text never enters URLs or logs.
  // The readable branch is retained only for curated/public identifiers.
  function searchProductId(vertical, name, q, ownerAccountId = '') {
    if (ownerAccountId) return privateProductId(ownerAccountId, vertical, q);
    const prefix = `s-${vertical}-`;
    const suffix = crypto.createHash('sha256').update(`${vertical}:${q}`).digest('hex').slice(0, 12);
    const rawBasis = `${name || q}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'q';
    const basis = rawBasis.slice(0, Math.max(1, 64 - prefix.length - suffix.length - 1));
    return `${prefix}${basis}-${suffix}`;
  }

  function searchSnapshotProductId(vertical, q, listing, ownerAccountId) {
    if (!ownerAccountId) return searchProductId(vertical, listing.name, q);
    const immutableQuote = JSON.stringify({
      vertical,
      query: String(q).normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase(),
      source: listing.source || null,
      providerIdentity: listing.providerIdentity || null,
      advertised_cents: listing.advertised_cents,
      context: listing.context || {},
      asOf: listing.provenance?.asOf || null,
      fetchedAt: listing.fetchedAt || null,
    });
    return `p-${crypto.createHash('sha256').update(`private-snapshot:v1\0${ownerAccountId}\0${immutableQuote}`).digest('hex').slice(0, 48)}`;
  }

  // Mock billing pages (only reachable when STRIPE is unconfigured). They
  // simulate the Stripe flow so the whole purchase → entitlement/key path is
  // exercisable without keys, and are clearly labeled as simulations.
  async function handleMockBilling(req, res, url, pathname) {
    if (billing.mode() !== 'mock') throw new HttpError(404, 'not found');
    if (process.env.NODE_ENV === 'production' && !await accountsEnabled()) throw new HttpError(503, 'billing simulations are disabled on this deployment');
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
      await billing.applyEvent(event, db);
      // 303 back to the SPA success page, which claims any minted key.
      res.writeHead(303, { Location: `/billing/success?session_id=${sessionId}&mock=1` });
      return res.end();
    }
    throw new HttpError(404, 'not found');
  }

  async function handleB2b(req, res, url, pathname, ip) {
    const rawKey = req.headers['x-api-key'];
    const key = typeof rawKey === 'string' ? await db.findApiKey(rawKey) : null;
    if (!key) throw new HttpError(401, 'missing or invalid X-API-Key');
    const rateScope = key.owner_account_id ? `account:${key.owner_account_id}` : `key:${key.id}`;
    const rl = b2bLimiter.check(`${rateScope}:${ip}`);
    applyRateHeaders(res, rl);
    if (!rl.ok) {
      res.setHeader('Retry-After', String(rl.retryAfterSec));
      throw new HttpError(429, 'per-minute rate limit exceeded');
    }
    const durableB2b = await durableRateCheck(req, `b2b:${rateScope}:${ip}`, b2bRate, 'b2b-api');
    if (durableB2b && !durableB2b.ok) {
      rejectRateLimit(res, durableB2b, 'per-minute rate limit exceeded');
    }
    applyRateHeaders(res, durableB2b);
    const usedToday = await db.meterUsage(key.id);
    const limit = B2B_DAILY_LIMIT[key.tier] ?? B2B_DAILY_LIMIT.starter;
    res.setHeader('X-DailyLimit-Limit', String(limit));
    res.setHeader('X-DailyLimit-Remaining', String(Math.max(0, limit - usedToday)));
    if (usedToday > limit) throw new HttpError(429, `daily quota exceeded for ${key.tier} tier (${limit}/day)`);
    const usage = { used_today: usedToday, daily_limit: limit, tier: key.tier };

    if (req.method === 'POST' && pathname === '/api/v1/analyze') {
      const body = await readJsonBody(req);
      // analyze on caller-supplied inputs isn't demo data; product-backed reads are.
      return sendJson(res, 200, { ...runAnalyze(body), usage });
    }
    if (req.method === 'POST' && pathname === '/api/v1/track') {
      if (!key.can_write_history) throw new HttpError(403, 'this API key is read-only; canonical history writes require an operator-issued ingestion scope');
      const body = await readJsonBody(req);
      const id = validate.id(body.product_id, 'product_id');
      const advertised = validate.cents(body.advertised_cents, 'advertised_cents');
      const product = await db.getPublicProduct(id);
      if (!product || !productionVerticals.includes(product.vertical)) throw new HttpError(404, 'unknown product');
      // Anchor the plausibility band to the first trusted-ingestion baseline.
      // Comparing against the latest mutable price would let a scoped client
      // ratchet a product by 4x repeatedly and poison its canonical history.
      const ingestionBaseline = Number.isInteger(product.evidence?.ingestionBaseline_cents)
        ? product.evidence.ingestionBaseline_cents
        : product.advertised_cents;
      if (advertised < Math.floor(ingestionBaseline / 4) || advertised > ingestionBaseline * 4) {
        throw new HttpError(422, 'price point rejected: outside the plausible band for this product');
      }
      const report = analyze({ vertical: product.vertical, advertised_cents: advertised, context: product.context });
      const pricingComplete = report.completeness?.status === 'complete';
      const pointAt = new Date().toISOString();
      const provenance = {
        source: 'api:trusted-ingestion', sourceLabel: 'Operator-scoped API observation', evidenceType: 'provider_quote',
        observed: true, degraded: false, fetchedAt: pointAt, asOf: pointAt,
        maxAgeSeconds: 3600, ageSeconds: 0, stale: false, alertEligible: pricingComplete,
      };
      await db.upsertProduct({
        id: product.id, vertical: product.vertical, name: product.name, url: product.url,
        advertised_cents: advertised, context: product.context,
        source: provenance.source, sourceLabel: provenance.sourceLabel, certainty: 'live', fetchedAt: pointAt,
        evidence: { ...product.evidence, ingestionBaseline_cents: ingestionBaseline, provenance, alertEligible: pricingComplete, pricingComplete }, visibility: 'curated',
      });
      const pointInserted = await db.addPricePoint(id, {
        ts: pointAt, advertised_cents: advertised, true_cents: report.truePrice.amount_cents,
        source: provenance.source, sourceLabel: provenance.sourceLabel, certainty: 'live',
        observed: true, alertEligible: pricingComplete, fetchedAt: pointAt, evidence: { provenance }, providerKey: `api-key:${key.id}`,
      });
      if (pointInserted && pricingComplete) {
        await db.enqueueJob('evaluate-alerts', {
          productId: id, trueCents: report.truePrice.amount_cents, pointAt, eligible: true, stale: false,
        }, { idempotencyKey: `evaluate-alerts:${id}:${pointAt}` });
      }
      return sendJson(res, 201, { tracked: true, true_cents: report.truePrice.amount_cents, completeness: report.completeness, alertEligible: pricingComplete, dataKind: 'observed', demoData: false, usage });
    }
    const productMatch = pathname.match(/^\/api\/v1\/products\/([a-z0-9-]{1,64})$/);
    if (req.method === 'GET' && productMatch) {
      const product = await db.getPublicProduct(productMatch[1]);
      if (!product || !productionVerticals.includes(product.vertical)) throw new HttpError(404, 'unknown product');
      requireRuntimeVertical(product.vertical);
      return sendJson(res, 200, { ...await productPayload(db, product, { includeHistory: true }), usage });
    }
    if (req.method === 'GET' && pathname === '/api/v1/usage') {
      return sendJson(res, 200, { usage });
    }
    throw new HttpError(404, 'unknown API route');
  }

  function runAnalyze(body) {
    const vertical = validate.enum(body.vertical, 'vertical', productionVerticals);
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
    const origin = new URL(baseUrlFor(req)).origin;
    const buf = buildExtensionZip(origin, extensionDir);
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
    const configuration = affiliateConfiguration(partnerId, partner);
    if (!configuration) throw new HttpError(404, 'partner link is not enabled');
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
    sendHtml(res, 200, interstitialHtml(partner.label, affiliateUrl(partner, target, configuration.tag), configuration.disclosureUrl));
  }

  function serveStatic(req, res, pathname) {
    const origin = baseUrlFor(req);
    if (pathname === '/robots.txt' || pathname === '/sitemap.xml') {
      const body = pathname === '/robots.txt' ? robotsText(origin) : sitemapText(origin);
      const buffer = Buffer.from(body, 'utf8');
      res.writeHead(200, {
        'Content-Type': pathname === '/robots.txt' ? 'text/plain; charset=utf-8' : 'application/xml; charset=utf-8',
        'Content-Length': buffer.length,
        'Cache-Control': 'public, max-age=300',
      });
      if (req.method === 'HEAD') return res.end();
      return res.end(buffer);
    }
    let rel = pathname === '/' ? 'index.html' : pathname.slice(1);
    // The staff dashboard is a separate page from the public SPA.
    if (pathname === '/admin' || pathname === '/admin/') rel = 'admin.html';
    // SPA-friendly: extensionless paths fall through to the app shell.
    else if (!rel.includes('.')) rel = 'index.html';
    const filePath = path.resolve(publicDir, rel);
    if (filePath !== publicDir && !filePath.startsWith(publicDir + path.sep)) {
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
    if (filePath.endsWith('index.html')) {
      const canonicalPath = CANONICAL_APP_ROUTES.has(pathname) ? pathname : '/';
      const body = Buffer.from(injectCanonicalMeta(fs.readFileSync(filePath, 'utf8'), `${origin}${canonicalPath}`), 'utf8');
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': body.length,
        'Cache-Control': 'no-cache',
      });
      if (req.method === 'HEAD') return res.end();
      return res.end(body);
    }
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
  server.on('close', () => {
    if (sweep) clearInterval(sweep);
    if (workerTimer) clearInterval(workerTimer);
  });

  return {
    server,
    handle,
    db,
    mailer,
    worker: jobWorker,
    readiness: readinessReport,
    runMaintenance,
    scheduleWorkerJobs,
    drainWorkerQueues,
    runWorkerCycle,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const priceCatalogVerification = billing.mode() === 'live'
    ? await billing.verifyLivePriceCatalog()
    : null;
  const { server, db } = await createApp({ priceCatalogVerification });
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
  let shuttingDown = false;
  let parentWatch = null;
  let testIdleWatch = null;
  let dbClosePromise = null;
  const closeDb = () => {
    if (!dbClosePromise) dbClosePromise = Promise.resolve().then(() => db.close());
    return dbClosePromise;
  };
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('shutting down…');
    let forceTimer;
    server.close(async () => {
      if (forceTimer) clearTimeout(forceTimer);
      if (parentWatch) clearInterval(parentWatch);
      if (testIdleWatch) clearInterval(testIdleWatch);
      try { await closeDb(); } catch (error) { console.error('[database close]', error.message); }
      process.exit(0);
    });
    // Browser clients and reverse proxies can keep HTTP/1.1 sockets alive after
    // SIGTERM. Drain idle sockets immediately, then force only the remaining
    // connections after a short grace period so deploys and test runners exit.
    server.closeIdleConnections?.();
    forceTimer = setTimeout(async () => {
      server.closeAllConnections?.();
      try { await closeDb(); } catch { /* graceful callback may have won the race */ }
      process.exit(0);
    }, 5_000);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // Playwright launches its web server through a Windows command shell. Some
  // Windows process trees can orphan the Node grandchild after that shell is
  // stopped, leaving CI/local test output pipes open forever. In test mode,
  // explicitly follow the launcher's lifetime and shut down when it disappears.
  if (process.env.EXIT_WITH_PARENT === '1') {
    const launcherPid = process.ppid;
    parentWatch = setInterval(() => {
      try { process.kill(launcherPid, 0); } catch { shutdown(); }
    }, 250);
  }
  const testIdleExitMs = Number(process.env.TEST_SERVER_IDLE_EXIT_MS);
  if (Number.isFinite(testIdleExitMs) && testIdleExitMs >= 5_000) {
    let lastRequestAt = Date.now();
    server.on('request', () => { lastRequestAt = Date.now(); });
    testIdleWatch = setInterval(() => {
      if (Date.now() - lastRequestAt >= testIdleExitMs) shutdown();
    }, Math.min(1_000, Math.floor(testIdleExitMs / 4)));
  }
}

export { createApp, productAlertEligible, catalogNotificationDeliveryAllowed };
