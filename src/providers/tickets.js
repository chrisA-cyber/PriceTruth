// Event tickets — live via the Ticketmaster Discovery API (free consumer key),
// with a clearly-labeled deterministic fallback when no key is configured.
// Set TICKETMASTER_API_KEY to go live: https://developer.ticketmaster.com/

import { httpJson, hashStr, bandCents, titleize } from './http.js';

const BASE = 'https://app.ticketmaster.com/discovery/v2/events.json';

export const vertical = 'ticket';

export function configured() {
  return Boolean(process.env.TICKETMASTER_API_KEY);
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
  return {
    name: picked.name,
    url: typeof picked.url === 'string' && picked.url.startsWith('https://') ? picked.url : null,
    advertised_cents: Math.round(priceRange.min * 100),
    currency: 'USD',
    context: { platform: 'ticketmaster' },
    source: 'live:ticketmaster',
    sourceLabel: 'Ticketmaster Discovery API — live lowest face value',
    certainty: 'live',
  };
}

export function fallback(q) {
  const cents = bandCents(hashStr(`ticket:${q}`), 3500, 15500); // $35–$155 face
  return {
    name: `${titleize(q) || 'Concert'} — example event`,
    url: null,
    advertised_cents: cents,
    currency: 'USD',
    context: { platform: 'ticketmaster' },
    source: 'estimated:model',
    sourceLabel: 'Estimated example face value — set TICKETMASTER_API_KEY for live events',
    certainty: 'estimated',
  };
}
