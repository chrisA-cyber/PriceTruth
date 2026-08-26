// Provider registry tests: fail-closed verified search, the always-on dated
// subscription catalog, input validation, and safe upstream-failure errors.

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { searchListing, providerStatus, SEARCH_VERTICALS } from '../src/providers/index.js';
import * as retail from '../src/providers/retail.js';
import * as subscriptions from '../src/providers/subscriptions.js';
import { normalizeFlightOffer } from '../src/providers/flights.js';
import { normalizeHotelOffer } from '../src/providers/hotels.js';
import { analyze } from '../src/engine/analyze.js';
import { hashStr, bandCents, toSlug } from '../src/providers/http.js';

describe('verified search fails closed without a source', () => {
  it('never substitutes a modeled retail price', async () => {
    await assert.rejects(
      () => searchListing({ vertical: 'retail', q: 'sony wh-1000xm5' }),
      (error) => error.status === 422 && error.code === 'PRICE_SOURCE_UNAVAILABLE' && !/RETAIL_API_URL/.test(error.message),
    );
  });

  it('retail fallback stays within the advertised $19.99–$499.99 band', () => {
    for (const q of ['a', 'widget', 'the quick brown fox', 'zzz-9', '4k oled tv 65']) {
      const fb = retail.fallback(q);
      assert.ok(fb.advertised_cents >= 1999 && fb.advertised_cents <= 49999, `${q}: ${fb.advertised_cents}`);
    }
  });

  it('returns a safe source-unavailable error for every unconfigured live vertical', async () => {
    for (const vertical of SEARCH_VERTICALS.filter((value) => value !== 'subscription')) {
      await assert.rejects(
        () => searchListing({ vertical, q: 'test query two' }),
        (error) => error.status === 422 && error.code === 'PRICE_SOURCE_UNAVAILABLE',
        vertical,
      );
    }
  });
});

describe('subscription dataset', () => {
  it('is always configured (ships in the repo)', () => {
    assert.equal(subscriptions.configured(), true);
  });

  it('matches a known plan by name and returns catalog certainty', async () => {
    const listing = await searchListing({ vertical: 'subscription', q: 'netflix' });
    assert.equal(listing.source, 'dataset:plans');
    assert.equal(listing.certainty, 'catalog');
    assert.ok(listing.advertised_cents > 0);
    assert.match(listing.sourceLabel, /snapshot/i);
  });

  it('returns no verified result for an unmatched query without inventing a price', async () => {
    await assert.rejects(
      () => searchListing({ vertical: 'subscription', q: 'zxqwv-not-a-real-plan' }),
      (error) => error.status === 404 && error.code === 'NO_VERIFIED_RESULT',
    );
  });

  it('fails closed for ambiguous generic terms and short brand fragments', async () => {
    for (const query of ['premium', 'ne', 'dis', 'ph', 'ify']) {
      await assert.rejects(
        () => searchListing({ vertical: 'subscription', q: query }),
        (error) => error.status === 404 && error.code === 'NO_VERIFIED_RESULT',
        query,
      );
    }
  });

  it('rejects an expired catalog instead of returning a stale dollar amount', async () => {
    await assert.rejects(
      () => searchListing({
        vertical: 'subscription',
        q: 'netflix',
        env: { SUBSCRIPTION_CATALOG_MAX_AGE_DAYS: '1' },
        now: Date.parse('2026-08-27T00:00:01.000Z'),
      }),
      (error) => error.status === 424 && error.code === 'PRICE_SOURCE_FAILED' && !('listing' in error),
    );
  });

  it('verifies every row and ages the catalog from its oldest as-of date', () => {
    const fresh = subscriptions.catalogFreshness({ now: Date.parse('2026-08-26T12:00:00.000Z') });
    assert.equal(fresh.ok, true);
    assert.equal(fresh.status, 'fresh');
    assert.equal(fresh.verifiedRows, fresh.rowCount);
    assert.equal(fresh.oldestAsOf, '2026-08-25');
    assert.equal(fresh.maxAgeDays, 93);

    const stale = subscriptions.catalogFreshness({ now: Date.parse('2026-11-27T00:00:01.000Z') });
    assert.equal(stale.ok, false);
    assert.equal(stale.status, 'stale');
    assert.equal(stale.stale, true);
  });

  it('fails closed for invalid age policy and malformed or future-dated rows', () => {
    const invalidPolicy = subscriptions.catalogFreshness({
      env: { SUBSCRIPTION_CATALOG_MAX_AGE_DAYS: '366' },
      now: Date.parse('2026-08-26T12:00:00.000Z'),
    });
    assert.equal(invalidPolicy.ok, false);
    assert.equal(invalidPolicy.configValid, false);

    const invalidRows = subscriptions.catalogFreshness({
      now: Date.parse('2026-08-26T12:00:00.000Z'),
      catalogData: {
        snapshot: '2026-08',
        plans: [{
          slug: 'future-plan', name: 'Future plan', advertised_cents: 999,
          pricingMode: 'stable_monthly', termMonths: 12, sourceRegion: 'US',
          asOf: '2026-08-27', sourceUrl: 'https://catalog.launch-operator.com/plans/future',
        }],
      },
    });
    assert.equal(invalidRows.ok, false);
    assert.equal(invalidRows.status, 'invalid');
    assert.equal(invalidRows.invalidRows, 1);
  });
});

describe('live flight quote truth', () => {
  it('uses the seller grand total without inventing unselected bags or seats', () => {
    const listing = normalizeFlightOffer({
      validatingAirlineCodes: ['NK'],
      price: { currency: 'USD', base: '70.00', total: '100.00', grandTotal: '100.00' },
    }, { origin: 'LAX', destination: 'LAS' });
    assert.equal(listing.advertised_cents, 10000);
    assert.equal(listing.context.carryOn, false);
    assert.equal(listing.context.seatSelection, false);
    const report = analyze({ vertical: 'flight', advertised_cents: listing.advertised_cents, context: listing.context });
    assert.equal(report.truePrice.amount_cents, 10000);
    assert.equal(report.lineItems.some((item) => ['carry_on', 'seat'].includes(item.code)), false);
  });
});

describe('live hotel quote identity', () => {
  it('keeps rolling stay searches one-time until dates and rate terms form an immutable identity', () => {
    const listing = normalizeHotelOffer({
      hotel: { hotelId: 'HTL123', name: 'Example Hotel' },
      offers: [{ checkInDate: '2026-09-16', checkOutDate: '2026-09-19', price: { currency: 'USD', total: '600.00' } }],
    }, { code: 'LAS', market: 'las_vegas' });
    assert.equal(listing.providerIdentity, null);
    assert.equal(listing.refreshable, false);
    assert.equal(listing.alertEligible, false);
    assert.equal(listing.context.quotedTotal_cents, 60000);
  });
});

describe('searchListing input validation', () => {
  it('rejects an unknown vertical with 400', async () => {
    await assert.rejects(() => searchListing({ vertical: 'boats', q: 'yacht' }), (e) => e.status === 400);
  });
  it('rejects a too-short query with 400', async () => {
    await assert.rejects(() => searchListing({ vertical: 'retail', q: 'a' }), (e) => e.status === 400);
  });
  it('rejects a too-long query with 400', async () => {
    await assert.rejects(() => searchListing({ vertical: 'retail', q: 'x'.repeat(121) }), (e) => e.status === 400);
  });
});

describe('live source failure fails closed', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.RETAIL_API_URL;
  });

  it('configured live retail feed that errors returns a safe upstream failure', async () => {
    process.env.RETAIL_API_URL = 'https://feed.example.com/search';
    assert.equal(retail.configured(), true);
    // Force the outbound call to fail the way a dead upstream would.
    globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };

    await assert.rejects(
      () => searchListing({ vertical: 'retail', q: 'sony wh-1000xm5' }),
      (error) => error.status === 424 && error.code === 'PRICE_SOURCE_FAILED' && !/ECONNREFUSED/.test(error.message),
    );
  });

  it('a configured live feed that succeeds is labeled live, not estimated', async () => {
    process.env.RETAIL_API_URL = 'https://feed.example.com/search';
    globalThis.fetch = async () => new Response(
      JSON.stringify({ name: 'Real Product', price_cents: 12999, currency: 'USD' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
    const listing = await searchListing({ vertical: 'retail', q: 'real product' });
    assert.equal(listing.degraded, false);
    assert.equal(listing.certainty, 'live');
    assert.equal(listing.advertised_cents, 12999);
    assert.equal(listing.source, 'live:retail-feed');
  });

  it('accepts only public HTTPS retail endpoints in production while preserving local development feeds', () => {
    assert.equal(retail.configured({
      NODE_ENV: 'production', RETAIL_API_URL: 'https://feed.launch-operator.com/v1/search?market=us',
    }), true);
    assert.equal(retail.configured({ NODE_ENV: 'development', RETAIL_API_URL: 'http://127.0.0.1:4781/mock/search' }), true);
    for (const url of [
      'http://feed.launch-operator.com/v1/search',
      'https://user:secret@feed.launch-operator.com/v1/search',
      'https://feed.launch-operator.com/v1/search#fragment',
      'https://127.0.0.1/v1/search',
      'https://metadata.google.internal/computeMetadata/v1',
    ]) assert.equal(retail.configured({ NODE_ENV: 'production', RETAIL_API_URL: url }), false, url);
  });

  it('rejects retail redirects without following or forwarding the bearer credential', async () => {
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url: String(url), options });
      return new Response(null, {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data' },
      });
    };
    await assert.rejects(
      () => retail.live('real product', {
        env: {
          NODE_ENV: 'production',
          RETAIL_API_URL: 'https://feed.launch-operator.com/v1/search?market=us',
          RETAIL_API_KEY: 'top-secret-bearer',
        },
        fetchImpl,
      }),
      (error) => error.status === 502 && error.code === 'UPSTREAM_REDIRECT_REJECTED',
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.redirect, 'manual');
    assert.equal(calls[0].options.headers.Authorization, 'Bearer top-secret-bearer');
    assert.match(calls[0].url, /^https:\/\/feed\.launch-operator\.com\/v1\/search\?/);
    assert.match(calls[0].url, /market=us/);
    assert.match(calls[0].url, /q=real\+product/);
  });

  it('does not promise refreshes or alerts for an empty provider identity', async () => {
    process.env.RETAIL_API_URL = 'https://feed.example.com/search';
    globalThis.fetch = async () => new Response(
      JSON.stringify({ name: 'Unidentified product', id: '   ', price_cents: 12999, currency: 'USD' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
    const listing = await searchListing({ vertical: 'retail', q: 'unidentified product' });
    assert.equal(listing.providerIdentity, null);
    assert.equal(listing.refreshable, false);
    assert.equal(listing.alertEligible, false);
    assert.equal(listing.provenance.alertEligible, false);
  });
});

describe('providerStatus exposes booleans only (no secrets)', () => {
  it('reports a live boolean per vertical and never a key', () => {
    const status = providerStatus();
    for (const vertical of SEARCH_VERTICALS) {
      assert.equal(typeof status[vertical].live, 'boolean');
    }
    // subscription ships a dataset, so it is always "live" but of kind 'dataset'
    // (not a current provider feed) — the UI uses this to avoid mislabeling it.
    assert.equal(status.subscription.live, true);
    assert.equal(status.subscription.kind, 'dataset');
    assert.equal(typeof status.subscription.freshness.ageSeconds, 'number');
    // A vertical with no key configured reports the 'fallback' kind.
    assert.equal(status.retail.kind, 'fallback');
    assert.equal(status.retail.truthUsable, false);
    const serialized = JSON.stringify(status);
    assert.ok(!/secret|key|token|password/i.test(serialized));
  });

  it('marks the subscription source unusable once the verified catalog expires', () => {
    const status = providerStatus({ now: Date.parse('2026-11-27T00:00:01.000Z') });
    assert.equal(status.subscription.live, true, 'the dataset remains installed for honest local/demo use');
    assert.equal(status.subscription.truthUsable, false);
    assert.equal(status.subscription.freshness.status, 'stale');
  });
});

describe('http helpers', () => {
  it('hashStr is stable and unsigned', () => {
    assert.equal(hashStr('abc'), hashStr('abc'));
    assert.ok(hashStr('abc') >= 0);
    assert.notEqual(hashStr('abc'), hashStr('abd'));
  });
  it('bandCents stays within [lo, hi)', () => {
    for (let s = 0; s < 1000; s += 37) {
      const v = bandCents(s, 1000, 2000);
      assert.ok(v >= 1000 && v < 2000);
    }
  });
  it('toSlug produces an id-safe slug starting with alphanumeric', () => {
    assert.equal(toSlug('Taylor', 'Swift!! Eras'), 'taylor-swift-eras');
    assert.match(toSlug('***'), /^[a-z0-9]/);
    assert.ok(toSlug('a'.repeat(200)).length <= 64);
  });
});
