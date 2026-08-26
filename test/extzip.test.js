// Tests for the hand-rolled ZIP writer (src/extzip.js) and the
// /download/extension.zip route that serves a per-origin extension bundle.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import { zip, crc32, prepareExtensionManifest } from '../src/extzip.js';
import { createApp } from '../src/server.js';

// --- Minimal ZIP reader (local headers only) so tests can verify the bytes we
// emit round-trip back to the exact input, without shelling out to unzip. ---
function readZip(buf) {
  const files = {};
  let off = 0;
  while (off + 4 <= buf.length && buf.readUInt32LE(off) === 0x04034b50) {
    const method = buf.readUInt16LE(off + 8);
    const compSize = buf.readUInt32LE(off + 18);
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const name = buf.toString('utf8', off + 30, off + 30 + nameLen);
    const dataStart = off + 30 + nameLen + extraLen;
    const comp = buf.subarray(dataStart, dataStart + compSize);
    const data = method === 0 ? comp : zlib.inflateRawSync(comp);
    files[name] = data.toString('utf8');
    off = dataStart + compSize;
  }
  return files;
}

function eocdCount(buf) {
  // EOCD signature is the last 22 bytes when there is no archive comment.
  const sig = buf.length - 22;
  assert.equal(buf.readUInt32LE(sig), 0x06054b50, 'EOCD signature present at expected offset');
  return buf.readUInt16LE(sig + 10); // total central-directory entries
}

describe('extzip: crc32', () => {
  it('matches known CRC-32 vectors', () => {
    assert.equal(crc32(Buffer.from('hello')), 0x3610a686);
    assert.equal(crc32(Buffer.from('')), 0x00000000);
    assert.equal(crc32(Buffer.from('The quick brown fox jumps over the lazy dog')), 0x414fa339);
  });
});

describe('extension release manifest', () => {
  it('removes fixture hosts and limits distributed seller access to HTTPS', () => {
    const source = { content_scripts: [{ matches: [
      '*://*.booking.com/*', '*://example.com/*', '*://*.example.com/*',
      '*://localhost/extension-demo.html*',
    ] }] };
    const release = prepareExtensionManifest(source, 'https://app.pricetruth.test');
    assert.deepEqual(release.content_scripts[0].matches, [
      'https://*.booking.com/*',
      'https://app.pricetruth.test/extension-demo.html*',
    ]);
    assert.equal(source.content_scripts[0].matches[0], '*://*.booking.com/*', 'source manifest is not mutated');
  });

  it('keeps the exact HTTP localhost demo only for a local download', () => {
    const release = prepareExtensionManifest({ content_scripts: [{ matches: ['*://example.com/*'] }] }, 'http://localhost:4780');
    assert.deepEqual(release.content_scripts[0].matches, ['http://localhost/extension-demo.html*']);
  });
});

describe('extzip: zip()', () => {
  it('starts with the local-file-header magic', () => {
    const buf = zip([{ name: 'a.txt', data: 'hello' }]);
    assert.equal(buf.readUInt32LE(0), 0x04034b50);
  });

  it('round-trips file names and contents through a real inflate', () => {
    const entries = [
      { name: 'dir/one.txt', data: 'first file\n' },
      { name: 'dir/two.json', data: JSON.stringify({ ok: true, n: 42 }) },
      { name: 'dir/big.txt', data: 'x'.repeat(50_000) },
    ];
    const files = readZip(zip(entries));
    assert.equal(files['dir/one.txt'], 'first file\n');
    assert.deepEqual(JSON.parse(files['dir/two.json']), { ok: true, n: 42 });
    assert.equal(files['dir/big.txt'], 'x'.repeat(50_000));
  });

  it('records the correct entry count in the EOCD', () => {
    const buf = zip([
      { name: 'a', data: '1' },
      { name: 'b', data: '2' },
      { name: 'c', data: '3' },
    ]);
    assert.equal(eocdCount(buf), 3);
  });

  it('is deterministic for identical input (stable per-origin cache)', () => {
    const mk = () => zip([{ name: 'x', data: 'same bytes' }]);
    assert.ok(mk().equals(mk()));
  });
});

describe('extzip: /download/extension.zip route', () => {
  let app;

  async function startApp() {
    const { server, db } = await createApp({ dbPath: ':memory:' });
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        resolve({ server, db, base: `http://127.0.0.1:${server.address().port}` });
      });
    });
  }

  before(async () => { app = await startApp(); });
  after(async () => {
    if (!app) return;
    await new Promise((r) => { app.server.close(r); app.server.closeAllConnections(); });
    await app.db.close();
  });

  it('serves a valid zip with attachment headers', async () => {
    const res = await fetch(app.base + '/download/extension.zip');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/zip');
    assert.match(res.headers.get('content-disposition') || '', /attachment/i);
    assert.match(res.headers.get('content-disposition') || '', /\.zip/i);

    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(buf.readUInt32LE(0), 0x04034b50, 'body is a real zip');

    const files = readZip(buf);
    const names = Object.keys(files);
    assert.ok(names.some((n) => n.endsWith('manifest.json')), 'bundle contains manifest.json');
    assert.ok(names.some((n) => n.endsWith('config.js')), 'bundle contains runtime config');
    assert.ok(names.some((n) => n.endsWith('adapters.js')), 'bundle contains seller adapters');
    assert.ok(names.some((n) => n.endsWith('content.js')), 'bundle contains content.js');
    assert.ok(names.some((n) => n.endsWith('icons/icon-128.png')), 'bundle contains store icon');
    const manifest = JSON.parse(files[names.find((n) => n.endsWith('manifest.json'))]);
    const matches = manifest.content_scripts.flatMap((item) => item.matches || []);
    assert.equal(matches.some((pattern) => /example\.com|localhost/i.test(pattern)), false, 'fixture hosts are stripped');
    assert.equal(matches.some((pattern) => pattern.startsWith('*://')), false, 'distributed matches use an explicit scheme');
    assert.ok(matches.some((pattern) => /^http:\/\/127\.0\.0\.1\/extension-demo/.test(pattern)), 'local bundle keeps only its exact demo host');
  });

  it('injects the requesting origin into the downloaded copy', async () => {
    const res = await fetch(app.base + '/download/extension.zip');
    const buf = Buffer.from(await res.arrayBuffer());
    const files = readZip(buf);
    const config = files[Object.keys(files).find((n) => n.endsWith('config.js'))];
    // Runtime configuration is isolated from content-script logic: the bundle
    // gets the requesting origin and demo host without mutating executable
    // detection code or leaving the development origin behind.
    assert.match(config, /appUrl: 'http:\/\/127\.0\.0\.1:\d+'/);
    assert.match(config, /demoHost: '127\.0\.0\.1'/);
    assert.doesNotMatch(config, /localhost:4780/);
  });
});
