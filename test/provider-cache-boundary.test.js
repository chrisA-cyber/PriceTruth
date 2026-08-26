import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createApp } from '../src/server.js';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

async function close(server) {
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  });
}

function search(base, vertical, q) {
  return fetch(`${base}/api/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ vertical, q }),
  });
}

describe('provider cache fail-closed boundary', () => {
  it('does not serve a cached live quote after its source configuration is removed', async () => {
    let upstreamCalls = 0;
    const upstream = http.createServer((_req, res) => {
      upstreamCalls += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'sku-cache-1', name: 'Cached product', price_cents: 12999, currency: 'USD' }));
    });
    const upstreamBase = await listen(upstream);
    const saved = { url: process.env.RETAIL_API_URL, ttl: process.env.PROVIDER_QUERY_CACHE_SECONDS };
    process.env.RETAIL_API_URL = `${upstreamBase}/lookup`;
    process.env.PROVIDER_QUERY_CACHE_SECONDS = '3600';
    const app = createApp({ dbPath: ':memory:' });
    const base = await listen(app.server);
    try {
      assert.equal((await search(base, 'retail', 'cached product')).status, 200);
      delete process.env.RETAIL_API_URL;
      const rejected = await search(base, 'retail', 'cached product');
      assert.equal(rejected.status, 422);
      assert.equal((await rejected.json()).code, 'PRICE_SOURCE_UNAVAILABLE');
      assert.equal(upstreamCalls, 1);
    } finally {
      await close(app.server);
      app.db.close();
      await close(upstream);
      if (saved.url === undefined) delete process.env.RETAIL_API_URL;
      else process.env.RETAIL_API_URL = saved.url;
      if (saved.ttl === undefined) delete process.env.PROVIDER_QUERY_CACHE_SECONDS;
      else process.env.PROVIDER_QUERY_CACHE_SECONDS = saved.ttl;
    }
  });

  it('does not serve a cached catalog result after the freshness window expires', async () => {
    const realNow = Date.now;
    const savedAge = process.env.SUBSCRIPTION_CATALOG_MAX_AGE_DAYS;
    const savedTtl = process.env.PROVIDER_QUERY_CACHE_SECONDS;
    process.env.SUBSCRIPTION_CATALOG_MAX_AGE_DAYS = '93';
    process.env.PROVIDER_QUERY_CACHE_SECONDS = '3600';
    Date.now = () => Date.parse('2026-08-26T12:00:00.000Z');
    const app = createApp({ dbPath: ':memory:' });
    const base = await listen(app.server);
    try {
      assert.equal((await search(base, 'subscription', 'netflix')).status, 200);
      process.env.SUBSCRIPTION_CATALOG_MAX_AGE_DAYS = '1';
      Date.now = () => Date.parse('2026-08-27T00:00:01.000Z');
      const rejected = await search(base, 'subscription', 'netflix');
      assert.equal(rejected.status, 424);
      assert.equal((await rejected.json()).code, 'PRICE_SOURCE_FAILED');
    } finally {
      Date.now = realNow;
      await close(app.server);
      app.db.close();
      if (savedAge === undefined) delete process.env.SUBSCRIPTION_CATALOG_MAX_AGE_DAYS;
      else process.env.SUBSCRIPTION_CATALOG_MAX_AGE_DAYS = savedAge;
      if (savedTtl === undefined) delete process.env.PROVIDER_QUERY_CACHE_SECONDS;
      else process.env.PROVIDER_QUERY_CACHE_SECONDS = savedTtl;
    }
  });
});
