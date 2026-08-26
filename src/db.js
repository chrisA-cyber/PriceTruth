import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';

const DEFAULT_PATH = path.join(import.meta.dirname, '..', 'data', 'pricetruth.db');
const FREE_ALERT_LIMIT = 1;
const PREMIUM_ALERT_LIMIT = 20;
const nowIso = (ms = Date.now()) => new Date(ms).toISOString();
const randomId = (prefix) => `${prefix}_${crypto.randomBytes(18).toString('base64url')}`;
const sha256 = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
const parseJson = (value, fallback = {}) => { try { return JSON.parse(value); } catch { return fallback; } };
const normalizePrivateQuery = (value) => String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

// Private report identifiers are deliberately opaque. Query text belongs in
// the owner-gated evidence payload, never in URLs, access logs, referrers, or
// browser history. Normalization keeps repeat searches stable while the
// account id provides tenant isolation.
function privateProductId(accountId, vertical, query) {
  const owner = String(accountId || '').trim();
  const kind = String(vertical || '').normalize('NFKC').trim().toLowerCase();
  const normalizedQuery = normalizePrivateQuery(query);
  if (!owner || !kind || !normalizedQuery) throw new TypeError('private product ids require an owner, vertical, and query');
  return `p-${sha256(`private-product:v1\0${owner}\0${kind}\0${normalizedQuery}`).slice(0, 48)}`;
}

// Existing tables remain source-compatible; production fields are introduced
// by the introspected migration below so long-lived installations upgrade in
// place without best-effort/silently-swallowed ALTER errors.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS products(id TEXT PRIMARY KEY,vertical TEXT NOT NULL,name TEXT NOT NULL,url TEXT,advertised_cents INTEGER NOT NULL,context_json TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS price_points(id INTEGER PRIMARY KEY AUTOINCREMENT,product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,ts TEXT NOT NULL,advertised_cents INTEGER NOT NULL,true_cents INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_pp_product_ts ON price_points(product_id,ts);
CREATE TABLE IF NOT EXISTS alerts(id INTEGER PRIMARY KEY AUTOINCREMENT,email TEXT NOT NULL,product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,threshold_cents INTEGER NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS api_keys(id INTEGER PRIMARY KEY AUTOINCREMENT,key_hash TEXT NOT NULL UNIQUE,label TEXT NOT NULL,tier TEXT NOT NULL DEFAULT 'starter',revoked INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS api_usage(key_id INTEGER NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,day TEXT NOT NULL,count INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(key_id,day));
CREATE TABLE IF NOT EXISTS accounts(email TEXT PRIMARY KEY,plan TEXT NOT NULL DEFAULT 'free',stripe_customer TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS billing_events(id INTEGER PRIMARY KEY AUTOINCREMENT,ts TEXT NOT NULL,type TEXT NOT NULL,email TEXT,plan TEXT,amount_cents INTEGER NOT NULL DEFAULT 0,currency TEXT NOT NULL DEFAULT 'usd',livemode INTEGER NOT NULL DEFAULT 0,stripe_ref TEXT UNIQUE);
CREATE INDEX IF NOT EXISTS idx_billing_ts ON billing_events(ts);
CREATE TABLE IF NOT EXISTS pending_keys(session_id TEXT PRIMARY KEY,raw_key TEXT NOT NULL,tier TEXT NOT NULL,created_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS auth_tokens(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,purpose TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,expires_at TEXT NOT NULL,consumed_at TEXT,created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_auth_account ON auth_tokens(account_id,purpose,created_at);
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,csrf_hash TEXT NOT NULL,user_agent_hash TEXT,ip_hash TEXT,created_at TEXT NOT NULL,last_seen_at TEXT NOT NULL,expires_at TEXT NOT NULL,revoked_at TEXT);
CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id,expires_at);
CREATE TABLE IF NOT EXISTS account_preferences(account_id TEXT PRIMARY KEY,email_alerts INTEGER NOT NULL DEFAULT 1,weekly_digest INTEGER NOT NULL DEFAULT 0,timezone TEXT NOT NULL DEFAULT 'UTC',created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS account_terms_acceptances(account_id TEXT NOT NULL,terms_version TEXT NOT NULL,accepted_at TEXT NOT NULL,context_json TEXT NOT NULL DEFAULT '{}',PRIMARY KEY(account_id,terms_version));
CREATE TABLE IF NOT EXISTS watchlist(account_id TEXT NOT NULL,product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,created_at TEXT NOT NULL,PRIMARY KEY(account_id,product_id));
CREATE TABLE IF NOT EXISTS notification_subscriptions(account_id TEXT NOT NULL,channel TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',verify_token_hash TEXT UNIQUE,unsubscribe_token_hash TEXT UNIQUE,verify_expires_at TEXT,verified_at TEXT,unsubscribed_at TEXT,bounced_at TEXT,complaint_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(account_id,channel));
CREATE TABLE IF NOT EXISTS notification_unsubscribe_tokens(token_hash TEXT PRIMARY KEY,account_id TEXT NOT NULL,channel TEXT NOT NULL,expires_at TEXT NOT NULL,used_at TEXT,created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_notification_unsubscribe_account ON notification_unsubscribe_tokens(account_id,channel,expires_at);
CREATE TABLE IF NOT EXISTS alert_unsubscribe_tokens(token_hash TEXT PRIMARY KEY,alert_id INTEGER NOT NULL,account_id TEXT NOT NULL,expires_at TEXT NOT NULL,used_at TEXT,created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_alert_unsubscribe_alert ON alert_unsubscribe_tokens(alert_id,expires_at);
CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,account_id TEXT,to_email TEXT NOT NULL,template TEXT NOT NULL,payload_ciphertext TEXT NOT NULL,payload_iv TEXT NOT NULL,payload_tag TEXT NOT NULL,metadata_json TEXT NOT NULL DEFAULT '{}',status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,max_attempts INTEGER NOT NULL DEFAULT 5,available_at TEXT NOT NULL,leased_until TEXT,last_error TEXT,provider_message_id TEXT,idempotency_key TEXT UNIQUE,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,sent_at TEXT);
CREATE INDEX IF NOT EXISTS idx_outbox_ready ON outbox(status,available_at,leased_until);
CREATE TABLE IF NOT EXISTS delivery_events(id TEXT PRIMARY KEY,outbox_id TEXT REFERENCES outbox(id) ON DELETE SET NULL,provider TEXT NOT NULL,provider_event_id TEXT UNIQUE,provider_message_id TEXT,type TEXT NOT NULL,payload_json TEXT NOT NULL DEFAULT '{}',occurred_at TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,type TEXT NOT NULL,payload_json TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,max_attempts INTEGER NOT NULL DEFAULT 5,available_at TEXT NOT NULL,leased_until TEXT,last_error TEXT,idempotency_key TEXT UNIQUE,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,completed_at TEXT);
CREATE INDEX IF NOT EXISTS idx_jobs_ready ON jobs(status,available_at,leased_until);
CREATE TABLE IF NOT EXISTS entitlements(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,product TEXT NOT NULL,status TEXT NOT NULL,source TEXT NOT NULL,source_ref TEXT NOT NULL,current_period_end TEXT,cancel_at_period_end INTEGER NOT NULL DEFAULT 0,metadata_json TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(source,source_ref,product));
CREATE INDEX IF NOT EXISTS idx_entitlements_account ON entitlements(account_id,status);
CREATE TABLE IF NOT EXISTS billing_source_state(account_id TEXT NOT NULL,source_ref TEXT NOT NULL,status TEXT NOT NULL,provider_event_created INTEGER,updated_at TEXT NOT NULL,PRIMARY KEY(account_id,source_ref));
CREATE TABLE IF NOT EXISTS checkout_claims(session_id TEXT PRIMARY KEY,account_id TEXT,plan TEXT NOT NULL,tier TEXT,status TEXT NOT NULL,claimed_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_checkout_claims_account ON checkout_claims(account_id,status);
CREATE TABLE IF NOT EXISTS checkout_intents(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,plan TEXT NOT NULL,idempotency_key TEXT NOT NULL UNIQUE,stripe_session_id TEXT,checkout_url TEXT,status TEXT NOT NULL DEFAULT 'pending',created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS idx_checkout_intents_pending ON checkout_intents(account_id,plan) WHERE status='pending';
CREATE TABLE IF NOT EXISTS billing_reconciliation(event_id TEXT PRIMARY KEY,event_type TEXT NOT NULL,reason TEXT NOT NULL,payload_json TEXT NOT NULL DEFAULT '{}',status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,resolved_at TEXT);
CREATE INDEX IF NOT EXISTS idx_billing_reconciliation_status ON billing_reconciliation(status,updated_at);
CREATE TABLE IF NOT EXISTS provider_usage(day TEXT NOT NULL,provider TEXT NOT NULL,calls INTEGER NOT NULL DEFAULT 0,failures INTEGER NOT NULL DEFAULT 0,consecutive_failures INTEGER NOT NULL DEFAULT 0,circuit_open_until TEXT,updated_at TEXT NOT NULL,PRIMARY KEY(day,provider));
`;

function columnNames(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
}

function addColumns(db, table, definitions) {
  const known = columnNames(db, table);
  for (const [name, sql] of Object.entries(definitions)) {
    if (!known.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${sql}`);
  }
}

function migrate(db) {
  addColumns(db, 'accounts', { id: 'TEXT', email_verified: 'INTEGER NOT NULL DEFAULT 0', verified_at: 'TEXT', deleted_at: 'TEXT', billing_customer_hash: 'TEXT', email_suppressed_at: 'TEXT', email_suppression_reason: 'TEXT' });
  addColumns(db, 'alerts', { account_id: 'TEXT', status: "TEXT NOT NULL DEFAULT 'pending'", updated_at: 'TEXT', last_notified_at: 'TEXT', last_trigger_key: 'TEXT', unsubscribe_token_hash: 'TEXT' });
  addColumns(db, 'api_keys', { owner_email: 'TEXT', stripe_ref: 'TEXT', owner_account_id: 'TEXT', prefix: 'TEXT', last_used_at: 'TEXT', revoked_at: 'TEXT', replaced_by_id: 'INTEGER', updated_at: 'TEXT', can_write_history: 'INTEGER NOT NULL DEFAULT 0', suspended: 'INTEGER NOT NULL DEFAULT 0' });
  addColumns(db, 'billing_events', { account_id: 'TEXT', status: "TEXT NOT NULL DEFAULT 'applied'", payload_json: "TEXT NOT NULL DEFAULT '{}'" });
  addColumns(db, 'products', { source: 'TEXT', source_label: 'TEXT', certainty: 'TEXT', fetched_at: 'TEXT', evidence_json: "TEXT NOT NULL DEFAULT '{}'", updated_at: 'TEXT', visibility: "TEXT NOT NULL DEFAULT 'curated'", owner_account_id: 'TEXT' });
  addColumns(db, 'price_points', { source: 'TEXT', source_label: 'TEXT', certainty: 'TEXT', observed: 'INTEGER NOT NULL DEFAULT 0', alert_eligible: 'INTEGER NOT NULL DEFAULT 0', fetched_at: 'TEXT', evidence_json: "TEXT NOT NULL DEFAULT '{}'", provider_key: 'TEXT' });
  addColumns(db, 'pending_keys', { account_id: 'TEXT', key_iv: 'TEXT', key_tag: 'TEXT' });
  addColumns(db, 'outbox', { metadata_json: "TEXT NOT NULL DEFAULT '{}'" });
  addColumns(db, 'alerts', { condition_active: 'INTEGER NOT NULL DEFAULT 0', last_evaluated_cents: 'INTEGER', last_delivered_trigger_key: 'TEXT' });
  db.prepare('UPDATE alerts SET last_delivered_trigger_key=last_trigger_key WHERE last_delivered_trigger_key IS NULL AND last_notified_at IS NOT NULL AND last_trigger_key IS NOT NULL').run();
  addColumns(db, 'entitlements', { provider_event_created: 'INTEGER' });
  addColumns(db, 'checkout_intents', { expires_at: 'TEXT', payment_status: 'TEXT', terms_version: 'TEXT' });
  const setId = db.prepare('UPDATE accounts SET id=? WHERE email=? AND id IS NULL');
  for (const row of db.prepare('SELECT email FROM accounts WHERE id IS NULL').all()) setId.run(randomId('acct'), row.email);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_id ON accounts(id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_accounts_stripe ON accounts(stripe_customer)');
  db.exec('DROP INDEX IF EXISTS idx_checkout_intents_pending');
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_checkout_intents_pending ON checkout_intents(account_id,plan) WHERE status IN ('pending','awaiting_payment')");
  db.exec('CREATE INDEX IF NOT EXISTS idx_alerts_account ON alerts(account_id,status)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_keys_account ON api_keys(owner_account_id,revoked)');
  db.prepare("UPDATE alerts SET updated_at=COALESCE(updated_at,created_at),status=COALESCE(status,'pending')").run();
  db.prepare('UPDATE products SET updated_at=COALESCE(updated_at,created_at)').run();
  db.prepare('INSERT OR IGNORE INTO schema_migrations(version,name,applied_at) VALUES(1,?,?)').run('production-foundation', nowIso());
  const hardened = db.prepare('SELECT 1 ok FROM schema_migrations WHERE version=2').get();
  if (!hardened) {
    // Pre-v2 anonymous search rows used an s-* id and were globally visible.
    // They may contain personal query text, so quarantine by deletion rather
    // than silently promoting them to the new curated catalog.
    // Legacy installations created these foreign keys without ON DELETE
    // CASCADE, so remove dependants explicitly before quarantining the rows.
    db.prepare("DELETE FROM alerts WHERE product_id IN (SELECT id FROM products WHERE id LIKE 's-%')").run();
    db.prepare("DELETE FROM watchlist WHERE product_id IN (SELECT id FROM products WHERE id LIKE 's-%')").run();
    db.prepare("DELETE FROM price_points WHERE product_id IN (SELECT id FROM products WHERE id LIKE 's-%')").run();
    db.prepare("DELETE FROM products WHERE id LIKE 's-%'").run();
    db.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES(2,?,?)').run('launch-state-hardening', nowIso());
  }
  db.prepare('INSERT OR IGNORE INTO schema_migrations(version,name,applied_at) VALUES(3,?,?)').run('versioned-terms-acceptance', nowIso());

  const opaquePrivateIds = db.prepare('SELECT 1 ok FROM schema_migrations WHERE version=4').get();
  if (!opaquePrivateIds) {
    // Early private reports used a readable s-<vertical>-<query>-<hash> id.
    // Rekey every private row so upgrading an existing installation removes
    // query text from all active URLs without discarding account history.
    const privateRows = db.prepare("SELECT id,vertical,owner_account_id,evidence_json FROM products WHERE visibility='private' AND owner_account_id IS NOT NULL").all();
    db.exec('PRAGMA foreign_keys=OFF');
    try {
      db.exec('BEGIN IMMEDIATE');
      const scrubbedDigestAccounts = new Set();
      for (const row of privateRows) {
        const originalQuery = parseJson(row.evidence_json, {}).originalQuery || row.id;
        const nextId = privateProductId(row.owner_account_id, row.vertical, originalQuery);
        if (nextId === row.id) continue;

        const target = db.prepare('SELECT id,vertical,owner_account_id FROM products WHERE id=?').get(nextId);
        if (target && (target.owner_account_id !== row.owner_account_id || target.vertical !== row.vertical)) {
          throw new Error('opaque private product id collision');
        }

        // Encrypted alert mail may contain the old report URL. Cancel and
        // scrub unsent messages so no stale query-bearing link can escape
        // after the migration.
        if (!scrubbedDigestAccounts.has(row.owner_account_id)) {
          db.prepare(`UPDATE outbox SET status='canceled',to_email='',payload_ciphertext='',payload_iv='',payload_tag='',metadata_json='{}',leased_until=NULL,last_error='private report id migrated',updated_at=?
            WHERE account_id=? AND template='weekly-digest' AND status IN ('pending','retry','sending')`)
            .run(nowIso(), row.owner_account_id);
          scrubbedDigestAccounts.add(row.owner_account_id);
        }
        const alertIds = db.prepare('SELECT id,account_id FROM alerts WHERE product_id=?').all(row.id);
        for (const alert of alertIds) {
          db.prepare(`UPDATE outbox SET status='canceled',to_email='',payload_ciphertext='',payload_iv='',payload_tag='',metadata_json='{}',leased_until=NULL,last_error='private report id migrated',updated_at=?
            WHERE account_id=? AND template='price-alert'
            AND CAST(CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json,'$.alertId') END AS INTEGER)=?
            AND status IN ('pending','retry','sending')`).run(nowIso(), alert.account_id, alert.id);
        }

        db.prepare('UPDATE price_points SET product_id=? WHERE product_id=?').run(nextId, row.id);
        db.prepare('UPDATE alerts SET product_id=? WHERE product_id=?').run(nextId, row.id);
        if (target) {
          db.prepare(`INSERT OR IGNORE INTO watchlist(account_id,product_id,created_at)
            SELECT account_id,?,created_at FROM watchlist WHERE product_id=?`).run(nextId, row.id);
          db.prepare('DELETE FROM watchlist WHERE product_id=?').run(row.id);
          db.prepare('DELETE FROM products WHERE id=?').run(row.id);
        } else {
          db.prepare('UPDATE watchlist SET product_id=? WHERE product_id=?').run(nextId, row.id);
          db.prepare('UPDATE products SET id=? WHERE id=?').run(nextId, row.id);
        }

        // Collection/evaluation jobs refer to the report in JSON and often in
        // an idempotency key. Preserve the job, but remove the readable id.
        for (const job of db.prepare('SELECT id,payload_json FROM jobs').all()) {
          const payload = parseJson(job.payload_json, null);
          if (!payload || payload.productId !== row.id) continue;
          payload.productId = nextId;
          db.prepare('UPDATE jobs SET payload_json=?,idempotency_key=?,updated_at=? WHERE id=?')
            .run(JSON.stringify(payload), `private-rekey:${job.id}`, nowIso(), job.id);
        }
      }
      db.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES(4,?,?)').run('opaque-private-product-identifiers', nowIso());
      const violations = db.prepare('PRAGMA foreign_key_check').all();
      if (violations.length) throw new Error('opaque private product migration left invalid references');
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* transaction may already be closed */ }
      throw error;
    } finally {
      db.exec('PRAGMA foreign_keys=ON');
    }
  }
}

function open(dbPath = process.env.PRICETRUTH_DB || DEFAULT_PATH) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const raw = new DatabaseSync(dbPath);
  raw.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  raw.exec(SCHEMA);
  migrate(raw);
  return wrap(raw, dbPath);
}

function wrap(raw, dbPath) {
  const q = (sql) => raw.prepare(sql);
  // PRAGMA quick_check walks the database and can be expensive for a large
  // production file. Cache its result so HTTP capability/readiness reads do
  // not synchronously scan the whole file. The server probes once at startup;
  // later full checks belong on an offline/backup copy so the synchronous
  // SQLite driver cannot stall live HTTP and webhook handling.
  let readinessCache = null;
  let integrityChecks = 0;
  const transactionScope = new AsyncLocalStorage();
  const transactionQueue = [];
  let topLevelTransactionActive = false;

  const activeTransactionContext = () => {
    let context = transactionScope.getStore();
    while (context) {
      if (context.raw === raw && context.active && context.root.active) return context;
      context = context.parent;
    }
    return null;
  };

  const assertPublicMethodAccess = (method) => {
    if (!topLevelTransactionActive || activeTransactionContext()) return;
    const error = new Error(`SQLite connection is busy with an asynchronous transaction; retry ${method} after it settles`);
    error.status = 503;
    error.code = 'SQLITE_BUSY';
    error.retryable = true;
    throw error;
  };

  const drainTransactionQueue = () => {
    if (topLevelTransactionActive || transactionQueue.length === 0) return;
    const queued = transactionQueue.shift();
    let result;
    try {
      result = startTopLevelTransaction(queued.fn);
    } catch (error) {
      queued.reject(error);
      drainTransactionQueue();
      return;
    }
    Promise.resolve(result).then(queued.resolve, queued.reject);
  };

  const releaseTopLevelTransaction = () => {
    topLevelTransactionActive = false;
    drainTransactionQueue();
  };

  const runStartedTransaction = (fn, parent = null, savepoint = null) => {
    const context = {
      raw,
      parent,
      root: parent?.root || null,
      active: true,
      nextSavepoint: 0,
    };
    if (!context.root) context.root = context;
    const nested = Boolean(parent);
    const finish = () => {
      context.active = false;
      if (!nested) releaseTopLevelTransaction();
    };
    const commit = (value) => {
      try {
        raw.exec(nested ? `RELEASE SAVEPOINT ${savepoint}` : 'COMMIT');
        return value;
      } catch (error) {
        try {
          if (nested) raw.exec(`ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}`);
          else raw.exec('ROLLBACK');
        } catch { /* preserve the commit failure */ }
        throw error;
      } finally {
        finish();
      }
    };
    const rollback = (error) => {
      try {
        if (nested) raw.exec(`ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}`);
        else raw.exec('ROLLBACK');
      } finally {
        finish();
      }
      throw error;
    };

    let value;
    try {
      value = transactionScope.run(context, fn);
    } catch (error) {
      return rollback(error);
    }
    // Preserve the historical synchronous return for synchronous callbacks,
    // while keeping the SQLite transaction open for async shared-domain code.
    if (value && typeof value.then === 'function') {
      return Promise.resolve(value).then(commit, rollback);
    }
    return commit(value);
  };

  function startTopLevelTransaction(fn) {
    topLevelTransactionActive = true;
    try {
      raw.exec('BEGIN IMMEDIATE');
    } catch (error) {
      releaseTopLevelTransaction();
      throw error;
    }
    return runStartedTransaction(fn);
  }

  const tx = (fn) => {
    if (typeof fn !== 'function') throw new TypeError('transaction callback must be a function');
    const parent = activeTransactionContext();
    if (parent) {
      const savepoint = `pt_nested_${++parent.root.nextSavepoint}`;
      raw.exec(`SAVEPOINT ${savepoint}`);
      return runStartedTransaction(fn, parent, savepoint);
    }
    if (!topLevelTransactionActive && transactionQueue.length === 0) {
      return startTopLevelTransaction(fn);
    }
    return new Promise((resolve, reject) => transactionQueue.push({ fn, resolve, reject }));
  };
  const since = (days) => nowIso(Date.now() - days * 86_400_000);
  const productRow = (row) => row ? { ...row, context: parseJson(row.context_json), evidence: parseJson(row.evidence_json) } : null;
  const accountByEmail = q('SELECT * FROM accounts WHERE email=? AND deleted_at IS NULL');
  const accountById = q('SELECT * FROM accounts WHERE id=? AND deleted_at IS NULL');
  const configuredPendingKey = process.env.PENDING_KEY_ENCRYPTION_KEY || process.env.OUTBOX_ENCRYPTION_KEY;
  const pendingCipherKey = configuredPendingKey
    ? crypto.createHash('sha256').update(configuredPendingKey, 'utf8').digest()
    : crypto.randomBytes(32);

  function sealSecret(secret) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', pendingCipherKey, iv);
    const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return { ciphertext: ciphertext.toString('base64url'), iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') };
  }

  function openSecret(row) {
    if (!row.key_iv || !row.key_tag) return row.raw_key;
    const decipher = crypto.createDecipheriv('aes-256-gcm', pendingCipherKey, Buffer.from(row.key_iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(row.key_tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(row.raw_key, 'base64url')), decipher.final()]).toString('utf8');
  }

  // Older databases stored claim-once secrets in plaintext. Seal them before
  // the adapter is returned (and therefore before HTTP traffic can begin). If
  // no stable encryption key exists, invalidate the legacy claim rather than
  // keeping recoverable bearer credentials at rest.
  for (const row of q('SELECT session_id,raw_key FROM pending_keys WHERE key_iv IS NULL OR key_tag IS NULL').all()) {
    if (configuredPendingKey) {
      const sealed = sealSecret(row.raw_key);
      q('UPDATE pending_keys SET raw_key=?,key_iv=?,key_tag=? WHERE session_id=?').run(sealed.ciphertext, sealed.iv, sealed.tag, row.session_id);
    } else {
      q("UPDATE checkout_claims SET status='superseded',updated_at=? WHERE session_id=? AND status='claimable'").run(nowIso(), row.session_id);
      q('DELETE FROM pending_keys WHERE session_id=?').run(row.session_id);
    }
  }

  function preferences(accountId) {
    let row = q('SELECT email_alerts,weekly_digest,timezone,created_at,updated_at FROM account_preferences WHERE account_id=?').get(accountId);
    if (!row) {
      const now = nowIso();
      q('INSERT INTO account_preferences(account_id,email_alerts,weekly_digest,timezone,created_at,updated_at) VALUES(?,1,0,\'UTC\',?,?)').run(accountId, now, now);
      row = q('SELECT email_alerts,weekly_digest,timezone,created_at,updated_at FROM account_preferences WHERE account_id=?').get(accountId);
    }
    return { ...row, email_alerts: Boolean(row.email_alerts), weekly_digest: Boolean(row.weekly_digest) };
  }

  const api = {
    raw,
    dbPath,
    transaction: tx,
    // SQLite transactions share one guarded connection, so the transaction
    // itself already serializes billing-object changes. Keep the same adapter
    // contract as Postgres without adding a second lock primitive.
    lockBillingObject(scope, objectId) {
      const kind = String(scope || '');
      const id = String(objectId || '');
      if (!/^[a-z][a-z0-9-]{0,31}$/.test(kind)) throw new TypeError('billing lock scope is invalid');
      if (!id || id.length > 512) throw new TypeError('billing lock object id must be 1..512 characters');
      return true;
    },
    schemaVersion: () => q('SELECT COALESCE(MAX(version),0) version FROM schema_migrations').get().version,
    checkReady({ force = false } = {}) {
      if (readinessCache && !force) return { ...readinessCache };
      const checkedAt = nowIso();
      let integrity = 'unavailable';
      let schemaVersion = null;
      try {
        integrityChecks += 1;
        integrity = String(q('PRAGMA quick_check').get()?.quick_check || 'unavailable');
        schemaVersion = api.schemaVersion();
      } catch {
        // Keep a safe, non-sensitive failure state. A later scheduled forced
        // probe can recover after a transient database error.
      }
      readinessCache = Object.freeze({
        ok: integrity === 'ok' && Number.isInteger(schemaVersion),
        integrity,
        schemaVersion,
        storage: dbPath === ':memory:' ? 'memory' : 'sqlite',
        checkedAt,
      });
      return { ...readinessCache };
    },
    refreshReady() { return api.checkReady({ force: true }); },
    readinessProbeStats() { return { integrityChecks, checkedAt: readinessCache?.checkedAt || null }; },

    upsertProduct({ id, vertical, name, url = null, advertised_cents, context = {}, source = null, sourceLabel = null, certainty = null, fetchedAt = null, evidence = {}, visibility = 'curated', ownerAccountId = null }) {
      if (visibility === 'private' && !ownerAccountId) {
        throw new TypeError('private products require an owner account');
      }
      const now = nowIso();
      const safeVisibility = visibility === 'private' ? 'private' : 'curated';
      q(`INSERT INTO products(id,vertical,name,url,advertised_cents,context_json,source,source_label,certainty,fetched_at,evidence_json,visibility,owner_account_id,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET vertical=excluded.vertical,name=excluded.name,url=excluded.url,
        advertised_cents=excluded.advertised_cents,context_json=excluded.context_json,source=excluded.source,source_label=excluded.source_label,
        certainty=excluded.certainty,fetched_at=excluded.fetched_at,evidence_json=excluded.evidence_json,visibility=excluded.visibility,
        owner_account_id=excluded.owner_account_id,updated_at=excluded.updated_at
        WHERE (products.owner_account_id IS NULL AND excluded.owner_account_id IS NULL) OR products.owner_account_id=excluded.owner_account_id`)
        .run(id, vertical, name, url, advertised_cents, JSON.stringify(context), source, sourceLabel, certainty, fetchedAt, JSON.stringify(evidence || {}), safeVisibility, ownerAccountId, now, now);
    },
    getProduct(id) { return productRow(q('SELECT * FROM products WHERE id=?').get(id)); },
    listProducts() { return q('SELECT * FROM products ORDER BY created_at,id').all().map(productRow); },
    repairDemoPricePoints(productId, { source, sourceLabel, certainty, evidenceJson }) {
      return q(`UPDATE price_points SET source=?,source_label=?,certainty=?,observed=0,alert_eligible=0,evidence_json=? WHERE product_id=?`)
        .run(source, sourceLabel, certainty, evidenceJson, productId).changes;
    },
    removeDemoProduct(productId) { return tx(() => {
      api.cancelProductJobs(productId);
      q('DELETE FROM alerts WHERE product_id=?').run(productId);
      q('DELETE FROM watchlist WHERE product_id=?').run(productId);
      q('DELETE FROM price_points WHERE product_id=?').run(productId);
      return q('DELETE FROM products WHERE id=?').run(productId).changes;
    }); },
    getVisibleProduct(id, accountId = null) { return productRow(q("SELECT * FROM products WHERE id=? AND (visibility='curated' OR owner_account_id=?)").get(id, accountId)); },
    getPublicProduct(id) { return productRow(q("SELECT * FROM products WHERE id=? AND visibility='curated'").get(id)); },
    listPublicProducts(limit = 20, offset = 0, verticals = null) {
      if (!Array.isArray(verticals)) return q("SELECT * FROM products WHERE visibility='curated' ORDER BY created_at,id LIMIT ? OFFSET ?").all(limit, offset).map(productRow);
      if (verticals.length === 0) return [];
      const slots = verticals.map(() => '?').join(',');
      return q(`SELECT * FROM products WHERE visibility='curated' AND vertical IN (${slots}) ORDER BY created_at,id LIMIT ? OFFSET ?`).all(...verticals, limit, offset).map(productRow);
    },
    countPublicProducts(verticals = null) {
      if (!Array.isArray(verticals)) return q("SELECT COUNT(*) n FROM products WHERE visibility='curated'").get().n;
      if (verticals.length === 0) return 0;
      const slots = verticals.map(() => '?').join(',');
      return q(`SELECT COUNT(*) n FROM products WHERE visibility='curated' AND vertical IN (${slots})`).get(...verticals).n;
    },
    countPrivateProducts(accountId) { return q("SELECT COUNT(*) n FROM products WHERE owner_account_id=? AND visibility='private'").get(accountId).n; },
    findPrivateProductByQuery(accountId, vertical, originalQuery) {
      const direct = productRow(q("SELECT * FROM products WHERE id=? AND owner_account_id=? AND visibility='private' AND vertical=?")
        .get(privateProductId(accountId, vertical, originalQuery), accountId, vertical));
      if (direct) return direct;
      const normalized = normalizePrivateQuery(originalQuery);
      return q(`SELECT * FROM products WHERE owner_account_id=? AND visibility='private' AND vertical=?
        ORDER BY CASE WHEN json_extract(evidence_json,'$.refreshable')=1 THEN 0 ELSE 1 END,updated_at DESC`)
        .all(accountId, vertical).map(productRow)
        .find((product) => normalizePrivateQuery(product?.evidence?.originalQuery) === normalized) || null;
    },
    deletePrivateProduct(accountId, productId) { return tx(() => {
      const product = q("SELECT id FROM products WHERE id=? AND owner_account_id=? AND visibility='private'").get(productId, accountId);
      if (!product) return false;
      api.cancelProductJobs(productId);
      const now = nowIso();
      const alertIds = q('SELECT id FROM alerts WHERE product_id=? AND account_id=?').all(productId, accountId).map((row) => row.id);
      for (const alertId of alertIds) {
        q(`UPDATE outbox SET
          status=CASE WHEN status IN ('pending','retry','sending') THEN 'canceled' ELSE status END,
          to_email=CASE WHEN status IN ('pending','retry','sending') THEN '' ELSE to_email END,
          payload_ciphertext='',payload_iv='',payload_tag='',metadata_json='{}',leased_until=NULL,
          last_error=CASE WHEN status IN ('pending','retry','sending') THEN 'private report deleted' ELSE last_error END,
          updated_at=? WHERE account_id=? AND template='price-alert'
          AND CAST(CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json,'$.alertId') END AS INTEGER)=?`)
          .run(now, accountId, alertId);
      }
      // A digest payload can contain this report's name and URL alongside
      // other watches, so scrub every locally retained digest body for the
      // account. Sent delivery metadata remains as an operational receipt.
      q(`UPDATE outbox SET
        status=CASE WHEN status IN ('pending','retry','sending') THEN 'canceled' ELSE status END,
        to_email=CASE WHEN status IN ('pending','retry','sending') THEN '' ELSE to_email END,
        payload_ciphertext='',payload_iv='',payload_tag='',metadata_json='{}',leased_until=NULL,
        last_error=CASE WHEN status IN ('pending','retry','sending') THEN 'private report deleted' ELSE last_error END,
        updated_at=? WHERE account_id=? AND template='weekly-digest'`).run(now, accountId);
      q('DELETE FROM alerts WHERE product_id=? AND account_id=?').run(productId, accountId);
      q('DELETE FROM watchlist WHERE product_id=? AND account_id=?').run(productId, accountId);
      q('DELETE FROM price_points WHERE product_id=?').run(productId);
      q("DELETE FROM products WHERE id=? AND owner_account_id=? AND visibility='private'").run(productId, accountId);
      return true;
    }); },
    cancelProductJobs(productId) {
      const now = nowIso();
      // Erasure applies to the durable audit trail too. A completed or failed
      // job can retain the same private product id/query-bearing payload as a
      // queued job, so scrub every matching row while preserving terminal
      // status for operational metrics.
      return q(`UPDATE jobs SET
        status=CASE WHEN status IN ('pending','retry','running') THEN 'canceled' ELSE status END,
        payload_json='{}',idempotency_key=NULL,leased_until=NULL,
        last_error=CASE WHEN status IN ('pending','retry','running') THEN 'target product deleted' ELSE last_error END,
        updated_at=?,completed_at=CASE WHEN status IN ('pending','retry','running') THEN ? ELSE completed_at END
        WHERE type IN ('collect-product','evaluate-alerts')
        AND json_extract(payload_json,'$.productId')=?`).run(now, now, productId).changes;
    },
    prunePrivateProductHistory(productId, { maxPoints = 500, maxDays = 365 } = {}) {
      const product = q("SELECT id FROM products WHERE id=? AND visibility='private'").get(productId);
      if (!product) return 0;
      let removed = q('DELETE FROM price_points WHERE product_id=? AND ts<?').run(productId, since(maxDays)).changes;
      removed += q(`DELETE FROM price_points WHERE product_id=? AND id NOT IN (
        SELECT id FROM price_points WHERE product_id=? ORDER BY ts DESC,id DESC LIMIT ?
      )`).run(productId, productId, Math.max(1, maxPoints)).changes;
      return removed;
    },
    pruneAllPrivateProductHistory({ maxPoints = 500, maxDays = 365 } = {}) {
      let removed = 0;
      for (const row of q("SELECT id FROM products WHERE visibility='private'").all()) removed += api.prunePrivateProductHistory(row.id, { maxPoints, maxDays });
      return removed;
    },
    reserveProviderCall(provider, dailyLimit = 1000) { return tx(() => {
      const day = nowIso().slice(0, 10), now = nowIso();
      q('INSERT OR IGNORE INTO provider_usage(day,provider,updated_at) VALUES(?,?,?)').run(day, provider, now);
      const row = q('SELECT * FROM provider_usage WHERE day=? AND provider=?').get(day, provider);
      if ((row.circuit_open_until && row.circuit_open_until > now) || row.calls >= Math.max(1, dailyLimit)) {
        return { allowed: false, reason: row.circuit_open_until && row.circuit_open_until > now ? 'circuit-open' : 'daily-budget', calls: row.calls, limit: dailyLimit };
      }
      q('UPDATE provider_usage SET calls=calls+1,updated_at=? WHERE day=? AND provider=?').run(now, day, provider);
      return { allowed: true, calls: row.calls + 1, limit: dailyLimit };
    }); },
    recordProviderResult(provider, { ok, circuitFailures = 5, circuitMs = 5 * 60_000 } = {}) {
      const day = nowIso().slice(0, 10), now = nowIso();
      q('INSERT OR IGNORE INTO provider_usage(day,provider,updated_at) VALUES(?,?,?)').run(day, provider, now);
      const row = q('SELECT * FROM provider_usage WHERE day=? AND provider=?').get(day, provider);
      const consecutive = ok ? 0 : row.consecutive_failures + 1;
      const openUntil = !ok && consecutive >= Math.max(1, circuitFailures) ? nowIso(Date.now() + Math.max(1000, circuitMs)) : (ok ? null : row.circuit_open_until);
      q('UPDATE provider_usage SET failures=failures+?,consecutive_failures=?,circuit_open_until=?,updated_at=? WHERE day=? AND provider=?')
        .run(ok ? 0 : 1, consecutive, openUntil, now, day, provider);
      return { ok: Boolean(ok), consecutiveFailures: consecutive, circuitOpenUntil: openUntil };
    },
    refundProviderCall(provider) {
      return q('UPDATE provider_usage SET calls=MAX(0,calls-1),updated_at=? WHERE day=? AND provider=?').run(nowIso(), nowIso().slice(0, 10), provider).changes > 0;
    },
    providerUsageToday() { return q('SELECT provider,calls,failures,consecutive_failures,circuit_open_until FROM provider_usage WHERE day=? ORDER BY provider').all(nowIso().slice(0, 10)); },
    addPricePoint(productId, { ts = nowIso(), advertised_cents, true_cents, source = null, sourceLabel = null, certainty = null, observed = false, alertEligible = observed, fetchedAt = null, evidence = {}, providerKey = null }) {
      // A dated provider observation must stay one observation when a worker
      // fetches the same snapshot repeatedly. Source/version time, stable
      // provider identity, and value form the idempotency tuple.
      const duplicate = q(`SELECT 1 ok FROM price_points WHERE product_id=? AND ts=?
        AND COALESCE(source,'')=COALESCE(?,'') AND COALESCE(provider_key,'')=COALESCE(?,'')
        AND advertised_cents=? AND true_cents=? LIMIT 1`)
        .get(productId, ts, source, providerKey, advertised_cents, true_cents);
      if (duplicate) return false;
      q(`INSERT INTO price_points(product_id,ts,advertised_cents,true_cents,source,source_label,certainty,observed,alert_eligible,fetched_at,evidence_json,provider_key)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(productId, ts, advertised_cents, true_cents, source, sourceLabel, certainty, observed ? 1 : 0, alertEligible ? 1 : 0, fetchedAt, JSON.stringify(evidence || {}), providerKey);
      return true;
    },
    getHistory(productId, days = 30) {
      return q(`SELECT ts,advertised_cents,true_cents,source,source_label,certainty,observed,alert_eligible,fetched_at,evidence_json FROM price_points WHERE product_id=? AND ts>=? ORDER BY ts`)
        .all(productId, since(days)).map((row) => ({ ...row, observed: Boolean(row.observed), alertEligible: Boolean(row.alert_eligible), evidence: parseJson(row.evidence_json) }));
    },
    getStats(productId, days = 30, { eligibleOnly = true, observedOnly = false } = {}) { const row = q(`SELECT COUNT(*) n,COUNT(DISTINCT ts) distinct_observations,COUNT(DISTINCT substr(ts,1,10)) distinct_days,MIN(ts) first_ts,MAX(ts) last_ts,MIN(true_cents) low_cents,MAX(true_cents) high_cents,CAST(ROUND(AVG(true_cents)) AS INTEGER) avg_cents FROM price_points WHERE product_id=? AND ts>=?${eligibleOnly ? ' AND alert_eligible=1' : observedOnly ? ' AND observed=1' : ''}`).get(productId, since(days)); return row?.n ? row : null; },
    getLatestPoint(productId, { eligibleOnly = true, observedOnly = false } = {}) { const row = q(`SELECT ts,advertised_cents,true_cents,source,source_label,certainty,observed,alert_eligible,fetched_at,evidence_json FROM price_points WHERE product_id=?${eligibleOnly ? ' AND alert_eligible=1' : observedOnly ? ' AND observed=1' : ''} ORDER BY ts DESC LIMIT 1`).get(productId); return row ? { ...row, observed: Boolean(row.observed), alertEligible: Boolean(row.alert_eligible), evidence: parseJson(row.evidence_json) } : null; },

    createAlert({ email, accountId = null, productId, threshold_cents, status = accountId ? 'active' : 'pending' }) {
      const now = nowIso();
      const result = q('INSERT INTO alerts(email,account_id,product_id,threshold_cents,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(email, accountId, productId, threshold_cents, status, now, now);
      return q('SELECT * FROM alerts WHERE id=?').get(Number(result.lastInsertRowid));
    },
    countAlertsForEmail(email) { return q("SELECT COUNT(*) n FROM alerts WHERE email=? AND status!='deleted'").get(email).n; },
    countAlertsForAccount(accountId) { return q("SELECT COUNT(*) n FROM alerts WHERE account_id=? AND status!='deleted'").get(accountId).n; },
    countActiveAlertsForAccount(accountId) { return q("SELECT COUNT(*) n FROM alerts WHERE account_id=? AND status='active'").get(accountId).n; },
    alertLimitForAccount(accountId) { return api.isPremium(accountId) ? PREMIUM_ALERT_LIMIT : FREE_ALERT_LIMIT; },
    isAlertWithinEntitlement(accountId, alertId) {
      const limit = api.alertLimitForAccount(accountId);
      return Boolean(q(`SELECT 1 ok FROM (
        SELECT id FROM alerts WHERE account_id=? AND status='active'
        ORDER BY created_at,id LIMIT ?
      ) allowed WHERE id=?`).get(accountId, limit, alertId));
    },
    listAlerts(accountId) { return q(`SELECT a.id,a.product_id,a.threshold_cents,a.status,a.created_at,a.updated_at,a.last_notified_at,p.name product_name,p.vertical,p.url FROM alerts a JOIN products p ON p.id=a.product_id WHERE a.account_id=? AND a.status!='deleted' ORDER BY a.created_at DESC`).all(accountId); },
    getAlert(id, accountId = null) { return accountId ? (q('SELECT * FROM alerts WHERE id=? AND account_id=?').get(id, accountId) || null) : (q('SELECT * FROM alerts WHERE id=?').get(id) || null); },
    updateAlert(accountId, id, patch) { return tx(() => {
      const old = api.getAlert(id, accountId);
      if (!old) return null;
      if (patch.status === 'active' && old.status !== 'active') {
        const limit = api.alertLimitForAccount(accountId);
        if (api.countActiveAlertsForAccount(accountId) >= limit) {
          const err = new Error(limit === FREE_ALERT_LIMIT
            ? 'free accounts get 1 active price alert'
            : `premium accounts are limited to ${limit} active price alerts`);
          err.status = 402;
          err.code = 'ALERT_LIMIT_REACHED';
          err.details = { limit, plan: limit === FREE_ALERT_LIMIT ? 'free' : 'premium' };
          throw err;
        }
      }
      const threshold = patch.threshold_cents ?? old.threshold_cents;
      const status = patch.status ?? old.status;
      const resetsCrossing = threshold !== old.threshold_cents || status !== old.status;
      if (resetsCrossing) api.cancelAlertOutbox(accountId, id);
      q(`UPDATE alerts SET threshold_cents=?,status=?,condition_active=?,last_trigger_key=?,last_evaluated_cents=?,updated_at=?
        WHERE id=? AND account_id=?`)
        .run(threshold, status, resetsCrossing ? 0 : old.condition_active,
          resetsCrossing ? null : old.last_trigger_key, resetsCrossing ? null : old.last_evaluated_cents,
          nowIso(), id, accountId);
      return api.getAlert(id, accountId);
    }); },
    deleteAlert(accountId, id) { return tx(() => {
      const alert = api.getAlert(id, accountId);
      if (!alert) return false;
      api.cancelAlertOutbox(accountId, id);
      q('DELETE FROM alert_unsubscribe_tokens WHERE alert_id=? AND account_id=?').run(id, accountId);
      q('DELETE FROM alerts WHERE id=? AND account_id=?').run(id, accountId);
      return true;
    }); },

    getOrCreateAccount(email) {
      let account = accountByEmail.get(email);
      if (account) return account;
      const now = nowIso(), id = randomId('acct');
      q('INSERT INTO accounts(email,id,plan,stripe_customer,email_verified,verified_at,created_at,updated_at) VALUES(?,?,\'free\',NULL,0,NULL,?,?)').run(email, id, now, now);
      preferences(id);
      return accountById.get(id);
    },
    upsertAccount({ email, plan = 'free', stripeCustomer = null }) {
      const account = api.getOrCreateAccount(email);
      // A webhook for a different Stripe customer must never steal an existing
      // account relationship. linkStripeCustomer performs the stronger unique
      // ownership check; this update only fills an empty legacy row.
      q('UPDATE accounts SET plan=?,stripe_customer=CASE WHEN stripe_customer IS NULL THEN ? ELSE stripe_customer END,updated_at=? WHERE id=?')
        .run(plan, stripeCustomer, nowIso(), account.id);
      return accountById.get(account.id);
    },
    linkStripeCustomer(accountId, customerId) {
      if (typeof customerId !== 'string' || !/^cus_[A-Za-z0-9_]{4,}$/.test(customerId)) return false;
      const account = accountById.get(accountId);
      if (!account || (account.stripe_customer && account.stripe_customer !== customerId)) return false;
      const owner = q('SELECT id FROM accounts WHERE stripe_customer=? AND deleted_at IS NULL').get(customerId);
      if (owner && owner.id !== accountId) return false;
      q('UPDATE accounts SET stripe_customer=?,updated_at=? WHERE id=? AND (stripe_customer IS NULL OR stripe_customer=?)')
        .run(customerId, nowIso(), accountId, customerId);
      return true;
    },
    getAccount(email) { return accountByEmail.get(email) || null; },
    getAccountById(id) { return accountById.get(id) || null; },
    getAccountByStripeCustomer(customerId) { return q('SELECT * FROM accounts WHERE stripe_customer=? AND deleted_at IS NULL').get(customerId) || null; },
    getDeletedAccountForBilling({ accountId = null, customerId = null } = {}) {
      if (accountId) {
        const row = q('SELECT id,deleted_at FROM accounts WHERE id=? AND deleted_at IS NOT NULL').get(accountId);
        if (row) return row;
      }
      if (!customerId) return null;
      return q('SELECT id,deleted_at FROM accounts WHERE billing_customer_hash=? AND deleted_at IS NOT NULL')
        .get(sha256(`billing-customer:${customerId}`)) || null;
    },
    verifyAccount(accountId) { const now = nowIso(); q('UPDATE accounts SET email_verified=1,verified_at=COALESCE(verified_at,?),updated_at=? WHERE id=?').run(now, now, accountId); return accountById.get(accountId) || null; },
    isPremium(emailOrId) { const account = String(emailOrId).includes('@') ? accountByEmail.get(emailOrId) : accountById.get(emailOrId); return Boolean(account && q("SELECT 1 ok FROM entitlements WHERE account_id=? AND product='premium' AND status IN ('active','trialing') LIMIT 1").get(account.id)); },
    getPreferences(accountId) { return preferences(accountId); },
    recordTermsAcceptance(accountId, termsVersion, context = {}) {
      if (!accountById.get(accountId)) throw new TypeError('terms acceptance requires an active account');
      const version = String(termsVersion || '').trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(version)) throw new TypeError('invalid terms version');
      const safeContext = context && typeof context === 'object' && !Array.isArray(context) ? context : {};
      q('INSERT OR IGNORE INTO account_terms_acceptances(account_id,terms_version,accepted_at,context_json) VALUES(?,?,?,?)')
        .run(accountId, version, nowIso(), JSON.stringify(safeContext));
      const row = q('SELECT account_id,terms_version,accepted_at,context_json FROM account_terms_acceptances WHERE account_id=? AND terms_version=?').get(accountId, version);
      return { account_id: row.account_id, terms_version: row.terms_version, accepted_at: row.accepted_at, context: parseJson(row.context_json) };
    },
    listTermsAcceptances(accountId) {
      return q('SELECT terms_version,accepted_at,context_json FROM account_terms_acceptances WHERE account_id=? ORDER BY accepted_at,terms_version').all(accountId)
        .map((row) => ({ termsVersion: row.terms_version, acceptedAt: row.accepted_at, context: parseJson(row.context_json) }));
    },
    updatePreferences(accountId, patch) { return tx(() => {
      const old = preferences(accountId), now = nowIso();
      const emailAlerts = patch.email_alerts ?? old.email_alerts;
      const weekly = patch.weekly_digest ?? old.weekly_digest;
      q(`INSERT INTO account_preferences(account_id,email_alerts,weekly_digest,timezone,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET email_alerts=excluded.email_alerts,weekly_digest=excluded.weekly_digest,timezone=excluded.timezone,updated_at=excluded.updated_at`).run(accountId, emailAlerts ? 1 : 0, weekly ? 1 : 0, patch.timezone ?? old.timezone, old.created_at || now, now);
      if (!emailAlerts) api.cancelNotificationOutbox(accountId, ['verify-alerts', 'price-alert', 'weekly-digest']);
      else if (!weekly) api.cancelNotificationOutbox(accountId, ['weekly-digest']);
      return preferences(accountId);
    }); },

    createAuthToken(accountId, purpose = 'login', ttlMs = 15 * 60_000) { return tx(() => {
      const now = nowIso();
      const account = accountById.get(accountId);
      if (!account || account.email_suppressed_at) return { token: null, id: null, expiresAt: null, suppressed: true };
      const active = q('SELECT COUNT(*) n FROM auth_tokens WHERE account_id=? AND purpose=? AND consumed_at IS NULL AND expires_at>?').get(accountId, purpose, now).n;
      // Preserve earlier links so an unauthenticated requester cannot rotate a
      // recipient's valid login token. The per-address/IP limit permits at most
      // five concurrent links; at that bounded cap we fail silently until one
      // is consumed or expires.
      if (active >= 5) return { token: null, id: null, expiresAt: null, suppressed: true };
      const token = crypto.randomBytes(32).toString('base64url');
      const id = randomId('auth');
      const expiresAt = nowIso(Date.now() + ttlMs);
      q('INSERT INTO auth_tokens(id,account_id,purpose,token_hash,expires_at,created_at) VALUES(?,?,?,?,?,?)').run(id, accountId, purpose, sha256(token), expiresAt, now);
      return { token, id, expiresAt, suppressed: false };
    }); },
    consumeAuthToken(token, purpose = 'login') {
      if (typeof token !== 'string' || token.length < 32 || token.length > 256) return null;
      return tx(() => { const row = q('SELECT * FROM auth_tokens WHERE token_hash=? AND purpose=? AND consumed_at IS NULL AND expires_at>?').get(sha256(token), purpose, nowIso()); if (!row) return null; const consumedAt = nowIso(); if (q('UPDATE auth_tokens SET consumed_at=? WHERE id=? AND consumed_at IS NULL').run(consumedAt, row.id).changes !== 1) return null; q('UPDATE auth_tokens SET consumed_at=? WHERE account_id=? AND purpose=? AND id!=? AND consumed_at IS NULL').run(consumedAt, row.account_id, purpose, row.id); return { ...row, account: api.verifyAccount(row.account_id) }; });
    },
    createSession(accountId, { ttlMs = 30 * 86_400_000, userAgent = null, ip = null } = {}) { const token = crypto.randomBytes(32).toString('base64url'), csrfToken = crypto.randomBytes(24).toString('base64url'), now = nowIso(), expiresAt = nowIso(Date.now() + ttlMs), id = randomId('sess'); q('INSERT INTO sessions(id,account_id,token_hash,csrf_hash,user_agent_hash,ip_hash,created_at,last_seen_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id, accountId, sha256(token), sha256(csrfToken), userAgent ? sha256(userAgent) : null, ip ? sha256(ip) : null, now, now, expiresAt); return { id, token, csrfToken, expiresAt }; },
    getSession(token, { touch = true } = {}) { if (typeof token !== 'string' || token.length < 32 || token.length > 256) return null; const row = q(`SELECT s.*,a.email,a.plan,a.email_verified,a.created_at account_created_at,a.verified_at FROM sessions s JOIN accounts a ON a.id=s.account_id WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>? AND a.deleted_at IS NULL`).get(sha256(token), nowIso()); if (row && touch && Date.now() - Date.parse(row.last_seen_at) > 300_000) q('UPDATE sessions SET last_seen_at=? WHERE id=?').run(nowIso(), row.id); return row || null; },
    verifyCsrf(session, token) { if (!session || typeof token !== 'string' || token.length < 24) return false; const expected = Buffer.from(session.csrf_hash, 'hex'), actual = Buffer.from(sha256(token), 'hex'); return expected.length === actual.length && crypto.timingSafeEqual(expected, actual); },
    rotateSessionCsrf(sessionId) { const csrfToken = crypto.randomBytes(24).toString('base64url'); const changed = q('UPDATE sessions SET csrf_hash=? WHERE id=? AND revoked_at IS NULL AND expires_at>?').run(sha256(csrfToken), sessionId, nowIso()).changes; return changed ? csrfToken : null; },
    revokeSession(token) { return typeof token === 'string' && q('UPDATE sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL').run(nowIso(), sha256(token)).changes > 0; },
    revokeAccountSessions(accountId) { return q('UPDATE sessions SET revoked_at=? WHERE account_id=? AND revoked_at IS NULL').run(nowIso(), accountId).changes; },
    pruneAuth() { return tx(() => {
      const now = nowIso();
      const expiredPending = q(`SELECT n.account_id,a.email FROM notification_subscriptions n JOIN accounts a ON a.id=n.account_id
        WHERE n.status='pending' AND ((n.verify_expires_at IS NOT NULL AND n.verify_expires_at<?)
          OR (n.verify_expires_at IS NULL AND n.updated_at<?))`).all(now, nowIso(Date.now() - 24 * 60 * 60_000));
      for (const { account_id: accountId, email } of expiredPending) {
        api.cancelNotificationOutbox(accountId);
        q("DELETE FROM alerts WHERE (account_id=? OR (account_id IS NULL AND email=?)) AND status='pending'").run(accountId, email);
        q('DELETE FROM alert_unsubscribe_tokens WHERE account_id=?').run(accountId);
        q('DELETE FROM notification_unsubscribe_tokens WHERE account_id=?').run(accountId);
        q("DELETE FROM notification_subscriptions WHERE account_id=? AND status='pending'").run(accountId);
      }
      const authTokens = q('DELETE FROM auth_tokens WHERE expires_at<? OR consumed_at IS NOT NULL').run(now).changes;
      const sessions = q('DELETE FROM sessions WHERE expires_at<? OR revoked_at<?').run(now, nowIso(Date.now() - 7 * 86_400_000)).changes;

      // Sign-in requests and abandoned legacy opt-ins must not retain arbitrary
      // third-party email addresses forever. Remove only unverified, truly
      // empty accounts with no billing, ownership, notification, or security
      // state; any account with a business/audit relationship is preserved.
      const abandoned = q(`SELECT a.id,a.email FROM accounts a WHERE a.deleted_at IS NULL AND a.email_verified=0
        AND a.stripe_customer IS NULL
        AND NOT EXISTS(SELECT 1 FROM auth_tokens t WHERE t.account_id=a.id)
        AND NOT EXISTS(SELECT 1 FROM sessions s WHERE s.account_id=a.id)
        AND NOT EXISTS(SELECT 1 FROM notification_subscriptions n WHERE n.account_id=a.id)
        AND NOT EXISTS(SELECT 1 FROM alerts x WHERE x.account_id=a.id OR x.email=a.email)
        AND NOT EXISTS(SELECT 1 FROM watchlist w WHERE w.account_id=a.id)
        AND NOT EXISTS(SELECT 1 FROM products p WHERE p.owner_account_id=a.id)
        AND NOT EXISTS(SELECT 1 FROM entitlements e WHERE e.account_id=a.id)
        AND NOT EXISTS(SELECT 1 FROM checkout_intents c WHERE c.account_id=a.id)
        AND NOT EXISTS(SELECT 1 FROM checkout_claims c WHERE c.account_id=a.id)
        AND NOT EXISTS(SELECT 1 FROM pending_keys p WHERE p.account_id=a.id)
        AND NOT EXISTS(SELECT 1 FROM api_keys k WHERE k.owner_account_id=a.id)
        AND NOT EXISTS(SELECT 1 FROM billing_events b WHERE b.account_id=a.id OR b.email=a.email)
        AND NOT EXISTS(SELECT 1 FROM billing_reconciliation r WHERE r.status='pending' AND json_extract(r.payload_json,'$.accountId')=a.id)`).all();
      for (const account of abandoned) {
        q('DELETE FROM outbox WHERE account_id=?').run(account.id);
        q('DELETE FROM account_preferences WHERE account_id=?').run(account.id);
        q('DELETE FROM account_terms_acceptances WHERE account_id=?').run(account.id);
        q('DELETE FROM accounts WHERE id=? AND email_verified=0').run(account.id);
      }
      return { authTokens, sessions, expiredPending: expiredPending.length, abandonedAccounts: abandoned.length };
    }); },

    addWatchlist(accountId, productId) { const now = nowIso(); q('INSERT OR IGNORE INTO watchlist(account_id,product_id,created_at) VALUES(?,?,?)').run(accountId, productId, now); return api.listWatchlist(accountId).find((row) => row.product_id === productId) || null; },
    removeWatchlist(accountId, productId) { return q('DELETE FROM watchlist WHERE account_id=? AND product_id=?').run(accountId, productId).changes > 0; },
    listWatchlist(accountId) { return q(`SELECT w.product_id,w.created_at,p.vertical,p.name,p.url,p.advertised_cents,p.context_json,p.source,p.source_label,p.certainty,p.fetched_at,p.evidence_json,p.visibility,p.owner_account_id FROM watchlist w JOIN products p ON p.id=w.product_id WHERE w.account_id=? ORDER BY w.created_at DESC`).all(accountId).map(productRow); },
    listTrackedProducts() { return q(`SELECT DISTINCT p.* FROM products p WHERE
      EXISTS(SELECT 1 FROM watchlist w WHERE w.product_id=p.id) OR
      EXISTS(SELECT 1 FROM alerts a WHERE a.product_id=p.id AND a.status='active')
      ORDER BY p.id`).all().map(productRow); },

    close() { raw.close(); },
  };

  Object.assign(api, buildOperationalMethods({ raw, q, tx, api, accountById, accountByEmail, preferences, productRow, sealSecret, openSecret }));
  // DatabaseSync exposes one connection. While an async transaction is
  // suspended, any unrelated statement on that connection would otherwise
  // become part of the open transaction and could report success before a
  // later rollback silently erased it. Public synchronous methods cannot wait
  // without changing their API, so fail them fast with a retryable busy error.
  // Calls made from the transaction's own async context remain available, and
  // transaction() itself uses the FIFO queue above.
  for (const [name, method] of Object.entries(api)) {
    if (name === 'transaction' || typeof method !== 'function') continue;
    api[name] = (...args) => {
      assertPublicMethodAccess(name);
      return method(...args);
    };
  }
  return api;
}

// Operational methods are split from the core CRUD above to keep migrations
// and compatibility APIs easy to audit.
function buildOperationalMethods({ raw, q, tx, api, accountById, preferences, productRow, sealSecret, openSecret }) {
  return {
    createApiKeyRecord(label, tier = 'starter', { ownerEmail = null, ownerAccountId = null, stripeRef = null, canWriteHistory = false } = {}) {
      if (!ownerAccountId && ownerEmail) ownerAccountId = api.getAccount(ownerEmail)?.id || null;
      const key = `pt_${tier}_${crypto.randomBytes(24).toString('base64url')}`;
      const now = nowIso();
      const inserted = q(`INSERT INTO api_keys(key_hash,prefix,label,tier,owner_email,owner_account_id,stripe_ref,can_write_history,revoked,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,0,?,?)`).run(sha256(key), key.slice(0, 18), label, tier, ownerEmail, ownerAccountId, stripeRef, canWriteHistory ? 1 : 0, now, now);
      const record = q('SELECT id,prefix,label,tier,can_write_history,created_at,last_used_at,revoked_at,replaced_by_id FROM api_keys WHERE id=?').get(Number(inserted.lastInsertRowid));
      return { key, record: { ...record, can_write_history: Boolean(record.can_write_history) } };
    },
    createApiKey(label, tier = 'starter', options = {}) { return api.createApiKeyRecord(label, tier, options).key; },
    findApiKey(key) {
      if (typeof key !== 'string' || key.length < 20 || key.length > 128) return null;
      const row = q('SELECT * FROM api_keys WHERE key_hash=? AND revoked=0 AND suspended=0').get(sha256(key)) || null;
      if (row) q('UPDATE api_keys SET last_used_at=? WHERE id=?').run(nowIso(), row.id);
      return row;
    },
    listApiKeys(accountId) { return q('SELECT id,prefix,label,tier,can_write_history,suspended,created_at,last_used_at,revoked_at,replaced_by_id FROM api_keys WHERE owner_account_id=? ORDER BY id DESC').all(accountId).map((row) => ({ ...row, can_write_history: Boolean(row.can_write_history), suspended: Boolean(row.suspended) })); },
    revokeApiKey(accountId, id) { const now = nowIso(); return q('UPDATE api_keys SET revoked=1,suspended=0,revoked_at=?,updated_at=? WHERE id=? AND owner_account_id=? AND revoked=0').run(now, now, id, accountId).changes > 0; },
    revokeApiKeysByStripeRef(stripeRef) { if (!stripeRef) return 0; const now = nowIso(); return q('UPDATE api_keys SET revoked=1,revoked_at=?,updated_at=? WHERE stripe_ref=? AND revoked=0').run(now, now, stripeRef).changes; },
    revokeApiKeysForAccount(accountId) { const now = nowIso(); return q('UPDATE api_keys SET revoked=1,revoked_at=?,updated_at=? WHERE owner_account_id=? AND revoked=0').run(now, now, accountId).changes; },
    syncApiKeysForAccount(accountId) {
      return tx(() => {
        const active = q("SELECT product,source_ref FROM entitlements WHERE account_id=? AND source='stripe' AND status IN ('active','trialing') AND product LIKE 'api:%'").all(accountId);
        const pastDue = q("SELECT product,source_ref FROM entitlements WHERE account_id=? AND source='stripe' AND status='past_due' AND product LIKE 'api:%'").all(accountId);
        const tierBySource = new Map(active.map((entry) => [entry.source_ref, entry.product === 'api:pro' ? 'pro' : 'starter']));
        const suspendedBySource = new Map(pastDue.map((entry) => [entry.source_ref, entry.product === 'api:pro' ? 'pro' : 'starter']));
        const aggregateTier = active.some((entry) => entry.product === 'api:pro') ? 'pro' : active.length ? 'starter' : null;
        const aggregateSuspendedTier = pastDue.some((entry) => entry.product === 'api:pro') ? 'pro' : pastDue.length ? 'starter' : null;
        const now = nowIso(), changed = { retiered: 0, suspended: 0, resumed: 0, revoked: 0, claimsUpdated: 0, claimsSuperseded: 0 };
        for (const key of q('SELECT id,stripe_ref,tier,suspended FROM api_keys WHERE owner_account_id=? AND revoked=0').all(accountId)) {
          const targetTier = key.stripe_ref ? (tierBySource.get(key.stripe_ref) || null) : aggregateTier;
          const suspendedTier = key.stripe_ref ? (suspendedBySource.get(key.stripe_ref) || null) : aggregateSuspendedTier;
          if (!targetTier && suspendedTier) {
            changed.suspended += q('UPDATE api_keys SET tier=?,suspended=1,updated_at=? WHERE id=? AND revoked=0').run(suspendedTier, now, key.id).changes;
          } else if (!targetTier) {
            changed.revoked += q('UPDATE api_keys SET revoked=1,revoked_at=?,updated_at=? WHERE id=? AND revoked=0').run(now, now, key.id).changes;
          } else if (key.tier !== targetTier || key.suspended) {
            changed.retiered += key.tier !== targetTier ? 1 : 0;
            changed.resumed += key.suspended ? 1 : 0;
            q('UPDATE api_keys SET tier=?,suspended=0,updated_at=? WHERE id=? AND revoked=0').run(targetTier, now, key.id);
          }
        }
        for (const pending of q('SELECT * FROM pending_keys WHERE account_id=?').all(accountId)) {
          let rawKey;
          try { rawKey = openSecret(pending); } catch { rawKey = null; }
          const key = rawKey ? q('SELECT id,tier,revoked FROM api_keys WHERE key_hash=?').get(sha256(rawKey)) : null;
          if (!key || key.revoked) {
            q('DELETE FROM pending_keys WHERE session_id=?').run(pending.session_id);
            changed.claimsSuperseded += q("UPDATE checkout_claims SET status='superseded',updated_at=? WHERE session_id=? AND status='claimable'").run(now, pending.session_id).changes;
          } else {
            q('UPDATE pending_keys SET tier=? WHERE session_id=?').run(key.tier, pending.session_id);
            const plan = key.tier === 'pro' ? 'api_pro' : 'api_starter';
            changed.claimsUpdated += q("UPDATE checkout_claims SET tier=?,plan=?,updated_at=? WHERE session_id=? AND status='claimable'").run(key.tier, plan, now, pending.session_id).changes;
          }
        }
        return { ...changed, aggregateTier };
      });
    },
    rotateApiKey(accountId, id, { label = null } = {}) {
      return tx(() => {
        const old = q('SELECT * FROM api_keys WHERE id=? AND owner_account_id=? AND revoked=0 AND suspended=0').get(id, accountId);
        if (!old) return null;
        const owner = accountById.get(accountId);
        const key = api.createApiKey(label || old.label, old.tier, { ownerEmail: owner?.email || old.owner_email, ownerAccountId: accountId, stripeRef: old.stripe_ref, canWriteHistory: Boolean(old.can_write_history) });
        const replacement = q('SELECT * FROM api_keys WHERE key_hash=?').get(sha256(key));
        const now = nowIso();
        q('UPDATE api_keys SET revoked=1,revoked_at=?,updated_at=?,replaced_by_id=? WHERE id=?').run(now, now, replacement.id, old.id);
        return { key, record: api.listApiKeys(accountId).find((row) => row.id === replacement.id) };
      });
    },
    meterUsage(keyId) {
      const day = nowIso().slice(0, 10);
      const key = q('SELECT id,owner_account_id FROM api_keys WHERE id=?').get(keyId);
      if (!key) throw new TypeError('unknown API key');
      q('INSERT INTO api_usage(key_id,day,count) VALUES(?,?,1) ON CONFLICT(key_id,day) DO UPDATE SET count=count+1').run(keyId, day);
      if (!key.owner_account_id) return q('SELECT count FROM api_usage WHERE key_id=? AND day=?').get(keyId, day).count;
      return q('SELECT COALESCE(SUM(u.count),0) count FROM api_usage u JOIN api_keys k ON k.id=u.key_id WHERE k.owner_account_id=? AND u.day=?')
        .get(key.owner_account_id, day).count;
    },

    createNotificationVerification(accountId, channel = 'email', ttlMs = 24 * 60 * 60_000, { allowResubscribe = false } = {}) {
      const existing = q('SELECT * FROM notification_subscriptions WHERE account_id=? AND channel=?').get(accountId, channel);
      const now = nowIso();
      // Never let knowledge of an email address disable an already verified
      // channel. Likewise, replaying a still-valid request keeps the original
      // link valid instead of rotating it and generating email storms.
      if (existing?.status === 'active') return { status: 'active', alreadyActive: true, verifyToken: null, unsubscribeToken: null, expiresAt: null };
      if (existing?.status === 'pending' && existing.verify_expires_at > now) {
        return { status: 'pending', alreadyPending: true, verifyToken: null, unsubscribeToken: null, expiresAt: existing.verify_expires_at };
      }
      if (existing && ['bounced', 'complained'].includes(existing.status)) {
        return { status: existing.status, suppressed: true, verifyToken: null, unsubscribeToken: null, expiresAt: null };
      }
      if (existing?.status === 'unsubscribed' && !allowResubscribe) {
        return { status: existing.status, suppressed: true, verifyToken: null, unsubscribeToken: null, expiresAt: null };
      }
      const verifyToken = crypto.randomBytes(32).toString('base64url');
      const unsubscribeToken = crypto.randomBytes(32).toString('base64url');
      const expiresAt = nowIso(Date.now() + ttlMs);
      q(`INSERT INTO notification_subscriptions(account_id,channel,status,verify_token_hash,unsubscribe_token_hash,verify_expires_at,verified_at,unsubscribed_at,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(account_id,channel) DO UPDATE SET status=excluded.status,verify_token_hash=excluded.verify_token_hash,
        unsubscribe_token_hash=excluded.unsubscribe_token_hash,verify_expires_at=excluded.verify_expires_at,
        verified_at=NULL,unsubscribed_at=NULL,updated_at=excluded.updated_at`)
        .run(accountId, channel, 'pending', sha256(verifyToken), sha256(unsubscribeToken), expiresAt, null, null, now, now);
      return { status: 'pending', verifyToken, unsubscribeToken, expiresAt };
    },
    verifyNotification(token) { return tx(() => {
      if (typeof token !== 'string') return null;
      const row = q("SELECT * FROM notification_subscriptions WHERE verify_token_hash=? AND status='pending' AND verify_expires_at>?").get(sha256(token), nowIso());
      if (!row) return null;
      const now = nowIso();
      q("UPDATE notification_subscriptions SET status='active',verify_token_hash=NULL,verify_expires_at=NULL,verified_at=?,unsubscribed_at=NULL,updated_at=? WHERE account_id=? AND channel=?").run(now, now, row.account_id, row.channel);
      const account = accountById.get(row.account_id);
      if (account) q("UPDATE alerts SET account_id=?,updated_at=? WHERE account_id IS NULL AND email=? AND status='pending'").run(row.account_id, now, account.email);
      q("UPDATE alerts SET status='active',updated_at=? WHERE account_id=? AND status='pending'").run(now, row.account_id);
      return q('SELECT * FROM notification_subscriptions WHERE account_id=? AND channel=?').get(row.account_id, row.channel);
    }); },
    unsubscribeNotification(token) { return tx(() => {
      if (typeof token !== 'string') return null;
      const tokenHash = sha256(token), now = nowIso();
      let row = q('SELECT * FROM notification_subscriptions WHERE unsubscribe_token_hash=?').get(tokenHash);
      if (!row) {
        const issued = q('SELECT * FROM notification_unsubscribe_tokens WHERE token_hash=? AND used_at IS NULL AND expires_at>?').get(tokenHash, now);
        if (issued) {
          q('UPDATE notification_unsubscribe_tokens SET used_at=? WHERE token_hash=? AND used_at IS NULL').run(now, tokenHash);
          row = q('SELECT * FROM notification_subscriptions WHERE account_id=? AND channel=?').get(issued.account_id, issued.channel);
        }
      }
      if (!row) return null;
      q("UPDATE notification_subscriptions SET status='unsubscribed',unsubscribed_at=?,updated_at=? WHERE account_id=? AND channel=?").run(now, now, row.account_id, row.channel);
      q("UPDATE alerts SET status='paused',updated_at=? WHERE account_id=? AND status='active'").run(now, row.account_id);
      api.cancelNotificationOutbox(row.account_id);
      return q('SELECT * FROM notification_subscriptions WHERE account_id=? AND channel=?').get(row.account_id, row.channel);
    }); },
    createNotificationUnsubscribeToken(accountId, channel = 'email', ttlMs = 366 * 86_400_000) {
      const subscription = q("SELECT 1 ok FROM notification_subscriptions WHERE account_id=? AND channel=? AND status='active'").get(accountId, channel);
      if (!subscription) return null;
      const token = crypto.randomBytes(32).toString('base64url'), now = nowIso();
      q('INSERT INTO notification_unsubscribe_tokens(token_hash,account_id,channel,expires_at,created_at) VALUES(?,?,?,?,?)')
        .run(sha256(token), accountId, channel, nowIso(Date.now() + ttlMs), now);
      return token;
    },
    getNotification(accountId, channel = 'email') { return q('SELECT * FROM notification_subscriptions WHERE account_id=? AND channel=?').get(accountId, channel) || null; },
    updateNotificationByProvider(messageId, type) {
      const outbox = q('SELECT * FROM outbox WHERE provider_message_id=?').get(messageId);
      if (!outbox?.account_id) return false;
      const now = nowIso();
      if (type === 'bounced') q("UPDATE notification_subscriptions SET status='bounced',bounced_at=?,updated_at=? WHERE account_id=? AND channel='email'").run(now, now, outbox.account_id);
      if (type === 'complained') q("UPDATE notification_subscriptions SET status='complained',complaint_at=?,updated_at=? WHERE account_id=? AND channel='email'").run(now, now, outbox.account_id);
      if (type === 'bounced' || type === 'complained') {
        q('UPDATE accounts SET email_suppressed_at=?,email_suppression_reason=?,updated_at=? WHERE id=? AND deleted_at IS NULL')
          .run(now, type, now, outbox.account_id);
        q(`UPDATE outbox SET status='canceled',to_email='',payload_ciphertext='',payload_iv='',payload_tag='',metadata_json='{}',leased_until=NULL,
          last_error=?,updated_at=? WHERE account_id=? AND status IN ('pending','retry','sending')`)
          .run(`email ${type}; account mail suppressed`, now, outbox.account_id);
      }
      return true;
    },
    isNotificationDeliveryAllowed(accountId, template, metadata = {}) {
      // Every account-owned message, including a magic link already claimed by
      // a worker, is canceled if account deletion won the race before send.
      const owningAccount = accountId ? accountById.get(accountId) : null;
      if (accountId && (!owningAccount || owningAccount.email_suppressed_at)) return false;
      if (!['verify-alerts', 'price-alert', 'weekly-digest'].includes(template)) return !accountId || Boolean(accountById.get(accountId));
      const notification = q("SELECT status FROM notification_subscriptions WHERE account_id=? AND channel='email'").get(accountId);
      if (template === 'verify-alerts') return notification?.status === 'pending';
      if (notification?.status !== 'active') return false;
      const prefs = q('SELECT email_alerts,weekly_digest FROM account_preferences WHERE account_id=?').get(accountId);
      if (!prefs?.email_alerts) return false;
      if (template === 'weekly-digest') return Boolean(prefs.weekly_digest && api.isWeeklyDigestEligible(accountId));
      const alertId = Number(metadata?.alertId);
      if (!Number.isSafeInteger(alertId) || alertId <= 0) return false;
      return api.isAlertWithinEntitlement(accountId, alertId);
    },
    cancelNotificationOutbox(accountId, templates = ['verify-alerts', 'price-alert', 'weekly-digest']) {
      if (!accountId || !Array.isArray(templates) || templates.length === 0) return 0;
      const slots = templates.map(() => '?').join(','), now = nowIso();
      return q(`UPDATE outbox SET status='canceled',to_email='',payload_ciphertext='',payload_iv='',payload_tag='',leased_until=NULL,last_error='notification suppressed before delivery',updated_at=?
        ,metadata_json='{}'
        WHERE account_id=? AND template IN (${slots}) AND status IN ('pending','retry','sending')`).run(now, accountId, ...templates).changes;
    },

    cancelAlertOutbox(accountId, alertId) {
      const now = nowIso();
      return q(`UPDATE outbox SET status='canceled',to_email='',payload_ciphertext='',payload_iv='',payload_tag='',metadata_json='{}',leased_until=NULL,last_error='alert inactive before delivery',updated_at=?
        WHERE account_id=? AND template='price-alert' AND CAST(json_extract(metadata_json,'$.alertId') AS INTEGER)=?
        AND status IN ('pending','retry','sending')`).run(now, accountId, alertId).changes;
    },

    enqueueOutbox({ accountId = null, toEmail, template, ciphertext, iv, tag, metadata = {}, idempotencyKey = null, maxAttempts = 5, availableAt = nowIso() }) {
      const id = randomId('mail'), now = nowIso();
      const safeMetadata = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};
      const result = q(`INSERT OR IGNORE INTO outbox(id,account_id,to_email,template,payload_ciphertext,payload_iv,payload_tag,metadata_json,status,attempts,max_attempts,available_at,idempotency_key,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,'pending',0,?,?,?,?,?)`).run(id, accountId, toEmail, template, ciphertext, iv, tag, JSON.stringify(safeMetadata), maxAttempts, availableAt, idempotencyKey, now, now);
      return result.changes ? q('SELECT * FROM outbox WHERE id=?').get(id) : q('SELECT * FROM outbox WHERE idempotency_key=?').get(idempotencyKey);
    },
    getOutbox(id) { return q('SELECT * FROM outbox WHERE id=?').get(id) || null; },
    cancelOutbox(id, reason = 'delivery suppressed before send') {
      const now = nowIso();
      return q(`UPDATE outbox SET status='canceled',to_email='',payload_ciphertext='',payload_iv='',payload_tag='',metadata_json='{}',leased_until=NULL,last_error=?,updated_at=?
        WHERE id=? AND status IN ('pending','retry','sending')`).run(String(reason).slice(0, 200), now, id).changes > 0;
    },
    claimOutbox(limit = 10, leaseMs = 60_000) {
      return tx(() => {
        const now = nowIso(), lease = nowIso(Date.now() + leaseMs);
        const redriveAt = nowIso(Date.now() + 6 * 60 * 60_000);
        q(`UPDATE outbox SET status='retry',attempts=0,available_at=?,leased_until=NULL,
          last_error=COALESCE(last_error,'delivery lease expired; alert retained for redrive'),updated_at=?
          WHERE template='price-alert' AND status='sending' AND leased_until<? AND attempts>=max_attempts`)
          .run(redriveAt, now, now);
        q("UPDATE outbox SET status='failed',leased_until=NULL,last_error=COALESCE(last_error,'delivery lease expired after maximum attempts'),updated_at=? WHERE template!='price-alert' AND status='sending' AND leased_until<? AND attempts>=max_attempts").run(now, now);
        const candidates = q(`SELECT * FROM outbox WHERE attempts<max_attempts AND (
          (status IN ('pending','retry') AND available_at<=?) OR
          (status='sending' AND leased_until IS NOT NULL AND leased_until<?)
        ) ORDER BY created_at LIMIT ?`).all(now, now, limit);
        const claimed = [];
        for (const item of candidates) {
          const changed = q(`UPDATE outbox SET status='sending',leased_until=?,attempts=attempts+1,updated_at=? WHERE id=? AND attempts<max_attempts AND (
            status IN ('pending','retry') OR (status='sending' AND leased_until IS NOT NULL AND leased_until<?)
          )`).run(lease, now, item.id, now).changes;
          if (changed) claimed.push(q('SELECT * FROM outbox WHERE id=?').get(item.id));
        }
        return claimed;
      });
    },
    markOutboxSent(id, providerMessageId = null) {
      const now = nowIso();
      const changed = q("UPDATE outbox SET status='sent',provider_message_id=?,sent_at=?,leased_until=NULL,last_error=NULL,updated_at=? WHERE id=? AND status='sending'").run(providerMessageId, now, now, id).changes > 0;
      if (changed && providerMessageId) api.reconcileDeliverySuppression(providerMessageId);
      return changed;
    },
    markOutboxFailed(id, error) { const item = api.getOutbox(id); if (!item || item.status !== 'sending') return false; const terminal = item.attempts >= item.max_attempts, status = terminal ? 'failed' : 'retry', delay = Math.min(3_600_000, 1000 * (2 ** Math.max(0, item.attempts))); return q("UPDATE outbox SET status=?,available_at=?,leased_until=NULL,last_error=?,updated_at=? WHERE id=? AND status='sending'").run(status, nowIso(Date.now() + delay), String(error || 'delivery failed').slice(0, 500), nowIso(), id).changes > 0; },
    failOutboxTerminal(id, error) {
      return q("UPDATE outbox SET status='failed',leased_until=NULL,last_error=?,updated_at=? WHERE id=? AND status='sending'")
        .run(String(error || 'non-retryable delivery failure').slice(0, 500), nowIso(), id).changes > 0;
    },
    redriveAlertOutbox(id, error, delayMs = 6 * 60 * 60_000) {
      const delay = Math.min(24 * 60 * 60_000, Math.max(60_000, Number(delayMs) || 0));
      return q(`UPDATE outbox SET status='retry',attempts=0,available_at=?,leased_until=NULL,last_error=?,updated_at=?
        WHERE id=? AND template='price-alert' AND status='sending'`)
        .run(nowIso(Date.now() + delay), String(error || 'delivery failed; alert retained for redrive').slice(0, 500), nowIso(), id).changes > 0;
    },
    recordDeliveryEvent({ outboxId = null, provider, providerEventId = null, providerMessageId = null, type, payload = {}, occurredAt = nowIso() }) { return q('INSERT OR IGNORE INTO delivery_events(id,outbox_id,provider,provider_event_id,provider_message_id,type,payload_json,occurred_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(randomId('delivery'), outboxId, provider, providerEventId, providerMessageId, type, JSON.stringify(payload), occurredAt, nowIso()).changes > 0; },
    reconcileDeliverySuppression(providerMessageId) {
      const event = q("SELECT type FROM delivery_events WHERE provider_message_id=? AND type IN ('bounced','complained') ORDER BY occurred_at DESC LIMIT 1").get(providerMessageId);
      return event ? api.updateNotificationByProvider(providerMessageId, event.type) : false;
    },

    enqueueJob(type, payload, { idempotencyKey = null, maxAttempts = 5, availableAt = nowIso() } = {}) { const id = randomId('job'), now = nowIso(); const result = q(`INSERT OR IGNORE INTO jobs(id,type,payload_json,status,attempts,max_attempts,available_at,idempotency_key,created_at,updated_at) VALUES(?,?,?,'pending',0,?,?,?,?,?)`).run(id, type, JSON.stringify(payload), maxAttempts, availableAt, idempotencyKey, now, now); return result.changes ? q('SELECT * FROM jobs WHERE id=?').get(id) : q('SELECT * FROM jobs WHERE idempotency_key=?').get(idempotencyKey); },
    claimJobs(limit = 10, leaseMs = 60_000) { return tx(() => {
      const now = nowIso(), lease = nowIso(Date.now() + leaseMs);
      q("UPDATE jobs SET status='failed',leased_until=NULL,last_error=COALESCE(last_error,'job lease expired after maximum attempts'),updated_at=? WHERE status='running' AND leased_until<? AND attempts>=max_attempts").run(now, now);
      const candidates = q(`SELECT * FROM jobs WHERE attempts<max_attempts AND (
        (status IN ('pending','retry') AND available_at<=?) OR
        (status='running' AND leased_until IS NOT NULL AND leased_until<?)
      ) ORDER BY created_at LIMIT ?`).all(now, now, limit), claimed = [];
      for (const item of candidates) {
        const changed = q(`UPDATE jobs SET status='running',leased_until=?,attempts=attempts+1,updated_at=? WHERE id=? AND attempts<max_attempts AND (
          status IN ('pending','retry') OR (status='running' AND leased_until IS NOT NULL AND leased_until<?)
        )`).run(lease, now, item.id, now).changes;
        if (changed) claimed.push(q('SELECT * FROM jobs WHERE id=?').get(item.id));
      }
      return claimed;
    }); },
    completeJob(id) { const now = nowIso(); return q("UPDATE jobs SET status='completed',completed_at=?,leased_until=NULL,last_error=NULL,updated_at=? WHERE id=? AND status='running'").run(now, now, id).changes > 0; },
    failJob(id, error) { const item = q("SELECT * FROM jobs WHERE id=? AND status='running'").get(id); if (!item) return false; const terminal = item.attempts >= item.max_attempts, status = terminal ? 'failed' : 'retry', delay = Math.min(3_600_000, 1000 * (2 ** Math.max(0, item.attempts))); return q("UPDATE jobs SET status=?,available_at=?,leased_until=NULL,last_error=?,updated_at=? WHERE id=? AND status='running'").run(status, nowIso(Date.now() + delay), String(error || 'job failed').slice(0, 500), nowIso(), id).changes > 0; },

    recordBillingEvent({ type, email = null, accountId = null, plan = null, amount_cents = 0, currency = 'usd', livemode = 0, stripe_ref = null, payload = {} }) { return q(`INSERT OR IGNORE INTO billing_events(ts,type,email,account_id,plan,amount_cents,currency,livemode,stripe_ref,status,payload_json) VALUES(?,?,?,?,?,?,?,?,?,'applied',?)`).run(nowIso(), type, email, accountId, plan, amount_cents, currency, livemode ? 1 : 0, stripe_ref, JSON.stringify(payload)).changes > 0; },
    hasRecognizedInvoicePayment(invoiceId) {
      return Boolean(q(`SELECT 1 ok FROM billing_events WHERE amount_cents>0
        AND type IN ('invoice.paid','invoice.payment_succeeded')
        AND json_extract(payload_json,'$.objectId')=? LIMIT 1`).get(invoiceId));
    },
    refundedTotalForCharge(chargeId) {
      return q(`SELECT COALESCE(MAX(CAST(json_extract(payload_json,'$.cumulativeRefunded') AS INTEGER)),0) total
        FROM billing_events WHERE type='charge.refunded' AND json_extract(payload_json,'$.objectId')=?`).get(chargeId).total;
    },
    billingObjectAmount(objectId, types = []) {
      if (!Array.isArray(types) || types.length === 0) return 0;
      const slots = types.map(() => '?').join(',');
      return q(`SELECT COALESCE(SUM(amount_cents),0) total FROM billing_events
        WHERE type IN (${slots}) AND json_extract(payload_json,'$.objectId')=?`).get(...types, objectId).total;
    },
    latestBillingObjectEvent(objectId, types = []) {
      if (!Array.isArray(types) || types.length === 0) return null;
      const slots = types.map(() => '?').join(',');
      const row = q(`SELECT type,payload_json FROM billing_events WHERE type IN (${slots})
        AND json_extract(payload_json,'$.objectId')=?
        ORDER BY CAST(COALESCE(json_extract(payload_json,'$.eventCreated'),-1) AS INTEGER) DESC,
          CASE WHEN type='charge.dispute.closed' THEN 3 WHEN type='charge.dispute.updated' THEN 2 ELSE 1 END DESC,id DESC LIMIT 1`)
        .get(...types, objectId);
      return row ? { type: row.type, payload: parseJson(row.payload_json) } : null;
    },
    recordBillingReconciliation({ eventId, eventType, reason, payload = {} }) {
      const now = nowIso();
      q(`INSERT INTO billing_reconciliation(event_id,event_type,reason,payload_json,status,attempts,created_at,updated_at)
        VALUES(?,?,?,?,'pending',1,?,?) ON CONFLICT(event_id) DO UPDATE SET reason=excluded.reason,
        payload_json=excluded.payload_json,status='pending',attempts=billing_reconciliation.attempts+1,updated_at=excluded.updated_at`)
        .run(eventId, eventType, String(reason || 'unmapped billing event').slice(0, 500), JSON.stringify(payload), now, now);
      return q('SELECT * FROM billing_reconciliation WHERE event_id=?').get(eventId);
    },
    resolveBillingReconciliation(eventId) { const now = nowIso(); return q("UPDATE billing_reconciliation SET status='resolved',resolved_at=?,updated_at=? WHERE event_id=? AND status='pending'").run(now, now, eventId).changes > 0; },
    billingReconciliationMetrics() { const pending = q("SELECT COUNT(*) n FROM billing_reconciliation WHERE status='pending'").get().n; const oldest = q("SELECT MIN(created_at) at FROM billing_reconciliation WHERE status='pending'").get().at; return { ok: pending === 0, pending, oldestPendingAt: oldest || null }; },
    listPendingBillingReconciliation(accountId, customerId = null) {
      return q(`SELECT event_id,event_type,reason,created_at,updated_at FROM billing_reconciliation
        WHERE status='pending' AND (json_extract(payload_json,'$.accountId')=? OR (? IS NOT NULL AND json_extract(payload_json,'$.customer')=?))
        ORDER BY created_at`).all(accountId, customerId, customerId);
    },
    upsertEntitlement({ accountId, product, status = 'active', source = 'stripe', sourceRef, currentPeriodEnd = null, cancelAtPeriodEnd = false, metadata = {}, eventCreated = null }) {
      const now = nowIso();
      const existing = q('SELECT * FROM entitlements WHERE source=? AND source_ref=? AND product=?').get(source, sourceRef, product);
      const sequence = Number.isInteger(eventCreated) && eventCreated >= 0 ? eventCreated : null;
      const sourceState = source === 'stripe' ? q('SELECT * FROM billing_source_state WHERE account_id=? AND source_ref=?').get(accountId, sourceRef) : null;
      const terminal = new Set(['canceled', 'unpaid', 'past_due', 'paused', 'incomplete', 'incomplete_expired', 'inactive']);
      if (sourceState && sequence !== null && sourceState.provider_event_created !== null) {
        const oldSequence = Number(sourceState.provider_event_created);
        if (sequence < oldSequence || (sequence === oldSequence && terminal.has(sourceState.status) && ['active', 'trialing'].includes(status))) {
          return { ...(existing || {}), applied: false, stale: true, status: existing?.status || sourceState.status };
        }
      }
      if (existing && sequence !== null && existing.provider_event_created !== null) {
        const oldSequence = Number(existing.provider_event_created);
        if (sequence < oldSequence || (sequence === oldSequence && terminal.has(existing.status) && ['active', 'trialing'].includes(status))) {
          return { ...existing, applied: false, stale: true };
        }
      }
      const id = randomId('ent');
      q(`INSERT INTO entitlements(id,account_id,product,status,source,source_ref,current_period_end,cancel_at_period_end,metadata_json,provider_event_created,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source,source_ref,product) DO UPDATE SET
        account_id=excluded.account_id,status=excluded.status,current_period_end=excluded.current_period_end,
        cancel_at_period_end=excluded.cancel_at_period_end,metadata_json=excluded.metadata_json,
        provider_event_created=COALESCE(excluded.provider_event_created,entitlements.provider_event_created),updated_at=excluded.updated_at`)
        .run(id, accountId, product, status, source, sourceRef, currentPeriodEnd, cancelAtPeriodEnd ? 1 : 0, JSON.stringify(metadata), sequence, now, now);
      if (source === 'stripe') api.recordBillingSourceState(accountId, sourceRef, status, sequence);
      return { ...q('SELECT * FROM entitlements WHERE source=? AND source_ref=? AND product=?').get(source, sourceRef, product), applied: true, stale: false };
    },
    listEntitlements(accountId) { return q('SELECT * FROM entitlements WHERE account_id=? ORDER BY created_at DESC').all(accountId).map((row) => ({ ...row, cancel_at_period_end: Boolean(row.cancel_at_period_end), metadata: parseJson(row.metadata_json) })); },
    getEntitlementBySource(accountId, sourceRef, product) {
      const row = q("SELECT * FROM entitlements WHERE account_id=? AND source='stripe' AND source_ref=? AND product=?").get(accountId, sourceRef, product);
      return row ? { ...row, cancel_at_period_end: Boolean(row.cancel_at_period_end), metadata: parseJson(row.metadata_json) } : null;
    },
    hasActiveEntitlement(accountId, product) { return Boolean(q("SELECT 1 ok FROM entitlements WHERE account_id=? AND product=? AND status IN ('active','trialing') LIMIT 1").get(accountId, product)); },
    hasActiveApiEntitlement(accountId) { return Boolean(q("SELECT 1 ok FROM entitlements WHERE account_id=? AND product LIKE 'api:%' AND status IN ('active','trialing') LIMIT 1").get(accountId)); },
    isStaleEntitlementEvent(accountId, sourceRef, eventCreated) {
      if (!Number.isInteger(eventCreated) || eventCreated < 0) return false;
      const row = q("SELECT MAX(provider_event_created) latest FROM entitlements WHERE account_id=? AND source='stripe' AND source_ref=?").get(accountId, sourceRef);
      const state = q('SELECT provider_event_created FROM billing_source_state WHERE account_id=? AND source_ref=?').get(accountId, sourceRef);
      const latest = Math.max(row?.latest === null || row?.latest === undefined ? -1 : Number(row.latest),
        state?.provider_event_created === null || state?.provider_event_created === undefined ? -1 : Number(state.provider_event_created));
      return latest > eventCreated;
    },
    listActivePaidEntitlements(accountId) { return q("SELECT product,status,source_ref,current_period_end,cancel_at_period_end FROM entitlements WHERE account_id=? AND source='stripe' AND status IN ('active','trialing','past_due','unpaid','paused','incomplete') ORDER BY product").all(accountId).map((row) => ({ ...row, cancel_at_period_end: Boolean(row.cancel_at_period_end) })); },
    syncAccountPlan(accountId) {
      return tx(() => {
        const account = accountById.get(accountId);
        if (!account) return null;
        const premium = api.hasActiveEntitlement(accountId, 'premium');
        const hasApi = api.hasActiveApiEntitlement(accountId);
        const plan = premium ? 'premium' : hasApi ? 'api' : 'free';
        q('UPDATE accounts SET plan=?,updated_at=? WHERE id=?').run(plan, nowIso(), accountId);
        api.reconcileAlertEntitlements(accountId);
        return accountById.get(accountId);
      });
    },
    reconcileAlertEntitlements(accountId) {
      return tx(() => {
        const account = accountById.get(accountId);
        if (!account) return null;
        const premium = api.hasActiveEntitlement(accountId, 'premium');
        const limit = premium ? PREMIUM_ALERT_LIMIT : FREE_ALERT_LIMIT;
        const active = q("SELECT id FROM alerts WHERE account_id=? AND status='active' ORDER BY created_at,id").all(accountId);
        const paused = active.slice(limit).map((row) => row.id);
        const now = nowIso();
        for (const alertId of paused) {
          q("UPDATE alerts SET status='paused',condition_active=0,updated_at=? WHERE id=? AND account_id=? AND status='active'")
            .run(now, alertId, accountId);
          api.cancelAlertOutbox(accountId, alertId);
        }
        if (!premium) api.cancelNotificationOutbox(accountId, ['weekly-digest']);
        return { limit, activeBefore: active.length, activeAfter: active.length - paused.length, paused };
      });
    },
    retireOtherEntitlements(accountId, sourceRef, keepProduct, eventCreated = null) {
      const sequence = Number.isInteger(eventCreated) && eventCreated >= 0 ? eventCreated : null;
      const rows = q('SELECT product,provider_event_created FROM entitlements WHERE account_id=? AND source=\'stripe\' AND source_ref=? AND product!=?').all(accountId, sourceRef, keepProduct);
      const retired = [];
      for (const row of rows) {
        if (sequence !== null && row.provider_event_created !== null && sequence < Number(row.provider_event_created)) continue;
        q("UPDATE entitlements SET status='canceled',provider_event_created=COALESCE(?,provider_event_created),updated_at=? WHERE account_id=? AND source='stripe' AND source_ref=? AND product=?")
          .run(sequence, nowIso(), accountId, sourceRef, row.product);
        retired.push(row.product);
      }
      return retired;
    },
    deactivateEntitlementsBySource(accountId, sourceRef, status = 'inactive', eventCreated = null) {
      const sequence = Number.isInteger(eventCreated) && eventCreated >= 0 ? eventCreated : null;
      const sourceState = api.recordBillingSourceState(accountId, sourceRef, status, sequence);
      if (!sourceState.applied) return [];
      const rows = q("SELECT product,provider_event_created FROM entitlements WHERE account_id=? AND source='stripe' AND source_ref=?").all(accountId, sourceRef);
      const deactivated = [];
      for (const row of rows) {
        if (sequence !== null && row.provider_event_created !== null && sequence < Number(row.provider_event_created)) continue;
        q(`UPDATE entitlements SET status=?,provider_event_created=COALESCE(?,provider_event_created),updated_at=?
          WHERE account_id=? AND source='stripe' AND source_ref=? AND product=?`)
          .run(status, sequence, nowIso(), accountId, sourceRef, row.product);
        deactivated.push(row.product);
      }
      return deactivated;
    },
    recordBillingSourceState(accountId, sourceRef, status, eventCreated = null) {
      const sequence = Number.isInteger(eventCreated) && eventCreated >= 0 ? eventCreated : null;
      const existing = q('SELECT * FROM billing_source_state WHERE account_id=? AND source_ref=?').get(accountId, sourceRef);
      const terminal = new Set(['canceled', 'unpaid', 'past_due', 'paused', 'incomplete', 'incomplete_expired', 'inactive']);
      if (existing && sequence !== null && existing.provider_event_created !== null) {
        const oldSequence = Number(existing.provider_event_created);
        if (sequence < oldSequence || (sequence === oldSequence && terminal.has(existing.status) && ['active', 'trialing'].includes(status))) {
          return { ...existing, applied: false, stale: true };
        }
      }
      q(`INSERT INTO billing_source_state(account_id,source_ref,status,provider_event_created,updated_at) VALUES(?,?,?,?,?)
        ON CONFLICT(account_id,source_ref) DO UPDATE SET status=excluded.status,
        provider_event_created=COALESCE(excluded.provider_event_created,billing_source_state.provider_event_created),updated_at=excluded.updated_at`)
        .run(accountId, sourceRef, status, sequence, nowIso());
      return { ...q('SELECT * FROM billing_source_state WHERE account_id=? AND source_ref=?').get(accountId, sourceRef), applied: true, stale: false };
    },
    confirmAlertDelivery(alertId, triggerKey, at = nowIso()) {
      if (!Number.isSafeInteger(Number(alertId)) || typeof triggerKey !== 'string' || !triggerKey) return false;
      return q(`UPDATE alerts SET last_notified_at=?,last_delivered_trigger_key=?,updated_at=?
        WHERE id=? AND status='active' AND condition_active=1 AND last_trigger_key=?`)
        .run(at, triggerKey, at, Number(alertId), triggerKey).changes > 0;
    },
    releaseAlertTrigger(alertId, triggerKey, at = nowIso()) {
      if (!Number.isSafeInteger(Number(alertId)) || typeof triggerKey !== 'string' || !triggerKey) return false;
      return q(`UPDATE alerts SET condition_active=0,last_trigger_key=NULL,updated_at=?
        WHERE id=? AND condition_active=1 AND last_trigger_key=?
        AND (last_delivered_trigger_key IS NULL OR last_delivered_trigger_key!=last_trigger_key)`)
        .run(at, Number(alertId), triggerKey).changes > 0;
    },
    recordAlertTrigger(alertId, triggerKey, at = nowIso()) { return q('UPDATE alerts SET last_trigger_key=?,updated_at=? WHERE id=? AND (last_trigger_key IS NULL OR last_trigger_key!=?)').run(triggerKey, at, alertId, triggerKey).changes > 0; },
    evaluateAlertCondition(alertId, trueCents, triggerKey, at = nowIso()) {
      return tx(() => {
        const alert = q("SELECT id,account_id,threshold_cents,condition_active,status,last_trigger_key,last_delivered_trigger_key FROM alerts WHERE id=? AND status='active'").get(alertId);
        if (!alert) return { notify: false, reason: 'inactive' };
        if (!api.isAlertWithinEntitlement(alert.account_id, alert.id)) return { notify: false, reason: 'not-entitled' };
        const below = trueCents <= alert.threshold_cents;
        if (!below) {
          api.cancelAlertOutbox(alert.account_id, alert.id);
          q('UPDATE alerts SET condition_active=0,last_trigger_key=NULL,last_evaluated_cents=?,updated_at=? WHERE id=?').run(trueCents, at, alertId);
          return { notify: false, reason: 'above-threshold' };
        }
        if (alert.condition_active) {
          const awaitingDelivery = alert.last_trigger_key && alert.last_delivered_trigger_key !== alert.last_trigger_key;
          if (awaitingDelivery && alert.last_trigger_key !== triggerKey) {
            // A fresher still-below observation supersedes an unsent retry.
            // Cancel the old encrypted price and let the caller atomically
            // enqueue this exact latest snapshot instead.
            api.cancelAlertOutbox(alert.account_id, alert.id);
            const changed = q(`UPDATE alerts SET last_evaluated_cents=?,last_trigger_key=?,updated_at=?
              WHERE id=? AND status='active' AND condition_active=1 AND last_trigger_key=?`)
              .run(trueCents, triggerKey, at, alertId, alert.last_trigger_key).changes;
            return { notify: changed === 1, reason: changed === 1 ? 'retargeted-pending-crossing' : 'raced' };
          }
          q('UPDATE alerts SET last_evaluated_cents=?,updated_at=? WHERE id=?').run(trueCents, at, alertId);
          return { notify: false, reason: awaitingDelivery ? 'delivery-pending' : 'already-below' };
        }
        const changed = q(`UPDATE alerts SET condition_active=1,last_evaluated_cents=?,last_trigger_key=?,updated_at=?
          WHERE id=? AND status='active' AND condition_active=0`).run(trueCents, triggerKey, at, alertId).changes;
        return { notify: changed === 1, reason: changed === 1 ? 'crossed-below' : 'raced' };
      });
    },
    listEvaluableAlerts(productId) {
      return q(`SELECT a.*,ac.email account_email,pref.timezone FROM alerts a JOIN accounts ac ON ac.id=a.account_id JOIN account_preferences pref ON pref.account_id=a.account_id JOIN notification_subscriptions n ON n.account_id=a.account_id AND n.channel='email' WHERE a.product_id=? AND a.status='active' AND ac.deleted_at IS NULL AND pref.email_alerts=1 AND n.status='active'`).all(productId)
        .filter((row) => api.isAlertWithinEntitlement(row.account_id, row.id));
    },
    listDeliverableAlerts(productId, trueCents) {
      return q(`SELECT a.*,ac.email account_email,pref.timezone FROM alerts a JOIN accounts ac ON ac.id=a.account_id JOIN account_preferences pref ON pref.account_id=a.account_id JOIN notification_subscriptions n ON n.account_id=a.account_id AND n.channel='email' WHERE a.product_id=? AND a.status='active' AND a.threshold_cents>=? AND ac.deleted_at IS NULL AND pref.email_alerts=1 AND n.status='active'`).all(productId, trueCents)
        .filter((row) => api.isAlertWithinEntitlement(row.account_id, row.id));
    },
    createAlertUnsubscribeToken(accountId, alertId, ttlMs = 366 * 86_400_000) {
      const alert = q("SELECT id FROM alerts WHERE id=? AND account_id=? AND status!='deleted'").get(alertId, accountId);
      if (!alert) return null;
      const token = crypto.randomBytes(32).toString('base64url'), now = nowIso();
      q('INSERT INTO alert_unsubscribe_tokens(token_hash,alert_id,account_id,expires_at,created_at) VALUES(?,?,?,?,?)')
        .run(sha256(token), alertId, accountId, nowIso(Date.now() + ttlMs), now);
      return token;
    },
    unsubscribeAlert(token) { return tx(() => {
      if (typeof token !== 'string') return null;
      const tokenHash = sha256(token), now = nowIso();
      let row = q("SELECT * FROM alerts WHERE unsubscribe_token_hash=? AND status!='deleted'").get(tokenHash);
      if (!row) {
        const issued = q('SELECT * FROM alert_unsubscribe_tokens WHERE token_hash=? AND used_at IS NULL AND expires_at>?').get(tokenHash, now);
        if (issued) {
          q('UPDATE alert_unsubscribe_tokens SET used_at=? WHERE token_hash=? AND used_at IS NULL').run(now, tokenHash);
          row = q("SELECT * FROM alerts WHERE id=? AND account_id=? AND status!='deleted'").get(issued.alert_id, issued.account_id);
        }
      }
      if (!row) return null;
      q("UPDATE alerts SET status='paused',condition_active=0,unsubscribe_token_hash=NULL,updated_at=? WHERE id=?").run(now, row.id);
      api.cancelAlertOutbox(row.account_id, row.id);
      return q('SELECT * FROM alerts WHERE id=?').get(row.id);
    }); },

    putPendingKey(sessionId, rawKey, tier, accountId = null) { const sealed = sealSecret(rawKey); q('INSERT OR REPLACE INTO pending_keys(session_id,raw_key,tier,account_id,key_iv,key_tag,created_at) VALUES(?,?,?,?,?,?,?)').run(sessionId, sealed.ciphertext, tier, accountId, sealed.iv, sealed.tag, nowIso()); },
    registerCheckoutClaim({ sessionId, accountId = null, plan, tier = null, status = tier ? 'claimable' : 'complete' }) {
      const now = nowIso();
      q(`INSERT INTO checkout_claims(session_id,account_id,plan,tier,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(session_id) DO UPDATE SET account_id=excluded.account_id,plan=excluded.plan,tier=excluded.tier,
        status=CASE WHEN checkout_claims.status='claimed' THEN checkout_claims.status ELSE excluded.status END,updated_at=excluded.updated_at`)
        .run(sessionId, accountId, plan, tier, status, now, now);
      return api.getCheckoutClaim(sessionId, accountId === null ? undefined : accountId);
    },
    getCheckoutClaim(sessionId, accountId = undefined) {
      const row = q('SELECT * FROM checkout_claims WHERE session_id=?').get(sessionId);
      if (!row || (accountId !== undefined && row.account_id !== accountId)) return null;
      return row;
    },
    takePendingKey(sessionId, accountId = undefined) { return tx(() => {
      const row = q('SELECT raw_key,tier,account_id,key_iv,key_tag FROM pending_keys WHERE session_id=?').get(sessionId);
      if (!row || (accountId !== undefined && row.account_id !== accountId)) return null;
      q('DELETE FROM pending_keys WHERE session_id=?').run(sessionId);
      const now = nowIso();
      q("UPDATE checkout_claims SET status='claimed',claimed_at=?,updated_at=? WHERE session_id=? AND status='claimable'").run(now, now, sessionId);
      return { raw_key: openSecret(row), tier: row.tier, account_id: row.account_id };
    }); },
    prunePendingKeys(ttlMs = 86_400_000) { q('DELETE FROM pending_keys WHERE created_at<?').run(nowIso(Date.now() - ttlMs)); },
    reserveCheckoutIntent(accountId, plan, options = {}) {
      return tx(() => {
        const { ttlMs = 30 * 60_000, termsVersion = null } = typeof options === 'number' ? { ttlMs: options } : options;
        const now = nowIso(), cutoff = nowIso(Date.now() - ttlMs);
        q("UPDATE checkout_intents SET status='expired',updated_at=? WHERE account_id=? AND status='pending' AND stripe_session_id IS NULL AND created_at<?").run(now, accountId, cutoff);
        // Once Stripe has attached a session, local wall-clock expiry is not an
        // authoritative terminal signal. A delayed completed webhook could
        // represent a real subscription, so only a signed provider terminal
        // event may expire/fail the intent.
        let intent = q("SELECT * FROM checkout_intents WHERE account_id=? AND status IN ('pending','awaiting_payment') ORDER BY created_at,id LIMIT 1").get(accountId);
        if (intent) {
          if (intent.plan !== plan) {
            const error = new Error('another checkout is already pending; finish or let it expire before choosing a different plan');
            error.status = 409;
            error.code = 'CHECKOUT_PENDING';
            error.details = { pendingPlans: [intent.plan] };
            throw error;
          }
          if (termsVersion && intent.terms_version !== termsVersion) {
            q('UPDATE checkout_intents SET terms_version=?,updated_at=? WHERE id=?').run(termsVersion, now, intent.id);
            intent = q('SELECT * FROM checkout_intents WHERE id=?').get(intent.id);
          }
          return { ...intent, created: false };
        }
        const id = randomId('checkout'), idempotencyKey = `pricetruth-${crypto.randomBytes(24).toString('base64url')}`;
        q("INSERT INTO checkout_intents(id,account_id,plan,idempotency_key,terms_version,status,created_at,updated_at) VALUES(?,?,?,?,?,'pending',?,?)")
          .run(id, accountId, plan, idempotencyKey, termsVersion, now, now);
        intent = q('SELECT * FROM checkout_intents WHERE id=?').get(id);
        return { ...intent, created: true };
      });
    },
    updateCheckoutIntent(intentId, { sessionId = null, url = null, status = 'pending', expiresAt = null, paymentStatus = null } = {}) {
      q('UPDATE checkout_intents SET stripe_session_id=COALESCE(?,stripe_session_id),checkout_url=COALESCE(?,checkout_url),expires_at=COALESCE(?,expires_at),payment_status=COALESCE(?,payment_status),status=?,updated_at=? WHERE id=?')
        .run(sessionId, url, expiresAt, paymentStatus, status, nowIso(), intentId);
      return q('SELECT * FROM checkout_intents WHERE id=?').get(intentId) || null;
    },
    getCheckoutIntentBySession(accountId, sessionId) {
      return q('SELECT * FROM checkout_intents WHERE account_id=? AND stripe_session_id=?').get(accountId, sessionId) || null;
    },
    completeCheckoutIntent(accountId, plan, sessionId) {
      const now = nowIso();
      return q("UPDATE checkout_intents SET stripe_session_id=COALESCE(stripe_session_id,?),status='completed',payment_status='paid',updated_at=? WHERE account_id=? AND plan=? AND status IN ('pending','awaiting_payment')")
        .run(sessionId, now, accountId, plan).changes;
    },
    terminalCheckoutIntent(accountId, sessionId, status, paymentStatus = null, expiresAt = null) {
      if (!['pending', 'awaiting_payment', 'expired', 'failed'].includes(status)) return false;
      return q('UPDATE checkout_intents SET status=?,payment_status=COALESCE(?,payment_status),expires_at=COALESCE(?,expires_at),updated_at=? WHERE account_id=? AND stripe_session_id=?')
        .run(status, paymentStatus, expiresAt, nowIso(), accountId, sessionId).changes > 0;
    },
    listPendingCheckoutIntents(accountId, ttlMs = 30 * 60_000) {
      const now = nowIso(), cutoff = nowIso(Date.now() - ttlMs);
      q("UPDATE checkout_intents SET status='expired',updated_at=? WHERE account_id=? AND status='pending' AND stripe_session_id IS NULL AND created_at<?").run(now, accountId, cutoff);
      return q("SELECT id,plan,stripe_session_id,created_at,expires_at,payment_status FROM checkout_intents WHERE account_id=? AND status IN ('pending','awaiting_payment') ORDER BY created_at").all(accountId);
    },
    listWeeklyDigestRecipients() {
      return q(`SELECT a.id,a.email,p.timezone FROM accounts a
        JOIN account_preferences p ON p.account_id=a.id
        JOIN notification_subscriptions n ON n.account_id=a.id AND n.channel='email' AND n.status='active'
        WHERE a.deleted_at IS NULL AND p.email_alerts=1 AND p.weekly_digest=1
        AND EXISTS(SELECT 1 FROM entitlements e WHERE e.account_id=a.id AND e.product='premium' AND e.status IN ('active','trialing'))`).all();
    },
    isWeeklyDigestEligible(accountId) { return Boolean(q(`SELECT 1 ok FROM accounts a
      JOIN account_preferences p ON p.account_id=a.id
      JOIN notification_subscriptions n ON n.account_id=a.id AND n.channel='email' AND n.status='active'
      WHERE a.id=? AND a.deleted_at IS NULL AND p.email_alerts=1 AND p.weekly_digest=1
      AND EXISTS(SELECT 1 FROM entitlements e WHERE e.account_id=a.id AND e.product='premium' AND e.status IN ('active','trialing'))`).get(accountId)); },
    pruneOperationalData({ completedJobDays = 14, deliveryEventDays = 90, outboxDays = 30 } = {}) {
      const now = nowIso();
      const jobs = q("DELETE FROM jobs WHERE status IN ('completed','failed','canceled') AND updated_at<?").run(nowIso(Date.now() - completedJobDays * 86_400_000)).changes;
      const deliveryEvents = q('DELETE FROM delivery_events WHERE created_at<?').run(nowIso(Date.now() - deliveryEventDays * 86_400_000)).changes;
      // Scrub recipient and encrypted payload as soon as terminal mail ages out;
      // the aggregate delivery-event audit has its own bounded retention.
      const outbox = q("DELETE FROM outbox WHERE status IN ('sent','failed','canceled') AND updated_at<?").run(nowIso(Date.now() - outboxDays * 86_400_000)).changes;
      q('DELETE FROM notification_unsubscribe_tokens WHERE used_at IS NOT NULL OR expires_at<?').run(now);
      q('DELETE FROM alert_unsubscribe_tokens WHERE used_at IS NOT NULL OR expires_at<?').run(now);
      q("DELETE FROM checkout_intents WHERE status IN ('completed','expired') AND updated_at<?").run(nowIso(Date.now() - 30 * 86_400_000));
      return { jobs, deliveryEvents, outbox };
    },
    revenueSummary(recent = 10) {
      const totals = q(`SELECT
        COALESCE(SUM(CASE WHEN amount_cents>0 AND type NOT LIKE 'charge.dispute.%' THEN 1 ELSE 0 END),0) paid_events,
        COALESCE(SUM(CASE WHEN amount_cents>0 AND type NOT LIKE 'charge.dispute.%' THEN amount_cents ELSE 0 END),0) gross_cents,
        COALESCE(-SUM(CASE WHEN type='charge.refunded' AND amount_cents<0 THEN amount_cents ELSE 0 END),0) refunds_cents,
        COALESCE(-SUM(CASE WHEN type LIKE 'charge.dispute.%' THEN amount_cents ELSE 0 END),0) disputes_cents,
        COALESCE(SUM(amount_cents),0) net_cents FROM billing_events`).get();
      const sumSince = (days) => q('SELECT COALESCE(SUM(amount_cents),0) cents FROM billing_events WHERE ts>=?').get(nowIso(Date.now() - days * 86_400_000)).cents;
      return { ...totals, last_30d_cents: sumSince(30), last_7d_cents: sumSince(7), recent: q('SELECT ts,type,plan,amount_cents,currency,livemode FROM billing_events ORDER BY ts DESC LIMIT ?').all(recent), active_plans: q("SELECT plan,COUNT(*) n FROM accounts WHERE plan!='free' AND deleted_at IS NULL GROUP BY plan").all() };
    },
    exportAccount(accountId) {
      const account = accountById.get(accountId);
      if (!account) return null;
      const privateProducts = q("SELECT * FROM products WHERE owner_account_id=? AND visibility='private' ORDER BY created_at").all(accountId).map((row) => {
        const product = productRow(row);
        return { ...product, history: q('SELECT ts,advertised_cents,true_cents,source,source_label,certainty,observed,fetched_at,evidence_json FROM price_points WHERE product_id=? ORDER BY ts').all(product.id).map((point) => ({ ...point, observed: Boolean(point.observed), evidence: parseJson(point.evidence_json) })) };
      });
      return {
        exportedAt: nowIso(),
        account: { id: account.id, email: account.email, emailVerified: Boolean(account.email_verified), plan: account.plan, createdAt: account.created_at, verifiedAt: account.verified_at || null, emailSuppressedAt: account.email_suppressed_at || null, emailSuppressionReason: account.email_suppression_reason || null },
        preferences: preferences(accountId),
        termsAcceptances: api.listTermsAcceptances(accountId),
        watchlist: api.listWatchlist(accountId), alerts: api.listAlerts(accountId), privateProducts,
        notificationSubscriptions: q('SELECT channel,status,verify_expires_at,verified_at,unsubscribed_at,bounced_at,complaint_at,created_at,updated_at FROM notification_subscriptions WHERE account_id=? ORDER BY channel').all(accountId),
        emailDeliveries: q('SELECT to_email,template,status,attempts,provider_message_id,created_at,sent_at FROM outbox WHERE account_id=? ORDER BY created_at').all(accountId),
        apiKeys: api.listApiKeys(accountId),
        apiUsage: q('SELECT k.id key_id,k.prefix,k.label,u.day,u.count FROM api_keys k JOIN api_usage u ON u.key_id=k.id WHERE k.owner_account_id=? ORDER BY u.day,k.id').all(accountId),
        entitlements: api.listEntitlements(accountId),
        billingSourceState: q('SELECT source_ref,status,provider_event_created,updated_at FROM billing_source_state WHERE account_id=? ORDER BY source_ref').all(accountId),
        sessions: q('SELECT id,created_at,last_seen_at,expires_at,revoked_at,user_agent_hash IS NOT NULL userAgentRecorded,ip_hash IS NOT NULL ipRecorded FROM sessions WHERE account_id=? ORDER BY created_at').all(accountId).map((row) => ({ ...row, userAgentRecorded: Boolean(row.userAgentRecorded), ipRecorded: Boolean(row.ipRecorded) })),
        authActivity: q('SELECT id,purpose,expires_at,consumed_at,created_at FROM auth_tokens WHERE account_id=? ORDER BY created_at').all(accountId),
        billing: q('SELECT ts,type,plan,amount_cents,currency,livemode FROM billing_events WHERE account_id=? OR email=? ORDER BY ts').all(accountId, account.email),
      };
    },
    deleteAccount(accountId) { return tx(() => {
      const account = accountById.get(accountId);
      if (!account || api.listActivePaidEntitlements(accountId).length > 0 || api.listPendingCheckoutIntents(accountId).length > 0 || api.listPendingBillingReconciliation(accountId, account?.stripe_customer).length > 0) return false;
      const now = nowIso();
      for (const product of q("SELECT id FROM products WHERE owner_account_id=? AND visibility='private'").all(accountId)) api.cancelProductJobs(product.id);
      q(`UPDATE jobs SET
        status=CASE WHEN status IN ('pending','retry','running') THEN 'canceled' ELSE status END,
        payload_json='{}',idempotency_key=NULL,leased_until=NULL,
        last_error=CASE WHEN status IN ('pending','retry','running') THEN 'target account deleted' ELSE last_error END,
        updated_at=?,completed_at=CASE WHEN status IN ('pending','retry','running') THEN ? ELSE completed_at END
        WHERE type='weekly-digest' AND json_extract(payload_json,'$.accountId')=?`).run(now, now, accountId);
      q('DELETE FROM sessions WHERE account_id=?').run(accountId);
      q('DELETE FROM auth_tokens WHERE account_id=?').run(accountId);
      q('DELETE FROM watchlist WHERE account_id=?').run(accountId);
      q('DELETE FROM alert_unsubscribe_tokens WHERE account_id=?').run(accountId);
      q('DELETE FROM alerts WHERE account_id=? OR email=?').run(accountId, account.email);
      q('DELETE FROM account_preferences WHERE account_id=?').run(accountId);
      q('DELETE FROM account_terms_acceptances WHERE account_id=?').run(accountId);
      q('DELETE FROM notification_subscriptions WHERE account_id=?').run(accountId);
      q('DELETE FROM notification_unsubscribe_tokens WHERE account_id=?').run(accountId);
      q('DELETE FROM outbox WHERE account_id=?').run(accountId);
      q('DELETE FROM pending_keys WHERE account_id=?').run(accountId);
      q('DELETE FROM checkout_claims WHERE account_id=?').run(accountId);
      q('DELETE FROM checkout_intents WHERE account_id=?').run(accountId);
      q('DELETE FROM entitlements WHERE account_id=?').run(accountId);
      q('DELETE FROM billing_source_state WHERE account_id=?').run(accountId);
      // Explicit dependent cleanup supports databases upgraded from the legacy
      // schema whose product foreign keys did not yet include CASCADE.
      q("DELETE FROM price_points WHERE product_id IN (SELECT id FROM products WHERE owner_account_id=? AND visibility='private')").run(accountId);
      q("DELETE FROM products WHERE owner_account_id=? AND visibility='private'").run(accountId);
      // API key labels are operator/user supplied and may contain personal or
      // client data. Erasure removes both those records and their linked
      // per-day usage rather than detaching a still-identifying label/prefix.
      q('DELETE FROM api_usage WHERE key_id IN (SELECT id FROM api_keys WHERE owner_account_id=?)').run(accountId);
      q('DELETE FROM api_keys WHERE owner_account_id=?').run(accountId);
      q('UPDATE billing_events SET email=NULL,account_id=NULL,payload_json=\'{}\' WHERE account_id=? OR email=?').run(accountId, account.email);
      if (account.stripe_customer) q('UPDATE billing_reconciliation SET payload_json=\'{}\' WHERE json_extract(payload_json,\'$.customer\')=?').run(account.stripe_customer);
      const customerHash = account.stripe_customer ? sha256(`billing-customer:${account.stripe_customer}`) : null;
      q("UPDATE accounts SET email=?,plan='free',stripe_customer=NULL,billing_customer_hash=?,deleted_at=?,updated_at=? WHERE id=?").run(`deleted+${accountId}@deleted.invalid`, customerHash, now, now, accountId);
      return true;
    }); },
    metrics() { const day = (n) => nowIso(Date.now() - n * 86_400_000).slice(0, 10), grouped = (table) => Object.fromEntries(q(`SELECT status,COUNT(*) n FROM ${table} GROUP BY status`).all().map((row) => [row.status, row.n])); return { keys_by_tier: q('SELECT tier,COUNT(*) n FROM api_keys WHERE revoked=0 GROUP BY tier').all(), api_calls_today: q('SELECT COALESCE(SUM(count),0) n FROM api_usage WHERE day>=?').get(day(0)).n, api_calls_7d: q('SELECT COALESCE(SUM(count),0) n FROM api_usage WHERE day>=?').get(day(7)).n, alerts: q("SELECT COUNT(*) n FROM alerts WHERE status!='deleted'").get().n, products: q('SELECT COUNT(*) n FROM products').get().n, price_points: q('SELECT COUNT(*) n FROM price_points').get().n, outbox: grouped('outbox'), jobs: grouped('jobs'), billing_reconciliation: api.billingReconciliationMetrics() }; },
  };
}

export { open, DEFAULT_PATH, sha256, privateProductId };
