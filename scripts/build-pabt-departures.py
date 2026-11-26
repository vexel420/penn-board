#!/usr/bin/env python3
"""Build docs/pabt-departures.json: scheduled departures from the Port
Authority Bus Terminal for every company that publishes a timetable (owner,
Nov 26: "I want them all to be listed"). NJ Transit's own buses come live
from NJ Transit (relay /njt-bus-pabt) and aren't in this file.

Inputs (official GTFS files; the workflow downloads them):
    coachusa=megabus-us.zip        Coach USA: ShortLine, Suburban, Rockland,
                                   Community Coach, Newark Airport Express
                                   (data.trilliumtransit.com/gtfs/megabus-us)
    greyhound=gtfs_generic_us.zip  Greyhound (FlixBus: gtfs.gis.flix.tech)
    trailways=Adirondack_Trailways-ADT.zip   Adirondack, Pine Hill and New
                                   York Trailways (511NY, NYSDOT)
    fullington=Adirondack_Trailways-FAB.zip  Fullington Trailways (511NY)
    academy=Academy_bus_data.zip   Academy (njtransit.com)
    lakeland=LakelandBusLines_bus_data.zip   Lakeland (njtransit.com)
    transbridge=Trans-Bridge_bus_data.zip    Trans-Bridge (njtransit.com)

For each trip that leaves from a stop at the terminal (by name, within 350 m
of it) and goes on somewhere: the company, route, destination, the gate when
the file gives one (Coach USA and Academy do), and its departure, for the next
DAYS days.

    python3 scripts/build-pabt-departures.py coachusa=... greyhound=... ...
"""
import csv, datetime, io, json, math, re, sys, zipfile
from collections import defaultdict
from pathlib import Path
from zoneinfo import ZoneInfo

OUT = Path(__file__).resolve().parent.parent / 'docs' / 'pabt-departures.json'
PABT = (40.7572, -73.9903)
DAYS = 14
NY = ZoneInfo('America/New_York')
NAME = re.compile(r'port\s*auth|p\.?\s?a\.?\s?b\.?\s?t\b|midtown bus terminal', re.I)
# Which kind each company is (the board's filters).
KIND = {
    'Academy': 'commuter', 'Lakeland': 'commuter', 'ShortLine': 'commuter', 'Suburban Transit': 'commuter',
    'Rockland Coaches': 'commuter', 'Community Coach': 'commuter', 'Newark Airport Express': 'airport',
    'Greyhound': 'intercity', 'Adirondack Trailways': 'intercity', 'Pine Hill Trailways': 'intercity',
    'New York Trailways': 'intercity', 'Fullington Trailways': 'intercity', 'Trans-Bridge Lines': 'intercity',
}


def rows(z, name):
    if name not in z.namelist():
        return []
    with z.open(name) as f:
        return list(csv.DictReader(io.TextIOWrapper(f, encoding='utf-8-sig')))


def km(a, b):
    return math.hypot((a[0] - b[0]) * 111.2, (a[1] - b[1]) * 84.2)


def mins(t):
    h, m, s = (int(x) for x in t.split(':'))
    return h * 60 + m


def company(source, agency, route):
    """The company's name as Port Authority lists it."""
    a = agency.replace('-us', '').strip()
    if source == 'coachusa':
        return {'ShortLine Hudson': 'ShortLine'}.get(a, a)
    if source == 'trailways':
        code = (route.get('route_short_name') or '').split(' ')[-1][:1]  # "ADT P702-D": P = Pine Hill
        return {'P': 'Pine Hill Trailways', 'N': 'New York Trailways'}.get(code, 'Adirondack Trailways')
    if source == 'greyhound':
        return 'Greyhound' if 'GREYHOUND' in agency.upper() else 'FlixBus'
    return {'academy': 'Academy', 'lakeland': 'Lakeland', 'transbridge': 'Trans-Bridge Lines', 'fullington': 'Fullington Trailways'}.get(source, a)


def gate_of(stop):
    g = (stop.get('platform_code') or '').strip()
    if re.fullmatch(r'\d{1,3}', g):
        return g
    m = re.search(r'gate\s*(\d{1,3})', ' '.join([stop.get('stop_code', ''), stop.get('stop_name', '')]), re.I)
    return m.group(1) if m else ''


GENERIC = re.compile(r'^(outbound|inbound|north|south|east|west)(bound)?$', re.I)


def tidy_sign(sign):
    """Academy-style signs: "139 - New York to Lakewood - (Old Bridge)" -> "Lakewood via Old Bridge"."""
    s = re.sub(r'^\d+[A-Z]?\s*-\s*', '', sign.strip())
    s = re.sub(r'^New York\s+to\s+', '', s, flags=re.I)
    parts = [x.strip() for x in s.split(' - ') if x.strip()]
    if not parts:
        return sign
    main = re.sub(r'\s*\((north|south|east|west)bound\)', '', parts[0], flags=re.I)
    via = next((x.strip('()') for x in parts[1:] if x.startswith('(')), '')
    return f'{main} via {via}' if via else main


def clean_dest(name):
    name = tidy_sign(re.sub(r'&amp;', '&', name, flags=re.I))
    name = re.sub(r'\s+,', ',', name)
    n = re.sub(r'\s*\((?:[^)]*bus (?:station|terminal)[^)]*)\)', '', name, flags=re.I)
    n = re.sub(r'\b(bus station|bus terminal|transportation center)\b', '', n, flags=re.I)
    return re.sub(r'\s+,', ',', re.sub(r'\s{2,}', ' ', n)).strip(' ,-') or name


def active_services(z, date):
    ymd, dow = date.strftime('%Y%m%d'), date.strftime('%A').lower()
    on = {c['service_id'] for c in rows(z, 'calendar.txt') if c['start_date'] <= ymd <= c['end_date'] and c.get(dow) == '1'}
    for d in rows(z, 'calendar_dates.txt'):
        if d['date'] == ymd:
            (on.add if d['exception_type'] == '1' else on.discard)(d['service_id'])
    return on


def main(inputs):
    today = datetime.datetime.now(NY).date()
    trips_out, index, days = [], {}, defaultdict(list)
    sources = {}
    for source, path in inputs:
        try:
            z = zipfile.ZipFile(path)
        except Exception as e:  # a company's file missing this week: the rest still build
            sources[source] = f'unreadable: {e}'
            continue
        stops = {s['stop_id']: s for s in rows(z, 'stops.txt')}
        at = {k for k, s in stops.items() if NAME.search(s.get('stop_name', '')) and s.get('stop_lat') and km((float(s['stop_lat']), float(s['stop_lon'])), PABT) < 0.35}
        agencies = {a.get('agency_id', ''): a['agency_name'] for a in rows(z, 'agency.txt')}
        routes = {r['route_id']: r for r in rows(z, 'routes.txt')}
        trips = {t['trip_id']: t for t in rows(z, 'trips.txt')}
        calls = defaultdict(list)
        for st in rows(z, 'stop_times.txt'):
            if st['trip_id'] in trips:
                calls[st['trip_id']].append((int(st['stop_sequence']), st['stop_id'], st['departure_time'] or st['arrival_time']))
        found = 0
        by_service = defaultdict(list)
        for tid, cs in calls.items():
            cs.sort()
            i = next((k for k, c in enumerate(cs) if c[1] in at), None)
            if i is None or i == len(cs) - 1 or not cs[i][2]:
                continue
            last = stops[cs[-1][1]]
            # A trip that goes on into Manhattan (into the city, stopping here first) isn't leaving.
            if last.get('stop_lat') and km((float(last['stop_lat']), float(last['stop_lon'])), PABT) < 6:
                continue
            t, r = trips[tid], routes.get(trips[tid]['route_id'], {})
            agency = agencies.get(r.get('agency_id', ''), next(iter(agencies.values()), ''))
            who = company(source, agency, r)
            sign = (t.get('trip_headsign') or '').strip()
            dest = clean_dest(tidy_sign(sign)) if sign and not GENERIC.match(sign) and not NAME.search(sign) else clean_dest(last['stop_name'])
            route = (r.get('route_short_name') or '').strip()
            if source == 'trailways' or len(route) > 6:
                route = ''
            key = (who, route, dest, gate_of(stops[cs[i][1]]), mins(cs[i][2]))
            if key not in index:
                index[key] = len(trips_out)
                trips_out.append(list(key))
            by_service[t['service_id']].append(index[key])
            found += 1
        for k in range(DAYS):
            date = today + datetime.timedelta(days=k)
            for svc in active_services(z, date):
                days[date.strftime('%Y%m%d')].extend(by_service.get(svc, []))
        sources[source] = f'{found} trips from the terminal'
        print(f'{source}: {len(at)} terminal stops, {found} trips')
    doc = {
        'built': datetime.datetime.now(NY).isoformat(timespec='minutes'),
        'kinds': KIND,
        'sources': sources,
        # [company, route, destination, gate, minutes after the day's midnight (may pass 1440)]
        'trips': trips_out,
        'days': {d: sorted(set(v)) for d, v in sorted(days.items())},
    }
    OUT.write_text(json.dumps(doc, separators=(',', ':'), ensure_ascii=False))
    per = defaultdict(int)
    for i in doc['days'].get(today.strftime('%Y%m%d'), []):
        per[trips_out[i][0]] += 1
    print(f'Wrote {OUT} ({OUT.stat().st_size // 1024} KB). Today: {dict(sorted(per.items(), key=lambda x: -x[1]))}')


if __name__ == '__main__':
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    main([a.split('=', 1) for a in sys.argv[1:]])
