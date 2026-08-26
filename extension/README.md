# PriceTruth browser extension

PriceTruth adds local, honesty-labeled price context to supported hotel, flight,
and ticket pages. Current U.S. hotel and live-event ticket displays are treated
as mandatory-fee inclusive; unverified taxes remain explicit unknowns and
optional add-ons are never auto-selected. It is a
Chrome Manifest V3 extension with no remote code, analytics, or automatic
network requests.

The on-page overlay fails closed: it requires an explicit `USD` or `US$` amount
plus reliable U.S. offer/location evidence (or an en-US point of sale for
flights). A bare `$`, foreign dollar prefix, or U.S. locale alone on a hotel or
ticket page is not enough.

## Supported seller adapters

The extension uses versioned, fixture-tested adapters for Booking.com,
Hotels.com, Expedia, Ticketmaster, StubHub, SeatGeek, Spirit, Frontier,
Marriott, and Hilton. Each adapter supplies seller selectors, exclusions, and a
fee profile. A bounded generic scan is a conservative fallback only on those
declared hosts. Unsupported sites receive no content script.

Multi-vertical Expedia pages use route and explicit page-language signals to
distinguish flights from hotels. If confidence is too low, the overlay remains
silent. A detected price can be corrected locally from the expanded card.

## Privacy and permissions

- Price extraction and fee calculations run inside the browser.
- No `fetch`, XHR, WebSocket, telemetry, or remote-code path is present.
- The sole API permission is `storage`, used for the user's per-site enablement
  preferences. Chrome sync is not used.
- Declared content-script hosts are the seller access needed to read visible
  prices and render the overlay.
- “Report detection” opens a PriceTruth feedback page only after a user clicks.
  The seller adapter, vertical, and detected cents are placed in that URL; the
  shopping-page URL is never included. Nothing is submitted automatically.

See [PRIVACY.md](PRIVACY.md) for the store-facing disclosure.

## Local installation and test

1. Run `npm run extension:check` at the repository root.
2. Open `chrome://extensions`, enable Developer mode, and choose **Load
   unpacked**.
3. Select `extension/`.

Use `npm run extension:package` to create the deterministic upload archive at
`dist/pricetruth-extension.zip`. Release instructions and store requirements are
in `docs/EXTENSION-RELEASE.md`.

## Architecture

| File | Responsibility |
|---|---|
| `manifest.json` | MV3 permissions, supported hosts, popup, options, icons |
| `config.js` | App origin injected into per-deployment download bundles |
| `adapters.js` | Tested seller classification, extraction, and ranking rules |
| `feemodel.js` | Bundled conservative integer-cents price model |
| `content.js` / `overlay.css` | Page extraction, local correction, accessible overlay |
| `popup.*` | Local all-in-cost calculator |
| `options.*` | Per-site local enablement preferences |

All monetary calculations use integer USD cents. Every projected line remains
labeled `typical` or `estimated`, every missing checkout cost is exposed through
the report completeness state, and seller quotes are never implied. The model
does not infer excluded hotel/ticket taxes or mandatory fees, and it never
selects optional extras for the shopper.
