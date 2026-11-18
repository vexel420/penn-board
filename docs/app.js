const REFRESH_MS = 20000;
const CARRIERS = { lirr: 'LIRR', njt: 'NJ Transit', amtrak: 'Amtrak' };
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let board = null;
let lastGood = 0;
let failed = false;
let view = 'departures';
let carrier = 'all';
const seenTracks = new Map(); // row id -> track last shown, to animate a newly posted track
const openRows = new Set();
try { carrier = localStorage.getItem('carrier') || 'all'; } catch {}

const nyTime = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
const nySecs = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', second: '2-digit' });
function clock(epoch) {
  const [hm, ap] = nyTime.format(new Date(epoch * 1000)).split(' ');
  return { hm, ap };
}
function countdown(epoch) {
  const m = Math.round((epoch - Date.now() / 1000) / 60);
  if (m < 0) return 'gone';
  if (m < 1) return 'now';
  if (m < 60) return `in ${m} min`;
  return `in ${Math.floor(m / 60)} h ${m % 60} min`;
}

function trackCell(r, extra = '') {
  if (r.track) {
    const fresh = seenTracks.has(r.id) && seenTracks.get(r.id) !== r.track;
    return `<div class="track${fresh ? ' flip' : ''}${extra}" aria-label="Track ${esc(r.track)}"><b>${esc(r.track)}</b></div>`;
  }
  if (r.trackLikely) return `<div class="track likely" aria-label="Track not posted, usually ${esc(r.trackLikely)}"><b>${esc(r.trackLikely)}</b><small>usual</small></div>`;
  return '<div class="track none" aria-label="Track not posted"><b>–</b></div>';
}

const STALE_AFTER_MS = 90 * 1000;
const isStale = () => !lastGood || Date.now() - lastGood > STALE_AFTER_MS;
const fromNjt = (r) => String(r.id).startsWith('njt-'); // NJ Transit text is shown as-is

// A departed LIRR, NJ Transit or Amtrak train stays on the board marked
// "Departed" for this long, then comes off. (Subway and PATH just drop off.)
const DEPARTED_SHOWN_S = 3 * 60;
// Amtrak trains leave the board only when Amtrak reports them gone. If its
// estimate passes with no word, the train stays (it is running late) until
// the estimate is this old, which means the data has stopped updating.
const AMTRAK_SILENT_S = 30 * 60;
const flaggedAt = new Map(); // train id -> when we first saw its feed call it departed
const vanished = new Map();  // train id -> row for a train that left the feed as it was due out

// When a train left, or null if it hasn't. Uses the feed's own word where it
// has one (LIRR, Amtrak), else the departure time plus any delay.
function departedAt(r) {
  if (r.tone === 'stop') return null; // a cancelled train never left
  const nowS = Date.now() / 1000;
  if (r.departedAt) return r.departedAt;
  if (r.departed) {
    if (!flaggedAt.has(r.id)) flaggedAt.set(r.id, nowS);
    return flaggedAt.get(r.id);
  }
  if (r.departsByFeed) return null; // Amtrak: only its own report counts
  const leaves = r.leaves ?? r.time;
  return leaves <= nowS ? leaves : null;
}

// Feeds sometimes drop a train the moment it leaves. Remember any that
// disappear close to their time, so they still show as departed.
function noteVanished(prev, next) {
  const nowS = Date.now() / 1000;
  const still = new Set(next.departures.map((r) => r.id));
  for (const id of still) vanished.delete(id);
  for (const r of prev ? prev.departures : []) {
    if (still.has(r.id) || vanished.has(r.id) || r.tone === 'stop') continue;
    if ((r.leaves ?? r.time) > nowS + 180) continue; // far from due: a feed glitch, not a departure
    const at = departedAt(r) ?? nowS;
    vanished.set(r.id, { ...r, departed: true, departedAt: Math.min(at, nowS) });
  }
  for (const [id, r] of vanished) if (nowS - r.departedAt > DEPARTED_SHOWN_S) vanished.delete(id);
}

function visibleRows(rows, kind) {
  const nowS = Date.now() / 1000;
  // Arrivals go 5 min after arriving, except a through train, which stays
  // until it has left Penn (its feed row disappears then).
  if (kind === 'arrivals') return rows.filter((r) => (r.continuesTo ? r.departsAt > nowS - 30 * 60 : r.time > nowS - 5 * 60));
  // Ordered by real departure: when a train left, or when it's now expected
  // to leave (delay included), so a delayed train moves down the board.
  const when = (r) => departedAt(r) ?? r.leaves ?? r.time;
  const all = [...rows, ...vanished.values()].sort((a, b) => when(a) - when(b));
  return all.filter((r) => {
    if (r.tone === 'stop') return r.time > nowS - 5 * 60; // keep a cancellation up a while
    const at = departedAt(r);
    if (at !== null) return nowS - at < DEPARTED_SHOWN_S;
    if (r.departsByFeed) return r.time > nowS - AMTRAK_SILENT_S;
    return true;
  });
}

// A train that has left says "Departed", whatever its last status was. Stale
// data never keeps the green boarding highlight.
// Final call: a boarding train in its last minute. NJ Transit rows keep NJ
// Transit's own wording (its terms ask for as-is text); the row still turns red.
// A delayed train's final call starts 2 minutes before its estimated
// departure, so no one misses it; an on-time train's, 1 minute before.
const isDelayed = (r) => (r.lateMin || 0) >= 2;
function finalCall(r, kind) {
  if (kind !== 'departures' || r.tone !== 'go' || isStale()) return false;
  const left = (r.leaves ?? r.time) - Date.now() / 1000;
  return left > 0 && left <= (isDelayed(r) ? 120 : 60);
}

function shownStatus(r, kind) {
  if (kind === 'departures' && departedAt(r) !== null) return { status: 'Departed', tone: 'departed' };
  // A delayed train whose track is posted is boarding (NJ Transit's own text stays).
  if (kind === 'departures' && r.tone === 'late' && r.track && !fromNjt(r)) r = { ...r, status: 'Boarding', tone: 'go' };
  if (finalCall(r, kind)) return { status: fromNjt(r) ? r.status : 'Final call', tone: 'final' };
  if (r.tone !== 'go') return { status: r.status, tone: r.tone };
  if (kind === 'arrivals' && r.time <= Date.now() / 1000 && !r.continuesTo) return { status: r.status, tone: 'quiet' };
  if (isStale()) return { status: r.status, tone: 'quiet' };
  return { status: r.status, tone: r.tone };
}

function finalLeft(r) {
  const s = (r.leaves ?? r.time) - Date.now() / 1000;
  return s > 60 ? 'in 2 min' : 'under 1 min';
}

function agoText(epoch) {
  const m = Math.floor((Date.now() / 1000 - epoch) / 60);
  return m < 1 ? 'left just now' : `left ${m} min ago`;
}

// ---------- arriving trains: cross off the stations already passed ----------
// Amtrak's feed marks each station a train has left. For LIRR the board asks
// LIRR about one train at a time, only while its list of stops is open.
const lirrProgress = new Map(); // train id -> { at, passed: Set of codes, loading }
function loadLirrProgress(id) {
  const p = lirrProgress.get(id);
  if (p && (p.loading || Date.now() - p.at < 20000)) return;
  lirrProgress.set(id, { ...(p || { passed: new Set(), at: 0 }), loading: true });
  fetch(`https://backend-unified.mylirr.org/locations/${encodeURIComponent(id)}`, { headers: { 'accept-version': '3.0' }, cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
    .then((d) => {
      const stops = (d.details && d.details.stops) || [];
      lirrProgress.set(id, { at: Date.now(), loading: false, known: true,
        passed: new Set(stops.filter((s) => s.stop_status === 'DEPARTED').map((s) => s.code)) });
    })
    .catch(() => lirrProgress.set(id, { ...(lirrProgress.get(id) || {}), at: Date.now(), loading: false }))
    .then(() => renderRail());
}
// Keep open LIRR arrival lists current (called on every redraw).
function refreshOpenProgress() {
  if (view !== 'arrivals' || !board) return;
  for (const r of board.arrivals) if (r.carrier === 'lirr' && r.viaCodes && openRows.has(r.id)) loadLirrProgress(r.id);
}

// Each stop on the way: 'passed', 'here' (at the station now) or ''. Null if unknown.
function viaStates(r) {
  if (view !== 'arrivals') return null;
  if (r.viaState) return r.viaState;
  if (r.carrier === 'lirr' && r.viaCodes) {
    const p = lirrProgress.get(r.id);
    return p && p.known ? r.viaCodes.map((c) => (p.passed.has(c) ? 'passed' : '')) : null;
  }
  return null;
}

function viaHtml(r) {
  const states = viaStates(r);
  const open = openRows.has(r.id);
  const next = states ? r.via.find((_, i) => states[i] !== 'passed') : null;
  const allPassed = states && !next;
  let where = '';
  if (states && states.some((s) => s)) where = allPassed ? ', next stop Penn Station' : `, next stop ${esc(next)}`;
  const names = r.via.map((name, i) => {
    const s = states && states[i];
    if (s === 'passed') return `<s><span class="sr">passed: </span>${esc(name)}</s>`;
    if (s === 'here') return `<b class="here">${esc(name)}<span class="sr">, at the station now</span></b>`;
    return esc(name);
  }).join(', ');
  const prog = lirrProgress.get(r.id);
  const failed = prog && !prog.loading && !prog.known && prog.at;
  const checking = open && !states && view === 'arrivals' && r.carrier === 'lirr'
    ? `<small class="checking">${failed ? 'LIRR didn’t say where this train is. Trying again shortly.' : 'Checking where the train is…'}</small>` : '';
  // The list always ends with where the train finishes. An arriving train
  // finishes at Penn, unless it carries on (an Amtrak through train).
  let tail = '', last = r.place;
  if (view === 'arrivals') {
    last = r.continuesTo || 'Penn Station';
    if (r.continuesTo) tail = ', Penn Station';
  }
  return `<details class="via" data-id="${esc(r.id)}"${open ? ' open' : ''}><summary>${esc(r.line)}, train ${esc(r.train)}, <u>${r.via.length} stops</u>${where}</summary><p>${names}${tail}</p><p class="last-stop">Last stop: <b>${esc(last)}</b></p>${checking}</details>`;
}

function rowHtml(r) {
  const shown = shownStatus(r, view);
  r = { ...r, status: shown.status, tone: shown.tone };
  const t = clock(r.time);
  const gone = r.tone === 'departed';
  // A late train counts down to when it is now expected to leave.
  const left = gone ? agoText(departedAt(r) ?? r.time) : countdown(r.tone === 'stop' ? r.time : (r.leaves ?? r.time));
  const due = !gone && left === 'gone' && r.departsByFeed; // late Amtrak, still expected
  // Under the status: how late (when the status itself doesn't say) and the
  // scheduled time, so a delayed train that is boarding still reads as delayed.
  const notes = [];
  if (isDelayed(r) && !/late/i.test(r.status) && !gone) notes.push(`${r.lateMin} min late`);
  if (r.sched && Math.abs(r.sched - r.time) >= 120) notes.push(`scheduled ${clock(r.sched).hm}`);
  if (view === 'arrivals' && r.continuesTo) notes.push(`continues to ${esc(r.continuesTo)}, leaves ${clock(r.departsAt).hm}`);
  const sched = notes.length ? `<small>${notes.join(', ')}</small>` : '';
  const via = r.via && r.via.length ? viaHtml(r) : `<div class="meta">${esc(r.line)}, train ${esc(r.train)}</div>`;
  return `<li class="row ${r.tone}${left === 'gone' && !gone && !due ? ' gone' : ''}">
    <div class="time"><b>${t.hm}<small>${t.ap}</small></b><span>${due ? 'due' : r.tone === 'final' ? finalLeft(r) : left === 'gone' ? '' : left}</span></div>
    <div class="carrier"><span class="plate ${r.carrier}">${CARRIERS[r.carrier]}</span></div>
    <div class="dest"><div class="place">${esc(r.place)}</div>${via}</div>
    <div class="status ${r.tone}">${esc(r.status)}${sched}</div>
    ${trackCell(r, r.tone === 'final' ? ' ring' : '')}
  </li>`;
}

function emptyMessage() {
  const s = board.sources;
  if (carrier === 'njt') {
    if (view === 'arrivals') return 'NJ Transit publishes departures only, so its arriving trains can’t be listed here.';
    if (s.njt.needsServer) return 'NJ Transit trains aren’t shown on this version of the site. See the note above.';
    if (s.njt.needsLogin) return 'NJ Transit trains appear once the site has an NJ Transit developer login. See the note above.';
    if (s.njt.error) return `NJ Transit data didn’t load: ${s.njt.error}. Trying again shortly.`;
  }
  if (carrier !== 'all' && s[carrier] && s[carrier].error) return `${CARRIERS[carrier]} data didn’t load: ${s[carrier].error}. Trying again shortly.`;
  return `No ${carrier === 'all' ? '' : CARRIERS[carrier] + ' '}${view} in the next few hours.`;
}

function renderRail() {
  if (!board || view === 'subway') return;
  const rows = visibleRows(board[view], view).filter((r) => carrier === 'all' || r.carrier === carrier);
  $('col-place').textContent = view === 'arrivals' ? 'From' : 'To';
  $('rows').innerHTML = rows.length ? rows.map(rowHtml).join('') : `<li class="empty">${esc(emptyMessage())}</li>`;
  for (const r of rows) seenTracks.set(r.id, r.track);
  refreshOpenProgress();
}

// ---------- subway lines: colours, station names, reroutes ----------
// docs/subway-data.json is built from the MTA's timetable by
// scripts/build-subway-data.py: every line's colours, every station, and the
// stations each line normally serves.
let subwayData;            // undefined: not loaded yet; null: couldn't load
let subwayDataLoading = null;
function loadSubwayData() {
  if (subwayData !== undefined || subwayDataLoading) return;
  subwayDataLoading = fetch('subway-data.json')
    .then((r) => (r.ok ? r.json() : null)).catch(() => null)
    .then((d) => {
      if (d) for (const r of Object.values(d.routes)) r.normalSet = new Set(r.normal);
      subwayData = d; subwayDataLoading = null; renderSubway(); renderServiceNotices();
    });
}
const lineInfo = (route) => (subwayData && subwayData.routes[route]) || { label: route, color: '#6b7a70', text: '#ffffff' };
const stationName = (id) => (subwayData && subwayData.stops[id] ? subwayData.stops[id][0] : '');
// Stations on this train's way that its line doesn't normally serve.
function unusualStops(route, train) {
  const r = subwayData && subwayData.routes[route];
  if (!r || !train.stops) return [];
  return train.stops.filter((id) => subwayData.stops[id] && !r.normalSet.has(id));
}
function bulletHtml(route, extraClass = '') {
  const l = lineInfo(route);
  return `<span class="bullet ${extraClass}" style="background:${esc(l.color)};color:${esc(l.text)}" aria-label="${esc(l.label)} train">${esc(l.label)}</span>`;
}

let subwayShown = [];      // the groups drawn, so a tap can find its train
const DIRS = { N: 'Uptown, the Bronx and Queens', S: 'Downtown and Brooklyn' };
function renderSubway() {
  if (!board) return;
  loadSubwayData();
  if (!board.subway.length) {
    $('subway').innerHTML = `<p class="empty">${board.sources.subway.error ? 'Subway times didn’t load. Trying again shortly.' : 'No subway trains reported right now.'}</p>`;
    return;
  }
  const nowS = Date.now() / 1000;
  subwayShown = [];
  // Each direction splits into express and local, by how each train is
  // actually running from Penn (night service and reroutes included).
  const SVC = { express: 'Express', local: 'Local' };
  $('subway').innerHTML = ['N', 'S'].map((dir) => {
    const parts = ['express', 'local'].map((svc) => {
    const lines = board.subway.filter((g) => g.dir === dir && (g.svc || 'local') === svc).map((g) => {
      const trains = g.trains.filter((x) => x.time >= nowS - 30).slice(0, 3);
      if (!trains.length) return '';
      const mins = trains.map((x) => Math.max(0, Math.round((x.time - nowS) / 60)));
      const first = trains[0];
      const last = first.stops && first.stops[first.stops.length - 1];
      const dest = stationName(last) || first.dest || (dir === 'N' ? 'Uptown' : 'Downtown');
      const firstMin = mins[0] === 0 ? '<b class="now">now</b>' : `<b>${mins[0]}</b> min`;
      const rest = mins.slice(1).length ? `, ${mins.slice(1).join(', ')}` : '';
      const rerouted = trains.find((x) => unusualStops(g.route, x).length);
      if (!rerouted) {
        return `<div class="sline">${bulletHtml(g.route)}<span class="sdest">${esc(dest)}</span><span class="smins">${firstMin}${rest}</span></div>`;
      }
      const i = subwayShown.push({ route: g.route, dir, svc: g.svc, train: rerouted }) - 1;
      return `<button type="button" class="sline rerouted" data-reroute="${i}" aria-haspopup="dialog">${bulletHtml(g.route)}<span class="sdest">${esc(dest)}<span class="reroute-tag">Rerouted, see map</span></span><span class="smins">${firstMin}${rest}</span></button>`;
    }).join('');
      return lines ? `<div class="svc"><h4>${SVC[svc]}</h4>${lines}</div>` : '';
    }).join('');
    return parts ? `<div class="dir"><h3>${DIRS[dir]}</h3>${parts}</div>` : '';
  }).join('');
}

// ---------- reroute map ----------
const LEAFLET = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/';
let leafletLoading = null;
function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (!leafletLoading) {
    leafletLoading = new Promise((resolve, reject) => {
      const css = document.createElement('link');
      css.rel = 'stylesheet'; css.href = LEAFLET + 'leaflet.min.css';
      document.head.append(css);
      const js = document.createElement('script');
      js.src = LEAFLET + 'leaflet.min.js';
      js.onload = () => resolve(window.L);
      js.onerror = () => { leafletLoading = null; reject(new Error('map library did not load')); };
      document.head.append(js);
    });
  }
  return leafletLoading;
}

let rerouteMap = null;
async function openReroute({ route, svc, train }) {
  const l = lineInfo(route);
  const stops = train.stops.filter((id) => subwayData.stops[id]);
  const unusual = new Set(unusualStops(route, train));
  const dest = stationName(stops[stops.length - 1]);
  $('reroute-h').innerHTML = `${bulletHtml(route)}<span>${esc(l.label)} train to ${esc(dest)}</span>`;
  $('reroute-note').textContent = `This ${l.label} train is running on a different route from normal, ${svc === 'express' ? 'express' : 'local'} from Penn. ` +
    `${unusual.size === 1 ? 'The station in gold is one' : `The ${unusual.size} stations in gold are ones`} the ${l.label} doesn’t usually stop at.`;
  $('reroute-stops').innerHTML = stops.map((id) => unusual.has(id)
    ? `<li class="unusual">${esc(stationName(id))} <small>not usual for the ${esc(l.label)}</small></li>`
    : `<li>${esc(stationName(id))}</li>`).join('');
  const dialog = $('reroute');
  if (!dialog.open) dialog.showModal();

  const box = $('reroute-map');
  try {
    const L = await loadLeaflet();
    box.classList.remove('unavailable');
    if (rerouteMap) rerouteMap.remove();
    rerouteMap = L.map(box, { scrollWheelZoom: false, attributionControl: true });
    // OpenStreetMap's own tiles (free, with credit), darkened in CSS to suit the board.
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18, className: 'rr-tiles',
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(rerouteMap);
    const pts = stops.map((id) => [subwayData.stops[id][1], subwayData.stops[id][2]]);
    L.polyline(pts, { color: '#f2ead8', weight: 8, opacity: .35 }).addTo(rerouteMap);
    L.polyline(pts, { color: l.color, weight: 5 }).addTo(rerouteMap);
    stops.forEach((id, i) => {
      const odd = unusual.has(id), end = i === 0 || i === stops.length - 1;
      const m = L.circleMarker(pts[i], {
        radius: odd ? 7 : end ? 7 : 4, weight: odd ? 3 : 2,
        color: odd ? '#e6b751' : '#121d18', fillColor: odd ? '#e6b751' : '#f2ead8', fillOpacity: 1,
      }).addTo(rerouteMap);
      const label = i === 0 ? `${stationName(id)} (you are here)` : stationName(id);
      m.bindTooltip(label, { permanent: end, direction: 'auto', className: 'rr-label' });
    });
    rerouteMap.fitBounds(L.latLngBounds(pts), { padding: [28, 28] });
    setTimeout(() => rerouteMap && rerouteMap.invalidateSize(), 50);
  } catch {
    box.classList.add('unavailable'); // the list of stops still shows
  }
}
$('subway').addEventListener('click', (e) => {
  const b = e.target.closest('[data-reroute]');
  if (b && subwayShown[b.dataset.reroute]) openReroute(subwayShown[b.dataset.reroute]);
});
$('reroute-close').addEventListener('click', () => $('reroute').close());
$('reroute').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });

function renderPath() {
  if (!board) return;
  const nowS = Date.now() / 1000;
  const byDest = new Map();
  for (const x of board.path || []) {
    const m = Math.round((x.time - nowS) / 60);
    if (m < 0) continue;
    if (!byDest.has(x.dest)) byDest.set(x.dest, { colors: x.colors, mins: [] });
    byDest.get(x.dest).mins.push(m);
  }
  if (!byDest.size) { renderPathSchedule(); return; }
  $('path').innerHTML = [...byDest].map(([dest, g]) => {
    const mins = g.mins.slice(0, 3);
    const firstMin = mins[0] === 0 ? '<b class="now">now</b>' : `<b>${mins[0]}</b> min`;
    const rest = mins.length > 1 ? `, ${mins.slice(1).join(', ')}` : '';
    const dots = (g.colors.length ? g.colors : ['']).map((c) => `<i${c ? ` style="background:#${c}"` : ''}></i>`).join('');
    return `<div class="sline"><span class="pdots" aria-hidden="true">${dots}</span><span class="sdest">${esc(dest)}</span><span class="smins">${firstMin}${rest}</span></div>`;
  }).join('');
}

// ---------- PATH timetable, shown when live PATH times aren't available ----------
// docs/path-schedule.json is built from PATH's published timetable by
// scripts/build-path-schedule.py. Holidays and one-off construction
// timetables aren't covered.

let pathSchedule;          // undefined: not loaded yet; null: couldn't load
let pathScheduleLoading = null;
function loadPathSchedule() {
  if (pathSchedule !== undefined || pathScheduleLoading) return;
  pathScheduleLoading = fetch('path-schedule.json')
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
    .then((d) => { pathSchedule = d; pathScheduleLoading = null; renderPath(); });
}

const PATH_COLORS = { 'Journal Square via Hoboken': ['#ff9900', '#4d92fb'] };
const nyParts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', weekday: 'short', hour: 'numeric', minute: 'numeric', year: 'numeric', month: '2-digit', day: '2-digit' });
function nyNow(offsetDays = 0) {
  const p = {};
  nyParts.formatToParts(new Date(Date.now() + offsetDays * 86400000)).forEach((x) => { p[x.type] = x.value; });
  const day = p.weekday === 'Sat' ? 'saturday' : p.weekday === 'Sun' ? 'sunday' : 'weekday';
  return { day, mins: +p.hour * 60 + +p.minute, date: `${p.year}-${p.month}-${p.day}` };
}
const fmtMins = (t) => { const h = Math.floor(t / 60) % 24, m = t % 60; return `${h % 12 || 12}:${String(m).padStart(2, '0')}`; };

// Scheduled departures in the next hour, today's and (near midnight) tomorrow's.
function nextScheduledPath() {
  const today = nyNow(), tomorrow = nyNow(1);
  const list = [
    ...(pathSchedule.days[today.day] || []).filter((d) => d.t >= today.mins),
    ...(pathSchedule.days[tomorrow.day] || []).map((d) => ({ ...d, t: d.t + 1440 })),
  ].filter((d) => d.t < today.mins + 60);
  const byDest = new Map();
  for (const d of list) {
    if (!byDest.has(d.to)) byDest.set(d.to, { colors: PATH_COLORS[d.to] || [d.color], times: [] });
    byDest.get(d.to).times.push(d.t);
  }
  return { byDest, today };
}

function renderPathSchedule() {
  if (pathSchedule === undefined) { loadPathSchedule(); $('path').innerHTML = '<p class="empty">Loading PATH times…</p>'; return; }
  if (!pathSchedule) {
    $('path').innerHTML = '<p class="empty">PATH times aren’t available right now. Trains from 33 St run to Hoboken and Journal Square.</p>';
    return;
  }
  const { byDest, today } = nextScheduledPath();
  const outdated = pathSchedule.validUntil && today.date > pathSchedule.validUntil;
  const note = `<p class="sched-note">Live PATH times aren’t available, so these are scheduled times from PATH’s timetable.${outdated
    ? ' That timetable was last published for service up to ' + new Date(pathSchedule.validUntil + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) + ', so times may have changed.'
    : ''} Holiday and weekend construction changes aren’t included.</p>`;
  const lines = [...byDest].map(([dest, g]) => {
    const [first, ...rest] = g.times.slice(0, 3).map(fmtMins);
    const dots = g.colors.map((c) => `<i style="background:${esc(c)}"></i>`).join('');
    return `<div class="sline"><span class="pdots" aria-hidden="true">${dots}</span><span class="sdest">${esc(dest)}</span><span class="smins"><b>${first}</b>${rest.length ? ', ' + rest.join(', ') : ''}</span></div>`;
  }).join('');
  $('path').innerHTML = note + (lines || '<p class="empty">No PATH trains are scheduled from 33 St in the next hour.</p>');
}

// ---------- service notices ----------
// One strip per place: railroads above the train list, the subway in its
// panel. It starts open; closing it is remembered for this visit until a new
// notice arrives.
const friendlyType = (t) => {
  const x = t.replace(/^Planned - /, 'Planned work, ');
  return x.charAt(0).toUpperCase() + x.slice(1).toLowerCase(); // sentence case
};
function noticeWho(n) {
  if (n.carrier === 'subway') return n.lines.filter((l) => subwayData && subwayData.routes[l]).slice(0, 4).map((l) => bulletHtml(l, 'tiny')).join('') || bulletHtml('S', 'tiny');
  return `<span class="plate ${n.carrier}">${CARRIERS[n.carrier]}</span>`;
}
// "[1]" in MTA text is a line symbol.
const noticeText = (t) => esc(t).replace(/\[([A-Z0-9]{1,2})\]/g, (m, l) => (subwayData && subwayData.routes[l] ? bulletHtml(l, 'tiny') : m));
function noticeStrip(list, where) {
  if (!list || !list.length) return '';
  const sig = list.map((n) => n.id).join('|');
  let closed = false;
  try { closed = sessionStorage.getItem('closed-' + where) === sig; } catch {}
  const urgent = list.some((n) => n.urgent);
  const label = where === 'subway' ? 'Subway service notices' : 'Service notices for trains at Penn';
  const items = list.map((n) => `<div class="al-item${n.urgent ? ' urgent' : ''}"><span class="who">${noticeWho(n)}</span><p style="margin:0"><span class="kind">${esc(friendlyType(n.type))}</span>${noticeText(n.text)}</p></div>`).join('');
  return `<details class="al-strip${urgent ? ' urgent' : ''}" data-where="${where}" data-sig="${esc(sig)}"${closed ? '' : ' open'}><summary><span class="n">${list.length}</span><span>${label}</span><span class="more"><span class="hide">Hide</span><span class="show">Show</span></span></summary>${items}</details>`;
}
function renderServiceNotices() {
  if (!board || !board.notices) return;
  $('rail-notices').innerHTML = noticeStrip(board.notices.rail, 'rail');
  $('subway-notices').innerHTML = noticeStrip(board.notices.subway, 'subway');
}
document.addEventListener('toggle', (e) => {
  const d = e.target;
  if (!d.classList || !d.classList.contains('al-strip')) return;
  try { d.open ? sessionStorage.removeItem('closed-' + d.dataset.where) : sessionStorage.setItem('closed-' + d.dataset.where, d.dataset.sig); } catch {}
}, true);

function renderNotices() {
  if (!board) return;
  const s = board.sources, out = [];
  if (s.njt.needsServer) out.push('NJ Transit trains aren’t shown here. NJ Transit only gives its data to a server with a developer login, and this version of the site runs without one.');
  else if (s.njt.needsLogin) out.push('NJ Transit isn’t connected yet, so its trains are missing and Amtrak tracks appear only shortly before departure. Start the server with <code>NJT_USERNAME</code> and <code>NJT_PASSWORD</code> from a free NJ Transit developer account to add them.');
  else if (s.njt.error) out.push(`NJ Transit data didn’t load (${esc(s.njt.error)}). The NJ Transit trains shown may not be real time.`);
  for (const k of ['lirr', 'amtrak']) if (s[k].error) out.push(`${CARRIERS[k]} data didn’t load (${esc(s[k].error)}). Showing the last trains received.`);
  if (s.subway.error) out.push('Subway times didn’t load. Showing the last times received.');
  $('notices').innerHTML = out.map((m) => `<p>${m}</p>`).join('');
}

function renderStamp() {
  const el = $('updated');
  if (!lastGood) { el.textContent = failed ? 'Can’t reach the train feeds. Trying again.' : 'Connecting…'; return; }
  const age = Math.round((Date.now() - lastGood) / 1000);
  el.className = failed || age > 60 ? 'stale' : '';
  el.textContent = failed || age > 60
    ? `Can’t reach the train feeds. Last updated ${Math.round(age / 60) || 1} min ago, so this information may not be real time.`
    : `Updated ${age < 5 ? 'just now' : age + ' seconds ago'}.`;
}

function render() { renderRail(); renderSubway(); renderPath(); renderNotices(); renderServiceNotices(); renderStamp(); }

// With server.js running, the server gathers everything. On static hosting
// (GitHub Pages) there is no server, so the page reads the feeds itself.
let direct = location.hostname.endsWith('github.io');
async function loadBoard(force) {
  if (!direct) {
    const res = await fetch(force ? 'api/board?force=1' : 'api/board', { cache: 'no-store' }).catch(() => null);
    if (res && res.ok) return res.json();
    if (res && res.status !== 404) throw new Error(res.status);
    direct = true;
  }
  return PennFeeds.board({ force });
}

let loading = null;
async function refresh(force = false) {
  if (loading && !force) return loading;
  const run = (async () => {
    try {
      const next = await loadBoard(force);
      noteVanished(board, next);
      board = next;
      lastGood = Date.now();
      failed = false;
    } catch { failed = true; }
    render();
  })();
  loading = run;
  run.finally(() => { if (loading === run) loading = null; });
  return run;
}

// Departure times fall on the minute, so at each minute: redraw at once (a
// train whose time has just passed stops showing as boarding), then fetch
// fresh data from every feed and redraw again.
function everyMinute() {
  const wait = 60000 - (Date.now() % 60000) + 500;
  setTimeout(() => { renderRail(); refresh(true); everyMinute(); }, wait);
}

function setPressed(group, attr, value) {
  document.querySelectorAll(`${group} button`).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset[attr] === value)));
}
document.querySelector('.seg').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  view = b.dataset.view; document.body.dataset.view = view;
  setPressed('.seg', 'view', view); setHeading(); render();
});

// The masthead names the view: Penn Station departures, arrivals, or subway and PATH.
const HEADINGS = { departures: 'departures', arrivals: 'arrivals', subway: 'subway and PATH' };
function setHeading() {
  $('h1-sub').textContent = HEADINGS[view];
  document.title = `Penn Station ${HEADINGS[view]}`;
}
document.querySelector('.chips').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  carrier = b.dataset.carrier;
  try { localStorage.setItem('carrier', carrier); } catch {}
  setPressed('.chips', 'carrier', carrier); renderRail();
});
$('rows').addEventListener('toggle', (e) => {
  const id = e.target.dataset && e.target.dataset.id; if (!id) return;
  e.target.open ? openRows.add(id) : openRows.delete(id);
  if (e.target.open) refreshOpenProgress();
}, true);
// The Subway tab only exists on narrow screens; fall back when the window widens.
matchMedia('(min-width: 961px)').addEventListener('change', (e) => {
  if (e.matches && view === 'subway') document.querySelector('.seg button[data-view="departures"]').click();
});

function tick() {
  const t = clock(Date.now() / 1000);
  $('clock').textContent = t.hm;
  $('clock-s').textContent = ':' + nySecs.format(new Date()).padStart(2, '0');
  $('clock-ap').textContent = t.ap;
  renderStamp();
}
// Tick on the second, so the seconds never skip or stall.
function everySecond() { setTimeout(() => { tick(); everySecond(); }, 1000 - (Date.now() % 1000) + 5); }
setPressed('.chips', 'carrier', carrier);
tick(); everySecond();
refresh(true); setInterval(() => refresh(), REFRESH_MS); everyMinute();
setInterval(() => { renderRail(); renderSubway(); renderPath(); }, 10000); // keep countdowns moving between refreshes
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(true); });
