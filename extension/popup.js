'use strict';

// PriceTruth popup — mini true-cost calculator.
//
// Privacy: everything here runs locally against the bundled fee model
// (feemodel.js, loaded via <script src> before this file). No fetches, no
// analytics, no storage — type a price, see the estimate, close the popup.
// All money math is integer cents; dollars are parsed with string math.

(function () {
  var FM = window.PTFeeModel;

  var verticalEl = document.getElementById('vertical');
  var priceEl = document.getElementById('price');
  var profileFieldEl = document.getElementById('profile-field');
  var profileLabelEl = document.getElementById('profile-label');
  var profileEl = document.getElementById('profile');
  var resultEl = document.getElementById('result');
  var settingsEl = document.getElementById('settings');
  var openAppEl = document.getElementById('open-app');

  if (window.PTConfig && openAppEl) openAppEl.href = window.PTConfig.appUrl;
  settingsEl.addEventListener('click', function () { chrome.runtime.openOptionsPage(); });

  var OPTIONS = FM.options();
  var PROFILE_LABELS = {
    hotel: 'Market',
    flight: 'Carrier',
    ticket: 'Platform',
    subscription: 'Subscription type',
    retail: '',
  };
  var DEFAULT_PROFILE = {
    hotel: 'las_vegas',
    flight: 'typical_lcc',
    ticket: 'ticketmaster',
    subscription: 'streaming',
  };
  var DEFAULT_PRICE = {
    hotel: '219.00',
    flight: '189.00',
    ticket: '86.00',
    subscription: '9.99',
    retail: '299.00',
  };

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function fillProfiles(vertical) {
    while (profileEl.firstChild) profileEl.removeChild(profileEl.firstChild);
    var opts = OPTIONS[vertical] || [];
    if (opts.length === 0) {
      profileFieldEl.hidden = true;
      return;
    }
    profileFieldEl.hidden = false;
    profileLabelEl.textContent = PROFILE_LABELS[vertical] || 'Profile';
    for (var i = 0; i < opts.length; i++) {
      var o = document.createElement('option');
      o.value = opts[i].id;
      o.textContent = opts[i].label;
      profileEl.appendChild(o);
    }
    var def = DEFAULT_PROFILE[vertical];
    if (def) profileEl.value = def;
  }

  function moneyRow(label, amount, opts) {
    var row = el('div', 'row' + (opts && opts.strong ? ' row-strong' : ''));
    var left = el('div', 'row-label');
    left.appendChild(el('span', null, label));
    if (opts && opts.tag) left.appendChild(el('span', 'tag tag-' + opts.tag, opts.tag));
    if (opts && opts.note) left.appendChild(el('div', 'note', opts.note));
    row.appendChild(left);
    row.appendChild(el('div', 'row-amount', amount));
    return row;
  }

  function renderEmpty(message) {
    while (resultEl.firstChild) resultEl.removeChild(resultEl.firstChild);
    resultEl.appendChild(el('p', 'empty', message));
  }

  function render() {
    var vertical = verticalEl.value;
    var cents = FM.dollarsToCents(priceEl.value);
    if (cents === null || cents === 0) {
      renderEmpty('Enter the displayed price (e.g. 219.00) to review what is included and modeled.');
      return;
    }

    var report = FM.analyze(vertical, cents, { profile: profileEl.value });
    if (!report) {
      renderEmpty('Could not compute an estimate for that input.');
      return;
    }

    while (resultEl.firstChild) resultEl.removeChild(resultEl.firstChild);

    var hasProjection = report.lineItems.some(function (line) { return line.certainty !== 'listed'; });
    var isPartial = report.completeness && report.completeness.status === 'partial';
    var unknownCount = isPartial ? report.completeness.unknownCosts.length : 0;

    // Glance-first verdict: the modeled total before the breakdown.
    var verdict = el('div', 'verdict');
    verdict.appendChild(el('div', 'verdict-label', isPartial ? 'Known subtotal' : hasProjection ? 'Modeled total' : 'Displayed total preserved'));
    var big = el('div', 'verdict-price');
    big.appendChild(el('span', 'verdict-amount', (hasProjection ? '~' : '') + FM.fmtUSD(report.truePrice.amount_cents)));
    big.appendChild(el('span', 'verdict-unit', ' ' + FM.unitLabel(report.truePrice.unit)));
    verdict.appendChild(big);
    var meta = el('div', 'verdict-meta');
    meta.appendChild(el('span', 'load' + (report.feeLoadPct > 0 ? ' load-hot' : ''),
      isPartial ? unknownCount + ' checkout cost' + (unknownCount === 1 ? '' : 's') + ' unknown'
        : report.feeLoadPct > 0 ? '+' + report.feeLoadPct + '% modeled' : 'displayed total preserved'));
    meta.appendChild(el('span', 'confidence', 'confidence ' + Math.round(report.confidence * 100) + '%'));
    verdict.appendChild(meta);
    resultEl.appendChild(verdict);

    // Breakdown
    var box = el('div', 'breakdown');
    box.appendChild(moneyRow('Displayed', FM.fmtUSD(report.advertised.amount_cents) + FM.unitLabel(report.advertised.unit)));
    var items = el('div', 'items');
    for (var i = 0; i < report.lineItems.length; i++) {
      var it = report.lineItems[i];
      items.appendChild(moneyRow(it.label, FM.fmtUSD(it.amount_cents), { tag: it.certainty, note: it.note }));
    }
    box.appendChild(items);
    box.appendChild(moneyRow(isPartial ? 'Known subtotal' : hasProjection ? 'Modeled total' : 'PriceTruth total', (hasProjection ? '~' : '') + FM.fmtUSD(report.truePrice.amount_cents), { strong: true }));
    if (report.total && report.total.amount_cents !== report.truePrice.amount_cents) {
      box.appendChild(moneyRow(report.total.label, FM.fmtUSD(report.total.amount_cents)));
    }
    resultEl.appendChild(box);

    // Honesty block: what was assumed, what the law says, what we can't know.
    var fine = el('div', 'fine');
    fine.appendChild(el('p', 'honesty', isPartial
      ? 'This is a known subtotal. Unknown checkout costs stay visible instead of being guessed as $0.'
      : hasProjection ? 'Every projected line is labeled “typical” or “estimated”; it is not a seller quote.'
        : 'The displayed price is preserved. Mandatory costs are not invented and optional extras are not selected for you.'));
    if (isPartial) {
      var unknownList = el('ul', 'notes unknown-costs');
      for (var u = 0; u < report.completeness.unknownCosts.length; u++) {
        var gap = report.completeness.unknownCosts[u];
        unknownList.appendChild(el('li', null, 'Unknown: ' + gap.label + ' — ' + gap.reason));
      }
      fine.appendChild(unknownList);
    }
    var notes = report.assumptions.concat(report.disclosures);
    if (notes.length > 0) {
      var ul = el('ul', 'notes');
      for (var n = 0; n < notes.length; n++) ul.appendChild(el('li', null, notes[n]));
      fine.appendChild(ul);
    }
    resultEl.appendChild(fine);
  }

  verticalEl.addEventListener('change', function () {
    fillProfiles(verticalEl.value);
    priceEl.value = DEFAULT_PRICE[verticalEl.value] || priceEl.value;
    render();
  });
  profileEl.addEventListener('change', render);
  priceEl.addEventListener('input', render);

  fillProfiles(verticalEl.value);
  render();
})();
