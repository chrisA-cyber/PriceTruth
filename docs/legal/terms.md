# Terms-of-service publication inputs

> **INTERNAL PRELAUNCH WORKSHEET — NOT TERMS OF SERVICE**
>
> This file is an operator and counsel handoff. Do not publish it, link users to it, or treat it
> as an agreement. It intentionally makes no claim about the operator, governing law, venue,
> dispute process, or support contact.

**Publication status:** Blocked pending operator input and legal approval

**Worksheet revision:** August 25, 2026

## Fail-closed commercial gate

Do not accept payment, issue paid API access, market a subscription as available, or require a
user to accept terms until a separate public agreement has been approved and deployed. Release
approval requires:

- Confirmed legal operator identity and a monitored private support channel.
- Counsel-approved effective date, launch territories, governing law, venue, and dispute terms.
- Accurate plan names, prices, renewal rules, cancellation path, refund policy, taxes, and trial
  behavior for the exact production billing configuration.
- An acceptance record tied to the published version for every account that must accept terms.
- Consistency among the terms, privacy policy, checkout, account dashboard, API documentation,
  affiliate disclosure, and actual application behavior.

If any item is unknown, paid and account-bound commercial features remain unavailable. Never fill
the gap with a product name, sample entity, assumed location, or fake address.

## Service facts to validate before drafting

The public agreement should describe only behavior verified in the production release:

- PriceTruth estimates total cost from advertised prices and labels listed, typical, and
  estimated components.
- Reports may include source, freshness, confidence, assumptions, price history, and a
  deal-quality score; none is a seller quote or guarantee.
- Users must verify price, availability, taxes, fees, and purchase terms at the seller's checkout.
- Accounts can manage saved products, alerts, preferences, API keys, exports, billing state, and
  deletion when those features are enabled.
- API access is authenticated, metered, subject to documented quotas, and revocable.
- Third-party sellers, price providers, email providers, payment processors, and affiliate
  destinations operate under their own terms.

Engineering and product owners must re-validate this list against the release candidate. Remove
or qualify anything the deployed service does not support.

## Operator and counsel decisions required

### Contract formation and eligibility

- Legal operator name, service address, support route, and capacity to contract.
- Minimum user age and any business-account authority requirements.
- The exact clickwrap or other acceptance flow and version-record retention.
- Countries or regions where the service will and will not be offered.

### Product, accounts, and acceptable use

- Scope of free, paid, API, alert, export, and account-deletion services.
- Account security duties, passwordless access expectations, suspension, and recovery.
- Prohibited automation, scraping, abuse, circumvention, resale, and misleading use.
- API-key ownership, confidentiality, rotation, quota, revocation, and service-level position.
- Rules for user-submitted URLs, search terms, and any future content.

### Fees, renewals, cancellation, and refunds

- Currency, taxes, billing interval, auto-renewal language, trials, and promotional pricing.
- Cancellation effective date, continued access, refunds, credits, failed payments, and disputes.
- Notice and consent requirements for price or plan changes.
- Payment-provider responsibilities and the operator's billing-support process.

No price, refund, or renewal language may be copied from this worksheet; it must come from the
approved commercial policy and match the configured checkout.

### Risk allocation

Counsel must draft the warranty disclaimer, limitation of liability, indemnity, force-majeure,
consumer-rights savings language, and any business-user terms for the selected jurisdictions.
Engineering documentation can explain uncertainty but cannot decide enforceability or liability
caps.

### Intellectual property and third parties

- Ownership and licensing of the software, methodology, datasets, report content, and branding.
- Permitted use of reports and API output.
- Treatment of seller names, marks, links, data licenses, and takedown requests.
- Affiliate relationships and the separation of compensation from analysis and ranking.

### Termination, changes, and disputes

- User and operator termination rights, data consequences, and surviving provisions.
- Notice and acceptance process for material changes.
- Governing law, forum, arbitration, class-action, informal-resolution, and consumer protections,
  chosen by counsel for the actual operator and launch regions.
- A monitored legal-notice route and service-of-process instructions.

## Prepublication verification

The launch approver must verify that:

- Every signup and paid checkout links the approved agreement before acceptance.
- The accepted version and timestamp can be retrieved for support or disputes.
- Pricing, cancellation, export, deletion, and API-key controls work as described.
- Uncertainty and seller-verification language is clear in every report.
- The public document names the real operator, contact route, effective date, and applicable
  jurisdictional terms.
- No internal note, sample value, draft marker, or unreviewed promise is present.

## Drafting and approval handoff

Counsel should create a separate publishable agreement from the confirmed operator decisions and
release behavior. Record its reviewer, approval date, version, deployed URL, and acceptance-flow
test in the launch evidence. This worksheet remains internal.
