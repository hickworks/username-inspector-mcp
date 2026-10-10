const test = require('node:test');
const assert = require('node:assert');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { stubFetch, freshHandler, startServer, rpc, fetchReal } = require('./helpers');

async function withServer(fn, { env } = {}) {
  const saved = {};
  for (const [k, v] of Object.entries(env || {})) { saved[k] = process.env[k]; process.env[k] = v; }
  const calls = stubFetch();
  const srv = await startServer(freshHandler());
  try {
    await fn(srv.url, calls);
  } finally {
    await srv.close();
    global.fetch = fetchReal;
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

async function connect(url) {
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  // The platform fetch is stubbed globally; the client must use the real one.
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { fetch: fetchReal }));
  return client;
}

const parse = result => JSON.parse(result.content[0].text);
const ACCEPT = { Accept: 'application/json, text/event-stream' };

test('lists both tools with read-only annotations', async () => {
  await withServer(async url => {
    const client = await connect(url);
    const { tools } = await client.listTools();
    assert.deepStrictEqual(tools.map(t => t.name).sort(), ['check_username', 'compare_fees']);
    for (const t of tools) {
      assert.strictEqual(t.annotations.readOnlyHint, true);
      assert.ok(t.description.length > 50);
    }
    await client.close();
  });
});

test('check_username reports available and taken per platform', async () => {
  await withServer(async url => {
    const client = await connect(url);
    const free = parse(await client.callTool({ name: 'check_username', arguments: { username: 'zzfreename' } }));
    assert.strictEqual(free.results.length, 12);
    const liveIds = ['ebay', 'ebaystore', 'poshmark', 'grailed', 'vinted', 'whatnot', 'bonanza', 'chairish'];
    const live = free.results.filter(r => liveIds.includes(r.platform));
    assert.ok(live.every(r => r.status === 'available'), JSON.stringify(live));
    const manual = free.results.filter(r => ['depop', 'etsy', 'mercari', 'rubylane'].includes(r.platform));
    assert.ok(manual.every(r => r.status === 'unverified' && r.check_url.startsWith('https://')));
    assert.strictEqual(free.summary.available.length, 8);

    const taken = parse(await client.callTool({ name: 'check_username', arguments: { username: 'takenname', platforms: ['ebay', 'poshmark', 'bonanza'] } }));
    assert.deepStrictEqual(taken.summary.taken.sort(), ['Bonanza', 'Poshmark', 'eBay']);
    assert.ok(taken.results.every(r => r.check_url && r.check_url.includes('takenname')));
    await client.close();
  });
});

test('a bot-blocked platform is reported unverified, never taken', async () => {
  await withServer(async url => {
    const client = await connect(url);
    const out = parse(await client.callTool({ name: 'check_username', arguments: { username: 'blockedname' } }));
    assert.deepStrictEqual(out.summary.taken, []);
    assert.deepStrictEqual(out.summary.available, []);
    assert.strictEqual(out.summary.unverified.length, 12);
    assert.ok(out.results.every(r => r.check_url));
    await client.close();
  });
});

test('check_username caches repeat lookups so a looping agent costs nothing', async () => {
  await withServer(async (url, calls) => {
    const client = await connect(url);
    await client.callTool({ name: 'check_username', arguments: { username: 'cacheme', platforms: ['poshmark', 'grailed'] } });
    const afterFirst = calls.length;
    assert.strictEqual(afterFirst, 2);
    await client.callTool({ name: 'check_username', arguments: { username: 'CacheMe', platforms: ['poshmark', 'grailed'] } });
    assert.strictEqual(calls.length, afterFirst, 'second identical lookup must not hit the platforms');
    await client.close();
  });
});

test('check_username rejects bad usernames and unknown platforms without any outbound request', async () => {
  await withServer(async (url, calls) => {
    const client = await connect(url);
    const badArgs = [
      { username: 'ab' },
      { username: 'has space' },
      { username: '../../etc/passwd' },
      { username: 'x'.repeat(51) },
      { username: 'okname', platforms: ['myspace'] },
      { username: 'okname', platforms: [] }
    ];
    for (const args of badArgs) {
      let failed = false;
      try {
        const res = await client.callTool({ name: 'check_username', arguments: args });
        failed = res.isError === true;
      } catch {
        failed = true;
      }
      assert.ok(failed, 'should reject ' + JSON.stringify(args));
    }
    assert.strictEqual(calls.length, 0);
    await client.close();
  });
});

test('compare_fees matches the calculator and sorts best first', async () => {
  await withServer(async url => {
    const client = await connect(url);
    const out = parse(await client.callTool({ name: 'compare_fees', arguments: { price: 50 } }));
    assert.strictEqual(out.results.length, 7);
    const by = Object.fromEntries(out.results.map(r => [r.platform, r]));
    assert.strictEqual(by.vinted.you_keep, 50);
    assert.strictEqual(by.depop.you_keep, 47.9);
    assert.strictEqual(by.mercari.you_keep, 45);
    assert.strictEqual(by.etsy.you_keep, 44.8);
    assert.strictEqual(by.ebay.you_keep, 42.8);
    assert.strictEqual(by.poshmark.you_keep, 40);
    const keeps = out.results.map(r => r.you_keep);
    assert.deepStrictEqual(keeps, [...keeps].sort((a, b) => b - a));
    assert.strictEqual(out.results[0].profit, undefined, 'no profit fields without costs');

    const withCosts = parse(await client.callTool({ name: 'compare_fees', arguments: { price: 50, shipping_charged: 8, item_cost: 10, ebay_promoted_rate_percent: 5 } }));
    const ebay = withCosts.results.find(r => r.platform === 'ebay');
    assert.strictEqual(ebay.fee, 11.19);
    assert.strictEqual(ebay.profit, 36.81);
    assert.ok(typeof ebay.margin_percent === 'number' && typeof ebay.roi_percent === 'number');

    let bad = false;
    try { bad = (await client.callTool({ name: 'compare_fees', arguments: { price: -5 } })).isError === true; } catch { bad = true; }
    assert.ok(bad);
    await client.close();
  });
});

test('compare_fees warns when shipping charged has no matching shipping cost, and names uncovered platforms', async () => {
  await withServer(async url => {
    const client = await connect(url);
    const noPostage = parse(await client.callTool({ name: 'compare_fees', arguments: { price: 50, shipping_charged: 8, item_cost: 10 } }));
    assert.ok(noPostage.notes.some(n => n.includes('no shipping_cost was given')));
    assert.ok(noPostage.notes.some(n => n.includes('Whatnot, Bonanza, Ruby Lane, and Chairish')));
    const withPostage = parse(await client.callTool({ name: 'compare_fees', arguments: { price: 50, shipping_charged: 8, item_cost: 10, shipping_cost: 8 } }));
    assert.ok(!withPostage.notes.some(n => n.includes('no shipping_cost was given')));
    const noShipping = parse(await client.callTool({ name: 'compare_fees', arguments: { price: 50 } }));
    assert.ok(!noShipping.notes.some(n => n.includes('no shipping_cost was given')));
    await client.close();
  });
});

test('every tool declares an output schema, and results with null ROI still validate', async () => {
  await withServer(async url => {
    const client = await connect(url);
    const { tools } = await client.listTools();
    for (const tool of tools) {
      assert.ok(tool.outputSchema && tool.outputSchema.properties, tool.name + ' has no outputSchema');
    }
    // Shipping cost without an item cost gives profit fields with a null ROI.
    const r = await client.callTool({ name: 'compare_fees', arguments: { price: 40, shipping_cost: 5 } });
    assert.notStrictEqual(r.isError, true);
    assert.strictEqual(r.structuredContent.results[0].roi_percent, null);
    await client.close();
  });
});

test('rate limit: the 13th tool call in a minute is refused with 429 and Retry-After', async () => {
  await withServer(async url => {
    const call = i => rpc(url, { jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'compare_fees', arguments: { price: 20 } } }, ACCEPT);
    for (let i = 1; i <= 12; i++) {
      const r = await call(i);
      assert.strictEqual(r.status, 200, 'call ' + i);
    }
    const blocked = await call(13);
    assert.strictEqual(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) >= 1);
    assert.match(blocked.json.error.message, /Rate limit/);
    // Non-tool requests (discovery) are not counted against the tool budget.
    const list = await rpc(url, { jsonrpc: '2.0', id: 99, method: 'tools/list' }, ACCEPT);
    assert.strictEqual(list.status, 200);
  });
});

test('a batch of tool calls counts every call toward the limit', async () => {
  await withServer(async url => {
    const msg = i => ({ jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'compare_fees', arguments: { price: 20 } } });
    const tooBig = await rpc(url, [msg(1), msg(2), msg(3), msg(4), msg(5), msg(6)], ACCEPT);
    assert.strictEqual(tooBig.status, 400, 'batches over 5 are refused outright');
    for (let n = 0; n < 2; n++) {
      const ok = await rpc(url, [msg(1), msg(2), msg(3), msg(4), msg(5)], ACCEPT);
      assert.notStrictEqual(ok.status, 429);
    }
    const over = await rpc(url, [msg(1), msg(2), msg(3)], ACCEPT);
    assert.strictEqual(over.status, 429, '10 + 3 > 12');
  });
});

test('oversized, malformed and wrong-method requests are rejected cheaply', async () => {
  await withServer(async (url, calls) => {
    const big = await rpc(url, 'x'.repeat(20000));
    assert.strictEqual(big.status, 413);
    const bad = await rpc(url, '{not json');
    assert.strictEqual(bad.status, 400);
    const get = await fetchReal(url, { method: 'GET' });
    assert.strictEqual(get.status, 405);
    assert.match(get.headers.get('allow'), /POST/);
    const del = await fetchReal(url, { method: 'DELETE' });
    assert.strictEqual(del.status, 405);
    const opt = await fetchReal(url, { method: 'OPTIONS' });
    assert.strictEqual(opt.status, 204);
    assert.strictEqual(opt.headers.get('access-control-allow-origin'), '*');
    assert.strictEqual(calls.length, 0);
  });
});

test('MCP_DISABLED switches the endpoint off', async () => {
  await withServer(async url => {
    const r = await rpc(url, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, ACCEPT);
    assert.strictEqual(r.status, 503);
    const opt = await fetchReal(url, { method: 'OPTIONS' });
    assert.strictEqual(opt.status, 204, 'CORS preflight still answers');
  }, { env: { MCP_DISABLED: '1' } });
});

test('works for simple clients that send only Accept: application/json', async () => {
  await withServer(async url => {
    const init = await rpc(url, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'curl', version: '1' } }
    }, { Accept: 'application/json' });
    assert.strictEqual(init.status, 200);
    assert.strictEqual(init.json.result.serverInfo.name, 'username-inspector');
    assert.ok(init.json.result.instructions.includes('cached for 5 minutes'));
  });
});
