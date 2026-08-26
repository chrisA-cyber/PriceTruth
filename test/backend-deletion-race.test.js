import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { open } from '../src/db.js';
import { createApp } from '../src/server.js';

function privateProduct(db, accountId, id = 's-retail-private-race') {
  db.upsertProduct({
    id,
    vertical: 'retail',
    name: 'Private race report',
    advertised_cents: 1299,
    context: {},
    source: 'live:retail-feed',
    sourceLabel: 'Test retail feed',
    certainty: 'live',
    fetchedAt: new Date().toISOString(),
    visibility: 'private',
    ownerAccountId: accountId,
    evidence: {
      originalQuery: 'private race report',
      providerIdentity: 'item-race',
      refreshable: true,
      provenance: { observed: true, stale: false, alertEligible: true },
    },
  });
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  if (!server.listening) return;
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  });
}

describe('private report deletion race defenses', () => {
  it('rejects an ownerless private row instead of coercing it to public', () => {
    const db = open(':memory:');
    try {
      assert.throws(() => db.upsertProduct({
        id: 's-retail-ownerless', vertical: 'retail', name: 'Secret query',
        advertised_cents: 100, visibility: 'private', evidence: {},
      }), /require an owner account/);
      assert.equal(db.getProduct('s-retail-ownerless'), null);
      assert.equal(db.getPublicProduct('s-retail-ownerless'), null);
    } finally {
      db.close();
    }
  });

  it('cancels queued refresh work when a private report or account is deleted', async () => {
    const priorWorker = process.env.DISABLE_WORKER;
    process.env.DISABLE_WORKER = '1';
    const app = await createApp({ dbPath: ':memory:' });
    try {
      const first = app.db.verifyAccount(app.db.getOrCreateAccount('delete-report@example.test').id);
      privateProduct(app.db, first.id, 's-retail-delete-report');
      const reportJob = app.db.enqueueJob('collect-product', {
        productId: 's-retail-delete-report', vertical: 'retail', q: 'private race report',
      }, { idempotencyKey: 'delete-report-race' });
      assert.equal(app.db.deletePrivateProduct(first.id, 's-retail-delete-report'), true);
      assert.equal(app.db.raw.prepare('SELECT status,payload_json FROM jobs WHERE id=?').get(reportJob.id).status, 'canceled');

      const second = app.db.verifyAccount(app.db.getOrCreateAccount('delete-account@example.test').id);
      privateProduct(app.db, second.id, 's-retail-delete-account');
      const accountJob = app.db.enqueueJob('collect-product', {
        productId: 's-retail-delete-account', vertical: 'retail', q: 'private race report',
      }, { idempotencyKey: 'delete-account-race' });
      assert.equal(app.db.deleteAccount(second.id), true);
      assert.equal(app.db.raw.prepare('SELECT status,payload_json FROM jobs WHERE id=?').get(accountJob.id).status, 'canceled');

      assert.deepEqual(await app.worker.tick(), []);
      assert.equal(app.db.getProduct('s-retail-delete-report'), null);
      assert.equal(app.db.getProduct('s-retail-delete-account'), null);
      assert.equal(app.db.getPublicProduct('s-retail-delete-report'), null);
      assert.equal(app.db.getPublicProduct('s-retail-delete-account'), null);
    } finally {
      app.server.close();
      app.db.close();
      if (priorWorker === undefined) delete process.env.DISABLE_WORKER;
      else process.env.DISABLE_WORKER = priorWorker;
    }
  });

  it('rechecks ownership after an awaited provider call before persisting', async () => {
    let releaseResponse;
    let markRequested;
    const requested = new Promise((resolve) => { markRequested = resolve; });
    const release = new Promise((resolve) => { releaseResponse = resolve; });
    const upstream = http.createServer((req, res) => {
      markRequested();
      release.then(() => {
        const body = JSON.stringify({ id: 'item-race', name: 'Private race report', price_cents: 1099, currency: 'USD' });
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
        res.end(body);
      });
    });
    const upstreamBase = await listen(upstream);
    const saved = {
      DISABLE_WORKER: process.env.DISABLE_WORKER,
      RETAIL_API_URL: process.env.RETAIL_API_URL,
      PROVIDER_QUERY_CACHE_SECONDS: process.env.PROVIDER_QUERY_CACHE_SECONDS,
    };
    process.env.DISABLE_WORKER = '1';
    process.env.RETAIL_API_URL = `${upstreamBase}/lookup`;
    process.env.PROVIDER_QUERY_CACHE_SECONDS = '1';
    const app = await createApp({ dbPath: ':memory:' });
    try {
      const account = app.db.verifyAccount(app.db.getOrCreateAccount('in-flight-delete@example.test').id);
      privateProduct(app.db, account.id);
      const job = app.db.enqueueJob('collect-product', {
        productId: 's-retail-private-race', vertical: 'retail', q: 'private race report',
      }, { idempotencyKey: 'in-flight-delete-race' });

      const tick = app.worker.tick();
      await requested;
      assert.equal(app.db.deletePrivateProduct(account.id, 's-retail-private-race'), true);
      releaseResponse();
      const result = await tick;

      assert.equal(result[0].status, 'canceled');
      assert.equal(app.db.raw.prepare('SELECT status FROM jobs WHERE id=?').get(job.id).status, 'canceled');
      assert.equal(app.db.getProduct('s-retail-private-race'), null);
      assert.equal(app.db.getPublicProduct('s-retail-private-race'), null);
    } finally {
      releaseResponse?.();
      app.server.close();
      app.db.close();
      await close(upstream);
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
