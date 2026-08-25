import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const DEFAULT_PATH = path.join(import.meta.dirname, '..', 'data', 'pricetruth.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  vertical TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT,
  advertised_cents INTEGER NOT NULL,
  context_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS price_points (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id TEXT NOT NULL REFERENCES products(id),
  ts TEXT NOT NULL,
  advertised_cents INTEGER NOT NULL,
  true_cents INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pp_product_ts ON price_points(product_id, ts);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  product_id TEXT NOT NULL REFERENCES products(id),
  threshold_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  tier TEXT NOT NULL DEFAULT 'starter',
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS api_usage (
  key_id INTEGER NOT NULL REFERENCES api_keys(id),
  day TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, day)
);
CREATE TABLE IF NOT EXISTS accounts (
  email TEXT PRIMARY KEY,
  plan TEXT NOT NULL DEFAULT 'free',
  stripe_customer TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS billing_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  email TEXT,
  plan TEXT,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'usd',
  livemode INTEGER NOT NULL DEFAULT 0,
  stripe_ref TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_billing_ts ON billing_events(ts);
-- Raw API keys minted by a paid checkout are held here transiently so the
-- buyer's success page can reveal the key exactly once, then it is deleted.
-- Only a SHA-256 hash ever persists in api_keys; this table is swept on a TTL.
CREATE TABLE IF NOT EXISTS pending_keys (
  session_id TEXT PRIMARY KEY,
  raw_key TEXT NOT NULL,
  tier TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

// Idempotent, best-effort column adds for databases created before these
// columns existed. CREATE TABLE IF NOT EXISTS never alters an existing table,
// so a long-lived prod db needs these to gain key-ownership tracking.
const MIGRATIONS = [
  "ALTER TABLE api_keys ADD COLUMN owner_email TEXT",
  "ALTER TABLE api_keys ADD COLUMN stripe_ref TEXT",
];

function open(dbPath = process.env.PRICETRUTH_DB || DEFAULT_PATH) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  for (const stmt of MIGRATIONS) {
    try { db.exec(stmt); } catch { /* column already exists — expected on repeat opens */ }
  }
  return wrap(db);
}

function nowIso() {
  return new Date().toISOString();
}

function sha256(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function wrap(db) {
  const stmts = {
    upsertProduct: db.prepare(`INSERT INTO products (id, vertical, name, url, advertised_cents, context_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET vertical=excluded.vertical, name=excluded.name, url=excluded.url,
        advertised_cents=excluded.advertised_cents, context_json=excluded.context_json`),
    getProduct: db.prepare('SELECT * FROM products WHERE id = ?'),
    listProducts: db.prepare('SELECT * FROM products ORDER BY created_at, id'),
    addPoint: db.prepare('INSERT INTO price_points (product_id, ts, advertised_cents, true_cents) VALUES (?, ?, ?, ?)'),
    history: db.prepare(`SELECT ts, advertised_cents, true_cents FROM price_points
      WHERE product_id = ? AND ts >= ? ORDER BY ts`),
    stats: db.prepare(`SELECT COUNT(*) AS n, MIN(true_cents) AS low_cents, MAX(true_cents) AS high_cents,
      CAST(ROUND(AVG(true_cents)) AS INTEGER) AS avg_cents FROM price_points WHERE product_id = ? AND ts >= ?`),
    latestPoint: db.prepare('SELECT ts, advertised_cents, true_cents FROM price_points WHERE product_id = ? ORDER BY ts DESC LIMIT 1'),
    insertAlert: db.prepare('INSERT INTO alerts (email, product_id, threshold_cents, created_at) VALUES (?, ?, ?, ?)'),
    countAlertsByEmail: db.prepare('SELECT COUNT(*) AS n FROM alerts WHERE email = ?'),
    insertKey: db.prepare('INSERT INTO api_keys (key_hash, label, tier, owner_email, stripe_ref, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
    findKey: db.prepare('SELECT * FROM api_keys WHERE key_hash = ? AND revoked = 0'),
    bumpUsage: db.prepare(`INSERT INTO api_usage (key_id, day, count) VALUES (?, ?, 1)
      ON CONFLICT(key_id, day) DO UPDATE SET count = count + 1`),
    getUsage: db.prepare('SELECT count FROM api_usage WHERE key_id = ? AND day = ?'),

    // accounts / entitlements
    upsertAccount: db.prepare(`INSERT INTO accounts (email, plan, stripe_customer, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(email) DO UPDATE SET plan=excluded.plan,
        stripe_customer=COALESCE(excluded.stripe_customer, accounts.stripe_customer), updated_at=excluded.updated_at`),
    getAccount: db.prepare('SELECT * FROM accounts WHERE email = ?'),

    // billing events (revenue ledger)
    insertBilling: db.prepare(`INSERT OR IGNORE INTO billing_events (ts, type, email, plan, amount_cents, currency, livemode, stripe_ref)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    revenueTotals: db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents),0) AS gross_cents FROM billing_events WHERE amount_cents > 0`),
    revenueSince: db.prepare('SELECT COALESCE(SUM(amount_cents),0) AS cents FROM billing_events WHERE amount_cents > 0 AND ts >= ?'),
    recentBilling: db.prepare('SELECT ts, type, plan, amount_cents, currency, livemode FROM billing_events ORDER BY ts DESC LIMIT ?'),
    activePlanCounts: db.prepare("SELECT plan, COUNT(*) AS n FROM accounts WHERE plan != 'free' GROUP BY plan"),

    // pending (once-shown) API keys from paid checkout
    putPending: db.prepare('INSERT OR REPLACE INTO pending_keys (session_id, raw_key, tier, created_at) VALUES (?, ?, ?, ?)'),
    getPending: db.prepare('SELECT raw_key, tier FROM pending_keys WHERE session_id = ?'),
    delPending: db.prepare('DELETE FROM pending_keys WHERE session_id = ?'),
    prunePending: db.prepare('DELETE FROM pending_keys WHERE created_at < ?'),

    // admin metrics
    keyCountsByTier: db.prepare('SELECT tier, COUNT(*) AS n FROM api_keys WHERE revoked = 0 GROUP BY tier'),
    apiCallsSince: db.prepare('SELECT COALESCE(SUM(count),0) AS n FROM api_usage WHERE day >= ?'),
    alertCount: db.prepare('SELECT COUNT(*) AS n FROM alerts'),
    productCount: db.prepare('SELECT COUNT(*) AS n FROM products'),
    pricePointCount: db.prepare('SELECT COUNT(*) AS n FROM price_points'),
  };

  function sinceIso(days) {
    return new Date(Date.now() - days * 86_400_000).toISOString();
  }

  return {
    raw: db,

    upsertProduct({ id, vertical, name, url = null, advertised_cents, context = {} }) {
      stmts.upsertProduct.run(id, vertical, name, url, advertised_cents, JSON.stringify(context), nowIso());
    },
    getProduct(id) {
      const row = stmts.getProduct.get(id);
      if (!row) return null;
      return { ...row, context: JSON.parse(row.context_json) };
    },
    listProducts() {
      return stmts.listProducts.all().map((row) => ({ ...row, context: JSON.parse(row.context_json) }));
    },

    addPricePoint(productId, { ts = nowIso(), advertised_cents, true_cents }) {
      stmts.addPoint.run(productId, ts, advertised_cents, true_cents);
    },
    getHistory(productId, days = 30) {
      return stmts.history.all(productId, sinceIso(days));
    },
    getStats(productId, days = 30) {
      const s = stmts.stats.get(productId, sinceIso(days));
      return s && s.n > 0 ? s : null;
    },
    getLatestPoint(productId) {
      return stmts.latestPoint.get(productId) || null;
    },

    createAlert({ email, productId, threshold_cents }) {
      stmts.insertAlert.run(email, productId, threshold_cents, nowIso());
    },
    countAlertsForEmail(email) {
      return stmts.countAlertsByEmail.get(email).n;
    },

    // Returns the raw key exactly once; only its SHA-256 is stored.
    createApiKey(label, tier = 'starter', { ownerEmail = null, stripeRef = null } = {}) {
      const raw = `pt_${tier}_${crypto.randomBytes(24).toString('base64url')}`;
      stmts.insertKey.run(sha256(raw), label, tier, ownerEmail, stripeRef, nowIso());
      return raw;
    },
    findApiKey(rawKey) {
      if (typeof rawKey !== 'string' || rawKey.length < 20 || rawKey.length > 128) return null;
      return stmts.findKey.get(sha256(rawKey)) || null;
    },
    meterUsage(keyId) {
      const day = new Date().toISOString().slice(0, 10);
      stmts.bumpUsage.run(keyId, day);
      return stmts.getUsage.get(keyId, day).count;
    },

    // ---- accounts / entitlements ----
    upsertAccount({ email, plan = 'free', stripeCustomer = null }) {
      const now = nowIso();
      stmts.upsertAccount.run(email, plan, stripeCustomer, now, now);
    },
    getAccount(email) {
      return stmts.getAccount.get(email) || null;
    },
    // The one source of truth for "is this email entitled to premium?".
    isPremium(email) {
      const acct = stmts.getAccount.get(email);
      return Boolean(acct && acct.plan === 'premium');
    },

    // ---- billing ledger ----
    // stripe_ref is UNIQUE, so replaying the same webhook event is a no-op:
    // the INSERT OR IGNORE keeps revenue from being double-counted.
    // Returns true if this event was newly recorded, false if it was a duplicate
    // (same stripe_ref already present). Callers use this as the idempotency gate
    // so replayed webhooks trigger their side effects exactly once.
    recordBillingEvent({ type, email = null, plan = null, amount_cents = 0, currency = 'usd', livemode = 0, stripe_ref = null }) {
      const res = stmts.insertBilling.run(nowIso(), type, email, plan, amount_cents, currency, livemode ? 1 : 0, stripe_ref);
      return res.changes > 0;
    },
    revenueSummary(recent = 10) {
      const totals = stmts.revenueTotals.get();
      const since = (days) => stmts.revenueSince.get(sinceIso(days)).cents;
      return {
        gross_cents: totals.gross_cents,
        paid_events: totals.n,
        last_30d_cents: since(30),
        last_7d_cents: since(7),
        recent: stmts.recentBilling.all(recent),
        active_plans: stmts.activePlanCounts.all(),
      };
    },

    // ---- pending (once-shown) keys ----
    putPendingKey(sessionId, rawKey, tier) {
      stmts.putPending.run(sessionId, rawKey, tier, nowIso());
    },
    // Returns { raw_key, tier } once, then deletes it (claim-once semantics).
    takePendingKey(sessionId) {
      const row = stmts.getPending.get(sessionId);
      if (!row) return null;
      stmts.delPending.run(sessionId);
      return row;
    },
    prunePendingKeys(ttlMs = 24 * 60 * 60 * 1000) {
      stmts.prunePending.run(new Date(Date.now() - ttlMs).toISOString());
    },

    // ---- admin metrics ----
    metrics() {
      const day = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
      return {
        keys_by_tier: stmts.keyCountsByTier.all(),
        api_calls_today: stmts.apiCallsSince.get(day(0)).n,
        api_calls_7d: stmts.apiCallsSince.get(day(7)).n,
        alerts: stmts.alertCount.get().n,
        products: stmts.productCount.get().n,
        price_points: stmts.pricePointCount.get().n,
      };
    },

    close() {
      db.close();
    },
  };
}

export { open, DEFAULT_PATH };
