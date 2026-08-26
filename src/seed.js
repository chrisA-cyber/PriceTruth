// Seeds the demo catalog and 90 days of deterministic synthetic price history.
// Synthetic data is clearly labeled as demo data in the UI; a production
// deployment replaces this with real tracked prices.

import { pathToFileURL } from 'node:url';
import { open } from './db.js';
import { analyze } from './engine/analyze.js';
import * as subscriptions from './providers/subscriptions.js';

// Small deterministic PRNG so every seed run produces identical history.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

const DEMO_PRODUCTS = [
  {
    id: 'vegas-hotel',
    vertical: 'hotel',
    name: 'Historical pre-rule demo — Las Vegas hotel',
    url: 'https://example.com/hotels/meridian-grand',
    advertised_cents: 21900,
    context: { market: 'las_vegas', nights: 3, resortFee_cents: 4500, tax_cents: 3800, parking_cents: 1500, mandatoryFeesIncluded: false, taxesIncluded: false, priceBasis: 'pre_rule', asOf: '2024-12-01', feeEvidence: 'Synthetic historical demo where mandatory fees were listed separately before the FTC all-in rule.' },
    source: 'demo:historical', sourceLabel: 'Synthetic historical pre-rule lodging example; not a current offer', certainty: 'estimated',
    walk: { low: 18900, high: 26900, vol: 0.06 },
  },
  {
    id: 'lcc-flight',
    vertical: 'flight',
    name: 'LAX → LAS one-way, low-cost carrier',
    url: 'https://example.com/flights/lax-las',
    advertised_cents: 18900,
    context: {
      carrier: 'typical_lcc', carryOn_cents: 4500, seat_cents: 3200,
      channel: 'ota', bookingFee_cents: 800, taxesIncluded: false, taxes_cents: 2000,
      priceBasis: 'base_fare', feeEvidence: 'Synthetic model explicitly represents a base fare before separately listed government taxes.',
    },
    walk: { low: 12900, high: 24900, vol: 0.1 },
  },
  {
    id: 'arena-ticket',
    vertical: 'ticket',
    name: 'Historical pre-rule demo — arena ticket',
    url: 'https://example.com/events/arena-tour',
    advertised_cents: 8600,
    context: { platform: 'ticketmaster', serviceFee_cents: 2795, facility_cents: 700, orderProcessing_cents: 595, tax_cents: 710, allInclusivePricing: false, priceBasis: 'pre_rule', asOf: '2024-12-01', feeEvidence: 'Synthetic historical demo where the shown face value excluded mandatory ticket fees before the FTC rule.' },
    source: 'demo:historical', sourceLabel: 'Synthetic historical pre-rule ticket example; not a current offer', certainty: 'estimated',
    walk: { low: 7400, high: 12900, vol: 0.08 },
  },
  {
    id: 'stream-sub',
    vertical: 'subscription',
    name: 'StreamMax Standard ("$9.99/month")',
    url: 'https://example.com/streammax',
    advertised_cents: 999,
    context: { pattern: 'streaming', introMonths: 6, renewal_cents: 1999 },
    walk: { low: 799, high: 1099, vol: 0.02 },
  },
  {
    id: 'anc-headphones',
    vertical: 'retail',
    name: 'Aurora ANC wireless headphones',
    url: 'https://example.com/shop/aurora-anc',
    advertised_cents: 29900,
    context: {},
    walk: { low: 21900, high: 31900, vol: 0.07 },
  },
];

function hashSeed(id) {
  let h = 2166136261;
  for (const ch of id) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

async function seed(db) {
  for (const p of DEMO_PRODUCTS) {
    const source = p.source || 'demo:seed';
    const sourceLabel = p.sourceLabel || 'Synthetic seeded demonstration; not a current offer';
    await db.upsertProduct({
      ...p,
      source,
      sourceLabel,
      certainty: p.certainty || 'estimated',
      evidence: {
        ...(p.evidence || {}),
        demo: true,
        refreshable: false,
        provenance: { source, sourceLabel, evidenceType: 'synthetic_demo', observed: false, demo: true, stale: true, alertEligible: false },
      },
    });
    const pointProvenance = JSON.stringify({
      provenance: { source, sourceLabel, evidenceType: 'synthetic_demo', observed: false, demo: true, stale: true, alertEligible: false },
    });
    // Repair older developer databases whose reserved demo points predate the
    // provenance columns. These ids are removed entirely in non-demo production.
    if (typeof db.repairDemoPricePoints === 'function') {
      await db.repairDemoPricePoints(p.id, {
        source, sourceLabel, certainty: p.certainty || 'estimated', evidenceJson: pointProvenance,
      });
    } else if (db.raw?.prepare) {
      db.raw.prepare(`UPDATE price_points SET source=?,source_label=?,certainty=?,observed=0,alert_eligible=0,evidence_json=? WHERE product_id=?`)
        .run(source, sourceLabel, p.certainty || 'estimated', pointProvenance, p.id);
    }
    const existing = await db.getLatestPoint(p.id, { eligibleOnly: false });
    if (existing) continue; // idempotent: don't duplicate history on re-run

    const rand = lcg(hashSeed(p.id));
    const report = analyze({ vertical: p.vertical, advertised_cents: p.advertised_cents, context: p.context, baseCertainty: 'estimated' });
    const ratio = report.truePrice.amount_cents / p.advertised_cents;

    let price = Math.round((p.walk.low + p.walk.high) / 2);
    const points = [];
    for (let day = 90; day >= 1; day--) {
      const drift = (rand() - 0.5) * 2 * p.walk.vol * price;
      price = Math.round(Math.min(p.walk.high, Math.max(p.walk.low, price + drift)));
      points.push({ day, advertised_cents: price });
    }
    // Today's point is the live demo price so the UI, engine, and history agree.
    points.push({ day: 0, advertised_cents: p.advertised_cents });

    for (const pt of points) {
      const ts = new Date(Date.now() - pt.day * 86_400_000).toISOString();
      await db.addPricePoint(p.id, {
        ts,
        advertised_cents: pt.advertised_cents,
        true_cents: Math.round(pt.advertised_cents * ratio),
        source,
        sourceLabel,
        certainty: p.certainty || 'estimated',
        observed: false,
        alertEligible: false,
        evidence: { provenance: { source, sourceLabel, evidenceType: 'synthetic_demo', observed: false, demo: true, stale: true, alertEligible: false } },
      });
    }
  }
}

async function removeDemoSeed(db) {
  let removed = 0;
  for (const product of DEMO_PRODUCTS) {
    if (typeof db.removeDemoProduct === 'function') {
      removed += Number(await db.removeDemoProduct(product.id)) || 0;
      continue;
    }
    await db.cancelProductJobs?.(product.id);
    db.raw.prepare('DELETE FROM alerts WHERE product_id=?').run(product.id);
    db.raw.prepare('DELETE FROM watchlist WHERE product_id=?').run(product.id);
    db.raw.prepare('DELETE FROM price_points WHERE product_id=?').run(product.id);
    removed += db.raw.prepare('DELETE FROM products WHERE id=?').run(product.id).changes;
  }
  return removed;
}

async function seedSubscriptionCatalog(db) {
  const now = new Date().toISOString();
  let inserted = 0;
  for (const entry of subscriptions.catalog()) {
    const listing = subscriptions.live(entry.slug);
    const asOf = new Date(listing.asOf).toISOString();
    const maxAgeSeconds = listing.maxAgeSeconds || 93 * 86_400;
    const stale = Math.max(0, Date.now() - Date.parse(asOf)) > maxAgeSeconds * 1000;
    const alertEligible = listing.refreshable === true && listing.alertEligible === true && !stale;
    const id = `catalog-sub-${entry.slug}`.slice(0, 64);
    const provenance = {
      source: listing.source,
      sourceLabel: listing.sourceLabel,
      evidenceType: 'catalog_snapshot',
      observed: false,
      degraded: false,
      demo: false,
      fetchedAt: now,
      asOf,
      maxAgeSeconds,
      ageSeconds: Math.max(0, Math.floor((Date.now() - Date.parse(asOf)) / 1000)),
      stale,
      alertEligible,
    };
    await db.upsertProduct({
      id,
      vertical: 'subscription',
      name: listing.name,
      url: listing.url,
      advertised_cents: listing.advertised_cents,
      context: listing.context,
      source: listing.source,
      sourceLabel: listing.sourceLabel,
      certainty: listing.certainty,
      fetchedAt: now,
      evidence: {
        originalQuery: entry.slug,
        providerIdentity: listing.providerIdentity,
        refreshable: true,
        alertEligible,
        provenance,
        items: [{ type: 'catalog_snapshot', source: listing.source, label: listing.sourceLabel, observed: false, asOf, fetchedAt: now }],
      },
      visibility: 'curated',
    });
    const report = analyze({ vertical: 'subscription', advertised_cents: listing.advertised_cents, context: listing.context, baseCertainty: 'catalog' });
    const latest = await db.getLatestPoint(id, { eligibleOnly: false });
    if (!latest || latest.evidence?.provenance?.asOf !== asOf || latest.true_cents !== report.truePrice.amount_cents) {
      await db.addPricePoint(id, {
        ts: asOf,
        advertised_cents: listing.advertised_cents,
        true_cents: report.truePrice.amount_cents,
        source: listing.source,
        sourceLabel: listing.sourceLabel,
        certainty: listing.certainty,
        observed: false,
        alertEligible,
        fetchedAt: now,
        evidence: { provenance, items: [{ type: 'catalog_snapshot', source: listing.source, label: listing.sourceLabel, observed: false, asOf, fetchedAt: now }] },
        providerKey: listing.source,
      });
      inserted += 1;
    }
  }
  return inserted;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = open();
  await seed(db);
  const demoKey = await db.createApiKey('local demo key', 'starter');
  console.log(`Seeded ${DEMO_PRODUCTS.length} demo products with 90 days of history.`);
  console.log('B2B demo API key (shown once, store it now):');
  console.log(`  ${demoKey}`);
  await db.close();
}

export { seed, seedSubscriptionCatalog, removeDemoSeed, DEMO_PRODUCTS };
