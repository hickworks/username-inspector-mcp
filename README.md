# Username Inspector MCP server

[![Tests](https://github.com/hickworks/username-inspector-mcp/actions/workflows/test.yml/badge.svg)](https://github.com/hickworks/username-inspector-mcp/actions/workflows/test.yml) [![VerifyMCP trust score for Username Inspector](https://verifymcp.io/badge/com-usernameinspector-username-inspector/api-mcp.svg)](https://verifymcp.io/servers/com-usernameinspector-username-inspector/api-mcp)

A free [Model Context Protocol](https://modelcontextprotocol.io) server for people who sell on resale marketplaces. It lets an AI assistant:

- look up whether a username or store name is free on eBay, eBay Store, Poshmark, Grailed, Vinted, Whatnot, Bonanza, Chairish, Depop, Etsy, Mercari, and Ruby Lane, and
- compare what a sale pays out after fees on eBay, Poshmark, Mercari, Depop, Etsy, Grailed, and Vinted.

It is the code behind [Username Inspector](https://usernameinspector.com). Documentation for end users is at **https://usernameinspector.com/mcp/**.

## Use the hosted servers

No account, no API key.

| Server | URL | Tools |
|---|---|---|
| Lookups | `https://usernameinspector.com/api/mcp` | `check_username`, `compare_fees` |
| Links only | `https://usernameinspector.com/api/mcp-links` | `get_profile_links`, `compare_fees` |

The links-only server never contacts a marketplace. It builds the public profile page address for a username and leaves it to you to open it.

**Claude Code**

```
claude mcp add --transport http username-inspector https://usernameinspector.com/api/mcp
```

**Clients with a JSON config (Cursor and others)**

```json
{
  "mcpServers": {
    "username-inspector": {
      "url": "https://usernameinspector.com/api/mcp"
    }
  }
}
```

**Clients with a custom connector or remote server option:** add a server and paste the URL.

It is also listed in the official MCP Registry as `com.usernameinspector/username-inspector`.

## Tools

### `check_username`

Looks up one username on up to 12 platforms. Each platform comes back as `available`, `taken`, `unverified`, or `error`, with a link to the profile page where one helps.

- `username` (required): 3 to 50 letters, numbers, hyphens, or underscores.
- `platforms` (optional): list of platform ids. Defaults to all twelve: `ebay`, `ebaystore`, `poshmark`, `grailed`, `vinted`, `whatnot`, `bonanza`, `chairish`, `depop`, `etsy`, `mercari`, `rubylane`.

Depop, Etsy, Mercari, and Ruby Lane block automated checks, so they always return a profile link. Poshmark, Vinted, and Bonanza usually return a live answer. eBay, eBay Store, Grailed, Whatnot, and Chairish often block automated lookups, and those come back as `unverified` with a link to check by hand. Which platforms answer can change at any time.

### `get_profile_links` (links-only server)

Builds the public profile page address for a username on each platform. Makes no requests to any marketplace.

### `compare_fees`

Takes a sale price in USD and, optionally, `shipping_charged`, `item_cost`, `shipping_cost`, and `ebay_promoted_rate_percent`. Returns fees and what you keep on seven platforms, best first, plus profit, margin, and ROI when costs are given. Estimates for US sellers, excluding sales tax, with the date each rate was last verified.

All tools are read-only and declare output schemas.

## Limits and behavior

- About 12 tool calls per minute per client (HTTP 429 with `Retry-After` beyond that), 16 KB request bodies, 5 messages per batch.
- One username per `check_username` call. Results are cached in memory for 5 minutes per username and platform, and errors are never cached.
- Outbound lookups run at most 12 at a time per instance, with a 5 second timeout per platform and 9 seconds per call.
- Setting `MCP_DISABLED=1` turns both endpoints off. `MCP_LINKS_DISABLED=1` turns off only the links endpoint.

The in-process limits are per instance and best effort. On a serverless host, add a rate-limit rule at the platform level too.

## Privacy

The assistant sends the username to the server, which looks it up on the marketplace and returns the result. Nothing is stored. The only logs are counts: tool name, how many platforms, and how long it took. Never usernames or IP addresses. See the [privacy policy](https://usernameinspector.com/privacy/).

## How the lookups work

`check_username` makes the same plain HTTPS request a browser makes when you open a profile page, and reads the response status or a marker on the page to tell whether a profile exists. It uses no marketplace API and no login, and it does not try to get around bot protection: when a platform answers with a challenge or an error, the result is `unverified`, never a guess.

Platforms can change or block these requests whenever they like. If you run this yourself, you are responsible for the load you put on those sites and for following their terms.

## Run it yourself

Requires Node 18 or newer.

```
npm install
npm start
```

This serves `http://127.0.0.1:3000/api/mcp` and `http://127.0.0.1:3000/api/mcp-links` (set `PORT` and `HOST` to change that). The `api/` folder is also laid out as Vercel serverless functions, so it deploys there unchanged. Use the Streamable HTTP transport; the server is stateless.

Quick check:

```
curl -s -X POST http://127.0.0.1:3000/api/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Tests

```
npm test
```

The tests use Node's built-in runner and stub the network, so they make no requests to any marketplace.

## Fee rates

All rates live in `lib/fee-calc.js`, each with a `lastVerified` date. They are US rates and change often, so check the platform's own fee page before pricing something.

## Layout

| Path | What it does |
|---|---|
| `api/mcp.js`, `api/mcp-links.js` | The two endpoints |
| `lib/mcp-handler.js` | HTTP front door: CORS, limits, kill switch |
| `lib/mcp-server.js`, `lib/mcp-links-server.js` | The tools |
| `lib/platform-checks.js` | How each platform is looked up |
| `lib/fee-calc.js` | Fee math |
| `lib/mcp-guard.js` | Rate limiter, cache, concurrency cap |
| `server.js` | Local runner |

## License

MIT. See [LICENSE](LICENSE).

## Contact

Found a wrong result or want a platform added? Use the [contact page](https://usernameinspector.com/contact/).
