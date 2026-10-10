// HTTP front door shared by the MCP endpoints (api/mcp.js and api/mcp-links.js):
// CORS, kill switch, size and batch limits, per-instance rate limits, and the
// stateless Streamable HTTP transport. Each endpoint passes in its own server
// factory and the environment variables that switch it off.
//
// Guard rails, in order of strength:
//   1. A Vercel Firewall rate-limit rule on /api/mcp* (cross-instance; set in
//      the dashboard, see README.md).
//   2. An environment variable turns an endpoint off without a code change.
//   3. Per-instance limits below: request size, batch size, tool calls per
//      client per minute, total requests per minute.
//   4. Inside the tools: one username per call, result cache, capped outbound
//      concurrency, timeouts (api/mcp only; the links endpoint makes no
//      outbound requests).
//   5. vercel.json caps each function's maxDuration.

const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { createRateLimiter, clientKey } = require('./mcp-guard');

const MAX_BODY_BYTES = 16 * 1024;
const MAX_BATCH = 5;
const TOOL_CALLS_PER_MINUTE = 12;
const REQUESTS_PER_MINUTE = 120;

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function sendJsonRpcError(res, status, code, message, id = null, extraHeaders = {}) {
  for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id }));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('too large'), { code: 'TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// createServer: () => McpServer. disabledEnv: names of env vars that, when set
// to anything, make the endpoint answer 503 (CORS preflights still work).
function createMcpHandler({ createServer, disabledEnv = ['MCP_DISABLED'], label = 'Username Inspector MCP server' }) {
  const toolCallLimiter = createRateLimiter({ windowMs: 60 * 1000, max: TOOL_CALLS_PER_MINUTE });
  const requestLimiter = createRateLimiter({ windowMs: 60 * 1000, max: REQUESTS_PER_MINUTE });

  return async function handler(req, res) {
    setCors(res);

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      return res.end();
    }

    if (disabledEnv.some(name => process.env[name])) {
      return sendJsonRpcError(res, 503, -32000, 'The ' + label + ' is temporarily disabled.');
    }

    if (req.method !== 'POST') {
      return sendJsonRpcError(res, 405, -32000, 'Method not allowed. This server is stateless: POST JSON-RPC messages to this URL.', null, { Allow: 'POST, OPTIONS' });
    }

    const declared = Number(req.headers['content-length'] || 0);
    if (declared > MAX_BODY_BYTES) {
      return sendJsonRpcError(res, 413, -32000, 'Request body too large.');
    }

    let body = req.body;
    try {
      if (body === undefined) body = await readBody(req);
      if (typeof body === 'string') body = body.length ? JSON.parse(body) : undefined;
    } catch (err) {
      if (err && err.code === 'TOO_LARGE') return sendJsonRpcError(res, 413, -32000, 'Request body too large.');
      return sendJsonRpcError(res, 400, -32700, 'Parse error: body must be valid JSON.');
    }
    if (body === undefined || body === null || typeof body !== 'object') {
      return sendJsonRpcError(res, 400, -32600, 'Invalid request: expected a JSON-RPC message.');
    }

    const messages = Array.isArray(body) ? body : [body];
    if (messages.length > MAX_BATCH) {
      return sendJsonRpcError(res, 400, -32600, 'Batch too large. Send at most ' + MAX_BATCH + ' messages per request.');
    }

    const key = clientKey(req);
    const overall = requestLimiter.take('all');
    const toolCalls = messages.filter(m => m && m.method === 'tools/call').length;
    const perClient = toolCalls ? toolCallLimiter.take(key, toolCalls) : { ok: true };
    if (!overall.ok || !perClient.ok) {
      const retry = String(!perClient.ok ? perClient.retryAfterSec : overall.retryAfterSec);
      const firstCall = messages.find(m => m && m.method === 'tools/call');
      return sendJsonRpcError(
        res, 429, -32000,
        'Rate limit exceeded. This server allows ' + TOOL_CALLS_PER_MINUTE + ' tool calls per minute per client. Wait ' + retry + ' seconds and do not retry in a loop.',
        firstCall && firstCall.id !== undefined ? firstCall.id : null,
        { 'Retry-After': retry }
      );
    }

    // Simple HTTP clients (curl) often omit the dual Accept the transport wants.
    const accept = String(req.headers.accept || '');
    if (!accept.includes('application/json') || !accept.includes('text/event-stream')) {
      req.headers.accept = 'application/json, text/event-stream';
    }

    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      transport.close();
      server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      console.log(JSON.stringify({ evt: 'mcp_error', message: String(err && err.message || err).slice(0, 200) }));
      if (!res.headersSent) sendJsonRpcError(res, 500, -32603, 'Internal server error.');
    }
  };
}

module.exports = { createMcpHandler };
