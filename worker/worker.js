// Penn Station board relay: a Cloudflare Worker (free plan) that fetches live
// data the page can't use directly and passes it on with permission attached.
//
//   GET /path           PATH's live departures (Port Authority's RidePATH feed),
//                       which doesn't let other websites read it
//   GET /alerts/subway  MTA subway service notices for lines at Penn (1 2 3 A C E,
//                       or the Penn stations), in effect now or within the hour
//   GET /alerts/lirr    LIRR service notices in effect now or within the hour
//   GET /path-alerts    PATH's alerts from the last 8 hours (Port Authority)
//   GET /njt            NJ Transit's departures from Penn (station NY), with
//                       tracks and status, plus its station messages. Uses the
//                       owner's NJ Transit RailData login, kept as the Worker
//                       secrets NJT_USERNAME and NJT_PASSWORD (never sent to
//                       the page). Cached 30 s.
//   GET /njt-day        NJ Transit's whole-day schedule from Penn (cached 1 h)
//
// The MTA's subway notice file is about 1 MB; filtered here it is a few tens of KB, so
// the board can refresh notices as often as trains. Every response is cached
// for 15-20 seconds, so however many people have the board open, each source is
// asked at most a few times a minute. See worker/README.md for setup.

const PATH_FEED = 'https://www.panynj.gov/bin/portauthority/ridepath.json';
// PATH's alerts (the Port Authority's site; no CORS header, so relayed too).
const PATH_ALERTS = 'https://www.panynj.gov/bin/portauthority/alerts?agency=PATH&hours=8';
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

async function alerts(feed, aheadHours = 1) {
  const data = await (await upstream(MTA_ALERTS[feed], 20)).json();
  const soon = Date.now() / 1000 + aheadHours * 3600;
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
// NJ Transit allows only 10 sign-ins a day per login, and Cloudflare runs
// this relay in many places at once. The token is therefore kept in Workers KV
// (NJT_KV), which every location shares, so the whole relay normally signs in
// once a day. If NJ Transit says the day's sign-ins are used up, the relay
// stops trying until midnight in New York.
const KV_TOKEN = 'token', KV_BLOCKED = 'signin-blocked';
const secondsToNyMidnight = () => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date()).map((x) => [x.type, +x.value]));
  return Math.max(60, 86400 - (p.hour * 3600 + p.minute * 60 + p.second) + 120);
};
async function getToken(env, fresh) {
  const setup = env.NJT_PROD_USERNAME ? 'prod' : 'test';
  if (njtTokenFor !== setup) { njtToken = ''; njtTokenFor = setup; }
  const kv = env.NJT_KV;
  if (!fresh && njtToken) return njtToken;
  if (!fresh && kv) {
    const k = await kv.get(`${KV_TOKEN}-${setup}`, 'json');
    if (k && k.token && k.host) { njtToken = k.token; NJT_API = k.host; return njtToken; }
  }
  if (!fresh) {
    // A token this location kept before KV was added: share it.
    const hit = await caches.default.match(`${TOKEN_BASE}-${setup}`);
    if (hit) {
      const k = await hit.json().catch(() => ({}));
      if (k.token && k.host) {
        njtToken = k.token; NJT_API = k.host;
        if (kv) await kv.put(`${KV_TOKEN}-${setup}`, JSON.stringify(k), { expirationTtl: 82800 });
        return njtToken;
      }
    }
  }
  if (kv && await kv.get(KV_BLOCKED)) throw new Error('NJ Transit sign-ins are used up for today; trying again after midnight');
  // Each login is tried on each server, production addresses first.
  const creds = [env.NJT_PROD_USERNAME && [env.NJT_PROD_USERNAME, env.NJT_PROD_PASSWORD], [env.NJT_USERNAME, env.NJT_PASSWORD]].filter(Boolean);
  const logins = NJT_HOSTS.flatMap((h) => creds.map(([u, p]) => [h, u, p]));
  let r = null; const tried = [];
  for (const [host, user, pass] of logins) {
    const login = { username: String(user).trim(), password: String(pass).trim() };
    try { r = await njtPost('getToken', login, host); } catch (e) {
      tried.push(`${new URL(host).host}: ${e.message}`); r = null;
      if (/daily usage|limit/i.test(e.message)) { if (kv) await kv.put(KV_BLOCKED, '1', { expirationTtl: secondsToNyMidnight() }); break; }
      continue;
    }
    if (r && r.UserToken) { NJT_API = host; break; }
    tried.push(`${new URL(host).host}: ${(r && r.errorMessage) || 'no token'}`);
  }
  if (!r || !r.UserToken) throw new Error(`NJ Transit did not accept the login (${tried.join('; ')})`);
  njtToken = r.UserToken;
  const keep = JSON.stringify({ token: njtToken, host: NJT_API });
  if (kv) await kv.put(`${KV_TOKEN}-${setup}`, keep, { expirationTtl: 82800 });
  await caches.default.put(`${TOKEN_BASE}-${setup}`, new Response(keep, { headers: { 'cache-control': 'max-age=82800' } }));
  return njtToken;
}
async function njtCall(env, endpoint, fields) {
  // A token NJ Transit no longer accepts comes back as "Invalid token": sign
  // in again, once. (Other errors don't use up a sign-in.)
  try {
    const r = await njtPost(endpoint, { token: await getToken(env, false), ...fields });
    if (!(r && !Array.isArray(r) && /token/i.test(r.errorMessage || ''))) return r;
  } catch (e) {
    if (!/invalid token|token/i.test(e.message) || /did not accept|used up/i.test(e.message)) throw e;
  }
  if (env.NJT_KV) await env.NJT_KV.delete(`${KV_TOKEN}-${env.NJT_PROD_USERNAME ? 'prod' : 'test'}`);
  return njtPost(endpoint, { token: await getToken(env, true), ...fields });
}
async function newarkBoards(env) {
  const key = new Request('https://penn-board-relay.internal/njt-newark-boards');
  try { const h = await caches.default.match(key); if (h) return await h.json(); } catch {}
  const boards = await Promise.all(['NP', 'ND'].map((station) => njtCall(env, 'getTrainSchedule', { station }).catch(() => null)));
  const items = boards.flatMap((b) => (b && b.ITEMS) || []);
  await caches.default.put(key, new Response(JSON.stringify(items), { headers: { 'cache-control': 'max-age=120' } }));
  return items;
}
async function njt(env) {
  if (!env.NJT_USERNAME || !env.NJT_PASSWORD) throw new Error('NJ Transit login not set');
  // Arrivals: trains to New York, from the boards of the stations they pass
  // on the way: Secaucus (most), and for those that skip it, Newark Penn
  // (Northeast Corridor, Coast Line, Raritan Valley) and Newark Broad St
  // (Morris & Essex, Montclair-Boonton). Each lists the train's stops with
  // its New York Penn time. The Newark boards are read every 2 minutes.
  const [sched, msgs, sec, nwk] = await Promise.all([
    njtCall(env, 'getTrainSchedule', { station: 'NY' }),
    njtCall(env, 'getStationMSG', { station: 'NY', line: '' }).catch(() => []),
    njtCall(env, 'getTrainSchedule', { station: 'SE' }).catch(() => null),
    newarkBoards(env),
  ]);
  if (!sched || !sched.ITEMS) throw new Error((sched && sched.errorMessage) || 'NJ Transit sent no departures');
  const goesToNy = (it) => /new york/i.test(it.DESTINATION || '') && (it.STOPS || []).some((x) => /new york penn/i.test(x.STATIONNAME || ''));
  const toNy = [];
  const have = new Set();
  // Secaucus first (closest to New York, so the freshest times), then Newark.
  for (const it of [...((sec && sec.ITEMS) || []), ...nwk]) {
    if (!goesToNy(it) || have.has(it.TRAIN_ID)) continue;
    have.add(it.TRAIN_ID); toNy.push(it);
  }
  // A train leaves Secaucus's list once it departs there, about 12 minutes
  // before New York: remember the ones seen (in this location's cache) until
  // 10 minutes after their New York time.
  const seenKey = new Request('https://penn-board-relay.internal/njt-arrivals-seen');
  let seen = [];
  try { const h = await caches.default.match(seenKey); if (h) seen = await h.json(); } catch {}
  const nyAt = (it) => { const x = (it.STOPS || []).find((y) => /new york penn/i.test(y.STATIONNAME || '')); return x ? Date.parse(String(x.TIME_UTC_FORMAT || '').replace(/^(\d+)-(\w+)-(\d+) /, '$2 $1 $3 ') + ' UTC') : NaN; };
  const ids = new Set(toNy.map((it) => it.TRAIN_ID));
  // Past Secaucus and Newark, a train is followed on its own (NJ Transit's
  // live stop list for that train, read at most every 45 s), so a train held
  // on the way in keeps updating and stays listed until NJ Transit marks it
  // at New York; then for 10 more minutes. (Given up 3 hours past its time.)
  const nyStop = (it) => (it.STOPS || []).find((y) => /new york penn/i.test(y.STATIONNAME || ''));
  const arrivedAt = (it) => { const x = nyStop(it); return x && /^yes$/i.test(String(x.DEPARTED || '')) ? nyAt(it) : 0; };
  const kept = [];
  for (const old of seen) {
    if (ids.has(old.TRAIN_ID)) continue;
    let it = old;
    const done = arrivedAt(it);
    if (done ? done < Date.now() - 10 * 60000 : nyAt(it) < Date.now() - 3 * 3600000) continue;
    if (!done) {
      const k = new Request(`https://penn-board-relay.internal/njt-stops/${encodeURIComponent(old.TRAIN_ID)}`);
      let fresh = null;
      try { const h = await caches.default.match(k); if (h) fresh = await h.json(); } catch {}
      if (!fresh) {
        fresh = await njtCall(env, 'getTrainStopList', { train: old.TRAIN_ID }).catch(() => null);
        if (fresh) await caches.default.put(k, new Response(JSON.stringify(fresh), { headers: { 'cache-control': 'max-age=45' } }));
      }
      const stops = fresh && (fresh.STOPS || (Array.isArray(fresh) && fresh[0] && fresh[0].STOPS));
      if (Array.isArray(stops) && stops.some((y) => /new york penn/i.test(y.STATIONNAME || ''))) it = { ...old, STOPS: stops };
    }
    kept.push({ ...it, PAST_SECAUCUS: true });
  }
  const arrivals = [...toNy, ...kept];
  if (sec && sec.ITEMS) await caches.default.put(seenKey, new Response(JSON.stringify(arrivals.map(({ PAST_SECAUCUS, ...it }) => it)), { headers: { 'cache-control': 'max-age=3600' } }));
  return JSON.stringify({ ITEMS: sched.ITEMS, MESSAGES: Array.isArray(msgs) ? msgs : [], ARRIVALS: arrivals });
}

// ---------- NJ Transit buses (BUSDATA web API, BUSDV2; owner's developer login) ----------
// Per NJ Transit's BUSDATA V1 document: POST form fields; authenticateUser gives a
// token (~24 h), kept in KV like the rail one so the relay signs in about once a day.
const BUS_HOSTS = ['https://pcsdata.njtransit.com/api/BUSDV2/', 'https://testpcsdata.njtransit.com/api/BUSDV2/'];
async function busPost(host, endpoint, fields) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.append(k, v);
  const res = await fetch(host + endpoint, { method: 'POST', body, headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`NJ Transit bus answered ${res.status} to ${endpoint}`);
  return res.json();
}
async function busToken(env, fresh) {
  const kv = env.NJT_KV;
  if (!fresh && kv) { const k = await kv.get('bus-token', 'json'); if (k && k.token) return k; }
  if (kv && await kv.get('bus-signin-blocked')) throw new Error('NJ Transit bus sign-ins paused for today');
  const tried = [];
  for (const host of BUS_HOSTS) {
    try {
      const r = await busPost(host, 'authenticateUser', { username: String(env.NJT_USERNAME).trim(), password: String(env.NJT_PASSWORD).trim() });
      if (r && String(r.Authenticated).toLowerCase() === 'true' && r.UserToken) {
        const k = { token: r.UserToken, host };
        if (kv) await kv.put('bus-token', JSON.stringify(k), { expirationTtl: 20 * 3600 });
        return k;
      }
      tried.push(`${new URL(host).host}: not accepted`);
    } catch (e) { tried.push(`${new URL(host).host}: ${e.message}`); }
  }
  if (kv) await kv.put('bus-signin-blocked', '1', { expirationTtl: 3600 });
  throw new Error(`NJ Transit bus login not accepted (${tried.join('; ')})`);
}
async function busCall(env, endpoint, fields) {
  let k = await busToken(env, false);
  let r = await busPost(k.host, endpoint, { token: k.token, ...fields });
  if (r && !Array.isArray(r) && /token/i.test(r.errorMessage || '')) {
    if (env.NJT_KV) await env.NJT_KV.delete('bus-token');
    k = await busToken(env, true);
    r = await busPost(k.host, endpoint, { token: k.token, ...fields });
  }
  return r;
}


// ---------- GitHub Actions caller check (OIDC) ----------
// A workflow in the owner's repository can ask GitHub for a short-lived signed
// ID token (audience "penn-board-relay"). It's checked here against GitHub's
// published keys: signature, issuer, audience, expiry and repository.
const GH_ISS = 'https://token.actions.githubusercontent.com';
const GH_REPO = 'vexel420/penn-board';
const b64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
async function githubActionsCaller(request) {
  try {
    const m = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') || '');
    if (!m) return false;
    const [h, p, sig] = m[1].split('.');
    const head = JSON.parse(new TextDecoder().decode(b64u(h)));
    const claims = JSON.parse(new TextDecoder().decode(b64u(p)));
    const now = Date.now() / 1000;
    if (head.alg !== 'RS256' || claims.iss !== GH_ISS || claims.aud !== 'penn-board-relay' || claims.repository !== GH_REPO || !(claims.exp > now) || claims.nbf > now + 60) return false;
    const jwks = await (await fetch(`${GH_ISS}/.well-known/jwks`, { cf: { cacheTtl: 3600 } })).json();
    const jwk = (jwks.keys || []).find((k) => k.kid === head.kid);
    if (!jwk) return false;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64u(sig), new TextEncoder().encode(`${h}.${p}`));
  } catch { return false; }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method !== 'GET') return fail(405, 'Method not allowed');
    const { pathname } = new URL(request.url);
    try {
      if (pathname === '/path') return json(await (await upstream(PATH_FEED, 15)).text(), 15);
      if (pathname === '/path-alerts') return json(await (await upstream(PATH_ALERTS, 20)).text(), 20);
      if (pathname === '/njt-server') {
        // Which NJ Transit server the relay is using (no data, no secrets).
        await getToken(env, false).catch(() => {});
        return json(JSON.stringify({ server: new URL(NJT_API).host }), 0);
      }
      if (pathname === '/njt-rail-gtfs') {
        // NJ Transit's rail timetable (GTFS zip) for the weekly rebuild only.
        // Locked: the caller must show a GitHub Actions ID token signed by GitHub
        // for the vexel420/penn-board repository (no shared secret to leak), or
        // the Worker secret REBUILD_KEY. The owner's login stays here.
        const given = request.headers.get('x-rebuild-key') || '';
        const keyOk = env.REBUILD_KEY && given.length === env.REBUILD_KEY.length && given === env.REBUILD_KEY;
        if (!keyOk && !(await githubActionsCaller(request))) return fail(403, 'Forbidden');
        const kv = env.NJT_KV;
        const base = 'https://raildata.njtransit.com/api/GTFSRT/';
        const post = async (url, fields) => { const b = new FormData(); for (const [k, v] of Object.entries(fields)) b.append(k, v); return fetch(url, { method: 'POST', body: b }); };
        let tok = kv && await kv.get('gtfs-token-rail');
        for (let attempt = 0; attempt < 2; attempt++) {
          if (!tok) {
            const r = await post(base + 'getToken', { username: String(env.NJT_USERNAME).trim(), password: String(env.NJT_PASSWORD).trim() });
            let j = null; try { j = await r.json(); } catch {}
            if (!j || !j.UserToken) return fail(502, 'NJ Transit timetable sign-in not accepted');
            tok = j.UserToken;
            if (kv) await kv.put('gtfs-token-rail', tok, { expirationTtl: 20 * 3600 });
          }
          const r = await post(base + 'getGTFS', { token: tok });
          const type = r.headers.get('content-type') || '';
          if (r.ok && !/json/i.test(type)) return new Response(r.body, { headers: { 'content-type': 'application/zip' } });
          tok = null;  // token refused: sign in again once
          if (kv) await kv.delete('gtfs-token-rail');
        }
        return fail(502, 'NJ Transit timetable not available');
      }
      if (pathname === '/mta-bus-stop') {
        // Next MTA buses at one stop (MTA Bus Time, SIRI stop monitoring; owner's key
        // MTA_BUSTIME_KEY stays here). ?stop= is the Bus Time stop code. Cached 30 s.
        const stop = new URL(request.url).searchParams.get('stop') || '';
        if (!/^\d{6}$/.test(stop)) return fail(400, 'stop must be a 6-digit Bus Time stop code');
        if (!env.MTA_BUSTIME_KEY) return fail(503, 'MTA Bus Time key not set');
        const cache = caches.default, key = new Request(`https://cache.local/mta-bus-stop/${stop}`);
        const hit = await cache.match(key);
        if (hit) return hit;
        const u = `https://bustime.mta.info/api/siri/stop-monitoring.json?version=2&key=${encodeURIComponent(String(env.MTA_BUSTIME_KEY).trim())}&MonitoringRef=${stop}&MaximumStopVisits=12`;
        const r = await fetch(u, { headers: { accept: 'application/json' } });
        if (!r.ok) return fail(502, `MTA Bus Time answered ${r.status}`);
        const d = await r.json();
        const visits = (((d.Siri || {}).ServiceDelivery || {}).StopMonitoringDelivery || [])[0]?.MonitoredStopVisit || [];
        const arr = (x) => (Array.isArray(x) ? x[0] : x) || '';
        const buses = visits.map((v) => {
          const j = v.MonitoredVehicleJourney || {}, c = j.MonitoredCall || {};
          return { line: arr(j.PublishedLineName), dest: arr(j.DestinationName), dir: j.DirectionRef,
            at: c.ExpectedArrivalTime || c.ExpectedDepartureTime || c.AimedArrivalTime || null,
            away: (c.Extensions && c.Extensions.Distances && c.Extensions.Distances.PresentableDistance) || arr(c.ArrivalProximityText) || '' };
        });
        const res = json(JSON.stringify({ stop, buses }), 30);
        ctx.waitUntil(cache.put(key, res.clone()));
        return res;
      }
      if (pathname === '/njt-bus-pabt') {
        // Live NJ Transit bus departures from Port Authority Bus Terminal (next hour), cached 30 s.
        const cache = caches.default, key = new Request(request.url, { method: 'GET' });
        const hit = await cache.match(key);
        if (hit) return hit;
        const d = await busCall(env, 'getBusDV', { stop: 'PABT', direction: '', route: '', IP: '' });
        const res = json(JSON.stringify(d), 30);
        ctx.waitUntil(cache.put(key, res.clone()));
        return res;
      }
      if (pathname === '/njt-day') {
        // The day's whole schedule from Penn (NJ Transit trains only), for
        // the last trains before the overnight break. Cached 1 hour.
        const cache = caches.default;
        const key = new Request(request.url, { method: 'GET' });
        const hit = await cache.match(key);
        if (hit) return hit;
        const r = await njtCall(env, 'getStationSchedule', { station: 'NY', NJTOnly: 'true' });
        const items = (Array.isArray(r) ? r.flatMap((x) => x.ITEMS || []) : (r && r.ITEMS) || [])
          .map((x) => ({ t: x.SCHED_DEP_DATE, id: x.TRAIN_ID, line: x.LINE, dest: x.DESTINATION }));
        const res = json(JSON.stringify({ ITEMS: items }), 3600);
        ctx.waitUntil(cache.put(key, res.clone()));
        return res;
      }
      if (pathname === '/njt') {
        const cache = caches.default;
        const key = new Request(request.url, { method: 'GET' });
        const hit = await cache.match(key);
        if (hit) return hit;
        // The last good copy is kept 6 h, and sent (marked STALE with its
        // time) if NJ Transit can't be reached, rather than an error.
        const lastKey = new Request('https://penn-board-relay.internal/njt-last');
        try {
          const body = await njt(env);
          const res = json(body, 30);
          ctx.waitUntil(cache.put(key, res.clone()));
          ctx.waitUntil(cache.put(lastKey, new Response(JSON.stringify({ at: Date.now(), body }), { headers: { 'cache-control': 'max-age=21600' } })));
          return res;
        } catch (e) {
          const last = await cache.match(lastKey);
          if (!last) throw e;
          const { at, body } = await last.json();
          const d = JSON.parse(body);
          d.STALE = { since: Math.round(at / 1000), reason: String(e.message || e).slice(0, 200) };
          return json(JSON.stringify(d), 15);
        }
      }
      const m = pathname.match(/^\/alerts\/(subway|lirr)$/);
      if (m) {
        // Filter once per 20 s per Cloudflare location, not once per visitor.
        const cache = caches.default;
        const key = new Request(request.url, { method: 'GET' });
        const hit = await cache.match(key);
        if (hit) return hit;
        // ?ahead=168: notices starting within a week (the board's map preview).
        const ahead = Math.min(168, Math.max(1, +new URL(request.url).searchParams.get('ahead') || 1));
        const res = json(await alerts(m[1], ahead), 20);
        ctx.waitUntil(cache.put(key, res.clone()));
        return res;
      }
      return fail(404, 'Not found');
    } catch (e) {
      return fail(502, String(e.message || e));
    }
  },
};
