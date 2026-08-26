import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { verifyNetlifyManifest, verifyPackagedAppFiles } from '../scripts/verify-netlify-manifest.mjs';
import { zip } from '../src/extzip.js';

function manifest() {
  return {
    functions: [
      {
        name: 'app',
        routes: ['/api/*', '/go/*', '/download/*', '/billing/*'].map((pattern) => ({ pattern, methods: [] })),
        excludedRoutes: ['/api/billing/webhook', '/api/email/webhook', '/api/internal/worker'].map((pattern) => ({ pattern })),
        trafficRules: { action: { config: {
          aggregate: { keys: [{ type: 'ip' }] },
          rateLimitConfig: { windowLimit: 300, windowSize: 60 },
        } } },
      },
      {
        name: 'webhooks',
        routes: ['/api/billing/webhook', '/api/email/webhook'].map((pattern) => ({ pattern, methods: ['POST'] })),
      },
      {
        name: 'worker-background', invocationMode: 'background',
        routes: [{ pattern: '/api/internal/worker', methods: ['POST'] }],
        trafficRules: { action: { config: {
          aggregate: { keys: [{ type: 'ip' }] },
          rateLimitConfig: { windowLimit: 10, windowSize: 60 },
        } } },
      },
      { name: 'worker-schedule', schedule: '* * * * *' },
    ],
  };
}

test('packaged Netlify manifest contract accepts the intended topology', () => {
  assert.deepEqual(verifyNetlifyManifest(manifest()), []);
});

test('packaged Netlify manifest contract catches extractor regressions', () => {
  const broken = manifest();
  const background = broken.functions.find((entry) => entry.name === 'worker-background');
  background.routes = [];
  background.trafficRules.action.config = {
    aggregate: { keys: [{ type: 'domain' }] },
    rateLimitConfig: { windowLimit: 11, windowSize: 60 },
  };
  broken.functions.find((entry) => entry.name === 'app').trafficRules.action.config.aggregate.keys = [{ type: 'domain' }];
  const failures = verifyNetlifyManifest(broken);
  assert.ok(failures.some((failure) => failure.startsWith('worker-background: exact POST route')));
  assert.ok(failures.some((failure) => failure.startsWith('worker-background: packaged rate limit is not aggregated by IP')));
  assert.ok(failures.some((failure) => failure.startsWith('worker-background: packaged rate limit unexpectedly uses domain')));
  assert.ok(failures.some((failure) => failure.startsWith('worker-background: packaged 10 request')));
  assert.ok(failures.some((failure) => failure.startsWith('app: packaged rate limit is not aggregated by IP')));
  assert.ok(failures.some((failure) => failure.startsWith('app: packaged rate limit unexpectedly uses domain')));
});

test('packaged app artifact must contain the SPA shell used by /billing/success', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pricetruth-netlify-manifest-'));
  const manifestPath = path.join(directory, 'manifest.json');
  const appPath = path.join(directory, 'app.zip');
  const packaged = manifest();
  packaged.functions.find((entry) => entry.name === 'app').path = appPath;
  try {
    fs.writeFileSync(appPath, zip([{ name: 'public/index.html', data: '<main id="app"></main>' }]));
    assert.deepEqual(verifyPackagedAppFiles(packaged, manifestPath), []);

    fs.writeFileSync(appPath, zip([{ name: 'index.mjs', data: 'export default () => {}' }]));
    assert.ok(verifyPackagedAppFiles(packaged, manifestPath).some((failure) => /public\/index\.html/.test(failure)));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
