#!/usr/bin/env python3
"""Build docs/path-schedule.json, PATH's timetable for trains leaving 33 St.

The board shows these scheduled times when live PATH times aren't available.
Run it again whenever PATH publishes a new timetable:

    curl -L -o path-gtfs.zip https://data.trilliumtransit.com/gtfs/path-nj-us/path-nj-us.zip
    python3 scripts/build-path-schedule.py path-gtfs.zip

Only the regular weekday, Saturday and Sunday timetables are used; PATH's
one-off construction and holiday timetables are ignored.
"""
import csv, io, json, sys, zipfile
from pathlib import Path

STATION = '33rd Street'
OUT = Path(__file__).resolve().parent.parent / 'docs' / 'path-schedule.json'


def table(z, name):
    with z.open(name) as f:
        return list(csv.DictReader(io.TextIOWrapper(f, encoding='utf-8-sig')))


def main(zip_path):
    z = zipfile.ZipFile(zip_path)
    info = table(z, 'feed_info.txt')[0]
    stops = table(z, 'stops.txt')
    station_ids = {s['stop_id'] for s in stops if s['stop_name'] == STATION}
    station_ids |= {s['stop_id'] for s in stops if s.get('parent_station') in station_ids}

    # The regular timetables are the ones that run on ordinary days of the week.
    days = {}
    for c in table(z, 'calendar.txt'):
        if c['monday'] == '1' and c['friday'] == '1' and c['saturday'] == '0':
            days['weekday'] = c['service_id']
        elif c['saturday'] == '1' and c['monday'] == '0':
            days['saturday'] = c['service_id']
        elif c['sunday'] == '1' and c['monday'] == '0':
            days['sunday'] = c['service_id']
    if len(days) != 3:
        sys.exit(f'Expected weekday, Saturday and Sunday timetables, found {sorted(days)}')
    service_day = {v: k for k, v in days.items()}

    routes = {r['route_id']: '#' + (r['route_color'] or '888888') for r in table(z, 'routes.txt')}
    trips = {t['trip_id']: t for t in table(z, 'trips.txt') if t['service_id'] in service_day}

    # Last stop of each trip, so trains that end at 33 St are left out.
    last_seq = {}
    at_station = []
    for st in table(z, 'stop_times.txt'):
        tid = st['trip_id']
        if tid not in trips:
            continue
        seq = int(st['stop_sequence'])
        last_seq[tid] = max(last_seq.get(tid, 0), seq)
        if st['stop_id'] in station_ids:
            at_station.append((tid, seq, st['departure_time']))

    out = {k: [] for k in days}
    for tid, seq, dep in at_station:
        if seq == last_seq[tid]:
            continue
        h, m, s = (int(x) for x in dep.split(':'))
        t = trips[tid]
        out[service_day[t['service_id']]].append({
            't': h * 60 + m,  # minutes after midnight; can pass 24:00 for late trains
            'to': t['trip_headsign'],
            'color': routes.get(t['route_id'], '#888888'),
        })
    for k in out:
        out[k].sort(key=lambda d: d['t'])

    end = info.get('feed_end_date', '')
    doc = {
        'station': '33 St',
        'source': 'PATH timetable (GTFS) via Trillium',
        'published': info.get('feed_version', ''),
        'validUntil': f'{end[:4]}-{end[4:6]}-{end[6:]}' if len(end) == 8 else '',
        'days': out,
    }
    OUT.write_text(json.dumps(doc, separators=(',', ':')))
    print(f'Wrote {OUT}: ' + ', '.join(f'{k} {len(v)} departures' for k, v in out.items()))


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
