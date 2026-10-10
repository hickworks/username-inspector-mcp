// Public, stateless MCP server (Streamable HTTP) at /api/mcp: username lookups
// on the marketplaces plus fee comparison. Tools live in lib/mcp-server.js;
// the HTTP front door and its guard rails live in lib/mcp-handler.js.
// MCP_DISABLED=1 turns it off without a code change.

const { createMcpServer } = require('../lib/mcp-server');
const { createMcpHandler } = require('../lib/mcp-handler');

module.exports = createMcpHandler({
  createServer: () => createMcpServer(),
  disabledEnv: ['MCP_DISABLED'],
  label: 'Username Inspector MCP server'
});
