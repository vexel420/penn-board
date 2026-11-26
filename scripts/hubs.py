"""The hubs the boards cover, read from docs/hub.js (the one place they're
listed), so every data build covers every hub without its own list.

    hubs() -> {'nyp': {'stations': {'128': ['1', '2', '3'], 'A28': [...]}, 'walk': 8}, 'gct': {...}}
"""
import re
from pathlib import Path

HUB_JS = Path(__file__).resolve().parent.parent / 'docs' / 'hub.js'


def hubs():
    text = HUB_JS.read_text()
    out = {}
    # Each hub starts with "    <id>: {" at four spaces' indent.
    starts = [(m.start(), m.group(1)) for m in re.finditer(r"^ {4}(\w+): \{\s*$", text, re.M)]
    for i, (pos, hid) in enumerate(starts):
        block = text[pos:starts[i + 1][0] if i + 1 < len(starts) else len(text)]
        seg = re.search(r"stations: \[(.*?)\],\s*$", block, re.M)
        stations = {m.group(1): re.findall(r"'([^']+)'", m.group(2)) for m in re.finditer(r"\{ id: '(\w+)', lines: \[([^\]]*)\] \}", seg.group(1))} if seg else {}
        walk = re.search(r"subwayWalk: (\d+)", block)
        elev = re.search(r"elevatorStations: \[([^\]]*)\]", block)
        out[hid] = {'stations': stations, 'walk': int(walk.group(1)) if walk else 5,
                    'elevatorStations': re.findall(r"'([^']+)'", elev.group(1)) if elev else []}
    return out


def hub_stations():
    """Every hub subway station id -> its lines."""
    return {s: ls for h in hubs().values() for s, ls in h['stations'].items()}


if __name__ == '__main__':
    print(hubs())
