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
  return leaves + (r.departGrace || 0) <= nowS ? leaves : null;
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
  // Past its time but still in LIRR's feed (it hasn't left): final call for
  // 2 more minutes, then plain boarding until it goes.
  return left > (r.departGrace ? -120 : 0) && left <= (isDelayed(r) ? 120 : 60);
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

// Lines with no trains from Penn late at night (the C; the 3 downtown, which
// ends at Penn), from the timetable: subway-data.json "nightGaps" holds the
// last train before the break, the first after it, and when that first
// morning train sets off. Phases: 'night' (no trains), then 'morning' from
// when the first train sets off until one shows "now" at Penn ("Daytime
// service has started on the C").
function nightGapState(stationId, line, dir) {
  const g = subwayData && subwayData.nightGaps && ((subwayData.nightGaps[stationId] || {})[line] || {})[dir];
  if (!g) return null;
  const today = nyNow(), tom = nyNow(1);
  const T = g[scheduleToday(today.day)], N = g[tom.day] || T;
  if (!T) return null;
  const m = today.mins;
  const key = `${today.date}|${stationId}|${line}|${dir}|gap`;
  if (m >= 12 * 60 && m > T.after) return { ...T, until: N.until, phase: 'night', key };
  if (m < 12 * 60 && m < (T.firstStart ?? T.until)) return { ...T, phase: 'night', key };
  if (m < 12 * 60 && !morningReached.has(key) && m < T.until + 30) return { ...T, phase: 'morning', key };
  return null;
}
// A train at Penn at this time (epoch seconds) is a late-night train: before
// the first daytime express reaches Penn in the morning, or after the last
// express leaves at night, by the timetable of the station's switching line
// (the 2 for the 1 2 3, the A for the A C E). Every line there gets the pill,
// and it stays on each train until it leaves.
const SWITCH_LINE = { '128': '2', A28: 'A' };
function lateNightTrain(stationId, dir, epoch) {
  const sw = subwayData && subwayData.switches && ((subwayData.switches[stationId] || {})[SWITCH_LINE[stationId]] || {})[dir];
  if (!sw) return false;
  const p = {};
  nyParts.formatToParts(new Date(epoch * 1000)).forEach((x) => { p[x.type] = x.value; });
  const day = p.weekday === 'Sat' ? 'saturday' : p.weekday === 'Sun' ? 'sunday' : 'weekday';
  const m = +p.hour * 60 + +p.minute;
  const T = sw[day === nyNow().day ? scheduleToday(day) : day];
  if (!T) return false;
  return m < 12 * 60 ? m < T.firstExpressPenn : m >= T.lastExpress;
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
    const parts = ['express', 'local'].map((svc) => {
    let notes = '';
    // A line that isn't running late at night says which train to take.
    const gaps = stn.lines.map((line) => {
      let g = nightGapState(stn.id, line, dir);
      // The first morning train showing "now" at Penn ends "Daytime service has started".
      if (g && g.phase === 'morning' && here.some((x) => x.route === line && x.dir === dir && x.trains.some((t) => t.time - nowS < 30))) {
        morningReached.add(g.key);
        g = nightGapState(stn.id, line, dir);
      }
      if (g && g.phase === 'morning' && g.svc === svc) return `<p class="svc-line">${ICON.sun}<span><b>Daytime service has started on the ${esc(lineInfo(line).label)}.</b></span></p>`;
      if (!g || g.svc !== svc || here.some((x) => x.route === line && x.dir === dir && x.trains.some((t) => t.time >= nowS - 30))) return '';
      // The other lines at this station still running this way (C: A or E; 3: 1 or 2).
      const alts = stn.lines.filter((l) => l !== line && !nightGapState(stn.id, l, dir)).map((l) => esc(lineInfo(l).label));
      const altText = alts.length ? `the ${alts.slice(0, -1).join(', ')}${alts.length > 1 ? ' or ' : ''}${alts[alts.length - 1]}` : '';
      const way = dir === 'N' ? 'uptown' : 'downtown';
      const label = esc(lineInfo(line).label);
      // Short: "No C trains until 5:41 AM. For downtown service, use the A or E."
      // When only one direction stops (the 3 ends at Penn), say which.
      const oneWay = !nightGapState(stn.id, line, dir === 'N' ? 'S' : 'N');
      const say = oneWay
        ? `No ${label} trains ${way} until ${fmtClock(g.until)}.${altText ? ` Use ${altText}.` : ''}`
        : `No ${label} trains until ${fmtClock(g.until)}.${altText ? ` For ${way} service, use ${altText}.` : ''}`;
      return `<div class="none-row">${bulletHtml(line)}<span>${say}</span></div>`;
    }).join('');
    if (svc === 'express') {
      // Other lines still running express in this direction (the 3 uptown, late at night).
      const otherExpress = (line) => here.some((g) => g.route !== line && g.dir === dir && g.svc === 'express' && g.trains.some((t) => t.time >= nowS - 30));
      notes = switching.map(({ line, st }) => {
        const label = esc(lineInfo(line).label);
        if (st.phase === 'started') return `<p class="svc-line night">${ICON.moon}<span><b>Late-night service has started on the ${label}.</b> The last express train leaves at ${fmtClock(st.lastExpress)}.</span></p>`;
        if (st.phase === 'morning') return `<p class="svc-line">${ICON.sun}<span><b>Daytime service has started on the ${label}.</b></span></p>`;
        const expressDue = here.some((g) => g.route === line && g.dir === dir && g.svc === 'express' && g.trains.some((t) => t.time >= nowS - 30));
        if (st.phase === 'night' && !expressDue) {
          const say = otherExpress(line) ? `${label} trains run local late nights, until ${fmtClock(st.until)}.` : `No express trains late nights. ${label} trains run local until ${fmtClock(st.until)}.`;
          return `<div class="none-row">${bulletHtml(line)}<span>${say}</span></div>`;
        }
        return '';
      }).join('');
    }
    notes += gaps;
    const lines = here.filter((g) => g.dir === dir && (g.svc || 'local') === svc).map((g) => {
      const trains = g.trains.filter((x) => x.time >= nowS - 30).slice(0, 3);
      if (!trains.length) return '';
      // Late-night pill by the next train's own time (stays until it leaves);
      // in the evening, the switching line's locals get it as soon as
      // late-night service has started.
      const pill = lateNightTrain(stn.id, dir, trains[0].time) || (svc === 'local' && lateNight(g.route) && !morningNow) ? LATE_PILL : '';
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
  // The line it's borrowing: the one that normally stops at most of the
  // unusual stations (the E to Inwood runs via the A), and where it joins and leaves it.
  const odd = stops.filter((id) => unusual.has(id));
  const via = Object.keys(subwayData.routes).filter((r) => r !== route)
    .map((r) => ({ r, n: odd.filter((id) => subwayData.routes[r].normalSet.has(id)).length }))
    .sort((a, b) => b.n - a.n)[0];
  const viaText = via && via.n >= Math.ceil(odd.length / 2)
    ? `running via the ${lineInfo(via.r).label} line from ${stationName(odd[0])} to ${stationName(odd[odd.length - 1])}`
    : 'running on a different route from normal';
  $('reroute-note').textContent = `This ${l.label} train is ${viaText}, ${svc === 'express' ? 'express' : 'local'} from Penn. ` +
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
  if (!b || !subwayShown[b.dataset.reroute]) return;
  const x = subwayShown[b.dataset.reroute], m = changeFor(x.route);
  if (m) openChange(m.n.id); else openReroute(x);
});
$('reroute-close').addEventListener('click', () => $('reroute').close());
$('reroute').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });

// ---------- service-change map ----------
// For an MTA notice that closes or reroutes part of a line, a map in two views:
//   1. the whole line: where it runs (its colour), where it doesn't (grey,
//      dashed), and where it ends and starts again;
//   2. how to get around it, when the MTA's notice says: the lines it suggests
//      (drawn only near the closed part), its shuttle buses, its transfer
//      stations (tap one to zoom in), and the MTA's own wording underneath.
// Nothing is invented: the closed part comes from the stations the notice
// names, the alternatives from its text. What the board can't read from a
// notice simply isn't drawn; the MTA's text is always shown.
const CHANGE_TYPES = /suspend|reroute/i;
const PENN_LL = [40.7506, -73.9935];
const LIVE_DIRECTIONS = {
  google: 'https://www.google.com/maps/dir/?api=1&origin=34+St-Penn+Station,+New+York,+NY&travelmode=transit',
  apple: 'https://maps.apple.com/?saddr=Penn+Station,+New+York,+NY&dirflg=r',
};
const directionsTo = ([lat, lon], name) => ({
  // No starting point: the maps app starts from where the person is.
  google: `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}&travelmode=transit`,
  apple: `https://maps.apple.com/?daddr=${lat},${lon}&q=${encodeURIComponent(name)}&dirflg=r`,
});

let subwayShapes = null, subwayShapesLoading = null;
function loadSubwayShapes() {
  if (subwayShapes) return Promise.resolve(subwayShapes);
  if (!subwayShapesLoading) {
    subwayShapesLoading = fetch(`subway-shapes.json?v=${encodeURIComponent((subwayData && subwayData.version) || '')}`)
      .then((r) => { if (!r.ok) throw new Error('track shapes did not load'); return r.json(); })
      .then((d) => (subwayShapes = d.lines))
      .catch((e) => { subwayShapesLoading = null; throw e; });
  }
  return subwayShapesLoading;
}

// Which lines call at each station (by the timetable).
let stationLinesCache = null;
function stationLines(id) {
  if (!stationLinesCache) {
    stationLinesCache = new Map();
    for (const [r, info] of Object.entries(subwayData.routes)) for (const s of info.normal) {
      if (!stationLinesCache.has(s)) stationLinesCache.set(s, new Set());
      stationLinesCache.get(s).add(r);
    }
  }
  return stationLinesCache.get(id) || new Set();
}
const LL = (id) => [subwayData.stops[id][1], subwayData.stops[id][2]];
const bulletsIn = (t) => [...String(t).matchAll(/\[([A-Z0-9]{1,2})\]/g)].map((m) => m[1]).filter((l) => subwayData.routes[l]);

// A station name as the MTA writes it in a notice -> a station id. Names are
// compared loosely ("Hoyt-Schermerhorn Sts" = "Hoyt–Schermerhorn Sts"); when
// several stations share a name (14 St), the one served by the lines the
// notice mentions wins.
const normName = (s) => String(s).toLowerCase().replace(/[‐-―-]/g, ' ').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
function findStation(name, prefer = []) {
  const q = normName(name);
  if (!q) return null;
  const all = Object.entries(subwayData.stops);
  let hits = all.filter(([, s]) => normName(s[0]) === q);
  if (!hits.length) hits = all.filter(([, s]) => { const n = normName(s[0]); return n.startsWith(q + ' ') || q.startsWith(n + ' '); });
  if (!hits.length) return null;
  const score = ([id]) => prefer.filter((l) => stationLines(id).has(l)).length;
  hits.sort((a, b) => score(b) - score(a));
  return hits[0][0];
}
// "42 St-Port Authority/Times Sq-42 St" names a station complex: one id per part.
const findStations = (name, prefer) => [...new Set(String(name).split('/').map((p) => findStation(p, prefer)).filter(Boolean))];

// The MTA's alternatives, read from the notice's text.
function readAlternatives(desc, route) {
  const text = String(desc || '').split(/what'?s happening\?/i)[0].trim();
  const lines = text.split('\n').map((x) => x.trim());
  const transfers = [], buses = [];
  let busList = false, transferList = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) { busList = false; transferList = false; continue; }
    if (/^transfer stations:?$|via transfer at:$/i.test(line)) { transferList = true; continue; }
    // Transfer stations: "Name [accessibility icon] (A) | [A][N][Q]", or the
    // name on one line and its lines alone on the next.
    let m = line.match(/^(?:transfer (?:at|between .+? at)\s+)?([^[|]+?)\s*(?:\[accessibility icon\])?\s*(?:\([^)]*\))?\s*\|\s*(.+)$/i);
    if (!m && !line.includes('[') && /^(\[[A-Z0-9]{1,2}\])+$/.test(lines[i + 1] || '')) m = [line, line, lines[++i]];
    // In a "Transfer stations:" list, also "Name [A][N][Q]" on one line.
    if (!m && transferList) m = line.match(/^([^[|]+?)\s*(?:\[accessibility icon\])?\s*((?:\[[A-Z0-9]{1,2}\])+)$/);
    if (m) {
      const ls = bulletsIn(m[2]);
      const ids = findStations(m[1], ls);
      if (ids.length) transfers.push({ name: m[1].trim(), lines: ls, ids, bus: /shuttle bus/i.test(m[2]) });
      continue;
    }
    // Shuttle buses: a list under "Free shuttle buses run on two routes:", or
    // one line saying where they run.
    if (/shuttle bus/i.test(line) && /:$/.test(line)) { busList = true; continue; }
    // (Not "For stations between X and Y, take a bus": that's advice, not a route.)
    if (busList || (/shuttle bus/i.test(line) && /\b(run|runs|make|makes|operate|operates)\b/i.test(line))) {
      const b = line.match(/between (.+?) and (.+?)(?:,\s*stopping at (.+?))?\.?$/i);
      if (b) {
        const via = b[3] ? b[3].split(/,\s*(?:and\s+)?|\s+and\s+/) : null;
        const names = [b[1], ...(via || []), b[2].replace(/,.*$/, '')];
        const ids = names.map((n) => findStation(n, [route])).filter(Boolean);
        const same = (x) => x.ids[0] === ids[0] && x.ids[x.ids.length - 1] === ids[ids.length - 1];
        if (ids.length > 1 && !buses.some(same)) buses.push({ ids, along: !via });
      }
    }
  }
  // Lines the MTA suggests: named where it says take/consider/use, or at a
  // transfer station (not lines merely mentioned in a note).
  const advice = lines.filter((x) => /\b(take|consider|use|transfer)\b/i.test(x) && !/^notes?:/i.test(x)).join(' ');
  const detours = [...new Set(bulletsIn(advice))].filter((l) => l !== route);
  for (const t of transfers) for (const l of t.lines) if (l !== route && !detours.includes(l)) detours.push(l);
  return { text, transfers, buses, detours };
}

// The notice as a map: its main line, the stations closed on it, and the
// alternatives. Null for notices that don't close or reroute part of a line.
function changeModel(n) {
  if (!n || n.carrier !== 'subway' || !subwayData || !CHANGE_TYPES.test(n.type)) return null;
  const named = Object.keys(n.affected || {}).filter((r) => subwayData.routes[r]);
  if (!named.length) return null;
  const route = bulletsIn(n.text).find((r) => named.includes(r)) || named[0];
  const closed = new Set(n.affected[route].filter((id) => subwayData.stops[id]));
  if (!closed.size) return null;
  return { n, route, closed, alt: readAlternatives(n.desc, route) };
}
const changeModels = () => ((board && board.notices && board.notices.subway) || []).map(changeModel).filter(Boolean);

// Geometry: where a station falls along a track path (the nearest point on
// any segment; straight stretches have few points), and the part of a path
// between two stations.
function along(path, p) {
  let best = { s: 0, d: Infinity };
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i], b = path[i + 1], dx = b[0] - a[0], dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
    const d = Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]);
    if (d < best.d) best = { s: i + t, d };
  }
  return best;
}
function between(path, sa, sb, a, b) {
  if (sa > sb) return between(path, sb, sa, b, a).reverse();
  return [a, ...path.slice(Math.floor(sa) + 1, Math.floor(sb) + 1), b];
}
// A line's track cut into station-to-station pieces, each closed or open.
function lineSegments(route, closed) {
  const ids = [...new Set([...subwayData.routes[route].normal, ...closed])].filter((id) => subwayData.stops[id]);
  const segs = [], ends = new Set();
  for (const path of subwayShapes[route] || []) {
    const on = ids.map((id) => ({ id, ...along(path, LL(id)) })).filter((x) => x.d < 0.0015).sort((a, b) => a.s - b.s);
    if (on.length) { ends.add(on[0].id); ends.add(on[on.length - 1].id); }
    for (let i = 0; i < on.length - 1; i++) {
      const a = on[i], b = on[i + 1];
      segs.push({ a: a.id, b: b.id, pts: between(path, a.s, b.s, LL(a.id), LL(b.id)), closed: closed.has(a.id) && closed.has(b.id) });
    }
  }
  return { segs, ends };
}
// Where live trains on this line are running off their usual tracks right now
// (from the train feed): straight lines between the stations they call at.
function liveDetours(route) {
  const out = [], lastStops = new Set();
  for (const g of (board && board.subway) || []) {
    if (g.route !== route) continue;
    for (const t of g.trains) {
      const odd = new Set(unusualStops(route, t));
      if (!odd.size) continue;
      const st = t.stops.filter((id) => subwayData.stops[id]);
      for (let i = 0; i < st.length - 1; i++) if (odd.has(st[i]) || odd.has(st[i + 1])) out.push([LL(st[i]), LL(st[i + 1])]);
      lastStops.add(st[st.length - 1]);
    }
  }
  return { paths: out, lastStops };
}

// Labels placed so they don't cover each other: each tries the right, left,
// below and above its station, and is left off (if not essential) when all
// four are taken. Placed again after every zoom.
function placeLabels(map, layer, labels) {
  layer.clearLayers();
  const taken = [];
  const free = (r) => !taken.some((t) => r.x < t.x + t.w && t.x < r.x + r.w && r.y < t.y + t.h && t.y < r.y + r.h);
  const size = map.getSize();
  for (const lb of labels) {
    const p = map.latLngToContainerPoint(lb.at);
    const w = lb.w, h = lb.h || 26;
    const sides = [[10, -h / 2], [-w - 10, -h / 2], [-w / 2, 12], [-w / 2, -h - 12]];
    let spot = null;
    for (const [dx, dy] of sides) {
      const r = { x: p.x + dx, y: p.y + dy, w, h };
      if (r.x < 4 || r.x + w > size.x - 4 || r.y < 4 || r.y + h > size.y - 4) continue;
      if (free(r)) { spot = [dx, dy, r]; break; }
    }
    if (!spot && !lb.must) continue;
    if (!spot) { const dx = p.x + 10 + w > size.x ? -w - 10 : 10; spot = [dx, -h / 2, { x: p.x + dx, y: p.y - h / 2, w, h }]; }
    taken.push(spot[2]);
    L.marker(lb.at, { interactive: false, zIndexOffset: 1000, icon: L.divIcon({ className: '', iconSize: [0, 0], html: `<div class="cm-label ${lb.cls || ''}" style="transform:translate(${spot[0]}px,${spot[1]}px)">${lb.html}</div>` }) }).addTo(layer);
  }
}
const textWidth = (s, bullets = 0) => Math.round(String(s).length * 7.4 + bullets * 21 + 18);

let changeMap = null, changeOpen = null;
function closeChange() { if ($('change').open) $('change').close(); }
// On phones the map fills the screen: the phone's Back button or gesture
// closes it (rather than leaving the board), as people expect.
window.addEventListener('popstate', () => { if ($('change').open) $('change').close(); });
$('change').addEventListener('close', () => {
  changeOpen = null;
  if (history.state && history.state.changeMap) history.back();
});

async function openChange(id, view = 1) {
  const model = changeModels().find((m) => m.n.id === id);
  if (!model) return;
  changeOpen = { id, view };
  const { n, route, alt } = model;
  const label = esc(lineInfo(route).label);
  $('chg-kind').textContent = friendlyType(n.type);
  const hasAlt = alt.text.length > 0;
  const canMapAlt = alt.transfers.length || alt.buses.length;
  if (view === 1) {
    $('chg-h').innerHTML = noticeText(n.text);
    $('chg-top').innerHTML = `<ul class="cm-key">
        <li><span class="sw" style="border-color:${esc(lineInfo(route).color)}"></span>${label} trains running</li>
        <li><span class="sw off"></span>No ${label} trains</li>
        ${alt.buses.length ? '<li><span class="sw bus"></span>Free shuttle bus</li>' : ''}
      </ul>
      ${hasAlt ? '<button type="button" class="cm-go" data-view="2">How to get around this <span aria-hidden="true">→</span></button>' : liveDirectionsHtml()}`;
    $('chg-below').innerHTML = '';
  } else {
    $('chg-h').innerHTML = `Getting around it`;
    $('chg-top').innerHTML = `<button type="button" class="cm-back" data-view="1">← Whole ${label} line</button>
      <p class="cm-sum">${noticeText(n.text)}</p>`;
    const chips = alt.transfers.map((t, i) => {
      const d = directionsTo(LL(t.ids[0]), t.name);
      return `<li class="cm-stn"><button type="button" class="cm-zoom" data-zoom="t${i}"><b>${noticeText(t.name)}</b><span class="ls">${t.lines.map((l) => bulletHtml(l, 'tiny')).join('')}</span></button>
        <span class="cm-dir">Directions: <a href="${esc(d.google)}" target="_blank" rel="noopener">Google Maps</a> · <a href="${esc(d.apple)}" target="_blank" rel="noopener">Apple Maps</a></span></li>`;
    }).join('');
    $('chg-below').innerHTML = `${chips ? `<h3 class="cm-h">${canMapAlt ? 'Tap a station to zoom in' : 'Stations to change at'}</h3><ul class="cm-stns">${chips}</ul>` : ''}
      <h3 class="cm-h">From the MTA</h3>
      <div class="cm-mta">${mtaTextHtml(alt.text)}</div>
      ${liveDirectionsHtml()}`;
  }
  const dialog = $('change');
  if (!dialog.open) { dialog.showModal(); history.pushState({ changeMap: true }, ''); }
  dialog.querySelector('.cm-body').scrollTop = 0;

  const box = $('chg-map');
  // View 2 without anything to draw: the MTA's text is the help.
  box.hidden = view === 2 && !canMapAlt;
  if (box.hidden) return;
  try {
    const [Lf] = await Promise.all([loadLeaflet(), loadSubwayShapes()]);
    if (!changeOpen || changeOpen.id !== id || changeOpen.view !== view) return; // another view opened meanwhile
    if (changeMap) changeMap.remove();
    changeMap = Lf.map(box, { zoomSnap: 0.25, scrollWheelZoom: false });
    Lf.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18, className: 'cm-tiles',
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors · Lines: MTA',
    }).addTo(changeMap);
    drawChange(changeMap, model, view);
  } catch (e) {
    console.warn('Service-change map:', e);
    box.hidden = true; // the text still helps
  }
}
const liveDirectionsHtml = () => `<p class="cm-live">Live directions from Penn: <a href="${LIVE_DIRECTIONS.google}" target="_blank" rel="noopener">Google Maps</a> · <a href="${LIVE_DIRECTIONS.apple}" target="_blank" rel="noopener">Apple Maps</a></p>`;
// The MTA's text, line by line, with its symbols drawn; "Transfer stations:"
// and the like become small headings.
// The MTA numbers its sections ("1. Between Inwood-207 St and Canal St"),
// which reads like the 1 train beside the line badges: numbered lines become
// a plain bulleted list instead.
function mtaTextHtml(t) {
  let html = '', list = false;
  for (const x of t.split('\n').map((y) => y.trim()).filter(Boolean)) {
    const item = x.match(/^\d+[.)]\s+(.*)$/);
    if (item && !list) { html += '<ul class="cm-list">'; list = true; }
    if (!item && list) { html += '</ul>'; list = false; }
    if (item) html += `<li>${noticeText(item[1])}</li>`;
    else html += /:$/.test(x) && x.length < 60 ? `<h4>${noticeText(x)}</h4>` : `<p>${noticeText(x)}</p>`;
  }
  return html + (list ? '</ul>' : '');
}

function drawChange(map, model, view) {
  const { route, closed, alt } = model;
  const info = lineInfo(route);
  const { segs, ends } = lineSegments(route, closed);
  const live = liveDetours(route);
  const casing = (pts, w) => L.polyline(pts, { color: '#fff', weight: w + 4, interactive: false }).addTo(map);
  const bullets = (ls) => ls.map((l) => bulletHtml(l, 'tiny')).join('');

  // Area for view 2: around the closed part, the transfer stations and buses.
  let area = null;
  if (view === 2) {
    const pts = [...closed, ...alt.transfers.flatMap((t) => t.ids), ...alt.buses.flatMap((b) => b.ids)].map(LL);
    area = L.latLngBounds(pts).pad(0.25);
    if (subwayData.routes[route].normal.some((id) => id === '128' || id === 'A28') && area.pad(0.4).contains(PENN_LL)) area.extend(PENN_LL);
    // The suggested lines, only within that area, thinner and lighter.
    for (const l of alt.detours) {
      for (const path of subwayShapes[l] || []) {
        let cur = [];
        const flush = () => { if (cur.length > 1) { casing(cur, 3); L.polyline(cur, { color: lineInfo(l).color, weight: 4, opacity: 0.8, interactive: false }).addTo(map); } cur = []; };
        for (const p of path) { if (area.contains(p)) cur.push(p); else flush(); }
        flush();
      }
    }
  }
  // The line itself: open parts in its colour, the closed part grey and dashed.
  // (White edges first, then the colours, so no edge covers a line.)
  for (const s of segs) casing(s.pts, 6);
  for (const p of live.paths) casing(p, 6);
  for (const s of segs.filter((x) => x.closed)) L.polyline(s.pts, { color: '#8f8f8f', weight: 5, dashArray: '8 7', interactive: false }).addTo(map);
  for (const s of segs.filter((x) => !x.closed)) L.polyline(s.pts, { color: info.color, weight: 6, interactive: false }).addTo(map);
  for (const p of live.paths) L.polyline(p, { color: info.color, weight: 6, interactive: false }).addTo(map);
  // Shuttle buses, stop to stop (the MTA doesn't give the streets they use).
  for (const b of alt.buses) {
    let ids = b.ids;
    if (b.along) { // "make stops between X and Y": every station of the line between them
      const path = (subwayShapes[route] || []).find((p) => along(p, LL(ids[0])).d < 0.0015 && along(p, LL(ids[ids.length - 1])).d < 0.0015);
      if (path) {
        const [sa, sb] = [along(path, LL(ids[0])).s, along(path, LL(ids[ids.length - 1])).s];
        ids = [...new Set([...subwayData.routes[route].normal, ...closed])].filter((id) => subwayData.stops[id])
          .map((id) => ({ id, ...along(path, LL(id)) })).filter((x) => x.d < 0.0015 && x.s >= Math.min(sa, sb) - 0.01 && x.s <= Math.max(sa, sb) + 0.01)
          .sort((x, y) => (sa < sb ? x.s - y.s : y.s - x.s)).map((x) => x.id);
      }
    }
    const pts = ids.map(LL);
    L.polyline(pts, { color: '#fff', weight: 8, interactive: false }).addTo(map);
    L.polyline(pts, { color: '#222', weight: 4, dashArray: '2 7', lineCap: 'round', interactive: false }).addTo(map);
  }

  // Stations: dots on the line (grey where closed), and on suggested lines in view 2.
  // Station dots grow as you zoom in; zoomed right out they'd hide the line.
  const dots = [];
  const dotSize = (small) => { const z = map.getZoom(); return z < 11.5 ? (small ? 1.5 : 2.5) : z < 13 ? (small ? 2.5 : 3.5) : (small ? 3.5 : 4.5); };
  const dot = (id, off, small) => dots.push([small, L.circleMarker(LL(id), { radius: 3, weight: small ? 1.5 : 2, color: off ? '#8f8f8f' : '#1b1b1b', fillColor: '#fff', fillOpacity: 1, interactive: false }).addTo(map)]);
  const lineIds = subwayData.routes[route].normal.filter((id) => subwayData.stops[id]);
  for (const id of new Set([...lineIds, ...closed])) dot(id, closed.has(id));
  const names = L.layerGroup();
  const shownIds = new Set([...lineIds, ...closed]);
  if (view === 2) {
    for (const l of alt.detours) for (const id of subwayData.routes[l].normal) {
      if (subwayData.stops[id] && !shownIds.has(id) && area.contains(LL(id))) { dot(id, false, true); shownIds.add(id); }
    }
  }
  // Zoomed in, every station shows its name and lines.
  const named = [];
  const linesAt = (id) => [...stationLines(id)].filter((l) => (view === 2 ? l === route || alt.detours.includes(l) : l === route) && !(l === route && closed.has(id)));
  // One name per station complex (Jay St-MetroTech has two stations): the one with lines running.
  const order = [...shownIds].sort((a, b) => linesAt(b).length - linesAt(a).length);
  for (const id of order) {
    const ls = linesAt(id);
    const [la, lo] = LL(id);
    if (named.some(([n, a, o]) => n === stationName(id) && Math.hypot(a - la, o - lo) < 0.004)) continue;
    named.push([stationName(id), la, lo]);
    L.marker(LL(id), { interactive: false, icon: L.divIcon({ className: '', iconSize: [0, 0], html: `<div class="cm-name${closed.has(id) && !ls.length ? ' off' : ''}">${esc(stationName(id))}${bullets(ls)}</div>` }) }).addTo(names);
  }

  // Labels for the overall picture.
  const labels = [];
  const name = (id) => stationName(id).replace(/-/g, '–');
  if (lineIds.includes('128') || lineIds.includes('A28')) {
    const id = lineIds.includes('A28') ? 'A28' : '128';
    labels.push({ at: LL(id), must: true, cls: 'here', html: `★ ${esc(name(id))}<small>You are here</small>`, w: textWidth(name(id)) + 10, h: 36 });
  }
  const closedList = [...closed].filter((id) => subwayData.stops[id]);
  const mid = closedList[Math.floor(closedList.length / 2)];
  if (mid) labels.push({ at: LL(mid), must: true, cls: 'off', html: `No ${lineLabel(info)} trains`, w: textWidth(`No ${info.label} trains`) });
  if (view === 1) {
    // Where the line ends and starts again around the closed part, and its far ends.
    const open = (id) => segs.some((s) => !s.closed && (s.a === id || s.b === id));
    const edges = closedList.filter((id) => open(id));
    for (const id of live.lastStops) labels.push({ at: LL(id), must: true, html: `${esc(name(id))}<small>${lineLabel(info)} trains end here</small>`, w: textWidth(`${lineLabel(info)} trains end here`), h: 36 });
    for (const id of edges) if (!live.lastStops.has(id)) labels.push({ at: LL(id), html: esc(name(id)), w: textWidth(name(id)) });
    for (const id of ends) if (!closed.has(id)) labels.push({ at: LL(id), html: esc(name(id)), w: textWidth(name(id)) });
  } else {
    alt.transfers.forEach((t) => {
      // A complex ("42 St-Port Authority/Times Sq-42 St") is labelled by its shortest name.
      const short = t.ids.map((id) => name(id)).sort((a, b) => a.length - b.length)[0];
      labels.push({ at: LL(t.ids[0]), must: true, html: `${esc(short)}${bullets(t.lines)}`, w: textWidth(short, t.lines.length) });
    });
    const transferNames = new Set(alt.transfers.flatMap((t) => t.ids.map(stationName)));
    for (const b of alt.buses) for (const id of [b.ids[0], b.ids[b.ids.length - 1]]) if (!transferNames.has(stationName(id))) labels.push({ at: LL(id), html: `${esc(name(id))}<small>Shuttle bus</small>`, w: textWidth(name(id)), h: 36 });
  }
  const labelLayer = L.layerGroup().addTo(map);
  const ring = L.layerGroup().addTo(map);
  const sync = () => {
    for (const [small, m] of dots) { m.setRadius(dotSize(small)); m.setStyle({ weight: map.getZoom() < 11.5 ? 1.2 : small ? 1.5 : 2 }); }
    if (map.getZoom() >= 14) { labelLayer.clearLayers(); names.addTo(map); }
    else { names.remove(); placeLabels(map, labelLayer, labels); }
  };
  const fit = view === 2 ? area : L.latLngBounds([...lineIds, ...closed].map(LL));
  map.fitBounds(fit, { padding: [24, 24] });
  // (Only once the map has a view: dots and labels are sized from it.)
  map.on('zoomend moveend', sync);
  sync();
  setTimeout(() => { map.invalidateSize(); map.fitBounds(fit, { padding: [24, 24] }); sync(); }, 60);

  // Tap a station under the map: zoom to it and circle it.
  $('chg-below').onclick = (e) => {
    const b = e.target.closest('[data-zoom]');
    if (!b) return;
    const t = alt.transfers[+b.dataset.zoom.slice(1)];
    const at = LL(t.ids[0]);
    $('chg-below').querySelectorAll('[data-zoom]').forEach((x) => x.setAttribute('aria-pressed', x === b));
    ring.clearLayers();
    L.marker(at, { interactive: false, zIndexOffset: 2000, icon: L.divIcon({ className: '', iconSize: [0, 0], html: '<div class="cm-ring"></div>' }) }).addTo(ring);
    map.flyTo(at, 15.5, { duration: 0.8 });
    $('chg-map').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };
}
const lineLabel = (info) => esc(info.label);

$('change').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) return closeChange();
  const v = e.target.closest('[data-view]');
  if (v && changeOpen) openChange(changeOpen.id, +v.dataset.view);
});
$('chg-close').addEventListener('click', closeChange);
$('subway-notices').addEventListener('click', (e) => {
  const b = e.target.closest('[data-change]');
  if (b) openChange(b.dataset.change);
});
// A "Rerouted, see map" row opens the notice behind it when there is one.
const changeFor = (route) => changeModels().find((m) => m.route === route);

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
  // Notices that close or reroute part of a line open a map.
  const mapBtn = (n) => (typeof changeModel === 'function' && changeModel(n) ? ` <button type="button" class="al-map" data-change="${esc(n.id)}">See map</button>` : '');
  const items = list.map((n) => `<div class="al-item${n.urgent ? ' urgent' : ''}"><span class="who">${noticeWho(n)}</span><p style="margin:0"><span class="kind">${esc(friendlyType(n.type))}</span>${noticeText(n.text)}${mapBtn(n)}</p></div>`).join('');
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
