// Provider registry: one uniform searchListing() over all five verticals.
// Each provider exposes configured()/live()/fallback(). When a live source is
// configured we try it and, on any failure, fall back to a clearly-labeled
// estimate marked `degraded` — the product never breaks, and it never presents
// an estimate as if it were live.

import * as hotels from './hotels.js';
import * as flights from './flights.js';
import * as tickets from './tickets.js';
import * as subscriptions from './subscriptions.js';
import * as retail from './retail.js';

const PROVIDERS = {
  hotel: hotels,
  flight: flights,
  ticket: tickets,
  subscription: subscriptions,
  retail,
};

export const SEARCH_VERTICALS = Object.keys(PROVIDERS);

function normalize(listing, { vertical }) {
  if (!listing || !Number.isInteger(listing.advertised_cents) || listing.advertised_cents < 0) {
    const err = new Error('provider returned no usable price');
    err.status = 502;
    throw err;
  }
  return {
    vertical,
    name: String(listing.name || 'Listing').slice(0, 160),
    url: typeof listing.url === 'string' && listing.url.startsWith('https://') ? listing.url : null,
    advertised_cents: listing.advertised_cents,
    currency: 'USD',
    context: listing.context && typeof listing.context === 'object' ? listing.context : {},
    source: listing.source || 'estimated:model',
    sourceLabel: listing.sourceLabel || 'Estimated',
    certainty: listing.certainty || 'estimated',
    degraded: Boolean(listing.degraded),
    fetchedAt: new Date().toISOString(),
  };
}

// Returns a normalized listing for a query. Never throws for "no live key" —
// only for a bad vertical or a truly unusable result.
export async function searchListing({ vertical, q }) {
  const provider = Object.hasOwn(PROVIDERS, vertical) ? PROVIDERS[vertical] : null;
  if (!provider) {
    const err = new Error(`search is not available for vertical "${vertical}"`);
    err.status = 400;
    throw err;
  }
  const query = String(q || '').trim();
  if (query.length < 2 || query.length > 120) {
    const err = new Error('query must be 2–120 characters');
    err.status = 400;
    throw err;
  }

  if (provider.configured()) {
    try {
      const live = await provider.live(query);
      return normalize(live, { vertical });
    } catch (err) {
      // Live source configured but failed — degrade to the labeled fallback.
      const fb = provider.fallback(query);
      fb.degraded = true;
      fb.sourceLabel = `${fb.sourceLabel} (live lookup failed: ${err.message})`.slice(0, 200);
      return normalize(fb, { vertical });
    }
  }
  return normalize(provider.fallback(query), { vertical });
}

// For /api/meta and the admin dashboard: which verticals have a live source
// wired up right now. No secrets are exposed — just booleans.
export function providerStatus() {
  const status = {};
  for (const [vertical, provider] of Object.entries(PROVIDERS)) {
    status[vertical] = { live: provider.configured() };
  }
  return status;
}
