# Handoff: Penn Station departure board

Written 16 Nov 2026 (evening, New York time). Read this first, then `README.md`.

## What the owner wants

A single website showing everything leaving New York Penn Station: LIRR, NJ Transit
and Amtrak with track numbers and status (boarding, delayed, cancelled), plus subway
times. Arrival tracks are a nice-to-have. Their focus is "a unified NYP departure
board"; they may publish it publicly. An earlier attempt by another assistant never
worked and was not used.

## State of the project

Everything is in this folder. It is not in git and has never been deployed.

| File | What it is |
| --- | --- |
| `server.js` | Zero-dependency Node server (Node 18+). Fetches each feed, normalises it, serves `/api/board` and the static page. |
| `public/index.html`, `style.css`, `app.js` | The page. Polls `/api/board` every 20 s. No build step, no framework. |
| `README.md` | How to run, how to add the NJ Transit login, data sources. |
| `screenshot.png` | Desktop screenshot from before the PATH panel was added. |

Run: `node server.js`, open http://localhost:3000.
In a Claude cloud container, Node's fetch ignores the proxy unless you run
`NODE_USE_ENV_PROXY=1 node server.js`.

### Verified against live data

- **LIRR** (MTA TrainTime, `backend-unified.mylirr.org/arrivals/NYK`, needs header
  `accept-version: 3.0`): departures and arrivals, posted track, usual track
  (`sched_track`, shown greyed and labelled "usual"), status.
- **Amtrak** (Amtraker community feed, `api-v3.amtraker.com/v3/trains`): departures
  and arrivals, delay, scheduled time. The `platform` field is usually empty and
  fills in shortly before departure.
- **Subway** (MTA GTFS-realtime, feeds `nyct%2Fgtfs` and `nyct%2Fgtfs-ace`): 1/2/3
  (stop `128`) and A/C/E (stop `A28`). Decoded by a small hand-written protobuf
  reader in `server.js`; no library.
- Page checked with Playwright at desktop and iPhone sizes: no console errors, no
  horizontal overflow.

### Written but never run against real data

- **NJ Transit** (`raildata.njtransit.com/api/TrainData/getToken` and
  `getTrainSchedule`, station `NY`). Needs `NJT_USERNAME` / `NJT_PASSWORD` env vars
  from a free developer account. The owner was reading the developer terms and had
  not confirmed they have a login. Field names (`ITEMS`, `SCHED_DEP_DATE`, `TRACK`,
  `STATUS`, `SEC_LATE`, `TRAIN_ID`, `LINE`, `LINEABBREVIATION`, `DESTINATION`,
  `STOPS`) are from memory of the API docs: expect to fix details on first run.
  Assumptions to check: Amtrak rows are identified by line name or a `TRAIN_ID`
  starting with `A` followed by digits, and are merged into the Amtraker rows by
  train number to supply tracks. The token is cached in `.njt-token.json` because
  NJ Transit limits token requests per day.
- **PATH** (`www.panynj.gov/bin/portauthority/ridepath.json`, station `33S`). The
  feed answered `{"results":[]}` on every check that evening, although PATH runs
  all night. `parsePath` was tested only against a hand-written sample. First job:
  check the feed in the daytime. If still empty, treat it as retired and find
  another source; the agreed fallback is PATH's published timetable, labelled as
  scheduled and not live.

## Decisions already made (do not reopen without asking)

- **Server-side aggregation.** Required: the NJ Transit login must stay off the
  browser, and NJ Transit's terms forbid apps where visitors pull from its servers
  directly. Redistribution from your own server is explicitly allowed.
- **NJ Transit terms compliance** (owner asked for these): NJ Transit status,
  destination and scheduled time are shown verbatim, only the row colour is derived;
  footer disclaims accuracy and affiliation and says data is redistributed from this
  server; a "may not be real time" notice appears after 60 s without an update.
  Polling is capped at one NJ Transit request per 30 s (about 2,900 a day; the
  limit is 100,000).
- **No mock or sample data on the page.** A feed that is missing says so.
- **No scraping NJ Transit's public DepartureVision site or reusing its embedded
  credentials.** That was attempted once and blocked; use the developer account.
- **Design:** Pennsylvania Railroad palette (Brunswick green ground, Tuscan red
  masthead, gold-leaf track plates, ivory text), one typeface (Archivo, using its
  width axis). The gold track plate is the one loud element; it flips once when a
  track is newly posted. Subway and PATH are side panels, not rows in the rail list,
  because they would flood it. On phones they become a third tab.
- **PATH is included with an explicit note** that it is not in Penn Station (33 St
  station, one block east on Sixth Avenue, own fare).

## Next steps, in order

1. Daytime check of the PATH feed (see above).
2. When the owner has an NJ Transit login: run with it, fix the adapter against the
   real response, confirm Amtrak tracks merge correctly.
3. **Disruption alternatives** (owner wants this; needs step 2 first). When several
   upcoming NJ Transit trains are cancelled or badly late (suggested start: 3 of the
   next 8 cancelled or 20+ min late) or an NJ Transit alert is posted, show a banner
   with ways out of New York: PATH to Hoboken then NJ Transit from Hoboken Terminal;
   PATH to Newark Penn via Journal Square then NEC / Coast / Raritan Valley; NJ
   Transit buses from the bus terminal if that feed works. Include next NJ Transit
   departures from Hoboken and Newark Penn (same API, other station codes) and quote
   any cross-honouring alert text verbatim. Thresholds are the owner's call.
4. Ideas discussed, not committed: service alerts (MTA and NJ Transit feeds); Herald
   Square subway lines grouped with PATH as "one block east"; a destination filter
   ("every way to Newark"); 7 train at Hudson Yards; M34 buses (needs a free MTA key);
   Citi Bike docks. A Port Authority Bus Terminal page was judged only partly
   feasible (NJ Transit buses only, and only if the bus feed carries gate numbers);
   the owner's priority is Penn Station.
5. Hosting, if they decide to publish: any Node host (Render, Railway, Fly.io) with
   the two NJ Transit env vars. Not started.

## Known rough edges

- LIRR station and branch names are a hard-coded code-to-name table in `server.js`;
  an unknown code shows as the raw code.
- Subway destinations come from a hard-coded table of terminal stop IDs; an unlisted
  terminal falls back to "Uptown" / "Downtown".
- LIRR `otp` is assumed to be seconds, negative meaning late.
- Amtrak rows only exist once Amtraker lists the train, so departures many hours out
  may be missing.
- NJ Transit publishes departures only; there are no NJ Transit arrivals.

## Environment notes

The owner's Default cloud environment had these hosts added for this project:
`api-endpoint.mta.info`, `backend-unified.mylirr.org`, `api-v3.amtraker.com`,
`www.njtransit.com`, `dv.njtransit.com`, `raildata.njtransit.com`, `www.panynj.gov`.
`www.njtransit.com` and `dv.njtransit.com` are no longer needed by the code.
