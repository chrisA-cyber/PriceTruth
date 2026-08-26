import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { getDatabase } from '@netlify/database';
import { NetlifyDB } from '@netlify/database-dev';
import { open } from '../src/db.js';
import { CutoverError, cutoverSqliteToNetlify, inspectSqliteSource } from '../scripts/migrate-sqlite-to-netlify.mjs';

const migrations = fileURLToPath(new URL('../netlify/database/migrations', import.meta.url));
const baselineMigration = fs.readFileSync(
  fileURLToPath(new URL('../netlify/database/migrations/20260826000000_pricetruth_baseline/migration.sql', import.meta.url)),
  'utf8',
);
const NOW = new Date('2026-08-26T12:00:00.000Z');

function buildFixture(source) {
  const db = open(source);
  const account = db.getOrCreateAccount('private-cutover@example.com');
  db.verifyAccount(account.id);
  db.upsertProduct({
    id: 'cutover-product', vertical: 'retail', name: 'Cutover product',
    advertised_cents: 12500, source: 'fixture', evidence: { preserved: true },
  });
  db.raw.prepare(`INSERT INTO price_points(
    id,product_id,ts,advertised_cents,true_cents,source,source_label,certainty,
    observed,alert_eligible,fetched_at,evidence_json,provider_key
  ) VALUES(500,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'cutover-product', '2026-08-25T12:00:00.000Z', 12500, 13900, 'fixture',
    'Fixture', 'observed', 1, 1, '2026-08-25T12:00:00.000Z',
    '{"receipt":"encrypted-elsewhere"}', 'fixture-observation',
  );
  db.raw.prepare(`INSERT INTO entitlements(
    id,account_id,product,status,source,source_ref,current_period_end,
    cancel_at_period_end,metadata_json,created_at,updated_at,provider_event_created
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'ent_cutover', account.id, 'premium', 'active', 'stripe', 'sub_cutover', null,
    0, '{"preserve":true}', NOW.toISOString(), NOW.toISOString(), 100,
  );
  const insertAlert = db.raw.prepare(`INSERT INTO alerts(
    id,email,product_id,threshold_cents,created_at,account_id,status,updated_at,
    condition_active
  ) VALUES(?,?,?,?,?,?,?,?,0)`);
  insertAlert.run(40, account.email, 'cutover-product', 12000, '2026-08-20T00:00:00.000Z', account.id, 'active', NOW.toISOString());
  insertAlert.run(41, account.email, 'cutover-product', 11000, '2026-08-21T00:00:00.000Z', account.id, 'paused', NOW.toISOString());

  const insertAuth = db.raw.prepare(`INSERT INTO auth_tokens(
    id,account_id,purpose,token_hash,expires_at,consumed_at,created_at
  ) VALUES(?,?,?,?,?,?,?)`);
  insertAuth.run('auth_one', account.id, 'login', 'a'.repeat(64), '2026-08-26T13:00:00.000Z', null, '2026-08-26T10:00:00.000Z');
  insertAuth.run('auth_two', account.id, 'login', 'b'.repeat(64), '2026-08-26T14:00:00.000Z', null, '2026-08-26T11:00:00.000Z');
  insertAuth.run('auth_expired', account.id, 'login', 'c'.repeat(64), '2026-08-26T11:00:00.000Z', null, '2026-08-26T09:00:00.000Z');

  const insertKey = db.raw.prepare(`INSERT INTO api_keys(
    id,key_hash,label,tier,revoked,created_at,owner_email,owner_account_id,prefix,
    replaced_by_id,updated_at,can_write_history,suspended
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  insertKey.run(701, 'e'.repeat(64), 'replacement', 'starter', 0, NOW.toISOString(), account.email, account.id, 'pt_live_e', null, NOW.toISOString(), 0, 0);
  insertKey.run(700, 'd'.repeat(64), 'original', 'starter', 1, NOW.toISOString(), account.email, account.id, 'pt_live_d', 701, NOW.toISOString(), 0, 0);
  db.raw.prepare('INSERT INTO api_usage(key_id,day,count) VALUES(?,?,?),(?,?,?)')
    .run(700, '2026-08-26', 3, 701, '2026-08-26', 5);

  db.raw.prepare(`INSERT INTO pending_keys(
    session_id,raw_key,tier,created_at,account_id,key_iv,key_tag
  ) VALUES(?,?,?,?,?,?,?)`).run(
    'checkout_cutover', 'ciphertext-key-material', 'starter', NOW.toISOString(),
    account.id, 'pending-iv', 'pending-tag',
  );
  db.raw.prepare(`INSERT INTO outbox(
    id,account_id,to_email,template,payload_ciphertext,payload_iv,payload_tag,
    metadata_json,status,attempts,max_attempts,available_at,leased_until,
    idempotency_key,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'out_cutover', account.id, account.email, 'login', 'mail-ciphertext',
    'mail-iv', 'mail-tag', '{"preserved":true}', 'sending', 1, 5,
    NOW.toISOString(), '2026-08-26T12:05:00.000Z', 'mail-cutover',
    NOW.toISOString(), NOW.toISOString(),
  );
  db.raw.prepare(`INSERT INTO jobs(
    id,type,payload_json,status,attempts,max_attempts,available_at,leased_until,
    idempotency_key,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
    'job_cutover', 'collect-product', JSON.stringify({ productId: 'cutover-product' }),
    'running', 1, 5, NOW.toISOString(), '2026-08-26T12:05:00.000Z',
    'job-cutover', NOW.toISOString(), NOW.toISOString(),
  );
  db.raw.prepare(`INSERT INTO billing_events(
    id,ts,type,email,plan,amount_cents,currency,livemode,stripe_ref,account_id,
    status,payload_json
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    600, NOW.toISOString(), 'invoice.paid', account.email, 'premium', 990,
    'usd', 1, 'evt_cutover', account.id, 'applied', '{"objectId":"inv_cutover"}',
  );
  db.raw.prepare(`INSERT INTO provider_usage(
    day,provider,calls,failures,consecutive_failures,updated_at
  ) VALUES(?,?,?,?,?,?)`).run('2026-08-26', 'fixture-provider', 7, 1, 0, NOW.toISOString());
  // A deleted historical row can leave SQLite's sequence above MAX(id). The
  // cutover must preserve that high-water mark and never reuse the old ID.
  db.raw.prepare("UPDATE sqlite_sequence SET seq=900 WHERE name='price_points'").run();
  db.raw.close();
  return account;
}

test('SQLite cutover plans safely, preserves exact values, backfills quotas, and reconciles', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pricetruth-cutover-'));
  const source = path.join(directory, 'source.db');
  const account = buildFixture(source);
  const local = new NetlifyDB({ logger: () => {} });
  const connectionString = await local.start();
  await local.applyMigrations(migrations);
  t.after(async () => {
    await local.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const logs = [];
  const plan = await cutoverSqliteToNetlify({
    source, connectionString, now: NOW, logger: (message) => logs.push(message),
  });
  assert.equal(plan.applied, false);
  assert.equal(plan.sourceCounts.accounts, 1);

  let pool = getDatabase({ connectionString }).pool;
  assert.equal(Number((await pool.query('SELECT COUNT(*) AS count FROM accounts')).rows[0].count), 0);
  await pool.end();

  const applied = await cutoverSqliteToNetlify({
    source, connectionString, apply: true, now: NOW, logger: (message) => logs.push(message),
  });
  assert.equal(applied.applied, true);

  pool = getDatabase({ connectionString }).pool;
  const jsonConstraints = (await pool.query(`SELECT conname FROM pg_constraint
    WHERE conname LIKE '%_json_object' ORDER BY conname`)).rows.map((row) => row.conname);
  assert.deepEqual(jsonConstraints, [
    'account_terms_acceptances_context_json_object',
    'billing_events_payload_json_object',
    'billing_reconciliation_payload_json_object',
    'delivery_events_payload_json_object',
    'entitlements_metadata_json_object',
    'jobs_payload_json_object',
    'outbox_metadata_json_object',
    'price_points_evidence_json_object',
    'products_context_json_object',
    'products_evidence_json_object',
  ]);
  await assert.rejects(pool.query("UPDATE products SET evidence_json='not-json' WHERE id='cutover-product'"));
  await assert.rejects(pool.query("UPDATE products SET context_json='[]' WHERE id='cutover-product'"));
  const alertSlots = await pool.query('SELECT id,quota_slot FROM alerts ORDER BY id');
  assert.deepEqual(alertSlots.rows, [{ id: 40, quota_slot: 1 }, { id: 41, quota_slot: 2 }]);
  const authSlots = await pool.query('SELECT id,quota_slot FROM auth_tokens ORDER BY id');
  assert.deepEqual(authSlots.rows, [
    { id: 'auth_expired', quota_slot: null },
    { id: 'auth_one', quota_slot: 1 },
    { id: 'auth_two', quota_slot: 2 },
  ]);
  assert.equal((await pool.query('SELECT count FROM account_api_usage WHERE account_id=$1 AND day=$2', [account.id, '2026-08-26'])).rows[0].count, 8);
  assert.equal((await pool.query('SELECT replaced_by_id FROM api_keys WHERE id=700')).rows[0].replaced_by_id, 701);
  assert.deepEqual((await pool.query('SELECT payload_ciphertext,payload_iv,payload_tag,status,leased_until,lease_token FROM outbox WHERE id=$1', ['out_cutover'])).rows[0], {
    payload_ciphertext: 'mail-ciphertext', payload_iv: 'mail-iv', payload_tag: 'mail-tag',
    status: 'sending', leased_until: '2026-08-26T12:05:00.000Z', lease_token: null,
  });
  assert.deepEqual((await pool.query('SELECT status,leased_until,lease_token FROM jobs WHERE id=$1', ['job_cutover'])).rows[0], {
    status: 'running', leased_until: '2026-08-26T12:05:00.000Z', lease_token: null,
  });
  const nextPoint = await pool.query(`INSERT INTO price_points(
    product_id,ts,advertised_cents,true_cents
  ) VALUES('cutover-product','2026-08-26T13:00:00.000Z',1,1) RETURNING id`);
  assert.equal(nextPoint.rows[0].id, 901);
  await pool.end();

  assert.equal(logs.some((line) => line.includes(account.email)), false);
  assert.equal(logs.some((line) => line.includes('mail-ciphertext')), false);
  assert.equal(logs.some((line) => line.includes(source)), false);
  await assert.rejects(
    cutoverSqliteToNetlify({ source, connectionString, apply: true, now: NOW }),
    (error) => error instanceof CutoverError && error.code === 'TARGET_NOT_EMPTY',
  );
  await assert.rejects(
    cutoverSqliteToNetlify({ source, connectionString, apply: true, allowExistingTarget: true, now: NOW }),
    (error) => error instanceof CutoverError && error.code === 'TARGET_IMPORT_REJECTED',
  );
  pool = getDatabase({ connectionString }).pool;
  assert.equal(Number((await pool.query('SELECT COUNT(*) AS count FROM accounts')).rows[0].count), 1);
  await pool.end();
});

test('cutover CLI exits nonzero with a sanitized error', () => {
  const missing = path.join(os.tmpdir(), 'private-person-name', 'missing.db');
  const script = fileURLToPath(new URL('../scripts/migrate-sqlite-to-netlify.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, '--inspect-source', `--source=${missing}`], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Cutover failed \[SOURCE_NOT_FOUND\]/);
  assert.equal(result.stderr.includes(missing), false);
});

test('append-only cutover preserves an existing target identity high-water mark', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pricetruth-cutover-sequence-'));
  const source = path.join(directory, 'source.db');
  buildFixture(source);
  const local = new NetlifyDB({ logger: () => {} });
  const connectionString = await local.start();
  await local.applyMigrations(migrations);
  t.after(async () => {
    await local.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  let pool = getDatabase({ connectionString }).pool;
  await pool.query('ALTER TABLE price_points ALTER COLUMN id RESTART WITH 1500');
  await pool.query(`INSERT INTO provider_usage(
    day,provider,calls,failures,consecutive_failures,updated_at
  ) VALUES('2026-08-25','existing-target',1,0,0,$1)`, [NOW.toISOString()]);
  await pool.end();

  await cutoverSqliteToNetlify({
    source, connectionString, allowExistingTarget: true, now: NOW,
  });
  await cutoverSqliteToNetlify({
    source, connectionString, apply: true, allowExistingTarget: true, now: NOW,
  });

  pool = getDatabase({ connectionString }).pool;
  const nextPoint = await pool.query(`INSERT INTO price_points(
    product_id,ts,advertised_cents,true_cents
  ) VALUES('cutover-product','2026-08-26T13:30:00.000Z',2,2) RETURNING id`);
  assert.equal(nextPoint.rows[0].id, 1500);
  assert.equal(Number((await pool.query("SELECT COUNT(*) AS count FROM provider_usage WHERE provider='existing-target'")).rows[0].count), 1);
  await pool.end();
});

test('a collision in the last imported table rolls back every earlier insert', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pricetruth-cutover-late-rollback-'));
  const source = path.join(directory, 'source.db');
  buildFixture(source);
  const local = new NetlifyDB({ logger: () => {} });
  const connectionString = await local.start();
  await local.applyMigrations(migrations);
  t.after(async () => {
    await local.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  let pool = getDatabase({ connectionString }).pool;
  await pool.query(`INSERT INTO provider_usage(
    day,provider,calls,failures,consecutive_failures,updated_at
  ) VALUES('2026-08-26','fixture-provider',1,0,0,$1)`, [NOW.toISOString()]);
  await pool.end();
  await assert.rejects(
    cutoverSqliteToNetlify({ source, connectionString, apply: true, allowExistingTarget: true, now: NOW }),
    (error) => error instanceof CutoverError && error.code === 'TARGET_IMPORT_REJECTED',
  );
  pool = getDatabase({ connectionString }).pool;
  assert.equal(Number((await pool.query('SELECT COUNT(*) AS count FROM accounts')).rows[0].count), 0);
  assert.equal(Number((await pool.query('SELECT COUNT(*) AS count FROM products')).rows[0].count), 0);
  assert.equal(Number((await pool.query('SELECT COUNT(*) AS count FROM provider_usage')).rows[0].count), 1);
  await pool.end();
});

test('source validation rejects target-unique collisions before connecting', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pricetruth-cutover-invalid-'));
  const source = path.join(directory, 'source.db');
  const db = open(source);
  db.upsertProduct({ id: 'duplicate-product', vertical: 'retail', name: 'Duplicate', advertised_cents: 10 });
  const statement = db.raw.prepare(`INSERT INTO price_points(
    product_id,ts,advertised_cents,true_cents,source,provider_key
  ) VALUES(?,?,?,?,?,?)`);
  statement.run('duplicate-product', NOW.toISOString(), 10, 12, 'fixture', 'same');
  statement.run('duplicate-product', NOW.toISOString(), 10, 12, 'fixture', 'same');
  db.raw.close();
  try {
    assert.throws(
      () => inspectSqliteSource(source, { now: NOW }),
      (error) => error instanceof CutoverError && error.code === 'SOURCE_UNIQUE_MISMATCH',
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('source validation rejects pre-existing cross-plan checkout races without changing them', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pricetruth-cutover-checkouts-'));
  const source = path.join(directory, 'source.db');
  const db = open(source);
  const account = db.getOrCreateAccount('cross-plan-cutover@example.com');
  const insert = db.raw.prepare(`INSERT INTO checkout_intents(
    id,account_id,plan,idempotency_key,status,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?)`);
  insert.run('checkout_cross_premium', account.id, 'premium', 'idempotency-cross-premium', 'pending', NOW.toISOString(), NOW.toISOString());
  insert.run('checkout_cross_api', account.id, 'api_pro', 'idempotency-cross-api', 'awaiting_payment', NOW.toISOString(), NOW.toISOString());
  db.raw.close();
  try {
    assert.throws(
      () => inspectSqliteSource(source, { now: NOW }),
      (error) => error instanceof CutoverError && error.code === 'SOURCE_UNIQUE_MISMATCH',
    );
    const reopened = open(source);
    try {
      assert.equal(reopened.raw.prepare(`SELECT COUNT(*) count FROM checkout_intents
        WHERE status IN ('pending','awaiting_payment')`).get().count, 2,
      'inspection must not expire or delete either provider-authoritative intent');
    } finally { reopened.close(); }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('source JSON-object validation fails safely before opening the target', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pricetruth-cutover-json-'));
  const source = path.join(directory, 'source.db');
  let db = open(source);
  db.upsertProduct({ id: 'invalid-json-product', vertical: 'retail', name: 'Invalid JSON', advertised_cents: 10 });
  db.raw.prepare('UPDATE products SET evidence_json=? WHERE id=?')
    .run('private-malformed-json-value', 'invalid-json-product');
  db.raw.close();
  let targetConnections = 0;
  const unreachablePool = {
    async connect() {
      targetConnections += 1;
      throw new Error('the target must not be contacted');
    },
  };
  try {
    await assert.rejects(
      cutoverSqliteToNetlify({ source, pool: unreachablePool, now: NOW }),
      (error) => error instanceof CutoverError && error.code === 'SOURCE_JSON_INVALID' &&
        /products\.evidence_json/.test(error.message) && !error.message.includes('private-malformed-json-value'),
    );
    assert.equal(targetConnections, 0);

    db = open(source);
    db.raw.prepare('UPDATE products SET evidence_json=?,context_json=? WHERE id=?')
      .run('{}', '[]', 'invalid-json-product');
    db.raw.close();
    assert.throws(
      () => inspectSqliteSource(source, { now: NOW }),
      (error) => error instanceof CutoverError && error.code === 'SOURCE_JSON_INVALID' && /products\.context_json/.test(error.message),
    );
  } finally {
    try { db?.raw?.close(); } catch { /* already closed */ }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('exact schema contracts reject missing source and target indexes', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pricetruth-cutover-schema-'));
  const damagedSource = path.join(directory, 'damaged-source.db');
  let db = open(damagedSource);
  db.raw.exec('DROP INDEX idx_pp_product_ts');
  db.raw.close();
  assert.throws(
    () => inspectSqliteSource(damagedSource, { now: NOW }),
    (error) => error instanceof CutoverError && error.code === 'SOURCE_SCHEMA_CONTRACT',
  );

  const validSource = path.join(directory, 'valid-source.db');
  db = open(validSource);
  db.raw.close();
  const local = new NetlifyDB({ logger: () => {} });
  const connectionString = await local.start();
  await local.applyMigrations(migrations);
  t.after(async () => {
    await local.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const pool = getDatabase({ connectionString }).pool;
  await pool.query('DROP INDEX idx_alerts_account_quota_slot');
  await pool.end();
  await assert.rejects(
    cutoverSqliteToNetlify({ source: validSource, connectionString, now: NOW }),
    (error) => error instanceof CutoverError && error.code === 'TARGET_SCHEMA_CONTRACT',
  );
});

test('source contract rejects an identity table rebuilt without AUTOINCREMENT', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pricetruth-cutover-autoincrement-'));
  const source = path.join(directory, 'source.db');
  const db = open(source);
  db.upsertProduct({ id: 'historical-product', vertical: 'retail', name: 'Historical', advertised_cents: 1 });
  const createSql = db.raw.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='price_points'").get().sql;
  const indexSql = db.raw.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='price_points' AND sql IS NOT NULL ORDER BY name")
    .all().map((row) => row.sql);
  db.raw.exec(`
    ALTER TABLE price_points RENAME TO price_points_old;
    ${createSql.replace(/\bAUTOINCREMENT\b/i, '')};
    DROP TABLE price_points_old;
    ${indexSql.join(';')};
    INSERT INTO price_points(id,product_id,ts,advertised_cents,true_cents)
      VALUES(900,'historical-product','2026-08-20T00:00:00.000Z',1,1);
    DELETE FROM price_points WHERE id=900;
  `);
  assert.equal(db.raw.prepare("SELECT seq FROM sqlite_sequence WHERE name='price_points'").get(), undefined);
  db.raw.close();
  try {
    assert.throws(
      () => inspectSqliteSource(source, { now: NOW }),
      (error) => error instanceof CutoverError && error.code === 'SOURCE_SCHEMA_CONTRACT',
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('source inspection rejects 64-bit SQLite IDs that cannot fit the target identity', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pricetruth-cutover-id-range-'));
  const source = path.join(directory, 'source.db');
  const db = open(source);
  db.upsertProduct({ id: 'high-id-product', vertical: 'retail', name: 'High ID', advertised_cents: 1 });
  db.raw.prepare(`INSERT INTO price_points(
    id,product_id,ts,advertised_cents,true_cents
  ) VALUES(2147483648,'high-id-product',?,1,1)`).run(NOW.toISOString());
  db.raw.close();
  try {
    assert.throws(
      () => inspectSqliteSource(source, { now: NOW }),
      (error) => error instanceof CutoverError && error.code === 'SOURCE_ID_RANGE',
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('source contract accepts a logically equivalent legacy column order', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pricetruth-cutover-legacy-shape-'));
  const source = path.join(directory, 'source.db');
  const db = open(source);
  db.raw.exec(`
    ALTER TABLE provider_usage RENAME TO provider_usage_old;
    CREATE TABLE provider_usage(
      updated_at TEXT NOT NULL,
      circuit_open_until TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      failures INTEGER NOT NULL DEFAULT 0,
      calls INTEGER NOT NULL DEFAULT 0,
      provider TEXT NOT NULL,
      day TEXT NOT NULL,
      PRIMARY KEY(day,provider)
    );
    INSERT INTO provider_usage(updated_at,circuit_open_until,consecutive_failures,failures,calls,provider,day)
      SELECT updated_at,circuit_open_until,consecutive_failures,failures,calls,provider,day FROM provider_usage_old;
    DROP TABLE provider_usage_old;
  `);
  db.raw.close();
  try {
    assert.equal(inspectSqliteSource(source, { now: NOW }).schemaVersion, 4);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('target contract is independent of the Postgres application schema name', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pricetruth-cutover-nonpublic-'));
  const source = path.join(directory, 'source.db');
  const db = open(source);
  db.raw.close();
  const local = new NetlifyDB({ logger: () => {} });
  const connectionString = await local.start();
  const basePool = getDatabase({ connectionString }).pool;
  const setup = await basePool.connect();
  await setup.query('CREATE SCHEMA pricetruth_application');
  await setup.query('SET search_path TO pricetruth_application');
  await setup.query(baselineMigration);
  setup.release();
  const scopedPool = {
    async connect() {
      const client = await basePool.connect();
      await client.query('SET search_path TO pricetruth_application');
      return client;
    },
  };
  t.after(async () => {
    await basePool.end();
    await local.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const result = await cutoverSqliteToNetlify({ source, pool: scopedPool, now: NOW });
  assert.equal(result.applied, false);
});
