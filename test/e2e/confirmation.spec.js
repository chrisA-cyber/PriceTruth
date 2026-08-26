import { test, expect } from '@playwright/test';

const cases = [
  {
    path: '/auth/verify',
    endpoint: '/api/auth/verify',
    button: 'Confirm and sign in',
    success: 'You are signed in',
    response: {
      authenticated: true,
      csrfToken: 'confirmed-csrf',
      account: { id: 'acct_confirmed', email: 'confirmed@example.com', emailVerified: true, plan: 'free' },
    },
  },
  {
    path: '/email/verify',
    endpoint: '/api/notifications/email/verify',
    button: 'Confirm email delivery',
    success: 'Email delivery confirmed',
    response: { verified: true, channel: 'email', status: 'active' },
  },
  {
    path: '/email/unsubscribe',
    endpoint: '/api/notifications/email/unsubscribe',
    button: 'Unsubscribe this email',
    success: 'Email unsubscribed',
    response: { unsubscribed: true, channel: 'email', status: 'unsubscribed' },
  },
  {
    path: '/alerts/unsubscribe',
    endpoint: '/api/alerts/unsubscribe',
    button: 'Unsubscribe this alert',
    success: 'Price alert stopped',
    response: { unsubscribed: true, alertId: 17, status: 'unsubscribed' },
  },
];

for (const entry of cases) {
  test(`${entry.path} keeps bearer in a fragment until explicit POST confirmation`, async ({ page }) => {
    const requests = [];
    await page.route(`**${entry.endpoint}`, async (route) => {
      requests.push({
        method: route.request().method(),
        url: route.request().url(),
        body: route.request().postDataJSON(),
      });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(entry.response),
      });
    });

    await page.goto(`${entry.path}#token=scanner-safe-secret`);
    await expect(page).toHaveURL(new RegExp(`${entry.path.replaceAll('/', '\\/')}$`));
    expect(requests).toHaveLength(0);
    await expect(page.getByText(/only after you press the button/i)).toBeVisible();

    await page.getByRole('button', { name: entry.button }).click();
    await expect(page.getByRole('heading', { name: entry.success })).toBeVisible();
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe('POST');
    expect(requests[0].body).toEqual({ token: 'scanner-safe-secret' });
    expect(requests[0].url).not.toContain('scanner-safe-secret');
  });
}
