# PriceTruth B2B API — v1 Reference

The PriceTruth API returns **true-cost breakdowns** (advertised price + every mandatory or
realistically-unavoidable fee), **price history**, and **deal-quality scores** as JSON. Every
projected number is honesty-labeled: line items carry a `certainty` field, and each report
carries `confidence` and `assumptions`.

> **Prototype notice.** This documents the API as implemented in `src/server.js`. The
> prototype serves plain HTTP on localhost and ships with clearly-labeled demo data.

## Base URL

```
http://localhost:4780
```

Start the server with `npm start` (the `PORT` environment variable overrides the port). All
v1 endpoints live under the `/api/v1/` path prefix. All requests and responses are JSON
(`Content-Type: application/json`).

## Authentication

Every v1 request must send an API key in the `X-API-Key` header:

```
X-API-Key: pt_starter_5f0pbZiUEfILdKezgjLl9G5pRZWo1oWn
```

- **Minting keys (prototype):** run `npm run keygen -- "Acme Travel" starter` (or `pro`) on
  the machine hosting the server. The raw key is printed **once** — store it immediately.
- Keys look like `pt_<tier>_<32 url-safe chars>` and are stored **only as a SHA-256 hash**;
  the server cannot recover a lost key and keys never appear in logs. Lost key = mint a new
  one.
- An optional HTTP minting route (`POST /api/admin/keys`, header `X-Admin-Token`) exists for
  operators, but it is disabled (403) unless the server was started with an `ADMIN_TOKEN`
  environment variable.
- A missing, malformed, or revoked key returns **401** on every v1 route.

## Tiers, quotas, and rate limits

| Tier | Price | Daily quota | Burst limit |
|---|---|---|---|
| `starter` | $49/mo | 100 requests/day | 30 requests/min per key |
| `pro` | $399/mo | 10,000 requests/day | 30 requests/min per key |

Metering semantics (exactly as enforced by the server):

- **Every authenticated v1 request counts against the daily quota** — including
  `GET /api/v1/usage`. There is no free "check my usage" call.
- Every successful v1 response includes a `usage` object; `used_today` **includes the
  request that returned it**.
- The daily counter is per **UTC calendar day** and resets at midnight UTC.
- Exceeding the daily quota returns **429** with
  `{"error": "daily quota exceeded for starter tier (100/day)"}` (no `Retry-After`; retry
  after the UTC day rolls over).
- The burst limiter is a token bucket (capacity 30, refilling at ~30/min, keyed per
  key + client IP). Exceeding it returns **429** with
  `{"error": "per-minute rate limit exceeded"}` and a `Retry-After` header (seconds).
- Prototype-only: the server's public per-IP limits also apply on top (GET burst ~120,
  POST burst ~20 with a slow refill from a single IP). Production would exempt keyed
  traffic from these.

## Conventions

> **All money is integer USD cents.** `advertised_cents: 21900` means $219.00. Every
> monetary field in every request and response is an integer number of cents
> (`0..1,000,000,000`). **Never use floating-point math on these values** — no
> `amount / 100 * 1.0825`, no float accumulation. Do arithmetic in integer cents and divide
> by 100 only when formatting for display. Sending a non-integer amount (e.g. `219.50`)
> returns 400.

- `currency` is always `"USD"` in v1.
- `certainty` on each line item is one of:
  - `"listed"` — the value was supplied in your request (seller/user quoted it),
  - `"typical"` — a market/carrier/platform typical from PriceTruth's fee datasets,
  - `"estimated"` — computed heuristically (e.g. a percentage tax).
- `confidence` (0.35–1.0) starts at 1.0 and is reduced by 0.08 per `typical` line and 0.12
  per `estimated` line. Treat sub-1.0 reports as projections, and say so in your UI.
- `feeLoadPct` is the hidden-cost percentage over the advertised price:
  `(truePrice − advertisedEquivalent) / advertisedEquivalent × 100`, rounded to one decimal.
  The advertised equivalent normalizes units where they differ: tickets use
  `advertised × quantity`, subscriptions use `advertised × 12` (a monthly teaser vs. a
  first-year true price); all other verticals use the advertised amount directly.

---

## POST /api/v1/analyze

Compute a true-cost report for one offer.

### Request body

| Field | Type | Required | Notes |
|---|---|---|---|
| `vertical` | string | yes | One of `hotel`, `flight`, `ticket`, `subscription`, `retail`. |
| `advertised_cents` | integer | yes | The advertised price in cents, `0..1e9`. |
| `context` | object | no | Vertical-specific detail (below). Its JSON serialization must be at most 4,096 characters. Anything you supply becomes a `listed` line; anything you omit is filled from typicals/estimates and labeled accordingly. |

Request bodies over 32 KB are rejected with 413. `context` keys per vertical (all optional;
all `*_cents` fields are integer cents):

- **hotel** — `market` (`las_vegas`, `new_york`, `miami`, `orlando`, `default`), `nights`
  (int 1–60, default 1), `resortFee_cents`, `tax_cents`, `taxPct` (number, e.g. `13.38`),
  `parking_cents`, `parking: false` to exclude parking.
- **flight** — `carrier` (`spirit`, `frontier`, `typical_lcc`, `typical_legacy`),
  `carryOn_cents`, `carryOn: false`, `checkedBags` (int 0–5) with `checkedBag_cents`,
  `seat_cents`, `seatSelection: false`, `channel: "ota"` with `bookingFee_cents`,
  `taxesIncluded: false` with `taxes_cents`, `travelers` (int 1–9).
- **ticket** — `platform` (`ticketmaster`, `stubhub`, `seatgeek`, `default`), `quantity`
  (int 1–20), `serviceFee_cents` or `serviceFeePct`, `facility_cents`,
  `orderProcessing_cents`, `tax_cents` or `taxPct`.
- **subscription** — `pattern` (`streaming`, `vpn`, `news`, `fitness`, `default`),
  `introMonths` (int 0–12), `renewal_cents`, `activation_cents`.
- **retail** — `shipping_cents`, `handling_cents`, `taxPct`.

Valid option ids for dropdowns are also served live by the public `GET /api/meta` endpoint.

### Response

`200` with a **Report** object (schema below) plus your `usage`.

### Example: hotel

A hotel advertising $219/night in Las Vegas, 3 nights, no fees supplied — PriceTruth fills
in the market-typical resort fee, estimated occupancy tax, and typical parking:

```
POST /api/v1/analyze
{"vertical": "hotel", "advertised_cents": 21900, "context": {"market": "las_vegas", "nights": 3}}
```

```json
{
  "vertical": "hotel",
  "currency": "USD",
  "advertised": { "amount_cents": 21900, "unit": "per_night" },
  "truePrice": { "amount_cents": 31732, "unit": "per_night" },
  "total": { "amount_cents": 95196, "label": "3-night stay total" },
  "lineItems": [
    { "code": "room", "label": "Room rate", "amount_cents": 21900,
      "kind": "base", "certainty": "listed" },
    { "code": "resort_fee", "label": "Resort fee", "amount_cents": 4500,
      "kind": "fee", "certainty": "typical",
      "note": "95% of Las Vegas, NV hotels charge one (typical $45/night)" },
    { "code": "taxes", "label": "Occupancy taxes (13.38%)", "amount_cents": 3532,
      "kind": "tax", "certainty": "estimated" },
    { "code": "parking", "label": "Parking", "amount_cents": 1800,
      "kind": "addon", "certainty": "typical",
      "note": "Typical for Las Vegas, NV; skip if you won't have a car" }
  ],
  "feeLoadPct": 44.9,
  "confidence": 0.72,
  "assumptions": [
    "Resort fee is the Las Vegas, NV typical; the hotel's actual fee may differ.",
    "Parking included at the market-typical rate; remove it if you are not driving."
  ],
  "disclosures": [
    "Mandatory fees must now be shown in the advertised price under the FTC junk-fee rule; many quotes still surface them only at checkout."
  ],
  "usage": { "used_today": 1, "daily_limit": 100, "tier": "starter" }
}
```

Reading it: the $219 room really costs **$317.32/night** ($951.96 for the stay) —
`feeLoadPct: 44.9` means 44.9% hidden cost on top of the sticker. `confidence: 0.72`
because two lines are `typical` and one is `estimated` (1.0 − 0.08 − 0.08 − 0.12). Supply
`resortFee_cents`, `tax_cents`, and `parking_cents` from a real quote and every line becomes
`listed` with `confidence: 1`.

### Example: subscription

A "$9.99/month" streaming plan with no renewal price supplied — PriceTruth applies the
streaming teaser pattern (3 intro months typical, renewal ~1.6× intro):

```
POST /api/v1/analyze
{"vertical": "subscription", "advertised_cents": 999, "context": {"pattern": "streaming"}}
```

```json
{
  "vertical": "subscription",
  "currency": "USD",
  "advertised": { "amount_cents": 999, "unit": "per_month" },
  "truePrice": { "amount_cents": 17379, "unit": "first_year" },
  "total": { "amount_cents": 17379, "label": "First-year cost" },
  "lineItems": [
    { "code": "intro", "label": "Intro price × 3 months", "amount_cents": 2997,
      "kind": "base", "certainty": "typical" },
    { "code": "renewal", "label": "Renewal price × 9 months", "amount_cents": 14382,
      "kind": "addon", "certainty": "estimated",
      "note": "Price rises to $15.98/month after 3 months" }
  ],
  "feeLoadPct": 45,
  "confidence": 0.8,
  "assumptions": [
    "Renewal price estimated at 1.6× the intro price (typical for streaming media)."
  ],
  "disclosures": [
    "Price rises to $15.98/month after 3 months.",
    "Effective cost is $14.48/month over the first year, not $9.99."
  ],
  "usage": { "used_today": 2, "daily_limit": 100, "tier": "starter" }
}
```

Note the unit shift: `advertised` is `per_month`, `truePrice` is `first_year` — the honest
comparison for teaser pricing. `feeLoadPct` here compares against `999 × 12`. With known
terms (`{"pattern": "streaming", "introMonths": 6, "renewal_cents": 1999}`) both lines
become `listed`, `truePrice` is exact (`17988` = $179.88 first year) and `confidence` is 1.

---

## GET /api/v1/products/:id

Fetch a tracked product: its current report, price-history statistics, deal-quality score,
and the raw history points. The window is fixed at the last **30 days** in v1.

The prototype ships five demo products (synthetic, deterministic history, labeled demo
data):

| id | vertical | Advertised → true |
|---|---|---|
| `vegas-hotel` | hotel | $219 → $317/night |
| `lcc-flight` | flight | $189 → $294 per fare |
| `arena-ticket` | ticket | $86 → $134 checkout |
| `stream-sub` | subscription | $9.99/mo → $179.88 first year |
| `anc-headphones` | retail | $299 (30-day low $219, high $319) |

### Response

`200` with `{product, report, stats, score, history, usage}`. Example for `vegas-hotel`
(**history truncated here to three points** — real responses return every point in the
window; timestamps are from the seeded demo data):

```json
{
  "product": {
    "id": "vegas-hotel",
    "vertical": "hotel",
    "name": "The Meridian Grand — Las Vegas Strip",
    "url": "https://example.com/hotels/meridian-grand"
  },
  "report": {
    "vertical": "hotel",
    "currency": "USD",
    "advertised": { "amount_cents": 21900, "unit": "per_night" },
    "truePrice": { "amount_cents": 31700, "unit": "per_night" },
    "total": { "amount_cents": 95100, "label": "3-night stay total" },
    "lineItems": [
      { "code": "room", "label": "Room rate", "amount_cents": 21900, "kind": "base", "certainty": "listed" },
      { "code": "resort_fee", "label": "Resort fee", "amount_cents": 4500, "kind": "fee", "certainty": "listed" },
      { "code": "taxes", "label": "Taxes", "amount_cents": 3800, "kind": "tax", "certainty": "listed" },
      { "code": "parking", "label": "Parking", "amount_cents": 1500, "kind": "addon", "certainty": "listed" }
    ],
    "feeLoadPct": 44.7,
    "confidence": 1,
    "assumptions": [],
    "disclosures": [
      "Mandatory fees must now be shown in the advertised price under the FTC junk-fee rule; many quotes still surface them only at checkout."
    ]
  },
  "stats": { "days": 30, "n": 30, "low_cents": 28760, "high_cents": 38937, "avg_cents": 32615 },
  "score": {
    "score": 56,
    "label": "fair deal",
    "reasons": [
      "Today is $29.40 above the window low of $287.60.",
      "Below the $326.15 average for this window.",
      "Hidden fees add 44.7% on top of the advertised price."
    ]
  },
  "history": [
    { "ts": "2026-07-23T19:05:33.422Z", "advertised_cents": 20728, "true_cents": 30004 },
    { "ts": "2026-07-24T19:05:33.422Z", "advertised_cents": 21384, "true_cents": 30953 },
    { "ts": "2026-08-21T19:05:33.423Z", "advertised_cents": 21900, "true_cents": 31700 }
  ],
  "usage": { "used_today": 3, "daily_limit": 100, "tier": "starter" }
}
```

- `stats` is `null` and `score.score` is `null` (label `"no history"`) when a product has no
  points in the window.
- The score is 0–100, computed **on true price**: up to 60 pts for where today sits in the
  window's low–high range, up to 20 pts vs. the window average, up to 20 pts for low fee
  load. Labels: ≥80 `great deal`, ≥60 `good deal`, ≥40 `fair deal`, else `poor deal`.
- Unknown ids return 404. Ids are lowercase slugs (`[a-z0-9-]`, max 64 chars).

---

## GET /api/v1/usage

Returns your current usage. **This call itself consumes one unit of quota**, and its count
is included in the response.

```json
{ "usage": { "used_today": 4, "daily_limit": 100, "tier": "starter" } }
```

---

## POST /api/v1/track

Append an observed price point to a tracked product's history. The server recomputes the
true price from the product's stored context — clients submit only what they observed
advertised, never a true price.

```json
{ "product_id": "anc-headphones", "advertised_cents": 25900 }
```

Response `201`:

```json
{ "tracked": true, "true_cents": 25900, "usage": { "used_today": 5, "daily_limit": 100, "tier": "starter" } }
```

Points outside a **0.25×–4× plausibility band** around the product's reference price are
rejected with `422 {"error": "price point rejected: outside the plausible band for this product"}`
and are not stored — this is the history-poisoning guard; scores and stats stay trustworthy.

---

## Public app endpoints (no key)

These are the same-origin endpoints the web app (and browser extension) call directly — **no
API key required**. They are **rate-limited per IP** (a token bucket, ~20 POST burst / ~120
GET burst from a single IP with a slow refill), and are meant for the app itself, not for
third-party integrations — use the keyed `/api/v1/` endpoints for that. All money is integer
USD cents, as everywhere in this doc.

> **Honesty labeling.** `POST /api/search` never presents an estimate as a live quote: every
> listing carries `source`, `sourceLabel`, `certainty`, and `degraded` so the caller always
> knows whether a price came from a live source or a clearly-labeled fallback. Billing
> responses carry `mock`/`mode` so a simulated checkout is never shown as a real charge.

### POST /api/search

Look up a listing through the provider layer, run it through the true-cost engine, upsert it
as a tracked product, and append a real price point — so history accrues across repeat
searches for the same listing. When a live source is configured for the vertical it is used;
otherwise the response falls back to a deterministic, clearly-labeled **estimate**.

#### Request body

| Field | Type | Required | Notes |
|---|---|---|---|
| `vertical` | string | yes | One of `hotel`, `flight`, `ticket`, `subscription`, `retail`. |
| `q` | string | yes | The search query, **2–120 characters** (trimmed). |

#### Response

`200` with the listing, its report, price-history stats, and a deal-quality score:

```json
{
  "product_id": "s-ticket-eagles-madison-square-garden-1a2b3c4d",
  "listing": {
    "vertical": "ticket",
    "name": "Eagles — Madison Square Garden",
    "url": null,
    "advertised_cents": 8600,
    "currency": "USD",
    "context": { "platform": "ticketmaster", "quantity": 2 },
    "source": "estimated:model",
    "sourceLabel": "Estimated",
    "certainty": "estimated",
    "degraded": false,
    "fetchedAt": "2026-08-24T17:03:11.208Z"
  },
  "report": { "…": "the standard Report object — vertical, advertised, truePrice, lineItems, feeLoadPct, confidence, assumptions, disclosures" },
  "stats": { "days": 90, "n": 1, "low_cents": 13400, "high_cents": 13400, "avg_cents": 13400 },
  "score": { "score": 41, "label": "fair deal", "reasons": ["…"] },
  "live": false
}
```

(The concrete numbers above are illustrative — the exact figures depend on whether a live
source answered or the labeled estimate was used, and on the query.)

Field notes:

- `product_id` is a deterministic slug `s-<vertical>-<slug>-<8 hex chars>`, derived from the
  vertical, listing name, and query. The same search maps to the same product, so repeated
  searches accrue into one history (window fixed at **90 days** here).
- `listing.source` is the machine tag for where the price came from — e.g. `live:amadeus`
  (hotel/flight), `live:ticketmaster` (ticket), `live:retail-feed` (retail), `dataset:plans`
  (subscription), or `estimated:model` (labeled fallback). `sourceLabel` is the
  human-readable version.
- `listing.certainty` is the listing-level provenance: `live` (real-time source), `typical`
  (dated catalog/dataset), or `estimated` (labeled fallback). This is distinct from the
  per-line-item `certainty` **inside** `report`, which uses the report vocabulary
  `listed`/`typical`/`estimated` (see [The Report object](#the-report-object)).
- `listing.degraded` is `true` **only** when a live source was configured but the lookup
  failed and the response fell back to a labeled estimate — the price is an estimate, not a
  live quote. When no live source is configured at all, the fallback is used with
  `degraded: false`.
- `live` is `true` when the listing came from a live source (i.e. `source` does **not** start
  with `estimated`), and `false` for a labeled estimate. Together with `certainty` and
  `degraded`, this tells the caller whether they are holding a live quote or a labeled
  estimate.
- **Subscription is a special case:** it is always answered from a dated catalog snapshot
  shipped in the repo. A matched plan returns `source: "dataset:plans"`,
  `certainty: "typical"`, `live: true` — it is "live" in the *status* sense but is
  **point-in-time catalog pricing, not a real-time quote**, so verify current pricing before
  relying on it. A query that matches no catalogued plan degrades to a labeled
  `estimated:model` example (`certainty: "estimated"`, `degraded: true`, `live: false`).
- `stats` is the 90-day price-history summary (`{days: 90, n, low_cents, high_cents,
  avg_cents}`), or `null` when there is no history; `score` is the deal-quality object (same
  shape and 0–100 scale as `GET /api/v1/products/:id`).

Errors: `400` for an unknown `vertical`, or a `q` outside 2–120 characters.

curl:

```sh
curl -s http://localhost:4780/api/search \
  -H "Content-Type: application/json" \
  -d '{"vertical":"ticket","q":"eagles madison square garden"}'
```

### POST /api/billing/checkout

Start a checkout for one plan and get a URL to redirect the browser to.

#### Request body

| Field | Type | Required | Notes |
|---|---|---|---|
| `planId` | string | yes | One of `premium` (consumer), `api_starter`, `api_pro` (API tiers). |
| `email` | string | no | Prefills the buyer's email on the checkout. |

#### Response

`200`:

```json
{ "url": "https://checkout.stripe.com/c/pay/cs_live_…", "mock": false, "mode": "live" }
```

- In **live mode** (a `STRIPE_SECRET_KEY` is set) `url` is a real Stripe Checkout Session
  URL, `mock` is `false`, and `mode` is `"live"`.
- In **mock mode** (no `STRIPE_SECRET_KEY`) `url` points at the app's own
  `/billing/mock-checkout` simulation page, `mock` is `true`, and `mode` is `"mock"`. The
  mock flow exercises the whole checkout → entitlement/key path locally without charging
  anything, and is clearly labeled as a simulation.

Errors: `400` for an unknown `planId` or an invalid `email`.

### GET /api/billing/claim?session_id=&lt;id&gt;

After an **API-plan** checkout (`api_starter` / `api_pro`) completes, the newly-minted API
key is staged for exactly **one** reveal on the buyer's success page. This endpoint returns
it once.

#### Response

`200`:

```json
{ "key": "pt_starter_5f0pbZiUEfILdKezgjLl9G5pRZWo1oWn", "tier": "starter", "note": "shown once; store it now" }
```

- The key is shown **once** — a second `claim` for the same `session_id` returns `404`.
- Consumer (`premium`) checkouts mint no API key, so `claim` returns `404` for them.
- `400` if `session_id` is missing or malformed (it must match `[A-Za-z0-9_]{6,200}`).

As with `npm run keygen`, only a hash of the key is stored server-side; once claimed (or once
its short TTL lapses unclaimed) it cannot be retrieved again.

### POST /api/billing/portal

Return a URL where a customer can self-serve manage or cancel their subscription.

#### Request body

`{ "email": "buyer@example.com" }`

#### Response

`200`:

```json
{ "url": "https://billing.stripe.com/p/session/…", "mock": false }
```

- **Live mode:** a real Stripe billing-portal URL for the account's Stripe customer. Returns
  `404` if no billing account exists for that email.
- **Mock mode:** `url` points at the app's `/billing/mock-portal` simulation page, with
  `mock: true` (no live account required).
- `400` for an invalid `email`.

### POST /api/billing/webhook

Stripe webhook receiver — **called by Stripe, not by app users.** It verifies the
`Stripe-Signature` header with HMAC-SHA256 against `STRIPE_WEBHOOK_SECRET` (scheme
`t=<ts>,v1=<hmac>`, constant-time compare, 300-second timestamp tolerance). On a valid
`checkout.session.completed` it records a replay-safe billing event (a `UNIQUE` Stripe
reference means a retried event is counted once) and then either:

- grants the **premium** plan to the buyer's account (consumer plan), or
- mints and stages an **API key** for one-time claim (API plans).

#### Response

`200` `{ "received": true, … }` (the `…` summarizes what was applied). Returns `400` on a
bad, missing, or stale signature.

This endpoint is intentionally **exempt from rate limiting** — Stripe retries with backoff,
and its signature check is the gate.

### GET /api/admin/metrics

Owner-only operational metrics: revenue, usage, and per-vertical provider status. Requires an
`X-Admin-Token` header matching the `ADMIN_TOKEN` environment variable (constant-time
compare).

```
X-Admin-Token: <your ADMIN_TOKEN>
```

Returns `403` when `ADMIN_TOKEN` is unset on the server or the supplied token does not match.

#### Response

`200`:

```json
{
  "billing": {
    "mode": "mock",
    "gross_cents": 5300,
    "paid_events": 3,
    "last_30d_cents": 5300,
    "last_7d_cents": 4900,
    "recent": [ { "…": "most-recent billing events" } ],
    "active_plans": [ { "…": "plan → active-account counts" } ]
  },
  "usage": {
    "keys_by_tier": [ { "…": "tier → API-key counts" } ],
    "api_calls_today": 12,
    "api_calls_7d": 87,
    "alerts": 4,
    "products": 9,
    "price_points": 214
  },
  "providers": {
    "hotel": { "live": false },
    "flight": { "live": false },
    "ticket": { "live": false },
    "subscription": { "live": true },
    "retail": { "live": false }
  },
  "generatedAt": "2026-08-24T17:03:11.208Z"
}
```

- `billing.mode` is `"live"` or `"mock"` — the same live-vs-mock distinction as the checkout
  endpoints. **All money is integer cents.**
- `providers` reports, per vertical, whether a live source is wired up right now
  (`{"live": boolean}`); no secrets are exposed. `subscription` is always `live: true`
  because it is backed by the shipped dataset snapshot (point-in-time catalog data, not a
  real-time quote).

---

## The Report object

| Field | Type | Meaning |
|---|---|---|
| `vertical` | string | `hotel` \| `flight` \| `ticket` \| `subscription` \| `retail` |
| `currency` | string | Always `"USD"` |
| `advertised` | `{amount_cents, unit}` | The sticker price. Unit: `per_night` \| `per_fare` \| `per_ticket` \| `per_month` \| `total` |
| `truePrice` | `{amount_cents, unit}` | Advertised + all mandatory/likely costs. Unit: `per_night` \| `per_fare` \| `checkout_total` \| `first_year` \| `total` |
| `total` | `{amount_cents, label}` or `null` | Multi-unit rollup, e.g. `"3-night stay total"`, `"First-year cost"` |
| `lineItems` | array | `{code, label, amount_cents, kind, certainty, note?}`; `kind`: `base` \| `fee` \| `tax` \| `addon`; `certainty`: `listed` \| `typical` \| `estimated` |
| `feeLoadPct` | number | Hidden-cost % over the advertised equivalent (one decimal) |
| `confidence` | number | 0.35–1.0; see Conventions |
| `assumptions` | string[] | Every assumption the engine made — show these to end users |
| `disclosures` | string[] | Regulatory/consumer context for this vertical |

## Errors

Errors are JSON: `{"error": "<message>"}`. Messages are human-readable and safe to log.

| Status | When | Example body |
|---|---|---|
| 400 | Invalid JSON, wrong types, unknown enum values, non-integer cents, oversized/invalid `context` | `{"error": "vertical must be one of: hotel, flight, ticket, subscription, retail"}` or `{"error": "advertised_cents must be integer cents (0..1e9)"}` |
| 401 | Missing, malformed, or revoked `X-API-Key` | `{"error": "missing or invalid X-API-Key"}` |
| 404 | Unknown product id or unknown v1 route | `{"error": "unknown product"}` |
| 422 | Track point outside the plausibility band | `{"error": "price point rejected: outside the plausible band for this product"}` |
| 413 | Request body over 32 KB | `{"error": "body exceeds 32768 bytes"}` — the server also closes the connection immediately, so some HTTP clients surface this as a connection reset instead of a readable body |
| 429 | Per-minute burst exceeded (has `Retry-After` header) or daily quota exhausted (no `Retry-After`) | `{"error": "per-minute rate limit exceeded"}` / `{"error": "daily quota exceeded for starter tier (100/day)"}` |

On 429 with `Retry-After`, wait the indicated seconds and retry. On daily-quota 429, back
off until the next UTC day or upgrade tiers.

## Quick start

curl:

```sh
curl -s http://localhost:4780/api/v1/analyze \
  -H "Content-Type: application/json" \
  -H "X-API-Key: pt_starter_YOUR_KEY_HERE" \
  -d '{"vertical":"hotel","advertised_cents":21900,"context":{"market":"las_vegas","nights":3}}'
```

PowerShell:

```powershell
$body = @{
  vertical         = 'subscription'
  advertised_cents = 999
  context          = @{ pattern = 'streaming' }
} | ConvertTo-Json
Invoke-RestMethod -Uri 'http://localhost:4780/api/v1/analyze' -Method Post `
  -Headers @{ 'X-API-Key' = 'pt_starter_YOUR_KEY_HERE' } `
  -ContentType 'application/json' -Body $body
```

## Versioning

- All v1 endpoints are namespaced under `/api/v1/`. Within v1, changes are **additive
  only**: new optional request fields, new response fields, new enum values in `lineItems`
  codes/labels. Build clients that ignore unknown fields.
- The existing fields documented here — names, types, units, and integer-cents semantics —
  will not change meaning within v1.
- Breaking changes ship as `/api/v2/` with both versions running side by side and a
  published migration window.

## Changelog

- **2026-08-24** — Added public same-origin endpoints (no API key, IP rate-limited):
  `POST /api/search` (live-or-labeled-estimate listing lookup → true-cost report → price-point
  ingestion) and Stripe-backed billing — `POST /api/billing/checkout`, `GET /api/billing/claim`,
  `POST /api/billing/portal`, `POST /api/billing/webhook` — plus owner-only
  `GET /api/admin/metrics`. Billing runs live with Stripe keys or in a clearly-labeled mock
  mode; the webhook is exempt from rate limiting.
- **v1 — 2026-08-21** — Initial release: `POST /api/v1/analyze` (five verticals),
  `GET /api/v1/products/:id` (30-day stats, score, history), `GET /api/v1/usage`,
  `POST /api/v1/track` (plausibility-banded price-point ingestion); API-key auth
  (SHA-256 at rest), starter/pro daily quotas, 30/min burst limit.
