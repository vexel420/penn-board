#!/usr/bin/env python3
"""Build docs/mnr-stations.json: Metro-North station codes (as TrainTime uses
them, "0NY", "0BC") -> station names, from the MTA's Metro-North timetable, for
the Grand Central page.

    python3 scripts/build-mnr-stations.py gtfsmnr.zip
"""
import csv, io, json, sys, zipfile
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / 'docs' / 'mnr-stations.json'


def main(path):
    z = zipfile.ZipFile(path)
    with z.open('stops.txt') as f:
        names = {r['stop_code']: r['stop_name'].strip() for r in csv.DictReader(io.TextIOWrapper(f, encoding='utf-8-sig')) if r.get('stop_code')}
    OUT.write_text(json.dumps(names, separators=(',', ':'), sort_keys=True))
    print(f'Wrote {OUT}: {len(names)} stations')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
