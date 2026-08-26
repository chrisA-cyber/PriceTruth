// Subscriptions — matched against a dated open dataset of well-known consumer
// plans (src/data/plans/subscriptions.json). This is real, publicly-listed
// pricing at the snapshot date, not live-scraped; the honesty comes from the
// engine revealing the true first-year cost of the advertised teaser.

import PLANS from '../data/plans/subscriptions.json' with { type: 'json' };
import { hashStr, bandCents, titleize } from './http.js';
import { isPublicHostname } from '../security.js';

export const vertical = 'subscription';
export const DEFAULT_CATALOG_MAX_AGE_DAYS = 93;
export const MAX_CATALOG_MAX_AGE_DAYS = 365;

// This provider is backed by a dated in-repo snapshot, not a live feed — the UI
// uses this to label it honestly as a catalog snapshot rather than "live data".
export const kind = 'dataset';

// Dataset lookup is always "configured" — it ships in the repo.
export function configured() {
  return true;
}

function dateAtUtcMidnight(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return NaN;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value
    ? timestamp
    : NaN;
}

function publicHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && isPublicHostname(url.hostname);
  } catch {
    return false;
  }
}

function maxAgeConfiguration(env = process.env) {
  const raw = env?.SUBSCRIPTION_CATALOG_MAX_AGE_DAYS;
  const supplied = raw !== undefined && String(raw).trim() !== '';
  const numeric = supplied && /^\d+$/.test(String(raw).trim()) ? Number(raw) : NaN;
  const configValid = !supplied || (Number.isSafeInteger(numeric) && numeric >= 1 && numeric <= MAX_CATALOG_MAX_AGE_DAYS);
  const maxAgeDays = configValid && supplied ? numeric : DEFAULT_CATALOG_MAX_AGE_DAYS;
  return { configValid, maxAgeDays, maxAgeSeconds: maxAgeDays * 86_400 };
}

function catalogRowValid(plan, { snapshot, now }) {
  const asOf = dateAtUtcMidnight(plan?.asOf);
  return Boolean(
    plan &&
    typeof plan.slug === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(plan.slug) &&
    typeof plan.name === 'string' && plan.name.trim().length > 0 && plan.name.length <= 160 &&
    Number.isSafeInteger(plan.advertised_cents) && plan.advertised_cents > 0 &&
    plan.sourceRegion === 'US' &&
    Number.isFinite(asOf) && asOf <= now && plan.asOf.startsWith(`${snapshot}-`) &&
    publicHttpsUrl(plan.sourceUrl) &&
    ['stable_monthly', 'fixed_term', 'teaser'].includes(plan.pricingMode) &&
    Number.isSafeInteger(plan.termMonths) && plan.termMonths >= 1 && plan.termMonths <= 120
  );
}

// Release/readiness status for the committed plan catalog. The oldest verified
// row controls freshness so a newly bumped snapshot label cannot conceal an old
// plan. Invalid/future rows and invalid max-age configuration fail closed.
export function catalogFreshness({ env = process.env, now = Date.now(), catalogData = PLANS } = {}) {
  const currentTime = Number(now);
  const safeNow = Number.isFinite(currentTime) ? currentTime : Date.now();
  const { configValid, maxAgeDays, maxAgeSeconds } = maxAgeConfiguration(env);
  const snapshot = typeof catalogData?.snapshot === 'string' ? catalogData.snapshot : '';
  const snapshotValid = /^\d{4}-\d{2}$/.test(snapshot);
  const rows = Array.isArray(catalogData?.plans) ? catalogData.plans : [];
  const seen = new Set();
  const validDates = [];
  let invalidRows = 0;

  for (const plan of rows) {
    const duplicate = typeof plan?.slug === 'string' && seen.has(plan.slug);
    if (typeof plan?.slug === 'string') seen.add(plan.slug);
    if (!snapshotValid || duplicate || !catalogRowValid(plan, { snapshot, now: safeNow })) {
      invalidRows += 1;
      continue;
    }
    validDates.push(dateAtUtcMidnight(plan.asOf));
  }

  const oldest = validDates.length ? Math.min(...validDates) : null;
  const newest = validDates.length ? Math.max(...validDates) : null;
  const ageSeconds = oldest === null ? null : Math.max(0, Math.floor((safeNow - oldest) / 1000));
  const stale = ageSeconds === null || ageSeconds > maxAgeSeconds;
  const rowsValid = rows.length > 0 && invalidRows === 0 && validDates.length === rows.length;
  const ok = configValid && snapshotValid && rowsValid && !stale;
  const status = !configValid || !snapshotValid || !rowsValid ? 'invalid' : stale ? 'stale' : 'fresh';

  return {
    ok,
    status,
    stale,
    snapshot: snapshot || null,
    snapshotValid,
    configValid,
    rowCount: rows.length,
    verifiedRows: validDates.length,
    invalidRows,
    oldestAsOf: oldest === null ? null : new Date(oldest).toISOString().slice(0, 10),
    newestAsOf: newest === null ? null : new Date(newest).toISOString().slice(0, 10),
    ageSeconds,
    ageDays: ageSeconds === null ? null : Math.floor((ageSeconds / 86_400) * 100) / 100,
    maxAgeDays,
    maxAgeSeconds,
    freshThrough: oldest === null ? null : new Date(oldest + maxAgeSeconds * 1000).toISOString(),
  };
}

export const freshness = catalogFreshness;

function normalizePlanQuery(value) {
  return String(value || '').normalize('NFKC').toLowerCase()
    .replace(/\+/g, ' plus ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function findPlan(q) {
  const query = normalizePlanQuery(q);
  if (!query) return null;

  const exact = PLANS.plans.filter((plan) => {
    const names = [plan.slug, plan.name, ...(plan.aliases || [])].map(normalizePlanQuery);
    return names.includes(query);
  });
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;

  // Fuzzy matching is deliberately one-way and brand-anchored: a complete,
  // four-or-more-character alias may appear as a token phrase in a longer
  // shopper query. Short fragments and generic name tokens (for example
  // "premium") never select the first plausible brand.
  const paddedQuery = ` ${query} `;
  const candidates = PLANS.plans.filter((plan) => (plan.aliases || []).some((alias) => {
    const phrase = normalizePlanQuery(alias);
    return phrase.length >= 4 && paddedQuery.includes(` ${phrase} `);
  }));
  return candidates.length === 1 ? candidates[0] : null;
}

export function live(q) {
  const plan = findPlan(q);
  if (!plan) {
    const err = new Error('no matching plan in the dataset');
    err.status = 404;
    throw err;
  }
  if (!catalogRowValid(plan, { snapshot: PLANS.snapshot, now: Date.now() })) {
    const err = new Error('catalog plan is missing approved pricing provenance');
    err.status = 502;
    throw err;
  }
  const context = { pattern: plan.pattern, pricingMode: plan.pricingMode, termMonths: plan.termMonths, sourceRegion: plan.sourceRegion };
  if (Number.isInteger(plan.introMonths)) context.introMonths = plan.introMonths;
  if (Number.isInteger(plan.renewal_cents)) context.renewal_cents = plan.renewal_cents;
  if (plan.billedUpfront) context.billedUpfront = true;
  return {
    name: plan.name,
    url: typeof plan.sourceUrl === 'string' ? plan.sourceUrl : null,
    advertised_cents: plan.advertised_cents,
    currency: 'USD',
    context,
    source: 'dataset:plans',
    sourceLabel: `Plan catalog snapshot ${PLANS.snapshot} — sourced term framing; renewal shown only when explicitly catalogued`,
    certainty: 'catalog',
    asOf: `${plan.asOf || `${PLANS.snapshot}-01`}T00:00:00.000Z`,
    maxAgeSeconds: maxAgeConfiguration(process.env).maxAgeSeconds,
    providerIdentity: plan.slug,
    refreshable: true,
    alertEligible: true,
  };
}

export function fallback(q) {
  // Query didn't match a catalogued plan: model a generic subscription.
  const seed = hashStr(`sub:${q}`);
  return {
    name: `${titleize(q) || 'Subscription'} — example plan`,
    url: null,
    advertised_cents: bandCents(seed, 499, 2999), // $4.99–$29.99/mo
    currency: 'USD',
    context: { pattern: 'default', pricingMode: 'stable_monthly', termMonths: 12 },
    source: 'estimated:model',
    sourceLabel: 'Estimated example plan — not in the catalog snapshot',
    certainty: 'estimated',
  };
}

export const catalog = () => PLANS.plans.map((p) => ({ slug: p.slug, name: p.name, pattern: p.pattern }));
export const snapshot = PLANS.snapshot;
