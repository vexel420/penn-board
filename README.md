# Penn Station board

Live departures, arrivals, tracks and statuses for LIRR, NJ Transit and Amtrak
at New York Penn Station, plus 1/2/3 and A/C/E subway times.

## Two ways to run it

**As a plain website (GitHub Pages).** The `docs/` folder works with no server:
the page reads the LIRR, Amtrak and subway feeds straight from the browser. To
turn it on, open the repository's Settings, then Pages, choose "Deploy from a
branch", pick `main` and the `/docs` folder, and save. NJ Transit and live PATH
times are not available this way.

**With the server.** Adds NJ Transit (needs a login, below) and PATH.

## Run the server

```bash
node server.js
```

Then open http://localhost:3000. Needs Node 18 or newer; there is nothing to install.

## Add NJ Transit

NJ Transit only serves its data to registered developers. Register for free at
https://developer.njtransit.com/registration/login (ask for the Rail Data API),
then start the server with your login:

```bash
NJT_USERNAME=you NJT_PASSWORD=secret node server.js
```

This also fills in Amtrak track numbers, which NJ Transit's Penn Station feed carries.

## Where the data comes from

| Service | Source | Tracks |
| --- | --- | --- |
| LIRR | MTA TrainTime | Posted track, plus the usual track before it is posted. Departures and arrivals. |
| NJ Transit | NJ Transit RailData API | Posted track. Departures only. |
| Amtrak | Amtraker (community feed; Amtrak has no public API) | From NJ Transit's feed when connected, otherwise once Amtrak posts it. |
| Subway | MTA GTFS-realtime | Not applicable. |

PATH: when live PATH times aren't available, the board shows scheduled times
from `docs/path-schedule.json`. Rebuild it from PATH's latest timetable with:

```bash
curl -L -o path-gtfs.zip https://data.trilliumtransit.com/gtfs/path-nj-us/path-nj-us.zip
python3 scripts/build-path-schedule.py path-gtfs.zip
```

Subway: line colours, station names and each line's normal stops come from
`docs/subway-data.json`. Rebuild it when the MTA publishes a new timetable:

```bash
curl -o gtfs_subway.zip https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip
python3 scripts/build-subway-data.py gtfs_subway.zip
```

To put it online, deploy this folder to any Node host (Render, Railway, Fly.io)
and set `NJT_USERNAME` and `NJT_PASSWORD` as environment variables there.
