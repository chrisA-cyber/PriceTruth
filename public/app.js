'use strict';

/* PriceTruth SPA — zero dependencies, CSP-strict (no inline script, no eval).
   All DOM built via createElement/textContent; innerHTML is never used.
   All money is integer USD cents; formatting/parsing is string math only. */

(function () {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const app = document.getElementById('app');
  const routeAnnouncer = document.getElementById('route-announcer');
  const COMPARE_KEY = 'pt-compare-v1';
  const AUTH_RETURN_KEY = 'pt-auth-return-v1';

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

  function safeAuthReturn(value) {
    if (typeof value !== 'string' || value.length > 160 || !value.startsWith('/')
      || value.startsWith('//') || value.includes('\\')) return null;
    let parsed;
    try { parsed = new URL(value, location.origin); } catch (err) { return null; }
    if (parsed.origin !== location.origin || parsed.search || parsed.hash) return null;
    if (parsed.pathname === '/pricing') return parsed.pathname;
    if (/^\/p\/[a-z0-9-]{1,64}$/.test(parsed.pathname)) return parsed.pathname;
    return null;
  }

  function rememberAuthReturn(value) {
    const path = safeAuthReturn(value);
    if (!path) return null;
    try { localStorage.setItem(AUTH_RETURN_KEY, JSON.stringify({ path, savedAt: Date.now() })); }
    catch (err) { /* storage may be unavailable */ }
    return path;
  }

  function pendingAuthReturn() {
    try {
      const value = JSON.parse(localStorage.getItem(AUTH_RETURN_KEY) || 'null');
      if (!value || !safeAuthReturn(value.path) || !Number.isFinite(value.savedAt)
        || Date.now() - value.savedAt > 60 * 60 * 1000) {
        localStorage.removeItem(AUTH_RETURN_KEY);
        return null;
      }
      return value.path;
    } catch (err) {
      try { localStorage.removeItem(AUTH_RETURN_KEY); } catch (ignored) { /* storage blocked */ }
      return null;
    }
  }

  function clearAuthReturn() {
    try { localStorage.removeItem(AUTH_RETURN_KEY); } catch (err) { /* storage blocked */ }
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

  function isRefreshableResult(payload) {
    if (!payload || typeof payload !== 'object') return false;
    return payload.refreshable === true
      || Boolean(payload.product && payload.product.refreshable === true)
      || Boolean(payload.listing && payload.listing.refreshable === true);
  }

  function isAlertEligibleResult(payload) {
    if (!payload || typeof payload !== 'object') return false;
    return isRefreshableResult(payload) && (
      payload.alertEligible === true
      || Boolean(payload.product && payload.product.alertEligible === true)
      || Boolean(payload.listing && payload.listing.alertEligible === true)
    );
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
      throw new AppError('rate', 'Too many requests arrived at once. Wait a few seconds, then retry.', 429, data);
    }
    if (!res.ok) {
      const msg = data && data.error ? data.error : `Request failed (HTTP ${res.status}).`;
      throw new AppError('http', msg, res.status, data);
    }
    return data;
  }

  let metaCache = null;
  let runtimeMeta = null;
  const INDEXABLE_PATHS = new Set(['/', '/find', '/analyze', '/pricing', '/api-docs', '/extension']);

  function applyCanonicalMeta(meta) {
    const pathname = INDEXABLE_PATHS.has(location.pathname) ? location.pathname : null;
    let base = null;
    try {
      const candidate = new URL(meta && meta.publicBaseUrl ? meta.publicBaseUrl : '');
      if ((candidate.protocol === 'https:' || candidate.protocol === 'http:')
        && !candidate.username && !candidate.password && candidate.origin === location.origin
        && (candidate.pathname === '/' || candidate.pathname === '') && !candidate.search && !candidate.hash) {
        base = candidate;
      }
    } catch (err) { /* canonical metadata is optional in local/older deployments */ }

    let canonical = document.querySelector('link[rel="canonical"]');
    let openGraph = document.querySelector('meta[property="og:url"]');
    if (!base || !pathname) {
      if (canonical) canonical.remove();
      if (openGraph) openGraph.remove();
      return;
    }
    const href = new URL(pathname, base).href;
    if (!canonical) {
      canonical = document.createElement('link');
      canonical.rel = 'canonical';
      document.head.append(canonical);
    }
    canonical.href = href;
    if (!openGraph) {
      openGraph = document.createElement('meta');
      openGraph.setAttribute('property', 'og:url');
      document.head.append(openGraph);
    }
    openGraph.content = href;
  }

  function getMeta() {
    if (!metaCache) {
      metaCache = fetchJSON('/api/meta')
        .then((data) => {
          runtimeMeta = data;
          applyAccountCapability(data);
          applyCanonicalMeta(data);
          return data;
        })
        .catch((err) => { metaCache = null; throw err; });
    }
    return metaCache;
  }

  function accountsEnabled(meta) {
    return !(meta && meta.capabilities && meta.capabilities.accounts === false);
  }

  function applyAccountCapability(meta) {
    const enabled = accountsEnabled(meta || runtimeMeta);
    const accountNav = document.querySelector('.nav-account');
    if (accountNav) accountNav.hidden = !enabled;
    for (const node of document.querySelectorAll('[data-account-required]')) node.hidden = !enabled;
    const existing = app.querySelector('.account-capability-notice');
    if (enabled) {
      if (existing) existing.remove();
      return;
    }
    if (!existing) {
      app.prepend(el('div', { class: 'notice notice-info account-capability-notice', role: 'status' },
        el('b', null, 'Read-only deployment. '),
        'Accounts and personal data storage are disabled in this public/demo environment. Reports remain one-time; saving, tracking, alerts, notifications, API keys, and billing are unavailable.'));
    }
  }

  function approvedLegal(meta) {
    const legal = meta && meta.legal;
    if (!legal || legal.configured !== true || legal.approved !== true) return null;
    if (![legal.operatorName, legal.jurisdiction, legal.supportContact, legal.effectiveDate]
      .every((value) => typeof value === 'string' && value.trim())) return null;
    return legal;
  }

  function commercialReady(meta) {
    const legal = approvedLegal(meta);
    return Boolean(meta && meta.billing && meta.billing.mode === 'live'
      && accountsEnabled(meta) && legal && typeof legal.termsVersion === 'string'
      && legal.termsVersion.trim() && supportHref(legal.supportContact));
  }

  function supportHref(contact) {
    const value = String(contact || '').trim();
    if (/^https:\/\//i.test(value) || /^mailto:[^\s@]+@[^\s@]+$/i.test(value)) return value;
    if (/^[^\s@]+@[^\s@]+$/.test(value)) return `mailto:${value}`;
    return null;
  }

  function legalIdentity(meta, opts) {
    const options = opts || {};
    const legal = approvedLegal(meta);
    if (!commercialReady(meta) || !legal) {
      return el(options.tag || 'p', { class: options.class || 'deployment-identity deployment-local' },
        options.localText || 'This deployment does not offer commercial enrollment or a paid-service support channel.');
    }
    const contactHref = supportHref(legal.supportContact);
    const support = contactHref
      ? el('a', { href: contactHref, rel: /^https:/i.test(contactHref) ? 'noopener' : null }, 'Support')
      : document.createTextNode(legal.supportContact);
    return el(options.tag || 'p', { class: options.class || 'deployment-identity' },
      'Operated by ', el('b', null, legal.operatorName),
      ` · ${legal.jurisdiction} · Terms ${legal.termsVersion} · effective ${legal.effectiveDate} · `, support);
  }

  let sessionCache = null;
  let sessionPending = null;

  async function getSession(force) {
    if (!runtimeMeta) {
      try { await getMeta(); } catch (err) { /* older deployments may lack metadata */ }
    }
    if (!accountsEnabled(runtimeMeta)) {
      sessionCache = { authenticated: false, unavailable: true, accountsDisabled: true };
      updateAccountNav(sessionCache);
      return sessionCache;
    }
    if (!force && sessionCache) return sessionCache;
    if (!force && sessionPending) return sessionPending;
    sessionPending = fetchJSON('/api/session')
      .then((data) => {
        sessionCache = data && data.authenticated ? data : { authenticated: false };
        updateAccountNav(sessionCache);
        return sessionCache;
      })
      .catch((err) => {
        if (err.status === 401 || err.status === 404) {
          sessionCache = { authenticated: false, unavailable: err.status === 404 };
          updateAccountNav(sessionCache);
          return sessionCache;
        }
        throw err;
      })
      .finally(() => { sessionPending = null; });
    return sessionPending;
  }

  function clearSession() {
    sessionCache = null;
    sessionPending = null;
    updateAccountNav({ authenticated: false });
  }

  function updateAccountNav(session) {
    const link = document.querySelector('.nav-account');
    if (!link) return;
    link.textContent = session && session.authenticated ? 'Dashboard' : 'Sign in';
    if (session && session.authenticated && session.account && session.account.email) {
      link.setAttribute('aria-label', `Dashboard for ${session.account.email}`);
    } else {
      link.removeAttribute('aria-label');
    }
  }

  async function accountJSON(url, opts) {
    const session = await getSession();
    if (!session.authenticated) throw new AppError('auth', 'Sign in to continue.', 401);
    const options = Object.assign({}, opts || {});
    options.headers = Object.assign({}, options.headers || {}, {
      'X-CSRF-Token': session.csrfToken || '',
    });
    return fetchJSON(url, options);
  }

  async function copyText(text) {
    if (!navigator.clipboard || !navigator.clipboard.writeText) {
      throw new AppError('clipboard', 'Copy is not available in this browser.');
    }
    await navigator.clipboard.writeText(text);
  }

  function formatTimestamp(value) {
    if (!value) return 'Not provided by source';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return 'Not provided by source';
    return d.toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  }

  function formatSourceDate(value) {
    if (!value) return 'Not provided by source';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return 'Not provided by source';
    // Catalog snapshots are source dates, not local browser events. Render the
    // recorded UTC date so midnight snapshots do not appear a day earlier.
    return d.toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
    });
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
    return el('span', { class: 'chip chip-demo' }, 'Illustrative history');
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
      return el('span', { class: 'chip score-none' }, 'Not enough history yet');
    }
    return el('span', { class: `chip ${scoreChipClass(score.label)}` }, `${score.score}/100 · ${score.label}`);
  }

  function estimateTag(note) {
    return el('span', {
      class: 'chip chip-estimate',
      title: note || 'Projected from market-typical data, not a listed price.',
      'aria-label': `Estimate. ${note || 'Projected from market-typical data, not a listed price.'}`,
    }, 'estimate');
  }

  function listingSourceKey(listing) {
    const provenance = listing && listing.provenance && typeof listing.provenance === 'object'
      ? listing.provenance : {};
    return String((listing && listing.source) || provenance.source || '');
  }

  function isCatalogListing(listing) {
    const provenance = listing && listing.provenance && typeof listing.provenance === 'object'
      ? listing.provenance : {};
    return Boolean(listing) && (
      listing.certainty === 'catalog'
      || listingSourceKey(listing).startsWith('dataset:')
      || provenance.evidenceType === 'catalog_snapshot'
    );
  }

  function effectiveLineCertainty(item, listing) {
    const certainty = item && item.certainty;
    // Older stored catalog reports used `typical` for their sourced catalog
    // base. Treat that line as catalog evidence in the UI, while preserving
    // genuinely modeled/estimated additions as estimates.
    if (certainty === 'catalog' || (certainty === 'typical' && isCatalogListing(listing))) return 'catalog';
    return ['listed', 'typical', 'estimated'].includes(certainty) ? certainty : 'estimated';
  }

  function evidenceTag(item, listing) {
    const certainty = effectiveLineCertainty(item, listing);
    const note = item && item.note;
    if (certainty === 'catalog') {
      const description = note || 'Dated catalog snapshot, not a live seller quote.';
      return el('span', {
        class: 'chip chip-catalog', title: description,
        'aria-label': `Catalog snapshot. ${description}`,
      }, 'catalog snapshot');
    }
    if (certainty === 'typical') {
      const description = note || 'Representative market value, not a seller quote.';
      return el('span', {
        class: 'chip chip-typical', title: description,
        'aria-label': `Market typical. ${description}`,
      }, 'market typical');
    }
    if (certainty === 'estimated') return estimateTag(note);
    return el('span', { class: 'chip chip-listed' }, 'listed');
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
      'aria-label': hasScore ? `Deal quality score ${val} out of 100 — ${score.label}` : 'Deal quality: not enough history yet',
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
      }, hasScore ? 'deal quality / 100' : 'not enough history'));

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

  function hiddenCostPercent(report) {
    const hidden = Math.max(0, hiddenCostCents(report));
    const baseline = Math.max(0, report.truePrice.amount_cents - hidden);
    return baseline > 0 ? Math.round((hidden / baseline) * 1000) / 10 : 0;
  }

  function evidenceCompletenessPercent(report) {
    const raw = report && Number(report.confidence);
    if (!Number.isFinite(raw)) return 0;
    return Math.max(0, Math.min(100, Math.round(raw * 100)));
  }

  function unknownCosts(report) {
    return Array.isArray(report && report.completeness && report.completeness.unknownCosts)
      ? report.completeness.unknownCosts
      : [];
  }

  function feeLinePhrase(vertical) {
    if (vertical === 'subscription') return 'in renewal changes & fees';
    return 'outside the displayed price';
  }

  function reportTotalLabel(report, listing) {
    const provenance = listing && listing.provenance && typeof listing.provenance === 'object' ? listing.provenance : {};
    const expiredObservation = provenance.stale === true && !isCatalogListing(listing)
      && (provenance.observed === true || listing?.certainty === 'live' || listingSourceKey(listing).startsWith('live:'));
    if (expiredObservation) return unknownCosts(report).length ? 'Expired stored subtotal' : 'Expired stored observation';
    if (unknownCosts(report).length) return 'Known subtotal';
    const certainties = (report.lineItems || []).map((item) => effectiveLineCertainty(item, listing));
    if (certainties.some((certainty) => certainty === 'estimated' || certainty === 'typical')) {
      return 'Estimated all-in total';
    }
    if (certainties.some((certainty) => certainty === 'catalog') || isCatalogListing(listing)) {
      return 'Catalog-based all-in total';
    }
    const source = String((listing && (listing.sourceLabel || listing.source)) || '');
    if (/^your\b/i.test(source)) return 'Your all-in total';
    return 'All-in total';
  }

  function confidenceCopy(report, listing) {
    const pct = evidenceCompletenessPercent(report);
    const gaps = unknownCosts(report);
    if (gaps.length) {
      return `Input completeness ${pct}% — ${gaps.map((item) => item.label).join(' and ')} still ${gaps.length === 1 ? 'needs' : 'need'} checkout evidence.`;
    }
    const certainties = (report.lineItems || []).map((item) => effectiveLineCertainty(item, listing));
    if (certainties.some((certainty) => certainty === 'estimated' || certainty === 'typical')) {
      return `Evidence completeness ${pct}% — this total includes labeled projections; the percentage is not price accuracy.`;
    }
    if (certainties.some((certainty) => certainty === 'catalog') || isCatalogListing(listing)) {
      return `Evidence completeness ${pct}% — based on a dated catalog snapshot, not a live quote or price-accuracy probability.`;
    }
    const source = String((listing && (listing.sourceLabel || listing.source)) || '');
    if (/^your\b/i.test(source)) {
      return `Input completeness ${pct}% — based on the amounts you supplied, not independent seller verification.`;
    }
    return `Evidence completeness ${pct}% — based on supplied or sourced amounts, not a guarantee of checkout accuracy.`;
  }

  function verdictPanel(report, score, opts) {
    const trueU = unitLabel(report.truePrice.unit);
    const advU = unitLabel(report.advertised.unit);
    const hidden = hiddenCostCents(report);
    const hiddenPct = hiddenCostPercent(report);
    const confPct = evidenceCompletenessPercent(report);
    const listing = opts && opts.listing;
    const totalLabel = reportTotalLabel(report, listing);
    const gaps = unknownCosts(report);

    const left = el('div', { class: 'verdict-main' },
      el('p', { class: 'verdict-kicker' }, totalLabel),
      el('div', { class: 'price-big', 'aria-label': `${totalLabel} ${fmtUSD(report.truePrice.amount_cents)} ${trueU}` },
        fmtUSD(report.truePrice.amount_cents),
        trueU ? el('span', { class: 'unit' }, trueU) : null),
      el('p', { class: 'verdict-advertised' },
        'advertised as ',
        el('span', { class: 'price-struck' }, fmtUSD(report.advertised.amount_cents)),
        advU ? ` ${advU}` : ''),
      hidden > 0
        ? el('p', { class: 'verdict-fees' },
            `+${fmtUSD(hidden)} ${feeLinePhrase(report.vertical)} (${hiddenPct}%)`)
        : gaps.length
          ? el('p', { class: 'verdict-no-additions' }, `No additional known costs yet; ${gaps.map((item) => item.label.toLowerCase()).join(' and ')} may change checkout.`)
          : el('p', { class: 'verdict-no-additions' }, 'No additional costs identified'),
      report.total
        ? el('p', { class: 'verdict-total' }, `${report.total.label}: `, el('b', null, fmtUSD(report.total.amount_cents)))
        : null,
      el('p', { class: 'verdict-confidence' },
        el('span', { class: 'confidence-bar', role: 'img', 'aria-label': `Evidence completeness ${confPct} percent` },
          el('span', { class: 'confidence-fill', style: `width:${confPct}%` })),
        confidenceCopy(report, listing)));

    const hasScore = Boolean(score && Number.isFinite(score.score));
    const kids = [left];
    kids.push(el('div', { class: 'gauge-wrap' },
      scoreGauge(score),
      el('p', {
        class: `gauge-label ${hasScore ? scoreChipClass(score.label).replace('score-', 'gauge-') : 'gauge-none'}`,
      }, hasScore ? score.label : 'Not enough history yet'),
      hasScore && score.reasons && score.reasons.length
        ? el('ul', { class: 'gauge-reasons' }, score.reasons.map((r) => el('li', null, r)))
        : null));
    return el('section', { class: 'card verdict', 'aria-label': gaps.length ? 'Known price subtotal' : 'All-in price verdict' }, kids);
  }

  function breakdownTable(report, listing) {
    const rows = report.lineItems.map((it) => {
      return el('tr', null,
        el('td', { 'data-label': 'Line item' },
          it.label,
          it.note ? el('span', { class: 'line-note' }, it.note) : null),
        el('td', { 'data-label': 'Kind' }, el('span', { class: `chip chip-kind-${it.kind}` }, it.kind)),
        el('td', { 'data-label': 'Evidence' }, evidenceTag(it, listing)),
        el('td', { class: 'amount', 'data-label': 'Amount' }, fmtUSD(it.amount_cents)));
    });

    // The Amount column sums to the per-unit true price, so the first footer
    // row must be that sum (never the multi-unit rollup). When a rollup exists
    // (e.g. a 3-night stay), it gets its own clearly-labeled second row.
    const sumLabel = `${reportTotalLabel(report, listing)} ${unitLabel(report.truePrice.unit)}`.trim();
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

  function reportSummaryText(report, title, listing) {
    const hidden = Math.max(0, hiddenCostCents(report));
    const gaps = unknownCosts(report);
    const provenance = listing && listing.provenance && typeof listing.provenance === 'object'
      ? listing.provenance : {};
    const source = listing && (listing.sourceLabel || listing.source || provenance.source);
    const observedAt = provenance.asOf || provenance.fetchedAt || (listing && listing.fetchedAt);
    const expired = provenance.stale === true;
    const lines = [
      `${title || 'PriceTruth report'}`,
      `${reportTotalLabel(report, listing)}: ${fmtUSD(report.truePrice.amount_cents)} ${unitLabel(report.truePrice.unit)}`.trim(),
      `Advertised: ${fmtUSD(report.advertised.amount_cents)} ${unitLabel(report.advertised.unit)}`.trim(),
      `Added costs identified: ${fmtUSD(hidden)} (${hiddenCostPercent(report)}%)`,
      confidenceCopy(report, listing),
    ];
    if (gaps.length) lines.push(`Unknown checkout costs: ${gaps.map((gap) => gap.label).join(', ')}`);
    if (report.total) lines.push(`${report.total.label}: ${fmtUSD(report.total.amount_cents)}`);
    if (source) lines.push(`Source: ${source}`);
    if (observedAt) lines.push(`${isCatalogListing(listing) ? 'Price as of' : 'Observed'}: ${formatTimestamp(observedAt)}`);
    if (expired) lines.push('Freshness: expired stored observation; this is not a current offer or alert-ready price.');
    lines.push('Verify the final price with the seller before paying.');
    return lines.join('\n');
  }

  function readComparison() {
    try {
      const items = JSON.parse(localStorage.getItem(COMPARE_KEY) || '[]');
      return Array.isArray(items) ? items.slice(0, 3) : [];
    } catch (err) {
      return [];
    }
  }

  function writeComparison(items) {
    try { localStorage.setItem(COMPARE_KEY, JSON.stringify(items.slice(0, 3))); }
    catch (err) { throw new AppError('storage', 'Comparison could not be saved in this browser.'); }
  }

  function addComparison(report, opts) {
    const existing = readComparison();
    const vertical = report.vertical;
    if (existing.length && existing[0].vertical !== vertical) {
      throw new AppError('compare', `Compare like with like. Clear the current ${existing[0].vertical} comparison before adding a ${vertical} report.`);
    }
    const id = (opts && opts.productId) || `${vertical}-${(opts && opts.title) || report.advertised.amount_cents}`;
    const item = {
      id,
      title: (opts && opts.title) || `${vertical} report`,
      vertical,
      advertised_cents: report.advertised.amount_cents,
      advertised_unit: report.advertised.unit,
      true_cents: report.truePrice.amount_cents,
      true_unit: report.truePrice.unit,
      fee_load_pct: report.feeLoadPct,
      added_cost_pct: hiddenCostPercent(report),
      confidence: report.confidence,
      completeness_status: unknownCosts(report).length ? 'partial' : 'complete',
      unknown_costs: unknownCosts(report).map((gap) => gap.label),
      source: opts && opts.listing ? opts.listing.sourceLabel || opts.listing.source || null : null,
      fetched_at: opts && opts.listing ? opts.listing.fetchedAt || null : null,
      as_of: opts && opts.listing && opts.listing.provenance
        ? opts.listing.provenance.asOf || opts.listing.provenance.fetchedAt || opts.listing.fetchedAt || null
        : opts && opts.listing ? opts.listing.fetchedAt || null : null,
      stale: Boolean(opts && opts.listing && opts.listing.provenance && opts.listing.provenance.stale === true),
      href: opts && opts.productId ? `/p/${opts.productId}` : location.pathname,
    };
    const next = [item, ...existing.filter((x) => x.id !== id)].slice(0, 3);
    writeComparison(next);
    return next.length;
  }

  function saveReportButton(productId, snapshotOnly) {
    const status = el('span', { class: 'action-status', 'aria-live': 'polite' });
    const button = el('button', { class: 'btn btn-secondary btn-compact', type: 'button' }, snapshotOnly ? 'Save snapshot' : 'Save');
    button.addEventListener('click', async () => {
      clear(status);
      button.disabled = true;
      try {
        const session = await getSession();
        if (!session.authenticated) {
          const returnTo = safeAuthReturn(`/p/${productId}`);
          if (returnTo) rememberAuthReturn(returnTo);
          navigate(`/account${returnTo ? `?return=${encodeURIComponent(returnTo)}` : ''}`);
          return;
        }
        await accountJSON('/api/account/watchlist', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ product_id: productId }),
        });
        button.textContent = 'Saved ✓';
        status.textContent = snapshotOnly ? 'Snapshot saved to your dashboard.' : 'Report saved to your dashboard.';
      } catch (err) {
        if (err.status === 409) {
          button.textContent = 'Saved ✓';
          status.textContent = 'Already in your dashboard.';
        } else {
          status.textContent = err.message;
          button.disabled = false;
        }
      }
    });
    getSession().then((session) => {
      if (!session.authenticated) button.textContent = snapshotOnly ? 'Sign in to save snapshot' : 'Sign in to save';
    }).catch(() => {});
    return el('span', { class: 'action-with-status', 'data-account-required': true }, button, status);
  }

  function reportActions(report, opts) {
    const title = (opts && opts.title) || 'PriceTruth report';
    const status = el('span', { class: 'action-status', 'aria-live': 'polite' });
    const copy = el('button', { class: 'btn btn-secondary btn-compact', type: 'button' }, 'Copy summary');
    copy.addEventListener('click', async () => {
      try {
        await copyText(reportSummaryText(report, title, opts && opts.listing));
        status.textContent = 'Summary copied.';
      } catch (err) { status.textContent = err.message; }
    });
    const share = el('button', { class: 'btn btn-secondary btn-compact', type: 'button' }, 'Share');
    share.addEventListener('click', async () => {
      const stableReport = Boolean(opts && opts.productId && opts.refreshable !== false);
      const summary = reportSummaryText(report, title, opts && opts.listing);
      const data = stableReport
        ? { title: `${title} — PriceTruth`, text: summary, url: location.href }
        : { title: `${title} — PriceTruth`, text: summary };
      try {
        if (navigator.share) await navigator.share(data);
        else {
          await copyText(stableReport ? location.href : summary);
          status.textContent = stableReport ? 'Report link copied.' : 'One-time report summary copied.';
        }
      } catch (err) {
        if (err && err.name !== 'AbortError') status.textContent = 'Could not share this report.';
      }
    });
    const compare = el('button', { class: 'btn btn-secondary btn-compact', type: 'button' }, 'Compare');
    compare.addEventListener('click', () => {
      try {
        const count = addComparison(report, opts || {});
        compare.textContent = 'Added ✓';
        status.replaceChildren(`${count} report${count === 1 ? '' : 's'} ready. `,
          el('a', { href: '/compare' }, 'Open comparison'));
      } catch (err) { status.textContent = err.message; }
    });
    const print = el('button', { class: 'btn btn-ghost btn-compact', type: 'button', onclick: () => window.print() }, 'Print');
    const refine = el('a', {
      class: 'btn btn-ghost btn-compact',
      href: `/analyze?vertical=${encodeURIComponent(report.vertical)}&price=${encodeURIComponent(fmtUSD(report.advertised.amount_cents).slice(1))}`,
    }, 'Edit assumptions');
    return el('div', { class: 'report-toolbar' },
      el('div', { class: 'report-actions', role: 'group', 'aria-label': 'Report actions' },
        opts && opts.productId ? saveReportButton(opts.productId, opts.refreshable === false) : null,
        compare, copy, share, print, refine),
      status);
  }

  function evidencePanel(report, opts) {
    const listing = opts && opts.listing;
    const counts = { listed: 0, catalog: 0, typical: 0, estimated: 0 };
    for (const item of report.lineItems || []) {
      const certainty = effectiveLineCertainty(item, listing);
      const key = Object.prototype.hasOwnProperty.call(counts, certainty) ? certainty : 'estimated';
      counts[key] += 1;
    }
    const source = listing && (listing.sourceLabel || listing.source);
    const fetchedAt = listing && listing.fetchedAt;
    const provenance = listing && listing.provenance && typeof listing.provenance === 'object'
      ? listing.provenance : {};
    const isDataset = isCatalogListing(listing);
    const isLiveFetch = !isDataset && (provenance.observed === true || (listing && listing.certainty === 'live'));
    const expiredLive = isLiveFetch && provenance.stale === true;
    const freshnessLabel = expiredLive ? 'Last observed' : isLiveFetch ? 'Checked' : isDataset ? 'Price as of' : 'Model calculated';
    const freshnessValue = isDataset || isLiveFetch ? (provenance.asOf || fetchedAt) : fetchedAt;
    const degraded = listing && listing.degraded;
    const snapshotNotice = isDataset
      ? el('div', { class: `notice ${provenance.stale ? 'notice-warn' : 'notice-info'}`, role: 'status' },
        el('b', null, provenance.stale ? 'Dataset snapshot may be stale. ' : 'Catalog snapshot. '),
        provenance.stale
          ? 'This point-in-time price is older than its source freshness window. Verify the current price with the seller.'
          : 'This is a point-in-time catalog price, not a live seller quote.')
      : expiredLive
        ? el('div', { class: 'notice notice-warn', role: 'alert' },
          el('b', null, 'Stored observation expired. '),
          'Its source freshness window has passed, so this is not a current offer or alert-ready price. Recheck with the seller before using the amount.')
        : null;
    return el('section', { class: 'report-section evidence-card', 'aria-labelledby': 'evidence-heading' },
      el('div', { class: 'card' },
        el('div', { class: 'evidence-head' },
          el('div', null,
            el('p', { class: 'eyebrow' }, 'Evidence ledger'),
            el('h2', { id: 'evidence-heading' }, 'What this report knows')),
          el('span', {
            class: 'confidence-pill',
            title: 'Evidence completeness, not the probability that checkout will match.',
          }, `${evidenceCompletenessPercent(report)}% evidence complete`)),
        degraded ? el('div', { class: 'notice notice-warn', role: 'status' },
          el('b', null, 'Source temporarily unavailable. '),
          'This report uses a labeled model as a fallback; verify every amount with the seller.') : null,
        snapshotNotice,
        el('dl', { class: 'evidence-grid' },
          el('div', null, el('dt', null, 'Seller-listed'), el('dd', null, `${counts.listed} line${counts.listed === 1 ? '' : 's'}`)),
          el('div', null, el('dt', null, 'Catalog snapshot'), el('dd', null, `${counts.catalog} line${counts.catalog === 1 ? '' : 's'}`)),
          el('div', null, el('dt', null, 'Market-typical'), el('dd', null, `${counts.typical} line${counts.typical === 1 ? '' : 's'}`)),
          el('div', null, el('dt', null, 'Modeled'), el('dd', null, `${counts.estimated} line${counts.estimated === 1 ? '' : 's'}`)),
          el('div', null, el('dt', null, freshnessLabel),
            el('dd', null, isDataset ? formatSourceDate(freshnessValue) : formatTimestamp(freshnessValue)))),
        el('p', { class: 'evidence-source' },
          el('b', null, 'Source: '), source || 'Manual inputs and PriceTruth fee models.'),
        el('p', { class: 'disclosure' },
          'Seller-listed amounts come from supplied or sourced values and are not independently guaranteed. Catalog snapshots are dated. Market-typical and modeled lines are projections. Final checkout is authoritative.')));
  }

  // The shared report renderer used by both the product page and the analyzer.
  function reportView(report, opts) {
    const score = opts && opts.score ? opts.score : null;
    const frag = document.createDocumentFragment();
    frag.append(verdictPanel(report, score, opts || {}));
    frag.append(reportActions(report, opts || {}));
    frag.append(el('section', { class: 'report-section' },
      el('div', { class: 'card', style: 'padding: 0.4rem 0' },
        el('h2', { style: 'padding: 0.8rem 1.25rem 0' }, 'Where the money goes'),
        breakdownTable(report, opts && opts.listing))));
    const fold = assumptionsFold(report);
    if (fold) frag.append(el('section', { class: 'report-section' }, fold));
    frag.append(evidencePanel(report, opts || {}));
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
      ? `All-in price over the last ${days} days. Today ${fmtUSD(last.true_cents)}, low ${fmtUSD(stats.low_cents)}, average ${fmtUSD(stats.avg_cents)}, high ${fmtUSD(stats.high_cents)}.`
      : `All-in price over the last ${days} days.`;

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

  function alertUnavailablePanel() {
    return el('div', { class: 'card panel', 'data-account-required': true },
      el('p', { class: 'eyebrow' }, 'Scheduled alerts'),
      el('h2', null, 'Alerts are unavailable for this result'),
      el('p', { class: 'panel-copy' },
        'PriceTruth creates alerts only for fresh, verified sources with a stable item identity. Modeled, stale, degraded, or identity-unstable results stay one-time or history-only.'),
      el('p', { class: 'disclosure' }, 'Eligible alerts are evaluated only after scheduled verified source updates. Delivery timing follows the source-update cadence.'));
  }

  function alertForm(productId, suggestedCents, opts) {
    const options = opts || {};
    const cadenceCopy = options.vertical === 'subscription'
      ? 'PriceTruth periodically checks the verified subscription catalog and emails after a confirmed catalog update meets your target. Delivery follows that catalog schedule.'
      : 'PriceTruth checks eligible sources on a scheduled cadence and emails after a verified update meets your target. Delivery follows that source schedule.';
    const wrap = el('div', { class: 'card panel', 'data-account-required': true },
      el('h2', null, 'Watch verified price updates'),
      el('p', { class: 'panel-copy' }, cadenceCopy));
    const body = el('div', null, loadingBlock('Checking your alert settings…'));
    wrap.append(body);

    function targetInput() {
      return el('input', {
        type: 'text', inputmode: 'decimal', id: `alert-price-${productId}`,
        placeholder: 'e.g. 279.00', value: suggestedCents ? fmtUSD(suggestedCents).slice(1) : '',
        'aria-label': 'Target all-in price in dollars',
      });
    }

    function renderSignedIn(session) {
      clear(body);
      const status = el('div', { 'aria-live': 'polite' });
      const priceInput = targetInput();
      const submitBtn = el('button', { class: 'btn', type: 'submit' }, 'Create alert');
      const form = el('form', {
        'aria-label': 'Set an all-in price alert',
        onsubmit: async (e) => {
          e.preventDefault();
          clear(status);
          const cents = parseDollarsToCents(priceInput.value);
          if (cents === null || cents <= 0) {
            status.append(el('p', { class: 'form-error' }, 'Enter a target like 279 or 279.99.'));
            return;
          }
          submitBtn.disabled = true;
          try {
            const data = await accountJSON('/api/account/alerts', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ product_id: productId, threshold_cents: cents }),
            });
            const pending = data && data.alert && data.alert.status === 'pending';
            status.append(el('p', { class: 'form-success' },
              pending
                ? `Alert saved for ${fmtUSD(cents)}. Check your inbox to activate email delivery. `
                : `Alert active below ${fmtUSD(cents)} for scheduled verified updates. `,
              el('a', { href: '/account', 'data-account-required': true }, 'Manage alert')));
            submitBtn.textContent = pending ? 'Confirmation sent ✓' : 'Alert created ✓';
          } catch (err) {
            if (err.status === 402 && err.data) status.append(upsellCard(err.data));
            else status.append(el('p', { class: 'form-error' }, err.message));
            submitBtn.disabled = false;
          }
        },
      },
        el('p', { class: 'signed-in-as' }, `Signed in as ${session.account.email}`),
        el('div', { class: 'field' },
          el('label', { for: `alert-price-${productId}` }, 'Alert below ($)'), priceInput,
          el('span', { class: 'hint' }, 'Evaluated only after an eligible verified source update.')),
        submitBtn, status);
      body.append(form);
    }

    function renderSignedOut() {
      clear(body);
      const status = el('div', { 'aria-live': 'polite' });
      const emailInput = el('input', {
        type: 'email', id: `alert-email-${productId}`, autocomplete: 'email',
        placeholder: 'you@example.com', required: true,
      });
      const priceInput = targetInput();
      const submitBtn = el('button', { class: 'btn', type: 'submit' }, 'Email me a confirmation');
      const form = el('form', {
        'aria-label': 'Request a price alert',
        onsubmit: async (e) => {
          e.preventDefault();
          clear(status);
          const email = emailInput.value.trim();
          const cents = parseDollarsToCents(priceInput.value);
          if (!email || !email.includes('@')) {
            status.append(el('p', { class: 'form-error' }, 'Enter a valid email address.'));
            return;
          }
          if (cents === null || cents <= 0) {
            status.append(el('p', { class: 'form-error' }, 'Enter a target like 279 or 279.99.'));
            return;
          }
          submitBtn.disabled = true;
          try {
            const data = await fetchJSON('/api/alerts', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ email, product_id: productId, threshold_cents: cents }),
            });
            status.append(el('p', { class: 'form-success' },
              data && data.message ? data.message : 'Check your inbox to confirm this alert and secure your dashboard.'));
          } catch (err) {
            status.append(el('p', { class: 'form-error' }, err.message));
            submitBtn.disabled = false;
          }
        },
      },
        el('div', { class: 'field' }, el('label', { for: `alert-email-${productId}` }, 'Email'), emailInput),
        el('div', { class: 'field' },
          el('label', { for: `alert-price-${productId}` }, 'Alert below ($)'), priceInput,
          el('span', { class: 'hint' }, 'We send a confirmation first, then evaluate scheduled verified updates. No marketing or seller tracking.')),
        submitBtn, status,
        el('p', { class: 'disclosure', 'data-account-required': true }, 'Already have an account? ', el('a', { href: '/account' }, 'Sign in')));
      body.append(form);
    }

    getSession().then((session) => {
      if (session.authenticated) renderSignedIn(session);
      else renderSignedOut();
    }).catch(() => renderSignedOut());
    return wrap;
  }

  // The premium paywall card is driven by the server's 402 response, but the
  // checkout itself always uses the verified signed-in account. Echo only the
  // email-alert and digest benefits this client can actually deliver.
  function upsellCard(data) {
    const up = data.upgrade;
    if (!up) {
      return el('p', { class: 'form-error' }, data.error || 'Alert limit reached.');
    }
    const includes = String(up.includes || '').split(',').map((s) => s.trim())
      .filter((item) => item && /\b(?:alerts?|email|digest)\b/i.test(item));
    return el('div', { class: 'upsell', role: 'note' },
      el('h3', null, 'Unlock more alerts'),
      el('p', { style: 'margin:0.25rem 0 0.5rem;color:var(--text-soft)' },
        data.error ? `${data.error[0].toUpperCase()}${data.error.slice(1)}.` : 'Free plan limit reached.'),
      el('p', { class: 'upsell-price' }, up.price || '$4/month'),
      includes.length ? el('ul', null, includes.map((i) => el('li', null, i))) : null,
      checkoutPanel(up.planId || 'premium', 'Upgrade to Premium — $4/mo', { returnTo: location.pathname }),
      el('p', { class: 'fineprint' }, 'See ', el('a', { href: '/pricing' }, 'all plans'), '.'));
  }

  /* ================= book direct panel ================= */

  function bookDirectConfig(product) {
    const hasSeller = product.url && /^https:\/\//i.test(product.url) && !/^https:\/\/example\.com(?:\/|$)/i.test(product.url);
    const blurb = product.vertical === 'subscription'
      ? 'Confirm the intro period, renewal date, renewal amount, cancellation steps, and tax before subscribing.'
      : product.vertical === 'hotel'
        ? 'Match the same room, dates, guests, cancellation terms, mandatory-fee-inclusive displayed price, taxes, and selected add-ons at checkout.'
        : product.vertical === 'flight'
          ? 'Match the same itinerary, fare class, travelers, bags, seat choices, and payment fees at checkout.'
          : product.vertical === 'ticket'
            ? 'Match the same section, quantity, delivery method, mandatory-fee-inclusive displayed price, taxes, and selected optional add-ons at checkout.'
            : 'Match the same item, quantity, seller, shipping speed, warranty, and tax at checkout.';
    return {
      heading: 'Verify before you pay', blurb,
      cta: hasSeller ? 'Open seller page' : null,
      href: hasSeller ? product.url : null,
    };
  }

  function bookDirectPanel(product) {
    const cfg = bookDirectConfig(product);
    return el('div', { class: 'card panel' },
      el('h2', null, cfg.heading),
      el('p', { class: 'panel-copy' }, cfg.blurb),
      cfg.href ? el('a', { class: 'btn', href: cfg.href, target: '_blank', rel: 'noopener nofollow' }, cfg.cta) : null,
      el('p', { class: 'disclosure' },
        cfg.href ? 'External seller page. PriceTruth cannot guarantee availability or the final checkout amount.' : 'No seller URL was attached to this report. Use the checklist above wherever you found the offer.'));
  }

  /* ================= views ================= */

  function homeView() {
    const root = el('div', null);

    const finderHolder = el('div', { class: 'hero-finder' }, loadingBlock('Preparing the price checker…'));
    root.append(el('section', { class: 'hero flagship-hero' },
      el('p', { class: 'eyebrow' }, 'The truth before checkout'),
      el('h1', null, 'Know what the price includes before you pay.'),
      el('p', { class: 'hero-sub' },
        'Search a supported source or enter the advertised amount in front of you. Reports separate sourced values, dated catalog terms, and explicit assumptions—and stop when verified search evidence is unavailable.'),
      finderHolder,
      el('ul', { class: 'hero-promises', 'aria-label': 'PriceTruth principles' },
        el('li', null, 'Every estimate labeled'),
        el('li', null, 'Sources and freshness shown'),
        el('li', null, 'No invented listing prices'))));

    getMeta().then((meta) => {
      clear(finderHolder);
      finderHolder.append(buildFinder(meta, { compact: true }));
    }).catch((err) => {
      clear(finderHolder);
      finderHolder.append(errorBlock(err, () => navigate('/find')));
    });

    root.append(el('section', { class: 'value-grid', 'aria-label': 'How PriceTruth works' },
      el('article', { class: 'card value-card' },
        el('span', { class: 'value-number', 'aria-hidden': 'true' }, '01'),
        el('h2', null, 'Start with evidence'),
        el('p', null, 'Use a connected source or enter a known advertised price. If verified search coverage is missing, PriceTruth asks for your price instead of inventing one.')),
      el('article', { class: 'card value-card' },
        el('span', { class: 'value-number', 'aria-hidden': 'true' }, '02'),
        el('h2', null, 'Inspect the evidence'),
        el('p', null, 'Listed, market-typical, and modeled amounts stay visibly separate, with source and freshness context.')),
      el('article', { class: 'card value-card' },
        el('span', { class: 'value-number', 'aria-hidden': 'true' }, '03'),
        el('h2', null, 'Decide with the total'),
        el('p', null, 'Compare like-for-like reports, edit assumptions, and—when a source has a stable identity—save a watch. Always verify at checkout.'))));

    const grid = el('div', { class: 'product-grid' });
    const sectionContext = el('span', { class: 'section-context' });
    const sectionIntro = el('p', { style: 'color:var(--text-soft);margin-top:-0.5rem' },
      'Public reports show the evidence behind each total. Signed-in checks build history only when a source provides a stable item identity.');
    const section = el('section', { 'aria-label': 'Recent price reports', class: 'tracked-section' },
      el('div', { class: 'section-head' },
        el('h2', null, 'Explore price reports'),
        sectionContext),
      sectionIntro,
      grid);
    root.append(section);

    function load() {
      clear(grid);
      grid.append(loadingBlock('Loading tracked reports…'));
      fetchJSON('/api/products')
        .then((data) => {
          clear(grid);
          clear(sectionContext);
          const products = Array.isArray(data.products) ? data.products : [];
          if (!products.length) {
            sectionIntro.textContent = 'No public reports are available yet. You can still check a supported source or build a report from a price you already have.';
            grid.append(el('div', { class: 'card empty-state product-grid-empty' },
              el('h3', null, 'No public reports yet'),
              el('p', null, 'Start with a supported service or enter a known advertised price.'),
              el('a', { class: 'btn', href: '/find' }, 'Check a price')));
            return;
          }
          const allDemo = products.every((product) => product && product.demoData === true);
          const hasCatalog = products.some((product) => isCatalogListing(product && product.provenance));
          if (allDemo) {
            sectionContext.append(demoChip());
            sectionIntro.textContent = 'These clearly labeled examples demonstrate the report format; they are not current seller offers or observed market history.';
          } else if (hasCatalog) {
            sectionContext.append(el('span', { class: 'chip chip-catalog' }, 'Dated catalog'));
            sectionIntro.textContent = 'Dated catalog reports show sourced plan terms and calculation evidence. Verify the current offer with the seller before buying.';
          }
          for (const product of products) grid.append(productCard(product));
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
    const { product, report, score, demoData } = payload;
    const refreshable = isRefreshableResult(payload);
    const stored = payload.provenance || {};
    const cardListing = {
      source: stored.source || stored.evidence?.provenance?.source || null,
      sourceLabel: stored.sourceLabel || null,
      certainty: stored.certainty || null,
      provenance: stored.evidence?.provenance || {},
    };
    const cardLabel = reportTotalLabel(report, cardListing);
    const gaps = unknownCosts(report);
    const expired = cardListing.provenance.stale === true && !isCatalogListing(cardListing)
      && (cardListing.provenance.observed === true || cardListing.certainty === 'live' || listingSourceKey(cardListing).startsWith('live:'));
    const trueU = unitLabel(report.truePrice.unit);
    const advU = unitLabel(report.advertised.unit);
    const addedPct = hiddenCostPercent(report);
    return el('a', {
      class: 'card product-card', href: `/p/${product.id}`,
      'aria-label': `${product.name}: ${cardLabel} ${fmtUSD(report.truePrice.amount_cents)} ${trueU}`,
    },
      el('div', null, verticalBadge(product.vertical)),
      el('div', { class: 'pc-name' }, product.name),
      el('div', { class: 'pc-advertised' },
        'advertised ',
        el('span', { class: 'price-struck' }, fmtUSD(report.advertised.amount_cents)),
        advU ? ` ${advU}` : ''),
      el('div', { class: 'pc-real' },
        fmtUSD(report.truePrice.amount_cents),
        trueU ? el('span', { class: 'unit' }, ` ${trueU}`) : null),
      el('div', { class: 'pc-total-label' }, cardLabel),
      el('div', { class: 'pc-chips' },
        demoData === true ? demoChip() : null,
        el('span', { class: `chip ${gaps.length ? 'chip-warn' : 'chip-fee'}` }, gaps.length ? `${gaps.length} mandatory cost${gaps.length === 1 ? '' : 's'} unknown` : addedPct > 0 ? `+${addedPct}% outside display` : 'No additions identified'),
        expired ? el('span', { class: 'chip chip-warn' }, 'expired observation') : null,
        !refreshable ? el('span', { class: 'chip chip-warn' }, 'one-time snapshot') : null,
        scoreChip(score)));
  }

  function productView(id) {
    const root = el('div', null);
    let days = 30;
    let loadToken = 0;

    function load() {
      const token = ++loadToken;
      clear(root);
      root.append(loadingBlock('Building the all-in report…'));
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
              el('p', null, 'That tracked report does not exist or is no longer available. '),
              el('a', { class: 'btn btn-secondary', href: '/' }, 'Back to all products')));
          } else {
            root.append(errorBlock(err, load));
          }
        });
    }

    function renderProduct(payload) {
      const { product, report, stats, score, history, demoData } = payload;
      const refreshable = isRefreshableResult(payload);
      const alertEligible = isAlertEligibleResult(payload);
      const lastObserved = history && history.length ? history[history.length - 1].ts : null;
      const storedProvenance = payload.provenance || {};
      const evidenceProvenance = storedProvenance.evidence && storedProvenance.evidence.provenance
        ? storedProvenance.evidence.provenance : {};
      const catalogSnapshot = String(storedProvenance.source || evidenceProvenance.source || '').startsWith('dataset:')
        || evidenceProvenance.evidenceType === 'catalog_snapshot';
      const showDemo = demoData === true && !catalogSnapshot;
      const sourceContext = {
        source: storedProvenance.source || evidenceProvenance.source || null,
        sourceLabel: showDemo
          ? 'Illustrative PriceTruth seed dataset'
          : storedProvenance.sourceLabel || 'Tracked PriceTruth observations',
        certainty: storedProvenance.certainty || null,
        fetchedAt: storedProvenance.fetchedAt || lastObserved,
        provenance: Object.assign({}, evidenceProvenance, {
          source: storedProvenance.source || evidenceProvenance.source || null,
          fetchedAt: storedProvenance.fetchedAt || evidenceProvenance.fetchedAt || lastObserved,
        }),
      };

      root.append(el('div', { class: 'view-head' },
        el('a', { class: 'back-link', href: '/find' }, '← Check another price'),
        el('h1', { style: 'margin-top:0.5rem' }, product.name),
        el('p', { style: 'display:flex;gap:0.5rem;flex-wrap:wrap;align-items:center' },
          verticalBadge(product.vertical), showDemo ? demoChip() : null,
          product.url && /^https:\/\//i.test(product.url) && !product.url.startsWith('https://example.com')
            ? el('a', { class: 'source-link', href: product.url, target: '_blank', rel: 'noopener nofollow' }, 'Seller page ↗')
            : null)));

      document.title = `${product.name} — PriceTruth`;

      root.append(reportView(report, {
        score, productId: product.id, refreshable, title: product.name, listing: sourceContext,
      }));

      if (!refreshable) {
        root.append(el('section', { class: 'report-section panel-grid' },
          el('div', { class: 'card panel one-time-report' },
            el('p', { class: 'eyebrow' }, 'No stable seller identity'),
            el('h2', null, 'Treat this as a one-time result'),
            el('p', { class: 'panel-copy' },
              'The source did not provide a stable item identity. You can save this snapshot, but PriceTruth cannot promise reliable rechecks, history, or alerts for it.'),
            el('p', { class: 'panel-copy' }, 'Verify the current offer and final total directly with the seller.')),
          bookDirectPanel(product)));
        return;
      }

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
            el('h2', null, 'All-in price history ', showDemo ? demoChip() : null),
            el('div', { class: 'segmented', role: 'group', 'aria-label': 'History window' }, btn30, btn90)),
          chartHolder)));

      // ---- alert + book direct ----
      root.append(el('section', { class: 'report-section panel-grid' },
        alertEligible
          ? alertForm(product.id, report.truePrice.amount_cents, { vertical: product.vertical })
          : alertUnavailablePanel(),
        bookDirectPanel(product)));
    }

    load();
    return root;
  }

  /* ================= analyzer ================= */

  const EXAMPLES = [
    {
      label: 'Hotel — $219 fee-inclusive display',
      vertical: 'hotel',
      advertised: '219',
      context: {
        market: 'las_vegas', nights: 3, mandatoryFeesIncluded: true,
        taxesIncluded: false, tax_cents: 3800, parking: false,
      },
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
      label: 'Ticket — $86 display + listed tax',
      vertical: 'ticket',
      advertised: '86',
      context: { platform: 'ticketmaster', quantity: 1, allInclusivePricing: true, taxesIncluded: false, tax_cents: 710 },
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
        const mandatoryIncluded = checkRow('f-hotel-mandatory-included', 'Seller explicitly says all mandatory hotel fees are included', false);
        const taxesIncluded = checkRow('f-hotel-tax-included', 'Seller explicitly says lodging taxes are included', false);
        const taxes = textInput('blank = unknown unless confirmed above');
        const parking = textInput('blank means not selected');
        return {
          node: el('div', null,
            el('div', { class: 'form-grid' },
              fieldRow('f-market', 'Market', market),
              fieldRow('f-nights', 'Nights', nights),
              fieldRow('f-taxes', 'Explicit taxes outside the displayed nightly price ($, optional)', taxes,
                'Blank stays unknown unless you confirm inclusion. Enter 0 only when the seller explicitly shows no excluded tax.'),
              fieldRow('f-parking', 'Parking you plan to buy per night ($, optional)', parking,
                'Blank = no parking selected; parking remains an optional choice.')),
            mandatoryIncluded.node, taxesIncluded.node),
          getContext() {
            const ctx = { market: market.value, parking: false };
            if (mandatoryIncluded.input.checked) ctx.mandatoryFeesIncluded = true;
            if (taxesIncluded.input.checked) ctx.taxesIncluded = true;
            const n = optionalInt(nights, 'Nights', 1, 60);
            if (n !== undefined) ctx.nights = n;
            const t = optionalCents(taxes, 'Explicit excluded taxes');
            if (t !== undefined) { ctx.taxesIncluded = false; ctx.tax_cents = t; }
            const p = optionalCents(parking, 'Parking');
            if (p !== undefined && p > 0) { ctx.parking = true; ctx.parking_cents = p; }
            return ctx;
          },
          setContext(ctx) {
            if (ctx.market && opts.hotelMarkets[ctx.market]) market.value = ctx.market;
            if (Number.isInteger(ctx.nights)) nights.value = String(ctx.nights);
            mandatoryIncluded.input.checked = ctx.mandatoryFeesIncluded === true;
            taxesIncluded.input.checked = ctx.taxesIncluded === true;
            taxes.value = ctx.taxesIncluded === false && Number.isInteger(ctx.tax_cents)
              ? fmtUSD(ctx.tax_cents).slice(1) : '';
            if (Number.isInteger(ctx.parking_cents)) parking.value = fmtUSD(ctx.parking_cents).slice(1);
          },
        };
      }
      case 'flight': {
        const carrier = selectInput(opts.flightCarriers, 'typical_lcc');
        const carryOn = checkRow('f-carryon', 'Bringing a carry-on bag', false);
        const bags = numberInput(0, 5, 0);
        const seat = checkRow('f-seat', 'Picking a seat', false);
        const ota = checkRow('f-ota', 'Booked through a booking site (OTA)', false);
        const taxesIncluded = checkRow('f-flight-tax-included', 'Seller explicitly says mandatory taxes and carrier charges are included', false);
        return {
          node: el('div', null,
            el('div', { class: 'form-grid' },
              fieldRow('f-carrier', 'Carrier', carrier),
              fieldRow('f-bags', 'Checked bags', bags)),
            carryOn.node, seat.node, ota.node, taxesIncluded.node),
          getContext() {
            const ctx = { carrier: carrier.value };
            if (!carryOn.input.checked) ctx.carryOn = false;
            if (!seat.input.checked) ctx.seatSelection = false;
            const b = optionalInt(bags, 'Checked bags', 0, 5);
            if (b !== undefined && b > 0) ctx.checkedBags = b;
            if (ota.input.checked) ctx.channel = 'ota';
            if (taxesIncluded.input.checked) ctx.taxesIncluded = true;
            return ctx;
          },
          setContext(ctx) {
            if (ctx.carrier && opts.flightCarriers[ctx.carrier]) carrier.value = ctx.carrier;
            carryOn.input.checked = ctx.carryOn === true || Number.isInteger(ctx.carryOn_cents);
            seat.input.checked = ctx.seatSelection === true || Number.isInteger(ctx.seat_cents);
            if (Number.isInteger(ctx.checkedBags)) bags.value = String(ctx.checkedBags);
            ota.input.checked = ctx.channel === 'ota';
            taxesIncluded.input.checked = ctx.taxesIncluded === true;
          },
        };
      }
      case 'ticket': {
        const platform = selectInput(opts.ticketPlatforms, 'ticketmaster');
        const qty = numberInput(1, 20, 1);
        const allIn = checkRow('f-ticket-all-in', 'Seller explicitly says all mandatory ticket fees are included', false);
        const taxesIncluded = checkRow('f-ticket-tax-included', 'Seller explicitly says government taxes are included', false);
        const taxes = textInput('blank = unknown unless confirmed above');
        return {
          node: el('div', null,
            el('div', { class: 'form-grid' },
              fieldRow('f-platform', 'Platform', platform),
              fieldRow('f-qty', 'Tickets', qty),
              fieldRow('f-ticket-tax', 'Explicit taxes outside the displayed ticket price ($, optional)', taxes,
                'Blank stays unknown unless you confirm inclusion.')),
            allIn.node, taxesIncluded.node),
          getContext() {
            const ctx = { platform: platform.value };
            if (allIn.input.checked) ctx.allInclusivePricing = true;
            if (taxesIncluded.input.checked) ctx.taxesIncluded = true;
            const q = optionalInt(qty, 'Tickets', 1, 20);
            if (q !== undefined) ctx.quantity = q;
            const t = optionalCents(taxes, 'Explicit excluded taxes');
            if (t !== undefined) { ctx.taxesIncluded = false; ctx.tax_cents = t; }
            return ctx;
          },
          setContext(ctx) {
            if (ctx.platform && opts.ticketPlatforms[ctx.platform]) platform.value = ctx.platform;
            if (Number.isInteger(ctx.quantity)) qty.value = String(ctx.quantity);
            allIn.input.checked = ctx.allInclusivePricing === true;
            taxesIncluded.input.checked = ctx.taxesIncluded === true;
            taxes.value = ctx.taxesIncluded === false && Number.isInteger(ctx.tax_cents)
              ? fmtUSD(ctx.tax_cents).slice(1) : '';
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
        const shipping = textInput('blank = unknown; enter 0 when explicitly free');
        const handling = textInput('blank = unknown; enter 0 when explicitly none');
        const noExtras = checkRow('f-retail-no-extras', 'Seller explicitly confirms no other mandatory seller charges', false);
        const taxPct = el('input', { type: 'number', min: '0', max: '100', step: '0.01', placeholder: 'e.g. 8.375' });
        return {
          node: el('div', null,
            el('div', { class: 'form-grid' },
              fieldRow('f-ship', 'Shipping ($, optional)', shipping),
              fieldRow('f-handling', 'Handling or mandatory seller charges ($, optional)', handling),
              fieldRow('f-taxpct', 'Sales tax % (optional)', taxPct, 'Blank = unknown tax, labeled in the report')),
            noExtras.node),
          getContext() {
            const ctx = {};
            const s = optionalCents(shipping, 'Shipping');
            if (s !== undefined) ctx.shipping_cents = s;
            const h = optionalCents(handling, 'Handling or mandatory seller charges');
            if (h !== undefined) ctx.handling_cents = h;
            else if (noExtras.input.checked) ctx.mandatoryExtrasIncluded = true;
            const t = optionalPct(taxPct, 'Sales tax');
            if (t !== undefined) ctx.taxPct = t;
            return ctx;
          },
          setContext(ctx) {
            if (Number.isInteger(ctx.shipping_cents)) shipping.value = fmtUSD(ctx.shipping_cents).slice(1);
            if (Number.isInteger(ctx.handling_cents)) handling.value = fmtUSD(ctx.handling_cents).slice(1);
            noExtras.input.checked = ctx.handlingIncluded === true || ctx.mandatoryExtrasIncluded === true;
            if (typeof ctx.taxPct === 'number') taxPct.value = String(ctx.taxPct);
          },
        };
      }
      default:
        return { node: el('div'), getContext: () => ({}), setContext: () => {} };
    }
  }

  const PRICE_LABEL = {
    hotel: 'Displayed nightly price ($)',
    flight: 'Advertised fare ($)',
    ticket: 'Displayed ticket price ($)',
    subscription: 'Advertised monthly price ($)',
    retail: 'Listed price ($)',
  };

  function analyzeView() {
    const root = el('div', null);
    root.append(el('div', { class: 'view-head' },
      el('h1', null, 'Edit a manual report'),
      el('p', { style: 'color:var(--text-soft);max-width:42rem' },
        'Enter the advertised amount and the details you know. Each optional field explains what a blank value means, and every projection stays visibly labeled.')));

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
    const resultHolder = el('div', null);
    const formStatus = el('div', { 'aria-live': 'polite', 'aria-atomic': 'true' });

    const params = new URLSearchParams(location.search);
    const requestedVertical = params.get('vertical');
    const initialVertical = meta.verticals.includes(requestedVertical) ? requestedVertical : 'hotel';
    const verticalSel = selectInput(
      Object.fromEntries(meta.verticals.map((v) => [v, v[0].toUpperCase() + v.slice(1)])),
      initialVertical);
    verticalSel.setAttribute('aria-label', 'Purchase type');

    const priceInput = textInput('e.g. 219 or $1,299.00');
    priceInput.setAttribute('aria-label', 'Advertised price in dollars');
    if (params.get('price')) priceInput.value = params.get('price');

    const priceLabelEl = el('label', { for: 'f-price' }, PRICE_LABEL[initialVertical]);
    priceInput.setAttribute('id', 'f-price');

    let currentForm = buildVerticalForm(initialVertical, meta);
    const dynamicHolder = el('div', null, currentForm.node);

    function switchVertical(v) {
      verticalSel.value = v;
      currentForm = buildVerticalForm(v, meta);
      clear(dynamicHolder);
      dynamicHolder.append(currentForm.node);
      priceLabelEl.textContent = PRICE_LABEL[v] || 'Advertised price ($)';
    }
    verticalSel.addEventListener('change', () => switchVertical(verticalSel.value));

    const submitBtn = el('button', { class: 'btn', type: 'submit' }, 'Calculate the all-in total');

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
        const resultHeading = el('h2', { class: 'result-heading', tabindex: '-1' }, 'Your all-in report');
        resultHolder.append(resultHeading,
          reportView(report, {
            title: `Manual ${vertical} report`,
            listing: { sourceLabel: 'Your inputs and PriceTruth fee models', fetchedAt: new Date().toISOString() },
          }));
        resultHeading.focus({ preventScroll: true });
        const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        resultHeading.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
      } catch (err) {
        clear(resultHolder);
        formStatus.append(el('p', { class: 'form-error', role: 'alert' }, err.message));
      } finally {
        submitBtn.disabled = false;
      }
    }

    const form = el('form', {
      'aria-label': 'All-in cost analyzer',
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
      el('p', { style: 'color:var(--text-soft);max-width:42rem' },
        'Core price truth stays free. Paid plans appear only when checkout and the promised delivery services are active on this deployment.')));

    const holder = el('div', null, loadingBlock('Checking plan availability…'));
    root.append(holder);

    const tier = (name, price, unit, items, action, opts) =>
      el('div', { class: `card tier${opts && opts.featured ? ' tier-featured' : ''}` },
        opts && opts.flag ? el('span', { class: 'tier-flag' }, opts.flag) : null,
        el('h2', null, name),
        el('p', { class: 'tier-price' }, price, unit ? el('span', { class: 'unit' }, unit) : null),
        opts && opts.description ? el('p', { class: 'tier-description' }, opts.description) : null,
        el('ul', null, items.map((i) => el('li', null, i))),
        action);

    function draw(meta) {
      clear(holder);
      const canUseAccounts = accountsEnabled(meta);
      const billingConfigured = meta.billing && meta.billing.mode === 'live';
      const liveBilling = commercialReady(meta);
      if (!liveBilling) {
        holder.append(el('div', { class: 'notice notice-info' },
          el('b', null, !canUseAccounts ? 'This deployment is read-only. ' : billingConfigured ? 'Paid enrollment is not legally ready. ' : 'Paid enrollment is closed here. '),
          !canUseAccounts
            ? 'Accounts, alerts, notifications, API keys, and billing are disabled. One-time reports and local comparisons remain available.'
            : billingConfigured
            ? 'Checkout remains unavailable until approved operator, support, jurisdiction, and effective-date disclosures are configured.'
            : 'You can use every free report tool without entering payment information. Sign in to see availability updates.'));
      }
      holder.append(legalIdentity(meta, {
        class: 'deployment-identity pricing-identity',
        localText: 'No commercial operator or paid-service support channel is active on this deployment.',
      }));
      const premiumAction = liveBilling
        ? checkoutPanel('premium', 'Choose Premium', {
          returnTo: '/pricing', signInLabel: 'Sign in to choose Premium',
        })
        : canUseAccounts
          ? el('a', { class: 'btn btn-secondary', href: '/account', 'data-account-required': true }, 'Get availability updates')
          : el('p', { class: 'tier-description' }, 'Unavailable on this read-only deployment.');
      const apiAction = liveBilling
        ? checkoutPanel('api_starter', 'Choose API Starter', {
          returnTo: '/pricing', signInLabel: 'Sign in to choose API Starter',
        })
        : el('a', { class: 'btn btn-secondary', href: '/api-docs' }, 'Explore the API');
      holder.append(el('div', { class: 'tier-grid' },
        tier('Free', '$0', '/forever', [
          'All-in reports with labeled evidence',
          'Manual assumption editing',
          'Local side-by-side comparisons',
          canUseAccounts ? 'One periodic alert on an eligible verified source' : 'One-time reports with no account storage',
        ], el('a', { class: 'btn', href: '/find' }, 'Check a price'),
          { description: 'For occasional decisions and transparent price checks.' }),
        tier('Premium', '$4', '/month', [
          'Up to 20 periodic alerts on eligible sources',
          'Email after a verified catalog or source update',
          'Weekly watchlist digest',
          'Everything in Free',
        ], premiumAction, { featured: liveBilling, flag: liveBilling ? 'Available now' : canUseAccounts ? 'Early access' : 'Unavailable here', description: 'For scheduled checks of several eligible purchases after verified source updates.' }),
        tier('API Starter', '$49', '/month', [
          '100 authenticated calls per day',
          'True-price reports as structured JSON',
          'Tracked product history endpoints',
          'Key creation, rotation, and revocation',
        ], el('div', null, apiAction,
          el('p', { class: 'tier-doc-link' }, el('a', { href: '/api-docs' }, 'Read developer documentation →'))),
          { description: 'For evaluated integrations within the documented quota.' })));
    }

    getMeta().then(draw).catch((err) => {
      clear(holder);
      holder.append(errorBlock(err, () => getMeta().then(draw)));
    });

    return root;
  }

  /* ================= API docs ================= */

  function codeBlock(text) {
    return el('pre', null, el('code', null, text));
  }

  function apiDocsView() {
    const root = el('div', { class: 'docs' });
    const apiBase = location.origin;
    root.append(el('div', { class: 'view-head' },
      el('h1', null, 'B2B API'),
      el('p', { style: 'color:var(--text-soft);max-width:44rem' },
        'The same true-price engine behind this site, as JSON. Three endpoints, key-based auth, daily quotas. All money is integer USD cents.'),
      el('p', { class: 'docs-actions' },
        el('a', { class: 'btn btn-secondary', href: '/api/openapi' }, 'OpenAPI 3.1 specification'),
        el('a', { class: 'btn btn-ghost', href: '/account', 'data-account-required': true }, 'Manage API keys'))));

    root.append(el('section', null,
      el('h2', null, 'Authentication'),
      el('p', null, 'Every request needs an ', el('code', { class: 'endpoint' }, 'X-API-Key'), ' header. Create, label, rotate, and revoke keys in your authenticated ',
        el('a', { href: '/account', 'data-account-required': true }, 'account dashboard'), '. Secrets are shown once and existing values cannot be retrieved.'),
      el('p', null, 'Bad or missing keys get ', el('code', { class: 'endpoint' }, '401'),
        '; over quota gets ', el('code', { class: 'endpoint' }, '429'),
        ' (there is also a modest per-minute burst limit).')));

    root.append(el('section', null,
      el('h2', null, el('span', { class: 'method' }, 'POST'), ' ', el('code', { class: 'endpoint' }, '/api/v1/analyze')),
      el('p', null, 'Turn an advertised price into a full true-cost report. Body: ',
        el('code', { class: 'endpoint' }, '{vertical, advertised_cents, context?}'), '.'),
      codeBlock(`curl -s ${apiBase}/api/v1/analyze \\
  -H "X-API-Key: $PRICETRUTH_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"vertical":"hotel","advertised_cents":21900,"context":{"market":"las_vegas","nights":3}}'
# -> { vertical, advertised, truePrice, lineItems[], feeLoadPct, confidence, ..., usage }`)));

    root.append(el('section', null,
      el('h2', null, el('span', { class: 'method' }, 'GET'), ' ', el('code', { class: 'endpoint' }, '/api/v1/products/:id')),
      el('p', null, 'A tracked product with its report, stats, deal score, and price history.'),
      codeBlock(`const res = await fetch('${apiBase}/api/v1/products/vegas-hotel', {
  headers: { 'X-API-Key': process.env.PRICETRUTH_KEY },
});
const { product, report, stats, score, history, usage } = await res.json();`)));

    root.append(el('section', null,
      el('h2', null, el('span', { class: 'method' }, 'GET'), ' ', el('code', { class: 'endpoint' }, '/api/v1/usage')),
      el('p', null, 'Where you stand against your daily quota.'),
      codeBlock(`curl -s ${apiBase}/api/v1/usage -H "X-API-Key: $PRICETRUTH_KEY"
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
        el('b', null, 'zero network requests'), '. The current preview is installed manually while seller-specific detection is being validated.')));

    root.append(el('div', { class: 'card', style: 'display:flex;flex-wrap:wrap;gap:1rem;align-items:center;justify-content:space-between' },
      el('div', null,
        el('h2', { style: 'margin:0 0 0.25rem' }, 'Install the preview'),
        el('p', { style: 'margin:0;color:var(--text-soft)' }, 'Download the reviewed source bundle, then load it locally in Chrome, Edge, or Brave.')),
      el('div', { style: 'display:flex;gap:0.6rem;flex-wrap:wrap' },
        el('a', { class: 'btn', href: '/download/extension.zip', download: 'pricetruth-extension.zip' }, 'Download extension (.zip)'),
        el('a', { class: 'btn btn-secondary', href: '/extension-demo.html' }, 'Open interactive preview'))));

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
        step(5, 'Try it', ['Open the ', el('a', { href: '/extension-demo.html' }, 'interactive preview'), ' — the badge appears bottom-right. Supported seller layouts use dedicated detection rules.']))));

    root.append(el('section', { style: 'margin-top:1.5rem' },
      el('h2', null, 'What it does'),
      el('ul', { class: 'ext-facts' },
        el('li', null, el('b', null, 'Reads a clearly scoped visible price'), ' only when a supported page shows explicit USD plus reliable U.S. offer or point-of-sale evidence. U.S. hotel and ticket prices are treated as mandatory-fee-inclusive; only selected or explicitly evidenced excluded costs should be added.'),
        el('li', null, el('b', null, 'Labels every estimate'), ' — anything beyond the advertised price is marked ', el('code', { class: 'endpoint' }, 'typical'), ' or ', el('code', { class: 'endpoint' }, 'estimated'), ', never presented as a quote.'),
        el('li', null, el('b', null, 'Sends nothing'), ' — the fee model is bundled; all math runs in your browser. No tracking, no accounts, no server calls.'),
        el('li', null, el('b', null, 'Stays quiet when unsure'), ' — a bare dollar sign, foreign currency, missing U.S. scope, or uncertain price produces no overlay.'))));

    root.append(el('div', { class: 'notice notice-info', style: 'margin-top:1.25rem' },
      el('b', null, 'Preview limitations. '),
      'This build is not yet distributed through a browser store, and price detection may miss or misread unfamiliar seller layouts. If it is not confident, it stays hidden. Always verify checkout.'));
    return root;
  }

  /* ================= live price finder ================= */

  // Badge the listing by its certainty, never by "not estimated". A dated
  // catalog snapshot (certainty 'typical', e.g. a matched subscription) is real
  // but is not a current provider quote, so it must never wear the green "live"
  // chip — that is the product's core honesty rule.
  const SOURCE_BADGE = {
    live: { cls: 'chip chip-live', label: 'live data', say: 'Live data.' },
    catalog: { cls: 'chip chip-catalog', label: 'catalog snapshot', say: 'Catalog snapshot (point-in-time, not a live quote).' },
    typical: { cls: 'chip chip-typical', label: 'market typical', say: 'Market-typical estimate, not a seller quote.' },
    estimated: { cls: 'chip chip-estimate', label: 'estimated', say: 'Estimated.' },
  };
  function sourceBadge(listing) {
    const b = isCatalogListing(listing)
      ? SOURCE_BADGE.catalog
      : SOURCE_BADGE[(listing && listing.certainty)] || SOURCE_BADGE.estimated;
    const note = (listing && listing.sourceLabel) || '';
    return el('span', {
      class: b.cls, title: note,
      'aria-label': `${b.say} ${note}`,
    }, b.label);
  }

  const FIND_EXAMPLES = {
    hotel: ['Las Vegas', 'Miami', 'New York'],
    flight: ['LAX-LAS', 'SFO to JFK', 'ORD-MIA'],
    ticket: ['Taylor Swift', 'Lakers', 'Hamilton'],
    subscription: ['Netflix', 'Disney+', 'Spotify', 'Adobe'],
    retail: ['wireless headphones', 'air fryer', 'standing desk'],
  };
  const FIND_PLACEHOLDER = {
    hotel: 'City, e.g. Las Vegas',
    flight: 'Route, e.g. LAX-LAS',
    ticket: 'Artist, team, or show',
    subscription: 'Service name, e.g. netflix',
    retail: 'Product name',
  };

  function providerSearchMode(meta, vertical) {
    const provider = meta && meta.providers && meta.providers[vertical];
    if (!provider || provider.truthUsable === false) return 'manual';
    if (provider.kind === 'dataset') return 'catalog';
    if (provider.kind === 'live' && provider.live === true) return 'live';
    return 'manual';
  }

  function inferVertical(value) {
    const s = String(value || '').toLowerCase();
    if (/\b(hotel|resort|room|night|lodging|airbnb|booking\.com|hotels\.com|marriott|hilton|hyatt)\b/.test(s)) return 'hotel';
    if (/\b(flight|airline|airfare|carry-on|baggage|spirit|frontier|delta|united|southwest|jetblue|flyfrontier|aa\.com)\b|\b[a-z]{3}\s*(?:-|to|→)\s*[a-z]{3}\b/.test(s)) return 'flight';
    if (/\b(ticket|concert|tour|arena|stadium|section|ticketmaster|stubhub|seatgeek)\b/.test(s)) return 'ticket';
    if (/\b(subscription|monthly|renewal|streaming|vpn|netflix|spotify|disney|adobe|newspaper|fitness)\b/.test(s)) return 'subscription';
    return 'retail';
  }

  function manualContext(vertical) {
    if (vertical === 'hotel') return {
      market: 'default', nights: 1, parking: false,
    };
    if (vertical === 'flight') return {
      carrier: 'typical_legacy',
      carryOn: false, seatSelection: false, checkedBags: 0,
    };
    if (vertical === 'ticket') return {
      platform: 'default', quantity: 1,
    };
    if (vertical === 'subscription') return { pattern: 'default' };
    return {};
  }

  function findView() {
    const root = el('div', null);
    root.append(el('div', { class: 'view-head' },
      el('p', { class: 'eyebrow' }, 'One place to start'),
      el('h1', null, 'Check a price before checkout'),
      el('p', { style: 'color:var(--text-soft);max-width:44rem' },
        'Search a connected source or enter the advertised amount you can see. PriceTruth shows an evidence-backed total when coverage exists—and says so plainly when it does not.')));
    const holder = el('div', null, loadingBlock('Loading options…'));
    root.append(holder);
    getMeta()
      .then((meta) => { clear(holder); holder.append(buildFinder(meta)); })
      .catch((err) => { clear(holder); holder.append(errorBlock(err, () => findRetry(holder))); });
    return root;
  }

  function findRetry(holder) {
    clear(holder);
    holder.append(loadingBlock('Loading options…'));
    getMeta().then((meta) => { clear(holder); holder.append(buildFinder(meta)); })
      .catch((e) => { clear(holder); holder.append(errorBlock(e)); });
  }

  function buildFinder(meta, options) {
    const compact = Boolean(options && options.compact);
    const container = el('div', null);
    const resultHolder = el('div', { class: 'finder-results' });
    const formStatus = el('div', { 'aria-live': 'polite', 'aria-atomic': 'true' });
    const verticals = meta.verticals || meta.searchVerticals || [];
    const verticalLabels = Object.fromEntries(verticals.map((vertical) => {
      const name = vertical[0].toUpperCase() + vertical.slice(1);
      return [vertical, providerSearchMode(meta, vertical) === 'manual' ? `${name} — manual price` : name];
    }));

    const verticalSel = selectInput(
      Object.assign({ auto: 'Auto-detect category' },
        verticalLabels), 'auto');
    verticalSel.setAttribute('id', 'find-vertical');

    const qInput = el('input', {
      type: 'text', id: 'find-q', autocomplete: 'off',
      placeholder: 'Search supported sources or enter a known price',
    });
    const submitBtn = el('button', { class: 'btn finder-submit', type: 'submit' }, 'Check available evidence');
    const modeHint = el('p', { class: 'input-mode', 'aria-live': 'polite' },
      'Searches use only connected or dated sources. A known dollar amount creates an editable manual report after you choose a category.');

    const statusLine = el('p', { class: 'find-status' });
    const STATUS = {
      live: { cls: 'chip chip-live', label: 'Direct source', say: ' Listings are requested from a connected source and timestamped.' },
      catalog: { cls: 'chip chip-catalog', label: 'Dated catalog', say: ' Catalog prices are point-in-time; verify current seller pricing.' },
      manual: { cls: 'chip chip-warn', label: 'Manual price required', say: ' No verified search source is connected for this category. Enter the advertised amount you can see.' },
    };

    function selectedVertical() {
      return verticalSel.value === 'auto' ? inferVertical(qInput.value) : verticalSel.value;
    }

    function updateInputGuidance() {
      const cents = parseDollarsToCents(qInput.value);
      const vertical = selectedVertical();
      const mode = providerSearchMode(meta, vertical);
      if (verticalSel.value !== 'auto') {
        qInput.placeholder = mode === 'manual'
          ? 'Enter the advertised price, e.g. $219'
          : (FIND_PLACEHOLDER[vertical] || 'Search or enter a known price');
      } else {
        qInput.placeholder = 'Search supported sources or enter a known price';
      }
      submitBtn.textContent = cents !== null
        ? (verticalSel.value === 'auto' ? 'Choose a category' : 'Build the all-in report')
        : mode === 'manual' ? 'Use a known price' : 'Check available evidence';
    }

    function refreshStatus() {
      const cents = parseDollarsToCents(qInput.value);
      if (verticalSel.value === 'auto' && !qInput.value.trim()) {
        clear(statusLine);
        statusLine.append(el('span', { class: 'chip chip-typical' }, 'Automatic'),
          ' Category and verified source coverage are identified from your input.');
        updateInputGuidance();
        return;
      }
      const v = selectedVertical();
      if (cents !== null) {
        clear(statusLine);
        statusLine.append(el('span', { class: 'chip chip-typical' }, 'Manual input'),
          verticalSel.value === 'auto'
            ? ' Choose a category so PriceTruth can apply the correct cost model.'
            : ` ${v[0].toUpperCase() + v.slice(1)} assumptions will be explicit and editable.`);
        updateInputGuidance();
        return;
      }
      const mode = providerSearchMode(meta, v);
      const s = STATUS[mode];
      clear(statusLine);
      statusLine.append(el('span', { class: s.cls }, s.label),
        verticalSel.value === 'auto' ? ` Detected ${v}.` : '', s.say);
      updateInputGuidance();
    }

    const chipsWrap = el('div', { class: 'example-chips', role: 'group', 'aria-label': 'Example searches' });
    function refreshChips() {
      clear(chipsWrap);
      const catalogPlans = meta.subscriptionCatalog && Array.isArray(meta.subscriptionCatalog.plans)
        ? meta.subscriptionCatalog.plans.map((plan) => plan && (plan.name || plan.slug)).filter(Boolean).slice(0, 4)
        : [];
      let examples;
      if (verticalSel.value === 'auto') {
        examples = [];
        if (providerSearchMode(meta, 'subscription') === 'catalog') examples.push(...catalogPlans.slice(0, 2));
        for (const vertical of verticals) {
          if (providerSearchMode(meta, vertical) === 'live' && FIND_EXAMPLES[vertical] && FIND_EXAMPLES[vertical][0]) {
            examples.push(FIND_EXAMPLES[vertical][0]);
          }
        }
        examples = [...new Set(examples)].slice(0, 3);
        examples.push('$219');
      } else if (providerSearchMode(meta, verticalSel.value) === 'catalog' && verticalSel.value === 'subscription') {
        examples = catalogPlans;
      } else if (providerSearchMode(meta, verticalSel.value) === 'live') {
        examples = FIND_EXAMPLES[verticalSel.value] || [];
      } else {
        examples = ['$219'];
      }
      for (const ex of examples) {
        chipsWrap.append(el('button', { type: 'button', onclick: () => {
          clear(formStatus);
          qInput.value = ex;
          refreshStatus();
          if (parseDollarsToCents(ex) !== null && verticalSel.value === 'auto') {
            formStatus.append(el('p', { class: 'form-error', role: 'alert' },
              'Choose what you are buying before PriceTruth calculates from this amount.'));
            verticalSel.focus();
            return;
          }
          run();
        } }, ex));
      }
    }

    verticalSel.addEventListener('change', () => { clear(formStatus); refreshStatus(); refreshChips(); });
    qInput.addEventListener('input', () => {
      const cents = parseDollarsToCents(qInput.value);
      if (cents !== null) {
        modeHint.textContent = verticalSel.value === 'auto'
          ? 'Manual price detected. Choose a category before calculating.'
          : 'Manual price detected. Every assumption in the report will be labeled and editable.';
      } else if (/^https?:\/\//i.test(qInput.value.trim())) {
        modeHint.textContent = 'Seller URL detected. PriceTruth will use it only when a verified source supports that seller or category.';
      } else {
        modeHint.textContent = 'Search detected. PriceTruth returns only direct or dated catalog evidence—never an invented listing price.';
      }
      refreshStatus();
    });

    function focusFinderResult() {
      const heading = resultHolder.querySelector('h2');
      if (heading) {
        heading.setAttribute('tabindex', '-1');
        heading.focus({ preventScroll: true });
      }
      const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      resultHolder.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
    }

    function sourceUnavailableView(err, vertical) {
      const code = err && err.data && err.data.code;
      let heading = 'Enter the price you can see';
      let detail = 'No verified search source is connected for this category.';
      if (code === 'NO_VERIFIED_RESULT') {
        heading = 'No verified price found';
        detail = 'The connected source did not return a matching offer.';
      } else if (code === 'PRICE_SOURCE_FAILED') {
        heading = 'That price source is temporarily unavailable';
        detail = 'PriceTruth stopped instead of substituting an invented listing price.';
      } else if (code === 'PRICE_SOURCE_BUSY' || (err && err.status === 429)) {
        heading = 'That price source is busy';
        detail = 'Wait a moment and retry, or continue with a price you already have.';
      } else if (err && err.kind === 'network') {
        heading = 'Price check unavailable';
        detail = 'PriceTruth could not reach the server. Your input is still here so you can retry.';
      }
      const title = el('h2', { tabindex: '-1' }, heading);
      const retry = err && (err.kind === 'network' || code === 'PRICE_SOURCE_FAILED' || code === 'PRICE_SOURCE_BUSY')
        ? el('button', { class: 'btn btn-secondary', type: 'button', onclick: run }, 'Try the source again')
        : null;
      const enterKnown = el('button', { class: 'btn', type: 'button', onclick: () => {
        qInput.value = '';
        clear(resultHolder);
        clear(formStatus);
        refreshStatus();
        qInput.focus();
      } }, 'Enter a known price');
      return el('div', { class: 'card state-error state-coverage', role: 'alert' },
        title,
        el('p', null, detail),
        el('p', null, 'PriceTruth will not make up a dollar amount. Enter the advertised amount above, choose a category, and every assumption will remain visible and editable.'),
        el('div', { class: 'state-actions' }, enterKnown, retry,
          el('a', { class: 'btn btn-ghost', href: `/analyze?vertical=${encodeURIComponent(vertical)}` }, 'Open manual analyzer')));
    }

    async function run() {
      clear(formStatus);
      const q = qInput.value.trim();
      const manualCents = parseDollarsToCents(q);
      if (q.length < 2 && manualCents === null) {
        formStatus.append(el('p', { class: 'form-error', role: 'alert' }, 'Paste a link, enter a price, or type at least 2 characters.'));
        return;
      }
      if (manualCents !== null && manualCents <= 0) {
        formStatus.append(el('p', { class: 'form-error', role: 'alert' }, 'Enter a price greater than $0.'));
        qInput.focus();
        return;
      }
      if (manualCents !== null && verticalSel.value === 'auto') {
        formStatus.append(el('p', { class: 'form-error', role: 'alert' },
          'Choose a category before PriceTruth calculates from a known price.'));
        verticalSel.focus();
        return;
      }
      const vertical = verticalSel.value === 'auto' ? inferVertical(q) : verticalSel.value;
      if (manualCents === null && providerSearchMode(meta, vertical) === 'manual') {
        clear(resultHolder);
        resultHolder.append(sourceUnavailableView({ data: { code: 'PRICE_SOURCE_UNAVAILABLE' } }, vertical));
        focusFinderResult();
        return;
      }
      clear(resultHolder);
      resultHolder.append(loadingBlock(manualCents !== null ? 'Building your all-in report…' : 'Checking price evidence…'));
      submitBtn.disabled = true;
      try {
        let view;
        if (manualCents !== null && manualCents > 0) {
          const report = await fetchJSON('/api/analyze', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ vertical, advertised_cents: manualCents, context: manualContext(vertical) }),
          });
          view = el('div', null,
            el('div', { class: 'result-title' },
              el('p', { class: 'eyebrow' }, 'Manual report'),
              el('h2', { tabindex: '-1' }, `${vertical[0].toUpperCase() + vertical.slice(1)} price at ${fmtUSD(manualCents)}`),
              el('p', null, 'We started with conservative category defaults. Use “Edit assumptions” to replace them with your exact cart or trip details.')),
            reportView(report, {
              title: `Manual ${vertical} report`,
              listing: { sourceLabel: 'Your advertised price and PriceTruth fee models', fetchedAt: new Date().toISOString() },
            }));
        } else {
          const session = await getSession();
          const searchRequest = session.authenticated ? accountJSON : fetchJSON;
          const data = await searchRequest('/api/search', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ vertical, q }),
          });
          view = findResult(data);
        }
        clear(resultHolder);
        resultHolder.append(view);
        focusFinderResult();
      } catch (err) {
        clear(resultHolder);
        const code = err && err.data && err.data.code;
        const safeSourceFailure = ['PRICE_SOURCE_UNAVAILABLE', 'NO_VERIFIED_RESULT', 'PRICE_SOURCE_FAILED', 'PRICE_SOURCE_BUSY'].includes(code);
        resultHolder.append(safeSourceFailure || (err && (err.kind === 'network' || err.status === 429))
          ? sourceUnavailableView(err, vertical)
          : el('div', { class: 'card state-error', role: 'alert' },
            el('h2', { tabindex: '-1' }, 'We could not build that report'),
            el('p', null, err.message),
            el('button', { class: 'btn btn-secondary', type: 'button', onclick: run }, 'Try again')));
        focusFinderResult();
      } finally {
        submitBtn.disabled = false;
      }
    }

    const form = el('form', { class: 'universal-form', 'aria-label': 'Check an advertised price', onsubmit: (e) => { e.preventDefault(); run(); } },
      el('div', { class: 'universal-input-row' },
        el('div', { class: 'field universal-query' },
          el('label', { for: 'find-q' }, 'URL, product, route, event, service, or price'), qInput),
        el('div', { class: 'field universal-category' }, el('label', { for: 'find-vertical' }, 'Category'), verticalSel),
        submitBtn),
      modeHint, statusLine, formStatus);

    refreshStatus();
    refreshChips();

    container.append(el('div', { class: compact ? 'universal-card universal-card-hero' : 'card universal-card' }, form),
      el('div', { class: 'finder-examples' }, el('span', null, 'Try:'), chipsWrap),
      resultHolder);
    return container;
  }

  function findResult(data) {
    const { listing, report, score, product_id } = data;
    const persisted = data.persisted === true && typeof product_id === 'string' && product_id.length > 0;
    const refreshable = isRefreshableResult(data);
    const trackable = persisted && refreshable;
    const alertEligible = isAlertEligibleResult(data);
    const sellerUrl = listing.url && /^https:\/\//i.test(listing.url) ? listing.url : null;
    const frag = document.createDocumentFragment();
    frag.append(el('div', { class: 'result-title' },
      el('p', { class: 'eyebrow' }, 'All-in report'),
      el('h2', { style: 'margin-bottom:0.25rem' }, listing.name),
      el('p', { style: 'display:flex;gap:0.5rem;flex-wrap:wrap;align-items:center' },
        verticalBadge(listing.vertical), sourceBadge(listing),
        listing.degraded ? el('span', { class: 'chip chip-warn', title: listing.sourceLabel }, 'fallback model') : null,
        sellerUrl ? el('a', { class: 'source-link', href: sellerUrl, target: '_blank', rel: 'noopener nofollow' }, 'Seller page ↗') : null)));
    frag.append(reportView(report, {
      score, productId: persisted ? product_id : null, refreshable, title: listing.name, listing,
    }));
    const productLike = { id: persisted ? product_id : null, vertical: listing.vertical, url: sellerUrl, name: listing.name };
    if (trackable) {
      frag.append(el('section', { class: 'report-section' },
        el('div', { class: 'card panel' },
          el('h2', null, 'Observation started'),
          el('p', { class: 'panel-copy' },
            'This exact result now has a stable report page. Recheck it over time to build a meaningful observed history.'),
          el('a', { class: 'btn btn-secondary', href: `/p/${product_id}` }, 'Open tracked report'))));
      frag.append(el('section', { class: 'report-section panel-grid' },
        alertEligible
          ? alertForm(product_id, report.truePrice.amount_cents, { vertical: listing.vertical })
          : alertUnavailablePanel(),
        bookDirectPanel(productLike)));
    } else if (!refreshable) {
      frag.append(el('section', { class: 'report-section panel-grid' },
        el('div', { class: 'card panel one-time-report' },
          el('p', { class: 'eyebrow' }, 'No stable seller identity'),
          el('h2', null, 'Treat this as a one-time result'),
          el('p', { class: 'panel-copy' }, persisted
            ? 'The source did not provide a stable item identity. You can save this snapshot, but PriceTruth will not promise reliable rechecks, history, or alerts for it.'
            : 'The source did not provide a stable item identity, so PriceTruth will not promise reliable rechecks, history, saving, or alerts for this result.'),
          el('p', { class: 'panel-copy' }, 'Verify the current offer and final total directly with the seller.')),
        bookDirectPanel(productLike)));
    } else {
      frag.append(el('section', { class: 'report-section panel-grid' },
        el('div', { class: 'card panel one-time-report', 'data-account-required': true },
          el('p', { class: 'eyebrow' }, 'Private by default'),
          el('h2', null, 'This is a one-time report'),
          el('p', { class: 'panel-copy' },
            'PriceTruth did not store this check, start history, or create an alert. This page is not a stable report link.'),
          el('p', { class: 'panel-copy' },
            'Sign in, then run the check again when you want to save it, track changes, or create a price alert.'),
          el('a', { class: 'btn btn-secondary', href: '/account', 'data-account-required': true }, 'Sign in to save future checks')),
        bookDirectPanel(productLike)));
    }
    return frag;
  }

  /* ================= local report comparison ================= */

  function comparisonView() {
    const root = el('div', null);
    root.append(el('div', { class: 'view-head compare-head' },
      el('p', { class: 'eyebrow' }, 'Like for like'),
      el('h1', null, 'Compare price evidence'),
      el('p', null, 'Compare up to three reports from the same category. Known subtotals and expired observations stay labeled. PriceTruth stores this comparison only in this browser.')));
    const holder = el('div', null);
    root.append(holder);

    function draw() {
      clear(holder);
      const items = readComparison();
      if (!items.length) {
        holder.append(el('div', { class: 'card empty-state' },
          el('h2', null, 'No reports to compare yet'),
          el('p', null, 'Check a price, then choose “Compare” in the report toolbar. Add another report from the same category to see the difference.'),
          el('a', { class: 'btn', href: '/find' }, 'Check a price')));
        return;
      }
      const completeCurrent = items.filter((item) => item.completeness_status !== 'partial' && item.stale !== true);
      const lowest = completeCurrent.length ? Math.min(...completeCurrent.map((item) => item.true_cents)) : null;
      const table = el('table', { class: 'comparison-table' },
        el('caption', null, `${items[0].vertical} price-evidence comparison`),
        el('thead', null, el('tr', null,
          el('th', { scope: 'col' }, 'Report'),
          el('th', { scope: 'col' }, 'Advertised'),
          el('th', { scope: 'col' }, 'Compared price'),
          el('th', { scope: 'col' }, 'Added cost'),
          el('th', { scope: 'col' }, 'Evidence complete'),
          el('th', { scope: 'col' }, ''))),
        el('tbody', null, items.map((item) => {
          const safeHref = typeof item.href === 'string' && /^\/(?:find|p\/[a-z0-9-]{1,64})$/.test(item.href)
            ? item.href : '/find';
          const partial = item.completeness_status === 'partial';
          const stale = item.stale === true;
          const comparable = !partial && !stale && lowest !== null;
          const delta = comparable ? item.true_cents - lowest : null;
          const remove = el('button', { class: 'btn btn-ghost btn-compact', type: 'button', 'aria-label': `Remove ${item.title}` }, 'Remove');
          remove.addEventListener('click', () => {
            writeComparison(readComparison().filter((x) => x.id !== item.id));
            draw();
          });
          return el('tr', null,
            el('th', { scope: 'row', 'data-label': 'Report' },
              el('a', { href: safeHref }, item.title),
              item.source ? el('span', { class: 'line-note' }, item.source) : null,
              item.as_of ? el('span', { class: 'line-note' }, `${stale ? 'Expired · ' : ''}${formatTimestamp(item.as_of)}`) : null),
            el('td', { 'data-label': 'Advertised' }, fmtUSD(item.advertised_cents), ' ', unitLabel(item.advertised_unit)),
            el('td', { 'data-label': 'Compared price', class: 'compare-total' }, fmtUSD(item.true_cents), ' ', unitLabel(item.true_unit),
              partial ? el('span', { class: 'chip chip-warn' }, 'known subtotal')
                : stale ? el('span', { class: 'chip chip-warn' }, 'expired observation')
                  : delta === 0 ? el('span', { class: 'chip chip-listed' }, 'lowest complete')
                    : el('span', { class: 'line-note' }, `+${fmtUSD(delta)} vs lowest complete`),
              partial && Array.isArray(item.unknown_costs) && item.unknown_costs.length
                ? el('span', { class: 'line-note' }, `Unknown: ${item.unknown_costs.join(', ')}`) : null),
            el('td', { 'data-label': 'Added cost' }, `${Number.isFinite(item.added_cost_pct) ? item.added_cost_pct : item.fee_load_pct}%`),
            el('td', { 'data-label': 'Evidence complete' }, `${evidenceCompletenessPercent(item)}%`),
            el('td', { 'data-label': 'Action' }, remove));
        })));
      const clearBtn = el('button', { class: 'btn btn-ghost', type: 'button', onclick: () => { writeComparison([]); draw(); } }, 'Clear comparison');
      holder.append(el('div', { class: 'notice notice-info' },
        el('b', null, 'Before deciding: '),
        'only complete, current reports receive a lowest-price marker. Confirm the same quantity, dates, travelers, inclusions, cancellation terms, and tax location.'),
        el('div', { class: 'card comparison-wrap' }, table),
        el('div', { class: 'compare-actions' }, el('a', { class: 'btn', href: '/find' }, 'Add another report'), clearBtn));
    }
    draw();
    return root;
  }

  /* ================= billing / checkout ================= */

  async function startCheckout(planId, acceptance) {
    const legalAcceptance = acceptance || {};
    const request = () => accountJSON('/api/billing/checkout', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planId, ...legalAcceptance }),
    });
    let data;
    try {
      data = await request();
    } catch (err) {
      // Refresh a stale session/CSRF pair once. A second denial is surfaced and
      // never downgraded to an unauthenticated or email-only checkout.
      if (err.status !== 403) throw err;
      const fresh = await getSession(true);
      if (!fresh.authenticated) throw new AppError('auth', 'Your sign-in expired. Sign in again to continue.', 401);
      data = await request();
    }
    if (data && data.url) window.location.assign(data.url);
    else throw new AppError('billing', 'Could not start checkout.');
  }

  // Live checkout belongs to a verified account. The server ignores arbitrary
  // checkout emails, so this control never asks for or sends one. In non-live
  // billing modes it fails closed and renders no purchase button.
  let checkoutPanelSequence = 0;
  function checkoutPanel(planId, buttonLabel, opts) {
    const options = opts || {};
    const panel = el('div', { class: 'checkout-panel' }, loadingBlock('Checking secure checkout…'));

    function signInState(message, sessionUnavailable) {
      clear(panel);
      if (message) panel.append(el('p', { class: 'notice notice-warn' }, message));
      if (sessionUnavailable) {
        panel.append(el('p', { class: 'disclosure' }, 'Secure account sign-in is not active, so checkout is unavailable.'));
        return;
      }
      const returnTo = safeAuthReturn(options.returnTo) || '/pricing';
      const signIn = el('a', {
        class: `btn${options.secondary ? ' btn-secondary' : ''}`,
        href: `/account?return=${encodeURIComponent(returnTo)}`,
        'data-account-required': true,
        onclick: () => { rememberAuthReturn(returnTo); },
      }, options.signInLabel || 'Sign in to continue');
      panel.append(signIn,
        el('p', { class: 'checkout-note' }, 'Checkout uses the email verified on your account. No separate billing email is collected here.'));
    }

    async function draw() {
      clear(panel);
      panel.append(loadingBlock('Checking secure checkout…'));
      const [meta, session] = await Promise.all([getMeta(), getSession()]);
      clear(panel);
      if (!commercialReady(meta)) {
        panel.append(el('div', { class: 'notice notice-info' },
          el('b', null, 'Paid enrollment is closed here. '),
          meta.billing && meta.billing.mode === 'live'
            ? 'Approved operator disclosures are incomplete, so checkout is unavailable.'
            : 'No payment checkout is available on this deployment.'));
        return;
      }
      if (!session.authenticated) {
        signInState(null, session.unavailable);
        return;
      }

      const legal = approvedLegal(meta);
      const termsVersion = legal && typeof meta.legal.termsVersion === 'string'
        ? meta.legal.termsVersion.trim() : '';
      if (!termsVersion) {
        panel.append(el('div', { class: 'notice notice-warn' },
          el('b', null, 'Checkout terms are unavailable. '),
          'Paid checkout remains closed until the current legal version is configured.'));
        return;
      }

      const status = el('div', { 'aria-live': 'polite' });
      const acceptanceId = `checkout-terms-${planId}-${++checkoutPanelSequence}`;
      const acceptance = el('input', { id: acceptanceId, type: 'checkbox', required: true });
      const btn = el('button', {
        class: `btn${options.secondary ? ' btn-secondary' : ''}`,
        type: 'submit',
        disabled: true,
      }, buttonLabel);
      acceptance.addEventListener('change', () => { btn.disabled = !acceptance.checked; });
      const form = el('form', {
        class: 'checkout-form',
        'aria-label': `Start ${planId.replace(/_/g, ' ')} checkout`,
        onsubmit: async (e) => {
          e.preventDefault();
          clear(status);
          if (!acceptance.checked) {
            status.append(el('p', { class: 'form-error' }, 'Review and accept the current Terms and Privacy Notice before checkout.'));
            acceptance.focus();
            return;
          }
          btn.disabled = true;
          btn.textContent = 'Opening secure checkout…';
          try {
            await startCheckout(planId, { acceptTerms: true, acceptedTermsVersion: termsVersion });
          } catch (err) {
            if (err.status === 401) {
              clearSession();
              signInState('Your secure sign-in expired. Sign in again to continue.');
              return;
            }
            status.append(el('p', { class: 'form-error' }, err.status === 403
              ? 'Secure checkout could not verify this session. Refresh the page and try again.'
              : err.message));
            btn.disabled = false;
            btn.textContent = buttonLabel;
          }
        },
      },
        el('p', { class: 'signed-in-as' }, 'Checkout account: ', el('b', null, session.account.email)),
        el('div', { class: 'checkout-acceptance field-check' }, acceptance,
          el('label', { for: acceptanceId },
            'I agree to the ', el('a', { href: '/legal.html#terms', target: '_blank', rel: 'noopener' }, 'Terms'),
            ' and acknowledge the ', el('a', { href: '/legal.html#privacy', target: '_blank', rel: 'noopener' }, 'Privacy Notice'),
            `. Terms version ${termsVersion}; effective ${legal.effectiveDate}.`)),
        btn,
        el('p', { class: 'checkout-note' }, 'Plan, renewal, tax, and cancellation details are confirmed before payment.'),
        status);
      panel.append(form);
    }

    draw().catch((err) => {
      clear(panel);
      panel.append(errorBlock(err, () => draw()));
    });
    return panel;
  }

  function billingSuccessView() {
    const root = el('div', null);
    const params = new URLSearchParams(location.search);
    const sessionId = params.get('session_id');
    const isMock = params.get('mock') === '1';
    const title = el('h1', null, isMock ? 'Finalizing checkout rehearsal' : 'Finalizing your purchase');

    root.append(el('div', { class: 'view-head' },
      title,
      isMock ? el('p', null, el('span', { class: 'chip chip-demo' }, 'simulated'),
        ' This environment runs a checkout rehearsal only. No card was charged and no paid service was purchased.') : null));

    const body = el('div', { 'aria-live': 'polite' }, loadingBlock('Waiting for confirmed billing status…'));
    root.append(body);

    if (!sessionId) {
      clear(body);
      title.textContent = 'Checkout reference missing';
      body.append(el('div', { class: 'card state-error' },
        el('h2', null, 'We cannot verify this checkout'),
        el('p', null, 'The return URL does not include a checkout session reference. No plan activation is being claimed.'),
        el('a', { class: 'btn btn-secondary', href: '/account', 'data-account-required': true }, 'Check account status')));
      return root;
    }

    const statusUrl = `/api/billing/checkout/status?session_id=${encodeURIComponent(sessionId)}`;
    const maxPolls = 8;
    let polls = 0;
    let polling = false;
    let pollTimer = null;

    function pendingState(exhausted) {
      title.textContent = isMock ? 'Checkout rehearsal is still processing' : 'Payment confirmation is still processing';
      clear(body);
      const retry = exhausted
        ? el('button', { class: 'btn btn-secondary', type: 'button', onclick: () => checkStatus(true) }, 'Check status again')
        : null;
      body.append(el('section', { class: 'card billing-pending' },
        el('h2', null, 'Activation pending'),
        el('p', null, isMock
          ? 'The local checkout record has not completed yet. No paid service is active.'
          : 'The payment provider redirected back before PriceTruth received final confirmation. Your plan and any API key are not marked ready yet.'),
        exhausted ? el('p', { class: 'notice notice-info' },
          'Confirmation is taking longer than expected. You can check again without creating another charge, or review your account later.')
          : el('p', { class: 'section-meta' }, `Confirmation check ${polls} of ${maxPolls}. This page will retry automatically.`),
        el('div', { class: 'billing-actions' }, retry,
          el('a', { class: 'btn btn-ghost', href: '/account', 'data-account-required': true }, 'Open account'))));
    }

    function premiumComplete(status) {
      title.textContent = isMock ? 'Checkout rehearsal complete' : 'Premium is active';
      clear(body);
      body.append(el('section', { class: 'card billing-complete' },
        el('span', { class: 'confirmation-check', 'aria-hidden': 'true' }, '✓'),
        el('h2', null, isMock ? 'Simulated Premium status recorded' : 'Premium unlocked'),
        el('p', null, isMock
          ? 'This local rehearsal did not charge a card or purchase a paid service.'
          : 'Your verified account now includes up to 20 periodic alerts on eligible sources, email after verified catalog or source updates, and the optional weekly watchlist digest. Delivery follows each source schedule.'),
        el('p', { class: 'section-meta' }, `Confirmed plan: ${status.plan || 'premium'}`),
        el('div', { class: 'billing-actions' },
          el('a', { class: 'btn', href: '/find' }, 'Find a price to watch'),
          el('a', { class: 'btn btn-secondary', href: '/account', 'data-account-required': true }, 'Manage plan'))));
    }

    function alreadyClaimed(status) {
      title.textContent = isMock ? 'Checkout rehearsal complete' : 'API plan is active';
      clear(body);
      body.append(el('section', { class: 'card billing-complete' },
        el('span', { class: 'confirmation-check', 'aria-hidden': 'true' }, '✓'),
        el('h2', null, 'One-time key already revealed'),
        el('p', null, 'This checkout is complete, but its one-time API key has already been claimed. Existing secret values cannot be shown again.'),
        el('p', { class: 'section-meta' }, `Confirmed plan: ${status.plan || 'API'} · ${status.tier || 'API'} tier`),
        el('a', { class: 'btn btn-secondary', href: '/account', 'data-account-required': true }, 'Manage or create API keys')));
    }

    function checkoutError(message, retry) {
      clear(body);
      body.append(el('section', { class: 'card state-error' },
        el('h2', null, 'Checkout is not confirmed'),
        el('p', null, message),
        el('div', { class: 'billing-actions' },
          retry ? el('button', { class: 'btn btn-secondary', type: 'button', onclick: retry }, 'Try again') : null,
          el('a', { class: 'btn btn-ghost', href: '/account', 'data-account-required': true }, 'Check account status'))));
    }

    function terminalCheckoutState(data) {
      const terminal = data && data.checkoutStatus === 'expired' ? 'expired' : 'failed';
      title.textContent = terminal === 'expired' ? 'Checkout expired' : 'Payment did not complete';
      clear(body);
      body.append(el('section', { class: 'card state-error' },
        el('h2', null, terminal === 'expired' ? 'This checkout session expired' : 'This checkout failed'),
        el('p', null, 'No plan or API key was activated from this checkout. A terminal checkout will not become active by waiting or refreshing this page.'),
        data && data.plan ? el('p', { class: 'section-meta' }, `Requested plan: ${data.plan}`) : null,
        el('div', { class: 'billing-actions' },
          el('a', { class: 'btn', href: '/pricing' }, 'Start a new checkout'),
          el('a', { class: 'btn btn-ghost', href: '/account', 'data-account-required': true }, 'Check account status'))));
    }

    function schedulePoll() {
      clearTimeout(pollTimer);
      pollTimer = setTimeout(() => { checkStatus(); }, Math.min(4000, 750 + polls * 500));
    }

    async function claimApiKey(status) {
      clear(body);
      body.append(loadingBlock('Securing your one-time API key…'));
      try {
        let data;
        const options = {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: sessionId }),
        };
        if (isMock) {
          data = await fetchJSON('/api/billing/claim', options);
        } else {
          const session = await getSession(true);
          if (!session.authenticated) throw new AppError('auth', 'Sign in with the account used at checkout to reveal this key.', 401);
          data = await accountJSON('/api/billing/claim', options);
        }
        if (data && data.status === 'pending') {
          polls += 1;
          pendingState(polls >= maxPolls);
          if (polls < maxPolls) schedulePoll();
          return;
        }
        if (!data || !data.key) {
          checkoutError('The API plan is confirmed, but no one-time key was returned. No key has been displayed as claimed.', () => checkStatus(true));
          return;
        }
        title.textContent = isMock ? 'Checkout rehearsal complete' : 'API key ready';
        clear(body);
        body.append(apiKeyReveal(data));
      } catch (err) {
        if (err.status === 409) {
          alreadyClaimed(status);
        } else if (err.status === 401) {
          checkoutError('Sign in with the verified account used for this checkout, then check the status again.', () => { location.assign('/account?return=%2Fpricing'); });
        } else if (err.status === 404) {
          checkoutError('The checkout is marked as an API plan, but a claimable key is not available. This is not being treated as Premium or as a completed key handoff.', () => checkStatus(true));
        } else {
          checkoutError(err.message, () => claimApiKey(status));
        }
      }
    }

    async function checkStatus(reset) {
      if (polling) return;
      if (polls > 0 && !root.isConnected) return;
      if (reset) polls = 0;
      polling = true;
      if (polls === 0) {
        clear(body);
        body.append(loadingBlock('Waiting for confirmed billing status…'));
      }
      try {
        const status = await fetchJSON(statusUrl);
        if (status && status.status === 'pending' && status.complete !== true) {
          polls += 1;
          pendingState(polls >= maxPolls);
          if (polls < maxPolls) schedulePoll();
        } else if (status.plan === 'premium' && status.status === 'complete') {
          premiumComplete(status);
        } else if (/^api_(starter|pro)$/.test(status.plan || '')) {
          if (status.status === 'claimable' && status.claimable === true) await claimApiKey(status);
          else if (status.status === 'claimed') alreadyClaimed(status);
          else checkoutError('The API checkout completed in an unknown key state. No key or consumer entitlement is being assumed.', () => checkStatus(true));
        } else if (status && status.complete === true) {
          checkoutError('The checkout completed without a recognized plan. No entitlement is being assumed.', () => checkStatus(true));
        } else {
          checkoutError('PriceTruth could not reconcile this checkout to an active entitlement. No plan or API key is being marked ready.', () => checkStatus(true));
        }
      } catch (err) {
        if (err.status === 409 && err.data && err.data.code === 'CHECKOUT_TERMINAL') {
          terminalCheckoutState(err.data);
        } else {
          checkoutError(err.status === 401
            ? 'Sign in with the verified account used for checkout before checking activation.'
            : err.message, () => checkStatus(true));
        }
      } finally {
        polling = false;
      }
    }

    setTimeout(() => { checkStatus(); }, 0);
    return root;
  }

  function apiKeyReveal(data) {
    const card = el('div', { class: 'card' });
    const keyBox = el('code', { class: 'key-reveal' }, data.key);
    const copyBtn = el('button', { class: 'btn btn-secondary', type: 'button' }, 'Copy key');
    copyBtn.addEventListener('click', () => {
      if (navigator.clipboard) navigator.clipboard.writeText(data.key).then(
        () => { copyBtn.textContent = 'Copied ✓'; }, () => { copyBtn.textContent = 'Copy failed'; });
    });
    card.append(
      el('h2', null, `API key ready — ${(data.tier || (data.record && data.record.tier) || 'starter')} tier`),
      el('p', { class: 'form-success' }, 'Store this now. For your security it is shown only once and cannot be retrieved again.'),
      el('div', { class: 'key-row' }, keyBox, copyBtn),
      el('p', { style: 'font-size:0.9rem;color:var(--text-soft)' },
        'Use it as an ', el('code', { class: 'endpoint' }, 'X-API-Key'), ' header. See the ',
        el('a', { href: '/api-docs' }, 'API docs'), ' to get started.'));
    return card;
  }

  function accountView() {
    const accountParams = new URLSearchParams(location.search);
    // `next` is read only for compatibility with links emitted before the
    // return parameter was standardized. Both names pass the same allowlist.
    const requestedReturn = safeAuthReturn(accountParams.get('return') || accountParams.get('next'));
    if (requestedReturn) rememberAuthReturn(requestedReturn);
    const root = el('div', null);
    const accountHeading = el('h1', null, 'Dashboard');
    const accountIntro = el('p', { style: 'color:var(--text-soft);max-width:42rem' },
      'Save reports, control price alerts, manage developer keys, and keep ownership of your data. Sign-in links are single-use—there is no password to remember.');
    root.append(el('div', { class: 'view-head' },
      el('p', { class: 'eyebrow' }, 'Your PriceTruth'),
      accountHeading, accountIntro));

    const holder = el('div', null, loadingBlock('Opening your dashboard…'));
    root.append(holder);

    function showReadOnlyAccount() {
      accountHeading.textContent = 'Read-only deployment';
      accountIntro.textContent = 'This public/demo environment does not accept or retain account data.';
      clear(holder);
      holder.append(el('section', { class: 'card empty-state' },
        el('h2', null, 'Accounts are disabled here'),
        el('p', null, 'You can create one-time reports and local comparisons. Saving, tracking, alerts, notifications, API keys, billing, export, and account deletion are unavailable because no account data is stored.'),
        el('a', { class: 'btn', href: '/find' }, 'Check a price')));
    }

    function showSignedOut(notice) {
      clear(holder);
      const status = el('div', { 'aria-live': 'polite' });
      if (notice) status.append(el('p', { class: 'form-success' }, notice));
      const returnTo = pendingAuthReturn();
      if (returnTo) status.append(el('p', { class: 'notice notice-info' },
        returnTo === '/pricing'
          ? 'Sign in to continue to secure plan checkout. Your verified account email will be used.'
          : 'Sign in to return to this report and save it to your account.'));
      const emailInput = el('input', {
        type: 'email', id: 'signin-email', placeholder: 'you@example.com',
        autocomplete: 'email', required: true,
      });
      const submit = el('button', { class: 'btn', type: 'submit' }, 'Email me a sign-in link');
      const form = el('form', {
        class: 'auth-form',
        onsubmit: async (e) => {
          e.preventDefault();
          clear(status);
          const email = emailInput.value.trim();
          if (!email || !email.includes('@')) {
            status.append(el('p', { class: 'form-error' }, 'Enter a valid email address.'));
            return;
          }
          submit.disabled = true;
          try {
            const data = await fetchJSON('/api/auth/request', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ email }),
            });
            const delivery = data && data.delivery && data.delivery.status;
            if (delivery === 'disabled') {
              status.append(el('p', { class: 'notice notice-warn' },
                'Sign-in email is not available on this environment yet. No account information was changed.'));
              submit.disabled = false;
            } else {
              status.append(el('div', { class: 'auth-sent', role: 'status' },
                el('span', { class: 'auth-sent-icon', 'aria-hidden': 'true' }, '✓'),
                el('div', null, el('h2', null, 'Check your inbox'),
                  el('p', null, data.message || `We sent a single-use sign-in link to ${email}. It expires soon.`),
                  el('p', { class: 'disclosure' }, 'You can close this tab after opening the link.'))));
              submit.textContent = 'Link requested';
            }
          } catch (err) {
            status.append(el('p', { class: 'form-error' }, err.message));
            submit.disabled = false;
          }
        },
      },
        el('div', { class: 'field' }, el('label', { for: 'signin-email' }, 'Email address'), emailInput,
          el('span', { class: 'hint' }, 'Used only for your account, requested alerts, and essential service messages.')),
        submit);
      holder.append(el('div', { class: 'account-auth-grid' },
        el('section', { class: 'card auth-card', 'aria-labelledby': 'signin-heading' },
          el('h2', { id: 'signin-heading' }, 'Sign in securely'),
          el('p', null, 'We will send a short-lived, single-use link. Requesting one never reveals whether an email already has an account.'),
          form, status),
        el('aside', { class: 'card account-benefits' },
          el('h2', null, 'Your dashboard keeps you in control'),
          el('ul', null,
            el('li', null, 'Saved reports and watchlists'),
            el('li', null, 'Pause, edit, or remove any alert'),
            el('li', null, 'Notification and digest preferences'),
            el('li', null, 'API key rotation and revocation'),
            el('li', null, 'One-click data export and account deletion')))));
    }

    function dashboardSection(title, description, body, attrs) {
      return el('section', Object.assign({ class: 'card dashboard-section' }, attrs || {}),
        el('div', { class: 'dashboard-section-head' },
          el('div', null, el('h2', null, title), description ? el('p', null, description) : null)),
        body);
    }

    function renderWatchlist(target) {
      clear(target);
      target.append(loadingBlock('Loading saved reports…'));
      fetchJSON('/api/account/watchlist').then((data) => {
        clear(target);
        const items = data.items || [];
        if (!items.length) {
          target.append(el('div', { class: 'empty-inline' },
            el('p', null, 'No saved reports yet. Save one from any report toolbar.'),
            el('a', { class: 'btn btn-secondary', href: '/find' }, 'Check a price')));
          return;
        }
        const list = el('div', { class: 'dashboard-list' });
        for (const item of items) {
          const product = item.product || {};
          const report = item.report;
          const remove = el('button', { class: 'btn btn-ghost btn-compact', type: 'button' }, 'Remove from saved');
          const rowStatus = el('span', { class: 'action-status', 'aria-live': 'polite' });
          remove.addEventListener('click', async () => {
            remove.disabled = true;
            try {
              await accountJSON(`/api/account/watchlist/${encodeURIComponent(item.product_id)}`, { method: 'DELETE' });
              renderWatchlist(target);
            } catch (err) { rowStatus.textContent = err.message; remove.disabled = false; }
          });
          let deleteReport = null;
          let deleteConfirmation = null;
          if (product.deletable === true) {
            deleteReport = el('button', { class: 'btn btn-ghost btn-compact', type: 'button' }, 'Delete report & history');
            const cancelDelete = el('button', { class: 'btn btn-ghost btn-compact', type: 'button' }, 'Cancel');
            const confirmDelete = el('button', { class: 'btn btn-danger btn-compact', type: 'button' }, 'Delete report and history');
            deleteConfirmation = el('div', { class: 'row-delete-confirmation', hidden: true },
              el('p', null, el('b', null, 'Delete this private report permanently? '),
                'This removes its price history, saved bookmark, and any alerts. Removing from saved alone does not delete the report.'),
              el('div', { class: 'dashboard-row-actions' }, cancelDelete, confirmDelete));
            deleteReport.addEventListener('click', () => {
              deleteConfirmation.hidden = false;
              confirmDelete.focus();
            });
            cancelDelete.addEventListener('click', () => {
              deleteConfirmation.hidden = true;
              deleteReport.focus();
            });
            confirmDelete.addEventListener('click', async () => {
              confirmDelete.disabled = true;
              cancelDelete.disabled = true;
              clear(rowStatus);
              try {
                await accountJSON(`/api/account/products/${encodeURIComponent(item.product_id)}`, { method: 'DELETE' });
                renderWatchlist(target);
              } catch (err) {
                rowStatus.textContent = err.message;
                confirmDelete.disabled = false;
                cancelDelete.disabled = false;
              }
            });
          }
          list.append(el('article', { class: 'dashboard-row' },
            el('div', { class: 'dashboard-row-main' },
              el('div', { class: 'row-title-line' }, verticalBadge(product.vertical || 'report'),
                el('h3', null, product.name || item.product_id),
                product.alertEligible === true
                  ? el('span', { class: 'chip chip-live' }, 'periodic alerts eligible')
                  : product.refreshable === true
                    ? el('span', { class: 'chip chip-typical' }, 'history only')
                    : el('span', { class: 'chip chip-warn' }, 'saved snapshot')),
              report ? el('p', null, el('b', null, fmtUSD(report.truePrice.amount_cents)),
                ` ${unitLabel(report.truePrice.unit)} all-in · ${hiddenCostPercent(report)}% added cost`) : null,
              el('p', { class: 'disclosure' }, `Saved ${formatTimestamp(item.created_at)}`)),
            el('div', { class: 'dashboard-row-actions' },
              el('a', { class: 'btn btn-secondary btn-compact', href: `/p/${item.product_id}` }, 'Open'), remove, deleteReport),
            deleteConfirmation, rowStatus));
        }
        target.append(list);
      }).catch((err) => { clear(target); target.append(errorBlock(err, () => renderWatchlist(target))); });
    }

    function renderAlerts(target) {
      clear(target);
      target.append(loadingBlock('Loading alerts…'));
      fetchJSON('/api/account/alerts').then((data) => {
        clear(target);
        const alerts = data.alerts || [];
        if (!alerts.length) {
          target.append(el('div', { class: 'empty-inline' },
            el('p', null, 'No active alerts. Open a fresh, verified, alert-eligible report to create a scheduled price-update alert.'),
            el('a', { class: 'btn btn-secondary', href: '/find' }, 'Find an eligible report')));
          return;
        }
        const list = el('div', { class: 'dashboard-list' });
        for (const alert of alerts) {
          const product = alert.product || {
            name: alert.product_name,
            vertical: alert.vertical,
            url: alert.url,
          };
          const inputId = `account-alert-${alert.id}`;
          const price = el('input', { type: 'text', inputmode: 'decimal', id: inputId, value: fmtUSD(alert.threshold_cents).slice(1) });
          const statusOptions = { active: 'Active', paused: 'Paused' };
          if (alert.status && !Object.prototype.hasOwnProperty.call(statusOptions, alert.status)) {
            statusOptions[alert.status] = alert.status === 'pending' ? 'Pending confirmation' : alert.status;
          }
          const statusSelect = selectInput(statusOptions, alert.status || 'active');
          statusSelect.setAttribute('aria-label', `Status for ${product.name || alert.product_id}`);
          const save = el('button', { class: 'btn btn-secondary btn-compact', type: 'button' }, 'Save');
          const remove = el('button', { class: 'btn btn-ghost btn-compact', type: 'button' }, 'Delete');
          const rowStatus = el('span', { class: 'action-status', 'aria-live': 'polite' });
          save.addEventListener('click', async () => {
            const cents = parseDollarsToCents(price.value);
            if (cents === null || cents <= 0) { rowStatus.textContent = 'Enter a valid target price.'; return; }
            save.disabled = true;
            try {
              await accountJSON(`/api/account/alerts/${encodeURIComponent(alert.id)}`, {
                method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ threshold_cents: cents, status: statusSelect.value }),
              });
              rowStatus.textContent = 'Alert updated.';
            } catch (err) { rowStatus.textContent = err.message; }
            save.disabled = false;
          });
          remove.addEventListener('click', async () => {
            if (!window.confirm('Delete this price alert?')) return;
            remove.disabled = true;
            try {
              await accountJSON(`/api/account/alerts/${encodeURIComponent(alert.id)}`, { method: 'DELETE' });
              renderAlerts(target);
            } catch (err) { rowStatus.textContent = err.message; remove.disabled = false; }
          });
          list.append(el('article', { class: 'dashboard-row alert-row' },
            el('div', { class: 'dashboard-row-main' },
              el('h3', null, product.name || alert.product_id),
              el('div', { class: 'alert-controls' },
                el('div', { class: 'field' }, el('label', { for: inputId }, 'Alert below ($)'), price),
                el('div', { class: 'field' }, el('label', null, 'Delivery'), statusSelect))),
            el('div', { class: 'dashboard-row-actions' }, save, remove), rowStatus));
        }
        target.append(el('p', { class: 'section-meta' },
          `${alerts.length} of ${data.limit || '—'} alerts used · ${data.plan || 'free'} plan · evaluated after scheduled verified updates`), list);
      }).catch((err) => { clear(target); target.append(errorBlock(err, () => renderAlerts(target))); });
    }

    function preferencesForm(preferences, subscription) {
      const emailAlerts = checkRow('pref-alerts', 'Send requested verified price-update alerts', preferences.email_alerts !== false);
      const weekly = checkRow('pref-weekly', 'Send a weekly watchlist digest', preferences.weekly_digest === true);
      const timezone = el('input', { type: 'text', id: 'pref-timezone', value: preferences.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', list: 'timezone-options' });
      const status = el('div', { 'aria-live': 'polite' });
      const submit = el('button', { class: 'btn btn-secondary', type: 'submit' }, 'Save preferences');
      const deliveryState = subscription && subscription.status ? subscription.status : 'not confirmed';
      return el('form', {
        class: 'preferences-form',
        onsubmit: async (e) => {
          e.preventDefault(); clear(status); submit.disabled = true;
          try {
            await accountJSON('/api/account/preferences', {
              method: 'PATCH', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                email_alerts: emailAlerts.input.checked,
                weekly_digest: weekly.input.checked,
                timezone: timezone.value.trim() || 'UTC',
              }),
            });
            status.append(el('p', { class: 'form-success' }, 'Preferences saved.'));
          } catch (err) { status.append(el('p', { class: 'form-error' }, err.message)); }
          submit.disabled = false;
        },
      }, el('p', { class: 'section-meta' },
        'Email delivery: ', el('span', { class: deliveryState === 'active' ? 'chip chip-live' : 'chip chip-typical' }, deliveryState)),
      emailAlerts.node, weekly.node,
      el('div', { class: 'field' }, el('label', { for: 'pref-timezone' }, 'Time zone'), timezone,
        el('datalist', { id: 'timezone-options' },
          ['UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Europe/London'].map((v) => el('option', { value: v }))),
        el('span', { class: 'hint' }, 'Used to schedule digests; enter an IANA time zone.')),
      submit, status);
    }

    function renderApiKeys(target, oneTimeKey) {
      clear(target);
      target.append(loadingBlock('Loading developer keys…'));
      fetchJSON('/api/account/api-keys').then((data) => {
        clear(target);
        const reveal = el('div', { 'aria-live': 'polite' });
        if (oneTimeKey && oneTimeKey.key) reveal.append(apiKeyReveal(oneTimeKey));
        const list = el('div', { class: 'dashboard-list key-list' });
        const keys = (data.keys || []).filter((key) => !key.revoked_at);
        if (!keys.length) list.append(el('p', { class: 'empty-inline' }, 'No active API keys.'));
        for (const key of keys) {
          const rotate = el('button', { class: 'btn btn-secondary btn-compact', type: 'button' }, 'Rotate');
          const revoke = el('button', { class: 'btn btn-ghost btn-compact', type: 'button' }, 'Revoke');
          const rowStatus = el('span', { class: 'action-status', 'aria-live': 'polite' });
          rotate.addEventListener('click', async () => {
            if (!window.confirm('Rotate this key? The current key will stop working immediately.')) return;
            rotate.disabled = true;
            try {
              const result = await accountJSON(`/api/account/api-keys/${encodeURIComponent(key.id)}/rotate`, { method: 'POST' });
              renderApiKeys(target, result);
            } catch (err) { rowStatus.textContent = err.message; rotate.disabled = false; }
          });
          revoke.addEventListener('click', async () => {
            if (!window.confirm('Revoke this API key? This cannot be undone.')) return;
            revoke.disabled = true;
            try {
              await accountJSON(`/api/account/api-keys/${encodeURIComponent(key.id)}`, { method: 'DELETE' });
              renderApiKeys(target);
            } catch (err) { rowStatus.textContent = err.message; revoke.disabled = false; }
          });
          list.append(el('article', { class: 'dashboard-row' },
            el('div', { class: 'dashboard-row-main' },
              el('h3', null, key.label || 'API key'),
              el('p', null, el('code', { class: 'endpoint' }, `${key.prefix || 'pt_'}…`), ` · ${key.tier || 'starter'}`),
              el('p', { class: 'disclosure' }, `Created ${formatTimestamp(key.created_at)} · Last used ${formatTimestamp(key.last_used_at)}`)),
            el('div', { class: 'dashboard-row-actions' }, rotate, revoke), rowStatus));
        }
        const label = el('input', { type: 'text', id: 'new-key-label', maxlength: '80', placeholder: 'e.g. staging integration' });
        const createStatus = el('div', { 'aria-live': 'polite' });
        const create = el('button', { class: 'btn btn-secondary', type: 'submit' }, 'Create API key');
        const form = el('form', {
          class: 'inline-create-form', onsubmit: async (e) => {
            e.preventDefault(); clear(createStatus);
            if (label.value.trim().length < 2) { createStatus.append(el('p', { class: 'form-error' }, 'Give the key a descriptive label.')); return; }
            create.disabled = true;
            try {
              const result = await accountJSON('/api/account/api-keys', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ label: label.value.trim(), tier: 'starter' }),
              });
              label.value = ''; renderApiKeys(target, result);
            } catch (err) { createStatus.append(el('p', { class: 'form-error' }, err.message)); create.disabled = false; }
          },
        }, el('div', { class: 'field' }, el('label', { for: 'new-key-label' }, 'New key label'), label), create, createStatus);
        target.append(reveal, list, el('details', { class: 'fold' },
          el('summary', null, 'Create a developer key'),
          el('div', { class: 'fold-body' }, form,
            el('p', { class: 'disclosure' }, 'The secret is shown once. Store it in a secrets manager; never put it in browser code.'))));
      }).catch((err) => { clear(target); target.append(errorBlock(err, () => renderApiKeys(target))); });
    }

    function dataControls(session) {
      const status = el('div', { 'aria-live': 'polite' });
      const exportBtn = el('button', { class: 'btn btn-secondary', type: 'button' }, 'Download my data');
      exportBtn.addEventListener('click', async () => {
        exportBtn.disabled = true; clear(status);
        try {
          const data = await accountJSON('/api/account/export', { method: 'POST' });
          const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = el('a', { href: url, download: `pricetruth-export-${new Date().toISOString().slice(0, 10)}.json` });
          document.body.append(a); a.click(); a.remove(); URL.revokeObjectURL(url);
          status.textContent = 'Your export was downloaded.';
        } catch (err) { status.textContent = err.message; }
        exportBtn.disabled = false;
      });
      const billingBtn = el('button', { class: 'btn btn-secondary', type: 'button' }, 'Manage billing');
      billingBtn.addEventListener('click', async () => {
        billingBtn.disabled = true; clear(status);
        try {
          const data = await accountJSON('/api/billing/portal', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          });
          if (data.url) window.location.assign(data.url);
          else throw new AppError('billing', 'Billing portal is not available.');
        } catch (err) { status.textContent = err.message; billingBtn.disabled = false; }
      });
      const confirmInput = el('input', { type: 'text', id: 'delete-confirm', autocomplete: 'off', placeholder: 'Type DELETE' });
      const deleteBtn = el('button', { class: 'btn btn-danger', type: 'button' }, 'Delete account permanently');
      deleteBtn.addEventListener('click', async () => {
        if (confirmInput.value !== 'DELETE') { status.textContent = 'Type DELETE exactly to confirm.'; return; }
        if (!window.confirm('Permanently delete this account, its watches, alerts, and keys?')) return;
        deleteBtn.disabled = true;
        try {
          await accountJSON('/api/account', {
            method: 'DELETE', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ confirm: 'DELETE' }),
          });
          clearSession(); showSignedOut('Your account and account-owned data were deleted.');
        } catch (err) {
          clear(status);
          if (err.status === 409 && err.data
            && (err.data.requiresBillingCancellation || err.data.code === 'ACTIVE_SUBSCRIPTION')) {
            status.append(el('p', { class: 'notice notice-warn' },
              'This account still has an active paid subscription. Open Manage billing, cancel the subscription, wait for the plan status to update, then retry account deletion.'));
          } else {
            status.append(el('p', { class: 'form-error' }, err.message));
          }
          deleteBtn.disabled = false;
        }
      });
      return el('div', null,
        el('div', { class: 'data-actions' }, exportBtn, session.account.plan !== 'free' ? billingBtn : null),
        status,
        el('details', { class: 'fold danger-zone' }, el('summary', null, 'Delete account and data'),
          el('div', { class: 'fold-body' },
            el('p', null, 'This permanently removes account-owned watches, alerts, sessions, preferences, and API keys. Download an export first if you need a copy.'),
            el('div', { class: 'field' }, el('label', { for: 'delete-confirm' }, 'Confirmation'), confirmInput), deleteBtn)));
    }

    async function showDashboard(session) {
      clear(holder);
      holder.append(loadingBlock('Loading account details…'));
      try {
        const [data, meta] = await Promise.all([
          fetchJSON('/api/account'),
          getMeta().catch(() => null),
        ]);
        clear(holder);
        const account = data.account || session.account;
        session.account = account;
        sessionCache = session;
        updateAccountNav(session);
        const returnTo = pendingAuthReturn();
        const logout = el('button', { class: 'btn btn-ghost', type: 'button' }, 'Sign out');
        logout.addEventListener('click', async () => {
          logout.disabled = true;
          try { await accountJSON('/api/session', { method: 'DELETE' }); }
          catch (err) { /* clear the local UI even if the session already expired */ }
          clearSession(); showSignedOut('You are signed out.');
        });
        holder.append(el('section', { class: 'account-summary' },
          el('div', null,
            el('p', { class: 'eyebrow' }, 'Signed in'),
            el('h2', null, account.email),
            el('p', null, el('span', { class: 'chip chip-live' }, `${account.plan || 'free'} plan`),
              account.emailVerified ? el('span', { class: 'verified-label' }, '✓ Verified email') : null)),
          logout));
        holder.append(legalIdentity(meta, {
          class: 'deployment-identity account-identity',
          localText: 'This deployment has no commercial operator or paid-service support channel. Free account controls remain available.',
        }));
        if (returnTo) {
          clearAuthReturn();
          holder.append(el('div', { class: 'notice notice-info' },
            el('b', null, 'Secure sign-in complete. '),
            el('a', { href: returnTo }, returnTo === '/pricing' ? 'Continue to pricing' : 'Return to your report'),
            returnTo === '/pricing' ? ' to choose a plan.' : ' to finish your report action.'));
        }
        const watchBody = el('div');
        const alertBody = el('div');
        const keyBody = el('div');
        holder.append(el('div', { class: 'dashboard-grid' },
          dashboardSection('Saved reports', 'Your watchlist of all-in reports.', watchBody, { class: 'card dashboard-section dashboard-wide' }),
          dashboardSection('Price alerts', 'Targets, delivery state, and limits.', alertBody, { class: 'card dashboard-section dashboard-wide' }),
          dashboardSection('Notifications', 'Choose which essential price messages arrive.', preferencesForm(data.preferences || {}, data.notificationSubscription)),
          dashboardSection('Developer keys', 'Create, rotate, and revoke secrets without exposing existing values.', keyBody),
          dashboardSection('Billing & your data', 'Plan controls, portable export, and permanent deletion.', dataControls(session))));
        renderWatchlist(watchBody);
        renderAlerts(alertBody);
        renderApiKeys(keyBody);
      } catch (err) {
        clear(holder);
        if (err.status === 401) { clearSession(); showSignedOut('Your sign-in expired. Request a new secure link.'); }
        else holder.append(errorBlock(err, () => showDashboard(session)));
      }
    }

    getSession(true).then((session) => {
      if (session.accountsDisabled) showReadOnlyAccount();
      else if (session.authenticated) showDashboard(session);
      else showSignedOut(new URLSearchParams(location.search).get('verified') === '1'
        ? 'That sign-in link is no longer active. Request a fresh link below.' : null);
    }).catch((err) => {
      clear(holder);
      holder.append(errorBlock(err, () => getSession(true).then((session) => session.authenticated ? showDashboard(session) : showSignedOut())));
    });
    return root;
  }

  /* ================= email-link confirmations ================= */

  const TOKEN_ACTIONS = {
    auth: {
      eyebrow: 'Secure sign-in',
      heading: 'Confirm sign-in',
      explanation: 'Opening this page does not consume your single-use link. Confirm below to sign in on this device.',
      button: 'Confirm and sign in',
      endpoint: '/api/auth/verify',
      successHeading: 'You are signed in',
      success: 'Your email is verified and this device now has a secure session.',
      actionHref: '/account',
      actionLabel: 'Open dashboard',
    },
    emailVerify: {
      eyebrow: 'Price alerts',
      heading: 'Confirm email delivery',
      explanation: 'Confirm that you asked PriceTruth to send requested price alerts and watchlist digests to this address.',
      button: 'Confirm email delivery',
      endpoint: '/api/notifications/email/verify',
      successHeading: 'Email delivery confirmed',
      success: 'Requested price alerts and enabled watchlist digests can now be delivered.',
      actionHref: '/account',
      actionLabel: 'Manage notifications',
    },
    emailUnsubscribe: {
      eyebrow: 'Email preferences',
      heading: 'Stop PriceTruth email',
      explanation: 'Confirm to stop the PriceTruth email channel associated with this secure link.',
      button: 'Unsubscribe this email',
      endpoint: '/api/notifications/email/unsubscribe',
      successHeading: 'Email unsubscribed',
      success: 'PriceTruth will no longer send alerts or digests through this email subscription.',
      actionHref: '/',
      actionLabel: 'Return to PriceTruth',
    },
    alertUnsubscribe: {
      eyebrow: 'Price alert',
      heading: 'Stop this price alert',
      explanation: 'Confirm to stop only the price alert associated with this secure link.',
      button: 'Unsubscribe this alert',
      endpoint: '/api/alerts/unsubscribe',
      successHeading: 'Price alert stopped',
      success: 'This alert will not send another price-drop email.',
      actionHref: '/',
      actionLabel: 'Return to PriceTruth',
    },
  };

  function tokenActionView(kind) {
    const config = TOKEN_ACTIONS[kind];
    let token = new URLSearchParams(location.hash.slice(1)).get('token');
    // Fragments never reach the server. Remove the bearer from visible browser
    // history before rendering, while retaining it only in this page closure.
    if (location.hash) history.replaceState({}, '', `${location.pathname}${location.search}`);
    const root = el('div', { class: 'confirmation-view' },
      el('div', { class: 'view-head' },
        el('p', { class: 'eyebrow' }, config.eyebrow),
        el('h1', null, config.heading),
        el('p', { style: 'color:var(--text-soft);max-width:40rem' }, config.explanation)));
    const body = el('div');
    root.append(body);

    if (!token) {
      body.append(el('div', { class: 'card state-error' },
        el('h2', null, 'Secure link missing'),
        el('p', null, 'This page needs the complete link from your PriceTruth email. The link may also have expired or already been used.'),
        el('a', { class: 'btn btn-secondary', href: kind === 'auth' ? '/account' : '/' },
          kind === 'auth' ? 'Request a new sign-in link' : 'Return to PriceTruth')));
      return root;
    }

    const status = el('div', { 'aria-live': 'polite' });
    const submit = el('button', { class: 'btn', type: 'submit' }, config.button);
    const form = el('form', {
      class: 'card confirmation-card',
      onsubmit: async (event) => {
        event.preventDefault();
        clear(status);
        submit.disabled = true;
        submit.textContent = 'Confirming…';
        try {
          const data = await fetchJSON(config.endpoint, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token }),
          });
          token = null;
          if (kind === 'auth' && data && data.authenticated) {
            const earlierSessionRequest = sessionPending;
            sessionCache = data;
            updateAccountNav(data);
            // A page-load session probe may have left before the confirmation
            // cookie existed. Do not let that older signed-out response win.
            if (earlierSessionRequest) earlierSessionRequest.then(() => {
              sessionCache = data;
              updateAccountNav(data);
            }, () => {
              sessionCache = data;
              updateAccountNav(data);
            });
          }
          clear(body);
          const returnTo = kind === 'auth' ? pendingAuthReturn() : null;
          const actionHref = returnTo || config.actionHref;
          const actionLabel = returnTo
            ? (returnTo === '/pricing' ? 'Continue to pricing' : 'Return to your report')
            : config.actionLabel;
          body.append(el('section', { class: 'card confirmation-card', role: 'status' },
            el('span', { class: 'confirmation-check', 'aria-hidden': 'true' }, '✓'),
            el('h2', null, config.successHeading),
            el('p', null, config.success),
            el('a', {
              class: 'btn', href: actionHref,
              onclick: returnTo ? clearAuthReturn : null,
            }, actionLabel)));
        } catch (err) {
          status.append(el('p', { class: 'form-error' }, err.message));
          submit.disabled = false;
          submit.textContent = config.button;
        }
      },
    },
      el('p', null, 'This action changes your account or delivery state only after you press the button.'),
      submit,
      status);
    body.append(form);
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
    { pattern: /^\/$/, title: 'PriceTruth — understand the price before checkout', view: () => homeView() },
    { pattern: /^\/find$/, title: 'Check a price before checkout — PriceTruth', view: () => findView() },
    { pattern: /^\/compare$/, title: 'Compare price evidence — PriceTruth', view: () => comparisonView() },
    { pattern: /^\/p\/([a-z0-9-]{1,64})$/, title: 'Product — PriceTruth', view: (m) => productView(m[1]) },
    { pattern: /^\/analyze$/, title: 'Analyzer — PriceTruth', view: () => analyzeView() },
    { pattern: /^\/pricing$/, title: 'Pricing — PriceTruth', view: () => pricingView() },
    { pattern: /^\/api-docs$/, title: 'B2B API — PriceTruth', view: () => apiDocsView() },
    { pattern: /^\/extension$/, title: 'Browser extension — PriceTruth', view: () => extensionView() },
    { pattern: /^\/account$/, title: 'Your account — PriceTruth', view: () => accountView() },
    { pattern: /^\/auth\/verify$/, title: 'Confirm sign-in — PriceTruth', view: () => tokenActionView('auth') },
    { pattern: /^\/email\/verify$/, title: 'Confirm email delivery — PriceTruth', view: () => tokenActionView('emailVerify') },
    { pattern: /^\/email\/unsubscribe$/, title: 'Unsubscribe email — PriceTruth', view: () => tokenActionView('emailUnsubscribe') },
    { pattern: /^\/alerts\/unsubscribe$/, title: 'Unsubscribe alert — PriceTruth', view: () => tokenActionView('alertUnsubscribe') },
    { pattern: /^\/billing\/success$/, title: 'Checkout status — PriceTruth', view: () => billingSuccessView() },
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

  function render(shouldFocus) {
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
    if (runtimeMeta) applyAccountCapability(runtimeMeta);
    if (runtimeMeta) applyCanonicalMeta(runtimeMeta);
    if (routeAnnouncer) routeAnnouncer.textContent = document.title;
    if (shouldFocus) app.focus({ preventScroll: true });
  }

  function navigate(href) {
    history.pushState({}, '', href);
    render(true);
    window.scrollTo(0, 0);
    closeMobileNav();
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

  window.addEventListener('popstate', () => render(true));

  function closeMobileNav() {
    const toggle = document.querySelector('.nav-toggle');
    const links = document.querySelector('.nav-links');
    if (!toggle || !links) return;
    toggle.setAttribute('aria-expanded', 'false');
    links.classList.remove('nav-open');
    const label = toggle.querySelector('.sr-only');
    if (label) label.textContent = 'Open navigation';
  }

  function initNavigation() {
    const toggle = document.querySelector('.nav-toggle');
    const links = document.querySelector('.nav-links');
    if (!toggle || !links) return;
    toggle.addEventListener('click', () => {
      const open = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', open ? 'false' : 'true');
      links.classList.toggle('nav-open', !open);
      const label = toggle.querySelector('.sr-only');
      if (label) label.textContent = open ? 'Open navigation' : 'Close navigation';
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') {
        closeMobileNav();
        toggle.focus();
      }
    });
  }

  /* ================= consent / privacy notice ================= */
  // PriceTruth sets no advertising or tracking cookies. This is a one-time,
  // honest notice (dismissal is remembered in localStorage, not a cookie).
  function initConsent() {
    let dismissed = false;
    try { dismissed = localStorage.getItem('pt-consent') === '1'; } catch (e) { /* storage blocked */ }
    if (dismissed) return;
    const bar = el('div', { class: 'consent-bar', role: 'region', 'aria-label': 'Privacy notice' },
      el('p', null,
        'PriceTruth uses no advertising or tracking cookies. We store only what runs the app. ',
        el('a', { href: '/legal.html' }, 'Privacy & terms'), '.'),
      el('button', { class: 'btn btn-secondary', type: 'button', onclick: () => {
        try { localStorage.setItem('pt-consent', '1'); } catch (e) { /* ignore */ }
        bar.remove();
      } }, 'Got it'));
    document.body.append(bar);
  }

  function initDeploymentIdentity() {
    const target = document.getElementById('deployment-identity');
    if (!target) return;
    getMeta().then((meta) => {
      const identity = legalIdentity(meta, {
        class: 'footer-line deployment-identity',
        localText: 'This deployment does not offer commercial enrollment or a paid-service support channel.',
      });
      identity.id = 'deployment-identity';
      target.replaceWith(identity);
    }).catch(() => { /* the neutral server-rendered disclosure remains */ });
  }

  const accountCapabilityObserver = new MutationObserver(() => {
    if (runtimeMeta && !accountsEnabled(runtimeMeta)) applyAccountCapability(runtimeMeta);
  });
  accountCapabilityObserver.observe(app, { childList: true, subtree: true });

  initNavigation();
  render(false);
  getSession().catch(() => {});
  initDeploymentIdentity();
  initConsent();
})();
