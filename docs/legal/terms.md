# Terms of Service — PriceTruth (prototype)

**Effective date:** 2026-08-21 (prototype draft)
**Operator:** PriceTruth (prototype), operated by [COMPANY ENTITY]
**Contact:** [CONTACT EMAIL]

> **Prototype notice.** PriceTruth is a working prototype seeded with demo data.
> These terms are drafted honestly for what the software is today. They are not
> legal advice, and a production launch would have counsel review them.

## 1. What PriceTruth is

PriceTruth shows **price estimates and price history for information only**. It
takes an advertised price (a hotel's nightly rate, an airline's base fare, a
ticket's face price, a subscription's teaser rate, a retail listing) and
projects the **true cost** — the total you would likely pay after typical fees,
taxes, and add-ons — together with price history and a deal-quality score.

By using the site or the API you accept these terms. If you do not accept them,
do not use the service.

## 2. Accuracy disclaimer — read this one

**PriceTruth produces estimates, not quotes.**

- Every cost breakdown labels each line item as `listed` (a value you or the
  seller supplied), `typical` (a market-typical figure from our datasets), or
  `estimated` (a computed heuristic). **Any line labeled typical or estimated
  is a projection and may differ — sometimes materially — from what a specific
  seller actually charges.**
- Every report carries a confidence value and a list of assumptions. Read them.
- Fee datasets, tax rates, and platform fee structures change; ours may lag.
- The prototype ships with **demo data**: demo products, simulated price
  history, and placeholder partner tags. It is labeled as such in the product
  and should be treated as illustrative.
- **The only price that matters is the one on the seller's checkout page at the
  moment you pay. Always verify there before buying.**

PriceTruth is not the seller, has no control over sellers' prices, and does not
guarantee that any price, fee, tax, availability, or score shown is accurate,
complete, or current.

## 3. Not advice

PriceTruth provides general information, not advice. Nothing on this site is
financial advice, investment advice, purchasing advice, tax advice, or a
recommendation to buy or not buy any particular product or service. Deal-quality
scores are an automated summary of price history and fee load, not a judgment
about what you should do. Decisions you make based on the service are your own.

## 4. No warranty

The service is provided **"as is" and "as available"**, without warranty of any
kind, express or implied, including merchantability, fitness for a particular
purpose, accuracy, and non-infringement. We do not warrant that the service
will be uninterrupted, error-free, or secure. This is a prototype; expect rough
edges, resets, and downtime.

## 5. Limitation of liability

To the maximum extent permitted by law, [COMPANY ENTITY] and its contributors
are not liable for any indirect, incidental, special, consequential, or
punitive damages, or any loss of profits, savings, data, or goodwill, arising
from or related to your use of the service — including purchase decisions made
in reliance on estimates, scores, or price history. To the extent liability
cannot be excluded, total aggregate liability is capped at the greater of the
amount you paid us in the twelve months before the claim (for the free
prototype: zero) and US $50. Some jurisdictions do not allow these exclusions,
so parts of this section may not apply to you.

## 6. Acceptable use

You agree not to:

- scrape, bulk-harvest, or systematically extract data from the site or API,
  or use automated traffic beyond the documented, enforced rate limits;
- circumvent or attempt to circumvent rate limits, quotas, API-key controls, or
  any security measure;
- share, resell, or publish an API key, or use another party's key;
- misrepresent PriceTruth output as a seller's official price or as a quote;
- use the service for any unlawful purpose, or to build a service that
  misleads consumers about prices — the exact thing this project exists to fix.

Rate limits are enforced per client on public routes and per key on the API;
requests over the limit receive HTTP 429 and should back off.

## 7. Price alerts

Creating an alert stores your email and threshold as described in the
[Privacy Policy](privacy.md). In the prototype no email is sent. Free usage is
limited (currently one alert); the premium tier shown in the product is a demo
of the intended paywall, not a live paid service — no payment is collected.

## 8. B2B API

Commercial API access is governed by these terms plus the API documentation
(`docs/API.md`), which covers tiers, daily quotas, and key handling. Keys are
shown once at creation and stored only as hashes; you are responsible for
keeping your key secret. We may throttle, suspend, or revoke keys that exceed
quota or violate Section 6. Production B2B use would be covered by a separate
signed agreement.

## 9. Affiliate links and third-party sites

Outbound partner links pass through an interstitial that discloses our
affiliate relationship (see the
[Affiliate Disclosure](affiliate-disclosure.md)). Third-party sites have their
own terms and privacy policies; we are not responsible for them.

## 10. Intellectual property

The PriceTruth software, datasets, and content are the property of
[COMPANY ENTITY] or its licensors. Sellers' names and trademarks belong to
their owners; their appearance here is nominative — to identify whose prices
are being analyzed — and implies no affiliation or endorsement.

## 11. Termination

We may suspend or terminate access (including revoking API keys) at any time
for violation of these terms, abuse, or legal necessity. You may stop using the
service at any time; ask us to delete your alert data per the Privacy Policy.

## 12. Changes

We may update these terms as the prototype evolves. The current version, with
its effective date, is always at this location. Continued use after a change is
acceptance of the new terms.

## 13. Governing law

These terms are governed by the laws of [GOVERNING LAW JURISDICTION], without
regard to conflict-of-law rules, and disputes belong to the courts of
[VENUE]. (Placeholders — to be fixed when [COMPANY ENTITY] exists.)

## 14. Contact

**[CONTACT EMAIL]**
