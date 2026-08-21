# Compliance Posture Memo — PriceTruth (prototype)

**To:** PriceTruth team (internal)
**From:** Product / compliance
**Date:** 2026-08-21
**Re:** Regulatory landscape, how the product relates to it, and what production needs

> Internal working memo, not legal advice. Positions here are grounded in what
> the code actually does as of this date; counsel review is a launch gate
> (checklist, bottom).

---

## 1. FTC Rule on Unfair or Deceptive Fees (16 CFR Part 464)

**What it is.** The FTC's "junk fees" rule, in force since May 2025. It covers
**live-event tickets and short-term lodging** (hotels, vacation rentals): the
advertised price must be the **all-in total** — inclusive of all mandatory fees
and charges — displayed at least as prominently as any other price. Government
taxes and reasonable shipping may be excluded from the headline number but must
be disclosed before checkout, and no fee may be misrepresented.

**How PriceTruth relates — two roles:**

1. **Compliance verification.** Our hotel and ticket verticals compute exactly
   the delta Part 464 targets: advertised price vs. true all-in price
   (`feeLoadPct` in every report). Where a covered seller advertises $86 and
   checkout is $134, that gap is now not just consumer-hostile, it is
   presumptively a rule violation. PriceTruth's breakdowns are, in effect, a
   Part 464 audit trail — useful to consumers, journalists, and (as a B2B
   product) to sellers checking their own funnels.

2. **Covering what the rule doesn't.** Part 464 deliberately stops at tickets
   and lodging. PriceTruth's other verticals live in the gap:
   - **Airline ancillaries** — outside FTC jurisdiction (see DOT, §3).
   - **Subscription teaser pricing** — first-year vs. advertised monthly rate
     (see §2).
   - **General retail** — drip pricing and inflated-reference pricing remain
     governed only by FTC Act §5's general deception standard.

   Positioning note: this is the product story — "the rule fixed two verticals;
   we cover the rest" — and it is accurate. Keep it in marketing only in this
   form; never imply the rule covers more than it does.

**Obligation on us:** minimal today (we sell nothing covered). If PriceTruth
ever displays covered sellers' prices in an advertising-like context, our
displayed headline numbers should themselves be all-in — which they already
are, by design.

## 2. FTC Negative Option Rule ("click-to-cancel", 16 CFR Part 425)

**Status — handle with care.** The FTC finalized the amended rule in late 2024,
but the **Eighth Circuit vacated it in July 2025** on procedural grounds before
its main provisions took effect. Negative-option marketing is still policed
under ROSCA, FTC Act §5, and increasingly strict state auto-renewal laws
(California's, notably), and the FTC may re-promulgate. Do not claim in product
copy that "click-to-cancel is the law"; the accurate framing is that regulators
are actively targeting subscription traps and enforcement continues under
existing statutes.

**Relevance to us.** The subscription vertical models precisely the harms the
rule targeted: teaser rates that step up, "free" trials that convert, and
first-year cost vs. advertised monthly price. Our `first_year` true-price unit
is the honest number ROSCA-style disclosure requires. If we ever sell our own
premium subscription (the $4/month alert tier is currently a demo paywall with
no payment collected), **we** become a negative-option seller and must ship:
clear pre-consent disclosure of renewal terms, express informed consent, and
cancellation as easy as signup.

## 3. DOT full-fare rule (airfare)

Airline price advertising is DOT's turf, not the FTC's. Under 14 CFR 399.84,
an advertised airfare must already include mandatory taxes and government fees
— so the "hidden" money in air travel is **ancillaries**: bags, seat selection,
boarding order, changes. That is exactly what our flight vertical estimates
(the $189 fare that becomes $294 with a bag and a seat is legal advertising —
and still a real consumer surprise). DOT's separate ancillary-fee transparency
rulemaking has been tied up in litigation; track it, but our value does not
depend on it. As with §1: we analyze fares, we do not advertise them; if we
ever display fares promotionally, the displayed fare must be full-fare
compliant — which our true-price framing already exceeds.

## 4. Alert emails: CAN-SPAM and double opt-in (production plan)

Today the prototype stores alerts and **sends nothing** (no mail provider is
wired; the API response says so explicitly). Before production sends a single
email:

- **Double opt-in.** Confirmation email with a verification link; no alert
  fires until confirmed. This kills typo'd/malicious third-party signups (the
  API currently accepts any syntactically valid address) and creates the
  consent record GDPR wants.
- **CAN-SPAM baseline**, even though requested price alerts are plausibly
  transactional: accurate header/from and subject lines, functional one-click
  unsubscribe in every message honored promptly (statute allows 10 business
  days; do it immediately), sender's physical postal address in the footer
  ([COMPANY ENTITY]'s — another reason the entity must exist first), and no
  further mail after opt-out.
- **Scope discipline.** Alert emails contain the alert. Any marketing content
  makes the message commercial and needs its own consent; default to never.
- Unsubscribe = delete the alert row, consistent with the privacy policy's
  deletion promise.

## 5. Data-protection posture: minimization by design

The strongest compliance position we hold, because it is enforced by code, not
policy:

- Only personal datum stored: alert email (+ product, threshold). SQLite, local
  file, no cloud, no processors, no transfers.
- No accounts, no cookies, no analytics, no third-party requests (CSP
  `default-src 'self'`; server makes zero outbound calls).
- Access logs contain method, path, status, duration — **no IPs, no query
  strings**. IPs live only in in-memory rate-limit buckets, pruned in minutes.
- B2B keys stored as SHA-256 hashes; raw key shown once at mint.
- `Referrer-Policy: no-referrer` — outbound clicks leak nothing.

Consequence: GDPR/CCPA exposure is minimal and honest — see `privacy.md`. Keep
it this way; every new datum added to the schema is a compliance decision, not
just an engineering one.

## 6. Affiliate program (16 CFR Part 255)

Covered in `affiliate-disclosure.md`. The structural guarantees: mandatory
interstitial disclosure on every `/go` link, `rel="sponsored"`, partner
allowlist, and — the substantive one — scores/prices computed with no partner
input. When real programs are signed, each network's own disclosure and
brand-usage terms must be checked, and the disclosure page must name programs.

## 7. Production-readiness compliance checklist

Gates before anything real launches:

- [ ] Form [COMPANY ENTITY]; put real entity name, contact email, and postal
      address into privacy.md, terms.md, affiliate-disclosure.md, legal.html.
- [ ] Counsel review of Terms (esp. liability cap, governing law/venue) and
      Privacy Policy; fix [GOVERNING LAW JURISDICTION]/[VENUE].
- [ ] Mail provider selected; DPA signed; double opt-in + one-click
      unsubscribe implemented and tested; postal address in footer.
- [ ] Alert retention schedule defined, documented in privacy.md, enforced by
      a cleanup job; DSAR (access/deletion) handling process written down.
- [ ] TLS termination, backups (encrypted, retention-limited), and a breach
      response plan for the one table with personal data.
- [ ] Verify logs stay IP/query-free through any hosting/CDN layer added in
      front (a CDN's default access logs would silently break §5's claims).
- [ ] Affiliate networks signed; per-network compliance checked; disclosure
      page updated with named programs.
- [ ] If premium alerts become a real paid subscription: ROSCA/state
      auto-renewal compliance (disclosure, consent, easy cancel) before first
      charge.
- [ ] State privacy law scan at real traffic volumes (CCPA/CPRA thresholds,
      Virginia, Colorado, etc.); COPPA n/a but keep the children's-privacy
      statement true.
- [ ] Accuracy substantiation file: keep fee datasets sourced and dated so
      "typical fee" claims can be defended; label freshness in-product.
- [ ] Monitoring: Part 464 enforcement actions, Negative Option Rule
      re-promulgation, DOT ancillary rulemaking — quarterly review.

## 8. Standing product rule

Honesty is the compliance strategy. Every projected number carries `certainty`
and confidence; demo data is labeled demo; estimates are labeled estimates. A
truth-in-pricing product that shades its own numbers is one FTC CID away from
being a very short story. When in doubt, disclose.
