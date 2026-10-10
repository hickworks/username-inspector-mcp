// How each platform is read, tested against stubbed responses (no network).
const test = require('node:test');
const assert = require('node:assert');
const { checkPlatform } = require('../lib/platform-checks');

const real = global.fetch;
function stub(handler) {
  global.fetch = async (url) => handler(String(url));
}
test.afterEach(() => { global.fetch = real; });

const page = (url, status, body = '') => ({ url, status, text: async () => body });

test('a 404 means available and a 200 means taken on status-based platforms', async () => {
  stub(u => page(u, u.includes('freename') ? 404 : 200));
  assert.strictEqual((await checkPlatform('poshmark', 'freename')).status, 'available');
  assert.strictEqual((await checkPlatform('poshmark', 'takenname')).status, 'taken');
  assert.strictEqual((await checkPlatform('vinted', 'freename')).status, 'available');
});

test('challenge and error responses become manual, never taken', async () => {
  for (const status of [403, 429, 500, 503]) {
    stub(u => page(u, status, '<title>Just a moment...</title>'));
    for (const id of ['poshmark', 'grailed', 'vinted', 'whatnot', 'chairish', 'bonanza', 'ebay', 'ebaystore']) {
      const r = await checkPlatform(id, 'someone');
      assert.strictEqual(r.status, 'manual', `${id} at ${status}`);
      assert.ok(r.url.includes('someone'));
    }
  }
});

test('platforms that block automated checks always return a link', async () => {
  stub(() => { throw new Error('should not be called'); });
  for (const id of ['depop', 'etsy', 'mercari', 'rubylane']) {
    const r = await checkPlatform(id, 'someone');
    assert.strictEqual(r.status, 'manual');
    assert.ok(r.url.startsWith('https://') && r.url.includes('someone'));
  }
});

test('eBay is read from the feedback profile page', async () => {
  const member = '<title>Feedback Profile</title><h2>Feedback ratings</h2>';
  const unknown = '<title>Feedback Profile</title><div class="feedback-detail-error"></div>';
  stub(u => page(u, 200, u.includes('realseller') ? member : unknown));
  assert.strictEqual((await checkPlatform('ebay', 'realseller')).status, 'taken');
  assert.strictEqual((await checkPlatform('ebay', 'nobodyhere')).status, 'available');
});

test('an eBay "available" answer is confirmed with a second request', async () => {
  let calls = 0;
  stub(u => {
    calls++;
    return page(u, 200, calls === 1
      ? '<title>Feedback Profile</title><div class="feedback-detail-error"></div>'
      : '<title>Feedback Profile</title><h2>Feedback ratings</h2>');
  });
  const r = await checkPlatform('ebay', 'flipflop');
  assert.strictEqual(calls, 2);
  assert.strictEqual(r.status, 'manual');
});

test('an unrecognized eBay page is manual', async () => {
  stub(u => page(u, 200, '<title>Feedback Profile</title><p>something else</p>'));
  assert.strictEqual((await checkPlatform('ebay', 'whatever')).status, 'manual');
});

test('Bonanza: a redirect away from /booths/ means available', async () => {
  stub(u => page(u.includes('freeshop') ? 'https://www.bonanza.com/' : u, 200));
  assert.strictEqual((await checkPlatform('bonanza', 'freeshop')).status, 'available');
  assert.strictEqual((await checkPlatform('bonanza', 'takenshop')).status, 'taken');
});

test('a network failure is reported as error with a link', async () => {
  stub(() => { throw new Error('network down'); });
  const r = await checkPlatform('poshmark', 'someone');
  assert.strictEqual(r.status, 'error');
  assert.ok(r.url.includes('someone'));
});
