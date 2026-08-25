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
  if (!data || !Number.isInteger(data.price_cents)) {
    const err = new Error('retail feed returned no integer price_cents');
    err.status = 502;
    throw err;
  }
  const context = {};
  if (Number.isInteger(data.shipping_cents)) context.shipping_cents = data.shipping_cents;
  if (typeof data.taxPct === 'number') context.taxPct = data.taxPct;
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
