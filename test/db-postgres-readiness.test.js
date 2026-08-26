import assert from 'node:assert/strict';
import test from 'node:test';

import { openPostgres } from '../src/db-postgres.js';

function instrumentedPool({ healthQuery } = {}) {
  const state = {
    healthQueries: 0,
    schemaQueries: 0,
    closed: false,
  };
  const pool = {
    state,
    async query(text) {
      if (text === 'SELECT 1 ok') {
        state.healthQueries += 1;
        if (healthQuery) return healthQuery(state.healthQueries);
        return { rows: [{ ok: 1 }], rowCount: 1 };
      }
      if (text.includes('FROM schema_migrations')) {
        state.schemaQueries += 1;
        return { rows: [{ version: 4 }], rowCount: 1 };
      }
      throw new Error(`unexpected readiness query: ${text}`);
    },
    async connect() {
      throw new Error('readiness probes must not reserve a transaction client');
    },
    async end() { state.closed = true; },
  };
  return pool;
}

test('Postgres readiness success and failure expire after the bounded cache TTL', async () => {
  let clock = 1_800_000_000_000;
  let available = true;
  const pool = instrumentedPool({
    healthQuery: async () => {
      if (!available) throw new Error('database unavailable');
      return { rows: [{ ok: 1 }], rowCount: 1 };
    },
  });
  const db = openPostgres({
    pool,
    readinessCacheTtlMs: 5_000,
    readinessClock: () => clock,
  });

  try {
    const initial = await db.checkReady();
    assert.equal(initial.ok, true);
    assert.equal(initial.checkedAt, new Date(clock).toISOString());
    assert.deepEqual([pool.state.healthQueries, pool.state.schemaQueries], [1, 1]);

    available = false;
    clock += 4_999;
    assert.equal((await db.checkReady()).ok, true, 'a fresh success may be reused briefly');
    assert.deepEqual([pool.state.healthQueries, pool.state.schemaQueries], [1, 1]);

    clock += 1;
    const unavailable = await db.checkReady();
    assert.equal(unavailable.ok, false, 'an expired success must not mask an outage');
    assert.equal(unavailable.schemaVersion, null);
    assert.deepEqual([pool.state.healthQueries, pool.state.schemaQueries], [2, 1]);

    available = true;
    clock += 4_999;
    assert.equal((await db.checkReady()).ok, false, 'a failure may also be reused only briefly');
    assert.deepEqual([pool.state.healthQueries, pool.state.schemaQueries], [2, 1]);

    clock += 1;
    assert.equal((await db.checkReady()).ok, true, 'an expired failure must recover automatically');
    assert.deepEqual([pool.state.healthQueries, pool.state.schemaQueries], [3, 2]);
    assert.equal((await db.readinessProbeStats()).integrityChecks, 3);
  } finally {
    await db.close();
  }
  assert.equal(pool.state.closed, true);
});

test('concurrent Postgres readiness callers share one in-flight live probe', async () => {
  let releaseHealth;
  let signalHealthStarted;
  const healthStarted = new Promise((resolve) => { signalHealthStarted = resolve; });
  const pool = instrumentedPool({
    healthQuery: () => new Promise((resolve) => {
      releaseHealth = resolve;
      signalHealthStarted();
    }),
  });
  const db = openPostgres({ pool, readinessCacheTtlMs: 5_000 });

  try {
    const checks = [
      db.checkReady(),
      db.checkReady(),
      db.checkReady({ force: true }),
      ...Array.from({ length: 9 }, () => db.checkReady()),
    ];
    await healthStarted;
    assert.equal(pool.state.healthQueries, 1);
    releaseHealth({ rows: [{ ok: 1 }], rowCount: 1 });

    const results = await Promise.all(checks);
    assert.equal(results.every((result) => result.ok), true);
    assert.equal(new Set(results.map((result) => result.checkedAt)).size, 1);
    assert.deepEqual([pool.state.healthQueries, pool.state.schemaQueries], [1, 1]);
    assert.equal((await db.readinessProbeStats()).integrityChecks, 1);
  } finally {
    await db.close();
  }
});
