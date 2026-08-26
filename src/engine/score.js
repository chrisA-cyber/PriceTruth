import { fmtUSD } from './money.js';

// Deal quality 0–100 from price history plus fee load.
//  - up to 60 pts: where today's true price sits in the window's low..high range
//  - up to 20 pts: today vs. the window average
//  - up to 20 pts: how much added cost sits above the displayed price
function dealQuality({ current_cents, low_cents, high_cents, avg_cents, feeLoadPct = 0 }) {
  if (![current_cents, low_cents, high_cents, avg_cents].every((v) => Number.isSafeInteger(v) && v >= 0)) {
    return { score: null, label: 'no history', reasons: ['Not enough price history yet to score this deal.'] };
  }

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  const positionPts = high_cents === low_cents
    ? 30
    : clamp(Math.round(((high_cents - current_cents) / (high_cents - low_cents)) * 60), 0, 60);

  const diffPct = avg_cents > 0 ? ((avg_cents - current_cents) / avg_cents) * 100 : 0;
  const avgPts = clamp(Math.round(10 + diffPct), 0, 20);

  const feePts = clamp(Math.round(20 - feeLoadPct / 2), 0, 20);

  const score = clamp(positionPts + avgPts + feePts, 0, 100);
  const label = score >= 80 ? 'great deal' : score >= 60 ? 'good deal' : score >= 40 ? 'fair deal' : 'poor deal';

  const reasons = [];
  if (current_cents <= low_cents) reasons.push('Today matches the window low — as cheap as it has been.');
  else reasons.push(`Today is ${fmtUSD(current_cents - low_cents)} above the window low of ${fmtUSD(low_cents)}.`);
  if (current_cents > avg_cents) reasons.push(`Above the ${fmtUSD(avg_cents)} average for this window.`);
  else if (current_cents < avg_cents) reasons.push(`Below the ${fmtUSD(avg_cents)} average for this window.`);
  if (feeLoadPct >= 20) reasons.push(`Added costs add ${feeLoadPct}% on top of the advertised price.`);
  else if (feeLoadPct > 0) reasons.push(`Fees add a modest ${feeLoadPct}% to the advertised price.`);

  return { score, label, reasons };
}

export { dealQuality };
