#!/usr/bin/env python3
"""Build docs/njt-timetable.json: NJ Transit's rail timetable in the same
compact form as docs/lirr-timetable.json, for "Other options" on a delayed
NJ Transit train (owner, Nov 24): direct or one-change trips from Penn,
live once the train is on the board (matched by train number).

Stations are NJ Transit's two-letter codes (the live board's STATION_2CHAR),
so a delayed train's stops match exactly. Secaucus's upper and lower levels
are one station ("SE"). Light rail is left out.

The file comes from NJ Transit's developer API with the owner's login, through
the relay's locked /njt-rail-gtfs route (the weekly rebuild proves it's this
repository's workflow with a GitHub-signed token).

    python3 scripts/build-njt-timetable.py rail.zip
"""
import csv, datetime, io, json, sys, zipfile
from collections import defaultdict
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / 'docs' / 'njt-timetable.json'
PENN = 'NY'
SAME = {'TS': 'SE'}                 # Secaucus lower level -> Secaucus
LIGHT_RAIL = {'HBLR', 'NLR', 'RVLN'}


def rows(z, name):
    with z.open(name) as f:
        yield from csv.DictReader(io.TextIOWrapper(f, encoding='utf-8-sig'))


def mins(t):
    h, m, _ = map(int, t.split(':'))
    return h * 60 + m


# Names as riders know them (NJ Transit's file abbreviates some).
NAME_FIX = {'NA': 'Newark Airport', 'JA': 'Jersey Avenue', 'PJ': 'Princeton Junction', 'TR': 'Trenton',
            'UV': 'Montclair State University', '23': 'Wayne/Route 23', 'UF': 'Ho-Ho-Kus', '17': 'Ramsey Route 17',
            'SE': 'Secaucus Junction', 'NY': 'New York Penn Station', 'ND': 'Newark Broad St', 'NP': 'Newark Penn'}


def title(s):
    import re
    t = ' '.join(w if w in ('NJ', 'NY') else w.capitalize() for w in s.split())
    return re.sub(r'([-/])([a-z])', lambda m: m.group(1) + m.group(2).upper(), t).replace(' St.', ' St')


def main(path):
    z = zipfile.ZipFile(path)
    names = set(z.namelist())
    dates = defaultdict(set)
    if 'calendar.txt' in names:
        days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
        for c in rows(z, 'calendar.txt'):
            d = datetime.datetime.strptime(c['start_date'], '%Y%m%d').date()
            end = datetime.datetime.strptime(c['end_date'], '%Y%m%d').date()
            while d <= end:
                if c[days[d.weekday()]] == '1':
                    dates[d.strftime('%Y%m%d')].add(c['service_id'])
                d += datetime.timedelta(days=1)
    for c in rows(z, 'calendar_dates.txt'):
        (dates[c['date']].add if c['exception_type'] == '1' else dates[c['date']].discard)(c['service_id'])
    code = {}
    stop_names = {}
    for s in rows(z, 'stops.txt'):
        c = SAME.get(s['stop_code'], s['stop_code'])
        code[s['stop_id']] = c
        stop_names.setdefault(c, NAME_FIX.get(c) or title(s['stop_name']))
    routes = {r['route_id']: r['route_short_name'] for r in rows(z, 'routes.txt')}
    trips = {t['trip_id']: t for t in rows(z, 'trips.txt') if routes.get(t['route_id']) not in LIGHT_RAIL}
    calls = defaultdict(list)
    for st in rows(z, 'stop_times.txt'):
        if st['trip_id'] in trips:
            calls[st['trip_id']].append((int(st['stop_sequence']), code[st['stop_id']], st['departure_time'] or st['arrival_time']))
    stop_ix, svc_ix, out = {}, {}, []
    for tid, cs in calls.items():
        cs.sort()
        t = trips[tid]
        flat = []
        for _, c, tm in cs:
            flat += [stop_ix.setdefault(c, len(stop_ix)), mins(tm)]
        last = cs[-1][1]
        out.append([routes[t['route_id']], NAME_FIX.get(last) or title(t.get('trip_headsign', '')), t.get('trip_short_name', ''), svc_ix.setdefault(t['service_id'], len(svc_ix)), flat])
    out.sort(key=lambda x: x[4][1])
    doc = {'penn': PENN, 'stops': sorted(stop_ix, key=stop_ix.get), 'names': {c: stop_names.get(c, c) for c in stop_ix},
           'svc': sorted(svc_ix, key=svc_ix.get),
           'dates': {d: sorted(svc_ix[x] for x in v if x in svc_ix) for d, v in sorted(dates.items()) if v & set(svc_ix)},
           'trips': out}
    OUT.write_text(json.dumps(doc, separators=(',', ':')))
    from_penn = sum(1 for x in out if stop_ix[PENN] in x[4][0:-2:2])
    print(f'Wrote {OUT} ({OUT.stat().st_size // 1024} KB): {len(out)} trains ({from_penn} leave Penn), {len(doc["dates"])} dates')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
