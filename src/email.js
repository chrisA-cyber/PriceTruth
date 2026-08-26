import crypto from 'node:crypto';

const isProduction = () => process.env.NODE_ENV === 'production';
const text = (value) => String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
const escapeHtml = (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');

function encryptionKey() {
  const configured = process.env.OUTBOX_ENCRYPTION_KEY;
  if (configured) return crypto.createHash('sha256').update(configured, 'utf8').digest();
  // Local development gets process-local encryption rather than plaintext at
  // rest. Production readiness fails until an explicit stable key is supplied.
  return crypto.randomBytes(32);
}

function encrypt(key, payload) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return { ciphertext: ciphertext.toString('base64url'), iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') };
}

function decrypt(key, record) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(record.payload_iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(record.payload_tag, 'base64url'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(record.payload_ciphertext, 'base64url')), decipher.final()]).toString('utf8'));
}

function render(template, data) {
  const appName = 'PriceTruth';
  if (template === 'magic-link') {
    const link = text(data.link);
    return {
      subject: 'Sign in to PriceTruth',
      text: `Use this secure, one-time link to sign in to ${appName}: ${link}\n\nIt expires in 15 minutes. If you did not request it, ignore this message.`,
      html: `<p>Use this secure, one-time link to sign in to ${appName}:</p><p><a href="${escapeHtml(link)}">Sign in to PriceTruth</a></p><p>This link expires in 15 minutes. If you did not request it, ignore this message.</p>`,
    };
  }
  if (template === 'verify-alerts') {
    const verify = text(data.verifyLink);
    const unsubscribe = text(data.unsubscribeLink);
    return {
      subject: 'Confirm PriceTruth price alerts',
      text: `Confirm email price alerts: ${verify}\n\nIf you did not request alerts, unsubscribe here: ${unsubscribe}`,
      html: `<p>Confirm that you want PriceTruth price alerts:</p><p><a href="${escapeHtml(verify)}">Confirm price alerts</a></p><p>If you did not request this, <a href="${escapeHtml(unsubscribe)}">unsubscribe</a>.</p>`,
    };
  }
  if (template === 'price-alert') {
    const link = text(data.productLink);
    const unsubscribe = text(data.unsubscribeLink);
    return {
      subject: `Price alert: ${text(data.productName).slice(0, 100)}`,
      text: `${text(data.productName)} reached ${text(data.truePrice)} in ${text(data.provenanceLabel || 'a verified price source')}. Review the evidence: ${link}\n\nUnsubscribe: ${unsubscribe}`,
      html: `<p><strong>${escapeHtml(data.productName)}</strong> reached ${escapeHtml(data.truePrice)} in ${escapeHtml(data.provenanceLabel || 'a verified price source')}.</p><p><a href="${escapeHtml(link)}">Review the evidence</a></p><p><a href="${escapeHtml(unsubscribe)}">Unsubscribe</a></p>`,
    };
  }
  if (template === 'weekly-digest') {
    const items = Array.isArray(data.items) ? data.items.slice(0, 20) : [];
    const unsubscribe = text(data.unsubscribeLink);
    const textItems = items.length
      ? items.map((entry) => `- ${text(entry.name).slice(0, 120)}: ${text(entry.currentPrice || 'No recent observation')} ${text(entry.link)}`).join('\n')
      : '- Your watchlist has no recent observations yet.';
    const htmlItems = items.length
      ? `<ul>${items.map((entry) => `<li><a href="${escapeHtml(text(entry.link))}">${escapeHtml(text(entry.name).slice(0, 120))}</a>: ${escapeHtml(text(entry.currentPrice || 'No recent observation'))}</li>`).join('')}</ul>`
      : '<p>Your watchlist has no recent observations yet.</p>';
    return {
      subject: 'Your weekly PriceTruth watchlist digest',
      text: `Here is this week's verified watchlist summary:\n\n${textItems}\n\nThese are the latest stored observations, not guaranteed offers. Unsubscribe: ${unsubscribe}`,
      html: `<p>Here is this week's verified watchlist summary:</p>${htmlItems}<p>These are the latest stored observations, not guaranteed offers.</p><p><a href="${escapeHtml(unsubscribe)}">Unsubscribe from email updates</a></p>`,
    };
  }
  throw new Error(`unknown email template: ${template}`);
}

function resolveTransport() {
  const selected = process.env.EMAIL_TRANSPORT;
  if (selected === 'memory') return 'memory';
  if (selected === 'console') return isProduction() ? 'disabled' : 'console';
  if (selected === 'resend' || (!selected && process.env.RESEND_API_KEY)) {
    return process.env.RESEND_API_KEY && process.env.EMAIL_FROM ? 'resend' : 'disabled';
  }
  return isProduction() ? 'disabled' : 'console';
}

function createMailer(db, { deliveryGuard = null } = {}) {
  const key = encryptionKey();
  const delivered = [];

  async function deliver(record) {
    const payload = decrypt(key, record);
    const rendered = render(record.template, payload);
    const transport = resolveTransport();
    if (transport === 'disabled') {
      const error = new Error('transactional email is not configured');
      error.retryable = false;
      throw error;
    }
    if (transport === 'memory') {
      const id = `memory_${crypto.randomBytes(8).toString('hex')}`;
      delivered.push({ id, to: record.to_email, template: record.template, payload, ...rendered });
      return id;
    }
    if (transport === 'console') {
      const id = `console_${crypto.randomBytes(8).toString('hex')}`;
      // Development-only transport. Never selected implicitly in production.
      console.info(`[email:dev] to=${record.to_email} subject=${rendered.subject}\n${rendered.text}`);
      delivered.push({ id, to: record.to_email, template: record.template, payload, ...rendered });
      return id;
    }
    const timeoutMs = Math.min(30_000, Math.max(1_000, Number(process.env.EMAIL_TIMEOUT_MS) || 10_000));
    let response;
    try {
      response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': record.idempotency_key || record.id },
        body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [record.to_email], subject: rendered.subject, text: rendered.text, html: rendered.html }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const wrapped = new Error(`email provider request failed: ${error?.name === 'TimeoutError' ? 'timeout' : 'network error'}`);
      wrapped.retryable = true;
      throw wrapped;
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok || typeof body.id !== 'string') {
      const error = new Error(`email provider rejected delivery (${response.status})`);
      error.status = response.status;
      error.retryable = response.ok || [408, 409, 429].includes(response.status) || response.status >= 500;
      throw error;
    }
    return body.id;
  }

  async function processPending(limit = 10) {
    const items = db.claimOutbox(limit);
    const results = [];
    for (const item of items) {
      const metadata = (() => { try { return JSON.parse(item.metadata_json || '{}'); } catch { return {}; } })();
      try {
        if (!db.isNotificationDeliveryAllowed(item.account_id, item.template, metadata)) {
          db.cancelNotificationOutbox(item.account_id, [item.template]);
          if (item.template === 'price-alert') db.releaseAlertTrigger(metadata.alertId, metadata.triggerKey);
          results.push({ id: item.id, status: 'canceled' });
          continue;
        }
        if (deliveryGuard && !await deliveryGuard({ record: item, metadata })) {
          db.cancelOutbox(item.id, 'delivery freshness gate failed');
          if (item.template === 'price-alert') db.releaseAlertTrigger(metadata.alertId, metadata.triggerKey);
          results.push({ id: item.id, status: 'canceled' });
          continue;
        }
        const messageId = await deliver(item);
        const markedSent = db.transaction(() => {
          if (!db.markOutboxSent(item.id, messageId)) return false;
          if (item.template === 'price-alert') db.confirmAlertDelivery(metadata.alertId, metadata.triggerKey);
          db.recordDeliveryEvent({ outboxId: item.id, provider: resolveTransport(), providerMessageId: messageId, type: 'sent' });
          return true;
        });
        if (markedSent) {
          results.push({ id: item.id, status: 'sent', providerMessageId: messageId });
        } else results.push({ id: item.id, status: 'canceled' });
      } catch (error) {
        const retryable = error?.retryable !== false;
        const exhaustedAlert = retryable && item.template === 'price-alert' && item.attempts >= item.max_attempts;
        if (exhaustedAlert) db.redriveAlertOutbox(item.id, `${error.message}; retained for automatic redrive`);
        else if (!retryable) db.failOutboxTerminal(item.id, error.message);
        else db.markOutboxFailed(item.id, error.message);
        const latest = db.getOutbox(item.id);
        if (item.template === 'price-alert' && latest?.status === 'failed') {
          db.releaseAlertTrigger(metadata.alertId, metadata.triggerKey);
        }
        results.push({ id: item.id, status: latest?.status || 'failed', error: error.message });
      }
    }
    return results;
  }

  function prepare({ accountId = null, to, template, data, metadata = {}, idempotencyKey = null }) {
    const sealed = encrypt(key, data);
    return { accountId, toEmail: to, template, metadata, ...sealed, idempotencyKey };
  }

  async function complete(record, { sendNow = true } = {}) {
    if (sendNow && ['pending', 'retry'].includes(record.status)) await processPending(10);
    const latest = db.getOutbox(record.id);
    return { id: latest.id, status: latest.status, attempts: latest.attempts, providerMessageId: latest.provider_message_id || null };
  }

  async function enqueue({ sendNow = true, ...message }) {
    const record = db.enqueueOutbox(prepare(message));
    return complete(record, { sendNow });
  }

  function readiness() {
    const transport = resolveTransport();
    return {
      ok: transport !== 'disabled' && (!isProduction() || Boolean(process.env.OUTBOX_ENCRYPTION_KEY)),
      transport,
      durableEncryption: Boolean(process.env.OUTBOX_ENCRYPTION_KEY),
      reason: transport === 'disabled' ? 'set RESEND_API_KEY and EMAIL_FROM' : (!process.env.OUTBOX_ENCRYPTION_KEY && isProduction() ? 'set OUTBOX_ENCRYPTION_KEY' : null),
    };
  }

  return { prepare, complete, enqueue, processPending, readiness, delivered, transport: resolveTransport };
}

// Resend signs delivery webhooks using the Standard Webhooks/Svix envelope.
// Verify exact raw bytes before parsing; accept key rotation (multiple v1
// signatures) and reject stale replays.
function verifyDeliveryWebhook(rawBody, headers, secret = process.env.RESEND_WEBHOOK_SECRET, toleranceSec = 300) {
  if (!secret) { const error = new Error('email webhook secret not configured'); error.status = 500; throw error; }
  const id = headers['svix-id'] || headers['webhook-id'];
  const timestamp = headers['svix-timestamp'] || headers['webhook-timestamp'];
  const signatures = headers['svix-signature'] || headers['webhook-signature'];
  if (typeof id !== 'string' || typeof timestamp !== 'string' || typeof signatures !== 'string') { const error = new Error('missing email webhook signature'); error.status = 400; throw error; }
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds) || Math.abs(Math.floor(Date.now() / 1000) - seconds) > toleranceSec) { const error = new Error('email webhook timestamp outside tolerance'); error.status = 400; throw error; }
  let key;
  try { key = secret.startsWith('whsec_') ? Buffer.from(secret.slice(6), 'base64') : Buffer.from(secret, 'utf8'); } catch { key = Buffer.from(secret, 'utf8'); }
  const expected = crypto.createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`, 'utf8').digest('base64');
  const valid = signatures.split(/\s+/).some((item) => {
    const candidate = item.startsWith('v1,') ? item.slice(3) : item.startsWith('v1=') ? item.slice(3) : '';
    if (!candidate) return false;
    const a = Buffer.from(expected), b = Buffer.from(candidate);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
  if (!valid) { const error = new Error('email webhook signature verification failed'); error.status = 400; throw error; }
  try { return JSON.parse(rawBody); } catch { const error = new Error('invalid email webhook JSON'); error.status = 400; throw error; }
}

export { createMailer, render, encrypt, decrypt, resolveTransport, verifyDeliveryWebhook };
