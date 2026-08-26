'use strict';

// PriceTruth content script — the "what will this actually cost?" overlay.
//
// Privacy: this script makes ZERO network requests. It reads prices already
// visible on the page you're looking at, computes a true-cost estimate with the
// bundled fee model (feemodel.js, loaded before this file per manifest.json),
// and renders a local badge. Nothing about your browsing leaves the browser.
//
// Honesty: the overlay requires explicit USD currency plus U.S. offer evidence,
// preserves current mandatory-fee-inclusive displays, and never selects an
// optional add-on. If scope or price is uncertain, it shows nothing at all.

(function () {
  // Guard against re-injection (SPA navigations, duplicate script insertion).
  if (window.__ptExtInjected) return;
  window.__ptExtInjected = true;

  var FM = window.PTFeeModel;
  var AD = window.PTAdapters;
  var CFG = window.PTConfig || {};
  if (!FM || !AD) return; // manifest ordering guarantees both in production

  var APP_URL = CFG.appUrl || 'http://localhost:4780';
  var PT_DEMO_HOST = CFG.demoHost || 'localhost';
  var MAX_NODES = 5000;
  var RETRY_DELAYS_MS = [1200, 3500]; // late-rendering SPAs get two more looks

  var HINT_RE = /price|amount|rate|fare|total|cost|deal|currency/i;
  var info = null;
  var disabledAdapters = [];
  var settingsLoaded = false;

  function offerIsUSScoped() {
    if (info && info.demo) return true;
    var meta = [];
    var metaNodes = document.querySelectorAll('meta[name="country"],meta[name="locale"],meta[property="og:locale"],meta[itemprop="addressCountry"]');
    for (var i = 0; i < metaNodes.length && i < 20; i++) meta.push(metaNodes[i].getAttribute('content') || '');
    var bodyText = document.body && document.body.innerText || '';
    var scopeText = [document.title, meta.join(' '), bodyText.slice(0, 50000)].join(' ');
    return AD.hasUSOfferEvidence(info && info.vertical, window.location.pathname + window.location.search,
      scopeText, document.documentElement && document.documentElement.lang);
  }

  // ---------------------------------------------------------------------------
  // Heuristic price detection
  // ---------------------------------------------------------------------------

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

  function excludedByAdapter(el) {
    if (!el.closest || !info || !info.exclude) return false;
    for (var i = 0; i < info.exclude.length; i++) {
      try { if (el.closest(info.exclude[i])) return true; } catch (_) { /* fixed adapter selector; ignore unsupported syntax */ }
    }
    return false;
  }

  function candidateFor(el, text, selectorRank) {
    if (!el || !text || text.length > 400 || !AD.MONEY_DETECT_RE.test(text)) return null;
    var tag = el.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEXTAREA' || tag === 'OPTION') return null;
    if (el.closest && el.closest('.pt-ext-root')) return null;
    if (excludedByAdapter(el)) return null;
    var rect = el.getBoundingClientRect();
    var style = window.getComputedStyle(el);
    var visible = rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || 1) > 0;
    return {
      text: text,
      cents: AD.parsePriceText(text),
      fontSize: parseFloat(style.fontSize) || 0,
      hint: hasPriceHint(el),
      selectorRank: selectorRank,
      struck: isStruckThrough(el),
      visible: visible,
      area: rect.width * rect.height,
      contextText: (el.parentElement && el.parentElement.textContent || text).slice(0, 300),
    };
  }

  // Seller selectors are ranked first. The bounded text walk remains as a
  // conservative fallback for supported-site layout changes.
  function detectPrice() {
    if (!document.body || !offerIsUSScoped()) return null;
    var candidates = [];
    var seenElements = typeof WeakSet === 'function' ? new WeakSet() : null;
    var selectors = info && info.selectors || [];
    for (var s = 0; s < selectors.length; s++) {
      var nodes;
      try { nodes = document.querySelectorAll(selectors[s]); } catch (_) { nodes = []; }
      for (var e = 0; e < nodes.length && e < 100; e++) {
        var selected = nodes[e];
        if (seenElements) seenElements.add(selected);
        var selectedCandidate = candidateFor(selected, selected.textContent || '', s);
        if (selectedCandidate) candidates.push(selectedCandidate);
      }
    }

    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    var seen = 0;
    while (seen < MAX_NODES) {
      var node = walker.nextNode();
      if (!node) break;
      seen++;
      var text = node.nodeValue;
      if (!text || text.length > 200 || !AD.MONEY_DETECT_RE.test(text)) continue;
      var el = node.parentElement;
      if (!el || (seenElements && seenElements.has(el))) continue;
      var genericCandidate = candidateFor(el, text, null);
      if (genericCandidate) candidates.push(genericCandidate);
    }
    var best = AD.chooseCandidate(candidates);
    return best && (best.selectorRank !== null || best.hint || best.fontSize >= 18) ? best : null;
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
    var isPartial = report.completeness && report.completeness.status === 'partial';
    var unknownCount = isPartial ? report.completeness.unknownCosts.length : 0;

    var head = el('div', 'pt-ext-card-head');
    var titleWrap = el('div', null);
    titleWrap.appendChild(el('div', 'pt-ext-card-title', 'Price check'));
    titleWrap.appendChild(el('div', 'pt-ext-card-sub',
      report.vertical + ' · USD · U.S.-scoped offer' + (info.demo ? ' · demo page' : '')));
    head.appendChild(titleWrap);
    head.appendChild(el('div', 'pt-ext-load',
      isPartial ? unknownCount + ' cost' + (unknownCount === 1 ? '' : 's') + ' unknown'
        : report.feeLoadPct > 0 ? '+' + report.feeLoadPct + '% modeled' : 'displayed total preserved'));
    var close = el('button', 'pt-ext-close', '×');
    close.type = 'button';
    close.title = 'Dismiss on this page';
    close.setAttribute('aria-label', 'Dismiss PriceTruth on this page');
    head.appendChild(close);
    card.appendChild(head);

    card.appendChild(moneyRow('Displayed price', FM.fmtUSD(report.advertised.amount_cents) + FM.unitLabel(report.advertised.unit)));

    var items = el('div', 'pt-ext-items');
    for (var i = 0; i < report.lineItems.length; i++) {
      var it = report.lineItems[i];
      items.appendChild(moneyRow(it.label, FM.fmtUSD(it.amount_cents), { tag: it.certainty, note: it.note }));
    }
    card.appendChild(items);

    card.appendChild(moneyRow(
      isPartial ? 'Known subtotal' : 'PriceTruth total',
      FM.fmtUSD(report.truePrice.amount_cents) + ' ' + FM.unitLabel(report.truePrice.unit),
      { strong: true }
    ));

    if (isPartial) {
      var unknownList = el('ul', 'pt-ext-unknown');
      for (var u = 0; u < report.completeness.unknownCosts.length; u++) {
        var gap = report.completeness.unknownCosts[u];
        unknownList.appendChild(el('li', null, 'Unknown: ' + gap.label + ' — ' + gap.reason));
      }
      card.appendChild(unknownList);
    }

    if (info.demo) {
      card.appendChild(el('p', 'pt-ext-honesty',
        'Demo mode: this page is treated as a current U.S. hotel display. Mandatory fees are not added a second time; unverified taxes remain unknown.'));
    }
    card.appendChild(el('p', 'pt-ext-honesty',
      isPartial
        ? 'This is a known subtotal, not a promised checkout total. Unverified costs remain unknown instead of being guessed as $0.'
        : 'On this U.S.-scoped offer, mandatory charges are preserved and optional extras are not selected; verify checkout with the seller.'));

    var correction = el('details', 'pt-ext-correction');
    correction.appendChild(el('summary', null, 'Wrong advertised price?'));
    var correctionRow = el('div', 'pt-ext-correction-row');
    var input = el('input', 'pt-ext-correction-input');
    input.type = 'text';
    input.inputMode = 'decimal';
    input.value = (report.advertised.amount_cents / 100).toFixed(2);
    input.setAttribute('aria-label', 'Correct advertised price in dollars');
    correctionRow.appendChild(input);
    var apply = el('button', 'pt-ext-correction-apply', 'Apply locally');
    apply.type = 'button';
    correctionRow.appendChild(apply);
    correction.appendChild(correctionRow);
    correction.appendChild(el('div', 'pt-ext-correction-error'));
    card.appendChild(correction);

    var foot = el('div', 'pt-ext-card-foot');
    var link = el('a', 'pt-ext-link', 'Open PriceTruth');
    link.href = APP_URL;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    foot.appendChild(link);
    var feedback = el('a', 'pt-ext-feedback', 'Report detection');
    feedback.href = AD.feedbackUrl(APP_URL, info, report.advertised.amount_cents);
    feedback.target = '_blank';
    feedback.rel = 'noopener noreferrer';
    feedback.title = 'Opens PriceTruth feedback; nothing is submitted automatically';
    foot.appendChild(feedback);
    foot.appendChild(el('span', 'pt-ext-privacy', 'Local unless you open feedback'));
    card.appendChild(foot);

    return card;
  }

  // The one live overlay on the page. Re-rendered in place when the detected
  // price changes (SPA navigation); torn down entirely when the user dismisses.
  var currentRoot = null;
  var currentKey = null;      // vertical|profile|cents of what's on screen now
  var wasOpen = false;        // preserve expanded/collapsed across re-renders
  var manualCents = null;
  var manualUrl = null;
  var extensionEnabled = false; // enabled only after local preference lookup

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
      'PriceTruth: ' + (report.completeness && report.completeness.status === 'partial' ? 'known subtotal ' : '') +
        FM.fmtUSD(report.truePrice.amount_cents) + FM.unitLabel(report.truePrice.unit) + ' reviewed'));

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

    var correctionBtn = card.querySelector('.pt-ext-correction-apply');
    if (correctionBtn) correctionBtn.addEventListener('click', function () {
      var correctionInput = card.querySelector('.pt-ext-correction-input');
      var correctionError = card.querySelector('.pt-ext-correction-error');
      var corrected = FM.dollarsToCents(correctionInput && correctionInput.value);
      if (corrected === null || corrected < 100) {
        correctionError.textContent = 'Enter a price of at least $1.00.';
        return;
      }
      correctionError.textContent = '';
      manualCents = corrected;
      manualUrl = window.location.href;
      var correctedReport = FM.analyze(info.vertical, corrected, { profile: info.profile });
      removeOverlay();
      render(correctedReport, info);
      currentKey = keyFor(correctedReport);
    });

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

  info = AD.classify(window.location.hostname, window.location.pathname, document.title, PT_DEMO_HOST);

  chrome.storage.local.get({ disabledAdapters: [] }, function (settings) {
    disabledAdapters = Array.isArray(settings.disabledAdapters) ? settings.disabledAdapters : [];
    settingsLoaded = true;
    reconcile();
  });

  var dismissedUrl = null;    // user closed the overlay for this exact URL
  var lastScanAt = 0;         // throttle detection on noisy pages
  var MIN_SCAN_GAP_MS = 900;
  var scanTimer = null;

  function keyFor(report) {
    return info.vertical + '|' + info.profile + '|' + report.truePrice.amount_cents;
  }

  function adapterIdentity(candidate) {
    return candidate && [candidate.adapterId, candidate.vertical, candidate.profile].join('|');
  }

  // Reclassify on every reconciliation. SPA frameworks can change route,
  // vertical, or supported/unsupported state without invoking history hooks.
  function refreshAdapter() {
    var next = AD.classify(window.location.hostname, window.location.pathname, document.title, PT_DEMO_HOST);
    if (!next) {
      info = null;
      extensionEnabled = false;
      removeOverlay();
      return false;
    }
    if (adapterIdentity(next) !== adapterIdentity(info)) {
      removeOverlay();
      manualCents = null;
      manualUrl = null;
    }
    info = next;
    extensionEnabled = settingsLoaded && disabledAdapters.indexOf(info.adapterId) === -1;
    if (!extensionEnabled) removeOverlay();
    return extensionEnabled;
  }

  function dismiss() {
    dismissedUrl = window.location.href;
    wasOpen = false;
    removeOverlay();
  }

  // Detect the prominent price and reconcile the overlay with it. Cheap to call
  // repeatedly: bails fast when nothing changed or the user dismissed this URL.
  function reconcile() {
    if (!refreshAdapter()) return;
    if (dismissedUrl === window.location.href) return;
    var found = manualUrl === window.location.href && manualCents ? { cents: manualCents } : detectPrice();
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
    manualCents = null;
    manualUrl = null;
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
