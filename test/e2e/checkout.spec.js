import { test, expect } from '@playwright/test';

const signedInSession = {
  authenticated: true,
  csrfToken: 'checkout-csrf-token',
  account: {
    id: 'acct_checkout_test',
    email: 'buyer@example.com',
    emailVerified: true,
    plan: 'free',
  },
};

async function billingMode(page, mode) {
  await page.route('**/api/meta', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      billing: { mode },
      legal: mode === 'live' ? {
        configured: true,
        approved: true,
        operatorName: 'PriceTruth Test Operator',
        jurisdiction: 'Test jurisdiction',
        supportContact: 'mailto:support@example.test',
        effectiveDate: '2026-08-25',
        termsVersion: '2026-08-25-v1',
      } : {
        configured: false,
        approved: false,
        operatorName: null,
        jurisdiction: null,
        supportContact: null,
        effectiveDate: null,
        termsVersion: null,
      },
    }),
  }));
}

async function sessionAs(page, session) {
  await page.route('**/api/session', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(session),
  }));
}

async function alertEligibleProduct(page) {
  await page.route('**/api/products/anc-headphones?days=*', async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    payload.refreshable = true;
    payload.alertEligible = true;
    payload.product = { ...payload.product, refreshable: true, alertEligible: true };
    await route.fulfill({ response, json: payload });
  });
}

async function alertLimit(page) {
  await page.route('**/api/account/alerts', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fulfill({
      status: 402,
      contentType: 'application/json',
      body: JSON.stringify({
        error: 'free accounts get 1 price alert',
        upgrade: {
          planId: 'premium',
          price: '$4/month',
          includes: '20 email alerts and a weekly digest',
        },
      }),
    });
  });
}

test('real mock checkout lifecycle exposes status before and after one-time API claim', async ({ request }, testInfo) => {
  test.skip(testInfo.project.name.includes('mobile'), 'actual server contract only needs one execution');
  const email = `checkout-contract-${Date.now()}@example.test`;
  const checkout = await request.post('/api/billing/checkout', {
    data: { planId: 'api_starter', email },
  });
  expect(checkout.status()).toBe(200);
  const checkoutBody = await checkout.json();
  expect(checkoutBody).toMatchObject({ mock: true, mode: 'mock' });

  const completion = await request.get(checkoutBody.url, { maxRedirects: 0 });
  expect(completion.status()).toBe(303);
  const location = completion.headers().location;
  expect(location).toMatch(/^\/billing\/success\?session_id=cs_mock_/);
  const sessionId = new URL(location, 'http://localhost').searchParams.get('session_id');
  expect(sessionId).toBeTruthy();

  const claimable = await request.get(`/api/billing/checkout/status?session_id=${encodeURIComponent(sessionId)}`);
  expect(claimable.status()).toBe(200);
  expect(await claimable.json()).toMatchObject({
    status: 'claimable', complete: true, claimable: true, plan: 'api_starter', tier: 'starter',
  });

  const claim = await request.post('/api/billing/claim', { data: { session_id: sessionId } });
  expect(claim.status()).toBe(200);
  const claimBody = await claim.json();
  expect(claimBody).toMatchObject({ status: 'claimed', plan: 'api_starter', tier: 'starter' });
  expect(claimBody.key).toMatch(/^pt_starter_/);

  const claimed = await request.get(`/api/billing/checkout/status?session_id=${encodeURIComponent(sessionId)}`);
  expect(claimed.status()).toBe(200);
  expect(await claimed.json()).toMatchObject({
    status: 'claimed', complete: true, claimable: false, plan: 'api_starter', tier: 'starter',
  });

  const secondClaim = await request.post('/api/billing/claim', { data: { session_id: sessionId } });
  expect(secondClaim.status()).toBe(409);
});

test('live pricing requires sign-in and never collects an unowned checkout email', async ({ page }) => {
  await billingMode(page, 'live');
  await sessionAs(page, { authenticated: false });
  await page.goto('/pricing');

  const signIn = page.getByRole('link', { name: 'Sign in to choose Premium' });
  await expect(signIn).toBeVisible();
  await expect(signIn).toHaveAttribute('href', '/account?return=%2Fpricing');
  await expect(page.locator('input[type="email"]')).toHaveCount(0);
  await expect(page.getByText(/checkout uses the email verified on your account/i).first()).toBeVisible();
  await expect(page.getByText(/Operated by PriceTruth Test Operator/i).first()).toBeVisible();
  await expect(page.locator('#deployment-identity')).toContainText('PriceTruth Test Operator');
});

test('live pricing checkout sends plan plus explicit versioned acceptance with session CSRF', async ({ page }) => {
  await billingMode(page, 'live');
  await sessionAs(page, signedInSession);
  let checkoutRequest;
  await page.route('**/api/billing/checkout', async (route) => {
    checkoutRequest = {
      headers: route.request().headers(),
      body: route.request().postDataJSON(),
    };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ url: '/pricing?checkout=started', mode: 'live' }),
    });
  });

  await page.goto('/pricing');
  await expect(page.getByText('Checkout account: buyer@example.com').first()).toBeVisible();
  await expect(page.locator('input[type="email"]')).toHaveCount(0);
  const premiumCheckout = page.getByRole('form', { name: 'Start premium checkout' });
  const acceptance = premiumCheckout.getByRole('checkbox');
  await expect(acceptance).not.toBeChecked();
  await expect(premiumCheckout.getByRole('button', { name: 'Choose Premium' })).toBeDisabled();
  await expect(premiumCheckout.getByRole('link', { name: 'Terms' })).toHaveAttribute('href', '/legal.html#terms');
  await expect(premiumCheckout.getByText(/Terms version 2026-08-25-v1; effective 2026-08-25/i)).toBeVisible();
  await acceptance.check();
  await premiumCheckout.getByRole('button', { name: 'Choose Premium' }).click();
  await page.waitForURL('**/pricing?checkout=started');

  expect(checkoutRequest.body).toEqual({
    planId: 'premium', acceptTerms: true, acceptedTermsVersion: '2026-08-25-v1',
  });
  expect(checkoutRequest.headers['x-csrf-token']).toBe('checkout-csrf-token');
});

test('live-billing alert upsell uses account checkout and shows only delivered email benefits', async ({ page }) => {
  await billingMode(page, 'live');
  await sessionAs(page, signedInSession);
  await alertLimit(page);
  await alertEligibleProduct(page);
  let checkoutRequest;
  await page.route('**/api/billing/checkout', async (route) => {
    checkoutRequest = {
      headers: route.request().headers(),
      body: route.request().postDataJSON(),
    };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ url: '/pricing?checkout=started', mode: 'live' }),
    });
  });

  await page.goto('/p/anc-headphones');
  await expect(page.getByText(/scheduled cadence.*delivery follows that source schedule/i)).toBeVisible();
  await page.getByRole('button', { name: 'Create alert' }).click();
  await expect(page.getByRole('heading', { name: 'Unlock more alerts' })).toBeVisible();
  await expect(page.getByText(/weekly digest/i)).toBeVisible();
  const upsellCheckout = page.getByRole('form', { name: 'Start premium checkout' });
  await upsellCheckout.getByRole('checkbox').check();
  await upsellCheckout.getByRole('button', { name: 'Upgrade to Premium — $4/mo' }).click();
  await page.waitForURL('**/pricing?checkout=started');

  expect(checkoutRequest.body).toEqual({
    planId: 'premium', acceptTerms: true, acceptedTermsVersion: '2026-08-25-v1',
  });
  expect(checkoutRequest.headers['x-csrf-token']).toBe('checkout-csrf-token');
});

test('alert upsell exposes no purchase action when billing is not live', async ({ page }) => {
  await billingMode(page, 'mock');
  await sessionAs(page, signedInSession);
  await alertLimit(page);
  await alertEligibleProduct(page);

  await page.goto('/p/anc-headphones');
  await page.getByRole('button', { name: 'Create alert' }).click();
  await expect(page.getByText(/paid enrollment is closed here/i)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Upgrade to Premium — $4/mo' })).toHaveCount(0);
  await expect(page.locator('input[type="email"]')).toHaveCount(0);
});

test('billing return waits for confirmed consumer status and never probes for an API key', async ({ page }) => {
  let statusChecks = 0;
  let claimCalls = 0;
  await page.route('**/api/billing/checkout/status?session_id=cs_consumer', async (route) => {
    statusChecks += 1;
    const pending = statusChecks === 1;
    await route.fulfill({
      status: pending ? 202 : 200,
      contentType: 'application/json',
      body: JSON.stringify(pending
        ? { status: 'pending', complete: false, claimable: false, plan: null, tier: null }
        : { status: 'complete', complete: true, claimable: false, plan: 'premium', tier: null }),
    });
  });
  await page.route('**/api/billing/claim', async (route) => {
    claimCalls += 1;
    await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'not an API purchase' }) });
  });

  await page.goto('/billing/success?session_id=cs_consumer');
  await expect(page.getByRole('heading', { name: 'Premium is active' })).toBeVisible();
  await expect(page.getByText(/email after verified catalog or source updates/i)).toBeVisible();
  expect(statusChecks).toBe(2);
  expect(claimCalls).toBe(0);
});

test('terminal checkout status offers a fresh checkout and never implies activation', async ({ page }) => {
  await page.route('**/api/billing/checkout/status?session_id=cs_expired', (route) => route.fulfill({
    status: 409,
    contentType: 'application/json',
    body: JSON.stringify({
      error: 'checkout session expired', code: 'CHECKOUT_TERMINAL', checkoutStatus: 'expired',
      requiresAction: true, plan: 'premium',
    }),
  }));

  await page.goto('/billing/success?session_id=cs_expired');
  await expect(page.getByRole('heading', { name: 'Checkout expired' })).toBeVisible();
  await expect(page.getByText(/No plan or API key was activated/i)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Start a new checkout' })).toHaveAttribute('href', '/pricing');
  await expect(page.getByText('Premium unlocked')).toHaveCount(0);
});

test('API billing return claims once with account CSRF after status becomes claimable', async ({ page }) => {
  await sessionAs(page, signedInSession);
  await page.route('**/api/billing/checkout/status?session_id=cs_api', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ status: 'claimable', complete: true, claimable: true, plan: 'api_starter', tier: 'starter' }),
  }));
  let claimRequest;
  await page.route('**/api/billing/claim', async (route) => {
    claimRequest = {
      headers: route.request().headers(),
      body: route.request().postDataJSON(),
    };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ key: 'pt_starter_one_time_secret', tier: 'starter', plan: 'api_starter', status: 'claimed', note: 'shown once' }),
    });
  });

  await page.goto('/billing/success?session_id=cs_api');
  await expect(page.getByRole('heading', { name: 'API key ready' }).first()).toBeVisible();
  await expect(page.getByText('pt_starter_one_time_secret')).toBeVisible();
  expect(claimRequest.body).toEqual({ session_id: 'cs_api' });
  expect(claimRequest.headers['x-csrf-token']).toBe('checkout-csrf-token');
});

test('a missing API claim is never presented as Premium or a completed key handoff', async ({ page }) => {
  await sessionAs(page, signedInSession);
  await page.route('**/api/billing/checkout/status?session_id=cs_missing', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ status: 'claimable', complete: true, claimable: true, plan: 'api_pro', tier: 'pro' }),
  }));
  await page.route('**/api/billing/claim', (route) => route.fulfill({
    status: 404,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'no key to claim' }),
  }));

  await page.goto('/billing/success?session_id=cs_missing');
  await expect(page.getByRole('heading', { name: 'Checkout is not confirmed' })).toBeVisible();
  await expect(page.getByText(/not being treated as Premium/i)).toBeVisible();
  await expect(page.getByText('Premium unlocked')).toHaveCount(0);
  await expect(page.getByText(/API key ready/i)).toHaveCount(0);
});

test('approved operator metadata reaches public legal and authenticated account surfaces', async ({ page }) => {
  await billingMode(page, 'live');
  await sessionAs(page, signedInSession);
  await page.route('**/api/account', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      account: signedInSession.account,
      preferences: { email_alerts: true, weekly_digest: false, timezone: 'UTC' },
      notificationSubscription: { status: 'active' },
      usage: { alerts: 0, watchlist: 0, apiKeys: 0 },
    }),
  }));
  await page.route('**/api/account/watchlist', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[]}' }));
  await page.route('**/api/account/alerts', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"alerts":[],"limit":1,"plan":"free"}' }));
  await page.route('**/api/account/api-keys', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"keys":[]}' }));

  await page.goto('/account');
  await expect(page.locator('.account-identity')).toContainText('PriceTruth Test Operator');
  await expect(page.locator('.account-identity')).toContainText('Test jurisdiction');

  await page.goto('/legal.html');
  await expect(page.locator('#legal-identity')).toContainText('Commercial operator: PriceTruth Test Operator');
  await expect(page.locator('#legal-law')).toContainText('Test jurisdiction');
  await expect(page.locator('#legal-support').getByRole('link')).toHaveAttribute('href', 'mailto:support@example.test');
});

test('dashboard separates bookmark removal from permanent private-report deletion', async ({ page }) => {
  await billingMode(page, 'mock');
  await sessionAs(page, signedInSession);
  await page.route('**/api/account', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      account: signedInSession.account,
      preferences: { email_alerts: true, weekly_digest: false, timezone: 'UTC' },
      notificationSubscription: { status: 'active' },
      usage: { alerts: 0, watchlist: 2, apiKeys: 0 },
    }),
  }));
  let privateDeleted = false;
  await page.route('**/api/account/watchlist', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      items: [
        {
          product_id: 'curated-report', created_at: '2026-08-25T12:00:00.000Z',
          product: { id: 'curated-report', name: 'Shared report', vertical: 'retail', refreshable: true, deletable: false },
        },
        ...(privateDeleted ? [] : [{
          product_id: 'private-report', created_at: '2026-08-25T12:00:00.000Z',
          product: { id: 'private-report', name: 'My private report', vertical: 'hotel', refreshable: false, deletable: true },
        }]),
      ],
    }),
  }));
  await page.route('**/api/account/products/private-report', async (route) => {
    expect(route.request().method()).toBe('DELETE');
    expect(route.request().headers()['x-csrf-token']).toBe(signedInSession.csrfToken);
    privateDeleted = true;
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"deleted":true}' });
  });
  await page.route('**/api/account/alerts', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"alerts":[],"limit":1,"plan":"free"}' }));
  await page.route('**/api/account/api-keys', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"keys":[]}' }));

  await page.goto('/account');
  await expect(page.getByRole('button', { name: 'Remove from saved' })).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Delete report & history' })).toHaveCount(1);
  await page.getByRole('button', { name: 'Delete report & history' }).click();
  await expect(page.getByText(/Removing from saved alone does not delete the report/i)).toBeVisible();
  await page.getByRole('button', { name: 'Delete report and history' }).click();
  await expect(page.getByRole('heading', { name: 'My private report' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Shared report' })).toBeVisible();
});

test('active subscription blocks account deletion with a billing-cancellation handoff', async ({ page }) => {
  const paidSession = {
    ...signedInSession,
    account: { ...signedInSession.account, plan: 'premium' },
  };
  await billingMode(page, 'live');
  await sessionAs(page, paidSession);
  await page.route('**/api/account', async (route) => {
    if (route.request().method() === 'DELETE') {
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'cancel active subscriptions before deleting the account',
          code: 'ACTIVE_SUBSCRIPTION',
          requiresBillingCancellation: true,
          portal: '/api/billing/portal',
          activeProducts: ['premium'],
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        account: paidSession.account,
        preferences: { email_alerts: true, weekly_digest: true, timezone: 'UTC' },
        notificationSubscription: { status: 'active' },
        usage: { alerts: 1, watchlist: 0, apiKeys: 0 },
      }),
    });
  });
  await page.route('**/api/account/watchlist', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[]}' }));
  await page.route('**/api/account/alerts', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"alerts":[],"limit":20,"plan":"premium"}' }));
  await page.route('**/api/account/api-keys', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"keys":[]}' }));

  await page.goto('/account');
  await page.getByText('Delete account and data').click();
  await page.getByLabel('Confirmation').fill('DELETE');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Delete account permanently' }).click();
  await expect(page.getByText(/open Manage billing, cancel the subscription/i)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Manage billing' })).toBeVisible();
});
