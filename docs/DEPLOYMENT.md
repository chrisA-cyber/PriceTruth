# Production deployment

PriceTruth ships as a non-root Node 24 container. Production state lives in a
single SQLite database on a persistent volume; TLS terminates at the platform
load balancer or reverse proxy. The current storage design supports one active
writer instance. Do not horizontally scale the web container against a shared
SQLite file.

Netlify is supported as the public static frontend and proxy in front of this
durable service. It is not a replacement for the persistent container in the
current architecture. See `NETLIFY.md` for the fail-closed build, required
origin settings, and the separate work required for a fully Netlify-native
Postgres/Functions migration.

## Environment promotion

Use three isolated environments: local, staging, and production. Staging has a
separate database and public origin. Keep Amadeus sandbox credentials out of the
public application; sandbox contract exercises run in an isolated harness and can
never be classified as verified search. The safe
baseline in `deploy/staging.env.example` disables accounts, customer email, and
charging. The paid runtime deliberately rejects Stripe test keys, so billing
lifecycle fixtures run in CI and authorized low-value live verification occurs
only under the paid-beta release gate. Never point staging at production
customer, email, or billing state.

1. Merge only after CI core, browser, accessibility, container, and CodeQL gates
   pass.
2. Build one immutable image from the reviewed commit and record its digest.
3. Deploy that digest to staging, run migrations on startup, then run
   `npm run deploy:verify -- --base-url=https://staging-origin`.
4. Complete the release-ticket evidence in `LAUNCH-CHECKLIST.md`.
5. Back up production and verify the checksum before promotion.
6. Deploy the same digest to production with a rolling *replacement* (one
   writer at a time), then run the post-deploy verifier.
7. Observe readiness, error rate, latency, email delivery, job backlog, and
   Stripe/Resend webhook health through the defined canary window.

## Build and run

```text
docker build --pull --tag pricetruth:<commit> .
docker run --rm --read-only --tmpfs /tmp \
  --env-file /secure/path/production.env \
  --mount type=volume,src=pricetruth-data,dst=/var/lib/pricetruth \
  --publish 127.0.0.1:4780:4780 pricetruth:<commit>
```

`compose.yaml` is a hardened single-host example: all Linux capabilities are
dropped, privilege escalation is disabled, the root filesystem is read-only,
and only the data volume and memory-backed `/tmp` are writable. Bind through a
TLS reverse proxy; do not publicly expose plain port 4780. Its default
localhost configuration explicitly overrides the image to development mode so
the loopback demo can boot without weakening the production HTTPS-origin gate.
Set `NODE_ENV=production` only together with a real public HTTPS
`PUBLIC_BASE_URL` and the complete production environment.

## Required production configuration

Start from `deploy/production.env.example`, inject values from the platform's
secret store, and run `npm run launch:gate -- --env-file <rendered-env-file>`.
The gate prints variable names only and fails unless all of the following hold:

- `PUBLIC_BASE_URL` is a real public, origin-only HTTPS URL; loopback,
  reserved example/test/invalid domains, credentials, paths, query, and
  fragments are rejected.
- `PRICETRUTH_DB` is an absolute, durable, non-memory path.
- `ENABLE_ACCOUNTS=1` and an immutable approved `LEGAL_TERMS_VERSION` bind
  checkout to an authenticated customer and versioned terms acceptance.
- approved operator name, jurisdiction, effective date, support contact, and
  `LEGAL_APPROVED=1` are present; placeholders never satisfy the gate.
- Resend delivery, verified sender, outbox encryption, and delivery-webhook
  verification are configured.
- The in-process durable worker is enabled.
- `ENABLE_LIVE_BILLING=1`, `STRIPE_AUTOMATIC_TAX=1`, and all live Stripe
  Price/Product/signing values are configured and provider-verified.
- every vertical listed in `LAUNCH_VERTICALS` has its required live source; hotel
  and flight require both production Amadeus credentials and the exact origin-only
  `AMADEUS_HOST=https://api.amadeus.com`.
- when `subscription` is declared, every catalog row verifies and the oldest row is no older
  than `SUBSCRIPTION_CATALOG_MAX_AGE_DAYS` (default 93, allowed 1–365).
- the operator metrics token is strong.

The production process performs the same boundary at startup and exits before
listening when it is incomplete. The image intentionally has no default public
origin: a platform must supply the real origin. The local Compose example uses
`http://localhost:4780`, which is accepted only as a loopback demo origin.

Passwordless authentication does not use a shared `SESSION_SECRET` or token
pepper: login, session, CSRF, verification, and unsubscribe tokens are generated
with 192–256 bits of randomness and only SHA-256 hashes are persisted. Adding
unused shared secrets would not improve that design.

## Runtime probes

- `GET /api/health` is liveness only. It proves the process can answer HTTP.
- `GET /api/ready` checks database integrity/storage, email durability, paid
  launch configuration, source freshness, and the worker. Its safe
  `dataSources.subscriptionCatalog` projection includes status, age, verified/invalid row
  counts, and the configured limit. It returns 503 when unsafe.
- Route traffic only after readiness is 200. Do not use liveness to decide
  whether a paid deployment may receive customers.

The post-deploy check verifies both probes, security headers, TLS/HSTS remotely,
and a deterministic analysis request. It does not charge, send email, prove a
provider quote, or replace the release-ticket evidence. A failed check halts
promotion.

## TLS and proxy boundary

The proxy must preserve `Host` and set `X-Forwarded-Proto: https`. Strip inbound
forwarding headers at the edge before setting trusted values. Redirect HTTP to
HTTPS permanently, enable modern TLS, and do not cache `/api/*`. The app applies
HSTS in production, rejects cross-origin authenticated mutations, and derives
secure cookies from HTTPS/production state.

## Rollback

Rollback the image only when the previous application version is compatible
with the current database schema. If not, stop the service, follow the verified
database restore procedure, and then start the matching image. Never overwrite
a live SQLite database or restore while `-wal`/`-shm` sidecars exist.

For a failed canary with no schema incompatibility:

1. Stop routing new requests and stop the worker.
2. Replace the image with the last known-good digest.
3. Run readiness and the post-deploy verifier.
4. Re-enable traffic and monitor for a full canary window.
5. Open an incident and preserve logs, request IDs, image digests, and provider
   event IDs.

## Scaling boundary

Before multiple app replicas, migrate durable state and leases to managed
PostgreSQL and run collection/outbox workers as separately scalable processes.
The API and job contracts already isolate those responsibilities, but SQLite
file locking and local timer ownership make multiple active writers unsafe.
