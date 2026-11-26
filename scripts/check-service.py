#!/usr/bin/env python3
"""Daily check of every transit agency's service notices before a big event
(owner, Nov 26: "do checks for schedule changes daily from now until Saturday
to make sure nothing is missed from any of the transit agencies").

For each event in docs/city-events.json that has a `watch` pattern and hasn't
ended, it reads the MTA's subway, bus, LIRR and Metro-North alerts, NJ
Transit's and PATH's messages (through the relay), and the MTA TrainTime
notices for Penn and Grand Central, and:

  - adds any bus route or subway line the MTA ties to the event to the event's
    busRoutes / lines (never removes: the event's lists only grow), so every
    hub's banner picks them up;
  - writes docs/service-check.json: when it checked, which sources answered,
    every notice about the event, and every holiday / special-schedule notice
    up to the event's end (shown in the banner's details).

Amtrak publishes no service-alert feed, so it isn't covered.

    python3 scripts/check-service.py
"""
import json, re, sys, time, urllib.request
from datetime import datetime
from pathlib import Path

DOCS = Path(__file__).resolve().parent.parent / 'docs'
EVENTS = DOCS / 'city-events.json'
OUT = DOCS / 'service-check.json'
RELAY = 'https://penn-board-relay.pennstationboard.workers.dev'
MTA = 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2F{}.json'
SCHEDULE = re.compile(r'holiday|special schedule|(saturday|sunday|weekday|friday) schedule|extra (trains|service)|additional (trains|service)|thanksgiving|parade', re.I)


def get(url, headers=None):
    req = urllib.request.Request(url, headers={'User-Agent': 'penn-board-service-check', **(headers or {})})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def text(t):
    tr = (t or {}).get('translation') or []
    return next((x['text'] for x in tr if x.get('language') == 'en'), tr[0]['text'] if tr else '')


def mta(feed, agency):
    out = []
    for e in get(MTA.format(feed)).get('entity', []):
        a = e.get('alert', {})
        routes = sorted({ie['route_id'] for ie in a.get('informed_entity', []) if ie.get('route_id')})
        per = [(int(p.get('start') or 0), int(p.get('end') or 0)) for p in a.get('active_period', [])]
        out.append({'agency': agency, 'id': e['id'], 'head': text(a.get('header_text')), 'desc': text(a.get('description_text')),
                    'routes': routes, 'start': min((p[0] for p in per), default=0), 'end': max((p[1] for p in per), default=0)})
    return out


def njt():
    d = get(f'{RELAY}/njt')
    return [{'agency': 'NJ Transit', 'id': f"njt-{i}", 'head': m.get('MSG_TEXT') or m.get('MSG_PUBDATE', ''), 'desc': '', 'routes': [], 'start': 0, 'end': 0}
            for i, m in enumerate(d.get('MESSAGES') or [])]


def path():
    return [{'agency': 'PATH', 'id': f"path-{m.get('messageid')}", 'head': m.get('Subject', ''), 'desc': re.sub(r'<[^>]+>', ' ', m.get('SentMessage', '')),
             'routes': [], 'start': 0, 'end': 0} for m in get(f'{RELAY}/path-alerts')]


def traintime(code, agency):
    d = get(f'https://backend-unified.mylirr.org/arrivals/{code}', {'accept-version': '3.0'})
    items = (d.get('alerts') or []) + (d.get('banners') or [])
    out = []
    for x in items:
        h = x.get('text') or x.get('header') or x.get('title') or x.get('message') or json.dumps(x)[:300]
        out.append({'agency': agency, 'id': f"tt-{code}-{abs(hash(h)) % 10**8}", 'head': re.sub(r'<[^>]+>', ' ', str(h)), 'desc': '', 'routes': [], 'start': 0, 'end': 0})
    return out


SOURCES = {
    'MTA subway': lambda: mta('subway-alerts', 'MTA subway'),
    'MTA bus': lambda: mta('bus-alerts', 'MTA bus'),
    'LIRR': lambda: mta('lirr-alerts', 'LIRR'),
    'Metro-North': lambda: mta('mnr-alerts', 'Metro-North'),
    'NJ Transit': njt,
    'PATH': path,
    'TrainTime (Penn)': lambda: traintime('NYK', 'TrainTime'),
    'TrainTime (Grand Central)': lambda: traintime('GCT', 'TrainTime'),
}


def main():
    doc = json.loads(EVENTS.read_text())
    now = time.time()
    events = [e for e in doc['events'] if e.get('watch') and datetime.fromisoformat(e['end']).timestamp() > now - 6 * 3600]
    gh_out = __import__('os').environ.get('GITHUB_OUTPUT')
    if gh_out:
        with open(gh_out, 'a') as f:
            f.write(f"watching={'true' if events else 'false'}\n")
    if not events:
        print('No event to watch.')
        return
    until = max(datetime.fromisoformat(e['end']).timestamp() for e in events)
    alerts, sources = [], {}
    for name, fn in SOURCES.items():
        try:
            got = fn()
            alerts += got
            sources[name] = {'ok': True, 'notices': len(got)}
        except Exception as ex:  # one agency down doesn't stop the rest
            sources[name] = {'ok': False, 'error': str(ex)[:200]}
    seen, unique = set(), []
    for a in alerts:
        k = (a['agency'], a['head'].strip())
        if a['head'].strip() and k not in seen:
            seen.add(k)
            unique.append(a)
    slim = lambda a: {k: a[k] for k in ('agency', 'id', 'head', 'routes', 'start', 'end') if a.get(k) not in (None, '', [], 0)}
    out = {'checked': int(now), 'until': int(until), 'sources': sources, 'events': {}, 'schedule': []}
    changed = False
    for e in events:
        pat = re.compile(e['watch'], re.I)
        mine = [a for a in unique if pat.search(f"{a['head']} {a['desc']}") and (not a['end'] or a['end'] > now)]
        out['events'][e['id']] = [slim(a) for a in mine]
        for a in mine:
            if a['agency'] == 'MTA bus':
                for r in a['routes']:
                    name = r[:-1] + '-SBS' if r.endswith('+') else r
                    if name not in e.setdefault('busRoutes', []):
                        e['busRoutes'].append(name)
                        changed = True
                        print(f"{e['id']}: added bus route {name} ({a['id']})")
            if a['agency'] == 'MTA subway':
                for r in a['routes']:
                    if r not in e.setdefault('lines', []):
                        e['lines'].append(r)
                        changed = True
                        print(f"{e['id']}: added subway line {r} ({a['id']})")
        print(f"{e['id']}: {len(mine)} notices about it")
    out['schedule'] = [slim(a) for a in unique if SCHEDULE.search(a['head']) and (not a['start'] or a['start'] <= until) and (not a['end'] or a['end'] > now)]
    if changed:
        EVENTS.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + '\n')
    OUT.write_text(json.dumps(out, indent=1, ensure_ascii=False) + '\n')
    for n, s in sources.items():
        print(f"{n}: {'ok, ' + str(s['notices']) + ' notices' if s['ok'] else 'FAILED ' + s['error']}")
    print(f"Holiday/special schedule notices through the event: {len(out['schedule'])}")
    for a in out['schedule']:
        print(f"  [{a['agency']}] {a['head'][:110]}")


if __name__ == '__main__':
    sys.exit(main())
