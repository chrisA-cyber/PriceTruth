import assert from 'node:assert/strict';
import test from 'node:test';

import { invokeNodeHandler } from '../netlify/lib/node-http-bridge.mjs';
import { createApp } from '../src/server.js';

function readAll(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

test('Netlify bridge preserves the exact body, route, trusted client context, and Set-Cookie multiplicity', async () => {
  const rawBody = Buffer.from([0, 1, 2, 127, 128, 254, 255]);
  const request = new Request('https://pricetruth.netlify.app/api/webhook?attempt=2', {
    method: 'POST',
    headers: {
      cookie: 'pt_session=session-value; pt_csrf=csrf-value',
      'content-type': 'application/octet-stream',
      'x-forwarded-for': '203.0.113.200',
    },
    body: rawBody,
  });

  const response = await invokeNodeHandler(request, {
    ip: '2001:db8::42',
    requestId: 'netlify-request-id',
  }, async (req, res) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/api/webhook?attempt=2');
    assert.equal(req.headers.cookie, 'pt_session=session-value; pt_csrf=csrf-value');
    assert.equal(req.headers.host, 'pricetruth.netlify.app');
    assert.equal(req.headers['x-forwarded-host'], 'pricetruth.netlify.app');
    assert.equal(req.headers['x-forwarded-proto'], 'https');
    assert.equal(req.headers['x-forwarded-for'], '2001:db8::42');
    assert.equal(req.headers['x-request-id'], 'netlify-request-id');
    assert.equal(req.socket.remoteAddress, '2001:db8::42');
    assert.deepEqual(await readAll(req), rawBody);
    res.setHeader('Set-Cookie', [
      'pt_session=one; Path=/; HttpOnly; Secure; SameSite=Lax',
      'pt_csrf=two; Path=/; Secure; SameSite=Strict',
    ]);
    res.writeHead(201, { 'Content-Type': 'application/octet-stream' });
    res.end(rawBody);
  });

  assert.equal(response.status, 201);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), rawBody);
  assert.deepEqual(response.headers.getSetCookie(), [
    'pt_session=one; Path=/; HttpOnly; Secure; SameSite=Lax',
    'pt_csrf=two; Path=/; Secure; SameSite=Strict',
  ]);
});

test('Netlify bridge runs the real handler, including buffered and streamed responses', async () => {
  const app = await createApp({ dbPath: ':memory:', startTimers: false });
  try {
    assert.equal(typeof app.handle, 'function');
    assert.equal(typeof app.runMaintenance, 'function');
    assert.equal(typeof app.scheduleWorkerJobs, 'function');
    assert.equal(typeof app.drainWorkerQueues, 'function');
    assert.equal(typeof app.runWorkerCycle, 'function');

    const context = { ip: '127.0.0.1', requestId: 'bridge-integration' };
    const health = await invokeNodeHandler(
      new Request('http://localhost:4780/api/health'), context, app.handle,
    );
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);

    const analyze = await invokeNodeHandler(new Request('http://localhost:4780/api/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ vertical: 'flight', advertised_cents: 5900, context: { carrier: 'spirit' } }),
    }), context, app.handle);
    assert.equal(analyze.status, 200);
    assert.equal(Number.isInteger((await analyze.json()).truePrice.amount_cents), true);

    const css = await invokeNodeHandler(
      new Request('http://localhost:4780/styles.css'), context, app.handle,
    );
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type'), /^text\/css/);
    assert.match(await css.text(), /:root/);
  } finally {
    app.db.close();
  }
});

test('Netlify bridge preserves HEAD response metadata without emitting a body', async () => {
  const response = await invokeNodeHandler(
    new Request('https://pricetruth.netlify.app/download/extension.zip', { method: 'HEAD' }),
    { ip: '192.0.2.10' },
    async (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': '3' });
      res.end(Buffer.from('zip'));
    },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-length'), '3');
  assert.equal((await response.arrayBuffer()).byteLength, 0);
});

test('Netlify bridge streams request bodies into the bounded application parser', async () => {
  const app = await createApp({ dbPath: ':memory:', startTimers: false });
  try {
    let emitted = 0;
    const request = new Request('https://pricetruth.netlify.app/api/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: new ReadableStream({
        pull(controller) {
          if (emitted >= 40) return controller.close();
          emitted += 1;
          controller.enqueue(new Uint8Array(1024).fill(0x20));
        },
      }),
      duplex: 'half',
    });
    Object.defineProperty(request, 'arrayBuffer', {
      value: async () => { throw new Error('bridge must not pre-buffer the Fetch body'); },
    });

    const response = await invokeNodeHandler(request, { ip: '192.0.2.20' }, app.handle);
    assert.equal(response.status, 413);
    assert.match((await response.json()).error, /body exceeds 32768 bytes/);
  } finally {
    await app.db.close();
  }
});
