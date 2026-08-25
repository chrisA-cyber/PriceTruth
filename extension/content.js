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

  // APP_URL and PT_DEMO_HOST are rewritten when the extension is downloaded
  // from a deployed PriceTruth site, so its links and its on-site demo point
  // back at wherever it came from. The defaults make a locally-run copy work.
  var APP_URL = 'http://localhost:4780';
  var PT_DEMO_HOST = 'localhost';
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
    // The PriceTruth site's own demo page (see manifest matches, scoped to
    // /extension-demo.html) is treated as a Las Vegas hotel listing.
    if (PT_DEMO_HOST && hostMatches(hostname, PT_DEMO_HOST)) return { vertical: 'hotel', profile: 'las_vegas', site: 'PriceTruth demo', demo: true };
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

  // Walk a few ancestors: line-through is often on a wrapper, not the text's
  // own element, and text-decoration-line is not an inherited property.
  function isStruckThrough(el) {
    var node = el;
    for (var depth = 0; node && depth < 4; depth++) {
      var dec = window.getComputedStyle(node).textDecorationLine;
      if (dec && dec.indexOf('line-through') !== -1) return true;
      node = node.parentElement;
    }
    return false;
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
      // Struck-out "was" price. text-decoration-line does not inherit in the
      // cascade, so a line-through set on an ancestor won't show on el's own
      // computed style — walk up a few levels to catch that common markup.
      if (isStruckThrough(el)) continue;

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
    var close = el('button', 'pt-ext-close', '×');
    close.type = 'button';
    close.title = 'Dismiss on this page';
    close.setAttribute('aria-label', 'Dismiss PriceTruth on this page');
    head.appendChild(close);
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

  // The one live overlay on the page. Re-rendered in place when the detected
  // price changes (SPA navigation); torn down entirely when the user dismisses.
  var currentRoot = null;
  var currentKey = null;      // vertical|profile|cents of what's on screen now
  var wasOpen = false;        // preserve expanded/collapsed across re-renders

  function removeOverlay() {
    if (currentRoot && currentRoot.parentNode) currentRoot.parentNode.removeChild(currentRoot);
    currentRoot = null;
    currentKey = null;
  }

  function render(report, info) {
    var root = el('div', 'pt-ext-root');
    if (wasOpen) root.classList.add('pt-ext-open');

    var badge = el('button', 'pt-ext-badge');
    badge.type = 'button';
    badge.setAttribute('aria-expanded', wasOpen ? 'true' : 'false');
    badge.appendChild(el('span', 'pt-ext-dot'));
    badge.appendChild(el('span', 'pt-ext-badge-text',
      'PriceTruth: ~' + FM.fmtUSD(report.truePrice.amount_cents) + FM.unitLabel(report.truePrice.unit) + ' real'));

    var card = buildCard(report, info);

    badge.addEventListener('click', function () {
      wasOpen = root.classList.toggle('pt-ext-open');
      badge.setAttribute('aria-expanded', wasOpen ? 'true' : 'false');
    });

    var closeBtn = card.querySelector('.pt-ext-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        dismiss();
      });
    }

    root.appendChild(card);
    root.appendChild(badge);
    (document.body || document.documentElement).appendChild(root);
    currentRoot = root;
  }

  // ---------------------------------------------------------------------------
  // Boot: detect at document_idle; retry briefly for late-rendering pages;
  // re-check on SPA navigation and page mutations; stay silent when nothing is
  // confidently found; honor an explicit dismiss for the current URL.
  // ---------------------------------------------------------------------------

  var info = classify(window.location.hostname);
  if (!info) return;

  var dismissedUrl = null;    // user closed the overlay for this exact URL
  var lastScanAt = 0;         // throttle detection on noisy pages
  var MIN_SCAN_GAP_MS = 900;
  var scanTimer = null;

  function keyFor(report) {
    return info.vertical + '|' + info.profile + '|' + report.truePrice.amount_cents;
  }

  function dismiss() {
    dismissedUrl = window.location.href;
    wasOpen = false;
    removeOverlay();
  }

  // Detect the prominent price and reconcile the overlay with it. Cheap to call
  // repeatedly: bails fast when nothing changed or the user dismissed this URL.
  function reconcile() {
    if (dismissedUrl === window.location.href) return;
    var found = detectPrice();
    if (!found) return;
    var report = FM.analyze(info.vertical, found.cents, { profile: info.profile });
    if (!report) return;
    var key = keyFor(report);
    if (key === currentKey && currentRoot) return; // already showing this
    removeOverlay();
    render(report, info);
    currentKey = key;
  }

  // Throttled reconcile — coalesces bursts of DOM mutations into one scan.
  function scheduleScan(delayMs) {
    if (scanTimer) return;
    var wait = Math.max(delayMs || 0, MIN_SCAN_GAP_MS - (Date.now() - lastScanAt));
    if (wait < 0) wait = 0;
    scanTimer = window.setTimeout(function () {
      scanTimer = null;
      lastScanAt = Date.now();
      reconcile();
    }, wait);
  }

  // First look plus a couple of retries for late-rendering SPAs.
  var attempt = 0;
  function tryDetect() {
    reconcile();
    if (!currentRoot && attempt < RETRY_DELAYS_MS.length) {
      window.setTimeout(tryDetect, RETRY_DELAYS_MS[attempt]);
      attempt++;
    }
  }
  tryDetect();

  // SPA route changes: history API is patched by most client-side routers, so
  // wrap it to learn when the "page" changes without a full reload. A changed
  // URL clears any prior dismiss and forces a fresh scan.
  function onNavigation() {
    if (dismissedUrl && dismissedUrl !== window.location.href) dismissedUrl = null;
    currentKey = null; // force re-render even if the number happens to match
    scheduleScan(400);
  }
  ['pushState', 'replaceState'].forEach(function (m) {
    var orig = history[m];
    if (typeof orig !== 'function') return;
    history[m] = function () {
      var r = orig.apply(this, arguments);
      onNavigation();
      return r;
    };
  });
  window.addEventListener('popstate', onNavigation);
  window.addEventListener('hashchange', onNavigation);

  // Content swaps without a route change (filters, date pickers) — watch the
  // body, but throttle hard so we never thrash on chatty pages.
  if (window.MutationObserver && document.body) {
    var mo = new MutationObserver(function () { scheduleScan(0); });
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  // Esc collapses an open card (does not permanently dismiss).
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && currentRoot && currentRoot.classList.contains('pt-ext-open')) {
      wasOpen = false;
      currentRoot.classList.remove('pt-ext-open');
      var b = currentRoot.querySelector('.pt-ext-badge');
      if (b) b.setAttribute('aria-expanded', 'false');
    }
  });
})();
