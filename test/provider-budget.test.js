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

describe('provider request budget', () => {
  it('charges an upstream no-match without counting it as a circuit failure', async () => {
    let upstreamCalls = 0;
    const upstream = http.createServer((_req, res) => {
      upstreamCalls += 1;
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
    const upstreamBase = await listen(upstream);

    const saved = {
      url: process.env.RETAIL_API_URL,
      budget: process.env.PROVIDER_DAILY_BUDGET_RETAIL,
    };
    process.env.RETAIL_API_URL = `${upstreamBase}/lookup`;
    process.env.PROVIDER_DAILY_BUDGET_RETAIL = '1';

    const app = createApp({ dbPath: ':memory:' });
    const base = await listen(app.server);
    try {
      const first = await fetch(`${base}/api/search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ vertical: 'retail', q: 'missing product' }),
      });
      assert.equal(first.status, 404);
      assert.equal((await first.json()).code, 'NO_VERIFIED_RESULT');

      const second = await fetch(`${base}/api/search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ vertical: 'retail', q: 'different missing product' }),
      });
      assert.equal(second.status, 429);
      assert.equal((await second.json()).code, 'PRICE_SOURCE_BUSY');
      assert.equal(upstreamCalls, 1, 'the exhausted budget must block the second upstream call');

      const usage = app.db.providerUsageToday().find((row) => row.provider === 'retail');
      assert.deepEqual(
        { calls: usage.calls, failures: usage.failures, consecutive: usage.consecutive_failures },
        { calls: 1, failures: 0, consecutive: 0 },
      );
    } finally {
      await close(app.server);
      app.db.close();
      await close(upstream);
      if (saved.url === undefined) delete process.env.RETAIL_API_URL;
      else process.env.RETAIL_API_URL = saved.url;
      if (saved.budget === undefined) delete process.env.PROVIDER_DAILY_BUDGET_RETAIL;
      else process.env.PROVIDER_DAILY_BUDGET_RETAIL = saved.budget;
    }
  });
});
