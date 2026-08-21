'use strict';

/* PriceTruth SPA — zero dependencies, CSP-strict (no inline script, no eval).
   All DOM built via createElement/textContent; innerHTML is never used.
   All money is integer USD cents; formatting/parsing is string math only. */

(function () {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const app = document.getElementById('app');

  /* ================= DOM helpers ================= */

  function appendKids(node, kids) {
    for (const kid of kids) {
      if (kid === null || kid === undefined || kid === false || kid === true) continue;
      if (Array.isArray(kid)) { appendKids(node, kid); continue; }
      node.append(typeof kid === 'object' && kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
  }

  function el(tag, attrs, ...kids) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'value') node.value = v;
        else if (k === 'checked') node.checked = Boolean(v);
        else if (k === 'disabled') node.disabled = Boolean(v);
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v === true ? '' : String(v));
      }
    }
    appendKids(node, kids);
    return node;
  }

  function svg(tag, attrs, ...kids) {
    const node = document.createElementNS(SVG_NS, tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        node.setAttribute(k, String(v));
      }
    }
    for (const kid of kids) {
      if (kid === null || kid === undefined) continue;
      node.append(typeof kid === 'object' && kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  /* ================= money: string math only ================= */

  // integer cents -> "$1,234.56"
  function fmtUSD(cents, opts) {
    const compact = opts && opts.compact;
    if (!Number.isSafeInteger(cents)) return '$—';
    const neg = cents < 0;
    const digits = String(Math.abs(cents)).padStart(3, '0');
    const whole = digits.slice(0, -2);
    const frac = digits.slice(-2);
    let grouped = '';
    for (let i = 0; i < whole.length; i++) {
      if (i > 0 && (whole.length - i) % 3 === 0) grouped += ',';
      grouped += whole[i];
    }
    if (compact && frac === '00') return `${neg ? '-' : ''}$${grouped}`;
    return `${neg ? '-' : ''}$${grouped}.${frac}`;
  }

  // "219", "219.99", "$1,299.00", " $ 1,299 " -> integer cents (or null if invalid)
  function parseDollarsToCents(input) {
    if (typeof input !== 'string') return null;
    let s = input.trim();
    if (s.startsWith('$')) s = s.slice(1);
    s = s.replace(/,/g, '').replace(/\s+/g, '');
    if (!/^\d{1,7}(\.\d{1,2})?$/.test(s)) return null;
    const dot = s.indexOf('.');
    const whole = dot === -1 ? s : s.slice(0, dot);
    let frac = dot === -1 ? '' : s.slice(dot + 1);
    frac = (frac + '00').slice(0, 2);
    // string concatenation, then a single integer parse — no float math on money
    return parseInt(whole + frac, 10);
  }

  const UNIT_LABEL = {
    per_night: '/night',
    per_fare: '/fare',
    per_ticket: '/ticket',
    per_month: '/mo',
    total: '',
    checkout_total: 'at checkout',
    first_year: 'first year',
  };

  function unitLabel(unit) {
    return UNIT_LABEL[unit] !== undefined ? UNIT_LABEL[unit] : unit;
  }

  /* ================= fetch layer ================= */

  class AppError extends Error {
    constructor(kind, message, status, data) {
      super(message);
      this.kind = kind;
      this.status = status;
      this.data = data;
    }
  }

  async function fetchJSON(url, opts) {
    let res;
    try {
      res = await fetch(url, opts);
    } catch (err) {
      throw new AppError('network', 'Could not reach the PriceTruth server. Check your connection and try again.');
    }
    let data = null;
    try { data = await res.json(); } catch (err) { /* non-JSON body */ }
    if (res.status === 429) {
      throw new AppError('rate', 'Easy there — the demo rate limit kicked in. Give it a few seconds, then retry.', 429, data);
    }
    if (!res.ok) {
      const msg = data && data.error ? data.error : `Request failed (HTTP ${res.status}).`;
      throw new AppError('http', msg, res.status, data);
    }
    return data;
  }

  let metaCache = null;
  function getMeta() {
    if (!metaCache) {
      metaCache = fetchJSON('/api/meta').catch((err) => { metaCache = null; throw err; });
    }
    return metaCache;
  }

  /* ================= shared UI atoms ================= */

  function loadingBlock(msg) {
    return el('div', { class: 'state-block', role: 'status', 'aria-live': 'polite' },
      el('div', { class: 'spinner', 'aria-hidden': 'true' }),
      el('p', null, msg || 'Loading…'));
  }

  function errorBlock(err, onRetry) {
    const heading = err && err.kind === 'rate' ? 'Whoa — slow down a second' : 'Something went wrong';
    return el('div', { class: 'card state-error', role: 'alert' },
      el('h2', null, heading),
      el('p', null, err && err.message ? err.message : 'Unexpected error.'),
      onRetry ? el('button', { class: 'btn btn-secondary', type: 'button', onclick: onRetry }, 'Retry') : null);
  }

  function demoChip() {
    return el('span', { class: 'chip chip-demo' }, 'Demo data');
  }

  function verticalBadge(vertical) {
    return el('span', { class: 'chip chip-vertical' }, vertical);
  }

  function scoreChipClass(label) {
    if (label === 'great deal') return 'score-great';
    if (label === 'good deal') return 'score-good';
    if (label === 'fair deal') return 'score-fair';
    if (label === 'poor deal') return 'score-poor';
    return 'score-none';
  }

  function scoreChip(score) {
    if (!score || score.score === null || score.score === undefined) {
      return el('span', { class: 'chip score-none' }, 'no history yet');
    }
    return el('span', { class: `chip ${scoreChipClass(score.label)}` }, `${score.score}/100 · ${score.label}`);
  }

  function estimateTag(note) {
    return el('span', {
      class: 'chip chip-estimate',
      title: note || 'Projected from market-typical data, not a listed price.',
      tabindex: '0',
      'aria-label': `Estimate. ${note || 'Projected from market-typical data, not a listed price.'}`,
    }, 'estimate');
  }

  /* ================= deal-quality gauge (SVG) ================= */

  function scoreGauge(score) {
    const hasScore = score && Number.isFinite(score.score);
    const val = hasScore ? Math.max(0, Math.min(100, score.score)) : 0;
    const cls = hasScore
      ? scoreChipClass(score.label).replace('score-', 'gauge-')
      : 'gauge-none';

    // semicircle gauge: radius 44, arc from (10,64) to (118,64)
    const R = 44;
    const arcLen = Math.PI * R; // ≈ 138.23
    const shown = hasScore ? (val / 100) * arcLen : 0;
    const arcPath = `M 20 68 A ${R} ${R} 0 0 1 108 68`;

    const g = svg('svg', {
      class: `gauge ${cls}`,
      viewBox: '0 0 128 78',
      width: '128',
      height: '78',
      role: 'img',
      'aria-label': hasScore ? `Deal quality score ${val} out of 100 — ${score.label}` : 'Deal quality: no history yet',
    },
      svg('path', { d: arcPath, fill: 'none', stroke: 'var(--surface-3)', 'stroke-width': '10', 'stroke-linecap': 'round' }),
      hasScore ? svg('path', {
        d: arcPath, fill: 'none', stroke: 'currentColor', 'stroke-width': '10', 'stroke-linecap': 'round',
        'stroke-dasharray': `${shown.toFixed(1)} ${arcLen.toFixed(1)}`,
      }) : null,
      svg('text', {
        x: '64', y: '58', 'text-anchor': 'middle',
        'font-size': '26', 'font-weight': '800', fill: 'var(--text)',
      }, hasScore ? String(val) : '—'),
      svg('text', {
        x: '64', y: '74', 'text-anchor': 'middle',
        'font-size': '9', fill: 'var(--text-faint)',
      }, hasScore ? 'deal quality / 100' : 'no history yet'));

    return g;
  }

  /* ================= shared report component ================= */

  function hiddenCostCents(report) {
    // Advertised-equivalent baseline in the true-price unit:
    //  - per_month -> first_year: advertised × 12
    //  - otherwise: the sum of 'base' line items (face × qty, room rate, listed price…)
    if (report.advertised.unit === 'per_month' && report.truePrice.unit === 'first_year') {
      return report.truePrice.amount_cents - report.advertised.amount_cents * 12;
    }
    let base = 0;
    for (const it of report.lineItems) if (it.kind === 'base') base += it.amount_cents;
    if (base === 0) base = report.advertised.amount_cents;
    return report.truePrice.amount_cents - base;
  }

  function feeLinePhrase(vertical) {
    if (vertical === 'subscription') return 'in renewal hikes & fees';
    return 'in fees & taxes';
  }

  function verdictPanel(report, score) {
    const trueU = unitLabel(report.truePrice.unit);
    const advU = unitLabel(report.advertised.unit);
    const hidden = hiddenCostCents(report);
    const confPct = Math.round(report.confidence * 100);

    const left = el('div', { class: 'verdict-main' },
      el('p', { class: 'verdict-kicker' }, 'True price'),
      el('div', { class: 'price-big', 'aria-label': `True price ${fmtUSD(report.truePrice.amount_cents)} ${trueU}` },
        fmtUSD(report.truePrice.amount_cents),
        trueU ? el('span', { class: 'unit' }, trueU) : null),
      el('p', { class: 'verdict-advertised' },
        'advertised as ',
        el('span', { class: 'price-struck' }, fmtUSD(report.advertised.amount_cents)),
        advU ? ` ${advU}` : ''),
      hidden > 0
        ? el('p', { class: 'verdict-fees' },
            `+${fmtUSD(hidden)} ${feeLinePhrase(report.vertical)} (${report.feeLoadPct}%)`)
        : el('p', { class: 'verdict-fees', style: 'color: var(--good)' }, 'No hidden costs detected'),
      report.total
        ? el('p', { class: 'verdict-total' }, `${report.total.label}: `, el('b', null, fmtUSD(report.total.amount_cents)))
        : null,
      el('p', { class: 'verdict-confidence' },
        el('span', { class: 'confidence-bar', role: 'img', 'aria-label': `Confidence ${confPct} percent` },
          el('span', { class: 'confidence-fill', style: `width:${confPct}%` })),
        `Confidence ${confPct}% — non-listed lines below are labeled as estimates.`));

    const kids = [left];
    if (score) {
      kids.push(el('div', { class: 'gauge-wrap' },
        scoreGauge(score),
        el('p', { class: `gauge-label ${scoreChipClass(score.label).replace('score-', 'gauge-')}` }, score.label),
        score.reasons && score.reasons.length
          ? el('ul', { class: 'gauge-reasons' }, score.reasons.map((r) => el('li', null, r)))
          : null));
    }
    return el('section', { class: 'card verdict', 'aria-label': 'True price verdict' }, kids);
  }

  function breakdownTable(report) {
    const rows = report.lineItems.map((it) => {
      const isEstimate = it.certainty === 'typical' || it.certainty === 'estimated';
      return el('tr', null,
        el('td', null,
          it.label,
          it.note && !isEstimate ? el('span', { class: 'line-note' }, it.note) : null),
        el('td', null, el('span', { class: `chip chip-kind-${it.kind}` }, it.kind)),
        el('td', null,
          isEstimate ? estimateTag(it.note) : el('span', { class: 'chip chip-listed' }, 'listed')),
        el('td', { class: 'amount' }, fmtUSD(it.amount_cents)));
    });

    // The Amount column sums to the per-unit true price, so the first footer
    // row must be that sum (never the multi-unit rollup). When a rollup exists
    // (e.g. a 3-night stay), it gets its own clearly-labeled second row.
    const sumLabel = `True price ${unitLabel(report.truePrice.unit)}`.trim();
    const footRows = [
      el('tr', null,
        el('td', { colspan: '3' }, sumLabel),
        el('td', { class: 'amount' }, fmtUSD(report.truePrice.amount_cents))),
    ];
    if (report.total) {
      footRows.push(el('tr', { class: 'foot-rollup' },
        el('td', { colspan: '3' }, report.total.label),
        el('td', { class: 'amount' }, fmtUSD(report.total.amount_cents))));
    }

    return el('div', { class: 'table-wrap' },
      el('table', { class: 'breakdown' },
        el('caption', { class: 'sr-only', style: 'position:absolute;left:-999px' }, 'Line-item cost breakdown'),
        el('thead', null, el('tr', null,
          el('th', { scope: 'col' }, 'Line item'),
          el('th', { scope: 'col' }, 'Kind'),
          el('th', { scope: 'col' }, 'Source'),
          el('th', { scope: 'col', class: 'amount' }, 'Amount'))),
        el('tbody', null, rows),
        el('tfoot', null, footRows)));
  }

  function assumptionsFold(report) {
    if (!report.assumptions.length && !report.disclosures.length) return null;
    return el('details', { class: 'fold' },
      el('summary', null, `Assumptions & disclosures (${report.assumptions.length + report.disclosures.length})`),
      el('div', { class: 'fold-body' },
        report.assumptions.length
          ? [el('p', null, el('b', null, 'Assumptions we made:')),
             el('ul', null, report.assumptions.map((a) => el('li', null, a)))]
          : null,
        report.disclosures.length
          ? [el('p', null, el('b', null, 'Worth knowing:')),
             el('ul', null, report.disclosures.map((d) => el('li', null, d)))]
          : null));
  }

  // The shared report renderer used by both the product page and the analyzer.
  function reportView(report, opts) {
    const score = opts && opts.score ? opts.score : null;
    const frag = document.createDocumentFragment();
    frag.append(verdictPanel(report, score));
    frag.append(el('section', { class: 'report-section' },
      el('div', { class: 'card', style: 'padding: 0.4rem 0' },
        el('h2', { style: 'padding: 0.8rem 1.25rem 0' }, 'Where the money goes'),
        breakdownTable(report))));
    const fold = assumptionsFold(report);
    if (fold) frag.append(el('section', { class: 'report-section' }, fold));
    return frag;
  }

  /* ================= price history chart ================= */

  function fmtDate(ts) {
    const d = new Date(ts);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  function historyChart(points, stats, days) {
    if (!points || points.length < 2) {
      return el('p', { class: 'chart-empty' }, 'Not enough history to chart yet.');
    }
    const W = 640, H = 240;
    const PAD = { l: 56, r: 16, t: 16, b: 30 };
    const innerW = W - PAD.l - PAD.r;
    const innerH = H - PAD.t - PAD.b;

    const values = points.map((p) => p.true_cents);
    let lo = Math.min(...values);
    let hi = Math.max(...values);
    if (stats) {
      lo = Math.min(lo, stats.low_cents);
      hi = Math.max(hi, stats.high_cents);
    }
    const span = Math.max(hi - lo, 1);
    lo -= Math.round(span * 0.06);
    hi += Math.round(span * 0.06);
    const range = hi - lo;

    const x = (i) => PAD.l + (i / (points.length - 1)) * innerW;
    const y = (v) => PAD.t + ((hi - v) / range) * innerH;

    let linePath = '';
    for (let i = 0; i < points.length; i++) {
      linePath += `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(points[i].true_cents).toFixed(1)} `;
    }
    const areaPath = `${linePath}L${x(points.length - 1).toFixed(1)} ${(PAD.t + innerH).toFixed(1)} L${PAD.l} ${(PAD.t + innerH).toFixed(1)} Z`;

    const kids = [
      svg('path', { class: 'chart-area', d: areaPath }),
      svg('path', { class: 'chart-line', d: linePath.trim() }),
    ];

    // dotted reference lines: low / avg / high
    if (stats) {
      const refs = [
        { v: stats.high_cents, cls: 'chart-ref chart-ref-high', lcls: 'chart-label chart-label-high', name: 'high' },
        { v: stats.avg_cents, cls: 'chart-ref chart-ref-avg', lcls: 'chart-label', name: 'avg' },
        { v: stats.low_cents, cls: 'chart-ref chart-ref-low', lcls: 'chart-label chart-label-low', name: 'low' },
      ];
      for (const r of refs) {
        const ry = y(r.v);
        kids.push(svg('line', { class: r.cls, x1: PAD.l, x2: W - PAD.r, y1: ry.toFixed(1), y2: ry.toFixed(1) }));
        kids.push(svg('text', { class: r.lcls, x: 2, y: (ry + 3).toFixed(1) }, fmtUSD(r.v, { compact: true })));
      }
    }

    // today marker (last point)
    const last = points[points.length - 1];
    kids.push(svg('circle', { class: 'chart-dot', cx: x(points.length - 1).toFixed(1), cy: y(last.true_cents).toFixed(1), r: '4.5' }));

    // x-axis date labels: first / middle / last
    const mid = Math.floor(points.length / 2);
    kids.push(svg('text', { class: 'chart-label', x: PAD.l, y: H - 8 }, fmtDate(points[0].ts)));
    kids.push(svg('text', { class: 'chart-label', x: W / 2, y: H - 8, 'text-anchor': 'middle' }, fmtDate(points[mid].ts)));
    kids.push(svg('text', { class: 'chart-label', x: W - PAD.r, y: H - 8, 'text-anchor': 'end' }, 'today'));

    const label = stats
      ? `True price over the last ${days} days. Today ${fmtUSD(last.true_cents)}, low ${fmtUSD(stats.low_cents)}, average ${fmtUSD(stats.avg_cents)}, high ${fmtUSD(stats.high_cents)}.`
      : `True price over the last ${days} days.`;

    return el('div', { class: 'chart-scroll' },
      svg('svg', { class: 'chart-svg', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': label }, ...kids));
  }

  function statChips(stats, todayCents, days) {
    if (!stats) return null;
    const chip = (cls, label, cents) =>
      el('div', { class: `stat-chip ${cls}` }, el('span', null, label), el('b', null, fmtUSD(cents)));
    return el('div', { class: 'stat-chips' },
      chip('stat-today', 'Today', todayCents),
      chip('stat-low', `${days}-day low`, stats.low_cents),
      chip('', `${days}-day average`, stats.avg_cents),
      chip('stat-high', `${days}-day high`, stats.high_cents));
  }

  /* ================= price alert form ================= */

  function alertForm(productId) {
    const wrap = el('div', { class: 'card panel' });
    const status = el('div', { 'aria-live': 'polite' });

    const emailInput = el('input', {
      type: 'email', id: `alert-email-${productId}`, autocomplete: 'email',
      placeholder: 'you@example.com', required: true, 'aria-label': 'Email for the price alert',
    });
    const priceInput = el('input', {
      type: 'text', inputmode: 'decimal', id: `alert-price-${productId}`,
      placeholder: 'e.g. 279.00', 'aria-label': 'Target true price in dollars',
    });
    const submitBtn = el('button', { class: 'btn', type: 'submit' }, 'Watch this price');

    let lastPayload = null;

    async function submit(premium) {
      clear(status);
      const email = emailInput.value.trim();
      if (!email || !email.includes('@')) {
        status.append(el('p', { class: 'form-error' }, 'Enter a valid email address.'));
        return;
      }
      const cents = parseDollarsToCents(priceInput.value);
      if (cents === null || cents <= 0) {
        status.append(el('p', { class: 'form-error' }, 'Enter a target price in dollars, like 279 or 279.99.'));
        return;
      }
      lastPayload = { email, product_id: productId, threshold_cents: cents };
      submitBtn.disabled = true;
      try {
        const body = premium ? { ...lastPayload, premium: true } : lastPayload;
        const data = await fetchJSON('/api/alerts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        status.append(el('p', { class: 'form-success' },
          `Alert set — we'll flag it when the true price drops below ${fmtUSD(cents)}.`));
        if (data && data.note) status.append(el('p', { class: 'disclosure' }, data.note));
      } catch (err) {
        if (err.status === 402 && err.data) {
          status.append(upsellCard(err.data, () => submit(true)));
        } else {
          status.append(el('p', { class: 'form-error' }, err.message));
        }
      } finally {
        submitBtn.disabled = false;
      }
    }

    const form = el('form', {
      'aria-label': 'Set a price alert',
      onsubmit: (e) => { e.preventDefault(); submit(false); },
    },
      el('div', { class: 'field' },
        el('label', { for: `alert-email-${productId}` }, 'Email'),
        emailInput),
      el('div', { class: 'field' },
        el('label', { for: `alert-price-${productId}` }, 'Alert me when the true price drops below ($)'),
        priceInput,
        el('span', { class: 'hint' }, 'Tracked against the true price — fees included, not the teaser number.')),
      submitBtn);

    wrap.append(
      el('h2', null, 'Price alert'),
      el('p', { style: 'font-size:0.88rem;color:var(--text-soft)' },
        'Free accounts get 1 alert. Demo build: alerts are stored, no email is sent.'),
      form,
      status);
    return wrap;
  }

  // The premium paywall card, rendered from the 402 response body.
  function upsellCard(data, onDemoUpgrade) {
    const up = data.upgrade;
    if (!up) {
      return el('p', { class: 'form-error' }, data.error || 'Alert limit reached.');
    }
    const includes = String(up.includes || '').split(',').map((s) => s.trim()).filter(Boolean);
    return el('div', { class: 'upsell', role: 'note' },
      el('h3', null, 'You found the paywall ',
        el('span', { class: 'chip chip-demo' }, 'demo')),
      el('p', { style: 'margin:0.25rem 0 0.5rem;color:var(--text-soft)' },
        data.error ? `${data.error[0].toUpperCase()}${data.error.slice(1)}.` : 'Free plan limit reached.'),
      el('p', { class: 'upsell-price' }, up.price || '$4/month'),
      includes.length
        ? el('ul', null, includes.map((i) => el('li', null, i)))
        : null,
      el('button', { class: 'btn', type: 'button', onclick: onDemoUpgrade },
        'Simulate premium & retry'),
      el('p', { class: 'fineprint' },
        'Demo: not purchasable yet — this button just re-sends the request flagged as premium. See ',
        el('a', { href: '/pricing' }, 'pricing'), ' for the real plan.'));
  }

  /* ================= book direct panel ================= */

  function bookDirectConfig(product) {
    const enc = encodeURIComponent;
    switch (product.vertical) {
      case 'hotel':
        return {
          partner: 'booking', partnerLabel: 'Booking.com',
          heading: 'Book direct & dodge the drip',
          blurb: 'Compare the all-in rate on a booking site — resort fees show up before checkout, not after.',
          cta: 'Check rates on Booking.com',
          href: `/go/booking?target=${enc('https://www.booking.com/searchresults.html?ss=Las+Vegas+Strip')}`,
        };
      case 'flight':
        return {
          partner: 'spirit', partnerLabel: 'Spirit Airlines',
          heading: 'Book direct & save the OTA fee',
          blurb: 'Booking with the airline usually skips the booking-site fee and prices the same or lower.',
          cta: 'Book direct with Spirit',
          href: `/go/spirit?target=${enc('https://www.spirit.com/book/flights')}`,
        };
      case 'ticket':
        return {
          partner: 'ticketmaster', partnerLabel: 'Ticketmaster',
          heading: 'Buy from the primary seller',
          blurb: 'Primary tickets must now show all-in prices up front — resale markups come on top of these fees.',
          cta: 'Search on Ticketmaster',
          href: `/go/ticketmaster?target=${enc('https://www.ticketmaster.com/search?q=arena+tour')}`,
        };
      default: {
        const target = product.url && product.url.startsWith('https://') ? product.url : 'https://example.com/';
        return {
          partner: 'example', partnerLabel: 'the seller (demo partner)',
          heading: 'Go straight to the source',
          blurb: 'Buying direct avoids marketplace markups and makes the renewal terms easier to find.',
          cta: 'Continue to the seller',
          href: `/go/example?target=${enc(target)}`,
        };
      }
    }
  }

  function bookDirectPanel(product) {
    const cfg = bookDirectConfig(product);
    return el('div', { class: 'card panel' },
      el('h2', null, cfg.heading),
      el('p', { style: 'font-size:0.88rem;color:var(--text-soft)' }, cfg.blurb),
      el('a', { class: 'btn', href: cfg.href, rel: 'noopener nofollow sponsored' }, cfg.cta),
      el('p', { class: 'disclosure' },
        'Affiliate link — PriceTruth may earn a commission at no extra cost to you; it never changes the numbers above.'));
  }

  /* ================= views ================= */

  function homeView() {
    const root = el('div', null);

    root.append(el('section', { class: 'hero' },
      el('h1', null, 'The actual price of anything online.'),
      el('div', { class: 'hero-contrast' },
        el('span', { class: 'quote-bubble quote-them' }, '“Can I get you a coupon?”'),
        el('span', { class: 'hero-vs' }, 'vs'),
        el('span', { class: 'quote-bubble quote-us' }, '“What will this actually cost me?”')),
      el('p', { class: 'hero-sub' },
        'Coupon extensions ask the first question. PriceTruth answers the second — resort fees, bag fees, service charges, and renewal hikes included, before you hit checkout.'),
      el('a', { class: 'btn', href: '/analyze' }, 'Analyze a price')));

    const grid = el('div', { class: 'product-grid' });
    const section = el('section', { 'aria-label': 'Demo products' },
      el('div', { class: 'section-head' },
        el('h2', null, 'Watching the drip'),
        demoChip()),
      el('p', { style: 'color:var(--text-soft);margin-top:-0.5rem' },
        'Five tracked example products with synthetic price history — click one for the full breakdown.'),
      grid);
    root.append(section);

    function load() {
      clear(grid);
      grid.append(loadingBlock('Loading demo products…'));
      fetchJSON('/api/products')
        .then((data) => {
          clear(grid);
          for (const p of data.products) grid.append(productCard(p));
        })
        .catch((err) => {
          clear(grid);
          grid.append(errorBlock(err, load));
        });
    }
    load();
    return root;
  }

  function productCard(payload) {
    const { product, report, score } = payload;
    const trueU = unitLabel(report.truePrice.unit);
    const advU = unitLabel(report.advertised.unit);
    return el('a', { class: 'card product-card', href: `/p/${product.id}`, 'aria-label': `${product.name}: true price ${fmtUSD(report.truePrice.amount_cents)} ${trueU}` },
      el('div', null, verticalBadge(product.vertical)),
      el('div', { class: 'pc-name' }, product.name),
      el('div', { class: 'pc-advertised' },
        'advertised ',
        el('span', { class: 'price-struck' }, fmtUSD(report.advertised.amount_cents)),
        advU ? ` ${advU}` : ''),
      el('div', { class: 'pc-real' },
        fmtUSD(report.truePrice.amount_cents),
        trueU ? el('span', { class: 'unit' }, ` ${trueU}`) : null),
      el('div', { class: 'pc-chips' },
        el('span', { class: 'chip chip-fee' }, `+${report.feeLoadPct}% fees`),
        scoreChip(score)));
  }

  function productView(id) {
    const root = el('div', null);
    let days = 30;
    let loadToken = 0;

    function load() {
      const token = ++loadToken;
      clear(root);
      root.append(loadingBlock('Crunching the true price…'));
      fetchJSON(`/api/products/${encodeURIComponent(id)}?days=${days}`)
        .then((payload) => {
          if (token !== loadToken) return;
          clear(root);
          renderProduct(payload);
        })
        .catch((err) => {
          if (token !== loadToken) return;
          clear(root);
          if (err.status === 404) {
            root.append(el('div', { class: 'card state-error' },
              el('h2', null, 'Product not found'),
              el('p', null, 'That demo product does not exist. '),
              el('a', { class: 'btn btn-secondary', href: '/' }, 'Back to all products')));
          } else {
            root.append(errorBlock(err, load));
          }
        });
    }

    function renderProduct(payload) {
      const { product, report, stats, score, history } = payload;

      root.append(el('div', { class: 'view-head' },
        el('a', { class: 'back-link', href: '/' }, '← All demo products'),
        el('h1', { style: 'margin-top:0.5rem' }, product.name),
        el('p', { style: 'display:flex;gap:0.5rem;flex-wrap:wrap;align-items:center' },
          verticalBadge(product.vertical), demoChip(),
          el('span', { style: 'font-size:0.82rem;color:var(--text-faint)' }, product.url))));

      document.title = `${product.name} — PriceTruth`;

      root.append(reportView(report, { score }));

      // ---- price history ----
      const todayCents = history && history.length ? history[history.length - 1].true_cents : report.truePrice.amount_cents;
      const chartHolder = el('div', null,
        historyChart(history, stats, days),
        statChips(stats, todayCents, days));

      const btn30 = el('button', { type: 'button', 'aria-pressed': days === 30 ? 'true' : 'false' }, '30 days');
      const btn90 = el('button', { type: 'button', 'aria-pressed': days === 90 ? 'true' : 'false' }, '90 days');
      btn30.addEventListener('click', () => { if (days !== 30) { days = 30; load(); } });
      btn90.addEventListener('click', () => { if (days !== 90) { days = 90; load(); } });

      root.append(el('section', { class: 'report-section' },
        el('div', { class: 'card', style: 'padding:1.1rem 1.25rem' },
          el('div', { class: 'history-head' },
            el('h2', null, 'True-price history ', demoChip()),
            el('div', { class: 'segmented', role: 'group', 'aria-label': 'History window' }, btn30, btn90)),
          chartHolder)));

      // ---- alert + book direct ----
      root.append(el('section', { class: 'report-section panel-grid' },
        alertForm(product.id),
        bookDirectPanel(product)));
    }

    load();
    return root;
  }

  /* ================= analyzer ================= */

  const EXAMPLES = [
    {
      label: 'Hotel — “$219” Vegas Strip',
      vertical: 'hotel',
      advertised: '219',
      context: { market: 'las_vegas', nights: 3, resortFee_cents: 4500, tax_cents: 3800, parking_cents: 1500 },
    },
    {
      label: 'Flight — “$189” low-cost carrier',
      vertical: 'flight',
      advertised: '189',
      context: {
        carrier: 'typical_lcc', carryOn_cents: 4500, seat_cents: 3200,
        channel: 'ota', bookingFee_cents: 800, taxesIncluded: false, taxes_cents: 2000,
      },
    },
    {
      label: 'Ticket — “$86” on Ticketmaster',
      vertical: 'ticket',
      advertised: '86',
      context: { platform: 'ticketmaster', serviceFee_cents: 2795, facility_cents: 700, orderProcessing_cents: 595, tax_cents: 710 },
    },
    {
      label: 'Subscription — “$9.99/mo” streaming',
      vertical: 'subscription',
      advertised: '9.99',
      context: { pattern: 'streaming', introMonths: 6, renewal_cents: 1999 },
    },
  ];

  function fieldRow(id, labelText, input, hint) {
    input.setAttribute('id', id);
    return el('div', { class: 'field' },
      el('label', { for: id }, labelText),
      input,
      hint ? el('span', { class: 'hint' }, hint) : null);
  }

  function checkRow(id, labelText, checked) {
    const input = el('input', { type: 'checkbox', id, checked });
    return {
      node: el('div', { class: 'field field-check' }, input, el('label', { for: id }, labelText)),
      input,
    };
  }

  function selectInput(optionsMap, selected) {
    const sel = el('select', null);
    for (const [value, label] of Object.entries(optionsMap)) {
      sel.append(el('option', { value, selected: value === selected }, label));
    }
    return sel;
  }

  function textInput(placeholder, value) {
    return el('input', { type: 'text', inputmode: 'decimal', placeholder: placeholder || '', value: value || '' });
  }

  function numberInput(min, max, value) {
    return el('input', { type: 'number', min: String(min), max: String(max), step: '1', value: value === undefined ? '' : String(value) });
  }

  // Reads an optional dollar field; '' -> undefined, invalid -> throws with the field name.
  function optionalCents(input, name) {
    const raw = input.value.trim();
    if (raw === '') return undefined;
    const cents = parseDollarsToCents(raw);
    if (cents === null) throw new AppError('form', `${name} must be a dollar amount like 45 or 45.50.`);
    return cents;
  }

  function optionalInt(input, name, lo, hi) {
    const raw = input.value.trim();
    if (raw === '') return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < lo || n > hi) throw new AppError('form', `${name} must be a whole number between ${lo} and ${hi}.`);
    return n;
  }

  function optionalPct(input, name) {
    const raw = input.value.trim();
    if (raw === '') return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || n > 100) throw new AppError('form', `${name} must be a percentage between 0 and 100.`);
    return n;
  }

  // Each builder returns { node, getContext(), setContext(ctx) }.
  function buildVerticalForm(vertical, meta) {
    const opts = meta.options;
    switch (vertical) {
      case 'hotel': {
        const market = selectInput(opts.hotelMarkets, 'las_vegas');
        const nights = numberInput(1, 60, 1);
        const resort = textInput('e.g. 45');
        const taxes = textInput('leave blank to estimate');
        const parking = textInput('e.g. 15');
        return {
          node: el('div', { class: 'form-grid' },
            fieldRow('f-market', 'Market', market),
            fieldRow('f-nights', 'Nights', nights),
            fieldRow('f-resort', 'Resort fee per night ($, optional)', resort, 'Blank = market-typical estimate'),
            fieldRow('f-taxes', 'Taxes per night ($, optional)', taxes, 'Blank = estimated from the market tax rate'),
            fieldRow('f-parking', 'Parking per night ($, optional)', parking, 'Blank = market-typical; enter 0 if free')),
          getContext() {
            const ctx = { market: market.value };
            const n = optionalInt(nights, 'Nights', 1, 60);
            if (n !== undefined) ctx.nights = n;
            const r = optionalCents(resort, 'Resort fee');
            if (r !== undefined) ctx.resortFee_cents = r;
            const t = optionalCents(taxes, 'Taxes');
            if (t !== undefined) ctx.tax_cents = t;
            const p = optionalCents(parking, 'Parking');
            if (p !== undefined) ctx.parking_cents = p;
            return ctx;
          },
          setContext(ctx) {
            if (ctx.market && opts.hotelMarkets[ctx.market]) market.value = ctx.market;
            if (Number.isInteger(ctx.nights)) nights.value = String(ctx.nights);
            if (Number.isInteger(ctx.resortFee_cents)) resort.value = fmtUSD(ctx.resortFee_cents).slice(1);
            if (Number.isInteger(ctx.tax_cents)) taxes.value = fmtUSD(ctx.tax_cents).slice(1);
            if (Number.isInteger(ctx.parking_cents)) parking.value = fmtUSD(ctx.parking_cents).slice(1);
          },
        };
      }
      case 'flight': {
        const carrier = selectInput(opts.flightCarriers, 'typical_lcc');
        const carryOn = checkRow('f-carryon', 'Bringing a carry-on bag', true);
        const bags = numberInput(0, 5, 0);
        const seat = checkRow('f-seat', 'Picking a seat', true);
        const ota = checkRow('f-ota', 'Booked through a booking site (OTA)', false);
        return {
          node: el('div', null,
            el('div', { class: 'form-grid' },
              fieldRow('f-carrier', 'Carrier', carrier),
              fieldRow('f-bags', 'Checked bags', bags)),
            carryOn.node, seat.node, ota.node),
          getContext() {
            const ctx = { carrier: carrier.value };
            if (!carryOn.input.checked) ctx.carryOn = false;
            if (!seat.input.checked) ctx.seatSelection = false;
            const b = optionalInt(bags, 'Checked bags', 0, 5);
            if (b !== undefined && b > 0) ctx.checkedBags = b;
            if (ota.input.checked) ctx.channel = 'ota';
            return ctx;
          },
          setContext(ctx) {
            if (ctx.carrier && opts.flightCarriers[ctx.carrier]) carrier.value = ctx.carrier;
            carryOn.input.checked = ctx.carryOn !== false;
            seat.input.checked = ctx.seatSelection !== false;
            if (Number.isInteger(ctx.checkedBags)) bags.value = String(ctx.checkedBags);
            ota.input.checked = ctx.channel === 'ota';
          },
        };
      }
      case 'ticket': {
        const platform = selectInput(opts.ticketPlatforms, 'ticketmaster');
        const qty = numberInput(1, 20, 1);
        const svcFee = textInput('leave blank to estimate');
        return {
          node: el('div', { class: 'form-grid' },
            fieldRow('f-platform', 'Platform', platform),
            fieldRow('f-qty', 'Tickets', qty),
            fieldRow('f-svc', 'Known service fee per ticket ($, optional)', svcFee, 'Blank = platform-typical estimate')),
          getContext() {
            const ctx = { platform: platform.value };
            const q = optionalInt(qty, 'Tickets', 1, 20);
            if (q !== undefined) ctx.quantity = q;
            const f = optionalCents(svcFee, 'Service fee');
            if (f !== undefined) ctx.serviceFee_cents = f;
            return ctx;
          },
          setContext(ctx) {
            if (ctx.platform && opts.ticketPlatforms[ctx.platform]) platform.value = ctx.platform;
            if (Number.isInteger(ctx.quantity)) qty.value = String(ctx.quantity);
            if (Number.isInteger(ctx.serviceFee_cents)) svcFee.value = fmtUSD(ctx.serviceFee_cents).slice(1);
          },
        };
      }
      case 'subscription': {
        const pattern = selectInput(opts.subscriptionPatterns, 'streaming');
        const intro = numberInput(0, 12, undefined);
        const renewal = textInput('leave blank to estimate');
        return {
          node: el('div', { class: 'form-grid' },
            fieldRow('f-pattern', 'Kind of subscription', pattern),
            fieldRow('f-intro', 'Intro months at the advertised price (optional)', intro, 'Blank = typical for this kind'),
            fieldRow('f-renewal', 'Renewal price per month if known ($, optional)', renewal, 'Blank = estimated from typical hikes')),
          getContext() {
            const ctx = { pattern: pattern.value };
            const m = optionalInt(intro, 'Intro months', 0, 12);
            if (m !== undefined) ctx.introMonths = m;
            const r = optionalCents(renewal, 'Renewal price');
            if (r !== undefined) ctx.renewal_cents = r;
            return ctx;
          },
          setContext(ctx) {
            if (ctx.pattern && opts.subscriptionPatterns[ctx.pattern]) pattern.value = ctx.pattern;
            if (Number.isInteger(ctx.introMonths)) intro.value = String(ctx.introMonths);
            if (Number.isInteger(ctx.renewal_cents)) renewal.value = fmtUSD(ctx.renewal_cents).slice(1);
          },
        };
      }
      case 'retail': {
        const shipping = textInput('blank = free shipping');
        const taxPct = el('input', { type: 'number', min: '0', max: '100', step: '0.01', placeholder: 'e.g. 8.375' });
        return {
          node: el('div', { class: 'form-grid' },
            fieldRow('f-ship', 'Shipping ($, optional)', shipping),
            fieldRow('f-taxpct', 'Sales tax % (optional)', taxPct, 'Blank = tax left out, and we say so')),
          getContext() {
            const ctx = {};
            const s = optionalCents(shipping, 'Shipping');
            if (s !== undefined) ctx.shipping_cents = s;
            const t = optionalPct(taxPct, 'Sales tax');
            if (t !== undefined) ctx.taxPct = t;
            return ctx;
          },
          setContext(ctx) {
            if (Number.isInteger(ctx.shipping_cents)) shipping.value = fmtUSD(ctx.shipping_cents).slice(1);
            if (typeof ctx.taxPct === 'number') taxPct.value = String(ctx.taxPct);
          },
        };
      }
      default:
        return { node: el('div'), getContext: () => ({}), setContext: () => {} };
    }
  }

  const PRICE_LABEL = {
    hotel: 'Advertised nightly rate ($)',
    flight: 'Advertised fare ($)',
    ticket: 'Advertised ticket price ($)',
    subscription: 'Advertised monthly price ($)',
    retail: 'Listed price ($)',
  };

  function analyzeView() {
    const root = el('div', null);
    root.append(el('div', { class: 'view-head' },
      el('h1', null, 'True-cost analyzer'),
      el('p', { style: 'color:var(--text-soft);max-width:42rem' },
        'Paste the advertised price, tell us what kind of purchase it is, and get the full picture — fees, taxes, and renewal traps included. Every projected number is labeled as an estimate.')));

    const holder = el('div', null, loadingBlock('Loading options…'));
    root.append(holder);

    getMeta()
      .then((meta) => { clear(holder); holder.append(buildAnalyzer(meta)); })
      .catch((err) => {
        clear(holder);
        holder.append(errorBlock(err, () => {
          clear(holder);
          holder.append(loadingBlock('Loading options…'));
          getMeta().then((meta) => { clear(holder); holder.append(buildAnalyzer(meta)); })
            .catch((e2) => { clear(holder); holder.append(errorBlock(e2)); });
        }));
      });

    return root;
  }

  function buildAnalyzer(meta) {
    const container = el('div', null);
    const resultHolder = el('div', { 'aria-live': 'polite' });
    const formStatus = el('div', null);

    const verticalSel = selectInput(
      Object.fromEntries(meta.verticals.map((v) => [v, v[0].toUpperCase() + v.slice(1)])),
      'hotel');
    verticalSel.setAttribute('aria-label', 'Purchase type');

    const priceInput = textInput('e.g. 219 or $1,299.00');
    priceInput.setAttribute('aria-label', 'Advertised price in dollars');

    const priceLabelEl = el('label', { for: 'f-price' }, PRICE_LABEL.hotel);
    priceInput.setAttribute('id', 'f-price');

    let currentForm = buildVerticalForm('hotel', meta);
    const dynamicHolder = el('div', null, currentForm.node);

    function switchVertical(v) {
      verticalSel.value = v;
      currentForm = buildVerticalForm(v, meta);
      clear(dynamicHolder);
      dynamicHolder.append(currentForm.node);
      priceLabelEl.textContent = PRICE_LABEL[v] || 'Advertised price ($)';
    }
    verticalSel.addEventListener('change', () => switchVertical(verticalSel.value));

    const submitBtn = el('button', { class: 'btn', type: 'submit' }, 'Reveal the true price');

    async function runAnalysis(vertical, advertised_cents, context) {
      clear(formStatus);
      clear(resultHolder);
      resultHolder.append(loadingBlock('Analyzing…'));
      submitBtn.disabled = true;
      try {
        const report = await fetchJSON('/api/analyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ vertical, advertised_cents, context }),
        });
        clear(resultHolder);
        resultHolder.append(
          el('h2', { style: 'margin:1.5rem 0 0.75rem' }, 'Your report'),
          reportView(report, {}));
        resultHolder.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } catch (err) {
        clear(resultHolder);
        formStatus.append(el('p', { class: 'form-error', role: 'alert' }, err.message));
      } finally {
        submitBtn.disabled = false;
      }
    }

    const form = el('form', {
      'aria-label': 'True-cost analyzer',
      onsubmit: (e) => {
        e.preventDefault();
        clear(formStatus);
        const cents = parseDollarsToCents(priceInput.value);
        if (cents === null || cents <= 0) {
          formStatus.append(el('p', { class: 'form-error', role: 'alert' },
            'Enter the advertised price in dollars — like 219, 219.99, or $1,299.00.'));
          return;
        }
        let context;
        try {
          context = currentForm.getContext();
        } catch (err) {
          formStatus.append(el('p', { class: 'form-error', role: 'alert' }, err.message));
          return;
        }
        runAnalysis(verticalSel.value, cents, context);
      },
    },
      el('div', { class: 'form-grid' },
        el('div', { class: 'field' },
          el('label', { for: 'f-vertical' }, 'What are you buying?'),
          verticalSel),
        el('div', { class: 'field' }, priceLabelEl, priceInput)),
      dynamicHolder,
      formStatus,
      submitBtn);
    verticalSel.setAttribute('id', 'f-vertical');

    // one-click example chips (the four pitch scenarios)
    const chips = el('div', { class: 'example-chips', role: 'group', 'aria-label': 'Example analyses' },
      EXAMPLES.map((ex) => el('button', {
        type: 'button',
        onclick: () => {
          switchVertical(ex.vertical);
          priceInput.value = ex.advertised;
          currentForm.setContext(ex.context);
          runAnalysis(ex.vertical, parseDollarsToCents(ex.advertised), ex.context);
        },
      }, ex.label)));

    container.append(
      el('p', { style: 'font-weight:650;font-size:0.88rem;color:var(--text-soft);margin-bottom:0.25rem' }, 'Try an example:'),
      chips,
      el('div', { class: 'card', style: 'padding:1.4rem' }, form),
      resultHolder);
    return container;
  }

  /* ================= pricing ================= */

  function pricingView() {
    const root = el('div', null);
    root.append(el('div', { class: 'view-head' },
      el('h1', null, 'Pricing'),
      el('p', { style: 'color:var(--text-soft)' }, 'Honest numbers deserve honest pricing. The truth layer is free; alerts at scale and the API pay the bills.')));

    const tier = (name, price, unit, items, action, opts) =>
      el('div', { class: `card tier${opts && opts.featured ? ' tier-featured' : ''}` },
        opts && opts.flag ? el('span', { class: 'tier-flag' }, opts.flag) : null,
        el('h2', null, name),
        el('p', { class: 'tier-price' }, price, unit ? el('span', { class: 'unit' }, unit) : null),
        el('ul', null, items.map((i) => el('li', null, i))),
        action);

    root.append(el('div', { class: 'tier-grid' },
      tier('Free', '$0', '/forever', [
        'Unlimited true-cost analyses',
        'Full fee & tax breakdowns',
        'Price history and deal scores',
        '1 price alert',
      ], el('a', { class: 'btn btn-secondary', href: '/analyze' }, 'Start analyzing')),
      tier('Premium', '$4', '/month', [
        '20 price alerts on true prices',
        'Weekly deal-quality digests',
        'Instant price-drop alerts',
        'Everything in Free',
      ], el('button', { class: 'btn', type: 'button', disabled: true }, 'Demo: not purchasable yet'),
        { featured: true, flag: 'Demo paywall' }),
      tier('B2B API', 'Custom', '', [
        'Starter: 100 calls/day',
        'Pro: 10,000 calls/day',
        'True-price reports as JSON',
        'Product history endpoints',
      ], el('a', { class: 'btn btn-secondary', href: '/api-docs' }, 'Read the API docs'))));

    root.append(el('p', { style: 'margin-top:1.25rem;font-size:0.85rem;color:var(--text-faint)' },
      'This is a prototype — Premium is a demo paywall (try adding a second price alert on any product), and API keys are minted locally.'));
    return root;
  }

  /* ================= API docs ================= */

  function codeBlock(text) {
    return el('pre', null, el('code', null, text));
  }

  function apiDocsView() {
    const root = el('div', { class: 'docs' });
    root.append(el('div', { class: 'view-head' },
      el('h1', null, 'B2B API'),
      el('p', { style: 'color:var(--text-soft);max-width:44rem' },
        'The same true-price engine behind this site, as JSON. Three endpoints, key-based auth, daily quotas. All money is integer USD cents.')));

    root.append(el('section', null,
      el('h2', null, 'Authentication'),
      el('p', null, 'Every request needs an ', el('code', { class: 'endpoint' }, 'X-API-Key'), ' header. Mint keys locally:'),
      codeBlock('npm run keygen -- "acme staging" starter\n# tiers: starter (100 calls/day) | pro (10,000 calls/day)'),
      el('p', null, 'Bad or missing keys get ', el('code', { class: 'endpoint' }, '401'),
        '; over quota gets ', el('code', { class: 'endpoint' }, '429'),
        ' (there is also a modest per-minute burst limit).')));

    root.append(el('section', null,
      el('h2', null, el('span', { class: 'method' }, 'POST'), ' ', el('code', { class: 'endpoint' }, '/api/v1/analyze')),
      el('p', null, 'Turn an advertised price into a full true-cost report. Body: ',
        el('code', { class: 'endpoint' }, '{vertical, advertised_cents, context?}'), '.'),
      codeBlock(`curl -s http://localhost:4780/api/v1/analyze \\
  -H "X-API-Key: $PRICETRUTH_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"vertical":"hotel","advertised_cents":21900,"context":{"market":"las_vegas","nights":3}}'
# -> { vertical, advertised, truePrice, lineItems[], feeLoadPct, confidence, ..., usage }`)));

    root.append(el('section', null,
      el('h2', null, el('span', { class: 'method' }, 'GET'), ' ', el('code', { class: 'endpoint' }, '/api/v1/products/:id')),
      el('p', null, 'A tracked product with its report, stats, deal score, and price history.'),
      codeBlock(`const res = await fetch('http://localhost:4780/api/v1/products/vegas-hotel', {
  headers: { 'X-API-Key': process.env.PRICETRUTH_KEY },
});
const { product, report, stats, score, history, usage } = await res.json();`)));

    root.append(el('section', null,
      el('h2', null, el('span', { class: 'method' }, 'GET'), ' ', el('code', { class: 'endpoint' }, '/api/v1/usage')),
      el('p', null, 'Where you stand against your daily quota.'),
      codeBlock(`curl -s http://localhost:4780/api/v1/usage -H "X-API-Key: $PRICETRUTH_KEY"
# -> { "usage": { "used_today": 12, "daily_limit": 100, "tier": "starter" } }`)));

    root.append(el('section', null,
      el('h2', null, 'Quotas'),
      el('p', null,
        el('b', null, 'Starter'), ': 100 calls/day. ',
        el('b', null, 'Pro'), ': 10,000 calls/day. Every response includes a ',
        el('code', { class: 'endpoint' }, 'usage'), ' object so you can meter yourself. See ',
        el('a', { href: '/pricing' }, 'pricing'), ' for plans.')));

    return root;
  }

  /* ================= extension ================= */

  function extensionView() {
    const root = el('div', null);
    root.append(el('div', { class: 'view-head' },
      el('h1', null, 'Browser extension'),
      el('p', { style: 'color:var(--text-soft);max-width:44rem' },
        'The truth layer at the moment you look at a price. It reads the price already on the page and shows what it will actually cost — computed locally, with ',
        el('b', null, 'zero network requests'), '. A prototype, so you install it unpacked (free, no store, 30 seconds).')));

    root.append(el('div', { class: 'card', style: 'display:flex;flex-wrap:wrap;gap:1rem;align-items:center;justify-content:space-between' },
      el('div', null,
        el('h2', { style: 'margin:0 0 0.25rem' }, 'Get it in two clicks'),
        el('p', { style: 'margin:0;color:var(--text-soft)' }, 'Download the extension, then load it unpacked in Chrome, Edge, or Brave.')),
      el('div', { style: 'display:flex;gap:0.6rem;flex-wrap:wrap' },
        el('a', { class: 'btn', href: '/download/extension.zip', download: 'pricetruth-extension.zip' }, 'Download extension (.zip)'),
        el('a', { class: 'btn btn-secondary', href: '/extension-demo.html' }, 'Open the live demo'))));

    const step = (n, title, body) =>
      el('li', { class: 'ext-step' },
        el('span', { class: 'ext-step-n' }, String(n)),
        el('div', null, el('b', null, title), el('div', { style: 'color:var(--text-soft);font-size:0.92rem' }, body)));

    root.append(el('section', { style: 'margin-top:1.5rem' },
      el('h2', null, 'Install it (unpacked)'),
      el('ol', { class: 'ext-steps' },
        step(1, 'Download and unzip', 'Grab the .zip above and extract it anywhere — you’ll get a pricetruth-extension folder.'),
        step(2, 'Open your extensions page', 'Go to chrome://extensions (or edge://extensions, brave://extensions).'),
        step(3, 'Turn on Developer mode', 'Toggle it on — usually top-right.'),
        step(4, 'Load unpacked', 'Click “Load unpacked” and pick the pricetruth-extension folder.'),
        step(5, 'Try it', ['Open the ', el('a', { href: '/extension-demo.html' }, 'live demo page'), ' — the badge appears bottom-right. It also runs on real booking, ticketing, and airline sites.']))));

    root.append(el('section', { style: 'margin-top:1.5rem' },
      el('h2', null, 'What it does'),
      el('ul', { class: 'ext-facts' },
        el('li', null, el('b', null, 'Reads the visible price'), ' on hotel, flight, and ticket pages and adds the fees you’d only see at checkout.'),
        el('li', null, el('b', null, 'Labels every estimate'), ' — anything beyond the advertised price is marked ', el('code', { class: 'endpoint' }, 'typical'), ' or ', el('code', { class: 'endpoint' }, 'estimated'), ', never presented as a quote.'),
        el('li', null, el('b', null, 'Sends nothing'), ' — the fee model is bundled; all math runs in your browser. No tracking, no accounts, no server calls.'),
        el('li', null, el('b', null, 'Stays quiet when unsure'), ' — if no price is confidently detected, it shows nothing.'))));

    root.append(el('p', { style: 'margin-top:1.25rem;font-size:0.85rem;color:var(--text-faint)' },
      'Prototype notes: install is unpacked (the Chrome Web Store version would need icons and review). Price detection on real sites is heuristic. The downloaded copy links back to this site automatically.'));
    return root;
  }

  /* ================= 404 ================= */

  function notFoundView() {
    return el('div', { class: 'card state-error' },
      el('h2', null, 'Page not found'),
      el('p', null, 'Nothing lives at this address.'),
      el('a', { class: 'btn btn-secondary', href: '/' }, 'Back home'));
  }

  /* ================= router ================= */

  const ROUTES = [
    { pattern: /^\/$/, title: 'PriceTruth — the actual price of anything online', view: () => homeView() },
    { pattern: /^\/p\/([a-z0-9-]{1,64})$/, title: 'Product — PriceTruth', view: (m) => productView(m[1]) },
    { pattern: /^\/analyze$/, title: 'Analyzer — PriceTruth', view: () => analyzeView() },
    { pattern: /^\/pricing$/, title: 'Pricing — PriceTruth', view: () => pricingView() },
    { pattern: /^\/api-docs$/, title: 'B2B API — PriceTruth', view: () => apiDocsView() },
    { pattern: /^\/extension$/, title: 'Browser extension — PriceTruth', view: () => extensionView() },
  ];

  function isSpaPath(path) {
    return ROUTES.some((r) => r.pattern.test(path));
  }

  function updateNav(path) {
    for (const link of document.querySelectorAll('.nav-links a[data-nav]')) {
      const target = link.getAttribute('data-nav');
      const current = target === '/' ? path === '/' : path.startsWith(target);
      if (current) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
  }

  function render() {
    const path = location.pathname;
    let matched = null;
    let match = null;
    for (const route of ROUTES) {
      match = path.match(route.pattern);
      if (match) { matched = route; break; }
    }
    clear(app);
    updateNav(path);
    if (matched) {
      document.title = matched.title;
      app.append(matched.view(match));
    } else {
      document.title = 'Not found — PriceTruth';
      app.append(notFoundView());
    }
  }

  function navigate(href) {
    history.pushState({}, '', href);
    render();
    window.scrollTo(0, 0);
  }

  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target instanceof Element ? e.target.closest('a') : null;
    if (!a || a.target || a.hasAttribute('download')) return;
    const href = a.getAttribute('href');
    if (!href || !href.startsWith('/')) return;
    const path = href.split('?')[0].split('#')[0];
    if (!isSpaPath(path)) return; // /go/*, /legal.html, /api/* fall through to the server
    e.preventDefault();
    navigate(href);
  });

  window.addEventListener('popstate', render);

  render();
})();
