#!/usr/bin/env python3
"""Build docs/njt-bus-finder.json: buses (NJ Transit and partner companies)
from Port Authority Bus Terminal that get close to each NJ Transit rail station, for rail outages and
strikes (owner, Nov 2026).

Inputs are NJ Transit's own timetable files (GTFS) from the developer portal:
the bus file (GTFSG2/getGTFS) and the rail file (GTFSRT/getGTFS).

For each rail station on a line that serves New York Penn, every bus route
leaving Port Authority (stop 26229, the gates are its platforms) that stops
within WALK_MAX metres of the station is listed with the bus stop it uses
(the one that gets you there soonest, walking included), the usual ride time
from Port Authority, the walk, the gates it leaves from and how often it runs
on weekdays. The board joins this with live departures (getBusDV, stop PABT).

    python3 scripts/build-njt-bus-finder.py bus.zip rail.zip \
        "Coach USA=gtfs.zip" Academy=Academy_bus_data.zip Lakeland=LakelandBusLines_bus_data.zip \
        Trans-Bridge=Trans-Bridge_bus_data.zip Seastreak=google_transit.zip

Partner companies' files (developer portal, "GTFS Data Downloads") are
optional; their trips count when they leave within ORIGIN_M of Port
Authority (ferries: from a Manhattan pier).
"""
import csv, datetime, io, json, math, re, statistics, sys, zipfile
from collections import defaultdict
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / 'docs' / 'njt-bus-finder.json'
PABT = '26229'
PABT_PT = (40.75637, -73.99075)
ORIGIN_M = 350           # partner stops this close to Port Authority count as leaving from it
FERRIES = {'Seastreak'}  # ferries leave from Manhattan piers instead


def manhattan(sid, s, pt):
    return 40.70 <= pt[0] <= 40.80 and -74.02 <= pt[1] <= -73.93
WALK_MAX = 1200          # metres from the bus stop to the station
FAR_MAX = 8000           # no walkable bus: the closest a bus gets, then a taxi or local ride
WALK_M_PER_MIN = 75
KEEP = 6                 # routes kept per station
# Rail routes that are not trains from New York Penn.
NOT_PENN = {'HBLR', 'NLR', 'RVLN', 'ATLC'}


def rows(z, name):
    with z.open(name) as f:
        yield from csv.DictReader(io.TextIOWrapper(f, encoding='utf-8-sig'))


def mins(t):
    h, m, s = map(int, t.split(':'))
    return h * 60 + m + s / 60


def metres(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    x = (lo2 - lo1) * math.cos((la1 + la2) / 2)
    return 6371000 * math.hypot(x, la2 - la1)


def title(s):
    small = {'at', 'and', 'of', 'the', 'via', 'to'}
    out = []
    for i, w in enumerate(s.strip().split()):
        lw = w.lower()
        out.append(lw if i and lw in small else (w if len(w) <= 3 and w.isupper() and w in ('NJ', 'NY', 'US', 'PNC', 'NJT') else w.capitalize()))
    return ' '.join(out).replace(' St.', ' St').replace('Phl.', 'Phila.')


def active_on(z, day):
    """Service ids running on a date (YYYYMMDD), from calendar.txt and calendar_dates.txt."""
    wd = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'][datetime.date(int(day[:4]), int(day[4:6]), int(day[6:])).weekday()]
    on = set()
    names = set(z.namelist())
    if 'calendar.txt' in names:
        on = {c['service_id'] for c in rows(z, 'calendar.txt') if c[wd] == '1' and c['start_date'] <= day <= c['end_date']}
    if 'calendar_dates.txt' in names:
        for c in rows(z, 'calendar_dates.txt'):
            if c['date'] == day:
                (on.add if c['exception_type'] == '1' else on.discard)(c['service_id'])
    return on


def sample_wednesday(z):
    """A Wednesday the file covers: a week or more out when it can (skips
    holiday-eve timetables), else the next one it has."""
    for lead in (7, 0):
        d = datetime.date.today() + datetime.timedelta(days=lead)
        for _ in range(400):
            if d.weekday() == 2:
                day = d.strftime('%Y%m%d')
                if active_on(z, day):
                    return day
            d += datetime.timedelta(days=1)
    return None


def gate_of(stop_id, stop):
    """Port Authority gate number when the file gives one."""
    if stop_id.startswith(PABT + '-'):
        g = stop_id.split('-', 1)[1].split('_')[0]
        return g if g.isdigit() else None
    m = re.search(r'gate\s*(\d+)', ' '.join([stop.get('stop_code', ''), stop.get('stop_name', ''), stop.get('platform_code', '')]), re.I)
    return m.group(1) if m else None


def feed_options(z, label, stations, origin_test):
    """Per station: {route key: entry} for trips in this file that leave an origin stop."""
    stops = {}
    for s in rows(z, 'stops.txt'):
        if s.get('stop_lat') and s.get('stop_lon'):
            stops[s['stop_id']] = (s, (float(s['stop_lat']), float(s['stop_lon'])))
    origins = {sid for sid, (s, pt) in stops.items() if origin_test(sid, s, pt)}
    near = defaultdict(dict)
    for sid, (s, pt) in stops.items():
        if sid in origins:
            continue
        for code, st in stations.items():
            if abs(pt[0] - st['pt'][0]) < 0.08 and abs(pt[1] - st['pt'][1]) < 0.1:
                d = metres(st['pt'], pt)
                if d <= FAR_MAX:
                    near[sid][code] = d
    agencies = {a.get('agency_id', ''): a['agency_name'] for a in rows(z, 'agency.txt')}
    routes = {}
    for r in rows(z, 'routes.txt'):
        ag = agencies.get(r.get('agency_id', ''), label) if len(agencies) > 1 else label
        short, long = r.get('route_short_name', '').strip(), r.get('route_long_name', '').strip()
        if short == ag or short in agencies.values():   # Coach USA puts the company in the short name
            short = ''
        if not short:
            short = re.sub(r'\s*-?\s*(east|west|north|south)bound$', '', long.split(' - ')[0], flags=re.I).strip()
        routes[r['route_id']] = (ag, short, title(long) if long.isupper() else long)
    wed = sample_wednesday(z)
    weekday = active_on(z, wed) if wed else set()
    trips = {t['trip_id']: (t['route_id'], t.get('trip_headsign', ''), t['service_id'] in weekday) for t in rows(z, 'trips.txt')}

    start, hits = {}, defaultdict(list)
    for st in rows(z, 'stop_times.txt'):
        sid, tid = st['stop_id'], st['trip_id']
        if sid in origins:
            if tid not in start and st['departure_time']:
                start[tid] = (mins(st['departure_time']), gate_of(sid, stops[sid][0]), stops[sid][0]['stop_name'])
        elif sid in near and st['arrival_time']:
            hits[tid].append((sid, mins(st['arrival_time'])))

    per = defaultdict(lambda: defaultdict(lambda: {'rides': defaultdict(list), 'gates': set(), 'heads': defaultdict(int), 'from': defaultdict(int), 'deps': []}))
    for tid, (t0, gate, oname) in start.items():
        if tid not in hits or tid not in trips:
            continue
        rid, head, wk = trips[tid]
        seen = set()
        for sid, t in hits[tid]:
            if t <= t0:
                continue
            for code in near[sid]:
                e = per[code][rid]
                e['rides'][sid].append(t - t0)
                if code not in seen:
                    seen.add(code)
                    if gate:
                        e['gates'].add(gate)
                    e['heads'][head] += 1
                    e['from'][oname] += 1
                    if wk:
                        e['deps'].append(t0 % 1440)

    out = defaultdict(list)
    for code, rs in per.items():
        merged = {}
        for rid, e in rs.items():
            ag, short, long = routes.get(rid, (label, rid, ''))
            # Files that split one route by direction or variant: merge by name.
            k = (ag, short or long)
            m = merged.setdefault(k, {'ag': ag, 'short': short, 'long': long, 'rides': defaultdict(list), 'gates': set(), 'heads': defaultdict(int), 'from': defaultdict(int), 'deps': []})
            for sid, v in e['rides'].items():
                m['rides'][sid] += v
            m['gates'] |= e['gates']
            for h, n in e['heads'].items():
                m['heads'][h] += n
            for h, n in e['from'].items():
                m['from'][h] += n
            m['deps'] += e['deps']
        for e in merged.values():
            best = None
            walkable = any(near[sid][code] <= WALK_MAX for sid in e['rides'])
            for sid, v in e['rides'].items():
                if walkable and near[sid][code] > WALK_MAX:
                    continue
                ride = statistics.median(v)
                walk = near[sid][code] / (WALK_M_PER_MIN if walkable else 400)  # else a taxi or local ride, ~24 km/h
                if best is None or ride + walk < best[0]:
                    best = (ride + walk, sid, ride, near[sid][code])
            total, sid, ride, dist = best
            deps = sorted(set(e['deps']))
            day = [d for d in deps if 6 * 60 <= d < 21 * 60]
            gap = statistics.median([b - a for a, b in zip(day, day[1:])]) if len(day) > 1 else None
            origin = max(e['from'], key=e['from'].get)
            out[code].append({
                'agency': e['ag'], 'route': e['short'], 'name': e['long'],
                'head': (max(e['heads'], key=e['heads'].get) or '').strip(),
                'from': None if re.search(r'port auth|pabt', origin, re.I) else origin,
                'stop': title(stops[sid][0]['stop_name']) if stops[sid][0]['stop_name'].isupper() else stops[sid][0]['stop_name'], 'stopId': sid,
                'ride': round(ride), 'walkM': round(dist), 'walk': max(1, round(dist / WALK_M_PER_MIN)),
                'total': round(total), 'far': dist > WALK_MAX,
                'gates': sorted(e['gates'], key=lambda g: (len(g), g)),
                'weekdayTrips': len(deps), 'gap': round(gap) if gap else None,
                'first': f'{int(deps[0] // 60) % 24:02d}:{int(deps[0] % 60):02d}' if deps else None,
                'last': f'{int(deps[-1] // 60) % 24:02d}:{int(deps[-1] % 60):02d}' if deps else None,
            })
    print(f'  {label}: {len(origins)} origin stops, sample weekday {wed}, {sum(len(v) for v in out.values())} station-route pairs')
    return out


def main(bus_zip, rail_zip, extras):
    rz = zipfile.ZipFile(rail_zip)

    # Rail stations on lines that serve New York Penn.
    rroutes = {r['route_id']: r['route_short_name'] for r in rows(rz, 'routes.txt')}
    rtrips = {t['trip_id']: rroutes[t['route_id']] for t in rows(rz, 'trips.txt')}
    lines_at = defaultdict(set)
    for st in rows(rz, 'stop_times.txt'):
        ln = rtrips.get(st['trip_id'])
        if ln and ln not in NOT_PENN:
            lines_at[st['stop_id']].add(ln)
    stations = {}
    for s in rows(rz, 'stops.txt'):
        if s['stop_id'] in lines_at and s['stop_code'] != 'NY':
            stations[s['stop_code']] = {'name': title(s['stop_name']), 'pt': (float(s['stop_lat']), float(s['stop_lon'])), 'lines': sorted(lines_at[s['stop_id']])}

    near_pabt = lambda sid, s, pt: metres(pt, PABT_PT) <= ORIGIN_M
    feeds = [('NJ Transit', zipfile.ZipFile(bus_zip), lambda sid, s, pt: sid.startswith(PABT + '-'))]
    for label, path in extras:
        feeds.append((label, zipfile.ZipFile(path), manhattan if label in FERRIES else near_pabt))
    allopts = defaultdict(list)
    for label, z, test in feeds:
        for code, v in feed_options(z, label, stations, test).items():
            allopts[code] += v

    out = {}
    for code, opts in allopts.items():
        # Fastest first, but a route that hardly runs goes after ones that do.
        opts.sort(key=lambda o: (o['far'], o['weekdayTrips'] < 4, o['total']))
        if opts and not opts[0]['far']:
            opts = [o for o in opts if not o['far']]
        else:
            opts = sorted(opts, key=lambda o: (o['weekdayTrips'] < 4, o['walkM']))[:2]
        out[code] = opts[:KEEP]

    doc = {'built': datetime.date.today().isoformat(),
           'stations': {c: {'name': s['name'], 'lines': s['lines'], 'buses': out.get(c, [])} for c, s in sorted(stations.items(), key=lambda x: x[1]['name'])}}
    OUT.write_text(json.dumps(doc, separators=(',', ':')))
    have = sum(1 for c in stations if out.get(c) and not out[c][0]['far']); far = sum(1 for c in stations if out.get(c) and out[c][0]['far'])
    print(f'Wrote {OUT} ({OUT.stat().st_size // 1024} KB): {have} of {len(stations)} stations have a bus from Port Authority within a walk, {far} more within {FAR_MAX // 1000} km')
    for c, s in sorted(stations.items(), key=lambda x: x[1]['name']):
        b = out.get(c, [])
        print(f"{s['name']:<28} " + ('; '.join(f"{'' if o['agency'] == 'NJ Transit' else o['agency'] + ' '}{o['route']}{' from ' + o['from'] if o['from'] else ''} {o['total']}m ({'FAR %.1fkm' % (o['walkM']/1000) if o['far'] else str(o['walk'])+'m walk'}, {o['weekdayTrips']}/wkday{', gate ' + ','.join(o['gates'][:2]) if o['gates'] else ''})" for o in b[:3]) or '-'))


if __name__ == '__main__':
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2], [a.split('=', 1) for a in sys.argv[3:]])
