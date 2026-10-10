// Local runner: serves the two MCP endpoints on a plain Node HTTP server.
//   npm start            -> http://127.0.0.1:3000/api/mcp  and  /api/mcp-links
// Set PORT and HOST to change where it listens.

const http = require('http');
const lookups = require('./api/mcp.js');
const links = require('./api/mcp-links.js');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';

const server = http.createServer((req, res) => {
  const path = (req.url || '').split('?')[0];
  if (path === '/api/mcp') return lookups(req, res);
  if (path === '/api/mcp-links') return links(req, res);
  res.statusCode = 404;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ error: 'Not found. Try /api/mcp or /api/mcp-links.' }));
});

server.listen(PORT, HOST, () => {
  console.log(`Username Inspector MCP listening on http://${HOST}:${PORT}/api/mcp and /api/mcp-links`);
});
