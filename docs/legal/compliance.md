# Legal and compliance launch gate

> **INTERNAL PRELAUNCH CONTROL DOCUMENT — NOT LEGAL ADVICE OR A PUBLIC POLICY**
>
> This file tells the operator what must be decided, reviewed, tested, and evidenced before
> launch. It intentionally contains no assumed entity, jurisdiction, venue, postal address, or
> contact channel. Product documentation cannot make those decisions on the operator's behalf.

**Overall status:** Blocked pending operator facts and qualified legal review

**Control revision:** August 25, 2026

## Non-negotiable fail-closed rule

The release must not accept payment, issue paid access, activate affiliate compensation, send
user notifications, or market regulated availability until the relevant gate below is approved.
If an owner, fact, policy, or test result is missing, the affected feature remains disabled.

The existing technical launch guard and honest frontend states support this rule, but they do not
replace operator sign-off. No engineer may invent a company, address, contact, jurisdiction,
venue, partner relationship, or legal conclusion to make a check pass.

## Blocking operator facts

The launch decision cannot be completed without:

- Legal operator identity, formation status, service address, and signing authority.
- Private, monitored support, privacy, legal-notice, and security-reporting channels.
- Launch countries and states, excluded regions, user eligibility, and minimum age.
- Governing law, venue, dispute path, and mandatory consumer-rights position approved by counsel.
- Production hosting, database, email, billing, analytics, price-provider, and affiliate vendors.
- Data locations, subprocessors, transfer mechanisms, retention periods, and incident owners.
- Final plans, prices, taxes, renewal behavior, cancellation timing, refunds, and support process.
- Live affiliate or sponsorship agreements, if any.
- Accessibility owner and ongoing conformance process.

These belong in a restricted operator record, not as sample values in the repository.

## Gate matrix

| Area | Required decision and evidence | Feature blocked until approval |
| --- | --- | --- |
| Public terms | Counsel-approved agreement matching account, API, billing, cancellation, and dispute behavior | Paid plans and mandatory account acceptance |
| Privacy | Verified data inventory, approved policy, subprocessors, retention, rights workflows, and contact route | Accounts, notifications, analytics, and payments |
| Billing | Approved prices and renewal/refund rules; live provider configuration; webhook, entitlement, cancellation, and reconciliation tests | All charges and paid entitlements |
| Email | Sender identity, consent basis, double opt-in where used, unsubscribe, suppression, deliverability, retention, and abuse handling | Alerts, digests, and marketing email |
| Affiliate | Signed relationship, pre-click disclosure, tracking inventory, allowlist, and ranking-independence test | Compensated links and sponsored placements |
| Pricing claims | Evidence that displayed totals label estimates, sources, freshness, uncertainty, and seller-verification requirements | Public price reports for an affected vertical |
| API | Approved commercial terms, quotas, key lifecycle, abuse response, data rights, and support process | External paid API issuance |
| Security | Monitored private reporting route, incident plan, secret management, recovery tests, and approved disclosure policy | Public internet exposure and paid operations |
| Accessibility | Keyboard, focus, screen-reader, contrast, zoom, reflow, error, and mobile tests with an issue owner | Public release of affected user journeys |
| Records | Versioned approvals, policy acceptance, consent, billing, incident, deletion, and vendor evidence with retention rules | The feature whose evidence cannot be retained |

## Regulatory review topics

Qualified counsel should determine applicability for the actual operator, audience, claims, and
territories. At minimum, the review should cover:

- All-in-price and mandatory-fee requirements for lodging, tickets, travel, subscriptions, and
  retail, including the FTC rule on unfair or deceptive fees and applicable state rules.
- FTC endorsement and material-connection requirements for affiliate and sponsored content.
- Federal and state unfair or deceptive acts and practices, comparative claims, substantiation,
  dark-pattern, auto-renewal, and negative-option requirements.
- Email and electronic-message consent, sender identification, unsubscribe, and recordkeeping.
- State, federal, and international privacy, breach-notification, children's privacy, biometric,
  sensitive-data, data-broker, and cross-border-transfer rules that match the launch scope.
- Payment-card allocation, payment-provider contracts, taxes, refunds, chargebacks, and sanctions.
- Accessibility duties and the chosen conformance target.
- Data-source licenses, website terms, database rights, trademarks, scraping restrictions, and
  permissions for product images or copied content.
- Consumer-reporting, financial-advice, insurance, travel-agent, ticket-broker, or other licensing
  regimes if future product behavior enters those categories.

This list identifies questions; it does not assert that a law applies or that the service
complies.

## Product truthfulness controls

Release evidence must show that:

- Advertised price and estimated total are clearly distinguished.
- Every material line item is labeled as listed, typical, or estimated.
- Source identity, collection time, freshness, and degraded status are visible.
- Assumptions are understandable and editable where the product supports editing.
- Reports direct users to verify the final seller checkout before purchasing.
- Stale, unavailable, modeled, and provider-failure states never masquerade as live evidence.
- Deal scores and comparisons explain their basis and do not imply guaranteed savings.
- Affiliate compensation cannot change calculations, evidence, or ranking.
- Share, copy, print, and export surfaces retain material qualifications.

These controls should be tested with real production configurations for every enabled vertical.

## Privacy and lifecycle controls

Before account or notification launch, retain proof that:

- Passwordless sign-in verifies control of the address and sessions can be revoked.
- State-changing account requests enforce CSRF protection.
- Alert consent and notification subscription states are explicit.
- Users can manage watchlist items, alerts, preferences, and API keys.
- Export and deletion complete as described in the approved privacy policy.
- Account deletion handles billing, active sessions, notifications, backups, and legally required
  records according to documented rules.
- Raw API keys are disclosed once, stored securely when temporarily staged, rotatable, and
  revocable.
- Logs and support tools avoid unnecessary personal data and secrets.
- Retention and deletion jobs are monitored and recoverable.

## Billing controls

Before accepting money:

- Production billing must fail closed unless durable storage, email, worker, public URL, secrets,
  webhook verification, and live price-source requirements are satisfied.
- Checkout must show the exact operator, product, interval, renewal, currency, taxes, cancellation
  path, refund position, and links to approved terms and privacy policy.
- Webhook processing, entitlement changes, duplicate delivery, failed payment, cancellation,
  refund, dispute, and reconciliation paths must pass against the live provider's test environment.
- Support must be able to identify an entitlement without exposing secret payment data.
- Revenue and entitlement records must be transactionally consistent and recoverable.
- The account dashboard must never imply that a test or unavailable plan is purchasable.

## Accessibility release evidence

Automated tests are necessary but not sufficient. The release record should include:

- Serious and critical automated issue scans for representative desktop and mobile routes.
- Keyboard-only navigation, visible focus, skip-link, dialog, form-error, and route-focus checks.
- Screen-reader checks for navigation, universal search, reports, tables, alerts, and account tools.
- Reflow and zoom checks without document-level horizontal scrolling.
- Touch targets, contrast, non-color cues, reduced motion, and forced-colors checks.
- A process for triage, regression testing, and responding to accessibility feedback.

## Approval record

The release owner must store a dated, access-controlled record containing:

- Operator facts and launch territories.
- Counsel and specialist reviews, scope, decisions, and unresolved risks.
- Approved public documents and their deployed URLs and versions.
- Vendor and subprocessor inventory.
- Test results and configuration snapshot.
- Named owners for incidents, privacy requests, billing disputes, policy changes, and periodic
  review.
- A go, limited-go, or no-go decision for each gated feature.

This repository document remains an internal control. It is never itself evidence that legal
review occurred, that a policy is published, or that a feature may be enabled.
