# Native Netlify deployment

PriceTruth deploys as one same-origin Netlify application. Netlify's CDN serves
the browser bundle, native Node functions own the dynamic routes, and Netlify
Database provides durable Postgres storage for production and isolated database
branches for Deploy Previews. No Render service, external API origin, or proxy
environment variable is required.

```text
Browser
  -> Netlify CDN (HTML, CSS, JavaScript, legal pages)
  -> native Node function (/api/*, /go/*, /download/*, /billing/*)
       -> Netlify Database (Postgres)
       -> Stripe, Resend, and configured price providers
  -> scheduled trigger
       -> background worker
            -> durable jobs and encrypted email outbox in Postgres
```

`npm run build:netlify` publishes the static application to `dist/netlify`.
The generated `_redirects` file contains exact JSON 404 guards for POST-only
webhook/worker paths, followed by `/admin` and SPA fallbacks. Netlify evaluates
the Functions' declared paths and methods before those static guards. The build
derives canonical metadata, `robots.txt`, and `sitemap.xml` from Netlify's
automatic `URL` value. `PRICETRUTH_SITE_ORIGIN` is only an optional canonical
override for an already-approved custom domain.

## Fastest safe demo

The deployed native adapter always forces `NODE_ENV=production`; a dashboard
typo cannot disable the application's launch gates. The independently attested
local Netlify Dev loopback runs as development. An unconfigured deployed site
enters a fail-safe demo mode with these effective capability values:

```text
NODE_ENV=production
PUBLIC_BASE_URL=<main site origin in published production; current deploy origin in previews>
DATABASE_MODE=netlify
WORKER_MODE=netlify-background
ENABLE_DEMO_SEED=1
ENABLE_ACCOUNTS=0
ENABLE_LIVE_BILLING=0
DISABLE_WORKER=0
```

Searches, manual analysis, reports, API documentation, the affiliate disclosure
flow, and the extension download work, but accounts, email, alerts, scheduled
collection, and charging remain off. When Netlify Database was auto-provisioned,
the demo catalog uses that durable Postgres branch; a direct local Function
invocation without `NETLIFY_DB_URL` falls back to in-memory data. Never add live
Stripe credentials to a demo-mode deployment.

`/api/ready` can still return HTTP 200 for this intentionally limited demo. Its
payload reports `worker.enabled=false` and `worker.dispatchConfigured=false`
until a valid dispatch secret exists. That does not mean the account or paid
product is launch-ready: their separate capability gates remain closed and the
production launch gate still fails without the required worker, email, legal,
billing, and provider configuration.

## Deploy from GitHub

1. In Netlify, choose **Add new project -> Import an existing project**.
2. Choose GitHub, authorize the repository if prompted, and select
   **PriceTruth**.
3. Select `main` as the production branch. Leave Base directory empty.
4. Keep the repository settings detected from `netlify.toml`:

   ```text
   Build command: npm run build:netlify
   Publish directory: dist/netlify
   Functions directory: netlify/functions
   ```

5. Choose **Deploy PriceTruth**. Do not add an external backend-origin
   variable; the Function and browser application share the Netlify origin.
6. Open the deployed URL, then verify:

   ```text
   https://YOUR-SITE.netlify.app/api/health
   https://YOUR-SITE.netlify.app/api/ready
   ```

7. Run the repository's remote verification against the exact public URL:

   ```text
   npm run deploy:verify -- --base-url=https://YOUR-SITE.netlify.app
   ```

Netlify uses the build's Node 24 version for the Function runtime. To pin it
explicitly, add `AWS_LAMBDA_JS_RUNTIME=nodejs24.x` under **Project
configuration -> Environment variables**, then redeploy. Netlify requires this
runtime override to be stored in the UI, CLI, or API rather than
`netlify.toml`.

## Enable Netlify Database

The production application uses `@netlify/database`. On the first deploy that
contains the package and SQL files under `netlify/database/migrations`, Netlify
automatically provisions the managed Postgres database and applies the
migrations before publishing. A failed migration blocks publication.

Confirm the database under **Project -> Database**. Netlify supplies
`NETLIFY_DB_URL` automatically and chooses the correct branch for each deploy;
do not create or copy that credential yourself. Do not set `PRICETRUTH_DB` on a
native Netlify deployment—filesystem SQLite is not shared or durable in
Functions.

For an existing site where automatic provisioning was disabled, open
**Project -> Database -> Create database**, then redeploy. Production deploys
use the main database branch. Each Deploy Preview receives an isolated branch
copied from production and receives its own migration run.

Netlify Database is available on credit-based plans. The Free plan is suitable
for validation, but a customer launch should use a paid plan with adequate
compute, retention, monitoring, and spending controls. Netlify documents the
current limits at
[Database billing and usage](https://docs.netlify.com/build/data-and-storage/netlify-database/billing-and-usage/).

## Move an existing SQLite installation

The repository includes a one-way, fail-closed importer for an existing
PriceTruth v4 SQLite database. It preserves primary IDs, hashes, encrypted
pending keys and email payloads, webhook/billing history, leases, retries,
entitlements, sessions, and operational queues. It also backfills the Postgres
alert and auth-token quota slots, carries per-key API usage into the new shared
account counter, advances identity sequences without lowering either source or
target high-water marks, and compares every imported value plus every table
count before committing.

Encryption continuity is an operator-owned prerequisite. Configure Netlify
with the **exact existing** `OUTBOX_ENCRYPTION_KEY` and, when the old service
set it separately, `PENDING_KEY_ENCRYPTION_KEY`. Pending checkout keys use the
latter or fall back to the outbox key. The importer intentionally copies
ciphertext, IVs, and authentication tags byte-for-byte; it cannot decrypt them,
prove that an environment key matches, or safely invent a replacement. Verify
the old key material through the secret stores without printing it. Secret
rotation requires first draining/superseding pending messages and key claims,
or a separately reviewed decrypt-and-re-encrypt migration with both keys—not a
new dashboard value during cutover.

The default command is a plan. It opens SQLite read-only, checks integrity and
foreign keys, requires the exact v4 source and target catalog contracts
(types/defaults, PK/FK/check constraints, index predicates, identity sequences,
triggers, and RLS included), validates all target uniqueness/ownership
constraints, and changes nothing:

```text
npm run db:cutover -- --source=/absolute/path/to/pricetruth-cutover.db
```

Use `--inspect-source` when no target credential should be loaded yet:

```text
npm run db:cutover -- --inspect-source --source=/absolute/path/to/pricetruth-cutover.db
```

The command obtains the target only from `NETLIFY_DB_URL`. Inject that value in
a trusted operator session (for example through a linked Netlify CLI session),
and remove it immediately afterward. Never paste it into a document, commit,
CI log, command argument, or support message. The tool itself prints table
counts only—never database URLs, paths, row contents, email addresses, hashes,
or ciphertext.

The four legacy SQLite auto-increment IDs (`price_points`, `alerts`, `api_keys`,
and `billing_events`) map to PostgreSQL `INTEGER` identities. Source inspection
rejects an ID or deleted-row sequence high-water mark that cannot leave a valid
32-bit next value, before it contacts the target. This is an explicit migration
volume limit; changing those identities to `BIGINT` requires a new reviewed
schema and cutover contract. Stripe provider event timestamps are already
`BIGINT` and do not have the 2038 Unix-seconds ceiling.

### Fresh Netlify target (recommended)

1. Announce a write-maintenance window. Disable the Render worker, block new
   account, alert, checkout, and webhook writes at the old origin, and wait for
   any in-flight request to finish. Do not rely on DNS propagation as a write
   lock.
2. While the old SQLite volume is quiescent, create a verified copy with
   `npm run db:backup -- --source=/absolute/live/pricetruth.db --output=/absolute/export/pricetruth-cutover.db`.
   Keep the live database and
   its `-wal`/`-shm` files untouched. Download the copy and its `.sha256` and
   `.json` sidecars through an approved encrypted channel; verify the digest on
   the operator machine.
3. Deploy Netlify with `ENABLE_DEMO_SEED=0`, accounts/email/billing disabled,
   the exact existing encryption material configured as Function secrets, and
   the production migrations applied. Do not send public traffic yet.
4. Run `--inspect-source`, then the default target plan above. The target must
   contain zero rows in every application data table. A schema-only
   `schema_migrations` row is expected and is not imported from SQLite.
5. Publish a production deploy immediately before import and confirm a new
   on-publish entry under **Project -> Database -> Backups**. This is the empty
   target rollback point; backup availability and retention depend on the
   project's plan.
6. Apply once:

   ```text
   npm run db:cutover -- --apply --source=/absolute/path/to/pricetruth-cutover.db
   ```

   The importer holds an exclusive transaction, appends in foreign-key-safe
   order, reconciles counts and cryptographic fingerprints, and exits nonzero
   without committing if any constraint, value, or invariant differs.
   Historical SQLite v4 files remain accepted with their original
   `(account_id, plan)` checkout index, but inspection fails closed if the file
   actually contains more than one pending or awaiting-payment checkout for an
   account. Reconcile those provider-authoritative intents explicitly; the
   importer never expires or drops one to force the cutover through.
7. Run the deployed health/readiness and post-deploy checks. Verify sign-in,
   watchlist, alert, billing-history, queue, and administrator counts without
   sending customer mail or charging. Then configure the signed worker and
   other production gates, publish again, and only then move the custom domain.
8. Keep Render write-frozen and retain the verified SQLite export for the
   agreed rollback window. Destroy credentials and retire the service only
   after Netlify writes, webhooks, scheduled/background work, and backups have
   been observed successfully.

Do not run the importer against a database that a public Netlify Function is
already seeding or writing. Do not retry `--apply` after an uncertain terminal
disconnect until the default plan proves whether rows committed.

### Existing Netlify target

A new database is safer. If the destination legitimately contains data that
must remain, first take and confirm a Netlify backup, then review the explicit
append-only plan before applying it. The only override is deliberately verbose:

```text
npm run db:cutover -- --allow-existing-target=append-only --source=/absolute/path/to/pricetruth-cutover.db
npm run db:cutover -- --apply --allow-existing-target=append-only --source=/absolute/path/to/pricetruth-cutover.db
```

This mode never updates, replaces, truncates, or deletes an existing row. It
captures the baseline under an exclusive transaction, rejects any primary-key
or uniqueness collision, requires every post-import count to equal baseline
plus source, and rolls the transaction back on a mismatch. It is not a merge or
deduplication tool. The same write-maintenance window and in-flight-request
drain used for a fresh cutover are required. Resolve conflicts by producing a
reviewed, app-specific migration on an isolated database branch—not by editing
the source or adding `ON CONFLICT` behavior to the importer.

## Production runtime environment

Runtime values must be added through **Project configuration -> Environment
variables**, `netlify env:set`, or the Netlify API. Values committed in
`[build.environment]` are build-only and are not Function secrets. Mark secrets
as containing secret values and limit their scope to **Functions** when the
plan supports scoped variables.

Netlify supplies `URL`, `SITE_ID`, `SITE_NAME`, and `NETLIFY_DB_URL`. Do not
redeclare them. `PUBLIC_BASE_URL` is optional. A published production Function
uses a validated override when present and otherwise uses Netlify's trusted
main site URL. Deploy Previews, branch deploys, and other non-published deploys
always use the validated HTTPS origin of their current Netlify request; they
ignore an inherited production override so magic links, checkout returns, CSRF
checks, extension links, and manual worker dispatches cannot cross into
production.

`netlify dev` is the only HTTP exception. The adapter requires the CLI's trusted
`dev` context, unpublished-deploy flag, `NETLIFY_DEV=true` process marker, and
matching loopback request/site ports before it accepts an `http://localhost`,
`127.0.0.1`, or `::1` origin. None of those signals can relax a deployed
Function's public-HTTPS requirement.

For a durable account launch, configure:

```text
NODE_ENV=production
DATABASE_MODE=netlify
WORKER_MODE=netlify-background
ENABLE_DEMO_SEED=0
ENABLE_ACCOUNTS=1
REQUIRE_EMAIL=1
EMAIL_TRANSPORT=resend
DISABLE_WORKER=0
ENABLE_LIVE_BILLING=0
LAUNCH_VERTICALS=subscription
PUBLIC_BASE_URL=https://your-final-domain.example  # optional override

ADMIN_TOKEN=<long random value>
OUTBOX_ENCRYPTION_KEY=<at least 32 random characters>
WORKER_DISPATCH_SECRET=<at least 32 random characters>
RESEND_API_KEY=<production Resend key>
RESEND_WEBHOOK_SECRET=<Resend/Svix signing secret>
EMAIL_FROM=<verified sender>

LEGAL_OPERATOR_NAME=<approved legal operator>
LEGAL_JURISDICTION=<approved jurisdiction>
SUPPORT_CONTACT_URL=https://...
LEGAL_EFFECTIVE_DATE=YYYY-MM-DD
LEGAL_TERMS_VERSION=<approved version>
LEGAL_APPROVED=1
```

Keep `ENABLE_LIVE_BILLING=0` until the account/email flow, durable worker,
legal review, and provider scope all pass `/api/ready`. Live billing additionally
requires the production Stripe secret, webhook secret, automatic-tax approval,
and every `STRIPE_PRICE_*` and `STRIPE_PRODUCT_*` value documented in
`deploy/netlify.env.example`. Production search verticals require their
corresponding provider credentials; undeclared or unverified sources fail
closed to manual analysis.

After changing any runtime variable, trigger a new deploy. Function deployments
capture the environment values that existed at deploy time.

## Scheduled and background work

A request-scoped Function never starts `setInterval`. Production background
work uses two concrete Functions:

1. `netlify/functions/worker-schedule.mjs` runs every minute in UTC. It creates
   a small timestamped payload, signs the exact request with HMAC-SHA256 using
   `WORKER_DISPATCH_SECRET`, and posts it to `/api/internal/worker` on the
   validated published site origin. Preview/branch invocations are disabled by
   the non-published runtime policy. It stays inside the 30-second Scheduled
   Function limit. Because Netlify automatically clocks Scheduled Functions only
   for published deploys, this scheduled-only entry point may attest an exact
   production main-origin match when its runtime `published` flag is stale.
   Ordinary web and background Functions never use that exception, so an old
   skew-protected production deploy cannot regain live credentials at the main
   hostname.
2. `netlify/functions/worker-background.mjs` owns that exact private path in
   background mode. It rejects missing, altered, future, or more-than-five-minute-old
   signatures before initializing the app. Every valid invocation claims
   bounded batches from the Postgres `jobs` and `outbox` tables using durable
   leases. The maintenance-tagged invocation every 15 minutes also scans and
   idempotently enqueues the tracked catalog and eligible digest recipients
   exactly once; ordinary one-minute invocations skip those full scans. Only
   queue draining repeats, until the queues are drained or the approximately
   12-minute safety budget expires. Netlify's platform ceiling is 15 minutes.

The scheduler marks one signed dispatch per 15-minute UTC bucket for maintenance
and job scheduling; every signed dispatch drains existing work. Set
`DISABLE_WORKER=1` to stop dispatch deliberately. If the dispatch secret is
unset, the scheduler logs a safe skip instead of producing a failing demo every
minute; `/api/ready` still prevents that deployment from passing the production
launch gate. A configured secret must contain at least 32 characters.

Collection scheduling, weekly digests, retryable email delivery, alert
evaluation, billing reconciliation, and retention must all remain recoverable
from Postgres. An immediate worker invocation may reduce latency, but the
scheduled trigger is the catch-up path after cold starts or transient errors.
Keep live billing and customer notifications disabled until the deployed
scheduled/background worker reports healthy.

Scheduled functions run automatically only on the published production deploy.
Deploy Previews and branch deploys force the scheduler and background worker
off even when they inherit production flags or a dispatch credential; a manual
**Run now** invocation safely no-ops. Exercise worker behavior locally against
an isolated database, then verify the signed scheduler/background path on the
published deployment. The private background endpoint is intentionally not an
operator API; always exercise it through the scheduler so the request is signed.

Platform behavior and limits are documented in
[Scheduled Functions](https://docs.netlify.com/build/functions/scheduled-functions/)
and
[Background Functions](https://docs.netlify.com/build/functions/background-functions/).

## Webhooks

Configure provider endpoints on the final Netlify origin:

```text
Stripe: POST https://YOUR-DOMAIN/api/billing/webhook
Resend: POST https://YOUR-DOMAIN/api/email/webhook
```

The same-origin Function receives the original request body and verifies the
provider signature before mutating Postgres. Do not put webhook routes behind a
SPA rewrite, an external proxy, or a public rate-limit rule. Stripe and Resend
retry non-success responses; durable event IDs provide replay protection.

## Deploy Preview safety

Deploy Previews get their own database branch, but the initial branch is copied
from production. The native adapter also enforces a non-published runtime
safety mode: every preview and branch deploy (but not attested local Netlify
Dev) forces live billing, accounts, customer email, background work, and
affiliate monetization off. It uses the in-memory mail transport and removes
inherited Stripe, Resend, and worker-dispatch credentials from the trusted app
runtime before initialization. This prevents an accidental environment-scope
mistake from causing side effects.

That runtime policy is not a sandbox for hostile preview code. Modified code
can execute before the adapter applies its policy and could read any inherited
secret. Production-only secret scoping and preview access controls therefore
remain mandatory. Treat every preview database as production-derived data:

- protect previews with team login or password access;
- never expose preview URLs as public test environments;
- give the Deploy Preview context sandbox provider keys or no provider keys;
- keep separate preview configuration even though the adapter also forces
  charging, outbound customer email, accounts, workers, and affiliate links off;
- never make production Stripe, Resend, administrator, or encryption secrets
  available to untrusted pull requests;
- test database changes in the preview branch before merging.

Environment variables can have separate Production and Deploy Preview values
in the Netlify UI. Review the repository's sensitive-variable policy before
enabling builds from forks.

## Local development

Install Netlify CLI 26 or newer, link the repository to the site once, then run:

```text
npm install --global netlify-cli
npm run build:netlify
netlify dev
```

`netlify dev` serves the generated static bundle and Functions at
`http://localhost:4780`, pulls permitted Netlify environment values, and starts
a local Postgres-compatible Netlify Database. On the first run, keep it open and
run `netlify database migrations apply` in a second terminal before exercising
the API. Local migrations are deliberately not automatic. Netlify Dev does not
run scheduled functions on a clock.

Useful commands:

```text
netlify database migrations apply
netlify database status
netlify functions:invoke FUNCTION_NAME
netlify build
```

Use `@netlify/database-dev` for database-only integration tests and
`@netlify/dev` for full Function/database tests. Local database branches do not
model production autoscaling or concurrency, so keep the deployed concurrency,
webhook, billing-idempotency, and privacy-erasure tests in the launch gate.

## Routing and files

`netlify/functions/app.mjs` declares these native paths:

```text
/api/*
/go/*
/download/*
/billing/*
```

The public app Function excludes the two exact webhook routes and
`/api/internal/worker`; those are claimed by `webhooks.mjs` and
`worker-background.mjs`. The public app has a coarse 300-request-per-IP,
60-second Netlify rate limit in front of its route-specific application limits.
Webhooks have no public platform rate limit, so legitimate Stripe and Resend
retries reach signature verification. The private worker retains its timestamped
HMAC integrity check and also has a coarse 10-request-per-IP, 60-second Netlify
limit so unsigned floods cannot start unbounded billable background invocations;
the rate limit is not treated as authentication or a source-IP allowlist.

The Function bundle explicitly includes `extension/**` and
`openapi/openapi.json`, which are read at runtime. All other public files are
served directly by the CDN. The final generated redirects are deliberately
limited to exact unsupported-method guards plus static UI fallbacks:

```text
/api/billing/webhook  /api-route-not-found.json  404
/api/email/webhook    /api-route-not-found.json  404
/api/internal/worker  /api-route-not-found.json  404
/admin                /admin.html                200
/admin/               /admin.html                200
/*                    /index.html                200
```

The native POST Functions win for valid webhook and worker calls. Unsupported
methods instead receive the generated JSON 404 and can never fall through to a
successful HTML SPA response. No redirect proxies to or depends on an external
backend.

## Rollback and recovery

Netlify deploys are immutable, so a previous application deploy can be
republished immediately. That action does **not** restore the database: the
current production data and schema stay in place. Netlify automatically takes
a production-database backup daily and just before a production deploy is
published; confirm the applicable backup and its plan-specific retention in
the Database dashboard rather than assuming one exists.

During the SQLite cutover window, the clean rollback is to leave Netlify
unpublished/unrouted, resume the frozen Render source, and investigate the
transaction failure. After public Netlify writes begin, switching back to the
old SQLite file would discard those writes. Prefer a forward fix or an
explicitly reconciled delta migration. Restore a Netlify backup only after
accounting for every post-backup customer write, because restore replaces the
production database's full schema and data. Netlify preserves the pre-restore
production contents on a dedicated branch as a fail-safe, and a Team Owner is
required to perform the restore from **Database -> Backups**.

`npm run db:backup` and `npm run db:restore` are SQLite-only tools. Never point
them at `NETLIFY_DB_URL`. Use backwards-compatible expand/migrate/contract SQL
migrations for Netlify schema changes, and exercise both application rollback
and database recovery on an isolated branch before launch.

See
[Netlify Database migrations](https://docs.netlify.com/build/data-and-storage/netlify-database/migrations/),
[backup and recovery](https://docs.netlify.com/build/data-and-storage/netlify-database/backup-and-recovery/),
and [local development](https://docs.netlify.com/build/data-and-storage/netlify-database/local-development/)
for the platform contracts.
