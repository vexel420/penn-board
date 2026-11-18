#!/usr/bin/env python3
"""Build docs/path-schedule.json: PATH's timetable for trains leaving 33 St.

The board shows these scheduled times when live PATH times aren't available
(always on the GitHub Pages version, which can't read PATH's live feed).

The timetables come straight from PATH's own schedule pages, which are kept
up to date (PATH's GTFS file stopped being updated in 2025):
  weekday  https://www.panynj.gov/path/en/schedules-maps/weekday-schedules.html
  weekend  https://www.panynj.gov/path/en/schedules-maps/weekend-schedules.html
  (the pages' data is read from their ".model.json" versions)

Run it again whenever PATH changes its timetable:

    python3 scripts/build-path-schedule.py

Only the regular weekday, Saturday and Sunday timetables are used. The weekend
page also carries old special-weekend pages (for construction), which are skipped.
"""
import html, json, re, sys, urllib.request
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / 'docs' / 'path-schedule.json'
BASE = 'https://www.panynj.gov/content/path/en/schedules-maps/'
COLORS = {'Journal Square': '#ff9900', 'Hoboken': '#4d92fb', 'Journal Square via Hoboken': '#ff9900'}
TIME = re.compile(r'^(\d{1,2}):(\d{2})\s*([AP])\.?M\.?$', re.I)


def fetch(page):
    req = urllib.request.Request(BASE + page + '.model.json', headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def clean(cell):
    return re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', ' ', cell))).strip()


def tables_in(node):
    """Every timetable table (as HTML) in a page's component tree, in order."""
    out = []
    if isinstance(node, dict):
        text = node.get('text')
        if isinstance(text, str):
            out += re.findall(r'<table.*?</table>', text, flags=re.S)
        for v in node.values():
            if isinstance(v, (dict, list)):
                out += tables_in(v)
    elif isinstance(node, list):
        for v in node:
            out += tables_in(v)
    return out


def find(node, test):
    """Components in the tree matching test()."""
    out = []
    if isinstance(node, dict):
        if test(node):
            out.append(node)
        for v in node.values():
            if isinstance(v, (dict, list)):
                out += find(v, test)
    elif isinstance(node, list):
        for v in node:
            out += find(v, test)
    return out


def from_33st(tables):
    """Departures from 33 St in these tables, as (minutes after midnight, destination)."""
    trips = []
    for t in tables:
        heads = [clean(h).lower() for h in re.findall(r'<b>(.*?)</b>', t, flags=re.S)]
        if not heads or not heads[0].startswith('33 st'):
            continue
        if any(h.startswith('hoboken') for h in heads[1:]) and not any('arrival at hoboken' in h for h in heads):
            dest = 'Journal Square via Hoboken'
        elif any('arrival at hoboken' in h for h in heads):
            dest = 'Hoboken'
        elif any('jsq' in h or 'journal' in h or 'grove' in h for h in heads):
            dest = 'Journal Square'
        else:
            continue
        for row in re.findall(r'<tr.*?</tr>', t, flags=re.S):
            cells = re.findall(r'<td.*?>(.*?)</td>', row, flags=re.S)
            if not cells:
                continue
            m = TIME.match(clean(cells[0]))
            if not m:
                continue
            h, mi, ap = int(m.group(1)) % 12, int(m.group(2)), m.group(3).upper()
            trips.append((h * 60 + mi + (720 if ap == 'P' else 0), dest))
    return sorted(set(trips))


def effective(page):
    text = ' '.join(clean(n['text']) for n in find(page, lambda n: isinstance(n.get('text'), str)))
    m = re.search(r'Effective\s+([A-Z][a-z]+ \d{1,2}, \d{4})', text)
    return m.group(1) if m else ''


def main():
    weekday_page = fetch('weekday-schedules')
    weekend_page = fetch('weekend-schedules')
    days = {'weekday': from_33st(tables_in(weekday_page))}
    # The regular weekend timetables are the accordion lists titled "Saturday
    # Schedule" and "Sunday Schedule"; dated lists belong to old special weekends.
    for day in ('saturday', 'sunday'):
        lists = find(weekend_page, lambda n: str(n.get('title', '')).lower().startswith(day + ' schedule'))
        days[day] = from_33st(tables_in(lists[0])) if lists else []
    for day, trips in days.items():
        if not trips:
            sys.exit(f'No {day} departures from 33 St found: PATH may have changed its pages.')
    doc = {
        'station': '33 St',
        'source': 'PATH schedule pages, panynj.gov',
        'published': f"Weekday timetable effective {effective(weekday_page)}" if effective(weekday_page) else '',
        'validUntil': '',  # PATH's pages give no end date
        'days': {day: [{'t': t, 'to': dest, 'color': COLORS[dest]} for t, dest in trips] for day, trips in days.items()},
    }
    OUT.write_text(json.dumps(doc, separators=(',', ':')))
    summary = ', '.join(f"{day} {len(t)}" for day, t in days.items())
    print(f'Wrote {OUT}: {summary} departures from 33 St. {doc["published"]}')


if __name__ == '__main__':
    main()
