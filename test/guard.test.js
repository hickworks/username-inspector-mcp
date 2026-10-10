const test = require('node:test');
const assert = require('node:assert');
const { createRateLimiter, createTtlCache, createSemaphore, clientKey } = require('../lib/mcp-guard');

test('rate limiter allows up to max, then blocks with a retry hint, then recovers', () => {
  const rl = createRateLimiter({ windowMs: 60000, max: 3 });
  assert.ok(rl.take('a', 1, 0).ok);
  assert.ok(rl.take('a', 2, 1000).ok);
  const blocked = rl.take('a', 1, 2000);
  assert.strictEqual(blocked.ok, false);
  assert.ok(blocked.retryAfterSec >= 1 && blocked.retryAfterSec <= 60);
  assert.ok(rl.take('b', 3, 2000).ok, 'other clients are independent');
  assert.ok(rl.take('a', 1, 61000).ok, 'window slides');
});

test('rate limiter never lets one request exceed the window', () => {
  const rl = createRateLimiter({ windowMs: 60000, max: 5 });
  assert.strictEqual(rl.take('a', 6, 0).ok, false);
});

test('ttl cache expires and evicts oldest at capacity', () => {
  const c = createTtlCache({ ttlMs: 1000, maxEntries: 2 });
  c.set('x', 1, 0);
  assert.strictEqual(c.get('x', 500), 1);
  assert.strictEqual(c.get('x', 1500), undefined);
  c.set('a', 1, 0);
  c.set('b', 2, 0);
  c.set('c', 3, 0);
  assert.strictEqual(c.size(), 2);
  assert.strictEqual(c.get('a', 1), undefined);
});

test('semaphore caps concurrency', async () => {
  const sem = createSemaphore(2);
  let running = 0;
  let peak = 0;
  const job = () => sem.run(async () => {
    running++;
    peak = Math.max(peak, running);
    await new Promise(r => setTimeout(r, 10));
    running--;
  });
  await Promise.all(Array.from({ length: 8 }, job));
  assert.strictEqual(peak, 2);
});

test('clientKey prefers the first forwarded address', () => {
  assert.strictEqual(clientKey({ headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' } }), '1.2.3.4');
  assert.strictEqual(clientKey({ headers: {}, socket: { remoteAddress: '9.9.9.9' } }), '9.9.9.9');
  assert.strictEqual(clientKey({ headers: {} }), 'unknown');
});
