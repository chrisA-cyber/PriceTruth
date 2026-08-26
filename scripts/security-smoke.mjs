import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/server.js';

const originalLog = console.log;
console.log = () => {};
const originalDisableWorker = process.env.DISABLE_WORKER;
process.env.DISABLE_WORKER = '1';
const { server, db } = await createApp({ dbPath: ':memory:' });
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const base = `http://127.0.0.1:${server.address().port}`;

try {
  const health = await fetch(`${base}/api/health`, { headers: { Origin: 'https://attacker.invalid' } });
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('access-control-allow-origin'), null);
  assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
  assert.match(health.headers.get('content-security-policy') || '', /default-src/);
  assert.equal(health.headers.get('cache-control'), 'no-store');
  assert.equal(health.headers.get('server'), null);

  const traversal = await fetch(`${base}/..%2fpackage.json`);
  assert.ok([403, 404].includes(traversal.status));
  assert.doesNotMatch(await traversal.text(), /"name"\s*:\s*"pricetruth"/);

  const malformed = await fetch(`${base}/api/analyze`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"broken":' });
  assert.equal(malformed.status, 400);
  assert.doesNotMatch(await malformed.text(), /(?:node:|at\s+\w+\s*\(|[A-Z]:\\)/);

  // The body reader deliberately destroys an over-limit socket immediately.
  // Depending on timing, a client may receive 413 or a reset; both prove the
  // server stopped accepting bytes. Use node:http so an intentional reset does
  // not leave an undici keep-alive handle racing shutdown on Windows.
  const target = new URL('/api/analyze', base);
  const oversized = await new Promise((resolve, reject) => {
    const req = http.request(target, { method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' } }, (response) => {
      response.resume();
      response.on('end', () => resolve({ status: response.statusCode, reset: false }));
    });
    req.on('error', (error) => {
      if (['ECONNRESET', 'EPIPE'].includes(error.code)) resolve({ status: null, reset: true });
      else reject(error);
    });
    req.end(JSON.stringify({ junk: 'x'.repeat(35_000) }));
  });
  assert.ok(oversized.status === 413 || oversized.reset, `unexpected oversized-body outcome: ${JSON.stringify(oversized)}`);

  const noKey = await fetch(`${base}/api/v1/usage`);
  assert.equal(noKey.status, 401);
  console.log = originalLog;
  console.log('Security smoke passed: headers, origin isolation, traversal, body limits, safe errors, and API auth.');
} finally {
  console.log = originalLog;
  await new Promise((resolve) => server.close(resolve));
  server.closeAllConnections();
  await db.close();
  if (originalDisableWorker === undefined) delete process.env.DISABLE_WORKER;
  else process.env.DISABLE_WORKER = originalDisableWorker;
}
