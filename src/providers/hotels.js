// Hotels — live via Amadeus Hotel Search (by-city → hotel-offers), with a
// labeled fallback. Query is a city name or code, e.g. "Las Vegas", "NYC".
// The advertised nightly rate is the room-only base; resort fees, occupancy
// taxes, and parking are the engine's market-typical estimates (the drip).

import * as amadeus from './amadeus.js';
import { hashStr, bandCents, titleize } from './http.js';

export const vertical = 'hotel';

export function configured() {
  return amadeus.configured();
}

// Map a free-text city to an Amadeus city code + the engine's market profile.
const CITIES = [
  { code: 'LAS', market: 'las_vegas', match: ['las vegas', 'vegas', 'las'] },
  { code: 'NYC', market: 'new_york', match: ['new york', 'nyc', 'manhattan'] },
  { code: 'MIA', market: 'miami', match: ['miami'] },
  { code: 'MCO', market: 'orlando', match: ['orlando', 'mco'] },
];
function resolveCity(q) {
  const s = String(q).trim().toLowerCase();
  for (const c of CITIES) if (c.match.some((m) => s.includes(m))) return c;
  const code = (s.toUpperCase().match(/^[A-Z]{3}$/) || [])[0];
  if (code) return { code, market: 'default' };
  return null;
}

export async function live(q) {
  const city = resolveCity(q);
  if (!city) {
    const err = new Error('hotel query needs a city, e.g. "Las Vegas" or a 3-letter city code');
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
  const checkIn = new Date(Date.now() + 21 * 86_400_000).toISOString().slice(0, 10);
  const checkOut = new Date(Date.now() + 24 * 86_400_000).toISOString().slice(0, 10);
  const qs = new URLSearchParams({ hotelIds: ids, checkInDate: checkIn, checkOutDate: checkOut, adults: '1', roomQuantity: '1', currency: 'USD', bestRateOnly: 'true' }).toString();
  const data = await amadeus.get(`/v3/shopping/hotel-offers?${qs}`);
  const entry = data && Array.isArray(data.data) ? data.data.find((d) => d.available && d.offers && d.offers[0]) : null;
  if (!entry) {
    const err = new Error('no available hotel offers for these dates');
    err.status = 404;
    throw err;
  }
  const offer = entry.offers[0];
  const nights = 3;
  const totalCents = Math.round(parseFloat(offer.price.total || offer.price.base) * 100);
  const perNight = Math.max(1, Math.round(totalCents / nights));
  const hotelName = entry.hotel && entry.hotel.name ? titleize(entry.hotel.name) : `Hotel in ${city.code}`;
  return {
    name: `${hotelName} — ${city.code}`,
    url: null,
    advertised_cents: perNight,
    currency: 'USD',
    context: { market: city.market, nights },
    source: 'live:amadeus',
    sourceLabel: 'Amadeus Hotel Search — live nightly rate; resort fee/taxes/parking are market-typical',
    certainty: 'live',
  };
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
    sourceLabel: 'Estimated example rate — set AMADEUS_CLIENT_ID/SECRET for live hotel rates',
    certainty: 'estimated',
  };
}
