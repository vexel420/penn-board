#!/usr/bin/env python3
"""Build docs/subway-entrances.json: every subway entrance from the MTA's
"Subway Entrances and Exits" open data (data.ny.gov, i9wp-a4ja), for the
board's maps (owner, Nov 24: show where the entrances are, like Google Maps).

{stop id: [[lat, lon, type, way], ...]}, stop ids as in the MTA's GTFS.
type: S stairs, E elevator, X escalator, R ramp, D door/other; way: B entry
and exit, X exit only, N entry only.

    python3 scripts/build-subway-entrances.py
"""
import json, urllib.request
from collections import defaultdict
from pathlib import Path

URL = 'https://data.ny.gov/resource/i9wp-a4ja.json?$limit=5000'
OUT = Path(__file__).resolve().parent.parent / 'docs' / 'subway-entrances.json'
TYPES = {'stair': 'S', 'elevator': 'E', 'escalator': 'X', 'ramp': 'R'}

rows = json.load(urllib.request.urlopen(URL, timeout=60))
out = defaultdict(list)
for r in rows:
    try:
        la, lo = round(float(r['entrance_latitude']), 6), round(float(r['entrance_longitude']), 6)
    except (KeyError, ValueError):
        continue
    t = TYPES.get(str(r.get('entrance_type', '')).lower(), 'D')
    entry, exit_ = r.get('entry_allowed') == 'YES', r.get('exit_allowed') == 'YES'
    way = 'B' if entry and exit_ else 'X' if exit_ else 'N'
    e = [la, lo, t, way]
    if e not in out[r['gtfs_stop_id']]:
        out[r['gtfs_stop_id']].append(e)
OUT.write_text(json.dumps(out, separators=(',', ':')))
print(f'Wrote {OUT} ({OUT.stat().st_size // 1024} KB): {sum(map(len, out.values()))} entrances at {len(out)} stations')
