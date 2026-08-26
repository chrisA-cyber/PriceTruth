import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createApp } from '../src/server.js';

const limitMs = Number(process.env.PERF_P95_MS || 500);
const originalLog = console.log;
console.log = () => {};
const { server, db } = createApp({ dbPath: ':memory:' });
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const base = `http://127.0.0.1:${server.address().port}`;

async function timed(url, init) {
  const start = performance.now();
  const response = await fetch(url, init);
  await response.arrayBuffer();
  assert.ok(response.ok, `${url} returned ${response.status}`);
  return performance.now() - start;
}
try {
  await timed(`${base}/api/health`);
  const healthSamples = [];
  for (let batch = 0; batch < 10; batch++) {
    healthSamples.push(...await Promise.all(Array.from({ length: 8 }, () => timed(`${base}/api/health`))));
  }
  const analyzeSamples = [];
  for (let i = 0; i < 12; i++) {
    analyzeSamples.push(await timed(`${base}/api/analyze`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ vertical: 'subscription', advertised_cents: 999, context: { pattern: 'streaming' } }),
    }));
  }
  const all = healthSamples.concat(analyzeSamples).sort((a, b) => a - b);
  const p95 = all[Math.ceil(all.length * 0.95) - 1];
  assert.ok(p95 <= limitMs, `p95 ${p95.toFixed(1)}ms exceeds ${limitMs}ms smoke budget`);
  console.log = originalLog;
  console.log(`Performance smoke passed: ${all.length} local HTTP samples, p95=${p95.toFixed(1)}ms (budget ${limitMs}ms).`);
} finally {
  console.log = originalLog;
  await new Promise((resolve) => server.close(resolve));
  server.closeAllConnections();
  db.close();
}
