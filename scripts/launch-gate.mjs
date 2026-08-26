// Fail-closed production configuration gate. It reports variable names only;
// secret values are never printed. This complements the live /api/ready probe.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyLivePriceCatalog } from '../src/billing.js';
import { catalogFreshness as subscriptionCatalogFreshness } from '../src/providers/subscriptions.js';

function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[match[1]] = value;
  }
  return out;
}

function publicHostname(value) {
  const host = String(value || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host || !host.includes('.') || /^\d+(?:\.\d+){3}$/.test(host) || host.includes(':')) return false;
  if (['localhost', 'test', 'example', 'invalid', 'local', 'internal', 'lan'].some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) return false;
  if (['example.com', 'example.net', 'example.org'].some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) return false;
  return /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host);
}

function publicEmailAddress(value, { displayName = false } = {}) {
  const clean = String(value || '').trim();
  const bracketed = clean.match(/^.{1,100}<([^<>]+)>$/);
  if (bracketed && !displayName) return false;
  const address = bracketed ? bracketed[1].trim() : clean;
  const match = address.match(/^[^\s@<>]{1,64}@([A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?)$/);
  return Boolean(match && publicHostname(match[1]));
}

function validateProductionEnv(env, { now = Date.now() } = {}) {
  const failures = [];
  const requireValue = (name, test, message) => {
    const value = env[name];
    if (!value) failures.push(`${name}: missing`);
    else if (test && !test(value)) failures.push(`${name}: ${message || 'invalid'}`);
  };

  requireValue('NODE_ENV', (v) => v === 'production', 'must be production');
  requireValue('PUBLIC_BASE_URL', (value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password && publicHostname(url.hostname) &&
        url.pathname.replace(/\/+$/, '') === '' && !url.search && !url.hash;
    } catch { return false; }
  }, 'must be an origin-only HTTPS URL');
  requireValue('PRICETRUTH_DB', (v) => v !== ':memory:' && path.isAbsolute(v), 'must be an absolute durable path');
  requireValue('ADMIN_TOKEN', (v) => v.length >= 32 && v.length <= 512 && /^[\x21-\x7E]+$/.test(v) && new Set(v).size >= 8 && !/(?:changeme|password|placeholder|example|admin[_-]?token|test[_-]?token)/i.test(v), 'must be a non-placeholder high-entropy token of at least 32 characters');
  requireValue('EMAIL_TRANSPORT', (v) => v === 'resend', 'must be resend');
  requireValue('RESEND_API_KEY', (v) => /^re_[A-Za-z0-9_-]{12,}$/.test(v), 'does not match a Resend key shape');
  requireValue('EMAIL_FROM', (v) => publicEmailAddress(v, { displayName: true }), 'must contain a public deliverable sender address');
  requireValue('OUTBOX_ENCRYPTION_KEY', (v) => v.length >= 32, 'must contain at least 32 characters');
  requireValue('RESEND_WEBHOOK_SECRET', (v) => v.length >= 24, 'must contain at least 24 characters');
  const legalText = (v) => v.length >= 2 && v.length <= 160 && !/^(?:tbd|todo|placeholder|your\b|example\b|unknown\b)/i.test(v.trim());
  requireValue('LEGAL_OPERATOR_NAME', legalText, 'must be an approved non-placeholder public operator name');
  requireValue('LEGAL_JURISDICTION', legalText, 'must be an approved non-placeholder jurisdiction');
  if (env.SUPPORT_CONTACT_URL) {
    requireValue('SUPPORT_CONTACT_URL', (v) => { try { const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password && publicHostname(u.hostname); } catch { return false; } }, 'must be a public HTTPS support URL');
  } else requireValue('SUPPORT_CONTACT_EMAIL', (v) => publicEmailAddress(v), 'must be a public support email when SUPPORT_CONTACT_URL is absent');
  requireValue('LEGAL_EFFECTIVE_DATE', (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && Date.parse(`${v}T00:00:00Z`) <= now, 'must be a valid non-future YYYY-MM-DD date');
  requireValue('LEGAL_APPROVED', (v) => v === '1', 'must be 1 after operator approval');
  requireValue('LEGAL_TERMS_VERSION', (v) => /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(v) && !/^(?:tbd|todo|placeholder|example|unknown|latest|current)$/i.test(v), 'must be an approved immutable terms version');
  requireValue('ENABLE_LIVE_BILLING', (v) => v === '1', 'must be 1 for a paid launch');
  requireValue('ENABLE_DEMO_SEED', (v) => v === '0', 'must be explicitly 0 for a paid launch');
  requireValue('STRIPE_AUTOMATIC_TAX', (v) => v === '1', 'must be 1 after Stripe Tax and required registrations are configured');
  requireValue('ENABLE_ACCOUNTS', (v) => v === '1', 'must be 1 for authenticated paid fulfillment');
  if (env.DISABLE_WORKER === '1') failures.push('DISABLE_WORKER: must not be 1');

  requireValue('STRIPE_SECRET_KEY', (v) => /^sk_live_[A-Za-z0-9_]{12,}$/.test(v), 'must be a live secret key');
  requireValue('STRIPE_WEBHOOK_SECRET', (v) => /^whsec_[A-Za-z0-9_]{12,}$/.test(v), 'does not match a signing secret');
  for (const name of ['STRIPE_PRICE_PREMIUM', 'STRIPE_PRICE_API_STARTER', 'STRIPE_PRICE_API_PRO']) {
    requireValue(name, (v) => /^price_[A-Za-z0-9_]{8,}$/.test(v), 'does not match a Stripe price id');
  }
  for (const name of ['STRIPE_PRODUCT_PREMIUM', 'STRIPE_PRODUCT_API_STARTER', 'STRIPE_PRODUCT_API_PRO']) {
    requireValue(name, (v) => /^prod_[A-Za-z0-9_]{8,}$/.test(v), 'does not match a Stripe product id');
  }

  if (env.SESSION_TTL_DAYS && (!/^\d+$/.test(env.SESSION_TTL_DAYS) || Number(env.SESSION_TTL_DAYS) < 1 || Number(env.SESSION_TTL_DAYS) > 90)) {
    failures.push('SESSION_TTL_DAYS: must be an integer from 1 to 90');
  }

  const verticals = String(env.LAUNCH_VERTICALS || '').split(',').map((v) => v.trim()).filter(Boolean);
  if (verticals.length === 0) failures.push('LAUNCH_VERTICALS: declare at least one launch vertical');
  const known = new Set(['hotel', 'flight', 'ticket', 'subscription', 'retail']);
  for (const vertical of verticals) if (!known.has(vertical)) failures.push(`LAUNCH_VERTICALS: unknown vertical ${vertical}`);
  if (verticals.some((v) => v === 'hotel' || v === 'flight')) {
    requireValue('AMADEUS_CLIENT_ID');
    requireValue('AMADEUS_CLIENT_SECRET');
    requireValue('AMADEUS_HOST', (v) => {
      try {
        const url = new URL(v);
        return url.origin === 'https://api.amadeus.com' && url.href === 'https://api.amadeus.com/';
      } catch { return false; }
    }, 'must be exactly the origin https://api.amadeus.com');
  }
  if (verticals.includes('ticket')) failures.push('LAUNCH_VERTICALS: ticket is unavailable because Ticketmaster Discovery does not attest all-in price inclusion');
  if (verticals.includes('subscription')) {
    const freshness = subscriptionCatalogFreshness({ env, now });
    if (!freshness.configValid) {
      failures.push('SUBSCRIPTION_CATALOG_MAX_AGE_DAYS: must be an integer from 1 to 365');
    } else if (!freshness.snapshotValid || freshness.invalidRows > 0 || freshness.rowCount === 0) {
      failures.push(`SUBSCRIPTION_CATALOG: catalog verification failed (${freshness.verifiedRows}/${freshness.rowCount} rows verified)`);
    } else if (freshness.stale) {
      failures.push(`SUBSCRIPTION_CATALOG: oldest verified row ${freshness.oldestAsOf} is ${Math.floor(freshness.ageSeconds / 86_400)} days old and exceeds the ${freshness.maxAgeDays}-day limit`);
    }
  }
  if (verticals.includes('retail')) {
    requireValue('RETAIL_API_URL', (v) => /^https:\/\//.test(v), 'must use HTTPS');
    requireValue('RETAIL_API_KEY');
  }
  return failures;
}

function args(argv) {
  const fileIndex = argv.indexOf('--env-file');
  return { envFile: fileIndex >= 0 ? argv[fileIndex + 1] : null };
}

async function main() {
  const { envFile } = args(process.argv.slice(2));
  let env = process.env;
  if (envFile) {
    const resolved = path.resolve(envFile);
    if (!fs.existsSync(resolved)) throw new Error(`environment file not found: ${resolved}`);
    env = parseEnv(fs.readFileSync(resolved, 'utf8'));
  }
  const failures = validateProductionEnv(env);
  if (failures.length) {
    console.error('Production launch gate FAILED:');
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
    return;
  }
  const catalog = await verifyLivePriceCatalog({ env });
  if (!catalog.ok) {
    console.error('Production launch gate FAILED: Stripe price catalog verification did not pass.');
    for (const plan of catalog.plans.filter((entry) => !entry.ok)) console.error(`  - ${plan.plan}: ${plan.failures.join(', ')}`);
    process.exitCode = 1;
    return;
  }
  console.log('Production launch gate passed: durable storage, email, workers, live billing, and declared launch data sources are configured.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

export { parseEnv, validateProductionEnv };
