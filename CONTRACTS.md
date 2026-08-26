# PriceTruth internal contracts

This file records invariants that must remain true across product, API,
extension, data, and operations work. `openapi/openapi.json` is the detailed HTTP
source of truth; `npm run api:check` validates it.

## Runtime and money

- Node 24+, ES modules, built-in `node:sqlite`, zero production npm
  dependencies. Browser-test tooling is development-only.
- Every monetary amount is integer USD cents from input through persistence and
  response. Float dollars exist only during final display formatting.
- Report lines use `listed`, `typical`, or `estimated`. An unobserved value may
  never be presented as an observed seller quote.
- Observed listings and price points retain source, source label, certainty,
  fetched time, observation flag, and evidence.

## HTTP

- `GET /api/health` is liveness. `GET /api/ready` is dependency/paid-launch
  readiness and returns 503 when unsafe. `GET /api/openapi` serves the contract.
- Every response includes `X-Request-Id`; API errors are
  `{error,code,requestId}`. Limited routes expose standard `RateLimit-*` and
  compatibility headers.
- JSON request bodies are bounded. Static file traversal, open affiliate
  redirects, untrusted forwarded hosts, unsafe request IDs, and log injection
  are rejected/sanitized.
- Public browser routes are unversioned; contracted B2B routes are `/api/v1/*`.
  Breaking B2B changes require a new version.

## Identity and account ownership

- Passwordless login, session, CSRF, email verification, and unsubscribe tokens
  are cryptographically random, expiring where appropriate, single-purpose,
  and stored only as SHA-256 hashes.
- Session cookie `pt_session` is HttpOnly/SameSite=Lax. CSRF cookie `pt_csrf` is
  SameSite=Strict. Authenticated mutations require matching `X-CSRF-Token` plus
  a same-origin check.
- Watchlists, alerts, preferences, notification status, entitlements, API keys,
  export, and deletion are scoped by immutable account ID—not caller-supplied
  email.
- API key secrets are shown once. Only hash, safe prefix, owner, lifecycle
  timestamps, label, tier, and usage metadata persist. Rotation atomically
  revokes the predecessor.

## Delivery, jobs, and idempotency

- Notification email requires double opt-in. Unsubscribe, bounce, and complaint
  states suppress future delivery.
- Outbox payloads are encrypted at rest; worker jobs/outbox records use durable
  leases, bounded retries/backoff, and terminal failure states.
- Stripe webhooks verify raw-body signatures and dedupe by stored event ID.
  Resend/Svix events verify raw body and signed headers and dedupe by provider
  event ID.
- Idempotency is operation-specific and documented in OpenAPI
  `x-idempotency.strategy`. No generic inbound `Idempotency-Key` contract exists.
  `/api/v1/track` is not retry-idempotent.

## Production safety

- Paid launch requires `ENABLE_LIVE_BILLING=1`, HTTPS `PUBLIC_BASE_URL`, absolute
  durable `PRICETRUTH_DB`, Resend/from/outbox/webhook values, Stripe secret,
  webhook and all price IDs, enabled worker, and live sources for declared
  `LAUNCH_VERTICALS`.
- The launch gate and `/api/ready` fail closed. Mock billing and ephemeral
  storage are never paid-production modes.
- SQLite supports one active app/writer. Multiple replicas require managed
  PostgreSQL and separately owned workers first.
- Backups are consistent SQLite snapshots, integrity-checked, hashed, copied
  off host, monitored for freshness, and restore-drilled.

## Extension

- Manifest V3; sole API permission is local `storage`; host access is limited to
  declared, tested seller adapters.
- Detection uses adapter selectors/exclusions before a bounded conservative
  fallback. Weak, hidden, struck-through, and implausible candidates are quiet.
- Fee calculation, preferences, and corrections remain local. There is no
  network, analytics, remote code, or dynamic-code path. Feedback opens only on
  explicit user action and never includes the shopping-page URL.
- Store packages include correct icons, options, privacy disclosure, origin-bound
  config, and the same fixture-tested adapter implementation.

## Required verification

```text
npm run check
npm test
npm run build
npm run smoke:security
npm run smoke:performance
npm run test:e2e
npm run test:a11y
```

CI also builds and probes the non-root container, audits production
dependencies, and runs CodeQL. Manual accessibility, receipt accuracy, billing,
provider-failure, backup/restore, incident, legal, and store gates remain
required because automation cannot prove those outcomes.
