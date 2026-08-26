# Accessibility release standard

PriceTruth targets WCAG 2.2 Level AA for the web experience and extension UI.
Automated checks reduce regressions but do not establish conformance.

## Automated gate

`npm run test:a11y` runs axe in Chromium desktop and mobile projects across the
home, finder, analyzer, pricing, account, and extension pages. Serious and
critical WCAG-tagged violations fail CI. Browser tests also cover skip-link
focus, result focus management, and mobile document overflow.

## Manual release matrix

Test every primary flow—sign in/out, manual and provider price check, edit
assumptions, compare, save/watch, create/update/unsubscribe alert, checkout and
portal return, API-key create/rotate/revoke, export/delete account—with:

- keyboard only, including visible focus and no traps;
- current NVDA + Chrome and VoiceOver + Safari;
- 200% and 400% browser zoom/reflow;
- increased text spacing;
- Windows High Contrast/forced colors;
- light/dark schemes and reduced motion;
- narrow 320 CSS-pixel viewport and landscape mobile;
- validation, loading, empty, offline, rate-limit, and server-error states.

Confirm that certainty, deal quality, and status do not rely on color; tables
have usable small-screen presentations; charts/gauges have equivalent text;
dynamic results are announced without stealing context; controls meet practical
44×44 CSS-pixel touch targets; and every email/extension control is operable and
labeled.

Record browser/assistive-technology versions, tester, date, flow, outcome,
screenshots or recording, and linked defects in the release ticket. Launch is
blocked by any flow-stopping issue or unmitigated WCAG A/AA failure. Publish a
conformance claim only after an expert audit and user testing with disabled
participants.
