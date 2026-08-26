# Operations and observability

## Signals and dashboards

The hosting platform must collect stdout/stderr, container CPU/memory/restarts,
edge request metrics, and probe results. Preserve `X-Request-Id` in proxy logs
and customer support tooling. Application logs include that identifier, method,
sanitized path, status, and duration; never log cookies, CSRF tokens, API keys,
magic links, email payloads, or provider secrets.

The primary dashboard should include:

- request rate, 4xx/5xx, p50/p95/p99 by route class;
- liveness/readiness status and restart count;
- SQLite file size, integrity/readiness, lock/busy errors, and disk utilization;
- job counts by status, oldest available job, attempts, and exhausted jobs;
- outbox counts, oldest pending message, attempts, provider acceptance,
  delivered, bounced, and complained events;
- search outcomes by vertical and provenance (`observed`, catalog, modeled),
  provider latency/failure, and subscription catalog status/oldest-row age against its
  configured maximum;
- Stripe webhook age/failures/duplicates, active entitlements, payment failures,
  and revenue reconciliation delta;
- `/api/ready.webhooks` route/global verified processing concurrency, unsigned
  per-IP body-read concurrency, accepted/rejected totals, and rejection reasons;
- API key usage, rate-limit responses, and daily-quota exhaustion;
- latest backup age and latest successful restore drill.

`GET /api/admin/metrics` is token-protected and supplies application summaries.
It is not a public monitoring endpoint. Store `ADMIN_TOKEN` in the monitor's
secret store and rotate it after operator access changes or suspected exposure.

## Paging

Page the on-call operator for:

- readiness failing for 5 minutes or liveness failing twice;
- fast SLO budget burn or sustained 5xx above 2%;
- paid entitlement webhook failures or no Stripe event receipt during known
  volume for 15 minutes;
- oldest eligible alert/outbox job over 10 minutes;
- bounced/complaint spike above the verified baseline;
- database integrity failure, disk above 80%, or verified backup older than 30
  minutes;
- evidence/provenance missing from any response labeled observed; or
- a launch catalog becomes invalid or reaches its freshness deadline before a replacement
  snapshot is reviewed and deployed.

Create a ticket, not a page, for slow provider degradation that is safely failing closed,
individual exhausted jobs, or gradual capacity growth.

## Daily checks

1. Review SLO and error-budget status.
2. Reconcile failed/exhausted jobs and email events without replaying customer
   messages blindly.
3. Review provider observed/catalog/fail-closed outcome mix and `/api/ready` catalog freshness; schedule
   re-verification well before `freshThrough` rather than extending the policy to clear an
   alert.
4. Confirm Stripe webhook success and entitlement reconciliation.
5. Confirm backup freshness and storage headroom.
6. Sample support corrections and extension misdetections for adapter/data
   regressions.

## Safe replay

Stripe events dedupe by persistent event ID. Resend events dedupe by provider
event ID. Outbox and collection/evaluation jobs use stored idempotency keys.
Before manually replaying anything, record the original event/job ID, confirm
its current durable state, and understand the handler's idempotency strategy in
`openapi/openapi.json`. B2B `/api/v1/track` is not idempotent: a retry appends an
additional observation.

## Capacity and maintenance

Keep the database volume under 70% during normal operation to leave space for
WAL/checkpoint and recovery. Schedule intensive maintenance and restore drills
outside provider collection peaks. A single active app/worker owns SQLite; use
`DISABLE_WORKER=1` only during controlled maintenance or when a separately
managed worker has taken ownership.
