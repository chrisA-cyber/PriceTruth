# PriceTruth — Security Documentation

**Scope:** this document was produced by auditing the actual spine code (`src/server.js`,
`src/security.js`, `src/db.js`, `src/keygen.js`, `src/seed.js`, `src/engine/*`,
`src/data/partners.json`) at version 0.1.0. Every claim below cites the implementation.
Line references are approximate and may drift as files change; function names are stable anchors.

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

**Privacy: data minimization as the primary control.** The system stores almost nothing about
people. The full inventory of user-adjacent data (see `src/db.js` SCHEMA):

- `alerts.email` — the only PII in the system, supplied voluntarily for price alerts.
- `api_keys` — SHA-256 hashes of B2B keys plus an operator-chosen label; never the raw key.
- No accounts, no passwords, no sessions, no cookies (the server never sets a `Set-Cookie`
  header anywhere), no tracking identifiers, no client fingerprinting, no third-party
  requests of any kind (the CSP even forbids the *frontend* from making them).
- Logs contain method, path, status, and latency only — no IPs, emails, keys, or query
  strings (`src/server.js handle`, final `console.log`; the `/go/` target URL lives in the
  query string, which is deliberately not logged).

What isn't collected can't be breached. The remaining PII (alert emails) is the top-listed
production hardening item in §4.

## 2. Threat model (STRIDE-lite)

Assets worth protecting: **(a)** alert email addresses, **(b)** B2B API keys and their quota
accounting, **(c)** price data integrity (history, stats, scores — the product *is* this data),
**(d)** the admin key-minting capability, **(e)** availability of the service, **(f)** visitors'
browsers (XSS / redirect abuse), **(g)** PriceTruth's honesty reputation (estimates labeled as
estimates).

| STRIDE | Threat (concrete) | Asset | Shipped control |
|---|---|---|---|
| **Spoofing** | Forged B2B identity to steal quota or read the API | B2B keys, quota | 192-bit random keys (`crypto.randomBytes(24)`), presented key hashed then looked up, unrevoked-only (`src/db.js createApiKey`/`findApiKey`); length gate 20–128 chars before hashing |
| **Spoofing** | Forged admin identity to mint keys | Admin capability | Route hard-disabled unless `ADMIN_TOKEN` env is set; header must equal it (`src/server.js` `/api/admin/keys`); see F-3 for the comparison caveat |
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
| **Elevation** | Free user exceeds alert limit | Paywall | Server-side count per email vs. limit — but the `premium` flag is client-asserted, an explicitly commented demo stand-in for a real account check (`src/server.js` `/api/alerts`) |
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
  matches (`src/server.js handleApi`; comparison caveat in F-3). No token in the environment
  means the capability does not exist at runtime.
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

## 4. Honest gaps & production TODOs

Ordered roughly by how soon each bites.

1. **No TLS.** The prototype speaks plaintext HTTP and (per F-1) currently binds all
   interfaces. Before any deployment: bind explicitly, terminate TLS (or front with a
   TLS-terminating proxy), add `Strict-Transport-Security` with a sane `max-age` once HTTPS is
   stable, and redirect HTTP→HTTPS at the edge. B2B keys and the admin token travel in headers
   and are trivially sniffable without TLS.
2. **No user accounts or authentication.** Alerts are keyed by bare email; anyone naming an
   email consumes its free-alert slot, and the `premium` flag is client-asserted (an explicitly
   commented demo stand-in, `src/server.js` `/api/alerts`). Production needs real accounts, a
   real entitlement check, and per-account rather than per-email limits.
3. **Alert emails in plaintext** (`alerts.email`, `src/db.js`). Acceptable in a local demo
   that never sends mail (the 201 response says exactly that). Production requirements:
   encryption at rest (full-disk at minimum; column-level preferred), **double opt-in** before
   an address is considered subscribed (also closes the sign-someone-else-up hole), one-click
   unsubscribe honored in every mail, and a retention/erasure story (delete on unsubscribe).
4. **Hashing vs. constant-time comparison.** Plain SHA-256 of API keys is appropriate — the
   keys carry 192 bits of CSPRNG entropy, so offline brute-force of a stolen hash is hopeless
   and slow password hashes (bcrypt/argon2) would only add latency. The hash-then-lookup also
   makes the equality check effectively timing-safe for keys. The one direct secret comparison
   that should become `crypto.timingSafeEqual` is the admin token (F-3).
5. **Rate limiting is per-process memory.** Restart clears every bucket; multiple instances
   would each grant a full allowance; there is no cross-node view. Production: shared store
   (Redis or equivalent) or edge limiting, keyed with IPv6 /64 awareness (F-6), plus derive
   client IP from the trusted proxy's `X-Forwarded-For` **only when** actually behind that
   proxy — today's code correctly ignores that spoofable header because it binds no proxy.
6. **No CSRF tokens — and why that is currently sound.** CSRF exploits ambient credentials the
   browser attaches automatically (cookies, HTTP auth). PriceTruth sets no cookies and has no
   session mechanism; the only credentials are explicit headers (`X-API-Key`,
   `X-Admin-Token`) that a cross-site form or fetch cannot forge onto a request. A cross-site
   attacker can make a victim's browser POST to an unauthenticated route like `/api/alerts` —
   but gains nothing over sending the same request directly (tracking now requires an explicit
   `X-API-Key`, which cross-site requests cannot attach; see F-2). **This stops
   being moot the day cookie-based sessions land** (gap 2): at that point add SameSite=Lax/
   Strict cookies, origin/Referer checks, and CSRF tokens on state-changing routes, in that
   order.
7. **No API-key revocation path.** The schema supports it (`api_keys.revoked`, filtered by
   `findApiKey`), but no route or CLI sets it — revoking today means manual SQL. Ship a
   `keygen --revoke` or admin route before issuing keys to real customers.
8. **Node runtime patching policy.** With zero dependencies, the runtime *is* the supply
   chain. Policy: track the active Node LTS line, apply Node security releases within 7 days of
   advisory publication (same-day for network-facing CVEs in `http`/`tls`/`zlib`), and pin the
   deployed minor version so upgrades are deliberate. `package.json` already enforces
   `"node": ">=24"`.
9. **No container/deploy hardening yet.** There is no Dockerfile or deploy config to audit.
   When one exists: non-root user, read-only filesystem except the data directory, health
   checks on `/api/health`, resource limits, explicit socket timeouts for slow-loris resilience
   (today only Node's defaults — `headersTimeout`/`requestTimeout` — apply), and a real access
   log with the F-4 control-character stripping baked in.
10. **Malformed-URL handling** (F-5) and **history-poisoning provenance** (F-2) are code-level
    fixes queued behind the spine freeze.

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

*Last audited: 2026-08-21, against the v0.1.0 spine. Re-audit whenever `src/**` changes.*
