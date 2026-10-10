// Shared by api/check.js (the website) and api/mcp.js (the MCP server), so both
// always use the same platform detection rules.
const USERNAME_REGEX = /^[a-zA-Z0-9-_]{3,50}$/;
const TIMEOUT_MS = 5000;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// A missing page means the name is free and a normal page means it is taken.
// Anything else (403 Cloudflare challenges, 429 rate limits, 5xx errors) tells
// us nothing about the name, so return null and let checkPlatform fall back to
// "check manually" instead of guessing "taken".
const byStatus = async (res) => {
  if (res.status === 404) return true;
  if (res.status >= 200 && res.status < 400) return false;
  return null;
};

const PLATFORM_CHECKS = {
  ebay: {
    // The profile link shown to people (and returned as the manual link).
    url: (u) => `https://www.ebay.com/usr/${encodeURIComponent(u)}`,
    // What we actually request. eBay answers server requests for /usr/ with a
    // 403 bot-protection page, so read the public feedback profile instead:
    // members get a full page with a "Feedback ratings" section, and an unknown
    // name gets a stub page containing a feedback-detail-error component.
    fetchUrl: (u) => `https://www.ebay.com/fdbk/feedback_profile/${encodeURIComponent(u)}`,
    // That stub could also appear when eBay has a problem loading the page, so
    // an "available" answer is re-checked once before it is believed.
    confirmAvailable: true,
    isAvailable: async (res) => {
      if (res.status !== 200 || !res.url.includes('/fdbk/feedback_profile/')) return null;
      const body = await res.text();
      if (!/<title>\s*Feedback Profile/i.test(body)) return null;
      if (body.includes('Feedback ratings')) return false;
      if (body.includes('feedback-detail-error')) return true;
      return null;
    }
  },
  ebaystore: {
    url: (u) => `https://www.ebay.com/str/${encodeURIComponent(u)}`,
    // eBay Store returns 410 when no store exists, 200 when it does.
    // If bot-blocked, eBay redirects away — detect via res.url.
    isAvailable: async (res) => {
      if (!res.url.includes('www.ebay.com/str/')) return null;
      if (res.status === 410) return true;
      return res.status === 200 ? false : null;
    }
  },
  poshmark: {
    url: (u) => `https://poshmark.com/closet/${encodeURIComponent(u)}`,
    isAvailable: byStatus
  },
  grailed: {
    url: (u) => `https://www.grailed.com/users/${encodeURIComponent(u)}`,
    isAvailable: byStatus
  },
  vinted: {
    url: (u) => `https://www.vinted.com/member/${encodeURIComponent(u)}`,
    isAvailable: byStatus
  },
  whatnot: {
    url: (u) => `https://www.whatnot.com/user/${encodeURIComponent(u)}`,
    isAvailable: byStatus
  },
  bonanza: {
    url: (u) => `https://www.bonanza.com/booths/${encodeURIComponent(u)}`,
    // Bonanza 302s to homepage when booth doesn't exist; res.url reflects final URL
    isAvailable: async (res) => res.status >= 400 ? null : !res.url.includes('/booths/')
  },
  chairish: {
    url: (u) => `https://www.chairish.com/shop/${encodeURIComponent(u)}`,
    isAvailable: byStatus
  }
};

const MANUAL_PLATFORMS = {
  depop:    (u) => `https://www.depop.com/${encodeURIComponent(u)}`,
  etsy:     (u) => `https://www.etsy.com/shop/${encodeURIComponent(u)}`,
  mercari:  (u) => `https://www.mercari.com/u/${encodeURIComponent(u)}`,
  rubylane: (u) => `https://www.rubylane.com/shop/${encodeURIComponent(u)}`
};

const ALL_PLATFORM_IDS = new Set([
  ...Object.keys(PLATFORM_CHECKS),
  ...Object.keys(MANUAL_PLATFORMS)
]);

async function checkPlatform(platformId, username) {
  if (MANUAL_PLATFORMS[platformId]) {
    return { status: 'manual', url: MANUAL_PLATFORMS[platformId](username) };
  }

  const platform = PLATFORM_CHECKS[platformId];

  // One request and its verdict: true (free), false (taken) or null (unknown).
  async function lookup() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const target = platform.fetchUrl ? platform.fetchUrl(username) : platform.url(username);
      const res = await fetch(target, {
        signal: controller.signal,
        headers: { 'User-Agent': USER_AGENT }
      });
      return await platform.isAvailable(res);
    } finally {
      clearTimeout(timer);
    }
  }

  try {
    let available = await lookup();
    if (available === true && platform.confirmAvailable) {
      await new Promise(resolve => setTimeout(resolve, 300));
      if ((await lookup()) !== true) available = null;
    }
    if (available === null) return { status: 'manual', url: platform.url(username) };
    return { status: available ? 'available' : 'taken' };
  } catch {
    return { status: 'error', url: platform.url(username) };
  }
}

const PLATFORM_NAMES = {
  ebay: 'eBay',
  ebaystore: 'eBay Store',
  poshmark: 'Poshmark',
  grailed: 'Grailed',
  vinted: 'Vinted',
  whatnot: 'Whatnot',
  bonanza: 'Bonanza',
  chairish: 'Chairish',
  depop: 'Depop',
  etsy: 'Etsy',
  mercari: 'Mercari',
  rubylane: 'Ruby Lane'
};

module.exports = {
  USERNAME_REGEX,
  PLATFORM_CHECKS,
  MANUAL_PLATFORMS,
  PLATFORM_NAMES,
  ALL_PLATFORM_IDS,
  checkPlatform
};
