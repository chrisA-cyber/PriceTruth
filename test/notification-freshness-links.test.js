import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/server.js';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

async function close(server) {
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  });
}

describe('notification freshness and report links', () => {
  it('uses real SPA report URLs and suppresses expired live quotes at send and read time', async () => {
    const realNow = Date.now;
    const saved = {
      transport: process.env.EMAIL_TRANSPORT,
      worker: process.env.DISABLE_WORKER,
      publicBase: process.env.PUBLIC_BASE_URL,
    };
    process.env.EMAIL_TRANSPORT = 'memory';
    process.env.DISABLE_WORKER = '1';
    process.env.PUBLIC_BASE_URL = 'https://app.launch-operator.com';
    const baseNow = realNow();
    Date.now = () => baseNow;

    const app = await createApp({ dbPath: ':memory:' });
    const base = await listen(app.server);
    try {
      const account = app.db.verifyAccount(app.db.getOrCreateAccount('freshness-links@launch-operator.com').id);
      app.db.updatePreferences(account.id, { email_alerts: true, weekly_digest: true, timezone: 'UTC' });
      app.db.upsertEntitlement({ accountId: account.id, product: 'premium', status: 'active', sourceRef: 'sub_freshness_links', eventCreated: 1 });
      app.db.syncAccountPlan(account.id);
      const verification = app.db.createNotificationVerification(account.id);
      app.db.verifyNotification(verification.verifyToken);

      const pointAt = new Date(baseNow - 1000).toISOString();
      const provenance = {
        source: 'live:retail-feed', sourceLabel: 'Verified retail feed', evidenceType: 'provider_quote',
        observed: true, fetchedAt: pointAt, asOf: pointAt, maxAgeSeconds: 3600,
        ageSeconds: 0, stale: false, alertEligible: true,
      };
      app.db.upsertProduct({
        id: 'live-retail-watch', vertical: 'retail', name: 'Live retail watch', advertised_cents: 1999,
        source: provenance.source, sourceLabel: provenance.sourceLabel, certainty: 'live', fetchedAt: pointAt,
        context: { shipping_cents: 0, handling_cents: 0, taxPct: 0 },
        evidence: { refreshable: true, providerIdentity: 'retail:watch-1', originalQuery: 'live retail watch', alertEligible: true, pricingComplete: true, provenance },
      });
      app.db.addPricePoint('live-retail-watch', {
        ts: pointAt, advertised_cents: 1999, true_cents: 1999, source: provenance.source,
        sourceLabel: provenance.sourceLabel, certainty: 'live', observed: true, alertEligible: true,
        fetchedAt: pointAt, evidence: { provenance }, providerKey: 'retail:watch-1',
      });
      app.db.addWatchlist(account.id, 'live-retail-watch');
      const alert = app.db.createAlert({
        email: account.email, accountId: account.id, productId: 'live-retail-watch', threshold_cents: 2200, status: 'active',
      });

      const alertJob = app.db.enqueueJob('evaluate-alerts', {
        productId: 'live-retail-watch', trueCents: 1999, pointAt, eligible: true, stale: false,
      }, { idempotencyKey: 'evaluate-live-retail-watch' });
      const originalPrepare = app.mailer.prepare;
      app.mailer.prepare = (message) => {
        if (message.template === 'price-alert') throw new Error('simulated alert outbox failure');
        return originalPrepare(message);
      };
      const failedAttempt = await app.worker.tick();
      assert.equal(failedAttempt.find((result) => result.id === alertJob.id).status, 'failed');
      const rolledBackAlert = app.db.getAlert(alert.id, account.id);
      assert.equal(Boolean(rolledBackAlert.condition_active), false);
      assert.equal(rolledBackAlert.last_notified_at, null);
      assert.equal(app.db.raw.prepare("SELECT COUNT(*) n FROM outbox WHERE template='price-alert'").get().n, 0);
      assert.equal(app.db.raw.prepare('SELECT COUNT(*) n FROM alert_unsubscribe_tokens WHERE alert_id=?').get(alert.id).n, 0);

      app.mailer.prepare = originalPrepare;
      app.db.raw.prepare("UPDATE jobs SET status='retry',available_at=? WHERE id=?").run(new Date(0).toISOString(), alertJob.id);
      const retry = await app.worker.tick();
      assert.equal(retry.find((result) => result.id === alertJob.id).status, 'completed');
      const alertMail = app.mailer.delivered.find((item) => item.template === 'price-alert');
      assert.equal(alertMail.payload.productLink, 'https://app.launch-operator.com/p/live-retail-watch');
      assert.ok(alert.id > 0);

      app.db.enqueueJob('weekly-digest', { accountId: account.id, week: '2026-W35' }, { idempotencyKey: 'weekly:fresh' });
      await app.worker.tick();
      const digest = app.mailer.delivered.find((item) => item.template === 'weekly-digest');
      assert.equal(digest.payload.items[0].link, 'https://app.launch-operator.com/p/live-retail-watch');

      app.db.evaluateAlertCondition(alert.id, 3000, 'reset-above', new Date(baseNow).toISOString());
      const ingestionKey = app.db.createApiKey('notification-ingestion', 'starter', { canWriteHistory: true });
      const tracked = await fetch(`${base}/api/v1/track`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': ingestionKey },
        body: JSON.stringify({ product_id: 'live-retail-watch', advertised_cents: 1899 }),
      });
      assert.equal(tracked.status, 201);
      await app.worker.tick();
      const alertMails = app.mailer.delivered.filter((item) => item.template === 'price-alert');
      assert.equal(alertMails.length, 2, 'operator ingestion must evaluate active thresholds');
      assert.equal(alertMails.at(-1).payload.productLink, 'https://app.launch-operator.com/p/live-retail-watch');

      Date.now = () => baseNow + 2 * 60 * 60_000 + 1000;
      const deliveredBeforeStaleDigest = app.mailer.delivered.length;
      app.db.enqueueJob('weekly-digest', { accountId: account.id, week: '2026-W36' }, { idempotencyKey: 'weekly:stale' });
      await app.worker.tick();
      assert.equal(app.mailer.delivered.length, deliveredBeforeStaleDigest, 'an expired quote must not appear in a later digest');

      const response = await fetch(`${base}/api/products/live-retail-watch?days=30`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.provenance.evidence.provenance.stale, true);
      assert.equal(body.alertEligible, false);
      assert.equal(body.stats, null);
      assert.equal(body.history[0].alertEligible, false);
      assert.equal(body.history[0].evidence.provenance.stale, true);

      const rawHistory = await (await fetch(`${base}/api/history/live-retail-watch?days=30`)).json();
      assert.equal(rawHistory.stats, null);
      assert.equal(rawHistory.points[0].alertEligible, false);
      assert.equal(rawHistory.points[0].evidence.provenance.stale, true);
    } finally {
      Date.now = realNow;
      await close(app.server);
      app.db.close();
      for (const [key, value] of Object.entries(saved)) {
        const envName = key === 'transport' ? 'EMAIL_TRANSPORT' : key === 'worker' ? 'DISABLE_WORKER' : 'PUBLIC_BASE_URL';
        if (value === undefined) delete process.env[envName];
        else process.env[envName] = value;
      }
    }
  });
});
