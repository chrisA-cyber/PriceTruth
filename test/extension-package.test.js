import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = path.resolve(import.meta.dirname, '..');
const EXT = path.join(ROOT, 'extension');
const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));

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
    const compressed = buf.subarray(dataStart, dataStart + compSize);
    const data = method === 0 ? compressed : zlib.inflateRawSync(compressed);
    files[name] = data.toString('utf8');
    off = dataStart + compSize;
  }
  return files;
}

function pngDimensions(file) {
  const bytes = fs.readFileSync(file);
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe('publishable extension package', () => {
  it('uses Manifest V3, a minimum browser version, and only local storage permission', () => {
    assert.equal(manifest.manifest_version, 3);
    assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
    assert.ok(Number(manifest.minimum_chrome_version) >= 120);
    assert.deepEqual(manifest.permissions, ['storage']);
    assert.equal(manifest.background, undefined);
  });

  it('references only files that exist and keeps scripts self-hosted', () => {
    const files = new Set();
    for (const script of manifest.content_scripts) {
      script.js.forEach((f) => files.add(f));
      script.css.forEach((f) => files.add(f));
    }
    files.add(manifest.action.default_popup);
    files.add(manifest.options_ui.page);
    Object.values(manifest.icons).forEach((f) => files.add(f));
    for (const file of files) assert.equal(fs.existsSync(path.join(EXT, file)), true, file);
    assert.equal(manifest.content_security_policy.extension_pages, "script-src 'self'; object-src 'none'; base-uri 'none'");
  });

  it('ships correctly-sized PNG store icons', () => {
    for (const size of [16, 32, 48, 128]) {
      assert.deepEqual(pngDimensions(path.join(EXT, `icons/icon-${size}.png`)), { width: size, height: size });
    }
  });

  it('contains no background network or dynamic-code primitives', () => {
    const js = ['config.js', 'adapters.js', 'feemodel.js', 'content.js', 'popup.js', 'options.js']
      .map((f) => fs.readFileSync(path.join(EXT, f), 'utf8')).join('\n');
    assert.doesNotMatch(js, /\b(?:fetch|XMLHttpRequest|WebSocket|sendBeacon)\s*\(/);
    assert.doesNotMatch(js, /\b(?:eval|Function)\s*\(/);
  });

  it('publishes conservative all-in defaults instead of typical mandatory-fee claims', () => {
    const listing = fs.readFileSync(path.join(EXT, 'STORE-LISTING.md'), 'utf8');
    const popup = fs.readFileSync(path.join(EXT, 'popup.js'), 'utf8');
    const content = fs.readFileSync(path.join(EXT, 'content.js'), 'utf8');
    assert.match(manifest.description, /without invented mandatory fees or auto-selected extras/i);
    assert.match(listing, /mandatory-fee inclusive/i);
    assert.match(listing, /optional extras are never selected/i);
    assert.match(listing, /explicitly USD-denominated/i);
    assert.match(content, /offerIsUSScoped/);
    assert.match(content, /hasUSOfferEvidence/);
    assert.match(content, /function refreshAdapter\(\)/);
    assert.match(content, /var next = AD\.classify/);
    assert.match(content, /Known subtotal/);
    assert.match(popup, /checkout cost/);
    assert.match(popup, /Unknown: /);
    assert.doesNotMatch(`${listing}\n${popup}\n${content}`, /invented mandatory fees|% added without evidence|typical fees for this site/i);
  });

  it('builds a store ZIP with the configured HTTPS origin and hostname', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pricetruth-extension-package-'));
    const output = path.join(tempDir, 'pricetruth-extension.zip');
    try {
      const run = spawnSync(process.execPath, [
        path.join(ROOT, 'scripts', 'package-extension.mjs'),
        '--app-url=https://app.pricetruth.test',
        `--output=${output}`,
      ], { cwd: ROOT, encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr || run.stdout);
      const files = readZip(fs.readFileSync(output));
      assert.match(files['config.js'], /appUrl: 'https:\/\/app\.pricetruth\.test'/);
      assert.match(files['config.js'], /demoHost: 'app\.pricetruth\.test'/);
      const packagedManifest = JSON.parse(files['manifest.json']);
      const matches = packagedManifest.content_scripts.flatMap((entry) => entry.matches || []);
      assert.ok(matches.includes('https://app.pricetruth.test/extension-demo.html*'));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
