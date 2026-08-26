# Incident response

## Severity

- **SEV-1:** customer data exposure/loss, incorrect charges or broad entitlement
  failure, database corruption, complete paid-service outage, or systemic
  observed-price misrepresentation.
- **SEV-2:** major vertical unavailable without a safe manual-input handoff, alert/email
  queue beyond SLO, elevated errors, or serious account/API access degradation.
- **SEV-3:** limited bug with a workaround, isolated failed jobs, or non-critical
  provider/extension regression.

SEV-1 acknowledgment target is 15 minutes; SEV-2 is 30 minutes. Name an incident
commander, operations lead, communications lead, and scribe. One person may hold
multiple roles on a small team, but ownership must be explicit.

## Response loop

1. Declare severity, start a UTC timeline, and link dashboards/log queries.
2. Protect customers first: disable paid launch, stop workers, make the affected
   vertical fail closed into manual input, or remove traffic as appropriate.
3. Preserve evidence: request IDs, image digest, configuration *names* (not
   values), provider event IDs, database/backup hashes, and affected record IDs.
4. Form and test one hypothesis at a time in staging or a recovery copy.
5. Apply the smallest reversible mitigation; verify readiness and customer
   behavior.
6. Communicate status on a predictable cadence without speculation or sensitive
   detail.
7. Resolve only after metrics recover and queued/retried work is reconciled.
8. Publish a blameless review with root cause, impact, detection gap, corrective
   owners/dates, and evidence that fixes were tested.

## Playbooks

### Suspected credential or session exposure

Revoke the affected API keys/sessions, rotate operator/provider secrets at the
issuer, stop using the suspected source, and inspect access by key prefix,
account, request ID, and provider logs. Never paste secrets into the incident
document. Determine notification obligations with qualified counsel before
making promises.

### Incorrect billing or entitlement

Disable live checkout while leaving account access available, retain all Stripe
event IDs, reconcile Stripe state against entitlements, and use persistent event
deduplication for replays. Refund or correct through the approved billing
process; do not edit the revenue ledger ad hoc.

### Database corruption or loss

Stop all writers, preserve the damaged files and sidecars, select the newest
verified off-host backup, and follow `BACKUP-RESTORE.md`. Validate account,
entitlement, alert, key, outbox, and history samples before restoring traffic.

### Provider sends bad prices

Remove the vertical/provider from observed launch coverage and fail search closed, retain raw
evidence permitted by policy, identify affected reports and
alerts, suppress bad queued notifications, and revalidate against checkout
receipts before re-enabling the source.

### Email bounce or complaint spike

Pause non-essential sends, keep transactional opt-out operational, verify
signature processing, identify template/domain/list changes, and honor provider
suppressions. Never reactivate a bounced/complained recipient without a valid
new consent path.

## Communications template fields

Every update states: incident ID/severity, user-visible impact, affected time
window, mitigation state, safe workaround if any, next-update time, and the
public status location. The deployment operator supplies real organization and
support identities at launch; this repository intentionally does not invent
them.
