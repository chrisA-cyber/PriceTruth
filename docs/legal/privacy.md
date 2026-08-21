# Privacy Policy — PriceTruth (prototype)

**Effective date:** 2026-08-21 (prototype draft)
**Operator:** PriceTruth (prototype), operated by [COMPANY ENTITY]
**Contact:** [CONTACT EMAIL]

> **Prototype notice.** PriceTruth is a working product prototype. It ships with
> demo data, runs against a local database, and has no production infrastructure.
> This policy describes what the software actually does today, and flags where a
> production deployment would need more. It is not legal advice.

## The short version

- We do not have user accounts, and we do not want your data.
- The **only** personal data this software stores is an **email address** — and
  only if you choose to create a price alert.
- No cookies. No trackers. No analytics. No third-party requests of any kind.
- We never sell or share personal data.
- Ask us to delete your alert email and we will.

## What we collect, and when

**Price alerts (the only personal data).** If you create a price alert, we store
the email address you enter, the product you chose, and your price threshold, so
we can tell you when the true price drops below it. That is the entire record.
It is collected only when you submit the alert form — browsing, analyzing
prices, and viewing history collect nothing.

In the current prototype, alerts are stored but **no email is ever sent** — there
is no mail provider connected. A production version would send alert emails only
after double opt-in confirmation (see "Changes" below and our internal
compliance memo).

**B2B API keys.** Partners using the commercial API get an API key. We store a
label they choose (typically a company or project name), the key's tier, and a
daily usage count. The key itself is stored only as a SHA-256 hash — we cannot
recover it, and it never appears in logs.

**What we do *not* collect:**

- No accounts, usernames, passwords, or profiles.
- No cookies of any kind — the server never sets one.
- No analytics, pixels, fingerprinting, or session recording.
- No third-party requests: every script, style, and image is served from our own
  origin, and our Content-Security-Policy blocks everything else. Our server
  makes no outbound network calls.
- No IP address logging. IP addresses are used transiently, in memory only, for
  rate limiting (abuse prevention), and are discarded within minutes. They are
  never written to disk.
- No query strings or search terms in logs. Our access log records only the
  HTTP method, path, status code, and response time.
- Our pages send a `Referrer-Policy: no-referrer` header, so outbound clicks do
  not tell the destination site what you were looking at here.

## Why we collect it (purpose and lawful basis)

The alert email exists for exactly one purpose: sending you the price alert you
asked for. We do not use it for marketing, do not enrich it, and do not combine
it with other data (there is no other data).

Where GDPR-style analysis applies, the lawful basis is **consent** (GDPR
Art. 6(1)(a)): you type your email into the alert form and submit it. You can
withdraw consent at any time by asking us to delete the alert.

## Where it lives

All data is stored in a local SQLite database file on the machine running the
prototype. There are no cloud databases, no third-party processors, and no
international transfers — the data never leaves the server it was submitted to.

## No sale, no sharing

We do not sell personal information. We do not share it with third parties. We
do not disclose it to advertisers, data brokers, or affiliate partners. Our
affiliate links (see the [Affiliate Disclosure](affiliate-disclosure.md)) carry
a partner tag, never your personal data.

## Retention and deletion

Alert records are kept while the alert is active. This prototype has no
automated retention schedule yet; a production deployment would delete alerts
after a defined inactivity period and would document that period here.

**Deletion on request:** email [CONTACT EMAIL] from the address on the alert
and we will delete every record tied to it. In the prototype, deletion means
removing the rows from the local database (and, because the prototype is
self-hosted, whoever runs the instance can simply delete the database file).

## Your rights

### GDPR (EU/EEA/UK visitors)

This prototype is not marketed to, or intended for, the EU public, and it does
not meet the scale where most GDPR machinery applies — but we honor its
principles by design:

- **Right of access:** ask [CONTACT EMAIL] and we will tell you exactly what we
  hold about your email address (at most: the address, alert product(s), and
  threshold(s)).
- **Right to erasure:** ask and we delete it, as described above.
- **Data minimization:** we built the system so there is almost nothing to
  request. No profiling, no automated decision-making with legal effect, no
  special-category data.

A production EU-facing deployment would name a controller ([COMPANY ENTITY]),
document processors, and provide a supervisory-authority complaint route.

### CCPA/CPRA (California visitors)

The prototype does not meet the CCPA's business thresholds, but our practices
already exceed its requirements:

- **We do not sell personal information and we do not "share" it** for
  cross-context behavioral advertising. There is nothing to opt out of.
- **Right to know:** same as access above — request at [CONTACT EMAIL].
- **Right to delete:** same as deletion above.
- We do not discriminate against anyone for exercising these rights.

## Children's privacy

PriceTruth is a price-analysis tool for people making purchases; it is not
directed to children under 13 (or the applicable age in your region), and we do
not knowingly collect personal information from children. If you believe a
child has submitted an email address, contact [CONTACT EMAIL] and we will
delete it.

## Changes to this policy

If the prototype grows into a product, this policy will change — for example, a
production version would add a mail provider (a data processor), double opt-in
for alerts, and a real retention schedule. Changes will be posted here with a
new effective date. Material changes to how alert emails are used would require
fresh consent, not a silent policy edit.

## Contact

Questions, access requests, or deletion requests: **[CONTACT EMAIL]**
Operator of record: **[COMPANY ENTITY]** (placeholder — the prototype has no
legal entity yet).
