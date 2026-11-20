const REFRESH_MS = 20000;
const CARRIERS = { lirr: 'LIRR', njt: 'NJ Transit', amtrak: 'Amtrak', path: 'PATH' };
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

// ---------- flip board style ----------
// An optional look (Board style, at the bottom of the page): the masthead,
// clock and each train's time, destination, status and track are drawn as
// split-flap tiles. Rows are redrawn often, so the page remembers what each
// field last showed (`flipShown`) and, after a redraw, turns over only the
// tiles whose character changed, stepping through a few letters between as a
// real board does. (It flips even with the device's Reduce Motion setting on:
// the owner's choice, since flipping is the point of this style.)
let flipMode = false;
try { flipMode = localStorage.getItem('boardStyle') === 'flip'; } catch {}
const flipShown = new Map(); // field key -> text it shows now
const FLIP_CHARS = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789:';
// A tile: its upper and lower halves, and two flaps that are always there
// (no elements are made or removed while flipping): the old character's upper
// half, which folds down, and the new character's lower half, which unfolds.
const tileHtml = (c) => `<span class="f"><span class="t"><b>${esc(c)}</b></span><span class="bt"><b>${esc(c)}</b></span><span class="ft"><b></b></span><span class="fb"><b></b></span></span>`;
// Tiles for `text`, showing what the field showed before; runFlips() turns them.
const flipLook = new Map(); // field key -> its colour state (e.g. 'final'), so a colour change flips too
function flipText(key, text, cls = '') {
  const to = String(text ?? '').toUpperCase();
  if (!flipMode) return esc(text);
  const from = flipShown.has(key) ? flipShown.get(key) : '';
  const n = Math.max(from.length, to.length, 1);
  const cells = [...from.padEnd(n)].slice(0, n);
  // Words wrap as whole groups, at the spaces of the new text.
  let html = '<span class="fw">';
  for (let i = 0; i < n; i++) {
    html += tileHtml(cells[i]);
    if (to[i] === ' ' && i < n - 1) html += '</span><span class="fw">';
  }
  html += '</span>';
  return `<span class="fl ${cls}" data-k="${esc(key)}" data-to="${esc(to)}" data-look="${esc(cls)}" role="text" aria-label="${esc(text)}">${html}</span>`;
}
// Flips run a few rows at a time, top to bottom, so a whole board changing
// at once (opening the page, switching tabs) never asks the phone to animate
// hundreds of tiles together. Rows off screen just show their new text.
const FLIP_ROWS_AT_ONCE = 3;
const flipQueue = [];
let flipRunning = 0;
function runFlips(root) {
  if (!flipMode) return;
  const groups = new Map(); // row (or masthead/clock) -> its tile changes
  const vh = innerHeight;
  // Measure every field first, then change any tiles: measuring after a change
  // would make the phone redo the page layout once per field.
  // (Rows are measured, not the tiles inside them: a row off screen isn't laid
  // out at all, and measuring its tiles would force that.)
  const els = [...root.querySelectorAll('.fl[data-to]')];
  const box = new Map();
  const rects = els.map((el) => {
    const owner = el.closest('li') || el;
    if (!box.has(owner)) box.set(owner, owner.getBoundingClientRect());
    return box.get(owner);
  });
  els.forEach((el, n) => {
    const to = el.dataset.to, k = el.dataset.k;
    // A colour change (the track turning red for the final call) turns every
    // tile over once, even where the character stays the same.
    const recolour = flipLook.has(k) && flipLook.get(k) !== el.dataset.look;
    flipShown.set(k, to);
    flipLook.set(k, el.dataset.look);
    delete el.dataset.to;
    const r = rects[n];
    const onScreen = r.bottom > -40 && r.top < vh + 40;
    const jobs = [];
    el.querySelectorAll('.f').forEach((f, i) => {
      const from = f.querySelector('.t b').textContent, ch = to[i] || ' ';
      if (!onScreen) { if (from !== ch) f.querySelectorAll('b').forEach((b) => { b.textContent = ch; }); return; }
      if (from !== ch || (recolour && ch !== ' ')) jobs.push([f, from, ch]);
    });
    if (!jobs.length) return;
    const owner = el.closest('li, .mast, .clock') || el;
    if (!groups.has(owner)) groups.set(owner, []);
    groups.get(owner).push(...jobs);
  });
  for (const jobs of groups.values()) flipQueue.push(jobs);
  pumpFlips();
}
function pumpFlips() {
  while (flipRunning < FLIP_ROWS_AT_ONCE && flipQueue.length) {
    const jobs = flipQueue.shift();
    flipRunning++;
    const t0 = performance.now();
    Promise.all(jobs.map(([f, from, ch], i) => (from === ch ? turnTile(f, ch, ch, t0 + i * 40) : flipTile(f, from, ch, i * 40))))
      .finally(() => { flipRunning--; pumpFlips(); });
  }
}
// One animation loop moves every flap on the board, frame by frame, with
// flat (2D) folds. Nothing is handed to the graphics layers, so tiles
// starting and stopping never make the browser rebuild them (that was what
// made earlier versions stutter on phones).
const FLAP_MS = 150;
const flapsMoving = new Set();
let flapLoop = 0;
function flapFrame(now) {
  for (const m of flapsMoving) {
    const t = Math.min(1, (now - m.start) / FLAP_MS);
    if (t < 0) continue;
    // First half: the old top folds down to the hinge. Second: the new bottom unfolds from it.
    const fall = Math.min(1, t * 2), rise = Math.max(0, t * 2 - 1);
    m.ft.style.transform = `scaleY(${(1 - fall * fall).toFixed(3)})`;          // speeds up as it falls
    m.fb.style.transform = `scaleY(${(1 - (1 - rise) * (1 - rise)).toFixed(3)})`; // slows as it lands
    if (t >= 1) { flapsMoving.delete(m); m.done(); }
  }
  flapLoop = flapsMoving.size ? requestAnimationFrame(flapFrame) : 0;
}
function turnTile(f, from, to, at) {
  return new Promise((done) => {
    if (!f.isConnected) return done();
    const [up, low, ftb, fbb] = f.querySelectorAll('b');
    const ft = ftb.parentNode, fb = fbb.parentNode;
    ftb.textContent = from; fbb.textContent = to;
    up.textContent = to; // revealed behind the falling flap
    ft.style.transform = 'scaleY(1)'; fb.style.transform = 'scaleY(0)';
    ft.style.visibility = fb.style.visibility = 'visible';
    flapsMoving.add({ ft, fb, start: at ?? performance.now(), done: () => {
      low.textContent = to; ft.style.visibility = fb.style.visibility = 'hidden'; done();
    } });
    if (!flapLoop) flapLoop = requestAnimationFrame(flapFrame);
  });
}
// Each change turns the tile over a few times, stepping through letters on
// the way, flap after flap with no pause between.
async function flipTile(f, from, ch, delay) {
  const a = FLIP_CHARS.indexOf(from), b = FLIP_CHARS.indexOf(ch);
  const steps = [];
  if (a >= 0 && b >= 0) {
    const dist = (b - a + FLIP_CHARS.length) % FLIP_CHARS.length, n = Math.min(3, dist);
    for (let k = 1; k < n; k++) steps.push(FLIP_CHARS[(a + Math.round((k * dist) / n)) % FLIP_CHARS.length]);
  }
  steps.push(ch);
  let at = performance.now() + (delay || 0), prev = from;
  for (const c of steps) {
    if (!f.isConnected) return;
    await turnTile(f, prev, c, at);
    at += FLAP_MS; // the next flap starts exactly as this one lands
    prev = c;
  }
}
// Masthead and clock.
function renderMastFlip() {
  const h = document.querySelector('.mast h1');
  if (flipMode) {
    h.innerHTML = `<span class="mast-flip">${flipText('mast', 'Penn Station')}</span> <span class="h1-sub" id="h1-sub"></span>`;
    runFlips(h);
  } else {
    h.innerHTML = 'Penn Station <span class="h1-sub" id="h1-sub"></span>';
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
    return flaggedAt.get(r.id);
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
  return (r.departsByFeed ? left > 0 : true) && left <= (isDelayed(r) ? 120 : 60);
}

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
  if (kind === 'departures' && departedAt(r) !== null) return { status: 'Departed', tone: 'departed' };
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
  if (kind === 'departures' && ownStatus(r) && (r.tone === 'ok' || r.tone === 'late') && (r.leaves ?? r.time) < Date.now() / 1000 - 120) return { status: 'Delayed', tone: 'late' };
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
  const heldBy = shown.held ? pennSuspension(r.carrier) : null;
  const t = clock(r.time);
  const gone = r.tone === 'departed';
  // A late train counts down to when it is now expected to leave.
  const left = gone ? agoText(departedAt(r) ?? r.time) : countdown(r.tone === 'stop' ? r.time : (r.leaves ?? r.time));
  const due = !gone && left === 'gone' && r.departsByFeed; // late Amtrak, still expected
  // Under the status: how late (when the status itself doesn't say) and the
  // scheduled time, so a delayed train that is boarding still reads as delayed.
  const notes = [];
  if (heldBy) notes.push('service suspended at Penn');
  if (isDelayed(r) && !/late/i.test(r.status) && !gone && !heldBy) notes.push(`${r.lateMin} min late`);
  if (r.sched && Math.abs(r.sched - r.time) >= 120) notes.push(`scheduled ${clock(r.sched).hm}`);
  if (view === 'arrivals' && r.continuesTo) notes.push(`continues to ${esc(r.continuesTo)}, leaves ${clock(r.departsAt).hm}`);
  const sched = notes.length ? `<small>${notes.join(', ')}</small>` : '';
  const via = r.via && r.via.length ? viaHtml(r) : `<div class="meta">${esc(r.line)}, train ${esc(r.train)}${fareTag(r)}</div>`;
  return `<li class="row ${r.tone}${left === 'gone' && !gone && !due && !heldBy ? ' gone' : ''}">
    <div class="time"><b>${flipText(`${r.id}|t`, t.hm)}<small>${t.ap}</small></b><span>${due ? 'due' : r.tone === 'final' ? finalLeft(r) : left === 'gone' ? '' : left}</span></div>
    <div class="carrier"><span class="plate ${r.carrier}">${CARRIERS[r.carrier]}</span></div>
    <div class="dest"><div class="place">${flipText(`${r.id}|p`, r.place)}</div>${via}${njtLastHtml(r)}${rowAlertHtml(r)}</div>
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
    if (s.njt.error) return `NJ Transit data didn’t load: ${s.njt.error}. Trying again shortly.`;
  }
  if (carrier !== 'all' && s[carrier] && s[carrier].error) return `${CARRIERS[carrier]} data didn’t load: ${s[carrier].error}. Trying again shortly.`;
  return `No ${carrier === 'all' ? '' : CARRIERS[carrier] + ' '}${view} in the next few hours.`;
}

function renderRail() {
  if (!board || view === 'subway' || view === 'alerts') return;
  const rows = visibleRows(board[view], view).filter((r) => carrier === 'all' || r.carrier === carrier);
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
      subwayData = d; renderSubway(); renderServiceNotices();
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
// A line named in a sentence ("Use the 2."): its badge, at text size.
const lineName = (route) => bulletHtml(route, 'inl');
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
  return { day: p.weekday === 'Sat' ? 'saturday' : p.weekday === 'Sun' ? 'sunday' : 'weekday', mins: +p.hour * 60 + +p.minute };
};
function lateNightTrain(stationId, route, dir, epoch, code) {
  const w = subwayData && subwayData.night && ((subwayData.night[stationId] || {})[route] || {})[dir];
  if (!w) return false;
  const { day, mins: m } = nyDayAt(epoch);
  const sched = (d) => w[d === nyNow().day ? scheduleToday(d) : d];
  // Like PATH: go by which scheduled trip this train is (its id in the live
  // feed). A night train running late keeps its pill until it leaves Penn; a
  // day train never gets one. Morning: today's early trips, or last night's
  // trips listed past midnight (start 24:00+, id 144000 and up).
  if (code) {
    const T = sched(day), Y = sched(nyDayAt(epoch - 86400).day);
    const inT = !!(T && T.trips && T.trips.includes(code));
    if (m >= 12 * 60) return inT;
    return (inT && code < '144000') || !!(Y && Y.trips && Y.trips.includes(code) && code >= '144000');
  }
  if (m >= 12 * 60) { const T = sched(day); return !!T && T.from >= 12 * 60 && m >= T.from; }
  // After midnight: the night began the evening before (or just after midnight).
  const T = sched(day), Y = sched(nyDayAt(epoch - 86400).day);
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
  const { day, mins } = nyDayAt(t);
  const T = sw[day === nyNow().day ? scheduleToday(day) : day];
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
  const { day, mins } = nyDayAt(epoch);
  if (mins >= 12 * 60) {
    const g = ng[other][day === nyNow().day ? scheduleToday(day) : day];
    return !!g && g.after >= 12 * 60 && mins > g.after;
  }
  const g = ng[other][nyDayAt(epoch - 86400).day];
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
  return any ? any.svc : (['2', '3', 'A'].includes(line) ? 'express' : 'local');
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
  const way = bothWaysOff(stn.id, line) ? '' : (dir === 'N' ? 'uptown ' : 'downtown ');
  // The lines the advisory sends people to ("[2] makes [3] stops..."), at this station.
  const desc = String(s.n.desc || '');
  let alts = [...new Set([...desc.matchAll(/\[([A-Z0-9]{1,2})\]/g)].map((m) => m[1]))].filter((l) => l !== line && stn.lines.includes(l));
  if (!alts.length) alts = stn.lines.filter((l) => l !== line && here.some((x) => x.route === l && x.dir === dir));
  const altNames = alts.map((l) => lineName(l));
  // "…until 5:00 AM, use the 2." (owner: one sentence; the advisory's
  // details stay in the notice).
  const use = altNames.length ? `, use the ${altNames.slice(0, -1).join(', ')}${altNames.length > 1 ? ' or ' : ''}${altNames[altNames.length - 1]}.` : '.';
  const until = `until ${clockText(s.end)}`;
  // The last train before it starts (a late one still counts).
  const last = here.filter((x) => x.route === line && x.dir === dir).flatMap((x) => x.trains)
    .map((t) => t.time).filter((t) => t >= nowS - 30 && t <= s.start + 10 * 60).sort((a, b) => b - a)[0];
  if (last) return `<p class="svc-line night">${ICON.moon}<span><b>The last ${way}${label} train leaves at ${clockText(last)}, ${inText(last, nowS)}.</b> Then no ${way}${label} trains ${until}${use}</span></p>`;
  if (nowS < s.start) return `<p class="svc-line night">${ICON.moon}<span><b>No ${way}${label} trains from ${clockText(s.start)} ${until}</b>${use}</span></p>`;
  return `<div class="none-row">${bulletHtml(line)}<span>No ${way}${label} trains ${until}${use}</span></div>`;
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
    const day = off === 0 ? scheduleToday(nyNow().day) : nyNow(off).day;
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
const SUB_LATE_PILL = `<a class="late-pill" href="${MTA_NIGHT_MAP}" target="_blank" rel="noopener" title="MTA late-night subway map (opens in a new tab)">${ICON.moon}Late night<span class="ext" aria-hidden="true">↗</span><span class="sr">, MTA late-night map, opens in a new tab</span></a>`;
// Trouble on a line (delays, skipped stops, reroutes): a pill on its rows.
// The notice itself, its map and other options are in the service notices.
const WARN_IC = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5 1.5 21h21zM11 9h2v6h-2zm0 8h2v2h-2z" fill="currentColor" fill-rule="evenodd"/></svg>';
const warnPill = (txt) => `<span class="late-pill warn-pill">${WARN_IC}${txt}</span>`;
const pills = (...ps) => { const h = ps.filter(Boolean).join(''); return h ? `<span class="pills">${h}</span>` : ''; };
// The "Delays" pill comes off a train that is running on time (within
// ON_TIME_S of its scheduled time at Penn); a train we can't match to the
// timetable keeps it.
const ON_TIME_S = 180;
const subwayPills = (route, dir, svc, stnId, train) => (subwayDelays(route, dir).length && !subwayOnTime(stnId, route, dir, train) ? warnPill('Delays') : '')
  + (svc === 'local' && subwayExpressSwitch(route, dir).length ? warnPill('Some trains skip stops') : '');

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
  const now = nyNow(), T = pathDay(now.day);
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
    const N = pathDay(nyNow(1).day);
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
  const { day, mins } = nyDayAt(epoch);
  const W = pathNightWindow(day, pathLine(dest));
  // The scheduled departure this train is (closest within 8 min), else its own time.
  const near = W.times.reduce((best, t) => (Math.abs(t - mins) < Math.abs(best - mins) ? t : best), Infinity);
  const m = Math.abs(near - mins) <= 8 ? near : mins;
  if (m < 12 * 60 && m < W.to) {
    const Y = pathNightWindow(nyDayAt(epoch - 86400).day, pathLine(dest));
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
  if (day === 'saturday' || day === 'sunday') tags.push(`<span class="tag wknd">${ICON.cal}Weekend service</span>`);
  if (st && st.phase === 'night') tags.push(`<span class="tag night">${ICON.moon}Late-night service</span>`);
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
function destName(key, name) {
  const before = destShown.get(key);
  destShown.set(key, name);
  if (before === undefined || before === name) return `<span class="dname">${esc(name)}</span>`;
  slideStarted = performance.now();
  return `<span class="dname changing"><span class="out" aria-hidden="true">${esc(before)}</span><span class="in">${esc(name)}</span></span>`;
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
  const lastOf = (x) => x.stops[x.stops.length - 1];
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
      const p = lateNightTrain(stn.id, g.route, dir, mine[0].time, mine[0].code) || localNight(stn.id, g, dir, mine[0].time) || cutbackNight(stn.id, g.route, dir, mine[0].time) ? SUB_LATE_PILL : '';
      return `<span class="b-row"><span>${esc(name(e))}${pills(p, subwayPills(g.route, dir, g.svc, stn.id, mine[0]))}</span><span class="smins">${first}${ts.length > 1 ? `, ${ts.slice(1).join(', ')}` : ''}</span></span>`;
    }).join('')}</span>`;
  }
  const before = bShown.get(key);
  bShown.set(key, html);
  const body = `<span class="b-wrap">${html}</span>`;
  return `<div class="sline optb">${bulletHtml(g.route)}${body}</div>`;
}
$('subway').addEventListener('click', (e) => {
  const b = e.target.closest('[data-sstyle]');
  if (!b) return;
  subwayStyle = b.dataset.sstyle;
  try { localStorage.setItem('subwayStyle', subwayStyle); } catch {}
  bShown.clear(); slideStarted = -Infinity; renderSubway();
});
const subwayStyleHtml = () => `<div class="sub-style"><span>Rows with more than one destination</span><div class="style-seg">
  <button type="button" data-sstyle="turns" aria-pressed="${subwayStyle === 'turns'}">Take turns</button><button type="button" data-sstyle="b" aria-pressed="${subwayStyle === 'b'}">All destinations</button></div></div>`;

let subwayShown = [];      // the groups drawn, so a tap can find its train
const DIRS = { '128': { N: 'Uptown and the Bronx', S: 'Downtown and Brooklyn' }, A28: { N: 'Uptown and Queens', S: 'Downtown and Brooklyn' } };
// The panel is redrawn often (new data, the 10 s tick, each turn). Redrawing
// while a destination is sliding would cut the slide short and make it jump,
// so a redraw that comes mid-slide waits until the slide has finished.
const SLIDE_MS = 1000; // .dname slide: .75 s out, .8 s in after .15 s
let slideStarted = -Infinity, slideWait = 0;
function renderSubway() {
  if (!board) return;
  const busy = SLIDE_MS - (performance.now() - slideStarted);
  if (busy > 0) {
    if (!slideWait) slideWait = setTimeout(() => { slideWait = 0; renderSubway(); }, busy + 20);
    return;
  }
  loadSubwayData();
  loadSubwayTimes();
  if (!board.subway.length) {
    $('subway').innerHTML = `<p class="empty">${board.sources.subway.error ? 'Subway times didn’t load. Trying again shortly.' : 'No subway trains reported right now.'}</p>`;
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
  const STATIONS = [{ id: '128', lines: ['1', '2', '3'] }, { id: 'A28', lines: ['A', 'C', 'E'] }];
  const states = [];
  $('subway').innerHTML = STATIONS.map((stn) => {
  const here = mergeScheduled(board.subway.filter((g) => (g.trains[0] && g.trains[0].stops ? g.trains[0].stops[0] : '') === stn.id));
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
    const parts = ['express', 'local'].map((svc) => {
    let notes = '';
    // A line that isn't running late at night says which train to take.
    const gaps = stn.lines.map((line) => {
      // A notice suspending the line here (the overnight 3): count down to its
      // last train, then point to the line the advisory names.
      const sus = suspensionNote(stn, here, line, dir, svc, nowS);
      if (sus !== null) return sus;
      let g = nightGapState(stn.id, line, dir);
      // The first morning train showing "now" at Penn ends "Daytime service has started".
      if (g && g.phase === 'morning' && here.some((x) => x.route === line && x.dir === dir && x.trains.some((t) => t.time - nowS < 30))) {
        morningReached.add(g.key);
        g = nightGapState(stn.id, line, dir);
      }
      if (g && g.phase === 'morning' && g.svc === svc) return `<p class="svc-line">${ICON.sun}<span><b>Daytime service has started on the ${lineName(line)}.</b></span></p>`;
      // "The last C train leaves at 10:34 PM, in 25 min." / "The last downtown 3 train..."
      // The last train running late: keep counting down until it has left.
      const lateLast = g && g.phase === 'night' && g.svc === svc
        ? liveLastOnly(here, line, dir, null, minsToEpoch(g.after - (nyNow().mins < 720 ? 1440 : 0)), nowS) : null;
      if (g && ((g.phase === 'countdown' && g.svc === svc) || lateLast)) {
        const way = bothWaysOff(stn.id, line) ? '' : (dir === 'N' ? 'uptown ' : 'downtown ');
        const t = lateLast ?? liveLast(here, line, dir, null, minsToEpoch(g.after), nowS);
        return `<p class="svc-line night">${ICON.moon}<span><b>The last ${way}${lineName(line)} train leaves at ${clockText(t)}, ${inText(t, nowS)}.</b> No ${way}${lineName(line)} trains late nights.</span></p>`;
      }
      if (g && g.phase === 'countdown') return '';
      if (!g || g.svc !== svc || here.some((x) => x.route === line && x.dir === dir && x.trains.some((t) => t.time >= nowS - 30))) return '';
      // The other lines at this station still running this way (C: A or E; 3: 1 or 2).
      const off = (l, d) => { const x = nightGapState(stn.id, l, d); return !!x && x.phase !== 'countdown'; };
      const alts = stn.lines.filter((l) => l !== line && !off(l, dir)).map((l) => lineName(l));
      const altText = alts.length ? `the ${alts.slice(0, -1).join(', ')}${alts.length > 1 ? ' or ' : ''}${alts[alts.length - 1]}` : '';
      const way = dir === 'N' ? 'uptown' : 'downtown';
      const label = lineName(line);
      // Short: "No C trains until 5:41 AM, use the A or E." A line not running
      // either way gets no direction; when only one direction stops (the 3
      // ends at Penn), say which.
      const oneWay = !bothWaysOff(stn.id, line);
      const say = oneWay
        ? `No ${label} trains ${way} until ${fmtClock(g.until)}${altText ? `, use ${altText}` : ''}.`
        : `No ${label} trains until ${fmtClock(g.until)}${altText ? `, use ${altText}` : ''}.`;
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
    notes = mergeNightBanners(notes);
    // Express trains skipping local stops, with no local trains of that line listed.
    if (svc === 'local') for (const line of stn.lines) {
      if (!here.some((g) => g.route === line && g.dir === dir && g.svc === 'local')) notes += switchNoteHtml(line, dir);
    }
    const lines = here.filter((g) => g.dir === dir && (g.svc || 'local') === svc).map((g) => {
      let upcoming = g.trains.filter((x) => x.time >= nowS - 30);
      // A shared row with trains to more than one end of the line (the A
      // downtown) takes turns: each end's own next trains for a few seconds,
      // soonest first, sliding from one to the next.
      const lastOf = (x) => x.stops && x.stops[x.stops.length - 1];
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
      const pill = lateNightTrain(stn.id, g.route, dir, trains[0].time, trains[0].code) || localNight(stn.id, g, dir, trains[0].time) || cutbackNight(stn.id, g.route, dir, trains[0].time) ? SUB_LATE_PILL : '';
      const mins = trains.map((x) => Math.max(0, Math.round((x.time - nowS) / 60)));
      const first = trains[0];
      const last = first.stops && first.stops[first.stops.length - 1];
      const dest = stationName(last) || first.dest || (dir === 'N' ? 'Uptown' : 'Downtown');
      const rowKey = `${stn.id}|${g.route}|${dir}|${g.svc}|${g.scheduled ? 'sched' : last}`;
      const turned = destShown.has(rowKey) && destShown.get(rowKey) !== dest;
      const destHtml = destName(rowKey, dest);
      // The times slide over with the name when the row turns to another end.
      const minsHtml = (html) => (turned ? `<span class="dname changing"><span class="out" aria-hidden="true">${minsShown.get(rowKey) || ''}</span><span class="in">${html}</span></span>` : html);
      const firstMin = mins[0] === 0 ? '<b class="now">now</b>' : `<b>${mins[0]}</b> min`;
      const rest = mins.slice(1).length ? `, ${mins.slice(1).join(', ')}` : '';
      minsShown.set(rowKey, firstMin + rest);
      const rerouted = trains.find((x) => unusualStops(g.route, x).length);
      // Delays and skipped stops: pills on the row (the notice, its map and
      // other options are in the service notices).
      const linePills = subwayPills(g.route, dir, svc, stn.id, trains[0]);
      if (!rerouted || changeFor(g.route)) {
        return `<div class="sline">${bulletHtml(g.route)}<span class="sdest">${destHtml}${pills(pill, linePills, rerouted ? warnPill('Rerouted') : '')}</span><span class="smins">${minsHtml(firstMin + rest)}</span></div>`;
      }
      // Rerouted with no notice behind it: the row itself opens the map.
      const i = subwayShown.push({ route: g.route, dir, svc: g.svc, train: rerouted }) - 1;
      return `<button type="button" class="sline rerouted" data-reroute="${i}" aria-haspopup="dialog">${bulletHtml(g.route)}<span class="sdest">${destHtml}${pills(pill && LATE_PILL, linePills)}<span class="reroute-tag">Rerouted, see map</span></span><span class="smins">${minsHtml(firstMin + rest)}</span></button>`;
    }).join('');
      return lines || notes ? `<div class="svc"><h4>${SVC[svc]}</h4>${notes}${lines}</div>` : '';
    }).join('');
    return parts ? `<div class="dir"><h3>${DIRS[stn.id][dir]}</h3>${parts}</div>` : '';
  }).join('');
  const label = stn.lines.map((l) => bulletHtml(l, 'small')).join('');
  return `<section class="stn" aria-label="${stn.lines.join(', ')} trains"><div class="stn-lines">${label}</div>${dirs || '<p class="empty">No trains reported right now.</p>'}</section>`;
  }).join('') + subwayStyleHtml();
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

// Where a rerouted line runs instead, read from the notice: "[C] runs via the
// [F] from Jay St-MetroTech to 34 St-Herald Sq and via the [D] to 59 St-
// Columbus Circle." -> [{ line: 'F', from, to }, { line: 'D', from, to }]. Only
// the first sentence of each kind is used (the other direction is the same
// route in reverse).
function readVia(desc, route) {
  const sentence = String(desc || '').split('\n').find((x) => new RegExp(`\\[${route}\\][^.]*runs via the \\[`).test(x));
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
function changeModel(n) {
  if (!n || n.carrier !== 'subway' || !subwayData || !CHANGE_TYPES.test(n.type)) return null;
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
  return { n, route, closed, whole, alt: readAlternatives(n.desc, route), via: readVia(n.desc, route) };
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
        <li><span class="sw off"></span>No ${label} trains</li>
        ${alt.buses.length ? '<li><span class="sw bus"></span>Free shuttle bus</li>' : ''}
        ${model.via && model.via.length ? `<li>${bulletHtml(route, 'tiny')} on its temporary route, via the ${[...new Set(model.via.map((v) => v.line))].map((l) => bulletHtml(l, 'tiny')).join(' and ')}</li>` : ''}
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
    if (subwayData.routes[route].normal.some((id) => id === '128' || id === 'A28') && area.pad(0.4).contains(PENN_LL)) area.extend(PENN_LL);
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
  const dot = (id, off, small) => dots.push([small, L.circleMarker(LL(id), { radius: 3, weight: small ? 1.5 : 2, color: off ? '#8f8f8f' : '#1b1b1b', fillColor: '#fff', fillOpacity: 1, interactive: false }).addTo(map)]);
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
function drawPathMap(map, { state = {}, marks = {}, flagged = [], fit = null }) {
  // (The map needs its view before anything is drawn on it.)
  const b = L.latLngBounds([PENN_LL, ...(fit || Object.keys(PATH_STATIONS)).map(PP)]);
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
    if (s === 'delay' || s === 'off') { const mid = ln.stops[Math.floor(ln.stops.length / 2)]; labels.push({ at: PP(mid), must: true, cls: 'off', html: `${esc(ln.name)}<small style="color:#ffd9d3">${s === 'off' ? 'No trains' : 'Delays'}</small>`, w: textWidth(ln.name), h: 36 }); }
  }
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
const PATH_NAMES = [['33S', /\b33(rd)? St/i], ['23S', /\b23(rd)? St/i], ['14S', /\b14(th)? St/i], ['09S', /\b9(th)? St/i], ['CHR', /Christopher/i],
  ['HOB', /Hoboken/i], ['NEW', /Newport/i], ['EXP', /Exchange P/i], ['GRV', /Grove/i], ['JSQ', /Journal Sq/i], ['HAR', /Harrison/i], ['NWK', /Newark/i], ['WTC', /World Trade|\bWTC\b/i]];
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
  const first = text.replace(PATH_PAIR, ' ').split(/\.\s/)[0];
  const issue = /elevator|escalator/i.test(first) ? 'Elevator out of service' : /closed|bypass|skip/i.test(first) ? 'Closed or skipped' : '';
  const flagged = issue ? PATH_NAMES.filter(([, re]) => re.test(first)).map(([c]) => c) : [];
  if (!Object.keys(state).length && !flagged.length) return null;
  return { n, state, flagged, issue };
}
// A pill for PATH trains from 33 St on a line an open PATH alert says is
// delayed or suspended (Journal Square via Hoboken uses both 33 St lines).
// A train leaving within 2 min of a scheduled departure to the same place
// is running on time.
function pathOnTime(dest, epoch) {
  if (!pathSchedule || !epoch) return false;
  for (const off of [-1, 0, 1]) {
    const day = off === 0 ? scheduleToday(nyNow().day) : nyNow(off).day;
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
  // (Live times only: an on-time train loses its "Delays" pill.)
  return worst === 'off' ? warnPill('Suspended') : worst === 'delay' && !pathOnTime(dest, epoch) ? warnPill('Delays') : '';
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
    drawPathMap(map, { state, marks, flagged });
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
      'Walk to PATH’s 33 St station, at Sixth Av and 32 St (about 5 minutes).',
      'Take a Journal Square train. Late nights and weekends it runs via Hoboken.',
      'At Journal Square, change to a Newark train. Newark Penn Station is two stops on, after Harrison.',
      'Or: take the downtown E to World Trade Center and PATH’s Newark train from there, no change.',
    ],
  },
  hoboken: {
    title: 'To Hoboken Terminal by PATH', dest: 'HOB', live: /hoboken/i, liveLabel: 'Trains to Hoboken from 33 St',
    state: { 'HOB-33': 'focus', 'JSQ-33': 'faint', 'NWK-WTC': 'faint', 'HOB-WTC': 'faint' },
    marks: { '33S': 'Board a Hoboken train', HOB: 'NJ Transit trains here' },
    steps: [
      'Walk to PATH’s 33 St station, at Sixth Av and 32 St (about 5 minutes).',
      'Take a Hoboken train, direct. When it isn’t running (late nights and weekends), take the Journal Square via Hoboken train.',
      'Hoboken is the last stop. NJ Transit trains leave from the same terminal.',
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
  $('chg-top').innerHTML = `<ol class="cm-steps">${g.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
    ${next.length ? `<p class="cm-sum"><b>${esc(g.liveLabel)}:</b> ${next.join(', ')}</p>` : ''}
    <button type="button" class="cm-back" data-guide="${other}">${other === 'hoboken' ? 'To Hoboken instead' : 'To Newark Penn instead'} →</button>`;
  const d = directionsTo(PP(g.dest), key === 'newark' ? 'Newark Penn Station' : 'Hoboken Terminal');
  const njtNotes = ((board && board.notices && board.notices.rail) || []).filter((n) => n.carrier === 'njt');
  $('chg-below').innerHTML = `<p class="cm-live">PATH charges its own fare. During major disruptions NJ Transit sometimes accepts its tickets on PATH (cross-honoring); check NJ Transit’s notices before you go.</p>
    <p class="cm-live">Directions: <a href="${esc(d.google)}" target="_blank" rel="noopener">Google Maps</a> · <a href="${esc(d.apple)}" target="_blank" rel="noopener">Apple Maps</a></p>
    ${njtNotes.length ? `<h3 class="cm-h">From NJ Transit</h3><div class="cm-mta">${njtNotes.map((n) => `<p>${noticeText(n.text)}</p>`).join('')}</div>` : ''}`;
  openSheet();
  try { drawPathMap(await freshMap(), { state: g.state, marks: g.marks, fit: ['33S', g.dest, 'JSQ'] }); } catch (e) { console.warn('guide map:', e); $('chg-map').hidden = true; }
}
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
const njtAltHtml = () => (njtDisrupted() ? `<div class="njt-alt"><p><b>NJ Transit trains from Penn are delayed or cancelled.</b> Other ways to New Jersey:</p>
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
function rowNotices(r) {
  const all = (board && board.notices && board.notices.rail) || [];
  if (r.carrier === 'lirr' && lirrData) {
    const id = lirrRouteFor(r.line);
    return id ? all.filter((n) => n.carrier === 'lirr' && isDelayNotice(n) && (n.lines || []).includes(id)) : [];
  }
  if (r.carrier === 'njt') {
    return all.filter((n) => {
      if (n.carrier !== 'njt' || !isDelayNotice(n)) return false;
      const nums = [...String(n.text).matchAll(/#\s?(\d{3,5})/g)].map((m) => m[1]);
      if (nums.length) return nums.includes(String(r.train));
      return NJT_LINE_WORDS.some(([inText, inLine]) => inText.test(n.text) && inLine.test(r.line || ''));
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
    for (const list of byLine.values()) for (const o of lastBeforeBreak(list)) map.set(o.id, { ...(map.get(o.id) || {}), line: true, until: o.until });
    for (const o of lastBeforeBreak(deps)) map.set(o.id, { ...(map.get(o.id) || {}), all: true, allUntil: o.until });
    njtLast = map;
    renderRail();
  } catch (e) { console.warn('NJ Transit day schedule:', e); }
}
loadNjtLast(); setInterval(loadNjtLast, 30 * 60 * 1000);
function njtLastHtml(r) {
  if (r.carrier !== 'njt' || view !== 'departures' || r.tone === 'departed' || r.tone === 'stop') return '';
  const x = njtLast.get(String(r.train));
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
  if (range) return `Delays of ${range[1]}–${range[2]} min`;
  if (mins.length && /delay|late/i.test(all)) return `Delays up to ${Math.max(...mins)} min`;
  return /delay|late/i.test(all) ? 'Delays' : 'Service alert';
}
function rowAlertHtml(r) {
  if (view !== 'departures' || r.tone === 'departed') return '';
  let ns = rowNotices(r);
  // The same notice sent twice, short and long: keep the long one.
  ns = ns.filter((n) => !ns.some((m) => m !== n && normNotice(m.text).length > normNotice(n.text).length && normNotice(m.text).startsWith(normNotice(n.text))));
  if (!ns.length) return '';
  const key = `${r.id}|${ns.map((n) => n.id).join(',')}`;
  return `<details class="row-alert" data-key="${esc(key)}"${openRowAlerts.has(key) ? ' open' : ''}><summary>⚠ ${esc(rowAlertSummary(ns))}${ns.length > 1 ? ` <span class="ra-n">${ns.length} notices</span>` : ''}</summary>${ns.map((n) => `<p>${noticeText(n.text)}</p>`).join('')}<button type="button" class="al-map" data-options="${esc(r.id)}">Other options</button></details>`;
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
const DOWN_WORDS = /\b(downtown|southbound|brooklyn-bound)\b/i, UP_WORDS = /\b(uptown|northbound|bronx-bound|queens-bound|manhattan-bound)\b/i;
const dirMatch = (n, dir) => {
  const first = String(n.text).split(/\.\s/)[0];
  const down = DOWN_WORDS.test(first), up = UP_WORDS.test(first);
  if (!dir || down === up) return true;
  return dir === 'S' ? down : up;
};
const isSwitchNotice = (n) => happeningNow(n) && /\b(running|runs|run|operating|operates)\s+express\b|\bexpress (between|from|to|in)\b|local to express/i.test(`${n.type} ${n.text}`);
const subwayExpressSwitch = (route, dir) => ((board && board.notices && board.notices.subway) || []).filter((n) => isSwitchNotice(n) && (n.lines || []).includes(route) && dirMatch(n, dir));
// (Only used when the line has no local row to carry the pill.)
const switchNoteHtml = (route, dir) => (subwayExpressSwitch(route, dir).length
  ? `<div class="none-row">${bulletHtml(route)}<span>Some ${lineName(route)} trains are running express and skip local stops. Other options are in the service notices.</span></div>` : '');

// The options sheet: other ways to where the delayed train goes.
// Stations every train shares (Penn itself, the hubs on the way out): not a reason to switch.
const SHARED_SKIP = /^(new york penn station|penn station|jamaica|woodside|forest hills|kew gardens|secaucus.*|newark penn station)$/i;
const normName2 = (s) => String(s || '').toLowerCase().replace(/-sec\b|✈|&#9992;?/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
function openOptions(r) {
  changeOpen = { id: 'options', view: 1 };
  $('chg-map').hidden = true;
  const nowS = Date.now() / 1000;
  const ns = rowNotices(r);
  $('chg-kind').textContent = 'Other options';
  $('chg-h').innerHTML = `${esc(r.line)} to ${esc(r.place)}`;
  $('chg-top').innerHTML = ns.map((n) => `<p class="cm-sum">⚠ ${noticeText(n.text)}</p>`).join('');
  const mine = new Set([...(r.via || []), r.place].map(normName2));
  const going = board.departures.filter((x) => x.carrier === r.carrier && x.id !== r.id && x.tone !== 'stop' && x.tone !== 'departed' && (x.leaves ?? x.time) > nowS && x.time < nowS + 3 * 3600 && rowNotices(x).length === 0);
  // Other trains from Penn (not affected by the notice) calling at stations
  // this train serves, by line: the next one and the stations they share.
  const byLine = new Map();
  for (const x of going) {
    const shared = [...(x.via || []), x.place].filter((s) => mine.has(normName2(s)) && !SHARED_SKIP.test(normName2(s)));
    if (!shared.length || x.line === r.line && r.carrier === 'lirr') continue;
    const k = x.line;
    if (!byLine.has(k)) byLine.set(k, { line: k, next: x, shared: new Set() });
    shared.forEach((s) => byLine.get(k).shared.add(s));
  }
  // LIRR: branches that serve these stations by the timetable, for when no
  // such train is on the board yet (later trains, other times of day).
  let timetable = '';
  if (r.carrier === 'lirr' && lirrData) {
    const listed = new Set([...byLine.keys(), r.line]);
    const rows2 = Object.entries(lirrData.routes).filter(([k, x]) => k !== '12' && !listed.has(x.name)).map(([, x]) => {
      const names = x.stops.map((id) => lirrData.stops[id] && lirrData.stops[id][0]).filter((nm) => nm && mine.has(normName2(nm)) && !SHARED_SKIP.test(normName2(nm)));
      return { x, names };
    }).filter((o) => o.names.length).sort((a, b) => b.names.length - a.names.length).slice(0, 4);
    if (rows2.length) timetable = `<h3 class="cm-h">Branches that also serve these stations</h3><ul class="cm-stns">${rows2.map((o) => `<li class="cm-stn"><div class="opt-h">${lirrChip(o.x)}<span>check the board for times</span></div><span class="cm-dir">Stops at ${esc(o.names.slice(0, 6).join(', '))}${o.names.length > 6 ? ` and ${o.names.length - 6} more` : ''}</span></li>`).join('')}</ul>`;
  }
  const items = [...byLine.values()].sort((a, b) => b.shared.size - a.shared.size).slice(0, 6).map((o) => {
    const t = clock(o.next.leaves ?? o.next.time);
    const s = [...o.shared];
    return `<li class="cm-stn"><div class="opt-h"><b>${esc(o.line)}</b><span>next ${t.hm} ${t.ap}${o.next.track ? `, track ${esc(o.next.track)}` : ''} to ${esc(o.next.place)}</span></div>
      <span class="cm-dir">Also stops at ${esc(s.slice(0, 6).join(', '))}${s.length > 6 ? ` and ${s.length - 6} more` : ''}</span></li>`;
  }).join('');
  $('chg-below').innerHTML = `${items ? `<h3 class="cm-h">Other trains from Penn to the same stations</h3><ul class="cm-stns">${items}</ul>` : '<p class="cm-live">No other train on the board right now stops at the same stations.</p>'}
    ${timetable}
    ${r.carrier === 'njt' ? '<h3 class="cm-h">Or by PATH</h3><p class="lchips"><button type="button" class="cm-back" data-guide="newark">To Newark Penn by PATH</button> <button type="button" class="cm-back" data-guide="hoboken">To Hoboken by PATH</button></p>' : ''}
    <p class="cm-live">Times and tracks from the live board. Fares and tickets differ by line; check before you board.</p>`;
  openSheet();
}
// Subway delay options: other lines at the same Penn station going the same
// way that share stations with the delayed one.
function openSubwayOptions(route, dir, stnId, mode) {
  changeOpen = { id: 'options', view: 1 };
  $('chg-map').hidden = true;
  $('chg-kind').textContent = 'Other options';
  $('chg-h').innerHTML = `${bulletHtml(route, 'tiny')} ${dir === 'N' ? 'uptown' : 'downtown'} from Penn`;
  $('chg-top').innerHTML = (mode === 'local' ? subwayExpressSwitch(route, dir) : subwayDelays(route, dir)).map((n) => `<p class="cm-sum">⚠ ${noticeText(n.text)}</p>`).join('');
  $('chg-below').innerHTML = subwayOptionsHtml(route, dir, stnId, mode);
  openSheet();
}
// The Penn station each subway line stops at.
const PENN_SUBWAY = { 1: '128', 2: '128', 3: '128', A: 'A28', C: 'A28', E: 'A28' };
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
  $('chg-h').innerHTML = `${lines.map((l) => bulletHtml(l, 'tiny')).join('')} from Penn`;
  $('chg-top').innerHTML = `<p class="cm-sum">⚠ ${noticeText(n.text)}</p>`;
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
  const items = [...best.values()].sort((a, b) => b.shared - a.shared).map((o) => `<li class="cm-stn"><div class="opt-h">${bulletHtml(o.route, 'tiny')}<span>${o.svc === 'express' ? 'Express' : 'Local'}, next in ${Math.max(0, Math.round((o.t.time - nowS) / 60))} min${subwayDelays(o.route, dir).length ? ' (also delayed)' : ''}</span></div><span class="cm-dir">Shares ${o.shared} stations with the ${lineName(route)}</span></li>`).join('');
  if (!items) return '<p class="cm-live">No other line from this station shares its stops.</p>';
  return `${bare ? '' : `<h3 class="cm-h">${mode === 'local' ? 'Other trains making local stops' : 'Other trains from this platform'}</h3>`}<ul class="cm-stns">${items}</ul>`;
}
document.addEventListener('click', (e) => {
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
// A "Rerouted, see map" row opens the notice behind it when there is one.
const changeFor = (route) => changeModels().find((m) => m.route === route && happeningNow(m.n));

function renderPath() {
  if (!board) return;
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
    const pill = pathLateNight(dest, nowS + (mins[0] || 0) * 60) ? LATE_PILL : '';
    return `<div class="sline"><span class="pdots" aria-hidden="true">${dots}</span><span class="sdest">${esc(dest)}${pills(pill, pathTrouble(dest, g.first))}</span><span class="smins">${firstMin}${rest}</span></div>`;
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
    const pill = pathLateNight(dest, Date.now() / 1000 + (((g.times[0] - nyNow().mins) % 1440) + 1440) % 1440 * 60) ? LATE_PILL : '';
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
  // Starts collapsed (owner's choice); opening it is remembered for this visit
  // until the set of notices changes.
  let opened = false;
  try { opened = sessionStorage.getItem('opened-' + where) === sig; } catch {}
  const urgent = list.some((n) => n.urgent);
  const label = where === 'subway' ? 'Subway service notices' : where === 'path' ? 'PATH alerts' : 'Service notices for trains at Penn';
  // Notices that close or reroute part of a line open a map.
  const mapBtn = (n) => (typeof changeModel === 'function' && (changeModel(n) || lirrModel(n) || pathModel(n)) ? ` <button type="button" class="al-map" data-change="${esc(n.id)}">See map</button>` : '');
  const items = list.map((n) => `<div class="al-item${n.urgent ? ' urgent' : ''}"><span class="who">${noticeWho(n)}</span><p style="margin:0"><span class="kind">${esc(friendlyType(n.type))}</span>${noticeText(n.text)}${mapBtn(n)}${optionsBtn(n)}</p></div>`).join('');
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
  $('njt-alt').innerHTML = njtAltHtml();
  renderAlertsTab();
}
// Phones: every notice on its own tab, by where it applies, with a count on
// the tab. (Computers keep the strips above the trains and in the subway panel.)
function renderAlertsTab() {
  const rail = board.notices.rail || [], subway = board.notices.subway || [];
  const card = (n) => {
    const map = typeof changeModel === 'function' && (changeModel(n) || lirrModel(n) || pathModel(n)) ? `<button type="button" class="al-map" data-change="${esc(n.id)}">See map</button>` : '';
    const opts = optionsBtn(n);
    return `<div class="al-card${n.urgent ? ' urgent' : ''}"><span class="who">${noticeWho(n)}</span><p><span class="kind">${esc(friendlyType(n.type))}</span>${noticeText(n.text)}${map || opts ? `<br>${map}${opts}` : ''}</p></div>`;
  };
  const group = (title, list, none) => `<h2 class="al-h">${title}</h2>${list.length ? list.map(card).join('') : `<p class="al-none">${none}</p>`}`;
  $('alerts').innerHTML = njtAltHtml() + group('Trains at Penn', rail, 'No notices for LIRR, NJ Transit or Amtrak right now.')
    + group('Subway', subway, 'No subway notices for the lines at Penn right now.')
    + group('PATH', board.notices.path || [], 'No PATH alerts right now.');
  const n = rail.length + subway.length + (board.notices.path || []).length;
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
  const [path, pa] = window.PENN_RELAY ? await Promise.all([PennFeeds.relayPath(force), PennFeeds.relayPathAlerts(force)]) : [null, null];
  return PennFeeds.board({ force, path: path || undefined, pathAlerts: pa && pa.data ? pa.data : [] });
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
const HEADINGS = { departures: 'departures', arrivals: 'arrivals', subway: 'subway and PATH', alerts: 'service alerts' };
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
  if (e.matches && (view === 'subway' || view === 'alerts')) document.querySelector('.seg button[data-view="departures"]').click();
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
// Tapping "Penn Station" reloads the page (fresh data and the newest version).
const mastTitle = document.querySelector('.mast h1');
mastTitle.setAttribute('role', 'button');
mastTitle.tabIndex = 0;
mastTitle.title = 'Reload the board';
mastTitle.addEventListener('click', () => location.reload());
mastTitle.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); location.reload(); } });
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
