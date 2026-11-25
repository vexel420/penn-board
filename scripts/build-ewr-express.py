#!/usr/bin/env python3
"""Build docs/ewr-express.json: Newark Airport Express (Coach USA) departures
from Port Authority Bus Terminal to Newark Airport's terminals, from the Coach
USA timetable file (the owner's NJ Transit developer portal download, "Coach
USA", gtfs.zip). Fare $23.50 one way (newarkairport.com, Nov 2026).

{"days": {"wk": [[minutes at Port Authority, {"A": m, "B": m, "C": m}], ...], "sa": [...], "su": [...]},
 "until": "YYYYMMDD"}

The file isn't public, so this is rebuilt by hand when Coach USA's schedule
changes (its file runs to `until`).

    python3 scripts/build-ewr-express.py gtfs.zip
"""
import csv, io, json, sys, zipfile
from collections import defaultdict
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / 'docs' / 'ewr-express.json'


def rows(z, name):
    with z.open(name) as f:
        yield from csv.DictReader(io.TextIOWrapper(f, encoding='utf-8-sig'))


def mins(t):
    h, m, _ = map(int, t.split(':'))
    return h * 60 + m


def main(path):
    z = zipfile.ZipFile(path)
    agency = {a['agency_id'] for a in rows(z, 'agency.txt') if a['agency_name'] == 'Newark Airport Express'}
    routes = {r['route_id'] for r in rows(z, 'routes.txt') if r['agency_id'] in agency}
    cal = {c['service_id']: c for c in rows(z, 'calendar.txt')}
    trips = {t['trip_id']: t['service_id'] for t in rows(z, 'trips.txt') if t['route_id'] in routes}
    stops = {s['stop_id']: s['stop_name'] for s in rows(z, 'stops.txt')}
    calls = defaultdict(list)
    for st in rows(z, 'stop_times.txt'):
        if st['trip_id'] in trips:
            calls[st['trip_id']].append((int(st['stop_sequence']), stops[st['stop_id']], st['departure_time'] or st['arrival_time']))
    days = {'wk': [], 'sa': [], 'su': []}
    until = '0'
    for tid, cs in calls.items():
        cs.sort()
        pa = next((c for c in cs if c[1] == 'Port Authority Bus Terminal'), None)
        if not pa:
            continue  # toward the city
        term = {c[1][-1]: mins(c[2]) for c in cs if c[1].startswith('Terminal ') and c[0] > pa[0]}
        c = cal.get(trips[tid])
        if not c or not term:
            continue
        until = max(until, c['end_date'])
        for k, d in (('wk', 'wednesday'), ('sa', 'saturday'), ('su', 'sunday')):
            if c[d] == '1':
                days[k].append([mins(pa[2]), term])
    for v in days.values():
        v.sort()
    OUT.write_text(json.dumps({'days': days, 'until': until}, separators=(',', ':')))
    print(f'Wrote {OUT}: ' + ', '.join(f'{k} {len(v)} trips' for k, v in days.items()) + f', until {until}')
    print('weekday first/last:', days['wk'][0], days['wk'][-1])


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
