// Links-only MCP server (Streamable HTTP) at /api/mcp-links: builds profile page
// links and compares fees, and contacts no marketplace. See
// lib/mcp-links-server.js. MCP_DISABLED=1 or MCP_LINKS_DISABLED=1 turns it off.

const { createLinksServer } = require('../lib/mcp-links-server');
const { createMcpHandler } = require('../lib/mcp-handler');

module.exports = createMcpHandler({
  createServer: () => createLinksServer(),
  disabledEnv: ['MCP_DISABLED', 'MCP_LINKS_DISABLED'],
  label: 'Username Inspector links-only MCP server'
});
