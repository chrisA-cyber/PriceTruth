import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { NetlifyDB } from '@netlify/database-dev';
import { applyEvent } from '../src/billing.js';
import { openPostgres } from '../src/db-postgres.js';

const migrations = fileURLToPath(new URL('../netlify/database/migrations', import.meta.url));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

async function eventLoopTurns(count = 4) {
  for (let index = 0; index < count; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('Stripe business-object concurrency on Netlify Postgres', () => {
  let local;
  let firstDb;
  let secondDb;
  let account;

  before(async () => {
    local = new NetlifyDB({ logger: () => {} });
    const connectionString = await local.start();
    await local.applyMigrations(migrations);
    firstDb = openPostgres({ connectionString });
    secondDb = openPostgres({ connectionString });
    account = await firstDb.getOrCreateAccount('stripe-concurrency@example.com');
  });

  after(async () => {
    await Promise.allSettled([firstDb?.close(), secondDb?.close()]);
    await local?.stop();
  });

  it('keeps the billing lock transaction-scoped', async () => {
    await assert.rejects(
      firstDb.lockBillingObject('invoice', 'inv_outside_transaction'),
      /require an active database transaction/,
    );
    assert.equal(await firstDb.transaction(
      () => firstDb.lockBillingObject('invoice', 'inv_inside_transaction'),
    ), true);
  });

  it('recognizes one payment across concurrent paid aliases for the same invoice', async () => {
    const firstRead = deferred();
    const releaseFirstRead = deferred();
    const secondLockAttempted = deferred();
    let secondReadReached = false;
    const firstHasPayment = firstDb.hasRecognizedInvoicePayment;
    const secondHasPayment = secondDb.hasRecognizedInvoicePayment;
    const secondLock = secondDb.lockBillingObject;
    let firstApply;
    let secondApply;

    firstDb.hasRecognizedInvoicePayment = async (...args) => {
      const result = await firstHasPayment(...args);
      firstRead.resolve(result);
      await releaseFirstRead.promise;
      return result;
    };
    secondDb.hasRecognizedInvoicePayment = async (...args) => {
      secondReadReached = true;
      return secondHasPayment(...args);
    };
    secondDb.lockBillingObject = async (...args) => {
      secondLockAttempted.resolve();
      return secondLock(...args);
    };

    const invoice = {
      id: 'inv_concurrent_aliases',
      amount_paid: 4_000,
      currency: 'usd',
      metadata: { account_id: account.id, plan: 'premium' },
    };
    try {
      firstApply = applyEvent({
        id: 'evt_concurrent_invoice_succeeded',
        type: 'invoice.payment_succeeded',
        created: 100,
        livemode: false,
        data: { object: invoice },
      }, firstDb);
      assert.equal(await firstRead.promise, false);

      secondApply = applyEvent({
        id: 'evt_concurrent_invoice_paid',
        type: 'invoice.paid',
        created: 101,
        livemode: false,
        data: { object: invoice },
      }, secondDb);
      await secondLockAttempted.promise;
      await eventLoopTurns();
      assert.equal(secondReadReached, false, 'the second adapter must wait on the invoice lock before reading the ledger');

      releaseFirstRead.resolve();
      const [first, second] = await Promise.all([firstApply, secondApply]);
      assert.equal(first.amount_cents, 4_000);
      assert.equal(first.duplicatePayment, false);
      assert.equal(second.amount_cents, 0);
      assert.equal(second.duplicatePayment, true);
      assert.equal(await firstDb.billingObjectAmount('inv_concurrent_aliases', ['invoice.paid', 'invoice.payment_succeeded']), 4_000);
    } finally {
      releaseFirstRead.resolve();
      await Promise.allSettled([firstApply, secondApply].filter(Boolean));
      firstDb.hasRecognizedInvoicePayment = firstHasPayment;
      secondDb.hasRecognizedInvoicePayment = secondHasPayment;
      secondDb.lockBillingObject = secondLock;
    }
  });

  it('books only the cumulative delta across concurrent charge refund events', async () => {
    const firstRead = deferred();
    const releaseFirstRead = deferred();
    const secondLockAttempted = deferred();
    let secondReadReached = false;
    const firstRefundedTotal = firstDb.refundedTotalForCharge;
    const secondRefundedTotal = secondDb.refundedTotalForCharge;
    const secondLock = secondDb.lockBillingObject;
    let firstApply;
    let secondApply;

    firstDb.refundedTotalForCharge = async (...args) => {
      const result = await firstRefundedTotal(...args);
      firstRead.resolve(result);
      await releaseFirstRead.promise;
      return result;
    };
    secondDb.refundedTotalForCharge = async (...args) => {
      secondReadReached = true;
      return secondRefundedTotal(...args);
    };
    secondDb.lockBillingObject = async (...args) => {
      secondLockAttempted.resolve();
      return secondLock(...args);
    };

    const charge = (amount_refunded) => ({
      id: 'ch_concurrent_cumulative',
      amount_refunded,
      currency: 'usd',
      metadata: { account_id: account.id },
    });
    try {
      firstApply = applyEvent({
        id: 'evt_concurrent_refund_1000',
        type: 'charge.refunded',
        created: 200,
        livemode: false,
        data: { object: charge(1_000) },
      }, firstDb);
      assert.equal(await firstRead.promise, 0);

      secondApply = applyEvent({
        id: 'evt_concurrent_refund_1500',
        type: 'charge.refunded',
        created: 201,
        livemode: false,
        data: { object: charge(1_500) },
      }, secondDb);
      await secondLockAttempted.promise;
      await eventLoopTurns();
      assert.equal(secondReadReached, false, 'the second adapter must wait on the charge lock before computing its delta');

      releaseFirstRead.resolve();
      const [first, second] = await Promise.all([firstApply, secondApply]);
      assert.equal(first.amount_cents, -1_000);
      assert.equal(second.amount_cents, -500);
      assert.equal(await firstDb.refundedTotalForCharge('ch_concurrent_cumulative'), 1_500);
      assert.equal(await firstDb.billingObjectAmount('ch_concurrent_cumulative', ['charge.refunded']), -1_500);
    } finally {
      releaseFirstRead.resolve();
      await Promise.allSettled([firstApply, secondApply].filter(Boolean));
      firstDb.refundedTotalForCharge = firstRefundedTotal;
      secondDb.refundedTotalForCharge = secondRefundedTotal;
      secondDb.lockBillingObject = secondLock;
    }
  });
});
