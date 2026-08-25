# PriceTruth — Security Documentation

**Scope:** this document was produced by auditing the actual spine code (`src/server.js`,
`src/security.js`, `src/db.js`, `src/keygen.js`, `src/seed.js`, `src/engine/*`,
`src/data/partners.json`) plus the monetization and live-data layers added afterward
(`src/billing.js`, `src/providers/*`) at version 0.1.0. Every claim below cites the
implementation. Line references are approximate and may drift as files change; function names are
stable anchors.

**Status:** working prototype with demo data. Honest about what it does and does not defend
against — see [Open findings](#open-findings) and [Honest gaps](#4-honest-gaps--production-todos).

---

## Audit findings and resolution status

Real issues found during the v0.1.0 spine audit, ordered by severity. None was a
remote-code-execution or data-theft class issue. **F-1 through F-5 were fixed in the commit
that followed the audit; F-6 is accepted for the prototype** with the production note below.
The original finding text is preserved so the reasoning stays reviewable.

### F-1 (Medium, FIXED) — Server listens on all interfaces, not localhost

> **Resolution:** `server.listen(PORT, HOST)` now binds `127.0.0.1` by default; exposing the
> server requires an explicit `HOST=0.0.0.0` (intended only behind TLS termination).

`src/server.js` (bottom, `require.main` block, ≈line 349) calls `server.listen(PORT, cb)` with
**no host argument**, so Node binds `::` / `0.0.0.0`. The startup log prints
`http://localhost:4780`, which suggests a loopback-only bind that is not actually configured.
On a shared network (coffee shop, office LAN), every endpoint — including `POST /api/admin/keys`
if `ADMIN_TOKEN` is exported, and all B2B key-authenticated routes — is reachable by LAN peers
over plaintext HTTP. Fix: `server.listen(PORT, '127.0.0.1', cb)` for the prototype, or make the
bind host explicit via env.

### F-2 (Medium, design, FIXED) — Anonymous price-history poisoning via `POST /api/track`

> **Resolution:** tracking moved to `POST /api/v1/track` — it now requires a valid `X-API-Key`
> (metered like every v1 route) and rejects points outside a 0.25×–4× plausibility band around
> the product's reference price with a 422. Production still wants provenance and server-side
> fetch verification, but anonymous poisoning is closed.

`src/server.js` `handleApi` (≈199–208) lets any unauthenticated client append a price point with
an arbitrary `advertised_cents` (any integer 0..1e9 passes `validate.cents`) to any seeded
product. Price history and the stats derived from it (`db.getStats` low/high/avg) feed the
deal-quality score (`src/engine/score.js dealQuality`) shown to every visitor. One request with
`advertised_cents: 1` makes the "30-day low" one cent and skews every subsequent score; the
write limiter (20 burst, 0.2/s refill ≈ 17k req/day/IP) bounds volume, not impact. The endpoint
is intended demo functionality, but it means the product's core integrity asset is writable by
anonymous clients. Production needs provenance (authenticated trackers/extension attestation),
server-side fetch verification, or at minimum outlier rejection before a point enters stats.

### F-3 (Low, FIXED) — `ADMIN_TOKEN` compared with non-constant-time `!==`

> **Resolution:** the comparison now uses `crypto.timingSafeEqual` (with a length pre-check,
> which leaks only the token's length, not its content).

`src/server.js` `handleApi` (≈230–234): `req.headers['x-admin-token'] !== adminToken` is a
short-circuiting string comparison of a secret. Network jitter makes byte-position timing
recovery largely impractical, but a secret comparison should still be
`crypto.timingSafeEqual` over fixed-length digests of both values. (Contrast: B2B key lookup is
already timing-safe in practice because the presented key is SHA-256-hashed before the indexed
equality lookup — `src/db.js findApiKey`.)

### F-4 (Low, FIXED) — Log injection via percent-encoded control characters in the path

> **Resolution:** the access log now prints the path filtered to printable ASCII and capped at
> 200 characters.

`src/server.js handle` decodes the URL path (`decodeURIComponent(url.pathname)`, ≈132) and later
logs the decoded value in the access-log line (`console.log` in the `finally` block, ≈166). A request to
`/x%0a[fake log line]` or one containing ANSI escape sequences writes attacker-controlled
newlines/escapes into stdout logs, enabling forged entries or terminal escape tricks in whatever
consumes the logs. Fix: log the raw `req.url` or strip `[\x00-\x1f\x7f]` before logging.

### F-5 (Low, FIXED) — Malformed percent-encoding returns a 500 without security headers

> **Resolution:** security headers are applied before any parsing, and URL parsing/decoding now
> happens inside the guarded path, turning malformed encodings into a logged 400.

In `src/server.js handle`, `decodeURIComponent` (≈132) runs **before** the `try` block (≈137)
and before `applySecurityHeaders` (≈134 executes after decode succeeds). A request to `/%` (or
any invalid %-sequence) throws `URIError`, which is only caught by the outer
`handle(...).catch(...)` in `createApp` (≈336–342): the client gets a generic 500 JSON body with
**no CSP/security headers**, the error is mislabeled `[fatal handler error]`, and the request is
never access-logged (the `finally` is inside the skipped `try`). Should be a 400 handled inside
the normal error path. Not a crash — the rejection is caught — but wrong status, missing
headers, and log noise.

### F-6 (Info, ACCEPTED for prototype) — Rate-limit weakening under bucket-map saturation; IPv6 rotation

> **Resolution:** accepted as the right memory-vs-limiting trade-off for a localhost prototype;
> the production fix (IPv6 /64 keying + edge rate limiting) is tracked in the gaps section.

`src/security.js RateLimiter.prune` (≈57–70) correctly bounds memory (10k buckets; idle >10 min
pruned; else oldest 10% evicted), but eviction of an *active* bucket resets that client to full
burst capacity on its next request — so an address-rotation flood that saturates the map
degrades limiting for everyone rather than exhausting memory (the right trade-off, but worth
knowing). Separately, limiting is per exact `req.socket.remoteAddress`: an attacker with one
IPv6 /64 can rotate through effectively unlimited addresses, each earning a fresh bucket.
Production should key IPv6 clients by /64 prefix and sit behind an edge rate limiter.

---

## 1. Security posture summary

**Supply chain: zero runtime dependencies.** `package.json` declares `"dependencies": {}`; the
entire spine uses only Node >= 24 built-ins (`node:http`, `node:fs`, `node:path`,
`node:crypto`, `node:sqlite`). There is no `node_modules` at runtime, so the third-party attack
surface — typosquatting, hijacked maintainers, malicious postinstall scripts, transitive CVE
sprawl — is zero. The trusted computing base is the Node.js runtime itself plus this repo's
first-party code. The corollary obligation is a Node patching policy (see §4), because runtime
CVEs are the *only* upstream CVEs that can affect us.

**Privacy: data minimization as the primary control.** The system stores little about people, and
what it stores is purpose-bound. The full inventory of user-adjacent data (see `src/db.js`
SCHEMA):

- `alerts.email` — email addresses supplied voluntarily for price alerts.
- `accounts` — one row per purchasing email: the email, its entitlement `plan`
  (`free`/`premium`/`api`), and an optional Stripe customer id, written by a completed checkout
  (`src/db.js upsertAccount`, called from `src/billing.js applyEvent`). These are *entitlement*
  rows, not authenticated accounts: there are still no passwords, no sessions, and no cookies
  (the server never sets a `Set-Cookie` header anywhere).
- `billing_events` — a revenue-ledger row per applied Stripe event (type, plan, amount, currency,
  livemode, unique Stripe ref, and the purchaser email when Stripe supplies it).
- `pending_keys` — a transient, plaintext API key awaiting one-time claim after a paid API
  checkout; TTL-swept (§3.12).
- `api_keys` — SHA-256 hashes of B2B keys plus label, tier, and (for checkout-minted keys) the
  owner email and Stripe ref; never the raw key.
- No tracking identifiers and no client fingerprinting; the *browser* makes no third-party
  requests (the CSP forbids the frontend from reaching any other origin). The **server**,
  however, now does make outbound calls when the relevant env vars are configured — to Amadeus,
  Ticketmaster, an optional retail feed, and Stripe — so the earlier "no outbound/third-party
  network calls of any kind" claim no longer holds; see §3.15.
- Logs contain method, path, status, and latency only — no IPs, emails, keys, or query
  strings (`src/server.js handle`, final `console.log`; the `/go/` target URL lives in the
  query string, which is deliberately not logged).

What isn't collected can't be breached. The PII at rest (alert and account/purchaser emails, plus
any not-yet-claimed raw API key) is the top-listed production hardening item in §4.

## 2. Threat model (STRIDE-lite)

Assets worth protecting: **(a)** alert email addresses, **(b)** B2B API keys and their quota
accounting, **(c)** price data integrity (history, stats, scores — the product *is* this data),
**(d)** the admin key-minting capability, **(e)** availability of the service, **(f)** visitors'
browsers (XSS / redirect abuse), **(g)** PriceTruth's honesty reputation (estimates labeled as
estimates), **(h)** billing/revenue-ledger integrity and the paid entitlements it grants
(premium status, minted API keys) plus the upstream provider credentials.

| STRIDE | Threat (concrete) | Asset | Shipped control |
|---|---|---|---|
| **Spoofing** | Forged B2B identity to steal quota or read the API | B2B keys, quota | 192-bit random keys (`crypto.randomBytes(24)`), presented key hashed then looked up, unrevoked-only (`src/db.js createApiKey`/`findApiKey`); length gate 20–128 chars before hashing |
| **Spoofing** | Forged admin identity to mint keys | Admin capability | Route hard-disabled unless `ADMIN_TOKEN` env is set; header must equal it, now via `crypto.timingSafeEqual` (`src/server.js isAdmin` / `/api/admin/keys`; F-3 resolved, §3.14) |
| **Spoofing** | Forged Stripe webhook to grant premium or mint an API key | Entitlement, keys | Body read raw pre-parse; HMAC-SHA256 over `t.body` compared timing-safe against the `v1` signature, keyed by `STRIPE_WEBHOOK_SECRET`, with a 300 s freshness window; bad/absent/stale signature → 400 (`src/billing.js verifyWebhook`, §3.10) |
| **Tampering / Repudiation** | Replayed webhook double-counts revenue or re-mints keys | Revenue ledger | `billing_events.stripe_ref` UNIQUE + `INSERT OR IGNORE`; `recordBillingEvent` returns first-time/duplicate and `applyEvent` gates all side effects on it, so revenue **and** key issuance are insert-once (`src/db.js`, `src/billing.js`, §3.11). Residual: side effects not yet wrapped in one transaction (§4) |
| **Spoofing** | Alert signup with someone else's email | Alert emails | Weak today: format validation only, no ownership verification (demo sends no email, so impact is a DB row); double opt-in is a production requirement (§4) |
| **Tampering** | SQL injection via any input | All DB data | Every query is a prepared statement with bound parameters — there is no string-built SQL anywhere in `src/db.js` |
| **Tampering** | Poisoned price history skewing scores | Price integrity | Input validation (integer cents 0..1e9, product must exist, `true_cents` recomputed server-side by the engine, never client-supplied) + write rate limit — but submission is unauthenticated: **open finding F-2** |
| **Tampering** | Money corrupted by float drift or overflow | Price integrity | Integer-cents invariant enforced at every construction and sum (`src/engine/money.js assertCents`, `sum`, half-up `pctOf`) |
| **Tampering** | XSS / DOM injection in served pages | Visitors' browsers | Strict CSP (§3.1), HTML-escaping of all interpolated values in the two server-rendered outputs (§3.8) |
| **Info disclosure** | Stolen DB file leaks B2B keys | B2B keys | Only SHA-256 hashes stored; raw key shown exactly once at mint (`src/db.js createApiKey`, `src/keygen.js`) |
| **Info disclosure** | Stolen DB file leaks emails | Alert emails | *Not mitigated in the prototype* — plaintext in a local WAL SQLite file, gitignored (`.gitignore` `data/*.db*`); encryption at rest is a production TODO (§4) |
| **Info disclosure** | Path traversal reads files outside `public/` | Server filesystem | Resolve-then-prefix-check guard + extension allowlist (§3.7) |
| **Info disclosure** | Stack traces / internals leaked to clients | Internals | 500s return the fixed string `internal server error`; details go to server console only (`src/server.js handle` catch) |
| **DoS** | Request floods | Availability | Per-IP token buckets on all `/api/` and `/go/` routes: GET 120 burst / 2 per s, POST 20 burst / 0.2 per s, B2B additionally 30 burst / 0.5 per s per key+IP (`src/server.js createApp`); `Retry-After` on 429 |
| **DoS** | Memory exhaustion via limiter state | Availability | Bucket map capped at 10,000 with idle-pruning and oldest-eviction (`src/security.js RateLimiter.prune`); see F-6 |
| **DoS** | Oversized / malformed bodies | Availability | 32 KB JSON body cap with early `req.destroy()` (`src/security.js readJsonBody`); `context` additionally capped at 4 KB serialized (`src/server.js runAnalyze`); Node's built-in 16 KB header cap applies |
| **DoS** | Quota theft on B2B tier | Quota accounting | Daily metering in SQLite per key per day (`src/db.js meterUsage`), 429 over `starter` 100/day, `pro` 10k/day |
| **Elevation** | Public user mints API keys | Admin capability | 403 unless `ADMIN_TOKEN` set and matched; local minting is the documented path (`npm run keygen`) |
| **Elevation** | Free user exceeds alert limit | Paywall | Server-side count per email vs. limit; entitlement is `db.isPremium(email)` reading the `accounts` table (set only by a completed checkout), **not** a client-supplied flag — the old client `premium` bypass was removed and a regression test asserts `premium: true` in the body cannot lift the limit (`src/server.js` `/api/alerts`, §3.13) |
| **Repudiation-ish / honesty** | Estimates passed off as facts | Reputation | Every line item carries `certainty: listed\|typical\|estimated`; `confidence` degrades per non-listed item; `assumptions`/`disclosures` ride the report (`src/engine/analyze.js`) |

## 3. Implemented controls, mapped to code

### 3.1 Strict Content-Security-Policy

Sent on **every** response (API, static, HTML, errors on the normal path) via
`applySecurityHeaders`, called at the top of `src/server.js handle`. The exact policy
(`src/security.js`, `CSP` constant):

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none';
base-uri 'none'; form-action 'self'; frame-ancestors 'none'
```

What it blocks:

- `script-src 'self'` — no inline `<script>`, no `eval`/`new Function` (no `'unsafe-eval'`),
  no external CDNs. Injected markup cannot execute; all JS must be a same-origin file.
- `style-src 'self' 'unsafe-inline'` — inline `style=""` *attributes* allowed (a deliberate,
  narrow concession for the frontend); no external stylesheets. CSS-based exfiltration to
  third-party origins is blocked by the source list.
- `img-src 'self' data:` — no remote image beacons; inline SVG and data URIs work.
- `connect-src 'self'` — page JS cannot fetch/XHR/WebSocket anywhere but this origin: even a
  successful script injection has nowhere to send data.
- `object-src 'none'`, `base-uri 'none'` — no plugin content; `<base>` hijacking of relative
  URLs is impossible.
- `form-action 'self'` — forms cannot be re-pointed at attacker origins.
- `frame-ancestors 'none'` — no framing, so no clickjacking (belt to the
  `X-Frame-Options: DENY` suspenders).

### 3.2 Security headers

`src/security.js applySecurityHeaders`: `X-Content-Type-Options: nosniff` (no MIME sniffing),
`X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` (outbound clicks — including affiliate
continues — carry no referrer), `Permissions-Policy` denying camera/microphone/geolocation/
payment, `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`,
and `Cache-Control: no-store` on API responses so proxies and browser caches never retain API
data. Static assets get `no-cache` for `index.html` and `max-age=300` for the rest
(`src/server.js serveStatic`).

### 3.3 Rate limiting with bounded memory

`src/security.js RateLimiter` is a classic token bucket per client key: `check()` refills by
elapsed time, spends one token per request, and reports `retryAfterSec` (surfaced as a
`Retry-After` header, `src/server.js handle` and `handleB2b`). Instances
(`src/server.js createApp`): reads 120 burst / 2 per s, writes 20 burst / 0.2 per s, B2B
30 burst / 0.5 per s keyed `key:<id>:<ip>` *in addition to* the IP limiter and the daily quota.
Anti-memory-exhaustion: the map is capped at `maxBuckets` (10,000); on overflow, `prune()` drops
buckets idle over 10 minutes, then the oldest 10% by insertion order if still full — so an
address-rotation flood cannot grow the map without bound (residual weakening noted in F-6).
Static file requests are *not* rate-limited; they are cheap stat+stream operations and the
public surface is a handful of small files.

### 3.4 JSON body handling

`src/security.js readJsonBody`: 32 KB cap enforced incrementally while chunks arrive, with
`req.destroy()` on breach (the connection is torn down, not buffered); the parsed value must be
a plain JSON object (arrays and primitives rejected); parse failures are clean 400s. Nested
`context` payloads are further capped at 4,096 serialized characters in
`src/server.js runAnalyze`. No deep-merging of parsed input occurs anywhere, so
`__proto__`-style prototype-pollution gadgets have nothing to latch onto.

### 3.5 Input validation allowlists

`src/security.js validate` centralizes validators, all throwing typed `HttpError(400)`:
`cents` (safe integer 0..1e9), `int` (bounded), `string` (bounded length), `enum` (strict
allowlist — used for `vertical` and key `tier`), `email` (bounded-length regex, lowercased),
`id` (slug `^[a-z0-9][a-z0-9-]{0,63}$`). Route parameters are additionally constrained by the
route regexes themselves (`/^\/api\/products\/([a-z0-9-]{1,64})$/` etc. in `src/server.js`).
Engine-side, out-of-range context values raise `RangeError`/`TypeError`, which `runAnalyze`
converts to 400s rather than 500s. Unknown routes and unknown methods are 404/405, not
fall-throughs.

### 3.6 Money as integers, everywhere

`src/engine/money.js`: `assertCents` (safe integer, 0..1e9 = $10M cap) guards every line-item
construction (`src/engine/analyze.js item`) and every summation (`sum` asserts each addend).
Percentages round half-up exactly once (`pctOf`). `true_cents` stored by `/api/v1/track` is
recomputed server-side from the engine (`src/server.js` `handleB2b`), never accepted from the
client. Formatting to `$1,234.56` happens only at display edges (`fmtUSD`,
`centsToDollarsLabel`) via integer division and modulo — floats never touch stored or summed
money.

### 3.7 SQL, keys, admin, redirects, static files

- **Prepared statements only.** All SQL in the codebase lives in the `stmts` object of
  `src/db.js wrap`, prepared once and executed with bound parameters. There is no string
  interpolation into SQL. `PRAGMA foreign_keys = ON` enforces referential integrity;
  `journal_mode = WAL` keeps the local file consistent under concurrent reads.
- **API keys hashed, shown once.** `src/db.js createApiKey` mints
  `pt_<tier>_<base64url(24 random bytes)>` (192 bits of CSPRNG entropy), stores only the
  SHA-256 hex, and returns the raw key exactly once — to the keygen CLI (`src/keygen.js`), the
  seed CLI's demo key (`src/seed.js` main block; note the server's auto-seed on first boot
  mints *no* key), or the admin route's 201 body. `findApiKey` hashes the presented key and
  looks up the digest, with a 20–128 char length gate first.
- **Admin minting off by default.** `POST /api/admin/keys` returns 403 with a pointer to
  `npm run keygen` unless the `ADMIN_TOKEN` env var is set *and* the `X-Admin-Token` header
  matches — now a constant-time `crypto.timingSafeEqual` after a length pre-check
  (`src/server.js handleApi`; F-3 resolved, see §3.14). No token in the environment means the
  capability does not exist at runtime.
- **Affiliate open-redirect guard.** `GET /go/:partner` (`src/server.js handleAffiliate`)
  requires a known partner id (`src/data/partners.json`), an absolute parseable `target`,
  `protocol === 'https:'`, and `hostAllowed`: hostname lowercased, then exact match or
  dot-boundary suffix match (`host === d || host.endsWith('.' + d)`) — so `booking.com` and
  `www.booking.com` pass while `evilbooking.com` and `booking.com.evil.io` fail. The URL
  constructor punycodes hostnames before the check, closing homograph lookalikes. The result is
  not even an HTTP redirect: it is an interstitial page carrying the FTC affiliate disclosure,
  with the destination HTML-escaped into a `rel="noopener nofollow sponsored"` link.
- **Static path-traversal guard.** `src/server.js serveStatic` resolves the request against
  `public/` and rejects any result that does not start with `PUBLIC_DIR + path.sep` (403) —
  this catches `..` sequences (already decoded upstream, so `%2e%2e` is covered), absolute
  paths, and Windows drive-letter escapes. Only regular files with an extension in the `MIME`
  allowlist are served (dotfiles like `.gitignore` have no extname and 404); everything else,
  including the SQLite DB (outside `public/` anyway), is unreachable. Extensionless paths serve
  the SPA shell.

### 3.8 Output encoding and logs

`src/security.js escapeHtml` escapes `& < > " '`. It is applied to every interpolated value in
the only two server-rendered HTML outputs: the affiliate interstitial (partner label and
destination URL, `src/server.js interstitialHtml`) and the error page (`escapeHtml(message)` in
the `handle` catch). Everything else the server emits is `JSON.stringify`'d API JSON or static
files. Logs are minimal by design (see §1): no IPs, credentials, emails, or query strings; only
500-class errors print stack traces, and only to the server console (F-4 notes the
control-character caveat on the logged path).

### 3.9 Data at rest

Local SQLite file (`data/pricetruth.db` by default, `PRICETRUTH_DB` overrides —
`src/db.js open`) in WAL mode. The DB and its WAL/SHM sidecars are gitignored
(`.gitignore`), as are `.env*` files, so neither user data nor local secrets can be committed.
Demo data is deterministic synthetic history (`src/seed.js`, seeded LCG). Every product-backed
API response — public (`/api/products`, `/api/products/:id`) and B2B (`/api/v1/products/:id`,
`/api/v1/track`) — carries `demoData: true`. The `/api/analyze` and `/api/v1/analyze` routes
compute on caller-supplied inputs (not seeded data) and so carry no demo flag.

### 3.10 Stripe webhook signature verification

`POST /api/billing/webhook` is the one unauthenticated *state-changing* route, and its gate is a
signature, not a rate limiter. The handler (`src/server.js handleApi`, ≈395) reads the request
body with `readRawBody` (`src/security.js`, 1 MB cap) **before any JSON parsing** — signature
verification must run over the exact bytes received, so the raw text is captured first and only
the verified bytes are parsed. `billing.verifyWebhook` (`src/billing.js`) parses the
`Stripe-Signature` header (`t=<timestamp>,v1=<hmac>`), recomputes `HMAC-SHA256` over
`` `${t}.${rawBody}` `` keyed by `STRIPE_WEBHOOK_SECRET`, and compares it to the presented `v1`
with `crypto.timingSafeEqual` — length-checked first, so a wrong-length signature short-circuits
to a reject instead of throwing inside `timingSafeEqual`. It then rejects any timestamp whose
absolute skew from now exceeds a **300 s tolerance** (the replay window), and only then
`JSON.parse`s the verified body. A missing, malformed, forged, or stale signature throws a plain
`Error` carrying `err.status = 400`; the central error handler (`src/server.js handle` catch,
≈272) now honors a well-formed 4xx status carried on a plain `Error`, so these surface as a real
400 with the intended message rather than a generic 500. (A missing `STRIPE_WEBHOOK_SECRET` is a
500, and a Stripe API failure in outbound calls carries a 502 that — being non-4xx — falls
through to the generic 500 body.)

The route is **intentionally exempt from rate limiting** (`isWebhook` check, `src/server.js
handle`, ≈247): Stripe retries deliveries with backoff, and a 429 here would drop legitimate
billing events. This is a deliberate, bounded exemption — a single path whose only entry is
signature-gated — not a general hole. Honest note: `verifyWebhook` is a zero-dependency,
first-party reimplementation of Stripe's documented signing scheme, exercised end-to-end by a
`signPayload` → `verifyWebhook` round-trip test; it has not been cross-validated against Stripe's
official SDK, so treat it as a careful implementation of that check rather than a certified one.

### 3.11 Billing ledger idempotency / replay safety

`billing_events.stripe_ref` is declared `UNIQUE`, and `db.recordBillingEvent` inserts with
`INSERT OR IGNORE` and **returns whether a new row was actually written** (`src/db.js`). Stripe
delivers webhooks *at least once* and retries on backoff, so the same `checkout.session.completed`
event can legitimately arrive more than once; the unique-ref-plus-ignore means each distinct
event's revenue lands in the ledger **exactly once**. A captured webhook replayed by an attacker
would still have to pass the signature and 300 s freshness checks of §3.10, and even then
contributes no new ledger row.

`billing.applyEvent` uses that return value as its **idempotency gate for the whole handler**: on
a replay (`recordBillingEvent` returns `false`) it returns early with `{ duplicate: true }` and
performs no entitlement grant and no key minting. So both revenue *and* key issuance are now
insert-once — a redelivered API-plan event does not mint a second `api_keys` row. (This closes the
gap noted in earlier drafts.) Covered by tests: `test/db.test.js` asserts the first-time/duplicate
return; `test/billing.test.js` asserts a replayed API checkout mints no second key and a replayed
premium webhook does not double the gross; `test/api.test.js` exercises the same over HTTP.

Note the residual failure mode: because the ledger insert and the side effects are separate
statements (no wrapping transaction), a process crash *between* them on the very first delivery
would leave the event recorded but the key unminted, and the retry would then be treated as a
duplicate. In-process `node:sqlite` executes these synchronously back-to-back, so the window is
tiny; wrapping them in a transaction is the belt-and-suspenders improvement (still a §4 item).

### 3.12 Claim-once API-key issuance

A paid API-plan checkout (`api_starter` / `api_pro`) mints a key inside `billing.applyEvent`
(`src/billing.js`): `db.createApiKey` generates `pt_<tier>_<base64url(24 random bytes)>` (192 bits
of CSPRNG entropy), stores **only** its SHA-256 hash in `api_keys`, and returns the raw key. The
raw key is written to the `pending_keys` table keyed by the Stripe `session_id`
(`db.putPendingKey`) and handed back **exactly once** by `GET /api/billing/claim`, which validates
`session_id` against `^[A-Za-z0-9_]{6,200}$` and calls `db.takePendingKey` — a read-then-delete in
the same call (claim-once semantics). Unclaimed rows are swept on a TTL by `db.prunePendingKeys`
(default 24 h) from the 5-minute periodic sweep in `createApp` (`src/server.js`, ≈219–224). The
raw key is never logged and is never persisted anywhere except this one transient row.

Honest tradeoff: between checkout and claim (at most the 24 h TTL), the plaintext API key sits at
rest in `pending_keys` inside the SQLite file. This is the **only** place a raw key ever lives,
and it is deleted the instant it is claimed — an accepted tradeoff for a once-shown handoff a
buyer needs immediately after paying. But a DB file stolen during that window would expose any
not-yet-claimed keys in the clear. Encrypting the column or shortening the TTL is the production
hardening (§4).

### 3.13 Server-side entitlement (no client-trusted flags)

The premium alert paywall (`POST /api/alerts`, `src/server.js`) decides entitlement with
`db.isPremium(email)`, which reads the `accounts` table and returns true only when that email's
`plan` is exactly `premium` (`src/db.js`). Premium is set solely by a completed checkout —
`applyEvent` → `db.upsertAccount({ plan: 'premium' })` in live mode, or the labeled mock-checkout
flow locally — never by anything in the request body. An earlier demo build trusted a `premium`
boolean supplied by the client; that override was **removed**. A regression test asserts a request
carrying `premium: true` still gets the free limit (`test/api.test.js`, "a client-supplied premium
flag does NOT lift the limit"), and a companion test confirms a real mock checkout does lift it for
that email. Limits are server-side constants: `FREE_ALERT_LIMIT` (1) and `PREMIUM_ALERT_LIMIT`
(20); over-limit requests return a 402 with an upgrade pointer.

### 3.14 Admin authentication

Admin access hangs on the `ADMIN_TOKEN` env var, compared with `crypto.timingSafeEqual` after a
length pre-check (`isAdmin`, `src/server.js`, ≈116; the same inline check guards
`POST /api/admin/keys`). When `ADMIN_TOKEN` is unset the comparison can never pass, so
`GET /api/admin/metrics` returns 403 and key minting is disabled with a pointer to
`npm run keygen` — the capability does not exist at runtime without the env var. This is the
constant-time comparison F-3 called for, now applied to every admin *data* entry point. Precise
scope, so this is not overstated: the **data** endpoints (`/api/admin/metrics` and the mint route)
are token-gated; the **`/admin` HTML shell** (`admin.html`) is still served as an ordinary static
file with no server-side token check (`src/server.js serveStatic`, ≈566), because it carries no
data — it only holds the token in the tab's `sessionStorage` and forwards it as `X-Admin-Token`
when it fetches the gated metrics endpoint. No secrets are exposed by the metrics payload:
`providerStatus()` (`src/providers/index.js`) reports a boolean and a coarse kind label per
vertical (`{ <vertical>: { live: true|false, kind: 'live'|'dataset'|'fallback' } }`), never keys
or credentials — a regression test serializes the whole status object and asserts it matches no
`/secret|key|token|password/i` (`test/providers.test.js`).

### 3.15 Provider layer — SSRF surface and secret handling

Live search (`POST /api/search`) reaches out to third-party price sources through the provider
registry (`src/providers/index.js`). **Every upstream host is fixed and developer-configured, not
derived from user input:**

- **Amadeus** (hotels + flights): the host is `AMADEUS_HOST` or the hardcoded
  `https://test.api.amadeus.com` default (`src/providers/amadeus.js`). The user's free-text query
  is resolved to an allowlisted city code or a `^[A-Z]{3}$`-validated code / airport-code pair
  before it ever reaches a URL (`resolveCity` / `parseRoute`) — raw query text is never
  interpolated into an Amadeus request.
- **Ticketmaster**: the base is the hardcoded constant
  `https://app.ticketmaster.com/discovery/v2/events.json` (`src/providers/tickets.js`); the query
  is sent only as `&keyword=${encodeURIComponent(q)}`.
- **Retail**: the base is the **operator-set** `RETAIL_API_URL` env var (an operator config value,
  not a user-supplied URL), with the query appended as `q=${encodeURIComponent(q)}`
  (`src/providers/retail.js`).

So there is no user-controlled SSRF vector: a caller can influence a query-string parameter but
never the scheme, host, or path. All outbound requests go through `httpJson`
(`src/providers/http.js`), which wraps `fetch` in an `AbortController` timeout (6 s default; the
authenticated Amadeus calls use 8 s) and raises a 504 on timeout. Upstream errors are reported with
the host name only (`safeHost`), never the full URL — so the Ticketmaster `apikey` query parameter
and any bearer token stay out of error messages. All API credentials
(`AMADEUS_CLIENT_ID`/`AMADEUS_CLIENT_SECRET`, `TICKETMASTER_API_KEY`, `RETAIL_API_KEY`,
`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `ADMIN_TOKEN`) come only from env vars, are never
returned in any response, and are never logged; `.env*` files are gitignored (§3.9). Live provider
responses are trusted to be *well-formed* JSON: they are validated for a usable integer price
(`normalize` requires an integer `advertised_cents` ≥ 0; retail requires integer `price_cents`)
and any listing URL is accepted only when it begins with `https://`, but the payloads are not
otherwise deeply schema-checked (§4). A configured live source that fails degrades to a clearly
labeled estimate rather than throwing, and an estimate is never presented as live
(`searchListing`, `source`/`certainty` labels).

## 4. Honest gaps & production TODOs

Ordered roughly by how soon each bites.

1. **No TLS.** The prototype speaks plaintext HTTP. It now binds loopback by default and
   `0.0.0.0` only on a recognized hosted platform or with an explicit `HOST` (F-1 resolved), but
   it terminates no TLS of its own. Before any deployment: terminate TLS (or front with a
   TLS-terminating proxy), add `Strict-Transport-Security` with a sane `max-age` once HTTPS is
   stable, and redirect HTTP→HTTPS at the edge. B2B keys, the admin token, and the Stripe webhook
   secret's signatures travel in headers and are trivially sniffable without TLS.
2. **Entitlement exists, but there is still no user authentication.** Entitlement is now a
   real server-side check — `db.isPremium(email)` against the `accounts` table, set only by a
   completed checkout (§3.13), so the old client-asserted `premium` flag is gone. What remains
   missing is *authentication*: `accounts`/`alerts` are keyed by bare email with no proof of
   ownership, so anyone naming an email consumes its slots, and limits are per-email rather than
   per-account. Production needs real login, proof of email ownership, and per-account limits.
3. **Stripe customer ↔ email mapping is trust-on-first-use.** `applyEvent` takes the email and
   `customer` id straight from the checkout session and upserts them onto the account
   (`src/billing.js`, `src/db.js upsertAccount`); there is no independent verification that the
   paying party controls that email, and the billing-portal route resolves a customer purely by
   whatever email is presented (`/api/billing/portal`). Fine while the flow is Stripe-originated
   and no mail is sent, but it should be tied to an authenticated account (gap 2) before it gates
   anything of value.
4. **PII and secrets in plaintext at rest.** Alert, account, and purchaser emails
   (`alerts.email`, `accounts.email`, `billing_events.email`) and, transiently, a raw API key in
   `pending_keys` all sit unencrypted in the local WAL SQLite file. Acceptable in a local demo
   that never sends mail (the 201 alert response says exactly that) and hands a key back exactly
   once (§3.12). Production requirements: encryption at rest (full-disk at minimum; column-level
   preferred), **encrypt the `pending_keys.raw_key` column or shorten its TTL** so a stolen DB
   file can't leak unclaimed keys, **double opt-in** before an address is considered subscribed
   (also closes the sign-someone-else-up hole), one-click unsubscribe honored in every mail, and
   a retention/erasure story (delete on unsubscribe).
5. **Webhook side effects are not yet transactional (residual).** The insert-once *logic* is now
   in place — `applyEvent` gates entitlement grant and key minting on the ledger insert being
   fresh, so a replay mints no second key (§3.11, resolved). What remains is that the ledger
   insert and the side effects are separate statements with no wrapping transaction: a crash
   between them on first delivery could record the event while leaving the key unminted, after
   which the retry is treated as a duplicate. Wrap the record + side effects in a single
   transaction before billing real customers at volume.
6. **Live provider responses are trusted to be well-formed.** Upstream JSON is validated for a
   usable integer price and an `https://` URL (§3.15) but is not otherwise schema-checked, and
   there is no user-driven SSRF vector (hosts are fixed/operator-configured). Production should
   add stricter response validation and per-provider timeouts/circuit-breaking beyond today's
   single AbortController timeout and degrade-to-estimate fallback.
7. **No per-account billing audit trail beyond the ledger.** `billing_events` is an
   append-only revenue ledger, not an audit log of entitlement changes; there is no record of
   *who* was granted or revoked what, when, or by which event. Add a per-account entitlement
   history before support or dispute-handling depends on it.
8. **Hashing vs. constant-time comparison.** Plain SHA-256 of API keys is appropriate — the
   keys carry 192 bits of CSPRNG entropy, so offline brute-force of a stolen hash is hopeless
   and slow password hashes (bcrypt/argon2) would only add latency. The hash-then-lookup also
   makes the equality check effectively timing-safe for keys. The admin-token comparison is now
   `crypto.timingSafeEqual` (F-3 resolved, §3.14), and the Stripe webhook signature compare is
   likewise timing-safe (§3.10), so no plaintext-secret `!==` comparison remains.
9. **Rate limiting is per-process memory.** Restart clears every bucket; multiple instances
   would each grant a full allowance; there is no cross-node view. Production: shared store
   (Redis or equivalent) or edge limiting, keyed with IPv6 /64 awareness (F-6), plus derive
   client IP from the trusted proxy's `X-Forwarded-For` **only when** actually behind that
   proxy — today's code correctly ignores that spoofable header because it binds no proxy.
10. **No CSRF tokens — and why that is currently sound.** CSRF exploits ambient credentials the
   browser attaches automatically (cookies, HTTP auth). PriceTruth sets no cookies and has no
   session mechanism; the only credentials are explicit headers (`X-API-Key`,
   `X-Admin-Token`) that a cross-site form or fetch cannot forge onto a request. A cross-site
   attacker can make a victim's browser POST to an unauthenticated route like `/api/alerts` —
   but gains nothing over sending the same request directly (tracking now requires an explicit
   `X-API-Key`, which cross-site requests cannot attach; see F-2). **This stops
   being moot the day cookie-based sessions land** (gap 2): at that point add SameSite=Lax/
   Strict cookies, origin/Referer checks, and CSRF tokens on state-changing routes, in that
   order.
11. **No API-key revocation path.** The schema supports it (`api_keys.revoked`, filtered by
   `findApiKey`), but no route or CLI sets it — revoking today means manual SQL. Ship a
   `keygen --revoke` or admin route before issuing keys to real customers.
12. **Node runtime patching policy.** With zero dependencies, the runtime *is* the supply
   chain. Policy: track the active Node LTS line, apply Node security releases within 7 days of
   advisory publication (same-day for network-facing CVEs in `http`/`tls`/`zlib`), and pin the
   deployed minor version so upgrades are deliberate. `package.json` already enforces
   `"node": ">=24"`.
13. **No container/deploy hardening yet.** There is no Dockerfile or deploy config to audit.
   When one exists: non-root user, read-only filesystem except the data directory, health
   checks on `/api/health`, resource limits, explicit socket timeouts for slow-loris resilience
   (today only Node's defaults — `headersTimeout`/`requestTimeout` — apply), and a real access
   log with the F-4 control-character stripping baked in.
14. **History-poisoning provenance** (F-2) remains open. Anonymous poisoning is already closed
    (tracking requires `X-API-Key` and a plausibility band; malformed-URL handling F-5 also
    shipped), and live search now records real observations (§3.15) — but neither attests the
    *provenance* of an observed price nor does independent server-side fetch verification, so a
    keyed client or a misbehaving upstream can still nudge history within the plausible band.
    Production wants signed/attested trackers and price re-verification before a point enters
    stats.

## 5. Responsible disclosure

Prototype-stage stub; a real policy page ships with the first public deployment.

- **Contact:** `security@pricetruth.example` (placeholder — this domain is not yet live; until
  then, open a private issue with the maintainer).
- **Coordinated disclosure:** we ask for **90 days** from report to public disclosure, and we
  commit to acknowledging reports within 5 business days and shipping or scheduling a fix
  within the window. If we need more time we will say so and negotiate, not stall.
- **No bounty program yet.** We will credit reporters in release notes if desired.
- **Safe harbor:** good-faith testing against your own local instance is always fine (it is a
  local prototype — please do exactly that). Do not test instances you do not operate, access
  data that is not yours, or degrade service for others.

---

*Last audited: 2026-08-21 against the v0.1.0 spine; monetization + live-data layers
(`src/billing.js`, `src/providers/*`) audited 2026-08-24. Re-audit whenever `src/**` changes.*
