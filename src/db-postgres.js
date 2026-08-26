import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { getDatabase } from '@netlify/database';

const FREE_ALERT_LIMIT = 1;
const PREMIUM_ALERT_LIMIT = 20;
const EXPECTED_SCHEMA_VERSION = 4;
const DEFAULT_READINESS_CACHE_TTL_MS = 5_000;
const nowIso = (ms = Date.now()) => new Date(ms).toISOString();
const randomId = (prefix) => `${prefix}_${crypto.randomBytes(18).toString('base64url')}`;
const sha256 = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
const parseJson = (value, fallback = {}) => {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
};
const normalizePrivateQuery = (value) => String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

function privateProductId(accountId, vertical, query) {
  const owner = String(accountId || '').trim();
  const kind = String(vertical || '').normalize('NFKC').trim().toLowerCase();
  const normalizedQuery = normalizePrivateQuery(query);
  if (!owner || !kind || !normalizedQuery) throw new TypeError('private product ids require an owner, vertical, and query');
  return `p-${sha256(`private-product:v1\0${owner}\0${kind}\0${normalizedQuery}`).slice(0, 48)}`;
}

function int(value) {
  const result = Number(value || 0);
  if (!Number.isSafeInteger(result)) throw new RangeError('database integer is outside the JavaScript safe range');
  return result;
}

function open(options = {}) {
  const normalized = options && typeof options === 'object' ? options : {};
  const database = normalized.database || (!normalized.pool
    ? getDatabase(normalized.connectionString ? { connectionString: normalized.connectionString } : undefined)
    : null);
  const pool = normalized.pool || database?.pool;
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('PriceTruth Postgres requires a pg-compatible pool');
  }
  return wrap(pool, {
    readinessCacheTtlMs: normalized.readinessCacheTtlMs,
    readinessClock: normalized.readinessClock,
  });
}

function wrap(pool, options = {}) {
  const transactionContext = new AsyncLocalStorage();
  let readinessCache = null;
  let readinessCachedAtMs = 0;
  let readinessChecks = 0;
  let readinessProbe = null;
  const readinessCacheTtlMs = Number.isFinite(Number(options.readinessCacheTtlMs))
    ? Math.min(60_000, Math.max(0, Number(options.readinessCacheTtlMs)))
    : DEFAULT_READINESS_CACHE_TTL_MS;
  const readinessClock = typeof options.readinessClock === 'function' ? options.readinessClock : Date.now;
  const readinessNow = () => {
    const value = Number(readinessClock());
    return Number.isFinite(value) ? value : Date.now();
  };

  const query = (text, params = []) => {
    const active = transactionContext.getStore();
    return (active?.client || pool).query(text, params);
  };
  const all = async (text, params = []) => (await query(text, params)).rows;
  const one = async (text, params = []) => (await query(text, params)).rows[0] || null;
  const run = async (text, params = []) => {
    const result = await query(text, params);
    return { changes: result.rowCount || 0, rows: result.rows };
  };

  async function transaction(fn) {
    if (typeof fn !== 'function') throw new TypeError('transaction requires a callback');
    const active = transactionContext.getStore();
    if (active) {
      const savepoint = `pt_nested_${++active.savepoint}`;
      await active.client.query(`SAVEPOINT ${savepoint}`);
      try {
        const value = await fn();
        await active.client.query(`RELEASE SAVEPOINT ${savepoint}`);
        return value;
      } catch (error) {
        await active.client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await active.client.query(`RELEASE SAVEPOINT ${savepoint}`);
        throw error;
      }
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL statement_timeout = '30s'");
      await client.query("SET LOCAL idle_in_transaction_session_timeout = '30s'");
      const value = await transactionContext.run({ client, savepoint: 0 }, fn);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* connection may have failed */ }
      throw error;
    } finally {
      client.release();
    }
  }

  const since = (days) => nowIso(Date.now() - days * 86_400_000);
  const productRow = (row) => row ? { ...row, context: parseJson(row.context_json), evidence: parseJson(row.evidence_json) } : null;
  const advisory = async (scope) => {
    await query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [String(scope)]);
  };
  const configuredPendingKey = process.env.PENDING_KEY_ENCRYPTION_KEY || process.env.OUTBOX_ENCRYPTION_KEY;
  const pendingCipherKey = configuredPendingKey
    ? crypto.createHash('sha256').update(configuredPendingKey, 'utf8').digest()
    : crypto.randomBytes(32);
  // Bucket identifiers can contain an email address or network address. Keep
  // those identifiers out of the database while retaining a stable digest
  // across independent Function instances. Production already requires the
  // outbox encryption key; the SHA-256 fallback keeps local/integration
  // environments deterministic without adding another required secret.
  const durableRateLimitKey = process.env.RATE_LIMIT_HASH_KEY || configuredPendingKey || null;
  const durableBucket = (bucket) => durableRateLimitKey
    ? crypto.createHmac('sha256', durableRateLimitKey).update(`durable-rate-limit:v1\0${bucket}`, 'utf8').digest('hex')
    : sha256(`durable-rate-limit:v1\0${bucket}`);

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

  async function accountByEmail(email) {
    return one('SELECT * FROM accounts WHERE email=$1 AND deleted_at IS NULL', [email]);
  }
  async function accountById(id) {
    return one('SELECT * FROM accounts WHERE id=$1 AND deleted_at IS NULL', [id]);
  }
  async function preferences(accountId) {
    const now = nowIso();
    await run(`INSERT INTO account_preferences(account_id,email_alerts,weekly_digest,timezone,created_at,updated_at)
      VALUES($1,1,0,'UTC',$2,$2) ON CONFLICT(account_id) DO NOTHING`, [accountId, now]);
    const row = await one('SELECT email_alerts,weekly_digest,timezone,created_at,updated_at FROM account_preferences WHERE account_id=$1', [accountId]);
    return { ...row, email_alerts: Boolean(row.email_alerts), weekly_digest: Boolean(row.weekly_digest) };
  }

  const api = {
    storage: 'postgres',
    transaction,
    async lockBillingObject(scope, objectId) {
      const kind = String(scope || '');
      const id = String(objectId || '');
      if (!/^[a-z][a-z0-9-]{0,31}$/.test(kind)) throw new TypeError('billing lock scope is invalid');
      if (!id || id.length > 512) throw new TypeError('billing lock object id must be 1..512 characters');
      if (!transactionContext.getStore()?.client) {
        throw new Error('billing object locks require an active database transaction');
      }
      await advisory(`billing-object:v1:${kind}:${id}`);
      return true;
    },
    async schemaVersion() {
      return int((await one('SELECT COALESCE(MAX(version),0)::integer version FROM schema_migrations'))?.version);
    },
    async checkReady({ force = false } = {}) {
      const clock = readinessNow();
      const cacheAgeMs = clock - readinessCachedAtMs;
      if (!force && readinessCache && cacheAgeMs >= 0 && cacheAgeMs < readinessCacheTtlMs) {
        return { ...readinessCache };
      }
      // A burst of readiness/meta/account checks on one warm Function should
      // share one lightweight connection/schema probe instead of multiplying
      // database traffic. The result is cached only briefly so neither a
      // success nor a transient failure can mask later database state.
      if (!readinessProbe) {
        readinessProbe = (async () => {
          readinessChecks += 1;
          const checkedAt = new Date(clock).toISOString();
          let schemaVersion = null;
          try {
            await one('SELECT 1 ok');
            schemaVersion = await api.schemaVersion();
          } catch { /* safe failure state below */ }
          readinessCache = Object.freeze({
            ok: schemaVersion === EXPECTED_SCHEMA_VERSION,
            integrity: schemaVersion === EXPECTED_SCHEMA_VERSION ? 'ok' : 'unavailable',
            schemaVersion,
            storage: 'postgres',
            checkedAt,
          });
          readinessCachedAtMs = readinessNow();
          return readinessCache;
        })();
      }
      const activeProbe = readinessProbe;
      try {
        return { ...await activeProbe };
      } finally {
        if (readinessProbe === activeProbe) readinessProbe = null;
      }
    },
    async refreshReady() { return api.checkReady({ force: true }); },
    async readinessProbeStats() { return { integrityChecks: readinessChecks, checkedAt: readinessCache?.checkedAt || null }; },
    async close() { if (typeof pool.end === 'function') await pool.end(); },

    // Cross-instance token bucket for security-sensitive traffic. PostgreSQL's
    // atomic unique-conflict update serializes both first use and later debits,
    // while the database clock prevents skew between Function hosts from
    // minting extra tokens.
    async consumeDurableRateLimit(bucket, {
      capacity = 60,
      refillPerSec = 1,
      cost = 1,
      ttlMs = null,
    } = {}) {
      const scope = String(bucket || '');
      const safeCapacity = Number(capacity);
      const safeRefill = Number(refillPerSec);
      const safeCost = Number(cost);
      if (!scope || scope.length > 1024) throw new TypeError('rate-limit bucket must be 1..1024 characters');
      if (!Number.isFinite(safeCapacity) || safeCapacity <= 0 || safeCapacity > 1_000_000) throw new RangeError('rate-limit capacity is invalid');
      if (!Number.isFinite(safeRefill) || safeRefill <= 0 || safeRefill > 100_000) throw new RangeError('rate-limit refill is invalid');
      if (!Number.isFinite(safeCost) || safeCost <= 0 || safeCost > safeCapacity) throw new RangeError('rate-limit cost is invalid');
      const defaultTtl = Math.max(10 * 60_000, Math.ceil((safeCapacity / safeRefill) * 2000));
      const safeTtl = Math.min(31 * 86_400_000, Math.max(60_000, Number(ttlMs) || defaultTtl));
      const storageBucket = durableBucket(scope);

      // INSERT .. ON CONFLICT performs the debit while PostgreSQL holds the
      // unique-index/row lock. The WHERE clause makes an insufficient balance
      // a no-op, so no pair of concurrent callers can both spend the same
      // token. This also works in the local Netlify Database emulator, whose
      // advisory-lock support is intentionally limited.
      const available = `(CASE
        WHEN durable_rate_limits.expires_at::timestamptz <= to_timestamp(excluded.updated_at_ms / 1000.0) THEN $2::double precision
        ELSE LEAST($2::double precision, durable_rate_limits.tokens +
          (GREATEST(0, excluded.updated_at_ms - durable_rate_limits.updated_at_ms)::double precision / 1000.0) * $3::double precision)
      END)`;
      const accepted = await one(`WITH rate_clock AS (
          SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms,
            to_char(
              (clock_timestamp() + ($5::double precision * interval '1 millisecond')) AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
            ) AS expires_at
        )
        INSERT INTO durable_rate_limits(bucket,tokens,updated_at_ms,expires_at)
        SELECT $1,$2::double precision-$4::double precision,now_ms,expires_at FROM rate_clock
        ON CONFLICT(bucket) DO UPDATE SET
          tokens=${available}-$4::double precision,
          -- A statement can compute its database timestamp and then wait on a
          -- competing unique-index/row lock. If the newer statement commits
          -- first, never move the stored clock or expiry backwards: doing so
          -- would let a later request refill time that has already elapsed.
          updated_at_ms=GREATEST(durable_rate_limits.updated_at_ms,excluded.updated_at_ms),
          expires_at=CASE
            WHEN excluded.updated_at_ms>=durable_rate_limits.updated_at_ms THEN excluded.expires_at
            ELSE durable_rate_limits.expires_at
          END
        WHERE ${available}+$6::double precision >= $4::double precision
        RETURNING tokens,updated_at_ms,expires_at`,
      [storageBucket, safeCapacity, safeRefill, safeCost, safeTtl, Number.EPSILON]);
      const row = accepted || await one('SELECT tokens,updated_at_ms,expires_at FROM durable_rate_limits WHERE bucket=$1', [storageBucket]);
      if (!row || !Number.isFinite(Number(row.tokens))) throw new Error('stored rate-limit bucket is invalid');
      const tokens = Math.min(safeCapacity, Math.max(0, Number(row.tokens)));
      const ok = Boolean(accepted);
      const retryAfterSec = ok ? null : Math.max(1, Math.ceil((safeCost - tokens) / safeRefill));
      return {
        ok,
        limit: safeCapacity,
        remaining: Math.max(0, Math.floor(tokens)),
        resetSec: Math.max(1, Math.ceil((safeCapacity - tokens) / safeRefill)),
        ...(retryAfterSec ? { retryAfterSec } : {}),
        expiresAt: row.expires_at,
      };
    },

    async upsertProduct({ id, vertical, name, url = null, advertised_cents, context = {}, source = null, sourceLabel = null, certainty = null, fetchedAt = null, evidence = {}, visibility = 'curated', ownerAccountId = null }) {
      if (visibility === 'private' && !ownerAccountId) throw new TypeError('private products require an owner account');
      const now = nowIso(), safeVisibility = visibility === 'private' ? 'private' : 'curated';
      await run(`INSERT INTO products(id,vertical,name,url,advertised_cents,context_json,source,source_label,certainty,fetched_at,evidence_json,visibility,owner_account_id,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)
        ON CONFLICT(id) DO UPDATE SET vertical=excluded.vertical,name=excluded.name,url=excluded.url,
          advertised_cents=excluded.advertised_cents,context_json=excluded.context_json,source=excluded.source,
          source_label=excluded.source_label,certainty=excluded.certainty,fetched_at=excluded.fetched_at,
          evidence_json=excluded.evidence_json,visibility=excluded.visibility,owner_account_id=excluded.owner_account_id,
          updated_at=excluded.updated_at
        WHERE (products.owner_account_id IS NULL AND excluded.owner_account_id IS NULL)
          OR products.owner_account_id=excluded.owner_account_id`,
      [id, vertical, name, url, advertised_cents, JSON.stringify(context), source, sourceLabel, certainty, fetchedAt,
        JSON.stringify(evidence || {}), safeVisibility, ownerAccountId, now]);
    },
    async getProduct(id) { return productRow(await one('SELECT * FROM products WHERE id=$1', [id])); },
    async listProducts() { return (await all('SELECT * FROM products ORDER BY created_at,id')).map(productRow); },
    async getVisibleProduct(id, accountId = null) { return productRow(await one("SELECT * FROM products WHERE id=$1 AND (visibility='curated' OR owner_account_id=$2)", [id, accountId])); },
    async getPublicProduct(id) { return productRow(await one("SELECT * FROM products WHERE id=$1 AND visibility='curated'", [id])); },
    async listPublicProducts(limit = 20, offset = 0, verticals = null) {
      if (!Array.isArray(verticals)) return (await all("SELECT * FROM products WHERE visibility='curated' ORDER BY created_at,id LIMIT $1 OFFSET $2", [limit, offset])).map(productRow);
      if (verticals.length === 0) return [];
      return (await all("SELECT * FROM products WHERE visibility='curated' AND vertical=ANY($1::text[]) ORDER BY created_at,id LIMIT $2 OFFSET $3", [verticals, limit, offset])).map(productRow);
    },
    async countPublicProducts(verticals = null) {
      if (!Array.isArray(verticals)) return int((await one("SELECT COUNT(*)::integer n FROM products WHERE visibility='curated'"))?.n);
      if (verticals.length === 0) return 0;
      return int((await one("SELECT COUNT(*)::integer n FROM products WHERE visibility='curated' AND vertical=ANY($1::text[])", [verticals]))?.n);
    },
    async countPrivateProducts(accountId) { return int((await one("SELECT COUNT(*)::integer n FROM products WHERE owner_account_id=$1 AND visibility='private'", [accountId]))?.n); },
    async findPrivateProductByQuery(accountId, vertical, originalQuery) {
      const direct = productRow(await one("SELECT * FROM products WHERE id=$1 AND owner_account_id=$2 AND visibility='private' AND vertical=$3", [privateProductId(accountId, vertical, originalQuery), accountId, vertical]));
      if (direct) return direct;
      const normalized = normalizePrivateQuery(originalQuery);
      return (await all(`SELECT * FROM products WHERE owner_account_id=$1 AND visibility='private' AND vertical=$2
        ORDER BY CASE WHEN (evidence_json::jsonb->>'refreshable')::boolean IS TRUE THEN 0 ELSE 1 END,updated_at DESC`, [accountId, vertical]))
        .map(productRow).find((product) => normalizePrivateQuery(product?.evidence?.originalQuery) === normalized) || null;
    },
    async deletePrivateProduct(accountId, productId) { return transaction(async () => {
      await advisory(`private-product:${accountId}:${productId}`);
      const product = await one("SELECT id FROM products WHERE id=$1 AND owner_account_id=$2 AND visibility='private' FOR UPDATE", [productId, accountId]);
      if (!product) return false;
      await api.cancelProductJobs(productId);
      const now = nowIso();
      const alertIds = (await all('SELECT id FROM alerts WHERE product_id=$1 AND account_id=$2', [productId, accountId])).map((row) => row.id);
      for (const alertId of alertIds) {
        await run(`UPDATE outbox SET status=CASE WHEN status IN ('pending','retry','sending') THEN 'canceled' ELSE status END,
          to_email=CASE WHEN status IN ('pending','retry','sending') THEN '' ELSE to_email END,
          payload_ciphertext='',payload_iv='',payload_tag='',metadata_json='{}',leased_until=NULL,lease_token=NULL,
          last_error=CASE WHEN status IN ('pending','retry','sending') THEN 'private report deleted' ELSE last_error END,updated_at=$1
          WHERE account_id=$2 AND template='price-alert' AND (metadata_json::jsonb->>'alertId')::integer=$3`, [now, accountId, alertId]);
      }
      await run(`UPDATE outbox SET status=CASE WHEN status IN ('pending','retry','sending') THEN 'canceled' ELSE status END,
        to_email=CASE WHEN status IN ('pending','retry','sending') THEN '' ELSE to_email END,
        payload_ciphertext='',payload_iv='',payload_tag='',metadata_json='{}',leased_until=NULL,lease_token=NULL,
        last_error=CASE WHEN status IN ('pending','retry','sending') THEN 'private report deleted' ELSE last_error END,updated_at=$1
        WHERE account_id=$2 AND template='weekly-digest'`, [now, accountId]);
      await run('DELETE FROM products WHERE id=$1 AND owner_account_id=$2 AND visibility=\'private\'', [productId, accountId]);
      return true;
    }); },
    async cancelProductJobs(productId) {
      const now = nowIso();
      return (await run(`UPDATE jobs SET status=CASE WHEN status IN ('pending','retry','running') THEN 'canceled' ELSE status END,
        payload_json='{}',idempotency_key=NULL,leased_until=NULL,lease_token=NULL,
        last_error=CASE WHEN status IN ('pending','retry','running') THEN 'target product deleted' ELSE last_error END,
        updated_at=$1,completed_at=CASE WHEN status IN ('pending','retry','running') THEN $1 ELSE completed_at END
        WHERE type IN ('collect-product','evaluate-alerts') AND payload_json::jsonb->>'productId'=$2`, [now, productId])).changes;
    },
    async prunePrivateProductHistory(productId, { maxPoints = 500, maxDays = 365 } = {}) {
      if (!await one("SELECT id FROM products WHERE id=$1 AND visibility='private'", [productId])) return 0;
      const first = await run('DELETE FROM price_points WHERE product_id=$1 AND ts<$2', [productId, since(maxDays)]);
      const second = await run(`DELETE FROM price_points WHERE product_id=$1 AND id NOT IN (
        SELECT id FROM price_points WHERE product_id=$1 ORDER BY ts DESC,id DESC LIMIT $2)`, [productId, Math.max(1, maxPoints)]);
      return first.changes + second.changes;
    },
    async pruneAllPrivateProductHistory(options = {}) {
      let removed = 0;
      for (const row of await all("SELECT id FROM products WHERE visibility='private'")) removed += await api.prunePrivateProductHistory(row.id, options);
      return removed;
    },
    async reserveProviderCall(provider, dailyLimit = 1000) { return transaction(async () => {
      const day = nowIso().slice(0, 10), now = nowIso();
      await run('INSERT INTO provider_usage(day,provider,updated_at) VALUES($1,$2,$3) ON CONFLICT(day,provider) DO NOTHING', [day, provider, now]);
      const allowed = await one(`UPDATE provider_usage SET calls=calls+1,updated_at=$3 WHERE day=$1 AND provider=$2
        AND calls<$4 AND (circuit_open_until IS NULL OR circuit_open_until<=$3) RETURNING calls`, [day, provider, now, Math.max(1, dailyLimit)]);
      if (allowed) return { allowed: true, calls: int(allowed.calls), limit: dailyLimit };
      const row = await one('SELECT calls,circuit_open_until FROM provider_usage WHERE day=$1 AND provider=$2', [day, provider]);
      return { allowed: false, reason: row.circuit_open_until && row.circuit_open_until > now ? 'circuit-open' : 'daily-budget', calls: int(row.calls), limit: dailyLimit };
    }); },
    async recordProviderResult(provider, { ok, circuitFailures = 5, circuitMs = 5 * 60_000 } = {}) { return transaction(async () => {
      const day = nowIso().slice(0, 10), now = nowIso();
      await run('INSERT INTO provider_usage(day,provider,updated_at) VALUES($1,$2,$3) ON CONFLICT(day,provider) DO NOTHING', [day, provider, now]);
      const row = await one('SELECT * FROM provider_usage WHERE day=$1 AND provider=$2 FOR UPDATE', [day, provider]);
      const consecutive = ok ? 0 : int(row.consecutive_failures) + 1;
      const openUntil = !ok && consecutive >= Math.max(1, circuitFailures) ? nowIso(Date.now() + Math.max(1000, circuitMs)) : (ok ? null : row.circuit_open_until);
      await run('UPDATE provider_usage SET failures=failures+$3,consecutive_failures=$4,circuit_open_until=$5,updated_at=$6 WHERE day=$1 AND provider=$2', [day, provider, ok ? 0 : 1, consecutive, openUntil, now]);
      return { ok: Boolean(ok), consecutiveFailures: consecutive, circuitOpenUntil: openUntil };
    }); },
    async refundProviderCall(provider) {
      return (await run('UPDATE provider_usage SET calls=GREATEST(0,calls-1),updated_at=$3 WHERE day=$1 AND provider=$2', [nowIso().slice(0, 10), provider, nowIso()])).changes > 0;
    },
    async providerUsageToday() { return all('SELECT provider,calls,failures,consecutive_failures,circuit_open_until FROM provider_usage WHERE day=$1 ORDER BY provider', [nowIso().slice(0, 10)]); },
    async addPricePoint(productId, { ts = nowIso(), advertised_cents, true_cents, source = null, sourceLabel = null, certainty = null, observed = false, alertEligible = observed, fetchedAt = null, evidence = {}, providerKey = null }) {
      const result = await one(`INSERT INTO price_points(product_id,ts,advertised_cents,true_cents,source,source_label,certainty,observed,alert_eligible,fetched_at,evidence_json,provider_key)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING RETURNING id`,
      [productId, ts, advertised_cents, true_cents, source, sourceLabel, certainty, observed ? 1 : 0, alertEligible ? 1 : 0, fetchedAt, JSON.stringify(evidence || {}), providerKey]);
      return Boolean(result);
    },
    async getHistory(productId, days = 30) {
      return (await all(`SELECT ts,advertised_cents,true_cents,source,source_label,certainty,observed,alert_eligible,fetched_at,evidence_json
        FROM price_points WHERE product_id=$1 AND ts>=$2 ORDER BY ts`, [productId, since(days)]))
        .map((row) => ({ ...row, observed: Boolean(row.observed), alertEligible: Boolean(row.alert_eligible), evidence: parseJson(row.evidence_json) }));
    },
    async getStats(productId, days = 30, { eligibleOnly = true, observedOnly = false } = {}) {
      const clause = eligibleOnly ? ' AND alert_eligible=1' : observedOnly ? ' AND observed=1' : '';
      const row = await one(`SELECT COUNT(*)::integer n,COUNT(DISTINCT ts)::integer distinct_observations,
        COUNT(DISTINCT substr(ts,1,10))::integer distinct_days,MIN(ts) first_ts,MAX(ts) last_ts,
        MIN(true_cents) low_cents,MAX(true_cents) high_cents,ROUND(AVG(true_cents))::integer avg_cents
        FROM price_points WHERE product_id=$1 AND ts>=$2${clause}`, [productId, since(days)]);
      return row?.n ? row : null;
    },
    async getLatestPoint(productId, { eligibleOnly = true, observedOnly = false } = {}) {
      const clause = eligibleOnly ? ' AND alert_eligible=1' : observedOnly ? ' AND observed=1' : '';
      const row = await one(`SELECT ts,advertised_cents,true_cents,source,source_label,certainty,observed,alert_eligible,fetched_at,evidence_json
        FROM price_points WHERE product_id=$1${clause} ORDER BY ts DESC LIMIT 1`, [productId]);
      return row ? { ...row, observed: Boolean(row.observed), alertEligible: Boolean(row.alert_eligible), evidence: parseJson(row.evidence_json) } : null;
    },
  };

  return Object.assign(api, buildAccountMethods({ all, one, run, transaction, advisory, api, accountByEmail, accountById, preferences, sealSecret, openSecret, productRow }),
    buildOperationalMethods({ all, one, run, query, transaction, advisory, api, accountByEmail, accountById, preferences, sealSecret, openSecret, productRow, since }));
}

function buildAccountMethods({ all, one, run, transaction, advisory, api, accountByEmail, accountById, preferences, productRow }) {
  return {
    async createAlert({ email, accountId = null, productId, threshold_cents, status = accountId ? 'active' : 'pending' }) {
      return transaction(async () => {
        if (accountId) {
          await advisory(`alerts:${accountId}`);
          if (!await one('SELECT id FROM accounts WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [accountId])) {
            throw new TypeError('alerts require an active account');
          }
          const limit = await api.alertLimitForAccount(accountId);
          const now = nowIso();
          for (let quotaSlot = 1; quotaSlot <= limit; quotaSlot += 1) {
            const alert = await one(`INSERT INTO alerts(email,account_id,product_id,threshold_cents,status,quota_slot,created_at,updated_at)
              VALUES($1,$2,$3,$4,$5,$6,$7,$7) ON CONFLICT DO NOTHING RETURNING *`,
            [email, accountId, productId, threshold_cents, status, quotaSlot, now]);
            if (alert) return alert;
          }
          const error = new Error(limit === FREE_ALERT_LIMIT ? 'free accounts get 1 price alert' : `premium accounts are limited to ${limit} price alerts`);
          error.status = 402;
          error.code = 'ALERT_LIMIT_REACHED';
          error.details = { limit, plan: limit === FREE_ALERT_LIMIT ? 'free' : 'premium' };
          throw error;
        }
        const now = nowIso();
        return one(`INSERT INTO alerts(email,account_id,product_id,threshold_cents,status,created_at,updated_at)
          VALUES($1,$2,$3,$4,$5,$6,$6) RETURNING *`, [email, accountId, productId, threshold_cents, status, now]);
      });
    },
    async countAlertsForEmail(email) { return int((await one("SELECT COUNT(*)::integer n FROM alerts WHERE email=$1 AND status!='deleted'", [email]))?.n); },
    async countAlertsForAccount(accountId) { return int((await one("SELECT COUNT(*)::integer n FROM alerts WHERE account_id=$1 AND status!='deleted'", [accountId]))?.n); },
    async countActiveAlertsForAccount(accountId) { return int((await one("SELECT COUNT(*)::integer n FROM alerts WHERE account_id=$1 AND status='active'", [accountId]))?.n); },
    async alertLimitForAccount(accountId) { return await api.isPremium(accountId) ? PREMIUM_ALERT_LIMIT : FREE_ALERT_LIMIT; },
    async isAlertWithinEntitlement(accountId, alertId) {
      const limit = await api.alertLimitForAccount(accountId);
      return Boolean(await one(`SELECT 1 ok FROM (SELECT id FROM alerts WHERE account_id=$1 AND status='active'
        ORDER BY created_at,id LIMIT $2) allowed WHERE id=$3`, [accountId, limit, alertId]));
    },
    async listAlerts(accountId) {
      return all(`SELECT a.id,a.product_id,a.threshold_cents,a.status,a.created_at,a.updated_at,a.last_notified_at,
        p.name product_name,p.vertical,p.url FROM alerts a JOIN products p ON p.id=a.product_id
        WHERE a.account_id=$1 AND a.status!='deleted' ORDER BY a.created_at DESC`, [accountId]);
    },
    async getAlert(id, accountId = null) {
      return accountId ? one('SELECT * FROM alerts WHERE id=$1 AND account_id=$2', [id, accountId]) : one('SELECT * FROM alerts WHERE id=$1', [id]);
    },
    async updateAlert(accountId, id, patch) { return transaction(async () => {
      await advisory(`alerts:${accountId}`);
      await one('SELECT id FROM accounts WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [accountId]);
      const old = await api.getAlert(id, accountId);
      if (!old) return null;
      if (patch.status === 'active' && old.status !== 'active') {
        const limit = await api.alertLimitForAccount(accountId);
        if (await api.countActiveAlertsForAccount(accountId) >= limit) {
          const error = new Error(limit === FREE_ALERT_LIMIT ? 'free accounts get 1 active price alert' : `premium accounts are limited to ${limit} active price alerts`);
          error.status = 402;
          error.code = 'ALERT_LIMIT_REACHED';
          error.details = { limit, plan: limit === FREE_ALERT_LIMIT ? 'free' : 'premium' };
          throw error;
        }
      }
      const threshold = patch.threshold_cents ?? old.threshold_cents;
      const status = patch.status ?? old.status;
      const resetsCrossing = threshold !== old.threshold_cents || status !== old.status;
      if (resetsCrossing) await api.cancelAlertOutbox(accountId, id);
      await run(`UPDATE alerts SET threshold_cents=$1,status=$2,condition_active=$3,last_trigger_key=$4,
        last_evaluated_cents=$5,updated_at=$6 WHERE id=$7 AND account_id=$8`,
      [threshold, status, resetsCrossing ? 0 : old.condition_active, resetsCrossing ? null : old.last_trigger_key,
        resetsCrossing ? null : old.last_evaluated_cents, nowIso(), id, accountId]);
      return api.getAlert(id, accountId);
    }); },
    async deleteAlert(accountId, id) { return transaction(async () => {
      const alert = await api.getAlert(id, accountId);
      if (!alert) return false;
      await api.cancelAlertOutbox(accountId, id);
      await run('DELETE FROM alerts WHERE id=$1 AND account_id=$2', [id, accountId]);
      return true;
    }); },

    async getOrCreateAccount(email) { return transaction(async () => {
      const now = nowIso(), id = randomId('acct');
      const inserted = await one(`INSERT INTO accounts(email,id,plan,stripe_customer,email_verified,verified_at,created_at,updated_at)
        VALUES($1,$2,'free',NULL,0,NULL,$3,$3) ON CONFLICT(email) DO NOTHING RETURNING *`, [email, id, now]);
      const account = inserted || await accountByEmail(email);
      if (!account) throw new Error('account creation conflict did not resolve');
      await preferences(account.id);
      return account;
    }); },
    async upsertAccount({ email, plan = 'free', stripeCustomer = null }) {
      const account = await api.getOrCreateAccount(email);
      await run(`UPDATE accounts SET plan=$1,stripe_customer=CASE WHEN stripe_customer IS NULL THEN $2 ELSE stripe_customer END,
        updated_at=$3 WHERE id=$4`, [plan, stripeCustomer, nowIso(), account.id]);
      return accountById(account.id);
    },
    async linkStripeCustomer(accountId, customerId) {
      if (typeof customerId !== 'string' || !/^cus_[A-Za-z0-9_]{4,}$/.test(customerId)) return false;
      try {
        const result = await run(`UPDATE accounts SET stripe_customer=$2,updated_at=$3 WHERE id=$1 AND deleted_at IS NULL
          AND (stripe_customer IS NULL OR stripe_customer=$2)`, [accountId, customerId, nowIso()]);
        return result.changes === 1;
      } catch (error) {
        if (error?.code === '23505') return false;
        throw error;
      }
    },
    async getAccount(email) { return accountByEmail(email); },
    async getAccountById(id) { return accountById(id); },
    async getAccountByStripeCustomer(customerId) { return one('SELECT * FROM accounts WHERE stripe_customer=$1 AND deleted_at IS NULL', [customerId]); },
    async getDeletedAccountForBilling({ accountId = null, customerId = null } = {}) {
      if (accountId) {
        const row = await one('SELECT id,deleted_at FROM accounts WHERE id=$1 AND deleted_at IS NOT NULL', [accountId]);
        if (row) return row;
      }
      if (!customerId) return null;
      return one('SELECT id,deleted_at FROM accounts WHERE billing_customer_hash=$1 AND deleted_at IS NOT NULL', [sha256(`billing-customer:${customerId}`)]);
    },
    async verifyAccount(accountId) {
      const now = nowIso();
      return one(`UPDATE accounts SET email_verified=1,verified_at=COALESCE(verified_at,$2),updated_at=$2
        WHERE id=$1 AND deleted_at IS NULL RETURNING *`, [accountId, now]);
    },
    async isPremium(emailOrId) {
      const account = String(emailOrId).includes('@') ? await accountByEmail(emailOrId) : await accountById(emailOrId);
      return Boolean(account && await one("SELECT 1 ok FROM entitlements WHERE account_id=$1 AND product='premium' AND status IN ('active','trialing') LIMIT 1", [account.id]));
    },
    async getPreferences(accountId) { return preferences(accountId); },
    async recordTermsAcceptance(accountId, termsVersion, context = {}) {
      if (!await accountById(accountId)) throw new TypeError('terms acceptance requires an active account');
      const version = String(termsVersion || '').trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(version)) throw new TypeError('invalid terms version');
      const safeContext = context && typeof context === 'object' && !Array.isArray(context) ? context : {};
      await run(`INSERT INTO account_terms_acceptances(account_id,terms_version,accepted_at,context_json)
        VALUES($1,$2,$3,$4) ON CONFLICT(account_id,terms_version) DO NOTHING`, [accountId, version, nowIso(), JSON.stringify(safeContext)]);
      const row = await one('SELECT account_id,terms_version,accepted_at,context_json FROM account_terms_acceptances WHERE account_id=$1 AND terms_version=$2', [accountId, version]);
      return { account_id: row.account_id, terms_version: row.terms_version, accepted_at: row.accepted_at, context: parseJson(row.context_json) };
    },
    async listTermsAcceptances(accountId) {
      return (await all('SELECT terms_version,accepted_at,context_json FROM account_terms_acceptances WHERE account_id=$1 ORDER BY accepted_at,terms_version', [accountId]))
        .map((row) => ({ termsVersion: row.terms_version, acceptedAt: row.accepted_at, context: parseJson(row.context_json) }));
    },
    async updatePreferences(accountId, patch) { return transaction(async () => {
      const old = await preferences(accountId), now = nowIso();
      const emailAlerts = patch.email_alerts ?? old.email_alerts;
      const weekly = patch.weekly_digest ?? old.weekly_digest;
      await run(`INSERT INTO account_preferences(account_id,email_alerts,weekly_digest,timezone,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(account_id) DO UPDATE SET email_alerts=excluded.email_alerts,
        weekly_digest=excluded.weekly_digest,timezone=excluded.timezone,updated_at=excluded.updated_at`,
      [accountId, emailAlerts ? 1 : 0, weekly ? 1 : 0, patch.timezone ?? old.timezone, old.created_at || now, now]);
      if (!emailAlerts) await api.cancelNotificationOutbox(accountId, ['verify-alerts', 'price-alert', 'weekly-digest']);
      else if (!weekly) await api.cancelNotificationOutbox(accountId, ['weekly-digest']);
      return preferences(accountId);
    }); },

    async createAuthToken(accountId, purpose = 'login', ttlMs = 15 * 60_000) { return transaction(async () => {
      await advisory(`auth-token:${accountId}:${purpose}`);
      const account = await accountById(accountId), now = nowIso();
      if (!account || account.email_suppressed_at) return { token: null, id: null, expiresAt: null, suppressed: true };
      await run(`UPDATE auth_tokens SET quota_slot=NULL WHERE account_id=$1 AND purpose=$2
        AND consumed_at IS NULL AND expires_at<=$3 AND quota_slot IS NOT NULL`, [accountId, purpose, now]);
      const token = crypto.randomBytes(32).toString('base64url'), id = randomId('auth'), expiresAt = nowIso(Date.now() + ttlMs);
      for (let quotaSlot = 1; quotaSlot <= 5; quotaSlot += 1) {
        const inserted = await one(`INSERT INTO auth_tokens(id,account_id,purpose,token_hash,quota_slot,expires_at,created_at)
          VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING id`,
        [id, accountId, purpose, sha256(token), quotaSlot, expiresAt, now]);
        if (inserted) return { token, id, expiresAt, suppressed: false };
      }
      return { token: null, id: null, expiresAt: null, suppressed: true };
    }); },
    async consumeAuthToken(token, purpose = 'login') {
      if (typeof token !== 'string' || token.length < 32 || token.length > 256) return null;
      return transaction(async () => {
        const consumedAt = nowIso();
        const row = await one(`UPDATE auth_tokens SET consumed_at=$3,quota_slot=NULL WHERE token_hash=$1 AND purpose=$2
          AND consumed_at IS NULL AND expires_at>$3 RETURNING *`, [sha256(token), purpose, consumedAt]);
        if (!row) return null;
        await run('UPDATE auth_tokens SET consumed_at=$1,quota_slot=NULL WHERE account_id=$2 AND purpose=$3 AND id!=$4 AND consumed_at IS NULL',
          [consumedAt, row.account_id, purpose, row.id]);
        return { ...row, account: await api.verifyAccount(row.account_id) };
      });
    },
    async createSession(accountId, { ttlMs = 30 * 86_400_000, userAgent = null, ip = null } = {}) {
      const token = crypto.randomBytes(32).toString('base64url'), csrfToken = crypto.randomBytes(24).toString('base64url');
      const now = nowIso(), expiresAt = nowIso(Date.now() + ttlMs), id = randomId('sess');
      await run(`INSERT INTO sessions(id,account_id,token_hash,csrf_hash,user_agent_hash,ip_hash,created_at,last_seen_at,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$7,$8)`, [id, accountId, sha256(token), sha256(csrfToken), userAgent ? sha256(userAgent) : null, ip ? sha256(ip) : null, now, expiresAt]);
      return { id, token, csrfToken, expiresAt };
    },
    async getSession(token, { touch = true } = {}) {
      if (typeof token !== 'string' || token.length < 32 || token.length > 256) return null;
      const row = await one(`SELECT s.*,a.email,a.plan,a.email_verified,a.created_at account_created_at,a.verified_at
        FROM sessions s JOIN accounts a ON a.id=s.account_id WHERE s.token_hash=$1 AND s.revoked_at IS NULL
        AND s.expires_at>$2 AND a.deleted_at IS NULL`, [sha256(token), nowIso()]);
      if (row && touch && Date.now() - Date.parse(row.last_seen_at) > 300_000) await run('UPDATE sessions SET last_seen_at=$1 WHERE id=$2', [nowIso(), row.id]);
      return row;
    },
    async verifyCsrf(session, token) {
      if (!session || typeof token !== 'string' || token.length < 24) return false;
      const expected = Buffer.from(session.csrf_hash, 'hex'), actual = Buffer.from(sha256(token), 'hex');
      return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    },
    async rotateSessionCsrf(sessionId) {
      const csrfToken = crypto.randomBytes(24).toString('base64url');
      const changed = await run('UPDATE sessions SET csrf_hash=$1 WHERE id=$2 AND revoked_at IS NULL AND expires_at>$3', [sha256(csrfToken), sessionId, nowIso()]);
      return changed.changes ? csrfToken : null;
    },
    async revokeSession(token) { return typeof token === 'string' && (await run('UPDATE sessions SET revoked_at=$1 WHERE token_hash=$2 AND revoked_at IS NULL', [nowIso(), sha256(token)])).changes > 0; },
    async revokeAccountSessions(accountId) { return (await run('UPDATE sessions SET revoked_at=$1 WHERE account_id=$2 AND revoked_at IS NULL', [nowIso(), accountId])).changes; },
    async pruneAuth() { return transaction(async () => {
      const now = nowIso();
      const expiredPending = await all(`SELECT n.account_id,a.email FROM notification_subscriptions n JOIN accounts a ON a.id=n.account_id
        WHERE n.status='pending' AND ((n.verify_expires_at IS NOT NULL AND n.verify_expires_at<$1)
        OR (n.verify_expires_at IS NULL AND n.updated_at<$2))`, [now, nowIso(Date.now() - 24 * 60 * 60_000)]);
      for (const { account_id: accountId, email } of expiredPending) {
        await api.cancelNotificationOutbox(accountId);
        await run("DELETE FROM alerts WHERE (account_id=$1 OR (account_id IS NULL AND email=$2)) AND status='pending'", [accountId, email]);
        await run("DELETE FROM notification_subscriptions WHERE account_id=$1 AND status='pending'", [accountId]);
      }
      const authTokens = (await run('DELETE FROM auth_tokens WHERE expires_at<$1 OR consumed_at IS NOT NULL', [now])).changes;
      const sessions = (await run('DELETE FROM sessions WHERE expires_at<$1 OR revoked_at<$2', [now, nowIso(Date.now() - 7 * 86_400_000)])).changes;
      const abandoned = await all(`SELECT a.id,a.email FROM accounts a WHERE a.deleted_at IS NULL AND a.email_verified=0
        AND a.stripe_customer IS NULL AND NOT EXISTS(SELECT 1 FROM auth_tokens t WHERE t.account_id=a.id)
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
        AND NOT EXISTS(SELECT 1 FROM billing_reconciliation r WHERE r.status='pending' AND r.payload_json::jsonb->>'accountId'=a.id)`);
      for (const account of abandoned) await run('DELETE FROM accounts WHERE id=$1 AND email_verified=0', [account.id]);
      return { authTokens, sessions, expiredPending: expiredPending.length, abandonedAccounts: abandoned.length };
    }); },

    async addWatchlist(accountId, productId) {
      const now = nowIso();
      await run('INSERT INTO watchlist(account_id,product_id,created_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [accountId, productId, now]);
      return (await api.listWatchlist(accountId)).find((row) => row.product_id === productId) || null;
    },
    async removeWatchlist(accountId, productId) { return (await run('DELETE FROM watchlist WHERE account_id=$1 AND product_id=$2', [accountId, productId])).changes > 0; },
    async listWatchlist(accountId) {
      return (await all(`SELECT w.product_id,w.created_at,p.vertical,p.name,p.url,p.advertised_cents,p.context_json,p.source,
        p.source_label,p.certainty,p.fetched_at,p.evidence_json,p.visibility,p.owner_account_id FROM watchlist w
        JOIN products p ON p.id=w.product_id WHERE w.account_id=$1 ORDER BY w.created_at DESC`, [accountId])).map(productRow);
    },
    async listTrackedProducts() {
      return (await all(`SELECT DISTINCT p.* FROM products p WHERE EXISTS(SELECT 1 FROM watchlist w WHERE w.product_id=p.id)
        OR EXISTS(SELECT 1 FROM alerts a WHERE a.product_id=p.id AND a.status='active') ORDER BY p.id`)).map(productRow);
    },
    async repairDemoPricePoints(productId, { source, sourceLabel, certainty, evidence = {}, evidenceJson = null }) {
      let encodedEvidence = evidenceJson;
      if (encodedEvidence === null) encodedEvidence = JSON.stringify(evidence);
      else {
        try { JSON.parse(encodedEvidence); } catch { throw new TypeError('evidenceJson must contain valid JSON'); }
      }
      return (await run(`UPDATE price_points SET source=$2,source_label=$3,certainty=$4,observed=0,alert_eligible=0,evidence_json=$5
        WHERE product_id=$1`, [productId, source, sourceLabel, certainty, encodedEvidence])).changes;
    },
    async removeDemoProduct(id) { return transaction(async () => {
      await api.cancelProductJobs(id);
      return (await run('DELETE FROM products WHERE id=$1', [id])).changes > 0;
    }); },
  };
}

function buildOperationalMethods({ all, one, run, transaction, advisory, api, accountById, preferences, sealSecret, openSecret, productRow, since }) {
  return {
    async createApiKeyRecord(label, tier = 'starter', { ownerEmail = null, ownerAccountId = null, stripeRef = null, canWriteHistory = false } = {}) {
      if (!ownerAccountId && ownerEmail) ownerAccountId = (await api.getAccount(ownerEmail))?.id || null;
      const key = `pt_${tier}_${crypto.randomBytes(24).toString('base64url')}`, now = nowIso();
      const record = await one(`INSERT INTO api_keys(key_hash,prefix,label,tier,owner_email,owner_account_id,stripe_ref,
        can_write_history,revoked,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,0,$9,$9)
        RETURNING id,prefix,label,tier,can_write_history,created_at,last_used_at,revoked_at,replaced_by_id`,
      [sha256(key), key.slice(0, 18), label, tier, ownerEmail, ownerAccountId, stripeRef, canWriteHistory ? 1 : 0, now]);
      return { key, record: { ...record, can_write_history: Boolean(record.can_write_history) } };
    },
    async createApiKey(label, tier = 'starter', options = {}) { return (await api.createApiKeyRecord(label, tier, options)).key; },
    async findApiKey(key) {
      if (typeof key !== 'string' || key.length < 20 || key.length > 128) return null;
      const row = await one('SELECT * FROM api_keys WHERE key_hash=$1 AND revoked=0 AND suspended=0', [sha256(key)]);
      if (row) await run('UPDATE api_keys SET last_used_at=$1 WHERE id=$2', [nowIso(), row.id]);
      return row;
    },
    async listApiKeys(accountId) {
      return (await all(`SELECT id,prefix,label,tier,can_write_history,suspended,created_at,last_used_at,revoked_at,replaced_by_id
        FROM api_keys WHERE owner_account_id=$1 ORDER BY id DESC`, [accountId]))
        .map((row) => ({ ...row, can_write_history: Boolean(row.can_write_history), suspended: Boolean(row.suspended) }));
    },
    async revokeApiKey(accountId, id) {
      const now = nowIso();
      return (await run('UPDATE api_keys SET revoked=1,suspended=0,revoked_at=$1,updated_at=$1 WHERE id=$2 AND owner_account_id=$3 AND revoked=0', [now, id, accountId])).changes > 0;
    },
    async revokeApiKeysByStripeRef(stripeRef) {
      if (!stripeRef) return 0;
      const now = nowIso();
      return (await run('UPDATE api_keys SET revoked=1,revoked_at=$1,updated_at=$1 WHERE stripe_ref=$2 AND revoked=0', [now, stripeRef])).changes;
    },
    async revokeApiKeysForAccount(accountId) {
      const now = nowIso();
      return (await run('UPDATE api_keys SET revoked=1,revoked_at=$1,updated_at=$1 WHERE owner_account_id=$2 AND revoked=0', [now, accountId])).changes;
    },
    async syncApiKeysForAccount(accountId) { return transaction(async () => {
      await advisory(`api-keys:${accountId}`);
      const active = await all("SELECT product,source_ref FROM entitlements WHERE account_id=$1 AND source='stripe' AND status IN ('active','trialing') AND product LIKE 'api:%'", [accountId]);
      const pastDue = await all("SELECT product,source_ref FROM entitlements WHERE account_id=$1 AND source='stripe' AND status='past_due' AND product LIKE 'api:%'", [accountId]);
      const tierBySource = new Map(active.map((entry) => [entry.source_ref, entry.product === 'api:pro' ? 'pro' : 'starter']));
      const suspendedBySource = new Map(pastDue.map((entry) => [entry.source_ref, entry.product === 'api:pro' ? 'pro' : 'starter']));
      const aggregateTier = active.some((entry) => entry.product === 'api:pro') ? 'pro' : active.length ? 'starter' : null;
      const aggregateSuspendedTier = pastDue.some((entry) => entry.product === 'api:pro') ? 'pro' : pastDue.length ? 'starter' : null;
      const now = nowIso(), changed = { retiered: 0, suspended: 0, resumed: 0, revoked: 0, claimsUpdated: 0, claimsSuperseded: 0 };
      for (const key of await all('SELECT id,stripe_ref,tier,suspended FROM api_keys WHERE owner_account_id=$1 AND revoked=0 FOR UPDATE', [accountId])) {
        const targetTier = key.stripe_ref ? (tierBySource.get(key.stripe_ref) || null) : aggregateTier;
        const suspendedTier = key.stripe_ref ? (suspendedBySource.get(key.stripe_ref) || null) : aggregateSuspendedTier;
        if (!targetTier && suspendedTier) {
          changed.suspended += (await run('UPDATE api_keys SET tier=$1,suspended=1,updated_at=$2 WHERE id=$3 AND revoked=0', [suspendedTier, now, key.id])).changes;
        } else if (!targetTier) {
          changed.revoked += (await run('UPDATE api_keys SET revoked=1,revoked_at=$1,updated_at=$1 WHERE id=$2 AND revoked=0', [now, key.id])).changes;
        } else if (key.tier !== targetTier || key.suspended) {
          changed.retiered += key.tier !== targetTier ? 1 : 0;
          changed.resumed += key.suspended ? 1 : 0;
          await run('UPDATE api_keys SET tier=$1,suspended=0,updated_at=$2 WHERE id=$3 AND revoked=0', [targetTier, now, key.id]);
        }
      }
      for (const pending of await all('SELECT * FROM pending_keys WHERE account_id=$1 FOR UPDATE', [accountId])) {
        let rawKey;
        try { rawKey = openSecret(pending); } catch { rawKey = null; }
        const key = rawKey ? await one('SELECT id,tier,revoked FROM api_keys WHERE key_hash=$1', [sha256(rawKey)]) : null;
        if (!key || key.revoked) {
          await run('DELETE FROM pending_keys WHERE session_id=$1', [pending.session_id]);
          changed.claimsSuperseded += (await run("UPDATE checkout_claims SET status='superseded',updated_at=$1 WHERE session_id=$2 AND status='claimable'", [now, pending.session_id])).changes;
        } else {
          await run('UPDATE pending_keys SET tier=$1 WHERE session_id=$2', [key.tier, pending.session_id]);
          const plan = key.tier === 'pro' ? 'api_pro' : 'api_starter';
          changed.claimsUpdated += (await run("UPDATE checkout_claims SET tier=$1,plan=$2,updated_at=$3 WHERE session_id=$4 AND status='claimable'", [key.tier, plan, now, pending.session_id])).changes;
        }
      }
      return { ...changed, aggregateTier };
    }); },
    async rotateApiKey(accountId, id, { label = null } = {}) { return transaction(async () => {
      await advisory(`api-keys:${accountId}`);
      const old = await one('SELECT * FROM api_keys WHERE id=$1 AND owner_account_id=$2 AND revoked=0 AND suspended=0 FOR UPDATE', [id, accountId]);
      if (!old) return null;
      const owner = await accountById(accountId);
      const created = await api.createApiKeyRecord(label || old.label, old.tier, {
        ownerEmail: owner?.email || old.owner_email, ownerAccountId: accountId,
        stripeRef: old.stripe_ref, canWriteHistory: Boolean(old.can_write_history),
      });
      const replacement = await one('SELECT * FROM api_keys WHERE key_hash=$1', [sha256(created.key)]), now = nowIso();
      await run('UPDATE api_keys SET revoked=1,revoked_at=$1,updated_at=$1,replaced_by_id=$2 WHERE id=$3', [now, replacement.id, old.id]);
      return { key: created.key, record: (await api.listApiKeys(accountId)).find((row) => row.id === replacement.id) };
    }); },
    async meterUsage(keyId) { return transaction(async () => {
      const day = nowIso().slice(0, 10);
      const key = await one('SELECT id,owner_account_id FROM api_keys WHERE id=$1', [keyId]);
      if (!key) throw new TypeError('unknown API key');
      await run(`INSERT INTO api_usage(key_id,day,count) VALUES($1,$2,1)
        ON CONFLICT(key_id,day) DO UPDATE SET count=api_usage.count+1`, [keyId, day]);
      if (!key.owner_account_id) return int((await one('SELECT count FROM api_usage WHERE key_id=$1 AND day=$2', [keyId, day])).count);
      const row = await one(`INSERT INTO account_api_usage(account_id,day,count) VALUES($1,$2,1)
        ON CONFLICT(account_id,day) DO UPDATE SET count=account_api_usage.count+1 RETURNING count`, [key.owner_account_id, day]);
      return int(row.count);
    }); },

    async createNotificationVerification(accountId, channel = 'email', ttlMs = 24 * 60 * 60_000, { allowResubscribe = false } = {}) { return transaction(async () => {
      await advisory(`notification:${accountId}:${channel}`);
      const existing = await one('SELECT * FROM notification_subscriptions WHERE account_id=$1 AND channel=$2 FOR UPDATE', [accountId, channel]);
      const now = nowIso();
      if (existing?.status === 'active') return { status: 'active', alreadyActive: true, verifyToken: null, unsubscribeToken: null, expiresAt: null };
      if (existing?.status === 'pending' && existing.verify_expires_at > now) return { status: 'pending', alreadyPending: true, verifyToken: null, unsubscribeToken: null, expiresAt: existing.verify_expires_at };
      if (existing && ['bounced', 'complained'].includes(existing.status)) return { status: existing.status, suppressed: true, verifyToken: null, unsubscribeToken: null, expiresAt: null };
      if (existing?.status === 'unsubscribed' && !allowResubscribe) return { status: existing.status, suppressed: true, verifyToken: null, unsubscribeToken: null, expiresAt: null };
      const verifyToken = crypto.randomBytes(32).toString('base64url'), unsubscribeToken = crypto.randomBytes(32).toString('base64url');
      const expiresAt = nowIso(Date.now() + ttlMs);
      await run(`INSERT INTO notification_subscriptions(account_id,channel,status,verify_token_hash,unsubscribe_token_hash,
        verify_expires_at,verified_at,unsubscribed_at,created_at,updated_at) VALUES($1,$2,'pending',$3,$4,$5,NULL,NULL,$6,$6)
        ON CONFLICT(account_id,channel) DO UPDATE SET status=excluded.status,verify_token_hash=excluded.verify_token_hash,
        unsubscribe_token_hash=excluded.unsubscribe_token_hash,verify_expires_at=excluded.verify_expires_at,
        verified_at=NULL,unsubscribed_at=NULL,updated_at=excluded.updated_at`,
      [accountId, channel, sha256(verifyToken), sha256(unsubscribeToken), expiresAt, now]);
      return { status: 'pending', verifyToken, unsubscribeToken, expiresAt };
    }); },
    async verifyNotification(token) { return transaction(async () => {
      if (typeof token !== 'string') return null;
      const now = nowIso();
      const row = await one(`UPDATE notification_subscriptions SET status='active',verify_token_hash=NULL,
        verify_expires_at=NULL,verified_at=$2,unsubscribed_at=NULL,updated_at=$2
        WHERE verify_token_hash=$1 AND status='pending' AND verify_expires_at>$2 RETURNING *`, [sha256(token), now]);
      if (!row) return null;
      const account = await accountById(row.account_id);
      if (account) {
        await advisory(`alerts:${row.account_id}`);
        const limit = await api.alertLimitForAccount(row.account_id);
        const pending = await all("SELECT id FROM alerts WHERE account_id IS NULL AND email=$1 AND status='pending' ORDER BY created_at,id FOR UPDATE", [account.email]);
        for (const alert of pending) {
          let attached = false;
          for (let quotaSlot = 1; quotaSlot <= limit && !attached; quotaSlot += 1) {
            try {
              attached = await transaction(async () => (await run(`UPDATE alerts SET account_id=$1,quota_slot=$2,status='active',updated_at=$3
                WHERE id=$4 AND account_id IS NULL AND status='pending'`, [row.account_id, quotaSlot, now, alert.id])).changes === 1);
            } catch (error) {
              if (error?.code !== '23505') throw error;
            }
          }
        }
      }
      return one('SELECT * FROM notification_subscriptions WHERE account_id=$1 AND channel=$2', [row.account_id, row.channel]);
    }); },
    async unsubscribeNotification(token) { return transaction(async () => {
      if (typeof token !== 'string') return null;
      const tokenHash = sha256(token), now = nowIso();
      let row = await one('SELECT * FROM notification_subscriptions WHERE unsubscribe_token_hash=$1 FOR UPDATE', [tokenHash]);
      if (!row) {
        const issued = await one(`UPDATE notification_unsubscribe_tokens SET used_at=$2 WHERE token_hash=$1
          AND used_at IS NULL AND expires_at>$2 RETURNING *`, [tokenHash, now]);
        if (issued) row = await one('SELECT * FROM notification_subscriptions WHERE account_id=$1 AND channel=$2 FOR UPDATE', [issued.account_id, issued.channel]);
      }
      if (!row) return null;
      await run("UPDATE notification_subscriptions SET status='unsubscribed',unsubscribed_at=$1,updated_at=$1 WHERE account_id=$2 AND channel=$3", [now, row.account_id, row.channel]);
      await run("UPDATE alerts SET status='paused',updated_at=$1 WHERE account_id=$2 AND status='active'", [now, row.account_id]);
      await api.cancelNotificationOutbox(row.account_id);
      return one('SELECT * FROM notification_subscriptions WHERE account_id=$1 AND channel=$2', [row.account_id, row.channel]);
    }); },
    async createNotificationUnsubscribeToken(accountId, channel = 'email', ttlMs = 366 * 86_400_000) {
      if (!await one("SELECT 1 ok FROM notification_subscriptions WHERE account_id=$1 AND channel=$2 AND status='active'", [accountId, channel])) return null;
      const token = crypto.randomBytes(32).toString('base64url'), now = nowIso();
      await run('INSERT INTO notification_unsubscribe_tokens(token_hash,account_id,channel,expires_at,created_at) VALUES($1,$2,$3,$4,$5)',
        [sha256(token), accountId, channel, nowIso(Date.now() + ttlMs), now]);
      return token;
    },
    async getNotification(accountId, channel = 'email') { return one('SELECT * FROM notification_subscriptions WHERE account_id=$1 AND channel=$2', [accountId, channel]); },
    async updateNotificationByProvider(messageId, type) { return transaction(async () => {
      const outbox = await one('SELECT * FROM outbox WHERE provider_message_id=$1', [messageId]);
      if (!outbox?.account_id) return false;
      const now = nowIso();
      if (type === 'bounced') await run("UPDATE notification_subscriptions SET status='bounced',bounced_at=$1,updated_at=$1 WHERE account_id=$2 AND channel='email'", [now, outbox.account_id]);
      if (type === 'complained') await run("UPDATE notification_subscriptions SET status='complained',complaint_at=$1,updated_at=$1 WHERE account_id=$2 AND channel='email'", [now, outbox.account_id]);
      if (type === 'bounced' || type === 'complained') {
        await run('UPDATE accounts SET email_suppressed_at=$1,email_suppression_reason=$2,updated_at=$1 WHERE id=$3 AND deleted_at IS NULL', [now, type, outbox.account_id]);
        await run(`UPDATE outbox SET status='canceled',to_email='',payload_ciphertext='',payload_iv='',payload_tag='',
          metadata_json='{}',leased_until=NULL,lease_token=NULL,last_error=$1,updated_at=$2
          WHERE account_id=$3 AND status IN ('pending','retry','sending')`, [`email ${type}; account mail suppressed`, now, outbox.account_id]);
      }
      return true;
    }); },
    async isNotificationDeliveryAllowed(accountId, template, metadata = {}) {
      const owningAccount = accountId ? await accountById(accountId) : null;
      if (accountId && (!owningAccount || owningAccount.email_suppressed_at)) return false;
      if (!['verify-alerts', 'price-alert', 'weekly-digest'].includes(template)) return !accountId || Boolean(owningAccount);
      const notification = await one("SELECT status FROM notification_subscriptions WHERE account_id=$1 AND channel='email'", [accountId]);
      if (template === 'verify-alerts') return notification?.status === 'pending';
      if (notification?.status !== 'active') return false;
      const prefs = await one('SELECT email_alerts,weekly_digest FROM account_preferences WHERE account_id=$1', [accountId]);
      if (!prefs?.email_alerts) return false;
      if (template === 'weekly-digest') return Boolean(prefs.weekly_digest && await api.isWeeklyDigestEligible(accountId));
      const alertId = Number(metadata?.alertId);
      return Number.isSafeInteger(alertId) && alertId > 0 && await api.isAlertWithinEntitlement(accountId, alertId);
    },
    async cancelNotificationOutbox(accountId, templates = ['verify-alerts', 'price-alert', 'weekly-digest']) {
      if (!accountId || !Array.isArray(templates) || templates.length === 0) return 0;
      return (await run(`UPDATE outbox SET status='canceled',to_email='',payload_ciphertext='',payload_iv='',payload_tag='',
        leased_until=NULL,lease_token=NULL,last_error='notification suppressed before delivery',updated_at=$1,metadata_json='{}'
        WHERE account_id=$2 AND template=ANY($3::text[]) AND status IN ('pending','retry','sending')`, [nowIso(), accountId, templates])).changes;
    },
    async cancelAlertOutbox(accountId, alertId) {
      return (await run(`UPDATE outbox SET status='canceled',to_email='',payload_ciphertext='',payload_iv='',payload_tag='',
        metadata_json='{}',leased_until=NULL,lease_token=NULL,last_error='alert inactive before delivery',updated_at=$1
        WHERE account_id=$2 AND template='price-alert' AND (metadata_json::jsonb->>'alertId')::integer=$3
        AND status IN ('pending','retry','sending')`, [nowIso(), accountId, alertId])).changes;
    },

    async enqueueOutbox({ accountId = null, toEmail, template, ciphertext, iv, tag, metadata = {}, idempotencyKey = null, maxAttempts = 5, availableAt = nowIso() }) {
      const id = randomId('mail'), now = nowIso(), safeMetadata = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};
      const inserted = await one(`INSERT INTO outbox(id,account_id,to_email,template,payload_ciphertext,payload_iv,payload_tag,
        metadata_json,status,attempts,max_attempts,available_at,idempotency_key,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pending',0,$9,$10,$11,$12,$12)
        ON CONFLICT(idempotency_key) DO NOTHING RETURNING *`,
      [id, accountId, toEmail, template, ciphertext, iv, tag, JSON.stringify(safeMetadata), maxAttempts, availableAt, idempotencyKey, now]);
      return inserted || one('SELECT * FROM outbox WHERE idempotency_key=$1', [idempotencyKey]);
    },
    async getOutbox(id) { return one('SELECT * FROM outbox WHERE id=$1', [id]); },
    async cancelOutbox(id, reason = 'delivery suppressed before send') {
      return (await run(`UPDATE outbox SET status='canceled',to_email='',payload_ciphertext='',payload_iv='',payload_tag='',
        metadata_json='{}',leased_until=NULL,lease_token=NULL,last_error=$1,updated_at=$2
        WHERE id=$3 AND status IN ('pending','retry','sending')`, [String(reason).slice(0, 200), nowIso(), id])).changes > 0;
    },
    async claimOutbox(limit = 10, leaseMs = 60_000) { return transaction(async () => {
      const now = nowIso(), lease = nowIso(Date.now() + leaseMs), token = randomId('lease');
      await run(`UPDATE outbox SET status='retry',attempts=0,available_at=$1,leased_until=NULL,lease_token=NULL,
        last_error=COALESCE(last_error,'delivery lease expired; alert retained for redrive'),updated_at=$2
        WHERE template='price-alert' AND status='sending' AND leased_until<$2 AND attempts>=max_attempts`, [nowIso(Date.now() + 6 * 60 * 60_000), now]);
      await run(`UPDATE outbox SET status='failed',leased_until=NULL,lease_token=NULL,
        last_error=COALESCE(last_error,'delivery lease expired after maximum attempts'),updated_at=$1
        WHERE template!='price-alert' AND status='sending' AND leased_until<$1 AND attempts>=max_attempts`, [now]);
      return all(`WITH candidates AS (
          SELECT id FROM outbox WHERE attempts<max_attempts AND ((status IN ('pending','retry') AND available_at<=$1)
            OR (status='sending' AND leased_until IS NOT NULL AND leased_until<$1))
          ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $2)
        UPDATE outbox o SET status='sending',leased_until=$3,lease_token=$4,attempts=o.attempts+1,updated_at=$1
        FROM candidates c WHERE o.id=c.id RETURNING o.*`, [now, Math.max(1, limit), lease, token]);
    }); },
    async markOutboxSent(id, providerMessageId = null, leaseToken = null) {
      if (!leaseToken) return false;
      const now = nowIso();
      const changed = (await run(`UPDATE outbox SET status='sent',provider_message_id=$1,sent_at=$2,leased_until=NULL,
        lease_token=NULL,last_error=NULL,updated_at=$2 WHERE id=$3 AND status='sending' AND lease_token=$4`, [providerMessageId, now, id, leaseToken])).changes > 0;
      if (changed && providerMessageId) await api.reconcileDeliverySuppression(providerMessageId);
      return changed;
    },
    async markOutboxFailed(id, error, leaseToken = null) {
      if (!leaseToken) return false;
      const item = await one("SELECT * FROM outbox WHERE id=$1 AND status='sending' AND lease_token=$2", [id, leaseToken]);
      if (!item) return false;
      const terminal = item.attempts >= item.max_attempts, status = terminal ? 'failed' : 'retry';
      const delay = Math.min(3_600_000, 1000 * (2 ** Math.max(0, item.attempts)));
      return (await run(`UPDATE outbox SET status=$1,available_at=$2,leased_until=NULL,lease_token=NULL,last_error=$3,updated_at=$4
        WHERE id=$5 AND status='sending' AND lease_token=$6`, [status, nowIso(Date.now() + delay), String(error || 'delivery failed').slice(0, 500), nowIso(), id, leaseToken])).changes > 0;
    },
    async failOutboxTerminal(id, error, leaseToken = null) {
      if (!leaseToken) return false;
      return (await run(`UPDATE outbox SET status='failed',leased_until=NULL,lease_token=NULL,last_error=$1,updated_at=$2
        WHERE id=$3 AND status='sending' AND lease_token=$4`, [String(error || 'non-retryable delivery failure').slice(0, 500), nowIso(), id, leaseToken])).changes > 0;
    },
    async redriveAlertOutbox(id, error, delayMs = 6 * 60 * 60_000, leaseToken = null) {
      if (typeof delayMs === 'string' && leaseToken === null) {
        leaseToken = delayMs;
        delayMs = 6 * 60 * 60_000;
      }
      if (!leaseToken) return false;
      const delay = Math.min(24 * 60 * 60_000, Math.max(60_000, Number(delayMs) || 0));
      return (await run(`UPDATE outbox SET status='retry',attempts=0,available_at=$1,leased_until=NULL,lease_token=NULL,
        last_error=$2,updated_at=$3 WHERE id=$4 AND template='price-alert' AND status='sending' AND lease_token=$5`,
      [nowIso(Date.now() + delay), String(error || 'delivery failed; alert retained for redrive').slice(0, 500), nowIso(), id, leaseToken])).changes > 0;
    },
    async recordDeliveryEvent({ outboxId = null, provider, providerEventId = null, providerMessageId = null, type, payload = {}, occurredAt = nowIso() }) {
      return Boolean(await one(`INSERT INTO delivery_events(id,outbox_id,provider,provider_event_id,provider_message_id,type,payload_json,occurred_at,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(provider_event_id) DO NOTHING RETURNING id`,
      [randomId('delivery'), outboxId, provider, providerEventId, providerMessageId, type, JSON.stringify(payload), occurredAt, nowIso()]));
    },
    async reconcileDeliverySuppression(providerMessageId) {
      const event = await one("SELECT type FROM delivery_events WHERE provider_message_id=$1 AND type IN ('bounced','complained') ORDER BY occurred_at DESC LIMIT 1", [providerMessageId]);
      return event ? api.updateNotificationByProvider(providerMessageId, event.type) : false;
    },

    async enqueueJob(type, payload, { idempotencyKey = null, maxAttempts = 5, availableAt = nowIso() } = {}) {
      const id = randomId('job'), now = nowIso();
      const inserted = await one(`INSERT INTO jobs(id,type,payload_json,status,attempts,max_attempts,available_at,idempotency_key,created_at,updated_at)
        VALUES($1,$2,$3,'pending',0,$4,$5,$6,$7,$7) ON CONFLICT(idempotency_key) DO NOTHING RETURNING *`,
      [id, type, JSON.stringify(payload), maxAttempts, availableAt, idempotencyKey, now]);
      return inserted || one('SELECT * FROM jobs WHERE idempotency_key=$1', [idempotencyKey]);
    },
    async claimJobs(limit = 10, leaseMs = 60_000) { return transaction(async () => {
      const now = nowIso(), lease = nowIso(Date.now() + leaseMs), token = randomId('lease');
      await run(`UPDATE jobs SET status='failed',leased_until=NULL,lease_token=NULL,
        last_error=COALESCE(last_error,'job lease expired after maximum attempts'),updated_at=$1
        WHERE status='running' AND leased_until<$1 AND attempts>=max_attempts`, [now]);
      return all(`WITH candidates AS (
          SELECT id FROM jobs WHERE attempts<max_attempts AND ((status IN ('pending','retry') AND available_at<=$1)
            OR (status='running' AND leased_until IS NOT NULL AND leased_until<$1))
          ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $2)
        UPDATE jobs j SET status='running',leased_until=$3,lease_token=$4,attempts=j.attempts+1,updated_at=$1
        FROM candidates c WHERE j.id=c.id RETURNING j.*`, [now, Math.max(1, limit), lease, token]);
    }); },
    async completeJob(id, leaseToken = null) {
      if (!leaseToken) return false;
      const now = nowIso();
      return (await run(`UPDATE jobs SET status='completed',completed_at=$1,leased_until=NULL,lease_token=NULL,
        last_error=NULL,updated_at=$1 WHERE id=$2 AND status='running' AND lease_token=$3`, [now, id, leaseToken])).changes > 0;
    },
    async failJob(id, error, leaseToken = null) {
      if (!leaseToken) return false;
      const item = await one("SELECT * FROM jobs WHERE id=$1 AND status='running' AND lease_token=$2", [id, leaseToken]);
      if (!item) return false;
      const terminal = item.attempts >= item.max_attempts, status = terminal ? 'failed' : 'retry';
      const delay = Math.min(3_600_000, 1000 * (2 ** Math.max(0, item.attempts)));
      return (await run(`UPDATE jobs SET status=$1,available_at=$2,leased_until=NULL,lease_token=NULL,last_error=$3,updated_at=$4
        WHERE id=$5 AND status='running' AND lease_token=$6`, [status, nowIso(Date.now() + delay), String(error || 'job failed').slice(0, 500), nowIso(), id, leaseToken])).changes > 0;
    },

    async recordBillingEvent({ type, email = null, accountId = null, plan = null, amount_cents = 0, currency = 'usd', livemode = 0, stripe_ref = null, payload = {} }) {
      const inserted = await one(`INSERT INTO billing_events(ts,type,email,account_id,plan,amount_cents,currency,livemode,stripe_ref,status,payload_json)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'applied',$10) ON CONFLICT(stripe_ref) DO NOTHING RETURNING id`,
      [nowIso(), type, email, accountId, plan, amount_cents, currency, livemode ? 1 : 0, stripe_ref, JSON.stringify(payload)]);
      return Boolean(inserted);
    },
    async hasRecognizedInvoicePayment(invoiceId) {
      return Boolean(await one(`SELECT 1 ok FROM billing_events WHERE amount_cents>0
        AND type IN ('invoice.paid','invoice.payment_succeeded')
        AND payload_json::jsonb->>'objectId'=$1 LIMIT 1`, [invoiceId]));
    },
    async refundedTotalForCharge(chargeId) {
      const row = await one(`SELECT COALESCE(MAX(CASE WHEN (payload_json::jsonb->>'cumulativeRefunded') ~ '^[0-9]+$'
        THEN (payload_json::jsonb->>'cumulativeRefunded')::bigint ELSE 0 END),0) total
        FROM billing_events WHERE type='charge.refunded' AND payload_json::jsonb->>'objectId'=$1`, [chargeId]);
      return int(row?.total);
    },
    async billingObjectAmount(objectId, types = []) {
      if (!Array.isArray(types) || types.length === 0) return 0;
      return int((await one(`SELECT COALESCE(SUM(amount_cents),0) total FROM billing_events
        WHERE type=ANY($1::text[]) AND payload_json::jsonb->>'objectId'=$2`, [types, objectId]))?.total);
    },
    async latestBillingObjectEvent(objectId, types = []) {
      if (!Array.isArray(types) || types.length === 0) return null;
      const row = await one(`SELECT type,payload_json FROM billing_events WHERE type=ANY($1::text[])
        AND payload_json::jsonb->>'objectId'=$2
        ORDER BY CASE WHEN (payload_json::jsonb->>'eventCreated') ~ '^[0-9]+$'
          THEN (payload_json::jsonb->>'eventCreated')::bigint ELSE -1 END DESC,
          CASE WHEN type='charge.dispute.closed' THEN 3 WHEN type='charge.dispute.updated' THEN 2 ELSE 1 END DESC,
          id DESC LIMIT 1`, [types, objectId]);
      return row ? { type: row.type, payload: parseJson(row.payload_json) } : null;
    },
    async recordBillingReconciliation({ eventId, eventType, reason, payload = {} }) {
      const now = nowIso();
      await run(`INSERT INTO billing_reconciliation(event_id,event_type,reason,payload_json,status,attempts,created_at,updated_at)
        VALUES($1,$2,$3,$4,'pending',1,$5,$5) ON CONFLICT(event_id) DO UPDATE SET reason=excluded.reason,
        payload_json=excluded.payload_json,status='pending',resolved_at=NULL,
        attempts=billing_reconciliation.attempts+1,updated_at=excluded.updated_at`,
      [eventId, eventType, String(reason || 'unmapped billing event').slice(0, 500), JSON.stringify(payload), now]);
      return one('SELECT * FROM billing_reconciliation WHERE event_id=$1', [eventId]);
    },
    async resolveBillingReconciliation(eventId) {
      const now = nowIso();
      return (await run("UPDATE billing_reconciliation SET status='resolved',resolved_at=$1,updated_at=$1 WHERE event_id=$2 AND status='pending'", [now, eventId])).changes > 0;
    },
    async billingReconciliationMetrics() {
      const row = await one("SELECT COUNT(*)::integer pending,MIN(created_at) oldest FROM billing_reconciliation WHERE status='pending'");
      const pending = int(row?.pending);
      return { ok: pending === 0, pending, oldestPendingAt: row?.oldest || null };
    },
    async listPendingBillingReconciliation(accountId, customerId = null) {
      return all(`SELECT event_id,event_type,reason,created_at,updated_at FROM billing_reconciliation
        WHERE status='pending' AND (payload_json::jsonb->>'accountId'=$1
          OR ($2::text IS NOT NULL AND payload_json::jsonb->>'customer'=$2)) ORDER BY created_at`, [accountId, customerId]);
    },

    async upsertEntitlement({ accountId, product, status = 'active', source = 'stripe', sourceRef, currentPeriodEnd = null, cancelAtPeriodEnd = false, metadata = {}, eventCreated = null }) {
      return transaction(async () => {
        await advisory(`entitlement:${source}:${sourceRef}`);
        const sequence = Number.isInteger(eventCreated) && eventCreated >= 0 ? eventCreated : null;
        const existing = await one('SELECT * FROM entitlements WHERE source=$1 AND source_ref=$2 AND product=$3 FOR UPDATE', [source, sourceRef, product]);
        const sourceState = source === 'stripe'
          ? await one('SELECT * FROM billing_source_state WHERE account_id=$1 AND source_ref=$2 FOR UPDATE', [accountId, sourceRef])
          : null;
        const terminal = new Set(['canceled', 'unpaid', 'past_due', 'paused', 'incomplete', 'incomplete_expired', 'inactive']);
        for (const previous of [sourceState, existing]) {
          if (!previous || sequence === null || previous.provider_event_created === null) continue;
          const oldSequence = Number(previous.provider_event_created);
          if (sequence < oldSequence || (sequence === oldSequence && terminal.has(previous.status) && ['active', 'trialing'].includes(status))) {
            return { ...(existing || {}), applied: false, stale: true, status: existing?.status || sourceState?.status };
          }
        }
        const now = nowIso();
        await run(`INSERT INTO entitlements(id,account_id,product,status,source,source_ref,current_period_end,cancel_at_period_end,
          metadata_json,provider_event_created,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)
          ON CONFLICT(source,source_ref,product) DO UPDATE SET account_id=excluded.account_id,status=excluded.status,
          current_period_end=excluded.current_period_end,cancel_at_period_end=excluded.cancel_at_period_end,
          metadata_json=excluded.metadata_json,
          provider_event_created=COALESCE(excluded.provider_event_created,entitlements.provider_event_created),updated_at=excluded.updated_at`,
        [randomId('ent'), accountId, product, status, source, sourceRef, currentPeriodEnd, cancelAtPeriodEnd ? 1 : 0,
          JSON.stringify(metadata), sequence, now]);
        if (source === 'stripe') {
          await run(`INSERT INTO billing_source_state(account_id,source_ref,status,provider_event_created,updated_at)
            VALUES($1,$2,$3,$4,$5) ON CONFLICT(account_id,source_ref) DO UPDATE SET status=excluded.status,
            provider_event_created=COALESCE(excluded.provider_event_created,billing_source_state.provider_event_created),
            updated_at=excluded.updated_at`, [accountId, sourceRef, status, sequence, now]);
        }
        const row = await one('SELECT * FROM entitlements WHERE source=$1 AND source_ref=$2 AND product=$3', [source, sourceRef, product]);
        return { ...row, applied: true, stale: false };
      });
    },
    async listEntitlements(accountId) {
      return (await all('SELECT * FROM entitlements WHERE account_id=$1 ORDER BY created_at DESC', [accountId]))
        .map((row) => ({ ...row, cancel_at_period_end: Boolean(row.cancel_at_period_end), metadata: parseJson(row.metadata_json) }));
    },
    async getEntitlementBySource(accountId, sourceRef, product) {
      const row = await one("SELECT * FROM entitlements WHERE account_id=$1 AND source='stripe' AND source_ref=$2 AND product=$3", [accountId, sourceRef, product]);
      return row ? { ...row, cancel_at_period_end: Boolean(row.cancel_at_period_end), metadata: parseJson(row.metadata_json) } : null;
    },
    async hasActiveEntitlement(accountId, product) {
      return Boolean(await one("SELECT 1 ok FROM entitlements WHERE account_id=$1 AND product=$2 AND status IN ('active','trialing') LIMIT 1", [accountId, product]));
    },
    async hasActiveApiEntitlement(accountId) {
      return Boolean(await one("SELECT 1 ok FROM entitlements WHERE account_id=$1 AND product LIKE 'api:%' AND status IN ('active','trialing') LIMIT 1", [accountId]));
    },
    async isStaleEntitlementEvent(accountId, sourceRef, eventCreated) {
      if (!Number.isInteger(eventCreated) || eventCreated < 0) return false;
      const row = await one(`SELECT GREATEST(
        COALESCE((SELECT MAX(provider_event_created) FROM entitlements WHERE account_id=$1 AND source='stripe' AND source_ref=$2),-1),
        COALESCE((SELECT provider_event_created FROM billing_source_state WHERE account_id=$1 AND source_ref=$2),-1)) latest`, [accountId, sourceRef]);
      return Number(row?.latest ?? -1) > eventCreated;
    },
    async listActivePaidEntitlements(accountId) {
      return (await all(`SELECT product,status,source_ref,current_period_end,cancel_at_period_end FROM entitlements
        WHERE account_id=$1 AND source='stripe' AND status IN ('active','trialing','past_due','unpaid','paused','incomplete')
        ORDER BY product`, [accountId])).map((row) => ({ ...row, cancel_at_period_end: Boolean(row.cancel_at_period_end) }));
    },
    async syncAccountPlan(accountId) {
      return transaction(async () => {
        await advisory(`account-plan:${accountId}`);
        const account = await accountById(accountId);
        if (!account) return null;
        const premium = await api.hasActiveEntitlement(accountId, 'premium');
        const hasApi = await api.hasActiveApiEntitlement(accountId);
        const plan = premium ? 'premium' : hasApi ? 'api' : 'free';
        await run('UPDATE accounts SET plan=$1,updated_at=$2 WHERE id=$3', [plan, nowIso(), accountId]);
        await api.reconcileAlertEntitlements(accountId);
        return accountById(accountId);
      });
    },
    async reconcileAlertEntitlements(accountId) {
      return transaction(async () => {
        await advisory(`alerts:${accountId}`);
        await one('SELECT id FROM accounts WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [accountId]);
        const account = await accountById(accountId);
        if (!account) return null;
        const premium = await api.hasActiveEntitlement(accountId, 'premium');
        const limit = premium ? PREMIUM_ALERT_LIMIT : FREE_ALERT_LIMIT;
        const active = await all("SELECT id FROM alerts WHERE account_id=$1 AND status='active' ORDER BY created_at,id FOR UPDATE", [accountId]);
        const paused = active.slice(limit).map((row) => int(row.id));
        const now = nowIso();
        for (const alertId of paused) {
          await run("UPDATE alerts SET status='paused',condition_active=0,updated_at=$1 WHERE id=$2 AND account_id=$3 AND status='active'", [now, alertId, accountId]);
          await api.cancelAlertOutbox(accountId, alertId);
        }
        if (!premium) await api.cancelNotificationOutbox(accountId, ['weekly-digest']);
        return { limit, activeBefore: active.length, activeAfter: active.length - paused.length, paused };
      });
    },
    async retireOtherEntitlements(accountId, sourceRef, keepProduct, eventCreated = null) {
      return transaction(async () => {
        await advisory(`entitlement:stripe:${sourceRef}`);
        const sequence = Number.isInteger(eventCreated) && eventCreated >= 0 ? eventCreated : null;
        const rows = await all("SELECT product,provider_event_created FROM entitlements WHERE account_id=$1 AND source='stripe' AND source_ref=$2 AND product!=$3 FOR UPDATE", [accountId, sourceRef, keepProduct]);
        const retired = [];
        for (const row of rows) {
          if (sequence !== null && row.provider_event_created !== null && sequence < Number(row.provider_event_created)) continue;
          await run(`UPDATE entitlements SET status='canceled',provider_event_created=COALESCE($1,provider_event_created),updated_at=$2
            WHERE account_id=$3 AND source='stripe' AND source_ref=$4 AND product=$5`, [sequence, nowIso(), accountId, sourceRef, row.product]);
          retired.push(row.product);
        }
        return retired;
      });
    },
    async deactivateEntitlementsBySource(accountId, sourceRef, status = 'inactive', eventCreated = null) {
      return transaction(async () => {
        const sourceState = await api.recordBillingSourceState(accountId, sourceRef, status, eventCreated);
        if (!sourceState.applied) return [];
        const sequence = Number.isInteger(eventCreated) && eventCreated >= 0 ? eventCreated : null;
        const rows = await all("SELECT product,provider_event_created FROM entitlements WHERE account_id=$1 AND source='stripe' AND source_ref=$2 FOR UPDATE", [accountId, sourceRef]);
        const deactivated = [];
        for (const row of rows) {
          if (sequence !== null && row.provider_event_created !== null && sequence < Number(row.provider_event_created)) continue;
          await run(`UPDATE entitlements SET status=$1,provider_event_created=COALESCE($2,provider_event_created),updated_at=$3
            WHERE account_id=$4 AND source='stripe' AND source_ref=$5 AND product=$6`, [status, sequence, nowIso(), accountId, sourceRef, row.product]);
          deactivated.push(row.product);
        }
        return deactivated;
      });
    },
    async recordBillingSourceState(accountId, sourceRef, status, eventCreated = null) {
      return transaction(async () => {
        await advisory(`entitlement:stripe:${sourceRef}`);
        const sequence = Number.isInteger(eventCreated) && eventCreated >= 0 ? eventCreated : null;
        const existing = await one('SELECT * FROM billing_source_state WHERE account_id=$1 AND source_ref=$2 FOR UPDATE', [accountId, sourceRef]);
        const terminal = new Set(['canceled', 'unpaid', 'past_due', 'paused', 'incomplete', 'incomplete_expired', 'inactive']);
        if (existing && sequence !== null && existing.provider_event_created !== null) {
          const oldSequence = Number(existing.provider_event_created);
          if (sequence < oldSequence || (sequence === oldSequence && terminal.has(existing.status) && ['active', 'trialing'].includes(status))) {
            return { ...existing, applied: false, stale: true };
          }
        }
        const now = nowIso();
        await run(`INSERT INTO billing_source_state(account_id,source_ref,status,provider_event_created,updated_at)
          VALUES($1,$2,$3,$4,$5) ON CONFLICT(account_id,source_ref) DO UPDATE SET status=excluded.status,
          provider_event_created=COALESCE(excluded.provider_event_created,billing_source_state.provider_event_created),updated_at=excluded.updated_at`,
        [accountId, sourceRef, status, sequence, now]);
        return { ...(await one('SELECT * FROM billing_source_state WHERE account_id=$1 AND source_ref=$2', [accountId, sourceRef])), applied: true, stale: false };
      });
    },

    async confirmAlertDelivery(alertId, triggerKey, at = nowIso()) {
      if (!Number.isSafeInteger(Number(alertId)) || typeof triggerKey !== 'string' || !triggerKey) return false;
      return (await run(`UPDATE alerts SET last_notified_at=$1,last_delivered_trigger_key=$2,updated_at=$1
        WHERE id=$3 AND status='active' AND condition_active=1 AND last_trigger_key=$2`, [at, triggerKey, Number(alertId)])).changes > 0;
    },
    async releaseAlertTrigger(alertId, triggerKey, at = nowIso()) {
      if (!Number.isSafeInteger(Number(alertId)) || typeof triggerKey !== 'string' || !triggerKey) return false;
      return (await run(`UPDATE alerts SET condition_active=0,last_trigger_key=NULL,updated_at=$1
        WHERE id=$2 AND condition_active=1 AND last_trigger_key=$3
        AND (last_delivered_trigger_key IS NULL OR last_delivered_trigger_key!=last_trigger_key)`, [at, Number(alertId), triggerKey])).changes > 0;
    },
    async recordAlertTrigger(alertId, triggerKey, at = nowIso()) {
      return (await run('UPDATE alerts SET last_trigger_key=$1,updated_at=$2 WHERE id=$3 AND (last_trigger_key IS NULL OR last_trigger_key!=$1)', [triggerKey, at, alertId])).changes > 0;
    },
    async evaluateAlertCondition(alertId, trueCents, triggerKey, at = nowIso()) {
      return transaction(async () => {
        await advisory(`alert-evaluation:${alertId}`);
        const alert = await one("SELECT id,account_id,threshold_cents,condition_active,status,last_trigger_key,last_delivered_trigger_key FROM alerts WHERE id=$1 AND status='active' FOR UPDATE", [alertId]);
        if (!alert) return { notify: false, reason: 'inactive' };
        if (!await api.isAlertWithinEntitlement(alert.account_id, alert.id)) return { notify: false, reason: 'not-entitled' };
        if (trueCents > alert.threshold_cents) {
          await api.cancelAlertOutbox(alert.account_id, alert.id);
          await run('UPDATE alerts SET condition_active=0,last_trigger_key=NULL,last_evaluated_cents=$1,updated_at=$2 WHERE id=$3', [trueCents, at, alertId]);
          return { notify: false, reason: 'above-threshold' };
        }
        if (alert.condition_active) {
          const awaitingDelivery = alert.last_trigger_key && alert.last_delivered_trigger_key !== alert.last_trigger_key;
          if (awaitingDelivery && alert.last_trigger_key !== triggerKey) {
            await api.cancelAlertOutbox(alert.account_id, alert.id);
            const changed = (await run(`UPDATE alerts SET last_evaluated_cents=$1,last_trigger_key=$2,updated_at=$3
              WHERE id=$4 AND status='active' AND condition_active=1 AND last_trigger_key=$5`,
            [trueCents, triggerKey, at, alertId, alert.last_trigger_key])).changes;
            return { notify: changed === 1, reason: changed === 1 ? 'retargeted-pending-crossing' : 'raced' };
          }
          await run('UPDATE alerts SET last_evaluated_cents=$1,updated_at=$2 WHERE id=$3', [trueCents, at, alertId]);
          return { notify: false, reason: awaitingDelivery ? 'delivery-pending' : 'already-below' };
        }
        const changed = (await run(`UPDATE alerts SET condition_active=1,last_evaluated_cents=$1,last_trigger_key=$2,updated_at=$3
          WHERE id=$4 AND status='active' AND condition_active=0`, [trueCents, triggerKey, at, alertId])).changes;
        return { notify: changed === 1, reason: changed === 1 ? 'crossed-below' : 'raced' };
      });
    },
    async listEvaluableAlerts(productId) {
      const rows = await all(`SELECT a.*,ac.email account_email,pref.timezone FROM alerts a
        JOIN accounts ac ON ac.id=a.account_id JOIN account_preferences pref ON pref.account_id=a.account_id
        JOIN notification_subscriptions n ON n.account_id=a.account_id AND n.channel='email'
        WHERE a.product_id=$1 AND a.status='active' AND ac.deleted_at IS NULL AND pref.email_alerts=1 AND n.status='active'`, [productId]);
      const allowed = await Promise.all(rows.map((row) => api.isAlertWithinEntitlement(row.account_id, row.id)));
      return rows.filter((_, index) => allowed[index]);
    },
    async listDeliverableAlerts(productId, trueCents) {
      const rows = await all(`SELECT a.*,ac.email account_email,pref.timezone FROM alerts a
        JOIN accounts ac ON ac.id=a.account_id JOIN account_preferences pref ON pref.account_id=a.account_id
        JOIN notification_subscriptions n ON n.account_id=a.account_id AND n.channel='email'
        WHERE a.product_id=$1 AND a.status='active' AND a.threshold_cents>=$2
          AND ac.deleted_at IS NULL AND pref.email_alerts=1 AND n.status='active'`, [productId, trueCents]);
      const allowed = await Promise.all(rows.map((row) => api.isAlertWithinEntitlement(row.account_id, row.id)));
      return rows.filter((_, index) => allowed[index]);
    },
    async createAlertUnsubscribeToken(accountId, alertId, ttlMs = 366 * 86_400_000) {
      if (!await one("SELECT id FROM alerts WHERE id=$1 AND account_id=$2 AND status!='deleted'", [alertId, accountId])) return null;
      const token = crypto.randomBytes(32).toString('base64url'), now = nowIso();
      await run('INSERT INTO alert_unsubscribe_tokens(token_hash,alert_id,account_id,expires_at,created_at) VALUES($1,$2,$3,$4,$5)',
        [sha256(token), alertId, accountId, nowIso(Date.now() + ttlMs), now]);
      return token;
    },
    async unsubscribeAlert(token) {
      return transaction(async () => {
        if (typeof token !== 'string') return null;
        const tokenHash = sha256(token), now = nowIso();
        let row = await one("SELECT * FROM alerts WHERE unsubscribe_token_hash=$1 AND status!='deleted' FOR UPDATE", [tokenHash]);
        if (!row) {
          const issued = await one(`UPDATE alert_unsubscribe_tokens SET used_at=$2 WHERE token_hash=$1
            AND used_at IS NULL AND expires_at>$2 RETURNING *`, [tokenHash, now]);
          if (issued) row = await one("SELECT * FROM alerts WHERE id=$1 AND account_id=$2 AND status!='deleted' FOR UPDATE", [issued.alert_id, issued.account_id]);
        }
        if (!row) return null;
        await run("UPDATE alerts SET status='paused',condition_active=0,unsubscribe_token_hash=NULL,updated_at=$1 WHERE id=$2", [now, row.id]);
        await api.cancelAlertOutbox(row.account_id, row.id);
        return one('SELECT * FROM alerts WHERE id=$1', [row.id]);
      });
    },

    async putPendingKey(sessionId, rawKey, tier, accountId = null) {
      const sealed = sealSecret(rawKey), now = nowIso();
      await run(`INSERT INTO pending_keys(session_id,raw_key,tier,account_id,key_iv,key_tag,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(session_id) DO UPDATE SET raw_key=excluded.raw_key,tier=excluded.tier,
        account_id=excluded.account_id,key_iv=excluded.key_iv,key_tag=excluded.key_tag,created_at=excluded.created_at`,
      [sessionId, sealed.ciphertext, tier, accountId, sealed.iv, sealed.tag, now]);
    },
    async registerCheckoutClaim({ sessionId, accountId = null, plan, tier = null, status = tier ? 'claimable' : 'complete' }) {
      const now = nowIso();
      await run(`INSERT INTO checkout_claims(session_id,account_id,plan,tier,status,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$6) ON CONFLICT(session_id) DO UPDATE SET account_id=excluded.account_id,
        plan=excluded.plan,tier=excluded.tier,status=CASE WHEN checkout_claims.status='claimed'
          THEN checkout_claims.status ELSE excluded.status END,updated_at=excluded.updated_at`,
      [sessionId, accountId, plan, tier, status, now]);
      return api.getCheckoutClaim(sessionId, accountId === null ? undefined : accountId);
    },
    async getCheckoutClaim(sessionId, accountId = undefined) {
      const row = await one('SELECT * FROM checkout_claims WHERE session_id=$1', [sessionId]);
      if (!row || (accountId !== undefined && row.account_id !== accountId)) return null;
      return row;
    },
    async takePendingKey(sessionId, accountId = undefined) {
      return transaction(async () => {
        const row = accountId === undefined
          ? await one('DELETE FROM pending_keys WHERE session_id=$1 RETURNING raw_key,tier,account_id,key_iv,key_tag', [sessionId])
          : await one('DELETE FROM pending_keys WHERE session_id=$1 AND account_id=$2 RETURNING raw_key,tier,account_id,key_iv,key_tag', [sessionId, accountId]);
        if (!row) return null;
        const now = nowIso();
        await run("UPDATE checkout_claims SET status='claimed',claimed_at=$1,updated_at=$1 WHERE session_id=$2 AND status='claimable'", [now, sessionId]);
        return { raw_key: openSecret(row), tier: row.tier, account_id: row.account_id };
      });
    },
    async prunePendingKeys(ttlMs = 86_400_000) {
      return (await run('DELETE FROM pending_keys WHERE created_at<$1', [nowIso(Date.now() - ttlMs)])).changes;
    },
    async reserveCheckoutIntent(accountId, plan, options = {}) {
      return transaction(async () => {
        // The account-wide lock is deliberate: two different plan ids must not
        // both pass the pending-check on separate warm Function instances and
        // create independent Stripe sessions for the same customer.
        await advisory(`checkout-intent:${accountId}`);
        const { ttlMs = 30 * 60_000, termsVersion = null } = typeof options === 'number' ? { ttlMs: options } : options;
        const now = nowIso(), cutoff = nowIso(Date.now() - ttlMs);
        await run(`UPDATE checkout_intents SET status='expired',updated_at=$1 WHERE account_id=$2
          AND status='pending' AND stripe_session_id IS NULL AND created_at<$3`, [now, accountId, cutoff]);
        let intent = await one(`SELECT * FROM checkout_intents WHERE account_id=$1
          AND status IN ('pending','awaiting_payment') ORDER BY created_at,id LIMIT 1 FOR UPDATE`, [accountId]);
        if (intent) {
          if (intent.plan !== plan) {
            const error = new Error('another checkout is already pending; finish or let it expire before choosing a different plan');
            error.status = 409;
            error.code = 'CHECKOUT_PENDING';
            error.details = { pendingPlans: [intent.plan] };
            throw error;
          }
          if (termsVersion && intent.terms_version !== termsVersion) {
            await run('UPDATE checkout_intents SET terms_version=$1,updated_at=$2 WHERE id=$3', [termsVersion, now, intent.id]);
            intent = await one('SELECT * FROM checkout_intents WHERE id=$1', [intent.id]);
          }
          return { ...intent, created: false };
        }
        const id = randomId('checkout'), idempotencyKey = `pricetruth-${crypto.randomBytes(24).toString('base64url')}`;
        const inserted = await one(`INSERT INTO checkout_intents(id,account_id,plan,idempotency_key,terms_version,status,created_at,updated_at)
          VALUES($1,$2,$3,$4,$5,'pending',$6,$6) ON CONFLICT DO NOTHING RETURNING *`,
        [id, accountId, plan, idempotencyKey, termsVersion, now]);
        if (inserted) return { ...inserted, created: true };
        intent = await one(`SELECT * FROM checkout_intents WHERE account_id=$1
          AND status IN ('pending','awaiting_payment') ORDER BY created_at,id LIMIT 1`, [accountId]);
        if (!intent) throw new Error('checkout intent conflict did not resolve');
        if (intent.plan !== plan) {
          const error = new Error('another checkout is already pending; finish or let it expire before choosing a different plan');
          error.status = 409;
          error.code = 'CHECKOUT_PENDING';
          error.details = { pendingPlans: [intent.plan] };
          throw error;
        }
        if (termsVersion && intent.terms_version !== termsVersion) {
          intent = await one('UPDATE checkout_intents SET terms_version=$1,updated_at=$2 WHERE id=$3 RETURNING *', [termsVersion, now, intent.id]);
        }
        return { ...intent, created: false };
      });
    },
    async updateCheckoutIntent(intentId, { sessionId = null, url = null, status = 'pending', expiresAt = null, paymentStatus = null } = {}) {
      await run(`UPDATE checkout_intents SET stripe_session_id=COALESCE($1,stripe_session_id),checkout_url=COALESCE($2,checkout_url),
        expires_at=COALESCE($3,expires_at),payment_status=COALESCE($4,payment_status),status=$5,updated_at=$6 WHERE id=$7`,
      [sessionId, url, expiresAt, paymentStatus, status, nowIso(), intentId]);
      return one('SELECT * FROM checkout_intents WHERE id=$1', [intentId]);
    },
    async getCheckoutIntentBySession(accountId, sessionId) {
      return one('SELECT * FROM checkout_intents WHERE account_id=$1 AND stripe_session_id=$2', [accountId, sessionId]);
    },
    async completeCheckoutIntent(accountId, plan, sessionId) {
      const now = nowIso();
      return (await run(`UPDATE checkout_intents SET stripe_session_id=COALESCE(stripe_session_id,$1),status='completed',
        payment_status='paid',updated_at=$2 WHERE account_id=$3 AND plan=$4 AND status IN ('pending','awaiting_payment')`,
      [sessionId, now, accountId, plan])).changes;
    },
    async terminalCheckoutIntent(accountId, sessionId, status, paymentStatus = null, expiresAt = null) {
      if (!['pending', 'awaiting_payment', 'expired', 'failed'].includes(status)) return false;
      return (await run(`UPDATE checkout_intents SET status=$1,payment_status=COALESCE($2,payment_status),
        expires_at=COALESCE($3,expires_at),updated_at=$4 WHERE account_id=$5 AND stripe_session_id=$6`,
      [status, paymentStatus, expiresAt, nowIso(), accountId, sessionId])).changes > 0;
    },
    async listPendingCheckoutIntents(accountId, ttlMs = 30 * 60_000) {
      const now = nowIso(), cutoff = nowIso(Date.now() - ttlMs);
      await run(`UPDATE checkout_intents SET status='expired',updated_at=$1 WHERE account_id=$2 AND status='pending'
        AND stripe_session_id IS NULL AND created_at<$3`, [now, accountId, cutoff]);
      return all(`SELECT id,plan,stripe_session_id,created_at,expires_at,payment_status FROM checkout_intents
        WHERE account_id=$1 AND status IN ('pending','awaiting_payment') ORDER BY created_at`, [accountId]);
    },
    async listWeeklyDigestRecipients() {
      return all(`SELECT a.id,a.email,p.timezone FROM accounts a
        JOIN account_preferences p ON p.account_id=a.id
        JOIN notification_subscriptions n ON n.account_id=a.id AND n.channel='email' AND n.status='active'
        WHERE a.deleted_at IS NULL AND p.email_alerts=1 AND p.weekly_digest=1
        AND EXISTS(SELECT 1 FROM entitlements e WHERE e.account_id=a.id AND e.product='premium'
          AND e.status IN ('active','trialing'))`);
    },
    async isWeeklyDigestEligible(accountId) {
      return Boolean(await one(`SELECT 1 ok FROM accounts a
        JOIN account_preferences p ON p.account_id=a.id
        JOIN notification_subscriptions n ON n.account_id=a.id AND n.channel='email' AND n.status='active'
        WHERE a.id=$1 AND a.deleted_at IS NULL AND p.email_alerts=1 AND p.weekly_digest=1
        AND EXISTS(SELECT 1 FROM entitlements e WHERE e.account_id=a.id AND e.product='premium'
          AND e.status IN ('active','trialing'))`, [accountId]));
    },
    async pruneOperationalData({ completedJobDays = 14, deliveryEventDays = 90, outboxDays = 30 } = {}) {
      return transaction(async () => {
        const now = nowIso();
        const jobs = (await run("DELETE FROM jobs WHERE status IN ('completed','failed','canceled') AND updated_at<$1", [since(completedJobDays)])).changes;
        const deliveryEvents = (await run('DELETE FROM delivery_events WHERE created_at<$1', [since(deliveryEventDays)])).changes;
        const outbox = (await run("DELETE FROM outbox WHERE status IN ('sent','failed','canceled') AND updated_at<$1", [since(outboxDays)])).changes;
        await run('DELETE FROM notification_unsubscribe_tokens WHERE used_at IS NOT NULL OR expires_at<$1', [now]);
        await run('DELETE FROM alert_unsubscribe_tokens WHERE used_at IS NOT NULL OR expires_at<$1', [now]);
        await run("DELETE FROM checkout_intents WHERE status IN ('completed','expired') AND updated_at<$1", [since(30)]);
        await run('DELETE FROM durable_rate_limits WHERE expires_at<$1', [now]);
        return { jobs, deliveryEvents, outbox };
      });
    },

    async revenueSummary(recent = 10) {
      const totalsRow = await one(`SELECT
        COALESCE(SUM(CASE WHEN amount_cents>0 AND type NOT LIKE 'charge.dispute.%' THEN 1 ELSE 0 END),0) paid_events,
        COALESCE(SUM(CASE WHEN amount_cents>0 AND type NOT LIKE 'charge.dispute.%' THEN amount_cents ELSE 0 END),0) gross_cents,
        COALESCE(-SUM(CASE WHEN type='charge.refunded' AND amount_cents<0 THEN amount_cents ELSE 0 END),0) refunds_cents,
        COALESCE(-SUM(CASE WHEN type LIKE 'charge.dispute.%' THEN amount_cents ELSE 0 END),0) disputes_cents,
        COALESCE(SUM(amount_cents),0) net_cents FROM billing_events`);
      const sumSince = async (days) => int((await one('SELECT COALESCE(SUM(amount_cents),0) cents FROM billing_events WHERE ts>=$1', [since(days)]))?.cents);
      const totals = Object.fromEntries(Object.entries(totalsRow || {}).map(([key, value]) => [key, int(value)]));
      return {
        ...totals,
        last_30d_cents: await sumSince(30),
        last_7d_cents: await sumSince(7),
        recent: await all('SELECT ts,type,plan,amount_cents,currency,livemode FROM billing_events ORDER BY ts DESC LIMIT $1', [Math.max(0, recent)]),
        active_plans: (await all("SELECT plan,COUNT(*)::integer n FROM accounts WHERE plan!='free' AND deleted_at IS NULL GROUP BY plan")).map((row) => ({ ...row, n: int(row.n) })),
      };
    },
    async exportAccount(accountId) {
      const account = await accountById(accountId);
      if (!account) return null;
      const privateProducts = [];
      for (const row of await all("SELECT * FROM products WHERE owner_account_id=$1 AND visibility='private' ORDER BY created_at", [accountId])) {
        const product = productRow(row);
        const history = (await all(`SELECT ts,advertised_cents,true_cents,source,source_label,certainty,observed,fetched_at,evidence_json
          FROM price_points WHERE product_id=$1 ORDER BY ts`, [product.id])).map((point) => ({
          ...point, observed: Boolean(point.observed), evidence: parseJson(point.evidence_json),
        }));
        privateProducts.push({ ...product, history });
      }
      const sessions = (await all(`SELECT id,created_at,last_seen_at,expires_at,revoked_at,user_agent_hash,ip_hash
        FROM sessions WHERE account_id=$1 ORDER BY created_at`, [accountId])).map((row) => ({
        id: row.id, created_at: row.created_at, last_seen_at: row.last_seen_at, expires_at: row.expires_at,
        revoked_at: row.revoked_at, userAgentRecorded: Boolean(row.user_agent_hash), ipRecorded: Boolean(row.ip_hash),
      }));
      return {
        exportedAt: nowIso(),
        account: {
          id: account.id, email: account.email, emailVerified: Boolean(account.email_verified), plan: account.plan,
          createdAt: account.created_at, verifiedAt: account.verified_at || null,
          emailSuppressedAt: account.email_suppressed_at || null,
          emailSuppressionReason: account.email_suppression_reason || null,
        },
        preferences: await preferences(accountId),
        termsAcceptances: await api.listTermsAcceptances(accountId),
        watchlist: await api.listWatchlist(accountId),
        alerts: await api.listAlerts(accountId),
        privateProducts,
        notificationSubscriptions: await all(`SELECT channel,status,verify_expires_at,verified_at,unsubscribed_at,bounced_at,
          complaint_at,created_at,updated_at FROM notification_subscriptions WHERE account_id=$1 ORDER BY channel`, [accountId]),
        emailDeliveries: await all(`SELECT to_email,template,status,attempts,provider_message_id,created_at,sent_at
          FROM outbox WHERE account_id=$1 ORDER BY created_at`, [accountId]),
        apiKeys: await api.listApiKeys(accountId),
        apiUsage: await all(`SELECT k.id key_id,k.prefix,k.label,u.day,u.count FROM api_keys k
          JOIN api_usage u ON u.key_id=k.id WHERE k.owner_account_id=$1 ORDER BY u.day,k.id`, [accountId]),
        entitlements: await api.listEntitlements(accountId),
        billingSourceState: await all(`SELECT source_ref,status,provider_event_created,updated_at
          FROM billing_source_state WHERE account_id=$1 ORDER BY source_ref`, [accountId]),
        sessions,
        authActivity: await all('SELECT id,purpose,expires_at,consumed_at,created_at FROM auth_tokens WHERE account_id=$1 ORDER BY created_at', [accountId]),
        billing: await all('SELECT ts,type,plan,amount_cents,currency,livemode FROM billing_events WHERE account_id=$1 OR email=$2 ORDER BY ts', [accountId, account.email]),
      };
    },
    async deleteAccount(accountId) {
      return transaction(async () => {
        await advisory(`account-delete:${accountId}`);
        const account = await one('SELECT * FROM accounts WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [accountId]);
        if (!account
          || (await api.listActivePaidEntitlements(accountId)).length > 0
          || (await api.listPendingCheckoutIntents(accountId)).length > 0
          || (await api.listPendingBillingReconciliation(accountId, account.stripe_customer)).length > 0) return false;
        const now = nowIso();
        for (const product of await all("SELECT id FROM products WHERE owner_account_id=$1 AND visibility='private'", [accountId])) {
          await api.cancelProductJobs(product.id);
        }
        await run(`UPDATE jobs SET status=CASE WHEN status IN ('pending','retry','running') THEN 'canceled' ELSE status END,
          payload_json='{}',idempotency_key=NULL,leased_until=NULL,lease_token=NULL,
          last_error=CASE WHEN status IN ('pending','retry','running') THEN 'target account deleted' ELSE last_error END,
          updated_at=$1,completed_at=CASE WHEN status IN ('pending','retry','running') THEN $1 ELSE completed_at END
          WHERE type='weekly-digest' AND payload_json::jsonb->>'accountId'=$2`, [now, accountId]);
        await run('DELETE FROM sessions WHERE account_id=$1', [accountId]);
        await run('DELETE FROM auth_tokens WHERE account_id=$1', [accountId]);
        await run('DELETE FROM watchlist WHERE account_id=$1', [accountId]);
        await run('DELETE FROM alert_unsubscribe_tokens WHERE account_id=$1', [accountId]);
        await run('DELETE FROM alerts WHERE account_id=$1 OR email=$2', [accountId, account.email]);
        await run('DELETE FROM account_preferences WHERE account_id=$1', [accountId]);
        await run('DELETE FROM account_terms_acceptances WHERE account_id=$1', [accountId]);
        await run('DELETE FROM notification_subscriptions WHERE account_id=$1', [accountId]);
        await run('DELETE FROM notification_unsubscribe_tokens WHERE account_id=$1', [accountId]);
        await run('DELETE FROM outbox WHERE account_id=$1', [accountId]);
        await run('DELETE FROM pending_keys WHERE account_id=$1', [accountId]);
        await run('DELETE FROM checkout_claims WHERE account_id=$1', [accountId]);
        await run('DELETE FROM checkout_intents WHERE account_id=$1', [accountId]);
        await run('DELETE FROM entitlements WHERE account_id=$1', [accountId]);
        await run('DELETE FROM billing_source_state WHERE account_id=$1', [accountId]);
        await run('DELETE FROM account_api_usage WHERE account_id=$1', [accountId]);
        await run("DELETE FROM products WHERE owner_account_id=$1 AND visibility='private'", [accountId]);
        await run('DELETE FROM api_keys WHERE owner_account_id=$1', [accountId]);
        await run("UPDATE billing_events SET email=NULL,account_id=NULL,payload_json='{}' WHERE account_id=$1 OR email=$2", [accountId, account.email]);
        if (account.stripe_customer) {
          await run("UPDATE billing_reconciliation SET payload_json='{}' WHERE payload_json::jsonb->>'customer'=$1", [account.stripe_customer]);
        }
        const customerHash = account.stripe_customer ? sha256(`billing-customer:${account.stripe_customer}`) : null;
        await run(`UPDATE accounts SET email=$1,plan='free',stripe_customer=NULL,billing_customer_hash=$2,
          deleted_at=$3,updated_at=$3 WHERE id=$4`, [`deleted+${accountId}@deleted.invalid`, customerHash, now, accountId]);
        return true;
      });
    },
    async metrics() {
      const day = (n) => nowIso(Date.now() - n * 86_400_000).slice(0, 10);
      const grouped = async (table) => Object.fromEntries((await all(`SELECT status,COUNT(*)::integer n FROM ${table} GROUP BY status`))
        .map((row) => [row.status, int(row.n)]));
      return {
        keys_by_tier: (await all('SELECT tier,COUNT(*)::integer n FROM api_keys WHERE revoked=0 GROUP BY tier')).map((row) => ({ ...row, n: int(row.n) })),
        api_calls_today: int((await one('SELECT COALESCE(SUM(count),0) n FROM api_usage WHERE day>=$1', [day(0)]))?.n),
        api_calls_7d: int((await one('SELECT COALESCE(SUM(count),0) n FROM api_usage WHERE day>=$1', [day(7)]))?.n),
        alerts: int((await one("SELECT COUNT(*)::integer n FROM alerts WHERE status!='deleted'"))?.n),
        products: int((await one('SELECT COUNT(*)::integer n FROM products'))?.n),
        price_points: int((await one('SELECT COUNT(*)::integer n FROM price_points'))?.n),
        outbox: await grouped('outbox'),
        jobs: await grouped('jobs'),
        billing_reconciliation: await api.billingReconciliationMetrics(),
      };
    },
  };
}

const openPostgres = open;

export { open, openPostgres, sha256, privateProductId };
