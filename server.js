// Penn Station live board: one small server, no dependencies (Node 18+).
// The feed readers live in docs/feeds.js, shared with the page. This server
// adds what a browser can't do: NJ Transit (needs a private login) and PATH
// (its feed doesn't allow browsers), and serves the page in /docs.

const http = require('http');
const fs = require('fs');
const path = require('path');
const feeds = require('./docs/feeds.js');
const { source, get, nyToEpoch, parsePath } = feeds;

const PORT = process.env.PORT || 3000;
const NJT_USERNAME = process.env.NJT_USERNAME || '';
const NJT_PASSWORD = process.env.NJT_PASSWORD || '';
const PUBLIC = path.join(__dirname, 'docs');
const TOKEN_FILE = path.join(__dirname, '.njt-token.json');

const pathTrains = source('path', 30, async () =>
  parsePath(await (await get('https://www.panynj.gov/bin/portauthority/ridepath.json')).json()));

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

async function board(force = false) {
  const [n, p] = await Promise.all([njt(force), pathTrains(force)]);
  return feeds.board({ server: true, force, njt: n, path: p, njtNeedsLogin: !NJT_USERNAME || !NJT_PASSWORD });
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/board') {
    try {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(await board(url.searchParams.has('force'))));
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
