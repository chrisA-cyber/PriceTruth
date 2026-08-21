# Affiliate Disclosure — PriceTruth (prototype)

**Effective date:** 2026-08-21 (prototype draft)
**Operator:** PriceTruth (prototype), operated by [COMPANY ENTITY]

This disclosure follows the FTC's Guides Concerning the Use of Endorsements and
Testimonials in Advertising (16 CFR Part 255) and the FTC's guidance on
disclosing material connections in affiliate marketing: if a link can earn us
money, you get told **before** you rely on it — clearly, conspicuously, and
every time.

## The material connection, in one sentence

**If you click through to a partner site from PriceTruth and then book or buy,
PriceTruth may earn a commission, at no extra cost to you.**

That commission is a "material connection" under FTC rules, and this page —
plus the interstitial described below — is how we disclose it.

## How our outbound links work

- Every partner link on PriceTruth goes through our own redirect route
  (`/go/<partner>`), never directly to the partner.
- Clicking one **always** shows an interstitial page first. It tells you where
  you are going and repeats the disclosure — "this is an affiliate link; if you
  book or buy after clicking, PriceTruth may earn a commission at no extra cost
  to you" — before you continue. The disclosure is unavoidable, not buried in a
  footer or behind a hover.
- The continue link carries `rel="sponsored nofollow noopener"`, marking the
  link as compensated for search engines (per Google's link-attribute
  guidelines) and preventing the destination page from scripting back to ours.
- Only an allowlist of known partners can be linked, only over HTTPS, and the
  affiliate tag we append identifies PriceTruth — it contains nothing about
  you. Our `no-referrer` policy means the partner is not even told which page
  you came from.

## Commissions never touch the numbers

This is the part we care most about, because PriceTruth's entire product is
telling you the truth about prices:

- **True-cost breakdowns, fee estimates, price history, and deal-quality scores
  are computed before, and completely independently of, any partner
  relationship.** The analysis engine's inputs are the advertised price, the
  vertical, and our fee datasets; the scoring inputs are recorded price history
  and fee load. Partner status is not an input to either. There is no code path
  by which being (or not being) an affiliate partner changes a number we show.
- Partners cannot pay for a better score, a lower true price, a hidden fee
  line, or preferred placement in results.
- If a partner's price is a bad deal, the score says so — and the affiliate
  link sits under that verdict anyway.

## Prototype status

PriceTruth is currently a prototype. The affiliate tags in the demo build are
placeholders (`pricetruth-demo`), and **no live commission agreements exist
yet**. We disclose as if the links were live because the mechanism is built and
because the habit matters: if real affiliate relationships are signed, this
page will name the programs, and the disclosure flow above is already in place
on day one.

## Questions

[CONTACT EMAIL]
