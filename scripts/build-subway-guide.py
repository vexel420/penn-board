#!/usr/bin/env python3
"""Build docs/subway-guide.json: the fastest way to where each Penn line goes,
for when that line isn't stopping at Penn (owner, Nov 2026: by travel time,
on trains, up to two changes).

For each line at Penn's two subway stations (1 2 3 at 34 St-Penn Station on
7 Av, A C E at 34 St-Penn Station on 8 Av) and each direction, the script
takes a reference stop where that line is heading (HUBS below) and finds the
fastest plans from Penn using other lines: a direct train, or up to two
changes inside the subway (the MTA's own transfers and minimum transfer
times; no street walks). The missing line itself is never used.

Time = time on the trains (timetable medians) + transfer times + half each
later line's usual gap (the average wait), plus 2 minutes per change so a
change has to save time to be suggested. Done for daytime (6 AM-9 PM) and
late night (midnight-5 AM), since some lines (the 42 St shuttle, the C) don't
run overnight. Plans that differ only in which of two lines to take ("the 2
or 3", "the 4 or 5") are merged when within 2 minutes.

It also checks walking through Penn Station to the other subway station
(WALK_MIN): offered as a second choice when a train from there goes straight
to the same place and the total is no more than 5 minutes slower.

The board takes the first plan whose first train is running.

    python3 scripts/build-subway-guide.py gtfs_subway.zip
"""
import csv, io, json, statistics, sys, zipfile
from collections import defaultdict
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / 'docs' / 'subway-guide.json'
PENN = {'128': ['1', '2', '3'], 'A28': ['A', 'C', 'E']}
OTHER = {'128': 'A28', 'A28': '128'}
WALK_MIN = 8  # through Penn Station between the 7 Av and 8 Av stations
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
# Subway rides the airport helper needs (route, from, to): median minutes.
RIDES = [('E', 'A28', 'G06'),  # Penn to Sutphin Blvd-Archer Av-JFK (AirTrain JFK)
         ('A', 'A28', 'H03'),  # Penn to Howard Beach-JFK (AirTrain JFK)
         ('E', 'A28', 'G14')]  # Penn to Jackson Hts-Roosevelt Av (Q70 to LaGuardia)
CHANGE_PENALTY = 2
MAX_LEGS = 3
KEEP = 4


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
    xfer = defaultdict(dict)  # in-system transfers between stations, minutes
    for t in rows(z, 'transfers.txt'):
        if t['from_stop_id'] != t['to_stop_id']:
            xfer[t['from_stop_id']][t['to_stop_id']] = int(t['min_transfer_time'] or 0) / 60

    def network(period):
        """stop -> [(route, dir, to, minutes)], and (route, dir, stop) -> usual gap."""
        lo, hi = PERIODS[period]
        ride, deps = defaultdict(list), defaultdict(list)
        for tid, cs in calls.items():
            cs.sort()
            r = trips[tid]
            r = r[:-1] if len(r) == 2 and r.endswith('X') else r
            for i, (_, a, d, ta) in enumerate(cs):
                if not lo <= ta % 1440 < hi:
                    continue
                deps[(r, d, a)].append(ta)
                for _, b, _, tb in cs[i + 1:]:
                    ride[(r, d, a, b)].append(tb - ta)
        out = defaultdict(list)
        for (r, d, a, b), v in ride.items():
            out[a].append((r, d, b, statistics.median(v)))
        gap = {}
        for k, v in deps.items():
            v.sort()
            g = [y - x for x, y in zip(v, v[1:]) if y > x]
            gap[k] = statistics.median(g) if g else 60
        return out, gap

    def search(net, gap, start, first_lines, missing, at_hub, max_legs=MAX_LEGS):
        """All plans (score, minutes, legs) from start to the hub; legs = [(route, dir, from, to)]."""
        found = []
        frontier = [(0.0, start, [], frozenset())]
        for depth in range(max_legs):
            nxt = {}
            for t0, s, path, used in frontier:
                starts = [(s, 0)] if depth == 0 else [(s, 0)] + list(xfer.get(s, {}).items())
                for s2, tx in starts:
                    for r, d, b, m in net.get(s2, []):
                        if r == missing or r in used or (depth == 0 and r not in first_lines):
                            continue
                        t = t0 + tx + (gap.get((r, d, s2), 10) / 2 if depth else 0) + m
                        p = path + [(r, d, s2, b)]
                        if b in at_hub:
                            found.append((t + CHANGE_PENALTY * depth, t, p))
                        else:
                            # Keep a few of the best ways to reach each stop.
                            nxt.setdefault(b, []).append((t, b, p, used | {r}))
            frontier = [x for v in nxt.values() for x in sorted(v, key=lambda y: y[0])[:3]]
        return sorted(found, key=lambda x: x[0])

    out, rides = {}, {}
    for period in PERIODS:
        net, gap = network(period)
        for r, a, b in RIDES:
            ms = [m for (r2, d, b2, m) in net.get(a, []) if r2 == r and b2 == b]
            if ms:
                rides.setdefault(f'{r}|{a}|{b}', {})[period] = round(min(ms))
        for stn, lines in PENN.items():
            for line in lines:
                for d in 'NS':
                    hub = HUBS[(line, d)]
                    at_hub = {hub, *xfer.get(hub, {})}
                    found = search(net, gap, stn, set(lines), line, at_hub)
                    # Merge plans that change at the same stations and differ only in
                    # which line (within 2 min): "the 2 or 3", "the 4 or 5".
                    groups = []
                    for score, mins, legs in found:
                        key = tuple((l[1], l[2], l[3]) for l in legs)
                        g = next((x for x in groups if x['key'] == key), None)
                        if g is None:
                            if len(groups) >= KEEP:
                                continue
                            g = {'key': key, 'score': score, 'mins': mins, 'legs': [{'routes': [], 'dir': l[1], 'from': l[2], 'to': l[3]} for l in legs]}
                            groups.append(g)
                        if score - g['score'] <= 2:
                            for i, l in enumerate(legs):
                                if l[0] not in g['legs'][i]['routes']:
                                    g['legs'][i]['routes'].append(l[0])
                    plans = [{'mins': round(g['mins']), 'legs': g['legs']} for g in sorted(groups, key=lambda x: x['score'])]
                    # Walking through Penn Station to the other subway station: a
                    # second choice when one train from there goes straight there.
                    other = OTHER[stn]
                    walk = [(t, p) for _, t, p in search(net, gap, other, set(PENN[other]), line, at_hub, max_legs=1)]
                    entry = {'plans': plans}
                    if walk:
                        walk_routes = sorted({p[0][0] for t, p in walk if t <= walk[0][0] + 2})
                        walk_mins = round(WALK_MIN + walk[0][0] + 3)
                        if not plans or walk_mins <= plans[0]['mins'] + 5:
                            entry['walk'] = {'routes': walk_routes, 'dir': walk[0][1][0][1], 'mins': walk_mins}
                    out.setdefault(stn, {}).setdefault(line, {}).setdefault(d, {})[period] = entry
    used = set(HUBS.values())
    for ls in out.values():
        for ds in ls.values():
            for per in ds.values():
                for e in per.values():
                    for p in e['plans']:
                        for l in p['legs']:
                            used.update((l['from'], l['to']))
    doc = {'names': {k: names.get(k, k) for k in sorted(used)}, 'plans': out, 'rides': rides}
    OUT.write_text(json.dumps(doc, separators=(',', ':')))
    print(f'Wrote {OUT} ({OUT.stat().st_size // 1024} KB)')
    for stn, ls in out.items():
        for line, ds in ls.items():
            for d, per in ds.items():
                for period, e in per.items():
                    p = e['plans'][0] if e['plans'] else None
                    how = ' -> '.join(f"{'/'.join(l['routes'])} to {names.get(l['to'], l['to'])}" for l in p['legs']) if p else 'no plan'
                    walk = f" | or walk to the {'/'.join(e['walk']['routes'])} ({e['walk']['mins']} min)" if 'walk' in e else ''
                    print(f"{line} {d} {period}: {how}{f' ({p['mins']} min)' if p else ''}{walk}")


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
