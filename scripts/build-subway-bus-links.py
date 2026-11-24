#!/usr/bin/env python3
"""Build docs/subway-bus-links.json: MTA buses that link nearby subway
stations on the same line, for when trains skip stops (owner, Nov 24: suggest
buses to the skipped stops, with live times from MTA Bus Time).

For every pair of stations up to MAX_APART stops apart on a line (from
docs/subway-data.json), each bus route that stops within NEAR_M metres of
both, in that order, is listed with the two bus stops (their ids are MTA Bus
Time stop codes), the usual ride, the walks at each end, the bus's sign and
how often it runs by day. The board asks the relay (/mta-bus-stop) for the
next buses at the first stop.

    python3 scripts/build-subway-bus-links.py gtfs_subway.zip gtfs_bx.zip gtfs_m.zip ...
"""
import csv, io, json, math, statistics, sys, zipfile
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'docs' / 'subway-bus-links.json'
NEAR_M = 300
MAX_APART = 6
KEEP = 3
WALK_M_PER_MIN = 75


def rows(z, name):
    with z.open(name) as f:
        yield from csv.DictReader(io.TextIOWrapper(f, encoding='utf-8-sig'))


def mins(t):
    h, m, s = map(int, t.strip().split(':'))
    return h * 60 + m + s / 60


def metres(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    return 6371000 * math.hypot((lo2 - lo1) * math.cos((la1 + la2) / 2), la2 - la1)


def main(subway_zip, bus_zips):
    sz = zipfile.ZipFile(subway_zip)
    spt = {s['stop_id']: (float(s['stop_lat']), float(s['stop_lon'])) for s in rows(sz, 'stops.txt') if s.get('location_type') == '1'}
    data = json.loads((ROOT / 'docs' / 'subway-data.json').read_text())
    pairs = set()
    for r, info in data['routes'].items():
        ids = [i for i in info.get('normal', []) if i in spt]
        for i, a in enumerate(ids):
            for b in ids[max(0, i - MAX_APART):i + MAX_APART + 1]:
                if a != b:
                    pairs.add((a, b))
    print(f'{len(pairs)} station pairs')

    links = defaultdict(dict)  # (a, b) -> route -> best
    for path in bus_zips:
        z = zipfile.ZipFile(path)
        near = defaultdict(dict)
        for s in rows(z, 'stops.txt'):
            pt = (float(s['stop_lat']), float(s['stop_lon']))
            for sid, p in spt.items():
                if abs(p[0] - pt[0]) < 0.004 and abs(p[1] - pt[1]) < 0.005:
                    d = metres(p, pt)
                    if d <= NEAR_M:
                        near[s['stop_id']][sid] = d
        wed = {c['service_id'] for c in rows(z, 'calendar.txt') if c['wednesday'] == '1'}
        routes = {r['route_id']: r['route_short_name'] for r in rows(z, 'routes.txt')}
        trips = {t['trip_id']: (routes.get(t['route_id'], t['route_id']), t.get('trip_headsign', ''), t['service_id'] in wed) for t in rows(z, 'trips.txt')}
        calls = defaultdict(list)
        for st in rows(z, 'stop_times.txt'):
            if st['stop_id'] in near:
                calls[st['trip_id']].append((int(st['stop_sequence']), st['stop_id'], mins(st['departure_time'])))
        acc = defaultdict(lambda: {'rides': [], 'heads': defaultdict(int), 'deps': []})
        for tid, cs in calls.items():
            if tid not in trips:
                continue
            route, head, wk = trips[tid]
            cs.sort()
            seen = set()
            for i, (_, ba, ta) in enumerate(cs):
                for _, bb, tb in cs[i + 1:]:
                    for sa in near[ba]:
                        for sb in near[bb]:
                            if (sa, sb) in pairs and (sa, sb, route, ba, bb) not in seen:
                                seen.add((sa, sb, route, ba, bb))
                                e = acc[(sa, sb, route, ba, bb)]
                                e['rides'].append(tb - ta)
                                e['heads'][head] += 1
                                if wk:
                                    e['deps'].append(ta % 1440)
        for (sa, sb, route, ba, bb), e in acc.items():
            ride = statistics.median(e['rides'])
            w1, w2 = near[ba][sa], near[bb][sb]
            total = ride + (w1 + w2) / WALK_M_PER_MIN
            day = sorted(d for d in e['deps'] if 6 * 60 <= d < 21 * 60)
            gap = statistics.median([y - x for x, y in zip(day, day[1:]) if y > x] or [0]) or None
            cur = links[(sa, sb)].get(route)
            if cur is None or total < cur['t']:
                links[(sa, sb)][route] = {'r': route, 'from': ba, 'to': bb, 'ride': round(ride), 'w1': round(w1), 'w2': round(w2), 't': round(total),
                                          'head': max(e['heads'], key=e['heads'].get).strip(), 'gap': round(gap) if gap else None}
        print(f'  {Path(path).name}: {len(near)} bus stops near stations')
    out = {f'{a}|{b}': sorted(v.values(), key=lambda x: x['t'])[:KEEP] for (a, b), v in links.items()}
    OUT.write_text(json.dumps(out, separators=(',', ':')))
    print(f'Wrote {OUT} ({OUT.stat().st_size // 1024} KB): {len(out)} station pairs linked by bus')


if __name__ == '__main__':
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2:])
