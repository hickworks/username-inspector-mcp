// Shared test helpers: a stub for global fetch that mimics each platform's
// "taken" / "available" responses, and a local HTTP server around api/mcp.js.

const http = require('http');

// Captured before any stubbing so the tests can still talk to the local server.
const fetchReal = global.fetch;

// Usernames containing "taken" look registered, "blocked" get a 403 challenge,
// everything else looks free.
function stubFetch() {
  const calls = [];
  global.fetch = async (url) => {
    calls.push(String(url));
    const u = String(url);
    const taken = u.includes('taken');
    // Bot-protection challenge: 403 with a body that says nothing about the name.
    if (u.includes('blocked')) return { url: u, status: 403, text: async () => '<title>Just a moment...</title>' };
    if (u.includes('ebay.com/fdbk/feedback_profile/')) {
      // Members have a "Feedback ratings" section; unknown names get an error stub.
      return {
        url: u,
        status: 200,
        text: async () => taken
          ? '<title>Feedback Profile</title><h2>Feedback ratings</h2>'
          : '<title>Feedback Profile</title><div class="component-error feedback-detail-error">Oops</div>'
      };
    }
    if (u.includes('ebay.com/str/')) return { url: u, status: taken ? 200 : 410, text: async () => '' };
    if (u.includes('bonanza.com/booths/')) return { url: taken ? u : 'https://www.bonanza.com/', status: 200, text: async () => '' };
    return { url: u, status: taken ? 200 : 404, text: async () => '' };
  };
  return calls;
}

// Fresh module graph so per-instance limiter/cache state doesn't leak between tests.
function freshHandler(name = 'mcp') {
  for (const key of Object.keys(require.cache)) {
    if (/[\\/](api[\\/]mcp|lib[\\/])/.test(key)) delete require.cache[key];
  }
  return require('../api/' + name + '.js');
}

async function startServer(handler) {
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}/api/mcp`, close: () => new Promise(resolve => server.close(resolve)) };
}

async function rpc(url, body, headers = {}) {
  const res = await fetchReal(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, headers: res.headers, json, text };
}

module.exports = { stubFetch, freshHandler, startServer, rpc, fetchReal };
