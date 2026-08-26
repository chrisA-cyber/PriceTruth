import { test, expect } from '@playwright/test';

async function readOnlyDeployment(page) {
  let sessionCalls = 0;
  await page.route('**/api/meta', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      capabilities: { accounts: false },
      billing: { mode: 'mock' },
      legal: {
        configured: false, approved: false, operatorName: null, jurisdiction: null,
        supportContact: null, effectiveDate: null,
      },
    }),
  }));
  await page.route('**/api/session', (route) => {
    sessionCalls += 1;
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"authenticated":false}' });
  });
  return () => sessionCalls;
}

test('accounts-disabled deployment exposes only read-only product surfaces', async ({ page }) => {
  const sessionCalls = await readOnlyDeployment(page);

  await page.goto('/account');
  await expect(page.getByRole('heading', { name: 'Read-only deployment' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Accounts are disabled here' })).toBeVisible();
  await expect(page.getByText(/does not accept or retain account data/i)).toBeVisible();
  await expect(page.locator('.nav-account')).toBeHidden();
  await expect(page.locator('input[type="email"]')).toHaveCount(0);
  expect(sessionCalls()).toBe(0);

  await page.goto('/p/anc-headphones');
  await expect(page.getByText(/Accounts and personal data storage are disabled/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /save/i })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Watch the true price' })).toHaveCount(0);
  await expect(page.locator('a[href^="/account"]:visible')).toHaveCount(0);

  await page.goto('/pricing');
  await expect(page.getByText(/Accounts, alerts, notifications, API keys, and billing are disabled/i)).toBeVisible();
  await expect(page.getByText('One-time reports with no account storage')).toBeVisible();
  await expect(page.getByRole('link', { name: /availability updates|sign in/i })).toHaveCount(0);
});
