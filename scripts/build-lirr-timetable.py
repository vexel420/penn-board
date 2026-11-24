#!/usr/bin/env python3
"""Build docs/lirr-timetable.json: the MTA's LIRR timetable in a compact form,
for "Other options" on a delayed LIRR train (owner, Nov 24): the next trains
from Penn to the same stations, direct or with one change (at Jamaica, say),
from the schedule, switching to live times once a train is on the live board
(matched by train number).

{"penn": stop id, "stops": [stop ids], "svc": [service ids],
 "dates": {"YYYYMMDD": [svc index, ...]},
 "trips": [[route id, headsign, train number, svc index, [stop index, minutes, stop index, minutes, ...]], ...]}

Minutes are after midnight of the service day and can pass 1440. Holidays and
one-off changes come from the timetable's own calendar.

    python3 scripts/build-lirr-timetable.py gtfslirr.zip
"""
import csv, datetime, io, json, sys, zipfile
from collections import defaultdict
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / 'docs' / 'lirr-timetable.json'
PENN = '237'


def rows(z, name):
    with z.open(name) as f:
        yield from csv.DictReader(io.TextIOWrapper(f, encoding='utf-8-sig'))


def mins(t):
    h, m, _ = map(int, t.split(':'))
    return h * 60 + m


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
    trips = {t['trip_id']: t for t in rows(z, 'trips.txt')}
    calls = defaultdict(list)
    for st in rows(z, 'stop_times.txt'):
        calls[st['trip_id']].append((int(st['stop_sequence']), st['stop_id'], st['departure_time'] or st['arrival_time']))
    stop_ix, svc_ix, out = {}, {}, []
    for tid, cs in calls.items():
        if tid not in trips:
            continue
        cs.sort()
        t = trips[tid]
        flat = []
        for _, sid, tm in cs:
            flat += [stop_ix.setdefault(sid, len(stop_ix)), mins(tm)]
        out.append([t['route_id'], t.get('trip_headsign', ''), t.get('trip_short_name', ''), svc_ix.setdefault(t['service_id'], len(svc_ix)), flat])
    out.sort(key=lambda x: x[4][1])
    doc = {'penn': PENN, 'stops': sorted(stop_ix, key=stop_ix.get), 'svc': sorted(svc_ix, key=svc_ix.get),
           'dates': {d: sorted(svc_ix[x] for x in v if x in svc_ix) for d, v in sorted(dates.items()) if v & set(svc_ix)},
           'trips': out}
    OUT.write_text(json.dumps(doc, separators=(',', ':')))
    from_penn = sum(1 for x in out if stop_ix[PENN] in x[4][0:-2:2])
    print(f'Wrote {OUT} ({OUT.stat().st_size // 1024} KB): {len(out)} trains ({from_penn} leave Penn), {len(doc["dates"])} dates')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
