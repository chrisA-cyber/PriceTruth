'use strict';

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const { open } = require('./db');
const { seed } = require('./seed');
const { analyze, VERTICALS } = require('./engine/analyze');
const { dealQuality } = require('./engine/score');
const { applySecurityHeaders, RateLimiter, HttpError, readJsonBody, validate, escapeHtml } = require('./security');

const PKG = require('../package.json');
const HOTEL = require('./data/fees/hotel.json');
const FLIGHT = require('./data/fees/flight.json');
const TICKET = require('./data/fees/ticket.json');
const SUBSCRIPTION = require('./data/fees/subscription.json');
const PARTNERS = require('./data/partners.json').partners;

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
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
  return {
    name: 'PriceTruth',
    version: PKG.version,
    currency: 'USD',
    demoData: true,
    verticals: VERTICALS,
    options: {
      hotelMarkets: labelMap(HOTEL.markets),
      flightCarriers: labelMap(FLIGHT.carriers),
      ticketPlatforms: labelMap(TICKET.platforms),
      subscriptionPatterns: labelMap(SUBSCRIPTION.patterns),
    },
    partners: labelMap(PARTNERS),
  };
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
      if (isApi || pathname.startsWith('/go/')) {
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
      } else if (req.method === 'GET' || req.method === 'HEAD') {
        serveStatic(req, res, pathname);
      } else {
        throw new HttpError(405, 'method not allowed');
      }
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      const message = err instanceof HttpError ? err.message : 'internal server error';
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
      const premium = body.premium === true; // demo stand-in for a paid account check
      const existing = db.countAlertsForEmail(email);
      const limit = premium ? PREMIUM_ALERT_LIMIT : FREE_ALERT_LIMIT;
      if (existing >= limit) {
        return sendJson(res, 402, {
          error: premium ? `premium accounts are limited to ${PREMIUM_ALERT_LIMIT} alerts in the demo` : 'free accounts get 1 price alert',
          upgrade: premium ? null : { plan: 'premium', price: '$4/month', includes: `${PREMIUM_ALERT_LIMIT} alerts, deal-quality digests, price-drop push` },
        });
      }
      db.createAlert({ email, productId: id, threshold_cents: threshold });
      return sendJson(res, 201, {
        created: true,
        note: 'Demo build: alerts are stored but no email is sent. Production wires this to a mail provider with double opt-in.',
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
    throw new HttpError(404, 'unknown API route');
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
    // SPA-friendly: extensionless paths fall through to the app shell.
    if (!rel.includes('.')) rel = 'index.html';
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

if (require.main === module) {
  const { server, db } = createApp();
  // Loopback by default; set HOST=0.0.0.0 explicitly (behind TLS) to expose.
  const HOST = process.env.HOST || '127.0.0.1';
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

module.exports = { createApp };
