const test = require('node:test');
const assert = require('node:assert');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { stubFetch, freshHandler, startServer, rpc, fetchReal } = require('./helpers');

async function withServer(name, fn, { env } = {}) {
  const saved = {};
  for (const [k, v] of Object.entries(env || {})) { saved[k] = process.env[k]; process.env[k] = v; }
  const calls = stubFetch();
  const srv = await startServer(freshHandler(name));
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
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { fetch: fetchReal }));
  return client;
}

const parse = result => JSON.parse(result.content[0].text);
const ACCEPT = { Accept: 'application/json, text/event-stream' };

test('links-only server lists get_profile_links and compare_fees, both read-only and closed-world', async () => {
  await withServer('mcp-links', async url => {
    const client = await connect(url);
    const { tools } = await client.listTools();
    assert.deepStrictEqual(tools.map(t => t.name).sort(), ['compare_fees', 'get_profile_links']);
    for (const t of tools) {
      assert.strictEqual(t.annotations.readOnlyHint, true, t.name);
      assert.strictEqual(t.annotations.openWorldHint, false, t.name);
      assert.strictEqual(t.annotations.destructiveHint, false, t.name);
      assert.ok(t.annotations.title, t.name + ' needs a title annotation');
    }
    assert.strictEqual(client.getServerVersion().name, 'username-inspector-links');
    await client.close();
  });
});

test('links-only tools declare output schemas', async () => {
  await withServer('mcp-links', async url => {
    const client = await connect(url);
    const { tools } = await client.listTools();
    for (const tool of tools) assert.ok(tool.outputSchema && tool.outputSchema.properties, tool.name + ' has no outputSchema');
    await client.close();
  });
});

test('get_profile_links builds all 12 profile URLs and contacts nothing', async () => {
  await withServer('mcp-links', async (url, calls) => {
    const client = await connect(url);
    const out = parse(await client.callTool({ name: 'get_profile_links', arguments: { username: 'Thrift_Lane-9' } }));
    assert.strictEqual(out.links.length, 12);
    const by = Object.fromEntries(out.links.map(l => [l.platform, l.profile_url]));
    assert.strictEqual(by.poshmark, 'https://poshmark.com/closet/Thrift_Lane-9');
    assert.strictEqual(by.ebay, 'https://www.ebay.com/usr/Thrift_Lane-9');
    assert.strictEqual(by.mercari, 'https://www.mercari.com/u/Thrift_Lane-9');
    assert.strictEqual(by.etsy, 'https://www.etsy.com/shop/Thrift_Lane-9');
    assert.ok(out.links.every(l => /^https:\/\//.test(l.profile_url) && l.name));
    assert.match(out.note, /No platform was contacted/);
    assert.strictEqual(calls.length, 0, 'the links-only server must make no outbound requests');
    await client.close();
  });
});

test('get_profile_links honors a platform subset, removes duplicates, and rejects bad input', async () => {
  await withServer('mcp-links', async (url, calls) => {
    const client = await connect(url);
    const sub = parse(await client.callTool({ name: 'get_profile_links', arguments: { username: 'abc123', platforms: ['poshmark', 'poshmark', 'vinted'] } }));
    assert.deepStrictEqual(sub.links.map(l => l.platform), ['poshmark', 'vinted']);
    for (const args of [{ username: 'ab' }, { username: 'has space' }, { username: '../x' }, { username: 'okname', platforms: ['myspace'] }, { username: 'okname', platforms: [] }]) {
      let failed = false;
      try { failed = (await client.callTool({ name: 'get_profile_links', arguments: args })).isError === true; } catch { failed = true; }
      assert.ok(failed, 'should reject ' + JSON.stringify(args));
    }
    assert.strictEqual(calls.length, 0);
    await client.close();
  });
});

test('compare_fees on the links-only server gives the same numbers as the main server', async () => {
  await withServer('mcp-links', async url => {
    const client = await connect(url);
    const out = parse(await client.callTool({ name: 'compare_fees', arguments: { price: 50, shipping_charged: 8, item_cost: 10 } }));
    const by = Object.fromEntries(out.results.map(r => [r.platform, r]));
    assert.strictEqual(by.ebay.fee, 8.29);
    assert.strictEqual(by.poshmark.profit, 30);
    assert.strictEqual(out.results[0].platform, 'depop');
    await client.close();
  });
});

test('tool descriptions on both servers describe behavior and do not instruct the model', async () => {
  const bad = /\b(do not|don't|you must|must not|should|always|never)\b/i;
  for (const name of ['mcp', 'mcp-links']) {
    await withServer(name, async url => {
      const client = await connect(url);
      const { tools } = await client.listTools();
      for (const t of tools) {
        assert.ok(!bad.test(t.description), `${name}/${t.name} description reads like an instruction: ${t.description}`);
        for (const [prop, def] of Object.entries(t.inputSchema.properties || {})) {
          assert.ok(!bad.test(def.description || ''), `${name}/${t.name}.${prop} description reads like an instruction`);
        }
      }
      await client.close();
    });
  }
});

test('MCP_LINKS_DISABLED turns off only the links endpoint, MCP_DISABLED turns off both', async () => {
  await withServer('mcp-links', async url => {
    const r = await rpc(url, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, ACCEPT);
    assert.strictEqual(r.status, 503);
  }, { env: { MCP_LINKS_DISABLED: '1' } });

  await withServer('mcp', async url => {
    const r = await rpc(url, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, ACCEPT);
    assert.strictEqual(r.status, 200, 'the main server stays up');
  }, { env: { MCP_LINKS_DISABLED: '1' } });

  await withServer('mcp-links', async url => {
    const r = await rpc(url, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, ACCEPT);
    assert.strictEqual(r.status, 503);
  }, { env: { MCP_DISABLED: '1' } });
});

test('the links endpoint shares the front-door limits (rate limit, size, method)', async () => {
  await withServer('mcp-links', async url => {
    const call = i => rpc(url, { jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'get_profile_links', arguments: { username: 'abc123' } } }, ACCEPT);
    for (let i = 1; i <= 12; i++) assert.strictEqual((await call(i)).status, 200, 'call ' + i);
    const blocked = await call(13);
    assert.strictEqual(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) >= 1);
    const big = await rpc(url, 'x'.repeat(20000));
    assert.strictEqual(big.status, 413);
    const get = await fetchReal(url, { method: 'GET' });
    assert.strictEqual(get.status, 405);
  });
});
