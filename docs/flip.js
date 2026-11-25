// Split-flap tiles, shared by the Penn board (app.js) and the Grand Central
// board (gct.js), which each define esc(). Moved here unchanged from app.js
// (owner, Nov 25: the same board styles on both).
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
