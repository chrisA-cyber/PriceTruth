# PriceTruth B2B API — v1 Reference

The PriceTruth API returns **true-cost breakdowns** (advertised price + every mandatory or
realistically-unavoidable fee), **price history**, and **deal-quality scores** as JSON. Every
projected number is honesty-labeled: line items carry a `certainty` field, and each report
carries `confidence` and `assumptions`.

The machine-readable contract for every public, account, webhook, operator, and
B2B route is available at `GET /api/openapi` and in `openapi/openapi.json`.
This document focuses on the stable B2B v1 surface.

## Base URL

```
http://localhost:4780
```

Start the server with `npm start` (the `PORT` environment variable overrides the port).
Production clients use the HTTPS `PUBLIC_BASE_URL` supplied by the operator. All v1
endpoints live under `/api/v1/` and use JSON.

## Authentication

Every v1 request must send an API key in the `X-API-Key` header:

```
X-API-Key: pt_starter_5f0pbZiUEfILdKezgjLl9G5pRZWo1oWn
```

- **Customer key lifecycle:** an authenticated API subscriber creates, lists,
  rotates, and revokes keys under `/api/account/api-keys`. The raw key is shown
  **once**—store it immediately. Rotation atomically revokes the prior key.
- **Operator recovery:** run `npm run keygen -- "label" starter|pro` on the host,
  or use the protected admin route. Customer self-service is preferred because
  it preserves account ownership and an auditable lifecycle.
- Keys look like `pt_<tier>_<32 url-safe chars>` and are stored **only as a SHA-256 hash**;
  the server cannot recover a lost key and keys never appear in logs. Lost key =
  rotate or mint a replacement and revoke the old record.
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
- Public per-IP limits also apply as an abuse-control layer.
- Limited responses expose `RateLimit-Limit`, `RateLimit-Remaining`, and
  `RateLimit-Reset`, plus `X-RateLimit-*` compatibility fields. B2B responses
  also expose `X-DailyLimit-Limit` and `X-DailyLimit-Remaining`.

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
  - `"catalog"` — the value came from an approved, dated source snapshot,
  - `"typical"` — a market/carrier/platform typical from PriceTruth's fee datasets,
  - `"estimated"` — computed heuristically (e.g. a percentage tax).
- `confidence` (0.35–1.0) starts at 1.0 and is reduced by 0.04 per `catalog` line,
  0.08 per `typical` line, 0.12 per `estimated` line, and 0.15 per unknown cost
  (capped at a 0.45 unknown-cost penalty). Treat sub-1.0 reports as uncertain and
  show that uncertainty in your UI.
- `completeness.status` is `"complete"` only when no mandatory or conditional
  checkout cost is missing. When it is `"partial"`, `truePrice` is a **known priced
  subtotal**, not a guaranteed checkout total; show every entry in
  `completeness.unknownCosts` instead of treating it as $0.
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
| `context` | object | no | Vertical-specific detail (below). Its JSON serialization must be at most 4,096 characters. Supplied amounts become `listed` lines. Missing mandatory inputs remain explicit unknown costs unless a documented, evidence-backed estimation path applies. |

Request bodies over 32 KB are rejected with 413. `context` keys per vertical (all optional;
all `*_cents` fields are integer cents):

- **hotel** — `market` (`las_vegas`, `new_york`, `miami`, `orlando`, `default`), `nights`
  (int 1–60, default 1), `mandatoryFeesIncluded: true` when explicitly attested,
  `resortFee_cents`, `taxesIncluded: true`, `tax_cents`, `taxPct` (number, e.g. `13.38`),
  `parking_cents`, or `parking: false` to leave optional parking unselected. A claim that
  fees are separately excluded must include `mandatoryFeesIncluded: false`, an allowed
  `priceBasis` (`room_only`, `pre_rule`, or `non_us`), and non-empty `feeEvidence`.
- **flight** — `carrier` (`spirit`, `frontier`, `typical_lcc`, `typical_legacy`),
  `carryOn_cents`, `carryOn: false`, `checkedBags` (int 0–5) with `checkedBag_cents`,
  `seat_cents`, `seatSelection: false`, `channel: "ota"` with `bookingFee_cents`,
  `taxesIncluded: true` when explicitly attested, or `taxes_cents`; `travelers` (int 1–9).
  A percentage-based excluded-tax estimate requires `taxesIncluded: false`, an allowed
  `priceBasis` (`base_fare`, `pre_rule`, or `non_us`), and non-empty `feeEvidence`.
- **ticket** — `platform` (`ticketmaster`, `stubhub`, `seatgeek`, `default`), `quantity`
  (int 1–20), `serviceFee_cents` or `serviceFeePct`, `facility_cents`,
  `orderProcessing_cents`, `taxesIncluded: true`, `tax_cents`, or `taxPct`.
  Modeling separately excluded mandatory ticket fees requires `allInclusivePricing: false`,
  an allowed `priceBasis` (`face_value`, `pre_rule`, or `non_us`), and non-empty `feeEvidence`.
- **subscription** — `pattern` (`streaming`, `vpn`, `news`, `fitness`, `default`),
  `introMonths` (int 0–12), `renewal_cents`, `activation_cents`.
- **retail** — `shipping_cents`, `handling_cents` (use integer `0` when the seller
  explicitly quotes none), `handlingIncluded: true` or `mandatoryExtrasIncluded: true`
  when explicitly attested, and `taxPct` (use `0` only for a known exempt checkout).

Valid option ids for dropdowns are also served live by the public `GET /api/meta` endpoint.

### Response

`200` with a **Report** object (schema below) plus your `usage`.

### Example: hotel

A hotel displays $219/night for a three-night stay, but the caller has no seller
attestation about mandatory lodging fees or taxes. PriceTruth preserves the known
room subtotal and names the two evidence gaps; it does not silently guess them as $0:

```
POST /api/v1/analyze
{"vertical": "hotel", "advertised_cents": 21900, "context": {"market": "las_vegas", "nights": 3}}
```

```json
{
  "vertical": "hotel",
  "currency": "USD",
  "advertised": { "amount_cents": 21900, "unit": "per_night" },
  "truePrice": { "amount_cents": 21900, "unit": "per_night" },
  "total": { "amount_cents": 65700, "label": "3-night known subtotal" },
  "lineItems": [
    { "code": "room", "label": "Room rate", "amount_cents": 21900,
      "kind": "base", "certainty": "listed" }
  ],
  "feeLoadPct": 0,
  "confidence": 0.7,
  "completeness": {
    "status": "partial",
    "unknownCosts": [
      {
        "code": "mandatory-hotel-fees",
        "label": "Mandatory hotel fees",
        "reason": "The source did not attest whether resort, destination, or other mandatory lodging fees are included."
      },
      {
        "code": "hotel-taxes",
        "label": "Hotel taxes",
        "reason": "The source did not attest that lodging taxes are included or provide an excluded tax amount."
      }
    ]
  },
  "assumptions": [
    "Mandatory lodging-fee inclusion is unknown; confirm the displayed price with the seller.",
    "Lodging taxes are unknown; confirm the checkout jurisdiction and seller total."
  ],
  "disclosures": [],
  "priceInclusion": {
    "mandatoryFeesIncluded": null,
    "taxesIncluded": null,
    "basis": "unknown",
    "evidence": null
  },
  "usage": { "used_today": 1, "daily_limit": 100, "tier": "starter" }
}
```

Reading it: $657 is the three-night **known subtotal**, not a checkout promise.
`feeLoadPct: 0` means no evidenced cost was added; it does not mean there are no other
costs. Supply exact excluded amounts or explicit inclusion attestations from the seller to
resolve the unknown-cost list. Optional parking is added only when the shopper selects it.

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
  "completeness": { "status": "complete", "unknownCosts": [] },
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

Local demo mode ships five synthetic products with deterministic history and
explicit demo labels:

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
      "Added costs add 44.7% on top of the advertised price."
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

Append an observed price point to canonical history. This route requires an
operator-issued API key with the `can_write_history` ingestion scope; ordinary
customer subscription keys are deliberately read/analyze-only and receive
`403`. The server recomputes true price from stored context—trusted ingestion
clients submit only the observed advertised amount, never a claimed true price.

```json
{ "product_id": "anc-headphones", "advertised_cents": 25900 }
```

Response `201`:

```json
{ "tracked": true, "true_cents": 25900, "usage": { "used_today": 5, "daily_limit": 100, "tier": "starter" } }
```

Points outside a **0.25×–4× plausibility band** around the product's reference price are
rejected with `422 {"error": "price point rejected: outside the plausible band for this product"}`
and are not stored. Accepted observations are still non-idempotent: do not retry
after an ambiguous network failure without first reconciling the intended point.

---

## Public app endpoints (no key)

These are the same-origin endpoints the web app calls directly—**no API key
required**. The packaged browser extension calculates locally and does not call
them automatically. The endpoints are **rate-limited per IP** (a token bucket, ~20 POST burst / ~120
GET burst from a single IP with a slow refill), and are meant for the app itself, not for
third-party integrations — use the keyed `/api/v1/` endpoints for that. All money is integer
USD cents, as everywhere in this doc.

> **Honesty labeling.** `POST /api/search` returns only a verified provider quote or a dated,
> verified catalog row. If neither is available, it returns a stable error code and no price;
> callers should offer manual advertised-price input. Successful listings carry `source`,
> `sourceLabel`, `certainty`, and provenance. Billing
> responses carry `mock`/`mode` so a simulated checkout is never shown as a real charge.

The legacy unauthenticated `POST /api/alerts` compatibility flow exists only in
local development. Production returns `410`; customers must sign in and use
account-owned watchlists/alerts so consent, ownership, limits, and deletion are
enforced together.

### POST /api/search

Look up a listing through the provider layer and run it through the true-cost
engine. Anonymous searches are ephemeral and return `product_id: null`,
`persisted: false`, `stats: null`; they never publish the query or alter shared
history. A signed-in search is stored as an account-private product and accrues
private history when the result has a stable provider identity. If a verified source is
unconfigured, unavailable, at capacity, or has no match, the endpoint fails closed and does
not return `listing`, `report`, or any substitute price.

#### Request body

| Field | Type | Required | Notes |
|---|---|---|---|
| `vertical` | string | yes | One of `hotel`, `flight`, `ticket`, `subscription`, `retail`. |
| `q` | string | yes | The search query, **2–120 characters** (trimmed). |

#### Response

`200` with the verified listing, its report, price-history stats, and a deal-quality score.
For example, a matched dated subscription catalog row returns:

```json
{
  "product_id": null,
  "persisted": false,
  "listing": {
    "vertical": "subscription",
    "name": "Netflix Standard",
    "url": null,
    "advertised_cents": 1999,
    "currency": "USD",
    "context": { "pricingMode": "stable_monthly", "termMonths": 12 },
    "source": "dataset:plans",
    "sourceLabel": "Verified subscription catalog snapshot",
    "certainty": "catalog",
    "degraded": false,
    "fetchedAt": "2026-08-25T00:00:00.000Z"
  },
  "report": { "…": "the standard Report object — vertical, advertised, truePrice, lineItems, feeLoadPct, confidence, completeness, assumptions, disclosures" },
  "stats": null,
  "score": { "score": null, "label": "not enough verified history", "reasons": ["…"] },
  "live": false
}
```

(The response shape is abbreviated; the current OpenAPI document is authoritative.)

Field notes:

- `product_id` is `null` for anonymous requests. Signed-in requests receive an
  account-namespaced deterministic ID; another account making the same query
  receives a different private record and cannot read or mutate yours.
- `listing.source` is the machine tag for where the verified price came from — e.g. `live:amadeus`
  (hotel/flight), `live:ticketmaster` (ticket), `live:retail-feed` (retail), `dataset:plans`
  (subscription). `sourceLabel` is the
  human-readable version.
- `listing.certainty` is the listing-level provenance: `live` (current provider response) or
  `catalog` (dated catalog/dataset). This is distinct from the
  per-line-item `certainty` **inside** `report`, which uses the report vocabulary
  `listed`/`catalog`/`typical`/`estimated` (see [The Report object](#the-report-object)).
- `listing.degraded` remains `false` for successful verified results. Upstream failures do not
  produce a degraded price; they return `PRICE_SOURCE_FAILED` with no listing or report.
- `live` is `true` only for a current observed provider quote
  (`listing.provenance.observed=true`). It is `false` for catalog snapshots and
  catalog snapshots. Together with `certainty`, `asOf`, and freshness fields,
  this prevents a dated source from being presented as a current provider response.
- **Subscription is a special case:** it is always answered from a dated catalog snapshot
  shipped in the repo. A matched plan returns `source: "dataset:plans"`,
  `certainty: "catalog"`, `live: false`: it is **point-in-time catalog pricing,
  not a current provider quote**, so verify current pricing before relying on it. A query that
  matches no catalogued plan returns `404` with `code: "NO_VERIFIED_RESULT"` and no price.
- `/api/meta` exposes the same safe catalog projection at
  `subscriptionCatalog.freshness` and `providers.subscription.freshness`; `/api/ready`
  exposes it at `dataSources.subscriptionCatalog`. Fields include `status`, oldest/newest
  as-of dates, row counts, `ageSeconds`, `maxAgeDays`, and `freshThrough`—never source URLs
  or credentials. Any non-demo production launch, its search/results, and subscription
  notifications fail closed when status is `stale` or `invalid`; explicit local/demo mode may
  show the dated row only with stale provenance.
- `stats` is `null` for anonymous requests. For a persisted private result it is
  the 90-day summary (`{days: 90, n, low_cents, high_cents, avg_cents}`);
  `score` uses the same 0–100 deal-quality shape as product reads.

Fail-closed search errors never contain a listing, report, or price:

| Status | Code | Meaning |
|---:|---|---|
| 404 | `NO_VERIFIED_RESULT` | The verified source had no matching result. |
| 422 | `PRICE_SOURCE_UNAVAILABLE` | No verified source is configured for that vertical. |
| 424 | `PRICE_SOURCE_FAILED` | A configured verified source failed safely. |
| 429 | `PRICE_SOURCE_BUSY` | The verified source budget/capacity is temporarily exhausted. |

`400` covers an unknown `vertical`, or a `q` outside 2–120 characters. The web app routes
all four fail-closed source states to manual advertised-price input.

curl:

```sh
curl -s http://localhost:4780/api/search \
  -H "Content-Type: application/json" \
  -d '{"vertical":"ticket","q":"eagles madison square garden"}'
```

### POST /api/billing/checkout

Start or reuse an account-owned Stripe Checkout session. Live mode requires an
authenticated cookie session, same-origin request, and the session's
`X-CSRF-Token`. Fetch `/api/meta` first and show the approved terms; checkout is
rejected unless the exact published version is explicitly accepted.

#### Request body

| Field | Type | Required | Notes |
|---|---|---|---|
| `planId` | string | yes | One of `premium` (consumer), `api_starter`, `api_pro` (API tiers). |
| `acceptTerms` | boolean | live | Must be `true`. |
| `acceptedTermsVersion` | string | live | Must exactly equal `/api/meta` → `legal.termsVersion`. |

#### Response

`200`:

```json
{ "url": "https://checkout.stripe.com/c/pay/cs_live_…", "mock": false, "mode": "live" }
```

- In **live mode** `url` is a real Stripe Checkout Session URL, `mock` is
  `false`, and `mode` is `"live"`. The account email—not arbitrary request
  input—owns the customer and fulfillment. A `reused` field may indicate a
  durable still-open checkout intent.
- In **local mock mode** (no `STRIPE_SECRET_KEY`, non-production) `url` points at the app's own
  `/billing/mock-checkout` simulation page, `mock` is `true`, and `mode` is `"mock"`. The
  mock flow exercises the whole checkout → entitlement/key path locally without charging
  anything, and is clearly labeled as a simulation.

Errors include `400` invalid input/terms, `401` no session, `403` origin/CSRF,
`409` active or pending subscription conflict, and `503` unsafe commerce,
reconciliation, tax, catalog, or launch configuration.

### GET /api/billing/checkout/status?session_id=&lt;id&gt;

Poll fulfillment without consuming a key. In live mode the cookie session must
own the Checkout Session; a different account receives `404`. HTTP `202`
reports `status: "pending"`; HTTP `200` reports `complete`, `claimable`, or
`claimed`; HTTP `409` represents a terminal expired/failed checkout. Poll with
a bounded timeout and never infer success from a redirect alone.

```json
{ "status": "claimable", "complete": true, "claimable": true, "plan": "api_starter", "tier": "starter" }
```

### POST /api/billing/claim

After an owned API-plan checkout becomes `claimable`, submit JSON
`{"session_id":"cs_…"}` with the authenticated cookie, same origin, and
`X-CSRF-Token`. The raw key is revealed exactly once.

#### Response

`200`:

```json
{ "key": "pt_starter_5f0pbZiUEfILdKezgjLl9G5pRZWo1oWn", "tier": "starter", "plan": "api_starter", "status": "claimed", "note": "shown once; store it now" }
```

- `202` means signed webhook fulfillment is still pending.
- `409` means the key was already claimed or is no longer claimable.
- `404` hides a wrong owner and covers non-API purchases/no staged key.
- `400` covers a missing/malformed session ID.

As with `npm run keygen`, only a hash of the key is stored server-side; once claimed (or once
its short TTL lapses unclaimed) it cannot be retrieved again.

Production has no destructive query-string `GET` claim flow. A deprecated
email-only/GET compatibility path exists only in local mock mode and returns
`405` outside that mode; clients must not depend on it.

### POST /api/billing/portal

Return a URL where a customer can self-serve manage or cancel their subscription.
Live mode uses the authenticated account's Stripe customer and requires the
same cookie/origin/CSRF controls as checkout; it does not accept an arbitrary
customer email. The JSON body may be empty.

#### Response

`200`:

```json
{ "url": "https://billing.stripe.com/p/session/…", "mock": false }
```

- **Live mode:** a real Stripe billing-portal URL for the authenticated
  account's Stripe customer. Returns `404` when that account has no billing customer.
- **Local mock mode:** `url` points at the app's `/billing/mock-portal` simulation page, with
  `mock: true` (no live account required).

### POST /api/billing/webhook

Stripe webhook receiver—**called by Stripe, not app users.** It verifies the raw
body and `Stripe-Signature` against `STRIPE_WEBHOOK_SECRET` with a bounded
timestamp tolerance. Persistent event-ID deduplication and event-created
ordering protect ledger/entitlement side effects. Checkout fulfillment is
account/intent/Price-bound; subscription, invoice, refund, and dispute events
then maintain access and audit state. See [WEBHOOKS.md](WEBHOOKS.md) for the
exact production event allowlist and foreign-catalog fail-closed behavior.

#### Response

`200` `{ "received": true, … }` (the `…` summarizes what was applied). Returns `400` on a
bad, missing, or stale signature.

The route bypasses the public token bucket so valid Stripe retries are not
dropped, but it still enforces body-size, pre-auth rate/concurrency, signature,
and global webhook-concurrency limits.

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
  current provider quote).

---

## The Report object

| Field | Type | Meaning |
|---|---|---|
| `vertical` | string | `hotel` \| `flight` \| `ticket` \| `subscription` \| `retail` |
| `currency` | string | Always `"USD"` |
| `advertised` | `{amount_cents, unit}` | The sticker price. Unit: `per_night` \| `per_fare` \| `per_ticket` \| `per_month` \| `total` |
| `truePrice` | `{amount_cents, unit}` | Evidence-backed total when `completeness.status` is `complete`; otherwise the known priced subtotal. Unit: `per_night` \| `per_fare` \| `checkout_total` \| `first_year` \| `total` |
| `total` | `{amount_cents, label}` or `null` | Multi-unit rollup, explicitly labeled as a total or known subtotal, e.g. `"3-night known subtotal"`, `"First-year cost"` |
| `lineItems` | array | `{code, label, amount_cents, kind, certainty, note?}`; `kind`: `base` \| `fee` \| `tax` \| `addon`; `certainty`: `listed` \| `catalog` \| `typical` \| `estimated` |
| `feeLoadPct` | number | Hidden-cost % over the advertised equivalent (one decimal) |
| `confidence` | number | 0.35–1.0; see Conventions |
| `completeness` | `{status, unknownCosts}` | `status` is `complete` or `partial`. Every unknown cost has `{code, label, reason}` and must remain visible to users. |
| `assumptions` | string[] | Every assumption the engine made — show these to end users |
| `disclosures` | string[] | Regulatory/consumer context for this vertical |

## Errors

Errors are JSON:
`{"error":"<message>","code":"<stable class>","requestId":"<correlation id>"}`.
Branch on status and `code`, not the human-readable message. Every response also
returns the correlation ID in `X-Request-Id`; include it in support requests.

| Status | When | Example body |
|---|---|---|
| 400 | Invalid JSON, wrong types, unknown enum values, non-integer cents, oversized/invalid `context` | `{"error": "vertical must be one of: hotel, flight, ticket, subscription, retail"}` or `{"error": "advertised_cents must be integer cents (0..1e9)"}` |
| 401 | Missing, malformed, or revoked `X-API-Key` | `{"error": "missing or invalid X-API-Key"}` |
| 403 | Customer key attempts canonical history ingestion | `{"error":"this API key is read-only; canonical history writes require an operator-issued ingestion scope"}` |
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

- **2026-08-25** — Added passwordless accounts, account-owned watchlists and
  double-opt-in alerts, preferences/export/deletion, self-service API-key
  create/rotate/revoke, durable job/outbox delivery, signed Resend delivery
  events, readiness, request IDs, standard error codes, rate/quota headers, and
  the full OpenAPI 3.1 contract at `GET /api/openapi`. Billing checkout is now
  account/CSRF/terms-version bound, fulfillment has a non-consuming status
  route, and one-time API keys are claimed by authenticated JSON `POST`.
- **2026-08-24** — Added public same-origin endpoints (no API key, IP rate-limited):
  `POST /api/search` (verified live/catalog lookup with fail-closed errors; anonymous results are
  ephemeral and signed-in results are private) and Stripe-backed billing—
  `POST /api/billing/checkout`, `GET /api/billing/checkout/status`,
  `POST /api/billing/claim`, `POST /api/billing/portal`,
  `POST /api/billing/webhook`—plus owner-only
  `GET /api/admin/metrics`. Billing runs live with Stripe keys or in a clearly-labeled mock
  mode; the webhook is exempt from rate limiting.
- **v1 — 2026-08-21** — Initial release: `POST /api/v1/analyze` (five verticals),
  `GET /api/v1/products/:id` (30-day stats, score, history), `GET /api/v1/usage`,
  `POST /api/v1/track` (plausibility-banded price-point ingestion); API-key auth
  (SHA-256 at rest), starter/pro daily quotas, 30/min burst limit.
