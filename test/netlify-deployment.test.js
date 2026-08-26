import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildNetlify,
  normalizeOrigin,
  assertDistinctOrigins,
  redirectManifest,
} from '../scripts/build-netlify.mjs';

test('Netlify backend origin validation fails closed', () => {
  assert.throws(() => normalizeOrigin(''), /is required/);
  assert.throws(() => normalizeOrigin('http://backend.pricetruth.app'), /public origin-only HTTPS/);
  assert.throws(() => normalizeOrigin('https://localhost'), /public origin-only HTTPS/);
  assert.throws(() => normalizeOrigin('https://backend.pricetruth.app/path'), /public origin-only HTTPS/);
  assert.equal(normalizeOrigin('https://backend.pricetruth.app/'), 'https://backend.pricetruth.app');
});

test('Netlify build rejects a proxy loop', () => {
  assert.throws(
    () => assertDistinctOrigins('https://pricetruth.netlify.app', ['https://pricetruth.netlify.app/']),
    /rewrite loop/,
  );
});

test('Netlify redirects proxy every dynamic surface before the SPA fallback', () => {
  const redirects = redirectManifest('https://backend.pricetruth.app');
  for (const route of ['/api/*', '/go/*', '/download/*', '/billing/*']) {
    assert.ok(redirects.includes(route), `${route} should be proxied`);
  }
  assert.ok(redirects.indexOf('/api/*') < redirects.indexOf('/*                     /index.html'));
  assert.match(redirects, /https:\/\/backend\.pricetruth\.app\/api\/:splat\s+200!/);
});

test('Netlify bundle contains the app and generated routing contract', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'pricetruth-netlify-test-'));
  const outputDir = path.join(parent, 'site');
  try {
    const result = buildNetlify({
      backendOrigin: 'https://backend.pricetruth.app',
      siteOrigin: 'https://pricetruth.netlify.app',
      outputDir,
      deployOrigins: ['https://deploy-preview-42--pricetruth.netlify.app'],
    });
    assert.equal(result.backendOrigin, 'https://backend.pricetruth.app');
    assert.equal(result.siteOrigin, 'https://pricetruth.netlify.app');
    for (const file of ['index.html', 'app.js', 'styles.css', 'legal.html', 'robots.txt', 'sitemap.xml', '_redirects', 'find/index.html']) {
      assert.ok(fs.existsSync(path.join(outputDir, file)), `${file} should be published`);
    }
    assert.match(fs.readFileSync(path.join(outputDir, '_redirects'), 'utf8'), /\/api\/\*/);
    assert.match(fs.readFileSync(path.join(outputDir, 'find', 'index.html'), 'utf8'), /canonical" href="https:\/\/pricetruth\.netlify\.app\/find/);
    assert.match(fs.readFileSync(path.join(outputDir, 'robots.txt'), 'utf8'), /Sitemap: https:\/\/pricetruth\.netlify\.app\/sitemap\.xml/);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
