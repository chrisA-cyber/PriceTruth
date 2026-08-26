# PriceTruth — Business Plan

**One line:** PriceTruth is the truth layer for buying things online — it tells you what a
purchase will *actually* cost, not what the seller advertised.

**Status:** working prototype. Every claim below about the product is backed by code in this
repo, cited inline. Every projected number below is an assumption, labeled as one — the same
honesty rule the product itself enforces (`CONTRACTS.md`: "every projected number carries
`certainty`").

---

## 1. Positioning

Three categories of tools sit between a shopper and a price. They answer different questions:

| Tool | Question it answers | What it misses |
|---|---|---|
| Coupon extensions (Honey, Capital One Shopping) | "Can I get you a coupon?" | The price itself. A 10% coupon on a $219 room that really costs $317/night is a distraction, not a saving. |
| Price trackers (CamelCamelCamel, Keepa) | "How has the *advertised* price moved?" | Fees. They chart the sticker, and the sticker is the least honest number in the transaction. |
| **PriceTruth** | **"What will this actually cost me?"** | — |

PriceTruth computes the **true price** — advertised price plus every mandatory or
realistically-unavoidable fee — as an itemized, certainty-labeled breakdown
(`src/engine/analyze.js`), scores the deal against *true-price* history
(`src/engine/score.js`), and stores that true price over time (`src/db.js`,
`price_points.true_cents`). The demo catalog makes the gap concrete: a "$219" Vegas room is
$317/night (fee load 44.7%), a "$189" LCC fare is $294, an "$86" arena ticket is $134 at
checkout, a "$9.99/month" streaming plan is $179.88 in year one.

Honesty is the product mechanic, not a marketing line: every line item carries
`certainty: listed | catalog | typical | estimated`, every report carries a `confidence` score and an
`assumptions` array, and demo data is labeled demo data.

## 2. Why now

**The FTC junk-fee rule (16 CFR Part 464, effective May 2025)** requires all-in advertised
pricing for hotels and live-event tickets. Three consequences, all favorable:

1. **Consumer salience.** Mandatory add-on fees and drip pricing are now named, regulated consumer harms. "What does it
   really cost?" is a mainstream question with regulatory air cover.
2. **A compliance-verification market.** Someone has to check whether an advertised price is
   actually all-in. A tool that independently reconstructs the true price is the natural
   verifier — for consumers, journalists, and the platforms themselves. Our hotel and ticket
   engines already cite the rule in their disclosures (`src/engine/analyze.js`).
3. **The rule's gaps are our roadmap.** Airline ancillaries (bags, seats, carry-ons) are DOT
   territory, untouched by Part 464 — our flight engine models them per carrier
   (`src/data/fees/flight.json`). Subscription teaser pricing is only partially addressed by
   the FTC's Negative Option Rule (click-to-cancel; it governs cancellation, not renewal-price
   drip) — our subscription engine computes honest first-year cost
   (`src/data/fees/subscription.json`).

The scale of the problem is documented: GAO found event-ticket fees average ~27% of face value,
reaching 58% (GAO-18-347, cited in `src/data/fees/ticket.json`).

## 3. Product surfaces

| Surface | Where / status | What it does |
|---|---|---|
| Web app | `public/`, served by `src/server.js` with strict CSP; UI in build against `CONTRACTS.md` | Glance-first true-price verdict, itemized breakdown with estimate labels, 30/90-day true-price history, deal-quality score, price alerts with a premium paywall — all backed by shipped server routes (`/api/analyze`, `/api/products`, `/api/history`, `/api/alerts` with its HTTP 402 upsell). |
| Browser extension | `extension/`, in build against the same API | The true price shown where the shopping happens. The acquisition wedge (see GTM). |
| B2B API | `/api/v1/*` in `src/server.js` — **implemented, keyed, metered, tested** | `POST /api/v1/analyze`, product + history reads, usage metering, hashed API keys, per-tier daily quotas. Reference: `docs/API.md`. |

Under the hood (all shipped, zero runtime dependencies): analysis engine covering five
verticals (hotel, flight, ticket, subscription, retail), fee datasets with cited public
sources (`src/data/fees/*.json`), 0–100 deal-quality scoring, SQLite price history, and an
affiliate redirect that always passes through a disclosure interstitial (`/go/:partner`).

## 4. Revenue

Six streams, ranked by expected time to first dollar. All figures are pre-revenue assumptions.

**Built vs. earning — the honest split.** The payment machinery now exists in code. The two
paid-plan streams below (premium, #4; B2B API, #2) are wired end-to-end through Stripe —
Checkout → signature-verified webhook → entitlement or API-key issuance → self-serve billing
portal — with **zero runtime dependencies** (Stripe's REST API over `fetch`, webhook HMAC via
`node:crypto`; `src/billing.js`, `PLANS`). With no `STRIPE_SECRET_KEY` set it runs in **mock
mode**: the full checkout → webhook → key/entitlement flow executes locally and in tests,
labeled a simulation in every UI surface so nothing is ever shown as a real charge. Dropping in
real keys + price IDs makes it genuinely live. What does *not* yet exist: real customers, real
revenue, live partner programs, and data-provider contracts at scale. This section describes
capability, not traction — the billing ledger is empty.

| # | Stream | Model | Unit economics | Time to first $ |
|---|---|---|---|---|
| 1 | Travel affiliate commissions | 3–6% of booking value via partner links; disclosure interstitial + open-redirect guard shipped (`/go/:partner`) **[rails wired · needs partner approval]** | ~$80 per converted $2,000 booking at 4% | Days–weeks |
| 2 | B2B pricing API | Starter $49/mo, Pro $399/mo — Stripe checkout → minted API key against shipped quotas **[implemented · live only after launch gates pass]** | ≥1.6¢/call (starter), ≥0.13¢/call (pro) | Weeks |
| 3 | Alternative-recommendation referrals | Referral fee when we surface a cheaper/equal alternative (incl. "book direct") **[shares #1 rails]** | Same rails as #1; higher trust value | Weeks–months |
| 4 | Premium subscription | $4/mo — multiple periodic alerts after verified catalog/source updates plus a weekly email digest; delivery follows source cadence. Stripe checkout → server-enforced entitlement (402 paywall + `/pricing` shipped) **[implemented · live only after launch gates pass]** | 1–3% of MAU converting | Months |
| 5 | Travel-site referral placements | Flat-fee partner placements, always disclosure-labeled **[future]** | $500–$2,000/mo per placement (assumed) | Months |
| 6 | Fee-index reports | Anonymized aggregate fee data for media/researchers **[future]** | $2k–$10k per report (assumed) | Quarters |

**Worked example — affiliate (stream 1).** A $2,000 hotel booking at a 4% commission pays $80.
Per 1,000 hotel-report views: at 3–6% outbound CTR (30–60 clicks) and 1–3% click-to-booking
conversion, expect 0.3–1.8 bookings → **$24–$144 per 1,000 product views** ($80 at the
midpoint assumptions of 5% CTR / 2% conversion). Honest caveats: CTR on a truth-first UI may
run below coupon-extension benchmarks (we tell users when a deal is *bad*), and commissions
require partner program approval. The conflict-of-interest risk this stream creates is
addressed in §7.

**Worked example — premium (stream 4).** $4/mo (`PLANS.premium`), converting 1–3% of MAU
(typical freemium-utility range; unproven for us). 25,000 MAU → 250–750 subscribers →
**$1,000–$3,000 MRR**, before ~5%/mo churn. The whole path now exists: the freemium 402 paywall
(the second alert on a free account returns HTTP 402 with the $4/mo upgrade offer) and the
`/pricing` page drive Stripe Checkout; a signature-verified `checkout.session.completed` webhook
grants premium server-side (`accounts` table, `db.isPremium`); the customer self-serves through
the billing portal (`src/billing.js`, `src/server.js`). In mock mode this runs locally, labeled
a simulation. Paid launch remains gated on production email, legal, storage, reconciliation, and operational readiness before anyone should actually pay — and no
one has: zero subscribers today.

**Worked example — B2B API (stream 2).** Starter $49/mo buys up to 100 calls/day (≤3,000/mo →
floor of ~1.6¢/call); Pro $399/mo buys 10,000/day (≤300,000/mo → ~0.13¢/call) —
`PLANS.api_starter` / `PLANS.api_pro`. Quotas are enforced in code today (`src/server.js`,
`B2B_DAILY_LIMIT`). Billing is now wired too: Stripe Checkout → webhook mints a hashed API key →
the key is revealed **exactly once** on the success page (claim-once via `/api/billing/claim`,
backed by the `pending_keys` table) → usage is metered and quota-enforced per tier. Compute cost
per call is negligible; the real COGS is data acquisition (§7). One design partner on Starter is
a credible first B2B dollar inside 90 days — the machinery to accept that dollar now exists,
but live enrollment remains closed until every launch gate passes. No paying API customer exists yet.

**Revenue visibility.** An owner-only, token-gated admin dashboard (`/admin`, backed by
`GET /api/admin/metrics`, gated by `ADMIN_TOKEN`) surfaces gross revenue, 7- and 30-day windows,
active plans by tier, API-call volume, and recent billing events — all read from a replay-safe
billing ledger that is idempotent on Stripe's event ref (`billing_events.stripe_ref UNIQUE`, so
a replayed webhook records once; `src/db.js`, `revenueSummary`). The response reports
`billing.mode`, so today it plainly shows mock-ledger entries as mock — the dashboard never
mistakes a simulated charge for a real one.

Streams 5 and 6 are deliberately last: placements need demonstrated audience, and fee-index
reports need a longitudinal dataset that only exists after months of collection. Stream 6
sells **aggregates only, never individual data** — consistent with the privacy policy
(`docs/legal/privacy.md`: no sale or sharing of personal data; the only PII in the system is
alert emails, which never touch price data or reports).

## 5. Go-to-market

1. **Extension as the acquisition wedge.** Distribution through the Chrome Web Store at zero
   CAC; the "this $219 room is really $317" moment happens at the point of purchase, where the
   value is self-demonstrating. Extension users generate price observations, which feed the
   dataset, which improves the product — acquisition and moat-building are the same motion.
2. **Programmatic SEO on "true cost of X".** The query family nobody owns: "true cost of
   [hotel]", "[hotel] resort fee", "spirit airlines real price", "[service] price after
   trial". Generate per-hotel resort-fee pages and per-market fee pages directly from the fee
   dataset (`src/data/fees/hotel.json`) and tracked properties — each page is a true-price
   breakdown with history, i.e. actual product, not thin content.
3. **PR: the annual "Hidden Fee Index".** Rank markets, carriers, platforms, and subscription
   categories by fee load from our aggregate data. Journalists cite indexes; every citation is
   a backlink and a trust deposit. First edition possible ~90 days after real collection
   starts (§8).

## 6. Moat

**Longitudinal true-price history is the compounding asset nobody else collects.** Advertised
price history is a commodity (CamelCamelCamel has 15+ years of it). Checkout-total history —
what people actually paid, fee-itemized, per property/carrier/platform, over time — does not
exist as a dataset anywhere, and it cannot be backfilled: a competitor starting in a year is a
year behind forever. The schema records it from day one (`price_points` stores
`advertised_cents` *and* `true_cents` per timestamp). Every product surface feeds it: tracked
products, extension observations, user-contributed quotes (the engine's `listed` overrides in
`context` are exactly this input path), and eventually B2B partner feeds. The fee-index
reports (stream 6) and the Hidden Fee Index (GTM) are the same asset, monetized and marketed.

## 7. Risks & mitigations

| Risk | Exposure | Mitigation |
|---|---|---|
| FTC rule *works*: hotel/ticket fee drip shrinks, weakening the headline use case | Two of five verticals | Pivot the same engine to **verification** ("is that all-in price actually all-in?") — a compliance market the rule itself creates — and lean into the uncovered verticals: airline ancillaries and subscription renewal drip (§2). The engine is vertical-modular; adding verticals is data work, not architecture work. |
| Scraping fragility: sites change, block, or ToS-lawyer us | Data pipeline (the prototype deliberately ships labeled demo data, not scrapers) | Diversify inputs: B2B partnerships where partners *supply* feeds (they want the verification badge), user-contributed receipts/quotes (already supported as `listed` context inputs), extension-observed prices. Scrapers become one input among four, not the foundation. |
| Affiliate conflict of interest: we earn when users click partners we score | Trust — the entire brand | Independence by construction, citable in code: the deal score is computed from price history and fee load only — `dealQuality()` in `src/engine/score.js` has no partner, revenue, or click input. Affiliate links exist *only* via the `/go/:partner` interstitial, which discloses the commission before every redirect and states "That never changes the prices, fees, or scores we show" (`src/server.js`). Partners are a fixed allowlist (`src/data/partners.json`); reports and scores render identically whether or not a partner link exists. Policy: we will show "this is a bad deal" on a partner's product, and we publish that policy. |
| Fee-data staleness: `typical` values drift from reality | Report accuracy | Every dataset carries `updated` dates and cited sources; `typical`/`estimated` lines are labeled and discount `confidence` (`src/engine/analyze.js`), so staleness degrades gracefully and visibly instead of silently lying. Real collection (§8) replaces typicals with observations. |

## 8. 90-day roadmap: prototype → beta

**Already shipped in the prototype (revenue machinery, works in mock mode today).** These were
"planned" in earlier drafts of this doc; they are now built and tested:

- **Stripe billing, end-to-end, zero-dependency.** All three paid plans (`PLANS`: premium
  $4/mo, API Starter $49/mo, API Pro $399/mo) run the full Checkout → signature-verified webhook
  → entitlement/key-issuance → self-serve portal flow (`src/billing.js`, `src/server.js`). Live
  on real keys; simulated (and clearly labeled) in mock mode when `STRIPE_SECRET_KEY` is absent.
- **Consumer premium.** Freemium 402 paywall + `/pricing` page → checkout → webhook grants
  premium server-side (`db.isPremium`, `accounts`).
- **Metered B2B API keys.** Checkout → webhook mints a hashed key → revealed once (claim-once,
  `/api/billing/claim`) → per-tier usage metering and quota enforcement.
- **Owner-only revenue dashboard + replay-safe ledger.** `/admin` + `GET /api/admin/metrics`
  (token-gated) over an idempotent `billing_events` ledger (`stripe_ref UNIQUE`).
- **Affiliate rails.** Disclosure interstitial + open-redirect guard (`/go/:partner`).

**Going live is a controlled operational milestone.** It requires all paid-launch readiness
checks to pass: approved operator/legal metadata, durable storage and backups, verified email,
workers and reconciliation, the reviewed Stripe product/price catalog and webhook, applicable
tax setup, and truthful data-source scope. Local simulation never counts as revenue.

**Still genuinely remaining (not built):** real customers and a first real dollar; data-provider
contracts at scale; production deliverability monitoring; dunning / failed-payment recovery;
operator tax registrations and jurisdiction-specific tax review; and SOC-type compliance. Automatic-tax calculation is a technical control, not proof of compliance. These stay future work below.

| Days | Milestone | Definition of done |
|---|---|---|
| 1–30 | **Verified data, two verticals** | Collect all-in seller totals with stable identities for a reviewed lodging catalog and maintain the verified subscription catalog; retire demo provenance only where evidence supports it. Submit affiliate-program applications (Booking, Expedia — rails already shipped). |
| 31–60 | **Alerts validated + extension shipped** | Validate production deliverability, double opt-in, unsubscribe, suppression, and scheduled-update cadence end to end. List the extension in the Chrome Web Store. Publish only SEO pages backed by verified, current evidence. |
| 61–90 | **First dollars, both motions** | First affiliate conversion tracked end-to-end. One B2B design partner live on Starter ($49/mo) with a case study after every paid-launch gate passes. First real premium charge through that same controlled path. "Added-Cost Index" v0 drafted from the first 90 days of verified data. |

Exit criteria for "beta": real data in two verticals, a user can be emailed a real alert they
double-opted into, and at least one revenue stream has produced a nonzero dollar.
