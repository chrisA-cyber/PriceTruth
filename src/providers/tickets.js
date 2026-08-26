// Event tickets — Ticketmaster discovery metadata plus a fail-closed all-in
// truth gate. The fallback helper is only for explicit illustrative fixtures.
// Set TICKETMASTER_API_KEY to go live: https://developer.ticketmaster.com/

import { httpJson, hashStr, bandCents, titleize } from './http.js';

const BASE = 'https://app.ticketmaster.com/discovery/v2/events.json';

export const vertical = 'ticket';

export function credentialsPresent() {
  return Boolean(process.env.TICKETMASTER_API_KEY);
}

export function configured() {
  // Discovery v2 priceRanges has no field that attests mandatory-fee
  // inclusion. Credentials alone therefore are not a truth-usable live source.
  return false;
}

export const unavailableReason = 'discovery-price-inclusion-unverified';

export function normalizeTicketEvent(event, priceRange) {
  const currency = String(priceRange?.currency || '').toUpperCase();
  if (currency !== 'USD' || !Number.isFinite(priceRange?.min) || priceRange.min <= 0) {
    const err = new Error('ticket source returned no usable USD price');
    err.status = 502;
    throw err;
  }
  const explicitAllIn = priceRange?.allInclusivePricing === true || event?.allInclusivePricing === true;
  if (!explicitAllIn) {
    const err = new Error('ticket source does not explicitly attest that the returned price includes mandatory fees');
    err.status = 502;
    throw err;
  }
  return {
    name: event.name,
    url: typeof event.url === 'string' && event.url.startsWith('https://') ? event.url : null,
    advertised_cents: Math.round(priceRange.min * 100),
    currency: 'USD',
    context: { platform: 'ticketmaster', allInclusivePricing: true },
    source: 'live:ticketmaster',
    sourceLabel: 'Ticket source — explicitly attested mandatory-fee-inclusive listed price',
    certainty: 'live',
    providerIdentity: typeof event.id === 'string' ? event.id : null,
    refreshable: typeof event.id === 'string',
  };
}

export async function live(q) {
  const key = process.env.TICKETMASTER_API_KEY;
  const url = `${BASE}?size=5&sort=relevance,desc&keyword=${encodeURIComponent(q)}&apikey=${encodeURIComponent(key)}`;
  const data = await httpJson(url, { timeoutMs: 6000 });
  const events = data && data._embedded && Array.isArray(data._embedded.events) ? data._embedded.events : [];
  // Prefer the first event that actually lists a USD price range.
  let picked = null;
  let priceRange = null;
  for (const ev of events) {
    const pr = Array.isArray(ev.priceRanges) ? ev.priceRanges.find((p) => p.currency === 'USD' && typeof p.min === 'number') : null;
    if (pr) { picked = ev; priceRange = pr; break; }
  }
  if (!picked) {
    const err = new Error('no matching event with a listed USD price');
    err.status = 404;
    throw err;
  }
  return normalizeTicketEvent(picked, priceRange);
}

export function fallback(q) {
  const cents = bandCents(hashStr(`ticket:${q}`), 3500, 15500); // $35–$155 modeled all-in example
  return {
    name: `${titleize(q) || 'Concert'} — example event`,
    url: null,
    advertised_cents: cents,
    currency: 'USD',
    context: { platform: 'ticketmaster' },
    source: 'estimated:model',
    sourceLabel: 'Modeled mandatory-fee-inclusive example — no verified live all-in ticket feed configured',
    certainty: 'estimated',
  };
}
