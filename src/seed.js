// Seeds the demo catalog and 90 days of deterministic synthetic price history.
// Synthetic data is clearly labeled as demo data in the UI; a production
// deployment replaces this with real tracked prices.

import { pathToFileURL } from 'node:url';
import { open } from './db.js';
import { analyze } from './engine/analyze.js';

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
    name: 'The Meridian Grand — Las Vegas Strip',
    url: 'https://example.com/hotels/meridian-grand',
    advertised_cents: 21900,
    context: { market: 'las_vegas', nights: 3, resortFee_cents: 4500, tax_cents: 3800, parking_cents: 1500 },
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
    },
    walk: { low: 12900, high: 24900, vol: 0.1 },
  },
  {
    id: 'arena-ticket',
    vertical: 'ticket',
    name: 'Arena concert — lower bowl ticket',
    url: 'https://example.com/events/arena-tour',
    advertised_cents: 8600,
    context: { platform: 'ticketmaster', serviceFee_cents: 2795, facility_cents: 700, orderProcessing_cents: 595, tax_cents: 710 },
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

function seed(db) {
  for (const p of DEMO_PRODUCTS) {
    db.upsertProduct(p);
    const existing = db.getLatestPoint(p.id);
    if (existing) continue; // idempotent: don't duplicate history on re-run

    const rand = lcg(hashSeed(p.id));
    const report = analyze({ vertical: p.vertical, advertised_cents: p.advertised_cents, context: p.context });
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
      db.addPricePoint(p.id, {
        ts,
        advertised_cents: pt.advertised_cents,
        true_cents: Math.round(pt.advertised_cents * ratio),
      });
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = open();
  seed(db);
  const demoKey = db.createApiKey('local demo key', 'starter');
  console.log(`Seeded ${DEMO_PRODUCTS.length} demo products with 90 days of history.`);
  console.log('B2B demo API key (shown once, store it now):');
  console.log(`  ${demoKey}`);
  db.close();
}

export { seed, DEMO_PRODUCTS };
