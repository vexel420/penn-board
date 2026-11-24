#!/usr/bin/env python3
"""Build docs/njt-bus-finder.json: NJ Transit buses from Port Authority Bus
Terminal that get close to each NJ Transit rail station, for rail outages and
strikes (owner, Nov 2026).

Inputs are NJ Transit's own timetable files (GTFS) from the developer portal:
the bus file (GTFSG2/getGTFS) and the rail file (GTFSRT/getGTFS).

For each rail station on a line that serves New York Penn, every bus route
leaving Port Authority (stop 26229, the gates are its platforms) that stops
within WALK_MAX metres of the station is listed with the bus stop it uses
(the one that gets you there soonest, walking included), the usual ride time
from Port Authority, the walk, the gates it leaves from and how often it runs
on weekdays. The board joins this with live departures (getBusDV, stop PABT).

    python3 scripts/build-njt-bus-finder.py bus.zip rail.zip
"""
import csv, io, json, math, statistics, sys, zipfile
from collections import defaultdict
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / 'docs' / 'njt-bus-finder.json'
PABT = '26229'
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


def main(bus_zip, rail_zip):
    bz, rz = zipfile.ZipFile(bus_zip), zipfile.ZipFile(rail_zip)

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

    # Bus stops near each station.
    bstops, near = {}, defaultdict(dict)
    for s in rows(bz, 'stops.txt'):
        if s['stop_id'].startswith(PABT):
            continue
        pt = (float(s['stop_lat']), float(s['stop_lon']))
        bstops[s['stop_id']] = (title(s['stop_name']), pt)
    for code, st in stations.items():
        la, lo = st['pt']
        for sid, (_, pt) in bstops.items():
            if abs(pt[0] - la) < 0.08 and abs(pt[1] - lo) < 0.1:
                d = metres(st['pt'], pt)
                if d <= FAR_MAX:
                    near[sid][code] = d

    # Weekday bus trips (a Wednesday in the file's range).
    wed = {c['service_id'] for c in rows(bz, 'calendar.txt') if c['wednesday'] == '1'}
    broutes = {r['route_id']: (r['route_short_name'], title(r['route_long_name'])) for r in rows(bz, 'routes.txt')}
    btrips = {t['trip_id']: (t['route_id'], t['trip_headsign'], t['service_id'] in wed) for t in rows(bz, 'trips.txt')}

    # One pass over stop_times: trips that leave Port Authority, and when they reach stops near stations.
    start = {}                           # trip -> (time at PABT, gate)
    hits = defaultdict(list)             # trip -> [(stop, time)]
    for st in rows(bz, 'stop_times.txt'):
        sid, tid = st['stop_id'], st['trip_id']
        if sid.startswith(PABT + '-'):
            if tid not in start:
                start[tid] = (mins(st['departure_time']), sid.split('-', 1)[1])
        elif sid in near:
            hits[tid].append((sid, mins(st['arrival_time'])))

    per = defaultdict(lambda: defaultdict(lambda: {'rides': defaultdict(list), 'gates': set(), 'heads': defaultdict(int), 'deps': []}))
    for tid, (t0, gate) in start.items():
        if tid not in hits or tid not in btrips:
            continue
        rid, head, weekday = btrips[tid]
        seen = set()
        for sid, t in hits[tid]:
            if t <= t0:
                continue
            for code in near[sid]:
                e = per[code][rid]
                e['rides'][sid].append(t - t0)
                if code not in seen:
                    seen.add(code)
                    if gate and gate != '..':
                        e['gates'].add(gate.split('_')[0])
                    e['heads'][head] += 1
                    if weekday:
                        e['deps'].append(t0 % 1440)

    out = {}
    for code, routes in per.items():
        opts = []
        for rid, e in routes.items():
            best = None
            walkable = any(near[sid][code] <= WALK_MAX for sid in e['rides'])
            for sid, v in e['rides'].items():
                if walkable and near[sid][code] > WALK_MAX:
                    continue
                walk = near[sid][code] / WALK_M_PER_MIN
                ride = statistics.median(v)
                if not walkable:
                    walk = near[sid][code] / 400  # a taxi or local ride, about 24 km/h
                if best is None or ride + walk < best[0]:
                    best = (ride + walk, sid, ride, near[sid][code])
            total, sid, ride, dist = best
            deps = sorted(e['deps'])
            day = [d for d in deps if 6 * 60 <= d < 21 * 60]
            gap = statistics.median([b - a for a, b in zip(day, day[1:])]) if len(day) > 1 else None
            short, long = broutes.get(rid, (rid, ''))
            opts.append({
                'route': short, 'name': long,
                'head': max(e['heads'], key=e['heads'].get).strip(),
                'stop': bstops[sid][0], 'stopId': sid,
                'ride': round(ride), 'walkM': round(dist), 'walk': max(1, round(dist / WALK_M_PER_MIN)),
                'total': round(total), 'far': dist > WALK_MAX,
                'gates': sorted(e['gates'], key=lambda g: (len(g), g)),
                'weekdayTrips': len(deps), 'gap': round(gap) if gap else None,
                'first': f'{int(deps[0] // 60) % 24:02d}:{int(deps[0] % 60):02d}' if deps else None,
                'last': f'{int(deps[-1] // 60) % 24:02d}:{int(deps[-1] % 60):02d}' if deps else None,
            })
        # Fastest first, but a route that hardly runs goes after ones that do.
        opts.sort(key=lambda o: (o['far'], o['weekdayTrips'] < 4, o['total']))
        if opts and not opts[0]['far']:
            opts = [o for o in opts if not o['far']]
        else:
            opts = sorted(opts, key=lambda o: (o['weekdayTrips'] < 4, o['walkM']))[:2]
        out[code] = opts[:KEEP]

    doc = {'built': zipfile.ZipFile(bus_zip).getinfo('stops.txt').date_time[:3],
           'stations': {c: {'name': s['name'], 'lines': s['lines'], 'buses': out.get(c, [])} for c, s in sorted(stations.items(), key=lambda x: x[1]['name'])}}
    OUT.write_text(json.dumps(doc, separators=(',', ':')))
    have = sum(1 for c in stations if out.get(c) and not out[c][0]['far']); far = sum(1 for c in stations if out.get(c) and out[c][0]['far'])
    print(f'Wrote {OUT} ({OUT.stat().st_size // 1024} KB): {have} of {len(stations)} stations have a bus from Port Authority within a walk, {far} more within {FAR_MAX // 1000} km')
    for c, s in sorted(stations.items(), key=lambda x: x[1]['name']):
        b = out.get(c, [])
        print(f"{s['name']:<28} " + ('; '.join(f"{o['route']} {o['total']}m ({'FAR %.1fkm' % (o['walkM']/1000) if o['far'] else str(o['walk'])+'m walk'}, {o['weekdayTrips']}/wkday, gate {','.join(o['gates'][:2])})" for o in b[:3]) or '-'))


if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
