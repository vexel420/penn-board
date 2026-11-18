# Handoff: Penn Station departure board

Written 16 Nov 2026 (evening, New York time). Read this first, then `README.md`.

## Update, later the same evening

- The project is on GitHub: https://github.com/vexel420/penn-board (public, `main`).
- `public/` was renamed `docs/` and the feed readers moved to `docs/feeds.js`,
  which both `server.js` and the page load. The page now runs **without a server**:
  it asks for `api/board`, and on a 404 (or on a `github.io` host) it reads LIRR,
  Amtrak and subway feeds directly in the browser. Tested this way with a plain
  static file server. NJ Transit and PATH still need `server.js` (NJ Transit needs
  a private login; the PATH feed sends no CORS header).
- Intended free hosting: GitHub Pages from `main` / `docs`, giving
  https://vexel420.github.io/penn-board/ . The owner has to switch Pages on in the
  repository settings; a session cannot do it. Not confirmed live.
- A Claude artifact cannot run the board: artifact pages are not allowed to fetch
  from other sites. Where the notes below say `public/`, read `docs/`.

## Subway lines and reroutes (added 17 Nov)

- `docs/subway-data.json`, built by `scripts/build-subway-data.py` from the
  MTA's GTFS (https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip, current copy
  covers Nov 2026 to May 2027), holds every line's official colours, every
  station's name and location, and the stations each line normally serves.
- The subway reader also takes the B/D/F/M feed and keeps each train's stops
  from Penn onwards. The page colours bullets and names terminals from the data
  file, so any line that turns up (a 5 on the 7 Av line, an F on the 8 Av line)
  draws correctly.
- A train calling at any station its line doesn't normally serve is marked
  "Rerouted, see map". Tapping opens a dialog with a Leaflet map (cdnjs,
  OpenStreetMap tiles darkened in CSS; CARTO's tiles now need an API key) and
  the stop list, unusual stops in gold. The line joins stations in order and
  says it doesn't trace exact tracks. Tested with simulated 5 and F reroutes;
  none was running during the session.
- Rebuild the data file when the MTA publishes a new timetable (dates in its
  feed_info); a stale file could flag a newly normal stop as a reroute.

## PATH scheduled times (added 17 Nov)

- The live PATH feed (`www.panynj.gov/bin/portauthority/ridepath.json`) has
  returned no trains since at least 16 Nov, day and night. A community live
  source, `path.api.razza.dev`, reset every connection on 17 Nov.
- So the PATH panel shows scheduled times whenever live times are missing (and
  always on GitHub Pages): `docs/path-schedule.json`, built by
  `scripts/build-path-schedule.py` from PATH's GTFS timetable at
  https://data.trilliumtransit.com/gtfs/path-nj-us/path-nj-us.zip . It uses only
  the regular weekday, Saturday and Sunday timetables; holiday and construction
  timetables are ignored, and the page says so.
- That timetable was published May 2025 and covers service only to 1 June 2026.
  It was the newest copy found; the page warns that times may have changed.
  Rerun the script when PATH publishes a newer one (the page's warning goes
  away by itself once `validUntil` is in the future).
- This session ran in a personal cloud environment named `penn-board` that
  allows the transit hosts, including `data.trilliumtransit.com` and
  `path.api.razza.dev`.

## Subway stations and LIRR fares (19 Nov)

- The subway panel has two boxes, 1 2 3 (stop 128) and A C E (stop A28),
  headed only by line symbols (owner: no explanatory notes; station signs do
  that). A train goes in the box of the Penn stop it calls at.
- LIRR rows carry a Peak or Off-peak tag from `peak_code` (P/O).
- Day/night/weekend indication is for the subway only (owner's choice).
  Approved on 19 Nov, not yet built: late-night trains carry a pill with a
  moon and "Late night"; a banner counts down to late-night service from one
  hour before; while express and late-night trains overlap in the evening the
  banner says late-night service has started (and when the last express
  leaves); late at night the Express heading stays, with "No express trains
  late nights. A trains run local until 5:38 AM."; in the morning a daytime
  banner shows only until the first express train leaves, while remaining
  late-night trains keep their marker. Both station boxes follow the same
  rules. See `design/switchover-updated.png`. Weekend options in
  `design/weekend-options.png`, awaiting a choice. The real switch
  times vary by line and day: from the MTA GTFS, downtown A trains run local at
  Penn from about 22:42 to 05:38 on weekdays (Sat from 22:38, Sun until 07:26);
  the 2 from about 23:03 to 05:47. Plan: precompute these per line and day
  into `subway-data.json` to drive the countdowns.

## Subway late-night / daytime / weekend: agreed design (19 Nov, not built yet)

Owner decisions so far (see `design/switchover-tags-express-banner.png`):
- Tags beside the "Subway" heading: "Late-night service" (moon) and
  "Weekend service" (calendar), both shown together when both apply.
- Late-night trains carry a pill: moon + "Late night".
- Banners live inside each station box's Express section; 1 2 3 and A C E
  follow the same rules.
- Evening: the banner counts down the END OF DAYTIME EXPRESS SERVICE ("The
  last express A leaves Penn in N min"). It appears one hour before the first
  late-night train enters service on the line (A leaves Inwood 22:08
  weekdays), says late-night service has started from then, and is removed
  once the last express train has left Penn (A ~22:33). After that, the normal
  late-night layout. See `design/evening-switchover-v3.png`.
- Late nights: the Express heading stays with "No express trains late nights.
  A trains run local until 5:38 AM."
- Morning: no countdown banner. Express trains simply appear with their
  normal minute countdowns. A "Daytime service has started" banner shows only
  until the first express train reaches Penn; late-night trains still at Penn
  keep their pill.
- Times come from the MTA GTFS per line and day (weekday / Saturday / Sunday).
- Tags are specific: "Late-night service", "Weekend service", "Holiday
  service", "Severe weather service" (from MTA schedule/weather notices).
  See `design/service-tags.png`.
- The "Late-night service" tag shows only once no more daytime trains are
  due at Penn (after the last express has left), and is removed in the
  morning when the first daytime express train's countdown reaches "now" at
  Penn. (Owner, 19 Nov.)
- Banner wording once late nights have begun on the line: "Late-night service
  has started on the [line]. The last express train leaves at [time]."

## Service notices (18 Nov, owner chose option A)

- `docs/feeds.js`: MTA alert feeds (`camsys/subway-alerts.json` ~1 MB, read
  every 3 min and never forced; `camsys/lirr-alerts.json` every 2 min), both
  CORS-open. Active notices only (`active_period`, `display_before_active`).
  Subway: lines 1/2/3/A/C/E or stops 128/A28. LIRR: all. Amtrak: per-train
  `alerts` from Amtraker. `board().notices = { rail, subway }`; urgent types
  (delays, suspensions, severe weather...) sort first and turn the strip amber.
- Page: a collapsible strip above the train list (rail) and one at the top of
  the subway panel (subway); on phones each sits under its own tab. Closing a
  strip is remembered for the visit until the set of notices changes.
- No PATH notice source exists that the site can read (the Port Authority
  publishes PATH alerts on its app and social media only). NJ Transit notices
  will need the developer login (`extra.njtNotices` is the hook).
- Express/local subheadings no longer carry "fewer stops"/"every stop".

## Changes of 18 Nov (evening)

- Arrivals: stations an arriving train has passed are crossed off, with "next
  stop" in the summary. Amtrak: from its per-station status (`viaState`). LIRR:
  `backend-unified.mylirr.org/locations/{train_id}` (~9 KB, CORS open), fetched
  only while that train's stop list is open, every 20 s (`lirrProgress`).
- Every stop list ends with "Last stop: X" (Penn Station for arrivals, or the
  onward destination for an Amtrak through train).
- Amtrak through trains stay on arrivals ("At Penn, continues to X, leaves
  h:mm") until they leave Penn (`continuesTo`, `departsAt`).
- A delayed LIRR or Amtrak train with its track posted (or an Amtrak train at
  Penn) shows "Boarding" with "N min late" underneath. Final call starts 2 min
  before the estimated departure for delayed trains (`lateMin` >= 2), 1 min
  for on-time ones.
- Subway panel splits each direction into Express and Local, decided per train
  from its next stops after Penn (`serviceFromPenn` in `docs/feeds.js`), so
  night service and reroutes sort themselves. No diamond symbols (owner's
  request). LIRR/Amtrak/NJ Transit have no reliable express flag, so rail rows
  aren't labelled.

## Ordering by real departure (18 Nov)

- Rows are ordered by when each train is really expected to leave (`leaves`,
  delay included), departed rows by when they left (`visibleRows`), so a delayed
  train moves down the board. The feed-side sort uses the same key.
- LIRR's `time` is the SCHEDULED time (checked against `/locations` sched_time);
  `status.otp` is the delay in seconds (negative = late). Rows now carry
  `time` = scheduled + delay and `sched` = scheduled, so the expected time is
  the big one with "scheduled h:mm" underneath when 2+ minutes apart.
- Amtrak departures use the later of the estimate and the schedule (Amtrak
  estimates an early ARRIVAL at Penn, but trains don't leave before schedule).
- NJ Transit rows still display NJ Transit's scheduled time as-is but are
  placed by scheduled + SEC_LATE, so one can look out of order by clock time.

## Freshness rules (added 17 Nov)

- The page forces a fresh fetch of every feed just after each minute (and on
  tab focus), and waits for it; the 20 s poll in between may show cached data.
  `source()` in `docs/feeds.js` honours a forced read at most every 10 s, so many
  open pages can't multiply feed requests (matters for NJ Transit's daily cap).
- Departed trains (`departedAt`, `noteVanished`, `visibleRows`, `shownStatus` in
  `docs/app.js`): an LIRR, NJ Transit or Amtrak departure shows "Departed" and
  "left N min ago" for 3 minutes (owner's choice, 18 Nov), then comes off.
  Amtrak departs only on Amtrak's own report (`departsByFeed`): a late train
  whose estimate passes stays, marked "due", until reported gone or the estimate
  is 30 min stale. "Departed" comes from the feed
  where it says so (LIRR `stop_status: DEPARTED`; Amtrak station status
  `Departed`, kept for 10 min in `docs/feeds.js`), else from the clock using
  `leaves` (departure time plus any delay; NJ Transit `SEC_LATE`). A train that
  drops out of a feed within 3 min of its time is kept and shown as departed.
  Late trains count down to `leaves`; cancelled trains stay 5 min; arrivals
  5 min. Subway and PATH are untouched (they simply drop off). The owner chose
  this to avoid anyone thinking a gone train can still be caught. Note: for NJ
  Transit rows "Departed" replaces NJ Transit's own status text once the train
  is due out (a judgment call against the as-is clause; see chat history).
- When the data is over 90 s old no row keeps the green boarding highlight.

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
  masthead, gold-leaf track plates, ivory text), Archivo (using its width axis)
  for everything except the masthead, which the owner chose on 18 Nov from five
  options (`design/`): option D, "Penn Station" in Limelight with "departures"
  in light Archivo and a triple gold rule. The gold track plate is the one loud element; it flips once when a
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
