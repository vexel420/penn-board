#!/usr/bin/env python3
"""Build docs/swf.json: getting from Penn to New York Stewart (SWF) (owner,
Nov 25: "incorporate SWF airport since it's also a Coach USA bus, or Metro-North
and a shuttle").

Per Stewart Airport's own page (swfny.com/transportation/public-transport,
Nov 2026) there is no direct bus from New York City any more. The two public
ways, both ending on Leprechaun Lines' Newburgh Beacon Bridge Shuttle (free in
2026, "Complimentary 2026 Fares"), which stops at the terminal on some runs:

  1. Metro-North Hudson Line from Grand Central to Beacon, then the shuttle.
     (Metro-North is live on the board: TrainTime's Grand Central departures.)
  2. Coach USA (ShortLine) from Port Authority to the Newburgh ShortLine
     Transportation Center at the Route 17K Park & Ride, then the shuttle.
     (Coach USA's file lists a Stewart Airport stop, but no trip calls there.)

The shuttle times below are typed from Leprechaun Lines' timetable (the
4-fold brochure dated 07/04/26, leprechaunlines.com/stewart-newburgh-beacon-shuttle/),
westbound runs that stop at Stewart Airport only: [Beacon Station, Rte 17K
Park & Ride, Stewart Airport]. Update them when the brochure changes.

{"mnr": {"svc": [...], "dates": {"YYYYMMDD": [svc index]}, "trips": [[svc, train, GC dep, Beacon arr], ...]},
 "coach": {"dates": {...}, "toNewburgh": [[svc, route, PABT dep, Newburgh arr]]},
 "shuttle": {"wk": [[beacon, parkride, swf]], "we": [...]}, "weekendDates": [YYYYMMDD weekday holidays]}

Minutes after midnight. Metro-North comes from the MTA's file (weekly rebuild);
Coach USA's file isn't public, so without it the coach part is kept as is.

    python3 scripts/build-swf.py gtfsmnr.zip [coach-usa-gtfs.zip]
"""
import csv, datetime, io, json, statistics, sys, zipfile
from collections import defaultdict
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / 'docs' / 'swf.json'
GC, BEACON = '1', '46'                     # Metro-North stop ids
PABT_NAME = 'Port Authority Bus Terminal'
NEWBURGH_NAME = 'Newburgh ShortLine Transportation Center'


def hm(x):
    h, m = map(int, x.split(':'))
    return h * 60 + m


def pm(x):  # 12-hour brochure time with an am/pm marker
    t, ap = x.split()
    h, m = map(int, t.split(':'))
    return (h % 12 + (12 if ap == 'p' else 0)) * 60 + m


# [Beacon, Rte 17K Park & Ride, Stewart Airport]; '-' where the run doesn't stop.
SHUTTLE = {
    'wk': [('5:40 a', '5:56 a', '6:06 a'), ('7:51 a', '8:09 a', '8:21 a'), ('8:23 a', '8:46 a', '9:06 a'),
           ('9:21 a', '9:50 a', '10:00 a'), ('11:15 a', '11:44 a', '11:54 a'), ('1:15 p', '1:37 p', '1:54 p'),
           ('4:23 p', '4:57 p', '5:09 p'), ('4:54 p', '5:29 p', '5:41 p'), ('5:22 p', '5:42 p', '5:54 p'),
           ('7:51 p', '8:09 p', '8:19 p'), ('8:19 p', '8:46 p', '8:56 p'), ('9:24 p', '9:51 p', '10:01 p'),
           ('10:03 p', '10:30 p', '10:40 p')],
    'we': [('8:42 a', '9:01 a', '9:08 a'), ('9:39 a', '9:58 a', '10:05 a'), ('10:38 a', '11:02 a', '11:10 a'),
           ('1:34 p', '1:58 p', '2:06 p'), ('2:42 p', '3:06 p', '3:14 p'), ('3:37 p', '4:01 p', '4:09 p'),
           ('4:37 p', '5:01 p', '5:09 p'), ('5:33 p', '5:57 p', '6:05 p'), ('6:37 p', '6:56 p', '7:03 p')],
}


def rows(z, name):
    with z.open(name) as f:
        yield from csv.DictReader(io.TextIOWrapper(f, encoding='utf-8-sig'))


def mins(t):
    h, m, _ = map(int, t.strip().split(':'))
    return h * 60 + m


def service_dates(z):
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
    if 'calendar_dates.txt' in names:
        for c in rows(z, 'calendar_dates.txt'):
            (dates[c['date']].add if c['exception_type'] == '1' else dates[c['date']].discard)(c['service_id'])
    return dates


def pack_dates(dates, used, today):
    svc_ix = {s: i for i, s in enumerate(sorted(used))}
    out = {d: sorted(svc_ix[s] for s in v if s in svc_ix) for d, v in sorted(dates.items()) if d >= today}
    return svc_ix, {d: v for d, v in out.items() if v}


def build_mnr(path, today):
    z = zipfile.ZipFile(path)
    dates = service_dates(z)
    trips = {t['trip_id']: t for t in rows(z, 'trips.txt')}
    calls = defaultdict(dict)
    for st in rows(z, 'stop_times.txt'):
        if st['stop_id'] in (GC, BEACON):
            calls[st['trip_id']][st['stop_id']] = (int(st['stop_sequence']), st['departure_time'] or st['arrival_time'])
    found = []
    for tid, c in calls.items():
        if GC in c and BEACON in c and c[GC][0] < c[BEACON][0] and tid in trips:
            t = trips[tid]
            found.append((t['service_id'], t['trip_short_name'], mins(c[GC][1]), mins(c[BEACON][1])))
    svc_ix, packed = pack_dates(dates, {f[0] for f in found}, today)
    # Weekdays that run a weekend timetable (holidays): few trains to Beacon.
    per_day = {d: sum(1 for f in found if f[0] in dates[d]) for d in packed}
    wk = [n for d, n in per_day.items() if datetime.datetime.strptime(d, '%Y%m%d').weekday() < 5]
    usual = statistics.median(wk) if wk else 0
    holidays = sorted(d for d, n in per_day.items() if datetime.datetime.strptime(d, '%Y%m%d').weekday() < 5 and n < usual * 0.75)
    return {'svc': sorted(svc_ix, key=svc_ix.get), 'dates': packed,
            'trips': sorted([[svc_ix[s], n, a, b] for s, n, a, b in found], key=lambda x: x[2])}, holidays


def build_coach(path, today):
    z = zipfile.ZipFile(path)
    stops = {s['stop_id']: s['stop_name'] for s in rows(z, 'stops.txt')}
    pabt = {k for k, v in stops.items() if v == PABT_NAME}
    newb = {k for k, v in stops.items() if v == NEWBURGH_NAME}
    routes = {r['route_id']: r['route_long_name'] for r in rows(z, 'routes.txt')}
    trips = {t['trip_id']: t for t in rows(z, 'trips.txt')}
    calls = defaultdict(list)
    for st in rows(z, 'stop_times.txt'):
        if st['stop_id'] in pabt | newb:
            calls[st['trip_id']].append((int(st['stop_sequence']), st['stop_id'], st['departure_time'] or st['arrival_time'], st['arrival_time'] or st['departure_time']))
    to_newb = []
    for tid, cs in calls.items():
        if tid not in trips:
            continue
        cs.sort()
        t = trips[tid]
        a = next((c for c in cs if c[1] in pabt), None)
        b = next((c for c in cs if c[1] in newb and a and c[0] > a[0]), None)
        if a and b:
            to_newb.append((t['service_id'], routes[t['route_id']].split(' - ')[0], mins(a[2]), mins(b[3])))
    svc_ix, packed = pack_dates(service_dates(z), {x[0] for x in to_newb}, today)
    return {'svc': sorted(svc_ix, key=svc_ix.get), 'dates': packed,
            'toNewburgh': sorted([[svc_ix[s], r, a, b] for s, r, a, b in to_newb], key=lambda x: x[2])}


def main(mnr_zip, coach_zip=None):
    today = datetime.date.today().strftime('%Y%m%d')
    old = json.loads(OUT.read_text()) if OUT.exists() else {}
    mnr, holidays = build_mnr(mnr_zip, today)
    coach = build_coach(coach_zip, today) if coach_zip else old.get('coach')
    doc = {'mnr': mnr, 'coach': coach, 'weekendDates': holidays,
           'shuttle': {k: [[pm(a), pm(b), pm(c)] for a, b, c in v] for k, v in SHUTTLE.items()}}
    OUT.write_text(json.dumps(doc, separators=(',', ':')))
    print(f'Wrote {OUT} ({OUT.stat().st_size // 1024} KB): {len(mnr["trips"])} Metro-North trains to Beacon, '
          f'{len(coach["toNewburgh"]) if coach else 0} buses to Newburgh; '
          f'weekday holidays {holidays}')


if __name__ == '__main__':
    if len(sys.argv) not in (2, 3):
        sys.exit(__doc__)
    main(*sys.argv[1:])
