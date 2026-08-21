'use strict';

// CLI: mint a B2B API key. Usage:
//   npm run keygen -- "Acme Travel" starter|pro
// The raw key is printed once; only its SHA-256 hash is stored.

const { open } = require('./db');

const TIERS = ['starter', 'pro'];

function main() {
  const [label, tier = 'starter'] = process.argv.slice(2);
  if (!label) {
    console.error('Usage: npm run keygen -- "<label>" [starter|pro]');
    process.exit(1);
  }
  if (!TIERS.includes(tier)) {
    console.error(`tier must be one of: ${TIERS.join(', ')}`);
    process.exit(1);
  }
  const db = open();
  const raw = db.createApiKey(label.slice(0, 100), tier);
  db.close();
  console.log('API key created (shown once, store it now):');
  console.log(`  ${raw}`);
  console.log(`  label: ${label}  tier: ${tier}`);
}

main();
