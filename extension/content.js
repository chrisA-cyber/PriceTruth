'use strict';

// PriceTruth content script — the "what will this actually cost?" overlay.
//
// Privacy: this script makes ZERO network requests. It reads prices already
// visible on the page you're looking at, computes a true-cost estimate with the
// bundled fee model (feemodel.js, loaded before this file per manifest.json),
// and renders a local badge. Nothing about your browsing leaves the browser.
//
// Honesty: everything beyond the advertised price is a typical-profile
// estimate and is labeled as such. If no price is confidently detected, the
// overlay shows nothing at all — it never guesses loudly.

(function () {
  // Guard against re-injection (SPA navigations, duplicate script insertion).
  if (window.__ptExtInjected) return;
  window.__ptExtInjected = true;

  var FM = window.PTFeeModel;
  if (!FM) return; // fee model must load first (manifest js order)

  var APP_URL = 'http://localhost:4780';
  var MAX_NODES = 5000;
  var RETRY_DELAYS_MS = [1200, 3500]; // late-rendering SPAs get two more looks

  // Detection regex per spec; extraction regex handles thousands separators so
  // "$1,299.00" doesn't mis-parse as $1.29.
  var DETECT_RE = /\$\s?\d{1,4}(?:[.,]\d{2})?/;
  var EXTRACT_RE = /\$\s?(\d{1,3}(?:,\d{3})+|\d{1,4})(?:[.,](\d{2}))?(?!\d)/;
  var HINT_RE = /price|amount|rate|fare|total|cost|deal|currency/i;

  // ---------------------------------------------------------------------------
  // Vertical classification from hostname
  // ---------------------------------------------------------------------------

  function hostMatches(hostname, domain) {
    return hostname === domain || hostname.slice(-(domain.length + 1)) === '.' + domain;
  }

  function classify(hostname) {
    if (hostMatches(hostname, 'booking.com')) return { vertical: 'hotel', profile: 'default', site: 'Booking.com', demo: false };
    if (hostMatches(hostname, 'hotels.com')) return { vertical: 'hotel', profile: 'default', site: 'Hotels.com', demo: false };
    if (hostMatches(hostname, 'expedia.com')) return { vertical: 'hotel', profile: 'default', site: 'Expedia', demo: false };
    if (hostMatches(hostname, 'ticketmaster.com')) return { vertical: 'ticket', profile: 'ticketmaster', site: 'Ticketmaster', demo: false };
    if (hostMatches(hostname, 'stubhub.com')) return { vertical: 'ticket', profile: 'stubhub', site: 'StubHub', demo: false };
    if (hostMatches(hostname, 'spirit.com')) return { vertical: 'flight', profile: 'spirit', site: 'Spirit', demo: false };
    if (hostMatches(hostname, 'example.com')) return { vertical: 'hotel', profile: 'default', site: 'example.com', demo: true };
    return null;
  }

  // ---------------------------------------------------------------------------
  // Heuristic price detection
  // ---------------------------------------------------------------------------

  function extractCents(text) {
    var m = EXTRACT_RE.exec(text);
    if (!m) return null;
    var dollars = m[1].replace(/,/g, '');
    var cents = m[2] || '00';
    var value = Number(dollars + cents); // digit-string concat, no float math
    return FM.isCents(value) && value >= 100 ? value : null;
  }

  function hasPriceHint(el) {
    var node = el;
    for (var depth = 0; node && depth < 4; depth++) {
      var cls = typeof node.className === 'string' ? node.className : '';
      var label = cls + ' ' + (node.id || '') + ' ' + (node.getAttribute && node.getAttribute('data-testid') || '');
      if (HINT_RE.test(label)) return true;
      node = node.parentElement;
    }
    return false;
  }

  // Returns {cents, fontSize, hint} for the most prominent visible price, or
  // null when nothing on the page looks confidently like a price.
  function detectPrice() {
    if (!document.body) return null;
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    var best = null;
    var seen = 0;

    while (seen < MAX_NODES) {
      var node = walker.nextNode();
      if (!node) break;
      seen++;

      var text = node.nodeValue;
      if (!text || text.length > 200 || !DETECT_RE.test(text)) continue;

      var el = node.parentElement;
      if (!el) continue;
      var tag = el.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEXTAREA' || tag === 'OPTION') continue;
      if (el.closest && el.closest('.pt-ext-root')) continue; // never read our own badge

      var rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue; // not rendered
      var style = window.getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      if (style.textDecorationLine && style.textDecorationLine.indexOf('line-through') !== -1) continue; // struck-out "was" price

      var cents = extractCents(text);
      if (cents === null) continue;

      var fontSize = parseFloat(style.fontSize) || 0;
      if (fontSize < 12) continue; // fine print is not the advertised price
      var hint = hasPriceHint(el);
      var score = fontSize + (hint ? 8 : 0);

      if (!best || score > best.score) {
        best = { cents: cents, fontSize: fontSize, hint: hint, score: score };
      }
    }

    // Confidence bar: a price-ish class/id, or prominent type. Otherwise stay quiet.
    if (best && (best.hint || best.fontSize >= 18)) return best;
    return null;
  }

  // ---------------------------------------------------------------------------
  // Badge / expanded card UI (all createElement + textContent; styles live in
  // overlay.css under the pt-ext- prefix)
  // ---------------------------------------------------------------------------

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function moneyRow(label, amount, opts) {
    var row = el('div', 'pt-ext-row' + (opts && opts.strong ? ' pt-ext-row-strong' : ''));
    var left = el('div', 'pt-ext-row-label');
    left.appendChild(el('span', null, label));
    if (opts && opts.tag) left.appendChild(el('span', 'pt-ext-tag pt-ext-tag-' + opts.tag, opts.tag));
    if (opts && opts.note) left.appendChild(el('div', 'pt-ext-note', opts.note));
    row.appendChild(left);
    row.appendChild(el('div', 'pt-ext-row-amount', amount));
    return row;
  }

  function buildCard(report, info) {
    var card = el('div', 'pt-ext-card');

    var head = el('div', 'pt-ext-card-head');
    var titleWrap = el('div', null);
    titleWrap.appendChild(el('div', 'pt-ext-card-title', 'True-cost estimate'));
    titleWrap.appendChild(el('div', 'pt-ext-card-sub',
      report.vertical + ' · ' + report.profileLabel + (info.demo ? ' · demo page' : '')));
    head.appendChild(titleWrap);
    head.appendChild(el('div', 'pt-ext-load',
      report.feeLoadPct > 0 ? '+' + report.feeLoadPct + '% hidden' : 'no hidden fees'));
    card.appendChild(head);

    card.appendChild(moneyRow('Advertised price', FM.fmtUSD(report.advertised.amount_cents) + FM.unitLabel(report.advertised.unit)));

    var items = el('div', 'pt-ext-items');
    for (var i = 0; i < report.lineItems.length; i++) {
      var it = report.lineItems[i];
      items.appendChild(moneyRow(it.label, FM.fmtUSD(it.amount_cents), { tag: it.certainty, note: it.note }));
    }
    card.appendChild(items);

    card.appendChild(moneyRow(
      'Estimated real price',
      '~' + FM.fmtUSD(report.truePrice.amount_cents) + ' ' + FM.unitLabel(report.truePrice.unit),
      { strong: true }
    ));

    if (info.demo) {
      card.appendChild(el('p', 'pt-ext-honesty',
        'Demo mode: this page isn’t a real listing, so it’s being treated as a hotel listing with the US-average fee profile.'));
    }
    card.appendChild(el('p', 'pt-ext-honesty',
      'Estimated from typical fees for this site’s category — actual checkout may differ. Lines marked “typical” or “estimated” are projections, not quotes.'));

    var foot = el('div', 'pt-ext-card-foot');
    var link = el('a', 'pt-ext-link', 'Open PriceTruth');
    link.href = APP_URL;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    foot.appendChild(link);
    foot.appendChild(el('span', 'pt-ext-privacy', 'Computed locally · nothing sent'));
    card.appendChild(foot);

    return card;
  }

  function render(report, info) {
    var root = el('div', 'pt-ext-root');

    var badge = el('button', 'pt-ext-badge');
    badge.type = 'button';
    badge.setAttribute('aria-expanded', 'false');
    badge.appendChild(el('span', 'pt-ext-dot'));
    badge.appendChild(el('span', 'pt-ext-badge-text',
      'PriceTruth: ~' + FM.fmtUSD(report.truePrice.amount_cents) + FM.unitLabel(report.truePrice.unit) + ' real'));

    var card = buildCard(report, info);

    badge.addEventListener('click', function () {
      var open = root.classList.toggle('pt-ext-open');
      badge.setAttribute('aria-expanded', open ? 'true' : 'false');
    });

    root.appendChild(card);
    root.appendChild(badge);
    (document.body || document.documentElement).appendChild(root);
  }

  // ---------------------------------------------------------------------------
  // Boot: detect at document_idle; retry briefly for late-rendering pages;
  // if nothing is confidently found, stay silent.
  // ---------------------------------------------------------------------------

  var info = classify(window.location.hostname);
  if (!info) return;

  var attempt = 0;
  function tryDetect() {
    var found = detectPrice();
    if (found) {
      var report = FM.analyze(info.vertical, found.cents, { profile: info.profile });
      if (report) render(report, info);
      return;
    }
    if (attempt < RETRY_DELAYS_MS.length) {
      window.setTimeout(tryDetect, RETRY_DELAYS_MS[attempt]);
      attempt++;
    }
  }
  tryDetect();
})();
