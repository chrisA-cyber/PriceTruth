# Service-level objectives

These objectives apply after paid launch. Calculate them from the production
edge and durable job/email records, not from client analytics alone.

| Indicator | Objective | Window |
|---|---:|---:|
| Web/API availability for non-provider routes | 99.9% successful eligible requests | rolling 30 days |
| `POST /api/analyze` latency | 95% under 500 ms; 99% under 1 s | rolling 30 days |
| Account/session mutation latency | 95% under 750 ms | rolling 30 days |
| Verified search success | 99% returns a valid observed/catalog result or an intentional fail-closed 404/422 response | rolling 7 days |
| Durable job start delay | 99% within 5 minutes of `available_at` | rolling 7 days |
| Alert evaluation after a recorded price point | 99% within 10 minutes | rolling 7 days |
| Transactional email handoff | 99% of eligible messages accepted by provider within 5 minutes | rolling 7 days |
| Verified backup freshness | newest verified recovery point no older than 30 minutes | continuous |

Eligible availability excludes requests rejected for invalid input,
authentication, entitlement, quota, CSRF/origin failure, or deliberate rate
limiting; it includes internal errors, timeouts, and dependency failures. Intentional
`NO_VERIFIED_RESULT` and `PRICE_SOURCE_UNAVAILABLE` responses count as available only when
they contain no listing/report/price and retain a stable error code for the manual-input handoff.

## Error-budget policy

A 99.9% monthly objective provides approximately 43 minutes of error budget.

- At 25% budget burn in the first week, review the dominant failure class.
- At 50%, pause non-essential risky releases and prioritize reliability work.
- At 75%, freeze feature releases except mitigations.
- At 100%, remain frozen until the incident review has owners and verified
  corrective controls.

Alert on fast burn (more than 14.4× budget for 1 hour) and slow burn (more than
2× for 24 hours). Use at least two windows to avoid paging on brief noise.

## Data-quality objectives

Availability is not enough for PriceTruth. For every launch vertical:

- 100% of monetary values are integer USD cents with explicit units;
- 100% of dated source rows have `catalog` certainty and modeled lines have `typical` or `estimated` certainty;
- 100% of observed claims include provider, retrieval time, and evidence;
- observed-vs-checkout validation meets the accuracy threshold approved in the
  release ticket; and
- source snapshot age never exceeds the vertical's published freshness policy (for the
  subscription catalog, the oldest verified row must remain within the configured 1–365
  day window, 93 days by default).

If a data-quality objective fails, downgrade the vertical to modeled/beta or
remove it from `LAUNCH_VERTICALS`; do not preserve a “live” badge by weakening
the definition.
