# API operations and client lifecycle

The complete OpenAPI 3.1 contract is `openapi/openapi.json`. Browser/account
routes are unversioned and deployed with the web app; commercial integration
routes are under `/api/v1`. Within v1, changes are additive. A breaking request,
response, money-unit, auth, or semantic change requires `/api/v2`, migration
guidance, and an announced overlap window.

## Request correlation and errors

Every response includes `X-Request-Id`. Clients may supply a safe 8–100
character ID using letters, digits, `. _ : -`; invalid values are replaced.
Include the returned ID in support reports.

API errors use:

```json
{"error":"human-readable message","code":"STABLE_CLASS","requestId":"correlation-id"}
```

Do not branch on `error`; branch on status and `code`. Some compatibility
responses may include extra fields such as an upgrade offer.

## Rate and quota handling

Limited responses expose `RateLimit-Limit`, `RateLimit-Remaining`, and
`RateLimit-Reset` plus `X-RateLimit-*` compatibility fields. A burst-limit 429
also supplies `Retry-After`. The B2B JSON body plus `X-DailyLimit-Limit` and
`X-DailyLimit-Remaining` expose the UTC-day quota; `GET /api/v1/usage` is itself
metered.

Use bounded exponential backoff with jitter for retryable 429/502/503 responses,
honor `Retry-After`, and cap total retry time. Do not retry validation,
authentication, CSRF, entitlement, or plausibility failures unchanged.

## API key lifecycle

- Create keys only inside an authenticated, CSRF-protected account with an
  active API entitlement. The raw key is returned once; only a SHA-256 hash and
  non-secret prefix remain.
- Give each environment/integration its own descriptive key. Never share a
  human's key, put it in browser code, URLs, logs, or support tickets.
- List records with `GET /api/account/api-keys`; responses contain metadata, not
  raw/hash material.
- Rotate using `POST /api/account/api-keys/{id}/rotate`. Persist the first
  successful response before restarting traffic; rotation is intentionally not
  retry-idempotent because each success revokes its predecessor.
- Revoke with `DELETE /api/account/api-keys/{id}` on decommission, team change,
  or suspected exposure. Verify old-key 401 and new-key success.
- Maintain at most five active account keys. Production operators review stale
  `last_used_at` values and rotate on the approved cadence.

## Idempotency and retries

Every OpenAPI operation has `x-idempotency.strategy`. There is no generic
inbound `Idempotency-Key` promise today. In particular,
`POST /api/v1/track` appends a price point and must not be automatically retried
after an ambiguous network failure; it is available only to operator-issued
keys with canonical-ingestion scope, never ordinary customer keys. Analyze is
a pure calculation. Watchlist uniqueness and server jobs have durable keys.
Checkout uses a durable per-account/plan intent plus Stripe idempotency;
customer-portal session creation is not retry-idempotent. Webhooks dedupe
persistently by provider event ID.

## SDK generation

Validate before generation with `npm run api:check`. The repository includes a
TypeScript Fetch generator configuration and a containerized example in
`openapi/README.md`. Pin the generator image by digest, run generated-client
contract tests against staging, scan/publish from a protected release workflow,
and version the SDK independently using semantic versioning. Generated code is
an artifact, not the API's source of truth.
