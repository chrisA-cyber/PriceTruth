import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const routes = [
  '/', '/find', '/analyze', '/pricing', '/account', '/extension', '/legal.html',
  '/auth/verify', '/email/verify', '/email/unsubscribe', '/alerts/unsubscribe', '/billing/success',
];

for (const route of routes) {
  test(`@a11y ${route} has no serious or critical axe violations`, async ({ page }) => {
    await page.goto(route);
    await expect(page.locator('main')).toBeVisible();
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    const blocking = results.violations.filter((violation) => ['serious', 'critical'].includes(violation.impact));
    expect(blocking, blocking.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`).join('\n')).toEqual([]);
  });
}

test('@a11y skip link reaches the application landmark', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: /skip to main content/i });
  await expect(skip).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('main')).toBeFocused();
});

test('@a11y live checkout acceptance is labeled and has no serious axe violations', async ({ page }) => {
  await page.route('**/api/meta', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      billing: { mode: 'live' },
      capabilities: { accounts: true },
      legal: {
        configured: true, approved: true, operatorName: 'Accessibility Test Operator',
        jurisdiction: 'Test jurisdiction', supportContact: 'mailto:support@example.test',
        effectiveDate: '2026-08-25', termsVersion: '2026-08-25-v1',
      },
    }),
  }));
  await page.route('**/api/session', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      authenticated: true, csrfToken: 'a11y-csrf',
      account: { id: 'acct_a11y', email: 'buyer@example.test', emailVerified: true, plan: 'free' },
    }),
  }));

  await page.goto('/pricing');
  const checkbox = page.getByRole('form', { name: 'Start premium checkout' }).getByRole('checkbox');
  await expect(checkbox).toHaveAccessibleName(/I agree to the Terms and acknowledge the Privacy Notice/i);
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const blocking = results.violations.filter((violation) => ['serious', 'critical'].includes(violation.impact));
  expect(blocking, blocking.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`).join('\n')).toEqual([]);
});
