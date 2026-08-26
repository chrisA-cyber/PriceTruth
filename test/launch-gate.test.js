import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateProductionEnv } from '../scripts/launch-gate.mjs';

const FRESH_NOW = Date.parse('2026-08-26T12:00:00.000Z');
const validate = (env, now = FRESH_NOW) => validateProductionEnv(env, { now });

const valid = {
  NODE_ENV: 'production',
  PUBLIC_BASE_URL: 'https://launch-operator.com',
  PRICETRUTH_DB: process.platform === 'win32' ? 'C:\\pricetruth-data\\pricetruth.db' : '/var/lib/pricetruth/pricetruth.db',
  ADMIN_TOKEN: 'Q7pL2vN9xR4mK8sT6wY3cF5hJ1dB0zUaG',
  EMAIL_TRANSPORT: 'resend',
  RESEND_API_KEY: 're_' + 'a'.repeat(24),
  EMAIL_FROM: 'alerts@launch-operator.com',
  OUTBOX_ENCRYPTION_KEY: 'b'.repeat(48),
  RESEND_WEBHOOK_SECRET: 'c'.repeat(32),
  ENABLE_LIVE_BILLING: '1',
  ENABLE_DEMO_SEED: '0',
  STRIPE_AUTOMATIC_TAX: '1',
  ENABLE_ACCOUNTS: '1',
  DISABLE_WORKER: '0',
  STRIPE_SECRET_KEY: 'sk_live_' + 'd'.repeat(24),
  STRIPE_WEBHOOK_SECRET: 'whsec_' + 'e'.repeat(24),
  STRIPE_PRICE_PREMIUM: 'price_' + 'f'.repeat(16),
  STRIPE_PRICE_API_STARTER: 'price_' + 'g'.repeat(16),
  STRIPE_PRICE_API_PRO: 'price_' + 'h'.repeat(16),
  STRIPE_PRODUCT_PREMIUM: 'prod_' + 'i'.repeat(16),
  STRIPE_PRODUCT_API_STARTER: 'prod_' + 'j'.repeat(16),
  STRIPE_PRODUCT_API_PRO: 'prod_' + 'k'.repeat(16),
  SESSION_TTL_DAYS: '30',
  LAUNCH_VERTICALS: 'subscription',
  LEGAL_OPERATOR_NAME: 'PriceTruth Test Operator LLC',
  LEGAL_JURISDICTION: 'New York, United States',
  SUPPORT_CONTACT_EMAIL: 'support@launch-operator.com',
  LEGAL_EFFECTIVE_DATE: '2026-08-25',
  LEGAL_APPROVED: '1',
  LEGAL_TERMS_VERSION: '2026-08-25-v1',
};

describe('production launch gate', () => {
  it('accepts a complete paid subscription launch configuration', () => {
    assert.deepEqual(validate(valid), []);
  });

  it('accepts Netlify Database with the signed background worker', () => {
    const netlify = {
      ...valid,
      DATABASE_MODE: 'netlify',
      WORKER_MODE: 'netlify-background',
      WORKER_DISPATCH_SECRET: 'w'.repeat(48),
      DISABLE_WORKER: '0',
    };
    delete netlify.PRICETRUTH_DB;
    delete netlify.PUBLIC_BASE_URL;
    assert.deepEqual(validate(netlify), []);

    delete netlify.WORKER_MODE;
    netlify.WORKER_DISPATCH_SECRET = 'too-short';
    assert.ok(validate(netlify).some((failure) => failure.startsWith('WORKER_DISPATCH_SECRET:')));
  });

  it('fails closed when durable storage, email, workers, or billing is unsafe', () => {
    const failures = validate({ ...valid, PUBLIC_BASE_URL: 'http://example.com', PRICETRUTH_DB: ':memory:', EMAIL_TRANSPORT: 'console', DISABLE_WORKER: '1', STRIPE_SECRET_KEY: 'sk_test_nope', ENABLE_DEMO_SEED: '1' });
    assert.ok(failures.some((f) => f.startsWith('PUBLIC_BASE_URL:')));
    assert.ok(failures.some((f) => f.startsWith('PRICETRUTH_DB:')));
    assert.ok(failures.some((f) => f.startsWith('EMAIL_TRANSPORT:')));
    assert.ok(failures.some((f) => f.startsWith('DISABLE_WORKER:')));
    assert.ok(failures.some((f) => f.startsWith('STRIPE_SECRET_KEY:')));
    assert.ok(failures.some((f) => f.startsWith('ENABLE_DEMO_SEED:')));

    const missingDemoBoundary = { ...valid };
    delete missingDemoBoundary.ENABLE_DEMO_SEED;
    assert.ok(validate(missingDemoBoundary).some((f) => f.startsWith('ENABLE_DEMO_SEED:')));
  });

  it('requires live-source credentials for every declared external vertical', () => {
    const failures = validate({ ...valid, LAUNCH_VERTICALS: 'hotel,ticket,retail' });
    for (const name of ['AMADEUS_CLIENT_ID', 'AMADEUS_CLIENT_SECRET', 'AMADEUS_HOST', 'RETAIL_API_URL', 'RETAIL_API_KEY']) {
      assert.ok(failures.some((f) => f.startsWith(name + ':')), name);
    }
    assert.ok(failures.some((f) => f.startsWith('LAUNCH_VERTICALS: ticket is unavailable')));
  });

  it('accepts a public retail endpoint path and rejects credential, local-network, and fragment targets', () => {
    const retail = {
      ...valid,
      LAUNCH_VERTICALS: 'retail',
      RETAIL_API_URL: 'https://feed.launch-operator.com/v1/search?market=us',
      RETAIL_API_KEY: 'retail-secret',
    };
    assert.deepEqual(validate(retail), []);
    for (const url of [
      'http://feed.launch-operator.com/v1/search',
      'https://user:secret@feed.launch-operator.com/v1/search',
      'https://feed.launch-operator.com/v1/search#fragment',
      'https://localhost/v1/search',
      'https://127.0.0.1/v1/search',
      'https://2130706433/v1/search',
      'https://[::1]/v1/search',
      'https://metadata.google.internal/computeMetadata/v1',
    ]) {
      const failures = validate({ ...retail, RETAIL_API_URL: url });
      assert.ok(failures.some((failure) => failure.startsWith('RETAIL_API_URL:')), url);
    }
  });

  it('rejects reserved or non-public sender and support destinations', () => {
    for (const env of [
      { ...valid, PUBLIC_BASE_URL: 'https://deployment.example.invalid' },
      { ...valid, EMAIL_FROM: 'alerts@example.com' },
      { ...valid, SUPPORT_CONTACT_EMAIL: 'support@localhost' },
      { ...valid, SUPPORT_CONTACT_EMAIL: '', SUPPORT_CONTACT_URL: 'https://support.example.invalid/help' },
    ]) {
      const failures = validate(env);
      assert.ok(failures.some((failure) => failure.startsWith('PUBLIC_BASE_URL:') || failure.startsWith('EMAIL_FROM:') || failure.startsWith('SUPPORT_CONTACT_')));
    }
  });

  it('rejects a stale subscription catalog and an invalid freshness override', () => {
    const stale = validate(valid, Date.parse('2026-11-27T00:00:01.000Z'));
    assert.ok(stale.some((failure) => failure.startsWith('SUBSCRIPTION_CATALOG: oldest verified row')));

    const invalidPolicy = validate({ ...valid, SUBSCRIPTION_CATALOG_MAX_AGE_DAYS: '366' });
    assert.ok(invalidPolicy.some((failure) => failure.startsWith('SUBSCRIPTION_CATALOG_MAX_AGE_DAYS:')));
  });
});
