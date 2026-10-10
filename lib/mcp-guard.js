// Guard rails for the public MCP endpoint (api/mcp.js).
//
// Serverless instances are short-lived and don't share memory, so every limit
// here is per instance and best effort. They stop a looping agent from
// fanning out requests to the platforms from a single instance; the hard,
// cross-instance rate limit has to be a Vercel Firewall rate-limit rule on
// /api/mcp (see README.md).

// Sliding-window limiter. take() records `cost` hits for `key` and reports
// whether the window still has room.
function createRateLimiter({ windowMs, max }) {
  const hits = new Map();

  function prune(now) {
    for (const [key, stamps] of hits) {
      const fresh = stamps.filter(t => now - t < windowMs);
      if (fresh.length) hits.set(key, fresh);
      else hits.delete(key);
    }
  }

  return {
    take(key, cost = 1, now = Date.now()) {
      if (hits.size > 1000) prune(now);
      const stamps = (hits.get(key) || []).filter(t => now - t < windowMs);
      if (stamps.length + cost > max) {
        const oldest = stamps[0] || now;
        const retryAfterSec = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
        hits.set(key, stamps);
        return { ok: false, retryAfterSec };
      }
      for (let i = 0; i < cost; i++) stamps.push(now);
      hits.set(key, stamps);
      return { ok: true, retryAfterSec: 0 };
    },
    size: () => hits.size
  };
}

// TTL cache of promises, so identical in-flight or recent lookups share one
// result. Rejected or errored results are evicted so a failure isn't replayed.
function createTtlCache({ ttlMs, maxEntries }) {
  const map = new Map();
  return {
    get(key, now = Date.now()) {
      const entry = map.get(key);
      if (!entry) return undefined;
      if (now - entry.at > ttlMs) {
        map.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key, value, now = Date.now()) {
      if (map.size >= maxEntries) map.delete(map.keys().next().value);
      map.set(key, { value, at: now });
    },
    delete: key => map.delete(key),
    size: () => map.size
  };
}

// Caps how many outbound platform requests one instance runs at once.
function createSemaphore(limit) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= limit || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active--;
        next();
      });
  };
  return {
    run: fn => new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    }),
    active: () => active,
    queued: () => queue.length
  };
}

// Best-effort client key for rate limiting. Never logged or stored.
function clientKey(req) {
  const fwd = req.headers['x-forwarded-for'];
  const first = Array.isArray(fwd) ? fwd[0] : (fwd || '').split(',')[0];
  return (first || req.headers['x-real-ip'] || (req.socket && req.socket.remoteAddress) || 'unknown').trim();
}

module.exports = { createRateLimiter, createTtlCache, createSemaphore, clientKey };
