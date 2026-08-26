# Webhook security, retries, and reconciliation

## Stripe

Configure the production endpoint as `POST /api/billing/webhook` and subscribe
to this exact allowlist:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.async_payment_failed`
- `checkout.session.expired`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `customer.subscription.paused`
- `customer.subscription.resumed`
- `invoice.paid`
- `invoice.payment_succeeded`
- `invoice.payment_failed`
- `charge.refunded`
- `charge.dispute.created`
- `charge.dispute.updated`
- `charge.dispute.closed`
- `refund.created`
- `refund.updated`
- `refund.failed`

The application verifies the raw body against `Stripe-Signature` and
`STRIPE_WEBHOOK_SECRET` before JSON is trusted. Event IDs are stored durably;
duplicates return 200 without reapplying revenue, entitlements, or once-shown
keys. `invoice.paid` and `invoice.payment_succeeded` are both accepted, while
cash is recognized once per immutable invoice ID.

Use a dedicated Stripe account/catalog for PriceTruth, or an equivalently
isolated endpoint that cannot receive another product's lifecycle. Live
subscription/invoice fulfillment is authorized by the configured Stripe Price
IDs, linked customer, account metadata, and owned checkout intent—not by
mutable email or metadata plan labels. A critical event containing a foreign or
ambiguous recurring Price is recorded for billing reconciliation and returns a
retryable failure; readiness remains failed until an operator reconciles it.
This fail-closed behavior prevents foreign catalog activity from granting or
revoking PriceTruth access, but it also means a shared Stripe catalog can block
deployments and should not be used.

Signed but non-actionable `invoice.*`, `customer.subscription.*`, and
`refund.*` variants outside the allowlist are acknowledged as informational
and ignored. Do not subscribe to them merely because they return 200.

Return 2xx only after the event is safely recorded/applied. Stripe retries
non-2xx deliveries; the route is exempt from public rate limiting. Reconcile
Stripe subscriptions/invoices against local entitlements daily and after any
webhook outage. Preserve event IDs and request IDs, never payload secrets, in
incident tickets.

## Resend/Svix

Configure `POST /api/email/webhook` with the provider-issued signing secret.
Verification uses the raw body and `svix-id`, `svix-timestamp`, and
`svix-signature` headers. The verifier rejects stale/tampered deliveries.
Provider event IDs are persisted so retries are safe. Bounce and complaint
events suppress the matching notification channel.

The delivery webhook is not proof that a person read an email. Track accepted,
delivered, bounced, and complained states separately. Never reactivate a
suppressed address automatically.

## Rotation

Rotate webhook secrets by creating a new provider endpoint/secret, deploy the
new secret, send and verify a test event, switch production delivery, then
retire the old endpoint. If a provider supports overlapping secrets, use that
window; the app currently accepts one configured secret per provider, so avoid
changing the secret before the matching deployment is ready.
