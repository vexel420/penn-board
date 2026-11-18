// Penn Station board relay: a Cloudflare Worker (free plan) that fetches live
// data the page can't read directly, because those sites don't allow other
// websites to read them, and passes it on with permission attached.
//
//   GET /path   PATH's live departures (Port Authority's RidePATH feed)
//
// Responses are cached for 15 seconds, so however many people have the board
// open, PATH's feed is asked at most about four times a minute.
// See worker/README.md for how to set it up.

const SOURCES = {
  '/path': 'https://www.panynj.gov/bin/portauthority/ridepath.json',
};
const CACHE_SECONDS = 15;

export default {
  async fetch(request) {
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, OPTIONS',
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const { pathname } = new URL(request.url);
    const upstream = SOURCES[pathname];
    if (!upstream || request.method !== 'GET') {
      return new Response('Not found', { status: 404, headers: cors });
    }
    try {
      const res = await fetch(upstream, {
        headers: { 'user-agent': 'Mozilla/5.0 (Penn Station board relay)', accept: 'application/json' },
        cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true }, // Cloudflare's own cache
      });
      if (!res.ok) return new Response(`Upstream answered ${res.status}`, { status: 502, headers: cors });
      return new Response(await res.text(), {
        headers: { ...cors, 'content-type': 'application/json', 'cache-control': `public, max-age=${CACHE_SECONDS}` },
      });
    } catch (e) {
      return new Response('Upstream unreachable', { status: 502, headers: cors });
    }
  },
};
