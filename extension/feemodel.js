'use strict';

// PriceTruth extension — bundled fee-model snapshot.
//
// This is a self-contained, conservative price-context model. Current U.S.
// hotel and live-event ticket displays are treated as mandatory-fee inclusive;
// optional extras are never selected for the shopper. Historical profile data
// remains bundled for labels and non-mandatory projections where applicable.
// It exists so the extension NEVER has to make a network request: every
// computation happens locally, in this file, in your browser.
//
// Loaded two ways:
//   - content scripts: listed before content.js in manifest.json content_scripts
//     (defines the PTFeeModel global in the extension's isolated world)
//   - popup: <script src="feemodel.js"> before popup.js
// It also exports via module.exports when run under Node, for sanity testing.
//
// Honesty rules: every line item carries a `certainty` ('listed' | 'typical' |
// 'estimated'), anything not 'listed' is labeled as a projection, and the
// model never invents a mandatory fee or selects an optional add-on.

(function (global) {
  var SNAPSHOT = {
    date: '2026-08-21',
    source: 'PriceTruth src/data/fees/*.json (typical values only)',
  };

  // ---------------------------------------------------------------------------
  // Data snapshot (values are integer USD cents unless suffixed Pct)
  // ---------------------------------------------------------------------------

  var HOTEL_MARKETS = {
    las_vegas: {
      label: 'Las Vegas, NV',
      resortFee_cents: 4500, resortFeePrevalencePct: 95,
      occupancyTaxPct: 13.38, occupancyFlatPerNight_cents: 0, taxAppliesToResortFee: true,
      parking_cents: 1800, parkingPrevalencePct: 80,
    },
    new_york: {
      label: 'New York, NY',
      resortFee_cents: 3500, resortFeePrevalencePct: 55,
      occupancyTaxPct: 14.75, occupancyFlatPerNight_cents: 350, taxAppliesToResortFee: true,
      parking_cents: 6500, parkingPrevalencePct: 90,
    },
    miami: {
      label: 'Miami, FL',
      resortFee_cents: 4000, resortFeePrevalencePct: 75,
      occupancyTaxPct: 13.0, occupancyFlatPerNight_cents: 0, taxAppliesToResortFee: true,
      parking_cents: 4200, parkingPrevalencePct: 85,
    },
    orlando: {
      label: 'Orlando, FL',
      resortFee_cents: 3500, resortFeePrevalencePct: 70,
      occupancyTaxPct: 12.5, occupancyFlatPerNight_cents: 0, taxAppliesToResortFee: true,
      parking_cents: 2800, parkingPrevalencePct: 75,
    },
    default: {
      label: 'US average',
      resortFee_cents: 3000, resortFeePrevalencePct: 35,
      occupancyTaxPct: 12.0, occupancyFlatPerNight_cents: 0, taxAppliesToResortFee: true,
      parking_cents: 2000, parkingPrevalencePct: 50,
    },
  };

  var FLIGHT_CARRIERS = {
    spirit: {
      label: 'Spirit Airlines',
      carryOn_cents: 6500, seatSelection_cents: 2500,
      carryOnPrevalencePct: 85, seatPrevalencePct: 60,
    },
    frontier: {
      label: 'Frontier Airlines',
      carryOn_cents: 6000, seatSelection_cents: 2200,
      carryOnPrevalencePct: 85, seatPrevalencePct: 60,
    },
    typical_lcc: {
      label: 'Typical low-cost carrier',
      carryOn_cents: 4500, seatSelection_cents: 3200,
      carryOnPrevalencePct: 80, seatPrevalencePct: 55,
    },
    typical_legacy: {
      label: 'Typical legacy carrier (basic economy)',
      carryOn_cents: 0, seatSelection_cents: 2000,
      carryOnPrevalencePct: 0, seatPrevalencePct: 50,
    },
  };

  var TICKET_PLATFORMS = {
    ticketmaster: {
      label: 'Ticketmaster',
      serviceFeePct: 27.5, serviceFeeRangePct: [15, 40],
      facility_cents: 600, orderProcessing_cents: 595,
    },
    stubhub: {
      label: 'StubHub (resale)',
      serviceFeePct: 30.0, serviceFeeRangePct: [25, 40],
      facility_cents: 0, orderProcessing_cents: 0,
    },
    seatgeek: {
      label: 'SeatGeek (resale)',
      serviceFeePct: 26.0, serviceFeeRangePct: [20, 35],
      facility_cents: 0, orderProcessing_cents: 0,
    },
    default: {
      label: 'Typical ticketing platform',
      serviceFeePct: 27.0, serviceFeeRangePct: [15, 40],
      facility_cents: 500, orderProcessing_cents: 500,
    },
  };

  var SUBSCRIPTION_PATTERNS = {
    streaming: { label: 'Streaming media', introMonthsTypical: 3, renewalMultiple: 1.6 },
    vpn: { label: 'VPN / security', introMonthsTypical: 12, renewalMultiple: 2.8 },
    news: { label: 'News / publishing', introMonthsTypical: 6, renewalMultiple: 4.0 },
    fitness: { label: 'Fitness / wellness apps', introMonthsTypical: 1, renewalMultiple: 1.8 },
    default: { label: 'Typical subscription', introMonthsTypical: 6, renewalMultiple: 2.0 },
  };

  var VERTICALS = ['hotel', 'flight', 'ticket', 'subscription', 'retail'];

  // ---------------------------------------------------------------------------
  // Integer-cents money helpers (mirrors src/engine/money.js)
  // ---------------------------------------------------------------------------

  function isCents(v) {
    return Number.isSafeInteger(v) && v >= 0 && v <= 1000000000; // $10M cap
  }

  // pct is a plain number like 13.38 (percent, not fraction). Round half-up.
  function pctOf(cents, pct) {
    return Math.floor((cents * pct) / 100 + 0.5);
  }

  function fmtUSD(cents, opts) {
    if (!isCents(cents)) return '$—';
    var compact = opts && opts.compact;
    var dollars = Math.floor(cents / 100);
    var rem = cents % 100;
    var d = dollars.toLocaleString('en-US');
    if (compact && rem === 0) return '$' + d;
    var r = String(rem);
    if (r.length < 2) r = '0' + r;
    return '$' + d + '.' + r;
  }

  // Parse a user-typed dollar string ("219", "$1,299.00", "219.99") to integer
  // cents using string math — the decimal part never touches floating point.
  // Returns null if the string is not a clean dollar amount.
  var DOLLARS_RE = /^\$?\s*(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?$/;
  function dollarsToCents(str) {
    if (typeof str !== 'string') return null;
    var m = DOLLARS_RE.exec(str.trim());
    if (!m) return null;
    var dollarsDigits = m[1].replace(/,/g, '');
    var centsDigits = m[2] || '';
    while (centsDigits.length < 2) centsDigits += '0';
    var cents = Number(dollarsDigits + centsDigits); // pure digit-string concat
    return isCents(cents) ? cents : null;
  }

  // ---------------------------------------------------------------------------
  // Report assembly (mirrors src/engine/analyze.js, typical-profile-only:
  // the extension never has seller-quoted fee amounts, so apart from the
  // advertised base every line is 'typical' or 'estimated').
  // ---------------------------------------------------------------------------

  function item(code, label, amount_cents, kind, certainty, note) {
    var it = { code: code, label: label, amount_cents: amount_cents, kind: kind, certainty: certainty };
    if (note) it.note = note;
    return it;
  }

  function sumItems(items) {
    var t = 0;
    for (var i = 0; i < items.length; i++) t += items[i].amount_cents;
    return t;
  }

  function confidenceFrom(lineItems, unknownCosts) {
    var c = 1.0;
    for (var i = 0; i < lineItems.length; i++) {
      if (lineItems[i].certainty === 'typical') c -= 0.08;
      else if (lineItems[i].certainty === 'estimated') c -= 0.12;
    }
    c -= Math.min(0.45, (unknownCosts || []).length * 0.15);
    return Math.max(0.35, Math.round(c * 100) / 100);
  }

  function finishReport(r) {
    var equiv = r.advertisedEquiv_cents != null ? r.advertisedEquiv_cents : r.advertised_cents;
    var feeLoadPct = equiv > 0 ? Math.round(((r.truePrice_cents - equiv) / equiv) * 1000) / 10 : 0;
    var unknownCosts = r.unknownCosts || [];
    return {
      vertical: r.vertical,
      currency: 'USD',
      advertised: { amount_cents: r.advertised_cents, unit: r.advertisedUnit },
      truePrice: { amount_cents: r.truePrice_cents, unit: r.trueUnit },
      total: r.total || null,
      lineItems: r.lineItems,
      feeLoadPct: feeLoadPct,
      confidence: confidenceFrom(r.lineItems, unknownCosts),
      completeness: {
        status: unknownCosts.length ? 'partial' : 'complete',
        unknownCosts: unknownCosts,
      },
      assumptions: r.assumptions,
      disclosures: r.disclosures,
      profileLabel: r.profileLabel,
    };
  }

  function analyzeHotel(advertised_cents, marketId) {
    var market = HOTEL_MARKETS[marketId] || HOTEL_MARKETS.default;
    var items = [item('room', 'Displayed room price', advertised_cents, 'base', 'listed')];

    return finishReport({
      vertical: 'hotel',
      advertised_cents: advertised_cents,
      advertisedUnit: 'per_night',
      truePrice_cents: sumItems(items),
      trueUnit: 'per_night',
      lineItems: items,
      assumptions: [
        'The displayed price is treated as including mandatory hotel fees.',
        'Optional parking is not selected for the shopper.',
        'Lodging taxes are unknown because the page adapter does not provide an exact tax attestation.',
      ],
      disclosures: ['For current U.S. short-term lodging offers, mandatory fees belong in the displayed price. Confirm expressly excluded taxes and optional extras with the seller.'],
      unknownCosts: [{ code: 'hotel-taxes', label: 'Hotel taxes', reason: 'The detected price does not attest that lodging taxes are included.' }],
      profileLabel: market.label,
    });
  }

  function analyzeFlight(advertised_cents, carrierId) {
    var carrier = FLIGHT_CARRIERS[carrierId] || FLIGHT_CARRIERS.typical_lcc;
    var items = [item('fare', 'Displayed fare (' + carrier.label + ')', advertised_cents, 'base', 'listed')];

    return finishReport({
      vertical: 'flight',
      advertised_cents: advertised_cents,
      advertisedUnit: 'per_fare',
      truePrice_cents: sumItems(items),
      trueUnit: 'per_fare',
      lineItems: items,
      assumptions: [
        'No bags, seat selection, or other optional extras are selected for the shopper.',
        'Add only the extras you choose after checking the airline’s current price.',
      ],
      disclosures: ['U.S. advertised fares include mandatory taxes and fees. Optional airline services vary and are not added automatically.'],
      profileLabel: carrier.label,
    });
  }

  function analyzeTicket(advertised_cents, platformId) {
    var platform = TICKET_PLATFORMS[platformId] || TICKET_PLATFORMS.default;
    var items = [item('ticket', 'Displayed ticket price', advertised_cents, 'base', 'listed')];

    var checkout = sumItems(items);
    return finishReport({
      vertical: 'ticket',
      advertised_cents: advertised_cents,
      advertisedUnit: 'per_ticket',
      truePrice_cents: checkout,
      trueUnit: 'checkout_total',
      total: { amount_cents: checkout, label: 'Checkout estimate' },
      lineItems: items,
      assumptions: [
        'The displayed price is treated as including mandatory ticket fees.',
        'Optional add-ons are not selected for the shopper.',
        'Ticket taxes are unknown because the page adapter does not provide an exact tax attestation.',
      ],
      disclosures: ['For current U.S. live-event ticket offers, mandatory fees belong in the displayed price. Confirm expressly excluded taxes and optional extras with the seller.'],
      unknownCosts: [{ code: 'ticket-taxes', label: 'Ticket taxes', reason: 'The detected price does not attest that government taxes are included.' }],
      profileLabel: platform.label,
    });
  }

  function analyzeSubscription(advertised_cents, patternId) {
    var pattern = SUBSCRIPTION_PATTERNS[patternId] || SUBSCRIPTION_PATTERNS.default;
    var assumptions = [];
    var disclosures = [];

    var introMonths = pattern.introMonthsTypical;
    var renewal = Math.round(advertised_cents * pattern.renewalMultiple);
    assumptions.push('Renewal price estimated at ' + pattern.renewalMultiple + '× the intro price (typical for ' + pattern.label.toLowerCase() + ').');

    var items = [];
    if (introMonths > 0) {
      items.push(item('intro', 'Intro price × ' + introMonths + ' months', advertised_cents * introMonths, 'base', 'typical'));
    }
    if (introMonths < 12) {
      items.push(item('renewal', 'Renewal price × ' + (12 - introMonths) + ' months', renewal * (12 - introMonths), 'addon', 'estimated',
        'Price rises to ' + fmtUSD(renewal, { compact: true }) + '/month after ' + introMonths + ' month' + (introMonths === 1 ? '' : 's')));
      disclosures.push('Price typically rises to ' + fmtUSD(renewal, { compact: true }) + '/month after ' + (introMonths === 0 ? 'signup' : introMonths + ' months') + '.');
    }

    var firstYear = sumItems(items);
    disclosures.push('Effective cost is ' + fmtUSD(Math.round(firstYear / 12), { compact: true }) + '/month over the first year, not ' + fmtUSD(advertised_cents, { compact: true }) + '.');

    return finishReport({
      vertical: 'subscription',
      advertised_cents: advertised_cents,
      advertisedUnit: 'per_month',
      truePrice_cents: firstYear,
      trueUnit: 'first_year',
      total: { amount_cents: firstYear, label: 'First-year cost' },
      lineItems: items,
      assumptions: assumptions,
      disclosures: disclosures,
      advertisedEquiv_cents: advertised_cents * 12,
      profileLabel: pattern.label,
    });
  }

  function analyzeRetail(advertised_cents) {
    var items = [item('price', 'Listed price', advertised_cents, 'base', 'listed')];
    return finishReport({
      vertical: 'retail',
      advertised_cents: advertised_cents,
      advertisedUnit: 'total',
      truePrice_cents: sumItems(items),
      trueUnit: 'total',
      lineItems: items,
      assumptions: [
        'Shipping, handling, and sales tax are unknown; the popup has no seller checkout quote or tax jurisdiction.',
      ],
      disclosures: ['This amount is the known listed subtotal, not a guaranteed checkout total.'],
      unknownCosts: [
        { code: 'shipping', label: 'Shipping', reason: 'The seller shipping quote was not supplied.' },
        { code: 'handling', label: 'Handling or mandatory seller charges', reason: 'The seller did not attest that no other mandatory charge applies.' },
        { code: 'sales-tax', label: 'Sales tax', reason: 'The checkout jurisdiction and tax rate are unknown.' },
      ],
      profileLabel: 'Retail listing',
    });
  }

  // analyze(vertical, advertised_cents, opts)
  //   opts.profile — market/carrier/platform/pattern id (per vertical)
  // Returns a report shaped like the spine's (src/engine/analyze.js), or null
  // for invalid input. All amounts integer cents.
  function analyze(vertical, advertised_cents, opts) {
    if (VERTICALS.indexOf(vertical) === -1 || !isCents(advertised_cents)) return null;
    var profile = opts && opts.profile;
    switch (vertical) {
      case 'hotel': return analyzeHotel(advertised_cents, profile);
      case 'flight': return analyzeFlight(advertised_cents, profile);
      case 'ticket': return analyzeTicket(advertised_cents, profile);
      case 'subscription': return analyzeSubscription(advertised_cents, profile);
      case 'retail': return analyzeRetail(advertised_cents);
      default: return null;
    }
  }

  // Dropdown data for the popup: { hotel: [{id,label}], flight: [...], ... }
  function options() {
    function list(map) {
      var out = [];
      for (var id in map) out.push({ id: id, label: map[id].label });
      return out;
    }
    return {
      hotel: list(HOTEL_MARKETS),
      flight: list(FLIGHT_CARRIERS),
      ticket: list(TICKET_PLATFORMS),
      subscription: list(SUBSCRIPTION_PATTERNS),
      retail: [],
    };
  }

  // Word-style labels carry a leading space so "$121.60" + label reads
  // "$121.60 at checkout"; slash-style labels stay tight ("$219.00/night").
  var UNIT_LABELS = {
    per_night: '/night',
    per_fare: '/fare',
    per_ticket: '/ticket',
    per_month: '/mo',
    checkout_total: ' at checkout',
    first_year: ' first year',
    total: ' total',
  };
  function unitLabel(unit) {
    return UNIT_LABELS[unit] || '';
  }

  var api = {
    SNAPSHOT: SNAPSHOT,
    VERTICALS: VERTICALS,
    analyze: analyze,
    options: options,
    unitLabel: unitLabel,
    fmtUSD: fmtUSD,
    dollarsToCents: dollarsToCents,
    pctOf: pctOf,
    isCents: isCents,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.PTFeeModel = api;
})(typeof self !== 'undefined' ? self : this);
