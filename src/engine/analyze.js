'use strict';

const path = require('node:path');
const { assertCents, pctOf, sum } = require('./money');

const DATA_DIR = path.join(__dirname, '..', 'data', 'fees');
const HOTEL = require(path.join(DATA_DIR, 'hotel.json'));
const FLIGHT = require(path.join(DATA_DIR, 'flight.json'));
const TICKET = require(path.join(DATA_DIR, 'ticket.json'));
const SUBSCRIPTION = require(path.join(DATA_DIR, 'subscription.json'));

const VERTICALS = ['hotel', 'flight', 'ticket', 'subscription', 'retail'];

// certainty: 'listed'   — value supplied in the request (seller/user quoted it)
//            'typical'  — market/carrier/platform typical from our datasets
//            'estimated'— computed heuristic
// Every non-'listed' line must be honest about being a projection; confidence
// and the disclosures array carry that honesty through to the UI and API.

function item(code, label, amount_cents, kind, certainty, note) {
  assertCents(amount_cents, code);
  const it = { code, label, amount_cents, kind, certainty };
  if (note) it.note = note;
  return it;
}

function confidenceFrom(lineItems) {
  let c = 1.0;
  for (const it of lineItems) {
    if (it.certainty === 'typical') c -= 0.08;
    else if (it.certainty === 'estimated') c -= 0.12;
  }
  return Math.max(0.35, Math.round(c * 100) / 100);
}

function finishReport({ vertical, advertised_cents, advertisedUnit, truePrice_cents, trueUnit, total, lineItems, assumptions, disclosures, advertisedEquiv_cents }) {
  const equiv = advertisedEquiv_cents ?? advertised_cents;
  const feeLoadPct = equiv > 0 ? Math.round(((truePrice_cents - equiv) / equiv) * 1000) / 10 : 0;
  return {
    vertical,
    currency: 'USD',
    advertised: { amount_cents: advertised_cents, unit: advertisedUnit },
    truePrice: { amount_cents: truePrice_cents, unit: trueUnit },
    total,
    lineItems,
    feeLoadPct,
    confidence: confidenceFrom(lineItems),
    assumptions,
    disclosures,
  };
}

function analyzeHotel(advertised_cents, ctx) {
  const market = HOTEL.markets[ctx.market] || HOTEL.markets.default;
  const nights = Number.isInteger(ctx.nights) && ctx.nights >= 1 && ctx.nights <= 60 ? ctx.nights : 1;
  const assumptions = [];
  const disclosures = [];
  const items = [item('room', 'Room rate', advertised_cents, 'base', 'listed')];

  let resortFee = 0;
  if (ctx.resortFee_cents !== undefined) {
    resortFee = assertCents(ctx.resortFee_cents, 'resortFee_cents');
    if (resortFee > 0) items.push(item('resort_fee', 'Resort fee', resortFee, 'fee', 'listed'));
  } else if (market.resortFee.prevalencePct >= 50) {
    resortFee = market.resortFee.typical_cents;
    items.push(item('resort_fee', 'Resort fee', resortFee, 'fee', 'typical',
      `${market.resortFee.prevalencePct}% of ${market.label} hotels charge one (typical ${centsToDollarsLabel(market.resortFee.typical_cents)}/night)`));
    assumptions.push(`Resort fee is the ${market.label} typical; the hotel's actual fee may differ.`);
  } else {
    assumptions.push('No resort fee assumed for this market; add one if the property charges it.');
  }

  let taxes = 0;
  if (ctx.tax_cents !== undefined) {
    taxes = assertCents(ctx.tax_cents, 'tax_cents');
    if (taxes > 0) items.push(item('taxes', 'Taxes', taxes, 'tax', 'listed'));
  } else {
    const taxPct = typeof ctx.taxPct === 'number' ? ctx.taxPct : market.occupancyTaxPct;
    const taxBase = advertised_cents + (market.taxAppliesToResortFee ? resortFee : 0);
    taxes = pctOf(taxBase, taxPct) + (market.occupancyFlatPerNight_cents || 0);
    items.push(item('taxes', `Occupancy taxes (${taxPct}%)`, taxes, 'tax', 'estimated'));
  }

  if (ctx.parking !== false) {
    if (ctx.parking_cents !== undefined) {
      const p = assertCents(ctx.parking_cents, 'parking_cents');
      if (p > 0) items.push(item('parking', 'Parking', p, 'addon', 'listed'));
    } else if (market.parking.prevalencePct >= 50) {
      items.push(item('parking', 'Parking', market.parking.typical_cents, 'addon', 'typical',
        `Typical for ${market.label}; skip if you won't have a car`));
      assumptions.push('Parking included at the market-typical rate; remove it if you are not driving.');
    }
  }

  const perNight = sum(items.map((i) => i.amount_cents));
  disclosures.push('Mandatory fees must now be shown in the advertised price under the FTC junk-fee rule; many quotes still surface them only at checkout.');
  return finishReport({
    vertical: 'hotel',
    advertised_cents,
    advertisedUnit: 'per_night',
    truePrice_cents: perNight,
    trueUnit: 'per_night',
    total: nights > 1 ? { amount_cents: perNight * nights, label: `${nights}-night stay total` } : null,
    lineItems: items,
    assumptions,
    disclosures,
  });
}

function analyzeFlight(advertised_cents, ctx) {
  const carrier = FLIGHT.carriers[ctx.carrier] || FLIGHT.carriers.typical_lcc;
  const assumptions = [];
  const disclosures = [];
  const items = [item('fare', `Base fare (${carrier.label})`, advertised_cents, 'base', 'listed')];

  if (ctx.carryOn !== false) {
    if (typeof ctx.carryOn_cents === 'number') {
      items.push(item('carry_on', 'Carry-on bag', assertCents(ctx.carryOn_cents, 'carryOn_cents'), 'fee', 'listed'));
    } else if (carrier.carryOn_cents > 0) {
      items.push(item('carry_on', 'Carry-on bag', carrier.carryOn_cents, 'fee', 'typical',
        `${carrier.prevalence.carryOnPct}% of travelers on this carrier type pay it`));
      assumptions.push('You bring one carry-on; set carryOn to false for a personal item only.');
    }
  }

  const bags = Number.isInteger(ctx.checkedBags) && ctx.checkedBags >= 0 && ctx.checkedBags <= 5 ? ctx.checkedBags : 0;
  if (bags > 0) {
    const per = typeof ctx.checkedBag_cents === 'number' ? assertCents(ctx.checkedBag_cents, 'checkedBag_cents') : carrier.checkedBag_cents;
    items.push(item('checked_bags', `Checked bag${bags > 1 ? `s × ${bags}` : ''}`, per * bags, 'fee',
      typeof ctx.checkedBag_cents === 'number' ? 'listed' : 'typical'));
  }

  if (ctx.seatSelection !== false) {
    if (typeof ctx.seat_cents === 'number') {
      items.push(item('seat', 'Seat selection', assertCents(ctx.seat_cents, 'seat_cents'), 'fee', 'listed'));
    } else if (carrier.seatSelection_cents > 0) {
      items.push(item('seat', 'Seat selection', carrier.seatSelection_cents, 'fee', 'typical',
        `${carrier.prevalence.seatPct}% pay to pick a seat; skip to be assigned one free at check-in`));
      assumptions.push('Includes a standard seat-selection fee; airlines assign a free seat at check-in if you skip it.');
    }
  }

  if (ctx.channel === 'ota') {
    const fee = typeof ctx.bookingFee_cents === 'number' ? assertCents(ctx.bookingFee_cents, 'bookingFee_cents') : FLIGHT.otaBookingFee.typical_cents;
    items.push(item('booking_fee', 'Booking-site fee', fee, 'fee', typeof ctx.bookingFee_cents === 'number' ? 'listed' : 'typical'));
    disclosures.push('Booking direct with the airline usually avoids this fee — and often prices the same or lower.');
  }

  if (ctx.taxesIncluded === false) {
    let taxes;
    if (typeof ctx.taxes_cents === 'number') {
      taxes = assertCents(ctx.taxes_cents, 'taxes_cents');
      items.push(item('taxes', 'Taxes & government fees', taxes, 'tax', 'listed'));
    } else {
      const t = FLIGHT.usDomesticTaxes;
      taxes = pctOf(advertised_cents, t.excisePct) + t.segmentFee_cents + t.securityFee_cents + t.passengerFacilityCharge_cents;
      items.push(item('taxes', 'Taxes & government fees', taxes, 'tax', 'estimated'));
    }
  } else {
    disclosures.push('US advertised fares already include base taxes (DOT full-fare rule); ancillary fees are the drip.');
  }

  const perFare = sum(items.map((i) => i.amount_cents));
  const travelers = Number.isInteger(ctx.travelers) && ctx.travelers >= 1 && ctx.travelers <= 9 ? ctx.travelers : 1;
  return finishReport({
    vertical: 'flight',
    advertised_cents,
    advertisedUnit: 'per_fare',
    truePrice_cents: perFare,
    trueUnit: 'per_fare',
    total: travelers > 1 ? { amount_cents: perFare * travelers, label: `${travelers} travelers total` } : null,
    lineItems: items,
    assumptions,
    disclosures,
  });
}

function analyzeTicket(advertised_cents, ctx) {
  const platform = TICKET.platforms[ctx.platform] || TICKET.platforms.default;
  const qty = Number.isInteger(ctx.quantity) && ctx.quantity >= 1 && ctx.quantity <= 20 ? ctx.quantity : 1;
  const assumptions = [];
  const disclosures = [];
  const items = [item('face', `Face value${qty > 1 ? ` × ${qty}` : ''}`, advertised_cents * qty, 'base', 'listed')];

  let serviceFee;
  if (typeof ctx.serviceFee_cents === 'number') {
    serviceFee = assertCents(ctx.serviceFee_cents, 'serviceFee_cents') * qty;
    items.push(item('service_fee', `Service fee${qty > 1 ? ` × ${qty}` : ''}`, serviceFee, 'fee', 'listed'));
  } else {
    const pct = typeof ctx.serviceFeePct === 'number' ? ctx.serviceFeePct : platform.serviceFeePct;
    serviceFee = pctOf(advertised_cents, pct) * qty;
    items.push(item('service_fee', `Service fee (~${pct}% of face)${qty > 1 ? ` × ${qty}` : ''}`, serviceFee, 'fee', 'typical',
      `${platform.label} service fees typically run ${platform.serviceFeeRangePct[0]}–${platform.serviceFeeRangePct[1]}% of face value`));
    assumptions.push(`Service fee estimated at the ${platform.label} typical rate; exact fee appears only at checkout.`);
  }

  const facility = typeof ctx.facility_cents === 'number' ? assertCents(ctx.facility_cents, 'facility_cents') : platform.facility_cents;
  if (facility > 0) {
    items.push(item('facility', `Facility charge${qty > 1 ? ` × ${qty}` : ''}`, facility * qty, 'fee',
      typeof ctx.facility_cents === 'number' ? 'listed' : 'typical'));
  }

  const processing = typeof ctx.orderProcessing_cents === 'number' ? assertCents(ctx.orderProcessing_cents, 'orderProcessing_cents') : platform.orderProcessing_cents;
  if (processing > 0) {
    items.push(item('order_processing', 'Order processing (per order)', processing, 'fee',
      typeof ctx.orderProcessing_cents === 'number' ? 'listed' : 'typical'));
  }

  if (typeof ctx.tax_cents === 'number') {
    if (ctx.tax_cents > 0) items.push(item('tax', 'Sales tax', assertCents(ctx.tax_cents, 'tax_cents'), 'tax', 'listed'));
  } else if (typeof ctx.taxPct === 'number') {
    const base = sum(items.map((i) => i.amount_cents));
    items.push(item('tax', `Sales tax (${ctx.taxPct}%)`, pctOf(base, ctx.taxPct), 'tax', 'estimated'));
  }

  const checkout = sum(items.map((i) => i.amount_cents));
  disclosures.push('Live-event tickets must be advertised all-in under the FTC junk-fee rule; resale platforms and add-ons still vary at checkout.');
  return finishReport({
    vertical: 'ticket',
    advertised_cents,
    advertisedUnit: 'per_ticket',
    truePrice_cents: checkout,
    trueUnit: 'checkout_total',
    total: { amount_cents: checkout, label: qty > 1 ? `Checkout estimate (${qty} tickets)` : 'Checkout estimate' },
    lineItems: items,
    assumptions,
    disclosures,
    advertisedEquiv_cents: advertised_cents * qty,
  });
}

function analyzeSubscription(advertised_cents, ctx) {
  const pattern = SUBSCRIPTION.patterns[ctx.pattern] || SUBSCRIPTION.patterns.default;
  const assumptions = [];
  const disclosures = [];

  const introMonths = Number.isInteger(ctx.introMonths) && ctx.introMonths >= 0 && ctx.introMonths <= 12
    ? ctx.introMonths : pattern.introMonthsTypical;
  const introListed = Number.isInteger(ctx.introMonths);

  let renewal;
  let renewalCertainty;
  if (typeof ctx.renewal_cents === 'number') {
    renewal = assertCents(ctx.renewal_cents, 'renewal_cents');
    renewalCertainty = 'listed';
  } else {
    renewal = Math.round(advertised_cents * pattern.renewalMultiple);
    renewalCertainty = 'estimated';
    assumptions.push(`Renewal price estimated at ${pattern.renewalMultiple}× the intro price (typical for ${pattern.label.toLowerCase()}).`);
  }

  const items = [];
  if (introMonths > 0) {
    items.push(item('intro', `Intro price × ${introMonths} months`, advertised_cents * introMonths, 'base',
      introListed ? 'listed' : 'typical'));
  }
  if (introMonths < 12) {
    items.push(item('renewal', `Renewal price × ${12 - introMonths} months`, renewal * (12 - introMonths), 'addon', renewalCertainty,
      `Price rises to ${centsToDollarsLabel(renewal)}/month after ${introMonths} month${introMonths === 1 ? '' : 's'}`));
  }
  if (typeof ctx.activation_cents === 'number' && ctx.activation_cents > 0) {
    items.push(item('activation', 'Activation / signup fee', assertCents(ctx.activation_cents, 'activation_cents'), 'fee', 'listed'));
  }

  const firstYear = sum(items.map((i) => i.amount_cents));
  if (introMonths < 12) {
    disclosures.push(`Price rises to ${centsToDollarsLabel(renewal)}/month after ${introMonths === 0 ? 'signup' : `${introMonths} months`}.`);
  }
  disclosures.push(`Effective cost is ${centsToDollarsLabel(Math.round(firstYear / 12))}/month over the first year, not ${centsToDollarsLabel(advertised_cents)}.`);

  return finishReport({
    vertical: 'subscription',
    advertised_cents,
    advertisedUnit: 'per_month',
    truePrice_cents: firstYear,
    trueUnit: 'first_year',
    total: { amount_cents: firstYear, label: 'First-year cost' },
    lineItems: items,
    assumptions,
    disclosures,
    advertisedEquiv_cents: advertised_cents * 12,
  });
}

function analyzeRetail(advertised_cents, ctx) {
  const assumptions = [];
  const disclosures = [];
  const items = [item('price', 'Listed price', advertised_cents, 'base', 'listed')];

  if (typeof ctx.shipping_cents === 'number' && ctx.shipping_cents > 0) {
    items.push(item('shipping', 'Shipping', assertCents(ctx.shipping_cents, 'shipping_cents'), 'fee', 'listed'));
  } else if (ctx.shipping_cents === undefined) {
    assumptions.push('Shipping assumed free; add it if this seller charges shipping.');
  }
  if (typeof ctx.handling_cents === 'number' && ctx.handling_cents > 0) {
    items.push(item('handling', 'Handling fee', assertCents(ctx.handling_cents, 'handling_cents'), 'fee', 'listed'));
  }
  if (typeof ctx.taxPct === 'number') {
    const base = sum(items.map((i) => i.amount_cents));
    items.push(item('tax', `Sales tax (${ctx.taxPct}%)`, pctOf(base, ctx.taxPct), 'tax', 'estimated'));
  } else {
    assumptions.push('Sales tax not included; supply taxPct for your state to include it.');
  }

  const total = sum(items.map((i) => i.amount_cents));
  return finishReport({
    vertical: 'retail',
    advertised_cents,
    advertisedUnit: 'total',
    truePrice_cents: total,
    trueUnit: 'total',
    total: null,
    lineItems: items,
    assumptions,
    disclosures,
  });
}

function centsToDollarsLabel(cents) {
  const dollars = Math.floor(cents / 100);
  const rem = cents % 100;
  return rem === 0 ? `$${dollars.toLocaleString('en-US')}` : `$${dollars.toLocaleString('en-US')}.${String(rem).padStart(2, '0')}`;
}

function analyze(request) {
  if (!request || typeof request !== 'object') throw new TypeError('request must be an object');
  const { vertical, advertised_cents } = request;
  if (!VERTICALS.includes(vertical)) throw new RangeError(`vertical must be one of ${VERTICALS.join(', ')}`);
  assertCents(advertised_cents, 'advertised_cents');
  const ctx = request.context && typeof request.context === 'object' ? request.context : {};

  switch (vertical) {
    case 'hotel': return analyzeHotel(advertised_cents, ctx);
    case 'flight': return analyzeFlight(advertised_cents, ctx);
    case 'ticket': return analyzeTicket(advertised_cents, ctx);
    case 'subscription': return analyzeSubscription(advertised_cents, ctx);
    case 'retail': return analyzeRetail(advertised_cents, ctx);
    /* c8 ignore next */
    default: throw new RangeError(`unhandled vertical ${vertical}`);
  }
}

module.exports = { analyze, VERTICALS };
