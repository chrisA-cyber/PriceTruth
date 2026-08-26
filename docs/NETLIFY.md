# Netlify deployment

PriceTruth can use Netlify as its public frontend and CDN while preserving the
existing durable Node service as the backend. This is the supported Netlify
topology for the current release.

It is intentionally **not** packaged as a standalone Netlify Functions app.
The application writes transactional account, billing, alert, job, and price
history state to SQLite and runs an in-process worker. Netlify Functions run in
ephemeral, automatically scaled runtimes, so a writable SQLite file and a
permanent `setInterval` worker would lose state or execute inconsistently.

## Supported topology

```text
Browser
  -> Netlify static frontend
       -> /api/*, /go/*, /download/*, /billing/*
            -> durable PriceTruth Node backend (Render, Fly.io, Railway, etc.)
                 -> persistent SQLite volume + worker
```

The build generates route-specific canonical metadata plus `robots.txt` and
`sitemap.xml` from the canonical public Netlify origin.

## Deploy from GitHub

1. Deploy the durable backend first using `render.production.yaml`, the
   container workflow in `DEPLOYMENT.md`, or another long-lived Node host with a
   persistent volume.
2. Create a Netlify site from this GitHub repository. Netlify reads
   `netlify.toml`; do not override its build command or publish directory.
3. In the Netlify build environment, set:

   ```text
   PRICETRUTH_BACKEND_ORIGIN=https://the-durable-backend-host
   ```

   The value must be a public, origin-only HTTPS URL. It is not a secret, but it
   must not be the Netlify site URL or the rewrite would loop.
   Netlify supplies its primary `URL` automatically. If a custom domain is not
   yet reflected there, also set
   `PRICETRUTH_SITE_ORIGIN=https://the-final-public-domain`.
4. On the backend, set:

   ```text
   PUBLIC_BASE_URL=https://the-final-netlify-domain
   TRUST_PROXY=1
   ```

   Keep every other production secret on the backend. Do not copy Stripe,
   Resend, database, provider, encryption, or administrator secrets into the
   Netlify build environment.
   Configure Stripe and Resend webhook destinations against the durable backend
   URL directly; their signatures remain authoritative and they should not
   depend on the public CDN proxy.
5. Deploy `main`. Netlify runs `npm run build:netlify` and publishes
   `dist/netlify`.
6. Run the remote gate against the Netlify URL:

   ```text
   npm run deploy:verify -- --base-url=https://the-final-netlify-domain
   ```

## Fail-closed behavior

`npm run build:netlify` refuses to publish when the backend or public site
origin is missing, invalid, non-HTTPS, private, or when the backend equals a
Netlify deployment origin. A static-only
deployment would render the shell while silently breaking searches, accounts,
alerts, billing, API access, extension downloads, and webhooks, so that mode is
not offered as a production option.

External Netlify proxy rewrites have a platform timeout. PriceTruth provider
budgets and synchronous routes are below that boundary, but slow collection and
email work remain on the durable backend worker.

## Fully Netlify-native future option

A standalone deployment is possible only after a separate migration:

1. replace writable SQLite with Netlify Database (Postgres) or another managed
   Postgres service;
2. convert the raw Node HTTP handler into request-scoped Netlify Functions;
3. split collection, outbox delivery, alerts, retention, and digests into
   scheduled/background workloads with durable leases;
4. re-run billing, webhook idempotency, privacy-erasure, and concurrency testing
   against the new database and worker model.

Do not place the existing SQLite database in a Function bundle or `/tmp`; those
files are not durable shared application state.
