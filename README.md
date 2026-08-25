# PriceTruth

**The actual price of anything online.**

Coupon extensions ask *"Can I get you a coupon?"*
PriceTruth asks **"What will this actually cost me?"**

PriceTruth is the truth layer for buying things online: it turns advertised prices into
**true prices** — resort fees, ancillary airline fees, ticketing service fees, subscription
teaser-rate cliffs, taxes — then tracks them over time and scores whether today is actually
a good deal.

| You're looking at | Advertised | PriceTruth says |
|---|---|---|
| Las Vegas hotel | $219/night | **$317/night** (room $219 + resort fee $45 + taxes $38 + parking $15) |
| LCC flight | $189 | **$294** (fare $189 + carry-on $45 + seat $32 + booking fee $8 + taxes $20) |
| Arena ticket | $86 | **$134 checkout** (face $86 + service $27.95 + facility $7 + processing $5.95 + tax $7.10) |
| "$9.99/mo" subscription | $9.99/mo | **$179.88 first year** (rises to $19.99 after 6 months) |

Every projected number is labeled — `listed` (quoted to you), `typical` (market data), or
`estimated` (heuristic) — with a confidence score. Honesty about uncertainty is a product
feature, not a footnote.

## Quickstart

```
npm start
```

That's it — **zero runtime dependencies** (Node ≥ 24, built-in SQLite). The server boots on
[http://localhost:4780](http://localhost:4780) and auto-seeds five demo products with 90 days
of deterministic price history. With no secrets set, every vertical serves clearly-labeled
estimates and billing runs in simulated **mock** mode — the whole product is usable offline.

Other commands:

| Command | Does |
|---|---|
| `npm run build` | Preflight: boot the app, health-check it, print a live-vs-fallback report |
| `npm test` | Full test suite (engine, security, providers, billing, DB, API integration) |
| `npm run seed` | Re-seed demo data + mint a demo B2B API key |
| `npm run keygen -- "Acme" pro` | Mint a B2B API key (printed once, stored hashed) |

## Deploying a demo

PriceTruth is a **persistent Node server** (it serves the web app *and* a live API, and
writes to SQLite at runtime). It needs a host that runs a long-lived Node process — not a
static/serverless host like Netlify or GitHub Pages, where the `/api/*` routes have nowhere
to run. It auto-seeds its demo data on boot, so no database needs to be provisioned.

**Render (recommended, free tier).** A blueprint ships in [`render.yaml`](render.yaml):

1. In Render: **New + → Blueprint**, connect this repo, **Apply**.
2. The blueprint sets `HOST=0.0.0.0` + `NODE_ENV=production`, pins Node 24, runs
   `npm run build` as a boot preflight, and health-checks `/api/health`.
3. (Optional) Fill in the `sync: false` secrets in the Render dashboard to go live — see
   [Configuration](#configuration-going-live) below. None are required to run.

**Railway / Fly.io / any PaaS.** Set one env var, `HOST=0.0.0.0` (the platform supplies
`PORT`), and start with `npm start` (see [`Procfile`](Procfile)). No build tooling, no deps.
The server also auto-binds `0.0.0.0` when it detects a hosted platform
(`RENDER`/`RAILWAY_ENVIRONMENT`/`FLY_APP_NAME`/`DYNO`/`NODE_ENV=production`).

> The free tier's disk is ephemeral and idle instances sleep — fine for a demo, since the
> app reseeds the demo catalog and 90-day history on every cold start. Alerts or tracked
> points added at runtime reset on redeploy. For anything persistent, attach a disk (Render)
> or point `PRICETRUTH_DB` at durable storage, and put TLS in front (the app speaks plain
> HTTP and expects the platform to terminate TLS).

## Configuration (going live)

Everything runs with **no configuration**: unset live sources fall back to labeled
estimates, and billing runs in mock mode. Set these environment variables to switch
individual pieces to live. They are all `sync: false` in [`render.yaml`](render.yaml), so
they are entered in the host's dashboard and **never committed** to the repo.

| Env var | Effect when set | Unset behavior |
|---|---|---|
| `PUBLIC_BASE_URL` | Canonical origin for checkout redirects, OG tags, sitemap | Derived from request host |
| `ADMIN_TOKEN` | Enables owner-only `/admin` + `/api/admin/metrics` (sent as `X-Admin-Token`) | Admin surfaces disabled (403) |
| `STRIPE_SECRET_KEY` | Live Stripe billing instead of mock | Simulated **mock** checkout/webhook |
| `STRIPE_WEBHOOK_SECRET` | Verifies `POST /api/billing/webhook` (HMAC-SHA256) | Webhook rejects (in live mode) |
| `STRIPE_PRICE_PREMIUM` / `_API_STARTER` / `_API_PRO` | Stripe Price IDs per plan | — (required in live mode) |
| `TICKETMASTER_API_KEY` | Live event-ticket prices (Discovery API, free key) | Labeled estimate |
| `AMADEUS_CLIENT_ID` / `AMADEUS_CLIENT_SECRET` | Live flight + hotel prices (free test tier) | Labeled estimate |
| `AMADEUS_HOST` | `https://api.amadeus.com` for production data | `https://test.api.amadeus.com` |
| `RETAIL_API_URL` / `RETAIL_API_KEY` | Optional generic retail feed | Labeled estimate |
| `PRICETRUTH_DB` | SQLite file path | `data/pricetruth.db` (or `:memory:` in tests) |

`npm run build` prints exactly which sources are LIVE vs fallback and whether billing is
live or mock — run it after setting keys to confirm. Subscriptions are always backed by a
**dated dataset snapshot** ([`src/data/plans/`](src/data/plans/)), not a live feed; see
[docs/DATA-SOURCES.md](docs/DATA-SOURCES.md) for the methodology behind every source.

## What's in the box

- **True-price engine** (`src/engine/`) — per-vertical fee models for hotels, flights,
  event tickets, subscriptions, and retail; integer-cents math throughout; certainty and
  confidence on every line item.
- **Price history + deal quality** — SQLite-backed history with 30/90-day stats and a
  0–100 deal score (position in range + vs. average + fee load).
- **Live data providers** (`src/providers/`) — one uniform search over all five verticals
  (`POST /api/search`): live source when a key is configured (Ticketmaster, Amadeus for
  flights + hotels, a dated dataset for subscriptions, optional retail feed), otherwise a
  clearly-labeled deterministic estimate. Every search accrues real price history. Methodology
  in [docs/DATA-SOURCES.md](docs/DATA-SOURCES.md).
- **Web app** (`public/`) — glance-first UI: the verdict first, the breakdown behind it.
  Search + analyzer for any price, history charts, deal gauges, price alerts, a pricing page,
  self-serve billing, and a one-time API-key reveal.
- **Browser extension** (`extension/`) — MV3 prototype that overlays true-price estimates
  on booking/ticketing sites, re-detecting across SPA navigation. Computes everything
  locally; makes zero network requests.
- **B2B pricing API** (`/api/v1/*`) — key-authenticated, metered, quota-tiered. See
  [docs/API.md](docs/API.md).
- **Monetization, wired** — Stripe billing with **zero dependencies** (REST over `fetch` +
  `node:crypto` HMAC webhooks), with a fully-working simulated mock mode: consumer
  freemium→premium upgrade, B2B API-key issuance on checkout, usage metering, self-serve
  portal, and an owner-only revenue/usage dashboard (`/admin`). Affiliate interstitials with
  FTC-compliant disclosure and an open-redirect guard. See [docs/BUSINESS.md](docs/BUSINESS.md).
- **Compliance layer** — privacy policy, terms, affiliate disclosure, and an FTC
  junk-fee-rule posture memo in [docs/legal/](docs/legal/).
- **Security** — strict CSP, rate limiting, input allowlists, hashed API keys, prepared
  statements, path-traversal and open-redirect guards, no third-party code at runtime.
  Threat model in [docs/SECURITY.md](docs/SECURITY.md).

## API in 10 seconds

```
POST /api/analyze
{ "vertical": "hotel", "advertised_cents": 21900,
  "context": { "market": "las_vegas", "nights": 3 } }
```

→ a `Report` with `truePrice`, labeled `lineItems`, `feeLoadPct`, `confidence`,
`assumptions`, and `disclosures`. Or search a live/estimated listing and get the report plus
deal score in one call:

```
POST /api/search
{ "vertical": "ticket", "q": "taylor swift" }
```

Full surface in [CONTRACTS.md](CONTRACTS.md), B2B reference in [docs/API.md](docs/API.md).

## Honest scope

This is a working prototype with real, if minimal, live paths. **What's genuine:** the
true-cost engine and integer-cents math; env-gated live clients for tickets (Ticketmaster),
flights + hotels (Amadeus test tier), and an optional retail feed; a dated subscription
dataset; Stripe billing wired end-to-end (REST + verified HMAC webhooks) that goes live the
moment real keys are set; server-side entitlements, metered API keys, and a revenue
dashboard. **What's still a demo:** with no keys set, listings are clearly-labeled estimates
and billing runs in simulated mock mode (never presented as a real charge); seeded demo
products use deterministic synthetic history; alerts are stored but not emailed; and there
are no real customers or revenue yet. The remaining production path — data-provider contracts
at scale, alert delivery with double opt-in, failed-payment/dunning handling, TLS — is mapped
in [docs/BUSINESS.md](docs/BUSINESS.md) and [docs/SECURITY.md](docs/SECURITY.md). Every
projected number in the UI is labeled and no estimate is ever shown as a live quote.

## Layout

```
src/            engine, SQLite layer, secure zero-dep HTTP server, build preflight
src/providers/  live-or-fallback data clients (hotels, flights, tickets, subs, retail)
src/billing.js  zero-dep Stripe (REST + HMAC webhooks) with a mock mode
src/data/       fee datasets, subscription snapshot, affiliate partner allowlist
public/         web app (no build step) + owner-only admin dashboard
extension/      MV3 browser extension prototype (local-only compute)
docs/           business model, API reference, security threat model, data sources, legal
test/           node:test suite
```
