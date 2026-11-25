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
    python3 scripts/build-lirr-timetable.py --mnr gtfsmnr.zip
"""
import csv, datetime, io, json, sys, zipfile
from collections import defaultdict
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / 'docs' / 'lirr-timetable.json'
PENN = '237'
# The same file for Metro-North (owner, Nov 25: "Other options" at Grand
# Central): --mnr writes docs/mnr-timetable.json, with Grand Central (stop 1)
# as "penn" (the origin) and the station names (Metro-North has no lirr-data.json).
MNR = ('1', Path(__file__).resolve().parent.parent / 'docs' / 'mnr-timetable.json')
NAMES = False


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
    if NAMES:
        # Metro-North's file gives each few dates their own service: keep the
        # next 3 weeks only (rebuilt weekly), so the file stays small for phones.
        today = datetime.date.today()
        keep_dates = {(today + datetime.timedelta(days=i)).strftime('%Y%m%d') for i in range(-1, 22)}
        dates = {d: v for d, v in dates.items() if d in keep_dates}
        used = set().union(*dates.values()) if dates else set()
        out = [x for x in out if sorted(svc_ix, key=svc_ix.get)[x[3]] in used]
        # Re-number the services and stops that are left.
        svc_names = sorted(svc_ix, key=svc_ix.get)
        keep_svc = sorted({svc_names[x[3]] for x in out})
        svc_ix = {sv: i for i, sv in enumerate(keep_svc)}
        stop_names = sorted(stop_ix, key=stop_ix.get)
        keep_stops = sorted({stop_names[x[4][i]] for x in out for i in range(0, len(x[4]), 2)}, key=lambda k: stop_ix[k])
        new_stop = {sid: i for i, sid in enumerate(keep_stops)}
        out = [[r, h, n, svc_ix[svc_names[sv]], [v if i % 2 else new_stop[stop_names[v]] for i, v in enumerate(flat)]] for r, h, n, sv, flat in out]
        stop_ix = new_stop
    out.sort(key=lambda x: x[4][1])
    names = {r['stop_id']: r['stop_name'].strip() for r in rows(z, 'stops.txt')} if NAMES else None
    doc = {'penn': PENN, 'stops': sorted(stop_ix, key=stop_ix.get), 'svc': sorted(svc_ix, key=svc_ix.get),
           **({'names': {k: v for k, v in names.items() if k in stop_ix}} if names else {}),
           'dates': {d: sorted(svc_ix[x] for x in v if x in svc_ix) for d, v in sorted(dates.items()) if v & set(svc_ix)},
           'trips': out}
    OUT.write_text(json.dumps(doc, separators=(',', ':')))
    from_penn = sum(1 for x in out if stop_ix[PENN] in x[4][0:-2:2])
    print(f'Wrote {OUT} ({OUT.stat().st_size // 1024} KB): {len(out)} trains ({from_penn} leave Penn), {len(doc["dates"])} dates')


if __name__ == '__main__':
    args = sys.argv[1:]
    if args[:1] == ['--mnr']:
        PENN, OUT = MNR
        NAMES = True
        args = args[1:]
    if len(args) != 1:
        sys.exit(__doc__)
    main(args[0])
