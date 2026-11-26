#!/usr/bin/env python3
"""Build docs/penn-elevators.json: the elevators and escalators at 34 St-Penn
Station (both subway stations and the LIRR entrance) and Grand Central-42 St, with what each serves and
the MTA's own advice when it's out (owner, Nov 25: elevator outages on the board).

The live outages come from the MTA's feed in the browser; this file adds the
MTA's "alternative route" text, which is only in the (large) equipment list.

    python3 scripts/build-penn-elevators.py
"""
import json, sys, urllib.request
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from hubs import hubs  # noqa: E402

OUT = Path(__file__).resolve().parent.parent / 'docs' / 'penn-elevators.json'
URL = 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fnyct_ene_equipments.json'
# Every hub's stations (docs/hub.js elevatorStations).
STATIONS = {n for h in hubs().values() for n in h['elevatorStations']}


def main():
    with urllib.request.urlopen(urllib.request.Request(URL, headers={'User-Agent': 'penn-board'}), timeout=60) as r:
        eq = json.load(r)
    out = {}
    for x in eq:
        if x.get('station') in STATIONS and x.get('isactive', 'Y') == 'Y':
            out[x['equipmentno']] = {'type': x.get('equipmenttype'), 'lines': x.get('linesservedbyelevator') or x.get('trainno'),
                                     'short': (x.get('shortdescription') or '').strip(), 'serving': (x.get('serving') or '').strip(),
                                     'ada': x.get('ADA') == 'Y', 'alt': ' '.join((x.get('alternativeroute') or '').split())}
    OUT.write_text(json.dumps(out, separators=(',', ':')))
    print(f'Wrote {OUT}: {len(out)} elevators and escalators')


if __name__ == '__main__':
    main()
