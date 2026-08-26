import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(import.meta.dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'extension', 'adapters.js'), 'utf8');
const context = { self: {}, encodeURIComponent };
vm.runInNewContext(source, context, { filename: 'extension/adapters.js' });
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'extension', 'feemodel.js'), 'utf8'), context, {
  filename: 'extension/feemodel.js',
});
const adapters = context.self.PTAdapters;
const feeModel = context.self.PTFeeModel;
const fixtures = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'extension-adapters.json'), 'utf8'));

describe('extension seller adapters', () => {
  it('classifies exact and subdomain hosts without suffix-spoofing', () => {
    for (const fixture of fixtures.classifications) {
      const actual = adapters.classify(fixture.host, fixture.path, '', 'localhost');
      if (fixture.vertical === null) {
        assert.equal(actual, null, fixture.host);
      } else {
        assert.equal(actual.vertical, fixture.vertical, fixture.host + fixture.path);
        assert.equal(actual.profile, fixture.profile, fixture.host + fixture.path);
        assert.equal(actual.adapterId, fixture.adapter, fixture.host + fixture.path);
      }
    }
  });

  it('uses explicit page signals for multi-vertical Expedia routes', () => {
    const actual = adapters.classify('expedia.com', '/opaque/spa', 'Choose a departing flight and returning flight');
    assert.equal(actual.vertical, 'flight');
    assert.equal(actual.profile, 'typical_legacy');
  });

  it('parses supported USD price strings with integer-cents arithmetic', () => {
    for (const fixture of fixtures.prices) {
      assert.equal(adapters.parsePriceText(fixture.text), fixture.cents, fixture.text);
    }
  });

  it('requires reliable U.S. offer evidence in addition to explicit USD', () => {
    for (const fixture of fixtures.scopes) {
      assert.equal(adapters.hasUSOfferEvidence(fixture.vertical, fixture.path, fixture.text, fixture.locale), fixture.allowed, fixture.name);
    }
  });

  it('ranks seller selectors while rejecting hidden, crossed-out, and weak candidates', () => {
    for (const fixture of fixtures.rankings) {
      const actual = adapters.chooseCandidate(fixture.candidates);
      assert.equal(actual && actual.cents, fixture.cents, fixture.name);
    }
  });

  it('creates an explicit, user-opened correction hook without embedding the page URL', () => {
    const info = adapters.classify('booking.com', '/hotel/private-itinerary', '');
    const url = adapters.feedbackUrl('https://pricetruth.example/', info, 21900);
    assert.equal(url, 'https://pricetruth.example/extension-feedback?source=extension&adapter=booking&vertical=hotel&detected_cents=21900');
    assert.doesNotMatch(url, /private-itinerary/);
  });

  it('preserves mandatory-fee-inclusive hotel and ticket displays while exposing unknown taxes', () => {
    for (const fixture of [
      { host: 'booking.com', path: '/hotel/us/example', price: 21900, unknown: 'hotel-taxes' },
      { host: 'ticketmaster.com', path: '/event/123', price: 8600, unknown: 'ticket-taxes' },
    ]) {
      const adapter = adapters.classify(fixture.host, fixture.path, 'Displayed total');
      const report = feeModel.analyze(adapter.vertical, fixture.price, { profile: adapter.profile });
      assert.equal(report.truePrice.amount_cents, fixture.price, fixture.host);
      assert.equal(report.feeLoadPct, 0, fixture.host);
      assert.equal(report.completeness.status, 'partial', fixture.host);
      assert.deepEqual(Array.from(report.completeness.unknownCosts, (cost) => cost.code), [fixture.unknown], fixture.host);
      assert.deepEqual(Array.from(report.lineItems, (line) => line.certainty), ['listed'], fixture.host);
      assert.doesNotMatch(report.lineItems.map((line) => line.label).join(' '), /resort|parking|service|facility|processing|tax/i);
    }
  });

  it('does not auto-select flight bags or seats', () => {
    const adapter = adapters.classify('spirit.com', '/book/flights', 'Flight total');
    const report = feeModel.analyze(adapter.vertical, 18900, { profile: adapter.profile });
    assert.equal(report.truePrice.amount_cents, 18900);
    assert.equal(report.completeness.status, 'complete');
    assert.deepEqual(Array.from(report.lineItems, (line) => line.certainty), ['listed']);
    assert.doesNotMatch(report.lineItems.map((line) => line.label).join(' '), /bag|seat/i);
  });

  it('labels a retail popup result as a subtotal when checkout inputs are unavailable', () => {
    const report = feeModel.analyze('retail', 29900, {});
    assert.equal(report.truePrice.amount_cents, 29900);
    assert.equal(report.completeness.status, 'partial');
    assert.deepEqual(Array.from(report.completeness.unknownCosts, (cost) => cost.code), ['shipping', 'handling', 'sales-tax']);
    assert.equal(report.confidence, 0.55);
  });
});
