import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { open } from '../src/db.js';

const product = (id) => ({
  id,
  vertical: 'retail',
  name: `Transaction ${id}`,
  url: `https://merchant.invalid/${id}`,
  advertised_cents: 1_000,
  context: {},
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

describe('SQLite async transaction compatibility', () => {
  it('preserves synchronous return and throw behavior', () => {
    const db = open(':memory:');
    try {
      const marker = { committed: true };
      const returned = db.transaction(() => {
        db.upsertProduct(product('sync-commit'));
        return marker;
      });
      assert.strictEqual(returned, marker);
      assert.equal(db.getProduct('sync-commit')?.id, 'sync-commit');

      assert.throws(() => db.transaction(() => {
        db.upsertProduct(product('sync-rollback'));
        throw new Error('synchronous abort');
      }), /synchronous abort/);
      assert.equal(db.getProduct('sync-rollback'), null);
    } finally {
      db.close();
    }
  });

  it('commits an async callback after it settles', async () => {
    const db = open(':memory:');
    try {
      await db.transaction(async () => {
        await db.upsertProduct(product('commit'));
      });
      assert.equal(db.getProduct('commit')?.id, 'commit');
    } finally {
      await db.close();
    }
  });

  it('rolls an async callback back when it rejects', async () => {
    const db = open(':memory:');
    try {
      await assert.rejects(db.transaction(async () => {
        await db.upsertProduct(product('rollback'));
        throw new Error('abort transaction');
      }), /abort transaction/);
      assert.equal(db.getProduct('rollback'), null);
    } finally {
      await db.close();
    }
  });

  it('recognizes true nesting after an await and uses an immediate savepoint', async () => {
    const db = open(':memory:');
    try {
      await db.transaction(async () => {
        db.upsertProduct(product('outer'));
        await Promise.resolve();

        const marker = { nested: true };
        const nested = db.transaction(() => {
          db.upsertProduct(product('nested-commit'));
          return marker;
        });
        assert.strictEqual(nested, marker, 'a synchronous nested transaction must not be queued');

        await assert.rejects(db.transaction(async () => {
          db.upsertProduct(product('nested-rollback'));
          await Promise.resolve();
          throw new Error('nested abort');
        }), /nested abort/);
      });

      assert.equal(db.getProduct('outer')?.id, 'outer');
      assert.equal(db.getProduct('nested-commit')?.id, 'nested-commit');
      assert.equal(db.getProduct('nested-rollback'), null);
    } finally {
      await db.close();
    }
  });

  it('queues an unrelated commit until an overlapping rollback has finished', async () => {
    const db = open(':memory:');
    const firstEntered = deferred();
    const releaseFirst = deferred();
    let secondEntered = false;
    try {
      const first = db.transaction(async () => {
        db.upsertProduct(product('rollback-before-await'));
        firstEntered.resolve();
        await releaseFirst.promise;
        db.upsertProduct(product('rollback-after-await'));
        throw new Error('first transaction aborts');
      });
      const firstRejected = assert.rejects(first, /first transaction aborts/);
      await firstEntered.promise;

      const second = db.transaction(async () => {
        secondEntered = true;
        db.upsertProduct(product('queued-commit'));
        await Promise.resolve();
        return 'second committed';
      });
      assert.equal(typeof second?.then, 'function');
      await Promise.resolve();
      assert.equal(secondEntered, false, 'an unrelated transaction must not become a nested savepoint');

      releaseFirst.resolve();
      await firstRejected;
      assert.equal(await second, 'second committed');
      assert.equal(secondEntered, true);
      assert.equal(db.getProduct('rollback-before-await'), null);
      assert.equal(db.getProduct('rollback-after-await'), null);
      assert.equal(db.getProduct('queued-commit')?.id, 'queued-commit');
    } finally {
      await db.close();
    }
  });

  it('fails unrelated reads and writes fast instead of leaking them into an open transaction', async () => {
    const db = open(':memory:');
    const transactionEntered = deferred();
    const releaseTransaction = deferred();
    try {
      const first = db.transaction(async () => {
        db.upsertProduct(product('uncommitted-a'));
        transactionEntered.resolve();
        await releaseTransaction.promise;
        throw new Error('roll A back');
      });
      const firstRejected = assert.rejects(first, /roll A back/);
      await transactionEntered.promise;

      assert.throws(() => db.upsertProduct(product('external-b')), (error) => {
        assert.equal(error.status, 503);
        assert.equal(error.code, 'SQLITE_BUSY');
        assert.equal(error.retryable, true);
        assert.match(error.message, /retry upsertProduct after it settles/);
        return true;
      });

      assert.throws(() => db.getProduct('uncommitted-a'), (error) => {
        assert.equal(error.status, 503);
        assert.equal(error.code, 'SQLITE_BUSY');
        assert.equal(error.retryable, true);
        assert.match(error.message, /retry getProduct after it settles/);
        return true;
      });

      releaseTransaction.resolve();
      await firstRejected;
      assert.equal(db.getProduct('uncommitted-a'), null);
      assert.equal(db.getProduct('external-b'), null, 'a rejected write must never report phantom success');

      assert.equal(db.upsertProduct(product('external-b')), undefined);
      assert.equal(db.getProduct('external-b')?.id, 'external-b');
    } finally {
      await db.close();
    }
  });

  it('keeps a committed transaction when the next queued transaction rolls back', async () => {
    const db = open(':memory:');
    const firstEntered = deferred();
    const releaseFirst = deferred();
    let secondEntered = false;
    try {
      const first = db.transaction(async () => {
        db.upsertProduct(product('preceding-commit'));
        firstEntered.resolve();
        await releaseFirst.promise;
        return 'first committed';
      });
      await firstEntered.promise;

      const second = db.transaction(async () => {
        secondEntered = true;
        db.upsertProduct(product('queued-rollback'));
        await Promise.resolve();
        throw new Error('second transaction aborts');
      });
      const secondRejected = assert.rejects(second, /second transaction aborts/);
      await Promise.resolve();
      assert.equal(secondEntered, false);

      releaseFirst.resolve();
      assert.equal(await first, 'first committed');
      await secondRejected;
      assert.equal(db.getProduct('preceding-commit')?.id, 'preceding-commit');
      assert.equal(db.getProduct('queued-rollback'), null);
    } finally {
      await db.close();
    }
  });
});
