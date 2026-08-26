import { test, expect } from '@playwright/test';
import { analyze } from '../../src/engine/analyze.js';

function accountMeta(origin) {
  return {
    name: 'PriceTruth', currency: 'USD', publicBaseUrl: origin,
    capabilities: { accounts: true, billing: false },
    billing: { mode: 'mock', plans: {} },
    legal: { configured: false, approved: false },
  };
}

test('save → sign in → verify preserves one safe report return path', async ({ page }) => {
  const report = analyze({ vertical: 'retail', advertised_cents: 12999, context: {} });
  await page.route('**/api/meta', (route) => {
    const origin = new URL(route.request().url()).origin;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(accountMeta(origin)) });
  });
  await page.route('**/api/session', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ authenticated: false }),
  }));
  await page.route('**/api/products/safe-report?days=30', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      product: { id: 'safe-report', name: 'Safe report', vertical: 'retail', url: null, refreshable: false },
      refreshable: false, alertEligible: false, report, score: null, stats: null, history: [], demoData: false,
      provenance: { source: 'estimated:model', sourceLabel: 'One-time model', certainty: 'estimated' },
    }),
  }));
  await page.route('**/api/auth/verify', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      authenticated: true, csrfToken: 'verified-csrf',
      account: { id: 'acct_safe', email: 'safe@example.com', emailVerified: true, plan: 'free' },
    }),
  }));

  await page.goto('/p/safe-report');
  await page.getByRole('button', { name: 'Sign in to save snapshot' }).click();
  await expect(page).toHaveURL(/\/account\?return=%2Fp%2Fsafe-report$/);

  await page.goto('/auth/verify#token=safe-token');
  await page.getByRole('button', { name: 'Confirm and sign in' }).click();
  const returnLink = page.getByRole('link', { name: 'Return to your report' });
  await expect(returnLink).toHaveAttribute('href', '/p/safe-report');
  await returnLink.click();
  await expect(page).toHaveURL(/\/p\/safe-report$/);
});

test('post-auth return rejects external, protocol-relative, query, and fragment destinations', async ({ page }) => {
  await page.route('**/api/meta', (route) => {
    const origin = new URL(route.request().url()).origin;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(accountMeta(origin)) });
  });
  await page.route('**/api/session', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ authenticated: false }),
  }));
  await page.route('**/api/auth/verify', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      authenticated: true, csrfToken: 'verified-csrf',
      account: { id: 'acct_safe', email: 'safe@example.com', emailVerified: true, plan: 'free' },
    }),
  }));

  for (const unsafe of ['https://evil.example/path', '//evil.example/path', '/pricing?next=evil', '/p/safe#evil']) {
    await page.goto(`/account?return=${encodeURIComponent(unsafe)}`);
    await page.goto('/auth/verify#token=safe-token');
    await page.getByRole('button', { name: 'Confirm and sign in' }).click();
    await expect(page.getByRole('link', { name: 'Open dashboard' })).toHaveAttribute('href', '/account');
    await page.evaluate(() => localStorage.clear());
  }
});

test('canonical and Open Graph URLs follow validated same-origin runtime metadata', async ({ page }) => {
  await page.route('**/api/meta', (route) => {
    const origin = new URL(route.request().url()).origin;
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ ...accountMeta(origin), capabilities: { accounts: false, billing: false } }),
    });
  });

  await page.goto('/pricing');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', /\/pricing$/);
  await expect(page.locator('meta[property="og:url"]')).toHaveAttribute('content', /\/pricing$/);
  await page.goto('/account');
  await expect(page.locator('link[rel="canonical"]')).toHaveCount(0);
  await expect(page.locator('meta[property="og:url"]')).toHaveCount(0);
});
