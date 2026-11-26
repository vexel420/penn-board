// Airport helper, shared by every hub's board (owner, Nov 25: "the airport tab
// will be a feature at all hubs"). Loaded after the hub's own script, which
// provides HUB_AIR (where the trip starts, its bus plans file, how to reach
// Port Authority and Grand Central), hubAirportOptions(code, nowS) (its own
// trains), hubAirportLoad(), railTo(), lirrArrivalAt(), subwayFromTo(),
// lineName(), loadMtaBusStop()/mtaBusLive, openSheet() and changeOpen.
//
// ---------- airport helper (owner, Nov 24) ----------
// "To the airport": pick JFK, LaGuardia or Newark and see the fastest and
// cheapest ways from Penn right now. The first train is live (the board's
// own LIRR, NJ Transit, Amtrak and subway times); connections are the usual
// times below. Fares only from the official pages, as of Nov 2026: subway and
// local bus $3.00 (MTA, from Jan 4, 2026); LIRR CityTicket $5.25 off-peak,
// $7.25 peak, Penn to Jamaica or Woodside (laguardiaairport.com); AirTrain
// JFK $8.75 (jfkairport.com); Q70 LaGuardia Link free (laguardiaairport.com);
// NJ Transit New York Penn to Newark Airport $17.25 with the AirTrain, and
// Newark Penn to Newark Airport $12.30 with the AirTrain, "+ $3.00 for PATH"
// (njtransit.com/ewr); PATH $3.00; NJ Transit local bus one zone $1.90
// (NJ Transit Northern Intrastate fare chart). Update here when fares change.
// Newark Airport Express $23.50 one way (newarkairport.com, Nov 2026).
const FARES = { subway: 3.00, cityOff: 5.25, cityPeak: 7.25, airtrainJfk: 8.75, njtEwr: 17.25, njtNewarkEwr: 12.30, path: 3.00, njtBus1: 1.90, ewrExpress: 23.50 };
// Usual minutes for the parts that aren't live (connections, rail rides).
const AIR_MIN = {
  lirrJamaica: 20, lirrWoodside: 11, njtEwr: 24, amtrakEwr: 18,
  airtrainJfkWait: 4, airtrainJfkRide: 8, airtrainEwrWait: 3, airtrainEwrRide: 10,
  q70Wait: 5, q70FromJacksonHts: 12, q70FromWoodside: 16, change: 3,
  // PATH: Penn to the 33 St station, 33 St to Journal Square (direct / via
  // Hoboken at night and weekends), Journal Square to Newark; then a NJ
  // Transit train (one stop) or the 62 bus from Newark Penn.
  walkToPath: 5, pathJsq: 17, pathJsqViaHob: 26, pathNewark: 11, pathNewarkWait: 5, pathNewarkWaitNight: 15,
  njtNewarkWait: 8, njtNewarkWaitNight: 20, njtNewarkEwr: 6, bus62Wait: 8, bus62Ride: 20,
};
const AIRPORTS = [['JFK', 'Queens'], ['LGA', 'LaGuardia'], ['EWR', 'Newark'], ['ISP', 'Islip'], ['SWF', 'Stewart']];
let airportPick = 'JFK';
try { airportPick = localStorage.getItem('airport') || 'JFK'; } catch {}
if (!AIRPORTS.some(([c]) => c === airportPick)) airportPick = 'JFK';
const money = (x) => `$${x.toFixed(2)}`;
const hm = (t) => { const c = clock(t); return `${c.hm} ${c.ap}`; };
const minsText = (m) => (m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}` : `${m} min`);
const airPl = (txt, cls) => `<span class="pl ${cls}">${txt}</span>`;
// Live NJ Transit departures at one bus stop (relay /njt-bus-stop), 30 s fresh.
const NEWARK_PENN_62_STOP = '18835'; // Raymond Blvd bus lanes, gates 2A and 3A
const njtStopLive = new Map(); // stop -> { at, trips }
const njtStopLoading = new Set();
function loadNjtStop(stop) {
  const cur = njtStopLive.get(stop);
  if (njtStopLoading.has(stop) || (cur && Date.now() - cur.at < 30000) || !window.PENN_RELAY) return;
  njtStopLoading.add(stop);
  fetch(`${window.PENN_RELAY}/njt-bus-stop?stop=${stop}`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status))))
    .then((d) => { njtStopLive.set(stop, { at: Date.now(), trips: (d && d.DVTrip) || [] }); })
    .catch(() => { njtStopLive.set(stop, { at: Date.now(), trips: (cur && cur.trips) || [] }); })
    .finally(() => { njtStopLoading.delete(stop); if (changeOpen && changeOpen.id === 'airport' && $('change').open) renderAirport(); });
}
// As [{ route, sign, at (epoch s), late, gate, live }], soonest first.
function njtStopBuses(stop) {
  loadNjtStop(stop);
  const cur = njtStopLive.get(stop);
  if (!cur) return [];
  const nowS = Date.now() / 1000, now = nyNow().mins;
  const clockMin = (re, x) => { const c = re.exec(x || ''); return c ? (+c[1] % 12) * 60 + +c[2] + (/pm/i.test(c[3]) ? 720 : 0) : null; };
  return cur.trips.map((x) => {
    const t = clockMin(/(\d+):(\d+)\s*(AM|PM)/i, x.departuretime);
    const st = clockMin(/(\d+):(\d+):\d+\s*(AM|PM)/i, x.sched_dep_time);
    if (t == null) return null;
    let inMin = (t - now + 1440) % 1440;
    if (inMin > 1200) return null; // just left
    let late = st != null ? (t - st + 1440) % 1440 : 0;
    if (late > 720) late = 0;
    return { route: String(x.public_route || ''), sign: String(x.header || ''), at: nowS - (nowS % 60) + inMin * 60, late, gate: String(x.lanegate || '').split('_')[0], live: !!x.vehicle_id && x.vehicle_id !== 'EMPTY' };
  }).filter(Boolean).sort((a, b) => a.at - b.at);
}
// From Newark Penn, once PATH gets you there: one stop on NJ Transit to the
// airport (with the AirTrain), or the 62 bus (live from NJ Transit at its
// stop). Shared by every hub (owner, Nov 25: no hub gets better information).
// `before`: the legs up to Newark Penn; `paid`: fare so far; `paidText`: what for.
// `live`: false when the PATH train is estimated rather than live.
function newarkPennOptions(before, atNewark, night, paid, paidText, live) {
  const out = [];
  const tr = atNewark + (AIR_MIN.change + (night ? AIR_MIN.njtNewarkWaitNight : AIR_MIN.njtNewarkWait)) * 60;
  out.push({ at: tr + (AIR_MIN.njtNewarkEwr + AIR_MIN.change + AIR_MIN.airtrainEwrWait + AIR_MIN.airtrainEwrRide) * 60, fare: paid + FARES.njtNewarkEwr, live,
    fareText: paidText === 'PATH' ? undefined : `${money(paid + FARES.njtNewarkEwr)} one way (${paidText} + NJ Transit with the AirTrain)`,
    legs: [...before, [tr, `${airPl('NJ Transit', 'p-njt')} at Newark Penn, one stop to Newark Airport`], [tr + (AIR_MIN.njtNewarkEwr + AIR_MIN.change) * 60, `${airPl('AirTrain', 'p-air')} to your terminal (included)`]] });
  // The 62: NJ Transit's own departures at Newark Penn (stop 18835) when in.
  const ready62 = atNewark + AIR_MIN.change * 60;
  const b62 = njtStopBuses(NEWARK_PENN_62_STOP).find((x) => x.route === '62' && /AIRPORT/i.test(x.sign) && x.at >= ready62);
  const bus = b62 ? b62.at : ready62 + AIR_MIN.bus62Wait * 60;
  const gate = b62 && b62.gate ? b62.gate : night ? '2A' : '3A';
  out.push({ at: bus + AIR_MIN.bus62Ride * 60, fare: paid + FARES.njtBus1, live, fareText: `${money(paid + FARES.njtBus1)} one way (${paidText} + one-zone bus fare)`,
    legs: [...before, [bus, `${airPl('62 bus', 'p-njt')} at Newark Penn (Raymond Blvd, gate ${esc(gate)}) to your terminal${b62 ? (b62.live ? ` · <span class="sb-live">live</span>${b62.late >= 2 ? ` <span class="bus-late">${b62.late} min late</span>` : ''}` : ' (scheduled)') : ', about every 20 min'}`]] });
  return out;
}

// ---------- buses to JFK and LaGuardia (owner, Nov 25) ----------
// docs/airport-buses.json (scripts/build-airport-buses.py): for each MTA bus
// route to the airport, the subway ride from Penn to a stop of that bus, and
// the bus to the airport (JFK: Lefferts Blvd AirTrain, free from there to every
// terminal, or Terminal 8; LaGuardia: Terminals B and C). Subway and bus are a
// free transfer: $3.00 in all (the Q70 LaGuardia Link is free anyway). The
// first train is live when the board lists it; the bus is live (MTA Bus Time).
let airportBuses;          // undefined: not loaded; null: couldn't load
let airportBusesLoading = null;
const loadAirportBuses = () => airportBusesLoading || (airportBusesLoading = fetch(HUB_AIR.buses).then((r) => (r.ok ? r.json() : null)).catch(() => null).then((d) => { airportBuses = d; if (changeOpen && changeOpen.id === 'airport' && $('change').open) renderAirport(); }));
const titleCase = (x) => String(x).toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\bAv\b/g, 'Av').replace(/\bRd\b/g, 'Rd');
function airportBusOptions(code, nowS) {
  if (code !== 'JFK' && code !== 'LGA') return [];
  loadAirportBuses();
  if (!airportBuses) return [];
  const names = airportBuses.names || {};
  const term = code === 'LGA' && lgaTerminal !== 'any' ? `Terminal ${lgaTerminal}` : null;
  const out = [];
  for (const p of airportBuses.plans.filter((x) => x.airport === code)) {
    // Where it drops you, and the ride there (LaGuardia: your terminal, if picked).
    const stops = Object.entries(p.to);
    const pick = term ? stops.find(([k]) => k === term) : stops.sort((a, b) => a[1] - b[1])[0];
    if (!pick) continue;
    const [alight, ride] = pick;
    const legs = [];
    let t = nowS;
    let live = false;
    p.subway.forEach((l, i) => {
      const tr = i === 0 ? subwayFromTo(l.route, l.from, l.to, nowS) : null;
      if (i === 0 && tr) { t = tr.time; live = true; } else t += (i === 0 ? 4 : 3 + 4) * 60;
      legs.push([t, `${lineName(l.route)} to ${esc(names[l.to] || l.to)}`]);
      t += l.mins * 60;
    });
    t += p.walk * 60;
    // The bus: live from MTA Bus Time when it's in, else the usual wait.
    loadMtaBusStop(p.board);
    const lb = mtaBusLive.get(p.board);
    const want = String(p.route).toUpperCase();
    const next = lb && lb.buses ? lb.buses.filter((b) => String(b.line).toUpperCase() === want && b.at && Date.parse(b.at) / 1000 >= t)
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0] : null;
    const busAt = next ? Date.parse(next.at) / 1000 : t + (p.gap / 2) * 60;
    const late = next && next.aimed ? Math.round((Date.parse(next.at) - Date.parse(next.aimed)) / 60000) : 0;
    // LaGuardia with no terminal picked: the bus serves both B and C.
    const both = code === 'LGA' && !term && stops.length > 1 ? `LaGuardia, Terminals ${stops.map(([k]) => k.replace('Terminal ', '')).sort().join(' and ')}` : '';
    const where = both || (alight === 'Lefferts Blvd AirTrain' ? 'Lefferts Blvd AirTrain station' : `${code === 'JFK' ? 'JFK ' : ''}${alight}`);
    legs.push([busAt, `${airPl(esc(p.route), 'p-mtabus')} from ${esc(titleCase(p.boardName))} to ${esc(where)}${next ? ` · <span class="sb-live">live</span>${late >= 2 ? ` <span class="bus-late">${late} min late</span>` : ''}` : `, about every ${p.gap} min`}`]);
    let at = busAt + ride * 60;
    if (p.airtrain) { legs.push([at, `${airPl('AirTrain', 'p-air')} to your terminal (free from here)`]); at += p.airtrain * 60; }
    out.push({ at, fare: FARES.subway, fareText: `${money(FARES.subway)} one way (subway, free transfer to the bus)`, legs, live, term: both ? null : alight.startsWith('Terminal') ? alight : null,
      only: code === 'JFK' && alight === 'Terminal 8' ? 'Terminal 8 only' : '' });
  }
  // The quickest two (a third if it's a different kind of trip).
  return out.sort((a, b) => a.at - b.at).slice(0, 2);
}

// ---------- LaGuardia terminals and airlines ----------
// From LaGuardia Airport's own website (Nov 25, 2026): Terminal B serves Air
// Canada, American, Frontier, JetBlue, Porter, Southwest and United; Terminal C
// is Delta's. Terminal A has no passenger flights (private aviation only; Spirit
// has ceased operations). Every LaGuardia bus serves Terminals B and C.
const LGA_AIRLINES = [['Air Canada', 'B'], ['American Airlines', 'B'], ['Delta', 'C'], ['Frontier Airlines', 'B'], ['JetBlue', 'B'], ['Porter Airlines', 'B'], ['Southwest Airlines', 'B'], ['United Airlines', 'B']];
let lgaTerminal = 'any', lgaAirline = '';
try { lgaTerminal = localStorage.getItem('lgaTerminal') || 'any'; lgaAirline = localStorage.getItem('lgaAirline') || ''; } catch {}
let lgaPicking = false;
function lgaPickerHtml() {
  if (lgaPicking) {
    return `<p class="am-label">Which airline?</p><ul class="am-list">${LGA_AIRLINES.map(([a, t]) => `<li><button type="button" data-lga-airline="${esc(a)}" data-lga-term="${t}">${esc(a)}<b>Terminal ${t}</b></button></li>`).join('')}</ul>
      <p class="am-note">From LaGuardia Airport's website. Not listed? Check your boarding pass. Terminal A has no passenger flights.</p>`;
  }
  const saved = lgaAirline && lgaTerminal !== 'any' ? `<div class="am-saved"><span>Flying <b>${esc(lgaAirline)}</b> · Terminal ${esc(lgaTerminal)}</span><button type="button" data-lga-change>Change</button></div>` : '';
  return saved || `<p class="am-label">Terminal</p><div class="am-row">${['any', 'B', 'C'].map((t) => `<button type="button" class="am-chip" data-lga-term="${t}" aria-pressed="${lgaTerminal === t}">${t === 'any' ? 'Any' : t}</button>`).join('')}<button type="button" class="am-link" data-lga-change>Not sure?</button></div>`;
}
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-lga-airline]');
  const t = e.target.closest('[data-lga-term]');
  const c = e.target.closest('[data-lga-change]');
  if (!a && !t && !c) return;
  if (c) lgaPicking = true; // "Not sure?" or "Change": the airline list
  else { lgaTerminal = t.dataset.lgaTerm; lgaAirline = a ? a.dataset.lgaAirline : ''; lgaPicking = false; }
  try { localStorage.setItem('lgaTerminal', lgaTerminal); localStorage.setItem('lgaAirline', lgaAirline); } catch {}
  renderAirport();
});

// ---------- Newark Airport Express (Coach USA) ----------
// docs/ewr-express.json (scripts/build-ewr-express.py, from Coach USA's
// timetable): departures from Port Authority Bus Terminal to Terminals B, C, A.
// Scheduled times (Coach USA publishes no live data).
let ewrExpress;
let ewrExpressLoading = null;
const loadEwrExpress = () => ewrExpressLoading || (ewrExpressLoading = fetch('ewr-express.json').then((r) => (r.ok ? r.json() : null)).catch(() => null).then((d) => { ewrExpress = d; if (changeOpen && changeOpen.id === 'airport' && $('change').open) renderAirport(); }));
function ewrExpressOptions(nowS) {
  loadEwrExpress();
  if (!ewrExpress) return [];
  const key = { weekday: 'wk', saturday: 'sa', sunday: 'su' };
  // This hub's pickup: Port Authority (Penn) or Grand Central (41 St).
  const times = ewrExpress[HUB_AIR.ewrFrom] || {};
  const today = nyNow(), yest = nyNow(-1), tom = nyNow(1);
  const midnight = nowS - today.mins * 60 - (nowS % 60);
  // (Times past midnight belong to the day before's schedule.)
  const list = [
    ...(times[key[yest.day]] || []).filter(([m]) => m >= 1440).map(([m, t]) => [m - 1440, t]),
    ...(times[key[today.day]] || []),
    ...(times[key[tom.day]] || []).map(([m, t]) => [m + 1440, Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v + 1440]))]),
  ];
  const ready = (nowS - midnight) / 60 + HUB_AIR.ewrWalk;
  const next = list.filter(([m]) => m >= ready).sort((a, b) => a[0] - b[0])[0];
  if (!next) return [];
  const [m, term] = next;
  const first = Math.min(...Object.values(term));
  const order = Object.entries(term).sort((a, b) => a[1] - b[1]).map(([k]) => k).join(', ');
  return [{ at: midnight + first * 60, fare: FARES.ewrExpress, live: false, tag: 'Scheduled', legs: [
    [midnight + (m - HUB_AIR.ewrWalk) * 60, HUB_AIR.ewrWalkText],
    [midnight + m * 60, `${airPl('Newark Airport Express', 'p-partner')} from ${esc(HUB_AIR.ewrStop)} to Terminals ${esc(order)}`]] }];
}

// ---------- Islip (Long Island MacArthur) ----------
// LIRR to Ronkonkoma (live), then a taxi or ride-hail, about 5 minutes, per
// MacArthur Airport's and the MTA's own pages (no scheduled shuttle to
// Ronkonkoma); or LIRR to Central Islip or Patchogue and Suffolk County
// Transit's route 6 bus, the one bus that serves the terminal.
// Suffolk County Transit route 6 to the terminal (docs/isp-bus.json,
// scripts/build-isp-bus.py): from the LIRR's Central Islip or Patchogue station.
let ispBus;
let ispBusLoading = null;
const loadIspBus = () => ispBusLoading || (ispBusLoading = fetch('isp-bus.json').then((r) => (r.ok ? r.json() : null)).catch(() => null).then((d) => { ispBus = d; if (changeOpen && changeOpen.id === 'airport' && $('change').open) renderAirport(); }));
function ispBusAfter(station, t) {
  if (!ispBus || !ispBus.from[station]) return null;
  const key = { weekday: 'wk', saturday: 'sa', sunday: 'su' };
  const nowS = Date.now() / 1000;
  const midnight = nowS - nyNow().mins * 60 - (nowS % 60);
  const list = [...(ispBus.from[station][key[nyNow().day]] || []), ...(ispBus.from[station][key[nyNow(1).day]] || []).map(([a, b]) => [a + 1440, b + 1440])];
  const x = list.find(([dep]) => midnight + dep * 60 >= t);
  return x ? { leave: midnight + x[0] * 60, arrive: midnight + x[1] * 60 } : null;
}
function ispOptions(nowS) {
  loadIspBus();
  const out = [];
  // LIRR to Ronkonkoma, then a taxi or ride-hail (about 5 min).
  const l = railTo(['lirr'], 'Ronkonkoma', nowS)[0];
  if (l) {
    const dep = l.leaves ?? l.time;
    const arr = lirrArrivalAt(l, 'Ronkonkoma') || dep + 80 * 60;
    out.push({ at: arr + 8 * 60, fare: null, fareText: 'LIRR fare to Ronkonkoma, plus the taxi', live: true,
      legs: [[dep, `${airPl('LIRR', 'p-lirr')} to Ronkonkoma${HUB_AIR.lirrFrom || ''}${l.track ? `, track ${esc(l.track)}` : ''}`], [arr + 3 * 60, 'Taxi or ride-hail to the terminal, about 5 min']] });
  }
  // LIRR to Central Islip or Patchogue, then Suffolk County Transit's route 6 to the terminal.
  for (const station of ['Central Islip', 'Patchogue']) {
    const t = railTo(['lirr'], station, nowS)[0];
    if (!t) continue;
    const dep = t.leaves ?? t.time;
    const arr = lirrArrivalAt(t, station);
    const bus = arr && ispBusAfter(station, arr + 3 * 60);
    if (!bus || bus.leave - arr > 50 * 60) continue; // no bus soon enough after the train
    out.push({ at: bus.arrive, fare: null, fareText: `LIRR fare to ${station}, plus ${money(ispBus.fare || 2.25)} for the bus`, live: true,
      legs: [[dep, `${airPl('LIRR', 'p-lirr')} to ${station}${HUB_AIR.lirrFrom || ''}${t.track ? `, track ${esc(t.track)}` : ''}`], [bus.leave, `${airPl('Suffolk 6', 'p-partner')} bus from ${station} station to the terminal (scheduled)`]] });
  }
  // Nothing on the live board (late at night, or the board's list is short):
  // the next trains from the LIRR timetable, tonight or tomorrow, direct or
  // with a change (owner, Nov 26: "if there is nothing today, work out the next
  // available time").
  if (!out.length) out.push(...ispScheduled(nowS));
  return out;
}
let ispTTAsked = false;
function ispScheduled(nowS) {
  if (typeof lirrTT === 'undefined' || !lirrTT || !lirrData) {
    if (!ispTTAsked && typeof loadLirrTT === 'function') { ispTTAsked = true; loadLirrTT().then(() => { if (changeOpen && changeOpen.id === 'airport' && $('change').open) renderAirport(); }); }
    return [];
  }
  const idOf = (name) => Object.keys(lirrData.stops).find((k) => normName2(lirrData.stops[k][0]) === normName2(name));
  const ids = { Ronkonkoma: idOf('Ronkonkoma'), 'Central Islip': idOf('Central Islip'), Patchogue: idOf('Patchogue') };
  const plans = ttPlans(lirrTT, TT.lirr.change, new Set(Object.values(ids).filter(Boolean)), null, nowS + 60, 30);
  const today = nyNow().date;
  const out = [];
  for (const [station, id] of Object.entries(ids)) {
    const p = id && plans.get(id);
    if (!p) continue;
    // The first train on the live board, on time: its live time and track.
    const r = ((board && board.departures) || []).find((x) => x.carrier === 'lirr' && trainNo(x.train) === p.first.train && x.tone !== 'stop');
    const onTime = r && Math.abs((r.leaves ?? r.time) - p.leave) < 120;
    const ride = [[p.leave, `${airPl('LIRR', 'p-lirr')} train ${esc(p.first.train)} to ${esc(p.change ? ttStopName('lirr', p.change.at) : station)}${HUB_AIR.lirrFrom || ''}${onTime && r.track ? `, track ${esc(r.track)}` : ''}`]];
    if (p.change) ride.push([p.change.time, `Change at ${esc(ttStopName('lirr', p.change.at))} for train ${esc(p.change.second.train)} to ${esc(station)}`]);
    const only = nyDayAt(p.leave).date !== today ? 'Tomorrow' : '';
    if (station === 'Ronkonkoma') {
      out.push({ at: p.arrive + 8 * 60, fare: null, fareText: 'LIRR fare to Ronkonkoma, plus the taxi', live: !!onTime, tag: 'Scheduled', only,
        legs: [...ride, [p.arrive + 3 * 60, 'Taxi or ride-hail to the terminal, about 5 min']] });
    } else {
      const bus = ispBusAfter(station, p.arrive + 3 * 60);
      if (!bus || bus.leave - p.arrive > 50 * 60) continue;
      out.push({ at: bus.arrive, fare: null, fareText: `LIRR fare to ${station}, plus ${money((ispBus && ispBus.fare) || 2.25)} for the bus`, live: !!onTime, tag: 'Scheduled', only,
        legs: [...ride, [bus.leave, `${airPl('Suffolk 6', 'p-partner')} bus from ${station} station to the terminal (scheduled)`]] });
    }
  }
  return out;
}
// ---------- New York Stewart (SWF) (owner, Nov 25) ----------
// No direct bus from the city any more (Stewart Airport's own page, Nov 2026).
// Two ways, both ending on Leprechaun Lines' Newburgh Beacon Bridge Shuttle,
// free in 2026, on the runs that stop at the terminal:
//   Metro-North Hudson Line, Grand Central to Beacon (live: TrainTime's Grand
//   Central departures, the same source as the board's LIRR), then the shuttle;
//   Coach USA (ShortLine) from Port Authority to the Route 17K Park & Ride in
//   Newburgh, then the shuttle.
// docs/swf.json (scripts/build-swf.py): the Metro-North and Coach USA
// timetables, and the shuttle's westbound runs that stop at Stewart.
let swfData;
let swfLoading = null;
const loadSwf = () => swfLoading || (swfLoading = fetch('swf.json').then((r) => (r.ok ? r.json() : null)).catch(() => null).then((d) => { swfData = d; if (changeOpen && changeOpen.id === 'airport' && $('change').open) renderAirport(); }));
let mnrLive = null, mnrLiveAt = 0, mnrLiveLoading = null;
function loadMnrLive() {
  if (mnrLiveLoading || Date.now() - mnrLiveAt < 60000) return;
  mnrLiveLoading = fetch('https://backend-unified.mylirr.org/arrivals/0NY', { headers: { 'accept-version': '3.0' }, cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status))))
    .then((d) => { mnrLive = ((d && d.arrivals) || []).filter((a) => a.railroad === 'MNR' && (a.stops || []).includes('0BC')); })
    .catch(() => {})
    .finally(() => { mnrLiveAt = Date.now(); mnrLiveLoading = null; if (changeOpen && changeOpen.id === 'airport' && $('change').open && airportPick === 'SWF') renderAirport(); });
}
// Days from today (0, 1) with their midnight, timetable date and shuttle schedule.
function swfDays(nowS) {
  return [0, 1].map((k) => {
    const n = nyNow(k);
    const ymd = n.date.replace(/-/g, '');
    const weekend = n.day !== 'weekday' || (swfData.weekendDates || []).includes(ymd);
    return { ymd, weekend, midnight: nowS + k * 86400 - nyNow().mins * 60 - (nowS % 60) };
  });
}
// The first shuttle run to the terminal leaving a stop (0 Beacon, 1 Park & Ride) at or after t.
function swfShuttleAfter(stop, t, nowS) {
  for (const d of swfDays(nowS)) {
    const run = (swfData.shuttle[d.weekend ? 'we' : 'wk'] || []).find((r) => d.midnight + r[stop] * 60 >= t);
    if (run) return { leave: d.midnight + run[stop] * 60, arrive: d.midnight + run[2] * 60 };
  }
  return null;
}
function swfOptions(nowS) {
  loadSwf();
  if (!swfData) return [];
  const out = [];
  const MAX_WAIT = 75 * 60; // don't offer a shuttle more than this long after you get there
  // Metro-North: the first train you can reach from here whose shuttle works out
  // (from Penn, the subway to Grand Central first: HUB_AIR.toGct minutes).
  if (swfData.mnr) {
    loadMnrLive();
    const live = new Map((mnrLive || []).map((a) => [String(a.train_num), a]));
    const reach = nowS + ((HUB_AIR.toGct || 0) + (HUB_AIR.toGct ? 2 : 4)) * 60;
    const trains = [];
    for (const d of swfDays(nowS)) {
      const svc = new Set(swfData.mnr.dates[d.ymd] || []);
      for (const [s, num, dep, arr] of swfData.mnr.trips) {
        if (!svc.has(s)) continue;
        const a = live.get(String(num));
        if (a && a.status && a.status.canceled) continue;
        const shift = a ? a.time - (d.midnight + dep * 60) : 0;
        if (Math.abs(shift) > 3 * 3600) continue; // another day's train with the same number
        trains.push({ num, dep: d.midnight + dep * 60 + shift, arr: d.midnight + arr * 60 + shift, live: !!a, track: a && a.track, late: Math.round(shift / 60) });
      }
    }
    trains.sort((x, y) => x.dep - y.dep);
    for (const tr of trains.filter((x) => x.dep >= reach).slice(0, 12)) {
      const sh = swfShuttleAfter(0, tr.arr + 3 * 60, nowS);
      if (!sh || sh.leave - tr.arr > MAX_WAIT) continue;
      const subAt = tr.dep - ((HUB_AIR.toGct || 0) + 2) * 60; // leave for Grand Central by
      out.push({ at: sh.arrive, fare: null, live: tr.live, tag: 'Scheduled',
        fareText: HUB_AIR.toGct ? `Metro-North fare to Beacon, plus ${money(FARES.subway)} for the subway; the shuttle is free in 2026` : 'Metro-North fare to Beacon; the shuttle is free in 2026',
        note: 'The shuttle stops at the terminal only on some runs; these times are for those. Check Leprechaun Lines’ schedule before you travel, especially on holidays.',
        legs: [...(HUB_AIR.toGct ? [[subAt, HUB_AIR.toGctText()]] : []),
          [tr.dep, `${airPl('Metro-North', 'p-mnr')} Hudson Line to Beacon, train ${esc(tr.num)}${tr.track ? `, track ${esc(tr.track)}` : ''}${tr.live ? ` · <span class="sb-live">live</span>${tr.late >= 2 ? ` <span class="bus-late">${tr.late} min late</span>` : ''}` : ' (scheduled)'}`],
          [sh.leave, `${airPl('Newburgh Beacon Bridge Shuttle', 'p-partner')} (free) from Beacon station to the terminal (scheduled)`]] });
      break;
    }
  }
  // Coach USA to Newburgh, then the shuttle from the Park & Ride.
  if (swfData.coach) {
    const ready = nowS + HUB_AIR.toPabt * 60;
    const buses = [];
    for (const d of swfDays(nowS)) {
      const svc = new Set(swfData.coach.dates[d.ymd] || []);
      for (const [s, route, dep, arr] of swfData.coach.toNewburgh) if (svc.has(s)) buses.push({ route, dep: d.midnight + dep * 60, arr: d.midnight + arr * 60 });
    }
    for (const b of buses.filter((x) => x.dep >= ready).sort((x, y) => x.dep - y.dep).slice(0, 10)) {
      const sh = swfShuttleAfter(1, b.arr + 5 * 60, nowS);
      if (!sh || sh.leave - b.arr > MAX_WAIT) continue;
      out.push({ at: sh.arrive, fare: null, live: false, tag: 'Scheduled',
        fareText: 'Coach USA fare to Newburgh (buy at Port Authority or online); the shuttle is free in 2026',
        note: 'Get off at the Newburgh ShortLine Transportation Center (Route 17K Park & Ride). The shuttle stops at the terminal only on some runs; check Coach USA’s and Leprechaun Lines’ schedules before you travel.',
        legs: [[b.dep - HUB_AIR.toPabt * 60, HUB_AIR.toPabtText],
          [b.dep, `${airPl(`Coach USA ${esc(b.route)}`, 'p-partner')} from Port Authority Bus Terminal to Newburgh (Route 17K Park & Ride)`],
          [sh.leave, `${airPl('Newburgh Beacon Bridge Shuttle', 'p-partner')} (free) from the Park & Ride to the terminal`]] });
      break;
    }
  }
  return out;
}
// Every option to an airport from this hub: its own trains, then the shared ones.
function airportOptions(code, nowS) {
  const o = hubAirportOptions(code, nowS);
  if (code === 'EWR') o.push(...ewrExpressOptions(nowS));
  if (code === 'ISP') o.push(...ispOptions(nowS));
  if (code === 'SWF') o.push(...swfOptions(nowS));
  o.push(...airportBusOptions(code, nowS));
  return o;
}
function renderAirport() {
  const nowS = Date.now() / 1000;
  const opts = airportOptions(airportPick, nowS).sort((a, b) => a.at - b.at);
  const fastest = opts[0];
  const priced = opts.filter((x) => x.fare != null);
  const cheapest = priced.length ? priced.reduce((a, b) => (b.fare < a.fare || (b.fare === a.fare && b.at < a.at) ? b : a)) : null;
  $('chg-top').innerHTML = `<div class="sheet-air five">${AIRPORTS.map(([c, s]) => `<button type="button" data-airport="${c}" aria-pressed="${c === airportPick}">${c}<small>${s}</small></button>`).join('')}</div>${airportPick === 'LGA' ? lgaPickerHtml() : ''}`;
  const lgaT = airportPick === 'LGA' && lgaTerminal !== 'any' ? `Terminal ${lgaTerminal}` : '';
  $('chg-below').innerHTML = (opts.length ? opts.map((x) => `<div class="opt-card"><div class="top"><span>${x === fastest ? '<span class="tagx tag-fast">Fastest</span>' : ''}${x === cheapest ? '<span class="tagx tag-cheap">Cheapest</span>' : ''}${x.live === false ? `<span class="tagx tag-sched">${x.tag || 'Estimated'}</span>` : '<span class="tagx tag-live">Live</span>'}${x.only ? `<span class="am-tag">${esc(x.only)}</span>` : ''}</span><span class="t">${minsText(Math.round((x.at - nowS) / 60))}</span></div>
    <ul class="legs">${x.legs.map(([t, txt]) => `<li><span>${hm(t)}</span><span>${txt}</span></li>`).join('')}<li><span>${hm(x.at)}</span><span>Arrive at ${lgaT || x.term || 'the airport'} (estimated)</span></li></ul>
    <div class="air-fare">${x.fareText || (x.fare != null ? `${money(x.fare)} one way` : '')}</div>${x.note ? `<div class="air-note">${x.note}</div>` : ''}</div>`).join('')
    : `<p class="cm-live">${airportPick === 'SWF' ? 'No connection to Stewart in the next day: the shuttle to the terminal runs only at certain times.' : (airportPick === 'ISP' && (typeof lirrTT === 'undefined' || lirrTT === undefined) ? 'Looking up the next trains in the LIRR timetable…' : `No trains to there are listed from ${HUB_AIR.from} right now.`)}</p>`)
    + '<p class="cm-live">First train: live times from the board. Buses: live from MTA Bus Time when marked live. Connections use usual times. Fares from the MTA, the Port Authority, PATH and NJ Transit; Newark Airport Express and Coach USA times are Coach USA’s schedule; Metro-North is live from TrainTime; the Stewart shuttle is Leprechaun Lines’ schedule; the Islip bus is Suffolk County Transit’s. Check before you travel.</p>';
}
function openAirport() {
  changeOpen = { id: 'airport', view: 1 };
  loadAirportBuses(); loadEwrExpress(); loadSwf(); loadIspBus(); hubAirportLoad();
  $('chg-map').hidden = true;
  $('chg-kind').textContent = `From ${HUB_AIR.from}`;
  $('chg-h').textContent = 'To the airport';
  renderAirport();
  openSheet();
}
$('to-airport').addEventListener('click', openAirport);
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-airport]');
  if (!b) return;
  airportPick = b.dataset.airport;
  try { localStorage.setItem('airport', airportPick); } catch {}
  renderAirport();
});
// Keep it current while open.
setInterval(() => { if (changeOpen && changeOpen.id === 'airport' && $('change').open) renderAirport(); }, 30000);


