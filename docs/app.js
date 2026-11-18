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
const AMTRAK_DEPARTED_SHOWN_S = 5 * 60; // owner's choice: Amtrak gets longer
const shownFor = (r) => (r.carrier === 'amtrak' ? AMTRAK_DEPARTED_SHOWN_S : DEPARTED_SHOWN_S);
const REPORT_LAG_S = 4 * 60; // the most a feed's "departed" report lags in practice
const AWAITING_MAX_S = 45 * 60; // an Amtrak train with no news this long past its time comes off
// Amtrak trains leave the board only when Amtrak reports them gone. If its
// estimate passes with no word, the train stays (it is running late) until
// the estimate is this old, which means the data has stopped updating.
const AMTRAK_SILENT_S = 30 * 60;
const flaggedAt = new Map(); // train id -> when we first saw its feed call it departed
const vanished = new Map();  // train id -> row for a train that left the feed as it was due out
const CANCELLED_SHOWN_S = 5 * 60; // a cancelled train stays until this long past its time
const cancelledGone = { departures: new Map(), arrivals: new Map() }; // cancelled trains a feed dropped early
function keepCancelled(prev, next, kind) {
  const nowS = Date.now() / 1000;
  const still = new Set(next[kind].map((r) => r.id));
  const kept = cancelledGone[kind];
  for (const id of still) kept.delete(id);
  for (const r of prev ? prev[kind] : []) {
    if (r.tone === 'stop' && !still.has(r.id) && r.time > nowS - CANCELLED_SHOWN_S) kept.set(r.id, r);
  }
  for (const [id, r] of kept) if (r.time <= nowS - CANCELLED_SHOWN_S) kept.delete(id);
}

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

// A departed train stays on the board for DEPARTED_SHOWN_S from when the
// board learned it had left, not from when it actually left: Amtrak's data
// runs a few minutes behind, so counting from the real departure made late
// reports vanish without ever showing "Departed". ("left N min ago" still
// uses the real time.)
const learnedAt = new Map(); // train id -> when the board first knew it had left
function shownSince(r, at) {
  if (!learnedAt.has(r.id)) learnedAt.set(r.id, Date.now() / 1000);
  return Math.max(at, learnedAt.get(r.id));
}

// Feeds sometimes drop a train the moment it leaves. Remember any that
// disappear close to their time, so they still show as departed.
function noteVanished(prev, next) {
  const nowS = Date.now() / 1000;
  keepCancelled(prev, next, 'departures');
  keepCancelled(prev, next, 'arrivals');
  const still = new Set(next.departures.map((r) => r.id));
  for (const id of still) vanished.delete(id);
  for (const r of prev ? prev.departures : []) {
    if (still.has(r.id) || vanished.has(r.id) || r.tone === 'stop') continue;
    if ((r.leaves ?? r.time) > nowS + 180) continue; // far from due: a feed glitch, not a departure
    if (r.departsByFeed) {
      // Amtrak drops a train that starts at Penn from its data while it's
      // delayed, and brings it back only once it has left. Until then, keep
      // it listed and say there's no news, rather than calling it departed.
      vanished.set(r.id, { ...r, awaiting: true, status: 'No update from Amtrak', tone: 'late' });
      continue;
    }
    const at = departedAt(r) ?? nowS;
    vanished.set(r.id, { ...r, departed: true, departedAt: Math.min(at, nowS) });
  }
  for (const [id, r] of vanished) {
    if (r.awaiting ? nowS - (r.leaves ?? r.time) > AWAITING_MAX_S : nowS - shownSince(r, r.departedAt) > shownFor(r)) vanished.delete(id);
  }
}

function visibleRows(rows, kind) {
  const nowS = Date.now() / 1000;
  // Arrivals go 5 min after arriving, except a through train, which stays
  // until it has left Penn (its feed row disappears then).
  if (kind === 'arrivals') {
    return [...rows, ...cancelledGone.arrivals.values()].sort((a, b) => a.time - b.time)
      .filter((r) => (r.continuesTo ? r.departsAt > nowS - 30 * 60 : r.time > nowS - 5 * 60));
  }
  // Ordered by real departure: when a train left, or when it's now expected
  // to leave (delay included), so a delayed train moves down the board.
  const when = (r) => departedAt(r) ?? r.leaves ?? r.time;
  const all = [...rows, ...vanished.values(), ...cancelledGone.departures.values()].sort((a, b) => when(a) - when(b));
  return all.filter((r) => {
    if (r.tone === 'stop') return r.time > nowS - CANCELLED_SHOWN_S; // keep a cancellation up a while
    const at = departedAt(r);
    // ...but never more than REPORT_LAG_S beyond its window after it really
    // left (otherwise opening the page would revive long-gone trains).
    if (at !== null) return nowS - shownSince(r, at) < shownFor(r) && nowS - at < shownFor(r) + REPORT_LAG_S;
    if (r.awaiting) return nowS - (r.leaves ?? r.time) < AWAITING_MAX_S;
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
  // An Amtrak train past its time that Amtrak hasn't reported boarding or gone.
  if (kind === 'departures' && r.departsByFeed && r.tone !== 'go' && r.tone !== 'stop' && (r.leaves ?? r.time) <= Date.now() / 1000) return { status: 'No update from Amtrak', tone: 'late' };
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

// LIRR fares depend on whether the train is peak or off-peak.
const fareTag = (r) => (r.fare === 'peak' ? ' <span class="fare peak">Peak</span>' : r.fare === 'offpeak' ? ' <span class="fare">Off-peak</span>' : '');

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
  return `<details class="via" data-id="${esc(r.id)}"${open ? ' open' : ''}><summary>${esc(r.line)}, train ${esc(r.train)}, <u>${r.via.length} stops</u>${where}${fareTag(r)}</summary><p>${names}${tail}</p><p class="last-stop">Last stop: <b>${esc(last)}</b></p>${checking}</details>`;
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
  const via = r.via && r.via.length ? viaHtml(r) : `<div class="meta">${esc(r.line)}, train ${esc(r.train)}${fareTag(r)}</div>`;
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
    if (s.njt.needsServer || s.njt.needsLogin) return 'NJ Transit data not yet available.';
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
  return `<span class="bullet ${extraClass}${l.label.length > 2 ? ' wide' : ''}" style="background:${esc(l.color)};color:${esc(l.text)}" aria-label="${esc(l.label)} train">${esc(l.label)}</span>`;
}

// ---------- subway service pattern: late nights, weekends, holidays, weather ----------
// The A (8 Av) and the 2 (7 Av) run express through Penn by day and local
// late at night. When they switch, per direction and day, comes from the MTA
// timetable (subway-data.json "switches", minutes after the service day's
// midnight). Phases for one line in one direction:
//   day      normal daytime service
//   started  the first late-night train has set off; express trains still due
//            (banner: late-night service has started, last express leaves at...)
//   night    no more express trains until morning ("No express trains late nights")
//   morning  the first daytime express has set off but hasn't reached Penn
//            (banner: daytime service has started)
const ICON = {
  moon: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" fill="currentColor"/></svg>',
  sun: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.5" fill="currentColor"/><g stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/></g></svg>',
  cal: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3.5 10h17M8 3v4M16 3v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><rect x="7" y="13" width="4" height="4" rx=".5" fill="currentColor"/></svg>',
  star: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.6 6.6 19.5l1.2-6L3.3 9.3l6.1-.7z" fill="currentColor"/></svg>',
  snow: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><g stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2v20M3.3 7l17.4 10M3.3 17l17.4-10M9 3.5l3 2.5 3-2.5M9 20.5l3-2.5 3 2.5"/></g></svg>',
};
const subwayNoticeText = () => ((board && board.notices && board.notices.subway) || []).map((n) => `${n.type} ${n.text}`).join('\n');
const holidayNotice = () => /holiday/i.test(subwayNoticeText());
const weatherNotice = () => /severe weather|winter weather|snow|storm|hurricane|flood/i.test(subwayNoticeText());
// On a holiday the MTA says which schedule runs; use that day's switch times.
function scheduleToday(day) {
  if (!holidayNotice()) return day;
  const t = subwayNoticeText();
  return /sunday schedule/i.test(t) ? 'sunday' : /saturday schedule/i.test(t) ? 'saturday' : day;
}
const fmtClock = (t) => {
  const m = ((t % 1440) + 1440) % 1440, h = Math.floor(m / 60);
  return `${h % 12 || 12}:${String(m % 60).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};
const morningReached = new Set(); // date|station|line|dir once the first daytime express shows "now"

function switchState(stationId, line, dir) {
  const sw = subwayData && subwayData.switches && ((subwayData.switches[stationId] || {})[line] || {})[dir];
  if (!sw) return null;
  const today = nyNow(), yest = nyNow(-1), tom = nyNow(1);
  const T = sw[scheduleToday(today.day)], Y = sw[yest.day], N = sw[tom.day];
  if (!T) return null;
  const m = today.mins;
  const key = `${today.date}|${stationId}|${line}|${dir}`;
  let phase, lastExpress, until;
  if (m >= 12 * 60) {
    phase = m < T.nightStart ? 'day' : m < T.lastExpress ? 'started' : 'night';
    lastExpress = T.lastExpress;
    until = N ? N.firstExpressPenn : T.firstExpressPenn;
  } else if (Y && m + 1440 < Y.lastExpress) {
    // Just after midnight, yesterday's express trains can still be due.
    phase = m + 1440 >= Y.nightStart ? 'started' : 'day';
    lastExpress = Y.lastExpress;
    until = T.firstExpressPenn;
  } else {
    until = T.firstExpressPenn;
    if (m < T.firstExpressStart) phase = 'night';
    else if (!morningReached.has(key) && m < T.firstExpressPenn + 30) phase = 'morning';
    else phase = 'day';
  }
  return { phase, lastExpress, until, key };
}

const LATE_PILL = `<span class="late-pill">${ICON.moon}Late night</span>`;

// PATH's late-night service: the hours when weekday trains from 33 St run to
// Journal Square via Hoboken (about 11 PM to 6 AM). PATH trains leaving in
// those hours get the pill on any day; weekend daytime via-Hoboken trains are
// the weekend pattern, not late night.
// PATH's day and late-night patterns from 33 St, per day, from PATH's
// timetable: direct Journal Square trains by day, Journal Square via Hoboken
// late at night (weekdays about 10:40 PM to 6 AM; weekends 9 PM to 10 AM).
function pathDay(day) {
  const list = pathSchedule && pathSchedule.days && pathSchedule.days[day];
  if (!list) return null;
  const direct = list.filter((d) => d.to === 'Journal Square').map((d) => d.t);
  const via = list.filter((d) => /via/i.test(d.to)).map((d) => d.t);
  if (!direct.length || !via.length) return null;
  const lastDirect = Math.max(...direct);
  const viaAfter = via.filter((t) => t > lastDirect);
  return {
    firstDirect: Math.min(...direct),
    lastDirect,
    nightStart: viaAfter.length ? Math.min(...viaAfter) : null, // first via-Hoboken train of the night
  };
}
// Where PATH stands now: 'countdown' (last direct train within the hour),
// 'night' (no direct Journal Square trains until morning) or 'day'.
function pathState() {
  const now = nyNow(), T = pathDay(now.day);
  if (!T) return null;
  const m = now.mins;
  if (m < T.firstDirect) return { phase: 'night', until: T.firstDirect };
  if (m > T.lastDirect) {
    const N = pathDay(nyNow(1).day);
    return { phase: 'night', until: N ? N.firstDirect : T.firstDirect };
  }
  if (m >= T.lastDirect - 60) return { phase: 'countdown', lastDirect: T.lastDirect, nightStart: T.nightStart, left: T.lastDirect - m };
  return { phase: 'day' };
}
// A PATH train leaving at this time (minutes after midnight, today) runs in
// the late-night pattern: after the last direct Journal Square train, or
// before the first one.
function pathLateNight(minsAfterMidnight) {
  const T = pathDay(nyNow().day);
  if (!T) return false;
  const m = ((minsAfterMidnight % 1440) + 1440) % 1440;
  return m > T.lastDirect || m < T.firstDirect;
}
// Tags beside the PATH heading, and what goes above the train rows.
function renderPathPattern() {
  const st = pathState();
  const tags = [];
  const day = nyNow().day;
  if (day === 'saturday' || day === 'sunday') tags.push(`<span class="tag wknd">${ICON.cal}Weekend service</span>`);
  if (st && st.phase === 'night') tags.push(`<span class="tag night">${ICON.moon}Late-night service</span>`);
  $('path-h').innerHTML = `PATH${tags.join('')}<span>33 St station, Sixth Av at 32 St</span>`;
  if (!st) return '';
  if (st.phase === 'countdown') {
    const starts = st.nightStart != null ? `Late-night service starts at ${fmtClock(st.nightStart)}. ` : '';
    return `<p class="svc-line night">${ICON.moon}<span>${starts}<b>The last direct Journal Square train leaves in ${st.left} min</b>, at ${fmtClock(st.lastDirect)}.</span></p>`;
  }
  if (st.phase === 'night') {
    const dots = '<span class="pdots" aria-hidden="true" style="opacity:.35"><i style="background:#ff9900"></i></span>';
    return `<div class="none-row">${dots}<span>No direct Journal Square trains late nights. Trains run to Journal Square via Hoboken until ${fmtClock(st.until)}.</span></div>`;
  }
  return '';
}

let subwayShown = [];      // the groups drawn, so a tap can find its train
const DIRS = { '128': { N: 'Uptown and the Bronx', S: 'Downtown and Brooklyn' }, A28: { N: 'Uptown and Queens', S: 'Downtown and Brooklyn' } };
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
  // Two separate stations: the 7 Av line (1 2 3) and the 8 Av line (A C E).
  // A train belongs to the station it calls at, so a rerouted train lands
  // in the right box.
  const STATIONS = [{ id: '128', lines: ['1', '2', '3'] }, { id: 'A28', lines: ['A', 'C', 'E'] }];
  const states = [];
  const morningNow = nyNow().mins < 12 * 60;
  $('subway').innerHTML = STATIONS.map((stn) => {
  const here = board.subway.filter((g) => (g.trains[0] && g.trains[0].stops ? g.trains[0].stops[0] : '') === stn.id);
  const dirs = ['N', 'S'].map((dir) => {
    // Lines at this station that switch between express and local, and where
    // each stands right now.
    const switching = stn.lines.map((line) => ({ line, st: switchState(stn.id, line, dir) })).filter((x) => x.st);
    for (const x of switching) {
      // The first daytime express showing "now" at Penn ends the morning.
      if (x.st.phase === 'morning' && here.some((g) => g.route === x.line && g.dir === dir && g.svc === 'express' && g.trains.some((t) => t.time - nowS < 30))) {
        morningReached.add(x.st.key);
        x.st = switchState(stn.id, x.line, dir);
      }
      states.push(x.st);
    }
    const lateNight = (route) => switching.some((x) => x.line === route) && (switching.find((x) => x.line === route).st.phase !== 'day' || morningNow);
    // This platform direction is on its late-night schedule: no more express
    // trains until morning. Every train here then gets the pill, locals too,
    // because late-night service runs less often.
    const dirNight = switching.some((x) => x.st.phase === 'night' || x.st.phase === 'morning');
    const parts = ['express', 'local'].map((svc) => {
    let notes = '';
    if (svc === 'express') {
      notes = switching.map(({ line, st }) => {
        const label = esc(lineInfo(line).label);
        if (st.phase === 'started') return `<p class="svc-line night">${ICON.moon}<span><b>Late-night service has started on the ${label}.</b> The last express train leaves at ${fmtClock(st.lastExpress)}.</span></p>`;
        if (st.phase === 'morning') return `<p class="svc-line">${ICON.sun}<span><b>Daytime service has started on the ${label}.</b></span></p>`;
        const expressDue = here.some((g) => g.route === line && g.dir === dir && g.svc === 'express' && g.trains.some((t) => t.time >= nowS - 30));
        if (st.phase === 'night' && !expressDue) return `<div class="none-row">${bulletHtml(line)}<span>No express trains late nights. ${label} trains run local until ${fmtClock(st.until)}.</span></div>`;
        return '';
      }).join('');
    }
    const lines = here.filter((g) => g.dir === dir && (g.svc || 'local') === svc).map((g) => {
      const pill = (svc === 'local' && lateNight(g.route)) || dirNight ? LATE_PILL : '';
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
        return `<div class="sline">${bulletHtml(g.route)}<span class="sdest">${esc(dest)}${pill}</span><span class="smins">${firstMin}${rest}</span></div>`;
      }
      const i = subwayShown.push({ route: g.route, dir, svc: g.svc, train: rerouted }) - 1;
      return `<button type="button" class="sline rerouted" data-reroute="${i}" aria-haspopup="dialog">${bulletHtml(g.route)}<span class="sdest">${esc(dest)}${pill}<span class="reroute-tag">Rerouted, see map</span></span><span class="smins">${firstMin}${rest}</span></button>`;
    }).join('');
      return lines || notes ? `<div class="svc"><h4>${SVC[svc]}</h4>${notes}${lines}</div>` : '';
    }).join('');
    return parts ? `<div class="dir"><h3>${DIRS[stn.id][dir]}</h3>${parts}</div>` : '';
  }).join('');
  const label = stn.lines.map((l) => bulletHtml(l, 'small')).join('');
  return `<section class="stn" aria-label="${stn.lines.join(', ')} trains"><div class="stn-lines">${label}</div>${dirs || '<p class="empty">No trains reported right now.</p>'}</section>`;
  }).join('');
  renderSubwayTags(states);
}

// Tags beside the Subway heading. Late-night service shows once no more
// daytime express trains are due on any switching line, and goes in the
// morning when the first daytime express shows "now" at Penn.
function renderSubwayTags(states) {
  const tags = [];
  if (states.length && states.every((st) => st.phase === 'night' || st.phase === 'morning')) tags.push(`<span class="tag night">${ICON.moon}Late-night service</span>`);
  const day = nyNow().day;
  if (holidayNotice()) tags.push(`<span class="tag hol">${ICON.star}Holiday service</span>`);
  else if (day === 'saturday' || day === 'sunday') tags.push(`<span class="tag wknd">${ICON.cal}Weekend service</span>`);
  if (weatherNotice()) tags.push(`<span class="tag wx">${ICON.snow}Severe weather service</span>`);
  $('sub-h').innerHTML = `Subway${tags.join('')}<span>34 St–Penn Station</span>`;
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
  loadPathSchedule(); // its switch times drive the tags and banner
  $('path').innerHTML = renderPathPattern() + [...byDest].map(([dest, g]) => {
    const mins = g.mins.slice(0, 3);
    const firstMin = mins[0] === 0 ? '<b class="now">now</b>' : `<b>${mins[0]}</b> min`;
    const rest = mins.length > 1 ? `, ${mins.slice(1).join(', ')}` : '';
    const dots = (g.colors.length ? g.colors : ['']).map((c) => `<i${c ? ` style="background:#${c}"` : ''}></i>`).join('');
    const pill = pathLateNight(nyNow().mins + (mins[0] || 0)) ? LATE_PILL : '';
    return `<div class="sline"><span class="pdots" aria-hidden="true">${dots}</span><span class="sdest">${esc(dest)}${pill}</span><span class="smins">${firstMin}${rest}</span></div>`;
  }).join('') + '<p class="sched-note live-note">Live times from PATH.</p>';
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
  ].filter((d) => d.t < today.mins + 120);
  const byDest = new Map();
  for (const d of list) {
    if (!byDest.has(d.to)) byDest.set(d.to, { colors: PATH_COLORS[d.to] || [d.color], times: [], later: [] });
    byDest.get(d.to)[d.t < today.mins + 60 ? 'times' : 'later'].push(d.t);
  }
  for (const [dest, g] of byDest) if (!g.times.length) byDest.delete(dest);
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
  // Shown under the times: short, but says they aren't live.
  const note = `<p class="sched-note">Scheduled times, not live.${outdated
    ? ' PATH’s timetable ran to ' + new Date(pathSchedule.validUntil + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) + ', so times may have changed.'
    : ''}</p>`;
  const lines = [...byDest].map(([dest, g]) => {
    const [first, ...rest] = g.times.slice(0, 3).map(fmtMins);
    const dots = g.colors.map((c) => `<i style="background:${esc(c)}"></i>`).join('');
    const pill = pathLateNight(g.times[0]) ? LATE_PILL : '';
    // How often trains run: the typical gap between the next few trains.
    const ts = [...g.times, ...g.later].slice(0, 5);
    const gaps = ts.slice(1).map((t, i) => t - ts[i]).sort((a, b) => a - b);
    const every = gaps.length ? `<span class="every-sub">About every ${gaps[Math.floor(gaps.length / 2)]} min</span>` : '';
    return `<div class="sline"><span class="pdots" aria-hidden="true">${dots}</span><span class="sdest">${esc(dest)}${pill}${every}</span><span class="smins"><b>${first}</b>${rest.length ? ', ' + rest.join(', ') : ''}</span></div>`;
  }).join('');
  $('path').innerHTML = renderPathPattern() + (lines || '<p class="empty">No PATH trains are scheduled from 33 St in the next hour.</p>') + note;
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
// The MTA writes symbols into notice text: "[1]" is a line, "[SIR]" the
// Staten Island Railway, "[airplane icon]" and the like are pictograms.
// Known pictograms are drawn; unknown ones are dropped rather than shown as words.
const NOTICE_ICONS = {
  airplane: ['Airport', '<path d="M21 15.5v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V8.5l-8 5v2l8-2.5V18l-2 1.5V21l3.5-1 3.5 1v-1.5L13 18v-5z" fill="currentColor"/>'],
  accessibility: ['Accessible', '<circle cx="12" cy="4" r="2" fill="currentColor"/><path d="M19 13v-2c-1.5 0-3-.6-4-1.6l-1.3-1.4c-.4-.4-1-.7-1.6-.7-1.1 0-2 .9-2 2v5.7c0 1.1.9 2 2 2h5v5h2v-5.5c0-1.1-.9-2-2-2h-3v-3.5c1.3 1.1 3 1.9 4.9 2zM12.1 19a3 3 0 0 1-5.8-1 3 3 0 0 1 2.3-2.9v-2.1A5 5 0 1 0 14.1 19z" fill="currentColor"/>'],
  'shuttle bus': ['Shuttle bus', '<path d="M4 16c0 .9.4 1.7 1 2.2V20a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-1h8v1a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-1.8c.6-.5 1-1.3 1-2.2V6c0-3.5-3.6-4-8-4S4 2.5 4 6zm3.5 1a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm9 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zM18 11H6V6h12z" fill="currentColor"/>'],
};
NOTICE_ICONS.bus = NOTICE_ICONS['shuttle bus'];
const noticeIcon = ([label, path]) => `<svg class="ic notice-ic" viewBox="0 0 24 24" role="img" aria-label="${label}">${path}</svg>`;
const noticeText = (t) => esc(t)
  .replace(/\[([a-z ]+?) icon\]/gi, (m, name) => (NOTICE_ICONS[name.toLowerCase()] ? noticeIcon(NOTICE_ICONS[name.toLowerCase()]) : ''))
  .replace(/\[SIR\]/g, () => (subwayData && subwayData.routes.SI ? bulletHtml('SI', 'tiny') : 'SIR'))
  .replace(/\[([A-Z0-9]{1,2})\]/g, (m, l) => (subwayData && subwayData.routes[l] ? bulletHtml(l, 'tiny') : m))
  .replace(/ {2,}/g, ' ').trim();
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
  // Not connected yet: a one-line note at the bottom of the page, not a banner.
  $('njt-note').textContent = s.njt.needsServer || s.njt.needsLogin ? 'NJ Transit data not yet available.' : '';
  if (s.njt.error) out.push(`NJ Transit data didn’t load (${esc(s.njt.error)}). The NJ Transit trains shown may not be real time.`);
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
  // No server: read PATH's live times through the relay, if one is set up.
  const path = window.PENN_RELAY ? await PennFeeds.relayPath(force) : null;
  return PennFeeds.board({ force, path: path || undefined });
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
