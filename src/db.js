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
`;

function open(dbPath = process.env.PRICETRUTH_DB || DEFAULT_PATH) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
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
    insertKey: db.prepare('INSERT INTO api_keys (key_hash, label, tier, created_at) VALUES (?, ?, ?, ?)'),
    findKey: db.prepare('SELECT * FROM api_keys WHERE key_hash = ? AND revoked = 0'),
    bumpUsage: db.prepare(`INSERT INTO api_usage (key_id, day, count) VALUES (?, ?, 1)
      ON CONFLICT(key_id, day) DO UPDATE SET count = count + 1`),
    getUsage: db.prepare('SELECT count FROM api_usage WHERE key_id = ? AND day = ?'),
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
    createApiKey(label, tier = 'starter') {
      const raw = `pt_${tier}_${crypto.randomBytes(24).toString('base64url')}`;
      stmts.insertKey.run(sha256(raw), label, tier, nowIso());
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

    close() {
      db.close();
    },
  };
}

export { open, DEFAULT_PATH };
