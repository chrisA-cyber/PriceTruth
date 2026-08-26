import assert from 'node:assert/strict';

const arg = process.argv.find((value) => value.startsWith('--base-url='));
const supplied = String(arg ? arg.slice('--base-url='.length) : process.env.PUBLIC_BASE_URL || '');
if (!supplied) throw new Error('set PUBLIC_BASE_URL or pass --base-url=https://deployment-origin');
const parsed = new URL(supplied);
const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname);
if (parsed.protocol !== 'https:' && !local) throw new Error('remote post-deploy checks require HTTPS');
const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
const reserved = ['test', 'example', 'invalid', 'local', 'internal', 'lan'].some((suffix) => host === suffix || host.endsWith(`.${suffix}`)) ||
  ['example.com', 'example.net', 'example.org'].some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
if (!local && (reserved || !host.includes('.') || /^\d+(?:\.\d+){3}$/.test(host) || host.includes(':'))) {
  throw new Error('remote post-deploy checks require a public non-reserved hostname');
}
if (parsed.username || parsed.password || !['', '/'].includes(parsed.pathname) || parsed.search || parsed.hash) {
  throw new Error('post-deploy base URL must be an origin with no credentials, path, query, or fragment');
}
const base = parsed.origin;

async function json(path, init) {
  const response = await fetch(base + path, { signal: AbortSignal.timeout(10_000), ...init });
  const body = await response.json().catch(() => null);
  return { response, body };
}

const health = await json('/api/health');
assert.equal(health.response.status, 200, 'liveness failed');
assert.equal(health.body?.ok, true, 'liveness body did not report ok');
assert.equal(health.response.headers.get('x-content-type-options'), 'nosniff');
assert.equal(health.response.headers.get('cache-control'), 'no-store');
if (!local) assert.match(health.response.headers.get('strict-transport-security') || '', /max-age=/);

const ready = await json('/api/ready');
assert.equal(ready.response.status, 200, `readiness failed: ${JSON.stringify(ready.body)}`);

const analysis = await json('/api/analyze', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ vertical: 'subscription', advertised_cents: 999, context: { pattern: 'streaming' } }),
});
assert.equal(analysis.response.status, 200);
assert.ok(Number.isInteger(analysis.body?.truePrice?.amount_cents));
console.log(`Post-deploy verification passed for ${base}: live, ready, secure headers, and analysis probe.`);
