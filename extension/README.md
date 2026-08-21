# PriceTruth browser extension (prototype)

**The truth layer at the moment you're looking at a price.** Coupon extensions
ask "can I get you a coupon?" — this overlay answers **"what will this actually
cost you?"** When you're staring at a $219/night hotel room, PriceTruth shows
the ~$317/night reality: resort fee, occupancy taxes, parking — before checkout
does.

Chrome Manifest V3, loadable unpacked. No build step, no dependencies, no icons.

## Privacy model: zero network requests

This is the product's differentiator, so it is worth stating bluntly:

- **The extension makes no network requests. None.** No fetches, no analytics,
  no telemetry, no cloud API calls, no coupon-server lookups.
- The fee model is **bundled inside the extension** (`feemodel.js`) — a snapshot
  of PriceTruth's typical-fee datasets (`src/data/fees/*.json`, snapshot
  2026-08-21). Every computation happens locally, in your browser.
- Nothing about your browsing — pages visited, prices seen, amounts typed —
  ever leaves the browser. There is nowhere for it to go.
- No storage either: the extension keeps no history and writes nothing to disk.
- The only outbound link is the "Open PriceTruth" anchor, which opens the local
  PriceTruth app (`http://localhost:4780`) **only if you click it**.

Compare that with coupon/shopping extensions, whose business model requires
telling a server what you're shopping for.

## What it does

**On supported sites** (booking.com, hotels.com, expedia.com, ticketmaster.com,
stubhub.com, spirit.com — plus example.com as a demo), a content script:

1. Scans visible text for a price (`$219`, `$1,299.00`, …) and takes the most
   prominent one — largest type, price-ish markup.
2. Classifies the vertical from the hostname (hotel / ticket / flight).
3. Computes a true-cost estimate from the bundled typical-fee profiles and
   shows a small bottom-right badge: **"PriceTruth: ~$317.32/night real"**.
4. Click the badge for the line-item breakdown — every non-listed line is
   tagged `typical` or `estimated`, with the note *"Estimated from typical fees
   for this site's category — actual checkout may differ."*

If no price is confidently detected, the overlay shows **nothing**. It never
guesses loudly.

**In the toolbar popup**, a mini calculator: pick a vertical (hotel, flight,
ticket, subscription, retail), type the advertised price, pick a
market/carrier/platform profile, and get the same glance-first true-price
verdict and breakdown — all computed locally.

## Load it unpacked

1. Open `chrome://extensions` in Chrome (or any Chromium browser).
2. Turn on **Developer mode** (toggle, top right).
3. Click **Load unpacked** and select this folder (`extension/`).
4. Pin "PriceTruth" from the puzzle-piece menu if you want the popup handy.

## Demo it

- **Quickest:** visit any `example.com` page that has a `$` price on it. (The
  stock example.com page has no price, so either paste one in via DevTools —
  e.g. run
  `document.body.prepend(Object.assign(document.createElement('h1'), {textContent: '$219.00 per night'}))`
  in the console — or serve any local test page on an `example.com` host
  entry.) The overlay treats the page as a hotel listing with the US-average
  fee profile and says so in the card — demo mode is labeled demo mode.
- **Real sites:** browse hotel listings on booking.com / hotels.com /
  expedia.com, event pages on ticketmaster.com / stubhub.com, or fares on
  spirit.com and look for the badge bottom-right. Detection is heuristic, so
  some page layouts won't trigger it — that's by design (silence over wrong
  guesses).
- **Popup demo:** open the popup, leave the defaults (hotel, $219, Las Vegas)
  — you get **~$317.32/night**, the same shape as the PriceTruth demo product
  (`vegas-hotel`, $219 advertised → $317 real).
- With the PriceTruth server running (`npm start` in the repo root), the "Open
  PriceTruth" links land on the full app at `http://localhost:4780`.

## Honest limitations (it's a prototype)

- **Heuristic price detection.** It grabs the most prominent `$` amount on the
  page, which may be a total instead of a nightly rate, a strikethrough deal
  price it failed to skip, or the wrong listing on a crowded search page.
- **Estimates only.** Fees are *typical profiles* (e.g. "US-average market",
  "Ticketmaster typical ~27.5% service fee"), not this seller's actual fees.
  The real checkout number will differ; every projected line is labeled.
- Hostname-level vertical classification: expedia.com is treated as hotels even
  when you're browsing flights there; multi-vertical sites need page-level
  classification (future work).
- The fee snapshot is frozen at bundle time (2026-08-21). Updating it means
  re-porting the `typical` values from `src/data/fees/*.json` into
  `feemodel.js` — deliberately manual, so the extension never phones home.
- Chrome MV3 only; not tested on Firefox.

## Files

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest — content scripts + popup, no permissions requested |
| `feemodel.js` | Bundled fee-model snapshot + integer-cents math (shared by content script and popup) |
| `content.js` | Price detection + overlay badge on supported sites |
| `overlay.css` | Badge/card styles (`pt-ext-` prefixed, high z-index) |
| `popup.html` / `popup.js` / `popup.css` | Toolbar mini calculator |

All money is integer USD cents end to end; dollars are parsed with string math,
never floats — same rules as the PriceTruth spine.
