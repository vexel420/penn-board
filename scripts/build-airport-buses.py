#!/usr/bin/env python3
"""Build docs/airport-buses.json: subway + bus trips from Penn to JFK and
LaGuardia (owner, Nov 25: buses in the airport helper; JFK by bus is the
cheapest, $3.00, since AirTrain is free from Lefferts Blvd).

For each MTA bus route that reaches an airport stop (AIRPORT_STOPS), the
fastest way from Penn: a subway ride (from 34 St-Penn Station, either one,
at most one change) to a station near a stop of that bus, a short walk, the
bus, and (JFK, Lefferts Blvd) the free AirTrain to the terminals. Times are
timetable medians, half the bus's daytime gap for the wait. The board shows
the bus's live arrivals (MTA Bus Time, stop code `board`).

    python3 scripts/build-airport-buses.py gtfs_subway.zip gtfs_q.zip gtfs_b.zip gtfs_busco.zip gtfs_m.zip
"""
import csv, io, json, math, statistics, sys, zipfile
from collections import defaultdict
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / 'docs' / 'airport-buses.json'
PENN = {'A28': ('A', 'C', 'E'), '128': ('1', '2', '3')}
WALK_PENN = 8            # minutes between the two Penn subway stations
NEAR_M = 250             # a bus stop this close to a subway station
WALK_M_PER_MIN = 75
CHANGE_MIN = 3
# Airport stops by name (as in the MTA's bus files) -> airport, what it reaches.
AIRPORT_STOPS = [
    ('JFK', 'LEFFERTS BLVD/AIRTRAIN STATION', 'Lefferts Blvd AirTrain', 'all terminals by the free AirTrain'),
    ('JFK', 'JFK AIRPORT/TERMINAL 8', 'Terminal 8', 'Terminal 8'),
    ('LGA', 'LAGUARDIA/TERMINAL B', 'Terminal B', 'Terminal B'),
    ('LGA', 'LAGUARDIA AIRPORT/TERMINAL B', 'Terminal B', 'Terminal B'),
    ('LGA', 'LGA/TERMINAL B', 'Terminal B', 'Terminal B'),
    ('LGA', 'LAGUARDIA/TERMINAL C', 'Terminal C', 'Terminal C'),
    ('LGA', 'LAGUARDIA AIRPORT/TERMINAL C', 'Terminal C', 'Terminal C'),
]
AIRTRAIN_LEFFERTS_MIN = 10  # Lefferts Blvd to the terminals, with the wait


def rows(z, name):
    with z.open(name) as f:
        yield from csv.DictReader(io.TextIOWrapper(f, encoding='utf-8-sig'))


def mins(t):
    h, m, s = map(int, t.strip().split(':'))
    return h * 60 + m + s / 60


def metres(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    return 6371000 * math.hypot((lo2 - lo1) * math.cos((la1 + la2) / 2), la2 - la1)


def weekday_trips(z):
    wed = {c['service_id'] for c in rows(z, 'calendar.txt') if c['wednesday'] == '1'}
    return wed


def subway_times(zpath):
    """Fastest daytime minutes from Penn to every station: [(minutes, legs)], at most one change."""
    z = zipfile.ZipFile(zpath)
    wed = weekday_trips(z)
    trips = {t['trip_id']: t['route_id'] for t in rows(z, 'trips.txt') if t['service_id'] in wed}
    calls = defaultdict(list)
    for st in rows(z, 'stop_times.txt'):
        if st['trip_id'] in trips:
            sid = st['stop_id']
            calls[st['trip_id']].append((int(st['stop_sequence']), sid[:-1] if sid[-1] in 'NS' else sid, mins(st['departure_time'])))
    xfer = defaultdict(dict)
    for t in rows(z, 'transfers.txt'):
        if t['from_stop_id'] != t['to_stop_id']:
            xfer[t['from_stop_id']][t['to_stop_id']] = int(t['min_transfer_time'] or 0) / 60
    ride, deps = defaultdict(list), defaultdict(list)
    for tid, cs in calls.items():
        cs.sort()
        r = trips[tid]
        r = r[:-1] if len(r) == 2 and r.endswith('X') else r
        for i, (_, a, ta) in enumerate(cs):
            if not 6 * 60 <= ta % 1440 < 21 * 60:
                continue
            deps[(r, a)].append(ta)
            for _, b, tb in cs[i + 1:]:
                ride[(r, a, b)].append(tb - ta)
    net = defaultdict(list)
    for (r, a, b), v in ride.items():
        net[a].append((r, b, statistics.median(v)))
    gap = {}
    for k, v in deps.items():
        v.sort()
        g = [y - x for x, y in zip(v, v[1:]) if y > x]
        gap[k] = statistics.median(g) if g else 30
    stations = {s['stop_id']: (s['stop_name'], float(s['stop_lat']), float(s['stop_lon'])) for s in rows(z, 'stops.txt') if s.get('location_type') == '1'}
    best = {}

    def offer(sid, t, legs):
        if sid not in best or t < best[sid][0]:
            best[sid] = (t, legs)
    for start, lines in PENN.items():
        extra = 0 if start == 'A28' else 0  # either Penn station; the board shows which
        for r, b, m in net[start]:
            if r not in lines:
                continue
            t1 = extra + gap.get((r, start), 10) / 2 + m
            offer(b, t1, [(r, start, b, round(m))])
            for b2, tx in [(b, 0)] + list(xfer.get(b, {}).items()):
                for r2, c, m2 in net.get(b2, []):
                    if r2 == r:
                        continue
                    offer(c, t1 + max(tx, CHANGE_MIN) + gap.get((r2, b2), 10) / 2 + m2, [(r, start, b, round(m)), (r2, b2, c, round(m2))])
    return best, stations


def main(subway_zip, bus_zips):
    best, stations = subway_times(subway_zip)
    out = defaultdict(list)
    for path in bus_zips:
        z = zipfile.ZipFile(path)
        stops = {s['stop_id']: (s['stop_name'], float(s['stop_lat']), float(s['stop_lon'])) for s in rows(z, 'stops.txt')}
        targets = {sid: next(a for a in AIRPORT_STOPS if a[1] == n) for sid, (n, *_) in stops.items() if any(a[1] == n for a in AIRPORT_STOPS)}
        if not targets:
            continue
        near = defaultdict(list)  # bus stop -> [(station, metres)]
        for sid, (n, la, lo) in stops.items():
            for st, (sn, sla, slo) in stations.items():
                if abs(sla - la) < 0.003 and abs(slo - lo) < 0.004:
                    d = metres((la, lo), (sla, slo))
                    if d <= NEAR_M:
                        near[sid].append((st, d))
        wed = weekday_trips(z)
        routes = {r['route_id']: r['route_short_name'] for r in rows(z, 'routes.txt')}
        trips = {t['trip_id']: (routes[t['route_id']], t['service_id'] in wed) for t in rows(z, 'trips.txt')}
        calls = defaultdict(list)
        for st in rows(z, 'stop_times.txt'):
            if st['stop_id'] in near or st['stop_id'] in targets:
                calls[st['trip_id']].append((int(st['stop_sequence']), st['stop_id'], mins(st['departure_time'])))
        acc = defaultdict(lambda: {'ride': [], 'deps': []})
        for tid, cs in calls.items():
            if tid not in trips:
                continue
            route, wk = trips[tid]
            cs.sort()
            for i, (_, a, ta) in enumerate(cs):
                if a not in near:
                    continue
                for _, b, tb in cs[i + 1:]:
                    if b in targets:
                        e = acc[(route, a, b)]
                        e['ride'].append(tb - ta)
                        if wk:
                            e['deps'].append(ta % 1440)
        for (route, a, b), e in acc.items():
            airport, _, place, reaches = targets[b]
            day = sorted(d for d in e['deps'] if 6 * 60 <= d < 21 * 60)
            g = [y - x for x, y in zip(day, day[1:]) if y > x]
            gap = statistics.median(g) if g else None
            if not gap or gap > 40:
                continue  # hardly runs by day
            ride = statistics.median(e['ride'])
            for st, d in near[a]:
                if st not in best and st not in PENN:
                    continue
                sub_t, legs = best.get(st, (0, []))
                walk = d / WALK_M_PER_MIN
                total = sub_t + walk + CHANGE_MIN + gap / 2 + ride + (AIRTRAIN_LEFFERTS_MIN if 'AirTrain' in place else 0)
                out[(airport, route, place)].append({
                    'airport': airport, 'route': route, 'board': a, 'boardName': stops[a][0], 'alight': place, 'reaches': reaches,
                    'subway': [{'route': l[0], 'from': l[1], 'to': l[2], 'mins': l[3]} for l in legs],
                    'subwayMins': round(sub_t), 'walk': max(1, round(walk)), 'busMins': round(ride), 'gap': round(gap),
                    'airtrain': AIRTRAIN_LEFFERTS_MIN if 'AirTrain' in place else 0, 'total': round(total),
                    'station': stations.get(st, (st,))[0],
                })
    # One plan per route and airport: the boarding stop with the quickest trip,
    # and the ride from it to each airport stop it serves (Terminal B and C).
    byroute = {}
    for (airport, route, place), v in out.items():
        for p in v:
            k = (airport, route)
            if k not in byroute or p['total'] < byroute[k]['total']:
                byroute[k] = dict(p)
    for k, p in byroute.items():
        p['to'] = {}
        for (airport, route, place), v in out.items():
            if (airport, route) != k:
                continue
            same = [x for x in v if x['board'] == p['board']]
            if same:
                p['to'][place] = min(x['busMins'] for x in same)
    doc = {'plans': sorted(byroute.values(), key=lambda p: (p['airport'], p['total'])),
           'names': {sid: n for sid, (n, *_) in stations.items()}}
    OUT.write_text(json.dumps(doc, separators=(',', ':')))
    print(f'Wrote {OUT}')
    for p in doc['plans']:
        sub = ' then '.join(f"{l['route']} {doc['names'].get(l['from'], l['from'])}->{doc['names'].get(l['to'], l['to'])} {l['mins']}m" for l in p['subway']) or 'walk'
        print(f"{p['airport']} {p['route']:>8}: {sub} | walk {p['walk']} | bus from {p['boardName']} ({p['board']}) every {p['gap']} to {p['to']} | total {p['total']} min")


if __name__ == '__main__':
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2:])
