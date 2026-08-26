// Hotels — live via Amadeus Hotel Search (by-city → hotel-offers). Query is a
// city name or code, e.g. "Las Vegas", "NYC".
// Amadeus Hotel Search returns a quoted full-stay total. The normalizer keeps
// that exact seller total and its inclusion evidence so the engine never
// rebuilds it from a rounded nightly average or double-adds mandatory fees.

import * as amadeus from './amadeus.js';
import { hashStr, bandCents, titleize } from './http.js';

export const vertical = 'hotel';

export function credentialsPresent(env = process.env) {
  return amadeus.credentialsPresent(env);
}

export function configured(env = process.env) {
  return amadeus.configured(env);
}

// Map a free-text city to an Amadeus city code + the engine's market profile.
const CITIES = [
  { code: 'LAS', market: 'las_vegas', match: ['las vegas', 'vegas', 'las'] },
  { code: 'NYC', market: 'new_york', match: ['new york', 'nyc', 'manhattan'] },
  { code: 'MIA', market: 'miami', match: ['miami', 'mia'] },
  { code: 'MCO', market: 'orlando', match: ['orlando', 'mco'] },
];
function resolveCity(q) {
  const s = String(q || '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
  // Named aliases must match the whole normalized query. Substring matching
  // made "Dallas" and "Glasgow" resolve to LAS and could return the wrong city.
  for (const c of CITIES) if (c.match.includes(s)) return c;
  const code = /^[a-z]{3}$/.test(s) ? s.toUpperCase() : null;
  if (code) return { code, market: 'default' };
  return null;
}
export function validateQuery(q) { return Boolean(resolveCity(q)); }

export function normalizeHotelOffer(entry, city, assumptions = {}) {
  const offer = entry?.offers?.[0];
  if (!offer?.price) throw Object.assign(new Error('hotel offer has no price'), { status: 502 });
  const currency = String(offer.price.currency || '').toUpperCase();
  if (currency !== 'USD') throw Object.assign(new Error('hotel offer is not denominated in USD'), { status: 502 });
  const total = Number(offer.price.total);
  if (!Number.isFinite(total) || total <= 0) throw Object.assign(new Error('hotel offer has no usable quoted stay total'), { status: 502 });
  const checkIn = Date.parse(`${offer.checkInDate || ''}T00:00:00Z`);
  const checkOut = Date.parse(`${offer.checkOutDate || ''}T00:00:00Z`);
  const nights = Number.isFinite(checkIn) && Number.isFinite(checkOut)
    ? Math.round((checkOut - checkIn) / 86_400_000)
    : NaN;
  if (!Number.isInteger(nights) || nights < 1 || nights > 60) throw Object.assign(new Error('hotel offer has invalid stay dates'), { status: 502 });
  if ((assumptions.checkInDate && assumptions.checkInDate !== offer.checkInDate) ||
      (assumptions.checkOutDate && assumptions.checkOutDate !== offer.checkOutDate)) {
    throw Object.assign(new Error('hotel offer stay dates do not match the requested quote dates'), { status: 502 });
  }
  const totalCents = Math.round(total * 100), perNight = Math.round(totalCents / nights);
  if (!Number.isSafeInteger(totalCents) || totalCents > 1_000_000_000 || perNight < 1) throw Object.assign(new Error('hotel offer total is out of range'), { status: 502 });
  const hotelName = entry.hotel?.name ? titleize(entry.hotel.name) : `Hotel in ${city.code}`;
  const adults = Number.isInteger(assumptions.adults) && assumptions.adults > 0 ? assumptions.adults : 1;
  const roomQuantity = Number.isInteger(assumptions.roomQuantity) && assumptions.roomQuantity > 0 ? assumptions.roomQuantity : 1;
  return {
    name: `${hotelName} — ${city.code}`,
    url: null,
    advertised_cents: perNight,
    currency: 'USD',
    // Amadeus price.total is the quoted full-stay total. Treat it as all-in
    // rather than re-adding estimated taxes/resort fees and double counting.
    context: {
      market: city.market,
      nights,
      checkInDate: offer.checkInDate,
      checkOutDate: offer.checkOutDate,
      adults,
      roomQuantity,
      bestRateOnly: assumptions.bestRateOnly !== false,
      mandatoryFeesIncluded: true,
      taxesIncluded: true,
      parking: false,
      quotedTotal_cents: totalCents,
    },
    source: 'live:amadeus',
    sourceLabel: `Amadeus Hotel Search — live quoted ${nights}-night stay total for ${adults} adult${adults === 1 ? '' : 's'} in ${roomQuantity} room${roomQuantity === 1 ? '' : 's'}, ${offer.checkInDate} to ${offer.checkOutDate}; reported mandatory taxes/fees included; property extras may vary`,
    certainty: 'live',
    // A hotel id alone is not a stable purchase identity: the rolling query
    // changes stay dates and may change room/rate/cancellation terms. Keep this
    // quote one-time until those exact dimensions are carried end to end.
    providerIdentity: null,
    refreshable: false,
    alertEligible: false,
  };
}

export async function live(q) {
  const city = resolveCity(q);
  if (!city) {
    const err = new Error('hotel query needs an exact supported city name, e.g. "Las Vegas", or a standalone 3-letter city code');
    err.status = 400;
    throw err;
  }
  const byCity = await amadeus.get(`/v1/reference-data/locations/hotels/by-city?cityCode=${city.code}`);
  const hotels = byCity && Array.isArray(byCity.data) ? byCity.data.slice(0, 15) : [];
  if (!hotels.length) {
    const err = new Error(`no hotels found for ${city.code}`);
    err.status = 404;
    throw err;
  }
  const ids = hotels.map((h) => h.hotelId).filter(Boolean).slice(0, 15).join(',');
  const now = Date.now();
  const assumptions = {
    checkInDate: new Date(now + 21 * 86_400_000).toISOString().slice(0, 10),
    checkOutDate: new Date(now + 24 * 86_400_000).toISOString().slice(0, 10),
    adults: 1,
    roomQuantity: 1,
    bestRateOnly: true,
  };
  const qs = new URLSearchParams({
    hotelIds: ids,
    checkInDate: assumptions.checkInDate,
    checkOutDate: assumptions.checkOutDate,
    adults: String(assumptions.adults),
    roomQuantity: String(assumptions.roomQuantity),
    currency: 'USD',
    bestRateOnly: String(assumptions.bestRateOnly),
  }).toString();
  const data = await amadeus.get(`/v3/shopping/hotel-offers?${qs}`);
  const entry = data && Array.isArray(data.data) ? data.data.find((d) => d.available && d.offers && d.offers[0]) : null;
  if (!entry) {
    const err = new Error('no available hotel offers for these dates');
    err.status = 404;
    throw err;
  }
  return normalizeHotelOffer(entry, city, assumptions);
}

export function fallback(q) {
  const city = resolveCity(q);
  const seed = hashStr(`hotel:${q}`);
  return {
    name: `${titleize(q) || 'Hotel'} — example nightly rate`,
    url: null,
    advertised_cents: bandCents(seed, 8900, 32900), // $89–$329/night
    currency: 'USD',
    context: { market: city ? city.market : 'default', nights: 3 },
    source: 'estimated:model',
    sourceLabel: 'Illustrative hotel model — not a current seller quote',
    certainty: 'estimated',
  };
}
