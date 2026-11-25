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
const FINAL_LATE_S = 120;      // a late train gets 2 minutes (as at Penn)
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
    else if (leaving && a.track && time - nowS() <= (lateMin >= 2 ? FINAL_LATE_S : FINAL_S) && time - nowS() > -60) { status = 'All aboard'; tone = 'final'; }
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
      fare: lirr ? (a.peak_code === 'P' ? 'peak' : 'offpeak') : '', leaves: time,
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
    saveDeparted();
    // Alerts TrainTime shows with the trains (special schedules and the like).
    const alerts = [...(m.alerts || []), ...(l.alerts || [])].map((x) => ({ id: `tt-${plain(x.header).slice(0, 60)}`, carrier: x.railroad === 'LIRR' ? 'lirr' : 'mnr',
      type: x.status || 'Service notice', text: plain(x.header), more: plain(x.text), urgent: (PennFeeds.URGENT || /delay|suspend|cancel/i).test(plain(x.header)) }));
    rail = { departures: deps, arrivals: [...a.arrivals, ...b.arrivals], alerts, at: Date.now(), error: '' };
  } catch (e) {
    rail.error = e.message || String(e);
  }
  render();
}

// Trains that just left stay on the board through a reload (as at Penn).
function saveDeparted() { store.set('gctDeparted', JSON.stringify([...departed.entries()].filter(([, d]) => nowS() - d.at < DEPARTED_SHOWN_S))); }
try { for (const [id, d] of JSON.parse(store.get('gctDeparted', '[]'))) if (nowS() - d.at < DEPARTED_SHOWN_S) departed.set(id, d); } catch {}
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
  const track = r.track ? `<div class="track${r.tone === 'final' ? ' ring' : ''}" aria-label="Track ${esc(r.track)}"><b>${flipText(`${r.id}|k`, r.track, r.tone === 'final' ? 'final' : '')}</b></div>` : `<div class="track none" aria-label="Track not posted"><b>${flipMode ? flipText(`${r.id}|k`, '') : '–'}</b></div>`;
  return `<li class="row ${r.tone}">
    <div class="time"><b>${flipText(`${r.id}|t`, t.hm)}<small>${t.ap}</small></b><span>${left === 'gone' ? '' : left}</span></div>
    <div class="carrier"><span class="plate ${r.plateClass}">${esc(r.plate)}</span></div>
    <div class="dest"><div class="place">${flipText(`${r.id}|p`, r.place)}</div>${via}${rowAlertHtml(r)}</div>
    <div class="status ${r.tone}">${flipText(`${r.id}|s`, r.status)}${notes.length ? `<small>${notes.join(', ')}</small>` : ''}</div>
    ${track}
  </li>`;
}
// ---------- notices on a train's row (as on the Penn board) ----------
// The railroad's delay notices for the train's line, as a pill opening the
// notice (LIRR: its own type; Metro-North: "Delays up to 20 min" and the like);
// LIRR boarding changes at a station the train stops at; and "N min late" when
// the train is running late with no notice and its status doesn't say so.
const MNR_ROUTE = { HU: '1', HA: '2', NH: '3', NC: '4', DN: '5', WB: '6' };
const branchOf = (r) => Object.keys(MNR_LINES).find((k) => MNR_LINES[k][0] === r.branch);
const LIRR_ALIASES = { 'Huntington Branch': 'Port Jefferson Branch', 'Greenport Branch': 'Greenport Service', 'Belmont Park Branch': 'Belmont Park', 'City Terminal Branch': 'City Terminal Zone' };
let lirrRoutes = null;
fetch('lirr-data.json').then((x) => (x.ok ? x.json() : null)).then((d) => { lirrRoutes = d && d.routes; renderRail(); }).catch(() => {});
const lirrRouteFor = (name) => lirrRoutes && Object.keys(lirrRoutes).find((k) => lirrRoutes[k].name === (LIRR_ALIASES[name] || name));
const isDelayNotice = (n) => happeningNow(n) && (DELAY_TYPES.test(n.type) || /\bdelay|\blate\b|cancel/i.test(n.text)) && !SERVICE_SWITCH.test(n.text);
function hiddenDelayMin(r) {
  if (r.tone === 'stop' || r.tone === 'departed' || /late|delay|held/i.test(r.status)) return null;
  if ((r.lateMin || 0) >= 2) return r.lateMin;
  return r.time < nowS() - 120 ? 0 : null;
}
function rowNotices(r) {
  const id = r.railroad === 'lirr' ? lirrRouteFor(r.branch) : MNR_ROUTE[branchOf(r)];
  if (!id) return [];
  // A notice about (nearly) the whole railroad: only on trains actually running late.
  const wide = r.railroad === 'lirr' ? 8 : 4;
  return notices.rail.filter((n) => n.carrier === r.railroad && isDelayNotice(n) && (n.lines || []).includes(id) && ((n.lines || []).length < wide || hiddenDelayMin(r) !== null));
}
function rowAlertSummary(ns) {
  const all = ns.map((n) => n.text).join(' ');
  const mins = [...all.matchAll(/(\d+)[- ]?(?:to[- ]\d+[- ]?)?min(?:ute)?s?\b/gi)].map((m) => +m[1]).filter((x) => x > 0 && x < 300);
  const range = all.match(/(\d+)\s*(?:-|to)\s*(\d+)[- ]?min/i);
  if (/suspend/i.test(all)) return 'Service suspended';
  if (/cancel/i.test(all) && !/delay/i.test(all)) return 'Cancellations';
  const maybe = /\b(subject to|may|might|could|possible|potential)\b/i.test(all) ? 'Possible delays' : 'Delays';
  if (range) return `${maybe} of ${range[1]}–${range[2]} min`;
  if (mins.length && /delay|late/i.test(all)) return `${maybe} up to ${Math.max(...mins)} min`;
  return /delay|late/i.test(all) ? maybe : 'Service alert';
}
const normName = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function rowAlertHtml(r) {
  if (view !== 'departures' || r.tone === 'departed') return '';
  const ns = rowNotices(r);
  const label = ns.length ? (r.railroad === 'lirr' ? mtaType(ns[0].type) : rowAlertSummary(ns)) : '';
  const delay = ns.length ? dropPill(`${r.id}|alert`, `${label}${ns.length > 1 ? ` (${ns.length})` : ''}`, 'warn', ns, 'rail', `<button type="button" class="al-map" data-options="${esc(r.id)}">Other options</button>`) : '';
  const stops = [...(r.via || []), r.place].map(normName);
  const boarding = r.railroad === 'lirr' ? notices.rail.filter((n) => n.carrier === 'lirr' && happeningNow(n) && /boarding change/i.test(n.type) && stops.some((st) => st && normName(n.text).includes(st))) : [];
  const hid = ns.length ? null : hiddenDelayMin(r);
  return pills(hid === null ? '' : warnPill(hid ? `${hid} min late` : 'Running late'), delay, boarding.length ? dropPill(`${r.id}|boarding`, 'Boarding change', 'info', boarding, 'rail') : '');
}
function renderRail() {
  const open = new Set([...document.querySelectorAll('#rows details[open]')].map((d) => d.dataset.id));
  const rows = visibleRows();
  $('col-place').textContent = view === 'arrivals' ? 'From' : 'To';
  $('rows').innerHTML = rows.length ? rows.map(rowHtml).join('')
    : `<li class="empty">${rail.error && !rail.at ? 'Train times didn’t load. Trying again shortly.' : rail.at ? `No ${line === 'all' ? '' : 'trains on this line '}${line === 'all' ? view : ''} in the next few hours.` : 'Loading the board…'}</li>`;
  document.querySelectorAll('#rows details').forEach((d) => { if (open.has(d.dataset.id)) d.open = true; });
  runFlips($('rows'));
  scheduleFinal(rows);
}
// Redraw on the second a train enters its final call (as at Penn).
let finalTimer = 0;
function scheduleFinal(rows) {
  clearTimeout(finalTimer);
  if (view !== 'departures') return;
  const t = nowS();
  const next = Math.min(...rows.filter((r) => r.track && r.tone !== 'departed' && r.tone !== 'stop').map((r) => r.time - ((r.lateMin || 0) >= 2 ? FINAL_LATE_S : FINAL_S)).filter((x) => x > t));
  if (next - t < 600) finalTimer = setTimeout(() => { loadRail(); }, (next - t) * 1000 + 100);
}

// ---------- subway: 4 5 6 (Lexington Av), 7 (Flushing), S (shuttle) ----------
// Laid out as on the Penn board (owner, Nov 25: the same toggles and pills):
// one row per line, direction and kind of service; a row whose trains go to
// more than one place either takes turns or lists every place (toggle), and
// carries the MTA's notices as pills (Delays, Stops skipped, Express to local,
// Reduced service) that open the notice's own words.
const SUBWAY_FEED = 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs';
const STATIONS = [
  { id: '631', lines: ['4', '5', '6'], dirs: { N: 'Uptown and the Bronx', S: 'Downtown and Brooklyn' }, svc: (r) => (r === '6' ? 'local' : 'express') }, // the diamond 6 is local in Manhattan
  { id: '723', lines: ['7'], dirs: { N: 'Queens', S: 'Times Sq and Hudson Yards' }, svc: (r, x) => (x ? 'express' : 'local') },
  { id: '901', lines: ['GS'], dirs: { S: 'Times Sq-42 St' }, svc: () => 'local', oneWay: true },
];
const SVC_NAMES = { express: 'Express', local: 'Local' };
let subwayData = null, subway = [], subwayErr = '';
fetch('subway-data.json').then((r) => (r.ok ? r.json() : null)).then((d) => { subwayData = d; renderSubway(); }).catch(() => {});
// Express runs of the 6 and the 7 (the MTA's "6X", "7X") get the MTA's diamond, not the circle.
// The note says where it runs express, on trains heading that way (uptown 6, Flushing-bound 7).
const DIAMOND_WHERE = { 6: 'express in the Bronx', 7: 'express in Queens' };
function bullet(route, cls = '', express = false) {
  const info = subwayData && subwayData.routes[route];
  const label = route === 'GS' ? 'S' : route;
  const diamond = express && DIAMOND_WHERE[route];
  return `<span class="bullet ${cls}${diamond ? ' diamond' : ''}" style="background:${esc(info ? info.color : '#808183')};color:${esc(info ? info.text : '#fff')}" aria-label="${esc(label)} ${diamond ? 'express ' : ''}train">${esc(label)}</span>`;
}
const stationName = (id) => (subwayData && subwayData.stops[id] ? subwayData.stops[id][0] : id);
// Stations only local trains stop at, on the stretch the diamond runs express:
// the 7 in Queens (Queensboro Plaza to Flushing), the 6 in the Bronx
// (3 Av-138 St to Parkchester). An express train calls at none of them, and
// must reach that stretch for us to tell.
// (7 express stops: Queensboro Plaza 718, 61 St-Woodside 712, 74 St 710, Junction Blvd 707,
// Mets-Willets Point 702. 6 express: 3 Av-138 St 619, Hunts Point Av 613, Parkchester 608.)
const LOCAL_ONLY = { 7: ['716', '715', '714', '713', '711', '709', '708', '706', '705'], 6: ['618', '617', '616', '615', '614', '612', '611', '610', '609'] };
const STRETCH_END = { 7: '702', 6: '608' };
function skipsLocal(route, ahead) {
  const loc = LOCAL_ONLY[route];
  if (!loc || !ahead.includes(STRETCH_END[route])) return false;
  return !ahead.some((id) => loc.includes(id));
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
        const dir = stn.oneWay ? 'S' : stop.id.slice(-1);
        // Express (the diamond) only if the train really skips local stops
        // ahead (owner, Nov 25: the MTA's feed was marking every Flushing-bound
        // 7 as "7X" while they made all stops). Penn judges express the same way.
        const x = /X$/.test(trip.route) && dir === 'N' && skipsLocal(route, trip.stops.slice(at + 1).map((s2) => s2.id.slice(0, -1)));
        const svc = stn.svc(route, x);
        const key = `${stn.id}|${route}|${dir}|${svc}|${x ? 'x' : ''}`;
        if (!groups.has(key)) groups.set(key, { stn: stn.id, route, dir, svc, express: x, trains: [] });
        // `code`: the trip's scheduled start, to match it to the timetable (on time or late).
        const code = (/^(\d{6})_/.exec(trip.trip || '') || [])[1] || '';
        groups.get(key).trains.push({ time: stop.time, dest: trip.stops[trip.stops.length - 1].id.slice(0, -1), code, stops: trip.stops.slice(at).map((x) => x.id.slice(0, -1)) });
      }
    }
    subway = [...groups.values()].map((g) => ({ ...g, trains: g.trains.sort((a, b) => a.time - b.time) }));
    subwayErr = '';
  } catch (e) { subwayErr = e.message || String(e); }
  renderSubway();
}

// On time or late, against the timetable at Grand Central (subway-times.json, as at Penn).
let subwayTimes = null;
fetch('subway-times.json').then((r) => (r.ok ? r.json() : null)).then((d) => {
  if (!d || !d.penn) return;
  subwayTimes = new Map();
  for (const [stn, ls] of Object.entries(d.penn)) for (const [ln, ds] of Object.entries(ls)) for (const [dir, days] of Object.entries(ds)) for (const [day, list] of Object.entries(days)) {
    subwayTimes.set(`${stn}|${ln}|${dir}|${day}`, new Map(list.split(',').map((x) => { const [c, m] = x.split(':'); return [c, +m]; })));
  }
  renderSubway();
}).catch(() => {});
const nyParts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', minute: '2-digit', hourCycle: 'h23' });
function nyNow(off = 0) {
  const p = {};
  nyParts.formatToParts(new Date(Date.now() + off * 86400000)).forEach((x) => { p[x.type] = x.value; });
  return { day: p.weekday === 'Sat' ? 'saturday' : p.weekday === 'Sun' ? 'sunday' : 'weekday', mins: +p.hour * 60 + +p.minute, date: `${p.year}-${p.month}-${p.day}` };
}
// The subway's holiday schedule (Sunday service) on its six big holidays, as on the Penn board.
function subwayHoliday(date) {
  const [y, m, d] = date.split('-').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const nth = Math.ceil(d / 7), last = d + 7 > new Date(Date.UTC(y, m, 0)).getUTCDate();
  return (m === 1 && d === 1) || (m === 7 && d === 4) || (m === 12 && d === 25) || (m === 5 && wd === 1 && last) || (m === 9 && wd === 1 && nth === 1) || (m === 11 && wd === 4 && nth === 4);
}
const minsToEpoch = (mins) => { const n = nyNow(); return Math.floor(Date.now() / 60000) * 60 - n.mins * 60 + mins * 60; };
function subwayLateBy(stnId, route, dir, x) {
  if (!subwayTimes || !x || !x.code) return null;
  let best = null;
  for (const off of [-1, 0, 1]) {
    const n = nyNow(off);
    const day = subwayHoliday(n.date) ? 'sunday' : n.day;
    const m = (subwayTimes.get(`${stnId}|${route}|${dir}|${day}`) || new Map()).get(x.code);
    if (m == null) continue;
    const diff = x.time - minsToEpoch(off * 1440 + m);
    if (Math.abs(diff) < 3 * 3600 && (best == null || Math.abs(diff) < Math.abs(best))) best = diff;
  }
  return best;
}
const ON_TIME_S = 180;
const LATE_PILL_MIN = 5;
const subwayOnTime = (stnId, route, dir, x) => { const d = subwayLateBy(stnId, route, dir, x); return d != null && d <= ON_TIME_S; };

// The two toggles under the panel, shared with the Penn board (same saved choices).
let subwayStyle = store.get('subwayStyle', 'turns') === 'b' ? 'b' : 'turns';
let allLatePills = store.get('subwayLatePills', 'advisory') === 'all';
const subwayStyleHtml = () => `<div class="sub-style"><span>Rows with more than one destination</span><div class="style-seg">
  <button type="button" data-sstyle="turns" aria-pressed="${subwayStyle === 'turns'}">Take turns</button><button type="button" data-sstyle="b" aria-pressed="${subwayStyle === 'b'}">All destinations</button></div></div>
  <div class="sub-style"><span>Delay pills</span><div class="style-seg">
  <button type="button" data-latepills="advisory" aria-pressed="${!allLatePills}">With advisories</button><button type="button" data-latepills="all" aria-pressed="${allLatePills}">All late trains</button></div></div>`;
$('sub-toggles').addEventListener('click', (e) => {
  const lp = e.target.closest('[data-latepills]');
  if (lp) { allLatePills = lp.dataset.latepills === 'all'; store.set('subwayLatePills', allLatePills ? 'all' : 'advisory'); renderSubway(); return; }
  const b = e.target.closest('[data-sstyle]');
  if (b) { subwayStyle = b.dataset.sstyle; store.set('subwayStyle', subwayStyle); renderSubway(); }
});

// Pills: the MTA's notices for the line, each named with the MTA's own type,
// opening a dropdown with the notice's words (as on the Penn board).
const WARN_IC = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5 1.5 21h21zM11 9h2v6h-2zm0 8h2v2h-2z" fill="currentColor" fill-rule="evenodd"/></svg>';
const warnPill = (txt) => `<span class="late-pill warn-pill">${WARN_IC}${txt}</span>`;
const openDrops = new Set();
const dropBodies = new Map();
const happeningNow = (n) => n.activeNow !== false;
const DELAY_TYPES = /delay|cancel|suspend|single track/i;
const SERVICE_SWITCH = /\b(running|runs|run|operating|operates)\s+(express|local)\b|\bexpress (between|from|to|in)\b|\blocal (between|from|to|in)\b|\breroute|\bruns? via\b/i;
const DOWN_WORDS = /\b(downtown|southbound|brooklyn-bound|manhattan-bound|hudson yards-bound|times sq-bound)\b/i, UP_WORDS = /\b(uptown|northbound|bronx-bound|queens-bound|flushing-bound)\b/i;
const dirMatch = (n, dir) => {
  const first = String(n.text).split(/\.\s/)[0];
  const down = DOWN_WORDS.test(first), up = UP_WORDS.test(first);
  if (!dir || down === up) return true;
  return dir === 'S' ? down : up;
};
const onLine = (n, route) => (n.lines || []).some((l) => l.replace(/X$/, '') === route || (route === 'GS' && l === 'S'));
const subNotices = (route, dir, test) => notices.subway.filter((n) => happeningNow(n) && onLine(n, route) && dirMatch(n, dir) && test(n));
const mtaType = (t) => { const x = String(t || '').replace(/^Planned - /, ''); return x.charAt(0).toUpperCase() + x.slice(1).toLowerCase(); };
function untilText(n) {
  const p = (n.periods || []).find(([a, b]) => a <= nowS() + 60 && b > nowS());
  if (!p || !isFinite(p[1])) return '';
  const fmt = (t, o) => new Date(t * 1000).toLocaleString('en-US', { timeZone: 'America/New_York', ...o });
  const sameDay = fmt(p[1], { day: 'numeric' }) === fmt(nowS(), { day: 'numeric' });
  return `until ${sameDay ? '' : `${fmt(p[1], { weekday: 'short' })} `}${fmt(p[1], { hour: 'numeric', minute: '2-digit' })}`;
}
function dropPill(key, label, kind, ns, where = 'subway', extra = '') {
  const open = openDrops.has(key);
  if (open) {
    const items = ns.map((n) => { const u = untilText(n); return `<span class="drop-n">${noticeBody(n)}${u ? `<small>${esc(u)}</small>` : ''}</span>`; }).join('');
    dropBodies.set(key, `<span class="drop${kind === 'warn' ? '' : ' info'}">${items}<span class="drop-links"><button type="button" class="al-map" data-goto="${where}">See full alert</button>${extra}</span></span>`);
  }
  return `<button type="button" class="late-pill ${kind === 'warn' ? 'warn-pill' : 'info-pill'}" data-drop="${esc(key)}" aria-expanded="${open}">${kind === 'warn' ? WARN_IC : ''}${esc(label)}<span class="chev" aria-hidden="true">${open ? '▾' : '▸'}</span></button>`;
}
const pills = (...ps) => {
  const h = ps.filter(Boolean).join('');
  if (!h) return '';
  const drops = [...h.matchAll(/data-drop="([^"]+)"/g)].map((m) => m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&')).filter((k) => openDrops.has(k)).map((k) => dropBodies.get(k) || '').join('');
  return `<span class="pills">${h}</span>${drops}`;
};
function subwayPills(stnId, route, dir, svc, train) {
  const k = (x) => `${stnId}|${route}|${dir}|${x}`;
  const delays = subNotices(route, dir, (n) => /delay/i.test(n.type) && (DELAY_TYPES.test(n.type) || /\bdelay|\blate\b|cancel/i.test(n.text)) && !SERVICE_SWITCH.test(n.text));
  // "Delays" comes off a train running on time; with "All late trains", a
  // train 5+ min behind its timetable gets a pill even with no notice.
  let delay = '';
  if (delays.length) delay = subwayOnTime(stnId, route, dir, train) ? '' : dropPill(k('delays'), 'Delays', 'warn', delays);
  else if (allLatePills) { const late = subwayLateBy(stnId, route, dir, train); if (late != null && late >= LATE_PILL_MIN * 60) delay = warnPill(`${Math.round(late / 60)} min late`); }
  const e2l = subNotices(route, dir, (n) => /express to local/i.test(n.type));
  const skip = subNotices(route, dir, (n) => /stops skipped|local to express/i.test(n.type) && !e2l.includes(n));
  const red = subNotices(route, dir, (n) => /reduced service/i.test(n.type));
  return delay
    + (skip.length ? dropPill(k('skip'), mtaType(skip[0].type), 'warn', skip) : '')
    + (e2l.length ? dropPill(k('e2l'), 'Express to local', 'info', e2l) : '')
    + (red.length ? dropPill(k('reduced'), 'Reduced service', 'info', red) : '');
}
document.addEventListener('click', (e) => {
  const d = e.target.closest('[data-drop]');
  if (d) { const k = d.dataset.drop; openDrops.has(k) ? openDrops.delete(k) : openDrops.add(k); renderSubway(); renderRail(); return; }
  const g = e.target.closest('[data-goto]');
  if (g) {
    // Phones: the Alerts tab; computers: open the notices strip it belongs to.
    if (matchMedia('(max-width: 960px)').matches) document.querySelector('.seg [data-view="alerts"]').click();
    else { const st = document.querySelector(`#${g.dataset.goto === 'rail' ? 'rail' : 'subway'}-notices details`); if (st) { st.open = true; st.scrollIntoView({ block: 'start', behavior: 'smooth' }); } }
  }
});

// A row taking turns shows each destination's next trains for a few seconds.
const ROTATE_MS = 8000;
const turnCycles = new Map();
const minsHtml = (times) => minsList(times.map((time) => ({ time })));
const minsList = (list) => {
  const ts = list.slice(0, 3).map((x) => Math.max(0, Math.round((x.time - nowS()) / 60)));
  return `${ts[0] === 0 ? '<b class="now">now</b>' : `<b>${ts[0]}</b> min`}${ts.length > 1 ? `, ${ts.slice(1).join(', ')}` : ''}`;
};
function rowHtmlSub(stn, g) {
  const t = nowS();
  let upcoming = g.trains.filter((x) => x.time >= t - 30);
  if (!upcoming.length) return '';
  const name = (id) => (stn.id === '901' ? 'Times Sq-42 St' : stationName(id));
  const note = g.express && DIAMOND_WHERE[g.route] && g.dir === 'N' ? `<small>${DIAMOND_WHERE[g.route]}</small>` : '';
  const ends = [...new Set(upcoming.map((x) => x.dest))];
  const key = `${stn.id}|${g.route}|${g.dir}|${g.svc}|${g.express}`;
  if (ends.length > 1 && subwayStyle === 'b') {
    // Every destination, each with its own next times and pills.
    const body = ends.map((e) => {
      const mine = upcoming.filter((x) => x.dest === e);
      return `<span class="b-row"><span>${esc(name(e))}${pills(subwayPills(stn.id, g.route, g.dir, g.svc, mine[0]))}</span><span class="smins">${minsList(mine)}</span></span>`;
    }).join('');
    return `<div class="sline optb">${bullet(g.route, '', g.express)}<span class="b-wrap"><span class="b-times">${body}</span>${note}</span></div>`;
  }
  if (ends.length > 1) {
    // Take turns, starting with the destination whose train comes first; while a train is "now", stay on it.
    const arriving = Math.round((upcoming[0].time - t) / 60) <= 0;
    const order = arriving ? '' : ends.join(',');
    const turnNow = Math.floor(Date.now() / ROTATE_MS);
    const c = turnCycles.get(key);
    if (!c || c.order !== order) turnCycles.set(key, { order, from: turnNow });
    if (!arriving) upcoming = upcoming.filter((x) => x.dest === ends[(turnNow - turnCycles.get(key).from) % ends.length]);
  }
  return `<div class="sline">${bullet(g.route, '', g.express)}<span class="sdest"><span class="dname">${esc(name(upcoming[0].dest))}</span>${note}${pills(subwayPills(stn.id, g.route, g.dir, g.svc, upcoming[0]))}</span><span class="smins">${minsList(upcoming)}</span></div>`;
}
let subTurnTimer = 0;
function renderSubway() {
  $('sub-toggles').innerHTML = subwayStyleHtml();
  if (!subway.length) { $('subway').innerHTML = `<p class="empty">${subwayErr ? 'Subway times didn’t load. Trying again shortly.' : 'Loading subway times…'}</p>`; return; }
  dropBodies.clear();
  $('subway').innerHTML = STATIONS.map((stn) => {
    const here = subway.filter((g) => g.stn === stn.id && g.trains.some((x) => x.time > nowS() - 30));
    if (!here.length) return '';
    const dirs = Object.keys(stn.dirs).map((dir) => {
      const mine = here.filter((g) => g.dir === dir);
      if (!mine.length) return '';
      const svcs = stn.id === '901' ? [['', mine]] : ['express', 'local'].map((sv) => [SVC_NAMES[sv], mine.filter((g) => g.svc === sv)]).filter(([, l]) => l.length);
      return `<div class="dir"><h3>${esc(stn.dirs[dir])}</h3>${svcs.map(([label, l]) => `<div class="svc">${label ? `<h4>${label}</h4>` : ''}${l.sort((a, b) => a.trains[0].time - b.trains[0].time || (a.express - b.express)).map((g) => rowHtmlSub(stn, g)).join('')}</div>`).join('')}</div>`;
    }).join('');
    return `<section class="stn" aria-label="${stn.lines.map((l) => (l === 'GS' ? 'S' : l)).join(', ')} trains"><div class="stn-lines">${stn.lines.map((l) => bullet(l, 'small')).join('')}</div>${dirs}</section>`;
  }).join('');
  // Rows taking turns move on every few seconds.
  clearTimeout(subTurnTimer);
  if (subwayStyle === 'turns') subTurnTimer = setTimeout(renderSubway, ROTATE_MS - (Date.now() % ROTATE_MS) + 30);
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
  if (n.carrier === 'subway') return (n.lines || []).filter((l) => /^[0-9A-Z]{1,2}$/.test(l)).slice(0, 4).map((l) => bullet(l.replace(/X$/, ''), 'tiny', /^[67]X$/.test(l))).join('') || bullet('GS', 'tiny');
  if (n.carrier === 'lirr') return '<span class="plate lirr">LIRR</span>';
  const ln = (n.lines || []).map((x) => LINE_NAMES[x]).filter(Boolean);
  const first = ln[0] ? Object.values(MNR_LINES).find(([nm]) => nm === ln[0]) : null;
  return `<span class="plate ${first ? first[1] : 'mnr'}">${esc(ln.length === 1 ? ln[0] : 'Metro-North')}</span>`;
}
// The MTA writes lines into notice text as "[2]"; those become line bullets,
// and pictograms like "[accessibility icon]" are dropped (as on the Penn board).
const noticeText = (t) => esc(t).replace(/\[[a-z ]+? icon\]/gi, '').replace(/\[([A-Z0-9]{1,2})\]/g, (m, l) => (subwayData && subwayData.routes[l] ? bullet(l, 'tiny') : `<b>${l}</b>`)).replace(/ {2,}/g, ' ').trim();
const noticeBody = (n) => `${noticeText(n.text)}${n.desc || n.more ? `<span class="n-more">${noticeText(n.desc || n.more).replace(/\n+/g, '<br>')}</span>` : ''}`;
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

// ---------- Other options for a delayed train (as on the Penn board) ----------
// The quickest ways from Grand Central to the stations the delayed train
// serves, direct or with one change, from the railroad's timetable
// (lirr-timetable.json from Grand Central Madison, stop 349; mnr-timetable.json
// from Grand Central, stop 1). A first train already on the live board shows
// its live time and track instead, so a card turns from "Scheduled" to "Live".
const TTG = { lirr: { file: 'lirr-timetable.json', from: '349', change: 180 }, mnr: { file: 'mnr-timetable.json', from: '1', change: 180 } };
const ttg = {}, ttgLoading = {};
let lirrDoc = null;
const loadTTG = (c) => ttgLoading[c] || (ttgLoading[c] = Promise.all([fetch(TTG[c].file).then((x) => (x.ok ? x.json() : null)).catch(() => null),
  c === 'lirr' ? fetch('lirr-data.json').then((x) => (x.ok ? x.json() : null)).catch(() => null) : null]).then(([t, d]) => { ttg[c] = t; if (d) lirrDoc = d; }));
// Stations every train shares (where they all stop on the way out): not a reason to switch.
const SHARED_SKIP = /^(grand central|grand central madison|harlem 125 st|jamaica|woodside|forest hills|kew gardens)$/i;
const trainNo = (x) => String(x || '').replace(/^0+(?=\d)/, '');
function ttgTripsNear(tt) {
  const out = [];
  const t0 = nowS();
  for (let k = 0; k < 2; k++) {
    const day = new Set(tt.dates[nyNow(k).date.replace(/-/g, '')] || []);
    const midnight = t0 + k * 86400 - nyNow().mins * 60 - (t0 % 60);
    for (const [route, head, train, svc, flat] of tt.trips) {
      if (!day.has(svc)) continue;
      const calls = [];
      for (let i = 0; i < flat.length; i += 2) calls.push([tt.stops[flat[i]], midnight + flat[i + 1] * 60]);
      if (calls[calls.length - 1][1] < t0 || calls[0][1] > t0 + 14 * 3600) continue;
      out.push({ route, head, train: trainNo(train), calls });
    }
  }
  return out;
}
function ttgPlans(tt, from, changeS, targets, skipTrain, fromS) {
  const trips = ttgTripsNear(tt);
  const byStop = new Map();
  for (const t of trips) t.calls.forEach(([sid], i) => { if (!byStop.has(sid)) byStop.set(sid, []); byStop.get(sid).push([t, i]); });
  const firsts = trips.map((t) => [t, t.calls.findIndex(([sid]) => sid === from)])
    .filter(([t, i]) => i >= 0 && i < t.calls.length - 1 && t.calls[i][1] >= fromS && t.calls[i][1] <= fromS + 12 * 3600 && t.train !== skipTrain);
  const best = new Map();
  const offer = (sid, plan) => {
    const b = best.get(sid);
    if (!b || plan.arrive < b.arrive || (plan.arrive === b.arrive && ((!plan.change && b.change) || (!!plan.change === !!b.change && plan.leave > b.leave)))) best.set(sid, plan);
  };
  for (const [t, i] of firsts) {
    const leave = t.calls[i][1];
    for (let j = i + 1; j < t.calls.length; j++) {
      const [hub, at] = t.calls[j];
      if (targets.has(hub)) offer(hub, { first: t, leave, arrive: at });
      for (const [u, k] of byStop.get(hub) || []) {
        if (u === t || u.train === skipTrain || u.calls[k][1] < at + changeS || u.calls[k][1] > at + 90 * 60) continue;
        if (u.calls.slice(k + 1).some(([sid]) => sid === from)) continue; // heading back toward Grand Central
        for (let m = k + 1; m < u.calls.length; m++) if (targets.has(u.calls[m][0])) offer(u.calls[m][0], { first: t, leave, change: { at: hub, time: u.calls[k][1], second: u }, arrive: u.calls[m][1] });
      }
    }
  }
  return best;
}
const MNR_ROUTE_LINE = { 1: 'HU', 2: 'HA', 3: 'NH', 4: 'NC', 5: 'DN', 6: 'WB' };
const ttgName = (c, id) => (c === 'lirr' ? (lirrDoc && lirrDoc.stops[id] ? lirrDoc.stops[id][0] : id) : ((ttg.mnr && ttg.mnr.names[id]) || mnrName(id)));
function ttgChip(c, route) {
  if (c === 'lirr') { const r = lirrDoc && lirrDoc.routes[route]; return `<span class="pl" style="background:${esc((r && r.color) || '#2f6fe0')};color:${esc((r && r.text) || '#fff')}">${esc(r ? r.name : 'LIRR')}</span>`; }
  const l = MNR_LINES[MNR_ROUTE_LINE[route]] || ['Metro-North', 'mnr'];
  return `<span class="plate ${l[1]}">${esc(l[0])}</span>`;
}
const hmT = (t) => { const c = clock(t); return `${c.hm} ${c.ap}`; };
function ttgPlansHtml(r) {
  const c = r.railroad, tt = ttg[c];
  if (tt === undefined || (c === 'lirr' && !lirrDoc)) return null;
  if (!tt) return '';
  const mine = new Set([...(r.via || []), r.place].map(normName).filter((x) => !SHARED_SKIP.test(x)));
  const nameOf = (id) => normName(ttgName(c, id));
  const targets = new Set(tt.stops.filter((id) => mine.has(nameOf(id))));
  if (!targets.size) return '';
  const best = ttgPlans(tt, TTG[c].from, TTG[c].change, targets, trainNo(r.train), nowS() + 60);
  const groups = new Map();
  for (const [sid, p] of best) {
    const key = `${p.first.train}|${p.change ? p.change.second.train : ''}`;
    if (!groups.has(key)) groups.set(key, { p, stops: [] });
    groups.get(key).stops.push([sid, p.arrive]);
  }
  const cards = [...groups.values()].sort((a, b) => a.p.leave - b.p.leave || b.stops.length - a.stops.length).slice(0, 5).map(({ p, stops }) => {
    const live = rail.departures.find((x) => x.railroad === c && trainNo(x.train) === p.first.train && x.tone !== 'departed');
    const leave = live ? live.time : p.leave;
    const tag = live ? '<span class="tagx tag-live">Live</span>' : '<span class="tagx tag-sched">Scheduled</span>';
    const how = p.change ? `Change at ${esc(ttgName(c, p.change.at))} for the ${hmT(p.change.time)} train to ${esc(p.change.second.head)}.` : 'No change.';
    stops.sort((a, b) => a[1] - b[1]);
    const gets = stops.slice(0, 6).map(([sid, at]) => `${esc(ttgName(c, sid))} ${hmT(at)}`).join(', ') + (stops.length > 6 ? ` and ${stops.length - 6} more` : '');
    return `<li class="cm-stn"><div class="opt-h">${ttgChip(c, p.first.route)}<span>${tag} ${hmT(leave)}${live && live.track ? `, track ${esc(live.track)}` : ''}</span></div>
      <span class="cm-dir">To ${esc(p.first.head)}. ${how} Gets you to ${gets}.</span></li>`;
  }).join('');
  return cards ? `<h3 class="cm-h">Other ways to the same stations</h3><ul class="cm-stns">${cards}</ul>` : '';
}
function openOptions(r) {
  changeOpen = { id: 'options', view: 1 };
  $('chg-map').hidden = true;
  $('chg-kind').textContent = 'Other options';
  $('chg-h').innerHTML = `${esc(r.branch)}${r.railroad === 'mnr' ? ' Line' : ''} to ${esc(r.place)}`;
  $('chg-top').innerHTML = rowNotices(r).map((n) => `<p class="cm-sum">⚠ ${noticeBody(n)}</p>`).join('');
  let html = ttgPlansHtml(r);
  if (html === null) { loadTTG(r.railroad).then(() => { if (changeOpen && changeOpen.id === 'options' && $('change').open) openOptions(r); }); html = '<p class="cm-live">Checking the timetable…</p>'; }
  $('chg-below').innerHTML = `${html || `<p class="cm-live">No other train from ${r.railroad === 'lirr' ? 'Grand Central Madison' : 'Grand Central'} reaches these stations in the next few hours.</p>`}
    <p class="cm-live">Live: time and track from the live board. Scheduled: from the ${r.railroad === 'lirr' ? 'LIRR' : 'Metro-North'} timetable until the train is on the board. Fares and tickets differ by line; check before you board.</p>`;
  openSheet();
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-options]');
  if (!b) return;
  const r = rail.departures.find((x) => x.id === b.dataset.options);
  if (r) openOptions(r);
});

// ---------- event warnings (as on the Penn board) ----------
// The same event list (docs/events.json, plus Ticketmaster through the relay
// once its key is set), showing the venues reached from Grand Central:
// UBS Arena (LIRR toward Elmont-UBS Arena). Madison Square Garden is over Penn,
// so it's on the Penn board. From 2 h before the start to 1 h after the usual end.
const EVENT_VENUES = /UBS Arena|Yankee Stadium|Citi Field/i;
const EVENT_MIN = { hockey: 160, basketball: 150, sports: 180, show: 180 };
let stationEvents = [], eventsAt = 0;
function loadEvents() {
  if (Date.now() - eventsAt < 30 * 60000) return;
  eventsAt = Date.now();
  const get = (u) => fetch(u, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  Promise.all([get('events.json'), RELAY ? get(`${RELAY}/events`) : null]).then(([a, b]) => {
    const seenE = new Set();
    stationEvents = [...((a && a.events) || []), ...((b && b.events) || [])].filter((e) => EVENT_VENUES.test(e.venue || '')).filter((e) => {
      const k = `${e.venue}|${Math.round(Date.parse(e.start) / 600000)}`;
      if (seenE.has(k)) return false;
      seenE.add(k);
      return true;
    });
    renderEvents();
  });
}
function eventsNow(t) {
  return stationEvents.map((e) => { const start = Date.parse(e.start) / 1000; return { ...e, startS: start, endS: start + (EVENT_MIN[e.kind] || 180) * 60 }; })
    .filter((e) => t >= e.startS - 2 * 3600 && t <= e.endS + 3600).sort((a, b) => a.startS - b.startS);
}
function eventText(e, t) {
  const at = (x) => { const c = clock(x); return `${c.hm} ${c.ap}`.replace(':00 ', ' '); };
  const how = /UBS/i.test(e.venue) ? 'LIRR trains toward Elmont-UBS Arena' : /Yankee/i.test(e.venue) ? 'Hudson and Harlem Line trains to Yankees-E 153 St' : 'the 7 to Mets-Willets Point';
  if (t < e.startS) return `<b>${esc(e.title)}</b> at ${esc(e.venue)}, ${at(e.startS)}. Expect crowds on ${how}.`;
  if (t < e.endS) return `<b>${esc(e.title)}</b> at ${esc(e.venue)} ends around ${at(e.endS)}. Expect crowded trains back after that.`;
  return `<b>${esc(e.title)}</b> just ended at ${esc(e.venue)}. Trains back toward Manhattan will be crowded.`;
}
const EVENT_ICON = '<svg class="ic ev-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M16 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm-8 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm0 2c-2.3 0-7 1.2-7 3.5V19h14v-2.5C15 14.2 10.3 13 8 13zm8 0c-.3 0-.6 0-1 .1 1.2.8 2 2 2 3.4V19h6v-2.5c0-2.3-4.7-3.5-7-3.5z" fill="currentColor"/></svg>';
const eventsHtml = () => eventsNow(nowS()).map((e) => `<div class="ev-note">${EVENT_ICON}<p>${eventText(e, nowS())}</p></div>`).join('');
function renderEvents() { $('events-note').innerHTML = eventsHtml(); renderAlertsTab(); }

// ---------- Alerts tab (phones) ----------
function renderAlertsTab() {
  const card = (n) => `<div class="al-card${n.urgent ? ' urgent' : ''}"><span class="who">${noticeWho(n)}</span><p><span class="kind">${esc(n.type)}</span>${noticeBody(n)}</p></div>`;
  const group = (title, list, none) => `<h2 class="al-h">${title}</h2>${list.length ? list.map(card).join('') : `<p class="al-none">${none}</p>`}`;
  const r = railNotices();
  const l = liftsHtml();
  const ev = eventsHtml();
  $('alerts').innerHTML = (ev ? `<h2 class="al-h">Events</h2>${ev}` : '') + group('Trains at Grand Central', r, 'No notices for Metro-North or the LIRR right now.')
    + group('Subway', notices.subway, 'No subway notices for the lines at Grand Central right now.')
    + `<h2 class="al-h">Elevators and escalators</h2>${l || '<p class="al-none">All elevators and escalators at Grand Central-42 St are working, per the MTA.</p>'}`;
  const n = r.length + notices.subway.length + lifts.length + eventsNow(nowS()).length;
  $('alerts-count').textContent = n ? String(n) : '';
}

// ---------- To the airport (shared with every hub: airport.js) ----------
// Grand Central's own routes; airport.js adds airport buses (from Grand
// Central's subway lines), the Newark Airport Express (it starts here, on 41 St),
// Islip and Stewart (Metro-North straight from here).
const HUB_AIR = {
  id: 'gct', from: 'Grand Central', buses: 'airport-buses-gct.json',
  ewrFrom: 'gct', ewrWalk: 4, ewrWalkText: 'Walk to the Newark Airport Express stop on 41 St, between Park and Lexington Avs', ewrStop: 'Grand Central (41 St)',
  toPabt: 15, toPabtText: 'The S to Times Sq-42 St, then walk west on 42 St to Port Authority (8 Av)',
  toGct: 0, lirrFrom: ' from Grand Central Madison',
};
const TO_PENN_MIN = 15; // the S to Times Sq, then the 1, 2 or 3 one stop, to the NJ Transit concourse
let changeOpen = null;
const lineName = (route) => bullet(String(route).replace(/X$/, ''), 'inl');
// The next live departures from here that call at a station (Metro-North or the LIRR).
function railTo(carriers, stop, nowS) {
  const want = carriers.map((c) => (c === 'lirr' ? 'lirr' : c === 'mnr' ? 'mnr' : ''));
  return rail.departures.filter((r) => want.includes(r.railroad) && r.tone !== 'stop' && r.tone !== 'departed' && r.time >= nowS + 60
    && r.via.concat(r.place).some((v) => new RegExp(`^${stop}\\b`, 'i').test(v))).sort((a, b) => a.time - b.time);
}
// The next train on a subway line from one of Grand Central's stations that reaches a station.
function subwayFromTo(route, from, to, nowS) {
  return subway.filter((g) => g.route === route && g.stn === from).flatMap((g) => g.trains)
    .filter((t) => t.time >= nowS + 60 && (t.stops || []).includes(to)).sort((a, b) => a.time - b.time)[0];
}
// When a live LIRR train from Grand Central Madison reaches a station, by the
// LIRR timetable (lirr-timetable.json, the same file as the Penn board's).
let lirrTT = null, lirrNames = null, lirrLoading = null;
function loadLirr() {
  if (lirrLoading) return lirrLoading;
  lirrLoading = Promise.all([fetch('lirr-timetable.json').then((r) => (r.ok ? r.json() : null)), fetch('lirr-data.json').then((r) => (r.ok ? r.json() : null))])
    .then(([t, d]) => { lirrTT = t; lirrNames = d && d.stops; if (changeOpen && changeOpen.id === 'airport' && $('change').open) renderAirport(); }).catch(() => {});
  return lirrLoading;
}
const GCM_STOP = '349'; // Grand Central Madison in the LIRR's timetable
function lirrArrivalAt(r, station) {
  if (!lirrTT || !lirrNames) return null;
  const sid = Object.keys(lirrNames).find((k) => String(lirrNames[k][0]).toLowerCase() === station.toLowerCase());
  const si = lirrTT.stops.indexOf(sid), gi = lirrTT.stops.indexOf(GCM_STOP);
  if (si < 0 || gi < 0) return null;
  for (const k of [0, -1]) {
    const day = new Set(lirrTT.dates[nyNow(k).date.replace(/-/g, '')] || []);
    for (const [, , train, svc, flat] of lirrTT.trips) {
      if (!day.has(svc) || String(train).replace(/^0+/, '') !== String(r.train).replace(/^0+/, '')) continue;
      let at = null, from = null;
      for (let i = 0; i < flat.length; i += 2) { if (flat[i] === si) at = flat[i + 1]; if (flat[i] === gi) from = flat[i + 1]; }
      if (at != null && from != null && at > from) return r.time + (at - from) * 60;
    }
  }
  return null;
}
// NJ Transit's live departures from Penn (for Newark Airport), through the relay.
let njtPenn = [], njtAt = 0;
function loadNjtPenn() {
  if (!RELAY || Date.now() - njtAt < 30000) return;
  njtAt = Date.now();
  fetch(`${RELAY}/njt`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((d) => {
    njtPenn = d && d.ITEMS ? PennFeeds.parseNjt(d.ITEMS).filter((x) => x.carrier === 'njt') : [];
    if (changeOpen && changeOpen.id === 'airport' && $('change').open) renderAirport();
  }).catch(() => {});
}
// Live MTA Bus Time arrivals at one stop (the airport buses), through the relay.
const mtaBusLive = new Map();
function loadMtaBusStop(stop) {
  const c = mtaBusLive.get(stop);
  if (!RELAY || (c && (c.loading || Date.now() - c.at < 30000))) return;
  mtaBusLive.set(stop, { ...(c || {}), loading: true });
  fetch(`${RELAY}/mta-bus-stop?stop=${encodeURIComponent(stop)}`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status))))
    .then((d) => mtaBusLive.set(stop, { at: Date.now(), buses: d.buses || [] }))
    .catch(() => mtaBusLive.set(stop, { at: Date.now(), error: true }))
    .finally(() => { if (changeOpen && changeOpen.id === 'airport' && $('change').open) renderAirport(); });
}
// PATH's live departures (relay /path): from 33 St (a walk) and World Trade Center.
let pathFeed = null, pathAt = 0;
function loadPath() {
  if (!RELAY || Date.now() - pathAt < 20000) return;
  pathAt = Date.now();
  fetch(`${RELAY}/path`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((d) => { pathFeed = d; if (changeOpen && changeOpen.id === 'airport' && $('change').open) renderAirport(); }).catch(() => {});
}
function pathFrom(station, destRe, after) {
  const st = ((pathFeed && pathFeed.results) || []).find((r) => r.consideredStation === station);
  const t = nowS();
  return ((st && st.destinations) || []).flatMap((d) => d.messages || []).map((m) => ({ dest: m.headSign || '', time: t + (parseInt(m.secondsToArrival, 10) || 0) }))
    .filter((x) => destRe.test(x.dest) && x.time >= after).sort((a, b) => a.time - b.time)[0];
}
// Amtrak trains from Penn that stop at Newark Airport (Amtraker, as on the Penn board).
let amtrakEwr = [], amtrakAt = 0;
function loadAmtrak() {
  if (Date.now() - amtrakAt < 60000) return;
  amtrakAt = Date.now();
  const epoch = (iso) => (iso ? Date.parse(iso) / 1000 : 0);
  fetch('https://api-v3.amtraker.com/v3/trains', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((d) => {
    const out = [];
    for (const list of Object.values(d || {})) for (const tr of list) {
      const st = tr.stations || [];
      const a = st.findIndex((x) => x.code === 'NYP'), b = st.findIndex((x) => x.code === 'EWR');
      if (a < 0 || b <= a || st[a].status === 'Departed') continue;
      out.push({ dep: epoch(st[a].dep || st[a].schDep), arr: epoch(st[b].arr || st[b].schArr), line: tr.routeName, train: tr.trainNum });
    }
    amtrakEwr = out.filter((x) => x.dep).sort((x, y) => x.dep - y.dep);
    if (changeOpen && changeOpen.id === 'airport' && $('change').open) renderAirport();
  }).catch(() => {});
}
const WALK_33ST_MIN = 18; // Grand Central (42 St & Park Av) to the 33 St PATH station (6 Av & 32 St)
const FULTON_TO_WTC_PATH_MIN = 6; // through the Fulton Center and the Oculus
const PATH_WTC_NEWARK_MIN = 22;
function hubAirportLoad() { loadLirr(); loadNjtPenn(); loadPath(); loadAmtrak(); loadNjtStop(NEWARK_PENN_62_STOP); }
function hubAirportOptions(code, nowS) {
  const o = [];
  const lirrFare = (r) => (r.fare === 'peak' ? FARES.cityPeak : FARES.cityOff);
  const lirrLeg = (r, to) => `${airPl('LIRR', 'p-lirr')} to ${to} from Grand Central Madison${r.track ? `, track ${esc(r.track)}` : ''}`;
  if (code === 'JFK') {
    // LIRR from Grand Central Madison to Jamaica, then the AirTrain.
    const l = railTo(['lirr'], 'Jamaica', nowS)[0];
    if (l) {
      const arr = lirrArrivalAt(l, 'Jamaica') || l.time + 22 * 60;
      const air = arr + AIR_MIN.change * 60;
      o.push({ at: air + (AIR_MIN.airtrainJfkWait + AIR_MIN.airtrainJfkRide) * 60, fare: lirrFare(l) + FARES.airtrainJfk,
        legs: [[l.time, lirrLeg(l, 'Jamaica')], [air, `${airPl('AirTrain', 'p-air')} to your terminal`]] });
    }
    // The 6 one stop to 51 St, walk through to the E at Lexington Av/53 St, the E to Sutphin Blvd, the AirTrain.
    const six = subwayFromTo('6', '631', '630', nowS);
    if (six) {
      const e = six.time + (2 + 5) * 60;
      const air = e + (23 + AIR_MIN.change) * 60;
      o.push({ at: air + (AIR_MIN.airtrainJfkWait + AIR_MIN.airtrainJfkRide) * 60, fare: FARES.subway + FARES.airtrainJfk,
        legs: [[six.time, `${lineName('6')} one stop to 51 St, then walk through to the ${lineName('E')} at Lexington Av/53 St`], [e, `${lineName('E')} to Sutphin Blvd-Archer Av-JFK`], [air, `${airPl('AirTrain', 'p-air')} to your terminal`]] });
    }
    // The 7 to Times Sq, through to the A at 42 St-Port Authority, the A to Howard Beach, the AirTrain.
    const seven = subwayFromTo('7', '723', '725', nowS);
    if (seven) {
      const a = seven.time + (3 + 5) * 60;
      const air = a + (48 + AIR_MIN.change) * 60;
      o.push({ at: air + (AIR_MIN.airtrainJfkWait + AIR_MIN.airtrainJfkRide) * 60, fare: FARES.subway + FARES.airtrainJfk,
        legs: [[seven.time, `${lineName('7')} to Times Sq-42 St, then walk through to the ${lineName('A')} at 42 St-Port Authority`], [a, `${lineName('A')} to Howard Beach-JFK`], [air, `${airPl('AirTrain', 'p-air')} to your terminal`]] });
    }
  } else if (code === 'LGA') {
    // LIRR to Woodside, then the Q70 LaGuardia Link (free).
    const l = railTo(['lirr'], 'Woodside', nowS)[0];
    if (l) {
      const arr = lirrArrivalAt(l, 'Woodside') || l.time + 12 * 60;
      const bus = arr + (AIR_MIN.change + AIR_MIN.q70Wait) * 60;
      o.push({ at: bus + AIR_MIN.q70FromWoodside * 60, fare: lirrFare(l),
        legs: [[l.time, lirrLeg(l, 'Woodside')], [bus, `${airPl('Q70 LaGuardia Link', 'p-sbs')} (free), about every 10 min`]] });
    }
    // The 7 to 74 St-Broadway, then the Q70 LaGuardia Link (free).
    const seven = subwayFromTo('7', '723', '710', nowS);
    if (seven) {
      const bus = seven.time + (19 + AIR_MIN.change + AIR_MIN.q70Wait) * 60;
      o.push({ at: bus + AIR_MIN.q70FromJacksonHts * 60, fare: FARES.subway,
        fareText: `${money(FARES.subway)} one way (the Q70 is free)`,
        legs: [[seven.time, `${lineName('7')} to 74 St-Broadway`], [bus, `${airPl('Q70 LaGuardia Link', 'p-sbs')} (free) from Roosevelt Av, about every 10 min`]] });
    }
  } else if (code === 'EWR') {
    // To Penn on the subway, then NJ Transit (live from NJ Transit).
    const ready = nowS + (TO_PENN_MIN + 3) * 60;
    const n = njtPenn.filter((r) => (r.leaves ?? r.time) >= ready && (r.via || []).concat(r.place).some((v) => /^Newark Airport\b/i.test(v))).sort((a, b) => (a.leaves ?? a.time) - (b.leaves ?? b.time))[0];
    if (n) {
      const dep = n.leaves ?? n.time;
      o.push({ at: dep + (AIR_MIN.njtEwr + AIR_MIN.change + AIR_MIN.airtrainEwrWait + AIR_MIN.airtrainEwrRide) * 60, fare: FARES.njtEwr + FARES.subway,
        fareText: `${money(FARES.njtEwr)} NJ Transit (AirTrain included), plus ${money(FARES.subway)} for the subway`,
        legs: [[dep - (TO_PENN_MIN + 3) * 60, `${lineName('S')} to Times Sq, then the ${lineName('1')}, ${lineName('2')} or ${lineName('3')} one stop to 34 St-Penn Station`],
          [dep, `${airPl('NJ Transit', 'p-njt')} from Penn Station to Newark Airport${n.track ? `, track ${esc(n.track)}` : ''}`],
          [dep + (AIR_MIN.njtEwr + AIR_MIN.change) * 60, `${airPl('AirTrain', 'p-air')} to your terminal (included)`]] });
    }
    // Amtrak from Penn (reservation required), after the subway to Penn.
    const m = amtrakEwr.find((x) => x.dep >= ready);
    if (m) {
      o.push({ at: (m.arr || m.dep + AIR_MIN.amtrakEwr * 60) + (AIR_MIN.change + AIR_MIN.airtrainEwrWait + AIR_MIN.airtrainEwrRide) * 60, fare: null, fareText: `Amtrak fare varies by train, plus ${money(FARES.subway)} for the subway`,
        note: 'Reservation required: buy an Amtrak ticket for this train before you board. NJ Transit tickets aren’t valid on Amtrak.',
        legs: [[m.dep - (TO_PENN_MIN + 3) * 60, `${lineName('S')} to Times Sq, then the ${lineName('1')}, ${lineName('2')} or ${lineName('3')} one stop to 34 St-Penn Station`],
          [m.dep, `${airPl('Amtrak', 'p-amtrak')} ${esc(m.line || '')} from Penn Station to Newark Airport`],
          [(m.arr || m.dep + AIR_MIN.amtrakEwr * 60) + AIR_MIN.change * 60, `${airPl('AirTrain', 'p-air')} to your terminal (included)`]] });
    }
    // PATH to Newark Penn, then NJ Transit one stop or the 62 bus (shared with Penn: newarkPennOptions).
    const night = nyNow().mins < 6 * 60 || nyNow().mins >= 23 * 60;
    // a) Walk to the 33 St station (cheapest: no subway fare), change at Journal Square.
    // PATH's feed looks about 20 min ahead, so past the walk there may be no
    // live train yet: then the usual gap (every 10 min by day, 20 at night), marked Estimated.
    const live33 = pathFrom('33S', /journal square/i, nowS + WALK_33ST_MIN * 60);
    const p = live33 || { dest: 'Journal Square', time: nowS + (WALK_33ST_MIN + (night ? 10 : 5)) * 60, est: true };
    if (p) {
      const atNewark = p.time + ((/hoboken/i.test(p.dest) ? AIR_MIN.pathJsqViaHob : AIR_MIN.pathJsq) + AIR_MIN.change + (night ? AIR_MIN.pathNewarkWaitNight : AIR_MIN.pathNewarkWait) + AIR_MIN.pathNewark) * 60;
      o.push(...newarkPennOptions([[p.time - WALK_33ST_MIN * 60, 'Walk to the 33 St PATH station (6 Av & 32 St), about 18 min'],
        [p.time, `${airPl('PATH', 'p-path')} to ${esc(p.dest)}, then change for Newark${p.est ? `, about every ${night ? 20 : 10} min` : ''}`]], atNewark, night, FARES.path, 'PATH', p.est ? false : undefined));
    }
    // b) The 4 or 5 to Fulton St, then PATH from World Trade Center straight to Newark.
    const lex = ['4', '5'].map((r) => { const t = subwayFromTo(r, '631', '418', nowS); return t && { ...t, route: r }; }).filter(Boolean).sort((x, y) => x.time - y.time)[0];
    if (lex) {
      const w = pathFrom('WTC', /newark/i, lex.time + (10 + FULTON_TO_WTC_PATH_MIN) * 60);
      if (w) {
        o.push(...newarkPennOptions([[lex.time, `${lineName(lex.route)} to Fulton St, then walk through to the World Trade Center PATH station`],
          [w.time, `${airPl('PATH', 'p-path')} to Newark`]], w.time + (PATH_WTC_NEWARK_MIN) * 60, night, FARES.subway + FARES.path, 'subway + PATH'));
      }
    }
  }
  return o;
}
function openSheet() {
  const d = $('change');
  if (!d.open) { d.showModal(); history.pushState({ changeMap: true }, ''); }
  d.querySelector('.cm-body').scrollTop = 0;
}
$('chg-close').addEventListener('click', () => { if ($('change').open) $('change').close(); });
window.addEventListener('popstate', () => { if ($('change').open) $('change').close(); });
$('change').addEventListener('close', () => { changeOpen = null; if (history.state && history.state.changeMap) history.back(); });

// ---------- page ----------
let lastClock = '';
function renderClock() {
  const p = {};
  new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', second: '2-digit' }).formatToParts(new Date()).forEach((x) => { p[x.type] = x.value; });
  const hm = `${p.hour}:${p.minute}`;
  if (flipMode) {
    // Tiles turn only when the minute changes; no seconds on the flip board.
    if (lastClock !== hm + p.dayPeriod) { $('clock').innerHTML = flipText('clock', hm); $('clock-ap').innerHTML = flipText('clock-ap', p.dayPeriod); runFlips($('clock').parentNode); lastClock = hm + p.dayPeriod; }
    $('clock-s').textContent = '';
    return;
  }
  $('clock').textContent = hm;
  $('clock-s').textContent = `:${p.second}`;
  $('clock-ap').textContent = p.dayPeriod;
}
// Board style (Standard or Flip board), shared with the Penn board.
const HUB_PILL = '<a class="hub-pill" href="index.html" title="Switch to Penn Station">⇄ Penn Station</a>';
function renderMast() {
  const h = document.querySelector('.mast h1');
  h.innerHTML = flipMode
    ? `<span class="mast-kicker">New York ${HUB_PILL}</span><span class="mast-flip">${flipText('mast', 'Grand Central')}</span>`
    : `<span class="mast-kicker">New York ${HUB_PILL}</span>Grand Central`;
  if (flipMode) runFlips(h); else flipShown.delete('mast');
}
function setBoardStyle(flip) {
  flipMode = flip;
  store.set('boardStyle', flip ? 'flip' : 'standard');
  document.body.classList.toggle('flipboard', flip);
  document.querySelectorAll('.style-seg [data-style]').forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.style === 'flip') === flip)));
  for (const k of [...flipShown.keys()]) if (k !== 'mast') flipShown.delete(k); // rows flip in fresh
  lastClock = '';
  renderMast(); renderClock(); renderRail();
}
document.querySelector('.style-bar .style-seg').addEventListener('click', (e) => { const b = e.target.closest('button[data-style]'); if (b) setBoardStyle(b.dataset.style === 'flip'); });
document.body.classList.toggle('flipboard', flipMode);
document.querySelectorAll('.style-seg [data-style]').forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.style === 'flip') === flipMode)));
renderMast();
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
// Tapping "Grand Central" reloads the page (fresh data and the newest version),
// as tapping "Penn Station" does on the Penn board. The pill switches boards instead.
const mastTitle = document.querySelector('.mast h1');
mastTitle.setAttribute('role', 'button');
mastTitle.tabIndex = 0;
mastTitle.title = 'Reload the board';
mastTitle.addEventListener('click', (e) => { if (!e.target.closest('.hub-pill')) location.reload(); });
mastTitle.addEventListener('keydown', (e) => { if (e.target.closest('.hub-pill')) return; if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); location.reload(); } });
// Inside the side-by-side view, the page knows it's framed (the split button hides).
if (window.self !== window.top) document.body.classList.add('in-split');
document.addEventListener('visibilitychange', () => { if (!document.hidden) { loadRail(); loadSubway(); } });

loadRail(); loadSubway(); loadBuses(); loadNotices(); loadLifts(); loadEvents();
setInterval(() => { loadEvents(); renderEvents(); }, 60000);
setInterval(loadRail, 20000);
setInterval(loadSubway, 30000);
setInterval(loadBuses, 60000);
setInterval(loadNotices, 60000);
setInterval(loadLifts, 3 * 60000);
setInterval(() => { renderClock(); }, 1000);
setInterval(() => { renderRail(); renderSubway(); renderBuses(); renderStamp(); }, 10000);
renderClock();
