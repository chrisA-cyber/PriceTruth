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
| `source` | Machine tag: `live:<provider>` or `dataset:plans` for successful search results. |
| `sourceLabel` | Human-readable description of exactly what the number is. |
| `certainty` | `live` (a current verified provider result) or `catalog` (a verified, dated snapshot). |
| `degraded` | `false` on successful verified results. Source failures return a stable error and no price. |
| `live` (on the search response) | `true` only for a current observed provider result; dated catalog rows return `false`. |

Line items produced by the true-cost engine use this `certainty` vocabulary:
`listed` (quoted to you) · `catalog` (dated verified snapshot) · `typical` (market data) · `estimated` (heuristic), each with a
confidence contribution. Honesty about uncertainty is a feature, not a footnote.

**Verified search fails closed.** When a provider is not configured, is unavailable, is at
capacity, or has no verified match, `/api/search` returns a stable error code and no listing or
report. The UI keeps the product useful by carrying the query into the manual analyzer, where
the shopper supplies the advertised price. Internal deterministic models exist only for
explicitly labeled illustrative fixtures and do not answer shopper searches.

Run `npm run build` at any time to print which sources are LIVE, dated catalog, or manual-only and whether
billing is live or mock.

## Per-vertical sources

| Vertical | Verified source (when configured) | Env vars | Query format | Without source/no match |
|---|---|---|---|---|
| Ticket | Ticketmaster Discovery API (only after all-in attestation is available) | `TICKETMASTER_API_KEY` | event/artist keywords, e.g. `taylor swift` | Fail closed; manual price input |
| Flight | Amadeus Flight Offers Search (production only) | `AMADEUS_CLIENT_ID`, `AMADEUS_CLIENT_SECRET`, `AMADEUS_HOST` | two airport codes, e.g. `LAX-LAS` | Fail closed; manual price input |
| Hotel | Amadeus Hotel Search (production only) | `AMADEUS_CLIENT_ID`, `AMADEUS_CLIENT_SECRET`, `AMADEUS_HOST` | a city or 3-letter code, e.g. `Las Vegas` | Fail closed; manual price input |
| Subscription | Dated dataset snapshot (ships in repo) | — (always on) | plan/service name, e.g. `netflix` | No-match error; manual price input |
| Retail | Optional generic feed you supply | `RETAIL_API_URL`, `RETAIL_API_KEY` | product keywords | Fail closed; manual price input |

Implementation lives in [`src/providers/`](../src/providers/); each provider exposes the same
`configured()` / `live()` provider contract, and [`index.js`](../src/providers/index.js)
normalizes verified results while translating unavailable, no-match, capacity, and upstream
failure states into safe public errors.

### Tickets — Ticketmaster Discovery API

Ticketmaster Discovery price ranges do not currently attest that mandatory fees are included,
so credentials alone do not make this source truth-usable and live Ticketmaster search stays
fail-closed. A future live result must be USD-denominated and explicitly attest all-inclusive
pricing before PriceTruth can label it as a live quote. Current U.S. ticket inputs are otherwise
treated as mandatory-fee-inclusive; PriceTruth does not invent service, facility, or processing
fees. Explicitly excluded taxes can still be supplied separately. Provider reference:
<https://developer.ticketmaster.com/>.

### Flights — Amadeus Flight Offers Search

The query must be exactly two standalone uppercase IATA codes (for example `LAX-LAS` or
`SFO to JFK`); natural-language city names fail closed rather than being split into bogus
three-letter chunks. `live()` searches a one-way USD offer for one adult, with connections
allowed, departing 21 days from the lookup. The exact generated departure date and traveler
assumptions are persisted in `context` and repeated in the source label. PriceTruth preserves
Amadeus's seller-listed `grandTotal` as the advertised fare, treats required taxes as included,
and selects no optional carry-on, checked bag, seat, or booking-site add-on. A shopper can add
an optional extra only when they choose it or provide an explicit amount. The validating
airline's IATA code supplies comparison context without changing the live total.
`source: live:amadeus`, `certainty: live`.

### Hotels — Amadeus Hotel Search

An exact normalized city alias or a standalone three-letter code resolves to an Amadeus city
code and one of the engine's market profiles (Las Vegas, New York, Miami, Orlando, or a generic
default). Substring matches are prohibited, so names such as Dallas and Glasgow cannot silently
resolve to LAS. `live()` lists hotels by city, then fetches best-rate offers for one adult in
one room for a three-night stay beginning 21 days from the lookup. The exact check-in,
check-out, adult, and room assumptions are persisted in `context` and repeated in the source
label. PriceTruth preserves the quoted full-stay total, displays a rounded nightly average for
comparison, and treats reported mandatory taxes and fees as included. It never infers resort
fees, parking, or other optional extras onto that current U.S. seller total.
`source: live:amadeus`, `certainty: live`.

> **Production truth boundary.** Amadeus's test host returns realistic but non-bookable
> sandbox inventory. PriceTruth therefore never treats test credentials or
> `https://test.api.amadeus.com` as a configured public source. Flight and hotel search are
> enabled only when both production credentials are present and `AMADEUS_HOST` is exactly the
> origin-only `https://api.amadeus.com` (an optional trailing slash is accepted; paths,
> queries, ports, credentials, and lookalike hosts are rejected). Sandbox contract checks
> belong in isolated test tooling and cannot create public `live:amadeus` provenance. The
> production OAuth token is cached and refreshed a minute before expiry.

### Subscriptions — dated dataset snapshot

Subscriptions are matched against a hand-maintained dataset of well-known consumer plans:
[`src/data/plans/subscriptions.json`](../src/data/plans/subscriptions.json). This is **real,
publicly-listed pricing at the snapshot date** — not live-scraped — so it is labeled
`source: dataset:plans`, `certainty: catalog`, and the `sourceLabel` names the snapshot. The
engine uses each row's explicit cadence and never invents a renewal increase for an ordinary
monthly plan.

- **Current launch snapshot:** `2026-08`, four US plans with per-row first-party URL,
  region, and as-of date: Netflix Standard, Disney+ Premium, Spotify Premium Individual's
  recurring price (temporary eligibility offers excluded), and Adobe Photography 1TB.
- **Freshness gate:** every row must have valid pricing/provenance, a public HTTPS first-party
  URL, a non-future as-of date in the declared snapshot month, and a unique slug. The oldest
  verified row controls catalog age. `SUBSCRIPTION_CATALOG_MAX_AGE_DAYS` is an integer from
  1–365 and defaults to 93 days; an invalid setting or expired row makes the source
  `truthUsable: false`, fails paid launch readiness, removes it from paid search metadata,
  and suppresses subscription alert evaluation and digest entries. Local/demo search still
  returns the dated result with `stale: true` so development remains usable without making a
  current-price claim.
- **Excluded until re-verified or modeled exactly:** Max, YouTube Premium, NYT, WSJ,
  NordVPN, ExpressVPN, Planet Fitness, and Peloton. Multi-year renewal totals and
  eligibility-limited promotions are not flattened into misleading monthly renewal prices.
- **Disclaimer carried in the file:** "Prices are point-in-time and approximate. No
  affiliation with or endorsement by the listed services is implied."
- **To update:** verify every public price and term against its linked first-party page,
  update each row's `asOf`, edit any changed amount/term, and bump `snapshot` to the matching
  `YYYY-MM`. Run the focused provider and launch-gate tests before promotion. Merely changing
  the month label cannot refresh old rows. A query that matches no catalogued plan returns
  `NO_VERIFIED_RESULT` rather than guessing at a specific brand's price.

### Retail — bring your own feed

There is no universal, ToS-clean, free continuously updated retail price feed, and PriceTruth will not
pretend otherwise. Retail search therefore fails closed by default and exposes a pluggable
slot: set `RETAIL_API_URL` (optionally `RETAIL_API_KEY`) to a feed that
answers `GET <url>?q=...` with JSON `{ name, url?, price_cents, currency?, shipping_cents?,
taxPct? }`. When wired, results are labeled `source: live:retail-feed`, `certainty: live`, and
the engine still reveals shipping/handling/tax on top — which is the whole point.

## Price history

Signed-in `POST /api/search` can persist a private product and append a price point when the
source has the required stable identity. Anonymous searches are one-time reports and do not
create a stable report URL. Seeded demonstration products carry explicit demo provenance and
synthetic history; verified catalog snapshots are classified as `dataKind: dataset` with
`demoData: false`, while provider observations are classified as observed. In other words,
`demoData` follows the record's explicit provenance rather than being applied to every product
read. Deal-quality scores combine position-in-range, distance from the average, and fee load;
with too little history the score degrades gracefully rather than inventing a trend.

## Boundaries & honesty notes

- Live provider responses are validated for an integer price and basic shape, but are
  otherwise trusted to be well-formed; PriceTruth does not independently re-verify a
  provider's number.
- Internal model bands are illustrative fixtures, not market forecasts, and never answer
  shopper search requests. Manual analysis starts from a price the shopper actually saw.
- No user query is ever used to construct a provider **host**; it is only ever sent as an
  encoded query parameter to a fixed, operator-configured endpoint (see
  [SECURITY.md](SECURITY.md)).
- Trademarks and service names in the subscription dataset are used nominatively to identify
  plans; no affiliation or endorsement is implied.
