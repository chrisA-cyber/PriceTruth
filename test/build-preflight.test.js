import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { main } from '../src/build.js';

const root = fileURLToPath(new URL('..', import.meta.url));

test('build preflight ignores production-scoped Netlify services and secrets', { timeout: 30_000 }, () => {
  const command = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'npm';
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'npm run build'] : ['run', 'build'];
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 20_000,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      ENABLE_ACCOUNTS: '1',
      ENABLE_DEMO_SEED: '0',
      ENABLE_LIVE_BILLING: '1',
      REQUIRE_EMAIL: '1',
      EMAIL_TRANSPORT: 'resend',
      DISABLE_WORKER: '0',
      WORKER_MODE: 'netlify-background',
      NETLIFY_DB_URL: 'postgres://build-preflight:must-not-connect@127.0.0.1:1/pricetruth',
      PUBLIC_BASE_URL: 'https://production-build-values.example.com',
      ADMIN_TOKEN: 'hostile-build-admin-token-that-must-not-be-read',
      STRIPE_SECRET_KEY: 'sk_live_hostile_build_secret_1234567890',
      STRIPE_WEBHOOK_SECRET: 'whsec_hostile_build_secret_1234567890',
      STRIPE_PRICE_PREMIUM: 'price_hostilepremium1234',
      STRIPE_PRICE_API_STARTER: 'price_hostilestarter1234',
      STRIPE_PRICE_API_PRO: 'price_hostilepro12345678',
      STRIPE_PRODUCT_PREMIUM: 'prod_hostilepremium1234',
      STRIPE_PRODUCT_API_STARTER: 'prod_hostilestarter1234',
      STRIPE_PRODUCT_API_PRO: 'prod_hostilepro12345678',
      RESEND_API_KEY: 're_hostile_build_secret_1234567890',
      RESEND_WEBHOOK_SECRET: 'hostile-build-webhook-secret-1234567890',
      EMAIL_FROM: 'PriceTruth <alerts@production-build-values.example.com>',
      OUTBOX_ENCRYPTION_KEY: 'hostile-build-outbox-encryption-key-1234567890',
      WORKER_DISPATCH_SECRET: 'hostile-build-worker-dispatch-key-1234567890',
      TICKETMASTER_API_KEY: 'hostile-build-ticketmaster-key',
      AMADEUS_CLIENT_ID: 'hostile-build-amadeus-id',
      AMADEUS_CLIENT_SECRET: 'hostile-build-amadeus-secret',
      AMADEUS_HOST: 'http://127.0.0.1:1',
      RETAIL_API_URL: 'http://127.0.0.1:1',
      RETAIL_API_KEY: 'hostile-build-retail-key',
    },
  });

  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  assert.equal(result.error, undefined, output);
  assert.equal(result.status, 0, output);
  assert.match(output, /mode: isolated in-memory smoke/);
  assert.match(output, /Billing: MOCK/);
  assert.match(output, /Admin metrics route: DISABLED/);
  assert.match(output, /Public base URL: \(derived from request host\)/);
  assert.match(output, /Build OK/);
  assert.doesNotMatch(output, /must-not-connect|hostile-build|production-build-values/);
});

test('an imported build preflight restores every isolated environment value', async () => {
  const hostile = {
    NODE_ENV: 'production',
    ENABLE_ACCOUNTS: '1',
    ENABLE_DEMO_SEED: '0',
    ENABLE_LIVE_BILLING: '1',
    NETLIFY_DB_URL: 'postgres://restore-check@127.0.0.1:1/pricetruth',
    STRIPE_SECRET_KEY: 'sk_live_restore_check_1234567890',
    EMAIL_TRANSPORT: 'resend',
    RESEND_API_KEY: 're_restore_check_1234567890',
  };
  const previous = new Map(Object.keys(hostile).map((name) => [name, process.env[name]]));
  Object.assign(process.env, hostile);

  try {
    assert.equal(await main(), true);
    for (const [name, value] of Object.entries(hostile)) {
      assert.equal(process.env[name], value, `${name} was not restored`);
    }
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
