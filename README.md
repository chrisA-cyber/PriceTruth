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

That's it — **zero dependencies** (Node ≥ 24, built-in SQLite). The server boots on
[http://localhost:4780](http://localhost:4780) and auto-seeds five demo products with 90 days
of deterministic price history.

Other commands:

| Command | Does |
|---|---|
| `npm test` | Full test suite (engine, security, API integration) |
| `npm run seed` | Re-seed demo data + mint a demo B2B API key |
| `npm run keygen -- "Acme" pro` | Mint a B2B API key (printed once, stored hashed) |

## What's in the box

- **True-price engine** (`src/engine/`) — per-vertical fee models for hotels, flights,
  event tickets, subscriptions, and retail; integer-cents math throughout; certainty and
  confidence on every line item.
- **Price history + deal quality** — SQLite-backed history with 30/90-day stats and a
  0–100 deal score (position in range + vs. average + fee load).
- **Web app** (`public/`) — glance-first UI: the verdict first, the breakdown behind it.
  Analyzer for any price, history charts, price alerts with a premium paywall demo.
- **Browser extension** (`extension/`) — MV3 prototype that overlays true-price estimates
  on booking/ticketing sites. Computes everything locally; makes zero network requests.
- **B2B pricing API** (`/api/v1/*`) — key-authenticated, metered, quota-tiered. See
  [docs/API.md](docs/API.md).
- **Monetization design** — affiliate interstitials with FTC-compliant disclosure and an
  open-redirect guard, premium alert tier, B2B tiers. See [docs/BUSINESS.md](docs/BUSINESS.md).
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
`assumptions`, and `disclosures`. Full surface in [CONTRACTS.md](CONTRACTS.md), B2B
reference in [docs/API.md](docs/API.md).

## Honest scope

This is a working prototype. Fee models use published typical values, demo products use
synthetic (deterministic, clearly labeled) history, alerts are stored but not emailed, and
premium is a paywall demo, not a billing system. The production path — real per-merchant
quotes, scraper/partner data feeds, alert delivery with double opt-in, TLS deployment — is
mapped in [docs/BUSINESS.md](docs/BUSINESS.md) and [docs/SECURITY.md](docs/SECURITY.md).

## Layout

```
src/            engine, SQLite layer, secure zero-dep HTTP server
src/data/       fee datasets (per vertical) + affiliate partner allowlist
public/         web app (no build step)
extension/      MV3 browser extension prototype (local-only compute)
docs/           business model, API reference, security threat model, legal
test/           node:test suite
```
