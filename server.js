// Penn Station live board: one small server, no dependencies (Node 18+).
// It gathers LIRR, NJ Transit, Amtrak and subway data, normalises it,
// and serves it to the page in /public as a single JSON document.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const NJT_USERNAME = process.env.NJT_USERNAME || '';
const NJT_PASSWORD = process.env.NJT_PASSWORD || '';
const PUBLIC = path.join(__dirname, 'public');
const TOKEN_FILE = path.join(__dirname, '.njt-token.json');

// ---------- helpers ----------

async function get(url, opts = {}) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
  return res;
}

const now = () => Math.floor(Date.now() / 1000);

// Wall-clock time in New York -> unix seconds.
function nyToEpoch(y, mo, d, h, mi, s) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(new Date(guess)).reduce((a, p) => (a[p.type] = +p.value, a), {});
  const asNy = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return Math.floor((guess - (asNy - guess)) / 1000);
}

// Each source is fetched at most once per `ttl` seconds; a failure keeps the
// last good rows on the board and reports the error alongside them.
function source(name, ttl, load) {
  const state = { data: null, at: 0, error: null, pending: null };
  return async () => {
    if (now() - state.at >= ttl && !state.pending) {
      state.pending = load()
        .then((data) => { state.data = data; state.error = null; })
        .catch((e) => { state.error = e.message || String(e); console.error(`[${name}]`, state.error); })
        .finally(() => { state.at = now(); state.pending = null; });
    }
    if (state.pending && (state.data === null || now() - state.at > ttl * 3)) await state.pending;
    return { data: state.data, error: state.error };
  };
}

// ---------- minimal protobuf reader (enough for GTFS-realtime) ----------

function readFields(buf) {
  const out = [];
  let p = 0;
  const varint = () => {
    let v = 0, mul = 1, b;
    do { b = buf[p++]; v += (b & 0x7f) * mul; mul *= 128; } while (b & 0x80);
    return v;
  };
  while (p < buf.length) {
    const tag = varint();
    const field = Math.floor(tag / 8), wire = tag & 7;
    if (wire === 0) out.push([field, varint()]);
    else if (wire === 2) { const len = varint(); out.push([field, buf.subarray(p, p + len)]); p += len; }
    else if (wire === 1) p += 8;
    else if (wire === 5) p += 4;
    else break;
  }
  return out;
}
const first = (fields, n) => { const f = fields.find((x) => x[0] === n); return f ? f[1] : undefined; };
const all = (fields, n) => fields.filter((x) => x[0] === n).map((x) => x[1]);
const str = (b) => (b ? Buffer.from(b).toString('utf8') : '');

// -> [{ route, stops: [{ id, time }] }]
function parseTripUpdates(buf) {
  const trips = [];
  for (const entity of all(readFields(buf), 2)) {
    const tu = first(readFields(entity), 3);
    if (!tu) continue;
    const f = readFields(tu);
    const trip = readFields(first(f, 1) || Buffer.alloc(0));
    const stops = all(f, 2).map((s) => {
      const sf = readFields(s);
      const ev = first(sf, 3) || first(sf, 2);
      return { id: str(first(sf, 4)), time: ev ? first(readFields(ev), 2) : undefined };
    });
    trips.push({ route: str(first(trip, 5)), stops });
  }
  return trips;
}

// ---------- subway ----------

const SUBWAY_FEEDS = [
  'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs',
  'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-ace',
];
const PENN_STOPS = new Set(['128', 'A28']); // 34 St-Penn Station: 1/2/3 and A/C/E
const TERMINALS = {
  101: 'Van Cortlandt Park-242 St', 103: '238 St', 106: '215 St', 112: '168 St', 137: 'Chambers St', 142: 'South Ferry',
  201: 'Wakefield-241 St', 204: 'Nereid Av', 213: 'E 180 St', 234: 'Nevins St', 247: 'Flatbush Av-Brooklyn College',
  301: 'Harlem-148 St', 120: '96 St', 127: 'Times Sq-42 St', 132: '14 St', 250: 'Crown Hts-Utica Av', 257: 'New Lots Av',
  A02: 'Inwood-207 St', A09: '168 St', A15: '125 St', A24: '59 St-Columbus Circle', A55: 'Euclid Av',
  A61: 'Rockaway Blvd', A65: 'Ozone Park-Lefferts Blvd', H11: 'Far Rockaway-Mott Av', H15: 'Rockaway Park-Beach 116 St',
  H04: 'Broad Channel', E01: 'World Trade Center', G05: 'Jamaica Center', F01: 'Jamaica-179 St', F06: 'Kew Gardens-Union Tpke',
  A27: '42 St-Port Authority', A32: 'W 4 St', A34: 'Chambers St', A36: 'Fulton St', A41: 'Jay St-MetroTech',
};

const subway = source('subway', 20, async () => {
  const feeds = await Promise.all(SUBWAY_FEEDS.map(async (u) =>
    parseTripUpdates(Buffer.from(await (await get(u)).arrayBuffer()))));
  const t = now();
  const groups = new Map();
  for (const trip of feeds.flat()) {
    const stop = trip.stops.find((s) => PENN_STOPS.has(s.id.slice(0, -1)));
    if (!stop || !stop.time || stop.time < t - 30 || stop.time > t + 3600) continue;
    const dir = stop.id.slice(-1); // N = uptown, S = downtown
    const last = trip.stops[trip.stops.length - 1].id.slice(0, -1);
    const route = trip.route.replace(/X$/, '');
    const key = route + dir;
    if (!groups.has(key)) groups.set(key, { route, dir, trains: [] });
    groups.get(key).trains.push({ time: stop.time, dest: TERMINALS[last] || '' });
  }
  return [...groups.values()].map((g) => {
    g.trains.sort((a, b) => a.time - b.time);
    g.trains = g.trains.slice(0, 4);
    return g;
  }).sort((a, b) => (a.route + a.dir).localeCompare(b.route + b.dir));
});

// ---------- PATH (Port Authority feed; 33 St station, a block east of Penn) ----------

function parsePath(feed) {
  const station = (feed.results || []).find((r) => r.consideredStation === '33S');
  if (!station) return [];
  const t = now();
  return (station.destinations || []).flatMap((d) => d.messages || [])
    .map((m) => ({
      dest: m.headSign || m.target || '',
      colors: String(m.lineColor || '').split(',').map((c) => c.trim()).filter((c) => /^[0-9a-f]{6}$/i.test(c)),
      time: t + Math.max(0, parseInt(m.secondsToArrival, 10) || 0),
    }))
    .sort((a, b) => a.time - b.time);
}
const pathTrains = source('path', 30, async () =>
  parsePath(await (await get('https://www.panynj.gov/bin/portauthority/ridepath.json')).json()));

// ---------- LIRR (MTA TrainTime) ----------

const LIRR_STATIONS = {
  ABT: 'Albertson', AGT: 'Amagansett', AVL: 'Amityville', ATL: 'Atlantic Terminal', ADL: 'Auburndale', BTA: 'Babylon',
  BWN: 'Baldwin', BSR: 'Bay Shore', BSD: 'Bayside', BRS: 'Bellerose', BMR: 'Bellmore', BPT: 'Bellport', BRT: 'Belmont Park',
  BPG: 'Bethpage', BWD: 'Brentwood', BHN: 'Bridgehampton', BDY: 'Broadway', CPL: 'Carle Place', CHT: 'Cedarhurst',
  CI: 'Central Islip', CAV: 'Centre Avenue', CSH: 'Cold Spring Harbor', CPG: 'Copiague', CLP: 'Country Life Press',
  DPK: 'Deer Park', DGL: 'Douglaston', EHN: 'East Hampton', ENY: 'East New York', ERY: 'East Rockaway', EWN: 'East Williston',
  EMT: 'Elmont-UBS Arena', FRY: 'Far Rockaway', FMD: 'Farmingdale', FPK: 'Floral Park', FLS: 'Flushing-Main St',
  FHL: 'Forest Hills', FPT: 'Freeport', GCY: 'Garden City', GBN: 'Gibson', GCV: 'Glen Cove', GHD: 'Glen Head',
  GST: 'Glen Street', GCT: 'Grand Central', GNK: 'Great Neck', GRV: 'Great River', GWN: 'Greenlawn', GPT: 'Greenport',
  GVL: 'Greenvale', HBY: 'Hampton Bays', HGN: 'Hempstead Gardens', HEM: 'Hempstead', HWT: 'Hewlett', HVL: 'Hicksville',
  HOL: 'Hollis', HPA: 'Hunterspoint Av', HUN: 'Huntington', IWD: 'Inwood', IPK: 'Island Park', ISP: 'Islip', JAM: 'Jamaica',
  KGN: 'Kew Gardens', KPK: 'Kings Park', LVW: 'Lakeview', LTN: 'Laurelton', LCE: 'Lawrence', LHT: 'Lindenhurst',
  LNK: 'Little Neck', LMR: 'Locust Manor', LVL: 'Locust Valley', LBH: 'Long Beach', LIC: 'Long Island City', LYN: 'Lynbrook',
  MVN: 'Malverne', MHT: 'Manhasset', MPK: 'Massapequa Park', MQA: 'Massapequa', MSY: 'Mastic-Shirley', MAK: 'Mattituck',
  MFD: 'Medford', MAV: 'Merillon Av', MRK: 'Merrick', SSM: 'Mets-Willets Point', MIN: 'Mineola', MTK: 'Montauk',
  MHL: 'Murray Hill', NBD: 'Nassau Blvd', NHP: 'New Hyde Park', NPT: 'Northport', NAV: 'Nostrand Av', ODL: 'Oakdale',
  ODE: 'Oceanside', OBY: 'Oyster Bay', PGE: 'Patchogue', NYK: 'Penn Station', PLN: 'Pinelawn', PDM: 'Plandome',
  PJN: 'Port Jefferson', PWS: 'Port Washington', QVG: 'Queens Village', RHD: 'Riverhead', RVC: 'Rockville Centre',
  RON: 'Ronkonkoma', ROS: 'Rosedale', RSN: 'Roslyn', SVL: 'Sayville', SCF: 'Sea Cliff', SFD: 'Seaford', STN: 'Smithtown',
  SHN: 'Southampton', SHD: 'Southold', SPK: 'Speonk', SAB: 'St. Albans', SJM: 'St. James', SMR: 'Stewart Manor',
  BK: 'Stony Brook', SYT: 'Syosset', VSM: 'Valley Stream', WGH: 'Wantagh', WHD: 'West Hempstead', WBY: 'Westbury',
  WHN: 'Westhampton', WWD: 'Westwood', WMR: 'Woodmere', WDD: 'Woodside', WYD: 'Wyandanch', YPK: 'Yaphank',
};
const LIRR_BRANCHES = {
  BY: 'Babylon', HH: 'Huntington', PJ: 'Port Jefferson', RK: 'Ronkonkoma', PW: 'Port Washington', LB: 'Long Beach',
  FR: 'Far Rockaway', HM: 'Hempstead', WH: 'West Hempstead', OB: 'Oyster Bay', MK: 'Montauk', GP: 'Greenport',
  BP: 'Belmont Park', CI: 'City Terminal',
};
const stationName = (c) => LIRR_STATIONS[c] || c;

const lirr = source('lirr', 20, async () => {
  const res = await get('https://backend-unified.mylirr.org/arrivals/NYK', { headers: { 'accept-version': '3.0' } });
  const { arrivals = [] } = await res.json();
  const rows = { departures: [], arrivals: [] };
  for (const a of arrivals) {
    const leaving = a.direction === 'E';
    const stops = (a.stops || []).filter((c) => c !== 'NYK');
    const lateMin = a.status && a.status.otp < 0 ? Math.round(-a.status.otp / 60) : 0;
    let status = 'On time', tone = 'ok';
    if (a.status && a.status.canceled) { status = 'Cancelled'; tone = 'stop'; }
    else if (a.status && a.status.held) { status = 'Held'; tone = 'late'; }
    else if (lateMin >= 2) { status = `${lateMin} min late`; tone = 'late'; }
    else if (leaving && a.track) { status = 'Boarding'; tone = 'go'; }
    else if (a.stop_status === 'DEPARTED') { status = 'Departed'; tone = 'quiet'; }
    else if (a.stop_status === 'ARRIVED') { status = 'Arrived'; tone = 'go'; }
    rows[leaving ? 'departures' : 'arrivals'].push({
      id: a.train_id,
      carrier: 'lirr',
      time: a.time,
      place: stationName(leaving ? stops[stops.length - 1] : stops[0]),
      line: `${LIRR_BRANCHES[a.branch] || a.branch} Branch`,
      train: a.train_num,
      track: a.track || '',
      trackLikely: a.track ? '' : (a.sched_track || ''),
      status, tone,
      via: stops.slice(leaving ? 0 : 1, leaving ? -1 : undefined).map(stationName),
    });
  }
  return rows;
});

// ---------- Amtrak (via the community Amtraker feed; Amtrak has no public API) ----------

const amtrak = source('amtrak', 60, async () => {
  const trains = await (await get('https://api-v3.amtraker.com/v3/trains')).json();
  const rows = { departures: [], arrivals: [] };
  const t = now();
  const epoch = (iso) => (iso ? Math.floor(Date.parse(iso) / 1000) : 0);
  for (const list of Object.values(trains)) {
    for (const tr of list) {
      if (tr.trainState === 'Completed') continue;
      const stop = (tr.stations || []).find((s) => s.code === 'NYP');
      if (!stop || stop.status === 'Departed') continue;
      const base = { carrier: 'amtrak', line: tr.routeName, train: tr.trainNum, track: stop.platform || '', trackLikely: '', via: [] };
      const row = (kind, sched, est, place) => {
        if (!sched) return;
        const when = est || sched;
        if (when < t - 300 || when > t + 8 * 3600) return;
        const late = Math.round((when - sched) / 60);
        let status = 'On time', tone = 'ok';
        if (late >= 5) { status = `${late} min late`; tone = 'late'; }
        else if (stop.status === 'Station') { status = kind === 'departures' ? 'Boarding' : 'Arrived'; tone = 'go'; }
        rows[kind].push({ ...base, id: `amtk-${tr.trainID}-${kind}`, time: when, sched, place, status, tone });
      };
      if (tr.destCode !== 'NYP') row('departures', epoch(stop.schDep), epoch(stop.dep), tr.destName);
      if (tr.origCode !== 'NYP') row('arrivals', epoch(stop.schArr), epoch(stop.arr), tr.origName);
    }
  }
  return rows;
});

// ---------- NJ Transit (official RailData API; needs a free developer login) ----------

const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
function njtTime(s) { // "17-Nov-2026 10:05:00 PM"
  const m = /^(\d+)-(\w+)-(\d+) (\d+):(\d+):(\d+) (AM|PM)$/.exec(s || '');
  if (!m) return 0;
  const h = (+m[4] % 12) + (m[7] === 'PM' ? 12 : 0);
  return nyToEpoch(+m[3], MONTHS[m[2]], +m[1], h, +m[5], +m[6]);
}

async function njtPost(endpoint, fields) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.append(k, v);
  const res = await get(`https://raildata.njtransit.com/api/TrainData/${endpoint}`, { method: 'POST', body });
  return res.json();
}

// NJ Transit limits how many tokens a login may request per day, so keep it on disk.
let njtToken = '';
try { njtToken = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')).token || ''; } catch {}
async function njtNewToken() {
  const r = await njtPost('getToken', { username: NJT_USERNAME, password: NJT_PASSWORD });
  if (!r.UserToken) throw new Error('NJ Transit rejected the login');
  njtToken = r.UserToken;
  try { fs.writeFileSync(TOKEN_FILE, JSON.stringify({ token: njtToken })); } catch {}
}

const njt = source('njt', 30, async () => {
  if (!NJT_USERNAME || !NJT_PASSWORD) return null;
  if (!njtToken) await njtNewToken();
  let r = await njtPost('getTrainSchedule', { token: njtToken, station: 'NY' });
  if (!r.ITEMS) { await njtNewToken(); r = await njtPost('getTrainSchedule', { token: njtToken, station: 'NY' }); }
  if (!r.ITEMS) throw new Error(r.errorMessage || 'NJ Transit sent no departures');
  return r.ITEMS.map((it) => {
    const raw = (it.STATUS || '').trim();
    const lateMin = Math.round((+it.SEC_LATE || 0) / 60);
    const up = raw.toUpperCase();
    // NJ Transit's terms ask that its data be shown as-is, so the status text
    // is passed through untouched; only the row's colour is derived from it.
    const status = raw;
    let tone = 'ok';
    if (up.includes('CANCEL')) tone = 'stop';
    else if (up.includes('ALL ABOARD') || up.includes('BOARDING')) tone = 'go';
    else if (up.includes('STAND BY') || up.includes('DELAY') || up.includes('LATE') || lateMin >= 2) tone = 'late';
    const isAmtrak = /AMTRAK|AMTK/i.test(`${it.LINE} ${it.LINEABBREVIATION}`) || /^A\d/.test(it.TRAIN_ID || '');
    const sched = njtTime(it.SCHED_DEP_DATE);
    return {
      id: `njt-${it.TRAIN_ID}`,
      carrier: isAmtrak ? 'amtrak' : 'njt',
      time: sched,
      place: (it.DESTINATION || '').replace(/&nbsp;/g, ' ').trim(),
      line: it.LINE || '',
      train: String(it.TRAIN_ID || '').replace(/^A(?=\d)/, ''),
      track: (it.TRACK || '').trim(),
      trackLikely: '',
      status, tone,
      via: (it.STOPS || []).map((s) => s.STATIONNAME).filter(Boolean).slice(0, -1),
    };
  });
});

// ---------- the board ----------

async function board() {
  const [l, n, a, s, p] = await Promise.all([lirr(), njt(), amtrak(), subway(), pathTrains()]);
  const t = now();
  const departures = [...(l.data ? l.data.departures : [])];
  const arrivals = [...(l.data ? l.data.arrivals : [])];
  const amtrakDeps = a.data ? a.data.departures.map((r) => ({ ...r })) : [];

  // NJ Transit's Penn Station feed also lists Amtrak departures with their
  // tracks; use it to fill in tracks Amtrak itself doesn't publish.
  for (const row of n.data || []) {
    if (row.carrier === 'amtrak') {
      const match = amtrakDeps.find((d) => d.train === row.train);
      if (match) {
        if (row.track) match.track = row.track;
        if (row.status && (row.tone === 'go' || row.tone === 'stop')) { match.status = row.status; match.tone = row.tone; }
      } else amtrakDeps.push(row);
    } else departures.push(row);
  }
  departures.push(...amtrakDeps);
  if (a.data) arrivals.push(...a.data.arrivals);

  const live = (r) => r.time > t - 120;
  const byTime = (x, y) => x.time - y.time;
  return {
    at: t,
    departures: departures.filter(live).sort(byTime),
    arrivals: arrivals.filter(live).sort(byTime),
    subway: s.data || [],
    path: p.data || [],
    sources: {
      lirr: { ok: !!l.data && !l.error, error: l.error },
      njt: { ok: !!n.data && !n.error, error: n.error, needsLogin: !NJT_USERNAME || !NJT_PASSWORD },
      amtrak: { ok: !!a.data && !a.error, error: a.error, tracks: !!n.data },
      subway: { ok: !!s.data && !s.error, error: s.error },
      path: { ok: !!p.data && !p.error, error: p.error },
    },
  };
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };

if (require.main === module) http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/board') {
    try {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(await board()));
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  const file = path.join(PUBLIC, path.normalize(url.pathname === '/' ? '/index.html' : url.pathname));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, () => console.log(`Penn Station board on http://localhost:${PORT}`));

module.exports = { parsePath };
