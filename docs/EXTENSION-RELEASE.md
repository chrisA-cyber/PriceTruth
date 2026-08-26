# Browser extension release

## Engineering gate

1. Update the fee snapshot date/data and adapter fixtures in the same change.
2. Update `manifest.json` version; Chrome versions never move backward.
3. Run `npm run extension:icons`, `npm run extension:check`, and the complete CI
   suite.
4. Test every supported seller fixture plus current live layouts in a clean
   Chrome profile. Verify wrong-price correction, per-site disable, SPA route
   changes, keyboard use, reduced motion, and narrow screens.
5. Package with the deployed origin:

```text
EXTENSION_APP_URL=https://<production-origin> npm run extension:package
```

The packager rejects non-HTTPS or URL paths and creates
`dist/pricetruth-extension.zip`. Record its SHA-256 hash and CI commit.

## Store gate

Supply real operator-controlled support and privacy URLs, screenshots, trader
status, distribution territories, and permission declarations. Source copy is
in `extension/STORE-LISTING.md`; privacy disclosure is in
`extension/PRIVACY.md`. Do not submit localhost, synthetic support identities,
or unverified claims.

Chrome host warnings must match the supported adapter list. The only API
permission is local `storage`; any permission expansion requires a privacy and
single-purpose review, fixture coverage, and a new release ticket.

## Staged rollout and rollback

Publish to an internal tester group, then 5%, 25%, 50%, and 100% with at least
one business day at each stage. Monitor store crashes/reviews, feedback by
adapter, wrong-price correction rate, and support volume. The extension has no
automatic telemetry, so metrics come only from explicit user reports and store
health surfaces.

Pause rollout for systemic false detection, missing honesty labels, privacy
regression, page breakage, or inaccessible controls. Roll back through the store
to the last known-good package and remove the failing adapter from the next
version; never silently broaden selectors to recover coverage.
