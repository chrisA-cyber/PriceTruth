'use strict';

// Engine unit tests: the four pitch scenarios (exact demo-product contexts),
// default estimation paths with honest certainty tags, quantity math,
// integer-cents money helpers, and the deal-quality scorer.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { analyze, VERTICALS } = require('../src/engine/analyze');
const { isCents, assertCents, pctOf, sum, fmtUSD } = require('../src/engine/money');
const { dealQuality } = require('../src/engine/score');

const byCode = (report, code) => report.lineItems.find((i) => i.code === code);
const itemsTotal = (report) => report.lineItems.reduce((acc, i) => acc + i.amount_cents, 0);

describe('analyze: pitch scenarios (exact demo-product contexts)', () => {
  it('hotel: Vegas $219/night is really $317/night, $951 for 3 nights', () => {
    const r = analyze({
      vertical: 'hotel',
      advertised_cents: 21900,
      context: { market: 'las_vegas', nights: 3, resortFee_cents: 4500, tax_cents: 3800, parking_cents: 1500 },
    });
    assert.equal(r.vertical, 'hotel');
    assert.equal(r.currency, 'USD');
    assert.deepEqual(r.advertised, { amount_cents: 21900, unit: 'per_night' });
    assert.deepEqual(r.truePrice, { amount_cents: 31700, unit: 'per_night' });
    assert.deepEqual(r.total, { amount_cents: 95100, label: '3-night stay total' });
    assert.equal(itemsTotal(r), 31700);
    assert.equal(byCode(r, 'resort_fee').amount_cents, 4500);
    assert.equal(byCode(r, 'taxes').amount_cents, 3800);
    assert.equal(byCode(r, 'parking').amount_cents, 1500);
    // Every component was supplied by the caller -> fully listed, full confidence.
    assert.ok(r.lineItems.every((i) => i.certainty === 'listed'));
    assert.equal(r.confidence, 1);
    assert.equal(r.feeLoadPct, 44.7);
  });

  it('flight: LCC $189 fare is really $294 flown', () => {
    const r = analyze({
      vertical: 'flight',
      advertised_cents: 18900,
      context: {
        carrier: 'typical_lcc', carryOn_cents: 4500, seat_cents: 3200,
        channel: 'ota', bookingFee_cents: 800, taxesIncluded: false, taxes_cents: 2000,
      },
    });
    assert.deepEqual(r.advertised, { amount_cents: 18900, unit: 'per_fare' });
    assert.deepEqual(r.truePrice, { amount_cents: 29400, unit: 'per_fare' });
    assert.equal(r.total, null); // single traveler
    assert.equal(itemsTotal(r), 29400);
    assert.equal(byCode(r, 'carry_on').amount_cents, 4500);
    assert.equal(byCode(r, 'seat').amount_cents, 3200);
    assert.equal(byCode(r, 'booking_fee').amount_cents, 800);
    assert.equal(byCode(r, 'taxes').amount_cents, 2000);
    assert.ok(r.lineItems.every((i) => i.certainty === 'listed'));
    assert.equal(r.confidence, 1);
    assert.equal(r.feeLoadPct, 55.6);
  });

  it('ticket: $86 face is really $134 at checkout', () => {
    const r = analyze({
      vertical: 'ticket',
      advertised_cents: 8600,
      context: { platform: 'ticketmaster', serviceFee_cents: 2795, facility_cents: 700, orderProcessing_cents: 595, tax_cents: 710 },
    });
    assert.deepEqual(r.advertised, { amount_cents: 8600, unit: 'per_ticket' });
    assert.deepEqual(r.truePrice, { amount_cents: 13400, unit: 'checkout_total' });
    assert.deepEqual(r.total, { amount_cents: 13400, label: 'Checkout estimate' });
    assert.equal(itemsTotal(r), 13400);
    assert.equal(byCode(r, 'service_fee').amount_cents, 2795);
    assert.equal(byCode(r, 'order_processing').amount_cents, 595);
    assert.ok(r.lineItems.every((i) => i.certainty === 'listed'));
    assert.equal(r.confidence, 1);
    assert.equal(r.feeLoadPct, 55.8);
  });

  it('subscription: "$9.99/month" is really $179.88 the first year', () => {
    const r = analyze({
      vertical: 'subscription',
      advertised_cents: 999,
      context: { pattern: 'streaming', introMonths: 6, renewal_cents: 1999 },
    });
    assert.deepEqual(r.advertised, { amount_cents: 999, unit: 'per_month' });
    assert.deepEqual(r.truePrice, { amount_cents: 17988, unit: 'first_year' });
    assert.deepEqual(r.total, { amount_cents: 17988, label: 'First-year cost' });
    assert.equal(byCode(r, 'intro').amount_cents, 999 * 6);
    assert.equal(byCode(r, 'renewal').amount_cents, 1999 * 6);
    assert.ok(r.lineItems.every((i) => i.certainty === 'listed'));
    assert.equal(r.confidence, 1);
    assert.equal(r.feeLoadPct, 50.1); // vs 12x the advertised monthly price
    assert.ok(r.disclosures.some((d) => d.includes('$19.99/month after 6 months')));
  });
});

describe('analyze: default estimation paths', () => {
  it('hotel with only market las_vegas estimates fees honestly', () => {
    const r = analyze({ vertical: 'hotel', advertised_cents: 20000, context: { market: 'las_vegas' } });
    const resort = byCode(r, 'resort_fee');
    const taxes = byCode(r, 'taxes');
    const parking = byCode(r, 'parking');
    // Typical resort fee for the market (95% prevalence -> included).
    assert.equal(resort.amount_cents, 4500);
    assert.equal(resort.certainty, 'typical');
    assert.match(resort.note, /Las Vegas/);
    // Occupancy tax estimated on room + resort fee (taxAppliesToResortFee).
    assert.equal(taxes.amount_cents, pctOf(20000 + 4500, 13.38));
    assert.equal(taxes.amount_cents, 3278);
    assert.equal(taxes.certainty, 'estimated');
    // Parking typical for the market (80% prevalence).
    assert.equal(parking.amount_cents, 1800);
    assert.equal(parking.certainty, 'typical');
    assert.equal(r.truePrice.amount_cents, 20000 + 4500 + 3278 + 1800);
    // Two typicals + one estimate: 1 - 0.08 - 0.12 - 0.08.
    assert.equal(r.confidence, 0.72);
    assert.ok(r.confidence < 1);
    assert.ok(r.assumptions.length >= 2);
  });

  it('flight with defaults tags carrier-typical ancillaries as typical', () => {
    const r = analyze({ vertical: 'flight', advertised_cents: 15000, context: { carrier: 'spirit' } });
    assert.equal(byCode(r, 'carry_on').certainty, 'typical');
    assert.equal(byCode(r, 'carry_on').amount_cents, 6500);
    assert.equal(byCode(r, 'seat').certainty, 'typical');
    assert.ok(r.confidence < 1);
  });

  it('subscription with no context uses the default teaser pattern', () => {
    const r = analyze({ vertical: 'subscription', advertised_cents: 1000, context: {} });
    // default pattern: 6 intro months (typical), renewal estimated at 2.0x.
    assert.equal(byCode(r, 'intro').certainty, 'typical');
    assert.equal(byCode(r, 'renewal').certainty, 'estimated');
    assert.equal(byCode(r, 'renewal').amount_cents, 2000 * 6);
    assert.equal(r.truePrice.amount_cents, 1000 * 6 + 2000 * 6);
    assert.ok(r.confidence < 1);
  });
});

describe('analyze: ticket quantity math', () => {
  it('adds the order-processing fee once per order, not per ticket', () => {
    const r1 = analyze({ vertical: 'ticket', advertised_cents: 8600, context: { platform: 'ticketmaster', quantity: 1 } });
    const r4 = analyze({ vertical: 'ticket', advertised_cents: 8600, context: { platform: 'ticketmaster', quantity: 4 } });
    assert.equal(byCode(r1, 'order_processing').amount_cents, 595);
    assert.equal(byCode(r4, 'order_processing').amount_cents, 595); // unchanged at qty 4
    // Per-ticket items do scale with quantity.
    assert.equal(byCode(r4, 'face').amount_cents, 8600 * 4);
    assert.equal(byCode(r4, 'service_fee').amount_cents, pctOf(8600, 27.5) * 4);
    assert.equal(byCode(r4, 'facility').amount_cents, 600 * 4);
    assert.deepEqual(r4.total, { amount_cents: r4.truePrice.amount_cents, label: 'Checkout estimate (4 tickets)' });
  });
});

describe('analyze: subscription intro-month edges', () => {
  it('introMonths 12 covers the year: no renewal line item', () => {
    const r = analyze({ vertical: 'subscription', advertised_cents: 999, context: { introMonths: 12 } });
    assert.equal(r.lineItems.length, 1);
    assert.equal(r.lineItems[0].code, 'intro');
    assert.equal(byCode(r, 'renewal'), undefined);
    assert.equal(r.truePrice.amount_cents, 999 * 12);
    assert.equal(r.feeLoadPct, 0);
    assert.ok(!r.disclosures.some((d) => d.startsWith('Price rises')));
  });

  it('introMonths 0 bills the renewal price all 12 months', () => {
    const r = analyze({ vertical: 'subscription', advertised_cents: 999, context: { introMonths: 0, renewal_cents: 1999 } });
    assert.equal(byCode(r, 'intro'), undefined);
    assert.equal(byCode(r, 'renewal').amount_cents, 1999 * 12);
    assert.equal(r.truePrice.amount_cents, 1999 * 12);
    assert.ok(r.disclosures.some((d) => d.includes('after signup')));
  });
});

describe('analyze: retail', () => {
  it('applies taxPct as an estimated line on top of listed charges', () => {
    const r = analyze({ vertical: 'retail', advertised_cents: 10000, context: { taxPct: 8.25 } });
    const tax = byCode(r, 'tax');
    assert.equal(tax.amount_cents, 825);
    assert.equal(tax.certainty, 'estimated');
    assert.deepEqual(r.truePrice, { amount_cents: 10825, unit: 'total' });
    assert.equal(r.confidence, 0.88);
  });

  it('with no context the listed price is the true price', () => {
    const r = analyze({ vertical: 'retail', advertised_cents: 29900, context: {} });
    assert.equal(r.truePrice.amount_cents, 29900);
    assert.equal(r.feeLoadPct, 0);
  });
});

describe('analyze: invalid inputs throw', () => {
  it('rejects unknown verticals', () => {
    assert.throws(() => analyze({ vertical: 'car', advertised_cents: 100 }), RangeError);
    assert.throws(() => analyze({ vertical: '', advertised_cents: 100 }), RangeError);
  });
  it('rejects bad cents', () => {
    assert.throws(() => analyze({ vertical: 'hotel', advertised_cents: -1 }), RangeError);
    assert.throws(() => analyze({ vertical: 'hotel', advertised_cents: 10.5 }), RangeError);
    assert.throws(() => analyze({ vertical: 'hotel', advertised_cents: 1_000_000_001 }), RangeError);
    assert.throws(() => analyze({ vertical: 'hotel', advertised_cents: '100' }), RangeError);
    assert.throws(() => analyze({ vertical: 'hotel' }), RangeError);
  });
  it('rejects non-object requests', () => {
    assert.throws(() => analyze(null), TypeError);
    assert.throws(() => analyze('hotel'), TypeError);
  });
  it('rejects bad cents inside context too', () => {
    assert.throws(
      () => analyze({ vertical: 'hotel', advertised_cents: 20000, context: { resortFee_cents: -5 } }),
      RangeError,
    );
  });
  it('exports the five verticals', () => {
    assert.deepEqual(VERTICALS, ['hotel', 'flight', 'ticket', 'subscription', 'retail']);
  });
});

describe('money helpers', () => {
  it('pctOf rounds half-up on integer cents', () => {
    assert.equal(pctOf(105, 10), 11); // 10.5 -> 11
    assert.equal(pctOf(104, 10), 10); // 10.4 -> 10
    assert.equal(pctOf(50, 1), 1);    // 0.5 -> 1
    assert.equal(pctOf(10000, 8.25), 825);
    assert.equal(pctOf(0, 99), 0);
  });
  it('pctOf validates its inputs', () => {
    assert.throws(() => pctOf(100, -0.1), RangeError);
    assert.throws(() => pctOf(100, 1000.1), RangeError);
    assert.throws(() => pctOf(100, NaN), RangeError);
    assert.throws(() => pctOf(100, '10'), RangeError);
    assert.throws(() => pctOf(-1, 10), RangeError);
  });
  it('fmtUSD formats cents with thousands separators', () => {
    assert.equal(fmtUSD(123456), '$1,234.56');
    assert.equal(fmtUSD(5), '$0.05');
    assert.equal(fmtUSD(0), '$0.00');
    assert.equal(fmtUSD(100000000), '$1,000,000.00');
    assert.equal(fmtUSD(500000, { compact: true }), '$5,000');
    assert.equal(fmtUSD(500050, { compact: true }), '$5,000.50'); // compact only drops .00
    assert.throws(() => fmtUSD(-1), RangeError);
    assert.throws(() => fmtUSD(12.5), RangeError);
  });
  it('assertCents enforces the 0..1e9 integer bounds', () => {
    assert.equal(assertCents(0), 0);
    assert.equal(assertCents(1_000_000_000), 1_000_000_000);
    assert.throws(() => assertCents(-1), RangeError);
    assert.throws(() => assertCents(1_000_000_001), RangeError);
    assert.throws(() => assertCents(1.5), RangeError);
    assert.throws(() => assertCents(NaN), RangeError);
    assert.throws(() => assertCents('100'), RangeError);
    assert.throws(() => assertCents(2 ** 53), RangeError);
    assert.throws(() => assertCents(-1, 'resort_fee'), /resort_fee/); // name lands in the message
  });
  it('isCents and sum agree with assertCents', () => {
    assert.equal(isCents(100), true);
    assert.equal(isCents(-1), false);
    assert.equal(sum([100, 200, 3]), 303);
    assert.equal(sum([]), 0);
    assert.throws(() => sum([100, -1]), RangeError);
  });
});

describe('dealQuality', () => {
  it('always scores within [0, 100]', () => {
    const combos = [
      { current_cents: 100, low_cents: 50, high_cents: 150, avg_cents: 100, feeLoadPct: 0 },
      { current_cents: 1, low_cents: 1, high_cents: 1_000_000, avg_cents: 500_000, feeLoadPct: 300 },
      { current_cents: 1_000_000, low_cents: 1, high_cents: 1_000_000, avg_cents: 2, feeLoadPct: 500 },
      { current_cents: 0, low_cents: 0, high_cents: 0, avg_cents: 0, feeLoadPct: 0 },
    ];
    for (const c of combos) {
      const q = dealQuality(c);
      assert.ok(Number.isInteger(q.score), `score should be an integer for ${JSON.stringify(c)}`);
      assert.ok(q.score >= 0 && q.score <= 100);
      assert.equal(typeof q.label, 'string');
      assert.ok(Array.isArray(q.reasons) && q.reasons.length > 0);
    }
  });

  it('scores a fee-free price at the window low as a great deal', () => {
    const q = dealQuality({ current_cents: 10000, low_cents: 10000, high_cents: 20000, avg_cents: 15000, feeLoadPct: 0 });
    assert.equal(q.score, 100);
    assert.equal(q.label, 'great deal');
    assert.ok(q.reasons.some((s) => s.includes('window low')));
  });

  it('penalizes prices above the window average', () => {
    const below = dealQuality({ current_cents: 14000, low_cents: 10000, high_cents: 20000, avg_cents: 15000, feeLoadPct: 0 });
    const above = dealQuality({ current_cents: 16000, low_cents: 10000, high_cents: 20000, avg_cents: 15000, feeLoadPct: 0 });
    assert.ok(above.score < below.score);
    assert.ok(above.reasons.some((s) => s.startsWith('Above the')));
  });

  it('returns score null when history is missing', () => {
    const q = dealQuality({});
    assert.equal(q.score, null);
    assert.equal(q.label, 'no history');
    assert.ok(q.reasons.length > 0);
    assert.equal(dealQuality({ current_cents: 100 }).score, null);
    assert.equal(dealQuality({ current_cents: -1, low_cents: 0, high_cents: 1, avg_cents: 1 }).score, null);
  });

  it('fee load drags the score down', () => {
    const base = { current_cents: 12000, low_cents: 10000, high_cents: 20000, avg_cents: 15000 };
    const clean = dealQuality({ ...base, feeLoadPct: 0 });
    const feeHeavy = dealQuality({ ...base, feeLoadPct: 40 });
    assert.equal(clean.score - feeHeavy.score, 20); // full 20-point fee bucket lost
    assert.ok(feeHeavy.reasons.some((s) => s.includes('Hidden fees')));
  });

  it('handles the degenerate flat window (high == low)', () => {
    const q = dealQuality({ current_cents: 5000, low_cents: 5000, high_cents: 5000, avg_cents: 5000, feeLoadPct: 0 });
    assert.equal(q.score, 60); // 30 position + 10 avg + 20 fees
    assert.equal(q.label, 'good deal');
  });
});
