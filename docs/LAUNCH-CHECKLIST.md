# Flagship launch checklist

This is a release gate, not a statement that external accounts, legal approval,
store review, production traffic, or real-user evidence already exist. Every
checked item requires an owner, date, and evidence link in the release ticket.

## Phase 1 — focus and accuracy standard

- [ ] Declare `LAUNCH_VERTICALS`; every other vertical is visibly beta/modeled.
- [ ] Publish each launch vertical's observed/catalog/model/manual-handoff definition,
      freshness limit, supported geography/sellers, and correction policy.
- [ ] If subscription launches, attach row-by-row first-party verification evidence and
      confirm `/api/ready` reports the catalog fresh within the approved 1–365 day policy
      (93 days by default); never refresh only the snapshot label.
- [ ] Approve receipt/checkout validation sampling and error thresholds before
      seeing results.
- [ ] Validate representative totals, units, quantities, taxes, fees, renewals,
      and uncertainty against real checkouts; attach de-identified evidence.
- [ ] Confirm every observed claim has source, retrieval time, evidence, and
      `observed=true`; every dated snapshot is labeled catalog; every projection is labeled typical/estimated.
- [ ] Remove the “live” claim or vertical when accuracy/freshness misses its gate.

## Phase 2 — production foundation

### Identity and customer control

- [ ] Passwordless email is delivered through the verified production domain;
      tokens are single-use and expire; account enumeration is prevented.
- [ ] Cookie, CSRF, same-origin, session expiry/revocation, logout, export, and
      deletion pass integration and manual browser tests.
- [ ] Watchlists, preferences, alerts, notification consent/status, billing,
      API keys, and usage are owned by authenticated account IDs.
- [ ] Double opt-in, one-click channel and alert unsubscribe, bounce/complaint
      suppression, retry exhaustion, and support recovery are tested end to end.

### Billing

- [ ] `ENABLE_LIVE_BILLING=1` passes the production gate; live products/prices,
      tax behavior, customer portal, invoices, cancellation, payment failure,
      refund, and entitlement transitions are verified in production mode.
- [ ] `ENABLE_ACCOUNTS=1`, `STRIPE_AUTOMATIC_TAX=1`, and the immutable approved
      `LEGAL_TERMS_VERSION` are visible in launch evidence; checkout records the
      exact terms version accepted by the authenticated account.
- [ ] Stripe raw-body signatures, persistent event-ID dedupe, retries, delayed
      events, duplicates, out-of-order events, and reconciliation are tested.
- [ ] Price/feature claims match actual entitlements and support capacity.
- [ ] No mock checkout/portal or test credential is reachable as a real offer.

### Data, storage, and workers

- [ ] Database is on a monitored persistent encrypted volume with one active
      writer; disk/locks/integrity/readiness are visible.
- [ ] In-process durable worker, leases, retry backoff, exhausted-job review,
      collection schedule, alert evaluation, and outbox delivery are proven
      across restart.
- [ ] Off-host backups meet RPO; checksum/integrity and monthly restore drill
      meet RTO; evidence is attached.
- [ ] Provider timeouts, malformed values, quotas, credential loss, no-match, and
      fail-closed/manual-handoff behavior pass fault tests without returning a substitute price.
- [ ] Stale/malformed subscription catalog tests prove paid readiness/search fail closed and
      subscription alert creation, evaluation, and digest entries are suppressed while the
      labeled local demo remains usable.

### Security, privacy, and legal

- [ ] Qualified reviewers approve final operator identity, support contact,
      terms, privacy, retention/deletion, affiliates, data sources, billing,
      email consent, correction/dispute, and incident notification obligations.
- [ ] All legal configuration variables are replaced with real approved values;
      no placeholders, prototype notices, or unsupported claims remain.
- [ ] Secrets are in the platform vault, least-privilege access is recorded,
      rotation/revocation is tested, and no secret appears in repository/logs.
- [ ] TLS, HSTS, proxy header trust, security headers, origin/CSRF protections,
      body limits, rate limits, traversal/redirect guards, and admin isolation
      pass the security review.
- [ ] Dependency audit and CodeQL have no unaccepted high/critical issue; every
      exception has owner, expiry, compensating control, and approval.

## Phase 3 — closed beta (50–200 users)

- [ ] Participants consent to beta terms and know which results are observed vs
      modeled; support and correction channels are staffed.
- [ ] Analytics/feedback collection matches the approved privacy disclosure.
- [ ] Measure task success, time to verified total, receipt accuracy, fallback
      rate, corrections, alert precision/latency, email outcomes, retention,
      support burden, accessibility, and trust comprehension.
- [ ] Triage every price discrepancy; systemic errors suppress alerts and live
      claims until corrected.
- [ ] SLOs, paging, incident drill, restore drill, provider outage, and billing
      reconciliation run successfully under beta load.
- [ ] Exit thresholds are met for the complete predefined sample—not a selected
      success subset.

## Phase 4 — paid beta

- [ ] Production launch-gate and post-deploy commands pass against the promoted
      immutable image; image digest and environment evidence are recorded.
- [ ] Real low-value checkout, renewal, portal update, cancellation, failure,
      refund, invoice, webhook retry, and entitlement removal are verified by
      authorized operators.
- [ ] Support response targets, refund/escalation playbooks, status location,
      and on-call coverage are active.
- [ ] API docs/OpenAPI, key create/rotate/revoke, quotas, request IDs, errors,
      retry guidance, and one supported SDK path are verified in staging.
- [ ] Chrome extension privacy/listing/permissions/assets/adapters pass review;
      store rollout is staged independently from the web launch.
- [ ] Error budget is healthy throughout the paid-beta observation window.

## Phase 5 — flagship expansion

- [ ] Expand one vertical/seller/geography at a time through the full Phase 1
      evidence gate; never inherit another vertical's accuracy claim.
- [ ] Migrate to managed PostgreSQL and separate workers before multiple active
      web replicas or sustained write concurrency.
- [ ] Add bulk B2B operations/SLA only after capacity, isolation, abuse controls,
      reconciliation, and support are demonstrated.
- [ ] Complete expert WCAG 2.2 AA audit and disabled-user research before a
      public conformance claim.
- [ ] Review SLOs, retention, vendors, permissions, pricing, legal terms,
      adapters, and disaster recovery at least quarterly.

## Final go/no-go

The release commander records **GO** only when every applicable item above is
checked with evidence, all P0 defects are closed, launch-gate/readiness/CI are
green, backups and rollback are verified, legal approval is recorded, and the
error budget is healthy. Any owner may call **NO-GO** for customer harm,
untruthful evidence, data loss, privacy/security, billing, accessibility, or
operational-readiness risk without needing a replacement launch date.
