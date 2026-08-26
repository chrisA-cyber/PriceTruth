import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => fs.readFileSync(path.join(ROOT, 'public', name), 'utf8');

describe('flagship consumer frontend', () => {
  const html = read('index.html');
  const js = read('app.js');
  const css = read('styles.css');
  const legal = read('legal.html');
  const legalJs = read('legal.js');

  it('ships syntactically valid browser code', () => {
    assert.doesNotThrow(() => new vm.Script(js, { filename: 'public/app.js' }));
    assert.doesNotThrow(() => new vm.Script(legalJs, { filename: 'public/legal.js' }));
  });

  it('uses one primary price-check entry and compact accessible navigation', () => {
    assert.match(html, />Check a price</);
    assert.match(html, /class="nav-toggle"[^>]+aria-expanded="false"[^>]+aria-controls="primary-navigation"/);
    assert.match(html, /id="route-announcer"[^>]+aria-live="polite"/);
    assert.doesNotMatch(html, />Analyzer</);
    assert.match(js, /Searches use only connected or dated sources/);
    assert.match(js, /function inferVertical\(/);
    assert.match(js, /meta\.subscriptionCatalog/);
    assert.doesNotMatch(js, /nordvpn|wall street journal/i);
  });

  it('keeps evidence, freshness, uncertainty, and degraded states explicit', () => {
    for (const phrase of ['Evidence ledger', 'Seller-listed', 'Market-typical', 'Modeled', 'Source:', 'Checked', 'Price as of', 'Dataset snapshot may be stale']) {
      assert.ok(js.includes(phrase), `missing trust language: ${phrase}`);
    }
    assert.match(js, /Source temporarily unavailable/);
    assert.match(js, /Final checkout is authoritative/);
    assert.match(js, /provenance\.asOf \|\| fetchedAt/);
    assert.match(js, /demoData === true && !catalogSnapshot/);
    assert.doesNotMatch(js, /no live key/i);
  });

  it('never turns insufficient history into a deal label', () => {
    assert.match(js, /Not enough history yet/);
    assert.match(js, /const hasScore = Boolean\(score && Number\.isFinite\(score\.score\)\)/);
    assert.match(js, /hasScore \? score\.label : 'Not enough history yet'/);
  });

  it('treats anonymous search as a one-time private report', () => {
    assert.match(js, /data\.persisted === true/);
    assert.match(js, /This is a one-time report/);
    assert.match(js, /did not store this check, start history, or create an alert/);
    assert.match(js, /productId: persisted \? product_id : null, refreshable/);
    assert.match(js, /if \(trackable\) \{[^]*alertForm\(product_id/);
  });

  it('requires an explicit stable provider identity before promising tracking', () => {
    assert.match(js, /payload\.refreshable === true/);
    assert.match(js, /const trackable = persisted && refreshable/);
    assert.match(js, /No stable seller identity/);
    assert.match(js, /Treat this as a one-time result/);
    assert.match(js, /Save snapshot/);
  });

  it('requires explicit alert eligibility and describes scheduled verified cadence', () => {
    assert.match(js, /payload\.alertEligible === true/);
    assert.match(js, /isRefreshableResult\(payload\)/);
    assert.match(js, /Alerts are unavailable for this result/);
    assert.match(js, /Delivery follows that source schedule/);
    assert.match(js, /periodically checks the verified subscription catalog/);
  });

  it('requires explicit manual evidence instead of silently treating blank fields as included', () => {
    const manualDefaults = js.slice(js.indexOf('function manualContext'), js.indexOf('function findView'));
    assert.doesNotMatch(manualDefaults, /mandatoryFeesIncluded|taxesIncluded|allInclusivePricing/);
    assert.match(js, /if \(mandatoryIncluded\.input\.checked\) ctx\.mandatoryFeesIncluded = true/);
    assert.match(js, /if \(allIn\.input\.checked\) ctx\.allInclusivePricing = true/);
    assert.match(js, /Seller explicitly says all mandatory hotel fees are included/);
    assert.match(js, /Seller explicitly says mandatory taxes and carrier charges are included/);
    assert.match(js, /Seller explicitly says all mandatory ticket fees are included/);
    assert.match(js, /Seller explicitly says government taxes are included/);
    assert.doesNotMatch(js, /Blank = market-typical estimate/);
    assert.doesNotMatch(js, /Blank = platform-typical estimate/);
  });

  it('does not auto-select optional flight extras', () => {
    assert.match(js, /carrier: 'typical_legacy',[\s\S]*carryOn: false, seatSelection: false, checkedBags: 0/);
    assert.match(js, /checkRow\('f-carryon', 'Bringing a carry-on bag', false\)/);
    assert.match(js, /checkRow\('f-seat', 'Picking a seat', false\)/);
    assert.match(js, /ctx\.carryOn === true \|\| Number\.isInteger\(ctx\.carryOn_cents\)/);
    assert.match(js, /ctx\.seatSelection === true \|\| Number\.isInteger\(ctx\.seat_cents\)/);
  });

  it('includes useful report actions and same-category comparison', () => {
    for (const phrase of ['Save', 'Compare', 'Copy summary', 'Share', 'Print', 'Edit assumptions']) {
      assert.ok(js.includes(phrase), `missing report action: ${phrase}`);
    }
    assert.match(js, /Compare like with like/);
    assert.match(js, /localStorage\.setItem\(COMPARE_KEY/);
    assert.match(js, /pattern: \/\^\\\/compare\$\//);
  });

  it('implements verified account ownership and CSRF-protected controls', () => {
    for (const route of [
      '/api/auth/request', '/api/session', '/api/account', '/api/account/preferences',
      '/api/account/watchlist', '/api/account/products/', '/api/account/alerts', '/api/account/api-keys', '/api/account/export',
    ]) assert.ok(js.includes(route), `missing account route ${route}`);
    assert.match(js, /X-CSRF-Token/);
    assert.match(js, /Delete account permanently/);
    assert.match(js, /Download my data/);
    assert.match(js, /Rotate this key/);
    assert.match(js, /Remove from saved/);
    assert.match(js, /Delete report & history/);
    assert.match(js, /Removing from saved alone does not delete the report/);
  });

  it('uses one allowlisted same-origin post-auth return contract', () => {
    assert.doesNotMatch(js, /account\?next=/);
    assert.match(js, /\?return=\$\{encodeURIComponent\(returnTo\)\}/);
    assert.match(js, /value\.startsWith\('\/\/'\)/);
    assert.match(js, /parsed\.origin !== location\.origin \|\| parsed\.search \|\| parsed\.hash/);
    assert.match(js, /accountParams\.get\('return'\) \|\| accountParams\.get\('next'\)/);
  });

  it('honors deployments that disable account and PII capabilities', () => {
    assert.match(js, /meta\.capabilities\.accounts === false/);
    assert.match(js, /data-account-required/);
    assert.match(js, /Accounts and personal data storage are disabled/);
    assert.match(js, /Accounts are disabled here/);
    assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  });

  it('binds live checkout, post-payment status, and one-time claims to the account contract', () => {
    assert.match(js, /accountJSON\('\/api\/billing\/checkout'/);
    assert.match(js, /acceptTerms: true, acceptedTermsVersion: termsVersion/);
    assert.match(js, /type: 'checkbox', required: true/);
    assert.match(js, /legal\.termsVersion\.trim\(\)/);
    assert.match(js, /legal\.html#terms/);
    assert.doesNotMatch(js, /checkout-email-/);
    assert.match(js, /\/api\/billing\/checkout\/status\?session_id=/);
    assert.match(js, /accountJSON\('\/api\/billing\/claim'/);
    assert.match(js, /status\.status === 'claimable'/);
    assert.match(js, /err\.status === 409/);
    assert.match(js, /CHECKOUT_TERMINAL/);
    assert.match(js, /Start a new checkout/);
    assert.match(js, /active paid subscription/);
  });

  it('uses explicit fragment-to-POST confirmation for bearer email links', () => {
    for (const route of ['/auth/verify', '/email/verify', '/email/unsubscribe', '/alerts/unsubscribe']) {
      assert.ok(js.includes(route), `missing confirmation route ${route}`);
    }
    assert.match(js, /new URLSearchParams\(location\.hash\.slice\(1\)\)/);
    assert.match(js, /method: 'POST'/);
    assert.match(js, /only after you press the button/i);
  });

  it('renders approved operator metadata and stays neutral without it', () => {
    for (const field of ['operatorName', 'jurisdiction', 'supportContact', 'effectiveDate', 'termsVersion', 'approved']) {
      assert.ok(js.includes(field), `missing legal metadata field ${field}`);
      assert.ok(legalJs.includes(field), `legal page missing metadata field ${field}`);
    }
    assert.match(legal, /Commercial enrollment is not active on this deployment/);
    assert.doesNotMatch(legal, /maintainer repository/i);
    assert.doesNotMatch(legal, /public issue[^.]*support/i);
  });

  it('derives canonical metadata from validated runtime origin instead of a host placeholder', () => {
    assert.doesNotMatch(`${html}\n${legal}\n${js}\n${legalJs}`, /pricetruth\.onrender\.com/);
    assert.doesNotMatch(html, /rel="canonical"/);
    assert.match(js, /meta && meta\.publicBaseUrl/);
    assert.match(js, /candidate\.origin === location\.origin/);
    assert.match(js, /INDEXABLE_PATHS/);
    assert.match(legalJs, /base\.origin !== location\.origin/);
  });

  it('provides mobile touch targets and responsive non-scrolling report rows', () => {
    assert.match(css, /min-height:\s*44px/);
    assert.match(css, /@media \(max-width: 640px\)/);
    assert.match(css, /content:\s*attr\(data-label\)/);
    assert.match(js, /'data-label': 'Evidence'/);
  });

  it('does not publish prototype copy or unresolved legal placeholders', () => {
    const launchCopy = `${html}\n${legal}`;
    assert.doesNotMatch(launchCopy, /\bprototype\b/i);
    assert.doesNotMatch(launchCopy, /\[(?:COMPANY ENTITY|CONTACT EMAIL|GOVERNING LAW JURISDICTION|VENUE)\]/);
    assert.match(legal, /HTTP-only <code>pt_session<\/code> cookie/);
    assert.match(legal, /export or delete account-owned data/);
    assert.match(legal, /commercial deployment must publish its real legal operator/i);
    assert.match(legal, /must not accept payment/i);
  });
});
