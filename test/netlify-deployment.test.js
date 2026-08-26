import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildNetlify,
  normalizeSiteOrigin,
  redirectManifest,
} from '../scripts/build-netlify.mjs';

test('Netlify canonical site origin validation fails closed in production', () => {
  assert.throws(() => normalizeSiteOrigin(''), /is required/);
  assert.throws(() => normalizeSiteOrigin('http://pricetruth.app'), /public origin-only HTTPS/);
  assert.throws(() => normalizeSiteOrigin('https://localhost'), /public origin-only HTTPS/);
  assert.throws(() => normalizeSiteOrigin('https://pricetruth.app/path'), /public origin-only HTTPS/);
  assert.equal(normalizeSiteOrigin('https://pricetruth.app/'), 'https://pricetruth.app');
});

test('Netlify canonical site origin permits only explicit localhost development', () => {
  assert.equal(
    normalizeSiteOrigin('http://localhost:4780/', { allowLocal: true }),
    'http://localhost:4780',
  );
  assert.throws(() => normalizeSiteOrigin('http://localhost:4780/'), /public origin-only HTTPS/);
});

test('Netlify redirects contain only static fallbacks', () => {
  const redirects = redirectManifest();
  for (const route of ['/api/*', '/go/*', '/download/*', '/billing/*']) {
    assert.ok(!redirects.includes(route), `${route} should be claimed by native Functions, not proxied`);
  }
  for (const route of ['/api/billing/webhook', '/api/email/webhook', '/api/internal/worker']) {
    assert.match(redirects, new RegExp(`^${route.replaceAll('/', '\\/')}\\s+\\/api-route-not-found\\.json\\s+404$`, 'm'));
  }
  assert.match(redirects, /^\/admin\s+\/admin\.html\s+200$/m);
  assert.match(redirects, /^\/admin\/\s+\/admin\.html\s+200$/m);
  assert.match(redirects, /^\/\*\s+\/index\.html\s+200$/m);
  assert.doesNotMatch(redirects, /https?:\/\//);
});

test('Netlify project configuration deploys native functions and no external backend proxy', () => {
  const config = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'netlify.toml'), 'utf8');
  assert.match(config, /\[functions\][\s\S]*directory\s*=\s*"netlify\/functions"/);
  assert.match(config, /node_bundler\s*=\s*"esbuild"/);
  assert.match(config, /included_files\s*=\s*\["extension\/\*\*",\s*"openapi\/openapi\.json",\s*"public\/index\.html"\]/);
  assert.match(config, /\[dev\][\s\S]*port\s*=\s*4780/);
  assert.doesNotMatch(config, /BACKEND_ORIGIN|https?:\/\/[^"\s]+\/:splat/);
});

test('Netlify worker and webhook entry points have explicit platform contracts', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const app = fs.readFileSync(path.join(root, 'netlify', 'functions', 'app.mjs'), 'utf8');
  const webhooks = fs.readFileSync(path.join(root, 'netlify', 'functions', 'webhooks.mjs'), 'utf8');
  const schedule = fs.readFileSync(path.join(root, 'netlify', 'functions', 'worker-schedule.mjs'), 'utf8');
  const background = fs.readFileSync(path.join(root, 'netlify', 'functions', 'worker-background.mjs'), 'utf8');
  assert.match(app, /excludedPath:[\s\S]*\/api\/billing\/webhook[\s\S]*\/api\/email\/webhook[\s\S]*\/api\/internal\/worker/);
  assert.match(app, /rateLimit:[\s\S]*aggregateBy:\s*\['ip'\][\s\S]*windowLimit:\s*300[\s\S]*windowSize:\s*60/);
  assert.match(webhooks, /path:\s*\['\/api\/billing\/webhook',\s*'\/api\/email\/webhook'\]/);
  assert.doesNotMatch(webhooks, /rateLimit/);
  assert.match(schedule, /schedule:\s*'\* \* \* \* \*'/);
  assert.match(background, /path:\s*'\/api\/internal\/worker'[\s\S]*background:\s*true[\s\S]*rateLimit:[\s\S]*aggregateBy:\s*\['ip'\][\s\S]*windowLimit:\s*10[\s\S]*windowSize:\s*60/);
});

test('Netlify bundle contains the app and generated routing contract', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'pricetruth-netlify-test-'));
  const outputDir = path.join(parent, 'site');
  try {
    const result = buildNetlify({
      siteOrigin: 'https://pricetruth.netlify.app',
      outputDir,
    });
    assert.equal(result.siteOrigin, 'https://pricetruth.netlify.app');
    for (const file of ['index.html', 'app.js', 'styles.css', 'legal.html', 'robots.txt', 'sitemap.xml', '_redirects', 'api-route-not-found.json', 'find/index.html']) {
      assert.ok(fs.existsSync(path.join(outputDir, file)), `${file} should be published`);
    }
    const redirects = fs.readFileSync(path.join(outputDir, '_redirects'), 'utf8');
    assert.doesNotMatch(redirects, /\/api\/\*/);
    assert.match(redirects, /^\/api\/internal\/worker\s+\/api-route-not-found\.json\s+404$/m);
    assert.match(redirects, /^\/\*\s+\/index\.html\s+200$/m);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(outputDir, 'api-route-not-found.json'), 'utf8')), {
      error: 'not found', code: 'NOT_FOUND',
    });
    assert.match(fs.readFileSync(path.join(outputDir, 'find', 'index.html'), 'utf8'), /canonical" href="https:\/\/pricetruth\.netlify\.app\/find/);
    assert.match(fs.readFileSync(path.join(outputDir, 'robots.txt'), 'utf8'), /Sitemap: https:\/\/pricetruth\.netlify\.app\/sitemap\.xml/);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
