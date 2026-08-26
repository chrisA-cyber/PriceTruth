'use strict';

// Seller-specific page adapters and a conservative candidate-ranking engine.
// This module deliberately has no browser API dependency: fixtures exercise it
// under Node, while content.js consumes the same global in Chrome.
(function (global) {
  // On-page detection is deliberately stricter than the popup calculator:
  // ambiguous "$" prices may be CAD, AUD, NZD, SGD, HKD, and more. The
  // overlay stays silent unless the page explicitly labels the amount USD.
  var MONEY_RE = /(?:\bUSD\s*\$?|\bUS\s*\$)\s*(\d{1,3}(?:,\d{3})+|\d{1,7})(?:[.,](\d{2}))?(?!\d)/i;
  var MONEY_DETECT_RE = /(?:\bUSD\s*\$?|\bUS\s*\$)\s*\d/i;

  var ADAPTERS = [
    {
      id: 'booking', domains: ['booking.com'], site: 'Booking.com', vertical: 'hotel', profile: 'default',
      selectors: ['[data-testid="price-and-discounted-price"]', '[data-testid="price-for-x-nights"]', '[data-testid*="price"]'],
      exclude: ['[data-testid*="strike"]', '[class*="crossed"]'],
      pathHints: ['/hotel/', '/searchresults'],
    },
    {
      id: 'hotels', domains: ['hotels.com'], site: 'Hotels.com', vertical: 'hotel', profile: 'default',
      selectors: ['[data-stid="price-lockup-text"]', '[data-stid*="price"]', '[class*="uitk-text-emphasis-theme"]'],
      exclude: ['del', 's', '[aria-label*="original price" i]'],
    },
    {
      id: 'expedia', domains: ['expedia.com'], site: 'Expedia', vertical: 'hotel', profile: 'default',
      selectors: ['[data-stid="price-lockup-text"]', '[data-stid*="price"]', '[data-test-id*="price"]'],
      exclude: ['del', 's', '[aria-label*="original price" i]'],
      routes: [
        { pattern: /\/(flights?|flights?-search)(?:\/|$)/i, vertical: 'flight', profile: 'typical_legacy' },
        { pattern: /\/(hotels?|hotel-search)(?:\/|$)/i, vertical: 'hotel', profile: 'default' },
      ],
    },
    {
      id: 'ticketmaster', domains: ['ticketmaster.com'], site: 'Ticketmaster', vertical: 'ticket', profile: 'ticketmaster',
      selectors: ['[data-testid*="price"]', '[data-test*="price"]', '[class*="Price"]'],
      exclude: ['del', 's', '[aria-label*="fees" i]'],
    },
    {
      id: 'stubhub', domains: ['stubhub.com'], site: 'StubHub', vertical: 'ticket', profile: 'stubhub',
      selectors: ['[data-testid*="price"]', '[class*="price"]', '[class*="Price"]'],
      exclude: ['del', 's', '[class*="original"]'],
    },
    {
      id: 'seatgeek', domains: ['seatgeek.com'], site: 'SeatGeek', vertical: 'ticket', profile: 'seatgeek',
      selectors: ['[data-testid*="price"]', '[class*="Price"]', '[class*="price"]'],
      exclude: ['del', 's', '[class*="original"]'],
    },
    {
      id: 'spirit', domains: ['spirit.com'], site: 'Spirit Airlines', vertical: 'flight', profile: 'spirit',
      selectors: ['[data-testid*="fare"]', '[data-testid*="price"]', '[class*="fare"]'],
      exclude: ['del', 's', '[class*="bundle"]'],
    },
    {
      id: 'frontier', domains: ['flyfrontier.com'], site: 'Frontier Airlines', vertical: 'flight', profile: 'frontier',
      selectors: ['[data-testid*="fare"]', '[data-testid*="price"]', '[class*="fare"]'],
      exclude: ['del', 's', '[class*="bundle"]'],
    },
    {
      id: 'marriott', domains: ['marriott.com'], site: 'Marriott', vertical: 'hotel', profile: 'default',
      selectors: ['[data-testid*="price"]', '[data-component-name*="rate"]', '[class*="rate"]'],
      exclude: ['del', 's', '[class*="original"]'],
    },
    {
      id: 'hilton', domains: ['hilton.com'], site: 'Hilton', vertical: 'hotel', profile: 'default',
      selectors: ['[data-testid*="price"]', '[data-testid*="rate"]', '[class*="rate"]'],
      exclude: ['del', 's', '[class*="original"]'],
    },
    {
      id: 'demo', domains: ['example.com'], site: 'example.com', vertical: 'hotel', profile: 'default',
      selectors: ['[data-pricetruth-price]', '[class*="price"]'], exclude: ['del', 's'], demo: true,
    },
  ];

  function hostMatches(hostname, domain) {
    var host = String(hostname || '').toLowerCase().replace(/\.$/, '');
    var d = String(domain || '').toLowerCase();
    return host === d || host.slice(-(d.length + 1)) === '.' + d;
  }

  function hasUSOfferEvidence(vertical, pathname, pageText, locale) {
    var path = String(pathname || '/');
    var text = String(pageText || '').slice(0, 50000);
    var lang = String(locale || '').trim();
    if (/(?:^|[/?&_-])(?:country|market|locale|pos)?[=_-]?(?:us|usa|en[_-]us)(?:$|[/?&#_-])/i.test(path)) return true;
    if (/\b(?:United States|USA|U\.S\.)\b/i.test(text)) return true;
    if (/\b(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\s+\d{5}(?:-\d{4})?\b/.test(text)) return true;
    // For air travel, an en-US point of sale plus an explicit USD amount is
    // sufficient scope evidence for the U.S. full-fare framing. Lodging and
    // event tickets still require offer/location evidence above.
    return vertical === 'flight' && /^en[-_]US$/i.test(lang);
  }

  function cloneInfo(adapter) {
    return {
      adapterId: adapter.id,
      domains: adapter.domains.slice(),
      site: adapter.site,
      vertical: adapter.vertical,
      profile: adapter.profile,
      selectors: (adapter.selectors || []).slice(),
      exclude: (adapter.exclude || []).slice(),
      demo: Boolean(adapter.demo),
    };
  }

  function classify(hostname, pathname, pageText, demoHost) {
    var host = String(hostname || '').toLowerCase();
    var path = String(pathname || '/');
    var text = String(pageText || '').slice(0, 2000);
    var adapter = null;
    for (var i = 0; i < ADAPTERS.length; i++) {
      for (var j = 0; j < ADAPTERS[i].domains.length; j++) {
        if (hostMatches(host, ADAPTERS[i].domains[j])) { adapter = ADAPTERS[i]; break; }
      }
      if (adapter) break;
    }

    if (!adapter && demoHost && hostMatches(host, demoHost)) {
      adapter = {
        id: 'pricetruth-demo', domains: [demoHost], site: 'PriceTruth demo', vertical: 'hotel', profile: 'las_vegas',
        selectors: ['[data-pricetruth-price]', '.demo-price', '[class*="price"]'], exclude: ['del', 's'], demo: true,
      };
    }
    if (!adapter) return null;

    var info = cloneInfo(adapter);
    var routes = adapter.routes || [];
    for (var r = 0; r < routes.length; r++) {
      if (routes[r].pattern.test(path)) {
        info.vertical = routes[r].vertical;
        info.profile = routes[r].profile;
        break;
      }
    }
    // Expedia URLs can be opaque during SPA transitions. Only override from
    // text when the signal is explicit; silence is better than a false switch.
    if (adapter.id === 'expedia' && /\b(roundtrip|one-way|departing flight|returning flight)\b/i.test(text)) {
      info.vertical = 'flight';
      info.profile = 'typical_legacy';
    }
    return info;
  }

  function parsePriceText(text) {
    var match = MONEY_RE.exec(String(text || ''));
    if (!match) return null;
    var whole = match[1].replace(/,/g, '');
    var cents = Number(whole + (match[2] || '00'));
    if (!Number.isSafeInteger(cents) || cents < 100 || cents > 1000000000) return null;
    return cents;
  }

  // Candidate shape: {text,cents,fontSize,hint,selectorRank,struck,visible,
  //                    area,contextText}. Higher scores win. A minimum score
  // keeps generic scans quiet on pages with only fine-print dollar amounts.
  function scoreCandidate(candidate) {
    if (!candidate || candidate.visible === false || candidate.struck) return -Infinity;
    var cents = candidate.cents == null ? parsePriceText(candidate.text) : candidate.cents;
    if (!Number.isSafeInteger(cents) || cents < 100) return -Infinity;
    var font = Number(candidate.fontSize) || 0;
    if (font < 12) return -Infinity;
    var score = Math.min(font, 72);
    if (candidate.hint) score += 9;
    if (Number.isInteger(candidate.selectorRank)) score += Math.max(4, 22 - candidate.selectorRank * 4);
    if (/\b(total|from|night|fare|ticket|room|each|person)\b/i.test(candidate.contextText || '')) score += 4;
    if (/\b(save|discount|points|rewards|tax(?:es)?|fees?)\b/i.test(candidate.contextText || '')) score -= 5;
    var area = Number(candidate.area) || 0;
    if (area > 0 && area < 12) score -= 8;
    return score;
  }

  function chooseCandidate(candidates) {
    var best = null;
    var list = Array.isArray(candidates) ? candidates : [];
    for (var i = 0; i < list.length; i++) {
      var score = scoreCandidate(list[i]);
      if (score < 18) continue;
      if (!best || score > best.score) {
        best = {
          cents: list[i].cents == null ? parsePriceText(list[i].text) : list[i].cents,
          fontSize: Number(list[i].fontSize) || 0,
          hint: Boolean(list[i].hint),
          selectorRank: Number.isInteger(list[i].selectorRank) ? list[i].selectorRank : null,
          score: score,
        };
      }
    }
    return best;
  }

  function feedbackUrl(appUrl, info, detectedCents) {
    var base = String(appUrl || '').replace(/\/+$/, '');
    var params = [
      'source=extension',
      'adapter=' + encodeURIComponent(info && info.adapterId || 'unknown'),
      'vertical=' + encodeURIComponent(info && info.vertical || 'unknown'),
      'detected_cents=' + encodeURIComponent(String(detectedCents || '')),
    ];
    return base + '/extension-feedback?' + params.join('&');
  }

  var api = {
    ADAPTERS: ADAPTERS,
    MONEY_DETECT_RE: MONEY_DETECT_RE,
    hostMatches: hostMatches,
    hasUSOfferEvidence: hasUSOfferEvidence,
    classify: classify,
    parsePriceText: parsePriceText,
    scoreCandidate: scoreCandidate,
    chooseCandidate: chooseCandidate,
    feedbackUrl: feedbackUrl,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.PTAdapters = api;
})(typeof self !== 'undefined' ? self : this);
