#!/usr/bin/env python3
"""Build docs/lirr-data.json from the MTA's LIRR timetable (GTFS).

It holds what the service-change map needs to draw an LIRR branch:
  - each branch's name and official colour,
  - each station's name and location (ids match the stop_id values in the
    MTA's LIRR service notices),
  - the stations each branch serves, and its track paths (simplified).

Rebuild when the MTA publishes a new LIRR timetable:

    curl -o gtfslirr.zip https://rrgtfsfeeds.s3.amazonaws.com/gtfslirr.zip
    python3 scripts/build-lirr-data.py gtfslirr.zip
"""
import csv, io, json, sys, zipfile
from collections import defaultdict
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / 'docs' / 'lirr-data.json'
SIMPLIFY = 0.00006  # degrees, about 6 m


def rows(z, name):
    with z.open(name) as f:
        yield from csv.DictReader(io.TextIOWrapper(f, encoding='utf-8-sig'))


def simplify(p, eps):
    if len(p) < 3:
        return p
    (y1, x1), (y2, x2) = p[0], p[-1]
    dx, dy = x2 - x1, y2 - y1
    length = (dx * dx + dy * dy) ** .5 or 1e-12
    i, far = 0, 0
    for k in range(1, len(p) - 1):
        d = abs(dy * (p[k][1] - x1) - dx * (p[k][0] - y1)) / length
        if d > far:
            i, far = k, d
    if far > eps:
        return simplify(p[:i + 1], eps)[:-1] + simplify(p[i:], eps)
    return [p[0], p[-1]]


def main(zip_path):
    z = zipfile.ZipFile(zip_path)
    routes = {r['route_id']: {'name': r['route_long_name'], 'color': '#' + (r['route_color'] or '6E3219').upper(),
                              'text': '#' + (r['route_text_color'] or 'FFFFFF').upper()} for r in rows(z, 'routes.txt')}
    stops = {s['stop_id']: [s['stop_name'], round(float(s['stop_lat']), 6), round(float(s['stop_lon']), 6)] for s in rows(z, 'stops.txt')}
    trips = {t['trip_id']: t for t in rows(z, 'trips.txt')}
    serves = defaultdict(set)
    for st in rows(z, 'stop_times.txt'):
        t = trips.get(st['trip_id'])
        if t:
            serves[t['route_id']].add(st['stop_id'])
    shape_route = {}
    for t in trips.values():
        shape_route.setdefault(t['shape_id'], t['route_id'])
    pts = defaultdict(list)
    for r in rows(z, 'shapes.txt'):
        if r['shape_id'] in shape_route:
            pts[r['shape_id']].append((int(r['shape_pt_sequence']), float(r['shape_pt_lat']), float(r['shape_pt_lon'])))
    by_route = defaultdict(list)
    for sid, p in pts.items():
        p = [(a, b) for _, a, b in sorted(p)]
        by_route[shape_route[sid]].append([[round(a, 5), round(b, 5)] for a, b in simplify(p, SIMPLIFY)])
    shapes = {}
    for route, paths in by_route.items():
        paths.sort(key=len, reverse=True)
        keep, seen = [], set()
        for path in paths:
            cells = {(round(a, 3), round(b, 3)) for a, b in path}
            if keep and len(cells - seen) <= 3:
                continue
            keep.append(path)
            seen |= cells
        shapes[route] = keep
    for rid, r in routes.items():
        r['stops'] = sorted(serves[rid])
    penn = next((k for k, v in stops.items() if v[0].lower().startswith('penn station')), '')
    info = next(rows(z, 'feed_info.txt'), {}) if 'feed_info.txt' in z.namelist() else {}
    doc = {'version': info.get('feed_version', ''), 'penn': penn, 'routes': routes, 'stops': stops, 'shapes': shapes}
    OUT.write_text(json.dumps(doc, separators=(',', ':')))
    print(f'Wrote {OUT}: {len(routes)} branches, {len(stops)} stations, {sum(len(v) for v in shapes.values())} paths, {OUT.stat().st_size // 1024} KB; Penn = {penn}')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
