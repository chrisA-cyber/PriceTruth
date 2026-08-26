# PriceTruth

**The actual price of anything online.**

Coupon extensions ask *"Can I get you a coupon?"*
PriceTruth asks **"What will this actually cost me?"**

PriceTruth is the truth layer for buying things online: it turns a seller-quoted price and
the shopper's selected options into a transparent **true price**. It preserves current
all-in prices, adds only documented excluded charges or selected options, explains renewal
cliffs, tracks eligible verified prices over time, and scores whether today is a good deal.

| You're looking at | Advertised | PriceTruth says |
|---|---|---|
| Current U.S. hotel display | $219/night | **$219/night** unless the seller explicitly excludes tax or another mandatory charge; optional parking is added only when selected |
| Flight total | $189 | **$266** when the shopper selects a $45 carry-on and $32 seat; mandatory taxes already in the seller total are not invented again |
| Current U.S. event ticket display | $86 | **$86 before optional add-ons**; a mandatory fee is added only with explicit separate-fee evidence |
| Netflix Standard catalog snapshot | $19.99/mo | **$239.88 first year** from a dated, linked catalog row |

Every number is labeled — `listed` (quoted by the seller or shopper), `catalog` (a dated
verified snapshot), `typical` (market data), or `estimated` (heuristic) — with a confidence
score. Honesty about uncertainty is a product feature, not a footnote.

## Quickstart

```
npm start
```

That's it — **zero runtime dependencies** (Node ≥ 24, built-in SQLite). The server boots on
[http://localhost:4780](http://localhost:4780). Local development includes clearly labeled
illustrative reports plus the dated verified subscription catalog. Search never substitutes
a modeled price: unsupported lookups route to the manual analyzer. Billing remains an
explicit **mock** simulation until the production gate is satisfied.

Other commands:

| Command | Does |
|---|---|
| `npm run build` | Preflight: boot the app, health-check it, print verified-vs-manual-only source status |
| `npm run check` | Parse source and validate OpenAPI + extension release contracts |
| `npm test` | Full unit/integration suite (engine, auth, jobs, email, security, providers, billing, DB, API, extension) |
| `npm run test:browser` | Playwright desktop/mobile flows and axe accessibility checks |
| `npm run smoke:security` | HTTP security regression probe |
| `npm run smoke:performance` | Local p95 performance regression budget |
| `npm run launch:gate -- --env-file <file>` | Fail-closed production configuration audit |
| `npm run seed` | Re-seed demo data + mint a demo B2B API key |
| `npm run keygen -- "Acme" pro` | Mint a B2B API key (printed once, stored hashed) |

## Deploying a demo

PriceTruth is a **persistent Node server** (it serves a live API, writes to SQLite at
runtime, and owns background work). Its backend therefore needs a host that runs a
long-lived Node process. It auto-seeds its demo data on boot, so no database needs to be
provisioned for a demo.

**Render (recommended, free tier).** A blueprint ships in [`render.yaml`](render.yaml):

1. In Render: **New + → Blueprint**, connect this repo, **Apply**.
2. The blueprint sets `HOST=0.0.0.0` + `NODE_ENV=production`, pins Node 24, runs
   `npm run build` as a boot preflight, and gates traffic on `/api/ready`.
3. Set its required public origin and optionally add provider credentials. Accounts,
   customer email, and charging remain disabled. Do not add Stripe credentials to this
   ephemeral blueprint; paid service uses [`render.production.yaml`](render.production.yaml).

**Railway / Fly.io / any PaaS.** Set `HOST=0.0.0.0`, an origin-only
`PUBLIC_BASE_URL`, and the explicit capability/data flags from an environment
template (the platform supplies `PORT`), then start with `npm start` (see
[`Procfile`](Procfile)). No build tooling or production dependencies are needed.
The server also auto-binds `0.0.0.0` when it detects a hosted platform
(`RENDER`/`RAILWAY_ENVIRONMENT`/`FLY_APP_NAME`/`DYNO`/`NODE_ENV=production`).

**Netlify.** The supported deployment keeps the durable Node/SQLite backend on
Render, Fly.io, Railway, or an equivalent host, while Netlify publishes the static
frontend and proxies every dynamic route to that backend. `netlify.toml` and
`npm run build:netlify` are included and fail closed if
`PRICETRUTH_BACKEND_ORIGIN` is missing or unsafe. See
[`docs/NETLIFY.md`](docs/NETLIFY.md). A standalone Netlify Functions deployment
would first require migrating SQLite to Postgres and the permanent worker to
scheduled/background workloads.

> **Durability caveat.** The free tier's disk is ephemeral and idle instances sleep — fine
> for a demo, since the app reseeds the demo catalog and 90-day history on every cold start.
> But all runtime data is wiped on restart/redeploy. That includes demo history and,
> on any incorrectly configured ephemeral custom deployment, customer alerts,
> entitlements, API keys, and the revenue ledger.
> **Do not enable live billing on an ephemeral free instance.** For anything persistent,
> attach a disk and point `PRICETRUTH_DB` at it (see the commented `disk:` block in
> [`render.yaml`](render.yaml)), and put TLS in front (the app speaks plain HTTP and expects
> the platform to terminate TLS).

## Production deployment

Use the non-root [`Dockerfile`](Dockerfile), persistent-volume
[`compose.yaml`](compose.yaml), and environment templates in `deploy/`. Paid
launch fails closed unless HTTPS, durable storage, verified Resend delivery,
outbox encryption, workers, live Stripe lifecycle configuration, and live data
for every declared launch vertical are present. `GET /api/ready` reports the
same runtime boundary; `GET /api/health` is liveness only.

The complete promotion, proxy, rollback, backup/restore, monitoring, SLO,
incident, and launch gates are in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) and
[docs/LAUNCH-CHECKLIST.md](docs/LAUNCH-CHECKLIST.md). SQLite production uses one
active writer; move to managed PostgreSQL before horizontal replication.

## Configuration

Local development runs with **no configuration**: unsupported verified searches
fail closed and hand off to manual advertised-price input; billing uses an explicit simulation. Production never
silently falls back to mock charging. Start with the appropriate template in
`deploy/`; inject secrets through the host's secret store, never the repository.

| Env var | Effect when set | Unset behavior |
|---|---|---|
| `PUBLIC_BASE_URL` | Origin-only canonical URL for links, checkout redirects, OG tags, and sitemap | Derived locally; production startup fails |
| `ENABLE_ACCOUNTS` | Enables authenticated account/customer surfaces when all email, legal, origin, and storage checks pass | Disabled in production |
| `REQUIRE_EMAIL` / `EMAIL_TRANSPORT` / `RESEND_API_KEY` / `EMAIL_FROM` | Requires verified Resend delivery for sign-in, verification, alerts, and digests | Console/dev only; disabled in production |
| `OUTBOX_ENCRYPTION_KEY` / `RESEND_WEBHOOK_SECRET` | Encrypts durable email payloads and verifies delivery events | Paid/account readiness fails |
| `ADMIN_TOKEN` | Enables owner-only `/admin` + `/api/admin/metrics` (sent as `X-Admin-Token`) | Admin surfaces disabled (403) |
| `ENABLE_LIVE_BILLING` | Explicit paid-production safety switch | Live charging disabled |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | Live Stripe API access and raw-body webhook verification | Local simulation; disabled in production |
| `STRIPE_PRICE_*` / `STRIPE_PRODUCT_*` | Immutable Price/Product IDs for every offered plan | Paid readiness fails |
| `STRIPE_AUTOMATIC_TAX` | Enables Stripe automatic-tax calculation after the operator independently completes applicable tax setup; this flag is not proof of registration or compliance | Paid launch gate fails |
| `LEGAL_OPERATOR_NAME` / `LEGAL_JURISDICTION` / `SUPPORT_CONTACT_URL` (or `SUPPORT_CONTACT_EMAIL`) / `LEGAL_EFFECTIVE_DATE` / `LEGAL_TERMS_VERSION` / `LEGAL_APPROVED` | Publishes approved operator terms and records versioned checkout acceptance | Accounts and paid checkout stay unavailable |
| `LAUNCH_VERTICALS` | Comma-separated public scope; undeclared verticals are unavailable in production | Paid launch gate fails; demo may expose modeled verticals |
| `SUBSCRIPTION_CATALOG_MAX_AGE_DAYS` | Maximum age of the oldest fully verified subscription row (integer `1..365`, default `93`) | Default applies; stale/invalid catalog blocks paid launch and subscription alerts |
| `JSON_BODY_TIMEOUT_MS` / `PROVIDER_RESPONSE_LIMIT_BYTES` | Bounds client JSON upload time and upstream provider JSON size (defaults: 10 seconds / 1 MiB) | Safe defaults apply |
| `WEBHOOK_BODY_TIMEOUT_MS` / `STRIPE_WEBHOOK_BODY_LIMIT_BYTES` / `EMAIL_WEBHOOK_BODY_LIMIT_BYTES` | Route-specific webhook read and payload limits | Safe defaults apply (10 seconds / 256 KiB / 128 KiB) |
| `WEBHOOK_MAX_CONCURRENCY` / `WEBHOOK_PREAUTH_MAX_CONCURRENCY_PER_IP` | Bounds verified global processing and unsigned per-IP body reads | Safe defaults apply (8 / 2) |
| `DISABLE_WORKER` | Maintenance-only worker stop when set to `1` | Durable in-process worker runs |
| `ENABLE_DEMO_SEED` | Explicitly permits synthetic catalog/history in demo deployment; paid production requires the exact value `0` | Production removes demo seed |
| `TICKETMASTER_API_KEY` | Observed event listing prices (not launch-grade all-in checkout attestation) | Verified search unavailable; manual analyzer remains available |
| `AMADEUS_CLIENT_ID` / `AMADEUS_CLIENT_SECRET` | Production Amadeus flight + hotel quotes when both credentials and the exact production origin are present | Verified search unavailable; manual analyzer remains available |
| `AMADEUS_HOST` | Must be the origin-only `https://api.amadeus.com`; sandbox/test hosts are deliberately rejected | Amadeus search is disabled |
| `RETAIL_API_URL` / `RETAIL_API_KEY` | Optional generic retail feed | Verified search unavailable; manual analyzer remains available |
| `ENABLE_AFFILIATE_LINKS` / `AFFILIATE_RELATIONSHIPS_APPROVED` | Both must be `1`, with a public disclosure URL and a real per-partner tag, before `/go/*` links exist | Affiliate routes and partner metadata are disabled |
| `AFFILIATE_DISCLOSURE_URL` / `AFFILIATE_TAG_<PARTNER>` | Approved public disclosure and secret-store partner identifier; demo/test/placeholder tags are rejected | Affiliate routes remain disabled |
| `PRICETRUTH_DB` | SQLite file path | `data/pricetruth.db` (or `:memory:` in tests) |

`npm run build` prints source provenance plus billing mode/readiness—run it after
configuration changes. Subscriptions are always backed by a
**dated dataset snapshot** ([`src/data/plans/`](src/data/plans/)), not a live feed; see
[docs/DATA-SOURCES.md](docs/DATA-SOURCES.md) for the methodology behind every source. Local
demo searches remain available with explicit stale provenance, while paid readiness and
subscription notifications fail closed after the verified freshness window expires.

## What's in the box

- **True-price engine** (`src/engine/`) — per-vertical fee models for hotels, flights,
  event tickets, subscriptions, and retail; integer-cents math throughout; certainty and
  confidence on every line item.
- **Price history + deal quality** — SQLite-backed history with 30/90-day stats and a
  0–100 deal score (position in range + vs. average + fee load).
- **Live data providers** (`src/providers/`) — one uniform search over all five verticals
  (`POST /api/search`): live source when a truth-usable provider is configured (production Amadeus for
  flights + hotels, a dated dataset for subscriptions, optional retail feed), otherwise a
  safe unavailable/no-match response with manual-entry guidance—never an invented quote. Anonymous searches are ephemeral; signed-in
  searches create account-private history. Methodology in [docs/DATA-SOURCES.md](docs/DATA-SOURCES.md).
- **Web app** (`public/`) — glance-first UI: the verdict first, the breakdown behind it.
  Search + analyzer for any price, history charts, deal gauges, price alerts, a pricing page,
  self-serve billing, and a one-time API-key reveal.
- **Browser extension** (`extension/`) — publishable MV3 release candidate with fixture-tested
  seller adapters, local correction and per-site controls, accessible overlay,
  correct icons, and minimal permission. Calculations are local and make no
  automatic network requests. Store review and rollout remain external release gates.
- **B2B pricing API** (`/api/v1/*`) — key-authenticated, metered, quota-tiered. See
  [docs/API.md](docs/API.md); the full OpenAPI 3.1 document is served at
  [`/api/openapi`](http://localhost:4780/api/openapi).
- **Monetization, wired** — Stripe billing with **zero dependencies** (REST over `fetch` +
  `node:crypto` HMAC webhooks), with a fully-working simulated mock mode: consumer
  freemium→premium upgrade, B2B API-key issuance on checkout, usage metering, self-serve
  portal, and an owner-only revenue/usage dashboard (`/admin`). Affiliate interstitials with
  FTC-compliant disclosure and an open-redirect guard. See [docs/BUSINESS.md](docs/BUSINESS.md).
- **Compliance layer** — privacy policy, terms, affiliate disclosure, and an FTC
  junk-fee-rule posture memo in [docs/legal/](docs/legal/).
- **Security** — passwordless hashed-token sessions, CSRF + same-origin mutations,
  strict CSP, rate limiting, input allowlists, hashed/rotatable API keys,
  prepared statements, signed/idempotent webhooks, encrypted outbox payloads,
  traversal/open-redirect guards, and no third-party production runtime code.
  Threat model in [docs/SECURITY.md](docs/SECURITY.md).

## API in 10 seconds

```
POST /api/analyze
{ "vertical": "hotel", "advertised_cents": 21900,
  "context": { "market": "las_vegas", "nights": 3 } }
```

→ a `Report` with `truePrice`, labeled `lineItems`, `feeLoadPct`, `confidence`,
`assumptions`, and `disclosures`. Or search a verified live/catalog listing and get the report plus
deal score in one call:

```
POST /api/search
{ "vertical": "ticket", "q": "taylor swift" }
```

Full surface in [CONTRACTS.md](CONTRACTS.md), B2B reference in [docs/API.md](docs/API.md).

## Honest scope

The repository implements the complete local product and a fail-closed production
foundation: verified accounts, durable double-opt-in alerts, signed delivery and
billing webhooks, entitlements, self-service key lifecycle, workers, readiness,
backups, deployment, CI, browser/accessibility gates, and operational contracts.
The default local mode intentionally remains demo-safe: missing provider keys fail
closed into manual input, seeded illustrative history is synthetic, console/memory email is not customer
delivery, and billing is simulated.

No source-code change can manufacture provider contracts, a verified sending
domain, Stripe products, production secrets, off-host backup schedules, legal
approval, Chrome Web Store review, real checkout evidence, beta users, support
staffing, or SLO history. Those external launch proofs are explicit no-go gates
in [docs/LAUNCH-CHECKLIST.md](docs/LAUNCH-CHECKLIST.md), rather than being hidden
behind a “ready” claim. Every projected number remains labeled and no estimate is
shown as a live quote.

## Layout

```
src/            engine, SQLite layer, secure zero-dep HTTP server, build preflight
src/providers/  verified live/catalog clients with fail-closed search behavior
src/billing.js  zero-dep Stripe (REST + HMAC webhooks) with a mock mode
src/data/       fee datasets, subscription snapshot, affiliate partner allowlist
public/         web app (no build step) + owner-only admin dashboard
extension/      publishable MV3 extension, seller adapters, local calculator/settings
openapi/        full OpenAPI 3.1 contract and SDK generator configuration
scripts/        gates, smoke probes, package, backup/restore, post-deploy verification
deploy/         local/staging/production environment templates
docs/           API, deployment, operations, SLO, incident, accessibility, legal
test/           node:test integration/fixtures plus Playwright browser/axe suites
```
