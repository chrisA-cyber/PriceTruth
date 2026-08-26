import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as amadeus from '../src/providers/amadeus.js';
import * as flights from '../src/providers/flights.js';
import * as hotels from '../src/providers/hotels.js';
import { providerStatus, searchListing } from '../src/providers/index.js';

const ENV_NAMES = ['AMADEUS_CLIENT_ID', 'AMADEUS_CLIENT_SECRET', 'AMADEUS_HOST'];
const originalEnv = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
const originalFetch = globalThis.fetch;
const originalDateNow = Date.now;

function setAmadeusEnv(host, { credentials = true } = {}) {
  process.env.AMADEUS_HOST = host;
  if (credentials) {
    process.env.AMADEUS_CLIENT_ID = 'production-client-id';
    process.env.AMADEUS_CLIENT_SECRET = 'production-client-secret';
  } else {
    delete process.env.AMADEUS_CLIENT_ID;
    delete process.env.AMADEUS_CLIENT_SECRET;
  }
}

describe('Amadeus production truth boundary', { concurrency: false }, () => {
  beforeEach(() => {
    amadeus._resetToken();
    globalThis.fetch = originalFetch;
    Date.now = originalDateNow;
    for (const name of ENV_NAMES) delete process.env[name];
  });

  afterEach(() => {
    amadeus._resetToken();
    globalThis.fetch = originalFetch;
    Date.now = originalDateNow;
    for (const name of ENV_NAMES) {
      if (originalEnv[name] === undefined) delete process.env[name];
      else process.env[name] = originalEnv[name];
    }
  });

  it('reports sandbox credentials as present but never truth-usable or live', () => {
    setAmadeusEnv('https://test.api.amadeus.com');

    assert.equal(amadeus.credentialsPresent(), true);
    assert.equal(flights.credentialsPresent(), true);
    assert.equal(hotels.credentialsPresent(), true);
    assert.equal(amadeus.productionOriginConfigured(), false);
    assert.equal(amadeus.configured(), false);
    assert.equal(flights.configured(), false);
    assert.equal(hotels.configured(), false);
  });

  it('keeps sandbox inventory out of public search and public live-source status', async () => {
    setAmadeusEnv('https://test.api.amadeus.com');
    let networkCalls = 0;
    globalThis.fetch = async () => {
      networkCalls += 1;
      throw new Error('sandbox network must not be called');
    };

    const status = providerStatus();
    for (const vertical of ['flight', 'hotel']) {
      assert.equal(status[vertical].live, false);
      assert.equal(status[vertical].kind, 'fallback');
      assert.equal(status[vertical].credentialsPresent, true);
    }
    await assert.rejects(
      () => searchListing({ vertical: 'flight', q: 'LAX-LAS' }),
      (error) => error.status === 422 && error.code === 'PRICE_SOURCE_UNAVAILABLE' && !('listing' in error),
    );
    assert.equal(networkCalls, 0);
  });

  it('requires both credentials and the exact origin-only production host', () => {
    const rejectedHosts = [
      '',
      'https://test.api.amadeus.com',
      'http://api.amadeus.com',
      'https://api.amadeus.com:444',
      'https://api.amadeus.com/v1',
      'https://api.amadeus.com?environment=test',
      'https://api.amadeus.com#test',
      'https://user@api.amadeus.com',
      'https://api.amadeus.com.example.org',
      ' https://api.amadeus.com',
    ];
    for (const host of rejectedHosts) {
      setAmadeusEnv(host);
      assert.equal(amadeus.configured(), false, host || '(empty)');
    }

    setAmadeusEnv('https://api.amadeus.com', { credentials: false });
    assert.equal(amadeus.configured(), false);

    setAmadeusEnv('https://api.amadeus.com');
    assert.equal(amadeus.configured(), true);
    setAmadeusEnv('https://api.amadeus.com/');
    assert.equal(amadeus.configured(), true);
  });

  it('rejects sandbox calls before any network request, even with a cached production token', async () => {
    setAmadeusEnv('https://api.amadeus.com');
    const requested = [];
    globalThis.fetch = async (url) => {
      requested.push(String(url));
      return new Response(JSON.stringify({ access_token: 'production-token', expires_in: 1800 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    assert.equal(await amadeus.token(), 'production-token');
    assert.deepEqual(requested, ['https://api.amadeus.com/v1/security/oauth2/token']);

    process.env.AMADEUS_HOST = 'https://test.api.amadeus.com';
    await assert.rejects(
      () => amadeus.token(),
      (error) => error.status === 503 && error.code === 'AMADEUS_PRODUCTION_SOURCE_REQUIRED',
    );
    await assert.rejects(
      () => amadeus.get('/v2/shopping/flight-offers'),
      (error) => error.status === 503 && error.code === 'AMADEUS_PRODUCTION_SOURCE_REQUIRED',
    );
    assert.equal(requested.length, 1, 'sandbox configuration must fail before fetch');
  });

  it('rejects ambiguous natural-language travel queries instead of silently changing destinations', () => {
    assert.equal(hotels.validateQuery('Las Vegas'), true);
    assert.equal(hotels.validateQuery('LAS'), true);
    assert.equal(hotels.validateQuery('MIA'), true);
    assert.equal(hotels.validateQuery('Dallas'), false);
    assert.equal(hotels.validateQuery('Glasgow'), false);
    assert.equal(hotels.validateQuery('Hotels in LAS'), false);

    assert.equal(flights.validateQuery('LAX-LAS'), true);
    assert.equal(flights.validateQuery('SFO to JFK'), true);
    assert.equal(flights.validateQuery('Boston to Miami'), false);
    assert.equal(flights.validateQuery('New York to Miami'), false);
    assert.equal(flights.validateQuery('lax to las'), false, 'airport codes must be explicit uppercase tokens');
  });

  it('returns the exact generated travel dates and party assumptions with each live quote', async () => {
    setAmadeusEnv('https://api.amadeus.com');
    Date.now = () => Date.parse('2026-08-26T12:00:00.000Z');
    const requested = [];
    globalThis.fetch = async (url) => {
      const parsed = new URL(String(url));
      requested.push(parsed);
      if (parsed.pathname === '/v1/security/oauth2/token') {
        return new Response(JSON.stringify({ access_token: 'production-token', expires_in: 1800 }), { status: 200 });
      }
      if (parsed.pathname === '/v2/shopping/flight-offers') {
        assert.equal(parsed.searchParams.get('departureDate'), '2026-09-16');
        assert.equal(parsed.searchParams.get('adults'), '1');
        assert.equal(parsed.searchParams.get('nonStop'), 'false');
        return new Response(JSON.stringify({ data: [{
          validatingAirlineCodes: ['AA'],
          itineraries: [{ segments: [{ departure: { at: '2026-09-16T08:30:00' } }] }],
          price: { currency: 'USD', grandTotal: '125.00' },
        }] }), { status: 200 });
      }
      if (parsed.pathname === '/v1/reference-data/locations/hotels/by-city') {
        assert.equal(parsed.searchParams.get('cityCode'), 'LAS');
        return new Response(JSON.stringify({ data: [{ hotelId: 'HTL123' }] }), { status: 200 });
      }
      if (parsed.pathname === '/v3/shopping/hotel-offers') {
        assert.equal(parsed.searchParams.get('checkInDate'), '2026-09-16');
        assert.equal(parsed.searchParams.get('checkOutDate'), '2026-09-19');
        assert.equal(parsed.searchParams.get('adults'), '1');
        assert.equal(parsed.searchParams.get('roomQuantity'), '1');
        assert.equal(parsed.searchParams.get('bestRateOnly'), 'true');
        return new Response(JSON.stringify({ data: [{
          available: true,
          hotel: { hotelId: 'HTL123', name: 'Exact Dates Hotel' },
          offers: [{ checkInDate: '2026-09-16', checkOutDate: '2026-09-19', price: { currency: 'USD', total: '600.00' } }],
        }] }), { status: 200 });
      }
      throw new Error(`unexpected Amadeus request: ${parsed}`);
    };

    const flight = await flights.live('LAX-LAS');
    assert.equal(flight.context.departureDate, '2026-09-16');
    assert.equal(flight.context.adults, 1);
    assert.equal(flight.context.tripType, 'one_way');
    assert.equal(flight.context.nonStopOnly, false);
    assert.match(flight.sourceLabel, /1 adult, one-way departing 2026-09-16/);

    const hotel = await hotels.live('Las Vegas');
    assert.equal(hotel.context.checkInDate, '2026-09-16');
    assert.equal(hotel.context.checkOutDate, '2026-09-19');
    assert.equal(hotel.context.adults, 1);
    assert.equal(hotel.context.roomQuantity, 1);
    assert.equal(hotel.context.bestRateOnly, true);
    assert.match(hotel.sourceLabel, /1 adult in 1 room, 2026-09-16 to 2026-09-19/);
    assert.equal(requested.length, 4);
  });

  it('rejects an upstream offer whose travel dates differ from the requested quote', () => {
    assert.throws(
      () => flights.normalizeFlightOffer({
        itineraries: [{ segments: [{ departure: { at: '2026-09-17T08:30:00' } }] }],
        price: { currency: 'USD', grandTotal: '125.00' },
      }, { origin: 'LAX', destination: 'LAS' }, { departureDate: '2026-09-16', adults: 1 }),
      /does not match the requested quote date/,
    );
    assert.throws(
      () => hotels.normalizeHotelOffer({
        hotel: { name: 'Wrong Dates Hotel' },
        offers: [{ checkInDate: '2026-09-17', checkOutDate: '2026-09-20', price: { currency: 'USD', total: '600.00' } }],
      }, { code: 'LAS', market: 'las_vegas' }, {
        checkInDate: '2026-09-16', checkOutDate: '2026-09-19', adults: 1, roomQuantity: 1,
      }),
      /do not match the requested quote dates/,
    );
  });
});
