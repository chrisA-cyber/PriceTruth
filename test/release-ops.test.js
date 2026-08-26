import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (file) => fs.readFileSync(file, 'utf8');

describe('release operations contracts', () => {
  it('ships every runtime asset in the non-root image context', () => {
    const dockerfile = read('Dockerfile');
    for (const asset of ['src', 'public', 'extension', 'openapi']) {
      assert.match(dockerfile, new RegExp(`COPY[^\\n]+${asset.replace('/', '\\/')}`), asset);
    }
    assert.match(dockerfile, /USER 10001:10001/);
    const ignores = read('.dockerignore').split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
    assert.equal(ignores.includes('data'), false, 'broad data ignore would remove src/data catalogs');
    assert.equal(ignores.some((line) => /(?:^|\/)src\/data(?:\/|$)/.test(line)), false);
    for (const catalog of ['src/data/fees/flight.json', 'src/data/fees/hotel.json', 'src/data/plans/subscriptions.json']) {
      assert.equal(fs.existsSync(catalog), true, catalog);
    }
  });

  it('keeps demo deployment incapable of live charging', () => {
    const renderDemo = read('render.yaml');
    assert.match(renderDemo, /key: ENABLE_ACCOUNTS\s+value: "0"/);
    assert.match(renderDemo, /key: ENABLE_LIVE_BILLING\s+value: "0"/);
    assert.match(renderDemo, /healthCheckPath: \/api\/ready/);
    assert.doesNotMatch(renderDemo, /key: STRIPE_(?:SECRET|WEBHOOK|PRICE|PRODUCT)/);
    const compose = read('compose.yaml');
    assert.match(compose, /PUBLIC_BASE_URL: \$\{PUBLIC_BASE_URL:-http:\/\/localhost:4780\}/);
    assert.match(compose, /ENABLE_DEMO_SEED: "1"/);
  });

  it('includes the complete fail-closed paid environment boundary', () => {
    const template = read('deploy/production.env.example');
    const keys = new Set(template.split(/\r?\n/).map((line) => /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1]).filter(Boolean));
    for (const key of [
      'NODE_ENV', 'PUBLIC_BASE_URL', 'PRICETRUTH_DB', 'TRUST_PROXY', 'ADMIN_TOKEN',
      'ENABLE_ACCOUNTS', 'REQUIRE_EMAIL', 'EMAIL_TRANSPORT', 'RESEND_API_KEY',
      'EMAIL_FROM', 'OUTBOX_ENCRYPTION_KEY', 'RESEND_WEBHOOK_SECRET',
      'ENABLE_LIVE_BILLING', 'STRIPE_AUTOMATIC_TAX', 'STRIPE_SECRET_KEY',
      'STRIPE_WEBHOOK_SECRET', 'STRIPE_PRICE_PREMIUM', 'STRIPE_PRICE_API_STARTER',
      'STRIPE_PRICE_API_PRO', 'STRIPE_PRODUCT_PREMIUM', 'STRIPE_PRODUCT_API_STARTER',
      'STRIPE_PRODUCT_API_PRO', 'LEGAL_OPERATOR_NAME', 'LEGAL_JURISDICTION',
      'LEGAL_EFFECTIVE_DATE', 'LEGAL_APPROVED', 'LEGAL_TERMS_VERSION',
      'DISABLE_WORKER', 'ENABLE_DEMO_SEED', 'LAUNCH_VERTICALS',
      'SUBSCRIPTION_CATALOG_MAX_AGE_DAYS',
    ]) assert.equal(keys.has(key), true, key);
    assert.equal(keys.has('SUPPORT_CONTACT_URL') || keys.has('SUPPORT_CONTACT_EMAIL'), true);
    for (const file of ['render.production.yaml', 'render.yaml', 'compose.yaml']) {
      assert.match(read(file), /SUBSCRIPTION_CATALOG_MAX_AGE_DAYS/);
    }
  });

  it('executes all release gates and a configured container smoke in CI', () => {
    const ci = read('.github/workflows/ci.yml');
    for (const command of [
      'npm run check', 'npm test', 'npm run build', 'npm run smoke:security',
      'npm run smoke:performance', 'npm run extension:check',
      'npm run extension:package', 'npm run test:e2e', 'npm run test:a11y',
      'npm audit --omit=dev --audit-level=high', 'docker build --pull',
    ]) assert.ok(ci.includes(command), command);
    assert.match(ci, /--env PUBLIC_BASE_URL=http:\/\/localhost:4780/);
    assert.match(ci, /--env SUBSCRIPTION_CATALOG_MAX_AGE_DAYS=93/);
    for (const endpoint of ['/', '/api/health', '/api/ready', '/api/meta', '/api/openapi']) {
      assert.ok(ci.includes(`'${endpoint}'`), endpoint);
    }
  });
});
