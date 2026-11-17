# Penn Station board

Live departures, arrivals, tracks and statuses for LIRR, NJ Transit and Amtrak
at New York Penn Station, plus 1/2/3 and A/C/E subway times.

## Run it

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

To put it online, deploy this folder to any Node host (Render, Railway, Fly.io)
and set `NJT_USERNAME` and `NJT_PASSWORD` as environment variables there.
