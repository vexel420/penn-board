#!/usr/bin/env python3
"""Build docs/isp-bus.json: Suffolk County Transit route 6 between the LIRR's
Central Islip and Patchogue stations and Long Island MacArthur Airport, for the
airport helper (owner, Nov 25). Suffolk County Transit's own timetable file
(https://tracksctbus.org/gtfs, no key). Fare from its fare data.

{"fare": 2.25, "from": {"Central Islip": {"wk": [[leaves station, at airport], ...], "sa": [...], "su": [...]},
                         "Patchogue": {...}}}

    curl -L -o sct.zip https://tracksctbus.org/gtfs
    python3 scripts/build-isp-bus.py sct.zip
"""
import csv, io, json, sys, zipfile
from collections import defaultdict
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / 'docs' / 'isp-bus.json'
AIRPORT = 'LI Macarthur Airport'
STATIONS = {'Central Islip': 'Central Islip LIRR', 'Patchogue': 'Patchogue LIRR'}


def rows(z, name):
    with z.open(name) as f:
        yield from csv.DictReader(io.TextIOWrapper(f, encoding='utf-8-sig'))


def mins(t):
    h, m, _ = map(int, t.split(':'))
    return h * 60 + m


def main(path):
    z = zipfile.ZipFile(path)
    stops = {s['stop_id']: s['stop_name'] for s in rows(z, 'stops.txt')}
    route6 = {r['route_id'] for r in rows(z, 'routes.txt') if r['route_short_name'] == '6'}
    cal = {c['service_id']: c for c in rows(z, 'calendar.txt')}
    trips = {t['trip_id']: t['service_id'] for t in rows(z, 'trips.txt') if t['route_id'] in route6}
    calls = defaultdict(list)
    for st in rows(z, 'stop_times.txt'):
        if st['trip_id'] in trips:
            calls[st['trip_id']].append((int(st['stop_sequence']), stops[st['stop_id']], mins(st['departure_time'] or st['arrival_time'])))
    out = {k: {'wk': [], 'sa': [], 'su': []} for k in STATIONS}
    for tid, cs in calls.items():
        cs.sort()
        ap = next((c for c in cs if c[1] == AIRPORT), None)
        c = cal.get(trips[tid])
        if not ap or not c:
            continue
        for key, prefix in STATIONS.items():
            st = next((x for x in cs if x[1].startswith(prefix) and x[0] < ap[0]), None)
            if not st:
                continue
            for d, day in (('wk', 'wednesday'), ('sa', 'saturday'), ('su', 'sunday')):
                if c[day] == '1':
                    out[key][d].append([st[2], ap[2]])
    for v in out.values():
        for k in v:
            v[k] = sorted(v[k])
    fare = next((float(f['price']) for f in rows(z, 'fare_attributes.txt') if f['fare_id'] == 'FULL_FARE'), None)
    OUT.write_text(json.dumps({'fare': fare, 'from': out}, separators=(',', ':')))
    print(f'Wrote {OUT}: fare {fare}; ' + '; '.join(f'{k}: ' + ', '.join(f'{d} {len(x)}' for d, x in v.items()) for k, v in out.items()))


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
