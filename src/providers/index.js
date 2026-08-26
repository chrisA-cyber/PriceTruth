// Provider registry: one uniform searchListing() over all five verticals.
// Search is deliberately fail-closed: a result must come from a current
// provider quote or an approved dated catalog row. Modeled prices remain
// available only through the explicit manual analyzer, where the shopper
// supplies the advertised amount. A failed or unsupported lookup never invents
// a plausible-looking dollar amount.

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
  const currency = String(listing.currency || 'USD').toUpperCase();
  if (currency !== 'USD') {
    const err = new Error(`provider returned unsupported currency ${currency || 'unknown'}; currency conversion is not configured`);
    err.status = 502;
    throw err;
  }
  const certainty = ['live', 'catalog', 'typical', 'estimated'].includes(listing.certainty) ? listing.certainty : 'estimated';
  const source = typeof listing.source === 'string' && /^[a-z][a-z0-9_-]*:[a-z0-9._-]+$/i.test(listing.source)
    ? listing.source.slice(0, 100)
    : 'estimated:model';
  const fetchedAt = new Date().toISOString();
  const asOf = typeof listing.asOf === 'string' && !Number.isNaN(Date.parse(listing.asOf)) ? new Date(listing.asOf).toISOString() : fetchedAt;
  const maxAgeSeconds = Number.isInteger(listing.maxAgeSeconds) && listing.maxAgeSeconds > 0
    ? Math.min(listing.maxAgeSeconds, 365 * 86_400)
    : (certainty === 'live' ? 3600 : certainty === 'catalog' || certainty === 'typical' ? 30 * 86_400 : 0);
  const ageSeconds = Math.max(0, Math.floor((Date.now() - Date.parse(asOf)) / 1000));
  const observed = certainty === 'live' && !source.startsWith('estimated:');
  const stale = maxAgeSeconds > 0 ? ageSeconds > maxAgeSeconds : true;
  const identityCandidate = typeof listing.providerIdentity === 'string' ? listing.providerIdentity.trim() : '';
  const providerIdentity = identityCandidate.length > 0 && identityCandidate.length <= 200 && !/[\u0000-\u001f\u007f]/.test(identityCandidate)
    ? identityCandidate
    : null;
  const refreshable = listing.refreshable === true && providerIdentity !== null;
  const alertEligible = Boolean(refreshable && !listing.degraded && !stale && (observed || listing.alertEligible === true));
  const evidenceType = source.startsWith('dataset:') ? 'catalog_snapshot' : observed ? 'provider_quote' : 'model_estimate';
  const sourceLabel = String(listing.sourceLabel || 'Estimated').slice(0, 200);
  return {
    vertical,
    name: String(listing.name || 'Listing').slice(0, 160),
    url: typeof listing.url === 'string' && listing.url.startsWith('https://') ? listing.url : null,
    advertised_cents: listing.advertised_cents,
    currency,
    context: listing.context && typeof listing.context === 'object' ? listing.context : {},
    source,
    sourceLabel,
    certainty,
    degraded: Boolean(listing.degraded),
    fetchedAt,
    provenance: {
      source,
      sourceLabel,
      evidenceType,
      observed,
      degraded: Boolean(listing.degraded),
      upstreamOutcome: listing.upstreamOutcome || (listing.degraded ? 'degraded' : 'ok'),
      fetchedAt,
      asOf,
      maxAgeSeconds,
      ageSeconds,
      stale,
      alertEligible,
    },
    evidence: [{ type: evidenceType, source, label: sourceLabel, observed, asOf, fetchedAt }],
    providerIdentity,
    refreshable,
    alertEligible,
  };
}

function lookupError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

// Returns only source-backed search results. Unsupported coverage, no-match,
// provider failures, and exhausted provider capacity are explicit states; none
// of them is converted into a synthetic price.
export async function searchListing({ vertical, q, allowLive = true, env = process.env, now = Date.now() }) {
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

  if (!provider.configured()) {
    throw lookupError(422, 'PRICE_SOURCE_UNAVAILABLE',
      `Verified ${vertical} search is not available on this deployment. Enter the advertised dollar amount to build a manual report; no modeled price was substituted.`);
  }
  if (typeof provider.freshness === 'function') {
    let sourceFreshness;
    try {
      sourceFreshness = provider.freshness({ env, now });
    } catch (err) {
      console.warn(`[providers] verified ${vertical} freshness check failed: ${err?.message || 'unknown provider error'}`);
      throw lookupError(424, 'PRICE_SOURCE_FAILED',
        `The verified ${vertical} price source is temporarily unavailable. Try again later or enter the advertised dollar amount; no modeled price was substituted.`);
    }
    if (sourceFreshness?.ok === false) {
      console.warn(`[providers] verified ${vertical} source rejected: catalog is ${sourceFreshness.status || 'unusable'}`);
      throw lookupError(424, 'PRICE_SOURCE_FAILED',
        `The verified ${vertical} price source is temporarily unavailable. Try again later or enter the advertised dollar amount; no modeled price was substituted.`);
    }
  }
  if (!allowLive) {
    throw lookupError(429, 'PRICE_SOURCE_BUSY',
      `Verified ${vertical} search is temporarily at capacity. Try again later or enter the advertised dollar amount; no modeled price was substituted.`);
  }
  try {
    const live = await provider.live(query);
    return normalize(live, { vertical });
  } catch (err) {
    if (err?.status === 400) throw err;
    if (err?.status === 404) {
      throw lookupError(404, 'NO_VERIFIED_RESULT',
        `No verified ${vertical} price matched that search. Check the query or enter the advertised dollar amount; no modeled price was substituted.`);
    }
    // Provider details can contain upstream hosts or account state. Keep them
    // in server logs and return one safe, actionable message to the shopper.
    console.warn(`[providers] verified ${vertical} lookup failed: ${err?.message || 'unknown provider error'}`);
    throw lookupError(424, 'PRICE_SOURCE_FAILED',
      `The verified ${vertical} price source is temporarily unavailable. Try again later or enter the advertised dollar amount; no modeled price was substituted.`);
  }
}

export function validateProviderQuery({ vertical, q }) {
  const provider = Object.hasOwn(PROVIDERS, vertical) ? PROVIDERS[vertical] : null;
  if (!provider) return false;
  return typeof provider.validateQuery !== 'function' || provider.validateQuery(q);
}

// For /api/meta and the admin dashboard: which verticals have a source wired up
// right now, and of what kind. No secrets are exposed — booleans + a kind tag.
//   kind 'live'     — a real-time API is configured and reachable-in-principle
//   kind 'dataset'  — answers come from a dated in-repo snapshot, not a live feed
//   kind 'fallback' — no verified source configured; search fails closed and
//                     the UI routes the shopper to manual advertised-price input
// `live` stays a boolean for backward compatibility (true for live OR dataset).
export function providerStatus({ env = process.env, now = Date.now() } = {}) {
  const status = {};
  for (const [vertical, provider] of Object.entries(PROVIDERS)) {
    const configured = provider.configured();
    const kind = configured ? (provider.kind || 'live') : 'fallback';
    const freshness = typeof provider.freshness === 'function' ? provider.freshness({ env, now }) : null;
    status[vertical] = {
      live: configured,
      kind: provider.unavailableReason ? 'unsupported' : kind,
      credentialsPresent: typeof provider.credentialsPresent === 'function' ? provider.credentialsPresent() : configured,
      truthUsable: configured && !provider.unavailableReason && freshness?.ok !== false,
      unavailableReason: provider.unavailableReason || null,
      ...(freshness ? { freshness } : {}),
    };
  }
  return status;
}
