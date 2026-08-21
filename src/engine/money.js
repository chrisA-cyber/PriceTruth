'use strict';

// All monetary amounts in PriceTruth are integer USD cents. Floating point
// never touches stored or summed money; percentages round half-up once.

function isCents(v) {
  return Number.isSafeInteger(v) && v >= 0 && v <= 1_000_000_000; // $10M cap
}

function assertCents(v, name = 'amount') {
  if (!isCents(v)) throw new RangeError(`${name} must be integer cents between 0 and 1e9, got ${v}`);
  return v;
}

// pct is a plain number like 13.38 (percent, not fraction). Round half-up.
// BigInt keeps exact half-cent products (e.g. 1500 × 5.1% = 76.5) from landing
// a hair below the boundary the way float multiplication does; pct is honored
// to 4 decimal places.
function pctOf(cents, pct) {
  assertCents(cents, 'pctOf base');
  if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0 || pct > 1000) {
    throw new RangeError(`pct out of range: ${pct}`);
  }
  const pctScaled = BigInt(Math.round(pct * 10_000));
  return Number((BigInt(cents) * pctScaled + 500_000n) / 1_000_000n);
}

function sum(items) {
  return items.reduce((acc, n) => acc + assertCents(n), 0);
}

function fmtUSD(cents, { compact = false } = {}) {
  assertCents(cents, 'fmtUSD');
  const dollars = Math.floor(cents / 100);
  const rem = cents % 100;
  const d = dollars.toLocaleString('en-US');
  if (compact && rem === 0) return `$${d}`;
  return `$${d}.${String(rem).padStart(2, '0')}`;
}

module.exports = { isCents, assertCents, pctOf, sum, fmtUSD };
