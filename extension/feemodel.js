'use strict';

// PriceTruth extension — bundled fee-model snapshot.
//
// This is a self-contained port of the "typical" values from the spine's
// datasets (src/data/fees/*.json, snapshot 2026-08-21) plus the same integer
// cents arithmetic the engine uses (src/engine/money.js, src/engine/analyze.js).
// It exists so the extension NEVER has to make a network request: every
// computation happens locally, in this file, in your browser.
//
// Loaded two ways:
//   - content scripts: listed before content.js in manifest.json content_scripts
//     (defines the PTFeeModel global in the extension's isolated world)
//   - popup: <script src="feemodel.js"> before popup.js
// It also exports via module.exports when run under Node, for sanity testing.
//
// Honesty rules (same as the spine): every line item carries a `certainty`
// ('listed' | 'typical' | 'estimated') and anything not 'listed' is a
// projection that must be labeled as such in the UI.

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

  function confidenceFrom(lineItems) {
    var c = 1.0;
    for (var i = 0; i < lineItems.length; i++) {
      if (lineItems[i].certainty === 'typical') c -= 0.08;
      else if (lineItems[i].certainty === 'estimated') c -= 0.12;
    }
    return Math.max(0.35, Math.round(c * 100) / 100);
  }

  function finishReport(r) {
    var equiv = r.advertisedEquiv_cents != null ? r.advertisedEquiv_cents : r.advertised_cents;
    var feeLoadPct = equiv > 0 ? Math.round(((r.truePrice_cents - equiv) / equiv) * 1000) / 10 : 0;
    return {
      vertical: r.vertical,
      currency: 'USD',
      advertised: { amount_cents: r.advertised_cents, unit: r.advertisedUnit },
      truePrice: { amount_cents: r.truePrice_cents, unit: r.trueUnit },
      total: r.total || null,
      lineItems: r.lineItems,
      feeLoadPct: feeLoadPct,
      confidence: confidenceFrom(r.lineItems),
      assumptions: r.assumptions,
      disclosures: r.disclosures,
      profileLabel: r.profileLabel,
    };
  }

  function analyzeHotel(advertised_cents, marketId) {
    var market = HOTEL_MARKETS[marketId] || HOTEL_MARKETS.default;
    var assumptions = [];
    var items = [item('room', 'Room rate', advertised_cents, 'base', 'listed')];

    var resortFee = 0;
    if (market.resortFeePrevalencePct >= 50) {
      resortFee = market.resortFee_cents;
      items.push(item('resort_fee', 'Resort fee', resortFee, 'fee', 'typical',
        market.resortFeePrevalencePct + '% of ' + market.label + ' hotels charge one'));
      assumptions.push('Resort fee is the ' + market.label + ' typical; this property’s actual fee may differ.');
    } else {
      assumptions.push('No resort fee assumed for this market (' + market.resortFeePrevalencePct + '% prevalence); some properties still charge one.');
    }

    var taxBase = advertised_cents + (market.taxAppliesToResortFee ? resortFee : 0);
    var taxes = pctOf(taxBase, market.occupancyTaxPct) + market.occupancyFlatPerNight_cents;
    items.push(item('taxes', 'Occupancy taxes (' + market.occupancyTaxPct + '%)', taxes, 'tax', 'estimated'));

    if (market.parkingPrevalencePct >= 50) {
      items.push(item('parking', 'Parking', market.parking_cents, 'addon', 'typical',
        'Typical for ' + market.label + '; skip if you won’t have a car'));
      assumptions.push('Parking included at the market-typical rate; remove it if you are not driving.');
    }

    return finishReport({
      vertical: 'hotel',
      advertised_cents: advertised_cents,
      advertisedUnit: 'per_night',
      truePrice_cents: sumItems(items),
      trueUnit: 'per_night',
      lineItems: items,
      assumptions: assumptions,
      disclosures: ['Mandatory fees must now be shown in the advertised price under the FTC junk-fee rule; many quotes still surface them only at checkout.'],
      profileLabel: market.label,
    });
  }

  function analyzeFlight(advertised_cents, carrierId) {
    var carrier = FLIGHT_CARRIERS[carrierId] || FLIGHT_CARRIERS.typical_lcc;
    var assumptions = [];
    var items = [item('fare', 'Base fare (' + carrier.label + ')', advertised_cents, 'base', 'listed')];

    if (carrier.carryOn_cents > 0) {
      items.push(item('carry_on', 'Carry-on bag', carrier.carryOn_cents, 'fee', 'typical',
        carrier.carryOnPrevalencePct + '% of travelers on this carrier type pay it'));
      assumptions.push('Assumes one carry-on; a personal item only avoids this fee.');
    }
    if (carrier.seatSelection_cents > 0) {
      items.push(item('seat', 'Seat selection', carrier.seatSelection_cents, 'fee', 'typical',
        carrier.seatPrevalencePct + '% pay to pick a seat; skip to be assigned one free at check-in'));
      assumptions.push('Includes a standard seat-selection fee; airlines assign a free seat at check-in if you skip it.');
    }
    assumptions.push('No checked bags assumed; checked-bag fees add more.');

    return finishReport({
      vertical: 'flight',
      advertised_cents: advertised_cents,
      advertisedUnit: 'per_fare',
      truePrice_cents: sumItems(items),
      trueUnit: 'per_fare',
      lineItems: items,
      assumptions: assumptions,
      disclosures: ['US advertised fares already include base taxes (DOT full-fare rule); ancillary fees are the drip.'],
      profileLabel: carrier.label,
    });
  }

  function analyzeTicket(advertised_cents, platformId) {
    var platform = TICKET_PLATFORMS[platformId] || TICKET_PLATFORMS.default;
    var assumptions = [];
    var items = [item('face', 'Face value', advertised_cents, 'base', 'listed')];

    var pct = platform.serviceFeePct;
    items.push(item('service_fee', 'Service fee (~' + pct + '% of face)', pctOf(advertised_cents, pct), 'fee', 'typical',
      platform.label + ' service fees typically run ' + platform.serviceFeeRangePct[0] + '–' + platform.serviceFeeRangePct[1] + '% of face value'));
    assumptions.push('Service fee estimated at the ' + platform.label + ' typical rate; the exact fee appears only at checkout.');

    if (platform.facility_cents > 0) {
      items.push(item('facility', 'Facility charge', platform.facility_cents, 'fee', 'typical'));
    }
    if (platform.orderProcessing_cents > 0) {
      items.push(item('order_processing', 'Order processing (per order)', platform.orderProcessing_cents, 'fee', 'typical'));
    }
    assumptions.push('One ticket, sales tax not included.');

    var checkout = sumItems(items);
    return finishReport({
      vertical: 'ticket',
      advertised_cents: advertised_cents,
      advertisedUnit: 'per_ticket',
      truePrice_cents: checkout,
      trueUnit: 'checkout_total',
      total: { amount_cents: checkout, label: 'Checkout estimate' },
      lineItems: items,
      assumptions: assumptions,
      disclosures: ['Live-event tickets must be advertised all-in under the FTC junk-fee rule; resale platforms and add-ons still vary at checkout.'],
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
        'Shipping assumed free; add it if this seller charges shipping.',
        'Sales tax not included (varies by state).',
      ],
      disclosures: [],
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
