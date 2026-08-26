import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { getDatabase } from '@netlify/database';

const SCHEMA_VERSION = 4;
const MAX_ALERTS_FREE = 1;
const MAX_ALERTS_PREMIUM = 20;
const MAX_ACTIVE_AUTH_TOKENS = 5;
// This hash covers SQLite's normalized logical v4 catalog, not raw CREATE SQL
// or customer data. That accepts a compatible database upgraded through an
// older DDL history while still rejecting type/default/key/index drift.
const SOURCE_SCHEMA_FINGERPRINT = '943b5e0110d1056b4d4abb4dfebffb98b2805ef2192c3b155a08a1dd98460b53';
const BASELINE_MIGRATION_SQL = fs.readFileSync(
  new URL('../netlify/database/migrations/20260826000000_pricetruth_baseline/migration.sql', import.meta.url),
  'utf8',
);
const POSTGRES_INTEGER_MAX = 2_147_483_647;
const BIGINT_VALUE_COLUMNS = new Set([
  'entitlements.provider_event_created',
  'billing_source_state.provider_event_created',
]);

const table = (name, primaryKey, sourceColumns, targetColumns = sourceColumns) => ({
  name, primaryKey, sourceColumns, targetColumns,
});

// This list is intentionally explicit. A cutover must stop when either schema
// changes instead of silently dropping a new field that the script does not
// understand yet.
const IMPORT_TABLES = [
  table('accounts', ['email'], [
    'email', 'plan', 'stripe_customer', 'created_at', 'updated_at', 'id',
    'email_verified', 'verified_at', 'deleted_at', 'billing_customer_hash',
    'email_suppressed_at', 'email_suppression_reason',
  ], [
    'email', 'id', 'plan', 'stripe_customer', 'email_verified', 'verified_at',
    'deleted_at', 'billing_customer_hash', 'email_suppressed_at',
    'email_suppression_reason', 'created_at', 'updated_at',
  ]),
  table('products', ['id'], [
    'id', 'vertical', 'name', 'url', 'advertised_cents', 'context_json',
    'created_at', 'source', 'source_label', 'certainty', 'fetched_at',
    'evidence_json', 'updated_at', 'visibility', 'owner_account_id',
  ], [
    'id', 'vertical', 'name', 'url', 'advertised_cents', 'context_json',
    'source', 'source_label', 'certainty', 'fetched_at', 'evidence_json',
    'updated_at', 'visibility', 'owner_account_id', 'created_at',
  ]),
  table('price_points', ['id'], [
    'id', 'product_id', 'ts', 'advertised_cents', 'true_cents', 'source',
    'source_label', 'certainty', 'observed', 'alert_eligible', 'fetched_at',
    'evidence_json', 'provider_key',
  ]),
  table('alerts', ['id'], [
    'id', 'email', 'product_id', 'threshold_cents', 'created_at', 'account_id',
    'status', 'updated_at', 'last_notified_at', 'last_trigger_key',
    'unsubscribe_token_hash', 'condition_active', 'last_evaluated_cents',
    'last_delivered_trigger_key',
  ], [
    'id', 'email', 'account_id', 'product_id', 'threshold_cents', 'status',
    'updated_at', 'last_notified_at', 'last_trigger_key',
    'unsubscribe_token_hash', 'condition_active', 'last_evaluated_cents',
    'last_delivered_trigger_key', 'quota_slot', 'created_at',
  ]),
  table('api_keys', ['id'], [
    'id', 'key_hash', 'label', 'tier', 'revoked', 'created_at', 'owner_email',
    'stripe_ref', 'owner_account_id', 'prefix', 'last_used_at', 'revoked_at',
    'replaced_by_id', 'updated_at', 'can_write_history', 'suspended',
  ], [
    'id', 'key_hash', 'prefix', 'label', 'tier', 'owner_email',
    'owner_account_id', 'stripe_ref', 'last_used_at', 'revoked_at',
    'replaced_by_id', 'updated_at', 'can_write_history', 'suspended', 'revoked',
    'created_at',
  ]),
  table('api_usage', ['key_id', 'day'], ['key_id', 'day', 'count']),
  table('account_api_usage', ['account_id', 'day'], null, ['account_id', 'day', 'count']),
  table('billing_events', ['id'], [
    'id', 'ts', 'type', 'email', 'plan', 'amount_cents', 'currency', 'livemode',
    'stripe_ref', 'account_id', 'status', 'payload_json',
  ], [
    'id', 'ts', 'type', 'email', 'account_id', 'plan', 'amount_cents',
    'currency', 'livemode', 'stripe_ref', 'status', 'payload_json',
  ]),
  table('pending_keys', ['session_id'], [
    'session_id', 'raw_key', 'tier', 'created_at', 'account_id', 'key_iv', 'key_tag',
  ], ['session_id', 'raw_key', 'tier', 'account_id', 'key_iv', 'key_tag', 'created_at']),
  table('auth_tokens', ['id'], [
    'id', 'account_id', 'purpose', 'token_hash', 'expires_at', 'consumed_at',
    'created_at',
  ], [
    'id', 'account_id', 'purpose', 'token_hash', 'quota_slot', 'expires_at',
    'consumed_at', 'created_at',
  ]),
  table('sessions', ['id'], [
    'id', 'account_id', 'token_hash', 'csrf_hash', 'user_agent_hash', 'ip_hash',
    'created_at', 'last_seen_at', 'expires_at', 'revoked_at',
  ]),
  table('account_preferences', ['account_id'], [
    'account_id', 'email_alerts', 'weekly_digest', 'timezone', 'created_at', 'updated_at',
  ]),
  table('account_terms_acceptances', ['account_id', 'terms_version'], [
    'account_id', 'terms_version', 'accepted_at', 'context_json',
  ]),
  table('watchlist', ['account_id', 'product_id'], ['account_id', 'product_id', 'created_at']),
  table('notification_subscriptions', ['account_id', 'channel'], [
    'account_id', 'channel', 'status', 'verify_token_hash',
    'unsubscribe_token_hash', 'verify_expires_at', 'verified_at',
    'unsubscribed_at', 'bounced_at', 'complaint_at', 'created_at', 'updated_at',
  ]),
  table('notification_unsubscribe_tokens', ['token_hash'], [
    'token_hash', 'account_id', 'channel', 'expires_at', 'used_at', 'created_at',
  ]),
  table('alert_unsubscribe_tokens', ['token_hash'], [
    'token_hash', 'alert_id', 'account_id', 'expires_at', 'used_at', 'created_at',
  ]),
  table('outbox', ['id'], [
    'id', 'account_id', 'to_email', 'template', 'payload_ciphertext', 'payload_iv',
    'payload_tag', 'metadata_json', 'status', 'attempts', 'max_attempts',
    'available_at', 'leased_until', 'last_error', 'provider_message_id',
    'idempotency_key', 'created_at', 'updated_at', 'sent_at',
  ], [
    'id', 'account_id', 'to_email', 'template', 'payload_ciphertext', 'payload_iv',
    'payload_tag', 'metadata_json', 'status', 'attempts', 'max_attempts',
    'available_at', 'leased_until', 'lease_token', 'last_error',
    'provider_message_id', 'idempotency_key', 'created_at', 'updated_at', 'sent_at',
  ]),
  table('delivery_events', ['id'], [
    'id', 'outbox_id', 'provider', 'provider_event_id', 'provider_message_id',
    'type', 'payload_json', 'occurred_at', 'created_at',
  ]),
  table('jobs', ['id'], [
    'id', 'type', 'payload_json', 'status', 'attempts', 'max_attempts',
    'available_at', 'leased_until', 'last_error', 'idempotency_key', 'created_at',
    'updated_at', 'completed_at',
  ], [
    'id', 'type', 'payload_json', 'status', 'attempts', 'max_attempts',
    'available_at', 'leased_until', 'lease_token', 'last_error',
    'idempotency_key', 'created_at', 'updated_at', 'completed_at',
  ]),
  table('entitlements', ['id'], [
    'id', 'account_id', 'product', 'status', 'source', 'source_ref',
    'current_period_end', 'cancel_at_period_end', 'metadata_json', 'created_at',
    'updated_at', 'provider_event_created',
  ], [
    'id', 'account_id', 'product', 'status', 'source', 'source_ref',
    'current_period_end', 'cancel_at_period_end', 'metadata_json',
    'provider_event_created', 'created_at', 'updated_at',
  ]),
  table('billing_source_state', ['account_id', 'source_ref'], [
    'account_id', 'source_ref', 'status', 'provider_event_created', 'updated_at',
  ]),
  table('checkout_claims', ['session_id'], [
    'session_id', 'account_id', 'plan', 'tier', 'status', 'claimed_at',
    'created_at', 'updated_at',
  ]),
  table('checkout_intents', ['id'], [
    'id', 'account_id', 'plan', 'idempotency_key', 'stripe_session_id',
    'checkout_url', 'status', 'created_at', 'updated_at', 'expires_at',
    'payment_status', 'terms_version',
  ], [
    'id', 'account_id', 'plan', 'idempotency_key', 'stripe_session_id',
    'checkout_url', 'status', 'expires_at', 'payment_status', 'terms_version',
    'created_at', 'updated_at',
  ]),
  table('billing_reconciliation', ['event_id'], [
    'event_id', 'event_type', 'reason', 'payload_json', 'status', 'attempts',
    'created_at', 'updated_at', 'resolved_at',
  ]),
  table('provider_usage', ['day', 'provider'], [
    'day', 'provider', 'calls', 'failures', 'consecutive_failures',
    'circuit_open_until', 'updated_at',
  ]),
];

const TARGET_ONLY_TABLES = [
  table('durable_rate_limits', ['bucket'], null, ['bucket', 'tokens', 'updated_at_ms', 'expires_at']),
];

const TARGET_TABLES = [...IMPORT_TABLES, ...TARGET_ONLY_TABLES];
const SOURCE_TABLE_NAMES = ['schema_migrations', ...IMPORT_TABLES.filter((entry) => entry.sourceColumns).map((entry) => entry.name)];
const IDENTITY_TABLES = ['price_points', 'alerts', 'api_keys', 'billing_events'];

const REFERENCE_RULES = [
  ['products', 'owner_account_id', 'accounts', 'id', true],
  ['price_points', 'product_id', 'products', 'id', false],
  ['alerts', 'account_id', 'accounts', 'id', true],
  ['alerts', 'product_id', 'products', 'id', false],
  ['api_keys', 'owner_account_id', 'accounts', 'id', true],
  ['api_keys', 'replaced_by_id', 'api_keys', 'id', true],
  ['api_usage', 'key_id', 'api_keys', 'id', false],
  ['billing_events', 'account_id', 'accounts', 'id', true],
  ['pending_keys', 'account_id', 'accounts', 'id', true],
  ['auth_tokens', 'account_id', 'accounts', 'id', false],
  ['sessions', 'account_id', 'accounts', 'id', false],
  ['account_preferences', 'account_id', 'accounts', 'id', false],
  ['account_terms_acceptances', 'account_id', 'accounts', 'id', false],
  ['watchlist', 'account_id', 'accounts', 'id', false],
  ['watchlist', 'product_id', 'products', 'id', false],
  ['notification_subscriptions', 'account_id', 'accounts', 'id', false],
  ['notification_unsubscribe_tokens', 'account_id', 'accounts', 'id', false],
  ['alert_unsubscribe_tokens', 'alert_id', 'alerts', 'id', false],
  ['alert_unsubscribe_tokens', 'account_id', 'accounts', 'id', false],
  ['outbox', 'account_id', 'accounts', 'id', true],
  ['delivery_events', 'outbox_id', 'outbox', 'id', true],
  ['entitlements', 'account_id', 'accounts', 'id', false],
  ['billing_source_state', 'account_id', 'accounts', 'id', false],
  ['checkout_claims', 'account_id', 'accounts', 'id', true],
  ['checkout_intents', 'account_id', 'accounts', 'id', false],
];

export class CutoverError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CutoverError';
    this.code = code;
  }
}

const quoteIdentifier = (value) => `"${String(value).replaceAll('"', '""')}"`;
const stableValue = (value) => {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString('base64');
  return value;
};
const rowKey = (row, primaryKey) => JSON.stringify(primaryKey.map((column) => stableValue(row[column])));
const sortRows = (rows, primaryKey) => [...rows].sort((left, right) => rowKey(left, primaryKey).localeCompare(rowKey(right, primaryKey)));
const fingerprint = (rows, columns, primaryKey) => crypto.createHash('sha256')
  .update(JSON.stringify(sortRows(rows, primaryKey).map((row) => columns.map((column) => stableValue(row[column])))))
  .digest('hex');

function fail(code, message) {
  throw new CutoverError(code, message);
}

function assertExactColumns(actual, expected, location, tableName) {
  const left = [...actual].sort();
  const right = [...expected].sort();
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    fail('SCHEMA_MISMATCH', `${location} table ${tableName} does not match the version ${SCHEMA_VERSION} cutover contract`);
  }
}

const normalizeSchemaSql = (value, schema = null) => {
  if (value === null || value === undefined) return null;
  let normalized = String(value);
  if (schema) {
    const escaped = schema.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    normalized = normalized
      .replace(new RegExp(`"${escaped}"\\.`, 'g'), '')
      .replace(new RegExp(`\\b${escaped}\\.`, 'g'), '');
  }
  return normalized.replace(/\s+/g, ' ').trim();
};

export function sqliteSchemaFingerprintForCutover(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().map((row) => row.name);
  const contract = {
    tables,
    tableOptions: [],
    identityAutoincrement: [],
    columns: [],
    foreignKeys: [],
    indexes: [],
    triggers: [],
    views: [],
  };
  const tableSet = new Set(tables);
  contract.tableOptions = db.prepare('PRAGMA table_list').all()
    .filter((row) => tableSet.has(row.name))
    .map((row) => [row.schema, row.name, row.type, Number(row.ncol), Number(row.wr), Number(row.strict)])
    .sort((left, right) => left[1].localeCompare(right[1]));
  // PRAGMA table_xinfo deliberately does not expose AUTOINCREMENT. Preserve
  // this one semantic token from sqlite_master so a rebuilt identity table
  // cannot lose sqlite_sequence high-water protection while still presenting
  // an otherwise identical logical catalog.
  contract.identityAutoincrement = IDENTITY_TABLES.map((tableName) => {
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(tableName)?.sql || '';
    return [tableName, /\bAUTOINCREMENT\b/i.test(sql)];
  });
  for (const tableName of tables) {
    for (const column of db.prepare(`PRAGMA table_xinfo(${quoteIdentifier(tableName)})`).all()) {
      contract.columns.push([
        tableName, column.name, String(column.type).toUpperCase(),
        Number(column.notnull), normalizeSchemaSql(column.dflt_value), Number(column.pk), Number(column.hidden),
      ]);
    }
    for (const key of db.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(tableName)})`).all()) {
      contract.foreignKeys.push([
        tableName, key.table, key.from, key.to,
        key.on_update, key.on_delete, key.match,
      ]);
    }
    for (const index of db.prepare(`PRAGMA index_list(${quoteIdentifier(tableName)})`).all()) {
      const columns = db.prepare(`PRAGMA index_xinfo(${quoteIdentifier(index.name)})`).all()
        .map((entry) => [Number(entry.seqno), entry.name, Number(entry.desc), entry.coll, Number(entry.key)]);
      const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?").get(index.name)?.sql || null;
      contract.indexes.push([
        tableName, index.origin === 'c' ? index.name : null, Number(index.unique),
        index.origin, Number(index.partial), columns,
        index.origin === 'c' ? normalizeSchemaSql(sql) : null,
      ]);
    }
  }
  contract.columns.sort((left, right) => JSON.stringify(left.slice(0, 2)).localeCompare(JSON.stringify(right.slice(0, 2))));
  contract.foreignKeys.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  contract.indexes.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  contract.triggers = db.prepare("SELECT name,tbl_name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name")
    .all().map((row) => [row.name, row.tbl_name, normalizeSchemaSql(row.sql)]);
  contract.views = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='view' ORDER BY name")
    .all().map((row) => [row.name, normalizeSchemaSql(row.sql)]);
  return crypto.createHash('sha256').update(JSON.stringify(contract)).digest('hex');
}

export async function postgresSchemaFingerprintForCutover(client, schemaName = null) {
  const schema = schemaName || String((await client.query('SELECT current_schema() AS schema')).rows[0].schema);
  const tables = (await client.query(`SELECT c.relname table_name,c.relkind,c.relpersistence,c.relrowsecurity,c.relforcerowsecurity
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND c.relkind IN ('r','p','v','m','f') ORDER BY c.relname`, [schema])).rows
    .map((row) => [row.table_name, row.relkind, row.relpersistence, row.relrowsecurity, row.relforcerowsecurity]);
  const columns = (await client.query(`SELECT table_name,column_name,ordinal_position,data_type,udt_schema,udt_name,
    is_nullable,column_default,is_identity,identity_generation,collation_schema,collation_name
    FROM information_schema.columns WHERE table_schema=$1 ORDER BY table_name,ordinal_position`, [schema])).rows
    .map((row) => [
      row.table_name, row.column_name, Number(row.ordinal_position), row.data_type,
      row.udt_schema, row.udt_name, row.is_nullable, normalizeSchemaSql(row.column_default, schema),
      row.is_identity, row.identity_generation, row.collation_schema, row.collation_name,
    ]);
  const constraints = (await client.query(`SELECT cls.relname table_name,con.conname,con.contype,
    con.convalidated,con.condeferrable,con.condeferred,
    pg_get_constraintdef(con.oid,true) definition
    FROM pg_constraint con JOIN pg_class cls ON cls.oid=con.conrelid
    JOIN pg_namespace ns ON ns.oid=cls.relnamespace
    WHERE ns.nspname=$1 ORDER BY cls.relname,con.conname`, [schema])).rows
    .map((row) => [
      row.table_name, row.conname, row.contype, row.convalidated, row.condeferrable,
      row.condeferred, normalizeSchemaSql(row.definition, schema),
    ]);
  const indexes = (await client.query(`SELECT tbl.relname table_name,idx.relname index_name,
    i.indisunique,i.indisprimary,i.indisvalid,i.indisready,i.indislive,pg_get_indexdef(i.indexrelid) definition
    FROM pg_index i JOIN pg_class idx ON idx.oid=i.indexrelid
    JOIN pg_class tbl ON tbl.oid=i.indrelid JOIN pg_namespace ns ON ns.oid=tbl.relnamespace
    WHERE ns.nspname=$1 ORDER BY tbl.relname,idx.relname`, [schema])).rows
    .map((row) => [
      row.table_name, row.index_name, row.indisunique, row.indisprimary,
      row.indisvalid, row.indisready, row.indislive, normalizeSchemaSql(row.definition, schema),
    ]);
  const triggers = (await client.query(`SELECT cls.relname table_name,tg.tgname,pg_get_triggerdef(tg.oid,true) definition
    FROM pg_trigger tg JOIN pg_class cls ON cls.oid=tg.tgrelid
    JOIN pg_namespace ns ON ns.oid=cls.relnamespace
    WHERE ns.nspname=$1 AND NOT tg.tgisinternal ORDER BY cls.relname,tg.tgname`, [schema])).rows
    .map((row) => [row.table_name, row.tgname, normalizeSchemaSql(row.definition, schema)]);
  const policies = (await client.query(`SELECT tablename,policyname,permissive,roles,cmd,qual,with_check
    FROM pg_policies WHERE schemaname=$1 ORDER BY tablename,policyname`, [schema])).rows
    .map((row) => [
      row.tablename, row.policyname, row.permissive, row.roles, row.cmd,
      normalizeSchemaSql(row.qual, schema), normalizeSchemaSql(row.with_check, schema),
    ]);
  const sequences = (await client.query(`SELECT c.relname sequence_name,s.seqtypid::regtype::text data_type,
    s.seqstart::text,s.seqincrement::text,s.seqmin::text,s.seqmax::text,s.seqcache::text,s.seqcycle
    FROM pg_sequence s JOIN pg_class c ON c.oid=s.seqrelid
    JOIN pg_namespace ns ON ns.oid=c.relnamespace
    WHERE ns.nspname=$1 ORDER BY c.relname`, [schema])).rows
    .map((row) => [
      row.sequence_name, row.data_type, row.seqstart, row.seqincrement, row.seqmin,
      row.seqmax, row.seqcache, row.seqcycle,
    ]);
  return crypto.createHash('sha256').update(JSON.stringify({
    tables, columns, constraints, indexes, triggers, policies, sequences,
  })).digest('hex');
}

function sourceSchemaFor(tableName) {
  if (tableName === 'schema_migrations') return ['version', 'name', 'applied_at'];
  return IMPORT_TABLES.find((entry) => entry.name === tableName)?.sourceColumns || [];
}

function validateSourceSchema(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name);
  if (JSON.stringify([...tables].sort()) !== JSON.stringify([...SOURCE_TABLE_NAMES].sort())) {
    fail('SOURCE_SCHEMA_MISMATCH', `source database tables do not match schema version ${SCHEMA_VERSION}`);
  }
  for (const tableName of SOURCE_TABLE_NAMES) {
    const columns = db.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all().map((row) => row.name);
    assertExactColumns(columns, sourceSchemaFor(tableName), 'source', tableName);
  }
  const migrations = db.prepare('SELECT version,name FROM schema_migrations ORDER BY version').all()
    .map((row) => [Number(row.version), row.name]);
  const expectedMigrations = [
    [1, 'production-foundation'],
    [2, 'launch-state-hardening'],
    [3, 'versioned-terms-acceptance'],
    [4, 'opaque-private-product-identifiers'],
  ];
  if (JSON.stringify(migrations) !== JSON.stringify(expectedMigrations)) {
    fail('SOURCE_SCHEMA_VERSION', `source database must contain the complete schema history through version ${SCHEMA_VERSION}`);
  }
  if (sqliteSchemaFingerprintForCutover(db) !== SOURCE_SCHEMA_FINGERPRINT) {
    fail('SOURCE_SCHEMA_CONTRACT', `source database structure does not match the exact version ${SCHEMA_VERSION} contract`);
  }
}

function loadSourceRows(db) {
  const rows = new Map();
  for (const definition of IMPORT_TABLES) {
    if (!definition.sourceColumns) continue;
    const columns = definition.sourceColumns.map(quoteIdentifier).join(',');
    const order = definition.primaryKey.map(quoteIdentifier).join(',');
    rows.set(definition.name, db.prepare(`SELECT ${columns} FROM ${quoteIdentifier(definition.name)} ORDER BY ${order}`).all()
      .map((row) => ({ ...row })));
  }
  return rows;
}

function loadSourceIdentityNextValues(db) {
  const highWater = new Map();
  const names = IDENTITY_TABLES.map(() => '?').join(',');
  for (const row of db.prepare(`SELECT name,seq FROM sqlite_sequence WHERE name IN (${names})`).all(...IDENTITY_TABLES)) {
    const sequenceValue = Number(row.seq);
    if (!Number.isSafeInteger(sequenceValue) || sequenceValue < 0) {
      fail('SOURCE_SEQUENCE_INVALID', `source ${row.name} identity high-water mark is invalid`);
    }
    highWater.set(row.name, BigInt(sequenceValue) + 1n);
  }
  return new Map(IDENTITY_TABLES.map((tableName) => [tableName, highWater.get(tableName) || 1n]));
}

function validateReferences(rows) {
  for (const [childTable, childColumn, parentTable, parentColumn, nullable] of REFERENCE_RULES) {
    const parentValues = new Set(rows.get(parentTable).map((row) => String(row[parentColumn])));
    const invalid = rows.get(childTable).filter((row) => {
      const value = row[childColumn];
      if (value === null || value === undefined) return !nullable;
      return !parentValues.has(String(value));
    });
    if (invalid.length) fail('SOURCE_REFERENCE_MISMATCH', `source ${childTable} has ${invalid.length} invalid ${childColumn} reference(s)`);
  }
}

function validateUnique(rows, tableName, columns, predicate = () => true) {
  const seen = new Set();
  let duplicates = 0;
  for (const row of rows.get(tableName).filter(predicate)) {
    const key = JSON.stringify(columns.map((column) => row[column] ?? ''));
    if (seen.has(key)) duplicates += 1;
    seen.add(key);
  }
  if (duplicates) fail('SOURCE_UNIQUE_MISMATCH', `source ${tableName} has ${duplicates} row(s) that violate the target uniqueness contract`);
}

function validateJsonObjectColumns(rows) {
  // Every persisted *_json field in the v4 application contract is written as
  // a JSON object. PostgreSQL runtime queries cast several of these TEXT
  // values to jsonb, so accepting malformed JSON (or an array/scalar) here
  // would let a cutover reconcile successfully and fail only under live
  // traffic. Derive the list from the explicit import contract so a future
  // JSON field cannot be added without receiving the same preflight check.
  for (const definition of IMPORT_TABLES.filter((entry) => entry.sourceColumns)) {
    for (const column of definition.sourceColumns.filter((name) => name.endsWith('_json'))) {
      let invalid = 0;
      for (const row of rows.get(definition.name)) {
        try {
          const parsed = JSON.parse(row[column]);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) invalid += 1;
        } catch {
          invalid += 1;
        }
      }
      if (invalid) {
        fail('SOURCE_JSON_INVALID', `source ${definition.name}.${column} has ${invalid} value(s) outside the JSON-object contract`);
      }
    }
  }
}

function prepareRows(sourceRows, cutoff) {
  const rows = new Map();
  for (const definition of IMPORT_TABLES) {
    if (!definition.sourceColumns) continue;
    rows.set(definition.name, sourceRows.get(definition.name).map((source) => {
      const output = {};
      for (const column of definition.targetColumns) {
        const value = source[column] ?? null;
        output[column] = value !== null && BIGINT_VALUE_COLUMNS.has(`${definition.name}.${column}`)
          ? String(value)
          : value;
      }
      return output;
    }));
  }

  const premiumAccounts = new Set(rows.get('entitlements')
    .filter((entry) => entry.product === 'premium' && ['active', 'trialing'].includes(entry.status))
    .map((entry) => entry.account_id));
  const alertsByAccount = new Map();
  for (const alert of rows.get('alerts')) {
    alert.quota_slot = null;
    if (!alert.account_id || alert.status === 'deleted') continue;
    const group = alertsByAccount.get(alert.account_id) || [];
    group.push(alert);
    alertsByAccount.set(alert.account_id, group);
  }
  for (const [accountId, alerts] of alertsByAccount) {
    alerts.sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)) || Number(left.id) - Number(right.id));
    const limit = premiumAccounts.has(accountId) ? MAX_ALERTS_PREMIUM : MAX_ALERTS_FREE;
    if (alerts.length > limit) {
      fail('SOURCE_ALERT_QUOTA', `source has an account with ${alerts.length} non-deleted alerts, above its target limit of ${limit}`);
    }
    alerts.forEach((alert, index) => { alert.quota_slot = index + 1; });
  }

  const tokensByAccountPurpose = new Map();
  for (const token of rows.get('auth_tokens')) {
    token.quota_slot = null;
    if (token.consumed_at !== null || String(token.expires_at) <= cutoff) continue;
    const key = `${token.account_id}\0${token.purpose}`;
    const group = tokensByAccountPurpose.get(key) || [];
    group.push(token);
    tokensByAccountPurpose.set(key, group);
  }
  for (const tokens of tokensByAccountPurpose.values()) {
    tokens.sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)) || String(left.id).localeCompare(String(right.id)));
    if (tokens.length > MAX_ACTIVE_AUTH_TOKENS) {
      fail('SOURCE_AUTH_QUOTA', `source has an account/purpose pair with ${tokens.length} active auth tokens, above the target limit of ${MAX_ACTIVE_AUTH_TOKENS}`);
    }
    tokens.forEach((token, index) => { token.quota_slot = index + 1; });
  }

  // SQLite tracked usage per key. Netlify's distributed quota is per account,
  // so carry the old rows forward and also seed the exact shared counter.
  const keyOwners = new Map(rows.get('api_keys').map((entry) => [Number(entry.id), entry.owner_account_id]));
  const accountUsage = new Map();
  for (const usage of rows.get('api_usage')) {
    const accountId = keyOwners.get(Number(usage.key_id));
    if (!accountId) continue;
    const key = `${accountId}\0${usage.day}`;
    const current = accountUsage.get(key) || { account_id: accountId, day: usage.day, count: 0 };
    current.count += Number(usage.count);
    accountUsage.set(key, current);
  }
  rows.set('account_api_usage', [...accountUsage.values()]);

  for (const entry of rows.get('outbox')) entry.lease_token = null;
  for (const entry of rows.get('jobs')) entry.lease_token = null;
  return rows;
}

function validateSourceInvariants(rows) {
  const missingAccountIds = rows.get('accounts').filter((row) => !row.id).length;
  if (missingAccountIds) fail('SOURCE_ACCOUNT_ID', `source has ${missingAccountIds} account(s) without stable IDs`);
  validateJsonObjectColumns(rows);
  validateReferences(rows);
  validateUnique(rows, 'accounts', ['id']);
  validateUnique(rows, 'accounts', ['stripe_customer'], (row) => row.stripe_customer !== null && row.deleted_at === null);
  validateUnique(rows, 'price_points', ['product_id', 'ts', 'source', 'provider_key', 'advertised_cents', 'true_cents']);
  // Historical SQLite v4 permitted one live intent per account+plan. The
  // Netlify target deliberately permits only one per account, so detect a
  // pre-existing cross-plan race before opening or writing the destination.
  // Nothing is silently expired or discarded; the operator must reconcile the
  // provider state and mark the losing intent terminal in the source first.
  validateUnique(rows, 'checkout_intents', ['account_id'], (row) => ['pending', 'awaiting_payment'].includes(row.status));
  const invalidPrivate = rows.get('products').filter((row) => row.visibility === 'private' && !row.owner_account_id).length;
  if (invalidPrivate) fail('SOURCE_PRIVATE_OWNER', `source has ${invalidPrivate} private product(s) without an owner`);
  for (const definition of IMPORT_TABLES.filter((entry) => entry.sourceColumns)) {
    const missingPrimaryKeys = rows.get(definition.name)
      .filter((row) => definition.primaryKey.some((column) => row[column] === null || row[column] === undefined)).length;
    if (missingPrimaryKeys) fail('SOURCE_PRIMARY_KEY', `source ${definition.name} has ${missingPrimaryKeys} row(s) without a complete primary key`);
    validateUnique(rows, definition.name, definition.primaryKey);
  }
}

function validateSourceIdentityRanges(rows, identityNextValues) {
  for (const tableName of IDENTITY_TABLES) {
    const invalidIds = rows.get(tableName).filter((row) => {
      const id = Number(row.id);
      return !Number.isSafeInteger(id) || id < 1 || id > POSTGRES_INTEGER_MAX;
    }).length;
    if (invalidIds) {
      fail('SOURCE_ID_RANGE', `source ${tableName} has ${invalidIds} identity value(s) outside the target INTEGER range`);
    }
    const next = identityNextValues.get(tableName) || 1n;
    if (next > BigInt(POSTGRES_INTEGER_MAX)) {
      fail('SOURCE_ID_CAPACITY', `source ${tableName} identity high-water mark has exhausted the target INTEGER range`);
    }
  }
}

export function inspectSqliteSource(source, { now = new Date() } = {}) {
  if (!source || source === ':memory:') fail('SOURCE_REQUIRED', 'an on-disk SQLite source is required');
  const resolved = path.resolve(source);
  let stats;
  try { stats = fs.statSync(resolved); } catch { fail('SOURCE_NOT_FOUND', 'the SQLite source file does not exist or is not readable'); }
  if (!stats.isFile() || stats.size === 0) fail('SOURCE_INVALID', 'the SQLite source must be a non-empty regular file');

  let db;
  try {
    db = new DatabaseSync(resolved, { readOnly: true });
    db.exec('PRAGMA query_only=ON; PRAGMA foreign_keys=ON;');
    // Hold one read snapshot across integrity, schema, invariant, and row
    // reads. A copied backup is still required operationally, but a stray
    // writer cannot give this process a torn multi-table view.
    db.exec('BEGIN');
    const quickCheck = db.prepare('PRAGMA quick_check').get()?.quick_check;
    if (quickCheck !== 'ok') fail('SOURCE_INTEGRITY', 'the SQLite source failed its integrity check');
    const fkErrors = db.prepare('PRAGMA foreign_key_check').all();
    if (fkErrors.length) fail('SOURCE_FOREIGN_KEYS', `the SQLite source has ${fkErrors.length} foreign-key violation(s)`);
    validateSourceSchema(db);
    const sourceRows = loadSourceRows(db);
    const identityNextValues = loadSourceIdentityNextValues(db);
    const rows = prepareRows(sourceRows, now.toISOString());
    validateSourceInvariants(rows);
    validateSourceIdentityRanges(rows, identityNextValues);
    const counts = Object.fromEntries(IMPORT_TABLES.map((definition) => [definition.name, rows.get(definition.name)?.length || 0]));
    db.exec('ROLLBACK');
    return {
      schemaVersion: SCHEMA_VERSION,
      rows,
      counts,
      identityNextValues,
      totalRows: Object.values(counts).reduce((sum, count) => sum + count, 0),
    };
  } catch (error) {
    if (error instanceof CutoverError) throw error;
    fail('SOURCE_READ_FAILED', 'the SQLite source could not be validated');
  } finally {
    try { db?.close(); } catch { /* read-only handle cleanup */ }
  }
}

function validateConnectionString(connectionString) {
  if (!connectionString) fail('TARGET_REQUIRED', 'NETLIFY_DB_URL is required for target validation');
  try {
    const parsed = new URL(connectionString);
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname || parsed.pathname === '/') throw new Error('invalid');
  } catch {
    fail('TARGET_URL_INVALID', 'NETLIFY_DB_URL must be a complete PostgreSQL connection URL');
  }
}

async function validateTargetSchema(client) {
  const productionSchema = String((await client.query('SELECT current_schema() AS schema')).rows[0]?.schema || '');
  if (!productionSchema) fail('TARGET_SCHEMA_CONTEXT', 'target connection does not have an active application schema');
  const result = await client.query(`SELECT table_name,column_name FROM information_schema.columns
    WHERE table_schema=current_schema() ORDER BY table_name,ordinal_position`);
  const byTable = new Map();
  for (const row of result.rows) {
    const columns = byTable.get(row.table_name) || [];
    columns.push(row.column_name);
    byTable.set(row.table_name, columns);
  }
  assertExactColumns(byTable.get('schema_migrations') || [], ['version', 'name', 'applied_at'], 'target', 'schema_migrations');
  for (const definition of TARGET_TABLES) {
    assertExactColumns(byTable.get(definition.name) || [], definition.targetColumns, 'target', definition.name);
  }
  const versionResult = await client.query('SELECT version,name FROM schema_migrations ORDER BY version');
  const migrations = versionResult.rows.map((row) => [Number(row.version), row.name]);
  if (JSON.stringify(migrations) !== JSON.stringify([[SCHEMA_VERSION, 'netlify-postgres-baseline']])) {
    fail('TARGET_SCHEMA_VERSION', `target database must be at the exact Netlify baseline version ${SCHEMA_VERSION}`);
  }

  // Materialize the checked-in baseline into an isolated scratch schema on
  // the *same* Postgres engine. Comparing logical catalogs there avoids magic
  // hashes tied to a particular Postgres/PGlite version or to the name of the
  // production schema. All scratch DDL is dropped before import and remains
  // inside the outer transaction.
  const scratchSchema = `pricetruth_cutover_contract_${crypto.randomBytes(8).toString('hex')}`;
  await client.query(`CREATE SCHEMA ${quoteIdentifier(scratchSchema)}`);
  try {
    await client.query(`SET LOCAL search_path TO ${quoteIdentifier(scratchSchema)}`);
    await client.query(BASELINE_MIGRATION_SQL);
    const [productionFingerprint, baselineFingerprint] = await Promise.all([
      postgresSchemaFingerprintForCutover(client, productionSchema),
      postgresSchemaFingerprintForCutover(client, scratchSchema),
    ]);
    if (productionFingerprint !== baselineFingerprint) {
      fail('TARGET_SCHEMA_CONTRACT', `target database structure does not match the exact Netlify baseline version ${SCHEMA_VERSION} contract`);
    }
    const disabledInternalTriggers = await client.query(`SELECT COUNT(*)::integer AS count
      FROM pg_trigger tg JOIN pg_class cls ON cls.oid=tg.tgrelid
      JOIN pg_namespace ns ON ns.oid=cls.relnamespace
      WHERE ns.nspname=$1 AND tg.tgisinternal AND tg.tgenabled<>'O'`, [productionSchema]);
    if (Number(disabledInternalTriggers.rows[0].count) !== 0) {
      fail('TARGET_SCHEMA_CONTRACT', 'target database has disabled internal constraint enforcement');
    }
  } finally {
    await client.query(`SET LOCAL search_path TO ${quoteIdentifier(productionSchema)}`);
    await client.query(`DROP SCHEMA ${quoteIdentifier(scratchSchema)} CASCADE`);
  }
}

async function tableCounts(client) {
  const counts = new Map();
  for (const definition of TARGET_TABLES) {
    const result = await client.query(`SELECT COUNT(*)::bigint AS count FROM ${quoteIdentifier(definition.name)}`);
    counts.set(definition.name, BigInt(result.rows[0].count));
  }
  return counts;
}

function assertTargetIsAllowed(counts, allowExistingTarget) {
  const populated = [...counts.entries()].filter(([, count]) => count !== 0n);
  if (populated.length && !allowExistingTarget) {
    fail('TARGET_NOT_EMPTY', `target contains data in ${populated.length} application table(s); use a fresh database or the explicit append-only override`);
  }
}

async function insertRows(client, definition, rows) {
  if (!rows.length) return;
  const columns = definition.targetColumns;
  const batchSize = Math.max(1, Math.min(250, Math.floor(5000 / columns.length)));
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize);
    const values = [];
    const slots = batch.map((row) => `(${columns.map((column) => {
      values.push(row[column] ?? null);
      return `$${values.length}`;
    }).join(',')})`).join(',');
    try {
      await client.query(`INSERT INTO ${quoteIdentifier(definition.name)} (${columns.map(quoteIdentifier).join(',')}) VALUES ${slots}`, values);
    } catch {
      fail('TARGET_IMPORT_REJECTED', `target rejected the append-only ${definition.name} import; no cutover rows were committed`);
    }
  }
}

async function restoreApiKeyLinks(client, rows) {
  for (const row of rows) {
    if (row.replaced_by_id === null) continue;
    try {
      await client.query('UPDATE api_keys SET replaced_by_id=$1 WHERE id=$2', [row.replaced_by_id, row.id]);
    } catch {
      fail('TARGET_API_KEY_LINK', 'target rejected an API-key rotation link; no cutover rows were committed');
    }
  }
}

async function targetIdentityNextValues(client) {
  const values = new Map();
  for (const tableName of IDENTITY_TABLES) {
    const sequenceResult = await client.query("SELECT pg_get_serial_sequence($1,'id') AS sequence", [tableName]);
    const sequenceName = String(sequenceResult.rows[0]?.sequence || '');
    if (!/^(?:[a-z_][a-z0-9_]*\.)?[a-z_][a-z0-9_]*$/i.test(sequenceName)) {
      fail('TARGET_SEQUENCE_INVALID', `target ${tableName} identity sequence is missing or invalid`);
    }
    const identifier = sequenceName.split('.').map(quoteIdentifier).join('.');
    const state = await client.query(`SELECT last_value::bigint AS last_value,is_called FROM ${identifier}`);
    const last = BigInt(state.rows[0].last_value);
    values.set(tableName, state.rows[0].is_called ? last + 1n : last);
  }
  return values;
}

async function resetIdentitySequences(client, sourceNextValues, baselineNextValues) {
  for (const tableName of IDENTITY_TABLES) {
    const result = await client.query(`SELECT COALESCE(MAX(id),0)::bigint AS maximum FROM ${quoteIdentifier(tableName)}`);
    const rowNext = BigInt(result.rows[0].maximum) + 1n;
    const next = [rowNext, sourceNextValues.get(tableName) || 1n, baselineNextValues.get(tableName) || 1n]
      .reduce((highest, candidate) => candidate > highest ? candidate : highest, 1n);
    if (next > BigInt(POSTGRES_INTEGER_MAX)) {
      fail('TARGET_ID_CAPACITY', `target ${tableName} identity range is exhausted; no cutover rows were committed`);
    }
    // ALTER COLUMN ... RESTART is transactional (unlike setval), so a later
    // reconciliation failure leaves both data and sequence state untouched.
    await client.query(`ALTER TABLE ${quoteIdentifier(tableName)} ALTER COLUMN id RESTART WITH ${next}`);
  }
}

async function reconcile(client, prepared, baseline, cutoff) {
  const actual = await tableCounts(client);
  for (const definition of TARGET_TABLES) {
    const imported = BigInt(prepared.get(definition.name)?.length || 0);
    const expected = baseline.get(definition.name) + imported;
    if (actual.get(definition.name) !== expected) {
      fail('TARGET_COUNT_MISMATCH', `target ${definition.name} count did not reconcile; no cutover rows were committed`);
    }
  }

  for (const definition of IMPORT_TABLES) {
    const expectedRows = prepared.get(definition.name) || [];
    if (!expectedRows.length) continue;
    const result = await client.query(`SELECT ${definition.targetColumns.map(quoteIdentifier).join(',')} FROM ${quoteIdentifier(definition.name)}`);
    const expectedKeys = new Set(expectedRows.map((row) => rowKey(row, definition.primaryKey)));
    const importedRows = result.rows.filter((row) => expectedKeys.has(rowKey(row, definition.primaryKey)));
    if (importedRows.length !== expectedRows.length || fingerprint(importedRows, definition.targetColumns, definition.primaryKey) !== fingerprint(expectedRows, definition.targetColumns, definition.primaryKey)) {
      fail('TARGET_FINGERPRINT_MISMATCH', `target ${definition.name} values did not reconcile; no cutover rows were committed`);
    }
  }

  const alertResult = await client.query(`SELECT COUNT(*)::integer AS invalid FROM alerts
    WHERE (account_id IS NOT NULL AND status<>'deleted' AND quota_slot IS NULL)
       OR (status='deleted' AND quota_slot IS NOT NULL)
       OR quota_slot<1 OR quota_slot>${MAX_ALERTS_PREMIUM}`);
  if (Number(alertResult.rows[0].invalid) !== 0) fail('TARGET_ALERT_QUOTA', 'target alert quota slots failed reconciliation');

  const alertLimitResult = await client.query(`SELECT COUNT(*)::integer AS invalid FROM (
    SELECT a.account_id,COUNT(*)::integer AS count,
      CASE WHEN EXISTS(SELECT 1 FROM entitlements e WHERE e.account_id=a.account_id
        AND e.product='premium' AND e.status IN ('active','trialing')) THEN ${MAX_ALERTS_PREMIUM} ELSE ${MAX_ALERTS_FREE} END AS allowed
    FROM alerts a WHERE a.account_id IS NOT NULL AND a.status<>'deleted'
    GROUP BY a.account_id
  ) quotas WHERE count>allowed`);
  if (Number(alertLimitResult.rows[0].invalid) !== 0) fail('TARGET_ALERT_LIMIT', 'target alert entitlement limits failed reconciliation');

  const authResult = await client.query(`SELECT COUNT(*)::integer AS invalid FROM auth_tokens
    WHERE (consumed_at IS NULL AND expires_at>$1 AND quota_slot IS NULL)
       OR ((consumed_at IS NOT NULL OR expires_at<=$1) AND quota_slot IS NOT NULL)
       OR quota_slot<1 OR quota_slot>${MAX_ACTIVE_AUTH_TOKENS}`, [cutoff]);
  if (Number(authResult.rows[0].invalid) !== 0) fail('TARGET_AUTH_QUOTA', 'target auth-token quota slots failed reconciliation');
}

function safeLogSummary(logger, label, counts) {
  try {
    logger(`${label}: schema v${SCHEMA_VERSION}; ${Object.values(counts).reduce((sum, count) => sum + Number(count), 0)} rows`);
    for (const definition of TARGET_TABLES) logger(`  ${definition.name}: ${counts[definition.name] || 0}`);
  } catch {
    // Logging must never change or misreport the outcome of a data transaction.
  }
}

export async function cutoverSqliteToNetlify({
  source,
  connectionString = process.env.NETLIFY_DB_URL,
  pool = null,
  apply = false,
  allowExistingTarget = false,
  now = new Date(),
  logger = () => {},
} = {}) {
  const inspected = inspectSqliteSource(source, { now });
  if (!pool) validateConnectionString(connectionString);
  safeLogSummary(logger, 'source validated', inspected.counts);

  let ownedPool = null;
  let client;
  try {
    const targetPool = pool || (ownedPool = getDatabase({ connectionString }).pool);
    client = await targetPool.connect();
  } catch {
    if (ownedPool) await ownedPool.end().catch(() => {});
    fail('TARGET_CONNECTION_FAILED', 'the Netlify Postgres target could not be reached');
  }

  const cutoff = now.toISOString();
  let transactionOpen = false;
  let commitAttempted = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    transactionOpen = true;
    // Plans exercise the exact same inserts and reconciliation as an apply,
    // then roll everything back. The lock makes baseline+source counts exact
    // and prevents a concurrent Function write from invalidating the result.
    await client.query(`LOCK TABLE schema_migrations, ${TARGET_TABLES.map((entry) => quoteIdentifier(entry.name)).join(',')} IN ACCESS EXCLUSIVE MODE`);
    await validateTargetSchema(client);
    const baseline = await tableCounts(client);
    const baselineIdentityNextValues = await targetIdentityNextValues(client);
    assertTargetIsAllowed(baseline, allowExistingTarget);

    for (const definition of IMPORT_TABLES) {
      const rows = inspected.rows.get(definition.name) || [];
      if (definition.name === 'api_keys') {
        await insertRows(client, definition, rows.map((row) => ({ ...row, replaced_by_id: null })));
      } else {
        await insertRows(client, definition, rows);
      }
    }
    await restoreApiKeyLinks(client, inspected.rows.get('api_keys'));
    await resetIdentitySequences(client, inspected.identityNextValues, baselineIdentityNextValues);
    await reconcile(client, inspected.rows, baseline, cutoff);

    if (!apply) {
      const targetCounts = Object.fromEntries([...baseline].map(([name, count]) => [name, count.toString()]));
      await client.query('ROLLBACK');
      transactionOpen = false;
      safeLogSummary(logger, 'target validated by rolled-back import plan', targetCounts);
      return { applied: false, sourceCounts: inspected.counts, targetCounts, schemaVersion: SCHEMA_VERSION };
    }

    commitAttempted = true;
    await client.query('COMMIT');
    transactionOpen = false;
    safeLogSummary(logger, 'cutover committed and reconciled', inspected.counts);
    return { applied: true, sourceCounts: inspected.counts, schemaVersion: SCHEMA_VERSION };
  } catch (error) {
    if (transactionOpen) {
      try { await client.query('ROLLBACK'); } catch { /* original safe failure wins */ }
    }
    if (commitAttempted) {
      fail('TARGET_COMMIT_UNCERTAIN', 'the target commit result is uncertain; freeze writes and run the default plan before any retry');
    }
    if (error instanceof CutoverError) throw error;
    fail('TARGET_VALIDATION_FAILED', 'the Netlify Postgres target failed validation; no cutover rows were committed');
  } finally {
    try { client?.release(); } catch { /* transaction outcome has already been determined */ }
    if (ownedPool) await ownedPool.end().catch(() => {});
  }
}

function parseArgs(argv) {
  const options = { apply: false, inspectSource: false, allowExistingTarget: false, sawApply: false, sawDryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') { options.apply = true; options.sawApply = true; }
    else if (argument === '--dry-run') { options.apply = false; options.sawDryRun = true; }
    else if (argument === '--inspect-source') options.inspectSource = true;
    else if (argument === '--source') options.source = argv[++index];
    else if (argument.startsWith('--source=')) options.source = argument.slice('--source='.length);
    else if (argument === '--allow-existing-target=append-only') options.allowExistingTarget = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else fail('ARGUMENT_INVALID', 'unknown cutover argument; use --help for the supported safe modes');
  }
  if (options.sawApply && options.sawDryRun) fail('ARGUMENT_CONFLICT', '--apply and --dry-run are mutually exclusive');
  if (options.inspectSource && options.apply) fail('ARGUMENT_CONFLICT', '--inspect-source cannot be combined with --apply');
  delete options.sawApply;
  delete options.sawDryRun;
  return options;
}

function usage() {
  return `PriceTruth SQLite -> Netlify Database cutover

Default (non-destructive target plan):
  npm run db:cutover -- --source=/absolute/path/pricetruth.db

Source-only inspection (no target connection):
  npm run db:cutover -- --inspect-source --source=/absolute/path/pricetruth.db

Apply to a fresh migrated target:
  npm run db:cutover -- --apply --source=/absolute/path/pricetruth.db

Append to a populated target (never updates/deletes existing rows):
  npm run db:cutover -- --allow-existing-target=append-only --source=/absolute/path/pricetruth.db
  npm run db:cutover -- --apply --allow-existing-target=append-only --source=/absolute/path/pricetruth.db

NETLIFY_DB_URL supplies the target. Output contains counts only, never row data.`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (options.inspectSource) {
    const inspected = inspectSqliteSource(options.source);
    safeLogSummary(console.log, 'source validated (inspection only)', inspected.counts);
    console.log('No target was contacted and no data was changed.');
    return;
  }
  const result = await cutoverSqliteToNetlify({
    source: options.source,
    apply: options.apply,
    allowExistingTarget: options.allowExistingTarget,
    logger: console.log,
  });
  console.log(result.applied
    ? 'Cutover complete. Keep the source snapshot until production verification and the rollback window are complete.'
    : 'Plan complete. No target data was changed; rerun with --apply only after reviewing this plan and taking a target snapshot.');
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  main().catch((error) => {
    const code = error instanceof CutoverError ? error.code : 'CUTOVER_FAILED';
    const message = error instanceof CutoverError ? error.message : 'the cutover failed safely';
    console.error(`Cutover failed [${code}]: ${message}`);
    process.exitCode = 1;
  });
}
