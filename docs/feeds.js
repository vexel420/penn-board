// Feed readers shared by the server (server.js) and the page (docs/app.js).
// LIRR, Amtrak and the subway allow browsers to read them directly, so the
// page can run with no server; NJ Transit and PATH need server.js.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PennFeeds = factory();
})(typeof self !== 'undefined' ? self : this, function () {

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
// A forced read (the page's on-the-minute refresh) fetches again and waits for
// the answer, unless the last fetch was under FORCE_GAP seconds ago. That gap
// stops many open pages from multiplying requests to a feed.
const FORCE_GAP = 10;
function source(name, ttl, load) {
  const state = { data: null, at: 0, error: null, pending: null };
  return async (force = false) => {
    if (now() - state.at >= (force ? Math.min(ttl, FORCE_GAP) : ttl) && !state.pending) {
      state.pending = load()
        .then((data) => { state.data = data; state.error = null; })
        .catch((e) => { state.error = e.message || String(e); if (typeof window === 'undefined') console.error(`[${name}]`, state.error); })
        .finally(() => { state.at = now(); state.pending = null; });
    }
    if (state.pending && (force || state.data === null || now() - state.at > ttl * 3)) await state.pending;
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
const utf8 = new TextDecoder();
const str = (b) => (b ? utf8.decode(b) : '');

// -> [{ route, stops: [{ id, time }] }]
function parseTripUpdates(buf) {
  const trips = [];
  for (const entity of all(readFields(buf), 2)) {
    const tu = first(readFields(entity), 3);
    if (!tu) continue;
    const f = readFields(tu);
    const trip = readFields(first(f, 1) || new Uint8Array(0));
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

// The B/D/F/M feed is read too: those lines are the ones usually sent along
// the 8 Av line through Penn when there's a service change.
const SUBWAY_FEEDS = [
  'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs',
  'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-ace',
  'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-bdfm',
];
const PENN_STOPS = new Set(['128', 'A28']); // 34 St-Penn Station: 7 Av line and 8 Av line

// Express or local from Penn, by the stops the train actually makes next:
// a local calls at 28 St or 50 St (7 Av line) or 23 St or 50 St (8 Av line),
// an express runs past them. Works for night service (the 2 and 3 go local)
// and for rerouted trains. Too few stops to tell: the line's usual service.
const LOCAL_NEXT = new Set(['129', '126', 'A30', 'A25']);
const USUALLY_EXPRESS = new Set(['2', '3', 'A']);
function serviceFromPenn(route, stops) {
  const next = stops.slice(1, 4);
  if (next.some((s) => LOCAL_NEXT.has(s))) return 'local';
  if (next.length >= 2) return 'express';
  return USUALLY_EXPRESS.has(route) ? 'express' : 'local';
}

// Each train keeps the stations it will call at from Penn onwards (station
// ids). The page names them, colours each line and spots reroutes using
// docs/subway-data.json.
const subway = source('subway', 20, async () => {
  const feeds = await Promise.all(SUBWAY_FEEDS.map(async (u) =>
    parseTripUpdates(new Uint8Array(await (await get(u)).arrayBuffer()))));
  const t = now();
  const groups = new Map();
  for (const trip of feeds.flat()) {
    const at = trip.stops.findIndex((s) => PENN_STOPS.has(s.id.slice(0, -1)));
    if (at < 0) continue;
    const stop = trip.stops[at];
    if (!stop.time || stop.time < t - 30 || stop.time > t + 3600) continue;
    const dir = stop.id.slice(-1); // N = uptown, S = downtown
    const route = trip.route.replace(/X$/, '');
    const stops = trip.stops.slice(at).map((s) => s.id.slice(0, -1));
    const svc = serviceFromPenn(route, stops);
    const key = route + dir + svc;
    if (!groups.has(key)) groups.set(key, { route, dir, svc, trains: [] });
    groups.get(key).trains.push({ time: stop.time, stops });
  }
  return [...groups.values()].map((g) => {
    g.trains.sort((a, b) => a.time - b.time);
    g.trains = g.trains.slice(0, 4);
    return g;
  }).sort((a, b) => (a.route + a.dir + a.svc).localeCompare(b.route + b.dir + b.svc));
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
    const delaySec = a.status && a.status.otp < 0 ? -a.status.otp : 0;
    const lateMin = Math.round(delaySec / 60);
    let status = 'On time', tone = 'ok';
    const departed = a.stop_status === 'DEPARTED';
    if (a.status && a.status.canceled) { status = 'Cancelled'; tone = 'stop'; }
    else if (leaving && departed) { status = 'Departed'; tone = 'quiet'; }
    else if (a.status && a.status.held) { status = 'Held'; tone = 'late'; }
    else if (leaving && a.track) { status = 'Boarding'; tone = 'go'; } // even if late
    else if (lateMin >= 2) { status = `${lateMin} min late`; tone = 'late'; }
    else if (a.stop_status === 'DEPARTED') { status = 'Departed'; tone = 'quiet'; }
    else if (a.stop_status === 'ARRIVED') { status = 'Arrived'; tone = 'go'; }
    rows[leaving ? 'departures' : 'arrivals'].push({
      id: a.train_id,
      carrier: 'lirr',
      // LIRR lists the scheduled time and reports the delay separately (otp,
      // seconds, negative = late): show and sort by the real expected time.
      time: a.time + delaySec,
      sched: a.time,
      lateMin,
      fare: a.peak_code === 'P' ? 'peak' : a.peak_code === 'O' ? 'offpeak' : '', // LIRR peak or off-peak fare
      place: stationName(leaving ? stops[stops.length - 1] : stops[0]),
      line: `${LIRR_BRANCHES[a.branch] || a.branch} Branch`,
      train: a.train_num,
      track: a.track || '',
      trackLikely: a.track ? '' : (a.sched_track || ''),
      status, tone,
      // Departures: LIRR says when a train has left; `leaves` is the clock
      // fallback (its listed time may not include a delay, so add it).
      departed: leaving && departed,
      leaves: a.time + delaySec,
      via: stops.slice(leaving ? 0 : 1, leaving ? -1 : undefined).map(stationName),
      viaCodes: stops.slice(leaving ? 0 : 1, leaving ? -1 : undefined), // to match LIRR's per-train progress
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
      // Amtrak never reports a train ending at Penn as "at the station": it
      // marks the whole trip Completed, a few minutes after arrival. Show it
      // as Arrived until 5 minutes after it got in.
      if (tr.trainState === 'Completed') {
        const end = (tr.stations || []).find((s) => s.code === 'NYP');
        const got = end && epoch(end.arr || end.schArr);
        if (tr.destCode === 'NYP' && got && got > t - 300) {
          rows.arrivals.push({ carrier: 'amtrak', line: tr.routeName, train: tr.trainNum, track: '', trackLikely: '', via: [],
            id: `amtk-${tr.trainID}-arrivals`, time: got, sched: epoch(end.schArr), place: tr.origName, status: 'Arrived', tone: 'go', leaves: got });
        }
        continue;
      }
      const stop = (tr.stations || []).find((s) => s.code === 'NYP');
      if (!stop) continue;
      // Stops along the way, as LIRR rows have them: trains only (no
      // connecting buses), without Penn itself or the far end of the trip.
      const stations = tr.stations || [];
      const at = stations.indexOf(stop);
      const names = (list) => list.filter((x) => !x.bus).map((x) => x.name);
      const viaOut = names(stations.slice(at + 1)).slice(0, -1);
      const viaIn = names(stations.slice(0, at)).slice(1);
      // How far an arriving train has got: Amtrak marks each station it has left.
      const viaInState = stations.slice(0, at).filter((x) => !x.bus).slice(1)
        .map((x) => (x.status === 'Departed' ? 'passed' : x.status === 'Station' ? 'here' : ''));
      const notes = (tr.alerts || []).map((x) => (typeof x === 'string' ? x : x && (x.message || x.text || x.header) || '')).filter(Boolean);
      const base = { carrier: 'amtrak', notes, departsByFeed: true, line: tr.routeName, train: tr.trainNum, track: stop.platform || '', trackLikely: '' };
      if (stop.status === 'Departed') {
        // Keep a train that has just left Penn, so the board can say so.
        const left = epoch(stop.dep);
        if (tr.destCode !== 'NYP' && left > t - 900) {
          rows.departures.push({ ...base, via: viaOut, id: `amtk-${tr.trainID}-departures`, time: left, sched: epoch(stop.schDep), place: tr.destName,
            status: 'Departed', tone: 'quiet', departed: true, departedAt: left, leaves: left });
        }
        continue;
      }
      // A through train (say Boston to Washington) arrives and then departs:
      // its arrival stays listed until it has left Penn.
      const throughTo = tr.origCode !== 'NYP' && tr.destCode !== 'NYP' ? tr.destName : '';
      const depSched = epoch(stop.schDep);
      const depWhen = depSched ? Math.max(epoch(stop.dep) || depSched, depSched) : 0;
      const arrivedByTime = tr.origCode !== 'NYP' && epoch(stop.arr || stop.schArr) <= t;
      const atPenn = stop.status === 'Station'; // as Amtrak reports it
      const row = (kind, sched, est, place) => {
        if (!sched) return;
        // A train can reach Penn early, but it won't leave before its
        // scheduled time; arrivals can be early.
        const when = kind === 'departures' ? Math.max(est || sched, sched) : (est || sched);
        // A departure stays until Amtrak reports it gone (the page drops one
        // whose estimate is 30 min stale); an arrival goes 5 min after it's
        // due, unless it continues on, when it stays until it leaves.
        const keepUntil = kind === 'departures' ? when + 1800 : throughTo ? depWhen + 1800 : when + 300;
        if (keepUntil < t || when > t + 8 * 3600) return;
        const late = Math.max(0, Math.round((when - sched) / 60));
        let status = 'On time', tone = 'ok';
        // A delayed train at Penn, or with its track posted, is boarding.
        // Departures: a through train due in, or reported at Penn, is boarding.
        if (kind === 'departures' && (atPenn || arrivedByTime || stop.platform)) { status = 'Boarding'; tone = 'go'; }
        else if (kind === 'arrivals' && atPenn) { status = throughTo ? 'At Penn' : 'Arrived'; tone = 'go'; }
        else if (late >= 5) { status = `${late} min late`; tone = 'late'; }
        rows[kind].push({ ...base, via: kind === 'departures' ? viaOut : viaIn, viaState: kind === 'arrivals' ? viaInState : undefined,
          id: `amtk-${tr.trainID}-${kind}`, time: when, sched, place, status, tone, leaves: when, lateMin: late,
          ...(kind === 'arrivals' && throughTo ? { continuesTo: throughTo, departsAt: depWhen } : {}) });
      };
      if (tr.destCode !== 'NYP') row('departures', epoch(stop.schDep), epoch(stop.dep), tr.destName);
      if (tr.origCode !== 'NYP') row('arrivals', epoch(stop.schArr), epoch(stop.arr), tr.origName);
    }
  }
  return rows;
});


// ---------- service notices (MTA: subway and LIRR) ----------

const ALERT_FEEDS = {
  subway: 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fsubway-alerts.json',
  lirr: 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Flirr-alerts.json',
};
const PENN_LINES = new Set(['1', '2', '3', 'A', 'C', 'E']);
// Notices people need before they travel: shown first, and the strip opens.
const URGENT = /delay|suspend|no service|cancel|severe|weather|reduced service|shuttle bus|substitute bus/i;

function alertText(t) {
  const tr = (t && t.translation) || [];
  const text = (tr.find((x) => x.language === 'en') || tr.find((x) => !/html/.test(x.language || '')) || {}).text || '';
  // Lines in a notice are separate sentences; join them as such.
  return text.split(/\n+/).map((x) => x.trim()).filter(Boolean).join('. ').replace(/([.!?:])\. /g, '$1 ');
}
// Notices in effect now (or about to be, if the MTA says to show them early).
function parseAlerts(feed, keep) {
  const t = now();
  const out = [];
  for (const e of feed.entity || []) {
    const a = e.alert || {};
    const meta = a['transit_realtime.mercury_alert'] || {};
    const early = +meta.display_before_active || 0;
    const periods = a.active_period || [];
    const active = !periods.length || periods.some((p) => (+p.start || 0) - early <= t && t <= (+p.end || Infinity));
    if (!active) continue;
    const ents = a.informed_entity || [];
    const lines = [...new Set(ents.map((x) => x.route_id).filter(Boolean))];
    const stops = ents.map((x) => x.stop_id).filter(Boolean);
    const text = alertText(a.header_text);
    if (!text) continue;
    const more = alertText(a.description_text);
    if (!keep(lines, stops, `${text} ${more}`)) continue;
    const type = meta.alert_type || 'Service notice';
    out.push({ id: e.id, type, urgent: URGENT.test(type), lines, text, more });
  }
  out.sort((x, y) => y.urgent - x.urgent);
  const byText = new Map();
  for (const n of out) {
    const key = n.text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const seen = byText.get(key);
    if (seen) seen.lines = [...new Set([...seen.lines, ...n.lines])];
    else byText.set(key, n);
  }
  return [...byText.values()];
}

// Notices refresh as often as trains (every 20 s and on the minute) wherever
// that's cheap: on the server, or in the browser through the relay, which
// trims the MTA's 1 MB subway file to a few KB. A browser with no relay reads
// the full file only every 3 minutes.
const IN_BROWSER = typeof window !== 'undefined';
const relayBase = () => (IN_BROWSER && window.PENN_RELAY ? window.PENN_RELAY.replace(/\/$/, '') : '');
const FAST_ALERTS = !IN_BROWSER || !!relayBase();
const alertUrl = (feed) => (relayBase() ? `${relayBase()}/alerts/${feed}` : ALERT_FEEDS[feed]);
const subwayAlerts = source('subway-alerts', FAST_ALERTS ? 20 : 180, async () =>
  parseAlerts(await (await get(alertUrl('subway'))).json(), (lines, stops) =>
    lines.some((l) => PENN_LINES.has(l)) || stops.some((s) => /^(128|A28)[NS]?$/.test(s))));
// LIRR notices about branches and stations apply to trains from Penn too;
// leave out ones about Grand Central only, which LIRR trains from Penn
// don't reach.
const aboutGrandCentralOnly = (text) => /grand central/i.test(text) && !/penn/i.test(text);
const lirrAlerts = source('lirr-alerts', FAST_ALERTS ? 20 : 120, async () =>
  parseAlerts(await (await get(alertUrl('lirr'))).json(), (lines, stops, text) => !aboutGrandCentralOnly(text)));

// Amtrak publishes notices per train; list each train's once.
function amtrakNotices(rows) {
  if (!rows) return [];
  const seen = new Set(), out = [];
  for (const r of [...rows.departures, ...rows.arrivals]) {
    for (const text of r.notes || []) {
      const key = r.train + text;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ id: `amtk-${key}`, carrier: 'amtrak', type: `Train ${r.train}, ${r.line}`, urgent: URGENT.test(text), lines: [], text });
    }
  }
  return out;
}

// Combine the sources into the document the page renders. `njt` and `path`
// are optional { data, error } results that only the server can supply.
async function board(extra = {}) {
  const force = !!extra.force;
  const fastAlerts = force && FAST_ALERTS;
  const [l, a, s, sa, la] = await Promise.all([lirr(force), amtrak(force), subway(force), subwayAlerts(fastAlerts), lirrAlerts(fastAlerts)]);
  const n = extra.njt || { data: null, error: null };
  const p = extra.path || { data: null, error: null };
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

  // The page decides what to show as trains leave (docs/app.js, visibleRows);
  // this only drops rows long past.
  const live = (r) => r.time > t - 20 * 60;
  // Order by when each train is really expected (delays included).
  const byTime = (x, y) => (x.leaves ?? x.time) - (y.leaves ?? y.time);
  return {
    at: t,
    departures: departures.filter(live).sort(byTime),
    arrivals: arrivals.filter(live).sort(byTime),
    subway: s.data || [],
    path: p.data || [],
    // Service notices, by where the page shows them: railroads above the
    // train list, subway (and PATH, if a source appears) in the subway panel.
    notices: {
      rail: [
        ...(la.data || []).map((x) => ({ ...x, carrier: 'lirr' })),
        ...amtrakNotices(a.data),
        ...(extra.njtNotices || []),
      ],
      subway: (sa.data || []).map((x) => ({ ...x, carrier: 'subway' })),
    },
    sources: {
      lirr: { ok: !!l.data && !l.error, error: l.error },
      njt: { ok: !!n.data && !n.error, error: n.error, needsLogin: !!extra.njtNeedsLogin, needsServer: !extra.server },
      amtrak: { ok: !!a.data && !a.error, error: a.error },
      subway: { ok: !!s.data && !s.error, error: s.error },
      path: { ok: !!p.data && !p.error, error: p.error, needsServer: !extra.server && !extra.path },
    },
  };
}

// Live PATH through the relay (docs/config.js), for the version of the site
// without its own server.
const relayPath = source('relay-path', 20, async () => {
  const base = typeof window !== 'undefined' && window.PENN_RELAY;
  return parsePath(await (await get(`${base.replace(/\/$/, '')}/path`)).json());
});

return { board, source, get, now, nyToEpoch, parsePath, relayPath };
});
