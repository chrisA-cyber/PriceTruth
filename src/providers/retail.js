// Retail — there is no universal, ToS-clean, free real-time retail price API,
// so this provider is honest about that: it returns a clearly-labeled example
// price for the query and exposes a pluggable slot (RETAIL_API_URL) for a real
// feed to be dropped in later. The engine still reveals shipping/handling/tax
// on top of whatever base price is supplied, which is the point.

import { httpJson, hashStr, bandCents, titleize } from './http.js';

export const vertical = 'retail';

export function configured() {
  return Boolean(process.env.RETAIL_API_URL);
}

// Optional generic client: GET RETAIL_API_URL?q=... expected to return JSON
// { name, url?, price_cents, currency?, shipping_cents?, taxPct? }.
export async function live(q) {
  const base = process.env.RETAIL_API_URL;
  const url = `${base}${base.includes('?') ? '&' : '?'}q=${encodeURIComponent(q)}`;
  const headers = {};
  if (process.env.RETAIL_API_KEY) headers.Authorization = `Bearer ${process.env.RETAIL_API_KEY}`;
  const data = await httpJson(url, { headers, timeoutMs: 6000 });
  // Validate magnitudes, not just types: an out-of-range feed value must degrade
  // to a labeled estimate (the registry catches this throw), never crash the
  // pricing engine with a 500. Bounds mirror the engine's integer-cents cap.
  const MAX_CENTS = 1_000_000_000; // $10M, matches money.js isCents
  if (!Number.isInteger(data.price_cents) || data.price_cents < 0 || data.price_cents > MAX_CENTS) {
    const err = new Error('retail feed returned an out-of-range price_cents');
    err.status = 502;
    throw err;
  }
  const context = {};
  // Optional fields are included only when sane; a bad one is dropped, not fatal.
  if (Number.isInteger(data.shipping_cents) && data.shipping_cents >= 0 && data.shipping_cents <= MAX_CENTS) {
    context.shipping_cents = data.shipping_cents;
  }
  if (typeof data.taxPct === 'number' && Number.isFinite(data.taxPct) && data.taxPct >= 0 && data.taxPct <= 1000) {
    context.taxPct = data.taxPct;
  }
  return {
    name: typeof data.name === 'string' ? data.name.slice(0, 120) : titleize(q),
    url: typeof data.url === 'string' && data.url.startsWith('https://') ? data.url : null,
    advertised_cents: data.price_cents,
    currency: data.currency === 'USD' || !data.currency ? 'USD' : data.currency,
    context,
    source: 'live:retail-feed',
    sourceLabel: 'Configured retail feed (RETAIL_API_URL)',
    certainty: 'live',
  };
}

export function fallback(q) {
  const seed = hashStr(`retail:${q}`);
  return {
    name: `${titleize(q) || 'Product'} — example listing`,
    url: null,
    advertised_cents: bandCents(seed, 1999, 49999), // $19.99–$499.99
    currency: 'USD',
    context: {},
    source: 'estimated:model',
    sourceLabel: 'Estimated example price — set RETAIL_API_URL to connect a real feed',
    certainty: 'estimated',
  };
}
