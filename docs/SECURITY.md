# PriceTruth security architecture

**Last reviewed:** 2026-08-26
**Code scope:** `src/server.js`, `src/security.js`, `src/db.js`, `src/billing.js`,
`src/email.js`, `src/jobs.js`, and `src/providers/**`

This document describes the current implementation. It is not a security
certification, legal opinion, or substitute for an independent review before a
public paid launch.

## 1. Security model

PriceTruth has three deliberately different operating modes:

- **Local/demo:** non-production may run with mock billing, memory email, an
  in-memory database, and synthetic demo data. Responses identify modeled and
  demo data; no real payment is represented as completed.
- **Production without accounts:** the public analysis surface can run with
  `ENABLE_ACCOUNTS=0`. Authentication, account data, notifications, API-key
  self-service, and billing mutations are unavailable.
- **Paid production:** live commerce is double opt-in. It requires both
  `ENABLE_LIVE_BILLING=1` and a valid live Stripe secret plus the complete
  account, email, legal, worker, database, tax, webhook, and verified Stripe
  catalog configuration. A key/flag mismatch is disabled and fails readiness;
  it never falls back to mock checkout.

`GET /api/health` is liveness. `GET /api/ready` is the operational readiness
boundary. `GET /api/meta` exposes only safe capability and legal projections,
not secrets. A database-integrity failure or unresolved critical billing
reconciliation disables account/billing capabilities and blocks checkout.
Signed provider webhooks remain available so operators can recover.

The standalone production entry point refuses unsafe startup configurations.
The predeploy `npm run launch:gate` validates the corresponding deployment
contract. Neither is a replacement for operator approval of the external gates
listed below.

## 2. Identity, sessions, and account ownership

### Passwordless sign-in

- Sign-in tokens are generated from 32 random bytes, stored only as SHA-256
  hashes, expire after 15 minutes by default, and are consumed atomically once.
- Magic-link tokens are placed in URL fragments. The browser posts the token to
  `POST /api/auth/verify`; query-token GET bridges return `410` and never mutate
  state. This keeps bearer tokens out of normal HTTP request URLs, referrers,
  proxy logs, and link-scanner prefetches.
- Sign-in requests return an anti-enumeration response. Per-address, per-IP, and
  global email budgets limit mail abuse. Expired requests and truly empty,
  unverified accounts are pruned so arbitrary addresses are not retained
  indefinitely.
- Production email-only legacy alert signup is retired. Alerts are owned by a
  verified, signed-in account.

### Sessions

- Session and CSRF values are high-entropy random tokens. Only their hashes are
  stored in SQLite.
- `pt_session` is `HttpOnly`, `SameSite=Lax`, and `Secure` in production.
  `pt_csrf` is readable by the same-origin frontend, `SameSite=Strict`, and
  `Secure` in production.
- Cookie-authenticated mutations require the matching `X-CSRF-Token`. Supplied
  `Origin` must match the canonical public origin, and cross-site Fetch Metadata
  values are rejected.
- Sessions expire (30 days by default), can be individually revoked, and are
  deleted on account erasure. Deleted accounts cannot authenticate.

All account resources are selected by the authenticated session's account ID;
client-supplied emails do not confer ownership. Private products and histories
are owner-gated at list, detail, history, watchlist, alert, refresh, and delete
boundaries. Private product identifiers are namespaced by account, and refresh
writes re-check ownership after any asynchronous provider call to prevent
deletion races from resurrecting data.

## 3. HTTP and browser protections

`src/security.js` applies the following controls to normal responses:

- CSP: same-origin scripts, styles, connections, fonts, and images (plus data
  images); no objects, base URL rewriting, cross-origin forms, or framing.
- `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, restrictive `Permissions-Policy`, COOP, and
  CORP.
- HSTS in production. TLS itself terminates at the deployment edge.
- `Cache-Control: no-store` on APIs.
- A validated or generated request ID returned as `X-Request-Id`.

JSON request bodies are limited to 32 KiB, must be JSON objects, pass
route-specific allowlist validation, and have a configurable 10-second read
deadline (`JSON_BODY_TIMEOUT_MS`). A timeout is `408`; a declared or streamed
oversize body is `413`. Webhook bodies have separate configurable caps (256 KiB
Stripe and 128 KiB email by default), early `Content-Length` rejection, and a
10-second read timeout. Static paths are resolved under the public root and
extension package inputs are explicit allowlists. Dynamic HTML uses output
escaping.

API/read/write/B2B/auth/search/webhook limiters are bounded in memory and return
rate-limit metadata with `Retry-After` where appropriate. Webhook pre-auth
budgets are route- and IP-scoped; invalid or slow unsigned traffic does not
consume the post-signature Stripe or email processing budget.

## 4. Data protection and privacy

SQLite runs with foreign keys and durable schema migrations. Production account
capability requires an absolute, non-memory `PRICETRUTH_DB` path. A cached
integrity result is established at startup; request paths do not run synchronous
full-database scans.

Shipped data controls include:

- prepared statements and bound parameters throughout the database layer;
- integer cents for stored and calculated money;
- raw API keys stored only as SHA-256 hashes;
- one-time checkout keys sealed with AES-256-GCM using
  `PENDING_KEY_ENCRYPTION_KEY` or `OUTBOX_ENCRYPTION_KEY`; legacy plaintext
  pending keys are sealed during migration or expired fail-closed;
- email outbox payloads sealed with AES-256-GCM; canceled notification rows are
  scrubbed before retention expiry;
- auth, notification-verification, and unsubscribe capabilities stored as
  hashes rather than bearer values;
- user-agent and IP session metadata stored as presence-limited hashes, not raw
  values;
- bounded retention for completed/canceled jobs, delivery events, terminal
  outbox rows, claims, intents, tokens, and sessions;
- data export covering the account, preferences, accepted terms, private
  reports and eligible history, watchlist, alerts, notification state, delivery
  records, API-key metadata/usage, entitlements, session/security activity, and
  sanitized billing history; and
- account deletion that purges private reports/history, alert and notification
  state, sessions, outbox, pending claims, API-key labels/prefixes/usage, and
  other account-owned data. Retained financial rows are deidentified and a
  minimal hashed Stripe-customer tombstone prevents late events from
  resurrecting an account.

Deletion is fail-closed while an active or charge-risk subscription, pending
checkout, or account/customer-linked billing reconciliation exists. The user
must cancel/resolve that relationship first, preserving billing-portal access
and preventing stranded charges.

Some PII columns, including account and delivery email addresses while active,
are not column-encrypted. Production therefore requires encrypted persistent
storage, restricted filesystem/service-account access, encrypted backups, and
an operator retention policy.

## 5. Responsible-disclosure publication gate

> **Internal prelaunch guidance — not a public disclosure policy.**

A security-reporting contact has not been supplied in this repository. The
operator must approve and publish a monitored reporting channel, safe-harbor
scope, incident process, and any response targets before public exposure. Until
then, report issues privately through an established maintainer channel and
never publish credentials, exploit payloads, or affected-user data.

## 6. Billing controls

Live checkout is account-authenticated and CSRF-protected. The server records an
explicit current terms acceptance (`acceptTerms: true` and the exact
`LEGAL_TERMS_VERSION`) before creating a session. Checkout uses a reserved,
account-owned intent, Stripe idempotency keys, the existing Stripe customer when
known, and blocks duplicate or cross-tier active/pending relationships that
would create unmanaged subscriptions.

Live Stripe configuration is checked for:

- a valid live secret and signed webhook secret;
- exactly configured Price and Product IDs for each plan;
- live, active, USD, monthly recurring Price objects whose amounts, lookup keys,
  and products match the internal plan catalog;
- `STRIPE_AUTOMATIC_TAX=1`; checkout enables automatic tax, requires billing
  address collection, and updates an existing customer's address; and
- canonical HTTPS return URLs, durable account/email/worker infrastructure,
  approved legal metadata, and an operator-grade admin token.

Checkout completion is verified against immutable account metadata, the
reserved intent, supported price identity, currency, mode, and payment state.
The status endpoint is account-owned and non-consuming. API-key reveal is a
CSRF-protected `POST` and succeeds once. The old destructive GET claim exists
only in local mock compatibility mode and returns `405` in live mode.

Stripe webhook controls include exact raw-body HMAC verification, timestamp
freshness, acceptance of any valid repeated `v1` signature during secret
rotation, event-ID replay protection, object/event ordering watermarks, and
transactional entitlement/key synchronization. Actionable lifecycle events are
handled explicitly; unrelated signed informational events are audited/ignored
without poisoning readiness. Mapping or integrity failures are persisted to a
reconciliation queue and return a retryable error rather than being silently
acknowledged.

The ledger recognizes invoice cash once across Stripe's paired invoice events,
books cumulative refunds by delta, and audits dispute withdrawal/restoration
with event-order protection. Disputes do not automatically grant or revoke
entitlements; the operator must apply the approved policy. Subscription plan
resolution uses actual Stripe item Price IDs rather than trusting mutable
metadata. Past-due API keys are suspended and can resume; terminal entitlement
states revoke them.

Stripe and Resend outbound calls have bounded timeouts. Secrets and provider
payloads are not returned by readiness, metadata, or admin responses.

Upstream provider JSON is streamed through a configurable 1 MiB cap
(`PROVIDER_RESPONSE_LIMIT_BYTES`) before parsing. Oversize or malformed
successful responses fail as `502`; transport deadlines fail as `504`. This
prevents a nominal JSON endpoint from forcing an unbounded buffer allocation.

## 7. Notification controls

Notification email uses a durable encrypted outbox, leases, retry limits,
idempotency keys, provider delivery-event reconciliation, and bounded retention.
The production transport must be Resend with an approved sender, API key,
webhook secret, encryption key, and enabled worker.

Email alerts require a verified notification subscription and a stable,
eligible price source. Verification, unsubscribe, and per-alert unsubscribe
links use fragments followed by explicit POST confirmation. Bounce, complaint,
unsubscribe, preference opt-out, alert pause, alert deletion, account deletion,
and entitlement changes are rechecked immediately before each send. They cancel
and scrub already-pending/retrying nonessential mail; a worker that claimed a
row before erasure is still prevented from sending it afterward.

Weekly digests require all of: active Premium entitlement, verified active email
subscription, enabled alert/digest preferences, and an account/week
idempotency key. Free, stale, canceled, or suppressed accounts are excluded.

## 8. API keys and administration

B2B keys contain 192 bits of random material. Only a hash and limited display
prefix are stored. Keys are account-owned, listable without secrets, rotatable,
revocable, suspendable, entitlement-checked at authentication, and metered by
day. Production self-service cannot bypass paid API entitlement even when a
development override is present.

Customer keys can read/analyze within their plan. Canonical-history ingestion
requires an operator-issued `can_write_history` scope, preventing arbitrary
customer keys from poisoning shared public history.

Admin endpoints exist only with a non-placeholder, printable, high-entropy
`ADMIN_TOKEN` of at least 32 characters. Production rejects a weak configured
token. Comparisons use constant-time comparison after a length check. Admin output is sanitized
and never includes raw keys, Stripe secrets, email secrets, or encryption keys.

## 9. Price-data integrity

Public product endpoints expose only curated products in enabled launch
verticals. Signed-out search is ephemeral. Signed-in search creates an
account-private product subject to account quotas and deletion. Scheduled work
honors account capability, launch vertical containment, stable provider
identity, ownership, and refresh eligibility.

Every listing and point carries source, certainty, freshness, provenance,
observed/dataset/modeled state, stable identity, and explicit alert eligibility.
Modeled, degraded, stale, ambiguous-currency, or identity-mismatched points do
not trigger alerts/digests or pollute eligible stats. Dataset observations are
deduplicated by their source/as-of identity rather than by refresh time. Deal
scores require distinct eligible observation dates; a single snapshot remains
unscored.

Provider hosts are fixed or operator-configured, queries are encoded/validated,
responses are schema-normalized, currencies are checked before cents math, and
requests use timeouts, query caching, daily budgets, and transport-only circuit
breakers. Production Amadeus credentials are sent only to the exact approved
origin. Unsupported semantic providers remain unavailable rather than being
described as truth-ready.

## 10. Operational requirements and residual risk

The following controls are not supplied by application code and remain launch
gates for the operator:

1. Terminate TLS at a trusted edge, redirect HTTP to HTTPS, restrict direct
   origin access, and configure `TRUST_PROXY=1` only behind a proxy that strips
   spoofed forwarding headers.
2. Put secrets in a managed secret store, restrict rotation access, and test
   Stripe/Resend key and webhook-secret rotation. Never commit production env
   files or databases.
3. Use encrypted persistent disks and encrypted, access-controlled backups.
   Run `npm run db:backup`, restore drills, capacity monitoring, and offline
   SQLite integrity checks. A synchronous integrity check runs at process
   startup only; repeating full scans in the serving event loop is unsafe for
   large databases.
4. Treat the SQLite deployment as a single-writer service. Do not point multiple
   independent replicas at an unsupported shared file. Migrate to a managed
   transactional database before scale or availability requirements exceed
   that model.
5. Add edge/shared rate limiting and bot/abuse controls for multi-instance
   deployments. In-process buckets reset on restart and are not a distributed
   quota system.
6. Complete applicable tax registrations and nexus analysis, customer-facing tax review,
   refund/dispute procedures, price-catalog approval, and legal review. The
   automatic-tax parameter is a technical control, not proof of compliance.
7. Verify the email domain (SPF, DKIM, DMARC), monitor bounce/complaint rates,
   and configure the exact documented Stripe and Resend webhook event sets.
8. Monitor `/api/ready`, pending billing reconciliation, outbox/job failures,
   provider health/budgets, database size, webhook rejection/rate metrics, and
   backup freshness. Alert a human before accepting paid traffic.
9. Maintain the Node 24 runtime and dev tooling on supported security releases.
   Runtime has no third-party npm dependencies, but Node itself, the OS image,
   Playwright tooling, Stripe, Resend, and data providers remain supply-chain
   dependencies.
10. Commission an independent application, infrastructure, privacy, and legal
    review before launch and after material auth, billing, provider, or schema
    changes.

## 11. Verification

Relevant automated gates include:

```text
npm test
npm run check
npm run smoke:security
npm run launch:gate
npm run db:backup
npm run deploy:verify
```

Tests cover auth token consumption, session/CSRF ownership, private-data
isolation and deletion races, notification suppression, API-key lifecycle,
billing ordering/idempotency/reconciliation, webhook signatures and limits,
provider provenance/currency math, schema migrations, data retention, readiness,
OpenAPI drift, and launch configuration. Passing tests demonstrate the tested
implementation; they do not eliminate the external requirements above.
