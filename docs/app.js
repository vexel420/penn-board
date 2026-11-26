const REFRESH_MS = 20000;
const CARRIERS = { lirr: 'LIRR', njt: 'NJ Transit', amtrak: 'Amtrak', path: 'PATH', mnr: 'Metro-North', njtbus: 'NJ Transit', bus: 'Bus' };
// This board's hub (docs/hub.js): Penn Station unless the page set another.
const IS_PENN = HUB.id === 'nyp';
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

// (The flip board engine is in flip.js, shared with the Grand Central board.)
// Masthead and clock.
// Switching stations (owner, Nov 26: "bottom bar for mobile and B for
// desktop"). Phones get a bar at the bottom of the screen with every hub; on a
// computer the bar is hidden by CSS and a ▾ next to the station name opens a
// menu of the stations instead. Neither inside the side-by-side page's frames.
const SWITCH_HUBS = Object.values(window.HUBS || {}).filter((h) => h.page && h.tab);
const CAN_SWITCH = SWITCH_HUBS.length > 1 && window.self === window.top;
const hubTile = (h) => `<i style="background:${h.tab.bg};color:${h.tab.ink}${h.tab.stripe ? `;box-shadow:inset 0 -4px 0 ${h.tab.stripe}` : ''}">${esc(h.tab.code)}</i>`;
const HUB_DD = CAN_SWITCH ? '<button type="button" class="hub-dd" aria-haspopup="true" aria-expanded="false" aria-controls="hub-menu" title="Change station" aria-label="Change station">▾</button>' : '';
if (CAN_SWITCH) {
  const bar = document.createElement('nav');
  bar.className = 'station-bar';
  bar.setAttribute('aria-label', 'Stations');
  bar.style.setProperty('--n', SWITCH_HUBS.length);
  bar.innerHTML = SWITCH_HUBS.map((h) => `<a href="${h.page}"${h.id === HUB.id ? ' class="on" aria-current="page"' : ''}>${hubTile(h)}<span>${esc(h.tab.label)}</span></a>`).join('');
  document.body.appendChild(bar);
  document.body.classList.add('has-station-bar');
  const menu = document.createElement('div');
  menu.className = 'hub-menu';
  menu.id = 'hub-menu';
  menu.hidden = true;
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'Stations');
  menu.innerHTML = `<div class="hub-menu-head">Stations</div>` + SWITCH_HUBS.map((h) => `<a role="menuitem" href="${h.page}"${h.id === HUB.id ? ' class="on" aria-current="page"' : ''}>${hubTile(h)}<span><b>${esc(h.name)}</b><small>${esc(h.tab.serves || '')}</small></span>${h.id === HUB.id ? '<em aria-hidden="true">✓</em>' : ''}</a>`).join('');
  document.body.appendChild(menu);
  const btn = () => document.querySelector('.hub-dd');
  const close = (focus) => { if (menu.hidden) return; menu.hidden = true; btn()?.setAttribute('aria-expanded', 'false'); if (focus) btn()?.focus(); };
  const open = () => {
    const b = btn(); if (!b) return;
    const r = b.getBoundingClientRect();
    menu.hidden = false;
    menu.style.top = `${Math.round(r.bottom + window.scrollY + 8)}px`;
    menu.style.left = `${Math.round(Math.max(12, Math.min(r.left + window.scrollX - 12, document.documentElement.clientWidth - menu.offsetWidth - 12)))}px`;
    b.setAttribute('aria-expanded', 'true');
    (menu.querySelector('a.on') || menu.querySelector('a'))?.focus();
  };
  document.addEventListener('click', (e) => {
    if (e.target.closest('.hub-dd')) { e.preventDefault(); e.stopPropagation(); if (menu.hidden) open(); else close(); return; }
    if (!e.target.closest('.hub-menu')) close();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (menu.hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); close(true); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const items = [...menu.querySelectorAll('a')];
      const i = items.indexOf(document.activeElement);
      items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
    }
  });
  window.addEventListener('resize', () => close());
}
function renderMastFlip() {
  const h = document.querySelector('.mast h1');
  if (flipMode) {
    h.innerHTML = `<span class="mast-kicker">${HUB.kicker}</span><span class="mast-flip">${flipText('mast', HUB.name)}</span>${HUB_DD}<span class="h1-sub" id="h1-sub"></span>`;
    runFlips(h);
  } else {
    h.innerHTML = `<span class="mast-kicker">${HUB.kicker}</span>${HUB.name}${HUB_DD}<span class="h1-sub" id="h1-sub"></span>`;
    flipShown.delete('mast');
  }
  setHeading();
}
function setBoardStyle(flip) {
  flipMode = flip;
  try { localStorage.setItem('boardStyle', flip ? 'flip' : 'standard'); } catch {}
  document.body.classList.toggle('flipboard', flip);
  document.querySelectorAll('.style-seg button').forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.style === 'flip') === flip)));
  for (const k of [...flipShown.keys()]) if (k !== 'mast') flipShown.delete(k); // rows flip in fresh
  lastClock = '';
  renderMastFlip(); tick(); render();
}
let lastClock = '';

function trackCell(r, extra = '') {
  if (r.track) {
    const fresh = seenTracks.has(r.id) && seenTracks.get(r.id) !== r.track;
    return `<div class="track${fresh && !flipMode ? ' flip' : ''}${extra}" aria-label="Track ${esc(r.track)}"><b>${flipText(`${r.id}|k`, r.track, extra.includes('ring') ? 'final' : '')}</b></div>`;
  }
  if (r.trackLikely) return `<div class="track likely" aria-label="Track not posted, usually ${esc(r.trackLikely)}"><b>${flipText(`${r.id}|k`, r.trackLikely)}</b><small>usual</small></div>`;
  return `<div class="track none" aria-label="Track not posted"><b>${flipMode ? flipText(`${r.id}|k`, '') : '–'}</b></div>`;
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
const CANCELLED_SHOWN_S = 5 * 60;
const LISTED_PAST_S = 30 * 60; // a non-Amtrak train still listed this long past its time is dropped // a cancelled train stays until this long past its time
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

// When a train left, or null if it hasn't. Only data says a train has left:
// the feed's own report (Amtrak), or the train dropping out of its feed as
// it's due (LIRR, NJ Transit; see noteVanished). The clock never does: a
// late train whose delay hasn't reached the feed is still at the platform.
function departedAt(r) {
  if (r.tone === 'stop') return null; // a cancelled train never left
  const nowS = Date.now() / 1000;
  if (r.departedAt) return r.departedAt;
  if (r.departed) {
    if (!flaggedAt.has(r.id)) flaggedAt.set(r.id, nowS);
    // Learned long after it was due out (the app was asleep, the feed was
    // slow): it left about when it was due, not when the board found out, so
    // "left N min ago" is right and old departures don't come back (Nov 24).
    const due = r.leaves ?? r.time;
    return flaggedAt.get(r.id) - due > 300 ? due : flaggedAt.get(r.id);
  }
  return null;
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
    // Dropped because it now starts somewhere else (or is cancelled), per
    // the railroad's notice: crossed off, never "Departed".
    const change = tripChangeFor(r, 'departures', next);
    if (change) { cancelledGone.departures.set(r.id, { ...r, tone: 'stop', status: change.status, changeNote: change.text }); continue; }
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
  saveRecentDeparted(next);
}
// Trains that just left stay on the board through a reload (owner, Nov 24:
// tapping "Penn Station" or reopening the page cleared them). Kept in this
// browser only, for the rest of their usual time on the board.
const RECENT_KEY = 'recentDeparted';
function saveRecentDeparted(next) {
  const nowS = Date.now() / 1000;
  const keep = [];
  for (const r of [...vanished.values(), ...(next ? next.departures : [])]) {
    if (r.awaiting || r.tone === 'stop') continue;
    const at = r === vanished.get(r.id) ? r.departedAt : departedAt(r);
    if (at == null || nowS - shownSince(r, at) > shownFor(r)) continue;
    keep.push({ ...r, departed: true, departedAt: at, learned: learnedAt.get(r.id) || nowS });
  }
  try { localStorage.setItem(RECENT_KEY, JSON.stringify({ at: nowS, rows: keep })); } catch {}
}
(function restoreRecentDeparted() {
  try {
    const d = JSON.parse(localStorage.getItem(RECENT_KEY) || 'null');
    if (!d || !Array.isArray(d.rows)) return;
    const nowS = Date.now() / 1000;
    for (const r of d.rows) {
      learnedAt.set(r.id, r.learned || r.departedAt);
      if (nowS - Math.max(r.departedAt, r.learned || 0) > shownFor(r)) continue;
      const { learned, ...row } = r;
      vanished.set(row.id, row);
    }
  } catch {}
})();

function visibleRows(rows, kind) {
  const nowS = Date.now() / 1000;
  // Arrivals go 5 min after arriving, except a through train, which stays
  // until it has left Penn (its feed row disappears then).
  if (kind === 'arrivals') {
    return [...rows, ...cancelledGone.arrivals.values()].sort((a, b) => a.time - b.time)
      .filter((r) => (r.continuesTo ? r.departsAt > nowS - 30 * 60 : r.time > nowS - 5 * 60 || r.awaiting));
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
    // A train still listed long after its time (a feed that stopped
    // updating) leaves the board without being called departed.
    return (r.leaves ?? r.time) > nowS - LISTED_PAST_S;
  });
}

// A train that has left says "Departed", whatever its last status was. Stale
// data never keeps the green boarding highlight.
// The last call to board, worded "All aboard" on every railroad to match NJ
// Transit, whose own status says that (owner's choice): a boarding train in its
// last minute. NJ Transit rows keep NJ Transit's own wording (its terms ask
// for as-is text); the row still turns red.
// A delayed train's final call starts 2 minutes before its estimated
// departure, so no one misses it; an on-time train's, 1 minute before.
const isDelayed = (r) => (r.lateMin || 0) >= 2;
function finalCall(r, kind) {
  if (kind !== 'departures' || r.tone !== 'go' || isStale()) return false;
  const left = (r.leaves ?? r.time) - Date.now() / 1000;
  // Past its time but still listed and boarding (it hasn't left): final call
  // until its feed shows it has gone. (Amtrak has its own rule.)
  return (r.departsByFeed ? left > 0 : true) && left <= (isDelayed(r) || isLastTrain(r) ? 120 : 60);
}
// The last train of the night on its line (owner, Nov 24: its final call starts
// 2 minutes out too). NJ Transit: the board's own last-train list. LIRR: no
// later train from Penn on the same branch for 90 minutes, by the timetable.
function isLastTrain(r) {
  if (r.carrier === 'njt') return typeof njtLast !== 'undefined' && njtLast.has(String(r.train));
  if (r.carrier !== 'lirr' || typeof lirrTT === 'undefined' || !lirrTT) return false;
  if (lastLirrCache.has(r.id)) return lastLirrCache.get(r.id);
  const leave = r.leaves ?? r.time;
  const mine = lirrTripsNear().find((t) => String(t.train) === String(r.train));
  let last = false;
  if (mine) {
    last = !lirrTripsNear().some((t) => t.route === mine.route && t !== mine && t.calls.some(([sid, at]) => sid === ttFrom(lirrTT) && at > leave + 60 && at < leave + 90 * 60) && t.calls[t.calls.length - 1][0] !== lirrTT.penn);
  }
  lastLirrCache.set(r.id, last);
  return last;
}
const lastLirrCache = new Map();

// A notice in effect now saying a railroad's service into and out of Penn
// is suspended (signal trouble, an incident): its trains are held, whatever
// the feed's own "on time" says.
const PENN_SUSPENDED = /(?:(?:into|in) and out of|to and from|at|from|into|to)\s+(?:new york\s+)?penn(?:sylvania)?\b/i;
function pennSuspension(carrier) {
  return ((board && board.notices && board.notices.rail) || []).find((n) => n.carrier === carrier && happeningNow(n)
    && /suspend|no (?:train )?service/i.test(`${n.type} ${n.text}`) && /suspend|no (?:train )?service/i.test(n.text) && PENN_SUSPENDED.test(n.text));
}
// The board's own words ("On time", "5 min late"), not a railroad's status text.
const ownStatus = (r) => !fromNjt(r) || /^(on time|\d+ min late)$/i.test(String(r.status || '').trim());
function shownStatus(r, kind) {
  // Buses (the bus terminal) keep their own status: no train rules.
  if (r.bus) return { status: r.status, tone: r.tone };
  if (kind === 'departures' && departedAt(r) !== null) return { status: 'Departed', tone: 'departed' };
  // An NJ Transit train past its expected time that hasn't reached New York.
  if (kind === 'arrivals' && r.awaiting && r.tone !== 'stop' && r.time < Date.now() / 1000 - 120) return { status: 'Delayed', tone: 'late', waiting: true };
  if (r.tone !== 'stop' && (ownStatus(r) || r.tone !== 'go') && pennSuspension(r.carrier) && !(kind === 'arrivals' && r.time <= Date.now() / 1000 && !r.continuesTo)) {
    return { status: fromNjt(r) && !ownStatus(r) ? r.status : 'Held', tone: 'held', held: true };
  }
  // A delayed train whose track is posted is boarding (NJ Transit's own text stays).
  if (kind === 'departures' && r.tone === 'late' && r.track && !fromNjt(r)) r = { ...r, status: 'Boarding', tone: 'go' };
  if (finalCall(r, kind)) return { status: fromNjt(r) ? r.status : 'All aboard', tone: 'final' };
  // An Amtrak train past its time that Amtrak hasn't reported boarding or gone.
  if (kind === 'departures' && r.departsByFeed && r.tone !== 'go' && r.tone !== 'stop' && (r.leaves ?? r.time) <= Date.now() / 1000) return { status: 'No update from Amtrak', tone: 'late' };
  // Past its time (by more than 2 min) and still listed, with no word from
  // its feed: it hasn't left, so it isn't "on time". (A boarding train keeps
  // "All aboard"; a railroad's own status text is left alone.)
  if (kind === 'departures' && ownStatus(r) && (r.tone === 'ok' || r.tone === 'late') && (r.leaves ?? r.time) < Date.now() / 1000 - 120) return { status: 'Delayed', tone: 'late', waiting: true };
  if (r.tone !== 'go') return { status: r.status, tone: r.tone };
  if (kind === 'arrivals' && r.time <= Date.now() / 1000 && !r.continuesTo) return { status: r.status, tone: 'quiet' };
  if (isStale()) return { status: r.status, tone: 'quiet' };
  return { status: r.status, tone: r.tone };
}

function finalLeft(r) {
  const s = (r.leaves ?? r.time) - Date.now() / 1000;
  return s > 60 ? 'in 2 min' : s > 0 ? 'under 1 min' : 'due';
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
  // The last stop is a station: no "-SEC" (via Secaucus) or ✈ (via Newark
  // Airport), which describe the way there, not the stop (owner, Nov 24).
  let tail = '', last = String(r.place).replace(/\s*✈\s*/g, ' ').replace(/\s*-\s*SEC\b/gi, '').trim();
  if (view === 'arrivals') {
    last = r.continuesTo || 'Penn Station';
    if (r.continuesTo) tail = ', Penn Station';
  }
  return `<details class="via" data-id="${esc(r.id)}"${open ? ' open' : ''}><summary>${r.where ? `${esc(r.where)}, ` : ''}${esc(r.line)}, train ${esc(r.train)}, <u>${r.via.length} stop${r.via.length === 1 ? '' : 's'}</u>${where}${fareTag(r)}</summary><p>${names}${tail}</p><p class="last-stop">Last stop: <b>${esc(last)}</b></p>${checking}</details>`;
}

function rowHtml(r) {
  const shown = shownStatus(r, view);
  r = { ...r, status: shown.status, tone: shown.tone };
  const heldBy = shown.held ? pennSuspension(r.carrier) : null;
  const t = clock(r.time);
  const gone = r.tone === 'departed';
  // A late train counts down to when it is now expected to leave.
  const left = gone ? agoText(departedAt(r) ?? r.time) : countdown(r.tone === 'stop' ? r.time : (r.leaves ?? r.time));
  // Past its time but not reported gone (late Amtrak, a delayed or held
  // train): still expected, so not dimmed, and the time says "due".
  const due = !gone && left === 'gone' && (r.departsByFeed || shown.waiting || shown.held);
  // Under the status: how late (when the status itself doesn't say) and the
  // scheduled time, so a delayed train that is boarding still reads as delayed.
  const notes = [];
  if (heldBy) notes.push(`service suspended at ${HUB.short}`);
  if (r.changeStatus && r.changeStatus !== r.status) notes.push(esc(r.changeStatus));
  if (isDelayed(r) && !/late/i.test(r.status) && !gone && !heldBy) notes.push(`${r.lateMin} min late`);
  if (r.sched && Math.abs(r.sched - r.time) >= 120) notes.push(`scheduled ${clock(r.sched).hm}`);
  if (view === 'arrivals' && r.continuesTo) notes.push(`continues to ${esc(r.continuesTo)}, leaves ${clock(r.departsAt).hm}`);
  const sched = notes.length ? `<small>${notes.join(', ')}</small>` : '';
  const via = r.meta ? `<div class="meta">${esc(r.meta)}${r.gateUsual ? ' · usual gate' : ''}</div>` : r.via && r.via.length ? viaHtml(r) : `<div class="meta">${r.where ? `${esc(r.where)}, ` : ''}${esc(r.line)}, train ${esc(r.train)}${fareTag(r)}</div>`;
  // Departures never fade by the clock: only a train its railroad reports
  // gone ("Departed") is dimmed. (Arrivals past their time still fade.)
  // A cancelled train keeps full colour until its last 30 s on the board.
  const nowS2 = Date.now() / 1000;
  const fading = r.tone === 'stop' ? nowS2 > r.time + CANCELLED_SHOWN_S - 30
    : view === 'arrivals' && left === 'gone' && !gone && !due && !heldBy;
  return `<li class="row ${r.tone}${fading ? ' gone' : ''}">
    <div class="time"><b>${flipText(`${r.id}|t`, t.hm)}<small>${t.ap}</small></b><span>${due ? 'due' : r.tone === 'final' ? finalLeft(r) : left === 'gone' ? '' : left}</span></div>
    <div class="carrier"><span class="plate ${r.plateClass || r.carrier}">${esc(r.plate || CARRIERS[r.carrier])}</span></div>
    <div class="dest"><div class="place">${flipText(`${r.id}|p`, r.place)}</div>${via}${njtLastHtml(r)}${railHolidayHtml(r)}${rowAlertHtml(r)}</div>
    <div class="status ${r.tone}">${flipText(`${r.id}|s`, r.status)}${sched}</div>
    ${trackCell(r, r.tone === 'final' ? ' ring' : '')}
  </li>`;
}

// Flip board: replace only the rows whose content changed (each row's
// markup, with its tiles' target text, is compared), and keep the rest as
// they are, so the page isn't rebuilt every few seconds.
function patchRows(rows) {
  const ul = $('rows');
  const old = new Map([...ul.children].filter((li) => li.dataset.rid).map((li) => [li.dataset.rid, li]));
  const want = rows.map((r) => {
    const sig = rowHtml(r);
    const li = old.get(r.id);
    if (li && li.dataset.sig === sig) { old.delete(r.id); return li; }
    const t = document.createElement('template');
    t.innerHTML = sig.trim();
    const n = t.content.firstElementChild;
    n.dataset.rid = r.id; n.dataset.sig = sig;
    // An open list of stops stays open.
    if (li) { const d = li.querySelector('details[open]'); const nd = n.querySelector('details'); if (d && nd) nd.open = true; old.delete(r.id); li.remove(); }
    return n;
  });
  for (const li of old.values()) li.remove();
  [...ul.children].forEach((c) => { if (!c.dataset.rid) c.remove(); });
  want.forEach((n, i) => { if (ul.children[i] !== n) ul.insertBefore(n, ul.children[i] || null); });
}

function emptyMessage() {
  const s = board.sources;
  if (carrier === 'njt') {
    if (view === 'arrivals') return 'NJ Transit publishes departures only, so its arriving trains can’t be listed here.';
    if (s.njt.needsServer || s.njt.needsLogin) return 'NJ Transit data not yet available.';
    if (s.njt.error) return `NJ Transit data didn’t load${plainError(s.njt.error)}. Trying again shortly.`;
  }
  if (carrier !== 'all' && s[carrier] && s[carrier].error) return `${CARRIERS[carrier]} data didn’t load${plainError(s[carrier].error)}. Trying again shortly.`;
  return `No ${carrier === 'all' ? '' : CARRIERS[carrier] + ' '}${view} in the next few hours.`;
}

// The final call starts on the second (owner, Nov 24: it waited for the next
// redraw, up to 10 s late): after each draw, a redraw is set for the next
// moment a train enters its final call (1 or 2 min before it leaves).
let finalTimer = null;
function scheduleFinalCall(rows) {
  clearTimeout(finalTimer);
  if (view !== 'departures') return;
  const nowS = Date.now() / 1000;
  let next = Infinity;
  for (const r of rows) {
    if (r.tone === 'stop' || r.tone === 'departed') continue;
    const at = (r.leaves ?? r.time) - (isDelayed(r) || isLastTrain(r) ? 120 : 60);
    if (at > nowS && at < next) next = at;
  }
  if (next - nowS < 10 * 60) finalTimer = setTimeout(renderRail, (next - nowS) * 1000 + 100);
}
function renderRail() {
  if (!board || view === 'subway' || view === 'alerts' || view === 'buses') return;
  // The chips filter by railroad, or (Grand Central) by Metro-North line.
  const rows = visibleRows(board[view], view).filter((r) => carrier === 'all' || r.carrier === carrier || r.group === carrier);
  scheduleFinalCall(rows);
  $('col-place').textContent = view === 'arrivals' ? 'From' : 'To';
  if (flipMode && rows.length) patchRows(rows);
  else $('rows').innerHTML = rows.length ? rows.map(rowHtml).join('') : `<li class="empty">${esc(emptyMessage())}</li>`;
  for (const r of rows) seenTracks.set(r.id, r.track);
  runFlips($('rows'));
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
  // (If it doesn't load, say on a weak phone connection, it's tried again in
  // 20 s rather than never: line badges and maps depend on it.)
  subwayDataLoading = fetch(`subway-data.json?v=${document.querySelector('script[src^="app.js"]').src.split('v=')[1] || ''}`)
    .then((r) => (r.ok ? r.json() : null)).catch(() => null)
    .then((d) => {
      subwayDataLoading = null;
      if (!d) { setTimeout(loadSubwayData, 20000); return; }
      for (const r of Object.values(d.routes)) r.normalSet = new Set(r.normal);
      subwayData = d; renderSubway(); renderServiceNotices(); if (typeof renderEvents === "function") renderEvents();
    });
}
const lineInfo = (route) => (subwayData && subwayData.routes[route]) || { label: route, color: '#6b7a70', text: '#ffffff' };
const stationName = (id) => (subwayData && subwayData.stops[id] ? subwayData.stops[id][0] : '');
// Stations on this train's way that its line doesn't normally serve.
// A stop the line doesn't usually make. Another platform of a station the
// line does serve (145 St's lower level, for a C ending there) isn't one:
// same name, same place.
const placeKey = (id) => { const x = subwayData.stops[id]; return x ? `${x[0]}|${x[1].toFixed(3)}|${x[2].toFixed(3)}` : id; };
function unusualStops(route, train) {
  const r = subwayData && subwayData.routes[route];
  if (!r || !train.stops) return [];
  if (!r.normalPlaces) r.normalPlaces = new Set([...r.normalSet].map(placeKey));
  return train.stops.filter((id) => subwayData.stops[id] && !r.normalSet.has(id) && !r.normalPlaces.has(placeKey(id)));
}
// A line named in a sentence ("Use the 2."): its badge, at text size.
const lineName = (route) => bulletHtml(route, 'inl');
// Express runs of the 6 and the 7 (Grand Central) get the MTA's diamond; the
// feed decides express by the stops a train makes (feeds.js serviceAt, from subway-rules.json).
const DIAMOND_NOTE = { 6: 'express in the Bronx', 7: 'express in Queens', F: 'express in Brooklyn' };
// They run local in Manhattan, so they share the local row with the circle
// trains: the bullet and note follow the train shown (t.diamond, feeds.js).
const isDiamond = (g, t) => !!(t && t.diamond);
const bulletShown = new Map(); // row -> diamond shown last, to flip when it changes
function rowBullet(g, t, key) {
  const d = isDiamond(g, t);
  const before = key ? bulletShown.get(key) : undefined;
  if (key) bulletShown.set(key, d);
  return bulletHtml(g.route, `${d ? 'diamond' : ''}${before !== undefined && before !== d ? ' bflip' : ''}`);
}
const diamondNote = (g, t) => (isDiamond(g, t) ? `<small class="dnote">${DIAMOND_NOTE[g.route] || 'express part of the way'}</small>` : '');
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
// Major holidays, when the subway runs its Sunday schedule (the MTA's
// pattern: New Year's Day, Memorial Day, July 4, Labor Day, Thanksgiving,
// Christmas). date: "2026-11-26".
function subwayHoliday(date) {
  const [y, m, d] = date.split('-').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 Sunday
  const nth = Math.ceil(d / 7), last = d + 7 > new Date(Date.UTC(y, m, 0)).getUTCDate();
  return (m === 1 && d === 1) || (m === 7 && d === 4) || (m === 12 && d === 25)
    || (m === 5 && wd === 1 && last) || (m === 9 && wd === 1 && nth === 1) || (m === 11 && wd === 4 && nth === 4);
}
// On a holiday the MTA says which schedule runs; use that day's switch times.
// Without a notice, the holiday calendar above (Sunday schedule).
function scheduleToday(day) {
  if (holidayNotice()) {
    const t = subwayNoticeText();
    if (/sunday schedule/i.test(t)) return 'sunday';
    if (/saturday schedule/i.test(t)) return 'saturday';
  }
  return subwayHoliday(nyNow().date) ? 'sunday' : day;
}
// The subway schedule a day runs (x: from nyNow or nyDayAt): today's as
// above, other days by the holiday calendar.
const subSched = (x) => (x.date === nyNow().date ? scheduleToday(x.day) : subwayHoliday(x.date) ? 'sunday' : x.day);
const fmtClock = (t) => {
  const m = ((t % 1440) + 1440) % 1440, h = Math.floor(m / 60);
  return `${h % 12 || 12}:${String(m % 60).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};
const morningReached = new Set(); // date|station|line|dir once the first daytime express shows "now"
// The first daytime train has already left this station: it was due 3+ min ago
// and the earliest one listed now is 8+ min after it. (A board opened after it
// passed never saw it show "now"; owner, Nov 26: the C banner stayed at Times
// Square after Penn's had cleared.) A late first train (under 8 min) still counts as coming.
// The train this board first saw coming while the banner was up, per banner:
// once its time has passed, it has arrived (the board refreshes every 30 s and
// can miss its "now"; owner, Nov 26: the banners must go once the first
// daytime express arrives, on every board).
const morningWatch = new Map();
function morningArrived(key, here, line, dir, svc, nowS) {
  const times = here.filter((g) => g.route === line && g.dir === dir && (!svc || (g.svc || 'local') === svc))
    .flatMap((g) => g.trains.map((t) => t.time)).filter((t) => t >= nowS - 30);
  if (times.some((t) => t - nowS < 30)) return true; // showing "now"
  const seen = morningWatch.get(key);
  if (seen != null && nowS > seen + 30) return true;
  if (seen == null && times.length) morningWatch.set(key, Math.min(...times));
  return false;
}
// A line whose late-night pattern is only fewer trains (the 3 uptown at Penn:
// no express/local switch, no overnight gap) also says when daytime service
// has started (owner, Nov 26: "the banner is missing the 3"): from the first
// daytime trip listed until it arrives, within 20 min of when the timetable's
// late-night pattern ends (subway-data.json "night" .to).
function windowMorning(stn, line, dir, svc, here, nowS) {
  const today = nyNow();
  if (today.mins >= 12 * 60 || switchState(stn.id, line, dir) || nightGapState(stn.id, line, dir)) return false;
  const w = (((subwayData && subwayData.night && subwayData.night[stn.id]) || {})[line] || {})[dir];
  const T = w && w[subSched(today)];
  if (!T || T.to == null || today.mins > T.to + 20 || today.mins < T.to - 90) return false;
  const key = `${today.date}|${stn.id}|${line}|${dir}|win`;
  if (morningReached.has(key)) return false;
  const day = here.filter((g) => g.route === line && g.dir === dir && (g.svc || 'local') === svc)
    .flatMap((g) => g.trains).filter((t) => t.time >= nowS - 30 && !lateNightTrain(stn.id, line, dir, t.time, t.code));
  if (!day.length) return false;
  const first = Math.min(...day.map((t) => t.time));
  if (first - nowS < 30 || (morningWatch.has(key) && nowS > morningWatch.get(key) + 30)) { morningReached.add(key); return false; }
  if (!morningWatch.has(key)) morningWatch.set(key, first);
  return true;
}
function firstMorningGone(here, line, dir, svc, untilMins, nowS) {
  if (untilMins == null) return false;
  const due = minsToEpoch(untilMins);
  if (nowS < due + 180) return false;
  const times = here.filter((g) => g.route === line && g.dir === dir && (!svc || (g.svc || 'local') === svc))
    .flatMap((g) => g.trains.map((t) => t.time)).filter((t) => t >= nowS - 30);
  return times.length > 0 && Math.min(...times) >= due + 480;
}

function switchState(stationId, line, dir) {
  const sw = subwayData && subwayData.switches && ((subwayData.switches[stationId] || {})[line] || {})[dir];
  if (!sw) return null;
  const today = nyNow(), yest = nyNow(-1), tom = nyNow(1);
  const T = sw[subSched(today)], Y = sw[subSched(yest)], N = sw[subSched(tom)];
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
  const T = g[subSched(today)], N = g[subSched(tom)] || T;
  if (!T) return null;
  const m = today.mins;
  const key = `${today.date}|${stationId}|${line}|${dir}|gap`;
  if (m >= 12 * 60 && m > T.after) return { ...T, until: N.until, phase: 'night', key };
  // The hour before the last train: count down to it.
  if (m >= 12 * 60 && m >= T.after - 60) return { ...T, phase: 'countdown', left: T.after - m, key };
  if (m < 12 * 60 && m < (T.firstStart ?? T.until)) return { ...T, phase: 'night', key };
  if (m < 12 * 60 && !morningReached.has(key) && m < T.until + 30) return { ...T, phase: 'morning', key };
  return null;
}
// A train at Penn at this time (epoch seconds) is a late-night train when its
// own line runs its late-night timetable then: subway-data.json "night" has,
// per line, direction and day, when trains start running 15+ min apart in the
// evening ("from") and when they come closer together again in the morning
// ("to"), from the MTA timetable. Each line ramps up at its own time, so the
// pills drop off line by line, and each stays on its train until it leaves.
const nyDayAt = (epoch) => {
  const p = {};
  nyParts.formatToParts(new Date(epoch * 1000)).forEach((x) => { p[x.type] = x.value; });
  return { day: p.weekday === 'Sat' ? 'saturday' : p.weekday === 'Sun' ? 'sunday' : 'weekday', mins: +p.hour * 60 + +p.minute, date: `${p.year}-${p.month}-${p.day}` };
};
function lateNightTrain(stationId, route, dir, epoch, code) {
  const w = subwayData && subwayData.night && ((subwayData.night[stationId] || {})[route] || {})[dir];
  if (!w) return false;
  const at = nyDayAt(epoch), m = at.mins, day = at;
  const sched = (x) => w[subSched(x)];
  // Like PATH: go by which scheduled trip this train is (its id in the live
  // feed). A night train running late keeps its pill until it leaves Penn; a
  // day train never gets one. Morning: today's early trips, or last night's
  // trips listed past midnight (start 24:00+, id 144000 and up).
  if (code) {
    const T = sched(day), Y = sched(nyDayAt(epoch - 86400));
    const inT = !!(T && T.trips && T.trips.includes(code));
    if (m >= 12 * 60) return inT;
    return (inT && code < '144000') || !!(Y && Y.trips && Y.trips.includes(code) && code >= '144000');
  }
  if (m >= 12 * 60) { const T = sched(day); return !!T && T.from >= 12 * 60 && m >= T.from; }
  // After midnight: the night began the evening before (or just after midnight).
  const T = sched(day), Y = sched(nyDayAt(epoch - 86400));
  if (!T || m >= T.to) return false;
  return !Y || Y.from >= 12 * 60 || m >= Y.from;
}

// A line with no late-night trains in either direction (the C), by the
// timetable: its messages name no direction. (The 3 stops only downtown.)
const bothWaysOff = (stationId, line) => {
  const g = subwayData && subwayData.nightGaps && (subwayData.nightGaps[stationId] || {})[line];
  return !!(g && g.N && g.S);
};

// The A and the 2 run local late at night: once that switch has begun (and
// until the first daytime express reaches Penn), their local trains are
// late-night trains, even before trains get 15+ minutes apart.
// Judged by the train's own time at Penn: after the first late-night train
// sets off (evening), or before the first daytime express reaches Penn.
const localNight = (stationId, g, dir, epoch) => {
  if (g.svc !== 'local') return false;
  const sw = subwayData && subwayData.switches && ((subwayData.switches[stationId] || {})[g.route] || {})[dir];
  if (!sw) return false;
  const t = epoch ?? (g.trains && g.trains[0] && g.trains[0].time) ?? Date.now() / 1000;
  const at = nyDayAt(t), mins = at.mins;
  const T = sw[subSched(at)];
  if (!T) return false;
  return mins >= 12 * 60 ? mins >= T.nightStart : mins < T.firstExpressPenn;
};

// The 3 stops running downtown from Penn late at night (it only runs Penn
// to Harlem): once the last downtown 3 has left, uptown 3 trains are on
// their late-night pattern, until downtown trains start again in the morning.
// (Any line that stops one way only at Penn at night, per nightGaps.)
const cutbackNight = (stationId, route, dir, epoch) => {
  const ng = subwayData && subwayData.nightGaps && (subwayData.nightGaps[stationId] || {})[route];
  const other = dir === 'N' ? 'S' : 'N';
  if (!ng || ng[dir] || !ng[other]) return false;
  const at = nyDayAt(epoch), mins = at.mins;
  if (mins >= 12 * 60) {
    const g = ng[other][subSched(at)];
    return !!g && g.after >= 12 * 60 && mins > g.after;
  }
  const g = ng[other][subSched(nyDayAt(epoch - 86400))];
  return !!g && mins < g.until && (g.after >= 12 * 60 || mins > g.after);
};

// ---------- a line suspended by a notice (planned overnight work) ----------
// The notice's next period (in effect now, or starting within 4 hours) that
// suspends this line at this Penn station.
function suspensionFor(stnId, line, nowS) {
  let best = null;
  for (const n of (board && board.notices && board.notices.subway) || []) {
    if (n.preview || !/suspend/i.test(n.type) || !(n.lines || []).includes(line) || !((n.affected || {})[line] || []).includes(stnId)) continue;
    for (const [start, end] of n.periods || []) {
      if (end > nowS && start - nowS < 4 * 3600 && (!best || start < best.start)) best = { n, start, end };
    }
  }
  return best;
}
// Which section (express or local) a line's trains are listed in this way.
function lineSection(here, stnId, line, dir) {
  const g = here.find((x) => x.route === line && x.dir === dir);
  if (g) return g.svc || 'local';
  const gap = subwayData && subwayData.nightGaps && ((subwayData.nightGaps[stnId] || {})[line] || {})[dir];
  const any = gap && Object.values(gap)[0];
  const rules = PennFeeds.subwayRules && PennFeeds.subwayRules();
  return any ? any.svc : ((rules && rules.usual[`${stnId}|${line}|${dir}`]) || 'local');
}
// Other lines at this station to use instead of `line` going this way,
// judged by where the trains go on the map, not by stops in common (owner,
// Nov 23): a line counts if it takes you at least ALT_REACH of the way
// toward the missing line's last stop (its main last stops, from the
// timetable), measured as the distance covered before the two lines part.
// Uptown C (168 St): the A, which goes on to Inwood; not the E, which turns
// off to Queens. Downtown C (Euclid Av): the A. Missing E uptown (Jamaica):
// nothing here goes there. Two stations within 400 m count as one (Chambers
// St for World Trade Center). Best first; none if nothing goes that way.
// `skip` leaves out lines not running.
const ALT_REACH = 0.7;
const kmBetween = (a, b) => { const dy = (a[1] - b[1]) * 111.2, dx = (a[2] - b[2]) * 111.2 * Math.cos(a[1] * Math.PI / 180); return Math.hypot(dx, dy); };
function directionAlts(stn, line, dir, skip = () => false) {
  const r = subwayData && subwayData.routes[line];
  const here = subwayData && subwayData.stops[stn.id];
  const ends = ((subwayData && subwayData.terminals && subwayData.terminals[line]) || {})[dir] || [];
  if (!r || !here || !ends.length) return [];
  const pos = (id) => subwayData.stops[id];
  const scores = stn.lines.filter((l) => l !== line && !skip(l) && subwayData.routes[l]).map((l) => {
    const alt = [...subwayData.routes[l].normalSet].map(pos).filter(Boolean);
    let reach = 0;
    for (const end of ends) {
      const t = pos(end);
      if (!t) continue;
      const total = kmBetween(here, t);
      if (total < 0.5) continue;
      // The missing line's stops the other line also serves (or has a
      // station beside), beyond this station: the one nearest its last stop.
      let nearest = Infinity;
      for (const id of r.normalSet) {
        const x = pos(id);
        if (!x || kmBetween(x, here) < 0.3 || kmBetween(x, t) >= total) continue;
        if (alt.some((y) => kmBetween(x, y) < 0.4)) nearest = Math.min(nearest, kmBetween(x, t));
      }
      if (isFinite(nearest)) reach = Math.max(reach, (total - nearest) / total);
    }
    return { l, reach };
  });
  return scores.filter((x) => x.reach >= ALT_REACH).sort((a, b) => b.reach - a.reach).map((x) => x.l);
}
// The lines a notice itself names, at this station (the MTA's own advice).
const noticeAlts = (n, stn, line) => [...new Set([...String(`${n.desc || ''}`).matchAll(/\[([A-Z0-9]{1,2})\]/g)].map((m) => m[1]))].filter((l) => l !== line && stn.lines.includes(l));

// The fastest way to where a missing line goes (subway-guide.json, built
// from the MTA timetable by scripts/build-subway-guide.py): a direct line,
// or one change inside the subway, by travel time (owner, Nov 24).
let subwayGuide, subwayGuideLoading = null;
function loadSubwayGuide() {
  if (subwayGuide !== undefined || subwayGuideLoading) return;
  subwayGuideLoading = fetch('subway-guide.json').then((r) => (r.ok ? r.json() : null)).catch(() => null)
    .then((d) => { subwayGuide = d; subwayGuideLoading = null; if (board) { slideStarted = -Infinity; renderSubway(); } });
}
const shortStop = (id) => String((subwayGuide && subwayGuide.names[id]) || stationName(id) || id).split('-')[0].trim();
const linesText = (ls0) => { const ls = [...ls0].sort((a, b) => String(a).localeCompare(String(b), 'en', { numeric: true })); return `${ls.slice(0, -1).map(lineName).join(', ')}${ls.length > 1 ? ' or ' : ''}${lineName(ls[ls.length - 1])}`; };
// The plan to show now: the fastest whose first train is running.
function guidePlan(stn, line, dir, here, nowS) {
  const byDir = ((subwayGuide && subwayGuide.plans[stn.id]) || {})[line] || {};
  // A shuttle runs one way from the hub; the board files it under one direction (feeds.js).
  const per = byDir[dir] || (/^(GS|FS|H)$/.test(line) ? byDir.N || byDir.S : null) || {};
  const e = (nyNow().mins < 5 * 60 ? per.night : per.day) || {};
  for (const p of e.plans || []) {
    const l0 = p.legs[0];
    const first = l0.routes.filter((l) => here.some((x) => x.route === l && x.dir === l0.dir && x.trains.some((t) => t.time >= nowS - 30)));
    if (first.length) return { ...p, legs: [{ ...l0, routes: first }, ...p.legs.slice(1)], walk: e.walk };
  }
  return e.walk ? { legs: [], walk: e.walk } : null;
}
// A line's name in a sentence; the 42 St and other shuttles are "the shuttle".
const routesText = (rs) => (rs.every((r) => /^(GS|FS|H|S)$/.test(r)) ? 'shuttle' : linesText(rs.filter((r) => !/^(GS|FS|H|S)$/.test(r))));
// What to do instead, as short sentences: the MTA notice's own advice
// first; then the fastest plan ("Take the 3 to Times Sq, the shuttle to
// Grand Central, then the 4 or 5."), with walking through Penn Station to
// the other subway station as a second choice; then a line going the same way.
function suggestionHtml(stn, line, dir, here, nowS, n) {
  const named = n ? noticeAlts(n, stn, line) : [];
  if (named.length) return `Use the ${linesText(named)}.`;
  const p = guidePlan(stn, line, dir, here, nowS);
  // (From a station with no other line, the walk can go on with a change:
  // "walk through Grand Central to the 4, 5 or 6 to 59 St, then the N or W to Queensboro Plaza".)
  const walkThen = (w) => (w.then ? ` to ${esc(shortStop(w.to))}, then ${w.then.map((l) => `the ${routesText(l.routes)} to ${esc(shortStop(l.to))}`).join(', then ')}` : '');
  const walk = p && p.walk ? `<span class="src">Or walk through ${esc(HUB.name)} to the ${routesText(p.walk.routes)}${walkThen(p.walk)}.</span>` : '';
  if (p && p.legs.length === 1) return `Use the ${routesText(p.legs[0].routes)}${p.legs[0].dir !== dir ? (p.legs[0].dir === 'N' ? ' uptown' : ' downtown') : ''}.${walk}`;
  if (p && p.legs.length > 1) {
    const ls = p.legs;
    const way = ls[0].dir !== dir ? (ls[0].dir === 'N' ? ' uptown' : ' downtown') : '';
    const mid = ls.slice(1, -1).map((l) => `the ${routesText(l.routes)} to ${esc(shortStop(l.to))}, `).join('');
    return `Take the ${routesText(ls[0].routes)}${way} to ${esc(shortStop(ls[0].to))}, ${mid}then the ${routesText(ls[ls.length - 1].routes)}.${walk}`;
  }
  const alts = directionAlts(stn, line, dir, (l) => !here.some((x) => x.route === l && x.dir === dir));
  if (alts.length) return `Use the ${linesText(alts)}.${walk}`;
  return walk ? walk.replace('<span class="src">Or walk', '<span>Walk') : '';
}
const howHtml = (h) => (h ? `<span class="how">${h}</span>` : '');

// A line rerouted or suspended so it doesn't stop at this station at all
// (the C via the D and F): shown like the overnight C, with the notice's end.
function lineAwayNote(stn, here, line, dir, svc, nowS) {
  if (here.some((x) => x.route === line && x.dir === dir && x.trains.some((t) => t.time >= nowS - 30))) return null;
  const g = nightGapState(stn.id, line, dir);
  if (g && (g.phase === 'night' || g.phase === 'countdown')) return null;
  const n = ((board && board.notices && board.notices.subway) || []).find((x) => !x.preview && happeningNow(x) && (x.lines || []).includes(line)
    && /reroute|suspend/i.test(x.type) && dirMatch(x, dir));
  if (!n) return null;
  if (lineSection(here, stn.id, line, dir) !== svc) return '';
  const u = untilText(n);
  const map = typeof changeModel === 'function' && changeModel(n) ? ` <button type="button" class="al-map" data-change="${esc(n.id)}">See map</button>` : '';
  return `<div class="none-row">${bulletHtml(line)}<span>No ${lineName(line)} trains at ${esc(stationName(stn.id))}${u ? ` ${esc(u)}` : ''}.${howHtml(suggestionHtml(stn, line, dir, here, nowS, n))}${map}</span></div>`;
}

// null: no suspension to show here (the usual messages apply).
function suspensionNote(stn, here, line, dir, svc, nowS) {
  const s = suspensionFor(stn.id, line, nowS);
  if (!s) return null;
  // A direction already off for the night by the timetable keeps its message.
  const g = nightGapState(stn.id, line, dir);
  if (g && g.phase === 'night') return null;
  if (lineSection(here, stn.id, line, dir) !== svc) return '';
  const label = lineName(line);
  const way = bothWaysOff(stn.id, line) || line === 'GS' ? '' : (dir === 'N' ? 'uptown ' : 'downtown ');
  // What to take instead: the advisory's own lines ("[2] makes [3] stops..."),
  // else the fastest way (suggestionHtml), on its own line.
  const how = suggestionHtml(stn, line, dir, here, nowS, s.n);
  const use = `.${how ? ` ${how}` : ''}`;
  const until = `until ${clockText(s.end)}`;
  // The last train before it starts (a late one still counts).
  const last = here.filter((x) => x.route === line && x.dir === dir).flatMap((x) => x.trains)
    .map((t) => t.time).filter((t) => t >= nowS - 30 && t <= s.start + 10 * 60).sort((a, b) => b - a)[0];
  if (last) return `<p class="svc-line night">${ICON.moon}<span><b>The last ${way}${label} train leaves at ${clockText(last)}, ${inText(last, nowS)}.</b> Then no ${way}${label} trains ${until}${use}</span></p>`;
  if (nowS < s.start) return `<p class="svc-line night">${ICON.moon}<span><b>No ${way}${label} trains from ${clockText(s.start)} ${until}</b>${use}</span></p>`;
  return `<div class="none-row">${bulletHtml(line)}<span>No ${way}${label} trains ${until}.${howHtml(how)}</span></div>`;
}

// Timetable minutes (after today's midnight, may pass 24:00) -> epoch seconds.
const minsToEpoch = (mins) => { const n = nyNow(); return Math.floor(Date.now() / 60000) * 60 - n.mins * 60 + mins * 60; };
// The live train that is the timetable's last one: the line's train in this
// direction (express or local, if given) closest to the scheduled time within
// 15 min, so the banner shows the same time and minutes as the row below it.
// Without a match, the timetable's time.
// The last train is the latest one: a train running late (up to an hour) or
// a little early still counts, and nothing scheduled after it can be listed.
function liveLast(groups, line, dir, svc, sched, nowS) {
  let best = null;
  for (const g of groups) {
    if (g.route !== line || g.dir !== dir || (svc && g.svc !== svc)) continue;
    for (const t of g.trains) if (t.time >= nowS - 30 && t.time >= sched - 10 * 60 && t.time <= sched + 60 * 60 && (!best || t.time > best)) best = t.time;
  }
  return best ?? sched;
}
// The same, but null when no live train matches.
function liveLastOnly(groups, line, dir, svc, sched, nowS) {
  const t = liveLast(groups, line, dir, svc, sched, nowS);
  return t === sched && !groups.some((g) => g.route === line && g.dir === dir && g.trains.some((x) => x.time === sched)) ? null : t;
}
// Each scheduled trip's time at Penn, by its live-feed id (subway-times.json,
// built by scripts/build-subway-data.py): to tell on-time trains from late ones.
let subwayTimes, subwayTimesLoading = null;
function loadSubwayTimes() {
  if (subwayTimes !== undefined || subwayTimesLoading) return;
  subwayTimesLoading = fetch('subway-times.json').then((r) => (r.ok ? r.json() : null)).catch(() => null).then((d) => {
    subwayTimes = null;
    if (d && d.penn) {
      subwayTimes = new Map();
      for (const [stn, ls] of Object.entries(d.penn)) for (const [line, ds] of Object.entries(ls)) for (const [dir, days] of Object.entries(ds)) for (const [day, list] of Object.entries(days)) {
        subwayTimes.set(`${stn}|${line}|${dir}|${day}`, new Map(list.split(',').map((x) => { const [c, m] = x.split(':'); return [c, +m]; })));
      }
    }
    subwayTimesLoading = null;
    if (board) renderSubway();
  });
}
// Seconds a train is behind its scheduled time at Penn (negative: early);
// null when it can't be matched to a scheduled trip.
function subwayLateBy(stnId, route, dir, x) {
  if (!subwayTimes || !x || !x.code) return null;
  let best = null;
  // Its service day: today's, yesterday's (trains after midnight) or tomorrow's.
  for (const off of [-1, 0, 1]) {
    const day = subSched(nyNow(off));
    const m = (subwayTimes.get(`${stnId}|${route}|${dir}|${day}`) || new Map()).get(x.code);
    if (m == null) continue;
    const diff = x.time - minsToEpoch(off * 1440 + m);
    if (Math.abs(diff) < 3 * 3600 && (best == null || Math.abs(diff) < Math.abs(best))) best = diff;
  }
  return best;
}
const subwayOnTime = (stnId, route, dir, x) => { const d = subwayLateBy(stnId, route, dir, x); return d != null && d <= ON_TIME_S; };
const clockText = (t) => { const c = clock(t); return `${c.hm} ${c.ap}`; };
const inText = (t, nowS) => { const m = Math.max(0, Math.round((t - nowS) / 60)); return m < 1 ? 'now' : `in ${m} min`; };
// Two or more late-night banners in one section become one box, each still
// counting down on its own line.
// Several lines starting daytime service in one section: one banner ("on the 2 and 3").
function mergeDayBanners(html) {
  const re = /<p class="svc-line">(<svg[^]*?<\/svg>)<span><b>Daytime service has started on the (.*?)\.<\/b><\/span><\/p>/g;
  const items = [...html.matchAll(re)];
  if (items.length < 2) return html;
  const names = [...new Set(items.map((m) => m[2]))];
  const list = names.length > 2 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names.join(' and ');
  let done = false;
  return html.replace(re, () => (done ? '' : ((done = true), `<p class="svc-line">${items[0][1]}<span><b>Daytime service has started on the ${list}.</b></span></p>`)));
}
function mergeNightBanners(html) {
  const re = new RegExp(`<p class="svc-line night">${ICON.moon.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}<span>(.*?)</span></p>`, 'g');
  const items = [...html.matchAll(re)].map((m) => m[1]);
  if (items.length < 2) return html;
  const rest = html.replace(re, '');
  return `<p class="svc-line night merged">${ICON.moon}<span>${items.map((x) => `<span class="nl">${x}</span>`).join('')}</span></p>${rest}`;
}

const LATE_PILL = `<span class="late-pill">${ICON.moon}Late night</span>`;
// Subway: the pill opens the MTA's late-night subway map in a new tab.
const MTA_NIGHT_MAP = 'https://www.mta.info/map/5336';
// A train still on the holiday's schedule after midnight, once the next day's
// service has begun (owner, Nov 26): the subway feed's trip ids start with the
// scheduled start, and the holiday's late trips start at 24:00 or later (144000+).
const HOLIDAY_PILL = `<span class="late-pill hol-pill">${'<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.6 6.6 19.5l1.2-6L3.3 9.3l6.1-.7z" fill="currentColor"/></svg>'}Holiday schedule</span>`;
const subHolidayTrip = (t) => !!(t && t.code && t.code >= '144000' && !subwayHoliday(nyNow().date) && subwayHoliday(nyNow(-1).date));
// A special schedule running today (owner, Nov 26: "every train under that
// schedule should have a holiday pill until the transition into late nite or
// the end of the holiday schedule … all special schedules like weather"):
// every daytime train gets the pill; a late-night train gets the late-night
// pill instead. Weather: while the MTA's severe-weather service notice is up.
const WX_PILL = `<span class="late-pill wx-pill">${'<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M11 2h2v4.2l3-1.7 1 1.7-4 2.3v2.3l2-1.2V7.3h2V11l2 1.1-1 1.8-2-1.2-2 1.2v2.3l4 2.3-1 1.7-3-1.7V22h-2v-4.2l-3 1.7-1-1.7 4-2.3v-2.3l-2 1.2V17H7v-3.7l-2-1.1 1-1.8 2 1.2 2-1.2V7.9L6 5.6l1-1.7 3 1.7z" fill="currentColor"/></svg>'}Severe weather schedule</span>`;
const holidayOn = (epoch) => subwayHoliday(nyDayAt(epoch).date) || (holidayNotice() && subwayHoliday(nyNow().date));
// Weekend service, the same way as a holiday (owner, Nov 26): Saturday and
// Sunday daytime trains, when the day isn't a holiday.
const WKND_PILL = `<span class="late-pill wknd-pill">${ICON.cal}Weekend schedule</span>`;
function specialPills(epoch, late) {
  // Severe weather: on every train, late-night ones too, all the time it's in
  // effect, to call out last-minute changes (owner, Nov 26).
  const wx = weatherNotice() ? WX_PILL : '';
  if (late) return wx;
  const day = nyDayAt(epoch).day;
  const sched = holidayOn(epoch) ? HOLIDAY_PILL : (day === 'saturday' || day === 'sunday') ? WKND_PILL : '';
  // (The holiday/weekend pill is wrapped: shown only while the hub is changing
  // over to or from late nights; see renderSubway.)
  return (sched ? `<span class="sp-pills">${sched}</span>` : '') + wx;
}
const SUB_LATE_PILL = `<a class="late-pill" href="${MTA_NIGHT_MAP}" target="_blank" rel="noopener" title="MTA late-night subway map (opens in a new tab)">${ICON.moon}Late night<span class="ext" aria-hidden="true">↗&#xFE0E;</span><span class="sr">, MTA late-night map, opens in a new tab</span></a>`;
// Trouble on a line (delays, skipped stops, reroutes): a pill on its rows.
// The notice itself, its map and other options are in the service notices.
const WARN_IC = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5 1.5 21h21zM11 9h2v6h-2zm0 8h2v2h-2z" fill="currentColor" fill-rule="evenodd"/></svg>';
const warnPill = (txt) => `<span class="late-pill warn-pill">${WARN_IC}${txt}</span>`;
// Pills that open a dropdown under the row with the railroad's own words
// (owner, Nov 23). dropPill makes the pill; pills() lays out a row's pills
// and adds the dropdown of any that are open.
const openDrops = new Set();
const dropBodies = new Map(); // pill key -> its dropdown, for this render
// The notice's own type, MTA style: "Planned - Express to Local" -> "Express to local".
const mtaType = (t) => { const x = String(t || '').replace(/^(Upcoming: )?Planned - /, ''); return x.charAt(0).toUpperCase() + x.slice(1).toLowerCase(); };
// When a notice ends: "5:00 AM", or "Mon 5:00 AM" on another day.
function untilText(n) {
  const nowS = Date.now() / 1000;
  const p = (n.periods || []).find(([a, b]) => a <= nowS + 60 && b > nowS);
  if (!p || !isFinite(p[1])) return '';
  const sameDay = new Date(p[1] * 1000).toLocaleDateString('en-US', { timeZone: 'America/New_York' }) === new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York' });
  const day = sameDay ? '' : `${new Date(p[1] * 1000).toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short' })} `;
  return `until ${day}${clockText(p[1])}`;
}
// A headline that leads into a list ("The following trains will make added
// stops at Elmont-UBS Arena tonight:") is shown with the list that follows it
// in the notice (owner, Nov 24: it was cut off).
const leadsIn = (n) => /(:|following[^.]*)\s*$/i.test(String(n.text || '').trim()) && String(n.desc || n.more || '').trim();
function noticeFull(n) {
  if (!leadsIn(n)) return noticeText(n.text);
  const rows = String(n.desc || n.more).split(/\n+/).map((x) => x.trim()).filter(Boolean)
    .map((x) => (/:$/.test(x) && x.length < 40 ? `<b>${noticeText(x)}</b>` : noticeText(x)));
  return `${noticeText(n.text)}<span class="n-more">${rows.join('<br>')}</span>`;
}
// Errors in plain words: a dropped connection is "the connection dropped", not
// "Failed to fetch"; anything else keeps the railroad's own message.
const plainError = (e) => (/failed to fetch|load failed|networkerror|network|aborted|timed? ?out|timeout/i.test(String(e)) ? ' (the connection dropped)' : `: ${esc(e)}`);
function dropPill(key, label, kind, ns, extra = '') {
  const open = openDrops.has(key);
  ns = ns.filter(Boolean);
  if (open) {
    const items = ns.map((n) => { const u = untilText(n); return `<span class="drop-n">${noticeFull(n)}${u ? `<small>${esc(u)}</small>` : ''}</span>`; }).join('');
    const link = ns.length ? `<button type="button" class="al-map" data-goto="${esc(ns[0].id)}">See full alert</button>` : '';
    dropBodies.set(key, `<span class="drop${kind === 'warn' ? '' : ' info'}">${items}<span class="drop-links">${link}${extra}</span></span>`);
  }
  const cls = kind === 'warn' ? 'warn-pill' : 'info-pill';
  return `<button type="button" class="late-pill ${cls}" data-drop="${esc(key)}" aria-expanded="${open}">${kind === 'warn' ? WARN_IC : ''}${esc(label)}<span class="chev" aria-hidden="true">${open ? '▾' : '▸'}</span></button>`;
}
const pills = (...ps) => {
  const h = ps.filter(Boolean).join('');
  if (!h) return '';
  const drops = [...h.matchAll(/data-drop="([^"]+)"/g)].map((m) => m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&')).filter((k) => openDrops.has(k)).map((k) => dropBodies.get(k) || '').join('');
  return `<span class="pills">${h}</span>${drops}`;
};
// Inside a row that is itself a button, pills can't be buttons.
const staticPills = (h) => h.replace(/<button([^>]*)>/g, '<span$1>').replace(/<\/button>/g, '</span>').replace(/data-drop=/g, 'data-x=');
// The "Delays" pill comes off a train that is running on time (within
// ON_TIME_S of its scheduled time at Penn); a train we can't match to the
// timetable keeps it.
const ON_TIME_S = 180;
// Trial toggle (owner, Nov 20): "All late trains" also gives a pill to a
// train running LATE_PILL_MIN or more behind its timetable with no advisory.
const LATE_PILL_MIN = 5;
let allLatePills = false;
try { allLatePills = localStorage.getItem('subwayLatePills') === 'all'; } catch {}
function subwayDelayPill(route, dir, stnId, train) {
  const ds = subwayDelays(route, dir);
  // (An open dropdown stays while its notice does, even when the row turns to an on-time train.)
  const key = `${stnId}|${route}|${dir}|delays`;
  if (ds.length) return subwayOnTime(stnId, route, dir, train) && !openDrops.has(key) ? '' : dropPill(key, 'Delays', 'warn', ds);
  if (!allLatePills) return '';
  const late = subwayLateBy(stnId, route, dir, train);
  return late != null && late >= LATE_PILL_MIN * 60 ? warnPill(`${Math.round(late / 60)} min late`) : '';
}
// Subway notices on a line's rows, each pill named with the MTA's own type.
const subNotices = (route, dir, re) => ((board && board.notices && board.notices.subway) || []).filter((n) => happeningNow(n) && (n.lines || []).includes(route) && re.test(n.type) && dirMatch(n, dir));
function subwayPills(route, dir, svc, stnId, train) {
  const k = (x) => `${stnId}|${route}|${dir}|${x}`;
  const sw = subwayExpressSwitch(route, dir);
  const e2l = subNotices(route, dir, /express to local/i);
  const red = subNotices(route, dir, /reduced service/i);
  // The pill says what the MTA calls it (owner, Nov 24); a notice already on
  // the switch pill isn't shown again as a second pill.
  const swIds = new Set(svc === 'local' ? sw.map((n) => n.id) : []);
  const skip = subNotices(route, dir, /stops skipped/i).filter((n) => !swIds.has(n.id) && !e2l.includes(n));
  return subwayDelayPill(route, dir, stnId, train)
    + (svc === 'local' && sw.length ? dropPill(k('switch'), mtaType(sw[0].type), 'warn', sw, skipMapBtn(sw)) : '')
    + (e2l.length ? dropPill(k('e2l'), 'Express to local', 'info', e2l) : '')
    + (skip.length ? dropPill(k('skip'), 'Stops skipped', 'warn', skip, skipMapBtn(skip)) : '')
    + (red.length ? dropPill(k('reduced'), 'Reduced service', 'info', red) : '')
    + changePill(route, dir, k('change'));
}
// Part of the line suspended or rerouted (storms, flooding, track work): a
// pill on the line's rows at the hub, named as the MTA does ("Part
// suspended", "Reroute"), with its map (owner, Nov 26).
// A notice naming no direction, about a stretch on one side of the hub (no 1
// trains above 96 St): only trains heading into that stretch, whatever the hub.
function headsInto(n, route, dir, stnId) {
  const m = changeModel(n);
  const ends = subwayData && subwayData.terminals && subwayData.terminals[route];
  if (!m || m.whole || !ends || !subwayData.stops[stnId] || noticeDir(n)) return true;
  // Which side of the hub each closed station is on, along the line's axis
  // from its southern to its northern end (km east and north).
  const here = LL(stnId);
  const at = (d) => { const ts = (ends[d] || []).filter((t) => subwayData.stops[t]).map(LL); return ts.length ? [ts.reduce((a, t) => a + t[0], 0) / ts.length, ts.reduce((a, t) => a + t[1], 0) / ts.length] : null; };
  const tn = at('N'), ts = at('S');
  if (!tn || !ts) return true;
  const ax = [(tn[0] - ts[0]) * 111, (tn[1] - ts[1]) * 84];
  return [...m.closed].filter((id) => subwayData.stops[id]).some((id) => {
    const x = LL(id);
    if (kmLL(x, here) < 0.3) return true; // the stretch includes the hub itself
    const side = (x[0] - here[0]) * 111 * ax[0] + (x[1] - here[1]) * 84 * ax[1];
    return dir === 'N' ? side > 0 : side < 0;
  });
}
function changePill(route, dir, key) {
  const stnId = key.split('|')[0];
  const ns = subNotices(route, dir, CHANGE_TYPES).filter((n) => !isSwitchNotice(n) && headsInto(n, route, dir, stnId));
  if (!ns.length) return '';
  const m = ns.map(changeModel).find(Boolean);
  return dropPill(key, mtaType(ns[0].type), 'warn', ns, m ? `<button type="button" class="al-map" data-change="${esc(m.n.id)}">See map</button>` : '');
}
// "See map" in a skipped-stops dropdown, when the notice names the stations,
// and the buses to those stations (below).
const skipMapBtn = (ns) => { const n = ns.find((x) => changeModel(x)); const m = n && changeModel(n); return n ? `<button type="button" class="al-map" data-change="${esc(n.id)}">See map</button>${m.skip ? skipBusHtml(m) : ''}` : ''; };

// ---------- buses to skipped stops (MTA Bus Time) ----------
// When trains skip stations, each skipped station gets the quickest MTA bus
// from the station either side of the skipped stretch (owner, Nov 24).
// docs/subway-bus-links.json (scripts/build-subway-bus-links.py) has the bus
// links between nearby stations; live times come from the relay's
// /mta-bus-stop (MTA Bus Time, key kept on the relay).
let subwayBusLinks;        // undefined: not loaded; null: couldn't load
let busLinksLoading = null;
const mtaBusLive = new Map(); // stop code -> { at, buses } | { at, error } | { loading }
function loadBusLinks() {
  if (subwayBusLinks !== undefined || busLinksLoading) return;
  busLinksLoading = fetch('subway-bus-links.json').then((r) => (r.ok ? r.json() : null)).catch(() => null)
    .then((d) => { subwayBusLinks = d; busLinksLoading = null; refreshSkipBuses(); });
}
function loadMtaBusStop(stop) {
  const c = mtaBusLive.get(stop);
  if (!window.PENN_RELAY || (c && (c.loading || Date.now() - c.at < 30000))) return;
  mtaBusLive.set(stop, { ...(c || {}), loading: true });
  fetch(`${window.PENN_RELAY}/mta-bus-stop?stop=${encodeURIComponent(stop)}`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status))))
    .then((d) => mtaBusLive.set(stop, { at: Date.now(), buses: d.buses || [] }))
    .catch(() => mtaBusLive.set(stop, { at: Date.now(), error: true }))
    .finally(() => { refreshSkipBuses(); if (changeOpen && changeOpen.id === 'airport' && $('change').open) renderAirport(); });
}
// Each skipped station's best bus: from the open station just before or just after the skipped stretch.
function skipBusPlan(model) {
  const ids = subwayData.routes[model.route].normal.filter((id) => subwayData.stops[id]);
  const idx = [...model.closed].map((id) => ids.indexOf(id)).filter((i) => i >= 0);
  if (!idx.length || !subwayBusLinks) return [];
  const ends = [ids[Math.min(...idx) - 1], ids[Math.max(...idx) + 1]].filter((id) => id && !model.closed.has(id));
  return ids.filter((id) => model.closed.has(id)).map((id) => {
    const opts = ends.flatMap((e) => (subwayBusLinks[`${e}|${id}`] || []).map((o) => ({ ...o, end: e })));
    opts.sort((a, b) => (a.t + (a.gap || 10) / 2) - (b.t + (b.gap || 10) / 2));
    return { id, opt: opts[0] || null };
  });
}
// Subway first (owner, Nov 24): the MTA's own advice in the notice, or other
// lines at the skipped station; a bus only for stations with neither.
function skipBusHtml(model) {
  const key = `data-skipbus="${esc(model.n.id)}"`;
  if (model.alt && model.alt.text) return `<div class="skip-bus" ${key}><span class="sb-h">Getting to the skipped stops</span><div class="sb-mta">${mtaTextHtml(model.alt.text)}</div></div>`;
  const otherLines = (id) => [...stationLines(id)].filter((l) => l !== model.route);
  const byTrain = [...model.closed].filter((id) => subwayData.stops[id] && otherLines(id).length);
  const trainHtml = byTrain.map((id) => `<li><b>${esc(stationName(id))}</b><span>Take the ${otherLines(id).map((l) => bulletHtml(l, 'tiny')).join(' ')} instead</span></li>`).join('');
  if (byTrain.length === [...model.closed].filter((id) => subwayData.stops[id]).length) return trainHtml ? `<div class="skip-bus" ${key}><span class="sb-h">Getting to the skipped stops</span><ul>${trainHtml}</ul></div>` : '';
  loadBusLinks();
  if (subwayBusLinks === undefined) return `<div class="skip-bus" ${key}><span class="sb-h">Getting to the skipped stops</span>${trainHtml ? `<ul>${trainHtml}</ul>` : ''}<span class="sb-dim">Finding buses…</span></div>`;
  const plan = skipBusPlan(model).filter((x) => !byTrain.includes(x.id));
  if (!plan.some((x) => x.opt)) return trainHtml ? `<div class="skip-bus" ${key}><span class="sb-h">Getting to the skipped stops</span><ul>${trainHtml}</ul></div>` : '';
  const nowMs = Date.now();
  // Stations reached by the same bus from the same stop share one line.
  const groups = [];
  for (const { id, opt } of plan) {
    const g = opt && groups.find((x) => x.opt && x.opt.from === opt.from && x.opt.r === opt.r);
    if (g) { g.ids.push(id); g.rides.push(opt.ride); } else groups.push({ ids: [id], opt, rides: opt ? [opt.ride] : [] });
  }
  const items = groups.map(({ ids: gi, opt, rides }) => {
    const names = gi.map((id) => esc(stationName(id))).join(', ');
    if (!opt) return `<li><b>${names}</b><span class="sb-dim">No bus nearby</span></li>`;
    loadMtaBusStop(opt.from);
    const live = mtaBusLive.get(opt.from);
    const buses = live && live.buses ? live.buses.filter((b) => String(b.line).toUpperCase() === opt.r.toUpperCase() && b.at)
      .map((b) => ({ m: Math.round((Date.parse(b.at) - nowMs) / 60000), late: b.aimed ? Math.round((Date.parse(b.at) - Date.parse(b.aimed)) / 60000) : 0 }))
      .filter((b) => b.m >= 0).sort((a, b) => a.m - b.m).slice(0, 2) : null;
    const next = buses ? buses.map((b) => b.m) : null;
    // Late by MTA Bus Time's own schedule (2+ min).
    const lateTxt = buses && buses[0] && buses[0].late >= 2 ? ` <span class="bus-late">${buses[0].late} min late</span>` : '';
    const when = next && next.length ? `<span class="sb-live">next ${next[0] === 0 ? 'now' : `in ${next[0]} min`}${next[1] != null ? `, ${next[1]}` : ''}</span>${lateTxt}`
      : next ? '<span class="sb-dim">none due soon</span>' : opt.gap ? `<span class="sb-dim">about every ${opt.gap} min</span>` : '';
    const lo = Math.min(...rides), hi = Math.max(...rides);
    return `<li><b>${names}</b><span>Get off at ${esc(stationName(opt.end))}, then the <span class="pl p-mtabus">${esc(opt.r)}</span> (${lo === hi ? lo : `${lo}–${hi}`} min ride) · ${when}</span></li>`;
  }).join('');
  return `<div class="skip-bus" ${key}><span class="sb-h">Getting to the skipped stops</span><ul>${trainHtml}${items}</ul><span class="sb-dim">No other subway line stops at ${byTrain.length ? 'the rest' : 'these'}, so here are buses. Live times from MTA Bus Time.</span></div>`;
}
function refreshSkipBuses() {
  document.querySelectorAll('[data-skipbus]').forEach((el) => {
    const m = changeModels().find((x) => x.n.id === el.dataset.skipbus);
    if (m) el.outerHTML = skipBusHtml(m) || '<span></span>';
  });
}
// A reroute pill, with the notice behind it (and its map) when there is one.

// PATH's late-night service: the hours when weekday trains from 33 St run to
// Journal Square via Hoboken (about 11 PM to 6 AM). PATH trains leaving in
// those hours get the pill on any day; weekend daytime via-Hoboken trains are
// the weekend pattern, not late night.
// PATH's day and late-night patterns from 33 St, per day, from PATH's
// timetable: direct Journal Square trains by day, Journal Square via Hoboken
// late at night (weekdays about 10:40 PM to 6 AM; weekends 9 PM to 10 AM).
// Which of PATH's timetables runs on a day. On the major holidays (New Year's,
// Memorial Day, July 4, Labor Day, Thanksgiving, Christmas) PATH runs a holiday
// schedule close to its weekend one (Nov 26: Thanksgiving's trains matched the
// weekend times; measured against the weekday timetable they looked late all
// night, and the banner said direct Journal Square trains started at 6 AM).
const pathKey = (d) => (subwayHoliday(d.date) ? 'sunday' : d.day);
function pathDay(day) {
  const list = pathSchedule && pathSchedule.days && pathSchedule.days[day];
  if (!list) return null;
  const direct = list.filter((d) => d.to === 'Journal Square').map((d) => d.t);
  const via = list.filter((d) => /via/i.test(d.to)).map((d) => d.t);
  if (!direct.length || !via.length) return null;
  const lastDirect = Math.max(...direct);
  const viaAfter = via.filter((t) => t > lastDirect);
  const firstDirect = Math.min(...direct);
  const viaBefore = via.filter((t) => t < firstDirect);
  return {
    firstDirect,
    // The last via-Hoboken train of the night, before direct trains resume.
    lastNight: viaBefore.length ? Math.max(...viaBefore) : null,
    lastDirect,
    nightStart: viaAfter.length ? Math.min(...viaAfter) : null, // first via-Hoboken train of the night
  };
}
// Where PATH stands now: 'countdown' (last direct train within the hour),
// 'night' (no direct Journal Square trains until morning) or 'day'.
function pathState() {
  const now = nyNow(), T = pathDay(pathKey(now));
  if (!T) return null;
  const m = now.mins;
  // Morning: late-night service lasts until its last train via Hoboken has
  // left, not until the first direct train (live PATH data, when there is
  // some, says so sooner: no via-Hoboken trains left in it).
  if (m < T.firstDirect) {
    const nearEnd = T.lastNight == null || m >= T.lastNight - 60;
    const live = nearEnd && board && board.path && board.path.length ? board.path : null;
    const viaLeft = live ? live.some((x) => /via/i.test(x.dest || '')) : true;
    if (!viaLeft || (T.lastNight != null && m > T.lastNight)) return { phase: 'day' };
    return { phase: 'night', until: T.firstDirect };
  }
  // Still counting down while the last direct train, running late, hasn't left.
  if (m > T.lastDirect && livePathLast(T.lastDirect)) return { phase: 'countdown', lastDirect: T.lastDirect, nightStart: T.nightStart, left: 0 };
  if (m > T.lastDirect) {
    const N = pathDay(pathKey(nyNow(1)));
    return { phase: 'night', until: N ? N.firstDirect : T.firstDirect };
  }
  if (m >= T.lastDirect - 60) return { phase: 'countdown', lastDirect: T.lastDirect, nightStart: T.nightStart, left: T.lastDirect - m };
  return { phase: 'day' };
}
// PATH's late-night trains, per line (Journal Square, direct or via Hoboken;
// Hoboken), from its timetable: trains 16+ min apart are the night pattern
// (PATH's normal evening service is every 15). 'to' is the first morning
// train that's part of frequent service again; 'from' the first evening train
// of the night pattern. A live train is matched to its scheduled departure,
// so a late-running night train keeps its pill until it leaves.
const PATH_NIGHT_GAP = 16;
const pathLine = (dest) => (/journal/i.test(dest) ? 'JSQ' : /hoboken/i.test(dest) ? 'HOB' : dest);
const pathNightCache = new Map();
function pathNightWindow(day, line) {
  const key = `${day}|${line}`;
  if (pathNightCache.has(key)) return pathNightCache.get(key);
  const list = ((pathSchedule && pathSchedule.days[day]) || []).filter((d) => pathLine(d.to) === line).map((d) => d.t).sort((a, b) => a - b);
  const morning = list.filter((t) => t < 720), evening = list.filter((t) => t >= 720);
  let to = 720;
  for (let i = 0; i < morning.length; i++) {
    const t = morning[i], prev = morning[i - 1], next = morning[i + 1];
    // Frequent again: soon after the train before; or, for a line's first
    // train of the day (Hoboken), soon before the next one.
    const firstOfDay = prev == null || t - prev > 180;
    if (t >= 180 && ((!firstOfDay && t - prev < PATH_NIGHT_GAP) || (firstOfDay && next != null && next - t < PATH_NIGHT_GAP))) { to = t; break; }
  }
  const night = [...evening, ...morning.filter((t) => t < to).map((t) => t + 1440)];
  let from = null;
  for (let i = night.length - 1; i > 0; i--) {
    if (night[i] - night[i - 1] < PATH_NIGHT_GAP) break;
    from = night[i] % 1440;
  }
  const w = { from, to, times: list };
  pathNightCache.set(key, w);
  return w;
}
function pathLateNight(dest, epoch) {
  if (!pathSchedule) return false;
  const at = nyDayAt(epoch), day = pathKey(at), mins = at.mins;
  const W = pathNightWindow(day, pathLine(dest));
  // The scheduled departure this train is (closest within 8 min), else its own time.
  const near = W.times.reduce((best, t) => (Math.abs(t - mins) < Math.abs(best - mins) ? t : best), Infinity);
  const m = Math.abs(near - mins) <= 8 ? near : mins;
  if (m < 12 * 60 && m < W.to) {
    const Y = pathNightWindow(pathKey(nyDayAt(epoch - 86400)), pathLine(dest));
    return Y.from == null ? false : Y.from >= 720 || m >= Y.from;
  }
  return W.from != null && W.from >= 720 && m >= W.from;
}
// The live PATH train that is the timetable's last direct Journal Square one
// (the latest direct JSQ train from 10 min before to an hour after its time),
// and the first via-Hoboken train of the night; null if not in PATH's data.
function livePathLast(schedMins) {
  const nowS = Date.now() / 1000, sched = minsToEpoch(schedMins);
  let best = null;
  for (const x of (board && board.path) || []) {
    if (!/journal/i.test(x.dest || '') || /via/i.test(x.dest || '')) continue;
    if (x.time >= nowS - 30 && x.time >= sched - 600 && x.time <= sched + 3600 && (!best || x.time > best)) best = x.time;
  }
  return best;
}
function livePathFirstVia(schedMins) {
  const nowS = Date.now() / 1000, sched = minsToEpoch(schedMins);
  let best = null;
  for (const x of (board && board.path) || []) {
    if (!/via/i.test(x.dest || '')) continue;
    if (x.time >= nowS - 30 && x.time >= sched - 600 && x.time <= sched + 3600 && (!best || x.time < best)) best = x.time;
  }
  return best;
}

// Tags beside the PATH heading, and what goes above the train rows.
function renderPathPattern() {
  const st = pathState();
  const tags = [];
  const day = nyNow().day;
  // Late night or weekend, not both (owner: keep the two patterns distinct).
  if (st && st.phase === 'night') tags.push(`<span class="tag night">${ICON.moon}Late-night service</span>`);
  else if (day === 'saturday' || day === 'sunday') tags.push(`<span class="tag wknd">${ICON.cal}Weekend service</span>`);
  $('path-h').innerHTML = `PATH${tags.join('')}<span>33 St station, Sixth Av at 32 St</span>`;
  if (!st) return '';
  if (st.phase === 'countdown') {
    // Live times where PATH has them, so the banner agrees with the rows below.
    const nowS = Date.now() / 1000;
    const last = livePathLast(st.lastDirect) ?? minsToEpoch(st.lastDirect);
    const via = st.nightStart != null ? (livePathFirstVia(st.nightStart) ?? minsToEpoch(st.nightStart)) : null;
    const starts = via != null ? `Late-night service starts at ${clockText(via)}. ` : '';
    const left = Math.max(0, Math.round((last - nowS) / 60));
    return `<p class="svc-line night">${ICON.moon}<span>${starts}<b>The last direct Journal Square train leaves ${left < 1 ? 'now' : `in ${left} min`}</b>, at ${clockText(last)}.</span></p>`;
  }
  if (st.phase === 'night') {
    const dots = '<span class="pdots" aria-hidden="true" style="opacity:.35"><i style="background:#ff9900"></i></span>';
    return `<div class="none-row">${dots}<span>No direct Journal Square trains late nights. Trains run to Journal Square via Hoboken until ${fmtClock(st.until)}.</span></div>`;
  }
  return '';
}

// All of a line's trains in one direction and service (express or local)
// share one row, whatever their last stop: Far Rockaway, Lefferts Blvd, a
// short trip to Euclid Av, or a service change like A to Chambers St. When
// they go to more than one place, the row takes turns (see renderSubway).
// ...except when any of those trains is rerouted: then the turning stops and
// each destination gets its own still row, so a rerouted one can show
// "Rerouted, see map".
function mergeScheduled(groups) {
  const out = [], merged = new Map();
  const rerouted = new Set(groups.filter((g) => g.trains.some((t) => unusualStops(g.route, t).length)).map((g) => `${g.route}|${g.dir}|${g.svc}`));
  for (const g of groups) {
    const k = `${g.route}|${g.dir}|${g.svc}`;
    if (rerouted.has(k)) { out.push(g); continue; }
    if (!merged.has(k)) { const m = { ...g, scheduled: true, trains: [] }; merged.set(k, m); out.push(m); }
    merged.get(k).trains.push(...g.trains);
  }
  for (const m of merged.values()) m.trains.sort((a, b) => a.time - b.time);
  return out;
}
// The destination name, sliding to the next one when it changes (the row's
// next train now goes somewhere else).
const destShown = new Map();
const minsShown = new Map(); // what each row's times showed, to slide out on a turn
const ROTATE_MS = 8000;      // how long each end of the line shows
let subwayTurning = false;   // a row is taking turns (redraw on each turn)
const turnCycles = new Map(); // row -> { order of its ends, turn it started on }
// `alts`: every name this row takes turns between. Each sits invisibly in the
// same spot, so the row is always as tall as its longest name and doesn't grow
// and shrink as it turns (owner, Nov 26: "Ozone Park-Lefferts Blvd" moved the
// Times Square board on every turn).
function destName(key, name, extra = '', alts = []) {
  const html = esc(name) + extra;
  const before = destShown.get(key);
  destShown.set(key, html);
  const size = alts.length > 1 ? alts.map((a) => `<span class="dname-size" aria-hidden="true">${esc(a)}${extra}</span>`).join('') : '';
  if (before === undefined || before === html) return `<span class="dname"><span>${html}</span>${size}</span>`;
  slideStarted = performance.now();
  return `<span class="dname changing"><span class="out" aria-hidden="true">${before}</span><span class="in">${html}</span>${size}</span>`;
}

// ---------- subway rows, option B (trial) ----------
// A row with trains to more than one place lists each place with its next
// times (up to 3), in order of the next train. It stays still: no switching.
let subwayStyle = 'turns';
try { subwayStyle = localStorage.getItem('subwayStyle') === 'b' ? 'b' : 'turns'; } catch {}
const bShown = new Map(); // row -> what it showed last, to slide from
function optionBRow(g, stn, dir, upcoming, ends, arriving, nowS) {
  const key = `${stn.id}|${g.route}|${dir}|${g.svc}|B`;
  const c = turnCycles.get(key), order = ends.join(','), turnNow = Math.floor(Date.now() / ROTATE_MS);
  if (!c || c.order !== order) turnCycles.set(key, { order, from: turnNow });
  const phase = 2; // (owner, Nov 19: just the list, no switching or animation)
  const linePills = subwayPills(g.route, dir, g.svc, stn.id, upcoming[0]);
  const name = (id) => stationName(id) || id;
  const lastOf = (x) => `${x.stops[x.stops.length - 1]}${x.diamond ? '|d' : ''}`;
  const anyDiamond = upcoming.some((x) => isDiamond(g, x));
  const pill = lateNightTrain(stn.id, g.route, dir, upcoming[0].time, upcoming[0].code) || localNight(stn.id, g, dir, upcoming[0].time) || cutbackNight(stn.id, g.route, dir, upcoming[0].time) ? SUB_LATE_PILL : '';
  let html;
  if (phase === 1) {
    html = `<span class="b-dests">${ends.map((e) => esc(name(e))).join('<span class="sep"> · </span>')}${pills(pill, linePills)}</span>`;
  } else {
    html = `<span class="b-times">${ends.map((e, k) => {
      const mine = upcoming.filter((x) => lastOf(x) === e);
      const ts = mine.slice(0, 3).map((x) => Math.max(0, Math.round((x.time - nowS) / 60)));
      const first = ts[0] === 0 ? '<b class="now">now</b>' : `<b>${ts[0]}</b> min`;
      // Late-night pill by this destination's next train.
      const lateB = !!(lateNightTrain(stn.id, g.route, dir, mine[0].time, mine[0].code) || localNight(stn.id, g, dir, mine[0].time) || cutbackNight(stn.id, g.route, dir, mine[0].time));
      const p = (lateB ? SUB_LATE_PILL : '') + (subHolidayTrip(mine[0]) ? HOLIDAY_PILL : specialPills(mine[0].time, lateB));
      // A row with diamond trains marks each end with its own small bullet.
      const mark = anyDiamond ? bulletHtml(g.route, `tiny${isDiamond(g, mine[0]) ? ' diamond' : ''}`) + ' ' : '';
      return `<span class="b-row"><span>${mark}${esc(name(e.split('|')[0]))}${diamondNote(g, mine[0])}${pills(p, subwayPills(g.route, dir, g.svc, stn.id, mine[0]))}</span><span class="smins">${first}${ts.length > 1 ? `, ${ts.slice(1).join(', ')}` : ''}</span></span>`;
    }).join('')}</span>`;
  }
  const before = bShown.get(key);
  bShown.set(key, html);
  const body = `<span class="b-wrap">${html}</span>`;
  return `<div class="sline optb" data-k="${esc(`${stn.id}|${g.route}|${dir}|${g.svc}|b`)}">${rowBullet(g, upcoming[0])}${body}</div>`;
}
$('sub-toggles').addEventListener('click', (e) => {
  const lp = e.target.closest('[data-latepills]');
  if (lp) {
    allLatePills = lp.dataset.latepills === 'all';
    try { localStorage.setItem('subwayLatePills', allLatePills ? 'all' : 'advisory'); } catch {}
    slideStarted = -Infinity; renderSubway(); renderPath();
    return;
  }
  const b = e.target.closest('[data-sstyle]');
  if (!b) return;
  subwayStyle = b.dataset.sstyle;
  try { localStorage.setItem('subwayStyle', subwayStyle); } catch {}
  bShown.clear(); slideStarted = -Infinity; renderSubway();
});
const subwayStyleHtml = () => `<div class="sub-style"><span>Rows with more than one destination</span><div class="style-seg">
  <button type="button" data-sstyle="turns" aria-pressed="${subwayStyle === 'turns'}">Take turns</button><button type="button" data-sstyle="b" aria-pressed="${subwayStyle === 'b'}">All destinations</button></div></div>
  <div class="sub-style"><span>Delay pills</span><div class="style-seg">
  <button type="button" data-latepills="advisory" aria-pressed="${!allLatePills}">With advisories</button><button type="button" data-latepills="all" aria-pressed="${allLatePills}">All late trains</button></div></div>`;

let subwayShown = [];      // the groups drawn, so a tap can find its train
const DIRS = HUB.dirs; // each hub's stations and how their directions are named (docs/hub.js)
// The panel is redrawn often (new data, the 10 s tick, each turn). Redrawing
// while a destination is sliding would cut the slide short and make it jump,
// so a redraw that comes mid-slide waits until the slide has finished.
const SLIDE_MS = 1000; // .dname slide: .75 s out, .8 s in after .15 s
let slideStarted = -Infinity, slideWait = 0;
// Rows and sections never shrink back between refreshes (owner, Nov 26: "still
// so much movement" at Penn and Times Square): each keeps the tallest height it
// has had, so a pill, a wrapped name or a time changing inside it can't make
// everything under it bounce. Forgotten when the window, the layout or the
// subway style changes, and every 15 minutes (one settle, not constant motion).
const rowMax = new Map();
let rowMaxKey = '', rowMaxAt = 0;
function holdHeights(root) {
  if (!root) return;
  const key = `${innerWidth}x${innerHeight}|${document.body.className}|${subwayStyle}|${flipMode}`;
  if (key !== rowMaxKey || Date.now() - rowMaxAt > 15 * 60000) { rowMax.clear(); rowMaxKey = key; rowMaxAt = Date.now(); }
  const els = [...root.querySelectorAll('[data-k]')];
  for (const el of els) { const m = rowMax.get(el.dataset.k); if (m) el.style.minHeight = `${m}px`; }
  for (const el of els) {
    const h = el.offsetHeight, m = rowMax.get(el.dataset.k) || 0;
    if (h > m) { rowMax.set(el.dataset.k, h); el.style.minHeight = `${h}px`; }
  }
}
function renderSubway() {
  if (!board) return;
  const busy = SLIDE_MS - (performance.now() - slideStarted);
  if (busy > 0) {
    if (!slideWait) slideWait = setTimeout(() => { slideWait = 0; renderSubway(); }, busy + 20);
    return;
  }
  loadSubwayData();
  loadSubwayTimes();
  loadSubwayGuide();
  if (!board.subway.length) {
    $('subway').innerHTML = `<p class="empty">${board.sources.subway.error ? 'Subway times didn’t load. Trying again shortly.' : 'No subway trains reported right now.'}</p>`;
    // The heading's tags still say which service is running.
    renderSubwayTags(HUB.stations.flatMap((stn) => stn.lines.flatMap((line) => ['N', 'S'].map((dir) => switchState(stn.id, line, dir)))).filter(Boolean));
    return;
  }
  const nowS = Date.now() / 1000;
  subwayShown = [];
  subwayTurning = false;
  // Each direction splits into express and local, by how each train is
  // actually running from Penn (night service and reroutes included).
  const SVC = { express: 'Express', local: 'Local' };
  // Two separate stations: the 7 Av line (1 2 3) and the 8 Av line (A C E).
  // A train belongs to the station it calls at, so a rerouted train lands
  // in the right box.
  const STATIONS = HUB.stations;
  const states = [];
  $('subway').innerHTML = STATIONS.map((stn) => {
  const here = mergeScheduled(board.subway.filter((g) => (g.trains[0] && g.trains[0].stops ? g.trains[0].stops[0] : '') === stn.id));
  const dirs = ['N', 'S'].map((dir) => {
    // Lines at this station that switch between express and local, and where
    // each stands right now.
    const switching = stn.lines.map((line) => ({ line, st: switchState(stn.id, line, dir) })).filter((x) => x.st);
    for (const x of switching) {
      // The first daytime express showing "now" at Penn ends the morning.
      if (x.st.phase === 'morning' && (morningArrived(x.st.key, here, x.line, dir, 'express', nowS) || firstMorningGone(here, x.line, dir, 'express', x.st.until, nowS))) {
        morningReached.add(x.st.key);
        x.st = switchState(stn.id, x.line, dir);
      }
      states.push(x.st);
    }
    const parts = ['express', 'local'].map((svc) => {
    let notes = '';
    // A line that isn't running late at night says which train to take.
    const gaps = stn.lines.map((line) => {
      // A notice suspending the line here (the overnight 3): count down to its
      // last train, then point to the line the advisory names.
      const sus = suspensionNote(stn, here, line, dir, svc, nowS);
      if (sus !== null) return sus;
      const away = lineAwayNote(stn, here, line, dir, svc, nowS);
      if (away !== null) return away;
      let g = nightGapState(stn.id, line, dir);
      // The first morning train showing "now" at Penn ends "Daytime service has started".
      if (g && g.phase === 'morning' && (morningArrived(g.key, here, line, dir, null, nowS) || firstMorningGone(here, line, dir, g.svc, g.until, nowS))) {
        morningReached.add(g.key);
        g = nightGapState(stn.id, line, dir);
      }
      if (g && g.phase === 'morning' && g.svc === svc) return `<p class="svc-line">${ICON.sun}<span><b>Daytime service has started on the ${lineName(line)}.</b></span></p>`;
      if (!g && windowMorning(stn, line, dir, svc, here, nowS)) return `<p class="svc-line">${ICON.sun}<span><b>Daytime service has started on the ${lineName(line)}.</b></span></p>`;
      // "The last C train leaves at 10:34 PM, in 25 min." / "The last downtown 3 train..."
      // The last train running late: keep counting down until it has left.
      const lateLast = g && g.phase === 'night' && g.svc === svc
        ? liveLastOnly(here, line, dir, null, minsToEpoch(g.after - (nyNow().mins < 720 ? 1440 : 0)), nowS) : null;
      if (g && ((g.phase === 'countdown' && g.svc === svc) || lateLast)) {
        const way = bothWaysOff(stn.id, line) || line === 'GS' ? '' : (dir === 'N' ? 'uptown ' : 'downtown ');
        const t = lateLast ?? liveLast(here, line, dir, null, minsToEpoch(g.after), nowS);
        return `<p class="svc-line night">${ICON.moon}<span><b>The last ${way}${lineName(line)} train leaves at ${clockText(t)}, ${inText(t, nowS)}.</b> No ${way}${lineName(line)} trains late nights.</span></p>`;
      }
      if (g && g.phase === 'countdown') return '';
      // Still in the overnight gap while the only trains listed are the first
      // morning ones (the shuttle's 6:04 AM shows up hours ahead).
      const gapEnd = g && g.phase === 'night' ? minsToEpoch(g.until + (nyNow().mins >= 720 ? 1440 : 0)) : Infinity;
      if (!g || g.svc !== svc || here.some((x) => x.route === line && x.dir === dir && x.trains.some((t) => t.time >= nowS - 30 && t.time < gapEnd - 120))) return '';
      // The other lines at this station still running this way (C: A or E; 3: 1 or 2).
      // The shuttle: the 7 makes the same trip, one stop between Times Sq and
      // Grand Central (owner, Nov 26: "advise people to take the 7").
      const how = line === 'GS' ? `Take the ${routesText(['7'])} to ${esc(shortStop((HUB.dirs[stn.id] || {})[dir] || 'Grand Central'))} until the first shuttle.` : suggestionHtml(stn, line, dir, here, nowS, null);
      const way = dir === 'N' ? 'uptown' : 'downtown';
      const label = lineName(line);
      // Short: "No C trains until 5:41 AM, use the A or E." A line not running
      // either way gets no direction; when only one direction stops (the 3
      // ends at Penn), say which.
      const oneWay = !bothWaysOff(stn.id, line) && line !== 'GS'; // (the shuttle has no uptown or downtown)
      const say = oneWay
        ? `No ${label} trains ${way} until ${fmtClock(g.until)}.${howHtml(how)}`
        : `No ${label} trains until ${fmtClock(g.until)}.${howHtml(how)}`;
      return `<div class="none-row">${bulletHtml(line)}<span>${say}</span></div>`;
    }).join('');
    if (svc === 'express') {
      // Other lines still running express in this direction (the 3 uptown, late at night).
      const otherExpress = (line) => here.some((g) => g.route !== line && g.dir === dir && g.svc === 'express' && g.trains.some((t) => t.time >= nowS - 30));
      notes = switching.map(({ line, st }) => {
        const label = lineName(line);
        if (st.phase === 'started') {
          // (After midnight the last express can be yesterday's evening schedule.)
          const base = st.lastExpress >= 1440 && nyNow().mins < 720 ? -1440 : 0;
          const t = liveLast(here, line, dir, 'express', minsToEpoch(st.lastExpress + base), nowS);
          return `<p class="svc-line night">${ICON.moon}<span><b>Late-night service has started on the ${label}.</b> The last express train leaves at ${clockText(t)}, ${inText(t, nowS)}.</span></p>`;
        }
        if (st.phase === 'morning') return `<p class="svc-line">${ICON.sun}<span><b>Daytime service has started on the ${label}.</b></span></p>`;
        const expressDue = here.some((g) => g.route === line && g.dir === dir && g.svc === 'express' && g.trains.some((t) => t.time >= nowS - 30));
        // The last express running late: still counting down.
        if (st.phase === 'night' && expressDue) {
          const base = nyNow().mins < 720 ? -1440 : 0;
          const t = liveLastOnly(here, line, dir, 'express', minsToEpoch((st.lastExpress ?? 0) + base), nowS);
          if (t) return `<p class="svc-line night">${ICON.moon}<span><b>The last ${label} express train leaves at ${clockText(t)}, ${inText(t, nowS)}.</b></span></p>`;
        }
        if (st.phase === 'night' && !expressDue) {
          const say = otherExpress(line) ? `${label} trains run local late nights, until ${fmtClock(st.until)}.` : `No express trains late nights. ${label} trains run local until ${fmtClock(st.until)}.`;
          return `<div class="none-row">${bulletHtml(line)}<span>${say}</span></div>`;
        }
        return '';
      }).join('');
    }
    notes += gaps;
    notes = mergeDayBanners(mergeNightBanners(notes));
    // Express trains skipping local stops, with no local trains of that line listed.
    if (svc === 'local') for (const line of stn.lines) {
      if (!here.some((g) => g.route === line && g.dir === dir && g.svc === 'local')) notes += switchNoteHtml(line, dir);
    }
    const lines = here.filter((g) => g.dir === dir && (g.svc || 'local') === svc).map((g) => {
      let upcoming = g.trains.filter((x) => x.time >= nowS - 30);
      // (Every place this row may show, for its size.)
      const endNames = [...new Set(upcoming.map((x) => stationName(x.stops && x.stops[x.stops.length - 1]) || x.dest).filter(Boolean))];
      // A shared row with trains to more than one end of the line (the A
      // downtown) takes turns: each end's own next trains for a few seconds,
      // soonest first, sliding from one to the next.
      // (The diamond 6 and 7 count as their own end: circle and diamond take turns.)
      const lastOf = (x) => x.stops && `${x.stops[x.stops.length - 1]}${x.diamond ? '|d' : ''}`;
      const ends = g.scheduled ? [...new Set(upcoming.map(lastOf))] : [];
      // ...except while a train is "now": then it stops on that train and lists
      // every A train's time, whatever its end.
      const arriving = upcoming.length && Math.round((upcoming[0].time - nowS) / 60) <= 0;
      if (ends.length > 1) subwayTurning = true;
      // Trial (owner, Nov 19): option B, set with the switch under the panel.
      if (ends.length > 1 && subwayStyle === 'b') return optionBRow(g, stn, dir, upcoming, ends, arriving, nowS);
      // The turns always start with the end whose train comes first, and start
      // over from it whenever that order changes (a train leaves, or a "now").
      if (ends.length > 1) {
        const order = arriving ? '' : ends.join(',');
        const c = turnCycles.get(`${stn.id}|${g.route}|${dir}|${g.svc}`);
        const turnNow = Math.floor(Date.now() / ROTATE_MS);
        if (!c || c.order !== order) turnCycles.set(`${stn.id}|${g.route}|${dir}|${g.svc}`, { order, from: turnNow });
        const from = turnCycles.get(`${stn.id}|${g.route}|${dir}|${g.svc}`).from;
        if (!arriving) upcoming = upcoming.filter((x) => lastOf(x) === ends[(turnNow - from) % ends.length]);
      }
      const trains = upcoming.slice(0, 3);
      if (!trains.length) return '';
      // Late-night pill by the next train's own time and line (stays until it leaves).
      const lateT = !!(lateNightTrain(stn.id, g.route, dir, trains[0].time, trains[0].code) || localNight(stn.id, g, dir, trains[0].time) || cutbackNight(stn.id, g.route, dir, trains[0].time));
      const pill = (lateT ? SUB_LATE_PILL : '')
        + (subHolidayTrip(trains[0]) ? HOLIDAY_PILL : specialPills(trains[0].time, lateT));
      const mins = trains.map((x) => Math.max(0, Math.round((x.time - nowS) / 60)));
      const first = trains[0];
      const last = first.stops && first.stops[first.stops.length - 1];
      const dest = stationName(last) || first.dest || (dir === 'N' ? 'Uptown' : 'Downtown');
      const rowKey = `${stn.id}|${g.route}|${dir}|${g.svc}|${g.scheduled ? 'sched' : last}`;
      const note = diamondNote(g, first);
      const turned = destShown.has(rowKey) && destShown.get(rowKey) !== esc(dest) + note;
      const destHtml = destName(rowKey, dest, note, endNames);
      // The times slide over with the name when the row turns to another end.
      const minsHtml = (html) => (turned ? `<span class="dname changing"><span class="out" aria-hidden="true">${minsShown.get(rowKey) || ''}</span><span class="in">${html}</span></span>` : html);
      const firstMin = mins[0] === 0 ? '<b class="now">now</b>' : `<b>${mins[0]}</b> min`;
      const rest = mins.slice(1).length ? `, ${mins.slice(1).join(', ')}` : '';
      minsShown.set(rowKey, firstMin + rest);
      const rerouted = !skipFor(g.route, dir) && trains.find((x) => unusualStops(g.route, x).length);
      // Delays and skipped stops: pills on the row (the notice, its map and
      // other options are in the service notices).
      const linePills = subwayPills(g.route, dir, svc, stn.id, trains[0]);
      // (A rerouted train under a notice: the notice's pill is already in linePills.)
      if (!rerouted || changeFor(g.route, dir)) {
        return `<div class="sline" data-k="${esc(rowKey)}">${rowBullet(g, first, rowKey)}<span class="sdest">${destHtml}${pills(pill, linePills)}</span><span class="smins">${minsHtml(firstMin + rest)}</span></div>`;
      }
      // Rerouted with no notice behind it: the row itself opens the map.
      const i = subwayShown.push({ route: g.route, dir, svc: g.svc, train: rerouted }) - 1;
      return `<button type="button" class="sline rerouted" data-k="${esc(rowKey)}" data-reroute="${i}" aria-haspopup="dialog">${rowBullet(g, first, rowKey)}<span class="sdest">${destHtml}${staticPills(pills(pill && LATE_PILL, linePills))}<span class="reroute-tag">Rerouted, see map</span></span><span class="smins">${minsHtml(firstMin + rest)}</span></button>`;
    }).join('');
      return lines || notes ? `<div class="svc"><h4>${SVC[svc]}</h4>${notes}${lines}</div>` : '';
    }).join('');
    // (Each direction also carries its station's bullets, shown when the directions stand as their own columns.)
    return parts ? `<div class="dir" data-k="${stn.id}|${dir}"><h3><span class="dir-lines">${stn.lines.map((l) => bulletHtml(l, 'small')).join('')}</span>${DIRS[stn.id][dir]}</h3>${parts}</div>` : '';
  }).join('');
  // Each platform named by its line where the hub says (Times Square: they're far apart).
  const label = stn.lines.map((l) => bulletHtml(l, 'small')).join('') + (stn.platform ? `<span class="plat-name">${esc(stn.platform)}</span>` : '');
  // A platform in another station of the complex gets that station's name above
  // it, like PATH (owner, Nov 26: the A C E on the Times Square board, under
  // "42 St–Port Authority Bus Terminal"), and how to get there: the tunnel.
  const note = stn.note ? `<p class="walk">${esc(stn.note)}${stn.noteLink ? ` <a href="${esc(stn.noteLink.href)}">${esc(stn.noteLink.label)} →</a>` : ''}</p>` : '';
  const head = stn.heading ? `<h2 class="path-h stn-head">${esc(stn.heading)}${stn.sub ? ` <span>${esc(stn.sub)}</span>` : ''}</h2>${note}` : '';
  // Subway hubs: a platform in another station of the complex says so in one
  // short line under its bullets, linking that station's board (owner, Nov 26:
  // the tunnel note took a whole row; the station has signs for the A C E).
  const where = HUB.layout === 'subway' && stn.heading
    ? `<p class="plat-where">At ${esc(stn.heading)}, through the tunnel${stn.noteLink ? ` · <a href="${esc(stn.noteLink.href)}">${esc(stn.noteLink.label)} →</a>` : ''}</p>` : '';
  // (--dirs: how many directions this card holds; side by side in it when the subway is the full-screen board.)
  const sec = `<section class="stn" style="--dirs:${Math.max(1, (dirs.match(/<div class="dir">/g) || []).length)}" aria-label="${stn.lines.join(', ')} trains"><div class="stn-lines">${label}</div>${where}${dirs || '<p class="empty">No trains reported right now.</p>'}</section>`;
  return { head, sec, tail: stn.heading ? '' : note, id: stn.id };
  }).reduce((html, x, i, all) => {
    if (HUB.layout !== 'subway') return html + x.head + x.sec + x.tail;
    // Subway hubs: every platform a card. With fixed columns (hub.js platCols)
    // each card keeps its column, so a refresh never moves one; phones show
    // them in station order (CSS order).
    if (i < all.length - 1) return html;
    const card = (y) => y.sec.replace('<section class="stn" style="', `<section class="stn" style="order:${all.indexOf(y)};`);
    if (HUB.platCols) {
      const placed = new Set(HUB.platCols.flat());
      const cols = HUB.platCols.map((ids) => `<div class="pcol">${ids.map((id) => all.find((y) => y.id === id)).filter(Boolean).map(card).join('')}</div>`);
      const rest = all.filter((y) => !placed.has(y.id)).map(card).join('');
      return `<div class="plats fixed-cols" style="--pcols:${HUB.platCols.length}">${cols.join('')}${rest}</div>`;
    }
    return `<div class="plats">${all.map(card).join('')}</div>`;
  }, '');
  $('sub-toggles').innerHTML = subwayStyleHtml();
  renderSubwayTags(states);
  // The holiday/weather pill on each train only while late-night service is
  // starting or ending at this hub (some train or line still on late nights);
  // once it's all daytime service, only the tag by the Subway heading says so,
  // until the next change-over tonight (owner, Nov 26).
  const changing = !!$('subway').querySelector('.late-pill:not(.hol-pill):not(.wx-pill):not(.wknd-pill):not(.warn-pill)')
    || states.some((st) => st.phase === 'night' || st.phase === 'morning');
  $('subway').classList.toggle('no-sp', !changing);
  holdHeights($('subway'));
}

// Tags beside the Subway heading. Late-night service shows once no more
// daytime express trains are due on any switching line, and goes in the
// morning when the first daytime express shows "now" at Penn.
function renderSubwayTags(states) {
  const tags = [];
  const isNight = (st) => st.phase === 'night' || st.phase === 'morning';
  const allNight = states.length > 0 && states.every(isNight);
  const someNight = states.some(isNight);
  // A holiday's schedule is daytime service: late-night service runs as usual
  // overnight (owner, Nov 26). So the holiday tag shows once daytime service
  // has started; while some lines are still on late nights, both tags show.
  // Daytime service has started once any line's first morning train is on its
  // way ('morning': "Daytime service has started on the C"), not only once a
  // line is fully back to daytime (owner, Nov 26: "as soon as daytime service
  // has started … show both pills until late nite has concluded").
  const started = !states.length || states.some((st) => st.phase !== 'night');
  const holiday = (holidayNotice() || subwayHoliday(nyNow().date)) && started;
  // Weekend service works the same way (owner, Nov 26: "this same logic … on
  // other transitions like weekend service"): its tag once daytime service has
  // started, both tags while some lines are still on late nights.
  const day = nyNow().day;
  const weekend = !holiday && (day === 'saturday' || day === 'sunday') && !subwayHoliday(nyNow().date) && started;
  if (allNight || ((holiday || weekend) && someNight)) tags.push(`<span class="tag night">${ICON.moon}Late-night service</span>`);
  if (holiday) tags.push(`<span class="tag hol">${ICON.star}Holiday service</span>`);
  else if (weekend) tags.push(`<span class="tag wknd">${ICON.cal}Weekend service</span>`);
  if (weatherNotice()) tags.push(`<span class="tag wx">${ICON.snow}Severe weather service</span>`);
  $('sub-h').innerHTML = `Subway${tags.join('')}<span>${esc(HUB.subwayName || HUB.name)}</span>`;
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
    ? (odd.length === 1 || stationName(odd[0]) === stationName(odd[odd.length - 1])
      ? `running via the ${lineInfo(via.r).label} line at ${stationName(odd[0])}`
      : `running via the ${lineInfo(via.r).label} line from ${stationName(odd[0])} to ${stationName(odd[odd.length - 1])}`)
    : 'running on a different route from normal';
  $('reroute-note').textContent = `This ${l.label} train is ${viaText}, ${svc === 'express' ? 'express' : 'local'} from ${stationName(stops[0])}. ` +
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
      // Penn and the last stop are always named; the others once zoomed in.
      m.bindTooltip(label, { permanent: true, direction: 'auto', className: `rr-label${end ? '' : ' rr-mid'}` });
    });
    rerouteMap.fitBounds(L.latLngBounds(pts), { padding: [28, 28] });
    const names = () => box.classList.toggle('show-names', rerouteMap.getZoom() >= 14);
    rerouteMap.on('zoomend', names); names();
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
const PENN_LL = HUB.ll; // the hub (Penn Station on the Penn board)
const LIVE_DIRECTIONS = HUB.directions;
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

// Where a rerouted line runs instead, read from the notice: "[C] runs via the
// [F] from Jay St-MetroTech to 34 St-Herald Sq and via the [D] to 59 St-
// Columbus Circle." -> [{ line: 'F', from, to }, { line: 'D', from, to }]. Only
// the first sentence of each kind is used (the other direction is the same
// route in reverse).
function readVia(desc, route) {
  // "[4] trains run via the [2] from Nevins St to Flatbush Av", "Brooklyn-bound
  // [A][C] trains are running via the [F] from W 4 St to Jay St": headline or details.
  const sentence = String(desc || '').split(/\n|(?<=\.)\s+(?=[A-Z\[])/).find((x) => new RegExp(`\\[${route}\\][^.]*\\b(?:runs?|running|operates?|operating|travels?|go(?:es)?)\\s+via the \\[`).test(x));
  if (!sentence) return [];
  const out = [];
  let from = null;
  for (const m of sentence.matchAll(/via the \[([A-Z0-9]{1,2})\](?: from (.+?))? to (.+?)(?= and via|\.|$)/g)) {
    const line = m[1];
    if (!subwayData.routes[line]) continue;
    const a = m[2] ? findStation(m[2], [line]) : from;
    const b = findStation(m[3], [line]);
    if (a && b) out.push({ line, from: a, to: b });
    from = b;
  }
  return out;
}

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
// Skipped stops and a local line running express get a map too (owner, Nov 24):
// the skipped stations grayed out, zoomed in on that stretch.
const SKIP_TYPES = /stops skipped|local to express/i;
function changeModel(n) {
  if (!n || n.carrier !== 'subway' || !subwayData) return null;
  const skip = !CHANGE_TYPES.test(n.type) && (SKIP_TYPES.test(n.type) || isSwitchNotice(n));
  if (!CHANGE_TYPES.test(n.type) && !skip) return null;
  const named = Object.keys(n.affected || {}).filter((r) => subwayData.routes[r]);
  if (!named.length) return null;
  const route = bulletsIn(n.text).find((r) => named.includes(r)) || named[0];
  const closed = new Set(n.affected[route].filter((id) => subwayData.stops[id]));
  // "Suspended" (not "Part Suspended"): no trains on the line at all while it
  // applies. The notice may list only the stations the line serves then (the
  // overnight 3: 34 St to 148 St), but the rest of the line isn't running
  // either, so the whole line is drawn as closed.
  const whole = /suspended/i.test(n.type) && !/part/i.test(n.type);
  if (whole) for (const id of subwayData.routes[route].normal) if (subwayData.stops[id]) closed.add(id);
  if (!closed.size) return null;
  return { n, route, closed, whole, skip, alt: readAlternatives(n.desc, route), via: readVia(`${n.text}\n${n.desc || ''}`, route) };
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
  const pm = pathModels().find((m) => m.n.id === id);
  if (pm) return openPathIssue(pm);
  const lm = lirrModels().find((m) => m.n.id === id);
  if (lm) { changeOpen = { id, view }; return openLirrChange(lm, view); }
  const model = changeModels().find((m) => m.n.id === id);
  if (!model) return;
  changeOpen = { id, view };
  const { n, route, alt } = model;
  const label = lineName(route);
  $('chg-kind').textContent = friendlyType(n.type);
  const hasAlt = alt.text.length > 0;
  const canMapAlt = alt.transfers.length || alt.buses.length;
  if (view === 1) {
    $('chg-h').innerHTML = noticeText(n.text);
    $('chg-top').innerHTML = `<ul class="cm-key">
        ${model.whole ? '' : `<li><span class="sw" style="border-color:${esc(lineInfo(route).color)}"></span>${label} trains running</li>`}
        <li>${model.skip ? `<span class="sw-skip"></span>${label} trains skip these stations` : `<span class="sw off"></span>No ${label} trains`}</li>
        <li class="ent-li">Zoom in for entrances: <span class="ent">${ENT_STAIR}</span> stairs <span class="ent el">${ENT_ELEV}</span> elevator <span class="ent ex">${ENT_STAIR}</span> exit only</li>
        ${alt.buses.length ? '<li><span class="sw bus"></span>Free shuttle bus</li>' : ''}
        ${model.via && model.via.length ? `<li>${bulletHtml(route, 'tiny')} on its temporary route, via the ${[...new Set(model.via.map((v) => v.line))].map((l) => bulletHtml(l, 'tiny')).join(' and ')}</li>` : ''}
      </ul>
      ${hasAlt ? '<button type="button" class="cm-go" data-view="2">How to get around this <span aria-hidden="true">→</span></button>' : liveDirectionsHtml()}`;
    $('chg-below').innerHTML = model.skip ? skipBusHtml(model) : '';
  } else {
    $('chg-h').innerHTML = `Getting around it`;
    $('chg-top').innerHTML = `<button type="button" class="cm-back" data-view="1">← Whole ${label} line</button>
      <p class="cm-sum">${noticeFull(n)}</p>`;
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
const liveDirectionsHtml = () => `<p class="cm-live">Live directions from ${HUB.short}: <a href="${LIVE_DIRECTIONS.google}" target="_blank" rel="noopener">Google Maps</a> · <a href="${LIVE_DIRECTIONS.apple}" target="_blank" rel="noopener">Apple Maps</a></p>`;
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

// A line moved sideways by `px` screen pixels (left of its direction when
// negative), at the map's current zoom: for lines drawn side by side.
function offsetLine(map, pts, px) {
  const z = map.getZoom();
  const P = pts.map((p) => map.project(p, z));
  const out = P.map((p, i) => {
    const a = P[Math.max(0, i - 1)], b = P[Math.min(P.length - 1, i + 1)];
    let dx = b.x - a.x, dy = b.y - a.y; const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;
    return map.unproject(L.point(p.x - dy * px, p.y + dx * px), z);
  });
  return out;
}

// ---------- subway entrances on the maps (docs/subway-entrances.json, MTA open data) ----------
const ENT_MIN_ZOOM = 16;
let subwayEntrances = null, entLoading = null;
const loadSubwayEntrances = () => entLoading || (entLoading = fetch('subway-entrances.json').then((r) => (r.ok ? r.json() : null)).catch(() => null).then((d) => { subwayEntrances = d; }));
const ENT_STAIR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 20h5v-4h4v-4h4V8h5V4h-7v4h-4v4H6v4H3z"/></svg>';
const ENT_ELEV = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm3.5 7h7L12 5.5zm0 4L12 18.5l3.5-4.5z"/></svg>';
// Small at 16, a bit bigger closer in; elevator blue, exit-only gray.
function entMarker([la, lo, t, way], z) {
  const size = z >= 17.5 ? 18 : z >= 16.75 ? 15 : 12;
  const cls = t === 'E' ? 'ent el' : way === 'X' ? 'ent ex' : 'ent';
  const title = t === 'E' ? 'Elevator' : way === 'X' ? 'Exit only' : way === 'N' ? 'Entry only' : 'Entrance';
  return L.marker([la, lo], { interactive: false, zIndexOffset: 3000, title,
    icon: L.divIcon({ className: '', iconSize: [0, 0], html: `<div class="${cls}" style="width:${size}px;height:${size}px">${t === 'E' ? ENT_ELEV : ENT_STAIR}</div>` }) });
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
    const pts = [...closed, ...alt.transfers.flatMap((t) => t.ids), ...alt.buses.flatMap((b) => b.ids), ...(model.via || []).flatMap((v) => [v.from, v.to])].map(LL);
    area = L.latLngBounds(pts).pad(0.25);
    if (subwayData.routes[route].normal.some((id) => HUB.stations.some((x) => x.id === id)) && area.pad(0.4).contains(PENN_LL)) area.extend(PENN_LL);
    // The suggested lines, only within that area, thinner and lighter.
    for (const l of alt.detours) {
      for (const path of subwayShapes[l] || []) {
        let cur = [];
        const flush = () => { if (cur.length > 1) { casing(cur, 3); L.polyline(cur, { color: lineInfo(l).color, weight: 4, opacity: 0.8, interactive: false }).addTo(map); } cur = []; };
        // Keep every stretch that touches the area, ends included: track data
        // can have long straight stretches with no points inside it (the 1
        // under Broadway, 157 St to Dyckman St).
        for (let i = 0; i < path.length - 1; i++) {
          const a = path[i], b = path[i + 1];
          if (area.intersects(L.latLngBounds([a, b]))) { if (!cur.length) cur.push(a); cur.push(b); } else flush();
        }
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
  // The line's temporary route over another line's tracks ("[C] runs via the
  // [F]"): drawn in its colour, with its badge beside each station it uses.
  const borrowed = new Set();
  const sideBySide = L.layerGroup().addTo(map), pairs = [];
  for (const v of model.via || []) {
    const path = (subwayShapes[v.line] || []).find((p) => along(p, LL(v.from)).d < 0.002 && along(p, LL(v.to)).d < 0.002);
    if (!path) continue;
    const sa = along(path, LL(v.from)).s, sb = along(path, LL(v.to)).s;
    const pts = between(path, sa, sb, LL(v.from), LL(v.to));
    // Side by side: the rerouted line and the line whose tracks it uses, like
    // two lines sharing a trunk on a subway map. Redrawn on zoom (offsets are
    // in screen pixels).
    pairs.push({ pts, a: info.color, b: lineInfo(v.line).color });
    for (const id of subwayData.routes[v.line].normal) {
      if (!subwayData.stops[id] || borrowed.has(id)) continue;
      const x = along(path, LL(id));
      if (x.d < 0.0015 && x.s >= Math.min(sa, sb) - 0.01 && x.s <= Math.max(sa, sb) + 0.01) borrowed.add(id);
    }
  }
  const drawPairs = () => {
    sideBySide.clearLayers();
    for (const pr of pairs) {
      L.polyline(pr.pts, { color: '#fff', weight: 15, interactive: false }).addTo(sideBySide);
      L.polyline(offsetLine(map, pr.pts, -3.2), { color: pr.a, weight: 6, interactive: false }).addTo(sideBySide);
      L.polyline(offsetLine(map, pr.pts, 3.2), { color: pr.b, weight: 6, interactive: false }).addTo(sideBySide);
    }
  };
  if (pairs.length) { map.on('zoomend', drawPairs); map.whenReady(drawPairs); }
  // Badges show once zoomed in enough to tell stations apart; further out, one
  // tag on the temporary route says what it is.
  const viaBadges = L.layerGroup(), viaTag = L.layerGroup();
  for (const id of borrowed) {
    L.circleMarker(LL(id), { radius: 4, weight: 2, color: '#1b1b1b', fillColor: '#fff', fillOpacity: 1, interactive: false }).addTo(map);
    L.marker(LL(id), { interactive: false, zIndexOffset: 800, icon: L.divIcon({ className: '', iconSize: [0, 0], html: `<div class="via-badge">${bulletHtml(route, 'tiny')}</div>` }) }).addTo(viaBadges);
  }
  if (borrowed.size) {
    const ids = [...borrowed], mid = ids[Math.floor(ids.length / 2)];
    const lines = [...new Set((model.via || []).map((v) => v.line))];
    L.marker(LL(mid), { interactive: false, zIndexOffset: 900, icon: L.divIcon({ className: '', iconSize: [0, 0], html: `<div class="cm-label" style="transform:translate(14px,-50%);flex-direction:row;align-items:center;gap:3px">${bulletHtml(route, 'tiny')} via ${lines.map((l) => bulletHtml(l, 'tiny')).join('')}</div>` }) }).addTo(viaTag);
    // Close in, station names list the line themselves, so the badges step aside.
    const showVia = () => { const z = map.getZoom(); viaTag.remove(); viaBadges.remove(); if (z < 13) viaTag.addTo(map); else if (z < 14) viaBadges.addTo(map); };
    map.on('zoomend', showVia); showVia();
  }
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
  // A skipped station (the line keeps running past it) gets a red ring, so a
  // lone skipped stop stands out even though the line through it stays colored.
  const skipped = (id) => model.skip && closed.has(id);
  const dot = (id, off, small) => dots.push([small, L.circleMarker(LL(id), { radius: 3, weight: small ? 1.5 : skipped(id) ? 3 : 2, color: skipped(id) ? '#d4512b' : off ? '#8f8f8f' : '#1b1b1b', fillColor: skipped(id) ? '#d9d9d9' : '#fff', fillOpacity: 1, interactive: false }).addTo(map), skipped(id)]);
  const lineIds = subwayData.routes[route].normal.filter((id) => subwayData.stops[id]);
  for (const id of new Set([...lineIds, ...closed])) dot(id, closed.has(id));
  const names = L.layerGroup();
  const shownIds = new Set([...lineIds, ...closed, ...borrowed]);
  if (view === 2) {
    for (const l of alt.detours) for (const id of subwayData.routes[l].normal) {
      if (subwayData.stops[id] && !shownIds.has(id) && area.contains(LL(id))) { dot(id, false, true); shownIds.add(id); }
    }
  }
  // Zoomed in, every station shows its name and lines.
  const named = [];
  // (A station the line is borrowing lists the line too, with the line it belongs to.)
  const linesAt = (id) => {
    const ls = [...stationLines(id)].filter((l) => (view === 2 ? l === route || alt.detours.includes(l) : l === route) && !(l === route && closed.has(id)));
    if (borrowed.has(id)) { for (const v of model.via || []) if (stationLines(id).has(v.line) && !ls.includes(v.line)) ls.push(v.line); if (!ls.includes(route)) ls.unshift(route); }
    return ls;
  };
  // One name per station complex (Jay St-MetroTech has two stations): the one with lines running.
  const order = [...shownIds].sort((a, b) => linesAt(b).length - linesAt(a).length);
  for (const id of order) {
    const ls = linesAt(id);
    const [la, lo] = LL(id);
    if (named.some(([n, a, o]) => n === stationName(id) && Math.hypot(a - la, o - lo) < 0.004)) continue;
    named.push([stationName(id), la, lo]);
    L.marker(LL(id), { interactive: false, icon: L.divIcon({ className: '', iconSize: [0, 0], html: `<div class="cm-name${closed.has(id) && !ls.length ? ' off' : ''}"><span class="nm">${esc(stationName(id))}</span>${skipped(id) ? '<span class="skip-tag">skipped</span>' : ''}${bullets(ls)}</div>` }) }).addTo(names);
  }

  // Labels for the overall picture.
  const labels = [];
  const name = (id) => stationName(id).replace(/-/g, '–');
  const hereIds = HUB.stations.map((x) => x.id).filter((id) => lineIds.includes(id));
  if (hereIds.length) {
    const id = hereIds[hereIds.length - 1];
    labels.push({ at: LL(id), must: true, cls: 'here', html: `★ ${esc(name(id))}<small>You are here</small>`, w: textWidth(name(id)) + 10, h: 36 });
  }
  const closedList = [...closed].filter((id) => subwayData.stops[id]);
  const mid = closedList[Math.floor(closedList.length / 2)];
  if (mid) labels.push({ at: LL(mid), must: true, cls: 'off', html: model.skip ? `${lineLabel(info)} trains skip` : `No ${lineLabel(info)} trains`, w: textWidth(model.skip ? `${info.label} trains skip` : `No ${info.label} trains`) });
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
  // Entrances (owner, Nov 24): only at the stations the advisory sends you to
  // (where the closed or skipped stretch starts and ends, where trains end,
  // the MTA's transfer stations, and Penn), and only zoomed in close.
  const entLayer = L.layerGroup().addTo(map);
  const openEdge = (id) => !closed.has(id) && lineIds.includes(id);
  const entIds = new Set([...live.lastStops,
    ...[...closed].flatMap((id) => { const i = lineIds.indexOf(id); return [lineIds[i - 1], lineIds[i + 1]]; }).filter((id) => id && openEdge(id)),
    ...(view === 2 ? alt.transfers.flatMap((t) => t.ids) : []),
    ...HUB.stations.map((x) => x.id).filter((id) => lineIds.includes(id))]);
  const drawEntrances = () => {
    entLayer.clearLayers();
    const z = map.getZoom();
    if (z < ENT_MIN_ZOOM || !subwayEntrances) return;
    const bnd = map.getBounds().pad(0.2);
    for (const id of entIds) for (const e of subwayEntrances[id] || []) if (bnd.contains([e[0], e[1]])) entMarker(e, z).addTo(entLayer);
  };
  loadSubwayEntrances().then(drawEntrances);
  const sync = () => {
    drawEntrances();
    for (const [small, m, sk] of dots) { m.setRadius(dotSize(small) + (sk ? 2.5 : 0)); m.setStyle({ weight: sk ? 3 : map.getZoom() < 11.5 ? 1.2 : small ? 1.5 : 2 }); }
    if (map.getZoom() >= 14) { labelLayer.clearLayers(); names.addTo(map); }
    else { names.remove(); placeLabels(map, labelLayer, labels); }
  };
  // Skipped stops: zoomed in on them and the stations either side.
  const near = () => { const ids = new Set(closed); for (const id of closed) { const i = lineIds.indexOf(id); if (i > 0) ids.add(lineIds[i - 1]); if (i >= 0 && i < lineIds.length - 1) ids.add(lineIds[i + 1]); } return [...ids].filter((id) => subwayData.stops[id]); };
  const fit = view === 2 ? area : model.skip ? L.latLngBounds(near().map(LL)).pad(0.3) : L.latLngBounds([...lineIds, ...closed].map(LL));
  map.fitBounds(fit, { padding: [24, 24] });
  // (Only once the map has a view: dots and labels are sized from it.)
  map.on('zoomend moveend', sync);
  sync();
  // (Skipped if this map was closed or replaced by another view meanwhile.)
  setTimeout(() => { if (map !== changeMap || !map._loaded) return; map.invalidateSize(); map.fitBounds(fit, { padding: [24, 24] }); sync(); }, 60);

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

// ---------- LIRR service-change map ----------
// The same two views as the subway map, for LIRR notices that change where
// trains go: stops skipped, buses replacing trains, suspensions. The MTA's
// LIRR notices name the branch and the stations affected (ids match
// docs/lirr-data.json, built by scripts/build-lirr-data.py):
//   view 1: the branch from Penn, with the affected stations crossed out
//           (skipped) or the stretch between them dashed (buses / no trains);
//   view 2: the MTA's own text (how to get around it), with the affected
//           stations listed (tap to zoom; directions in Google or Apple Maps).
const LIRR_CHANGE = /suspend|substitute bus|stops skipped|reroute|single track|service change|no service/i;
let lirrData = null, lirrDataLoading = null;
function loadLirrData() {
  if (lirrData) return Promise.resolve(lirrData);
  if (!lirrDataLoading) {
    const v = (document.querySelector('script[src^="app.js"]').src.split('v=')[1] || '');
    lirrDataLoading = fetch(`lirr-data.json?v=${v}`).then((r) => { if (!r.ok) throw new Error('LIRR map data did not load'); return r.json(); })
      .then((d) => (lirrData = d)).catch((e) => { lirrDataLoading = null; throw e; });
  }
  return lirrDataLoading;
}
loadLirrData().then(() => renderServiceNotices()).catch(() => {});

function lirrModel(n) {
  if (!n || n.carrier !== 'lirr' || !lirrData || !LIRR_CHANGE.test(n.type)) return null;
  const routes = Object.keys(n.affected || {}).filter((r) => lirrData.routes[r] && (lirrData.shapes[r] || []).length);
  if (!routes.length) return null;
  const affected = new Set(routes.flatMap((r) => n.affected[r]).filter((id) => lirrData.stops[id]));
  if (!affected.size) return null;
  const kind = /bus/i.test(n.type) ? 'bus' : /skipped/i.test(n.type) ? 'skip' : 'off';
  const text = String(n.desc || '').split(/what'?s happening\?/i)[0].trim();
  return { n, lirr: true, routes, affected, kind, text };
}

const LLL = (id) => [lirrData.stops[id][1], lirrData.stops[id][2]];
// The LIRR branches calling at a station, as small chips in their colours.
// (City Terminal Zone is left out: it's the shared stretch Penn-Jamaica.)
const lirrBranchesAt = (id) => Object.entries(lirrData.routes).filter(([r, x]) => r !== '12' && x.stops.includes(id)).map(([, x]) => x);
const lirrChip = (x) => `<span class="lchip" style="background:${esc(x.color)};color:${esc(x.text)}">${esc(x.name.replace(/ Branch$| Service$/, ''))}</span>`;
// A branch's track cut into station-to-station pieces; a piece between two
// affected stations is part of the change (buses or no trains there).
function lirrSegments(route, affected) {
  const ids = [...new Set([...lirrData.routes[route].stops, ...affected])].filter((id) => lirrData.stops[id]);
  const segs = [];
  for (const path of lirrData.shapes[route] || []) {
    const on = ids.map((id) => ({ id, ...along(path, LLL(id)) })).filter((x) => x.d < 0.003).sort((a, b) => a.s - b.s);
    for (let i = 0; i < on.length - 1; i++) {
      const a = on[i], b = on[i + 1];
      segs.push({ pts: between(path, a.s, b.s, LLL(a.id), LLL(b.id)), hit: affected.has(a.id) && affected.has(b.id) });
    }
  }
  return segs;
}

async function openLirrChange(model, view) {
  const { n, routes, affected, kind, text } = model;
  const r0 = lirrData.routes[routes[0]];
  $('chg-kind').textContent = friendlyType(n.type);
  const sw = kind === 'skip' ? '' : `<li><span class="sw ${kind === 'bus' ? 'bus' : 'off'}"></span>${kind === 'bus' ? 'Buses replace trains' : 'No trains'}</li>`;
  if (view === 1) {
    $('chg-h').innerHTML = `<span class="plate lirr">LIRR</span> ${esc(n.text)}`;
    $('chg-top').innerHTML = `<ul class="cm-key">
        <li><span class="sw" style="border-color:${esc(r0.color)}"></span>${esc(routes.map((r) => lirrData.routes[r].name).join(', '))}</li>
        ${kind === 'skip' ? '<li><span class="sw off"></span>Station skipped</li>' : sw}
      </ul>
      ${text ? '<button type="button" class="cm-go" data-view="2">How to get around this <span aria-hidden="true">→</span></button>' : liveDirectionsHtml()}`;
    $('chg-below').innerHTML = '';
  } else {
    $('chg-h').innerHTML = 'Getting around it';
    $('chg-top').innerHTML = `<button type="button" class="cm-back" data-view="1">← Whole branch</button><p class="cm-sum">${esc(n.text)}</p>`;
    const cards = [...affected].map((id, i) => {
      const d = directionsTo(LLL(id), lirrData.stops[id][0]);
      return `<li class="cm-stn"><button type="button" class="cm-zoom" data-zoom="l${i}"><b>${esc(lirrData.stops[id][0])}</b></button>
        <span class="lchips">${lirrBranchesAt(id).map(lirrChip).join('')}</span>
        <span class="cm-dir">Directions: <a href="${esc(d.google)}" target="_blank" rel="noopener">Google Maps</a> · <a href="${esc(d.apple)}" target="_blank" rel="noopener">Apple Maps</a></span></li>`;
    }).join('');
    $('chg-below').innerHTML = `<h3 class="cm-h">Stations affected · tap to zoom in</h3><ul class="cm-stns">${cards}</ul>
      <h3 class="cm-h">From the MTA</h3><div class="cm-mta">${mtaTextHtml(text)}</div>${liveDirectionsHtml()}`;
  }
  const dialog = $('change');
  if (!dialog.open) { dialog.showModal(); history.pushState({ changeMap: true }, ''); }
  dialog.querySelector('.cm-body').scrollTop = 0;
  const box = $('chg-map');
  box.hidden = false;
  try {
    const Lf = await loadLeaflet();
    if (!changeOpen || changeOpen.id !== n.id || changeOpen.view !== view) return;
    if (changeMap) changeMap.remove();
    changeMap = Lf.map(box, { zoomSnap: 0.25, scrollWheelZoom: false });
    Lf.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18, className: 'cm-tiles',
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors · Lines: MTA',
    }).addTo(changeMap);
    drawLirrChange(changeMap, model, view);
  } catch (e) {
    console.warn('LIRR map:', e);
    box.hidden = true;
  }
}

function drawLirrChange(map, model, view) {
  const { routes, affected, kind } = model;
  const casing = (pts, w) => L.polyline(pts, { color: '#fff', weight: w + 4, interactive: false }).addTo(map);
  const penn = lirrData.penn;
  // The rest of the LIRR in each branch's own colour, thinner and lighter, so
  // the way from Penn to the affected branch shows.
  for (const [r, paths] of Object.entries(lirrData.shapes)) {
    if (routes.includes(r)) continue;
    for (const path of paths) L.polyline(path, { color: lirrData.routes[r].color, weight: 3, opacity: 0.55, interactive: false }).addTo(map);
  }
  const all = [];
  for (const r of routes) {
    const color = lirrData.routes[r].color;
    const segs = lirrSegments(r, affected);
    for (const s of segs) casing(s.pts, 6);
    for (const s of segs) {
      all.push(...s.pts);
      if (s.hit && kind !== 'skip') {
        L.polyline(s.pts, kind === 'bus'
          ? { color: '#222', weight: 4, dashArray: '2 7', lineCap: 'round', interactive: false }
          : { color: '#8f8f8f', weight: 5, dashArray: '8 7', interactive: false }).addTo(map);
      } else L.polyline(s.pts, { color, weight: 6, interactive: false }).addTo(map);
    }
    for (const id of lirrData.routes[r].stops) {
      if (!lirrData.stops[id]) continue;
      const hit = affected.has(id);
      L.circleMarker(LLL(id), { radius: hit ? 5 : 3.5, weight: 2, color: hit ? '#c0392b' : '#1b1b1b', fillColor: '#fff', fillOpacity: 1, interactive: false }).addTo(map);
    }
  }
  // Labels: Penn, each affected station, the branch's far ends.
  const name = (id) => lirrData.stops[id][0];
  const labels = [];
  if (lirrData.stops[penn]) labels.push({ at: LLL(penn), must: true, cls: 'here', html: `★ ${esc(name(penn))}<small>You are here</small>`, w: textWidth(name(penn)) + 10, h: 36 });
  const note = kind === 'skip' ? 'Skipped' : kind === 'bus' ? 'Buses' : 'No trains';
  for (const id of affected) labels.push({ at: LLL(id), must: view === 2 || affected.size <= 6, cls: 'off', html: `${esc(name(id))}<small style="color:#ffd9d3">${note}</small>`, w: textWidth(name(id)), h: 36 });
  const labelLayer = L.layerGroup().addTo(map), ring = L.layerGroup().addTo(map);
  let selected = null; // a station tapped in the list gets a fuller label instead
  const sync = () => placeLabels(map, labelLayer, labels.filter((x) => !selected || !L.latLng(x.at).equals(L.latLng(LLL(selected)))));
  const pts = view === 2 ? [...affected].map(LLL) : [...all, ...(lirrData.stops[penn] ? [LLL(penn)] : [])];
  const fit = L.latLngBounds(pts).pad(view === 2 ? 0.4 : 0.05);
  map.fitBounds(fit, { padding: [24, 24], maxZoom: 14 });
  map.on('zoomend moveend', sync); sync();
  setTimeout(() => { map.invalidateSize(); map.fitBounds(fit, { padding: [24, 24], maxZoom: 14 }); sync(); }, 60);
  $('chg-below').onclick = (e) => {
    const b = e.target.closest('[data-zoom]');
    if (!b) return;
    const id = [...affected][+b.dataset.zoom.slice(1)];
    $('chg-below').querySelectorAll('[data-zoom]').forEach((x) => x.setAttribute('aria-pressed', x === b));
    ring.clearLayers();
    L.marker(LLL(id), { interactive: false, zIndexOffset: 2000, icon: L.divIcon({ className: '', iconSize: [0, 0], html: '<div class="cm-ring"></div>' }) }).addTo(ring);
    // The station's name and the branches that call there, beside it.
    L.marker(LLL(id), { interactive: false, zIndexOffset: 2100, icon: L.divIcon({ className: '', iconSize: [0, 0], html: `<div class="cm-label lstation" style="transform:translate(-50%,24px)">${esc(lirrData.stops[id][0])}${affected.has(id) ? `<small style="color:#c0392b">${kind === 'skip' ? 'Skipped' : kind === 'bus' ? 'Buses replace trains' : 'No trains'}</small>` : ''}<span class="lchips">${lirrBranchesAt(id).map(lirrChip).join('')}</span></div>` }) }).addTo(ring);
    selected = id; sync();
    map.flyTo(LLL(id), 14.5, { duration: 0.8 });
    $('chg-map').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };
}
const lirrModels = () => ((board && board.notices && board.notices.rail) || []).map(lirrModel).filter(Boolean);

// ---------- PATH maps, NJ Transit fallback guides, delay options ----------
// PATH's stations and lines (stations are fixed; lines drawn station to
// station, side by side where they share track, like PATH's own map).
const PATH_STATIONS = {
  NWK: ['Newark Penn Station', 40.7347, -74.1640], HAR: ['Harrison', 40.7390, -74.1558],
  JSQ: ['Journal Square', 40.7331, -74.0628], GRV: ['Grove St', 40.7197, -74.0430],
  EXP: ['Exchange Place', 40.7164, -74.0329], WTC: ['World Trade Center', 40.7118, -74.0110],
  NEW: ['Newport', 40.7268, -74.0340], HOB: ['Hoboken', 40.7352, -74.0291],
  CHR: ['Christopher St', 40.7330, -74.0071], '09S': ['9 St', 40.7342, -73.9989],
  '14S': ['14 St', 40.7374, -73.9969], '23S': ['23 St', 40.7429, -73.9929], '33S': ['33 St', 40.7489, -73.9883],
};
const PATH_LINES = [
  { id: 'NWK-WTC', name: 'Newark–WTC', color: '#D93A30', off: -3, stops: ['NWK', 'HAR', 'JSQ', 'GRV', 'EXP', 'WTC'] },
  { id: 'HOB-WTC', name: 'Hoboken–WTC', color: '#65C100', off: 3, stops: ['HOB', 'NEW', 'EXP', 'WTC'] },
  { id: 'JSQ-33', name: 'Journal Square–33 St', color: '#FF9900', off: 3, stops: ['JSQ', 'GRV', 'NEW', 'CHR', '09S', '14S', '23S', '33S'] },
  { id: 'HOB-33', name: 'Hoboken–33 St', color: '#4D92FB', off: -3, stops: ['HOB', 'CHR', '09S', '14S', '23S', '33S'] },
];
const PP = (c) => [PATH_STATIONS[c][1], PATH_STATIONS[c][2]];
const pathChip = (ln) => `<span class="lchip" style="background:${ln.color};color:${ln.id === 'JSQ-33' ? '#1b1b1b' : '#fff'}">${esc(ln.name)}</span>`;

// A shared map frame for these sheets.
function openSheet() {
  const d = $('change');
  if (!d.open) { d.showModal(); history.pushState({ changeMap: true }, ''); }
  d.querySelector('.cm-body').scrollTop = 0;
}
async function freshMap() {
  const Lf = await loadLeaflet();
  const box = $('chg-map');
  box.hidden = false;
  if (changeMap) changeMap.remove();
  changeMap = Lf.map(box, { zoomSnap: 0.25, scrollWheelZoom: false });
  Lf.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18, className: 'cm-tiles',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors · PATH: Port Authority',
  }).addTo(changeMap);
  return changeMap;
}

// PATH's network with each line in a state: 'run' (normal), 'focus' (the
// route to take), 'delay', 'off' (no trains), 'faint' (not part of this).
// `marks`: station code -> label text; flagged stations get a red ring.
function drawPathMap(map, { state = {}, marks = {}, flagged = [], fit = null, near = false }) {
  // (The map needs its view before anything is drawn on it.)
  // `near`: zoomed to a problem spot (Penn only included when it's close by).
  const pts0 = (fit || Object.keys(PATH_STATIONS)).map(PP);
  const b = L.latLngBounds(near && !fit.some((c) => ['33S', '23S', '14S'].includes(c)) ? pts0 : [PENN_LL, ...pts0]);
  map.fitBounds(b, { padding: [28, 28] });
  const lines = L.layerGroup().addTo(map);
  const draw = () => {
    lines.clearLayers();
    for (const ln of PATH_LINES) {
      const s = state[ln.id] || 'run';
      const pts = offsetLine(map, ln.stops.map(PP), ln.off);
      if (s === 'faint') { L.polyline(pts, { color: ln.color, weight: 3, opacity: 0.35, interactive: false }).addTo(lines); continue; }
      L.polyline(pts, { color: '#fff', weight: s === 'focus' || s === 'delay' ? 11 : 9, interactive: false }).addTo(lines);
      if (s === 'off') L.polyline(pts, { color: '#8f8f8f', weight: 5, dashArray: '8 7', interactive: false }).addTo(lines);
      else L.polyline(pts, { color: ln.color, weight: s === 'focus' || s === 'delay' ? 7 : 5, interactive: false }).addTo(lines);
      if (s === 'delay') L.polyline(pts, { color: '#1b1b1b', weight: 2, dashArray: '1 9', lineCap: 'round', interactive: false }).addTo(lines);
    }
  };
  map.whenReady(draw); map.on('zoomend', draw);
  // The walk from Penn to PATH's 33 St station.
  L.polyline([PENN_LL, PP('33S')], { color: '#222', weight: 4, dashArray: '2 7', lineCap: 'round', interactive: false }).addTo(map);
  for (const c of Object.keys(PATH_STATIONS)) {
    const red = flagged.includes(c);
    L.circleMarker(PP(c), { radius: red ? 6 : 4, weight: 2, color: red ? '#c0392b' : '#1b1b1b', fillColor: '#fff', fillOpacity: 1, interactive: false }).addTo(map);
  }
  // Penn and PATH's 33 St are a block apart: one label for both.
  const at33 = flagged.includes('33S') ? `PATH 33 St: ${(marks['33S'] || '').toLowerCase()}` : '5 min walk to PATH 33 St';
  const labels = [{ at: PENN_LL, must: true, cls: 'here', html: `★ Penn Station<small${flagged.includes('33S') ? ' style="color:#c0392b"' : ''}>${esc(at33)}</small>`, w: Math.round(at33.length * 6.2 + 20), h: 36 }];
  for (const [c, text] of Object.entries(marks)) if (c !== '33S') labels.push({ at: PP(c), must: true, cls: flagged.includes(c) ? 'off' : '', html: `${esc(PATH_STATIONS[c][0])}${text ? `<small${flagged.includes(c) ? ' style="color:#ffd9d3"' : ''}>${esc(text)}</small>` : ''}`, w: textWidth(Math.max(PATH_STATIONS[c][0].length, text.length) > 18 ? text : PATH_STATIONS[c][0]) + 10, h: text ? 36 : 26 });
  for (const ln of PATH_LINES) {
    const s = state[ln.id];
    if ((s === 'delay' || s === 'off') && !near) { const mid = ln.stops[Math.floor(ln.stops.length / 2)]; labels.push({ at: PP(mid), must: true, cls: 'off', html: `${esc(ln.name)}<small style="color:#ffd9d3">${s === 'off' ? 'No trains' : 'Delays'}</small>`, w: textWidth(ln.name), h: 36 }); }
  }
  // Every station named where there's room (owner, Nov 24), after the ones that must show.
  for (const c of Object.keys(PATH_STATIONS)) if (c !== '33S' && !(c in marks)) labels.push({ at: PP(c), html: esc(PATH_STATIONS[c][0]), w: textWidth(PATH_STATIONS[c][0]) + 10, h: 26 });
  const layer = L.layerGroup().addTo(map);
  const sync = () => placeLabels(map, layer, labels);
  map.on('zoomend moveend', sync); sync();
  setTimeout(() => { map.invalidateSize(); map.fitBounds(b, { padding: [28, 28] }); sync(); draw(); }, 60);
}

// ---------- PATH alerts as maps ----------
// PATH writes its lines as "JSQ-33", "NWK-WTC", "HOB-33", "HOB-WTC"; each
// sentence says what's happening to the lines it names ("JSQ-33 delayed",
// "NWK-WTC, HOB-WTC, HOB-33 running"). Station problems (an elevator out of
// service) name the station in the first sentence.
const PATH_PAIR = /\b(NWK|JSQ|HOB|33|WTC)\s*-\s*(NWK|JSQ|HOB|33|WTC)\b/g;
function pathLineFor(a, b) {
  const ln = PATH_LINES.find((x) => { const [p, q] = x.id.split('-'); return (a === p && b === q) || (a === q && b === p); });
  return ln ? ln.id : null;
}
// (With PATH's own short names too: "elevators at HOB & EX PL"; owner, Nov 26: an alert written that way was missed.)
const PATH_NAMES = [['33S', /\b33(rd)? St/i], ['23S', /\b23(rd)? St/i], ['14S', /\b14(th)? St/i], ['09S', /\b9(th)? St/i], ['CHR', /Christopher|\bCHR\b/i],
  ['HOB', /Hoboken|\bHOB\b/i], ['NEW', /Newport|\bNWPT\b/i], ['EXP', /Exchange P|\bEX\.? ?PL\b|\bEXP\b/i], ['GRV', /Grove|\bGRV\b/i], ['JSQ', /Journal Sq|\bJSQ\b/i], ['HAR', /Harrison|\bHAR\b/i], ['NWK', /Newark|\bNWK\b/i], ['WTC', /World Trade|\bWTC\b/i]];
function pathModel(n) {
  if (!n || n.carrier !== 'path') return null;
  const text = String(n.text || '');
  const state = {};
  for (const clause of text.split(/[.;]\s+/)) {
    const ids = [...clause.matchAll(PATH_PAIR)].map((m) => pathLineFor(m[1], m[2])).filter(Boolean);
    if (!ids.length) continue;
    const s = /suspend|no service|not running|no trains/i.test(clause) ? 'off' : /delay|slow|congest/i.test(clause) ? 'delay' : /running|resum|normal/i.test(clause) ? 'run' : 'delay';
    for (const id of ids) if (!state[id] || s !== 'run') state[id] = s;
  }
  // "JSQ-33 via HOB" (late nights, weekends) runs through Hoboken: both 33 St lines.
  if (/\bJSQ\s*-\s*33\b[^.]*\bvia\s+HOB\b/i.test(text) && state['JSQ-33'] && !state['HOB-33']) state['HOB-33'] = state['JSQ-33'];
  // A notice for every train, naming no line ("Overnight trains may leave up to
  // 10 minutes late"; owner, Nov 26: such alerts got no pill): all lines delayed.
  if (!Object.keys(state).length && /\b(overnight|all|PATH)\s+trains?\b|\bsystem-?wide\b/i.test(text) && /\b(late|delay|slow|wait)/i.test(text)) {
    for (const ln of PATH_LINES) state[ln.id] = /suspend|no service|not running/i.test(text) ? 'off' : 'delay';
  }
  // (Parentheses only say where trains go: "elevator … (trains to 33 St and WTC)".)
  const first = text.replace(PATH_PAIR, ' ').split(/\.\s/)[0].replace(/\([^)]*\)/g, ' ');
  const issue = /elevator|escalator/i.test(first) ? 'Elevator out of service' : /closed|bypass|skip/i.test(first) ? 'Closed or skipped' : '';
  const flagged = issue ? PATH_NAMES.filter(([, re]) => re.test(first)).map(([c]) => c) : [];
  // Where a delay comes from, in PATH's words: "Crew reported a track
  // condition at 14 St" -> 14 St, "Track condition" (owner, Nov 24: the map
  // should zoom to it and say so, like the MTA map).
  const rest = text.replace(PATH_PAIR, ' ');
  const spots = Object.keys(state).length ? PATH_NAMES.filter(([c, re]) => re.test(rest) && !flagged.includes(c)).map(([c]) => c) : [];
  const cm = rest.match(/\b(track condition|signal (?:problem|issue|trouble)s?|disabled train|switch (?:problem|issue)s?|power (?:problem|issue|outage)s?|police activity|medical emergency|sick passenger|equipment (?:problem|issue)s?|congestion|construction|maintenance|flooding|fire)\b/i);
  const cause = cm ? cm[1].charAt(0).toUpperCase() + cm[1].slice(1).toLowerCase() : 'Delays here';
  if (!Object.keys(state).length && !flagged.length) return null;
  return { n, state, flagged, issue, spots, cause };
}
// A pill for PATH trains from 33 St on a line an open PATH alert says is
// delayed or suspended (Journal Square via Hoboken uses both 33 St lines).
// A train leaving within 2 min of a scheduled departure to the same place
// is running on time.
function pathOnTime(dest, epoch) {
  if (!pathSchedule || !epoch) return false;
  for (const off of [-1, 0, 1]) {
    const day = pathKey(nyNow(off)); // PATH's own timetable by the real day (weekend on holidays)
    for (const d of pathSchedule.days[day] || []) if (d.to === dest && Math.abs(minsToEpoch(off * 1440 + d.t) - epoch) <= 120) return true;
  }
  return false;
}
function pathTrouble(dest, epoch) {
  const ids = /via/i.test(dest) ? ['JSQ-33', 'HOB-33'] : /journal/i.test(dest) ? ['JSQ-33'] : /hoboken/i.test(dest) ? ['HOB-33'] : [];
  let worst = '';
  for (const m of pathModels()) for (const id of ids) {
    if (m.state[id] === 'off') worst = 'off';
    else if (m.state[id] === 'delay' && !worst) worst = 'delay';
  }
  // PATH trains start at 33 St, so they leave on time even when the delay is
  // further along (Nov 24: "track condition at 14 St"): unlike the subway,
  // where Penn is mid-route, an on-time departure here doesn't mean an on-time
  // trip, so the pill stays while PATH's notice applies.
  const ns = pathModels().filter((m) => ids.some((id) => m.state[id] === 'off' || m.state[id] === 'delay')).map((m) => m.n);
  if (worst === 'off') return dropPill(`path|${dest}|off`, 'Suspended', 'warn', ns);
  if (worst === 'delay') return dropPill(`path|${dest}|delay`, 'Delays', 'warn', ns);
  // An elevator out, or a station closed or skipped, where this train stops
  // (owner, Nov 26: these PATH alerts got no pill).
  const stops = new Set(PATH_LINES.filter((ln) => ids.includes(ln.id)).flatMap((ln) => ln.stops)); // (via Hoboken: both lines' stops)
  const at = pathModels().filter((m) => m.issue && m.flagged.some((c) => stops.has(c)));
  if (at.length) {
    const closed = at.some((m) => /closed|skip/i.test(m.issue));
    return dropPill(`path|${dest}|${closed ? 'closed' : 'elev'}`, closed ? 'Station closed' : 'Elevator out', 'warn', at.map((m) => m.n));
  }
  // "All late trains" (the subway panel's toggle): a train 5+ min behind.
  if (allLatePills && epoch) {
    const late = pathLateBy(dest, epoch);
    if (late != null && late >= LATE_PILL_MIN * 60) return warnPill(`${Math.round(late / 60)} min late`);
  }
  return '';
}
// How late a live PATH train from 33 St is, in seconds (null if unknown).
// 33 St is where the trains start, and they don't leave early, so a train
// due after a scheduled departure (and before the next) is that departure
// running late: measured from the latest scheduled time at or before it.
function pathLateBy(dest, epoch) {
  if (!pathSchedule || !epoch) return null;
  // Within 2 min of a scheduled departure (either side) is on time.
  if (pathOnTime(dest, epoch)) return 0;
  let best = null;
  for (const off of [-1, 0, 1]) {
    const day = pathKey(nyNow(off)); // PATH's own timetable by the real day (weekend on holidays)
    for (const d of pathSchedule.days[day] || []) {
      if (d.to !== dest) continue;
      const t = minsToEpoch(off * 1440 + d.t);
      if (t <= epoch + 60 && (best == null || t > best)) best = t;
    }
  }
  return best != null && epoch - best < 60 * 60 ? Math.max(0, epoch - best) : null;
}
const pathModels = () => ((board && board.notices && board.notices.path) || []).map(pathModel).filter(Boolean);

async function openPathIssue(m) {
  const { n, state, flagged, issue } = m;
  changeOpen = { id: n.id, view: 1 };
  $('chg-kind').textContent = `PATH · ${n.type}`;
  $('chg-h').innerHTML = esc(n.text.split(/\.\s/)[0]);
  const key = [];
  if (Object.values(state).includes('delay')) key.push('<li><span class="sw" style="border-color:#888;border-top-style:dotted"></span>Delays</li>');
  if (Object.values(state).includes('off')) key.push('<li><span class="sw off"></span>No trains</li>');
  if (flagged.length) key.push(`<li><span class="sw" style="border-color:#c0392b"></span>${esc(issue)}</li>`);
  if ((m.spots || []).length) key.push(`<li><span class="ring-key"></span>${esc(m.cause)}</li>`);
  $('chg-top').innerHTML = `<ul class="cm-key">${key.join('')}</ul>`;
  const running = PATH_LINES.filter((ln) => state[ln.id] === 'run');
  const cards = flagged.map((c) => {
    const d = directionsTo(PP(c), `PATH ${PATH_STATIONS[c][0]}`);
    return `<li class="cm-stn"><button type="button" class="cm-zoom" data-pzoom="${c}"><b>${esc(PATH_STATIONS[c][0])}</b></button><span class="cm-dir">Directions: <a href="${esc(d.google)}" target="_blank" rel="noopener">Google Maps</a> · <a href="${esc(d.apple)}" target="_blank" rel="noopener">Apple Maps</a></span></li>`;
  }).join('');
  $('chg-below').innerHTML = `${running.length ? `<h3 class="cm-h">Running normally</h3><p class="lchips">${running.map(pathChip).join('')}</p>` : ''}
    ${cards ? `<h3 class="cm-h">Station</h3><ul class="cm-stns">${cards}</ul>` : ''}
    <h3 class="cm-h">From PATH</h3><div class="cm-mta"><p>${esc(n.text)}</p></div>${liveDirectionsHtml()}`;
  openSheet();
  try {
    const map = await freshMap();
    const marks = {};
    for (const c of flagged) marks[c] = issue;
    for (const c of m.spots || []) marks[c] = m.cause;
    // Zoomed to where it's happening: the station(s) PATH names and the ones
    // either side on the affected lines (and 33 St, if those lines reach it).
    let fit = null;
    if ((m.spots || []).length || flagged.length) {
      const ids = new Set([...(m.spots || []), ...flagged]);
      for (const ln of PATH_LINES) if (state[ln.id] && state[ln.id] !== 'run') ln.stops.forEach((c, i) => { if (ids.has(c)) { if (ln.stops[i - 1]) ids.add(ln.stops[i - 1]); if (ln.stops[i + 1]) ids.add(ln.stops[i + 1]); } });
      fit = [...ids];
    }
    drawPathMap(map, { state, marks, flagged: [...flagged, ...(m.spots || [])], fit, near: !!fit });
    $('chg-below').onclick = (e) => { const b = e.target.closest('[data-pzoom]'); if (b) map.flyTo(PP(b.dataset.pzoom), 15, { duration: 0.8 }); };
  } catch (e) { console.warn('PATH map:', e); $('chg-map').hidden = true; }
}

// ---------- NJ Transit disruption: other ways to New Jersey ----------
// Ready-made guides to Newark Penn and Hoboken by PATH, offered when NJ
// Transit trains at Penn are badly delayed or cancelled. The words are the
// board's own (not NJ Transit's data); NJ Transit's notices stay as sent.
const NJT_GUIDES = {
  newark: {
    title: 'To Newark Penn Station by PATH', dest: 'NWK', live: /journal/i, liveLabel: 'Journal Square trains from 33 St',
    state: { 'JSQ-33': 'focus', 'NWK-WTC': 'focus', 'HOB-33': 'faint', 'HOB-WTC': 'faint' },
    marks: { '33S': 'Board a Journal Square train', JSQ: 'Change for Newark', NWK: 'NJ Transit and Amtrak here' },
    steps: [
      'Walk to PATH 33 St (6 Av at 32 St, about 5 min).',
      'Take a Journal Square train (via Hoboken late nights and weekends).',
      'Change at Journal Square for Newark, 2 stops on.',
      'Or: downtown [E] to World Trade Center, then PATH direct to Newark.',
    ],
  },
  hoboken: {
    title: 'To Hoboken Terminal by PATH', dest: 'HOB', live: /hoboken/i, liveLabel: 'Trains to Hoboken from 33 St',
    state: { 'HOB-33': 'focus', 'JSQ-33': 'faint', 'NWK-WTC': 'faint', 'HOB-WTC': 'faint' },
    marks: { '33S': 'Board a Hoboken train', HOB: 'NJ Transit trains here' },
    steps: [
      'Walk to PATH 33 St (6 Av at 32 St, about 5 min).',
      'Take a Hoboken train (late nights and weekends: Journal Square via Hoboken).',
      'NJ Transit trains leave from Hoboken Terminal.',
    ],
  },
};
async function openGuide(key) {
  const g = NJT_GUIDES[key];
  changeOpen = { id: `guide-${key}`, view: 1 };
  $('chg-kind').textContent = 'Other ways to New Jersey';
  $('chg-h').innerHTML = esc(g.title);
  const nowS = Date.now() / 1000;
  const next = ((board && board.path) || []).filter((x) => g.live.test(x.dest || '') && x.time >= nowS - 30).slice(0, 3)
    .map((x) => { const m = Math.max(0, Math.round((x.time - nowS) / 60)); return m ? `${m} min` : 'now'; });
  const other = key === 'newark' ? 'hoboken' : 'newark';
  $('chg-top').innerHTML = `<ol class="cm-steps">${g.steps.map((s) => `<li>${noticeText(s)}</li>`).join('')}</ol>
    ${next.length ? `<p class="cm-sum"><b>${esc(g.liveLabel)}:</b> ${next.join(', ')}</p>` : ''}
    <button type="button" class="cm-back" data-guide="${other}">${other === 'hoboken' ? 'To Hoboken instead' : 'To Newark Penn instead'} →</button>`;
  const d = directionsTo(PP(g.dest), key === 'newark' ? 'Newark Penn Station' : 'Hoboken Terminal');
  const njtNotes = ((board && board.notices && board.notices.rail) || []).filter((n) => n.carrier === 'njt');
  $('chg-below').innerHTML = `<p class="cm-live">PATH charges its own fare. During major disruptions NJ Transit sometimes accepts its tickets on PATH (cross-honoring); check NJ Transit’s notices before you go.</p>
    <p class="cm-live">Directions: <a href="${esc(d.google)}" target="_blank" rel="noopener">Google Maps</a> · <a href="${esc(d.apple)}" target="_blank" rel="noopener">Apple Maps</a></p>
    ${njtNotes.length ? `<h3 class="cm-h">From NJ Transit</h3><div class="cm-mta">${njtNotes.map((n) => `<p>${noticeFull(n)}</p>`).join('')}</div>` : ''}`;
  openSheet();
  try { drawPathMap(await freshMap(), { state: g.state, marks: g.marks, fit: ['33S', g.dest, 'JSQ'] }); } catch (e) { console.warn('guide map:', e); $('chg-map').hidden = true; }
}
// ---------- LIRR: other ways to Long Island when Penn is suspended or badly delayed ----------
const LIRR_GUIDES = {
  gcm: {
    title: 'LIRR from Grand Central Madison', short: 'Grand Central Madison', at: [40.7527, -73.9772], name: 'Grand Central Madison',
    steps: [
      'Some LIRR trains run from Grand Central Madison (Madison Av at 44 St). Check its board before you go.',
      'From Penn: uptown [1] [2] [3] one stop to Times Sq, then the shuttle (about 15 min). Or walk, about 25 min.',
    ],
  },
  woodside: {
    title: 'By the 7 to Woodside', short: '[7] to Woodside', at: [40.7459, -73.9029], name: 'Woodside Station',
    steps: [
      'Take the [7] to 61 St–Woodside from Grand Central, Times Sq (uptown [1] [2] [3] one stop) or 34 St–Hudson Yards (10 min walk west).',
      'LIRR Woodside is right below. Port Washington and most Main Line trains stop there.',
    ],
  },
  jamaica: {
    title: 'By the E to Forest Hills, Kew Gardens or Jamaica', short: '[E] to Forest Hills or Jamaica', at: [40.7003, -73.808], name: 'Jamaica Station', live: 'E',
    steps: [
      'Take a Queens-bound [E] from 34 St–Penn (8 Av side).',
      'Change to the LIRR at Forest Hills–71 Av (about 25 min), Kew Gardens–Union Tpke, or Sutphin Blvd for Jamaica (about 35 min).',
      'All branches except Port Washington stop at Jamaica.',
    ],
  },
};
// The LIRR's notice about Penn, cut to its advice for everyone (no
// branch-by-branch train lists, no "click here").
const lirrPennNotice = () => pennSuspension('lirr') || ((board && board.notices && board.notices.rail) || []).find((n) => n.carrier === 'lirr' && happeningNow(n) && /penn/i.test(n.text) && /delay|suspend/i.test(`${n.type} ${n.text}`));
function lirrAdvice(n) {
  const parts = String((n && n.desc) || '').split(/\n+/).map((x) => x.trim()).filter(Boolean);
  const out = [];
  for (const x of parts) {
    if (/service alerts$|^(east|west)bound|^the \d/i.test(x)) break;
    if (/click here/i.test(x)) continue;
    out.push(x);
  }
  return out;
}
// The MTA's standing map of ways to Long Island when LIRR service at Penn
// is suspended (owner, Nov 2026: a dedicated map, not tonight's only). Shown
// with every LIRR disruption banner and guide; linked, not copied here.
const MTA_LIRR_ALT_MAP = 'https://www.mta.info/image/186211';
const altMapLink = () => `<a class="alt-map" href="${MTA_LIRR_ALT_MAP}" target="_blank" rel="noopener">MTA map of travel alternatives ↗&#xFE0E;</a>`;
function openLirrGuide(key) {
  const g = LIRR_GUIDES[key];
  changeOpen = { id: `lguide-${key}`, view: 1 };
  $('chg-map').hidden = true;
  $('chg-kind').textContent = 'Other ways to Long Island';
  $('chg-h').innerHTML = esc(g.title);
  const nowS = Date.now() / 1000;
  const next = g.live ? ((board && board.subway) || []).filter((x) => x.route === g.live && x.dir === 'N' && x.trains[0] && x.trains[0].stops[0] === 'A28')
    .flatMap((x) => x.trains).filter((t) => t.time >= nowS - 30).sort((a, b) => a.time - b.time).slice(0, 3)
    .map((t) => { const m = Math.max(0, Math.round((t.time - nowS) / 60)); return m ? `${m} min` : 'now'; }) : [];
  const n = lirrPennNotice(), advice = lirrAdvice(n);
  const others = Object.keys(LIRR_GUIDES).filter((k) => k !== key);
  $('chg-top').innerHTML = `<div class="cm-mta">${advice.length ? `<b>From the MTA:</b>${advice.map((x) => `<p>${noticeText(x)}</p>`).join('')}` : ''}${altMapLink()}</div>
    <ol class="cm-steps">${g.steps.map((x) => `<li>${noticeText(x)}</li>`).join('')}</ol>
    ${next.length ? `<p class="cm-sum"><b>Queens-bound ${lineName('E')} trains from Penn:</b> ${next.join(', ')}</p>` : ''}
    <p class="lchips">${others.map((k) => `<button type="button" class="cm-back" data-lguide="${k}">${noticeText(LIRR_GUIDES[k].short)} →</button>`).join(' ')}</p>`;
  const d = directionsTo(g.at, g.name);
  const notes = ((board && board.notices && board.notices.rail) || []).filter((n) => n.carrier === 'lirr' && happeningNow(n));
  const honored = advice.some((x) => /honou?ring LIRR/i.test(x));
  $('chg-below').innerHTML = `${honored ? '' : '<p class="cm-live">The subway charges its own fare unless the MTA says LIRR tickets are accepted (cross-honoring); check the LIRR notices.</p>'}
    <p class="cm-live">Directions: <a href="${esc(d.google)}" target="_blank" rel="noopener">Google Maps</a> · <a href="${esc(d.apple)}" target="_blank" rel="noopener">Apple Maps</a></p>
    ${notes.length ? `<h3 class="cm-h">From the LIRR</h3><div class="cm-mta">${notes.map((n) => `<p>${noticeFull(n)}</p>`).join('')}</div>` : ''}`;
  openSheet();
}
// LIRR service into and out of Penn suspended, or most of the next hour's
// LIRR trains badly late.
function lirrDisrupted() {
  if (!board) return '';
  if (pennSuspension('lirr')) return 'suspended';
  const nowS = Date.now() / 1000;
  const rows = board.departures.filter((r) => r.carrier === 'lirr' && (r.leaves ?? r.time) > nowS - 300 && r.time < nowS + 75 * 60);
  const late = rows.filter((r) => (r.lateMin || 0) >= 15 || (r.leaves ?? r.time) < nowS - 600).length;
  return rows.length >= 4 && late >= 3 && late / rows.length >= 0.4 ? 'delayed' : '';
}
// The banner carries the MTA's own advice (diversions, which subway lines
// take LIRR fares) and its map, then the guides.
const lirrAltHtml = () => {
  if (!IS_PENN) return ''; // the guide is about LIRR service at Penn
  const d = lirrDisrupted();
  if (!d) return '';
  const n = lirrPennNotice(), advice = lirrAdvice(n);
  return `<div class="njt-alt lirr-alt"><p><b>${d === 'suspended' ? 'LIRR service into and out of Penn is suspended.' : 'LIRR trains from Penn are badly delayed.'}</b></p>
  <div class="lirr-advice">${advice.map((x) => `<p>${noticeText(x)}</p>`).join('')}${altMapLink()}</div>
  <p>Other ways to Long Island:</p>
  <div>${Object.keys(LIRR_GUIDES).map((k) => `<button type="button" data-lguide="${k}">${noticeText(LIRR_GUIDES[k].short)}</button>`).join('')}</div></div>`;
};
// Railroad banners for the chosen railroad (all: LIRR first).
const railAltHtml = () => `${carrier === 'all' || carrier === 'lirr' ? lirrAltHtml() : ''}${carrier === 'all' || carrier === 'njt' ? njtAltHtml() : ''}`;
// When to offer the guides: several NJ Transit trains from Penn cancelled, or
// most of the next hour's badly late, or an NJ Transit notice about a
// suspension or major delays at Penn. Always in #preview mode.
function njtDisrupted() {
  if (!board) return false;
  if (typeof PREVIEW !== 'undefined' && PREVIEW) return true;
  const nowS = Date.now() / 1000;
  const rows = board.departures.filter((r) => r.carrier === 'njt' && (r.leaves ?? r.time) > nowS - 300 && r.time < nowS + 75 * 60);
  const cancelled = rows.filter((r) => r.tone === 'stop').length;
  const late = rows.filter((r) => (r.lateMin || 0) >= 15).length;
  const notice = (board.notices.rail || []).some((n) => n.carrier === 'njt' && /suspend|no service|major delay|severe delay|significant delay|cross[- ]?honor/i.test(n.text) && /new york|penn station|psny|\bnec\b|northeast corridor|all lines/i.test(n.text));
  return cancelled >= 3 || (rows.length >= 4 && late >= 3 && late / rows.length >= 0.4) || notice;
}
// Says "delayed", "cancelled" or both, by what the next hour's trains show.
function njtTrouble() {
  const nowS = Date.now() / 1000;
  const rows = ((board && board.departures) || []).filter((r) => r.carrier === 'njt' && (r.leaves ?? r.time) > nowS - 300 && r.time < nowS + 75 * 60);
  const c = rows.some((r) => r.tone === 'stop'), d = rows.some((r) => (r.lateMin || 0) >= 15);
  return c && d ? 'delayed or cancelled' : c ? 'cancelled' : 'delayed';
}
const njtAltHtml = () => (IS_PENN && njtDisrupted() ? `<div class="njt-alt"><p><b>NJ Transit trains from Penn are ${njtTrouble()}.</b> Other ways to New Jersey:</p>
  <div><button type="button" data-guide="newark">To Newark Penn by PATH</button><button type="button" data-guide="hoboken">To Hoboken by PATH</button></div></div>` : '');

// ---------- delays on the trains they affect, with other options ----------
const NJT_LINE_WORDS = [[/\bNEC\b|Northeast Corridor/i, /Northeast/i], [/North Jersey Coast|\bNJCL\b/i, /Jersey Coast/i], [/Morris (and|&) Essex|\bM&E\b/i, /Morristown|Gladstone/i],
  [/Montclair-Boonton|\bMOBO\b/i, /Montclair|Boonton/i], [/Raritan Valley/i, /Raritan/i], [/Main\/Bergen|Main Line|Bergen County/i, /Main|Bergen/i], [/Pascack/i, /Pascack/i], [/Gladstone/i, /Gladstone/i]];
const DELAY_TYPES = /delay|cancel|suspend|single track/i;
// A live LIRR train's branch name -> the MTA's LIRR route id (notices use
// these). Huntington trains are the Port Jefferson Branch in the MTA's data.
const LIRR_ALIASES = { 'Huntington Branch': 'Port Jefferson Branch', 'Greenport Branch': 'Greenport Service', 'Belmont Park Branch': 'Belmont Park', 'City Terminal Branch': 'City Terminal Zone' };
const lirrRouteFor = (line) => lirrData && Object.keys(lirrData.routes).find((k) => lirrData.routes[k].name === (LIRR_ALIASES[line] || line));
// Only notices about delays get "Other options". A train switched between
// local and express (or rerouted) is itself another way to travel, even when
// the MTA files it under "Delays", so those don't.
const SERVICE_SWITCH = /\b(running|runs|run|operating|operates)\s+(express|local)\b|\bexpress (between|from|to|in)\b|\blocal (between|from|to|in)\b|\breroute|\bruns? via\b/i;
// Notes on individual trains only for events happening now: not notices the
// MTA shows ahead of their start, nor #preview's upcoming work.
const happeningNow = (n) => n.activeNow !== false && !n.preview;
const isDelayNotice = (n) => happeningNow(n) && (DELAY_TYPES.test(n.type) || /\bdelay|\blate\b|cancel/i.test(n.text)) && !SERVICE_SWITCH.test(n.text);
// A train running late whose status on the board doesn't say so (owner,
// Nov 24): late by its railroad's own numbers (2+ min), or 2+ min past its
// time and not gone, while the board shows "BOARDING", "On time" and the like.
// Returns the minutes late (0 if only overdue), or null. Any railroad.
function hiddenDelayMin(r) {
  if (r.tone === 'stop' || r.tone === 'departed' || r.departed || departedAt(r) !== null) return null;
  const shown = shownStatus(r, 'departures');
  if (shown.tone === 'departed' || shown.tone === 'stop' || /late|delay|stand ?by|no update|held/i.test(String(shown.status || ''))) return null;
  if ((r.lateMin || 0) >= 2) return r.lateMin;
  return (r.leaves ?? r.time) < Date.now() / 1000 - 120 ? 0 : null;
}
const njtHiddenDelay = (r) => hiddenDelayMin(r) !== null;
const NJT_SYSTEMWIDE = /\bNJ ?TRANSIT (rail )?(service|trains)\b|\ball (NJ ?TRANSIT )?(rail )?(service|trains)\b|\b(into and out of|to and from|in and out of) (Penn Station New York|PSNY|New York Penn|Penn Station)\b/i;
// The trains a railroad notice names ("The 9:11pm train from Babylon to Penn
// Station is operating 30-35 minutes late"): [{ hm: '9:11', ap: 'PM', from, to }].
const NAMED_TRAIN = /\b(\d{1,2}:\d{2})\s*([ap])\.?\s?m\.?\s+train\s+from\s+(.+?)(?:\s+(?:to|due(?:\s+(?:in|at))?)\s+(.+?))?(?=\s+(?:is|was|will|has|have|are|and|due|at|which|departing|leaving|originat\w*|terminat\w*)\b|[.,;:(<]|$)/gi;
function namedTrains(n) {
  const text = String(n.text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  return [...text.matchAll(NAMED_TRAIN)].map((m) => ({ hm: m[1], ap: m[2].toUpperCase() + 'M', from: m[3], to: m[4] || '' }));
}
const HUB_NAME = IS_PENN ? /\bpenn\b/i : /grand central/i;
// A notice naming trains belongs only on those trains leaving this hub (owner,
// Nov 26: an inbound train running late shouldn't show on every train out;
// only on the outgoing train delayed by it). The railroads publish no link
// between an inbound train and the train it turns into, so an outgoing train
// gets the notice only when the notice itself names it ("...as a result, the
// 10:07pm train from Penn Station to Babylon will depart 15 minutes late").
// null: it names no train (then the branch rule decides).
function namedTrainFits(n, r) {
  const refs = namedTrains(n);
  if (!refs.length) return null;
  const at = clock(r.sched || r.time);
  return refs.some((t) => HUB_NAME.test(t.from) && t.hm === at.hm && t.ap === at.ap);
}
function rowNotices(r) {
  const all = (board && board.notices && board.notices.rail) || [];
  if (r.carrier === 'lirr' && lirrData) {
    const id = lirrRouteFor(r.line);
    // A notice covering (nearly) every branch is about the LIRR as a whole: only
    // on trains actually running late whose status doesn't say so, like NJ Transit's.
    return id ? all.filter((n) => n.carrier === 'lirr' && isDelayNotice(n) && (namedTrainFits(n, r) ?? ((n.lines || []).includes(id)
      && ((n.lines || []).length < 8 || hiddenDelayMin(r) !== null)))) : [];
  }
  if (r.carrier === 'mnr') {
    // Metro-North: notices naming the train's line (its route id); one about
    // (nearly) every line only on trains actually running late.
    const id = Object.keys(MNR_ROUTE_NAMES).find((k) => `${MNR_ROUTE_NAMES[k][0]} Line` === r.line);
    return id ? all.filter((n) => n.carrier === 'mnr' && isDelayNotice(n) && (namedTrainFits(n, r) ?? ((n.lines || []).includes(id)
      && ((n.lines || []).length < 4 || hiddenDelayMin(r) !== null)))) : [];
  }
  if (r.carrier === 'njt') {
    return all.filter((n) => {
      if (n.carrier !== 'njt' || !isDelayNotice(n)) return false;
      const nums = [...String(n.text).matchAll(/#\s?(\d{3,5})/g)].map((m) => m[1]);
      if (nums.length) return nums.includes(String(r.train));
      if (NJT_LINE_WORDS.some(([inText, inLine]) => inText.test(n.text) && inLine.test(r.line || ''))) return true;
      // About NJ Transit service as a whole, naming no line or train ("NJ
      // TRANSIT rail service is subject to up to 20-minute delays into and out
      // of Penn Station New York"): only trains actually running late whose
      // status doesn't already say so (owner, Nov 24), not every train.
      // A train on "STAND BY" (waiting for its track) gets it too (owner, Nov 24).
      return !NJT_LINE_WORDS.some(([inText]) => inText.test(n.text)) && NJT_SYSTEMWIDE.test(n.text) && (njtHiddenDelay(r) || /stand ?by/i.test(String(r.status || '')));
    });
  }
  return [];
}
// ---------- NJ Transit's last trains before the overnight break ----------
// From NJ Transit's whole-day schedule for Penn (relay /njt-day, refreshed
// every 30 min): for each line, the last departure before a break of 2 hours
// or more that runs past 3 AM, and the first train after it; the same for NJ
// Transit as a whole. Matched to live rows by train number.
let njtLast = new Map(); // train number -> { line: true?, all: true?, until }
function njtTime2(s) { // "18-Nov-2026 10:05:00 PM"
  const m = /^(\d+)-(\w+)-(\d+) (\d+):(\d+):\d+ (AM|PM)$/.exec(s || '');
  if (!m) return 0;
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(m[2]) + 1;
  return PennFeeds.nyToEpoch(+m[3], mon, +m[1], (+m[4] % 12) + (m[6] === 'PM' ? 12 : 0), +m[5], 0);
}
function lastBeforeBreak(list) { // [{t, id}] sorted -> [{id, until|null}]
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i], b = list[i + 1];
    // Covers 3 AM: from the train's time to the next (or the list's end, if none).
    const end = b ? b.t : a.t + 6 * 3600;
    if (end - a.t < 2 * 3600) continue;
    // The next 3 AM after this train: is it inside the break?
    const t3 = a.t + ((180 - nyDayAt(a.t).mins + 1440) % 1440) * 60;
    if (t3 <= end) out.push({ id: a.id, t: a.t, until: b ? b.t : null });
  }
  // The schedule ends with tonight's last trains, so tomorrow's first isn't in
  // it: use this morning's (same time a day later) when tomorrow is the same
  // kind of day (weekday, Saturday, Sunday) as today.
  const known = out.find((o) => o.until);
  for (const o of out) {
    if (o.until || !known) continue;
    const guess = known.until + Math.round((o.t - known.t) / 86400) * 86400;
    if (guess > o.t && nyDayAt(guess).day === nyDayAt(known.until).day) o.until = guess;
  }
  return out;
}
async function loadNjtLast() {
  if (!window.PENN_RELAY) return;
  try {
    const d = await (await fetch(`${window.PENN_RELAY.replace(/\/$/, '')}/njt-day`)).json();
    const deps = (d.ITEMS || []).filter((x) => x.dest && !/^new york/i.test(x.dest)).map((x) => ({ t: njtTime2(x.t), id: String(x.id), line: x.line })).filter((x) => x.t).sort((a, b) => a.t - b.t);
    const map = new Map();
    const byLine = new Map();
    for (const x of deps) { if (!byLine.has(x.line)) byLine.set(x.line, []); byLine.get(x.line).push(x); }
    for (const [line, list] of byLine) for (const o of lastBeforeBreak(list)) map.set(o.id, { ...(map.get(o.id) || {}), line: true, until: o.until, t: o.t, lineName: line });
    for (const o of lastBeforeBreak(deps)) map.set(o.id, { ...(map.get(o.id) || {}), all: true, allUntil: o.until, t: o.t });
    njtLast = map;
    renderRail();
  } catch (e) { console.warn('NJ Transit day schedule:', e); }
}
if (IS_PENN) { loadNjtLast(); setInterval(loadNjtLast, 30 * 60 * 1000); }
// The schedule's last train may be cancelled or missing from the live list (a
// storm, a holiday change: owner, Nov 26): then the latest train of that line
// (or of NJ Transit) that is listed, leaving no more than an hour before it, is the last.
const njtLineKey = (l) => String(l || '').toLowerCase().replace(/\s+line$/, '').replace(/[^a-z]+/g, '');
function njtLastFallback(r) {
  const listed = ((board && board.departures) || []).filter((x) => x.carrier === 'njt' && x.tone !== 'stop');
  const has = new Set(listed.map((x) => String(x.train)));
  const t = r.leaves ?? r.time;
  const out = {};
  for (const [id, e] of njtLast) {
    if (has.has(id) || !e.t || t > e.t + 15 * 60 || t < e.t - 60 * 60) continue;
    if (e.line && njtLineKey(e.lineName) === njtLineKey(r.line) && !listed.some((x) => njtLineKey(x.line) === njtLineKey(r.line) && (x.leaves ?? x.time) > t)) { out.line = true; out.until = e.until; }
    if (e.all && !listed.some((x) => (x.leaves ?? x.time) > t)) { out.all = true; out.allUntil = e.allUntil; }
  }
  return out.line || out.all ? out : null;
}
// A railroad train still running on yesterday's holiday schedule (TrainTime's
// service date, LIRR and Metro-North).
function railHolidayHtml(r) {
  // Every LIRR, Metro-North and NJ Transit train of a holiday's service day
  // (each runs a holiday schedule; Amtrak doesn't), including its trains after midnight.
  if (view !== 'departures' || r.tone === 'departed' || !['lirr', 'mnr', 'njt'].includes(r.carrier)) return '';
  const day = r.runDate || nyDayAt(r.sched || r.time).date;
  return subwayHoliday(day) ? `<div class="pills">${HOLIDAY_PILL}</div>` : '';
}
function njtLastHtml(r) {
  if (r.carrier !== 'njt' || view !== 'departures' || r.tone === 'departed' || r.tone === 'stop') return '';
  const x = njtLast.get(String(r.train)) || njtLastFallback(r);
  if (!x) return '';
  const until = (t) => (t ? ` until ${clock(t).hm} ${clock(t).ap}` : ' tonight');
  const say = x.all ? `Last NJ Transit train from Penn${until(x.allUntil)}.` : `Last ${esc(r.line)} train from Penn${until(x.until)}.`;
  return `<div class="row-last">${ICON.moon}<span>${say}</span></div>`;
}

// A delay notice on a train: one short line ("⚠ Delays up to 45 min") that
// opens to the notice's own words and other options. Opened ones stay open
// across refreshes.
const openRowAlerts = new Set();
const normNotice = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function rowAlertSummary(ns) {
  const all = ns.map((n) => n.text).join(' ');
  const mins = [...all.matchAll(/(\d+)[- ]?(?:to[- ]\d+[- ]?)?min(?:ute)?s?\b/gi)].map((m) => +m[1]).filter((x) => x > 0 && x < 300);
  const range = all.match(/(\d+)\s*(?:-|to)\s*(\d+)[- ]?min/i);
  if (/suspend/i.test(all)) return 'Service suspended';
  if (/cancel/i.test(all) && !/delay/i.test(all)) return 'Cancellations';
  // "Subject to", "may", "could": delays that might happen, said as such.
  const maybe = /\b(subject to|may|might|could|possible|potential)\b/i.test(all) ? 'Possible delays' : 'Delays';
  if (range) return `${maybe} of ${range[1]}–${range[2]} min`;
  if (mins.length && /delay|late/i.test(all)) return `${maybe} up to ${Math.max(...mins)} min`;
  return /delay|late/i.test(all) ? maybe : 'Service alert';
}
// A railroad train's notices as pills that open a dropdown: its delay
// notices (LIRR: the LIRR's own type, e.g. "Some delays"; NJ Transit, which
// sends no type: "Delays up to 45 min"), and boarding changes at a station
// it stops at (LIRR's "Boarding change", e.g. at Forest Hills).
function rowAlertHtml(r) {
  if (view !== 'departures' || r.tone === 'departed') return '';
  let ns = rowNotices(r);
  // The same notice sent twice, short and long: keep the long one.
  ns = ns.filter((n) => !ns.some((m) => m !== n && normNotice(m.text).length > normNotice(n.text).length && normNotice(m.text).startsWith(normNotice(n.text))));
  const label = ns.length ? (r.carrier === 'lirr' ? mtaType(ns[0].type) : rowAlertSummary(ns)) : '';
  const delay = ns.length ? dropPill(`${r.id}|alert`, `${label}${ns.length > 1 ? ` (${ns.length})` : ''}`, 'warn', ns, `<button type="button" class="al-map" data-options="${esc(r.id)}">Other options</button>`) : '';
  const stops = [...(r.via || []), r.place].map(normName2);
  const boarding = r.carrier === 'lirr' ? ((board && board.notices && board.notices.rail) || []).filter((n) => n.carrier === 'lirr' && happeningNow(n) && /boarding change/i.test(n.type)
    && stops.some((st) => st && normName2(n.text).includes(st))) : [];
  const board2 = boarding.length ? dropPill(`${r.id}|boarding`, 'Boarding change', 'info', boarding) : '';
  // Running late with no notice to explain it, and a status that doesn't say so.
  const hid = ns.length ? null : hiddenDelayMin(r);
  const late = hid === null ? '' : warnPill(hid ? `${hid} min late` : 'Running late');
  return pills(late, delay, board2);
}
document.addEventListener('toggle', (e) => {
  const d = e.target;
  if (!d.classList || !d.classList.contains('row-alert') || !d.dataset.key) return;
  if (d.open) openRowAlerts.add(d.dataset.key); else openRowAlerts.delete(d.dataset.key);
}, true);
// Subway: delay notices on a line's rows.
// (A notice that starts "Downtown" or "Uptown" applies to that direction only.)
const subwayDelays = (route, dir) => ((board && board.notices && board.notices.subway) || []).filter((n) => /delay/i.test(n.type) && isDelayNotice(n) && (n.lines || []).includes(route)
  && dirMatch(n, dir));

// Some of a line's trains running express (skipping local stops): the
// riders affected are those using local stops, so the note and its options go
// under the line's local service (or, if none is listed, its Local section).
// A notice naming one direction ("Some uptown C trains...") applies to that one.
// Which way a notice's trains run, for any line at any hub (owner, Nov 26):
// "uptown"/"northbound" and "downtown"/"southbound" say it outright; "<place>-
// bound" ("Woodlawn-bound [4]", "Flushing-bound [7]", "Manhattan-bound",
// "Brooklyn-bound") is the direction whose last stops are nearest that place,
// measured from where the notice applies. null: both ways (or can't tell).
const BOROUGH_AT = { manhattan: [40.758, -73.985], brooklyn: [40.65, -73.95], bronx: [40.85, -73.88], queens: [40.73, -73.82] };
const normStn = (x) => String(x).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const kmLL = (a, b) => Math.hypot((a[0] - b[0]) * 111, (a[1] - b[1]) * 84);
const noticeDirs = new Map();
function noticeDir(n) {
  const memo = `${n.id}|${n.text}`;
  if (noticeDirs.has(memo)) return noticeDirs.get(memo);
  const first = String(n.text).split(/\.\s/)[0];
  const down = /\b(downtown|southbound)\b/i.test(first), up = /\b(uptown|northbound)\b/i.test(first);
  let dir = down !== up ? (down ? 'S' : 'N') : null;
  const bound = [...first.matchAll(/([A-Z][\w.'’]*(?:[ -][A-Z0-9][\w.'’]*)*)-bound\b/g)].map((m) => m[1]);
  if (!dir && bound.length && subwayData) {
    const line = (n.lines || []).map((l) => l.replace(/X$/, '')).find((l) => subwayData.terminals && subwayData.terminals[l]);
    const ends = line && subwayData.terminals[line];
    if (ends) {
      // Where the notice applies: its stations on that line, else this hub.
      const at = ((n.affected || {})[line] || []).filter((id) => subwayData.stops[id]).map(LL)[0] || HUB.ll;
      const votes = bound.map((place) => {
        const key = normStn(place);
        const p = BOROUGH_AT[key] || (() => {
          const hit = Object.entries(subwayData.stops).find(([, v]) => normStn(v[0]) === key) || Object.entries(subwayData.stops).find(([, v]) => normStn(v[0]).startsWith(key));
          return hit && [hit[1][1], hit[1][2]];
        })();
        if (!p) return null;
        // The direction whose last stops are nearer that place than the notice's stretch is.
        const score = (d) => Math.min(...(ends[d] || []).filter((id) => subwayData.stops[id]).map((id) => kmLL(LL(id), p) - kmLL(at, p)));
        return score('N') < score('S') ? 'N' : 'S';
      }).filter(Boolean);
      if (votes.length && votes.every((v) => v === votes[0])) dir = votes[0];
    }
  }
  if (subwayData) noticeDirs.set(memo, dir);
  return dir;
}
const dirMatch = (n, dir) => {
  const d = noticeDir(n);
  return !dir || !d || d === dir;
};
// Trains skipping local stops ("running express", "local to express"). Not
// "express to local": that's an express line making extra local stops.
const isSwitchNotice = (n) => happeningNow(n) && !/express to local/i.test(`${n.type} ${n.text}`)
  && /\b(running|runs|run|operating|operates)\s+express\b|\bexpress (between|from|in)\b|\bexpress to (?!local)|local to express/i.test(`${n.type} ${n.text}`);
const subwayExpressSwitch = (route, dir) => ((board && board.notices && board.notices.subway) || []).filter((n) => isSwitchNotice(n) && (n.lines || []).includes(route) && dirMatch(n, dir));
// (Only used when the line has no local row to carry the pill.)
const switchNoteHtml = (route, dir) => (subwayExpressSwitch(route, dir).length
  ? `<div class="none-row">${bulletHtml(route)}<span>Some ${lineName(route)} trains are running express and skip local stops. Other options are in the service notices.</span></div>` : '');

// The options sheet: other ways to where the delayed train goes.
// Stations every train shares (Penn itself, the hubs on the way out): not a reason to switch.
const SHARED_SKIP = /^(new york penn station|penn station|jamaica|woodside|forest hills|kew gardens|secaucus.*|newark penn station|grand central|grand central madison|harlem 125 st)$/i;
const normName2 = (s) => String(s || '').toLowerCase().replace(/-sec\b|✈|&#9992;?/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
// ---------- Railroad timetables: LIRR and NJ Transit ----------
// For a delayed train: the quickest ways from Penn to the stations it serves,
// direct or with one change (at Jamaica, Secaucus, Newark…), from the
// railroad's timetable (scripts/build-lirr-timetable.py, build-njt-timetable.py).
// A first train that's on the live board shows its live time and track
// instead (matched by train number), so a card switches from "Scheduled" to
// "Live" by itself (owner, Nov 24).
// Metro-North (Grand Central): docs/mnr-timetable.json, the same format, from Grand Central.
const TT = { lirr: { file: 'lirr-timetable.json', change: 180 }, njt: { file: 'njt-timetable.json', change: 240 }, mnr: { file: 'mnr-timetable.json', change: 180 } };
let lirrTT, njtTT, mnrTT;  // undefined: not loaded; null: couldn't load
const ttLoading = {};
const ttOf = (c) => (c === 'lirr' ? lirrTT : c === 'mnr' ? mnrTT : njtTT);
const loadTT = (c) => ttLoading[c] || (ttLoading[c] = fetch(TT[c].file).then((x) => (x.ok ? x.json() : null)).catch(() => null).then((d) => { if (c === 'lirr') { lirrTT = d; lastLirrCache.clear(); } else if (c === 'mnr') mnrTT = d; else njtTT = d; }));
// Where trips start in a timetable: the hub's own station (the LIRR file's "penn" is Penn;
// at Grand Central the LIRR leaves from Grand Central Madison, HUB.lirrStop).
const ttFrom = (tt) => (tt && tt === lirrTT ? HUB.lirrStop || tt.penn : tt && tt.penn);
const loadLirrTT = () => loadTT('lirr');
setTimeout(loadLirrTT, 3000); // for last trains of the night (final call)
const trainNo = (x) => String(x || '').replace(/^0+(?=\d)/, '');
// Today's and tomorrow's trains as { route, head, train, calls: [[stop, epoch s], ...] }.
function ttTripsNear(tt, aheadH = 14) {
  const out = [];
  const nowS = Date.now() / 1000;
  for (let k = 0; k < 2; k++) {
    const day = new Set(tt.dates[nyNow(k).date.replace(/-/g, '')] || []);
    const midnight = nowS + k * 86400 - nyNow().mins * 60 - (nowS % 60);
    for (const [route, head, train, svc, flat] of tt.trips) {
      if (!day.has(svc)) continue;
      const calls = [];
      for (let i = 0; i < flat.length; i += 2) calls.push([tt.stops[flat[i]], midnight + flat[i + 1] * 60]);
      if (calls[calls.length - 1][1] < nowS || calls[0][1] > nowS + aheadH * 3600) continue;
      out.push({ route, head, train: trainNo(train), calls });
    }
  }
  return out;
}
const lirrTripsNear = () => ttTripsNear(lirrTT);
// Best plan to each target station: { first, leave, change?: { at, time, second }, arrive }.
// (windowH: how far ahead the first train may leave; the airport looks into tomorrow.)
function ttPlans(tt, changeS, targets, skipTrain, fromS, windowH = 12) {
  const trips = ttTripsNear(tt, windowH + 4);
  const penn = ttFrom(tt);
  const byStop = new Map();
  for (const t of trips) t.calls.forEach(([sid], i) => { if (!byStop.has(sid)) byStop.set(sid, []); byStop.get(sid).push([t, i]); });
  const firsts = trips.map((t) => [t, t.calls.findIndex(([sid]) => sid === penn)])
    .filter(([t, i]) => i >= 0 && i < t.calls.length - 1 && t.calls[i][1] >= fromS && t.calls[i][1] <= fromS + windowH * 3600 && t.train !== skipTrain);
  const best = new Map();
  // Earliest arrival; for the same arrival, no change beats a change, then the
  // later train from Penn (less waiting at the change).
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
        if (u.calls.slice(k + 1).some(([sid]) => sid === penn)) continue; // heading back toward Penn
        for (let m = k + 1; m < u.calls.length; m++) if (targets.has(u.calls[m][0])) offer(u.calls[m][0], { first: t, leave, change: { at: hub, time: u.calls[k][1], second: u }, arrive: u.calls[m][1] });
      }
    }
  }
  return best;
}
const hmap = (t) => { const c = clock(t); return `${c.hm} ${c.ap}`; };
const ttStopName = (c, id) => (c === 'lirr' ? (lirrData && lirrData.stops[id] ? lirrData.stops[id][0] : id) : c === 'mnr' ? ((mnrTT && mnrTT.names[id]) || id) : ((njtTT && njtTT.names[id]) || id));
// Metro-North's route ids in its timetable and notices: 1 Hudson, 2 Harlem, 3 New Haven, 4-6 its branches.
const MNR_ROUTE_NAMES = { 1: ['Hudson', 'hu'], 2: ['Harlem', 'ha'], 3: ['New Haven', 'nh'], 4: ['New Canaan', 'nh'], 5: ['Danbury', 'nh'], 6: ['Waterbury', 'nh'] };
const ttChip = (c, route) => (c === 'lirr'
  ? lirrChip((lirrData && lirrData.routes[route]) || { name: 'LIRR', color: '#555', text: '#fff' })
  : c === 'mnr' ? `<span class="plate ${(MNR_ROUTE_NAMES[route] || ['', 'mnr'])[1]}">${esc((MNR_ROUTE_NAMES[route] || ['Metro-North'])[0])}</span>`
  : `<span class="pl p-njt">${esc((typeof NJT_LINE_NAMES !== 'undefined' && NJT_LINE_NAMES[route]) || route)}</span>`);
// The options cards for a delayed train; null while its timetable loads.
function ttPlansHtml(r, mineNames) {
  const c = r.carrier;
  const tt = ttOf(c);
  if (tt === undefined) return null;
  if (!tt || (c === 'lirr' && !lirrData)) return '';
  const targets = c === 'njt'
    ? new Set((r.viaCodes || []).filter((x) => x !== 'SE' && x !== 'NP'))
    : c === 'mnr' ? new Set(Object.keys(tt.names).filter((id) => mineNames.has(normName2(tt.names[id])) && !SHARED_SKIP.test(normName2(tt.names[id]))))
    : new Set(Object.keys(lirrData.stops).filter((id) => mineNames.has(normName2(lirrData.stops[id][0])) && !SHARED_SKIP.test(normName2(lirrData.stops[id][0]))));
  if (!targets.size) return '';
  const best = ttPlans(tt, TT[c].change, targets, trainNo(r.train), Date.now() / 1000 + 60);
  const groups = new Map();
  for (const [sid, p] of best) {
    const key = `${p.first.train}|${p.change ? p.change.second.train : ''}`;
    if (!groups.has(key)) groups.set(key, { p, stops: [] });
    groups.get(key).stops.push([sid, p.arrive]);
  }
  const cards = [...groups.values()].sort((a, b) => a.p.leave - b.p.leave || b.stops.length - a.stops.length).slice(0, 5).map(({ p, stops }) => {
    const live = board.departures.find((x) => x.carrier === c && trainNo(x.train) === p.first.train && x.tone !== 'departed');
    const leave = live ? (live.leaves ?? live.time) : p.leave;
    const tag = live ? '<span class="tagx tag-live">Live</span>' : '<span class="tagx tag-sched">Scheduled</span>';
    const how = p.change ? `Change at ${esc(ttStopName(c, p.change.at))} for the ${hmap(p.change.time)} train to ${esc(p.change.second.head)}.` : 'No change.';
    stops.sort((a, b) => a[1] - b[1]);
    const gets = stops.slice(0, 6).map(([sid, at]) => `${esc(ttStopName(c, sid))} ${hmap(at)}`).join(', ') + (stops.length > 6 ? ` and ${stops.length - 6} more` : '');
    return `<li class="cm-stn"><div class="opt-h">${ttChip(c, p.first.route)}<span>${tag} ${hmap(leave)}${live && live.track ? `, track ${esc(live.track)}` : ''}</span></div>
      <span class="cm-dir">To ${esc(p.first.head)}. ${how} Gets you to ${gets}.</span></li>`;
  }).join('');
  return cards ? `<h3 class="cm-h">Other ways to the same stations</h3><ul class="cm-stns">${cards}</ul>` : '';
}
function openOptions(r) {
  changeOpen = { id: 'options', view: 1 };
  $('chg-map').hidden = true;
  const nowS = Date.now() / 1000;
  const ns = rowNotices(r);
  $('chg-kind').textContent = 'Other options';
  $('chg-h').innerHTML = `${esc(r.line)} to ${esc(r.place)}`;
  $('chg-top').innerHTML = ns.map((n) => `<p class="cm-sum">⚠ ${noticeFull(n)}</p>`).join('');
  const mine = new Set([...(r.via || []), r.place].map(normName2));
  const going = board.departures.filter((x) => x.carrier === r.carrier && x.id !== r.id && x.tone !== 'stop' && x.tone !== 'departed' && (x.leaves ?? x.time) > nowS && x.time < nowS + 3 * 3600 && rowNotices(x).length === 0);
  // Other trains from Penn (not affected by the notice) calling at stations
  // this train serves, by line: the next one and the stations they share.
  const byLine = new Map();
  for (const x of going) {
    const shared = [...(x.via || []), x.place].filter((s) => mine.has(normName2(s)) && !SHARED_SKIP.test(normName2(s)));
    if (!shared.length || x.line === r.line && (r.carrier === 'lirr' || r.carrier === 'mnr')) continue;
    const k = x.line;
    if (!byLine.has(k)) byLine.set(k, { line: k, next: x, shared: new Set() });
    shared.forEach((s) => byLine.get(k).shared.add(s));
  }
  // LIRR and NJ Transit: direct or one-change trips from the timetable, live once on the board.
  let timetable = '';
  if (TT[r.carrier]) {
    const html = ttPlansHtml(r, mine);
    if (html === null) { loadTT(r.carrier).then(() => { if (changeOpen && changeOpen.id === 'options' && $('change').open) openOptions(r); }); timetable = '<p class="cm-live">Checking the timetable…</p>'; }
    else timetable = html;
  }
  const items = [...byLine.values()].sort((a, b) => b.shared.size - a.shared.size).slice(0, 6).map((o) => {
    const t = clock(o.next.leaves ?? o.next.time);
    const s = [...o.shared];
    return `<li class="cm-stn"><div class="opt-h"><b>${esc(o.line)}</b><span>next ${t.hm} ${t.ap}${o.next.track ? `, track ${esc(o.next.track)}` : ''} to ${esc(o.next.place)}</span></div>
      <span class="cm-dir">Also stops at ${esc(s.slice(0, 6).join(', '))}${s.length > 6 ? ` and ${s.length - 6} more` : ''}</span></li>`;
  }).join('');
  const lirrDone = TT[r.carrier] && ttOf(r.carrier);
  $('chg-below').innerHTML = `${lirrDone ? (timetable || `<p class="cm-live">No other train from ${HUB.short} reaches these stations in the next few hours.</p>`)
    : `${items ? `<h3 class="cm-h">Other trains from ${HUB.short} to the same stations</h3><ul class="cm-stns">${items}</ul>` : '<p class="cm-live">No other train on the board right now stops at the same stations.</p>'}${timetable}`}
    ${r.carrier === 'njt' ? '<h3 class="cm-h">Or by PATH</h3><p class="lchips"><button type="button" class="cm-back" data-guide="newark">To Newark Penn by PATH</button> <button type="button" class="cm-back" data-guide="hoboken">To Hoboken by PATH</button></p>' : ''}
    <p class="cm-live">${TT[r.carrier] ? `Live: time and track from the live board. Scheduled: from the ${CARRIERS[r.carrier]} timetable until the train is on the board. ` : 'Times and tracks from the live board. '}Fares and tickets differ by line; check before you board.</p>`;
  openSheet();
}
// Subway delay options: other lines at the same Penn station going the same
// way that share stations with the delayed one.
function openSubwayOptions(route, dir, stnId, mode) {
  changeOpen = { id: 'options', view: 1 };
  $('chg-map').hidden = true;
  $('chg-kind').textContent = 'Other options';
  $('chg-h').innerHTML = `${bulletHtml(route, 'tiny')} ${dir === 'N' ? 'uptown' : 'downtown'} from ${esc(stationName(stnId))}`;
  $('chg-top').innerHTML = (mode === 'local' ? subwayExpressSwitch(route, dir) : subwayDelays(route, dir)).map((n) => `<p class="cm-sum">⚠ ${noticeFull(n)}</p>`).join('');
  $('chg-below').innerHTML = subwayOptionsHtml(route, dir, stnId, mode);
  openSheet();
}
// The Penn station each subway line stops at.
// The hub's station each subway line stops at (Penn: 1 2 3 at 128, A C E at A28).
const PENN_SUBWAY = Object.fromEntries(HUB.stations.flatMap((x) => x.lines.map((l) => [l, x.id])));
// "Other options" on a subway notice (delays, or local stops skipped).
const noticeHasOptions = (n) => n.carrier === 'subway' && (n.lines || []).some((l) => PENN_SUBWAY[l])
  && ((/delay/i.test(n.type) && isDelayNotice(n)) || isSwitchNotice(n));
const optionsBtn = (n) => (noticeHasOptions(n) ? ` <button type="button" class="al-map" data-nopt="${esc(n.id)}">Other options</button>` : '');
function openNoticeOptions(id) {
  const n = ((board && board.notices && board.notices.subway) || []).find((x) => x.id === id);
  if (!n || !subwayData) return;
  const mode = isSwitchNotice(n) && !(/delay/i.test(n.type) && isDelayNotice(n)) ? 'local' : '';
  changeOpen = { id: 'options', view: 1 };
  $('chg-map').hidden = true;
  $('chg-kind').textContent = 'Other options';
  const lines = n.lines.filter((l) => PENN_SUBWAY[l] && subwayData.routes[l]);
  $('chg-h').innerHTML = `${lines.map((l) => bulletHtml(l, 'tiny')).join('')} from ${esc(stationName(PENN_SUBWAY[lines[0]] || HUB.stations[0].id))}`;
  $('chg-top').innerHTML = `<p class="cm-sum">⚠ ${noticeFull(n)}</p>`;
  const dirs = ['N', 'S'].filter((d) => dirMatch(n, d));
  $('chg-below').innerHTML = lines.flatMap((l) => dirs.map((d) => `<h3 class="cm-h">Instead of the ${dirs.length > 1 ? (d === 'N' ? 'uptown ' : 'downtown ') : ''}${lineName(l)}</h3>${subwayOptionsHtml(l, d, PENN_SUBWAY[l], mode, true)}`)).join('');
  openSheet();
}
function subwayOptionsHtml(route, dir, stnId, mode, bare) {
  const nowS = Date.now() / 1000;
  const mine = subwayData.routes[route].normalSet;
  // For local stops being skipped, only trains that make local stops help.
  const groups = board.subway.filter((g) => g.route !== route && g.dir === dir && g.trains[0] && g.trains[0].stops[0] === stnId && (mode !== 'local' || g.svc === 'local'));
  const best = new Map();
  for (const g of groups) {
    const shared = subwayData.routes[g.route].normal.filter((id) => mine.has(id) && id !== stnId).length;
    const t = g.trains.find((x) => x.time >= nowS - 30);
    if (!shared || !t) continue;
    if (!best.has(g.route) || best.get(g.route).t.time > t.time) best.set(g.route, { route: g.route, shared, t, svc: g.svc });
  }
  // What it does for the rider (owner, Nov 24: not "shares N stations"): how far
  // it goes along this line's route before you'd change back.
  // "Shares N stations with the X", tap to see which (owner, Nov 24), in the
  // order the other train reaches them.
  const helps = (o) => {
    const ids = [...new Set((o.t.stops || []).filter((id) => mine.has(id) && id !== stnId))];
    if (!ids.length) return `Shares ${o.shared} stations with the ${lineName(route)}`;
    return `<details class="shared"><summary>Shares ${ids.length} station${ids.length === 1 ? '' : 's'} with the ${lineName(route)}</summary><ul>${ids.map((id) => `<li>${esc(stationName(id))}</li>`).join('')}</ul></details>`;
  };
  const items = [...best.values()].sort((a, b) => b.shared - a.shared).map((o) => `<li class="cm-stn"><div class="opt-h">${bulletHtml(o.route, 'tiny')}<span>${o.svc === 'express' ? 'Express' : 'Local'}, next in ${Math.max(0, Math.round((o.t.time - nowS) / 60))} min${subwayDelays(o.route, dir).length ? ' (also delayed)' : ''}</span></div><span class="cm-dir">${helps(o)}</span></li>`).join('');
  if (!items) return '<p class="cm-live">No other line from this station shares its stops.</p>';
  return `${bare ? '' : `<h3 class="cm-h">${mode === 'local' ? 'Other trains making local stops' : 'Other trains from this platform'}</h3>`}<ul class="cm-stns">${items}</ul>`;
}
document.addEventListener('click', (e) => {
  const lg = e.target.closest('[data-lguide]');
  if (lg) { e.preventDefault(); openLirrGuide(lg.dataset.lguide); return; }
  const g = e.target.closest('[data-guide]');
  if (g) { e.preventDefault(); openGuide(g.dataset.guide); return; }
  const o = e.target.closest('[data-options]');
  if (o) { e.preventDefault(); e.stopPropagation(); const r = board.departures.find((x) => x.id === o.dataset.options); if (r) openOptions(r); return; }
  const s = e.target.closest('[data-sopt]');
  if (s) { e.preventDefault(); e.stopPropagation(); const [route, dir, stn, mode] = s.dataset.sopt.split('|'); openSubwayOptions(route, dir, stn, mode); return; }
  const no = e.target.closest('[data-nopt]');
  if (no) { e.preventDefault(); e.stopPropagation(); openNoticeOptions(no.dataset.nopt); }
}, true);
$('path-notices').addEventListener('click', (e) => {
  const b = e.target.closest('[data-change]');
  if (b) openChange(b.dataset.change);
});

$('change').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) return closeChange();
  const v = e.target.closest('[data-view]');
  if (v && changeOpen) openChange(changeOpen.id, +v.dataset.view);
});
$('chg-close').addEventListener('click', closeChange);
$('alerts').addEventListener('click', (e) => {
  const b = e.target.closest('[data-change]');
  if (b) openChange(b.dataset.change);
});
$('rail-notices').addEventListener('click', (e) => {
  const b = e.target.closest('[data-change]');
  if (b) openChange(b.dataset.change);
});
$('subway-notices').addEventListener('click', (e) => {
  const b = e.target.closest('[data-change]');
  if (b) openChange(b.dataset.change);
});
// "See map" inside a pill's dropdown on the subway list (reroutes, skipped stops).
$('subway').addEventListener('click', (e) => {
  const b = e.target.closest('[data-change]');
  if (b) openChange(b.dataset.change);
});
// A "Rerouted, see map" row opens the notice behind it when there is one.
const changeFor = (route, dir) => changeModels().find((m) => m.route === route && !m.skip && happeningNow(m.n) && dirMatch(m.n, dir));
// Trains sent express under a notice (sometimes on another line's express
// track) aren't "rerouted": the notice's own pill covers them. A notice about
// skipping a station never adds stations, so it doesn't count (owner, Nov 26:
// "Woodlawn-bound 4 skips Burnside Av" was hiding a rerouted 4).
const skipFor = (route, dir) => changeModels().find((m) => m.route === route && m.skip && isSwitchNotice(m.n) && happeningNow(m.n) && dirMatch(m.n, dir));

function renderPath() {
  if (!board || !HUB.path) return; // PATH's 33 St station is Penn's neighbour
  const nowS = Date.now() / 1000;
  const byDest = new Map();
  for (const x of board.path || []) {
    const m = Math.round((x.time - nowS) / 60);
    if (m < 0) continue;
    if (!byDest.has(x.dest)) byDest.set(x.dest, { colors: x.colors, mins: [], first: x.time });
    byDest.get(x.dest).mins.push(m);
  }
  if (!byDest.size) { renderPathSchedule(); return; }
  loadPathSchedule(); // its switch times drive the tags and banner
  $('path').innerHTML = renderPathPattern() + [...byDest].map(([dest, g]) => {
    const mins = g.mins.slice(0, 3);
    const firstMin = mins[0] === 0 ? '<b class="now">now</b>' : `<b>${mins[0]}</b> min`;
    const rest = mins.length > 1 ? `, ${mins.slice(1).join(', ')}` : '';
    const dots = (g.colors.length ? g.colors : ['']).map((c) => `<i${c ? ` style="background:#${c}"` : ''}></i>`).join('');
    const lateP = pathLateNight(dest, nowS + (mins[0] || 0) * 60);
    const pill = lateP ? LATE_PILL : (holidayOn(nowS + (mins[0] || 0) * 60) ? HOLIDAY_PILL : '');
    return `<div class="sline" data-k="path|${esc(dest)}"><span class="pdots" aria-hidden="true">${dots}</span><span class="sdest">${esc(dest)}${pills(pill, pathTrouble(dest, g.first))}</span><span class="smins">${firstMin}${rest}</span></div>`;
  }).join('') + '<p class="sched-note live-note">Live times from PATH.</p>';
  holdHeights($('path'));
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
    ...(pathSchedule.days[pathKey(today)] || []).filter((d) => d.t >= today.mins),
    ...(pathSchedule.days[pathKey(tomorrow)] || []).map((d) => ({ ...d, t: d.t + 1440 })),
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
    const tP = Date.now() / 1000 + (((g.times[0] - nyNow().mins) % 1440) + 1440) % 1440 * 60;
    const pill = pathLateNight(dest, tP) ? LATE_PILL : (holidayOn(tP) ? HOLIDAY_PILL : '');
    // How often trains run: the typical gap between the next few trains.
    const ts = [...g.times, ...g.later].slice(0, 5);
    const gaps = ts.slice(1).map((t, i) => t - ts[i]).sort((a, b) => a - b);
    const every = gaps.length ? `<span class="every-sub">About every ${gaps[Math.floor(gaps.length / 2)]} min</span>` : '';
    return `<div class="sline"><span class="pdots" aria-hidden="true">${dots}</span><span class="sdest">${esc(dest)}${pills(pill, pathTrouble(dest))}${every}</span><span class="smins"><b>${first}</b>${rest.length ? ', ' + rest.join(', ') : ''}</span></div>`;
  }).join('');
  $('path').innerHTML = renderPathPattern() + (lines || '<p class="empty">No PATH trains are scheduled from 33 St in the next hour.</p>') + note;
}

// ---------- service notices ----------
// One strip per place: railroads above the train list, the subway in its
// panel. It starts collapsed; opening it is remembered for this visit until
// the set of notices changes.
const friendlyType = (t) => {
  const x = t.replace(/^(Upcoming: )?Planned - /, (m, up) => (up ? 'Upcoming planned work, ' : 'Planned work, '));
  return x.charAt(0).toUpperCase() + x.slice(1).toLowerCase(); // sentence case
};
function noticeWho(n) {
  if (n.carrier === 'subway') return n.lines.filter((l) => /^[A-Z0-9]{1,2}$/.test(l)).slice(0, 4).map((l) => bulletHtml(l, 'tiny')).join('') || bulletHtml('S', 'tiny');
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
  // A line in brackets ("[1]") is its badge; until line colours have loaded,
  // just the line's name, never the brackets.
  .replace(/\[([A-Z0-9]{1,2})\]/g, (m, l) => (subwayData && subwayData.routes[l] ? bulletHtml(l, 'tiny') : `<b>${l}</b>`))
  .replace(/ {2,}/g, ' ').trim();
function noticeStrip(list, where) {
  if (!list || !list.length) return '';
  const sig = list.map((n) => n.id).join('|');
  // Starts collapsed (owner's choice); once opened it stays open for this visit
  // until it's closed (owner, Nov 26: it was closing by itself whenever the MTA
  // updated a notice, which changes the notice's id).
  let opened = false;
  try { opened = !!sessionStorage.getItem('opened-' + where); } catch {}
  const urgent = list.some((n) => n.urgent);
  const label = where === 'subway' ? 'Subway service notices' : where === 'path' ? 'PATH alerts' : `Service notices for trains at ${HUB.short}`;
  // Notices that close or reroute part of a line open a map.
  const mapBtn = (n) => (typeof changeModel === 'function' && (changeModel(n) || lirrModel(n) || pathModel(n)) ? ` <button type="button" class="al-map" data-change="${esc(n.id)}">See map</button>` : '');
  const items = list.map((n) => `<div class="al-item${n.urgent ? ' urgent' : ''}" data-nid="${esc(n.id)}"><span class="who">${noticeWho(n)}</span><p style="margin:0"><span class="kind">${esc(friendlyType(n.type))}</span>${noticeFull(n)}${mapBtn(n)}${optionsBtn(n)}</p></div>`).join('');
  return `<details class="al-strip${urgent ? ' urgent' : ''}" data-where="${where}" data-sig="${esc(sig)}"${opened ? ' open' : ''}><summary><span class="n">${list.length}</span><span>${label}</span><span class="more"><span class="hide">Hide</span><span class="show">Show</span></span></summary>${items}</details>`;
}
// Add #preview to the address to see the next week's planned LIRR and subway
// work as notices, with their maps (to check maps before work is in effect).
const PREVIEW = /preview/i.test(location.hash);
let previewNotices = [];
if (PREVIEW) Promise.all([PennFeeds.upcomingNotices('lirr'), PennFeeds.upcomingNotices('subway')])
  .then(([l, s]) => { previewNotices = [...l, ...s].filter((n) => /planned/i.test(n.type)); renderServiceNotices(); }).catch(() => {});
function renderServiceNotices() {
  if (!board || !board.notices) return;
  if (PREVIEW && previewNotices.length) {
    const have = new Set([...board.notices.rail, ...board.notices.subway].map((n) => n.id));
    for (const n of previewNotices) {
      const p = { ...n, type: `Upcoming: ${n.type}` };
      // Only those that open a map: the point of the preview.
      if (have.has(n.id) || !(lirrModel(p) || changeModel(p))) continue;
      (n.carrier === 'lirr' ? board.notices.rail : board.notices.subway).push(p);
    }
  }
  $('rail-notices').innerHTML = noticeStrip(board.notices.rail, 'rail');
  $('subway-notices').innerHTML = noticeStrip(board.notices.subway, 'subway');
  $('path-notices').innerHTML = noticeStrip(board.notices.path, 'path');
  $('njt-alt').innerHTML = railAltHtml();
  renderAlertsTab();
}
// ---------- elevator and escalator outages at Penn (owner, Nov 25) ----------
// The MTA's live outage feed (no key; the page reads it directly) for 34 St-Penn
// Station: both subway stations and the LIRR entrance. docs/penn-elevators.json
// (scripts/build-penn-elevators.py, weekly) adds the MTA's own advice for each.
// Shown in the subway panel and on the Alerts tab.
const ENE_FEED = 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fnyct_ene.json';
const ENE_STATIONS = new Set(HUB.elevatorStations);
let eneOut = [], eneInfo = {}, eneAt = 0;
function loadElevators() {
  if (Date.now() - eneAt < 3 * 60000) return;
  eneAt = Date.now();
  if (!Object.keys(eneInfo).length) fetch('penn-elevators.json').then((r) => (r.ok ? r.json() : {})).then((d) => { eneInfo = d || {}; renderElevators(); }).catch(() => {});
  fetch(ENE_FEED, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status))))
    .then((d) => { eneOut = (Array.isArray(d) ? d : []).filter((x) => ENE_STATIONS.has(x.station) && x.isupcomingoutage !== 'Y'); renderElevators(); })
    .catch(() => {});
}
// "11/25/2026 02:00:00 PM" (New York time) -> "about 2 PM today" / "about 2 PM Fri, Nov 27".
function eneWhen(x) {
  const m = /(\d+)\/(\d+)\/(\d+) (\d+):(\d+):\d+ (AM|PM)/.exec(x || '');
  if (!m) return '';
  const time = `${+m[4]}${m[5] !== '00' ? ':' + m[5] : ''} ${m[6]}`;
  const ymd = `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  if (ymd === nyNow().date) return `about ${time} today`;
  if (ymd === nyNow(1).date) return `about ${time} tomorrow`;
  const d = new Date(`${ymd}T12:00:00`);
  return `about ${time} ${d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`;
}
const ENE_ICON = '<svg class="ic ene-ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="4" r="2" fill="currentColor"/><path d="M19 13v-2c-1.5 0-3-.6-4-1.6l-1.3-1.4c-.4-.4-1-.7-1.6-.7-1.1 0-2 .9-2 2v5.7c0 1.1.9 2 2 2h5v5h2v-5.5c0-1.1-.9-2-2-2h-3v-3.5c1.3 1.1 3 1.9 4.9 2zM12.1 19a3 3 0 0 1-5.8-1 3 3 0 0 1 2.3-2.9v-2.1A5 5 0 1 0 14.1 19z" fill="currentColor"/></svg>';
// Alerts minimized to one line (event and elevator alerts), remembered on this device.
const readMin = () => { try { return JSON.parse(localStorage.getItem('eventsMin') || '[]'); } catch { return []; } };
const evMin = new Set(readMin());
// Every open board shares the list (side by side, other tabs): take the others'
// changes as they happen, and never save over them with an old copy (owner,
// Nov 26: "it says it's minimized but is still showing").
addEventListener('storage', (e) => {
  if (e.key !== 'eventsMin') return;
  evMin.clear(); readMin().forEach((x) => evMin.add(x));
  renderElevators(); renderEvents();
});
function elevatorsHtml() {
  return eneOut.map((x) => {
    const info = eneInfo[x.equipment] || {};
    const kind = x.equipmenttype === 'ES' ? 'Escalator' : 'Elevator';
    const what = info.short || x.serving || '';
    const back = eneWhen(x.estimatedreturntoservice);
    // The MTA's advice, without its own status line ("out of service for replacement"), which may be older than the outage.
    const advice = String(info.alt || '').replace(/^[^.]*out of service[^.]*\.\s*/i, '');
    const alt = advice ? `<details class="ene-alt" data-k="ene-${esc(x.equipment || '')}"><summary>What to do instead</summary><p>${esc(advice)}</p></details>` : '';
    // Minimizes like the event alerts (owner, Nov 26: "same with the elevator alert").
    const id = `ene-${x.equipment || what}`;
    if (evMin.has(id)) return `<button type="button" class="ene-note ev-min" data-evmin="${esc(id)}" aria-expanded="false">${ENE_ICON}<span><b>${kind} out</b>: ${esc(what)}</span><span class="ev-open">Show</span></button>`;
    return `<div class="ene-note">${ENE_ICON}<div><p><b>${kind} out</b>${x.trainno ? ` at the ${esc(x.trainno)} station` : ''}: ${esc(what)}.${back ? ` Back in service by ${esc(back)} (MTA estimate).` : ''}</p>${alt}</div><button type="button" class="ev-hide" data-evmin="${esc(id)}" aria-expanded="true" aria-label="Minimize the ${kind.toLowerCase()} alert" title="Minimize">–</button></div>`;
  }).join('');
}
function renderElevators() {
  const el = $('elevators');
  if (el) setKeepOpen(el, elevatorsHtml());
  if (board && board.notices) renderAlertsTab();
}
loadElevators();
setInterval(loadElevators, 60000);

// ---------- event warnings (owner, Nov 25) ----------
// Big events that crowd the stations: games and shows at Madison Square
// Garden (right above Penn) and UBS Arena (LIRR to Elmont-UBS Arena).
// docs/events.json (scripts/build-events.py, daily: the NHL's schedule and any
// owner-listed events) plus Ticketmaster through the relay once its key is set.
// Shown from 2 hours before the start until an hour after the usual end.
let stationEvents = [];
let eventsAt = 0;
const EVENT_MIN = { hockey: 160, basketball: 150, sports: 180, show: 180 };
function loadEvents() {
  if (Date.now() - eventsAt < 30 * 60000) return;
  eventsAt = Date.now();
  const get = (u) => fetch(u, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  Promise.all([get('events.json'), window.PENN_RELAY ? get(window.PENN_RELAY + '/events') : null]).then(([a, b]) => {
    // Only the venues reached from this hub (Penn: Madison Square Garden, UBS Arena).
    const all = [...((a && a.events) || []), ...((b && b.events) || [])].filter((e) => HUB.eventVenues.test(e.venue || ''));
    const seen = new Set();
    stationEvents = all.filter((e) => {
      const k = `${e.venue}|${Math.round(Date.parse(e.start) / 600000)}`; // same venue, same start: one event
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).sort((x, y) => Date.parse(x.start) - Date.parse(y.start));
    renderEvents();
  });
}
function eventsNow(nowS) {
  return stationEvents.map((e) => {
    const start = Date.parse(e.start) / 1000;
    const end = start + (EVENT_MIN[e.kind] || 180) * 60;
    return { ...e, startS: start, endS: end };
  }).filter((e) => nowS >= e.startS - 2 * 3600 && nowS <= e.endS + 3600);
}
function eventText(e, nowS) {
  const at = (t) => hm(t).replace(':00 ', ' ');
  // Venues reached from another hub (Grand Central): Yankee Stadium by Metro-North, Citi Field by the 7.
  if (!IS_PENN && !/UBS/i.test(e.venue)) {
    const how = /Yankee/i.test(e.venue) ? 'Hudson and Harlem Line trains to Yankees-E 153 St' : 'the 7 to Mets-Willets Point';
    if (nowS < e.startS) return `<b>${esc(e.title)}</b> at ${esc(e.venue)}, ${at(e.startS)}. Expect crowds on ${how}.`;
    if (nowS < e.endS) return `<b>${esc(e.title)}</b> at ${esc(e.venue)} ends around ${at(e.endS)}. Expect crowded trains back after that.`;
    return `<b>${esc(e.title)}</b> just ended at ${esc(e.venue)}. Trains back toward Manhattan will be crowded.`;
  }
  const msg = /garden/i.test(e.venue);
  const where = msg ? 'Madison Square Garden' : e.venue;
  if (nowS < e.startS) return msg
    ? `<b>${esc(e.title)}</b> at ${where}, ${at(e.startS)}. Expect crowds at Penn before it starts and when it ends, around ${at(e.endS)}.`
    : `<b>${esc(e.title)}</b> at ${esc(where)}, ${at(e.startS)}. LIRR trains to Elmont-UBS Arena will be crowded.`;
  if (nowS < e.endS) return msg
    ? `<b>${esc(e.title)}</b> at ${where} ends around ${at(e.endS)}. Expect crowds at Penn from then.`
    : `<b>${esc(e.title)}</b> at ${esc(where)} ends around ${at(e.endS)}. Expect crowded LIRR trains back toward ${HUB.short} after that.`;
  return msg
    ? `<b>${esc(e.title)}</b> just ended at ${where}. Expect crowds at Penn for the next hour.`
    : `<b>${esc(e.title)}</b> just ended at ${esc(where)}. LIRR trains back toward ${HUB.short} will be crowded.`;
}
const EVENT_ICON = '<svg class="ic ev-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M16 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm-8 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm0 2c-2.3 0-7 1.2-7 3.5V19h14v-2.5C15 14.2 10.3 13 8 13zm8 0c-.3 0-.6 0-1 .1 1.2.8 2 2 2 3.4V19h6v-2.5c0-2.3-4.7-3.5-7-3.5z" fill="currentColor"/></svg>';
function eventsHtml() {
  const nowS = Date.now() / 1000;
  return cityEventsHtml(nowS) + eventsNow(nowS).map((e) => `<div class="ev-note">${EVENT_ICON}<p>${eventText(e, nowS)}</p></div>`).join('');
}

// ---------- city events: parades, marathons, street closures (owner, Nov 26) ----------
// docs/city-events.json lists each event once, with its route and the MTA's own
// lists of affected bus routes and subway lines. Every hub, now or added later,
// works out for itself whether it's affected: within the event's radiusKm of
// the route, or sharing a bus route or subway line with it. The live MTA bus
// and subway alerts below add the details as the MTA posts them.
let cityEvents = [];
const HUB_BUS_LINES = [...new Set((HUB.busStops || []).flatMap((b) => b.lines))];
const HUB_SUB_LINES = [...new Set(HUB.stations.flatMap((s) => s.lines))];
function kmToRoute(ll, route) {
  const kx = 111.32 * Math.cos(ll[0] * Math.PI / 180), ky = 110.57;
  let best = Infinity;
  for (let i = 0; i + 1 < route.length; i++) {
    const ax = (route[i][1] - ll[1]) * kx, ay = (route[i][0] - ll[0]) * ky, bx = (route[i + 1][1] - ll[1]) * kx, by = (route[i + 1][0] - ll[0]) * ky;
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}
// The daily check of every agency's notices before an event (service-check.json,
// scripts/check-service.py): when it last ran, and the notices about the event.
let serviceCheck = null;
const AGENCY_FOR = { 'MTA subway': 'subway', 'MTA bus': 'bus', LIRR: 'lirr', 'Metro-North': 'mnr', 'NJ Transit': 'njt', PATH: 'path' };
function checkHtml(e, nowS) {
  const c = serviceCheck;
  if (!c || !c.events || !c.events[e.id]) return '';
  const lineName = (r) => r.replace(/\+$/, '-SBS');
  // Only what concerns this hub: its bus routes, its subway lines, its railroads.
  const mine = c.events[e.id].filter((a) => {
    const k = AGENCY_FOR[a.agency];
    if (k === 'bus') return (a.routes || []).some((r) => HUB_BUS_LINES.includes(lineName(r)));
    if (k === 'subway') return (a.routes || []).some((r) => HUB_SUB_LINES.includes(r));
    if (k === 'path') return !!HUB.path;
    return !k || HUB.rails.includes(k);
  });
  const ok = Object.entries(c.sources || {}).filter(([, v]) => v.ok).map(([n]) => n.replace(/ \(.*\)$/, ''));
  const names = [...new Set(ok)];
  const list = mine.length ? `<ul class="ev-list">${mine.map((a) => `<li><b>${esc(a.agency)}:</b> ${noticeText(a.head)}</li>`).join('')}</ul>` : '';
  return `<span class="ev-sub">${list}<span class="ev-checked">Checked every morning with ${esc(names.join(', '))}; last ${esc(dayTime(c.checked, nowS))}.</span></span>`;
}
function loadCityEvents() {
  fetch('service-check.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null).then((d) => { serviceCheck = d; renderEvents(); });
  fetch('city-events.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null).then((d) => {
    cityEvents = ((d && d.events) || []).map((e) => {
      const near = e.route && e.route.length > 1 ? kmToRoute(HUB.ll, e.route) : Infinity;
      return { ...e, startS: Date.parse(e.start) / 1000, endS: Date.parse(e.end) / 1000, fromS: Date.parse(e.showFrom || e.start) / 1000 - (e.showFrom ? 0 : 48 * 3600),
        near: near <= (e.radiusKm || 1), buses: HUB_BUS_LINES.filter((l) => (e.busRoutes || []).includes(l)), lines: HUB_SUB_LINES.filter((l) => (e.lines || []).includes(l)) };
    }).filter((e) => e.near || e.buses.length || e.lines.length);
    renderEvents();
  });
}
// "today 8:30 AM", "tomorrow", "Sat Nov 28 8:30 AM".
function dayTime(t, nowS = Date.now() / 1000) {
  const c = clock(t), time = `${c.hm} ${c.ap}`.replace(':00 ', ' ');
  const d = nyDayAt(t).date, today = nyDayAt(nowS).date, tmrw = nyDayAt(nowS + 86400).date;
  if (d === today) return `today ${time}`;
  if (d === tmrw) return `tomorrow ${time}`;
  return `${new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(t * 1000))} ${time}`;
}
const cityEventsNow = (nowS) => cityEvents.filter((e) => nowS >= e.fromS && nowS <= e.endS + 2 * 3600);
document.addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-evmin]'); if (!b) return;
  const id = b.dataset.evmin;
  const open = evMin.has(id);
  evMin.clear(); readMin().forEach((x) => evMin.add(x)); // the latest, from every board
  open ? evMin.delete(id) : evMin.add(id);
  try { localStorage.setItem('eventsMin', JSON.stringify([...evMin])); } catch {}
  if (id.startsWith('ene-')) renderElevators(); else renderEvents();
  document.querySelector(`[data-evmin="${CSS.escape(id)}"]`)?.focus();
});
function cityEventsHtml(nowS) {
  return cityEventsNow(nowS).map((e) => {
    const c = clock(e.endS), end = c.hm === '12:00' ? (c.ap === 'PM' ? 'noon' : 'midnight') : `${c.hm} ${c.ap}`;
    const when = nowS < e.startS ? `${dayTime(e.startS, nowS)} to about ${end}` : nowS < e.endS ? `happening now, until about ${end}` : 'just ended; streets are reopening';
    const here = e.near ? `Expect closed streets and crowds near ${esc(HUB.name)}. ` : '';
    const buses = e.buses.length ? `<span class="ev-sub">Buses here with changes: ${e.buses.map(busBadge).join(' ')}</span>` : '';
    const lines = e.lines.length ? `<span class="ev-sub">Subway: ${e.lines.map((l) => bulletHtml(l, 'tiny')).join(' ')} service changes</span>` : '';
    const more = `<span class="ev-sub"><button type="button" class="al-map" data-cityevent="${esc(e.id)}">Route map</button>${e.source ? ` <a class="alt-map" href="${esc(e.source.url)}" target="_blank" rel="noopener">${esc(e.source.label)}&nbsp;↗&#xFE0E;</a>` : ''}</span>`;
    // One short line, the rest folded (it sits above the trains on a phone).
    const which = [e.buses.length ? 'buses' : '', e.lines.length ? 'subway' : ''].filter(Boolean).join(', ');
    // Minimized (owner, Nov 26): one slim line that opens it again; remembered per event.
    if (evMin.has(e.id)) return `<button type="button" class="ev-note city ev-min" data-evmin="${esc(e.id)}" aria-expanded="false">${EVENT_ICON}<span><b>${esc(e.title)}</b>, ${nowS < e.startS ? esc(dayTime(e.startS, nowS)) : nowS < e.endS ? 'happening now' : 'just ended'}</span><span class="ev-open">Show</span></button>`;
    return `<div class="ev-note city">${EVENT_ICON}<div><p><b>${esc(e.title)}</b>, ${when}. ${here}</p><details class="ev-more" data-k="ev-${esc(e.id)}"><summary>Details${which ? `, ${which}` : ''} and route map</summary><p>${e.note ? `${esc(e.note)} ` : ''}${e.routeText ? `Route: ${esc(e.routeText)}. ` : ''}${esc(e.closures || '')}${buses}${lines}${checkHtml(e, nowS)}${more}</p></details></div><button type="button" class="ev-hide" data-evmin="${esc(e.id)}" aria-expanded="true" aria-label="Minimize ${esc(e.title)}" title="Minimize">–</button></div>`;
  }).join('');
}
async function openCityEvent(id) {
  const e = cityEvents.find((x) => x.id === id);
  if (!e) return;
  changeOpen = { id: `city-${id}`, view: 1 };
  $('chg-kind').textContent = `Near ${HUB.short}`;
  $('chg-h').textContent = e.title;
  $('chg-top').innerHTML = `<p class="cm-sum">${esc(e.routeText || '')}. The star is ${esc(HUB.name)}.</p>`;
  $('chg-below').innerHTML = e.buses.length ? `<p class="cm-sum">Buses at ${esc(HUB.short)} with changes: ${e.buses.map(busBadge).join(' ')}</p>` : '';
  openSheet();
  const box = $('chg-map');
  box.hidden = false;
  try {
    const Lf = await loadLeaflet();
    if (!changeOpen || changeOpen.id !== `city-${id}`) return;
    if (changeMap) changeMap.remove();
    changeMap = Lf.map(box, { zoomSnap: 0.25, scrollWheelZoom: false });
    Lf.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, className: 'cm-tiles', attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }).addTo(changeMap);
    Lf.polyline(e.route, { color: '#d4512b', weight: 7, opacity: 0.85 }).addTo(changeMap);
    Lf.marker(HUB.ll, { interactive: false, icon: Lf.divIcon({ className: '', iconSize: [0, 0], html: '<div class="hub-star" aria-label="This station">★</div>' }) }).addTo(changeMap);
    changeMap.fitBounds(Lf.latLngBounds([HUB.ll, ...e.route]).pad(0.15));
  } catch { box.hidden = true; }
}
document.addEventListener('click', (ev) => { const b = ev.target.closest('[data-cityevent]'); if (b) openCityEvent(b.dataset.cityevent); });
loadCityEvents();
setInterval(loadCityEvents, 30 * 60000);

// ---------- live MTA bus alerts for the hub's bus routes (owner, Nov 26) ----------
// The MTA's bus service alerts (detours, closed stops, parades), for the routes
// in the hub's bus panel: in effect now, or starting within 48 hours.
const BUS_ALERTS_URL = 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fbus-alerts.json';
let busAlerts = [];
const busRouteName = (id) => String(id).replace(/\+$/, '-SBS'); // the MTA's "M34+" is the M34-SBS
const alertText = (t) => { const tr = (t && t.translation) || []; return (tr.find((x) => x.language === 'en') || tr.find((x) => !/html/.test(x.language || '')) || {}).text || ''; };
// Corners a text names: "3rd Ave at E 42nd St", "9th Ave/W 40th St", "W 34 St at 8 Av".
const AVE = /\b(?:(\d+)(?:st|nd|rd|th)?|([a-z]+))\s+av(?:e|enue)?\b|\b(broadway)\b/gi;
const STREET = /\b(?:[EW]\.?\s+)?(?:(\d+)(?:st|nd|rd|th)?|([A-Z][a-z]+))\s+[Ss]t(?:reet)?\b/g;
const cornersIn = (text) => ({ aves: [...String(text).matchAll(AVE)].map((m) => (m[1] || m[2] || m[3]).toLowerCase()), sts: [...String(text).matchAll(STREET)].map((m) => (m[1] ? +m[1] : m[2].toLowerCase())) });
// An alert about particular stops ("stop on 3rd Ave at E 42nd St has been
// moved") counts only when it names one of the hub's own stops (same avenue,
// within a block); route-wide ones (detours, schedules, the parade) always do.
function aboutHubStop(head) {
  if (!/\bstops?\b/i.test(head)) return true;
  const c = cornersIn(head);
  if (!c.aves.length && !c.sts.length) return true; // names no place: about the route
  const near = (x, y) => (typeof x === 'number' && typeof y === 'number' ? Math.abs(x - y) <= 1 : x === y);
  return (HUB.busStops || []).some((b) => { const h = cornersIn(b.where); return h.aves.some((a) => c.aves.includes(a)) && h.sts.some((x) => c.sts.some((y) => near(x, y))); });
}
function loadBusAlerts() {
  if (!HUB_BUS_LINES.length) return;
  fetch(BUS_ALERTS_URL).then((r) => (r.ok ? r.json() : null)).catch(() => null).then((d) => {
    if (!d) return;
    const nowS = Date.now() / 1000;
    busAlerts = (d.entity || []).map((x) => {
      const a = x.alert || {};
      const routes = [...new Set((a.informed_entity || []).map((ie) => ie.route_id && busRouteName(ie.route_id)).filter(Boolean))];
      const mine = HUB_BUS_LINES.filter((l) => routes.includes(l));
      const per = (a.active_period || []).map((p) => ({ start: +p.start || 0, end: +p.end || Infinity })).filter((p) => p.end > nowS).sort((p, q) => p.start - q.start)[0];
      return { id: x.id, mine, start: per && per.start, end: per && per.end, head: alertText(a.header_text), desc: alertText(a.description_text) };
    }).filter((a) => a.mine.length && a.start !== undefined && a.start <= nowS + 48 * 3600 && a.head && aboutHubStop(a.head))
      .sort((p, q) => (p.start > nowS) - (q.start > nowS) || p.start - q.start);
    renderHubBuses();
    if (board && board.notices) renderAlertsTab();
  });
}
function busAlertWhen(a, nowS = Date.now() / 1000) {
  const open = !isFinite(a.end) || a.end - nowS > 90 * 86400; // the MTA's far-off placeholder end dates
  const until = open ? 'until further notice' : `until ${dayTime(a.end, nowS)}`;
  if (open && a.start > nowS) return `From ${dayTime(a.start, nowS)}`;
  return a.start <= nowS ? `Now, ${until}` : `${dayTime(a.start, nowS)} ${isFinite(a.end) ? `to ${dayTime(a.end, nowS)}` : 'on'}`;
}
function busAlertsHtml(cls = 'bus-al') {
  return busAlerts.map((a) => `<details class="${cls}" data-k="bal-${esc(a.id)}" data-nid="bus-${esc(a.id)}"><summary><span class="bus-al-lines">${a.mine.map(busBadge).join(' ')}</span><span class="bus-al-h">${esc(a.head)}<small>${esc(busAlertWhen(a))}</small></span></summary>${a.desc ? `<p>${esc(a.desc).replace(/\n+/g, '<br>')}</p>` : ''}</details>`).join('');
}
const busChanged = (ln, nowS = Date.now() / 1000) => busAlerts.some((a) => a.start <= nowS && a.mine.includes(ln));
loadBusAlerts();
setInterval(loadBusAlerts, 5 * 60000);

// ---------- every bus company at the terminal (owner, Nov 26: "I want them all to be listed") ----------
// docs/pabt-carriers.json: the Port Authority's own list, and where the board's
// times for each come from (live, a published schedule, or none found).
const CARRIER_TAG = { live: ['Live', 'tag-live'], scheduled: ['Scheduled', 'tag-sched'], none: ['Check with the company', 'tag-none'] };
function renderCarriers() {
  const box = $('pabt-carriers');
  if (!box) return;
  fetch('pabt-carriers.json').then((r) => (r.ok ? r.json() : null)).catch(() => null).then((d) => {
    if (!d) { box.innerHTML = '<p class="empty">The list of companies didn’t load.</p>'; return; }
    box.innerHTML = `<ul class="carriers">${d.carriers.map((c) => {
      const [t, cls] = CARRIER_TAG[c.data] || CARRIER_TAG.none;
      const web = c.web ? `<a href="https://${esc(c.web)}" target="_blank" rel="noopener">${esc(c.web.replace(/^www\./, '').split('/')[0])} ↗&#xFE0E;</a>` : '';
      const tel = c.phone ? `<a href="tel:${esc(c.phone.replace(/[^0-9+]/g, ''))}">${esc(c.phone)}</a>` : '';
      return `<li><div class="c-top"><b>${esc(c.name)}</b><span class="tagx ${cls}">${t}</span></div>${c.gates ? `<span class="c-note">${esc(c.gates)}</span>` : ''}<span class="c-links">${[web, tel].filter(Boolean).join(' · ')}</span></li>`;
    }).join('')}</ul><p class="cm-live">From the <a href="${esc(d.source)}" target="_blank" rel="noopener">Port Authority’s list of carriers</a>. “Scheduled” times are each company’s published timetable.</p>`;
  });
}
renderCarriers();
// Redraws keep folded sections the reader opened (data-k) open.
function setKeepOpen(el, html) {
  const open = new Set([...el.querySelectorAll('details[open][data-k]')].map((d) => d.dataset.k));
  el.innerHTML = html;
  if (open.size) el.querySelectorAll('details[data-k]').forEach((d) => { if (open.has(d.dataset.k)) d.open = true; });
}
function renderEvents() {
  const el = $('events-note');
  if (el) setKeepOpen(el, eventsHtml());
  if (board && board.notices) renderAlertsTab();
}
loadEvents();
setInterval(() => { loadEvents(); renderEvents(); }, 60000);

// Phones: every notice on its own tab, by where it applies, with a count on
// the tab. (Computers keep the strips above the trains and in the subway panel.)
function renderAlertsTab() {
  const rail = board.notices.rail || [], subway = board.notices.subway || [];
  const card = (n) => {
    const map = typeof changeModel === 'function' && (changeModel(n) || lirrModel(n) || pathModel(n)) ? `<button type="button" class="al-map" data-change="${esc(n.id)}">See map</button>` : '';
    const opts = optionsBtn(n);
    return `<div class="al-card${n.urgent ? ' urgent' : ''}" data-nid="${esc(n.id)}"><span class="who">${noticeWho(n)}</span><p><span class="kind">${esc(friendlyType(n.type))}</span>${noticeFull(n)}${map || opts ? `<br>${map}${opts}` : ''}</p></div>`;
  };
  const group = (title, list, none) => `<h2 class="al-h">${title}</h2>${list.length ? list.map(card).join('') : `<p class="al-none">${none}</p>`}`;
  const ev = eventsHtml();
  const lifts = elevatorsHtml();
  const railNames = HUB.rails.map((c) => CARRIERS[c]);
  setKeepOpen($('alerts'), (ev ? `<h2 class="al-h">Events</h2>${ev}` : '') + lirrAltHtml() + njtAltHtml() + group(`Trains at ${HUB.short}`, rail, `No notices for ${railNames.slice(0, -1).join(', ')}${railNames.length > 2 ? ',' : ''} or ${railNames[railNames.length - 1]} right now.`)
    + group('Subway', subway, `No subway notices for the lines at ${HUB.short} right now.`)
    + (HUB.path ? group('PATH', board.notices.path || [], 'No PATH alerts right now.') : '')
    + (HUB_BUS_LINES.length ? `<h2 class="al-h">Buses</h2>${busAlerts.length ? busAlertsHtml('bus-al al-bus') : `<p class="al-none">No MTA alerts for the buses at ${esc(HUB.short)} right now.</p>`}` : '')
    + `<h2 class="al-h">Elevators and escalators</h2>${lifts || `<p class="al-none">All elevators and escalators at ${esc(HUB.elevatorStations.join(' and '))} are working, per the MTA.</p>`}`);
  const n = rail.length + subway.length + (board.notices.path || []).length + eventsNow(Date.now() / 1000).length + cityEventsNow(Date.now() / 1000).length + busAlerts.length + eneOut.length;
  $('alerts-count').textContent = n ? String(n) : '';
}
document.addEventListener('toggle', (e) => {
  const d = e.target;
  if (!d.classList || !d.classList.contains('al-strip')) return;
  try { d.open ? sessionStorage.setItem('opened-' + d.dataset.where, d.dataset.sig) : sessionStorage.removeItem('opened-' + d.dataset.where); } catch {}
}, true);

function renderNotices() {
  if (!board) return;
  const s = board.sources, out = [];
  // Not connected yet: a one-line note at the bottom of the page, not a banner.
  $('njt-note').textContent = s.njt.needsServer || s.njt.needsLogin ? 'NJ Transit data not yet available.' : '';
  if (s.njt.error) out.push('NJ Transit data didn’t load. The NJ Transit trains shown may not be real time.');
  else if (s.njt.staleSince) out.push(`NJ Transit times are from ${Math.max(1, Math.round((Date.now() / 1000 - s.njt.staleSince) / 60))} min ago and may not be real time. Confirm on the station screens.`);
  for (const k of ['lirr', 'amtrak', 'mnr']) if (s[k] && s[k].error) out.push(`${CARRIERS[k]} data didn’t load${plainError(s[k].error)}. Showing the last trains received.`);
  if (s.subway.error) out.push('Subway times didn’t load. Showing the last times received.');
  if (s.njtbus && s.njtbus.error) out.push('NJ Transit bus times didn’t load. Showing other companies’ schedules.');
  if (s.buses && s.buses.error) out.push('Other bus companies’ schedules didn’t load.');
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

// The bus panel is showing: the Buses tab (phones), or the side panel switched to Buses (computers).
// Every board opens on Subway (owner, Nov 26: "default view to be subway not
// busses"); Buses is a tap away and isn't remembered between visits.
let side = 'subway';
try { localStorage.removeItem('sidePanel'); } catch {}
if (HUB.layout === 'subway') side = 'buses';
document.body.dataset.side = side;
const WIDE = matchMedia('(min-width: 961px)');
const busesShown = () => view === 'buses' || (WIDE.matches && side === 'buses') || (WIDE.matches && HUB.layout === 'subway') || (WIDE.matches && HUB.mergeSide && document.body.classList.contains('side-main'));
function setSide(x) {
  side = x; document.body.dataset.side = side;
  setPressed('.side-switch', 'side', side);
  if (busesShown()) { renderBuses(); renderHubBuses(); }
}
document.addEventListener('click', (e) => { const b = e.target.closest('[data-side]'); if (b) setSide(b.dataset.side); });
setPressed('.side-switch', 'side', side);
// Computers: the side panel can be the main board, and either side can be
// hidden for a full-width view (owner, Nov 26: "double tap subway and have it
// swap rail and subway"; "a way to minimize the side tab all together").
// Remembered on this device. Phones keep their tabs.
// Each board keeps its own (owner, Nov 26: Subway full screen at Penn made Times
// Square open on its buses). A subway hub (Times Square) always opens with the
// subway as the main board: buses as main is never remembered there.
let sideMain = false, panelOff = false;
const deskKey = (k) => `${k === 'main' ? 'sideMain' : 'panelOff'}:${HUB.id}`;
try {
  sideMain = HUB.layout !== 'subway' && localStorage.getItem(deskKey('main')) === '1';
  panelOff = localStorage.getItem(deskKey('off')) === '1';
  localStorage.removeItem('sideMain'); localStorage.removeItem('panelOff'); // the old shared settings
} catch {}
const mainName = () => (HUB.layout === 'subway' ? 'Subway' : (HUB.mainLabel || 'departures').replace(/^./, (c) => c.toUpperCase()));
const sideName = () => (HUB.layout === 'subway' || (side === 'buses' && !HUB.mergeSide) ? 'Buses' : HUB.mergeSide ? 'Subway & buses' : (HUB.path ? 'Subway & PATH' : 'Subway'));
function applyDeskLayout() {
  document.body.classList.toggle('side-main', sideMain);
  document.body.classList.toggle('panel-off', panelOff);
  document.body.classList.toggle('merge-side', !!HUB.mergeSide);
  document.body.classList.add('stack-dirs'); // (every board: directions stacked, never side by side)
  fitSubCols();
  requestAnimationFrame(() => fitSubZoom());
  // (Deferred: the bus code further down this script is set up by then.)
  setTimeout(() => { if (board && busesShown()) { renderBuses(); renderHubBuses(); } }, 0);
  const swap = document.querySelector('.pt-swap'), hide = document.querySelector('.pt-hide'), back = document.querySelector('.panel-back');
  // What's on the side right now, and what's hidden.
  const onSide = sideMain ? mainName() : sideName();
  if (swap) { swap.setAttribute('aria-pressed', String(sideMain)); swap.title = sideMain ? `Put ${mainName()} back as the main board` : `Make ${sideName()} the main board (double-click its tab for full screen)`; swap.querySelector('span').textContent = sideMain ? `${mainName()} to main` : 'Make main'; }
  if (hide) { hide.title = `Hide ${onSide} for a full-width ${sideMain ? sideName() : mainName()}`; hide.querySelector('span').textContent = `Hide ${onSide}`; }
  if (back) {
    back.hidden = !panelOff; back.querySelector('span').textContent = `Show ${onSide}`;
    // Not floating over the board (owner, Nov 26: it covered the PATH times):
    // with the side panel as the main board, next to its other buttons; with the
    // trains full width, in the row with "Side by side".
    const home = sideMain ? document.querySelector('.panel-tools') : (document.querySelector('.trip-bar') || document.querySelector('.layout'));
    if (home && back.parentElement !== home) home.append(back);
  }
  // The bus map and lists size themselves to their box.
  setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
}
// Subway as the full-screen board: each station one card in its own column,
// directions stacked like Times Square (owner, Nov 26: "no side by side at all
// for subways"), then PATH;
// a fixed order, so a refresh never moves anything (owner: Penn "moving around
// and flashing when it refreshes"). --sub-cols is the number of 18rem tracks
// (18rem each, a card one per direction; stacked: 24rem, one per card); with the trains showing, as many as fit.
function fitSubCols() {
  const box = document.querySelector('aside.subway');
  const b = document.body;
  if (!box || !b.classList.contains('side-main') || b.classList.contains('merge-side')) return;
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const n = (box.querySelectorAll('#subway > .stn').length) + (box.querySelector('.path-part') ? 1 : 0);
  const tw = 25; // a 24rem track and its gap, in rem
  const fit = Math.max(1, Math.floor((box.clientWidth - 2.2 * rem + rem) / (tw * rem)));
  b.style.setProperty('--sub-cols', b.classList.contains('panel-off') ? Math.max(1, n) : Math.min(fit, Math.max(1, n)));
}
addEventListener('resize', fitSubCols);
// Full screen (trains hidden): every line on the screen without scrolling
// (owner, Nov 26). Shrink the subway a little when needed (down to 75%); the
// smaller it is, the more side-panel-width columns fit, so the size and the
// number of columns are chosen together, largest size that fits first.
// Port Authority: the subway part only (the bus list beside it can scroll).
function fitSubZoom() {
  const b = document.body, merge = b.classList.contains('merge-side');
  // A subway hub (Times Square): the subway is always the main board on a
  // computer, so it always fits its platforms on the screen (owner, Nov 26: in
  // the 2-board view the 7 sat below the screen), in its fixed columns, down to 80%.
  if (HUB.layout === 'subway') {
    const plats = document.querySelector('.main-sub .plats');
    if (!plats) return;
    if (!WIDE.matches || b.classList.contains('side-main')) { plats.style.zoom = ''; plats.dataset.sized = ''; return; }
    // (Sized once per window size and layout; a data refresh changes nothing
    // unless the platforms stop fitting, then one step smaller. No flashing.)
    const key = `${innerWidth}x${innerHeight}|${b.className}`;
    const fits = () => Math.max(...[...plats.querySelectorAll('.stn')].map((x) => x.getBoundingClientRect().bottom), 0) + window.scrollY <= innerHeight - 12;
    let z = parseFloat(plats.style.zoom) || 1;
    if (plats.dataset.sized !== key) { plats.dataset.sized = key; z = 1; plats.style.zoom = '1'; }
    while (!fits() && z > 0.81) { z -= 0.05; plats.style.zoom = z.toFixed(2); }
    return;
  }
  const el = document.querySelector('aside.subway .sub-part'), box = document.querySelector('aside.subway');
  if (!el || !box) return;
  if (!(WIDE.matches && b.classList.contains('side-main') && b.classList.contains('panel-off'))) { if (el.style.zoom) el.style.zoom = ''; fitSubCols(); return; }
  fitSubCols();
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const lines = () => Math.max(...[...el.querySelectorAll('#subway > .stn, #path')].map((x) => x.getBoundingClientRect().bottom), 0) + window.scrollY;
  const fits = () => lines() <= innerHeight - 12;
  // A data refresh: keep the size unless the lines no longer fit (then step down).
  // A new layout or window size: the largest size that fits, from the top.
  let z = parseFloat(el.style.zoom) || 1;
  if (!el.dataset.sized || el.dataset.sized !== `${innerWidth}x${innerHeight}|${b.className}`) {
    el.dataset.sized = `${innerWidth}x${innerHeight}|${b.className}`;
    // Start no larger than lets every column fit across.
    const n = parseInt(getComputedStyle(b).getPropertyValue('--sub-cols'), 10) || 1;
    z = merge ? 1 : Math.min(1, (box.clientWidth - 2.2 * rem + rem) / (n * 25 * rem));
    z = Math.max(merge ? 0.75 : 0.7, Math.floor(z * 20) / 20);
    el.style.zoom = z.toFixed(2);
  }
  while (!fits() && z > (merge ? 0.76 : 0.71)) { z -= 0.05; el.style.zoom = z.toFixed(2); }
}
addEventListener('resize', () => fitSubZoom());
function setDesk(k, v) {
  if (k === 'main') sideMain = v; else panelOff = v;
  try { localStorage.setItem(deskKey(k), v ? '1' : '0'); } catch {}
  applyDeskLayout();
}
(function deskTools() {
  const aside = document.querySelector('aside.subway'), layout = document.querySelector('.layout');
  if (!aside || !layout) return;
  const tools = document.createElement('div');
  tools.className = 'panel-tools';
  tools.innerHTML = '<button type="button" class="pt-swap" aria-pressed="false"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h11l-3-3 1.4-1.4L22 8l-5.6 5.4L15 12l3-3H7zm10 10H6l3 3-1.4 1.4L2 16l5.6-5.4L9 12l-3 3h11z" fill="currentColor"/></svg><span>Make main</span></button>'
    + '<button type="button" class="pt-hide"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h2v16H4zm5.4 7H20v2H9.4l3.3 3.3-1.4 1.4L5.6 12l5.7-5.7 1.4 1.4z" fill="currentColor" transform="rotate(180 12 12)"/></svg><span>Hide</span></button>';
  aside.prepend(tools);
  const back = document.createElement('button');
  back.type = 'button'; back.className = 'panel-back'; back.hidden = true;
  back.innerHTML = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M15.4 7.4 14 6l-6 6 6 6 1.4-1.4L10.8 12z" fill="currentColor"/></svg><span>Show</span>';
  layout.append(back);
  tools.querySelector('.pt-swap').addEventListener('click', () => setDesk('main', !sideMain));
  tools.querySelector('.pt-hide').addEventListener('click', () => setDesk('off', true));
  back.addEventListener('click', () => setDesk('off', false));
  // Double-click a panel tab (Subway, Buses): that becomes the main board, or goes back.
  document.querySelector('.side-switch')?.addEventListener('dblclick', (e) => {
    const b = e.target.closest('[data-side]'); if (!b || !WIDE.matches) return;
    if (side !== b.dataset.side) setSide(b.dataset.side);
    // Straight to full screen, the trains hidden (owner, Nov 26); again: back to both.
    const full = !sideMain;
    setDesk('off', full);
    setDesk('main', full);
  });
  document.querySelector('.side-switch')?.addEventListener('click', () => applyDeskLayout());
  applyDeskLayout();
})();

// Safari doesn't keep the reader's place when the board redraws above them
// (Chrome does: "scroll anchoring"). Times Square, with the subway as its main
// board, redraws under the reader every few seconds (owner, Nov 26: "jumping").
// Before a redraw: the element at the reader's eye line; after: scroll so it
// stays put. (Where the browser already did this, the difference is 0.)
function keepAnchor(fn) {
  return function anchored(...args) {
    if (window.scrollY < 5) return fn.apply(this, args);
    const el = document.elementFromPoint(innerWidth / 2, Math.min(160, innerHeight / 3));
    if (!el || el === document.body || el === document.documentElement || el.closest('dialog, .station-bar')) return fn.apply(this, args);
    const path = []; let n = el;
    while (n && !n.id && n.parentElement && n !== document.body) { path.unshift([...n.parentElement.children].indexOf(n)); n = n.parentElement; }
    const root = n && n.id, sig = el.tagName + '.' + el.className, top = el.getBoundingClientRect().top;
    const out = fn.apply(this, args);
    let m = root ? document.getElementById(root) : null;
    for (const i of path) m = m && m.children[i];
    if (m && m.tagName + '.' + m.className === sig) {
      const d = m.getBoundingClientRect().top - top;
      if (Math.abs(d) > 1 && Math.abs(d) < innerHeight) window.scrollBy(0, d);
    }
    return out;
  };
}
function render() { renderRail(); renderSubway(); renderPath(); renderNotices(); renderServiceNotices(); renderStamp(); if (busesShown()) renderBuses(); }

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
  const [path, pa] = window.PENN_RELAY && HUB.path ? await Promise.all([PennFeeds.relayPath(force), PennFeeds.relayPathAlerts(force)]) : [null, null];
  return PennFeeds.board({ force, path: path || undefined, pathAlerts: pa && pa.data ? pa.data : [] });
}

// ---------- trains that won't run to or from Penn, from the railroads' own notices ----------
// LIRR: "The 10:20pm train from Penn Station to Huntington will originate at
// Jamaica at 10:42pm." / "The 9:16pm train from Huntington to Penn Station is
// canceled at Jamaica." / "... will be diverted to Grand Central."
// NJ Transit: "train #3880 ... is canceled" / "will originate at Newark".
// Such a train is crossed off at Penn, saying where it starts or ends instead.
const placeShort = (x) => String(x || '').replace(/\s+(station|terminal)$/i, '').trim();
function lirrTripChanges(b) {
  const out = [];
  for (const n of (b.notices && b.notices.rail) || []) {
    if (n.carrier !== 'lirr' || n.activeNow === false || n.preview) continue;
    for (const t of n.trips || []) {
      const m = /^The (\d{1,2}):(\d{2})\s*([ap])m train from (.+?) to (.+?) (is|will) (.*)$/i.exec(t);
      if (!m) continue;
      const [, h, mi, ap, from, to, , rest] = m;
      const mins = (+h % 12 + (ap.toLowerCase() === 'p' ? 12 : 0)) * 60 + +mi;
      const at = (re) => { const x = re.exec(rest); return x ? placeShort(x[1]) : ''; };
      let change = null;
      if (/originate/i.test(rest)) { const when = /at (\d{1,2}:\d{2})\s*[ap]m\.?$/i.exec(rest); change = { status: `Starts at ${at(/originate (?:at|from|in) (.+?)(?: at \d|\.|$)/i)}${when ? ` ${when[1]}` : ''}` }; }
      else if (/divert/i.test(rest)) change = { status: `To ${at(/diverted to (.+?)(?:\.|$)/i) || 'another station'}` };
      else if (/terminate/i.test(rest)) change = { status: `Ends at ${at(/terminate (?:at|in) (.+?)(?:\.|$)/i)}` };
      else if (/cancel/i.test(rest)) { const where = at(/cancel(?:l)?ed (?:at|in) (.+?)(?:\.|$)/i); change = { status: where ? `Ends at ${where}` : 'Cancelled', whole: !where }; }
      if (!change) continue;
      out.push({ ...change, mins, from: placeShort(from), to: placeShort(to), text: t });
    }
  }
  return out;
}
const sameName = (a, b) => { const x = normName2(a).split(' ')[0], y = normName2(b).split(' ')[0]; return !!x && x === y; };
// The notice line that changes this train, if any (b: the board whose notices to read).
function tripChangeFor(r, kind, b, lirr = lirrTripChanges(b)) {
  const njtMsgs = ((b.notices && b.notices.rail) || []).filter((n) => n.carrier === 'njt' && n.activeNow !== false).map((n) => n.text);
  {
    {
      let hit = null;
      if (r.carrier === 'lirr') {
        const { mins } = nyDayAt(r.sched || r.time);
        hit = lirr.find((c) => c.mins === mins && (kind === 'departures' ? /penn/i.test(c.from) && sameName(c.to, r.place) : /penn/i.test(c.to) && sameName(c.from, r.place)));
        // A Penn departure that starts elsewhere: not cancelled outright.
      } else if (r.carrier === 'njt' && r.train) {
        const msg = njtMsgs.find((t) => new RegExp(`#\\s*${r.train}\\b`).test(t));
        if (msg) {
          const after = msg.slice(msg.search(new RegExp(`#\\s*${r.train}\\b`)));
          const sentence = after.split(/\.\s/)[0];
          const o = /originat\w* (?:at|in|from) ([A-Z][\w .'-]+?)(?:[,.]|\s+(?:at|due|and)\b|$)/.exec(sentence);
          const e = /terminat\w* (?:at|in) ([A-Z][\w .'-]+?)(?:[,.]|\s+(?:at|due|and)\b|$)/.exec(sentence);
          if (kind === 'departures' && o && !/^(new york|penn station|psny|ny penn)/i.test(o[1])) hit = { status: `Starts at ${placeShort(o[1])}`, text: sentence };
          else if (kind === 'arrivals' && e && !/^(new york|penn station|psny|ny penn)/i.test(e[1])) hit = { status: `Ends at ${placeShort(e[1])}`, text: sentence };
          else if (/\bcancel+ed\b/i.test(sentence) && /psny|new york|penn/i.test(sentence)) hit = { status: 'Cancelled', text: sentence };
        }
      }
      return hit;
    }
  }
}
function applyTripChanges(b) {
  if (!b || !b.departures) return;
  const lirr = lirrTripChanges(b);
  for (const kind of ['departures', 'arrivals']) {
    for (const r of b[kind] || []) {
      if (r.tone === 'stop' || r.departed) continue;
      const hit = tripChangeFor(r, kind, b, lirr);
      if (!hit) continue;
      // NJ Transit's own status text, when it has one, stays.
      const own = r.carrier === 'njt' && !/^(on time|\d+ min late)$/i.test(String(r.status || '').trim()) ? r.status : '';
      Object.assign(r, { tone: 'stop', status: own || hit.status, changeStatus: hit.status, changeNote: hit.text });
    }
  }
}

// LIRR inbound changes name the train by its start time at the far end
// ("the 9:16pm from Huntington"), which the Penn feed doesn't carry. Look
// up only the arrivals from that station (once each) and match the time.
const lirrStarts = new Map(); // train id -> its scheduled start (epoch), or 0 if unknown
async function matchLirrArrivals(b) {
  const changes = lirrTripChanges(b).filter((c) => /penn/i.test(c.to));
  if (!changes.length) return;
  const rows = (b.arrivals || []).filter((r) => r.carrier === 'lirr' && r.tone !== 'stop' && changes.some((c) => sameName(c.from, r.place)));
  let changed = false;
  await Promise.all(rows.map(async (r) => {
    if (!lirrStarts.has(r.id)) {
      lirrStarts.set(r.id, 0);
      try {
        const d = await (await fetch(`https://backend-unified.mylirr.org/locations/${encodeURIComponent(r.id)}`, { headers: { 'accept-version': '3.0' }, cache: 'no-store' })).json();
        const first = ((d.details && d.details.stops) || [])[0];
        lirrStarts.set(r.id, (first && first.sched_time) || 0);
      } catch {}
    }
    const start = lirrStarts.get(r.id);
    if (!start) return;
    const c = changes.find((x) => x.mins === nyDayAt(start).mins && sameName(x.from, r.place));
    if (c) { Object.assign(r, { tone: 'stop', status: c.status, changeNote: c.text }); changed = true; }
  }));
  if (changed && b === board) renderRail();
}

// Pill dropdowns open and close; "See full alert" goes to the notice itself.
document.addEventListener('click', (e) => {
  const d = e.target.closest('[data-drop]');
  if (d) {
    e.preventDefault(); e.stopPropagation();
    const k = d.dataset.drop;
    if (openDrops.has(k)) openDrops.delete(k); else openDrops.add(k);
    renderRail(); slideStarted = -Infinity; renderSubway(); renderPath(); renderHubBuses();
    return;
  }
  const g = e.target.closest('[data-goto]');
  if (!g) return;
  e.preventDefault(); e.stopPropagation();
  const id = g.dataset.goto;
  const tab = document.querySelector('.seg button[data-view="alerts"]');
  if (tab && getComputedStyle(tab).display !== 'none') tab.click();
  const sel = `[data-nid="${CSS.escape(id)}"]`;
  let el = document.querySelector(`#alerts ${sel}`);
  if (!el || !el.offsetParent) {
    el = document.querySelector(`.al-strip ${sel}`);
    if (el) el.closest('details').open = true;
  }
  // A bus alert (computers): the one in the bus panel, opened.
  if (!el || !el.offsetParent) {
    el = document.querySelector(`#hub-buses ${sel}`);
    if (el) { el.open = true; const all = el.closest('.bus-al-all'); if (all) all.open = true; }
  }
  if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1600); }
}, true);

let loading = null;
async function refresh(force = false) {
  if (loading && !force) return loading;
  const run = (async () => {
    try {
      const next = await loadBoard(force);
      applyTripChanges(next);
      matchLirrArrivals(next);
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
const HEADINGS = { departures: HUB.mainLabel || 'departures', arrivals: 'arrivals', subway: HUB.subwayTab, alerts: 'service alerts', buses: 'buses' };
// No airport routes from this hub yet (Port Authority, Times Square): no button.
if (HUB.airport === false) { const b = document.getElementById('to-airport'); if (b) { b.hidden = true; b.style.display = 'none'; } }
// A subway hub (Times Square): the subway is the main view and the side panel holds only buses.
if (HUB.layout === 'subway') document.body.classList.add('layout-subway');
function setHeading() {
  $('h1-sub').textContent = HEADINGS[view];
  document.title = `${HUB.title} ${HEADINGS[view]}`;
}
document.querySelector('.chips').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  carrier = b.dataset.carrier;
  try { localStorage.setItem('carrier', carrier); } catch {}
  setPressed('.chips', 'carrier', carrier); renderRail(); $('njt-alt').innerHTML = railAltHtml();
});
$('rows').addEventListener('toggle', (e) => {
  const id = e.target.dataset && e.target.dataset.id; if (!id) return;
  e.target.open ? openRows.add(id) : openRows.delete(id);
  if (e.target.open) refreshOpenProgress();
}, true);
// The Subway tab only exists on narrow screens; fall back when the window widens.
matchMedia('(min-width: 961px)').addEventListener('change', (e) => {
  if (e.matches && (view === 'subway' || view === 'alerts' || view === 'buses')) {
    // (Coming from the Buses tab: the side panel shows the buses.)
    if (view === 'buses' || view === 'subway') setSide(view);
    document.querySelector('.seg button[data-view="departures"]').click();
  }
});

function tick() {
  const t = clock(Date.now() / 1000);
  if (flipMode) {
    // Tiles turn only when the minute changes.
    if (lastClock !== t.hm + t.ap) { $('clock').innerHTML = flipText('clock', t.hm); $('clock-ap').innerHTML = flipText('clock-ap', t.ap); runFlips($('clock').parentNode); lastClock = t.hm + t.ap; }
    $('clock-s').textContent = ''; // no seconds on the flip board
    renderStamp();
    return;
  }
  $('clock').textContent = t.hm;
  $('clock-s').textContent = ':' + nySecs.format(new Date()).padStart(2, '0');
  $('clock-ap').textContent = t.ap;
  renderStamp();
}
// Tick on the second, so the seconds never skip or stall.
function everySecond() { setTimeout(() => { tick(); everySecond(); }, 1000 - (Date.now() % 1000) + 5); }
setPressed('.chips', 'carrier', carrier);
// (The redraws that can change heights above the reader, kept anchored.)
renderSubway = keepAnchor(((f) => function () { const out = f.apply(this, arguments); fitSubZoom(); return out; })(renderSubway));
renderRail = keepAnchor(renderRail);
renderPath = keepAnchor(renderPath);
renderEvents = keepAnchor(renderEvents);
renderElevators = keepAnchor(renderElevators);
renderHubBuses = keepAnchor(renderHubBuses);
renderBuses = keepAnchor(renderBuses);
// A reload (tapping the station name, or the browser's refresh) comes back to
// the same tab and the same place on the page (owner, Nov 26: "jumping back to
// the top on each refresh"). The board fills in after the page loads, so the
// browser's own scroll restore finds a short page and gives up; this waits
// for the content, puts the reader back, and stops as soon as they scroll.
(function keepPlace() {
  const KEY = `place:${HUB.id}`;
  try { history.scrollRestoration = 'manual'; } catch {}
  const save = () => { try { sessionStorage.setItem(KEY, JSON.stringify({ y: Math.round(scrollY), view, side, t: Date.now() })); } catch {} };
  addEventListener('pagehide', save);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') save(); });
  let saved = null;
  try { saved = JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch {}
  const nav = (performance.getEntriesByType && performance.getEntriesByType('navigation')[0]) || {};
  if (!saved || nav.type !== 'reload' || Date.now() - saved.t > 30 * 60000) return;
  // (After the rest of this script has run: the tabs' code is set up further down.)
  setTimeout(() => {
  // The same tab (phones) and side panel (computers).
  const tab = saved.view && document.querySelector(`.seg button[data-view="${saved.view}"]`);
  if (tab && saved.view !== view && getComputedStyle(tab).display !== 'none') tab.click();
  if (saved.side && saved.side !== side && typeof setSide === 'function') setSide(saved.side);
  if (!(saved.y > 0)) return;
  let stop = false, reached = 0;
  const quit = () => { stop = true; };
  ['wheel', 'touchstart', 'keydown', 'mousedown'].forEach((t) => addEventListener(t, quit, { once: true, passive: true }));
  const started = Date.now();
  (function again() {
    if (stop || Date.now() - started > 15000) return;
    if (document.documentElement.scrollHeight >= saved.y + innerHeight - 4) {
      if (Math.abs(scrollY - saved.y) > 4) scrollTo(0, saved.y);
      reached = reached || Date.now();
      // Keep it there while the rest of the board fills in above it.
      if (Date.now() - reached > 5000) return;
    }
    setTimeout(again, 150);
  })();
  }, 0);
})();
// Tapping "Penn Station" reloads the page (fresh data and the newest version).
const mastTitle = document.querySelector('.mast h1');
mastTitle.setAttribute('role', 'button');
mastTitle.tabIndex = 0;
mastTitle.title = 'Reload the board';
mastTitle.addEventListener('click', (e) => { if (!e.target.closest('.hub-dd')) location.reload(); });
mastTitle.addEventListener('keydown', (e) => { if (e.target.closest('.hub-dd')) return; if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); location.reload(); } });
// The side-by-side page opens with this board on the left, and its Back link returns here.
document.querySelectorAll('.split-btn').forEach((a) => { a.href = `split.html?from=${HUB.id}`; });
// Inside the side-by-side view (split.html) the page knows it's framed.
if (window.self !== window.top) document.body.classList.add('in-split');
document.querySelector('.style-seg').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-style]');
  if (b) setBoardStyle(b.dataset.style === 'flip');
});
document.body.classList.toggle('flipboard', flipMode);
document.querySelectorAll('.style-seg button').forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.style === 'flip') === flipMode)));
renderMastFlip();
tick(); everySecond();
refresh(true); setInterval(() => refresh(), REFRESH_MS); everyMinute();
setInterval(() => { renderRail(); renderSubway(); renderPath(); }, 10000);
// Rows taking turns between ends of the line move on every few seconds.
// (Timed to the turn itself, so each end shows for the same few seconds.)
(function nextTurn() {
  setTimeout(() => { if (subwayTurning) renderSubway(); nextTurn(); }, ROTATE_MS - (Date.now() % ROTATE_MS) + 20);
})(); // keep countdowns moving between refreshes
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(true); });


// ---------- buses at the hub (owner, Nov 25: every board lists its nearby buses) ----------
// Live MTA Bus Time at the stops around the station (stop codes from the MTA's
// Manhattan bus timetable), through the relay.
const HUB_BUS_STOPS = HUB.busStops; // docs/hub.js
const hubBuses = new Map();
function loadHubBuses() {
  if (!window.PENN_RELAY) return;
  Promise.all(HUB_BUS_STOPS.map((b) => fetch(`${window.PENN_RELAY}/mta-bus-stop?stop=${b.stop}`, { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null)).then((d) => { if (d) hubBuses.set(b.stop, d.buses || []); }).catch(() => {}))).then(renderHubBuses);
}
// Fixed rows (owner, Nov 25: buses stay put rather than reorder by which comes
// next): stop by stop as listed in hub.js, each route at it, with its next
// times or "none due soon". The route badge opens the MTA's page for that route
// (schedule and route map) in a new tab; "Map of the stops" shows where each stop is.
const busRouteUrl = (ln) => `https://www.mta.info/schedules/bus/${encodeURIComponent(String(ln).toLowerCase())}`;
const busBadge = (ln) => `<a class="bus-pl" href="${busRouteUrl(ln)}" target="_blank" rel="noopener" title="${esc(ln)} route map and schedule (MTA, opens in a new tab)">${esc(ln.replace('-SBS', ''))}${/SBS/.test(ln) ? '<small>SBS</small>' : ''}</a>`;
function renderHubBuses() {
  const el = $('hub-buses');
  if (!el) return;
  if (!hubBuses.size) { el.innerHTML = `<p class="empty">${window.PENN_RELAY ? 'Loading buses…' : 'Bus times aren’t available here.'}</p>`; return; }
  const t = Date.now();
  const mins = (times) => times.map((x, i) => { const m = Math.max(0, Math.round((x - t / 1000) / 60)); return i === 0 ? (m < 1 ? '<b class="now">now</b>' : `<b>${m}</b> min`) : String(m); }).join(', ');
  const rows = HUB_BUS_STOPS.flatMap((b) => b.lines.map((ln) => {
    const times = (hubBuses.get(b.stop) || []).filter((x) => String(x.line).toUpperCase() === ln && x.at && Date.parse(x.at) >= t - 30000 && Date.parse(x.at) <= t + 90 * 60000)
      .map((x) => Date.parse(x.at) / 1000).sort((a, c) => a - c).slice(0, 3);
    const when = times.length ? mins(times) : `<span class="sb-dim">${hubBuses.has(b.stop) ? 'none due soon' : 'no live times'}</span>`;
    // The MTA's alerts for this route in effect now: a pill that opens to them, like the subway's (owner, Nov 26).
    const nowS = t / 1000;
    const ns = busAlerts.filter((a) => a.start <= nowS && a.mine.includes(ln)).map((a) => ({ id: `bus-${a.id}`, text: a.head, desc: a.desc, periods: [[a.start, a.end]] }));
    const chg = ns.length ? pills(dropPill(`bus|${b.stop}|${ln}`, 'Service change', 'warn', ns)) : '';
    return `<div class="sline">${busBadge(ln)}<span class="sdest"><span class="dname">${esc(b.label)}</span> <small>${esc(b.where)}</small>${chg}</span><span class="smins">${when}</span></div>`;
  }));
  // The MTA's alerts for these routes, folded under one line; the rows they touch say "Service change".
  const al = busAlerts.length ? `<details class="bus-al-all" data-k="bal-all"><summary>${busAlerts.length} MTA alert${busAlerts.length > 1 ? 's' : ''} for these buses</summary>${busAlertsHtml()}</details>` : '';
  setKeepOpen(el, `${al}<section class="stn">${rows.join('')}</section><button type="button" class="al-map bus-map-btn" data-busmap>Map of the stops</button>`);
}
// The stops on a map, each labeled with its routes and direction.
async function openBusMap() {
  changeOpen = { id: 'busmap', view: 1 };
  $('chg-kind').textContent = `Buses at ${HUB.short}`;
  $('chg-h').textContent = 'Where the bus stops are';
  $('chg-top').innerHTML = '<p class="cm-sum">Tap a stop below to zoom in to it on the map. Tap a route for the MTA’s route map and schedule (opens in a new tab).</p>';
  $('chg-below').innerHTML = `<ul class="cm-stns">${HUB_BUS_STOPS.map((b, i) => `<li class="cm-stn bus-stop-li" data-busstop="${i}" tabindex="0" role="button" aria-label="Show stop ${i + 1} on the map"><div class="opt-h"><span class="bus-num">${i + 1}</span>${b.lines.map(busBadge).join(' ')}</div><span class="cm-dir">${esc(b.label)}, ${esc(b.where)}</span></li>`).join('')}</ul>`;
  openSheet();
  const box = $('chg-map');
  box.hidden = false;
  try {
    const Lf = await loadLeaflet();
    if (!changeOpen || changeOpen.id !== 'busmap') return;
    if (changeMap) changeMap.remove();
    changeMap = Lf.map(box, { zoomSnap: 0.25, scrollWheelZoom: false });
    Lf.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, className: 'cm-tiles', attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors · Stops: MTA' }).addTo(changeMap);
    Lf.marker(HUB.ll, { interactive: false, icon: Lf.divIcon({ className: '', iconSize: [0, 0], html: '<div class="hub-star" aria-label="This station">★</div>' }) }).addTo(changeMap);
    // Numbered dots (the routes are in the list below); stops on the same
    // corner are nudged apart so every number shows.
    const placed = [];
    busMarkers = [];
    HUB_BUS_STOPS.forEach((b, i) => {
      let [la, lo] = b.ll;
      while (placed.some(([a, c]) => Math.abs(a - la) < 0.00012 && Math.abs(c - lo) < 0.00016)) lo += 0.00018;
      placed.push([la, lo]);
      busMarkers[i] = Lf.marker([la, lo], { title: `${i + 1}: ${b.lines.join(', ')}, ${b.label}`, icon: Lf.divIcon({ className: '', iconSize: [0, 0], html: `<div class="bus-dot">${i + 1}</div>` }) })
        .bindPopup(`<b>${i + 1}. ${b.lines.map(esc).join(', ')}</b><br>${esc(b.label)}<br>${esc(b.where)}`).addTo(changeMap);
      busMarkers[i].on('click', () => markBusStop(i));
    });
    const ctl = Lf.control({ position: 'topright' });
    ctl.onAdd = () => { const d = Lf.DomUtil.create('div'); d.innerHTML = '<button type="button" class="bus-all" data-busall hidden>Show all stops</button>'; Lf.DomEvent.disableClickPropagation(d); return d; };
    ctl.addTo(changeMap);
    busAllBounds = Lf.latLngBounds([HUB.ll, ...HUB_BUS_STOPS.map((b) => b.ll)]).pad(0.2);
    changeMap.fitBounds(busAllBounds);
  } catch { box.hidden = true; }
}
// Tapping a stop in the list (owner, Nov 25) zooms the map in to it.
let busMarkers = [], busAllBounds = null;
function markBusStop(i) {
  document.querySelectorAll('#chg-below [data-busstop]').forEach((li) => li.classList.toggle('on', +li.dataset.busstop === i));
  document.querySelectorAll('#chg-map .bus-dot').forEach((d) => d.classList.toggle('on', d.textContent === String(i + 1)));
  busMarkers.forEach((m, j) => m && m.setZIndexOffset(j === i ? 1000 : 0));
  const all = document.querySelector('[data-busall]'); if (all) all.hidden = i < 0;
}
function zoomBusStop(i) {
  const m = busMarkers[i];
  if (!changeMap || !m) return;
  markBusStop(i);
  $('chg-map').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  changeMap.flyTo(m.getLatLng(), 18.5, { duration: 0.6 });
  changeMap.once('moveend', () => m.openPopup());
}
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-busmap]')) openBusMap();
  if (e.target.closest('[data-busall]')) { changeMap && changeMap.closePopup(); markBusStop(-1); if (changeMap && busAllBounds) changeMap.flyToBounds(busAllBounds, { duration: 0.6 }); }
  const li = e.target.closest('[data-busstop]');
  if (li && !e.target.closest('a')) zoomBusStop(+li.dataset.busstop);
});
document.addEventListener('keydown', (e) => { const li = e.target.closest && e.target.closest('[data-busstop]'); if (li && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); zoomBusStop(+li.dataset.busstop); } });
loadHubBuses();
setInterval(loadHubBuses, 60000);
setInterval(renderHubBuses, 10000);

// ---------- airport helper: Penn's part (owner, Nov 24-25) ----------
// The screen, fares, airport buses, the Newark Airport Express, Islip and
// Stewart are shared with the other hubs in airport.js; Penn's own routes are here.
const PENN_AIR = {
  id: 'nyp', from: 'Penn Station', buses: 'airport-buses.json',
  ewrFrom: 'days', ewrWalk: 10, ewrWalkText: 'Walk up 8 Av to Port Authority (41 St), or the A, C or E one stop', ewrStop: 'Port Authority Bus Terminal',
  toPabt: 10, toPabtText: 'Walk up 8 Av to Port Authority (41 St), or the A, C or E one stop',
  toGct: 15, toGctText: () => `${lineName('2')} or ${lineName('3')} to Times Sq, then the ${lineName('S')} or ${lineName('7')} to Grand Central`,
};
function pennAirportLoad() { loadLirrTT(); loadNjtStop(NEWARK_PENN_62_STOP); loadSubwayGuide(); loadPathFeed(); }
// The next live departures from Penn that call at a station (railroads).
function railTo(carriers, stop, nowS) {
  return ((board && board.departures) || []).filter((r) => carriers.includes(r.carrier) && r.tone !== 'stop' && r.tone !== 'departed' && !r.departed
    && (r.leaves ?? r.time) >= nowS + 60 && (r.via || []).concat(r.place).some((v) => new RegExp(`^${stop}\\b`, 'i').test(v)))
    .sort((a, b) => (a.leaves ?? a.time) - (b.leaves ?? b.time));
}
// The next live subway trains from Penn (8 Av) whose stops include one.
function subwayTo(route, stopId, nowS) {
  return ((board && board.subway) || []).filter((g) => g.route === route && g.trains[0] && g.trains[0].stops[0] === 'A28')
    .flatMap((g) => g.trains).filter((t) => t.time >= nowS + 60 && (t.stops || []).includes(stopId)).sort((a, b) => a.time - b.time);
}
const subRide = (key, fallback) => { const r = subwayGuide && subwayGuide.rides && subwayGuide.rides[key]; return (r && (nyNow().mins < 5 * 60 ? r.night : r.day)) || fallback; };
// The next train on a subway route from one Penn station that reaches a station.
function subwayFromTo(route, from, to, nowS) {
  return ((board && board.subway) || []).filter((g) => g.route === route && g.trains[0] && g.trains[0].stops && g.trains[0].stops[0] === from)
    .flatMap((g) => g.trains).filter((t) => t.time >= nowS + 60 && (t.stops || []).includes(to)).sort((a, b) => a.time - b.time)[0];
}
// When a live LIRR train from Penn reaches a station, by the timetable (else null).
function lirrArrivalAt(r, station) {
  if (typeof lirrTT === 'undefined' || !lirrTT || !lirrData) return null;
  const id = Object.keys(lirrData.stops).find((k) => normName2(lirrData.stops[k][0]) === normName2(station));
  const trip = lirrTripsNear().find((x) => x.train === trainNo(r.train));
  const at = trip && trip.calls.find(([sid]) => sid === id);
  const penn = trip && trip.calls.find(([sid]) => sid === ttFrom(lirrTT));
  return at && penn ? at[1] + ((r.leaves ?? r.time) - penn[1]) : null;
}
// Penn's own routes (JFK, LaGuardia, Newark); airport.js adds the shared ones.
function pennAirportOptions(code, nowS) {
  const o = [];
  const lirrFare = (r) => (r.fare === 'peak' ? FARES.cityPeak : FARES.cityOff);
  if (code === 'JFK') {
    const l = railTo(['lirr'], 'Jamaica', nowS)[0];
    if (l) { const dep = l.leaves ?? l.time, at = dep + (AIR_MIN.lirrJamaica + AIR_MIN.change + AIR_MIN.airtrainJfkWait + AIR_MIN.airtrainJfkRide) * 60;
      o.push({ at, fare: lirrFare(l) + FARES.airtrainJfk, legs: [[dep, `${airPl('LIRR', 'p-lirr')} to Jamaica${l.track ? `, track ${esc(l.track)}` : ''}`], [dep + (AIR_MIN.lirrJamaica + AIR_MIN.change) * 60, `${airPl('AirTrain', 'p-air')} to your terminal`]] }); }
    const e = subwayTo('E', 'G06', nowS)[0];
    if (e) { const ride = subRide('E|A28|G06', 35); const at = e.time + (ride + AIR_MIN.change + AIR_MIN.airtrainJfkWait + AIR_MIN.airtrainJfkRide) * 60;
      o.push({ at, fare: FARES.subway + FARES.airtrainJfk, legs: [[e.time, `${lineName('E')} to Sutphin Blvd-Archer Av-JFK`], [e.time + (ride + AIR_MIN.change) * 60, `${airPl('AirTrain', 'p-air')} to your terminal`]] }); }
    const a = subwayTo('A', 'H03', nowS)[0];
    if (a) { const ride = subRide('A|A28|H03', 46); const at = a.time + (ride + AIR_MIN.change + AIR_MIN.airtrainJfkWait + AIR_MIN.airtrainJfkRide) * 60;
      o.push({ at, fare: FARES.subway + FARES.airtrainJfk, legs: [[a.time, `${lineName('A')} to Howard Beach-JFK`], [a.time + (ride + AIR_MIN.change) * 60, `${airPl('AirTrain', 'p-air')} to your terminal`]] }); }
  } else if (code === 'LGA') {
    const l = railTo(['lirr'], 'Woodside', nowS)[0];
    if (l) { const dep = l.leaves ?? l.time, at = dep + (AIR_MIN.lirrWoodside + AIR_MIN.change + AIR_MIN.q70Wait + AIR_MIN.q70FromWoodside) * 60;
      o.push({ at, fare: lirrFare(l), legs: [[dep, `${airPl('LIRR', 'p-lirr')} to Woodside${l.track ? `, track ${esc(l.track)}` : ''}`], [dep + (AIR_MIN.lirrWoodside + AIR_MIN.change) * 60, `${airPl('Q70 LaGuardia Link', 'p-sbs')} (free), about every 10 min`]] }); }
  } else if (code === 'EWR') {
    const n = railTo(['njt'], 'Newark Airport', nowS)[0];
    if (n) { const dep = n.leaves ?? n.time, at = dep + (AIR_MIN.njtEwr + AIR_MIN.change + AIR_MIN.airtrainEwrWait + AIR_MIN.airtrainEwrRide) * 60;
      o.push({ at, fare: FARES.njtEwr, legs: [[dep, `${airPl('NJ Transit', 'p-njt')} to Newark Airport${n.track ? `, track ${esc(n.track)}` : ''}`], [dep + (AIR_MIN.njtEwr + AIR_MIN.change) * 60, `${airPl('AirTrain', 'p-air')} to your terminal (included)`]] }); }
    const m = railTo(['amtrak'], 'Newark Airport', nowS)[0];
    if (m) { const dep = m.leaves ?? m.time, at = dep + (AIR_MIN.amtrakEwr + AIR_MIN.change + AIR_MIN.airtrainEwrWait + AIR_MIN.airtrainEwrRide) * 60;
      o.push({ at, fare: null, fareText: 'Amtrak fare varies by train', note: 'Reservation required: buy an Amtrak ticket for this train before you board. NJ Transit tickets aren’t valid on Amtrak.', legs: [[dep, `${airPl('Amtrak', 'p-amtrak')} ${esc(m.line || '')} to Newark Airport${m.track ? `, track ${esc(m.track)}` : ''}`], [dep + (AIR_MIN.amtrakEwr + AIR_MIN.change) * 60, `${airPl('AirTrain', 'p-air')} to your terminal (included)`]] }); }
    // PATH to Newark Penn, then one stop on NJ Transit or the 62 bus.
    const p = ((board && board.path) || []).find((x) => /journal square/i.test(x.dest || '') && x.time >= nowS + AIR_MIN.walkToPath * 60);
    if (p) {
      const night = nyNow().mins < 6 * 60 || nyNow().mins >= 23 * 60;
      const atNewark = p.time + ((/hoboken/i.test(p.dest) ? AIR_MIN.pathJsqViaHob : AIR_MIN.pathJsq) + AIR_MIN.change + (night ? AIR_MIN.pathNewarkWaitNight : AIR_MIN.pathNewarkWait) + AIR_MIN.pathNewark) * 60;
      const pathLegs = [[p.time - AIR_MIN.walkToPath * 60, 'Walk to the 33 St PATH station (6 Av & 32 St)'],
        [p.time, `${airPl('PATH', 'p-path')} to ${esc(p.dest)}, then change for Newark`]];
      o.push(...newarkPennOptions(pathLegs, atNewark, night, FARES.path, 'PATH'));
    }
    // The E to World Trade Center, then PATH straight to Newark (no change at
    // Journal Square). Same as the Grand Central board's 4/5 to Fulton St route.
    const e = subwayFromTo('E', 'A28', 'E01', nowS);
    if (e) {
      const night = nyNow().mins < 6 * 60 || nyNow().mins >= 23 * 60;
      const w = pathFromStation('WTC', /newark/i, e.time + (11 + 5) * 60);
      if (w) {
        o.push(...newarkPennOptions([[e.time, `${lineName('E')} to World Trade Center, then walk through to the PATH station`],
          [w.time, `${airPl('PATH', 'p-path')} to Newark`]], w.time + 22 * 60, night, FARES.subway + FARES.path, 'subway + PATH'));
      }
    }
  }
  return o;
}
// PATH's live departures at any station (relay /path), for the World Trade Center route.
let pathFeedAll = null, pathFeedAt = 0;
function loadPathFeed() {
  if (!window.PENN_RELAY || Date.now() - pathFeedAt < 20000) return;
  pathFeedAt = Date.now();
  fetch(`${window.PENN_RELAY}/path`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((d) => { pathFeedAll = d; if (changeOpen && changeOpen.id === 'airport' && $('change').open) renderAirport(); }).catch(() => {});
}
function pathFromStation(station, destRe, after) {
  const st = ((pathFeedAll && pathFeedAll.results) || []).find((r) => r.consideredStation === station);
  const t = Date.now() / 1000;
  return ((st && st.destinations) || []).flatMap((d) => d.messages || []).map((m) => ({ dest: m.headSign || '', time: t + (parseInt(m.secondsToArrival, 10) || 0) }))
    .filter((x) => destRe.test(x.dest) && x.time >= after).sort((a, b) => a.time - b.time)[0];
}

// ---------- airport helper: Grand Central's part (owner, Nov 25) ----------
// Its own routes: LIRR from Grand Central Madison, the 6/E and 7/A to JFK, the 7
// and LIRR to the Q70, and Newark by NJ Transit or Amtrak from Penn, PATH from
// 33 St (a walk) or World Trade Center (the 4/5), with the shared Newark Penn
// connections. airport.js adds buses, the Newark Airport Express (from 41 St),
// Islip and Stewart.
const GCT_AIR = {
  id: 'gct', from: 'Grand Central', buses: 'airport-buses-gct.json',
  ewrFrom: 'gct', ewrWalk: 4, ewrWalkText: 'Walk to the Newark Airport Express stop on 41 St, between Park and Lexington Avs', ewrStop: 'Grand Central (41 St)',
  toPabt: 15, toPabtText: 'The S to Times Sq-42 St, then walk west on 42 St to Port Authority (8 Av)',
  toGct: 0, lirrFrom: ' from Grand Central Madison',
};
const TO_PENN_MIN = 15; // the S to Times Sq, then the 1, 2 or 3 one stop, to the NJ Transit concourse
// NJ Transit's live departures from Penn (for Newark Airport), through the relay.
let njtPenn = [], njtPennAt = 0;
function loadNjtPenn() {
  if (!window.PENN_RELAY || Date.now() - njtPennAt < 30000) return;
  njtPennAt = Date.now();
  fetch(`${window.PENN_RELAY}/njt`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((d) => {
    njtPenn = d && d.ITEMS ? PennFeeds.parseNjt(d.ITEMS).filter((x) => x.carrier === 'njt') : [];
    if (changeOpen && changeOpen.id === 'airport' && $('change').open) renderAirport();
  }).catch(() => {});
}
// Amtrak trains from Penn that stop at Newark Airport (Amtraker, as on the Penn board).
let amtrakEwr = [], amtrakEwrAt = 0;
function loadAmtrakEwr() {
  if (Date.now() - amtrakEwrAt < 60000) return;
  amtrakEwrAt = Date.now();
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
// The M60-SBS eastbound at E 125 St/Lexington Av (MTA stop 405421), and its
// usual ride from there to LaGuardia by hour of the day (MTA Manhattan bus
// timetable, Nov 2026: about 21 min overnight, 33 min at 4 PM to Terminal C).
const M60_125 = '405421';
const M60_RIDE = {
  C: [22, 22, 22, 21, 21, 24, 25, 27, 27, 27, 27, 27, 27, 27, 29, 29, 33, 31, 28, 28, 26, 26, 25, 23],
  B: [24, 24, 24, 23, 23, 26, 27, 30, 30, 30, 30, 30, 30, 30, 32, 32, 36, 34, 31, 31, 29, 28, 27, 25],
};
function gctAirportLoad() { loadLirrTT(); loadNjtPenn(); loadPathFeed(); loadAmtrakEwr(); loadNjtStop(NEWARK_PENN_62_STOP); }
function gctAirportOptions(code, nowS) {
  const o = [];
  const lirrFare = (r) => (r.fare === 'peak' ? FARES.cityPeak : FARES.cityOff);
  const lirrLeg = (r, to) => `${airPl('LIRR', 'p-lirr')} to ${to} from Grand Central Madison${r.track ? `, track ${esc(r.track)}` : ''}`;
  if (code === 'JFK') {
    // LIRR from Grand Central Madison to Jamaica, then the AirTrain.
    const l = railTo(['lirr'], 'Jamaica', nowS)[0];
    if (l) {
      const arr = lirrArrivalAt(l, 'Jamaica') || (l.leaves ?? l.time) + 22 * 60;
      const air = arr + AIR_MIN.change * 60;
      o.push({ at: air + (AIR_MIN.airtrainJfkWait + AIR_MIN.airtrainJfkRide) * 60, fare: lirrFare(l) + FARES.airtrainJfk,
        legs: [[l.leaves ?? l.time, lirrLeg(l, 'Jamaica')], [air, `${airPl('AirTrain', 'p-air')} to your terminal`]] });
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
      const arr = lirrArrivalAt(l, 'Woodside') || (l.leaves ?? l.time) + 12 * 60;
      const bus = arr + (AIR_MIN.change + AIR_MIN.q70Wait) * 60;
      o.push({ at: bus + AIR_MIN.q70FromWoodside * 60, fare: lirrFare(l),
        legs: [[l.leaves ?? l.time, lirrLeg(l, 'Woodside')], [bus, `${airPl('Q70 LaGuardia Link', 'p-sbs')} (free), about every 10 min`]] });
    }
    // To 125 St, then the M60-SBS from E 125 St/Lexington Av (owner, Nov 26:
    // "Metro-North to Harlem-125th St to the M60" can beat the rest at some hours).
    // The bus is live from MTA Bus Time; its ride is the timetable's for that hour.
    const m60 = (ready) => {
      loadMtaBusStop(M60_125);
      const lb = mtaBusLive.get(M60_125);
      const next = lb && lb.buses ? lb.buses.filter((b) => /^M60/i.test(String(b.line)) && b.at && Date.parse(b.at) / 1000 >= ready).sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0] : null;
      const at = next ? Date.parse(next.at) / 1000 : ready + 5 * 60;
      const b = lgaTerminal === 'B';
      const ride = (b ? M60_RIDE.B : M60_RIDE.C)[Math.floor(nyDayAt(at).mins / 60) % 24];
      return { at, arrive: at + ride * 60, term: b ? 'Terminal B' : 'Terminal C',
        leg: [at, `${airPl('M60-SBS', 'p-mtabus')} from E 125 St/Lexington Av to LaGuardia ${b ? 'Terminal B' : 'Terminal C'}${next ? ' · <span class="sb-live">live</span>' : ', about every 10 min'}`] };
    };
    const mn = railTo(['mnr'], 'Harlem-125 St', nowS)[0];
    if (mn) {
      const dep = mn.leaves ?? mn.time;
      const bus = m60(dep + (AIR_MIN.mnrHarlem + AIR_MIN.walkHarlemLex) * 60);
      const f = railFare(HUB.mnrCode, '0HL'), pk = mn.fare === 'peak';
      const rail = railCost(f, pk) ?? (pk ? FARES.cityPeak : FARES.cityOff);
      o.push({ at: bus.arrive, fare: rail + FARES.subway, term: bus.term, live: true,
        fareText: `${money(rail)} Metro-North${f && f.city ? ' CityTicket' : ''}${pk ? ' (peak)' : ''}, plus ${money(FARES.subway)} for the bus (no free transfer)`,
        legs: [[dep, `<span class="plate ${esc(mn.plateClass || 'mnr')}">${esc(mn.plate || 'Metro-North')}</span> train ${esc(mn.train)} to Harlem-125 St${mn.track ? `, track ${esc(mn.track)}` : ''}`],
          [dep + AIR_MIN.mnrHarlem * 60, 'Walk east on 125 St to Lexington Av, about 3 min'], bus.leg] });
    }
    const lex = ['4', '5'].map((r) => { const t = subwayFromTo(r, '631', '621', nowS); return t && { ...t, route: r }; }).filter(Boolean).sort((x, y) => x.time - y.time)[0];
    if (lex) {
      const bus = m60(lex.time + (AIR_MIN.lexTo125 + 2) * 60);
      o.push({ at: bus.arrive, fare: FARES.subway, term: bus.term, live: true,
        fareText: `${money(FARES.subway)} one way (subway, free transfer to the bus)`,
        legs: [[lex.time, `${lineName(lex.route)} to 125 St`], bus.leg] });
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
    const live33 = pathFromStation('33S', /journal square/i, nowS + WALK_33ST_MIN * 60);
    const p = live33 || { dest: 'Journal Square', time: nowS + (WALK_33ST_MIN + (night ? 10 : 5)) * 60, est: true };
    if (p) {
      const atNewark = p.time + ((/hoboken/i.test(p.dest) ? AIR_MIN.pathJsqViaHob : AIR_MIN.pathJsq) + AIR_MIN.change + (night ? AIR_MIN.pathNewarkWaitNight : AIR_MIN.pathNewarkWait) + AIR_MIN.pathNewark) * 60;
      o.push(...newarkPennOptions([[p.time - WALK_33ST_MIN * 60, 'Walk to the 33 St PATH station (6 Av & 32 St), about 18 min'],
        [p.time, `${airPl('PATH', 'p-path')} to ${esc(p.dest)}, then change for Newark${p.est ? `, about every ${night ? 20 : 10} min` : ''}`]], atNewark, night, FARES.path, 'PATH', p.est ? false : undefined));
    }
    // b) The 4 or 5 to Fulton St, then PATH from World Trade Center straight to Newark.
    const lex = ['4', '5'].map((r) => { const t = subwayFromTo(r, '631', '418', nowS); return t && { ...t, route: r }; }).filter(Boolean).sort((x, y) => x.time - y.time)[0];
    if (lex) {
      const w = pathFromStation('WTC', /newark/i, lex.time + (10 + FULTON_TO_WTC_PATH_MIN) * 60);
      if (w) {
        o.push(...newarkPennOptions([[lex.time, `${lineName(lex.route)} to Fulton St, then walk through to the World Trade Center PATH station`],
          [w.time, `${airPl('PATH', 'p-path')} to Newark`]], w.time + (PATH_WTC_NEWARK_MIN) * 60, night, FARES.subway + FARES.path, 'subway + PATH'));
      }
    }
  }
  return o;
}
// This hub's part of the airport helper (airport.js calls these).
const HUB_AIR = IS_PENN ? PENN_AIR : GCT_AIR;
const hubAirportOptions = (code, nowS) => (IS_PENN ? pennAirportOptions(code, nowS) : gctAirportOptions(code, nowS));
const hubAirportLoad = () => (IS_PENN ? pennAirportLoad() : gctAirportLoad());

// ---------- Buses tab (testing) ----------
// For NJ Transit rail outages and strikes: pick your station, see how to get
// to Port Authority (subway or walk) and the buses from there that stop near
// it. docs/njt-bus-finder.json comes from NJ Transit's and partner companies'
// timetables (scripts/build-njt-bus-finder.py). NJ Transit buses are live
// (getBusDV at Port Authority through the relay), matched to the station by
// their sign; partner companies show their published schedule.
const NJT_LINE_NAMES = { BNTN: 'Montclair-Boonton', BNTNM: 'Montclair-Boonton', MNBN: 'Main/Bergen County', MNBNP: 'Port Jervis', MNE: 'Morris & Essex', MNEG: 'Gladstone Branch', MRL: 'Meadowlands', NEC: 'Northeast Corridor', NJCL: 'North Jersey Coast', NJCLL: 'North Jersey Coast', PASC: 'Pascack Valley', PRIN: 'Princeton Shuttle', RARV: 'Raritan Valley' };
let busFinder;            // undefined: not loaded; null: couldn't load
let busFinderLoading = null;
let busLive = null, busLiveAt = 0, busLiveLoading = null;
let busStation = '';
try { busStation = localStorage.getItem('busStation') || ''; } catch {}
function loadBusFinder() {
  if (busFinder !== undefined || busFinderLoading) return;
  busFinderLoading = fetch('njt-bus-finder.json').then((r) => (r.ok ? r.json() : null)).catch(() => null)
    .then((d) => { busFinder = d; busFinderLoading = null; if (busesShown()) renderBuses(); });
}
function loadBusLive() {
  if (busLiveLoading || Date.now() - busLiveAt < 30000 || !window.PENN_RELAY) return;
  busLiveLoading = fetch(window.PENN_RELAY + '/njt-bus-pabt', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status))))
    .then((d) => { busLive = { trips: (d && d.DVTrip) || [], at: Date.now() }; })
    .catch(() => { busLive = busLive && busLive.trips ? busLive : { error: true, trips: [] }; })
    .finally(() => { busLiveAt = Date.now(); busLiveLoading = null; if (busesShown()) renderBuses(); });
}
const normSign = (x) => String(x || '').replace(/\s+/g, ' ').trim().toUpperCase();
const busPill = (o) => (o.agency === 'NJ Transit' ? `<span class="pl p-njt">${esc(o.route)}</span>` : `<span class="pl p-partner">${esc(o.agency)}${o.route ? ` ${esc(o.route)}` : ''}</span>`);
// Next scheduled departures from the timetable, as minutes from now (today, then tomorrow).
function busScheduled(o) {
  const key = { weekday: 'wk', saturday: 'sa', sunday: 'su' };
  const today = nyNow(), tomorrow = nyNow(1);
  return [...((o.times || {})[key[today.day]] || []).filter((t) => t >= today.mins).map((t) => ({ in: t - today.mins, tomorrow: false, t })),
    ...((o.times || {})[key[tomorrow.day]] || []).map((t) => ({ in: t + 1440 - today.mins, tomorrow: true, t }))];
}
// Live NJ Transit departures from Port Authority whose sign reaches the station, as minutes from now.
function busLiveFor(o) {
  if (o.agency !== 'NJ Transit' || !busLive || busLive.error) return null;
  const signs = new Set((o.heads || []).map(normSign));
  const now = nyNow().mins;
  return busLive.trips.filter((x) => x.public_route === o.route && signs.has(normSign(x.header))).map((x) => {
    const m = /in (\d+) min/i.exec(x.departurestatus || '');
    const c = /(\d+):(\d+)\s*(AM|PM)/i.exec(x.departuretime || '');
    const t = c ? (+c[1] % 12) * 60 + +c[2] + (/pm/i.test(c[3]) ? 720 : 0) : null;
    const inMin = m ? +m[1] : t != null ? ((t - now + 1440) % 1440) : null;
    // Late: the live departure against its scheduled time ("05:30:00 PM").
    const sc = /(\d+):(\d+):\d+\s*(AM|PM)/i.exec(x.sched_dep_time || '');
    const st = sc ? (+sc[1] % 12) * 60 + +sc[2] + (/pm/i.test(sc[3]) ? 720 : 0) : null;
    let late = t != null && st != null ? ((t - st + 1440) % 1440) : 0;
    if (late > 720) late = 0;
    return { in: inMin > 1200 ? inMin - 1440 : inMin, soon: !!m, t, late, gate: String(x.lanegate || '').split('_')[0] };
  }).filter((x) => x.in != null && x.in >= 0).sort((a, b) => a.in - b.in);
}
// Distances in miles: "about 2 miles", "about 1.5 miles", "under a mile".
const milesText = (m) => { const mi = m / 1609.344; if (mi < 1) return 'a mile'; const r = mi < 3 ? Math.round(mi * 2) / 2 : Math.round(mi); return `about ${r} mile${r === 1 ? '' : 's'}`; };
const clockOf = (t) => `${fmtMins(t)} ${(t % 1440) < 720 ? 'AM' : 'PM'}`;
// "300 - NYC - Middletown" under route 300: drop the repeated number and "Westbound".
function busName(o) {
  const n = String(o.name || '').replace(/\b(east|west|north|south)bound\b/ig, '').replace(/\s*-\s*$/, '').trim();
  const r = String(o.route || '').trim();
  const rest = r && n.toLowerCase().startsWith(r.toLowerCase()) ? n.slice(r.length).replace(/^\s*-\s*/, '').trim() : n;
  return rest || o.head || '';
}
function portAuthorityHtml(nowS) {
  if (!IS_PENN) return portAuthorityFromGct(nowS);
  const trainsTo = (routes, from, to) => ((board && board.subway) || []).filter((g) => routes.includes(g.route) && g.trains[0] && g.trains[0].stops && g.trains[0].stops[0] === from)
    .flatMap((g) => g.trains.map((t) => ({ ...t, route: g.route }))).filter((t) => (t.stops || []).includes(to) && t.time >= nowS + 60).sort((a, b) => a.time - b.time).slice(0, 3);
  const next = (ts) => ts.map((t) => `${bulletHtml(t.route, 'inl')} ${Math.round((t.time - nowS) / 60)} min`).join(' &nbsp; ');
  const ace = trainsTo(['A', 'C', 'E'], 'A28', 'A27');
  const sub = ace.length
    ? `<div><span>Subway: ${['A', 'C', 'E'].map((r) => bulletHtml(r, 'inl')).join(' ')} uptown, one stop to 42 St-Port Authority Bus Terminal</span><span class="dim">From 34 St-Penn Station (8 Av) · about 5 min with the wait</span><b>Next: ${next(ace)}</b></div>`
    : (() => {
      const t = trainsTo(['1', '2', '3'], '128', '127');
      return t.length
        ? `<div><span>Subway: ${['1', '2', '3'].map((r) => bulletHtml(r, 'inl')).join(' ')} uptown, one stop to Times Sq-42 St, then the underground passage to Port Authority</span><span class="dim">From 34 St-Penn Station (7 Av). No uptown ${['A', 'C', 'E'].map((r) => bulletHtml(r, 'inl')).join(' ')} listed right now.</span><b>Next: ${next(t)}</b></div>`
        : `<div><span>Subway: no uptown trains to 42 St listed right now.</span></div>`;
    })();
  return `<div class="bf-get">${sub}<div><span>Walk up 8 Av to 41 St</span><span class="dim">About 10 min. Port Authority's entrance is at 8 Av and 41 St.</span></div></div>`;
}
// From Grand Central: the shuttle or the 7 to Times Sq, then the passage under 42 St to Port Authority.
function portAuthorityFromGct(nowS) {
  const ts = [['GS', '901', '902'], ['7', '723', '725']].map(([r, a, b]) => { const t = subwayFromTo(r, a, b, nowS); return t && { ...t, route: r }; }).filter(Boolean).sort((x, y) => x.time - y.time);
  const sub = ts.length
    ? `<div><span>Subway: the ${lineName('S')} or ${lineName('7')} to Times Sq-42 St, then the underground passage west to Port Authority</span><span class="dim">About 10 min with the walk</span><b>Next: ${ts.slice(0, 3).map((t) => `${bulletHtml(t.route, 'inl')} ${Math.max(0, Math.round((t.time - nowS) / 60))} min`).join(' &nbsp; ')}</b></div>`
    : '<div><span>Subway: no shuttle or 7 to Times Sq listed right now.</span></div>';
  return `<div class="bf-get">${sub}<div><span>Walk west on 42 St to 8 Av</span><span class="dim">About 20 min. Port Authority's entrance is at 8 Av and 41 St.</span></div></div>`;
}
function renderBuses() {
  const box = $('buses');
  // Only where NJ Transit's buses leave nearby (Penn, Port Authority); not Grand Central (owner, Nov 26).
  if (!box) return;
  loadBusFinder();
  loadBusLive();
  if (busFinder === undefined) { box.innerHTML = '<p class="empty">Loading buses…</p>'; return; }
  if (!busFinder) { box.innerHTML = '<p class="empty">The bus list didn’t load. Try again in a moment.</p>'; return; }
  const nowS = Date.now() / 1000;
  const stations = Object.entries(busFinder.stations);
  const st = busFinder.stations[busStation];
  const open = document.activeElement && document.activeElement.id === 'bf-station';
  if (open) return;  // don't redraw under an open picker
  // NJ Transit's own word that rail tickets are good on its buses (a storm, a rail outage).
  const xh = ((board && board.notices && board.notices.rail) || []).filter((n) => n.carrier === 'njt' && /cross[- ]?honou?r/i.test(n.text) && /bus/i.test(n.text));
  if ($('njt-bus-note')) $('njt-bus-note').innerHTML = xh.length ? `<div class="njt-xh"><b>Cross-honoring:</b> ${noticeText(xh[0].text)}</div>` : '';
  let html = `<p class="bf-intro">Pick your NJ Transit station to see the buses from Port Authority Bus Terminal that stop near it: for when trains aren’t running, or rail tickets are good on buses.</p>
    <select id="bf-station" class="bf-select" aria-label="Your station"><option value="">Choose your station</option>${stations.map(([c, x]) => `<option value="${esc(c)}"${c === busStation ? ' selected' : ''}>${esc(x.name)}${x.lines.length ? ` (${esc([...new Set(x.lines.map((l) => NJT_LINE_NAMES[l] || l))].join(', '))})` : ''}</option>`).join('')}</select>`;
  if (st) {
    // (At the bus terminal itself there's nothing to get to.)
    html += HUB.busTerminal ? `<p class="bf-h">Buses to ${esc(st.name)}</p>` : `<p class="bf-h">1 · Get to Port Authority</p>${portAuthorityHtml(nowS)}<p class="bf-h">2 · Bus to ${esc(st.name)}</p>`;
    if (!st.buses.length) {
      html += `<div class="opt-card">No bus from Port Authority goes near ${esc(st.name)}. See NJ Transit’s <a href="https://www.njtransit.com/abc" target="_blank" rel="noopener">alternate service plans&nbsp;↗&#xFE0E;</a>.</div>`;
    }
    // The bus that gets you there first comes first.
    const opts = st.buses.map((o) => {
      const live = busLiveFor(o);
      const sched = live && live.length ? null : busScheduled(o);
      const first = live && live.length ? live[0].in : sched.length ? sched[0].in : Infinity;
      return { o, live, sched, arrive: first + o.total };
    }).sort((a, b) => a.arrive - b.arrive);
    for (const { o, live, sched } of opts) {
      let deps;
      if (live && live.length) {
        deps = `<div class="deps">${live.slice(0, 3).map((x) => `<span>${x.soon || x.t == null ? `in ${x.in} min` : clockOf(x.t)}${x.late >= 2 ? ` <span class="bus-late">${x.late} min late</span>` : ''}${x.gate && x.gate !== 'EMPTY' ? `<span class="gate">Gate ${esc(x.gate)}</span>` : ''}</span>`).join('')}</div>`;
      } else {
        const why = o.agency !== 'NJ Transit' ? 'Scheduled' : busLive && !busLive.error ? 'None listed live now · scheduled' : 'Scheduled';
        deps = sched.length ? `<div class="deps sched">${sched.slice(0, 3).map((x) => `<span>${clockOf(x.t)}${x.tomorrow ? ' tomorrow' : ''}</span>`).join('')}<span class="kind">${why}</span></div>`
          : '<div class="deps sched"><span>No trips in the timetable</span></div>';
      }
      const gates = !(live && live.length) && o.gates.length ? ` <span class="gate">Gate ${esc(o.gates.slice(0, 2).join(' or '))}</span>` : '';
      const where = o.far
        ? `Gets within ${milesText(o.walkM)} of the station at ${esc(o.stop)}; you’ll need a taxi or local ride from there.`
        : `Get off at ${esc(o.stop)}, ${o.walk} min walk to the station.`;
      const from = o.from ? ` Leaves from ${esc(o.from)}, not inside Port Authority.` : '';
      const often = o.gap && o.gap <= 60 ? `; by day about every ${o.gap} min` : o.weekdayTrips ? `; ${o.weekdayTrips} trip${o.weekdayTrips === 1 ? '' : 's'} on weekdays` : '';
      html += `<div class="opt-card bf-bus"><div class="rt">${busPill(o)} ${esc(busName(o))}${gates}</div>${deps}
        <span class="sub">${where}${from} About ${o.total} min from Port Authority${often}.</span></div>`;
    }
  }
  html += `<p class="cm-live">NJ Transit bus times are live from NJ Transit and may not be real-time data. Other companies show their published schedules. Buy tickets from each bus company.${busLive && busLive.error ? ' Live NJ Transit bus times didn’t load; showing schedules.' : ''}</p>`;
  box.innerHTML = html;
}
document.addEventListener('change', (e) => {
  if (e.target.id !== 'bf-station') return;
  busStation = e.target.value;
  try { localStorage.setItem('busStation', busStation); } catch {}
  e.target.blur();
  renderBuses();
});
setInterval(() => { if (busesShown()) renderBuses(); }, 30000);


// A line bullet keeps the punctuation after it on the same line ("on the 2."
// never leaves the period alone on the next line). Runs on whatever the board
// draws, wherever bullets appear.
function glueBullets(root) {
  for (const b of root.querySelectorAll('.bullet')) {
    const n = b.nextSibling;
    if (!n || n.nodeType !== 3 || !/^[.,:;)]/.test(n.data) || (b.parentNode && b.parentNode.classList && b.parentNode.classList.contains('nowrap-b'))) continue;
    const w = document.createElement('span');
    w.className = 'nowrap-b';
    b.replaceWith(w);
    w.append(b, n.data[0]);
    n.data = n.data.slice(1);
  }
}
let glueQueued = false;
new MutationObserver(() => {
  if (glueQueued) return;
  glueQueued = true;
  requestAnimationFrame(() => { glueQueued = false; glueBullets(document.body); });
}).observe(document.body, { childList: true, subtree: true });
glueBullets(document.body);


// Installed as an app: the offline helper (docs/sw.js) keeps the page itself
// available with no connection; live data still comes fresh.
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('sw.js').catch(() => {});
