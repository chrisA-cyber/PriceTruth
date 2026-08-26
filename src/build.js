// Build / preflight — the "one command" that proves a deploy will actually
// boot. With zero runtime dependencies there is nothing to compile, so a
// meaningful build for this project is: confirm the runtime, boot the whole
// app in-memory, and hit the health + meta endpoints. Netlify exposes runtime
// configuration during builds, so this smoke test deliberately isolates itself
// from deploy-time databases, providers, billing, email, and worker credentials.
// Production configuration is verified separately by the launch gate. Exits
// non-zero on any failure so CI / a deploy pipeline fails loudly.
//
// Usage: npm run build   (then: npm start)

import { pathToFileURL } from 'node:url';

const MIN_MAJOR = 24;
const PREFLIGHT_ENVIRONMENT = Object.freeze({
  NODE_ENV: 'development',
  ENABLE_DEMO_SEED: '1',
  ENABLE_ACCOUNTS: '0',
  ENABLE_LIVE_BILLING: '0',
  REQUIRE_EMAIL: '0',
  EMAIL_TRANSPORT: 'memory',
  DISABLE_WORKER: '1',
  WORKER_MODE: 'in-process',
  NETLIFY_DB_URL: null,
  PRICETRUTH_DB: null,
  PUBLIC_BASE_URL: null,
  ADMIN_TOKEN: null,
  LAUNCH_VERTICALS: null,
  SUBSCRIPTION_CATALOG_MAX_AGE_DAYS: null,
  STRIPE_SECRET_KEY: null,
  STRIPE_WEBHOOK_SECRET: null,
  STRIPE_PRICE_PREMIUM: null,
  STRIPE_PRICE_API_STARTER: null,
  STRIPE_PRICE_API_PRO: null,
  STRIPE_PRODUCT_PREMIUM: null,
  STRIPE_PRODUCT_API_STARTER: null,
  STRIPE_PRODUCT_API_PRO: null,
  STRIPE_AUTOMATIC_TAX: null,
  RESEND_API_KEY: null,
  RESEND_WEBHOOK_SECRET: null,
  EMAIL_FROM: null,
  OUTBOX_ENCRYPTION_KEY: null,
  PENDING_KEY_ENCRYPTION_KEY: null,
  WORKER_DISPATCH_SECRET: null,
  RATE_LIMIT_HASH_KEY: null,
  TICKETMASTER_API_KEY: null,
  AMADEUS_CLIENT_ID: null,
  AMADEUS_CLIENT_SECRET: null,
  AMADEUS_HOST: null,
  RETAIL_API_URL: null,
  RETAIL_API_KEY: null,
  ENABLE_AFFILIATE_LINKS: '0',
  AFFILIATE_RELATIONSHIPS_APPROVED: null,
  AFFILIATE_DISCLOSURE_URL: null,
});

function isolatePreflightEnvironment() {
  const previous = new Map();
  for (const [name, value] of Object.entries(PREFLIGHT_ENVIRONMENT)) {
    previous.set(name, process.env[name]);
    if (value === null) delete process.env[name];
    else process.env[name] = value;
  }
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

function fmtUSDcents(c) {
  return `$${(c / 100).toFixed(2)}`;
}

async function runPreflight() {
  const problems = [];
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  console.log(`PriceTruth build/preflight`);
  console.log(`  node ${process.versions.node} (require >= ${MIN_MAJOR})`);
  console.log('  mode: isolated in-memory smoke (deployment credentials are not loaded)');
  if (nodeMajor < MIN_MAJOR) problems.push(`Node ${MIN_MAJOR}+ required (node:sqlite, import attributes)`);

  // Boot the real app on an ephemeral loopback port — never the deploy HOST.
  const { createApp } = await import('./server.js');
  const { server, db } = await createApp({ dbPath: ':memory:', startTimers: false });

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const health = await fetch(`${base}/api/health`).then((r) => r.json());
    if (!health.ok) problems.push('health check did not report ok');
    console.log(`  health: ok  (version ${health.version})`);

    const meta = await fetch(`${base}/api/meta`).then((r) => r.json());
    if (!Array.isArray(meta.verticals) || meta.verticals.length !== 5) {
      problems.push(`expected 5 verticals, got ${meta.verticals && meta.verticals.length}`);
    }
    if ((await db.listProducts()).length === 0) problems.push('demo data did not seed on boot');

    // Config report — honest live/mock picture for whoever is deploying.
    const SOURCE_KIND = {
      live: 'LIVE (real-time feed)',
      dataset: 'dataset (dated catalog snapshot)',
      fallback: 'MANUAL ONLY (verified search unavailable)',
    };
    console.log('\n  Data sources:');
    for (const [vertical, s] of Object.entries(meta.providers || {})) {
      console.log(`    ${vertical.padEnd(13)} ${SOURCE_KIND[s.kind] || (s.live ? 'LIVE' : 'MANUAL ONLY')}`);
    }
    console.log(`\n  Billing: ${meta.billing.mode.toUpperCase()}${meta.billing.mode === 'mock' ? ' (simulation — complete the paid-production launch gate to enable live billing)' : ''}`);
    for (const p of Object.values(meta.billing.plans || {})) {
      console.log(`    ${p.id.padEnd(12)} ${p.label.padEnd(12)} ${p.price}`);
    }
    console.log(`\n  Admin metrics route: ${process.env.ADMIN_TOKEN ? 'protected (ADMIN_TOKEN set)' : 'DISABLED (set ADMIN_TOKEN to enable /admin)'}`);
    console.log(`  Public base URL: ${process.env.PUBLIC_BASE_URL || '(derived from request host)'}`);

    // Prove the end-to-end analyze path returns integer cents.
    const probe = await fetch(`${base}/api/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ vertical: 'flight', advertised_cents: 5900, context: { carrier: 'spirit' } }),
    }).then((r) => r.json());
    if (!probe.truePrice || !Number.isInteger(probe.truePrice.amount_cents)) {
      problems.push('analyze probe did not return integer-cents true price');
    } else {
      console.log(`\n  Engine probe: $59.00 Spirit fare -> ${fmtUSDcents(probe.truePrice.amount_cents)} true cost`);
    }
  } finally {
    if (server.listening) {
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      });
    }
    await db.close();
  }

  if (problems.length) {
    console.error(`\nBUILD FAILED:\n  - ${problems.join('\n  - ')}`);
    return false;
  }
  console.log('\nBuild OK — `npm start` is ready to serve.');
  return true;
}

export async function main() {
  const restoreEnvironment = isolatePreflightEnvironment();
  try {
    return await runPreflight();
  } finally {
    restoreEnvironment();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((ok) => {
    if (!ok) process.exitCode = 1;
  }).catch((err) => {
    console.error('BUILD FAILED:', err);
    process.exitCode = 1;
  });
}
