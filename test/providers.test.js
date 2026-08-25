// Provider registry tests: deterministic labeled fallbacks (so the product is
// fully usable with zero API keys), the always-on subscription dataset, input
// validation, and the "live source configured but failed → labeled degraded
// fallback, never a crash and never mislabeled as live" contract.

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { searchListing, providerStatus, SEARCH_VERTICALS } from '../src/providers/index.js';
import * as retail from '../src/providers/retail.js';
import * as subscriptions from '../src/providers/subscriptions.js';
import { hashStr, bandCents, toSlug } from '../src/providers/http.js';

describe('provider fallbacks are deterministic and labeled', () => {
  it('the same query yields the same estimate across calls', async () => {
    const a = await searchListing({ vertical: 'retail', q: 'sony wh-1000xm5' });
    const b = await searchListing({ vertical: 'retail', q: 'sony wh-1000xm5' });
    assert.equal(a.advertised_cents, b.advertised_cents);
    assert.ok(Number.isInteger(a.advertised_cents));
    assert.equal(a.certainty, 'estimated');
    assert.equal(a.degraded, false);
    assert.match(a.source, /^estimated:/);
  });

  it('retail fallback stays within the advertised $19.99–$499.99 band', () => {
    for (const q of ['a', 'widget', 'the quick brown fox', 'zzz-9', '4k oled tv 65']) {
      const fb = retail.fallback(q);
      assert.ok(fb.advertised_cents >= 1999 && fb.advertised_cents <= 49999, `${q}: ${fb.advertised_cents}`);
    }
  });

  it('every vertical has a usable fallback with a non-negative integer price', async () => {
    for (const vertical of SEARCH_VERTICALS) {
      const listing = await searchListing({ vertical, q: 'test query two' });
      assert.equal(listing.vertical, vertical);
      assert.ok(Number.isInteger(listing.advertised_cents) && listing.advertised_cents >= 0);
      assert.equal(listing.currency, 'USD');
      assert.equal(typeof listing.sourceLabel, 'string');
      assert.ok(['live', 'typical', 'estimated'].includes(listing.certainty));
    }
  });
});

describe('subscription dataset', () => {
  it('is always configured (ships in the repo)', () => {
    assert.equal(subscriptions.configured(), true);
  });

  it('matches a known plan by name and returns typical certainty', async () => {
    const listing = await searchListing({ vertical: 'subscription', q: 'netflix' });
    assert.equal(listing.source, 'dataset:plans');
    assert.equal(listing.certainty, 'typical');
    assert.ok(listing.advertised_cents > 0);
    assert.match(listing.sourceLabel, /snapshot/i);
  });

  it('an unmatched query degrades to a clearly-labeled estimate (never a crash)', async () => {
    const listing = await searchListing({ vertical: 'subscription', q: 'zxqwv-not-a-real-plan' });
    // configured()===true but live() throws 404 → registry degrades to fallback.
    assert.equal(listing.degraded, true);
    assert.equal(listing.certainty, 'estimated');
    assert.match(listing.sourceLabel, /live lookup failed/i);
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

describe('live source failure degrades honestly', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.RETAIL_API_URL;
  });

  it('configured live retail feed that errors falls back to a degraded estimate, not a 5xx', async () => {
    process.env.RETAIL_API_URL = 'https://feed.example.com/search';
    assert.equal(retail.configured(), true);
    // Force the outbound call to fail the way a dead upstream would.
    globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };

    const listing = await searchListing({ vertical: 'retail', q: 'sony wh-1000xm5' });
    assert.equal(listing.degraded, true);
    assert.equal(listing.certainty, 'estimated');
    assert.match(listing.sourceLabel, /live lookup failed/i);
    assert.ok(Number.isInteger(listing.advertised_cents));
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
});

describe('providerStatus exposes booleans only (no secrets)', () => {
  it('reports a live boolean per vertical and never a key', () => {
    const status = providerStatus();
    for (const vertical of SEARCH_VERTICALS) {
      assert.equal(typeof status[vertical].live, 'boolean');
    }
    // subscription ships a dataset, so it is always "live".
    assert.equal(status.subscription.live, true);
    const serialized = JSON.stringify(status);
    assert.ok(!/secret|key|token|password/i.test(serialized));
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
