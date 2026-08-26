import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const request = (schema, required = true) => ({ required, content: { 'application/json': { schema } } });
const headers = {
  'X-Request-Id': { $ref: '#/components/headers/RequestId' },
  'RateLimit-Limit': { $ref: '#/components/headers/RateLimitLimit' },
  'RateLimit-Remaining': { $ref: '#/components/headers/RateLimitRemaining' },
  'RateLimit-Reset': { $ref: '#/components/headers/RateLimitReset' },
};
const jsonResponse = (description, schema, extraHeaders = {}) => ({
  description, headers: { ...headers, ...extraHeaders }, content: { 'application/json': { schema } },
});
const errorResponse = (description) => jsonResponse(description, ref('Error'));
const standardErrors = (codes = [400, 401, 403, 404, 429, 500]) => Object.fromEntries(codes.map((code) => [String(code), errorResponse({
  400: 'Invalid request', 401: 'Authentication required', 402: 'Payment or entitlement required', 403: 'Forbidden', 404: 'Not found',
  405: 'Method not allowed', 409: 'Conflict', 413: 'Payload too large', 422: 'Semantically invalid', 429: 'Rate limited', 500: 'Internal error', 502: 'Upstream provider error', 503: 'Not ready',
}[code])]));
const op = ({ tags, summary, operationId, security = [], parameters, body, ok = ref('Object'), status = '200', statusText = 'Successful response', errors = [400, 429, 500], idempotency = 'none', description }) => ({
  tags, summary, operationId, description, security, parameters, requestBody: body,
  'x-idempotency': { strategy: idempotency },
  responses: { [status]: jsonResponse(statusText, ok), ...standardErrors(errors) },
});
const cookieRead = [{ cookieAuth: [] }];
const cookieWrite = [{ cookieAuth: [], csrfHeader: [] }];
const b2b = [{ apiKey: [] }];
const admin = [{ adminToken: [] }];
const productId = { name: 'productId', in: 'path', required: true, schema: { type: 'string', pattern: '^[a-z0-9-]{1,64}$' } };
const numericId = (name = 'id') => ({ name, in: 'path', required: true, schema: { type: 'integer', minimum: 1 } });
const checkoutSessionQuery = { name: 'session_id', in: 'query', required: true, schema: { type: 'string', pattern: '^[A-Za-z0-9_]{6,200}$' } };

const paths = {
  '/api/health': { get: op({ tags: ['Operations'], summary: 'Liveness probe', operationId: 'getHealth', ok: ref('Health'), errors: [429, 500], statusText: 'Process is live' }) },
  '/api/ready': { get: op({ tags: ['Operations'], summary: 'Dependency and paid-launch readiness', operationId: 'getReadiness', ok: ref('Readiness'), errors: [429, 503], statusText: 'Deployment is ready' }) },
  '/api/openapi': { get: op({ tags: ['Operations'], summary: 'Download this OpenAPI 3.1 contract', operationId: 'getOpenApiContract', ok: ref('Object'), errors: [429, 503], statusText: 'OpenAPI JSON document' }) },
  '/api/meta': { get: op({ tags: ['Public'], summary: 'Product capabilities and provider status', operationId: 'getMetadata', errors: [429, 500] }) },
  '/api/auth/request': { post: op({ tags: ['Authentication'], summary: 'Request a passwordless sign-in link', operationId: 'requestSignInLink', body: request(ref('EmailRequest')), ok: ref('AcceptedDelivery'), status: '202', statusText: 'Request accepted without account enumeration', errors: [400, 429, 500], idempotency: 'server-generated delivery key plus per-address rate limit' }) },
  '/api/auth/request-link': { post: op({ tags: ['Authentication'], summary: 'Compatibility alias: request sign-in link', operationId: 'requestSignInLinkAlias', body: request(ref('EmailRequest')), ok: ref('AcceptedDelivery'), status: '202', errors: [400, 429, 500], idempotency: 'server-generated delivery key plus per-address rate limit', description: 'Alias of POST /api/auth/request. New clients should use the canonical route.' }) },
  '/api/auth/verify': {
    post: op({ tags: ['Authentication'], summary: 'Consume a magic token and establish a browser session', operationId: 'verifySignInToken', body: request(ref('TokenRequest')), ok: ref('Session'), errors: [400, 403, 429, 500], idempotency: 'single-use token', description: 'Requires application/json and a same-origin browser request. Origin/fetch-metadata checks run before token consumption, so a rejected login-CSRF attempt does not burn the link.' }),
  },
  '/api/session': {
    get: op({ tags: ['Authentication'], summary: 'Inspect the current browser session', operationId: 'getSession', security: [], ok: ref('Session'), errors: [429, 500] }),
    delete: op({ tags: ['Authentication'], summary: 'Sign out this session', operationId: 'deleteSession', security: cookieWrite, ok: ref('Session'), errors: [401, 403, 429, 500], idempotency: 'session revocation' }),
  },
  '/api/account': {
    get: op({ tags: ['Account'], summary: 'Get account, preferences, and usage', operationId: 'getAccount', security: cookieRead, errors: [401, 429, 500] }),
    delete: op({ tags: ['Account'], summary: 'Delete and de-identify the account', operationId: 'deleteAccount', security: cookieWrite, body: request(ref('DeleteAccountRequest')), ok: ref('Deleted'), errors: [400, 401, 403, 409, 429, 500], idempotency: 'blocked while billing is active/pending; otherwise one account-deletion transaction' }),
  },
  '/api/account/preferences': { patch: op({ tags: ['Account'], summary: 'Update notification preferences', operationId: 'updatePreferences', security: cookieWrite, body: request(ref('PreferencesPatch')), errors: [400, 401, 403, 429, 500], idempotency: 'last-write-wins patch' }) },
  '/api/account/watchlist': {
    get: op({ tags: ['Watchlist'], summary: 'List saved products', operationId: 'listWatchlist', security: cookieRead, errors: [401, 429, 500] }),
    post: op({ tags: ['Watchlist'], summary: 'Save and schedule a product', operationId: 'addWatchlistProduct', security: cookieWrite, body: request(ref('ProductIdRequest')), status: '201', errors: [400, 401, 403, 404, 429, 500], idempotency: 'unique account and product; collection job uses time-bucket key' }),
  },
  '/api/account/watchlist/{productId}': { delete: op({ tags: ['Watchlist'], summary: 'Remove a saved product', operationId: 'removeWatchlistProduct', security: cookieWrite, parameters: [productId], ok: ref('Deleted'), errors: [401, 403, 404, 429, 500], idempotency: 'delete by unique account and product' }) },
  '/api/account/products/{productId}': { delete: op({ tags: ['Products'], summary: 'Delete an account-owned private search result and its history', operationId: 'deletePrivateProduct', security: cookieWrite, parameters: [productId], ok: ref('Deleted'), errors: [401, 403, 404, 429, 500], idempotency: 'owner-bound cascading deletion' }) },
  '/api/account/alerts': {
    get: op({ tags: ['Alerts'], summary: 'List account alerts and entitlement limit', operationId: 'listAlerts', security: cookieRead, errors: [401, 429, 500] }),
    post: op({ tags: ['Alerts'], summary: 'Create an alert with double opt-in when needed', operationId: 'createAlert', security: cookieWrite, body: request(ref('AlertCreate')), status: '201', errors: [400, 401, 402, 403, 404, 429, 500], idempotency: 'database record plus verification-delivery key' }),
  },
  '/api/account/alerts/{id}': {
    patch: op({ tags: ['Alerts'], summary: 'Change an alert threshold or status', operationId: 'updateAlert', security: cookieWrite, parameters: [numericId()], body: request(ref('AlertPatch')), errors: [400, 401, 403, 404, 429, 500], idempotency: 'last-write-wins patch' }),
    delete: op({ tags: ['Alerts'], summary: 'Delete an alert', operationId: 'deleteAlert', security: cookieWrite, parameters: [numericId()], ok: ref('Deleted'), errors: [401, 403, 404, 429, 500], idempotency: 'delete by account-owned id' }),
  },
  '/api/account/notifications/email/request': { post: op({ tags: ['Alerts'], summary: 'Request email-notification verification', operationId: 'requestEmailVerification', security: cookieWrite, ok: ref('AcceptedDelivery'), status: '202', errors: [401, 403, 429, 500], idempotency: 'server-generated verification-delivery key' }) },
  '/api/notifications/email/verify': {
    post: op({ tags: ['Alerts'], summary: 'Activate email notifications', operationId: 'verifyEmailNotifications', body: request(ref('TokenRequest')), errors: [400, 429, 500], idempotency: 'single-use verification token' }),
  },
  '/api/notifications/email/unsubscribe': {
    post: op({ tags: ['Alerts'], summary: 'Unsubscribe the email channel', operationId: 'unsubscribeEmailNotifications', body: request(ref('TokenRequest')), errors: [400, 429, 500], idempotency: 'signed token sets terminal channel state' }),
  },
  '/api/alerts/unsubscribe': {
    post: op({ tags: ['Alerts'], summary: 'Unsubscribe one alert', operationId: 'unsubscribeAlert', body: request(ref('TokenRequest')), errors: [400, 429, 500], idempotency: 'signed alert token sets terminal alert state' }),
  },
  '/api/account/api-keys': {
    get: op({ tags: ['API keys'], summary: 'List key metadata (never secret material)', operationId: 'listApiKeys', security: cookieRead, errors: [401, 429, 500] }),
    post: op({ tags: ['API keys'], summary: 'Create a once-shown API key', operationId: 'createApiKey', security: cookieWrite, body: request(ref('ApiKeyCreate')), status: '201', ok: ref('ApiKeySecretResponse'), errors: [400, 401, 403, 409, 429, 500], idempotency: 'none; each accepted call creates a new secret' }),
  },
  '/api/account/api-keys/{id}/rotate': { post: op({ tags: ['API keys'], summary: 'Atomically replace and revoke an API key', operationId: 'rotateApiKey', security: cookieWrite, parameters: [numericId()], body: request({ type: 'object', properties: { label: { type: 'string', minLength: 1, maxLength: 100 } } }, false), status: '201', ok: ref('ApiKeySecretResponse'), errors: [400, 401, 403, 404, 429, 500], idempotency: 'none; retry may rotate the newly-created key again, so persist the first response' }) },
  '/api/account/api-keys/{id}': { delete: op({ tags: ['API keys'], summary: 'Revoke an API key', operationId: 'revokeApiKey', security: cookieWrite, parameters: [numericId()], errors: [401, 403, 404, 429, 500], idempotency: 'revocation state transition' }) },
  '/api/account/export': { post: op({ tags: ['Account'], summary: 'Export account-owned data', operationId: 'exportAccount', security: cookieWrite, errors: [401, 403, 429, 500], idempotency: 'read-only snapshot' }) },
  '/api/analyze': { post: op({ tags: ['Public'], summary: 'Analyze a caller-supplied advertised price', operationId: 'analyzePublicPrice', body: request(ref('AnalyzeRequest')), ok: ref('Report'), errors: [400, 413, 429, 500], idempotency: 'pure calculation' }) },
  '/api/products': { get: op({ tags: ['Products'], summary: 'List the bounded curated public catalog', operationId: 'listProducts', parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 50, default: 20 } }, { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 } }], errors: [429, 500] }) },
  '/api/products/{productId}': { get: op({ tags: ['Products'], summary: 'Get a tracked product report and history', operationId: 'getProduct', parameters: [productId, { name: 'days', in: 'query', schema: { type: 'integer', enum: [30, 90], default: 30 } }], errors: [404, 429, 500] }) },
  '/api/history/{productId}': { get: op({ tags: ['Products'], summary: 'Get raw price history and statistics', operationId: 'getProductHistory', parameters: [productId, { name: 'days', in: 'query', schema: { type: 'integer', enum: [30, 90], default: 30 } }], errors: [404, 429, 500] }) },
  '/api/search': { post: op({ tags: ['Products'], summary: 'Search verified sources and analyze; fails closed when no verified price is available', operationId: 'searchPrice', security: [{}, ...cookieRead], body: request(ref('SearchRequest')), errors: [400, 404, 413, 422, 424, 429, 500, 502], idempotency: 'anonymous calls do not persist; signed-in private product ids are deterministic within the owning account' }) },
  '/api/alerts': { post: op({ tags: ['Alerts'], summary: 'Deprecated local-only email alert compatibility', operationId: 'createLegacyAlert', body: request(ref('LegacyAlertCreate')), status: '201', errors: [400, 402, 404, 410, 429, 500], idempotency: 'verification-delivery key in local development', description: 'Retired with HTTP 410 in production. Sign in and use /api/account/alerts so alert ownership, quotas, suppression, and deletion are account-bound.' }) },
  '/api/billing/checkout': { post: op({ tags: ['Billing'], summary: 'Create or reuse an account-owned Stripe Checkout session', operationId: 'createCheckout', security: cookieWrite, body: request(ref('CheckoutRequest')), errors: [400, 401, 403, 409, 429, 500, 502, 503], idempotency: 'durable per-account/plan intent plus Stripe Idempotency-Key; local mock mode also accepts email-only compatibility calls', description: 'Live mode requires cookie authentication, CSRF, acceptTerms=true, and acceptedTermsVersion exactly matching /api/meta legal.termsVersion. The versioned acceptance is recorded before Stripe session creation. Existing or pending API subscriptions must be managed in the portal rather than opening a second subscription.' }) },
  '/api/billing/checkout/status': { get: op({ tags: ['Billing'], summary: 'Poll non-consuming checkout fulfillment status', operationId: 'getCheckoutStatus', security: cookieRead, parameters: [checkoutSessionQuery], ok: ref('CheckoutStatus'), errors: [400, 401, 404, 429, 500], idempotency: 'read-only ownership-bound lookup', description: 'Returns HTTP 202 while the signed webhook has not fulfilled the session. Local mock mode permits an anonymous lookup.' }) },
  '/api/billing/claim': {
    post: op({ tags: ['Billing'], summary: 'Claim a purchased API key exactly once', operationId: 'claimPurchasedKey', security: cookieWrite, body: request(ref('CheckoutClaimRequest')), ok: ref('CheckoutClaimResponse'), errors: [400, 401, 403, 404, 409, 429, 500], idempotency: 'claim-once transaction; HTTP 202 while fulfillment is pending' }),
    get: { ...op({ tags: ['Billing'], summary: 'Deprecated local-mock claim compatibility route', operationId: 'claimPurchasedKeyMockCompatibility', parameters: [checkoutSessionQuery], ok: ref('CheckoutClaimResponse'), errors: [400, 404, 405, 429, 500], idempotency: 'claim-once transaction; disabled outside local mock mode' }), deprecated: true },
  },
  '/api/billing/portal': { post: op({ tags: ['Billing'], summary: 'Create a Stripe customer-portal session', operationId: 'createBillingPortal', security: cookieWrite, body: request(ref('EmailRequest'), false), errors: [400, 401, 403, 404, 429, 500, 502, 503], idempotency: 'Stripe portal session creation; local mock mode permits compatibility email input' }) },
  '/api/billing/webhook': { post: op({ tags: ['Webhooks'], summary: 'Receive signed Stripe lifecycle events', operationId: 'receiveStripeWebhook', security: [{ stripeSignature: [] }], body: { required: true, content: { 'application/json': { schema: ref('Object') } } }, errors: [400, 500, 503], idempotency: 'persistent Stripe event.id deduplication', description: 'The raw request body is verified. Unmapped critical live events are durably reconciled and return a retryable 503.' }) },
  '/api/email/webhook': { post: op({ tags: ['Webhooks'], summary: 'Receive signed Resend delivery events', operationId: 'receiveEmailWebhook', security: [{ svixId: [], svixTimestamp: [], svixSignature: [] }], body: { required: true, content: { 'application/json': { schema: ref('Object') } } }, errors: [400, 500], idempotency: 'persistent svix-id or provider event ID deduplication', description: 'Bounces and complaints suppress the account notification channel. Duplicate provider events return 200.' }) },
  '/api/admin/keys': { post: op({ tags: ['Admin'], summary: 'Operator-only API key creation', operationId: 'adminCreateApiKey', security: admin, body: request(ref('ApiKeyCreate')), status: '201', ok: ref('ApiKeySecretResponse'), errors: [400, 403, 429, 500], idempotency: 'none; operator must store the once-shown response' }) },
  '/api/admin/metrics': { get: op({ tags: ['Admin'], summary: 'Operational usage and revenue snapshot', operationId: 'getAdminMetrics', security: admin, errors: [403, 429, 500] }) },
  '/api/v1/analyze': { post: op({ tags: ['B2B v1'], summary: 'Analyze an advertised price', operationId: 'analyzePriceV1', security: b2b, body: request(ref('AnalyzeRequest')), ok: { allOf: [ref('Report'), { type: 'object', required: ['usage'], properties: { usage: ref('Usage') } }] }, errors: [400, 401, 413, 429, 500], idempotency: 'pure calculation' }) },
  '/api/v1/track': { post: op({ tags: ['B2B v1'], summary: 'Append an operator-authorized canonical price observation', operationId: 'trackPriceV1', security: b2b, body: request(ref('TrackRequest')), status: '201', errors: [400, 401, 403, 404, 422, 429, 500], idempotency: 'none; operator ingestion clients should deduplicate upstream observation IDs', description: 'Canonical public-history ingestion requires an operator-issued API key with can_write_history scope. Ordinary customer API keys are read/analyze-only and receive 403, preventing tenant data from poisoning shared public history.' }) },
  '/api/v1/products/{productId}': { get: op({ tags: ['B2B v1'], summary: 'Read a tracked product and history', operationId: 'getProductV1', security: b2b, parameters: [productId], errors: [401, 404, 429, 500] }) },
  '/api/v1/usage': { get: op({ tags: ['B2B v1'], summary: 'Read API usage (this request is metered)', operationId: 'getUsageV1', security: b2b, ok: { type: 'object', required: ['usage'], properties: { usage: ref('Usage') } }, errors: [401, 429, 500] }) },
};

// Email links land directly on SPA paths with the token in the URL fragment.
// Only these POST endpoints consume capabilities; API query-token bridges are
// intentionally omitted so bearer values never appear in access logs.
paths['/api/billing/checkout/status'].get.responses['202'] = jsonResponse('Webhook fulfillment is still pending', ref('CheckoutStatus'));
paths['/api/billing/claim'].post.responses['202'] = jsonResponse('Webhook fulfillment is still pending', ref('CheckoutStatus'));

const dailyHeaders = {
  'X-DailyLimit-Limit': { $ref: '#/components/headers/DailyLimitLimit' },
  'X-DailyLimit-Remaining': { $ref: '#/components/headers/DailyLimitRemaining' },
};
for (const [route, item] of Object.entries(paths)) {
  if (!route.startsWith('/api/v1/')) continue;
  for (const operation of Object.values(item)) {
    for (const response of Object.values(operation.responses)) response.headers = { ...(response.headers || {}), ...dailyHeaders };
  }
}

const spec = {
  openapi: '3.1.0',
  info: {
    title: 'PriceTruth API', version: '1.0.0',
    summary: 'All-in price analysis, tracked history, accounts, alerts, billing, and B2B access.',
    description: 'Money is integer USD cents. Public browser APIs are unversioned and evolve with the web app. Contracted B2B APIs are under /api/v1. Mutations document their actual x-idempotency strategy; PriceTruth does not accept a generic Idempotency-Key header unless an operation explicitly says so.',
  },
  servers: [{ url: 'http://localhost:4780', description: 'Local development' }, { url: '{origin}', description: 'Deployed HTTPS origin', variables: { origin: { default: 'https://pricetruth.example' } } }],
  tags: ['Operations', 'Public', 'Authentication', 'Account', 'Watchlist', 'Alerts', 'API keys', 'Products', 'Billing', 'Webhooks', 'Admin', 'B2B v1'].map((name) => ({ name })),
  paths,
  components: {
    securitySchemes: {
      cookieAuth: { type: 'apiKey', in: 'cookie', name: 'pt_session', description: 'Opaque, HttpOnly, SameSite=Lax session token. Only its SHA-256 hash is stored.' },
      csrfHeader: { type: 'apiKey', in: 'header', name: 'X-CSRF-Token', description: 'Required with cookie-authenticated mutations; must match the pt_csrf cookie and same-origin check.' },
      apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
      adminToken: { type: 'apiKey', in: 'header', name: 'X-Admin-Token' },
      stripeSignature: { type: 'apiKey', in: 'header', name: 'Stripe-Signature' },
      svixId: { type: 'apiKey', in: 'header', name: 'svix-id' },
      svixTimestamp: { type: 'apiKey', in: 'header', name: 'svix-timestamp' },
      svixSignature: { type: 'apiKey', in: 'header', name: 'svix-signature' },
    },
    headers: {
      RequestId: { description: 'Server-generated or validated caller correlation id.', schema: { type: 'string', pattern: '^[A-Za-z0-9._:-]{8,100}$' } },
      RateLimitLimit: { description: 'Token-bucket capacity for this route.', schema: { type: 'integer', minimum: 1 } },
      RateLimitRemaining: { description: 'Whole request tokens remaining.', schema: { type: 'integer', minimum: 0 } },
      RateLimitReset: { description: 'Seconds until the bucket is full.', schema: { type: 'integer', minimum: 1 } },
      DailyLimitLimit: { description: 'Authenticated key daily UTC quota.', schema: { type: 'integer', enum: [100, 10000] } },
      DailyLimitRemaining: { description: 'Requests left in the current UTC quota day.', schema: { type: 'integer', minimum: 0 } },
    },
    schemas: {
      Object: { type: 'object', additionalProperties: true },
      Cents: { type: 'integer', minimum: 0, maximum: 1000000000, description: 'USD cents; never a floating-point dollar amount.' },
      Vertical: { type: 'string', enum: ['hotel', 'flight', 'ticket', 'subscription', 'retail'] },
      Certainty: { type: 'string', enum: ['listed', 'catalog', 'typical', 'estimated'] },
      Money: { type: 'object', required: ['amount_cents', 'unit'], properties: { amount_cents: ref('Cents'), unit: { type: 'string' } }, additionalProperties: false },
      LineItem: { type: 'object', required: ['code', 'label', 'amount_cents', 'kind', 'certainty'], properties: { code: { type: 'string' }, label: { type: 'string' }, amount_cents: ref('Cents'), kind: { type: 'string', enum: ['base', 'fee', 'tax', 'addon'] }, certainty: ref('Certainty'), note: { type: 'string' } }, additionalProperties: false },
      UnknownCost: { type: 'object', required: ['code', 'label', 'reason'], properties: { code: { type: 'string' }, label: { type: 'string' }, reason: { type: 'string' } }, additionalProperties: false },
      Completeness: { type: 'object', required: ['status', 'unknownCosts'], properties: { status: { type: 'string', enum: ['complete', 'partial'] }, unknownCosts: { type: 'array', items: ref('UnknownCost') } }, additionalProperties: false },
      Report: { type: 'object', required: ['vertical', 'currency', 'advertised', 'truePrice', 'lineItems', 'feeLoadPct', 'confidence', 'completeness', 'assumptions', 'disclosures'], properties: { vertical: ref('Vertical'), currency: { const: 'USD' }, advertised: ref('Money'), truePrice: { allOf: [ref('Money')], description: 'Evidence-backed total when completeness.status is complete; otherwise the known priced subtotal. Never interpret a partial report as a guaranteed checkout total.' }, total: { type: ['object', 'null'], properties: { amount_cents: ref('Cents'), label: { type: 'string' } }, required: ['amount_cents', 'label'] }, priceInclusion: { type: 'object', properties: { mandatoryFeesIncluded: { type: ['boolean', 'null'] }, taxesIncluded: { type: ['boolean', 'null'] }, basis: { type: ['string', 'null'] }, evidence: { type: ['string', 'null'] } }, additionalProperties: false }, lineItems: { type: 'array', items: ref('LineItem') }, feeLoadPct: { type: 'number' }, confidence: { type: 'number', minimum: 0, maximum: 1 }, completeness: ref('Completeness'), assumptions: { type: 'array', items: { type: 'string' } }, disclosures: { type: 'array', items: { type: 'string' } } }, additionalProperties: true },
      AnalyzeRequest: { type: 'object', required: ['vertical', 'advertised_cents'], properties: { vertical: ref('Vertical'), advertised_cents: ref('Cents'), context: { type: 'object', maxProperties: 50, additionalProperties: true } }, additionalProperties: false },
      SearchRequest: { type: 'object', required: ['vertical', 'q'], properties: { vertical: ref('Vertical'), q: { type: 'string', minLength: 2, maxLength: 120 } }, additionalProperties: false },
      TrackRequest: { type: 'object', required: ['product_id', 'advertised_cents'], properties: { product_id: { type: 'string', pattern: '^[a-z0-9-]{1,64}$' }, advertised_cents: ref('Cents') }, additionalProperties: false },
      Usage: { type: 'object', required: ['used_today', 'daily_limit', 'tier'], properties: { used_today: { type: 'integer', minimum: 1 }, daily_limit: { type: 'integer', enum: [100, 10000] }, tier: { type: 'string', enum: ['starter', 'pro'] } }, additionalProperties: false },
      Error: { type: 'object', required: ['error', 'code', 'requestId'], properties: { error: { type: 'string' }, code: { type: 'string', enum: ['INVALID_REQUEST', 'AUTH_REQUIRED', 'PAYMENT_REQUIRED', 'FORBIDDEN', 'NOT_FOUND', 'REQUEST_TIMEOUT', 'CONFLICT', 'GONE', 'PAYLOAD_TOO_LARGE', 'UNPROCESSABLE', 'RATE_LIMITED', 'CAPABILITY_UNAVAILABLE', 'VERTICAL_UNAVAILABLE', 'PRIVATE_PRODUCT_LIMIT', 'SERVICE_UNAVAILABLE', 'INTERNAL_ERROR'] }, requestId: { type: 'string' } }, additionalProperties: true },
      Health: { type: 'object', required: ['ok', 'version', 'uptimeSeconds'], properties: { ok: { const: true }, version: { type: 'string' }, uptimeSeconds: { type: 'integer', minimum: 0 } }, additionalProperties: false },
      Readiness: { type: 'object', required: ['ok', 'version', 'database', 'email', 'paidLaunch', 'dataSources', 'capabilities', 'worker', 'checkedAt'], properties: { ok: { type: 'boolean' }, version: { type: 'string' }, database: ref('Object'), email: ref('Object'), paidLaunch: ref('Object'), dataSources: ref('Object'), capabilities: ref('Object'), productionSafety: ref('Object'), webhooks: ref('Object'), worker: ref('Object'), checkedAt: { type: 'string', format: 'date-time' } }, additionalProperties: true },
      EmailRequest: { type: 'object', required: ['email'], properties: { email: { type: 'string', format: 'email', maxLength: 254 } }, additionalProperties: false },
      TokenRequest: { type: 'object', required: ['token'], properties: { token: { type: 'string', minLength: 32, maxLength: 256, pattern: '^[A-Za-z0-9_-]+$' } }, additionalProperties: false },
      Session: { type: 'object', required: ['authenticated'], properties: { authenticated: { type: 'boolean' }, csrfToken: { type: 'string', writeOnly: true }, account: ref('Object') }, additionalProperties: false },
      AcceptedDelivery: { type: 'object', required: ['accepted', 'delivery'], properties: { accepted: { const: true }, delivery: { type: 'object', required: ['status'], properties: { status: { type: 'string', enum: ['sent', 'queued', 'disabled', 'failed'] } } }, message: { type: 'string' } }, additionalProperties: true },
      PreferencesPatch: { type: 'object', minProperties: 1, properties: { email_alerts: { type: 'boolean' }, weekly_digest: { type: 'boolean' }, timezone: { type: 'string', minLength: 1, maxLength: 100 } }, additionalProperties: false },
      ProductIdRequest: { type: 'object', required: ['product_id'], properties: { product_id: { type: 'string', pattern: '^[a-z0-9-]{1,64}$' } }, additionalProperties: false },
      AlertCreate: { type: 'object', required: ['product_id', 'threshold_cents'], properties: { product_id: { type: 'string', pattern: '^[a-z0-9-]{1,64}$' }, threshold_cents: ref('Cents') }, additionalProperties: false },
      LegacyAlertCreate: { allOf: [ref('AlertCreate'), { type: 'object', required: ['email'], properties: { email: { type: 'string', format: 'email' } } }] },
      AlertPatch: { type: 'object', minProperties: 1, properties: { threshold_cents: ref('Cents'), status: { type: 'string', enum: ['active', 'paused'] } }, additionalProperties: false },
      ApiKeyCreate: { type: 'object', required: ['label'], properties: { label: { type: 'string', minLength: 1, maxLength: 100 }, tier: { type: 'string', enum: ['starter', 'pro'], default: 'starter' } }, additionalProperties: false },
      ApiKeyRecord: { type: 'object', required: ['id', 'prefix', 'label', 'tier', 'created_at'], properties: { id: { type: 'integer' }, prefix: { type: 'string' }, label: { type: 'string' }, tier: { type: 'string', enum: ['starter', 'pro'] }, suspended: { type: 'boolean', description: 'Temporarily unauthenticatable while payment is past due; may resume after payment succeeds.' }, created_at: { type: 'string', format: 'date-time' }, last_used_at: { type: ['string', 'null'], format: 'date-time' }, revoked_at: { type: ['string', 'null'], format: 'date-time' } }, additionalProperties: true },
      ApiKeySecretResponse: { type: 'object', required: ['key'], properties: { key: { type: 'string', pattern: '^pt_(?:starter|pro)_[A-Za-z0-9_-]+$', writeOnly: true }, record: ref('ApiKeyRecord'), note: { type: 'string' } }, additionalProperties: true },
      CheckoutRequest: { type: 'object', required: ['planId'], properties: { planId: { type: 'string', enum: ['premium', 'api_starter', 'api_pro'] }, email: { type: 'string', format: 'email', description: 'Local mock compatibility only; live checkout uses the authenticated account.' }, acceptTerms: { type: 'boolean', description: 'Must be true in live mode.' }, acceptedTermsVersion: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$', description: 'Must exactly equal /api/meta legal.termsVersion in live mode.' } }, additionalProperties: false },
      CheckoutClaimRequest: { type: 'object', required: ['session_id'], properties: { session_id: { type: 'string', pattern: '^[A-Za-z0-9_]{6,200}$' } }, additionalProperties: false },
      CheckoutStatus: { type: 'object', required: ['status', 'complete', 'claimable', 'plan', 'tier'], properties: { status: { type: 'string', enum: ['pending', 'complete', 'claimable', 'claimed'] }, complete: { type: 'boolean' }, claimable: { type: 'boolean' }, plan: { type: ['string', 'null'], enum: ['premium', 'api_starter', 'api_pro', null] }, tier: { type: ['string', 'null'], enum: ['starter', 'pro', null] } }, additionalProperties: false },
      CheckoutClaimResponse: { type: 'object', required: ['key', 'tier', 'status'], properties: { key: { type: 'string', pattern: '^pt_(?:starter|pro)_[A-Za-z0-9_-]+$', writeOnly: true }, tier: { type: 'string', enum: ['starter', 'pro'] }, plan: { type: 'string', enum: ['api_starter', 'api_pro'] }, status: { const: 'claimed' }, note: { type: 'string' } }, additionalProperties: false },
      DeleteAccountRequest: { type: 'object', required: ['confirm'], properties: { confirm: { const: 'DELETE' } }, additionalProperties: false },
      Deleted: { type: 'object', properties: { deleted: { type: 'boolean' }, revoked: { type: 'boolean' } }, minProperties: 1, additionalProperties: false },
    },
  },
};

const out = path.join(ROOT, 'openapi');
const target = path.join(out, 'openapi.json');
const generated = JSON.stringify(spec, null, 2) + '\n';
if (process.argv.includes('--check')) {
  const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
  if (current !== generated) {
    console.error('OpenAPI artifact is stale. Run `node scripts/generate-openapi.mjs`.');
    process.exitCode = 1;
  } else console.log(`OpenAPI artifact matches generator (${Object.keys(paths).length} paths).`);
} else {
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(target, generated);
  console.log(`Generated ${Object.keys(paths).length}-path OpenAPI contract.`);
}
