#!/usr/bin/env python3
"""Build docs/subway-data.json from the MTA's subway timetable (GTFS).

It holds what the board needs to draw any subway line correctly, including
one that turns up at Penn because of a service change:
  - every line's official colour and text colour,
  - every station's name and location,
  - the stations each line normally serves, so a train stopping somewhere its
    line doesn't usually go can be shown as rerouted.

Rebuild it when the MTA publishes a new timetable (a few times a year):

    curl -o gtfs_subway.zip https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip
    python3 scripts/build-subway-data.py gtfs_subway.zip
"""
import csv, io, json, sys, zipfile
from collections import defaultdict
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / 'docs' / 'subway-data.json'


def rows(z, name):
    with z.open(name) as f:
        yield from csv.DictReader(io.TextIOWrapper(f, encoding='utf-8-sig'))


def line_of(route_id):
    # Express variants (6X, 7X, FX) are drawn as their line (the realtime feed
    # reports them that way too); shuttles keep their own ids (GS, FS, H).
    return route_id[:-1] if len(route_id) == 2 and route_id.endswith('X') and route_id != 'SI' else route_id


def main(zip_path):
    z = zipfile.ZipFile(zip_path)
    info = next(rows(z, 'feed_info.txt'))

    stops, parent = {}, {}
    for s in rows(z, 'stops.txt'):
        if s['location_type'] == '1':
            stops[s['stop_id']] = [s['stop_name'], round(float(s['stop_lat']), 6), round(float(s['stop_lon']), 6)]
        parent[s['stop_id']] = s['parent_station'] or s['stop_id']

    routes = {}
    for r in rows(z, 'routes.txt'):
        line = line_of(r['route_id'])
        if line in routes:
            continue
        routes[line] = {
            'label': r['route_short_name'] if r['route_short_name'] not in ('SIR',) else 'SIR',
            'color': '#' + (r['route_color'] or '808183').upper(),
            'text': '#' + (r['route_text_color'] or 'FFFFFF').upper(),
        }

    trip_line = {t['trip_id']: line_of(t['route_id']) for t in rows(z, 'trips.txt')}
    normal = defaultdict(set)
    for st in rows(z, 'stop_times.txt'):
        line = trip_line.get(st['trip_id'])
        if line:
            normal[line].add(parent.get(st['stop_id'], st['stop_id'].rstrip('NS')))
    for line, r in routes.items():
        r['normal'] = sorted(normal[line])

    doc = {'version': info.get('feed_version', ''), 'routes': routes, 'stops': stops}
    OUT.write_text(json.dumps(doc, separators=(',', ':')))
    print(f'Wrote {OUT}: {len(routes)} lines, {len(stops)} stations, {OUT.stat().st_size // 1024} KB')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
