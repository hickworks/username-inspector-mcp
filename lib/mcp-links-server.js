// The links-only Username Inspector MCP server (api/mcp-links.js).
//
// Same fee comparison as the main server, but no lookups: instead of asking a
// marketplace whether a name exists, get_profile_links builds the public profile
// page address for each platform. This server makes no requests to any
// marketplace or other outside service, so it only runs our own code. It exists
// for directories that don't list servers which read third-party sites.

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { z } = require('zod');
const { USERNAME_REGEX, PLATFORM_NAMES } = require('./platform-checks');
const { registerCompareFees, profileUrl, SERVER_VERSION, PLATFORM_IDS } = require('./mcp-server');

const INSTRUCTIONS = [
  'Username Inspector (links-only) answers two questions for people who sell on resale marketplaces.',
  'get_profile_links: the public profile page address for a username on eBay, eBay Store, Poshmark, Depop, Etsy, Grailed, Vinted, Mercari, Whatnot, Bonanza, Ruby Lane, and Chairish. This server contacts no marketplace, so it does not say whether a name is taken; opening a link in a browser does.',
  'compare_fees: after fees, how much does a sale keep on eBay, Poshmark, Mercari, Depop, Etsy, Grailed, and Vinted?',
  'For automatic availability results, the full Username Inspector server is at https://usernameinspector.com/mcp/.'
].join(' ');

function createLinksServer({ log = line => console.log(JSON.stringify(line)) } = {}) {
  const server = new McpServer(
    { name: 'username-inspector-links', version: SERVER_VERSION, title: 'Username Inspector (links)', websiteUrl: 'https://usernameinspector.com/mcp/' },
    { instructions: INSTRUCTIONS }
  );

  server.registerTool(
    'get_profile_links',
    {
      title: 'Get profile page links for a username',
      description:
        'Build profile links for ONE username on 12 resale platforms. Example: username=\'vintage_finds\' returns each platform\'s profile URL.',
      inputSchema: {
        username: z.string().regex(USERNAME_REGEX, 'Use 3 to 50 letters, numbers, hyphens, or underscores.')
          .describe('Username, no @ or spaces.'),
        platforms: z.array(z.enum(PLATFORM_IDS)).min(1).max(PLATFORM_IDS.length).optional()
          .describe('Platform ids. Omit for all.')
      },
      outputSchema: {
        username: z.string(),
        links: z.array(z.object({
          platform: z.string(),
          name: z.string(),
          profile_url: z.string()
        })),
        how_to_read: z.string(),
        note: z.string()
      },
      annotations: {
        title: 'Get profile page links for a username',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
        destructiveHint: false
      }
    },
    async ({ username, platforms }) => {
      const ids = [...new Set(platforms && platforms.length ? platforms : PLATFORM_IDS)];
      const payload = {
        username,
        links: ids.map(id => ({
          platform: id,
          name: PLATFORM_NAMES[id],
          profile_url: profileUrl(id, username)
        })),
        how_to_read: 'A profile page at a link means the name is taken. A not-found or error page means it appears to be free. Registration can still be refused for reserved or blocked names, so confirm on the platform.',
        note: 'No platform was contacted to produce these links.'
      };
      log({ evt: 'mcp_tool', tool: 'get_profile_links', platforms: ids.length, ms: 0 });
      return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
    }
  );

  registerCompareFees(server, log);

  return server;
}

module.exports = { createLinksServer };
