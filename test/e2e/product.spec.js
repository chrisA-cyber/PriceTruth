import { test, expect } from '@playwright/test';
import { analyze } from '../../src/engine/analyze.js';

async function reportFor(_request, vertical, advertisedCents, context = {}) {
  // These reports are fixtures for mocked search/product responses. Building
  // them with the real engine keeps the shape faithful without consuming the
  // shared server's per-IP write budget across parallel browser projects.
  return analyze({ vertical, advertised_cents: advertisedCents, context });
}

test('universal price check produces a labeled report and moves focus', async ({ page }) => {
  await page.goto('/find');
  await expect(page.getByRole('heading', { name: /check a price before checkout/i })).toBeVisible();
  await page.locator('#find-vertical').selectOption('hotel');
  await page.locator('#find-q').fill('$219.00');
  await page.getByRole('button', { name: 'Build the all-in report' }).click();
  const heading = page.getByRole('heading', { name: /hotel price at \$219\.00/i });
  await expect(heading).toBeVisible();
  await expect(heading).toBeFocused();
  await expect(page.getByRole('region', { name: 'Known price subtotal' })).toBeVisible();
  await expect(page.getByText(/mandatory hotel fees/i).first()).toBeVisible();
  await expect(page.getByText(/hotel taxes/i).first()).toBeVisible();
});

test('insufficient history is explicit on cards and reports and never looks like a deal', async ({ page }) => {
  const report = analyze({
    vertical: 'subscription', advertised_cents: 1599,
    context: { pricingMode: 'stable_monthly', termMonths: 12 },
  });
  const payload = {
    product: { id: 'historyless-plan', name: 'Historyless plan', vertical: 'subscription', url: null, refreshable: false },
    refreshable: false,
    alertEligible: false,
    report,
    score: null,
    stats: null,
    history: [],
    demoData: false,
    provenance: { source: 'dataset:plans', sourceLabel: 'Verified catalog snapshot', certainty: 'catalog' },
  };
  await page.route(/\/api\/products(?:\?.*)?$/, (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ products: [payload], pagination: { limit: 12, offset: 0, total: 1, nextOffset: null } }),
  }));
  await page.goto('/');
  const card = page.locator('.product-card', { hasText: 'Historyless plan' });
  await expect(card.getByText('Not enough history yet', { exact: true })).toBeVisible();
  await expect(card.getByText(/good deal|great deal/i)).toHaveCount(0);

  await page.route('**/api/products/historyless-plan?days=30', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(payload),
  }));
  await page.goto('/p/historyless-plan');
  const verdict = page.getByRole('region', { name: 'All-in price verdict' });
  await expect(verdict.getByText('Not enough history yet', { exact: true })).toBeVisible();
  await expect(verdict.getByText(/good deal|great deal/i)).toHaveCount(0);
});

test('anonymous search stays one-time and never creates null tracking actions', async ({ page, request }) => {
  const report = await reportFor(request, 'retail', 12999, { sales_tax_pct: 8.25 });
  await page.route('**/api/meta', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.providers.retail = { kind: 'live', live: true, truthUsable: true };
    await route.fulfill({ response, body: JSON.stringify(body) });
  });
  await page.route('**/api/search', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      product_id: null,
      persisted: false,
      refreshable: true,
      listing: {
        name: 'Wireless headphones', vertical: 'retail', url: null,
        refreshable: true,
        advertised_cents: 12999, certainty: 'estimated', source: 'estimated:model',
        sourceLabel: 'PriceTruth retail model', fetchedAt: '2026-08-25T12:00:00.000Z',
        provenance: {
          source: 'estimated:model', evidenceType: 'model_estimate', observed: false,
          fetchedAt: '2026-08-25T12:00:00.000Z', asOf: '2026-08-25T12:00:00.000Z', stale: true,
        },
      },
      report,
      score: null,
    }),
  }));

  await page.goto('/find');
  await page.locator('#find-vertical').selectOption('retail');
  await page.locator('#find-q').fill('wireless headphones');
  await page.getByRole('button', { name: 'Check available evidence' }).click();

  await expect(page.getByRole('heading', { name: 'This is a one-time report' })).toBeVisible();
  await expect(page.getByText(/did not store this check, start history, or create an alert/i)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sign in to save future checks' })).toHaveAttribute('href', '/account');
  await expect(page.getByRole('heading', { name: 'Observation started' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Watch verified price updates' })).toHaveCount(0);
  await expect(page.locator('a[href="/p/null"]')).toHaveCount(0);
});

test('a result without stable seller identity stays a snapshot with no tracking promises', async ({ page, request }) => {
  const report = await reportFor(request, 'retail', 12999, { sales_tax_pct: 8.25 });
  await page.route('**/api/meta', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.providers.retail = { kind: 'live', live: true, truthUsable: true };
    await route.fulfill({ response, body: JSON.stringify(body) });
  });
  await page.route('**/api/search', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      product_id: 'snapshot-headphones',
      persisted: true,
      refreshable: false,
      listing: {
        name: 'Unidentified headphones', vertical: 'retail', url: null,
        refreshable: false, advertised_cents: 12999, certainty: 'estimated',
        source: 'estimated:model', sourceLabel: 'One-time provider result',
        fetchedAt: '2026-08-25T12:00:00.000Z',
        provenance: { source: 'estimated:model', observed: false, refreshable: false },
      },
      report,
      score: null,
    }),
  }));

  await page.goto('/find');
  await page.locator('#find-vertical').selectOption('retail');
  await page.locator('#find-q').fill('unidentified headphones');
  await page.getByRole('button', { name: 'Check available evidence' }).click();

  await expect(page.getByRole('heading', { name: 'Treat this as a one-time result' })).toBeVisible();
  await expect(page.getByText(/save this snapshot.*no.*reliable rechecks, history, or alerts/i)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Observation started' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Watch verified price updates' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Open tracked report' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /save snapshot/i })).toBeVisible();
});

test('a refreshable result creates alerts only when the source is explicitly eligible', async ({ page, request }) => {
  const report = await reportFor(request, 'subscription', 1599, { pricingMode: 'stable_monthly', termMonths: 12 });
  await page.route('**/api/search', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      product_id: 'catalog-plan', persisted: true, refreshable: true, alertEligible: false,
      listing: {
        name: 'Catalog plan', vertical: 'subscription', url: null, advertised_cents: 1599,
        refreshable: true, alertEligible: false, certainty: 'catalog', source: 'dataset:plans',
        sourceLabel: 'Catalog snapshot', fetchedAt: '2026-08-25T12:00:00.000Z',
        provenance: { source: 'dataset:plans', refreshable: true, alertEligible: false, observed: false },
      },
      report,
      score: null,
    }),
  }));

  await page.goto('/find');
  await page.locator('#find-vertical').selectOption('subscription');
  await page.locator('#find-q').fill('catalog plan');
  await page.getByRole('button', { name: 'Check available evidence' }).click();

  await expect(page.getByRole('heading', { name: 'Observation started' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Alerts are unavailable for this result' })).toBeVisible();
  await expect(page.getByText(/delivery timing follows the source-update cadence/i)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Watch verified price updates' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Create alert' })).toHaveCount(0);
});

test('dataset evidence uses its price date and warns when the snapshot is stale', async ({ page, request }) => {
  const report = await reportFor(request, 'subscription', 1599, { pattern: 'default' });
  await page.route('**/api/search', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      product_id: null,
      persisted: false,
      listing: {
        name: 'Example monthly plan', vertical: 'subscription', url: null,
        advertised_cents: 1599, certainty: 'catalog', source: 'dataset:plans',
        sourceLabel: 'Plan catalog snapshot', fetchedAt: '2026-08-25T12:00:00.000Z',
        provenance: {
          source: 'dataset:plans', evidenceType: 'catalog_snapshot', observed: false,
          fetchedAt: '2026-08-25T12:00:00.000Z', asOf: '2024-01-02T00:00:00.000Z',
          maxAgeSeconds: 2592000, ageSeconds: 52000000, stale: true,
        },
      },
      report,
      score: null,
    }),
  }));

  await page.goto('/find');
  await page.locator('#find-vertical').selectOption('subscription');
  await page.locator('#find-q').fill('example monthly plan');
  await page.getByRole('button', { name: 'Check available evidence' }).click();

  const evidence = page.locator('.evidence-card');
  await expect(evidence.getByText('Price as of', { exact: true })).toBeVisible();
  await expect(evidence.getByText(/Jan 2, 2024/)).toBeVisible();
  await expect(evidence.getByText(/Dataset snapshot may be stale/i)).toBeVisible();
  await expect(evidence.getByText(/older than its source freshness window/i)).toBeVisible();
  await expect(evidence.locator('dt', { hasText: 'Checked' })).toHaveCount(0);
});

test('verified subscription catalog report keeps its source and is never relabeled as seed demo data', async ({ page, request }) => {
  const report = await reportFor(request, 'subscription', 1599, { pricingMode: 'stable_monthly', termMonths: 12 });
  await page.route('**/api/products/catalog-plan?days=30', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      product: { id: 'catalog-plan', name: 'Verified catalog plan', vertical: 'subscription', url: null, refreshable: true, alertEligible: true },
      refreshable: true,
      alertEligible: true,
      demoData: false,
      provenance: {
        source: 'dataset:plans', sourceLabel: 'Verified subscription catalog snapshot', certainty: 'catalog',
        fetchedAt: '2026-08-25T12:00:00.000Z',
        evidence: { provenance: {
          source: 'dataset:plans', evidenceType: 'catalog_snapshot', observed: false,
          asOf: '2026-08-20T00:00:00.000Z', fetchedAt: '2026-08-25T12:00:00.000Z', stale: false,
        } },
      },
      report,
      stats: null,
      score: null,
      history: [{ ts: '2026-08-25T12:00:00.000Z', advertised_cents: 1599, true_cents: report.truePrice.amount_cents }],
    }),
  }));

  await page.goto('/p/catalog-plan');
  await expect(page.locator('.evidence-card')).toContainText('Verified subscription catalog snapshot');
  await expect(page.locator('.evidence-card')).toContainText('Price as of');
  await expect(page.getByText('Illustrative PriceTruth seed dataset')).toHaveCount(0);
  await expect(page.locator('.chip-demo')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Watch verified price updates' })).toBeVisible();
  await expect(page.getByText(/periodically checks the verified subscription catalog/i)).toBeVisible();
});

test('expired live observations stay expired on cards, detail, copy, and comparison output', async ({ page, request }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (value) => { window.__priceTruthCopied = value; } },
    });
  });
  const report = await reportFor(request, 'retail', 1999, { shipping_cents: 0, handling_cents: 0, taxPct: 0 });
  const observedAt = '2026-08-20T12:00:00.000Z';
  const provenance = {
    source: 'live:retail-feed', sourceLabel: 'Verified retail feed', certainty: 'live', fetchedAt: observedAt,
    evidence: { provenance: {
      source: 'live:retail-feed', sourceLabel: 'Verified retail feed', evidenceType: 'provider_quote',
      observed: true, fetchedAt: observedAt, asOf: observedAt, maxAgeSeconds: 3600,
      ageSeconds: 500000, stale: true, alertEligible: false,
    } },
  };
  const payload = {
    product: { id: 'expired-live-item', name: 'Expired live item', vertical: 'retail', url: null, refreshable: true, alertEligible: false },
    refreshable: true,
    alertEligible: false,
    demoData: false,
    provenance,
    report,
    stats: null,
    score: null,
    history: [{ ts: observedAt, advertised_cents: 1999, true_cents: 1999, alertEligible: false }],
  };
  await page.route(/\/api\/products(?:\?.*)?$/, (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ products: [payload], pagination: { limit: 12, offset: 0, total: 1, nextOffset: null } }),
  }));
  await page.route('**/api/products/expired-live-item?days=30', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(payload),
  }));

  await page.goto('/');
  const card = page.locator('.product-card', { hasText: 'Expired live item' });
  await expect(card.getByText('Expired stored observation', { exact: true })).toBeVisible();
  await expect(card.getByText('expired observation', { exact: true })).toBeVisible();

  await page.goto('/p/expired-live-item');
  await expect(page.getByRole('region', { name: 'All-in price verdict' })).toContainText('Expired stored observation');
  await expect(page.locator('.evidence-card')).toContainText('Stored observation expired');
  await expect(page.locator('.evidence-card')).toContainText('Last observed');

  await page.getByRole('button', { name: 'Copy summary' }).click();
  const copied = await page.evaluate(() => window.__priceTruthCopied || '');
  expect(copied).toContain('Source: Verified retail feed');
  expect(copied).toContain('Observed:');
  expect(copied).toContain('Freshness: expired stored observation');

  await page.getByRole('button', { name: 'Compare' }).click();
  await page.goto('/compare');
  await expect(page.getByRole('heading', { name: 'Compare price evidence' })).toBeVisible();
  await expect(page.getByText('expired observation', { exact: true })).toBeVisible();
  await expect(page.getByText(/lowest complete/i)).toHaveCount(0);
});

test('manual analyzer supports keyboard-first submission', async ({ page }) => {
  await page.goto('/analyze');
  await page.getByLabel('Purchase type').selectOption('subscription');
  await page.getByLabel('Advertised price in dollars').fill('9.99');
  await page.getByRole('button', { name: 'Calculate the all-in total' }).click();
  await expect(page.getByRole('heading', { name: 'Your all-in report' })).toBeFocused();
  await expect(page.getByText(/first-year cost/i).first()).toBeVisible();
});

test('manual reports keep unconfirmed mandatory costs unknown until the user supplies evidence', async ({ page }) => {
  await page.goto('/analyze');

  await page.getByLabel('Purchase type').selectOption('hotel');
  await expect(page.locator('label[for="f-price"]')).toHaveText('Displayed nightly price ($)');
  await expect(page.getByLabel('Seller explicitly says all mandatory hotel fees are included')).not.toBeChecked();
  await expect(page.getByLabel('Seller explicitly says lodging taxes are included')).not.toBeChecked();
  await page.getByLabel('Advertised price in dollars').fill('219');
  await page.getByRole('button', { name: 'Calculate the all-in total' }).click();
  await expect(page.getByRole('heading', { name: 'Your all-in report' })).toBeFocused();
  await expect(page.getByRole('region', { name: 'Known price subtotal' })).toBeVisible();
  await expect(page.getByText(/mandatory hotel fees/i).first()).toBeVisible();
  await expect(page.getByText(/hotel taxes/i).first()).toBeVisible();
  await expect(page.locator('table.breakdown tbody').getByText('Resort fee', { exact: true })).toHaveCount(0);
  await expect(page.locator('table.breakdown tbody').getByText('Parking', { exact: true })).toHaveCount(0);

  await page.getByLabel('Purchase type').selectOption('ticket');
  await expect(page.locator('label[for="f-price"]')).toHaveText('Displayed ticket price ($)');
  await expect(page.getByLabel('Seller explicitly says all mandatory ticket fees are included')).not.toBeChecked();
  await expect(page.getByLabel('Seller explicitly says government taxes are included')).not.toBeChecked();
  await page.getByLabel('Advertised price in dollars').fill('86');
  await page.getByRole('button', { name: 'Calculate the all-in total' }).click();
  await expect(page.getByRole('heading', { name: 'Your all-in report' })).toBeFocused();
  await expect(page.getByRole('region', { name: 'Known price subtotal' })).toBeVisible();
  const defaultTicketRows = page.locator('table.breakdown tbody');
  await expect(defaultTicketRows.getByText(/Service fee|Facility charge|Order processing/)).toHaveCount(0);
  await expect(page.locator('table.breakdown tfoot')).toContainText('$86.00');

  const explicitTax = page.getByLabel(/Explicit taxes outside the displayed ticket price/i);
  await explicitTax.fill('12.50');
  await page.getByRole('button', { name: 'Calculate the all-in total' }).click();
  await expect(page.getByRole('heading', { name: 'Your all-in report' })).toBeFocused();
  const explicitTicketRows = page.locator('table.breakdown tbody');
  await expect(explicitTicketRows.getByText('Explicitly excluded tax', { exact: true })).toBeVisible();
  await expect(explicitTicketRows).toContainText('$12.50');
  await expect(explicitTicketRows.getByText(/Service fee|Facility charge|Order processing/)).toHaveCount(0);
  await expect(page.locator('table.breakdown tfoot')).toContainText('$98.50');
  await expect(page.getByText(/mandatory ticket fees/i).first()).toBeVisible();

  await page.getByLabel('Seller explicitly says all mandatory ticket fees are included').check();
  await page.getByRole('button', { name: 'Calculate the all-in total' }).click();
  await expect(page.getByRole('region', { name: 'All-in price verdict' })).toBeVisible();

  await page.getByLabel('Purchase type').selectOption('flight');
  await expect(page.getByLabel('Bringing a carry-on bag')).not.toBeChecked();
  await expect(page.getByLabel('Picking a seat')).not.toBeChecked();
  await expect(page.getByLabel('Seller explicitly says mandatory taxes and carrier charges are included')).not.toBeChecked();
  await page.getByLabel('Advertised price in dollars').fill('125');
  await page.getByRole('button', { name: 'Calculate the all-in total' }).click();
  await expect(page.getByRole('heading', { name: 'Your all-in report' })).toBeFocused();
  await expect(page.getByRole('region', { name: 'Known price subtotal' })).toBeVisible();
  const defaultFlightRows = page.locator('table.breakdown tbody');
  await expect(defaultFlightRows.getByText(/Carry-on bag|Seat selection/)).toHaveCount(0);
  await expect(page.locator('table.breakdown tfoot')).toContainText('$125.00');
});

test('API contract works through a real browser context', async ({ request }) => {
  const response = await request.post('/api/analyze', {
    data: { vertical: 'ticket', advertised_cents: 8600, context: { platform: 'ticketmaster', quantity: 2 } },
  });
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body.currency).toBe('USD');
  expect(Number.isInteger(body.truePrice.amount_cents)).toBe(true);
  expect(['complete', 'partial']).toContain(body.completeness.status);
  expect(Array.isArray(body.completeness.unknownCosts)).toBe(true);
  expect(body.lineItems.every((item) => ['listed', 'typical', 'estimated'].includes(item.certainty))).toBe(true);
});

test('mobile pages do not introduce document-level horizontal scrolling', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes('mobile'), 'mobile project only');
  for (const route of ['/', '/find', '/analyze', '/pricing', '/account']) {
    await page.goto(route);
    await expect(page.locator('main')).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, route).toBeLessThanOrEqual(1);
  }
});
