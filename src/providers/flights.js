// Flights — live via Amadeus Flight Offers Search. The fallback helper is kept
// only for explicit illustrative fixtures; public search never calls it.
// Query is an origin/destination pair, e.g. "LAX-LAS", "SFO to JFK".
// Amadeus returns a seller-listed grand total. Optional ancillaries must never
// be invented from a carrier profile unless the shopper explicitly selected
// them and the offer proves their cost.

import * as amadeus from './amadeus.js';
import { hashStr, bandCents } from './http.js';

export const vertical = 'flight';

export function credentialsPresent(env = process.env) {
  return amadeus.credentialsPresent(env);
}

export function configured(env = process.env) {
  return amadeus.configured(env);
}

function parseRoute(q) {
  const input = String(q || '').normalize('NFKC').trim().replace(/\s+/g, ' ');
  // Accept only an explicit pair of uppercase, standalone IATA-shaped codes.
  // Extracting arbitrary three-letter chunks turns natural-language cities
  // such as Boston or New York into bogus BOS→TON / NEW→YOR routes.
  const match = /^([A-Za-z]{3})(?:\s*[-–—→/]\s*|\s+to\s+)([A-Za-z]{3})$/i.exec(input);
  if (!match || match[1] !== match[1].toUpperCase() || match[2] !== match[2].toUpperCase()) return null;
  if (match[1] === match[2]) return null;
  return { origin: match[1], destination: match[2] };
}

// Map an airline IATA code to one of the engine's carrier profiles. Unknown
// carriers use the neutral profile rather than fabricating low-cost fees.
const LCC = new Set(['NK', 'F9', 'G4', 'SY', 'MX']); // Spirit, Frontier, Allegiant, Sun Country, Breeze
const LEGACY = new Set(['AA', 'DL', 'UA', 'AS', 'B6', 'WN', 'HA']);
function carrierProfile(code) {
  if (code === 'NK') return 'spirit';
  if (code === 'F9') return 'frontier';
  if (LCC.has(code)) return 'typical_lcc';
  if (LEGACY.has(code)) return 'typical_legacy';
  return 'neutral';
}
export function validateQuery(q) { return Boolean(parseRoute(q)); }

export function normalizeFlightOffer(offer, route, assumptions = {}) {
  if (!offer?.price) throw Object.assign(new Error('flight offer has no price'), { status: 502 });
  const currency = String(offer.price.currency || '').toUpperCase();
  if (currency !== 'USD') throw Object.assign(new Error('flight offer is not denominated in USD'), { status: 502 });
  const total = Number(offer.price.grandTotal ?? offer.price.total);
  if (!Number.isFinite(total) || total <= 0) throw Object.assign(new Error('flight offer has no usable all-in total'), { status: 502 });
  const advertisedCents = Math.round(total * 100);
  if (!Number.isSafeInteger(advertisedCents) || advertisedCents > 1_000_000_000) throw Object.assign(new Error('flight offer total is out of range'), { status: 502 });
  const code = Array.isArray(offer.validatingAirlineCodes) ? offer.validatingAirlineCodes[0] : null;
  const offeredDepartureDate = String(offer?.itineraries?.[0]?.segments?.[0]?.departure?.at || '').slice(0, 10);
  if (offeredDepartureDate && !/^\d{4}-\d{2}-\d{2}$/.test(offeredDepartureDate)) {
    throw Object.assign(new Error('flight offer has an invalid departure date'), { status: 502 });
  }
  if (assumptions.departureDate && offeredDepartureDate && assumptions.departureDate !== offeredDepartureDate) {
    throw Object.assign(new Error('flight offer departure date does not match the requested quote date'), { status: 502 });
  }
  const departureDate = offeredDepartureDate || assumptions.departureDate || null;
  const adults = Number.isInteger(assumptions.adults) && assumptions.adults > 0 ? assumptions.adults : null;
  const quoteContext = departureDate && adults ? {
    departureDate,
    adults,
    tripType: assumptions.tripType || 'one_way',
    nonStopOnly: assumptions.nonStopOnly === true,
  } : {};
  const assumptionLabel = departureDate && adults
    ? ` for ${adults} adult${adults === 1 ? '' : 's'}, one-way departing ${departureDate}`
    : '';
  return {
    name: `${route.origin} → ${route.destination} one-way${code ? ` (${code})` : ''}`,
    url: null,
    advertised_cents: advertisedCents,
    currency: 'USD',
    context: { carrier: carrierProfile(code), taxesIncluded: true, carryOn: false, seatSelection: false, ...quoteContext },
    source: 'live:amadeus',
    sourceLabel: `Amadeus Flight Offers — live seller-listed total${assumptionLabel}; mandatory taxes included; no optional ancillaries selected`,
    certainty: 'live',
  };
}

export async function live(q) {
  const route = parseRoute(q);
  if (!route) {
    const err = new Error('flight query needs two standalone uppercase airport codes, e.g. "LAX-LAS"');
    err.status = 400;
    throw err;
  }
  const assumptions = {
    departureDate: new Date(Date.now() + 21 * 86_400_000).toISOString().slice(0, 10),
    adults: 1,
    tripType: 'one_way',
    nonStopOnly: false,
  };
  const qs = new URLSearchParams({
    originLocationCode: route.origin,
    destinationLocationCode: route.destination,
    departureDate: assumptions.departureDate,
    adults: String(assumptions.adults),
    currencyCode: 'USD',
    max: '1',
    nonStop: String(assumptions.nonStopOnly),
  }).toString();
  const data = await amadeus.get(`/v2/shopping/flight-offers?${qs}`);
  const offer = data && Array.isArray(data.data) ? data.data[0] : null;
  if (!offer || !offer.price) {
    const err = new Error(`no flight offers found for ${route.origin}→${route.destination}`);
    err.status = 404;
    throw err;
  }
  return normalizeFlightOffer(offer, route, assumptions);
}

export function fallback(q) {
  const route = parseRoute(q);
  const seed = hashStr(`flight:${q}`);
  return {
    name: route ? `${route.origin} → ${route.destination} one-way — example` : 'Example one-way flight',
    url: null,
    advertised_cents: bandCents(seed, 5900, 28900), // $59–$289 base fare
    currency: 'USD',
    context: { carrier: 'typical_lcc', channel: 'ota', taxesIncluded: false, priceBasis: 'base_fare', feeEvidence: 'The fallback is explicitly a modeled base fare, not a current seller-displayed total.' },
    source: 'estimated:model',
    sourceLabel: 'Illustrative flight model — not a current seller quote',
    certainty: 'estimated',
  };
}
