# PriceTruth — Internal Interface Contracts

Ground truth for everyone working in this repo. The spine (engine, db, server) is
built and tested; build against these contracts, do not change them.

## Stack rules

- **Zero runtime dependencies.** Node >= 24, ES modules (`"type": "module"`), built-in `node:sqlite`.
- All money is **integer USD cents** end to end. Format only at the display edge.
- Server: `npm start` → http://localhost:4780 (env `PORT` overrides). Auto-seeds demo data on first boot.
- Tests: `npm test` (node:test, files in `test/`). Seed: `npm run seed`. Keys: `npm run keygen -- "label" starter|pro`.
- Honesty is a product rule: every projected number carries `certainty` and the UI must label non-listed values as estimates. Demo data is labeled demo data.

## File ownership (do not write outside your area)

| Area | Paths |
|---|---|
| Spine (done, read-only) | `src/**`, `package.json`, `.gitignore` |
| Frontend | `public/**` except `public/legal.html` |
| Legal | `docs/legal/**`, `public/legal.html` |
| Tests | `test/**` |
| Extension | `extension/**` |
| Business docs | `docs/BUSINESS.md`, `docs/API.md` |
| Security docs | `docs/SECURITY.md` |
| README | root `README.md` (spine author) |

## HTTP API

All JSON. Public routes are rate-limited per IP (GET ~120 burst, POST ~20 burst — tests should stay under or create fresh app instances).

| Route | Req | Resp (200 unless noted) |
|---|---|---|
| `GET /api/health` | — | `{ok, version}` |
| `GET /api/meta` | — | `{name, version, currency, demoData, verticals[], options:{hotelMarkets, flightCarriers, ticketPlatforms, subscriptionPatterns}, partners}` — each option map is `{id: label}` for dropdowns |
| `POST /api/analyze` | `{vertical, advertised_cents, context?}` | `Report` (below); 400 on bad input |
| `GET /api/products` | — | `{products: [ProductPayload], demoData: true}` |
| `GET /api/products/:id?days=30\|90` | — | `ProductPayload & {history: [{ts, advertised_cents, true_cents}], demoData}` ; 404 unknown |
| `GET /api/history/:id?days=30\|90` | — | `{points, stats, days}` |
| `POST /api/v1/track` | header `X-API-Key`; `{product_id, advertised_cents}` | 201 `{tracked, true_cents, usage}`; 422 outside the 0.25×–4× plausibility band (history-poisoning guard) |
| `POST /api/alerts` | `{email, product_id, threshold_cents, premium?}` | 201 `{created, note}`; **402** `{error, upgrade}` when free limit (1) hit — this is the premium paywall |
| `POST /api/admin/keys` | header `X-Admin-Token` = env `ADMIN_TOKEN`; `{label, tier}` | 201 `{key,…}`; 403 if env unset |
| `POST /api/v1/analyze` | header `X-API-Key`; same body as analyze | `Report & {usage:{used_today, daily_limit, tier}}`; 401 bad key; 429 over quota (starter 100/day, pro 10k/day) |
| `GET /api/v1/products/:id` | header `X-API-Key` | `ProductPayload & {history, usage}` |
| `GET /api/v1/usage` | header `X-API-Key` | `{usage}` |
| `GET /go/:partner?target=<https url>` | — | 200 HTML affiliate interstitial with disclosure; 400 non-https or hostname not in partner allowlist; 404 unknown partner |

`ProductPayload = { product:{id, vertical, name, url}, report: Report, stats: {days, n, low_cents, high_cents, avg_cents} | null, score: {score:0-100|null, label, reasons[]} }`

## Report schema (`src/engine/analyze.js`)

```js
{
  vertical: 'hotel'|'flight'|'ticket'|'subscription'|'retail',
  currency: 'USD',
  advertised: { amount_cents, unit },       // per_night | per_fare | per_ticket | per_month | total
  truePrice: { amount_cents, unit },        // per_night | per_fare | checkout_total | first_year | total
  total: { amount_cents, label } | null,    // e.g. "3-night stay total", "First-year cost"
  lineItems: [{ code, label, amount_cents, kind: 'base'|'fee'|'tax'|'addon',
                certainty: 'listed'|'estimated'|'typical', note? }],
  feeLoadPct: number,                        // hidden-cost % over advertised
  confidence: 0.35–1,
  assumptions: [string],
  disclosures: [string],
}
```

Demo products (seeded, use these ids): `vegas-hotel` ($219 → $317/night), `lcc-flight` ($189 → $294),
`arena-ticket` ($86 → $134 checkout), `stream-sub` ($9.99/mo → $179.88 first year), `anc-headphones`
(retail, rich 90-day history: today $299, 30-day low $219, high $319).

## Frontend constraints (CSP is enforced by the server)

- `script-src 'self'` — **no inline `<script>`**, no eval, no external CDNs. All JS in `/app.js` (plus extra self-hosted files if needed).
- Styles: external stylesheet `/styles.css`; inline `style=""` attributes allowed. No external fonts — system font stack.
- `img-src 'self' data:` — inline SVG elements and data: URIs fine.
- Static files live in `public/`; extensionless GETs serve `index.html` (SPA routing works); `.html .css .js .json .svg .png .ico .txt .webmanifest` are the servable types.
- Design: **glance-first** — the big REAL PRICE verdict before the breakdown; details expandable below. Label every `typical`/`estimated` line as an estimate. Light + dark via `prefers-color-scheme`. Footer links `/legal.html` and affiliate disclosure. Mark demo data as demo.
- Currency renderer must use integer-cents → string (`$1,234.56`); never float math.

## Affiliate partners (`src/data/partners.json`)

ids: `booking, expedia, hotels, kayak, ticketmaster, stubhub, spirit, example`. Frontend links use
`/go/<partner>?target=<encoded https url>` — never link partner sites directly (the interstitial carries the FTC disclosure).
