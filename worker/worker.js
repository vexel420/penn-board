// Penn Station board relay: a Cloudflare Worker (free plan) that fetches live
// data the page can't use directly and passes it on with permission attached.
//
//   GET /path           PATH's live departures (Port Authority's RidePATH feed),
//                       which doesn't let other websites read it
//   GET /alerts/subway  MTA subway service notices for lines at Penn (1 2 3 A C E,
//                       or the Penn stations), in effect now or within the hour
//   GET /alerts/lirr    LIRR service notices in effect now or within the hour
//   GET /njt            NJ Transit's departures from Penn (station NY), with
//                       tracks and status, plus its station messages. Uses the
//                       owner's NJ Transit RailData login, kept as the Worker
//                       secrets NJT_USERNAME and NJT_PASSWORD (never sent to
//                       the page). Cached 30 s.
//
// The MTA's subway notice file is about 1 MB; filtered here it is a few tens of KB, so
// the board can refresh notices as often as trains. Every response is cached
// for 15-20 seconds, so however many people have the board open, each source is
// asked at most a few times a minute. See worker/README.md for setup.

const PATH_FEED = 'https://www.panynj.gov/bin/portauthority/ridepath.json';
const MTA_ALERTS = {
  subway: 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fsubway-alerts.json',
  lirr: 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Flirr-alerts.json',
};
const PENN_LINES = new Set(['1', '2', '3', 'A', 'C', 'E']);
const PENN_STOP = /^(128|A28)[NS]?$/;
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, OPTIONS' };

const json = (body, seconds) => new Response(body, {
  headers: { ...CORS, 'content-type': 'application/json', 'cache-control': `public, max-age=${seconds}` },
});
const fail = (status, text) => new Response(text, { status, headers: CORS });

async function upstream(url, seconds) {
  const res = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (Penn Station board relay)', accept: 'application/json' },
    cf: { cacheTtl: seconds, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`Upstream answered ${res.status}`);
  return res;
}

// Keep plain-English text only (drop the HTML copies) to shrink the response.
const plain = (t) => (t && t.translation ? { translation: t.translation.filter((x) => x.language === 'en') } : t);

async function alerts(feed) {
  const data = await (await upstream(MTA_ALERTS[feed], 20)).json();
  const soon = Date.now() / 1000 + 3600;
  const now = Date.now() / 1000;
  const entity = (data.entity || []).filter((e) => {
    const a = e.alert || {};
    const meta = a['transit_realtime.mercury_alert'] || {};
    const early = +meta.display_before_active || 0;
    const periods = a.active_period || [];
    const live = !periods.length || periods.some((p) => (+p.start || 0) - early <= soon && now <= (+p.end || Infinity));
    if (!live) return false;
    if (feed !== 'subway') return true;
    return (a.informed_entity || []).some((x) => PENN_LINES.has(x.route_id) || PENN_STOP.test(x.stop_id || ''));
  // The full text is kept: for the subway it holds the MTA's alternatives
  // (transfer stations, shuttle buses), which the board maps; for the LIRR it
  // is used to leave out notices about Grand Central only.
  }).map((e) => ({ ...e, alert: { ...e.alert, header_text: plain(e.alert.header_text),
    description_text: plain(e.alert.description_text) } }));
  return JSON.stringify({ entity });
}

// ---------- NJ Transit RailData ----------
// NJ Transit's servers, tried in order: raildata.njt.gov (the address in the
// developer portal's current docs), the older production address, then test.
const NJT_HOSTS = ['https://raildata.njt.gov/api/TrainData/', 'https://raildata.njtransit.com/api/TrainData/', 'https://testraildata.njtransit.com/api/TrainData/'];
let NJT_API = NJT_HOSTS[0];
const TOKEN_BASE = 'https://penn-board-relay.internal/njt-token';
let njtToken = '', njtTokenFor = '';

async function njtPost(endpoint, fields, host = NJT_API) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.append(k, v);
  const res = await fetch(host + endpoint, { method: 'POST', body, headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`NJ Transit answered ${res.status} to ${endpoint}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}
// NJ Transit limits how many tokens a login may get per day, so the token is
// kept (in memory, and in this location's cache for other instances).
async function getToken(env, fresh) {
  const cache = caches.default;
  // A token kept for one setup (test only, or with production) isn't reused
  // after the other is configured. NJ Transit allows only 10 tokens a day.
  const TOKEN_KEY = `${TOKEN_BASE}-${env.NJT_PROD_USERNAME ? 'prod' : 'test'}`;
  if (njtTokenFor !== TOKEN_KEY) { njtToken = ''; njtTokenFor = TOKEN_KEY; }
  if (!fresh && njtToken) return njtToken;
  if (!fresh) {
    const hit = await cache.match(TOKEN_KEY);
    // Kept with the server that issued it (test or main): a token only works there.
    if (hit) { const k = await hit.json().catch(() => ({})); if (k.token && k.host) { njtToken = k.token; NJT_API = k.host; return njtToken; } }
  }
  // Production and test have separate logins (NJ Transit emails both):
  // NJT_PROD_USERNAME / NJT_PROD_PASSWORD for production, NJT_USERNAME /
  // NJT_PASSWORD for test. Only test tokens carry no tracks or statuses.
  // Each login is tried on each server, production addresses first.
  const creds = [env.NJT_PROD_USERNAME && [env.NJT_PROD_USERNAME, env.NJT_PROD_PASSWORD], [env.NJT_USERNAME, env.NJT_PASSWORD]].filter(Boolean);
  const logins = NJT_HOSTS.flatMap((h) => creds.map(([u, p]) => [h, u, p]));
  let r = null; const tried = [];
  for (const [host, user, pass] of logins) {
    const login = { username: String(user).trim(), password: String(pass).trim() };
    try { r = await njtPost('getToken', login, host); } catch (e) { tried.push(`${new URL(host).host}: ${e.message}`); r = null; continue; }
    if (r && r.UserToken) { NJT_API = host; break; }
    // (A sign-in that fails because of the daily limit isn't retried elsewhere.)
    if (r && /limit|exceed/i.test(r.errorMessage || '')) break;
    tried.push(`${new URL(host).host}: ${(r && r.errorMessage) || 'no token'}`);
  }
  if (!r || !r.UserToken) throw new Error(`NJ Transit did not accept the login (${tried.join('; ')})`);
  njtToken = r.UserToken;
  await cache.put(TOKEN_KEY, new Response(JSON.stringify({ token: njtToken, host: NJT_API }), { headers: { 'cache-control': 'max-age=82800' } }));
  return njtToken;
}
async function njtCall(env, endpoint, fields) {
  // An expired or unknown token comes back as an error: get a new one, once.
  try {
    const r = await njtPost(endpoint, { token: await getToken(env, false), ...fields });
    if (!(r && !Array.isArray(r) && r.errorMessage)) return r;
  } catch (e) {
    if (!/token/i.test(e.message)) throw e;
  }
  return njtPost(endpoint, { token: await getToken(env, true), ...fields });
}
async function njt(env) {
  if (!env.NJT_USERNAME || !env.NJT_PASSWORD) throw new Error('NJ Transit login not set');
  const [sched, msgs] = await Promise.all([
    njtCall(env, 'getTrainSchedule', { station: 'NY' }),
    njtCall(env, 'getStationMSG', { station: 'NY', line: '' }).catch(() => []),
  ]);
  if (!sched || !sched.ITEMS) throw new Error((sched && sched.errorMessage) || 'NJ Transit sent no departures');
  return JSON.stringify({ ITEMS: sched.ITEMS, MESSAGES: Array.isArray(msgs) ? msgs : [] });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method !== 'GET') return fail(405, 'Method not allowed');
    const { pathname } = new URL(request.url);
    try {
      if (pathname === '/path') return json(await (await upstream(PATH_FEED, 15)).text(), 15);
      if (pathname === '/njt-server') {
        // Which NJ Transit server the relay is using (no data, no secrets).
        await getToken(env, false).catch(() => {});
        return json(JSON.stringify({ server: new URL(NJT_API).host }), 0);
      }
      if (pathname === '/njt') {
        const cache = caches.default;
        const key = new Request(request.url, { method: 'GET' });
        const hit = await cache.match(key);
        if (hit) return hit;
        const res = json(await njt(env), 30);
        ctx.waitUntil(cache.put(key, res.clone()));
        return res;
      }
      const m = pathname.match(/^\/alerts\/(subway|lirr)$/);
      if (m) {
        // Filter once per 20 s per Cloudflare location, not once per visitor.
        const cache = caches.default;
        const key = new Request(request.url, { method: 'GET' });
        const hit = await cache.match(key);
        if (hit) return hit;
        const res = json(await alerts(m[1]), 20);
        ctx.waitUntil(cache.put(key, res.clone()));
        return res;
      }
      return fail(404, 'Not found');
    } catch (e) {
      return fail(502, String(e.message || e));
    }
  },
};
