// Flights — live via Amadeus Flight Offers Search, with a labeled fallback.
// Query is an origin/destination pair, e.g. "LAX-LAS", "SFO to JFK".
// Amadeus returns the base fare and grand total, so real government taxes are
// passed through as a *listed* line; ancillaries (carry-on, seat) are still the
// engine's typical estimates, which is honest for the drip we're modeling.

import * as amadeus from './amadeus.js';
import { hashStr, bandCents } from './http.js';

export const vertical = 'flight';

export function configured() {
  return amadeus.configured();
}

function parseRoute(q) {
  const codes = (String(q).toUpperCase().match(/[A-Z]{3}/g) || []).filter((c, i, a) => a.indexOf(c) === i);
  return codes.length >= 2 ? { origin: codes[0], destination: codes[1] } : null;
}

// Map an airline IATA code to one of the engine's carrier profiles. Unknown
// carriers fall through to the engine's own 'typical_lcc' default.
const LCC = new Set(['NK', 'F9', 'G4', 'SY', 'MX']); // Spirit, Frontier, Allegiant, Sun Country, Breeze
const LEGACY = new Set(['AA', 'DL', 'UA', 'AS', 'B6', 'WN', 'HA']);
function carrierProfile(code) {
  if (code === 'NK') return 'spirit';
  if (code === 'F9') return 'frontier';
  if (LCC.has(code)) return 'typical_lcc';
  if (LEGACY.has(code)) return 'typical_legacy';
  return 'typical_lcc';
}

export async function live(q) {
  const route = parseRoute(q);
  if (!route) {
    const err = new Error('flight query needs two airport codes, e.g. "LAX-LAS"');
    err.status = 400;
    throw err;
  }
  const departureDate = new Date(Date.now() + 21 * 86_400_000).toISOString().slice(0, 10);
  const qs = new URLSearchParams({
    originLocationCode: route.origin,
    destinationLocationCode: route.destination,
    departureDate,
    adults: '1',
    currencyCode: 'USD',
    max: '1',
    nonStop: 'false',
  }).toString();
  const data = await amadeus.get(`/v2/shopping/flight-offers?${qs}`);
  const offer = data && Array.isArray(data.data) ? data.data[0] : null;
  if (!offer || !offer.price) {
    const err = new Error(`no flight offers found for ${route.origin}→${route.destination}`);
    err.status = 404;
    throw err;
  }
  const base = Math.round(parseFloat(offer.price.base || offer.price.grandTotal) * 100);
  const grand = Math.round(parseFloat(offer.price.grandTotal || offer.price.base) * 100);
  const taxes = Math.max(0, grand - base);
  const code = Array.isArray(offer.validatingAirlineCodes) ? offer.validatingAirlineCodes[0] : null;
  const context = { carrier: carrierProfile(code), taxesIncluded: false };
  if (taxes > 0) context.taxes_cents = taxes;
  return {
    name: `${route.origin} → ${route.destination} one-way${code ? ` (${code})` : ''}`,
    url: null,
    advertised_cents: base,
    currency: 'USD',
    context,
    source: 'live:amadeus',
    sourceLabel: 'Amadeus Flight Offers — live base fare; taxes passed through, ancillaries typical',
    certainty: 'live',
  };
}

export function fallback(q) {
  const route = parseRoute(q);
  const seed = hashStr(`flight:${q}`);
  return {
    name: route ? `${route.origin} → ${route.destination} one-way — example` : 'Example one-way flight',
    url: null,
    advertised_cents: bandCents(seed, 5900, 28900), // $59–$289 base fare
    currency: 'USD',
    context: { carrier: 'typical_lcc', channel: 'ota', taxesIncluded: false },
    source: 'estimated:model',
    sourceLabel: 'Estimated example fare — set AMADEUS_CLIENT_ID/SECRET for live fares',
    certainty: 'estimated',
  };
}
