// Shared Amadeus Self-Service client (flights + hotels). Free test tier:
// https://developers.amadeus.com/ — set AMADEUS_CLIENT_ID and
// AMADEUS_CLIENT_SECRET. Defaults to the test host; set AMADEUS_HOST to
// https://api.amadeus.com for production credentials.

import { httpJson } from './http.js';

const HOST = () => process.env.AMADEUS_HOST || 'https://test.api.amadeus.com';

let tokenCache = { value: null, expiresAt: 0 };

export function configured() {
  return Boolean(process.env.AMADEUS_CLIENT_ID && process.env.AMADEUS_CLIENT_SECRET);
}

export async function token() {
  const now = Date.now();
  if (tokenCache.value && now < tokenCache.expiresAt) return tokenCache.value;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: process.env.AMADEUS_CLIENT_ID,
    client_secret: process.env.AMADEUS_CLIENT_SECRET,
  }).toString();
  const data = await httpJson(`${HOST()}/v1/security/oauth2/token`, {
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
  const t = await token();
  return httpJson(`${HOST()}${pathAndQuery}`, {
    headers: { Authorization: `Bearer ${t}` },
    timeoutMs: 8000,
  });
}

// Test-only: reset the module token cache between tests.
export function _resetToken() {
  tokenCache = { value: null, expiresAt: 0 };
}
