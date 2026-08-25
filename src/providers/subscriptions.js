// Subscriptions — matched against a dated open dataset of well-known consumer
// plans (src/data/plans/subscriptions.json). This is real, publicly-listed
// pricing at the snapshot date, not live-scraped; the honesty comes from the
// engine revealing the true first-year cost of the advertised teaser.

import PLANS from '../data/plans/subscriptions.json' with { type: 'json' };
import { hashStr, bandCents, titleize } from './http.js';

export const vertical = 'subscription';

// Dataset lookup is always "configured" — it ships in the repo.
export function configured() {
  return true;
}

function findPlan(q) {
  const s = String(q).trim().toLowerCase();
  if (!s) return null;
  // exact slug, then alias/name contains, then query contained in name.
  let hit = PLANS.plans.find((p) => p.slug === s);
  if (hit) return hit;
  hit = PLANS.plans.find((p) => (p.aliases || []).some((a) => a === s));
  if (hit) return hit;
  hit = PLANS.plans.find((p) => (p.aliases || []).some((a) => s.includes(a) || a.includes(s)) || p.name.toLowerCase().includes(s));
  return hit || null;
}

export function live(q) {
  const plan = findPlan(q);
  if (!plan) {
    const err = new Error('no matching plan in the dataset');
    err.status = 404;
    throw err;
  }
  const context = { pattern: plan.pattern };
  if (Number.isInteger(plan.introMonths)) context.introMonths = plan.introMonths;
  if (Number.isInteger(plan.renewal_cents)) context.renewal_cents = plan.renewal_cents;
  return {
    name: plan.name,
    url: null,
    advertised_cents: plan.advertised_cents,
    currency: 'USD',
    context,
    source: 'dataset:plans',
    sourceLabel: `Plan catalog snapshot ${PLANS.snapshot} — advertised price, verify current pricing`,
    certainty: 'typical',
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
    context: { pattern: 'default' },
    source: 'estimated:model',
    sourceLabel: 'Estimated example plan — not in the catalog snapshot',
    certainty: 'estimated',
  };
}

export const catalog = () => PLANS.plans.map((p) => ({ slug: p.slug, name: p.name, pattern: p.pattern }));
export const snapshot = PLANS.snapshot;
