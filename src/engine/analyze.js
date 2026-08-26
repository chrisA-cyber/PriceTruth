import { assertCents, pctOf, sum } from './money.js';
import HOTEL from '../data/fees/hotel.json' with { type: 'json' };
import FLIGHT from '../data/fees/flight.json' with { type: 'json' };
import TICKET from '../data/fees/ticket.json' with { type: 'json' };
import SUBSCRIPTION from '../data/fees/subscription.json' with { type: 'json' };

const VERTICALS = ['hotel', 'flight', 'ticket', 'subscription', 'retail'];

// certainty: 'listed'   — value supplied in the request (seller/user quoted it)
//            'catalog'  — value copied from an approved dated source snapshot
//            'typical'  — market/carrier/platform typical from our fee datasets
//            'estimated'— computed heuristic
// Every non-'listed' line must be honest about being a projection; confidence
// and the disclosures array carry that honesty through to the UI and API.

// Own-property lookup with fallback: user-supplied keys like __proto__ or
// constructor must hit the fallback profile, never Object.prototype members.
function ownOr(map, key, fallback) {
  return typeof key === 'string' && Object.hasOwn(map, key) ? map[key] : map[fallback];
}

function item(code, label, amount_cents, kind, certainty, note) {
  assertCents(amount_cents, code);
  const it = { code, label, amount_cents, kind, certainty };
  if (note) it.note = note;
  return it;
}

function confidenceFrom(lineItems, unknownCosts = []) {
  let c = 1.0;
  for (const it of lineItems) {
    if (it.certainty === 'catalog') c -= 0.04;
    else if (it.certainty === 'typical') c -= 0.08;
    else if (it.certainty === 'estimated') c -= 0.12;
  }
  // A missing mandatory/conditional checkout input is an evidence gap, not a
  // zero-dollar line. Keep that uncertainty visible even when every emitted
  // amount was copied exactly from the caller or source.
  c -= Math.min(0.45, unknownCosts.length * 0.15);
  return Math.max(0.35, Math.round(c * 100) / 100);
}

function finishReport({ vertical, advertised_cents, advertisedUnit, truePrice_cents, trueUnit, total, lineItems, assumptions, disclosures, advertisedEquiv_cents, priceInclusion = null, unknownCosts = [] }) {
  assertCents(advertised_cents, 'advertised amount');
  assertCents(truePrice_cents, 'true-price total');
  if (total) assertCents(total.amount_cents, 'report total');
  const equiv = advertisedEquiv_cents ?? advertised_cents;
  assertCents(equiv, 'advertised equivalent');
  const feeLoadPct = equiv > 0 ? Math.round(((truePrice_cents - equiv) / equiv) * 1000) / 10 : 0;
  return {
    vertical,
    currency: 'USD',
    advertised: { amount_cents: advertised_cents, unit: advertisedUnit },
    truePrice: { amount_cents: truePrice_cents, unit: trueUnit },
    total,
    lineItems,
    feeLoadPct,
    confidence: confidenceFrom(lineItems, unknownCosts),
    completeness: {
      status: unknownCosts.length ? 'partial' : 'complete',
      unknownCosts,
    },
    assumptions,
    disclosures,
    ...(priceInclusion ? { priceInclusion } : {}),
  };
}

function combineCertainty(a, b) {
  const rank = { listed: 0, catalog: 1, typical: 2, estimated: 3 };
  return rank[a] >= rank[b] ? a : b;
}

function sourcedLabel(certainty, { listed, typical, estimated }) {
  if (certainty === 'catalog' || certainty === 'typical') return typical;
  if (certainty === 'estimated') return estimated;
  return listed;
}

const FTC_ALL_IN_EFFECTIVE = Date.parse('2025-05-12T00:00:00Z');
function hasSeparateFeeEvidence(ctx, bases) {
  if (!bases.includes(ctx.priceBasis) || typeof ctx.feeEvidence !== 'string' || ctx.feeEvidence.trim().length < 8) return false;
  if (ctx.priceBasis === 'pre_rule') return typeof ctx.asOf === 'string' && !Number.isNaN(Date.parse(ctx.asOf)) && Date.parse(ctx.asOf) < FTC_ALL_IN_EFFECTIVE;
  if (ctx.priceBasis === 'non_us') return typeof ctx.sourceRegion === 'string' && ctx.sourceRegion.toUpperCase() !== 'US';
  return true;
}

function analyzeHotel(advertised_cents, ctx, baseCertainty) {
  if (ctx.tax_cents !== undefined) assertCents(ctx.tax_cents, 'tax_cents');
  if (ctx.resortFee_cents !== undefined) assertCents(ctx.resortFee_cents, 'resortFee_cents');
  if (ctx.parking_cents !== undefined) assertCents(ctx.parking_cents, 'parking_cents');
  const market = ownOr(HOTEL.markets, ctx.market, 'default');
  const nights = Number.isInteger(ctx.nights) && ctx.nights >= 1 && ctx.nights <= 60 ? ctx.nights : 1;
  const assumptions = [], disclosures = [], unknownCosts = [];
  const quotedTotal = ctx.quotedTotal_cents === undefined ? null : assertCents(ctx.quotedTotal_cents, 'quotedTotal_cents');
  const mandatoryFeesIncluded = ctx.mandatoryFeesIncluded === true;
  const separateMandatoryFees = ctx.mandatoryFeesIncluded === false && hasSeparateFeeEvidence(ctx, ['room_only', 'pre_rule', 'non_us']);
  const taxesIncluded = ctx.taxesIncluded === true;
  const separateTaxes = ctx.tax_cents !== undefined || (ctx.taxesIncluded === false && hasSeparateFeeEvidence(ctx, ['room_only', 'pre_rule', 'non_us']));
  const roomLabel = quotedTotal === null
    ? sourcedLabel(baseCertainty, { listed: 'Room rate', typical: 'Catalog room rate', estimated: 'Modeled room rate' })
    : sourcedLabel(baseCertainty, { listed: 'Seller-listed stay price (rounded nightly average)', typical: 'Catalog stay price (rounded nightly average)', estimated: 'Modeled stay price (rounded nightly average)' });
  const items = [item('room', roomLabel, advertised_cents, 'base', baseCertainty)];

  let resortFee = 0;
  if (mandatoryFeesIncluded) {
    disclosures.push('The supplied source explicitly marks calculable mandatory lodging fees as included.');
  } else if (ctx.resortFee_cents !== undefined) {
    resortFee = assertCents(ctx.resortFee_cents, 'resortFee_cents');
    if (resortFee > 0) items.push(item('resort_fee', 'Resort fee', resortFee, 'fee', 'listed'));
  } else if (separateMandatoryFees && market.resortFee.prevalencePct >= 50) {
    resortFee = market.resortFee.typical_cents;
    items.push(item('resort_fee', 'Resort fee', resortFee, 'fee', 'typical',
      `${market.resortFee.prevalencePct}% of ${market.label} hotels charge one (typical ${centsToDollarsLabel(market.resortFee.typical_cents)}/night)`));
    assumptions.push(`Resort fee is the ${market.label} typical; the hotel's actual fee may differ.`);
  } else if (separateMandatoryFees) {
    assumptions.push('No resort fee assumed for this market; add one if the property charges it.');
  } else {
    assumptions.push('Mandatory lodging-fee inclusion is unknown; confirm the displayed price with the seller.');
    unknownCosts.push({ code: 'mandatory-hotel-fees', label: 'Mandatory hotel fees', reason: 'The source did not attest whether resort, destination, or other mandatory lodging fees are included.' });
  }

  if (taxesIncluded) {
    disclosures.push('The supplied source explicitly marks lodging taxes as included.');
  } else if (ctx.tax_cents !== undefined) {
    if (ctx.tax_cents > 0) items.push(item('taxes', 'Taxes', ctx.tax_cents, 'tax', 'listed'));
  } else if (separateTaxes) {
    const taxPct = typeof ctx.taxPct === 'number' ? ctx.taxPct : market.occupancyTaxPct;
    const taxBase = advertised_cents + (market.taxAppliesToResortFee ? resortFee : 0);
    const taxes = pctOf(taxBase, taxPct) + (market.occupancyFlatPerNight_cents || 0);
    items.push(item('taxes', `Occupancy taxes (${taxPct}%)`, taxes, 'tax', 'estimated'));
  } else {
    assumptions.push('Lodging taxes are unknown; confirm the checkout jurisdiction and seller total.');
    unknownCosts.push({ code: 'hotel-taxes', label: 'Hotel taxes', reason: 'The source did not attest that lodging taxes are included or provide an excluded tax amount.' });
  }

  if (ctx.parking === true || ctx.parking_cents !== undefined) {
    if (ctx.parking_cents !== undefined) {
      const parking = assertCents(ctx.parking_cents, 'parking_cents');
      if (parking > 0) items.push(item('parking', 'Parking', parking, 'addon', 'listed'));
    } else if (market.parking.prevalencePct >= 50) {
      items.push(item('parking', 'Parking', market.parking.typical_cents, 'addon', 'typical', `Typical for ${market.label}; skip if you won't have a car`));
      assumptions.push('Parking included at the market-typical rate; remove it if you are not driving.');
    }
  }

  const perNight = sum(items.map((entry) => entry.amount_cents));
  if (quotedTotal !== null) disclosures.push('The seller-provided full-stay total is preserved exactly; the nightly figure is only a rounded average for comparison.');
  const exactTotal = quotedTotal === null ? perNight * nights : quotedTotal + (perNight - advertised_cents) * nights;
  return finishReport({
    vertical: 'hotel', advertised_cents, advertisedUnit: 'per_night', truePrice_cents: perNight, trueUnit: 'per_night',
    total: nights > 1 || quotedTotal !== null ? { amount_cents: exactTotal, label: unknownCosts.length ? `${nights}-night known subtotal` : quotedTotal === null ? `${nights}-night stay total` : sourcedLabel(baseCertainty, { listed: `Seller-listed ${nights}-night stay total`, typical: `Catalog ${nights}-night stay total`, estimated: `Modeled ${nights}-night stay total` }) } : null,
    lineItems: items, assumptions, disclosures, unknownCosts,
    priceInclusion: {
      mandatoryFeesIncluded: mandatoryFeesIncluded ? true : separateMandatoryFees ? false : null,
      taxesIncluded: taxesIncluded ? true : separateTaxes ? false : null,
      basis: separateMandatoryFees || separateTaxes ? ctx.priceBasis : mandatoryFeesIncluded || taxesIncluded ? 'source_attestation' : 'unknown',
      evidence: separateMandatoryFees || separateTaxes ? ctx.feeEvidence?.trim().slice(0, 240) || null : null,
    },
  });
}

function analyzeFlight(advertised_cents, ctx, baseCertainty) {
  const carrier = ownOr(FLIGHT.carriers, ctx.carrier, 'typical_lcc');
  const assumptions = [];
  const disclosures = [];
  const unknownCosts = [];
  const fareLabel = ctx.taxesIncluded === true
    ? sourcedLabel(baseCertainty, { listed: `Seller-listed fare including mandatory taxes (${carrier.label})`, typical: `Catalog fare including mandatory taxes (${carrier.label})`, estimated: `Modeled fare including mandatory taxes (${carrier.label})` })
    : sourcedLabel(baseCertainty, { listed: `Base fare (${carrier.label})`, typical: `Typical base fare (${carrier.label})`, estimated: `Modeled base fare (${carrier.label})` });
  const items = [item('fare', fareLabel, advertised_cents, 'base', baseCertainty)];

  if (ctx.carryOn === true || typeof ctx.carryOn_cents === 'number') {
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

  if (ctx.seatSelection === true || typeof ctx.seat_cents === 'number') {
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

  if (ctx.taxes_cents !== undefined) assertCents(ctx.taxes_cents, 'taxes_cents');
  const taxesIncluded = ctx.taxesIncluded === true;
  const separateTaxes = ctx.taxes_cents !== undefined || (ctx.taxesIncluded === false && hasSeparateFeeEvidence(ctx, ['base_fare', 'pre_rule', 'non_us']));
  if (separateTaxes) {
    let taxes;
    if (typeof ctx.taxes_cents === 'number') {
      taxes = assertCents(ctx.taxes_cents, 'taxes_cents');
      items.push(item('taxes', 'Taxes & government fees', taxes, 'tax', 'listed'));
    } else {
      const t = FLIGHT.usDomesticTaxes;
      taxes = pctOf(advertised_cents, t.excisePct) + t.segmentFee_cents + t.securityFee_cents + t.passengerFacilityCharge_cents;
      items.push(item('taxes', 'Taxes & government fees', taxes, 'tax', 'estimated'));
    }
  } else if (taxesIncluded) {
    disclosures.push('The supplied source explicitly marks mandatory taxes and carrier charges as included; selected ancillaries remain separate.');
  } else {
    assumptions.push('Mandatory airfare taxes and carrier-charge inclusion is unknown; confirm the seller total.');
    unknownCosts.push({ code: 'mandatory-flight-charges', label: 'Taxes and mandatory carrier charges', reason: 'The source did not attest that mandatory airfare charges are included or provide their excluded amount.' });
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
    unknownCosts,
    priceInclusion: {
      mandatoryFeesIncluded: taxesIncluded ? true : separateTaxes ? false : null,
      taxesIncluded: taxesIncluded ? true : separateTaxes ? false : null,
      basis: separateTaxes ? ctx.priceBasis : taxesIncluded ? 'source_attestation' : 'unknown',
      evidence: separateTaxes ? ctx.feeEvidence?.trim().slice(0, 240) || null : null,
    },
  });
}

function analyzeTicket(advertised_cents, ctx, baseCertainty) {
  if (ctx.tax_cents !== undefined) assertCents(ctx.tax_cents, 'tax_cents');
  const platform = ownOr(TICKET.platforms, ctx.platform, 'default');
  const qty = Number.isInteger(ctx.quantity) && ctx.quantity >= 1 && ctx.quantity <= 20 ? ctx.quantity : 1;
  const assumptions = [];
  const disclosures = [];
  const unknownCosts = [];
  const separateMandatoryFees = ctx.allInclusivePricing === false && hasSeparateFeeEvidence(ctx, ['face_value', 'pre_rule', 'non_us']);
  const allInclusive = ctx.allInclusivePricing === true;
  const baseLabel = allInclusive
    ? sourcedLabel(baseCertainty, { listed: 'Seller-listed all-in price', typical: 'Catalog all-in price', estimated: 'Modeled mandatory-fee-inclusive price' })
    : sourcedLabel(baseCertainty, { listed: 'Face value', typical: 'Typical face value', estimated: 'Modeled face value' });
  const items = [item('face', `${baseLabel}${qty > 1 ? ` × ${qty}` : ''}`, advertised_cents * qty, 'base', baseCertainty)];

  if (allInclusive) {
    if (ctx.tax_cents !== undefined) {
      const tax = assertCents(ctx.tax_cents, 'tax_cents');
      if (tax > 0) items.push(item('tax', 'Explicitly excluded tax', tax, 'tax', 'listed'));
    }
    const checkout = sum(items.map((entry) => entry.amount_cents));
    disclosures.push(baseCertainty === 'estimated'
      ? 'This modeled example treats the current US displayed ticket price as mandatory-fee-inclusive; it is not a seller quote.'
      : 'This source reports the mandatory-fee-inclusive US ticket price; optional add-ons and taxes not represented by the source may still vary.');
    if (ctx.taxesIncluded !== true && ctx.tax_cents === undefined) {
      unknownCosts.push({ code: 'ticket-taxes', label: 'Ticket taxes', reason: 'The source did not attest that government taxes are included or provide an excluded amount.' });
    }
    return finishReport({
      vertical: 'ticket', advertised_cents, advertisedUnit: 'per_ticket', truePrice_cents: checkout,
      trueUnit: 'checkout_total', total: { amount_cents: checkout, label: unknownCosts.length ? (qty > 1 ? `Known subtotal (${qty} tickets)` : 'Known subtotal') : sourcedLabel(baseCertainty, { listed: qty > 1 ? `Listed total (${qty} tickets)` : 'Listed total', typical: qty > 1 ? `Catalog total (${qty} tickets)` : 'Catalog total', estimated: qty > 1 ? `Modeled total (${qty} tickets)` : 'Modeled total' }) },
      lineItems: items, assumptions, disclosures, advertisedEquiv_cents: checkout, unknownCosts,
      priceInclusion: { mandatoryFeesIncluded: true, taxesIncluded: ctx.taxesIncluded === true ? true : ctx.tax_cents !== undefined ? false : null, basis: 'source_attestation', evidence: null },
    });
  }

  if (!separateMandatoryFees) {
    unknownCosts.push({ code: 'mandatory-ticket-fees', label: 'Mandatory ticket fees', reason: 'The source did not attest that all mandatory ticket fees are included.' });
    if (ctx.tax_cents !== undefined) {
      const tax = assertCents(ctx.tax_cents, 'tax_cents');
      if (tax > 0) items.push(item('tax', 'Explicitly excluded tax', tax, 'tax', 'listed'));
    } else if (typeof ctx.taxPct === 'number') {
      const base = sum(items.map((entry) => entry.amount_cents));
      items.push(item('tax', `Sales tax (${ctx.taxPct}%)`, pctOf(base, ctx.taxPct), 'tax', 'estimated'));
    } else if (ctx.taxesIncluded !== true) {
      unknownCosts.push({ code: 'ticket-taxes', label: 'Ticket taxes', reason: 'The source did not attest that government taxes are included or provide an excluded amount.' });
    }
    const knownSubtotal = sum(items.map((entry) => entry.amount_cents));
    disclosures.push('This is a known subtotal only; mandatory ticket fees or taxes may still be added by the seller.');
    return finishReport({
      vertical: 'ticket', advertised_cents, advertisedUnit: 'per_ticket', truePrice_cents: knownSubtotal,
      trueUnit: 'checkout_total', total: { amount_cents: knownSubtotal, label: qty > 1 ? `Known subtotal (${qty} tickets)` : 'Known subtotal' },
      lineItems: items, assumptions, disclosures, advertisedEquiv_cents: advertised_cents * qty, unknownCosts,
      priceInclusion: { mandatoryFeesIncluded: null, taxesIncluded: ctx.taxesIncluded === true ? true : ctx.tax_cents !== undefined || typeof ctx.taxPct === 'number' ? false : null, basis: 'unknown', evidence: null },
    });
  }

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
  } else if (ctx.taxesIncluded !== true) {
    unknownCosts.push({ code: 'ticket-taxes', label: 'Ticket taxes', reason: 'The source did not attest that government taxes are included or provide an excluded amount.' });
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
    unknownCosts,
    priceInclusion: { mandatoryFeesIncluded: false, taxesIncluded: ctx.taxesIncluded === true ? true : ctx.tax_cents !== undefined || typeof ctx.taxPct === 'number' ? false : null, basis: ctx.priceBasis, evidence: ctx.feeEvidence.trim().slice(0, 240) },
  });
}

function analyzeSubscription(advertised_cents, ctx, baseCertainty) {
  if (['stable_monthly', 'fixed_term', 'teaser'].includes(ctx.pricingMode)) {
    const months = Number.isInteger(ctx.termMonths) && ctx.termMonths >= 1 && ctx.termMonths <= 60 ? ctx.termMonths : 12;
    const assumptions = [], disclosures = [], items = [];
    let totalCents = 0;
    if (ctx.pricingMode === 'teaser') {
      const introMonths = Number.isInteger(ctx.introMonths) && ctx.introMonths >= 0 && ctx.introMonths <= 60 ? ctx.introMonths : months;
      const introWithinTerm = Math.min(months, introMonths);
      if (introWithinTerm > 0) {
        items.push(item('intro', `${sourcedLabel(baseCertainty, { listed: 'Intro price', typical: 'Catalog intro price', estimated: 'Modeled intro price' })} × ${introWithinTerm} months`, advertised_cents * introWithinTerm, 'base', baseCertainty));
        totalCents += advertised_cents * introWithinTerm;
      }
      if (months > introWithinTerm) {
        if (typeof ctx.renewal_cents !== 'number') throw new RangeError('renewal_cents is required when a teaser renews within the represented term');
        const renewal = assertCents(ctx.renewal_cents, 'renewal_cents');
        items.push(item('renewal', `Renewal price × ${months - introWithinTerm} months`, renewal * (months - introWithinTerm), 'addon', baseCertainty,
          `Price rises to ${centsToDollarsLabel(renewal)}/month after ${introWithinTerm} months`));
        totalCents += renewal * (months - introWithinTerm);
      }
      if (typeof ctx.renewal_cents === 'number') {
        const renewal = assertCents(ctx.renewal_cents, 'renewal_cents');
        disclosures.push(`The sourced renewal price is ${centsToDollarsLabel(renewal)}/month after ${introMonths} month${introMonths === 1 ? '' : 's'}; it is not added before that renewal date.`);
      }
    } else {
      items.push(item('term', `${sourcedLabel(baseCertainty, { listed: 'Listed price', typical: 'Catalog price', estimated: 'Modeled price' })} × ${months} months`, advertised_cents * months, 'base', baseCertainty));
      totalCents = advertised_cents * months;
    }
    if (typeof ctx.activation_cents === 'number' && ctx.activation_cents > 0) {
      const activation = assertCents(ctx.activation_cents, 'activation_cents');
      items.push(item('activation', 'Activation / signup fee', activation, 'fee', 'listed'));
      totalCents += activation;
    }
    if (ctx.billedUpfront) disclosures.push(`The ${months}-month term is billed up front even though the headline price is expressed per month.`);
    const periodLabel = months === 12 ? 'First-year cost' : `${months}-month term total`;
    disclosures.push(`Effective cost is ${centsToDollarsLabel(Math.round(totalCents / months))}/month over this ${months}-month period.`);
    return finishReport({
      vertical: 'subscription', advertised_cents, advertisedUnit: 'per_month',
      truePrice_cents: totalCents, trueUnit: months === 12 ? 'first_year' : 'term_total',
      total: { amount_cents: totalCents, label: periodLabel }, lineItems: items, assumptions, disclosures,
      advertisedEquiv_cents: advertised_cents * months,
    });
  }
  const pattern = ownOr(SUBSCRIPTION.patterns, ctx.pattern, 'default');
  const assumptions = [];
  const disclosures = [];

  const introListed = Number.isInteger(ctx.introMonths) && ctx.introMonths >= 0 && ctx.introMonths <= 12;
  const introMonths = introListed ? ctx.introMonths : pattern.introMonthsTypical;

  let renewal;
  let renewalCertainty;
  if (typeof ctx.renewal_cents === 'number') {
    renewal = assertCents(ctx.renewal_cents, 'renewal_cents');
    renewalCertainty = baseCertainty;
  } else {
    renewal = Math.round(advertised_cents * pattern.renewalMultiple);
    renewalCertainty = 'estimated';
    assumptions.push(`Renewal price estimated at ${pattern.renewalMultiple}× the intro price (typical for ${pattern.label.toLowerCase()}).`);
  }

  const items = [];
  if (introMonths > 0) {
    items.push(item('intro', `Intro price × ${introMonths} months`, advertised_cents * introMonths, 'base',
      combineCertainty(baseCertainty, introListed ? 'listed' : 'typical')));
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

function analyzeRetail(advertised_cents, ctx, baseCertainty) {
  const assumptions = [];
  const disclosures = [];
  const unknownCosts = [];
  const items = [item('price', sourcedLabel(baseCertainty, { listed: 'Listed price', typical: 'Catalog price', estimated: 'Modeled price' }), advertised_cents, 'base', baseCertainty)];

  if (typeof ctx.shipping_cents === 'number') {
    const shipping = assertCents(ctx.shipping_cents, 'shipping_cents');
    if (shipping > 0) items.push(item('shipping', 'Shipping', shipping, 'fee', 'listed'));
  } else {
    assumptions.push('Shipping is unknown; add the seller quote, including 0 when free.');
    unknownCosts.push({ code: 'shipping', label: 'Shipping', reason: 'Seller shipping amount was not supplied and may apply.' });
  }
  if (typeof ctx.handling_cents === 'number') {
    const handling = assertCents(ctx.handling_cents, 'handling_cents');
    if (handling > 0) items.push(item('handling', 'Handling fee', handling, 'fee', 'listed'));
  } else if (ctx.handlingIncluded !== true && ctx.mandatoryExtrasIncluded !== true) {
    assumptions.push('Handling or other mandatory seller charges are unknown; supply the quoted amount, including 0 when none apply.');
    unknownCosts.push({ code: 'handling', label: 'Handling or mandatory seller charges', reason: 'The seller source did not provide handling or attest that no other mandatory seller charge applies.' });
  }
  if (typeof ctx.taxPct === 'number') {
    const base = sum(items.map((i) => i.amount_cents));
    items.push(item('tax', `Sales tax (${ctx.taxPct}%)`, pctOf(base, ctx.taxPct), 'tax', 'estimated'));
  } else {
    assumptions.push('Sales tax is unknown; supply taxPct for the checkout jurisdiction, including 0 when exempt.');
    unknownCosts.push({ code: 'sales-tax', label: 'Sales tax', reason: 'Checkout jurisdiction and tax rate were not supplied.' });
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
    unknownCosts,
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
  const baseCertainty = request.baseCertainty === undefined ? 'listed' : request.baseCertainty;
  if (!['listed', 'catalog', 'typical', 'estimated'].includes(baseCertainty)) throw new RangeError('baseCertainty must be listed, catalog, typical, or estimated');

  switch (vertical) {
    case 'hotel': return analyzeHotel(advertised_cents, ctx, baseCertainty);
    case 'flight': return analyzeFlight(advertised_cents, ctx, baseCertainty);
    case 'ticket': return analyzeTicket(advertised_cents, ctx, baseCertainty);
    case 'subscription': return analyzeSubscription(advertised_cents, ctx, baseCertainty);
    case 'retail': return analyzeRetail(advertised_cents, ctx, baseCertainty);
    /* c8 ignore next */
    default: throw new RangeError(`unhandled vertical ${vertical}`);
  }
}

export { analyze, VERTICALS };
