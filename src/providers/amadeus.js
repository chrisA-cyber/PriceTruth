// Shared Amadeus Self-Service client (flights + hotels).
//
// PriceTruth's public provider contract is production-only. Amadeus's test
// environment returns realistic sandbox inventory, so allowing it through the
// same path would turn a non-bookable fixture into a "live" verified quote.
// Keep the origin locked and fail closed unless production credentials and the
// exact production origin are configured together.

import { httpJson } from './http.js';

export const PRODUCTION_ORIGIN = 'https://api.amadeus.com';

let tokenCache = { value: null, expiresAt: 0 };

export function credentialsPresent(env = process.env) {
  return Boolean(String(env.AMADEUS_CLIENT_ID || '').trim() && String(env.AMADEUS_CLIENT_SECRET || '').trim());
}

export function productionOriginConfigured(env = process.env) {
  const raw = String(env.AMADEUS_HOST || '');
  if (!raw || raw !== raw.trim()) return false;
  try {
    const url = new URL(raw);
    return url.origin === PRODUCTION_ORIGIN && url.href === `${PRODUCTION_ORIGIN}/`;
  } catch {
    return false;
  }
}

export function configured(env = process.env) {
  return credentialsPresent(env) && productionOriginConfigured(env);
}

function requireProductionConfiguration(env = process.env) {
  if (configured(env)) return PRODUCTION_ORIGIN;
  const err = new Error('Amadeus production source is not configured');
  err.status = 503;
  err.code = 'AMADEUS_PRODUCTION_SOURCE_REQUIRED';
  throw err;
}

export async function token() {
  // Check before consulting the token cache. A token obtained from a previous
  // production configuration must never let a later sandbox/misconfigured
  // process state bypass the public-source boundary.
  const host = requireProductionConfiguration();
  const now = Date.now();
  if (tokenCache.value && now < tokenCache.expiresAt) return tokenCache.value;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: process.env.AMADEUS_CLIENT_ID,
    client_secret: process.env.AMADEUS_CLIENT_SECRET,
  }).toString();
  const data = await httpJson(`${host}/v1/security/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    timeoutMs: 6000,
  });
  if (!data || !data.access_token) {
    const err = new Error('amadeus auth failed');
    err.status = 502;
    throw err;
  }
  // Refresh a minute early to avoid using a token mid-expiry.
  tokenCache = { value: data.access_token, expiresAt: now + Math.max(0, (data.expires_in || 1799) - 60) * 1000 };
  return tokenCache.value;
}

export async function get(pathAndQuery) {
  const host = requireProductionConfiguration();
  const t = await token();
  return httpJson(`${host}${pathAndQuery}`, {
    headers: { Authorization: `Bearer ${t}` },
    timeoutMs: 8000,
  });
}

// Test-only: reset the module token cache between tests.
export function _resetToken() {
  tokenCache = { value: null, expiresAt: 0 };
}
