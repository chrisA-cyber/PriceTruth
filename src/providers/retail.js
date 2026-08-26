// Retail — there is no universal, ToS-clean, free real-time retail price API,
// so verified search fails closed until a pluggable RETAIL_API_URL feed is
// supplied. The illustrative helper below is never returned by public search.

import { httpJson, hashStr, bandCents, titleize } from './http.js';

export const vertical = 'retail';

export function configured() {
  return Boolean(process.env.RETAIL_API_URL);
}

// Optional generic client: GET RETAIL_API_URL?q=... expected to return JSON
// { name, url?, price_cents, currency?, shipping_cents?, handling_cents?,
//   handling_included?, mandatory_extras_included?, taxPct? }.
export async function live(q) {
  const base = process.env.RETAIL_API_URL;
  const url = `${base}${base.includes('?') ? '&' : '?'}q=${encodeURIComponent(q)}`;
  const headers = {};
  if (process.env.RETAIL_API_KEY) headers.Authorization = `Bearer ${process.env.RETAIL_API_KEY}`;
  const data = await httpJson(url, { headers, timeoutMs: 6000 });
  // Validate magnitudes, not just types: an out-of-range feed value must become
  // a safe source failure (the registry catches this throw), never crash the
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
  if (Number.isInteger(data.handling_cents) && data.handling_cents >= 0 && data.handling_cents <= MAX_CENTS) {
    context.handling_cents = data.handling_cents;
  } else if (data.handling_included === true) {
    context.handlingIncluded = true;
  } else if (data.mandatory_extras_included === true) {
    context.mandatoryExtrasIncluded = true;
  }
  if (typeof data.taxPct === 'number' && Number.isFinite(data.taxPct) && data.taxPct >= 0 && data.taxPct <= 1000) {
    context.taxPct = data.taxPct;
  }
  const explicitId = typeof data.id === 'string' ? data.id.trim() : '';
  const urlIdentity = typeof data.url === 'string' && data.url.startsWith('https://') ? data.url.trim() : '';
  const providerIdentity = explicitId.length > 0 && explicitId.length <= 200
    ? explicitId
    : urlIdentity.length > 0 && urlIdentity.length <= 200 ? urlIdentity : null;
  return {
    name: typeof data.name === 'string' ? data.name.slice(0, 120) : titleize(q),
    url: typeof data.url === 'string' && data.url.startsWith('https://') ? data.url : null,
    advertised_cents: data.price_cents,
    currency: data.currency === 'USD' || !data.currency ? 'USD' : data.currency,
    context,
    source: 'live:retail-feed',
    sourceLabel: 'Configured retail price feed',
    certainty: 'live',
    providerIdentity,
    refreshable: providerIdentity !== null,
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
    sourceLabel: 'Illustrative retail model — not a current seller quote',
    certainty: 'estimated',
  };
}
