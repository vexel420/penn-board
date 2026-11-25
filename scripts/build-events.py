#!/usr/bin/env python3
"""Build docs/events.json: big events that crowd the stations (owner, Nov 25:
"event warnings is a good idea, we should incorporate that now").

  - Rangers home games at Madison Square Garden (right above Penn) and
    Islanders home games at UBS Arena (LIRR to Elmont-UBS Arena), from the
    NHL's own published schedule (api-web.nhle.com).
  - Anything the owner lists in docs/events-extra.json (concerts, the Knicks,
    MetLife Stadium, parades): [{"venue": "...", "title": "...", "start":
    "2026-12-05T19:30:00-05:00", "kind": "show"}]. Times with their UTC offset.

Knicks games and concerts come from Ticketmaster through the relay (/events)
once its key is set; the NBA blocks automated access to its own files.

Runs daily (GitHub Actions) so a rescheduled game is caught within a day.

    python3 scripts/build-events.py
"""
import datetime, json, sys, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'docs' / 'events.json'
EXTRA = ROOT / 'docs' / 'events-extra.json'
TEAMS = [('NYR', 'Madison Square Garden'), ('NYI', 'UBS Arena')]


def get(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'penn-board events builder (github.com/vexel420/penn-board)'})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def main():
    now = datetime.datetime.now(datetime.timezone.utc)
    old = json.loads(OUT.read_text()) if OUT.exists() else {'events': []}
    events, failed = [], []
    for team, venue in TEAMS:
        try:
            d = get(f'https://api-web.nhle.com/v1/club-schedule-season/{team}/now')
        except Exception as e:  # keep last week's copy of this team
            print(f'{team}: {e}', file=sys.stderr)
            failed.append(team)
            events += [x for x in old['events'] if x.get('team') == team]
            continue
        name = lambda x: ' '.join(v['default'] for v in (x.get('placeName'), x.get('commonName')) if v)
        for g in d.get('games', []):
            if g['homeTeam']['abbrev'] != team or g.get('gameScheduleState', 'OK') != 'OK':
                continue
            start = datetime.datetime.fromisoformat(g['startTimeUTC'].replace('Z', '+00:00'))
            if start < now - datetime.timedelta(hours=8):
                continue
            events.append({'id': f'nhl-{g["id"]}', 'team': team, 'kind': 'hockey',
                           'venue': (g.get('venue') or {}).get('default', venue), 'start': g['startTimeUTC'],
                           'title': f'{name(g["homeTeam"]) or team} vs. {name(g["awayTeam"]) or g["awayTeam"]["abbrev"]}'})
    if EXTRA.exists():
        for i, x in enumerate(json.loads(EXTRA.read_text())):
            start = datetime.datetime.fromisoformat(x['start'])
            if start >= now - datetime.timedelta(hours=8):
                events.append({'id': f'extra-{i}', 'kind': x.get('kind', 'show'), 'venue': x['venue'], 'title': x['title'],
                               'start': start.astimezone(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')})
    events.sort(key=lambda x: x['start'])
    if events == old.get('events'):
        print('No changes.')
        return
    OUT.write_text(json.dumps({'events': events, 'built': now.strftime('%Y-%m-%dT%H:%M:%SZ')}, separators=(',', ':')))
    print(f'Wrote {OUT}: {len(events)} events' + (f' (kept old copy for {failed})' if failed else ''))
    for x in events[:6]:
        print(' ', x['start'], x['venue'], '|', x['title'])


if __name__ == '__main__':
    main()
