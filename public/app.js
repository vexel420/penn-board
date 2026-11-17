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

function trackCell(r) {
  if (r.track) {
    const fresh = seenTracks.has(r.id) && seenTracks.get(r.id) !== r.track;
    return `<div class="track${fresh ? ' flip' : ''}" aria-label="Track ${esc(r.track)}"><b>${esc(r.track)}</b></div>`;
  }
  if (r.trackLikely) return `<div class="track likely" aria-label="Track not posted, usually ${esc(r.trackLikely)}"><b>${esc(r.trackLikely)}</b><small>usual</small></div>`;
  return '<div class="track none" aria-label="Track not posted"><b>–</b></div>';
}

function rowHtml(r) {
  const t = clock(r.time);
  const left = countdown(r.time);
  const sched = r.sched && Math.abs(r.sched - r.time) >= 120 ? `<small>scheduled ${clock(r.sched).hm}</small>` : '';
  const via = r.via && r.via.length
    ? `<details class="via" data-id="${esc(r.id)}"${openRows.has(r.id) ? ' open' : ''}><summary>${esc(r.line)}, train ${esc(r.train)}, <u>${r.via.length} stops</u></summary><p>${r.via.map(esc).join(', ')}</p></details>`
    : `<div class="meta">${esc(r.line)}, train ${esc(r.train)}</div>`;
  return `<li class="row ${r.tone}${left === 'gone' ? ' gone' : ''}">
    <div class="time"><b>${t.hm}<small>${t.ap}</small></b><span>${left === 'gone' ? '' : left}</span></div>
    <div class="carrier"><span class="plate ${r.carrier}">${CARRIERS[r.carrier]}</span></div>
    <div class="dest"><div class="place">${esc(r.place)}</div>${via}</div>
    <div class="status ${r.tone}">${esc(r.status)}${sched}</div>
    ${trackCell(r)}
  </li>`;
}

function emptyMessage() {
  const s = board.sources;
  if (carrier === 'njt') {
    if (view === 'arrivals') return 'NJ Transit publishes departures only, so its arriving trains can’t be listed here.';
    if (s.njt.needsLogin) return 'NJ Transit trains appear once the site has an NJ Transit developer login. See the note above.';
    if (s.njt.error) return `NJ Transit data didn’t load: ${s.njt.error}. Trying again shortly.`;
  }
  if (carrier !== 'all' && s[carrier] && s[carrier].error) return `${CARRIERS[carrier]} data didn’t load: ${s[carrier].error}. Trying again shortly.`;
  return `No ${carrier === 'all' ? '' : CARRIERS[carrier] + ' '}${view} in the next few hours.`;
}

function renderRail() {
  if (!board || view === 'subway') return;
  const rows = board[view].filter((r) => carrier === 'all' || r.carrier === carrier);
  $('col-place').textContent = view === 'arrivals' ? 'From' : 'To';
  $('rows').innerHTML = rows.length ? rows.map(rowHtml).join('') : `<li class="empty">${esc(emptyMessage())}</li>`;
  for (const r of rows) seenTracks.set(r.id, r.track);
}

const DIRS = { N: 'Uptown, the Bronx and Queens', S: 'Downtown and Brooklyn' };
function renderSubway() {
  if (!board) return;
  if (!board.subway.length) {
    $('subway').innerHTML = `<p class="empty">${board.sources.subway.error ? 'Subway times didn’t load. Trying again shortly.' : 'No subway trains reported right now.'}</p>`;
    return;
  }
  const nowS = Date.now() / 1000;
  $('subway').innerHTML = ['N', 'S'].map((dir) => {
    const lines = board.subway.filter((g) => g.dir === dir).map((g) => {
      const mins = g.trains.map((x) => Math.round((x.time - nowS) / 60)).filter((m) => m >= 0).slice(0, 3);
      if (!mins.length) return '';
      const colour = '123'.includes(g.route) ? 'red' : 'ACE'.includes(g.route) ? 'blue' : '';
      const dest = g.trains[0].dest || (dir === 'N' ? 'Uptown' : 'Downtown');
      const firstMin = mins[0] === 0 ? '<b class="now">now</b>' : `<b>${mins[0]}</b> min`;
      const rest = mins.slice(1).length ? `, ${mins.slice(1).join(', ')}` : '';
      return `<div class="sline"><span class="bullet ${colour}" aria-label="${esc(g.route)} train">${esc(g.route)}</span><span class="sdest">${esc(dest)}</span><span class="smins">${firstMin}${rest}</span></div>`;
    }).join('');
    return lines ? `<div class="dir"><h3>${DIRS[dir]}</h3>${lines}</div>` : '';
  }).join('');
}

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
  if (!byDest.size) {
    $('path').innerHTML = `<p class="empty">${board.sources.path.error
      ? 'PATH times didn’t load. Trying again shortly.'
      : 'PATH isn’t reporting live times right now. Trains from 33 St run to Hoboken and Journal Square.'}</p>`;
    return;
  }
  $('path').innerHTML = [...byDest].map(([dest, g]) => {
    const mins = g.mins.slice(0, 3);
    const firstMin = mins[0] === 0 ? '<b class="now">now</b>' : `<b>${mins[0]}</b> min`;
    const rest = mins.length > 1 ? `, ${mins.slice(1).join(', ')}` : '';
    const dots = (g.colors.length ? g.colors : ['']).map((c) => `<i${c ? ` style="background:#${c}"` : ''}></i>`).join('');
    return `<div class="sline"><span class="pdots" aria-hidden="true">${dots}</span><span class="sdest">${esc(dest)}</span><span class="smins">${firstMin}${rest}</span></div>`;
  }).join('');
}

function renderNotices() {
  if (!board) return;
  const s = board.sources, out = [];
  if (s.njt.needsLogin) out.push('NJ Transit isn’t connected yet, so its trains are missing and Amtrak tracks appear only shortly before departure. Start the server with <code>NJT_USERNAME</code> and <code>NJT_PASSWORD</code> from a free NJ Transit developer account to add them.');
  else if (s.njt.error) out.push(`NJ Transit data didn’t load (${esc(s.njt.error)}). The NJ Transit trains shown may not be real time.`);
  for (const k of ['lirr', 'amtrak']) if (s[k].error) out.push(`${CARRIERS[k]} data didn’t load (${esc(s[k].error)}). Showing the last trains received.`);
  if (s.subway.error) out.push('Subway times didn’t load. Showing the last times received.');
  $('notices').innerHTML = out.map((m) => `<p>${m}</p>`).join('');
}

function renderStamp() {
  const el = $('updated');
  if (!lastGood) { el.textContent = failed ? 'Can’t reach the board server. Trying again.' : 'Connecting…'; return; }
  const age = Math.round((Date.now() - lastGood) / 1000);
  el.className = failed || age > 60 ? 'stale' : '';
  el.textContent = failed || age > 60
    ? `Can’t reach the board server. Last updated ${Math.round(age / 60) || 1} min ago, so this information may not be real time.`
    : `Updated ${age < 5 ? 'just now' : age + ' seconds ago'}.`;
}

function render() { renderRail(); renderSubway(); renderPath(); renderNotices(); renderStamp(); }

async function refresh() {
  try {
    const res = await fetch('api/board', { cache: 'no-store' });
    if (!res.ok) throw new Error(res.status);
    board = await res.json();
    lastGood = Date.now();
    failed = false;
  } catch { failed = true; }
  render();
}

function setPressed(group, attr, value) {
  document.querySelectorAll(`${group} button`).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset[attr] === value)));
}
document.querySelector('.seg').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  view = b.dataset.view; document.body.dataset.view = view;
  setPressed('.seg', 'view', view); render();
});
document.querySelector('.chips').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  carrier = b.dataset.carrier;
  try { localStorage.setItem('carrier', carrier); } catch {}
  setPressed('.chips', 'carrier', carrier); renderRail();
});
$('rows').addEventListener('toggle', (e) => {
  const id = e.target.dataset && e.target.dataset.id; if (!id) return;
  e.target.open ? openRows.add(id) : openRows.delete(id);
}, true);
// The Subway tab only exists on narrow screens; fall back when the window widens.
matchMedia('(min-width: 961px)').addEventListener('change', (e) => {
  if (e.matches && view === 'subway') document.querySelector('.seg button[data-view="departures"]').click();
});

function tick() {
  const t = clock(Date.now() / 1000);
  $('clock').textContent = t.hm; $('clock-ap').textContent = t.ap;
  renderStamp();
}
setPressed('.chips', 'carrier', carrier);
tick(); setInterval(tick, 1000);
refresh(); setInterval(refresh, REFRESH_MS);
setInterval(() => { renderRail(); renderSubway(); renderPath(); }, 10000); // keep countdowns moving between refreshes
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
