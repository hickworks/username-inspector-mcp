// The Username Inspector MCP server: two read-only tools.
//   check_username  - is one username free across 12 reselling platforms
//   compare_fees    - what a sale pays out on 7 platforms after fees
//
// Transport and abuse limits live in api/mcp.js and lib/mcp-guard.js; this
// file only defines the tools. Everything is injectable so the tests can run
// it without touching the network.

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { z } = require('zod');
const {
  USERNAME_REGEX, PLATFORM_CHECKS, MANUAL_PLATFORMS, PLATFORM_NAMES, ALL_PLATFORM_IDS, checkPlatform
} = require('./platform-checks');
const { compareFees } = require('./fee-calc');
const { createTtlCache, createSemaphore } = require('./mcp-guard');

const SERVER_VERSION = '1.1.0';
const CACHE_TTL_MS = 5 * 60 * 1000;
const TOOL_DEADLINE_MS = 9000;

const PLATFORM_IDS = [...ALL_PLATFORM_IDS];

// One cache and one outbound limiter per serverless instance.
const defaultCache = createTtlCache({ ttlMs: CACHE_TTL_MS, maxEntries: 500 });
const defaultSemaphore = createSemaphore(12);

const INSTRUCTIONS = [
  'Username Inspector answers two questions for people who sell on resale marketplaces.',
  'check_username: is a username or store name free on eBay, Poshmark, Depop, Etsy, Grailed, Vinted, Mercari, Whatnot, Bonanza, Ruby Lane, and Chairish?',
  'compare_fees: after fees, how much does a sale keep on eBay, Poshmark, Mercari, Depop, Etsy, Grailed, and Vinted?',
  'Results are informational. Availability comes from each platform\'s public profile page, so confirm on the platform before relying on a name.',
  'Several platforms (often eBay, Grailed, Whatnot, and Chairish) block automated lookups, and those come back as unverified with a link to check by hand. Poshmark, Vinted, and Bonanza most reliably return a live answer.',
  'Each call checks one username. Results are cached for 5 minutes and the server rate-limits repeated calls.'
].join(' ');

function profileUrl(platformId, username) {
  const live = PLATFORM_CHECKS[platformId];
  if (live) return live.url(username);
  return MANUAL_PLATFORMS[platformId](username);
}

function withDeadline(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('deadline')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Shared with the links-only server (lib/mcp-links-server.js): pure calculation,
// no network access.
function registerCompareFees(server, log = line => console.log(JSON.stringify(line))) {
  server.registerTool(
    'compare_fees',
    {
      title: 'Compare reseller selling fees',
      description:
        'Compare what a US sale keeps after fees on 7 platforms. Example: price=45, item_cost=12 ranks platforms by profit.',
      inputSchema: {
        price: z.number().positive().max(100000).describe('Sale price, USD.'),
        shipping_charged: z.number().min(0).max(100000).optional()
          .describe('Shipping buyer pays, USD.'),
        item_cost: z.number().min(0).max(100000).optional().describe('Item cost, USD.'),
        shipping_cost: z.number().min(0).max(100000).optional()
          .describe('Your postage cost, USD.'),
        ebay_promoted_rate_percent: z.number().min(0).max(100).optional()
          .describe('eBay promoted rate, percent.')
      },
      outputSchema: {
        currency: z.string(),
        inputs: z.object({
          price: z.number(),
          shipping_charged: z.number(),
          item_cost: z.number(),
          shipping_cost: z.number(),
          ebay_promoted_rate_percent: z.number()
        }),
        results: z.array(z.object({
          platform: z.string(),
          name: z.string(),
          fee: z.number(),
          you_keep: z.number(),
          fee_breakdown: z.string(),
          rates_last_verified: z.string(),
          profit: z.number().optional(),
          margin_percent: z.number().optional(),
          roi_percent: z.number().nullable().optional()
        })),
        notes: z.array(z.string())
      },
      annotations: {
        title: 'Compare reseller selling fees',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
        destructiveHint: false
      }
    },
    async ({ price, shipping_charged = 0, item_cost = 0, shipping_cost = 0, ebay_promoted_rate_percent = 0 }) => {
      const results = compareFees(price, {
        shipCharged: shipping_charged,
        itemCost: item_cost,
        shipCost: shipping_cost,
        promoRate: ebay_promoted_rate_percent
      });
      const payload = {
        currency: 'USD',
        inputs: { price, shipping_charged, item_cost, shipping_cost, ebay_promoted_rate_percent },
        results,
        notes: [
          'Fees are estimates for US sellers and exclude sales tax.',
          'Rates change. Verify on the platform before pricing, or see https://usernameinspector.com/fee-calculator/.',
          'Platforms not covered: Whatnot, Bonanza, Ruby Lane, and Chairish.',
          ...(shipping_charged > 0 && shipping_cost === 0
            ? ['Profit counts the shipping charged as income because no shipping_cost was given; supplying shipping_cost gives a true profit figure. Poshmark and Vinted ignore shipping because the buyer pays the label.']
            : [])
        ]
      };
      log({ evt: 'mcp_tool', tool: 'compare_fees', ms: 0 });
      return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
    }
  );
}

function createMcpServer({
  checkPlatformImpl = checkPlatform,
  cache = defaultCache,
  semaphore = defaultSemaphore,
  log = line => console.log(JSON.stringify(line))
} = {}) {
  const server = new McpServer(
    { name: 'username-inspector', version: SERVER_VERSION, title: 'Username Inspector', websiteUrl: 'https://usernameinspector.com/mcp/' },
    { instructions: INSTRUCTIONS }
  );

  // Cached per (username, platform). Errors are evicted so a blocked or
  // timed-out request is retried next time instead of replayed for 5 minutes.
  function lookup(platformId, username) {
    const key = platformId + ':' + username.toLowerCase();
    let pending = cache.get(key);
    let cached = true;
    if (!pending) {
      cached = false;
      pending = semaphore.run(() => checkPlatformImpl(platformId, username));
      cache.set(key, pending);
      pending
        .then(result => {
          if (!result || result.status === 'error') cache.delete(key);
        })
        .catch(() => cache.delete(key));
    }
    return pending.then(result => ({ result, cached }));
  }

  server.registerTool(
    'check_username',
    {
      title: 'Check username availability',
      description:
        'Check if ONE username is free on 12 resale platforms. Example: username=\'vintage_finds\' returns available, taken, or unverified per platform.',
      inputSchema: {
        username: z.string().regex(USERNAME_REGEX, 'Use 3 to 50 letters, numbers, hyphens, or underscores.')
          .describe('Username, no @ or spaces.'),
        platforms: z.array(z.enum(PLATFORM_IDS)).min(1).max(PLATFORM_IDS.length).optional()
          .describe('Platform ids. Omit for all.')
      },
      outputSchema: {
        username: z.string(),
        results: z.array(z.object({
          platform: z.string(),
          name: z.string(),
          status: z.enum(['available', 'taken', 'unverified', 'error']),
          check_url: z.string().optional(),
          note: z.string().optional()
        })),
        summary: z.object({
          available: z.array(z.string()),
          taken: z.array(z.string()),
          unverified: z.array(z.string()),
          error: z.array(z.string())
        }),
        disclaimer: z.string()
      },
      annotations: {
        title: 'Check username availability',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
        destructiveHint: false
      }
    },
    async ({ username, platforms }) => {
      const started = Date.now();
      const ids = [...new Set(platforms && platforms.length ? platforms : PLATFORM_IDS)];
      try {
        const settled = await withDeadline(Promise.all(ids.map(id => lookup(id, username))), TOOL_DEADLINE_MS);

        const results = ids.map((id, i) => {
          const { result } = settled[i];
          const out = { platform: id, name: PLATFORM_NAMES[id], status: 'error' };
          if (result.status === 'available') {
            out.status = 'available';
          } else if (result.status === 'taken') {
            out.status = 'taken';
            out.check_url = profileUrl(id, username);
          } else if (result.status === 'manual') {
            out.status = 'unverified';
            out.check_url = result.url || profileUrl(id, username);
            out.note = 'This platform cannot be checked automatically. Open check_url: a profile page means the name is taken.';
          } else {
            out.check_url = result.url || profileUrl(id, username);
            out.note = 'The check timed out or was blocked. Open check_url to verify.';
          }
          return out;
        });

        const names = status => results.filter(r => r.status === status).map(r => r.name);
        const payload = {
          username,
          results,
          summary: {
            available: names('available'),
            taken: names('taken'),
            unverified: names('unverified'),
            error: names('error')
          },
          disclaimer: 'Based on each platform\'s public profile page at the time of the check. Confirm on the platform before relying on a name.'
        };
        log({ evt: 'mcp_tool', tool: 'check_username', platforms: ids.length, cached: settled.filter(s => s.cached).length, ms: Date.now() - started });
        return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
      } catch (err) {
        log({ evt: 'mcp_tool_error', tool: 'check_username', ms: Date.now() - started });
        return {
          isError: true,
          content: [{ type: 'text', text: 'The availability check took too long or failed. Try again in a moment, or use https://usernameinspector.com to check manually.' }]
        };
      }
    }
  );

  registerCompareFees(server, log);

  return server;
}

module.exports = { createMcpServer, registerCompareFees, profileUrl, SERVER_VERSION, PLATFORM_IDS };
