#!/usr/bin/env python3
"""Build docs/subway-guide.json: the fastest way to where each Penn line goes,
for when that line isn't stopping at Penn (owner, Nov 2026: pick by travel
time, stay on trains, no street walks).

For each line at Penn's two subway stations (1 2 3 at 34 St-Penn Station on
7 Av, A C E at 34 St-Penn Station on 8 Av) and each direction, the script
takes a reference stop where that line is heading (HUBS below) and finds the
fastest plans from Penn using other lines:
  - one train straight there, or
  - one train, a change inside the subway (the MTA's own transfers, with its
    minimum transfer time), and a second train.
The missing line itself is never used. Time = time on the trains (median of
the timetable) + transfer time + half the second line's usual gap (the
average wait). Done twice: daytime (6 AM-9 PM) and late night (midnight-5 AM),
since some lines don't run overnight. The board takes the first plan whose
first train is running.

    python3 scripts/build-subway-guide.py gtfs_subway.zip
"""
import csv, io, json, statistics, sys, zipfile
from collections import defaultdict
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / 'docs' / 'subway-guide.json'
PENN = {'128': ['1', '2', '3'], 'A28': ['A', 'C', 'E']}
# Where each line is heading from Penn, per direction: a main stop on its own
# route (its last stop, or the hub of the area it serves).
HUBS = {
    ('1', 'N'): '112',  # 168 St-Washington Hts
    ('1', 'S'): '142',  # South Ferry
    ('2', 'N'): '222',  # 149 St-Grand Concourse (the Bronx)
    ('2', 'S'): '247',  # Flatbush Av-Brooklyn College
    ('3', 'N'): '301',  # Harlem-148 St
    ('3', 'S'): '257',  # New Lots Av
    ('A', 'N'): 'A09',  # 168 St
    ('A', 'S'): 'A55',  # Euclid Av (where it goes on to the Rockaways and Lefferts)
    ('C', 'N'): 'A09',  # 168 St
    ('C', 'S'): 'A51',  # Broadway Junction (on to Euclid Av)
    ('E', 'N'): 'G14',  # Jackson Hts-Roosevelt Av (Queens)
    ('E', 'S'): 'E01',  # World Trade Center
}
PERIODS = {'day': (6 * 60, 21 * 60), 'night': (0, 5 * 60)}
KEEP = 4  # plans kept per line, direction and period


def rows(z, name):
    with z.open(name) as f:
        yield from csv.DictReader(io.TextIOWrapper(f, encoding='utf-8-sig'))


def minutes(t):
    h, m, s = map(int, t.split(':'))
    return h * 60 + m + s / 60


def main(zip_path):
    z = zipfile.ZipFile(zip_path)
    weekday = {c['service_id'] for c in rows(z, 'calendar.txt') if c['wednesday'] == '1'}
    names = {s['stop_id']: s['stop_name'] for s in rows(z, 'stops.txt')}
    trips = {t['trip_id']: t['route_id'] for t in rows(z, 'trips.txt') if t['service_id'] in weekday}
    calls = defaultdict(list)
    for st in rows(z, 'stop_times.txt'):
        if st['trip_id'] in trips:
            sid = st['stop_id']
            calls[st['trip_id']].append((int(st['stop_sequence']), sid[:-1] if sid[-1] in 'NS' else sid, sid[-1], minutes(st['departure_time'])))
    # In-system transfers between stations (no street walks), in minutes.
    xfer = {}
    for t in rows(z, 'transfers.txt'):
        if t['from_stop_id'] != t['to_stop_id']:
            xfer.setdefault(t['from_stop_id'], {})[t['to_stop_id']] = int(t['min_transfer_time'] or 0) / 60

    def legs(period):
        """(route, dir, from, to) -> median minutes; (route, dir, stop) -> median gap."""
        lo, hi = PERIODS[period]
        ride, deps = defaultdict(list), defaultdict(list)
        for tid, cs in calls.items():
            cs.sort()
            route = trips[tid].rstrip('X') if len(trips[tid]) == 2 and trips[tid].endswith('X') else trips[tid]
            for i, (_, a, d, ta) in enumerate(cs):
                if not lo <= ta % 1440 < hi:
                    continue
                deps[(route, d, a)].append(ta)
                for _, b, _, tb in cs[i + 1:]:
                    ride[(route, d, a, b)].append(tb - ta)
        r = {k: statistics.median(v) for k, v in ride.items()}
        gap = {}
        for k, v in deps.items():
            v.sort()
            g = [y - x for x, y in zip(v, v[1:]) if y > x]
            gap[k] = statistics.median(g) if g else 60
        return r, gap

    out = {}
    for period in PERIODS:
        ride, gap = legs(period)
        by_from = defaultdict(list)  # (route, dir, from) -> [(to, mins)]
        for (route, d, a, b), m in ride.items():
            by_from[(route, d, a)].append((b, m))
        for stn, lines in PENN.items():
            for line in lines:
                for d in 'NS':
                    hub = HUBS[(line, d)]
                    # Arriving anywhere in the hub's station complex counts (74 St-Broadway
                    # for Jackson Hts-Roosevelt Av; Chambers St for World Trade Center).
                    at_hub = {hub, *xfer.get(hub, {})}
                    plans = []
                    for r1 in lines:
                        if r1 == line:
                            continue
                        for d1 in 'NS':
                            for (x, m1) in by_from.get((r1, d1, stn), []):
                                if x in at_hub:
                                    plans.append({'mins': m1, 'legs': [{'route': r1, 'dir': d1, 'to': x}]})
                                    continue
                                for x2, tmin in [(x, 0)] + list(xfer.get(x, {}).items()):
                                    for (r2, d2, a), dests in by_from.items():
                                        if a != x2 or r2 in (line, r1):
                                            continue
                                        for b, m2 in dests:
                                            if b in at_hub:
                                                total = m1 + tmin + gap.get((r2, d2, x2), 10) / 2 + m2
                                                plans.append({'mins': total, 'legs': [{'route': r1, 'dir': d1, 'to': x}, {'route': r2, 'dir': d2, 'from': x2, 'to': hub}]})
                    # Best per shape (which change, which second line); then merge first
                    # lines that do the same thing within 2 minutes ("the A or C").
                    plans.sort(key=lambda p: p['mins'])
                    merged = []
                    for p in plans:
                        key = tuple((l.get('from'), l['to'], l['route'] if i else l['dir']) for i, l in enumerate(p['legs']))
                        same = next((q for q in merged if q['key'] == key), None)
                        if same:
                            if p['mins'] - same['mins'] <= 2 and p['legs'][0]['route'] not in same['first']:
                                same['first'].append(p['legs'][0]['route'])
                            continue
                        if len(merged) < KEEP:
                            merged.append({'key': key, 'mins': p['mins'], 'first': [p['legs'][0]['route']], 'legs': p['legs']})
                    out.setdefault(stn, {}).setdefault(line, {}).setdefault(d, {})[period] = [
                        {'mins': round(m['mins']), 'first': m['first'], 'firstDir': m['legs'][0]['dir'],
                         'change': m['legs'][0]['to'] if len(m['legs']) > 1 else None,
                         'changeTo': m['legs'][1]['from'] if len(m['legs']) > 1 else None,
                         'then': m['legs'][1]['route'] if len(m['legs']) > 1 else None}
                        for m in merged]
    doc = {'hubs': {f'{l}|{d}': h for (l, d), h in HUBS.items()}, 'names': {}, 'plans': out}
    used = set(HUBS.values())
    for stn in out.values():
        for dirs in stn.values():
            for per in dirs.values():
                for plist in per.values():
                    for p in plist:
                        used.update(x for x in (p['change'], p['changeTo']) if x)
    doc['names'] = {k: names.get(k, k) for k in sorted(used)}
    OUT.write_text(json.dumps(doc, separators=(',', ':')))
    print(f'Wrote {OUT} ({OUT.stat().st_size // 1024} KB)')
    for stn, ls in out.items():
        for line, ds in ls.items():
            for d, per in ds.items():
                for period, plist in per.items():
                    best = plist[0] if plist else None
                    if best:
                        how = '/'.join(best['first']) + (f" to {names.get(best['change'])} then {best['then']}" if best['then'] else ' direct')
                        print(f'{line} {d} {period}: {how} ({best["mins"]} min to {names.get(HUBS[(line, d)])})')
                    else:
                        print(f'{line} {d} {period}: no plan (the board falls back to a direct line)')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
