// Build / preflight — the "one command" that proves a deploy will actually
// boot. With zero runtime dependencies there is nothing to compile, so a
// meaningful build for this project is: confirm the runtime, boot the whole
// app in-memory, hit the health + meta endpoints, and print exactly which data
// sources are verified/live vs manual-only and whether billing is simulated. Exits non-zero
// on any failure so CI / a deploy pipeline fails loudly.
//
// Usage: npm run build   (then: npm start)

import { pathToFileURL } from 'node:url';
import { createApp } from './server.js';

const MIN_MAJOR = 24;

function fmtUSDcents(c) {
  return `$${(c / 100).toFixed(2)}`;
}

async function main() {
  const problems = [];
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  console.log(`PriceTruth build/preflight`);
  console.log(`  node ${process.versions.node} (require >= ${MIN_MAJOR})`);
  if (nodeMajor < MIN_MAJOR) problems.push(`Node ${MIN_MAJOR}+ required (node:sqlite, import attributes)`);

  // Boot the real app on an ephemeral loopback port — never the deploy HOST.
  const { server, db } = createApp({ dbPath: ':memory:' });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const health = await fetch(`${base}/api/health`).then((r) => r.json());
    if (!health.ok) problems.push('health check did not report ok');
    console.log(`  health: ok  (version ${health.version})`);

    const meta = await fetch(`${base}/api/meta`).then((r) => r.json());
    if (!Array.isArray(meta.verticals) || meta.verticals.length !== 5) {
      problems.push(`expected 5 verticals, got ${meta.verticals && meta.verticals.length}`);
    }
    if (db.listProducts().length === 0) problems.push('demo data did not seed on boot');

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
    server.close();
    server.closeAllConnections();
    db.close();
  }

  if (problems.length) {
    console.error(`\nBUILD FAILED:\n  - ${problems.join('\n  - ')}`);
    process.exit(1);
  }
  console.log('\nBuild OK — `npm start` is ready to serve.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('BUILD FAILED:', err);
    process.exit(1);
  });
}
