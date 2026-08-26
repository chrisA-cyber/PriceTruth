import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import { createApp } from '../src/server.js';
import { readJsonBody } from '../src/security.js';
import { httpJson } from '../src/providers/http.js';
import { signPayload } from '../src/billing.js';

async function startApp() {
  const created = createApp({ dbPath: ':memory:' });
  await new Promise((resolve, reject) => {
    created.server.once('error', reject);
    created.server.listen(0, '127.0.0.1', resolve);
  });
  return { ...created, base: `http://127.0.0.1:${created.server.address().port}` };
}

async function stopApp(app) {
  if (!app) return;
  await new Promise((resolve) => {
    app.server.close(resolve);
    app.server.closeAllConnections();
  });
  app.db.close();
}

function requestStream(headers = {}) {
  const stream = new PassThrough();
  stream.headers = headers;
  return stream;
}

describe('bounded client and provider JSON I/O', () => {
  it('distinguishes a slow JSON body (408) from declared and streamed oversize bodies (413)', async () => {
    const slow = requestStream();
    await assert.rejects(readJsonBody(slow, { timeoutMs: 20 }), (error) => error.status === 408);
    slow.destroy();

    const declared = requestStream({ 'content-length': '1000' });
    await assert.rejects(readJsonBody(declared, { limitBytes: 100 }), (error) => error.status === 413);
    declared.destroy();

    const streamed = requestStream();
    const bounded = readJsonBody(streamed, { limitBytes: 16, timeoutMs: 1000 });
    streamed.end(JSON.stringify({ value: 'x'.repeat(32) }));
    await assert.rejects(bounded, (error) => error.status === 413);

    const valid = requestStream();
    const parsed = readJsonBody(valid, { limitBytes: 100, timeoutMs: 1000 });
    valid.end('{"ok":true}');
    assert.deepEqual(await parsed, { ok: true });
  });

  it('caps streamed upstream responses before JSON parsing and reports 502', async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => new Response('x'.repeat(2048), { status: 200 });
      await assert.rejects(httpJson('https://feed.launch-operator.com/data', { maxResponseBytes: 1024 }), (error) =>
        error.status === 502 && error.code === 'UPSTREAM_PAYLOAD_TOO_LARGE');

      globalThis.fetch = async () => new Response('<html>not json</html>', { status: 200 });
      await assert.rejects(httpJson('https://feed.launch-operator.com/data'), (error) =>
        error.status === 502 && error.code === 'UPSTREAM_INVALID_JSON');

      globalThis.fetch = async (_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
      await assert.rejects(httpJson('https://feed.launch-operator.com/data', { timeoutMs: 20 }), (error) => error.status === 504);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('origin-derived discovery and webhook telemetry', () => {
  let app;
  let saved;

  before(async () => {
    saved = {
      DISABLE_WORKER: process.env.DISABLE_WORKER,
      PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
      STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
      RESEND_WEBHOOK_SECRET: process.env.RESEND_WEBHOOK_SECRET,
      WEBHOOK_BURST: process.env.WEBHOOK_BURST,
      WEBHOOK_REFILL_PER_SECOND: process.env.WEBHOOK_REFILL_PER_SECOND,
    };
    process.env.DISABLE_WORKER = '1';
    delete process.env.PUBLIC_BASE_URL;
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_io_telemetry_123456';
    process.env.RESEND_WEBHOOK_SECRET = 'io-telemetry-resend-secret-123456';
    process.env.WEBHOOK_BURST = '1';
    process.env.WEBHOOK_REFILL_PER_SECOND = '0.1';
    app = await startApp();
  });

  after(async () => {
    await stopApp(app);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('derives public metadata, robots, sitemap, canonical, and Open Graph URLs from the serving origin', async () => {
    const meta = await (await fetch(`${app.base}/api/meta`)).json();
    assert.equal(meta.publicBaseUrl, app.base);

    const robots = await (await fetch(`${app.base}/robots.txt`)).text();
    assert.match(robots, new RegExp(`Sitemap: ${app.base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/sitemap\\.xml`));
    assert.doesNotMatch(robots, /onrender\.com/);

    const sitemap = await (await fetch(`${app.base}/sitemap.xml`)).text();
    assert.match(sitemap, new RegExp(`<loc>${app.base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/pricing</loc>`));
    assert.doesNotMatch(sitemap, /onrender\.com/);

    const pricing = await (await fetch(`${app.base}/pricing`)).text();
    assert.match(pricing, new RegExp(`<link rel="canonical" href="${app.base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/pricing">`));
    assert.match(pricing, new RegExp(`<meta property="og:url" content="${app.base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/pricing">`));
    const account = await (await fetch(`${app.base}/account`)).text();
    assert.match(account, new RegExp(`<link rel="canonical" href="${app.base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/">`));
  });

  it('reports successful, signature-rejected, and route-budget-rejected webhooks without stale in-flight counts', async () => {
    const event = (id) => ({ id, type: 'invoice.created', livemode: false, created: Math.floor(Date.now() / 1000), data: { object: { id: `in_${id}` } } });
    const sendStripe = (value) => {
      const raw = JSON.stringify(value);
      return fetch(`${app.base}/api/billing/webhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'stripe-signature': signPayload(raw, process.env.STRIPE_WEBHOOK_SECRET) },
        body: raw,
      });
    };

    assert.equal((await sendStripe(event('evt_io_first'))).status, 200);
    assert.equal((await sendStripe(event('evt_io_budget'))).status, 503);
    const invalidEmail = await fetch(`${app.base}/api/email/webhook`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"type":"email.bounced"}',
    });
    assert.equal(invalidEmail.status, 400);

    const telemetry = (await (await fetch(`${app.base}/api/ready`)).json()).webhooks;
    assert.equal(telemetry.active, 0);
    assert.equal(telemetry.preauth.active, 0);
    assert.equal(telemetry.preauth.activeIpBuckets, 0);
    assert.equal(telemetry.verified, 2);
    assert.equal(telemetry.accepted, 1);
    assert.equal(telemetry.rejected, 2);
    assert.equal(telemetry.routes.billing.verified, 2);
    assert.equal(telemetry.routes.billing.accepted, 1);
    assert.equal(telemetry.routes.billing.rejected, 1);
    assert.equal(telemetry.routes.billing.rejections.budget, 1);
    assert.equal(telemetry.routes.email.verified, 0);
    assert.equal(telemetry.routes.email.accepted, 0);
    assert.equal(telemetry.routes.email.rejected, 1);
    assert.equal(telemetry.routes.email.rejections.signature, 1);
    assert.equal(telemetry.routes.billing.preauthActive, 0);
    assert.equal(telemetry.routes.email.preauthActive, 0);
    assert.equal(telemetry.routes.billing.preauthActiveIpBuckets, 0);
    assert.equal(telemetry.routes.email.preauthActiveIpBuckets, 0);
    assert.ok(telemetry.peakActive >= 1);
    assert.ok(telemetry.preauth.peakActive >= 1);
    assert.ok(telemetry.routes.billing.peakActive >= 1);
    assert.ok(telemetry.routes.billing.preauthPeak >= 1);
    assert.equal(telemetry.budget.perRouteBurst, 1);
  });
});
