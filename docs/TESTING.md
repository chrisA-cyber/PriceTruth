# Quality gates

The merge gate is executable in `.github/workflows/ci.yml` on Node 24.

| Gate | Command | Purpose |
|---|---|---|
| Source/contracts | `npm run check` | Parse JS/JSON; validate OpenAPI references/auth/idempotency; validate extension permissions/assets |
| Unit/integration | `npm test` | Engine, providers, database, auth, jobs, email, billing, HTTP, security, extension fixtures |
| Boot preflight | `npm run build` | Start the real app in memory and probe health, metadata, and integer-cents analysis |
| Security smoke | `npm run smoke:security` | Headers, origin isolation, traversal, body limits, safe errors, B2B auth |
| Performance smoke | `npm run smoke:performance` | Local HTTP p95 regression budget |
| Extension release | `npm run extension:check` + origin-bound package | Adapter/package tests, permission/assets validation, releasable ZIP creation |
| Browser flows | `npm run test:e2e` | Desktop/mobile price checks, analyzer, focus, API, overflow |
| Accessibility | `npm run test:a11y` | WCAG-tagged axe scan plus keyboard skip-link behavior |
| Container | CI job | Reproducible build, non-root user, persistent volume, explicit safe demo config, page/liveness/readiness/meta/OpenAPI probes |
| Dependencies | CI audit/Dependabot | Production high-severity audit; weekly test-tool updates |
| Static security | CodeQL | Extended JavaScript queries on PR/main and weekly |

The performance command is a smoke budget, not capacity certification. Before
a major traffic launch, run a representative external load test against staging
with provider calls stubbed. Exercise provider sandbox limits only through a
non-public harness: the application deliberately rejects Amadeus sandbox
credentials so those responses can never acquire verified-live provenance. Record
p50/p95/p99, error rate, CPU/memory, database lock time, queue lag, and recovery
after a provider timeout. Never load-test production checkout or email delivery.

Browser failures upload trace, screenshot, video, and HTML report artifacts for
14 days. Flaky tests are retried in CI for diagnostics but remain failures when
all attempts fail; do not add unconditional skips to pass a release.
