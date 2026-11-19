#!/usr/bin/env python3
"""Build docs/subway-data.json from the MTA's subway timetable (GTFS).

It holds what the board needs to draw any subway line correctly, including
one that turns up at Penn because of a service change:
  - every line's official colour and text colour,
  - every station's name and location,
  - the stations each line normally serves, so a train stopping somewhere its
    line doesn't usually go can be shown as rerouted;
  - for lines that run express through Penn by day and local late at night
    (the A and the 2), when that switch happens, per direction and day;
  - for lines that don't leave Penn at all late at night (the C, and the 3
    going downtown, which ends at Penn), the hours with no trains (the page
    suggests the station's other lines running that way).

It also builds docs/subway-times.json (each trip's scheduled time at Penn,
to tell on-time trains from late ones) and docs/subway-shapes.json: the path of every line's tracks
(simplified to about 100 KB), which the service-change map draws.

Rebuild it when the MTA publishes a new timetable (a few times a year):

    curl -o gtfs_subway.zip https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip
    python3 scripts/build-subway-data.py gtfs_subway.zip
"""
import csv, io, json, re, sys, zipfile
from collections import defaultdict
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / 'docs' / 'subway-data.json'
SHAPES_OUT = OUT.with_name('subway-shapes.json')
SIMPLIFY = 0.00004  # degrees, about 4 m: drops points that don't change the drawn line

# Penn's two subway stations, and the next stations that only local trains
# call at (the same rule as serviceFromPenn in docs/feeds.js).
PENN = {'128', 'A28'}
LOCAL_NEXT = {'129', '126', 'A30', 'A25'}
# Lines checked for a break in service from Penn late at night.
NIGHT_GAP_LINES = {'C', '3'}
NIGHT_GAP_MIN = 90  # a longer break than this in a line's trains is its night off
# Extra last stops that share the line's main row (owner's choice, Nov 2026):
# the weekday rush-hour A to Rockaway Park. (Euclid Av A trips stay separate.)
SHARE_ROW = {('A', 'S'): ['H15']}
NIGHT_HEADWAY = 15  # minutes: in the morning, trains closer than this end the night
# The late-night pill (owner's rule, Nov 2026): once every express train has
# finished serving the platform for the night, a line's trains are late-night
# trains from the point where they stay more than NIGHT_GAP minutes apart.
# (A line running express all night, the 3 uptown, doesn't hold the others back.)
NIGHT_GAP = 12


def minutes(hms):
    h, m, _ = (int(x) for x in hms.split(':'))
    return h * 60 + m  # may pass 24:00 for trains after midnight


def switch_times(trips_at_penn):
    """From one line's trips at one Penn station, in one direction, on one
    service day, work out the late-night switch:
      nightStart        a late-night (local) train first sets off from its terminal
      lastExpress       the last express train leaves Penn
      firstExpressStart the first daytime express sets off from its terminal
      firstExpressPenn  that train reaches Penn (local "until" this time)
    All in minutes after the service day's midnight. None if the line doesn't switch."""
    evening = sorted(t for t in trips_at_penn if t[0] >= 18 * 60)
    morning = sorted(t for t in trips_at_penn if 3 * 60 <= t[0] < 12 * 60)
    night_local = [t for t in evening if not t[2]]
    express_eve = [t for t in evening if t[2]]
    express_morn = [t for t in morning if t[2]]
    if not night_local or not express_eve or not express_morn:
        return None
    first_local = min(night_local, key=lambda t: t[0])
    first_express = min(express_morn, key=lambda t: t[0])
    return {
        'nightStart': min(t[1] for t in night_local if t[0] >= first_local[0] - 5),
        'lastExpress': max(t[0] for t in express_eve),
        'firstExpressStart': first_express[1],
        'firstExpressPenn': first_express[0],
    }


def night_gap(trips_at_penn):
    """The longest break in a line's departures from Penn over the day (on a
    24-hour clock, wrapping past midnight), if it's long enough to be the
    line's night off: {'after': last train before it, 'until': first after it},
    in minutes after midnight."""
    times = sorted({t[0] % 1440 for t in trips_at_penn})
    if len(times) < 2:
        return None
    gaps = [((times[(i + 1) % len(times)] - t) % 1440, t, times[(i + 1) % len(times)]) for i, t in enumerate(times)]
    size, after, until = max(gaps)
    if size <= NIGHT_GAP_MIN:
        return None
    # When the first train after the break sets off from its terminal: the
    # board says "Daytime service has started" from then until it reaches Penn.
    first = min((t for t in trips_at_penn if t[0] % 1440 == until), key=lambda t: t[1])
    return {'after': after, 'until': until, 'firstStart': first[1] % 1440}


def simplify(p, eps):
    """Douglas-Peucker: keep only the points needed to draw the line within eps."""
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


def line_shapes(z, shape_line):
    """Each line's track paths, simplified, leaving out paths that only repeat
    another one of the same line (short trips over part of the route)."""
    pts = defaultdict(list)
    for r in rows(z, 'shapes.txt'):
        if r['shape_id'] in shape_line:
            pts[r['shape_id']].append((int(r['shape_pt_sequence']), float(r['shape_pt_lat']), float(r['shape_pt_lon'])))
    by_line = defaultdict(list)
    for sid, p in pts.items():
        p = [(a, b) for _, a, b in sorted(p)]
        by_line[shape_line[sid]].append([[round(a, 5), round(b, 5)] for a, b in simplify(p, SIMPLIFY)])
    out = {}
    for line, paths in by_line.items():
        paths.sort(key=len, reverse=True)
        keep, seen = [], set()
        for path in paths:
            cells = {(round(a, 3), round(b, 3)) for a, b in path}
            if keep and len(cells - seen) <= 2:
                continue
            keep.append(path)
            seen |= cells
        out[line] = keep
    return out


def last_express(ts_at_platform):
    """The last express train of the evening at one Penn platform (all lines),
    in evening-continuous minutes; lines running express all night don't count."""
    xs = [(t if t >= 12 * 60 else t + 1440, line, express) for t, line, express in ts_at_platform if t >= 12 * 60 or t < 6 * 60]
    all_night = {line for x, line, e in xs if e and 25 * 60 + 30 <= x <= 28 * 60 + 30}
    return max([x for x, line, e in xs if e and line not in all_night and x < 28 * 60] or [0])


def night_window(trips_at_penn, last_e=0):
    """When a line runs its late-night timetable from Penn: 'from', the first
    evening train after the platform's last express (last_e) from which the
    line's trains stay more than NIGHT_GAP minutes apart, and 'to', the first
    morning train that comes within NIGHT_HEADWAY of the one before.
    Trains at or after 'from', or before 'to', are late-night trains. Each line
    has its own, so the pill drops off line by line as service ramps up."""
    times = sorted({t[0] for t in trips_at_penn})
    morning = [t for t in times if t < 12 * 60]
    # (Evening trips run past midnight as 24:xx, 25:xx...; stop at 4 AM so the
    # next morning's ramp-up doesn't count.)
    evening = [t for t in times if 12 * 60 <= t < 28 * 60]
    to = 12 * 60
    for prev, t in zip(morning, morning[1:]):
        if t >= 3 * 60 and t - prev < NIGHT_HEADWAY:
            to = t
            break
    # The night runs on into the small hours, which the timetable may list as
    # early-morning times (01:29) rather than 25:29: join them on, up to 'to'.
    if not evening:
        return None
    night = evening + [t + 1440 for t in morning if evening[-1] < t + 1440 < to + 1440]
    s = len(night)
    while s - 1 >= 1 and night[s - 1] - night[s - 2] > NIGHT_GAP:
        s -= 1
    after = [x for x in night[s:] if x > last_e]
    frm = (after[0] % 1440 if after[0] >= 1440 else after[0]) if after else None
    if frm is None or 6 * 60 < frm < 19 * 60 or not morning:
        return None
    # Every scheduled late-night trip, by its live-feed id (the PATH method:
    # each live train is matched to its own scheduled trip, so a late-running
    # night train keeps its pill and an early day train never gets one).
    frm_x = frm if frm >= 12 * 60 else frm + 1440
    near = []
    for t in trips_at_penn:
        x = t[0] if t[0] >= 12 * 60 else t[0] + 1440   # evening-continuous minutes
        night_train = (x >= frm_x) and (t[0] >= 12 * 60 or t[0] < to)
        if night_train and t[3]:
            near.append(t[3])
    return {'from': frm, 'to': to, 'trips': sorted(set(near))}


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

    day_of = {}
    for c in rows(z, 'calendar.txt'):
        if c['saturday'] == '1' and c['monday'] == '0':
            day_of[c['service_id']] = 'saturday'
        elif c['sunday'] == '1' and c['monday'] == '0':
            day_of[c['service_id']] = 'sunday'
        elif c['monday'] == '1':
            day_of[c['service_id']] = 'weekday'
    trips = {t['trip_id']: t for t in rows(z, 'trips.txt')}
    trip_line = {tid: line_of(t['route_id']) for tid, t in trips.items()}
    normal = defaultdict(set)
    calls = defaultdict(list)  # trip -> [(seq, station, direction, departure)]
    for st in rows(z, 'stop_times.txt'):
        line = trip_line.get(st['trip_id'])
        if line:
            station = parent.get(st['stop_id'], st['stop_id'].rstrip('NS'))
            normal[line].add(station)
            calls[st['trip_id']].append((int(st['stop_sequence']), station, st['stop_id'][-1], st['departure_time']))

    # Late-night switches at Penn, per station, line, direction and day.
    at_penn = defaultdict(list)  # (station, line, dir, day) -> [(penn min, start min, express?)]
    ends = defaultdict(lambda: defaultdict(int))  # (line, dir) -> last stop -> trips from Penn
    for tid, cs in calls.items():
        cs.sort()
        names = [c[1] for c in cs]
        day = day_of.get(trips[tid]['service_id'])
        if not day:
            continue
        for i, c in enumerate(cs):
            if c[1] in PENN and i + 2 < len(cs):
                express = not any(n in LOCAL_NEXT for n in names[i + 1:i + 4])
                # The trip's id in the MTA's live feed starts with its scheduled
                # start in hundredths of a minute ("033750_1..N03R"); the
                # timetable's trip id carries the same number.
                code = re.search(r'_(\d{6})_', tid)
                ends[(trip_line[tid], c[2])][names[-1]] += 1
                at_penn[(c[1], trip_line[tid], c[2], day)].append((minutes(c[3]), minutes(cs[0][3]), express, code.group(1) if code else ''))
    switches, gaps, nights = {}, {}, {}
    platform = defaultdict(list)  # (station, dir, day) -> [(penn min, line, express?)]
    for (station, line, d, day), ts in at_penn.items():
        platform[(station, d, day)] += [(t[0], line, t[2]) for t in ts]
    last_e = {k: last_express(v) for k, v in platform.items()}
    for (station, line, d, day), ts in at_penn.items():
        w = night_window(ts, last_e[(station, d, day)]) if not (line in NIGHT_GAP_LINES and night_gap(ts)) else None
        if w:
            nights.setdefault(station, {}).setdefault(line, {}).setdefault(d, {})[day] = w
        sw = switch_times(ts)
        if sw:
            switches.setdefault(station, {}).setdefault(line, {}).setdefault(d, {})[day] = sw
        gap = night_gap(ts) if line in NIGHT_GAP_LINES else None
        if gap:
            # The section it's shown in: how the line usually runs from Penn.
            express = sum(t[2] for t in ts) * 2 > len(ts)
            gap.update(svc='express' if express else 'local')
            gaps.setdefault(station, {}).setdefault(line, {}).setdefault(d, {})[day] = gap
    for line, r in routes.items():
        r['normal'] = sorted(normal[line])

    shape_line = {}
    for t in trips.values():
        shape_line.setdefault(t['shape_id'], line_of(t['route_id']))
    shapes = line_shapes(z, shape_line)
    SHAPES_OUT.write_text(json.dumps({'version': info.get('feed_version', ''), 'lines': shapes}, separators=(',', ':')))
    print(f'Wrote {SHAPES_OUT}: {sum(len(v) for v in shapes.values())} track paths, {SHAPES_OUT.stat().st_size // 1024} KB')

    # Each line's main last stops from Penn, by direction: those at least 10%
    # of its trips from Penn end at (the A downtown: Far Rockaway and Lefferts
    # Blvd). The board shows a line's trains to these on one row, named by the
    # next train's last stop. Any other last stop (a short trip when the
    # schedule changes over, the weekday rush-hour A to Rockaway Park, or a
    # service change like A to Chambers St) gets a row of its own.
    terminals = {}
    for (line, d), counts in ends.items():
        total = sum(counts.values())
        main = {k for k, n in counts.items() if n >= 0.1 * total} | set(SHARE_ROW.get((line, d), []))
        terminals.setdefault(line, {})[d] = sorted(main & set(counts))
    # Each scheduled trip's time at Penn, by its live-feed id, so the board
    # can tell a train running on time from a late one (a delay pill comes
    # off an on-time train). "code:minutes" pairs, minutes after the service
    # day's midnight (past 1440 after midnight).
    times = {}
    for (station, line, d, day), ts in at_penn.items():
        pairs = sorted({(t[3], t[0]) for t in ts if t[3]})
        times.setdefault(station, {}).setdefault(line, {}).setdefault(d, {})[day] = ','.join(f'{c}:{m}' for c, m in pairs)
    TIMES_OUT = OUT.with_name('subway-times.json')
    TIMES_OUT.write_text(json.dumps({'version': info.get('feed_version', ''), 'penn': times}, separators=(',', ':')))
    print(f'Wrote {TIMES_OUT}: {TIMES_OUT.stat().st_size // 1024} KB')
    doc = {'version': info.get('feed_version', ''), 'routes': routes, 'stops': stops, 'switches': switches, 'nightGaps': gaps, 'night': nights, 'terminals': terminals}
    OUT.write_text(json.dumps(doc, separators=(',', ':')))
    print(f'Wrote {OUT}: {len(routes)} lines, {len(stops)} stations, {OUT.stat().st_size // 1024} KB')
    for station, ls in nights.items():
        for line, ds in sorted(ls.items()):
            for d, days in sorted(ds.items()):
                fmt = lambda m: f'{m // 60 % 24}:{m % 60:02}'
                print(f'Late-night {line} {d} at {station}:', ', '.join(f'{k} {fmt(w["from"])}-{fmt(w["to"])}' for k, w in sorted(days.items())))
    for station, ls in gaps.items():
        for line, ds in ls.items():
            for d, days in ds.items():
                print(f'No {line} {d} from {station} late nights:', {k: (v['after'], v['until']) for k, v in days.items()})
    print(f'Late-night switches: {sum(len(d) for ls in switches.values() for l in ls.values() for d in l.values())} line/direction/day combinations')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
