'use strict';

// Unit tests for the security module: validators (HttpError 400 semantics),
// HTML escaping, and the token-bucket rate limiter incl. bucket pruning.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { RateLimiter, HttpError, validate, escapeHtml } = require('../src/security');

// Every validator failure must be an HttpError with status 400 so the server
// maps it straight to a client error.
function assertThrows400(fn, messageRe) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof HttpError, `expected HttpError, got ${err && err.constructor.name}`);
    assert.equal(err.status, 400);
    if (messageRe) assert.match(err.message, messageRe);
    return true;
  });
}

describe('HttpError', () => {
  it('carries a status and is a real Error', () => {
    const err = new HttpError(402, 'payment required');
    assert.ok(err instanceof Error);
    assert.equal(err.status, 402);
    assert.equal(err.message, 'payment required');
  });
});

describe('validate.cents', () => {
  it('accepts integer cents within 0..1e9', () => {
    assert.equal(validate.cents(0, 'amount'), 0);
    assert.equal(validate.cents(21900, 'amount'), 21900);
    assert.equal(validate.cents(1_000_000_000, 'amount'), 1_000_000_000);
  });
  it('rejects negatives, floats, overflow, and non-numbers', () => {
    assertThrows400(() => validate.cents(-1, 'amount'), /amount/);
    assertThrows400(() => validate.cents(10.5, 'amount'));
    assertThrows400(() => validate.cents(1_000_000_001, 'amount'));
    assertThrows400(() => validate.cents('100', 'amount'));
    assertThrows400(() => validate.cents(undefined, 'amount'));
    assertThrows400(() => validate.cents(NaN, 'amount'));
  });
});

describe('validate.int', () => {
  it('accepts integers inside the inclusive range', () => {
    assert.equal(validate.int(5, 'n', 0, 10), 5);
    assert.equal(validate.int(0, 'n', 0, 10), 0);
    assert.equal(validate.int(10, 'n', 0, 10), 10);
  });
  it('rejects out-of-range and non-integers', () => {
    assertThrows400(() => validate.int(-1, 'n', 0, 10), /\[0, 10\]/);
    assertThrows400(() => validate.int(11, 'n', 0, 10));
    assertThrows400(() => validate.int(2.5, 'n', 0, 10));
    assertThrows400(() => validate.int('5', 'n', 0, 10));
  });
});

describe('validate.string', () => {
  it('accepts non-empty strings up to the max', () => {
    assert.equal(validate.string('hello', 'label'), 'hello');
    assert.equal(validate.string('x'.repeat(200), 'label'), 'x'.repeat(200));
    assert.equal(validate.string('ab', 'label', 2), 'ab');
  });
  it('rejects empty, oversized, and non-strings', () => {
    assertThrows400(() => validate.string('', 'label'), /label/);
    assertThrows400(() => validate.string('x'.repeat(201), 'label'));
    assertThrows400(() => validate.string('abc', 'label', 2));
    assertThrows400(() => validate.string(42, 'label'));
    assertThrows400(() => validate.string(null, 'label'));
  });
});

describe('validate.enum', () => {
  it('accepts listed values and rejects everything else', () => {
    assert.equal(validate.enum('starter', 'tier', ['starter', 'pro']), 'starter');
    assertThrows400(() => validate.enum('gold', 'tier', ['starter', 'pro']), /starter, pro/);
    assertThrows400(() => validate.enum(undefined, 'tier', ['starter', 'pro']));
  });
});

describe('validate.email', () => {
  it('accepts reasonable addresses', () => {
    assert.equal(validate.email('user@example.com'), 'user@example.com');
    assert.equal(validate.email('a.b+tag@sub.example.co'), 'a.b+tag@sub.example.co');
  });
  it('normalizes uppercase to lowercase', () => {
    assert.equal(validate.email('User@EXAMPLE.Com'), 'user@example.com');
  });
  it('rejects addresses with no @', () => {
    assertThrows400(() => validate.email('no-at-sign.example.com'), /email/);
  });
  it('rejects a huge local part (> 64 chars)', () => {
    assert.equal(validate.email(`${'a'.repeat(64)}@example.com`), `${'a'.repeat(64)}@example.com`);
    assertThrows400(() => validate.email(`${'a'.repeat(65)}@example.com`));
  });
  it('rejects other malformed shapes', () => {
    assertThrows400(() => validate.email('a@b')); // no dotted TLD
    assertThrows400(() => validate.email('a b@example.com')); // whitespace
    assertThrows400(() => validate.email('a@@example.com'));
    assertThrows400(() => validate.email(''));
    assertThrows400(() => validate.email(42));
    assertThrows400(() => validate.email(`${'a'.repeat(64)}@${'b'.repeat(300)}.com`)); // > 320 total
  });
});

describe('validate.id', () => {
  it('accepts lowercase slugs', () => {
    assert.equal(validate.id('vegas-hotel'), 'vegas-hotel');
    assert.equal(validate.id('0abc'), '0abc');
    assert.equal(validate.id('a'.repeat(64)), 'a'.repeat(64));
  });
  it('rejects uppercase, leading dash, oversize, and non-strings', () => {
    assertThrows400(() => validate.id('Vegas-Hotel'), /slug/);
    assertThrows400(() => validate.id('-abc'));
    assertThrows400(() => validate.id('a'.repeat(65)));
    assertThrows400(() => validate.id(''));
    assertThrows400(() => validate.id('a b'));
    assertThrows400(() => validate.id(42));
  });
});

describe('escapeHtml', () => {
  it('escapes all five HTML-significant characters', () => {
    assert.equal(escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
  });
  it('escapes ampersands first (no double-escaping artifacts)', () => {
    assert.equal(escapeHtml('&lt;'), '&amp;lt;');
    assert.equal(
      escapeHtml('<a href="x" data-y=\'z\'>&</a>'),
      '&lt;a href=&quot;x&quot; data-y=&#39;z&#39;&gt;&amp;&lt;/a&gt;',
    );
  });
  it('leaves plain text alone and coerces non-strings', () => {
    assert.equal(escapeHtml('plain text.'), 'plain text.');
    assert.equal(escapeHtml(123), '123');
  });
});

describe('RateLimiter', () => {
  it('allows exactly the capacity immediately, then denies with retryAfterSec >= 1', () => {
    const rl = new RateLimiter({ capacity: 5, refillPerSec: 1 });
    for (let i = 0; i < 5; i++) {
      assert.equal(rl.check('client-a').ok, true, `check ${i + 1} of 5 should pass`);
    }
    const denied = rl.check('client-a');
    assert.equal(denied.ok, false);
    assert.ok(Number.isInteger(denied.retryAfterSec));
    assert.ok(denied.retryAfterSec >= 1);
  });

  it('tracks clients independently', () => {
    const rl = new RateLimiter({ capacity: 2, refillPerSec: 1 });
    rl.check('a');
    rl.check('a');
    assert.equal(rl.check('a').ok, false);
    assert.equal(rl.check('b').ok, true); // fresh bucket unaffected
  });

  it('prune() removes stale buckets', () => {
    const rl = new RateLimiter({ capacity: 3, refillPerSec: 1 });
    rl.check('stale-client');
    rl.check('fresh-client');
    // Age one bucket past the 10-minute staleness horizon.
    rl.buckets.get('stale-client').last = Date.now() - 11 * 60 * 1000;
    rl.prune();
    assert.equal(rl.buckets.has('stale-client'), false);
    assert.equal(rl.buckets.has('fresh-client'), true);
  });

  it('keeps the bucket map bounded under an address-rotation flood', () => {
    const maxBuckets = 5;
    const rl = new RateLimiter({ capacity: 1, refillPerSec: 1, maxBuckets });
    for (let i = 0; i < 50; i++) {
      rl.check(`rotating-ip-${i}`);
      assert.ok(rl.buckets.size <= maxBuckets, `map grew to ${rl.buckets.size} at key ${i}`);
    }
    // Newest clients survive; the flood cannot pin memory.
    assert.ok(rl.buckets.has('rotating-ip-49'));
  });
});
