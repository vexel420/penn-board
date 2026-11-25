// Grand Central board (owner, Nov 25): Metro-North and the LIRR at Grand
// Central Madison, the subway at Grand Central-42 St (4 5 6 7 S), nearby buses,
// service notices and elevator outages. Same layout and stylesheet as the Penn
// board, in the "Celestial" theme; its own script so nothing here can break Penn.
//
// Sources (all the MTA's, no keys in the page):
//   trains   TrainTime's Grand Central departures (0NY Metro-North, GCT LIRR),
//            the same source as the Penn board's LIRR
//   subway   the MTA's 1-7/S trip feed
//   buses    MTA Bus Time through the relay (/mta-bus-stop)
//   notices  the MTA's Metro-North, LIRR and subway alerts through the relay
//   lifts    the MTA's elevator and escalator outages

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const RELAY = (window.PENN_RELAY || '').replace(/\/$/, '');
const nowS = () => Date.now() / 1000;
const nyTime = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
const clock = (t) => { const [hm, ap] = nyTime.format(new Date(t * 1000)).split(' '); return { hm, ap }; };
function countdown(t) {
  const m = Math.round((t - nowS()) / 60);
  if (m < 0) return 'gone';
  if (m < 1) return 'now';
  if (m < 60) return `in ${m} min`;
  return `in ${Math.floor(m / 60)} h ${m % 60} min`;
}
const agoText = (t) => { const m = Math.max(0, Math.round((nowS() - t) / 60)); return m < 1 ? 'just left' : `left ${m} min ago`; };
const store = { get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

// ---------- trains ----------
// Metro-North lines as TrainTime names them; the New Haven's branches share its red.
const MNR_LINES = {
  HU: ['Hudson', 'hu'], HA: ['Harlem', 'ha'], NH: ['New Haven', 'nh'],
  NC: ['New Canaan', 'nh'], DN: ['Danbury', 'nh'], WB: ['Waterbury', 'nh'],
};
const lineGroup = (b) => (b === 'NC' || b === 'DN' || b === 'WB' ? 'NH' : b);
const BOARD_AHEAD_S = 15 * 60; // Grand Central posts tracks early: "Boarding" only this close to departure
const FINAL_S = 60;            // final call, as at Penn
const DEPARTED_SHOWN_S = 3 * 60;
// Station names are needed before the trains are shown (owner, Nov 25: the
// board showed codes like "2SM" when the trains loaded first). The trains wait
// for this file, up to 5 s; if it never loads, codes are better than nothing.
let mnrNames = {};
const mnrNamesReady = Promise.race([
  fetch('mnr-stations.json').then((r) => (r.ok ? r.json() : {})).then((d) => { mnrNames = d || {}; }).catch(() => {}),
  new Promise((r) => setTimeout(r, 5000)),
]);
const mnrName = (c) => mnrNames[c] || c;

let rail = { departures: [], arrivals: [], alerts: [], at: 0, error: '' };
const seen = new Map(); // id -> last row seen, to show "Departed" when a train drops off the list
const departed = new Map(); // id -> { row, at }

function parseArrivals(list, railroad) {
  const out = { departures: [], arrivals: [] };
  const lirr = railroad === 'lirr';
  for (const a of list || []) {
    const leaving = a.direction === 'E';
    const here = lirr ? 'GCT' : '0NY';
    // Metro-North codes missing from the MTA's own station list (like 0HB,
    // between Yankees-E 153 St and Morris Heights) aren't passenger stops: left out.
    const known = (c) => lirr || !Object.keys(mnrNames).length || c in mnrNames;
    const stops = (a.stops || []).filter((c) => c !== here && known(c));
    // TrainTime gives the scheduled time and the delay apart (otp, seconds;
    // negative = late, as for the LIRR at Penn). Trains don't leave early.
    const otp = a.status && typeof a.status.otp === 'number' ? a.status.otp : 0;
    const lateS = otp < 0 ? -otp : 0;
    const time = leaving ? a.time + lateS : a.time - otp;
    const lateMin = Math.round(lateS / 60);
    const line = lirr ? [`${(PennFeeds.LIRR_BRANCHES || {})[a.branch] || 'LIRR'}${a.branch ? ' Branch' : ''}`, 'lirr'] : (MNR_LINES[a.branch] || [a.branch || 'Metro-North', 'hu']);
    const name = lirr ? PennFeeds.lirrStationName : mnrName;
    let status = 'On time', tone = 'ok';
    const isGone = a.stop_status === 'DEPARTED';
    if (a.status && a.status.canceled) { status = 'Cancelled'; tone = 'stop'; }
    else if (leaving && isGone) { status = 'Departed'; tone = 'departed'; }
    else if (a.status && a.status.held) { status = 'Held'; tone = 'late'; }
    else if (leaving && a.track && time - nowS() <= FINAL_S && time - nowS() > -60) { status = 'All aboard'; tone = 'final'; }
    else if (leaving && a.track && time - nowS() <= BOARD_AHEAD_S) { status = 'Boarding'; tone = 'go'; }
    else if (lateMin >= 2) { status = `${lateMin} min late`; tone = 'late'; }
    else if (!leaving && a.stop_status === 'ARRIVED') { status = 'Arrived'; tone = 'go'; }
    else if (!leaving && otp >= 120) { status = `${Math.round(otp / 60)} min early`; tone = 'ok'; }
    (leaving ? out.departures : out.arrivals).push({
      id: `${railroad}-${a.train_id}-${leaving ? 'd' : 'a'}`, railroad, group: lirr ? 'lirr' : lineGroup(a.branch),
      plate: lirr ? 'LIRR' : line[0], branch: line[0], plateClass: line[1], train: a.train_num, time, sched: a.time, lateMin,
      place: name(leaving ? stops[stops.length - 1] : stops[0]),
      via: stops.slice(leaving ? 0 : 1, leaving ? -1 : undefined).map(name),
      track: a.track || '', status, tone, where: lirr ? 'Grand Central Madison' : '',
    });
  }
  return out;
}
const plain = (h) => String(h || '').replace(/<\/?(p|br|div|li|ul)\b[^>]*>/gi, ' ').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
async function loadRail() {
  const get = (code) => fetch(`https://backend-unified.mylirr.org/arrivals/${code}`, { headers: { 'accept-version': '3.0' }, cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`TrainTime answered ${r.status}`))));
  try {
    const [m, l] = await Promise.all([get('0NY'), get('GCT'), mnrNamesReady]);
    const a = parseArrivals(m.arrivals, 'mnr'), b = parseArrivals(l.arrivals, 'lirr');
    const deps = [...a.departures, ...b.departures];
    // A departure that drops off the list near its time has left.
    const ids = new Set(deps.map((r) => r.id));
    for (const [id, r] of seen) {
      if (!ids.has(id) && !departed.has(id) && r.tone !== 'stop' && Math.abs(r.time - nowS()) < 10 * 60) departed.set(id, { row: { ...r, status: 'Departed', tone: 'departed' }, at: Math.min(nowS(), Math.max(r.time, nowS() - 60)) });
    }
    seen.clear();
    deps.forEach((r) => seen.set(r.id, r));
    // Alerts TrainTime shows with the trains (special schedules and the like).
    const alerts = [...(m.alerts || []), ...(l.alerts || [])].map((x) => ({ id: `tt-${plain(x.header).slice(0, 60)}`, carrier: x.railroad === 'LIRR' ? 'lirr' : 'mnr',
      type: x.status || 'Service notice', text: plain(x.header), more: plain(x.text), urgent: (PennFeeds.URGENT || /delay|suspend|cancel/i).test(plain(x.header)) }));
    rail = { departures: deps, arrivals: [...a.arrivals, ...b.arrivals], alerts, at: Date.now(), error: '' };
  } catch (e) {
    rail.error = e.message || String(e);
  }
  render();
}

let view = 'departures';
let line = store.get('gctLine', 'all');
function visibleRows() {
  const t = nowS();
  for (const [id, d] of departed) if (t - d.at > DEPARTED_SHOWN_S) departed.delete(id);
  let rows = view === 'departures'
    ? [...rail.departures.filter((r) => !departed.has(r.id)), ...[...departed.values()].map((d) => ({ ...d.row, departedAt: d.at }))]
    : rail.arrivals.filter((r) => r.time > t - 5 * 60);
  if (line !== 'all') rows = rows.filter((r) => r.group === line);
  return rows.filter((r) => r.time < t + 3 * 3600).sort((a, b) => (a.departedAt ?? a.time) - (b.departedAt ?? b.time));
}
function rowHtml(r) {
  const t = clock(r.time);
  const gone = r.tone === 'departed';
  const left = gone ? agoText(r.departedAt ?? r.time) : countdown(r.time);
  const notes = [];
  if (r.sched && Math.abs(r.time - r.sched) >= 120) notes.push(`scheduled ${clock(r.sched).hm}`);
  const meta = `${esc(r.where ? `${r.where}, ` : '')}${esc(r.branch)}${r.railroad === 'mnr' ? ' Line' : ''}, train ${esc(r.train)}`;
  const via = r.via.length
    ? `<details class="via" data-id="${esc(r.id)}"><summary>${meta}, <u>${r.via.length} stop${r.via.length === 1 ? '' : 's'}</u></summary><p>${r.via.map(esc).join(', ')}</p><p class="last-stop">${view === 'departures' ? 'Last stop' : 'From'}: <b>${esc(r.place)}</b></p></details>`
    : `<div class="meta">${meta}</div>`;
  const track = r.track ? `<div class="track${r.tone === 'final' ? ' ring' : ''}" aria-label="Track ${esc(r.track)}"><b>${esc(r.track)}</b></div>` : '<div class="track none" aria-label="Track not posted"><b>–</b></div>';
  return `<li class="row ${r.tone}">
    <div class="time"><b>${t.hm}<small>${t.ap}</small></b><span>${left === 'gone' ? '' : left}</span></div>
    <div class="carrier"><span class="plate ${r.plateClass}">${esc(r.plate)}</span></div>
    <div class="dest"><div class="place">${esc(r.place)}</div>${via}</div>
    <div class="status ${r.tone}">${esc(r.status)}${notes.length ? `<small>${notes.join(', ')}</small>` : ''}</div>
    ${track}
  </li>`;
}
function renderRail() {
  const open = new Set([...document.querySelectorAll('#rows details[open]')].map((d) => d.dataset.id));
  const rows = visibleRows();
  $('col-place').textContent = view === 'arrivals' ? 'From' : 'To';
  $('rows').innerHTML = rows.length ? rows.map(rowHtml).join('')
    : `<li class="empty">${rail.error && !rail.at ? 'Train times didn’t load. Trying again shortly.' : rail.at ? `No ${line === 'all' ? '' : 'trains on this line '}${line === 'all' ? view : ''} in the next few hours.` : 'Loading the board…'}</li>`;
  document.querySelectorAll('#rows details').forEach((d) => { if (open.has(d.dataset.id)) d.open = true; });
  scheduleFinal(rows);
}
// Redraw on the second a train enters its final call (as at Penn).
let finalTimer = 0;
function scheduleFinal(rows) {
  clearTimeout(finalTimer);
  if (view !== 'departures') return;
  const t = nowS();
  const next = Math.min(...rows.filter((r) => r.track && r.tone !== 'departed' && r.tone !== 'stop').map((r) => r.time - FINAL_S).filter((x) => x > t));
  if (next - t < 600) finalTimer = setTimeout(() => { loadRail(); }, (next - t) * 1000 + 100);
}

// ---------- subway: 4 5 6 (Lexington Av), 7 (Flushing), S (shuttle) ----------
const SUBWAY_FEED = 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs';
const STATIONS = [
  { id: '631', lines: ['4', '5', '6'], dirs: { N: 'Uptown and the Bronx', S: 'Downtown and Brooklyn' }, svc: (r) => (r === '6' ? 'Local' : 'Express') },
  { id: '723', lines: ['7'], dirs: { N: 'Queens', S: 'Times Sq and Hudson Yards' } },
  { id: '901', lines: ['GS'], dirs: { N: 'Times Sq-42 St', S: 'Times Sq-42 St' } },
];
let subwayData = null, subway = [], subwayErr = '';
fetch('subway-data.json').then((r) => (r.ok ? r.json() : null)).then((d) => { subwayData = d; renderSubway(); }).catch(() => {});
function bullet(route, cls = '') {
  const info = subwayData && subwayData.routes[route];
  const label = route === 'GS' ? 'S' : route;
  return `<span class="bullet ${cls}" style="background:${esc(info ? info.color : '#808183')};color:${esc(info ? info.text : '#fff')}" aria-label="${esc(label)} train">${esc(label)}</span>`;
}
async function loadSubway() {
  try {
    const trips = PennFeeds.parseTripUpdates(new Uint8Array(await (await fetch(SUBWAY_FEED, { cache: 'no-store' })).arrayBuffer()));
    const t = nowS();
    const groups = new Map();
    for (const trip of trips) {
      for (const stn of STATIONS) {
        const at = trip.stops.findIndex((s) => s.id.slice(0, -1) === stn.id);
        if (at < 0 || at === trip.stops.length - 1) continue; // ends here: nobody boards it
        const stop = trip.stops[at];
        if (!stop.time || stop.time < t - 30 || stop.time > t + 3600) continue;
        const route = trip.route.replace(/X$/, '');
        if (!stn.lines.includes(route)) continue;
        const dir = stop.id.slice(-1);
        const dest = trip.stops[trip.stops.length - 1].id.slice(0, -1);
        const key = `${stn.id}|${route}|${dir}|${dest}|${/X$/.test(trip.route) ? 'x' : ''}`;
        if (!groups.has(key)) groups.set(key, { stn: stn.id, route, dir, dest, express: /X$/.test(trip.route), times: [] });
        groups.get(key).times.push(stop.time);
      }
    }
    subway = [...groups.values()].map((g) => ({ ...g, times: g.times.sort((a, b) => a - b).slice(0, 3) }));
    subwayErr = '';
  } catch (e) { subwayErr = e.message || String(e); }
  renderSubway();
}
const minsHtml = (times) => times.map((x, i) => { const m = Math.max(0, Math.round((x - nowS()) / 60)); return i === 0 ? (m < 1 ? '<b class="now">now</b>' : `<b>${m}</b> min`) : String(m); }).join(', ');
function renderSubway() {
  if (!subway.length) { $('subway').innerHTML = `<p class="empty">${subwayErr ? 'Subway times didn’t load. Trying again shortly.' : 'Loading subway times…'}</p>`; return; }
  const name = (id) => (subwayData && subwayData.stops[id] ? subwayData.stops[id][0] : id);
  $('subway').innerHTML = STATIONS.map((stn) => {
    const here = subway.filter((g) => g.stn === stn.id && g.times.some((x) => x > nowS() - 20));
    if (!here.length) return '';
    const dirs = (stn.id === '901' ? ['S', 'N'].slice(0, 1) : ['N', 'S']).map((dir) => {
      const list = here.filter((g) => stn.id === '901' || g.dir === dir).sort((a, b) => a.times[0] - b.times[0]);
      if (!list.length) return '';
      const bySvc = stn.svc ? ['Express', 'Local'].map((s) => [s, list.filter((g) => stn.svc(g.route) === s)]).filter(([, l]) => l.length) : [['', list]];
      return `<div class="dir"><h3>${esc(stn.dirs[dir])}</h3>${bySvc.map(([s, l]) => `<div class="svc">${s ? `<h4>${s}</h4>` : ''}${l.map((g) => `<div class="sline">${bullet(g.route)}<span class="sdest"><span class="dname">${esc(stn.id === '901' ? 'Times Sq-42 St' : name(g.dest))}</span>${g.express && g.route !== '7' ? '' : g.express ? ' <small>express</small>' : ''}</span><span class="smins">${minsHtml(g.times)}</span></div>`).join('')}</div>`).join('')}</div>`;
    }).join('');
    return `<section class="stn" aria-label="${stn.lines.map((l) => (l === 'GS' ? 'S' : l)).join(', ')} trains"><div class="stn-lines">${stn.lines.map((l) => bullet(l, 'small')).join('')}</div>${dirs}</section>`;
  }).join('');
}

// ---------- buses (MTA Bus Time, through the relay) ----------
// Stops at Grand Central (stop codes from the MTA's Manhattan bus timetable).
const BUS_STOPS = [
  { stop: '405241', lines: ['M42'], label: '42 St crosstown, westbound', where: 'E 42 St at Park Av' },
  { stop: '403459', lines: ['M42'], label: '42 St crosstown, eastbound', where: 'E 42 St at Park Av' },
  { stop: '402843', lines: ['M101', 'M102', 'M103'], label: 'Downtown on Lexington Av', where: 'Lexington Av at E 45 St' },
  { stop: '402679', lines: ['M101', 'M102', 'M103'], label: 'Uptown on 3 Av', where: '3 Av at E 42 St' },
  { stop: '400018', lines: ['M1', 'M2'], label: 'Uptown on Madison Av', where: 'Madison Av at E 43 St' },
  { stop: '400561', lines: ['M3', 'M4'], label: 'Uptown on Madison Av', where: 'Madison Av at E 42 St' },
];
const buses = new Map();
async function loadBuses() {
  if (!RELAY) return;
  await Promise.all(BUS_STOPS.map((b) => fetch(`${RELAY}/mta-bus-stop?stop=${b.stop}`, { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null)).then((d) => { if (d) buses.set(b.stop, d.buses || []); }).catch(() => {})));
  renderBuses();
}
function renderBuses() {
  if (!buses.size) { $('gct-buses').innerHTML = `<p class="empty">${RELAY ? 'Loading buses…' : 'Bus times aren’t available here.'}</p>`; return; }
  const t = Date.now();
  const rows = BUS_STOPS.flatMap((b) => {
    const list = (buses.get(b.stop) || []).filter((x) => b.lines.includes(String(x.line).toUpperCase()) && x.at && Date.parse(x.at) > t - 30000);
    const byLine = new Map();
    for (const x of list) { const k = String(x.line).toUpperCase(); if (!byLine.has(k)) byLine.set(k, []); byLine.get(k).push(Date.parse(x.at) / 1000); }
    return [...byLine.entries()].map(([ln, times]) => ({ ln, times: times.sort((a, c) => a - c).slice(0, 3), b }));
  }).sort((x, y) => x.times[0] - y.times[0]);
  $('gct-buses').innerHTML = rows.length ? `<section class="stn">${rows.map((x) => `<div class="sline"><span class="bus-pl">${esc(x.ln)}</span><span class="sdest"><span class="dname">${esc(x.b.label)}</span> <small>${esc(x.b.where)}</small></span><span class="smins">${minsHtml(x.times)}</span></div>`).join('')}</section>`
    : '<p class="empty">No buses reported at Grand Central right now.</p>';
}

// ---------- service notices ----------
let notices = { rail: [], subway: [] };
const LINE_NAMES = { 1: 'Hudson', 2: 'Harlem', 3: 'New Haven', 4: 'New Canaan', 5: 'Danbury', 6: 'Waterbury' };
async function loadNotices() {
  if (!RELAY) return;
  const get = (feed) => fetch(`${RELAY}/alerts/${feed}`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : { entity: [] })).catch(() => ({ entity: [] }));
  const [m, l, s] = await Promise.all([get('mnr'), get('lirr'), get('subway-gct')]);
  const mnr = PennFeeds.parseAlerts(m, () => true).map((n) => ({ ...n, carrier: 'mnr' }));
  // LIRR notices apply to Grand Central Madison unless they're about Penn only.
  const lirr = PennFeeds.parseAlerts(l, (lines, stops, text) => !(/penn/i.test(text) && !/grand central/i.test(text))).map((n) => ({ ...n, carrier: 'lirr' }));
  const sub = PennFeeds.parseAlerts(s, (lines, stops, text, type) => stops.some((x) => /^(631|723|901)[NS]?$/.test(x)) || !/station notice|boarding change|extra transfer|elevator|escalator/i.test(type))
    .map((n) => ({ ...n, carrier: 'subway' }));
  notices = { rail: [...mnr, ...lirr], subway: sub };
  renderNotices();
}
function noticeWho(n) {
  if (n.carrier === 'subway') return (n.lines || []).filter((l) => /^[0-9A-Z]{1,2}$/.test(l)).slice(0, 4).map((l) => bullet(l.replace(/X$/, ''), 'tiny')).join('') || bullet('GS', 'tiny');
  if (n.carrier === 'lirr') return '<span class="plate lirr">LIRR</span>';
  const ln = (n.lines || []).map((x) => LINE_NAMES[x]).filter(Boolean);
  const first = ln[0] ? Object.values(MNR_LINES).find(([nm]) => nm === ln[0]) : null;
  return `<span class="plate ${first ? first[1] : 'mnr'}">${esc(ln.length === 1 ? ln[0] : 'Metro-North')}</span>`;
}
const noticeBody = (n) => `${esc(n.text)}${n.desc || n.more ? `<span class="n-more">${esc(n.desc || n.more)}</span>` : ''}`;
function strip(list, where, label) {
  if (!list.length) return '';
  return `<details class="al-strip${list.some((n) => n.urgent) ? ' urgent' : ''}" data-where="${where}"><summary><span class="n">${list.length}</span><span>${label}</span><span class="more"><span class="hide">Hide</span><span class="show">Show</span></span></summary>${list.map((n) => `<div class="al-item${n.urgent ? ' urgent' : ''}"><span class="who">${noticeWho(n)}</span><p style="margin:0"><span class="kind">${esc(n.type)}</span>${noticeBody(n)}</p></div>`).join('')}</details>`;
}
function railNotices() {
  const seenText = new Set();
  return [...rail.alerts, ...notices.rail].filter((n) => { const k = n.text.toLowerCase().slice(0, 80); if (seenText.has(k)) return false; seenText.add(k); return true; });
}
function renderNotices() {
  $('rail-notices').innerHTML = strip(railNotices(), 'rail', 'Service notices for trains at Grand Central');
  $('subway-notices').innerHTML = strip(notices.subway, 'subway', 'Subway service notices');
  renderAlertsTab();
}

// ---------- elevator and escalator outages (Grand Central-42 St) ----------
let lifts = [], liftInfo = {};
fetch('penn-elevators.json').then((r) => (r.ok ? r.json() : {})).then((d) => { liftInfo = d || {}; renderLifts(); }).catch(() => {});
async function loadLifts() {
  try {
    const d = await (await fetch('https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fnyct_ene.json', { cache: 'no-store' })).json();
    lifts = (Array.isArray(d) ? d : []).filter((x) => x.station === 'Grand Central-42 St' && x.isupcomingoutage !== 'Y');
  } catch {}
  renderLifts();
}
function liftWhen(x) {
  const m = /(\d+)\/(\d+)\/(\d+) (\d+):(\d+):\d+ (AM|PM)/.exec(x || '');
  if (!m) return '';
  return `about ${+m[4]}${m[5] !== '00' ? ':' + m[5] : ''} ${m[6]}, ${+m[1]}/${+m[2]}`;
}
function liftsHtml() {
  return lifts.map((x) => {
    const info = liftInfo[x.equipment] || {};
    const advice = String(info.alt || '').replace(/^[^.]*out of service[^.]*\.\s*/i, '');
    const back = liftWhen(x.estimatedreturntoservice);
    return `<div class="ene-note"><svg class="ic ene-ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="4" r="2" fill="currentColor"/><path d="M19 13v-2c-1.5 0-3-.6-4-1.6l-1.3-1.4c-.4-.4-1-.7-1.6-.7-1.1 0-2 .9-2 2v5.7c0 1.1.9 2 2 2h5v5h2v-5.5c0-1.1-.9-2-2-2h-3v-3.5c1.3 1.1 3 1.9 4.9 2zM12.1 19a3 3 0 0 1-5.8-1 3 3 0 0 1 2.3-2.9v-2.1A5 5 0 1 0 14.1 19z" fill="currentColor"/></svg><div><p><b>${x.equipmenttype === 'ES' ? 'Escalator' : 'Elevator'} out</b>${x.trainno ? ` at the ${esc(x.trainno)} station` : ''}: ${esc(info.short || x.serving || '')}.${back ? ` Back in service by ${esc(back)} (MTA estimate).` : ''}</p>${advice ? `<details class="ene-alt"><summary>What to do instead</summary><p>${esc(advice)}</p></details>` : ''}</div></div>`;
  }).join('');
}
function renderLifts() { $('elevators').innerHTML = liftsHtml(); renderAlertsTab(); }

// ---------- Alerts tab (phones) ----------
function renderAlertsTab() {
  const card = (n) => `<div class="al-card${n.urgent ? ' urgent' : ''}"><span class="who">${noticeWho(n)}</span><p><span class="kind">${esc(n.type)}</span>${noticeBody(n)}</p></div>`;
  const group = (title, list, none) => `<h2 class="al-h">${title}</h2>${list.length ? list.map(card).join('') : `<p class="al-none">${none}</p>`}`;
  const r = railNotices();
  const l = liftsHtml();
  $('alerts').innerHTML = group('Trains at Grand Central', r, 'No notices for Metro-North or the LIRR right now.')
    + group('Subway', notices.subway, 'No subway notices for the lines at Grand Central right now.')
    + `<h2 class="al-h">Elevators and escalators</h2>${l || '<p class="al-none">All elevators and escalators at Grand Central-42 St are working, per the MTA.</p>'}`;
  const n = r.length + notices.subway.length + lifts.length;
  $('alerts-count').textContent = n ? String(n) : '';
}

// ---------- page ----------
function renderClock() {
  const p = {};
  new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', second: '2-digit' }).formatToParts(new Date()).forEach((x) => { p[x.type] = x.value; });
  $('clock').textContent = `${p.hour}:${p.minute}`;
  $('clock-s').textContent = `:${p.second}`;
  $('clock-ap').textContent = p.dayPeriod;
}
function renderStamp() {
  const el = $('updated');
  if (!rail.at) { el.textContent = rail.error ? 'Can’t reach the train feeds. Trying again.' : 'Connecting…'; return; }
  const age = Math.round((Date.now() - rail.at) / 1000);
  el.className = age > 60 ? 'stale' : '';
  el.textContent = age > 60 ? `Can’t reach the train feeds. Last updated ${Math.round(age / 60) || 1} min ago, so this information may not be real time.` : `Updated ${age < 5 ? 'just now' : `${age} seconds ago`}.`;
}
function render() { renderRail(); renderStamp(); renderNotices(); }
document.querySelectorAll('.seg [data-view]').forEach((b) => b.addEventListener('click', () => {
  view = b.dataset.view;
  document.body.dataset.view = view;
  document.querySelectorAll('.seg [data-view]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  renderRail();
}));
function setLine(v) {
  line = v; store.set('gctLine', v);
  document.querySelectorAll('.chips [data-line]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.line === v)));
  renderRail();
}
document.querySelectorAll('.chips [data-line]').forEach((b) => b.addEventListener('click', () => setLine(b.dataset.line)));
setLine(line);
// Inside the side-by-side view, the page knows it's framed (the split button hides).
if (window.self !== window.top) document.body.classList.add('in-split');
document.addEventListener('visibilitychange', () => { if (!document.hidden) { loadRail(); loadSubway(); } });

loadRail(); loadSubway(); loadBuses(); loadNotices(); loadLifts();
setInterval(loadRail, 20000);
setInterval(loadSubway, 30000);
setInterval(loadBuses, 60000);
setInterval(loadNotices, 60000);
setInterval(loadLifts, 3 * 60000);
setInterval(() => { renderClock(); }, 1000);
setInterval(() => { renderRail(); renderSubway(); renderBuses(); renderStamp(); }, 10000);
renderClock();
