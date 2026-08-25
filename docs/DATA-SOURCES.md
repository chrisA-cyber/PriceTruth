# PriceTruth — Data Sources & Methodology

PriceTruth's credibility rests on one rule: **never present an estimate as a live quote.**
Every price the product surfaces carries a machine-readable provenance so a person (or an API
caller) always knows whether they are looking at a real listed price or a modeled projection.

This document explains, per vertical, where the advertised price comes from, how the "true
cost" on top of it is derived, and exactly what changes when you add an API key.

## How provenance is labeled

Each listing returned by `POST /api/search` (and each line item in a `Report`) carries:

| Field | Meaning |
|---|---|
| `source` | Machine tag: `live:<provider>`, `dataset:plans`, or `estimated:model`. |
| `sourceLabel` | Human-readable description of exactly what the number is. |
| `certainty` | `live` (a real listed price), `typical` (real but point-in-time catalog / market data), or `estimated` (a modeled placeholder). |
| `degraded` | `true` when a live source **was** configured but the call failed, so the result fell back to a labeled estimate. The product never breaks; it degrades visibly. |
| `live` (on the search response) | `true` when the listing did not come from the `estimated:model` fallback. |

Line items produced by the true-cost engine reuse the same `certainty` vocabulary:
`listed` (quoted to you) · `typical` (market data) · `estimated` (heuristic), each with a
confidence contribution. Honesty about uncertainty is a feature, not a footnote.

**The fallback is deterministic.** When no live key is set, a query is hashed (FNV-1a) into a
stable value inside a per-vertical band, so the same query always yields the same labeled
estimate. This keeps the product fully usable and demoable offline without ever pretending a
made-up number is a real one.

Run `npm run build` at any time to print which sources are LIVE vs fallback and whether
billing is live or mock.

## Per-vertical sources

| Vertical | Live source (when configured) | Env vars | Query format | Fallback band (no key) |
|---|---|---|---|---|
| Ticket | Ticketmaster Discovery API (free consumer key) | `TICKETMASTER_API_KEY` | event/artist keywords, e.g. `taylor swift` | $35–$155 face |
| Flight | Amadeus Flight Offers Search (free test tier) | `AMADEUS_CLIENT_ID`, `AMADEUS_CLIENT_SECRET`, `AMADEUS_HOST` | two airport codes, e.g. `LAX-LAS` | $59–$289 base fare |
| Hotel | Amadeus Hotel Search (free test tier) | `AMADEUS_CLIENT_ID`, `AMADEUS_CLIENT_SECRET`, `AMADEUS_HOST` | a city or 3-letter code, e.g. `Las Vegas` | $89–$329 / night |
| Subscription | Dated dataset snapshot (ships in repo) | — (always on) | plan/service name, e.g. `netflix` | $4.99–$29.99 / mo |
| Retail | Optional generic feed you supply | `RETAIL_API_URL`, `RETAIL_API_KEY` | product keywords | $19.99–$499.99 |

Implementation lives in [`src/providers/`](../src/providers/); each provider exposes the same
`configured()` / `live()` / `fallback()` contract, and [`index.js`](../src/providers/index.js)
tries the live source when configured and falls back to the labeled estimate on any failure.

### Tickets — Ticketmaster Discovery API

`live()` queries `/discovery/v2/events.json` for the top 5 relevance-sorted events and picks
the first with a **USD price range**, using its `min` as the advertised lowest face value
(`source: live:ticketmaster`, `certainty: live`). If no matching event has a listed USD price
it raises a 404, which the registry turns into a labeled degraded estimate. The engine then
adds typical ticketing drip (service, facility, processing fees, tax) on top. Free key:
<https://developer.ticketmaster.com/>.

### Flights — Amadeus Flight Offers Search

The query is parsed into an origin/destination IATA pair; `live()` searches a one-way offer
~21 days out in USD. Amadeus returns both `base` fare and `grandTotal`, so **real government
taxes are passed through as a `listed` line** (`context.taxes_cents`), while ancillaries
(carry-on, seat selection) remain the engine's `typical` estimates — honest for the drip we
model. The validating airline's IATA code is mapped to an engine carrier profile (Spirit,
Frontier, typical LCC, typical legacy). `source: live:amadeus`, `certainty: live`.

### Hotels — Amadeus Hotel Search

A free-text city resolves to an Amadeus city code and one of the engine's market profiles
(Las Vegas, New York, Miami, Orlando, or a generic default). `live()` lists hotels by city,
then fetches best-rate offers for a 3-night stay ~21 days out and derives a **room-only
nightly rate**. Resort fees, occupancy taxes, and parking are the market-typical drip added
by the engine. `source: live:amadeus`, `certainty: live`.

> **Amadeus test vs production.** The default host is `https://test.api.amadeus.com`, whose
> free tier returns realistic but **sandbox** data — treat it as representative, not
> bookable. Set `AMADEUS_HOST=https://api.amadeus.com` with production credentials for real
> inventory. The OAuth token is cached and refreshed a minute before expiry.

### Subscriptions — dated dataset snapshot

Subscriptions are matched against a hand-maintained dataset of well-known consumer plans:
[`src/data/plans/subscriptions.json`](../src/data/plans/subscriptions.json). This is **real,
publicly-listed pricing at the snapshot date** — not live-scraped — so it is labeled
`source: dataset:plans`, `certainty: typical`, and the `sourceLabel` names the snapshot. The
honesty here is the engine revealing the true first-year cost of a teaser rate (e.g. a
12-month intro price that renews higher).

- **Current snapshot:** `2026-08`, 12 plans (Netflix, Disney+, Spotify, Max, YouTube
  Premium, NYT, WSJ, NordVPN, ExpressVPN, Planet Fitness, Peloton App, Adobe Photography),
  each with aliases for matching.
- **Disclaimer carried in the file:** "Prices are point-in-time and approximate. No
  affiliation with or endorsement by the listed services is implied."
- **To update:** edit the JSON, bump the `snapshot` string to the new `YYYY-MM`, and keep
  every amount in integer cents. A query that matches no catalogued plan degrades to a
  labeled generic estimate rather than guessing at a specific brand's price.

### Retail — bring your own feed

There is no universal, ToS-clean, free real-time retail price API, and PriceTruth will not
pretend otherwise. The retail provider returns a clearly-labeled example price by default and
exposes a pluggable slot: set `RETAIL_API_URL` (optionally `RETAIL_API_KEY`) to a feed that
answers `GET <url>?q=...` with JSON `{ name, url?, price_cents, currency?, shipping_cents?,
taxPct? }`. When wired, results are labeled `source: live:retail-feed`, `certainty: live`, and
the engine still reveals shipping/handling/tax on top — which is the whole point.

## Price history

Every `POST /api/search` upserts the listing as a tracked product and appends a **real price
point** (advertised + computed true cost, both integer cents) to SQLite. So history is
genuine and accrues over time from actual searches — distinct from the **seeded demo
products**, whose 90-day history is deterministic synthetic data, clearly flagged as demo in
the API (`demoData: true`). Deal-quality scores combine position-in-range, distance from the
average, and fee load; with too little history the score degrades gracefully rather than
inventing a trend.

## Boundaries & honesty notes

- Live provider responses are validated for an integer price and basic shape, but are
  otherwise trusted to be well-formed; PriceTruth does not independently re-verify a
  provider's number.
- Fallback bands are illustrative ranges, not market forecasts — they exist so the product is
  usable and demoable without keys, and they are always labeled `estimated`.
- No user query is ever used to construct a provider **host**; it is only ever sent as an
  encoded query parameter to a fixed, operator-configured endpoint (see
  [SECURITY.md](SECURITY.md)).
- Trademarks and service names in the subscription dataset are used nominatively to identify
  plans; no affiliation or endorsement is implied.
