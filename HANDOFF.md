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

## Deploying changes (cache busting)

GitHub Pages lets browsers keep files for 10 minutes. `docs/index.html` loads
`style.css`, `config.js`, `feeds.js` and `app.js` with `?v=<stamp>`; bump the
stamp whenever any of them changes, e.g.
`V=$(date -u +%Y%m%d%H%M); sed -i -E "s#(style\.css|config\.js|feeds\.js|app\.js)\?v=[0-9]+#\1?v=$V#g" docs/index.html`.
Worker changes deploy separately (Workers API with the saved token, or the
dashboard); the board's alerts now come through `/alerts/subway` and
`/alerts/lirr` on the Worker, refreshed every 20 s.

## PATH (updated 19 Nov)

- Timetable: `scripts/build-path-schedule.py` now reads PATH's own schedule
  pages (`/content/path/en/schedules-maps/weekday-schedules.model.json` and
  `weekend-schedules.model.json` on panynj.gov; only the "Saturday Schedule" /
  "Sunday Schedule" lists, not the old dated special weekends). The weekday
  timetable is effective 16 Nov 2026 and the pages give no end date. The old
  Trillium GTFS was a May 2025 copy and missed PATH's new weekend service
  (direct Journal Square trains 10 AM to 9 PM on weekends).
- Weekday from 33 St: last direct Journal Square 10:30 PM, via Hoboken from
  10:42 PM, last Hoboken 10:47 PM, first direct Journal Square 6:03 AM.
  Weekends: direct Journal Square 10:10 AM to 9:00 PM, Hoboken 10:15 AM to
  9:27 PM, via Hoboken otherwise.
- Display (owner-approved): option B (next scheduled times plus "About every N
  min"); tags beside the PATH heading (Weekend service, Late-night service); a
  countdown banner from one hour before the last direct Journal Square train;
  late at night "No direct Journal Square trains late nights. Trains run to
  Journal Square via Hoboken until <first direct>"; Late night pill on trains
  in that period. No morning banner. `pathDay`, `pathState`,
  `renderPathPattern` in `docs/app.js`.
- Live PATH (`/bin/portauthority/ridepath.json`) works again as of 19 Nov but
  sends no CORS header, so only `server.js` can use it.
  The GitHub Pages version can use it through a Cloudflare Worker relay
  (`worker/worker.js`, setup in `worker/README.md`): set its address in
  `docs/config.js` (`window.PENN_RELAY`). Deployed 17 Nov as `penn-board-relay` on the
  owner's Cloudflare account: https://penn-board-relay.pennstationboard.workers.dev
  (set in `docs/config.js`). Redeploy by uploading `worker/worker.js` (module
  syntax) via the dashboard or the Workers API; a Cloudflare API token for
  api.cloudflare.com is saved as a network secret on the `penn-board` cloud
  environment (expires; make a new one with the "Edit Cloudflare Workers"
  template if it has). The same Worker is the
  intended home for NJ Transit, with the login as a Worker secret.
- PATH alerts: the site uses `/bin/portauthority/alerts?agency=PATH&hours=8`
  (Everbridge). It returned [] for every query on 19 Nov and sends no CORS
  header; its item format is unknown, so it isn't wired in yet.

## How Amtrak's data behaves at Penn (observed 17-19 Nov)

Watched Amtraker (`api-v3.amtraker.com/v3/trains`) once a minute:
- Each train's data is 1 to 5.5 minutes old at any moment (`lastValTS`).
- The NYP `platform` (track) field is always empty: Amtrak tracks at Penn
  only come from NJ Transit's feed (server version with login).
- A through train shows NYP status `Station` 3 to 5 min after it arrives;
  the board therefore treats a through train whose arrival time has passed
  as boarding (departures only).
- A train ending at Penn never shows `Station`; the whole trip goes
  `Completed` a few minutes after arrival. The board shows it as Arrived for
  5 min instead of dropping it.
- A train starting at Penn (Keystone, Empire Service) is listed before its
  scheduled time, drops out of the data while delayed, and reappears only as
  `Departed` (Keystone 639 on 17 Nov: due 21:00, left 21:47). The board keeps
  such a train as "No update from Amtrak" for up to 45 min past its time.
- Other Amtrak track sources checked on 19 Nov, none usable: the Moynihan
  Train Hall website board (Cloudflare blocks automated requests and it isn't
  open to other sites); LIRR's `backend-unified.mylirr.org/solari/NYK` (the
  Penn board feed, LIRR trains only). NJ Transit's feed remains the only way.
- Departed Amtrak trains show for 5 min from when the board learns of it
  (others 3 min), never more than 4 min beyond that after the real departure.

## Subway late-night / daytime / weekend (built 19 Nov)

Owner decisions so far (see `design/switchover-tags-express-banner.png`):
- Tags beside the "Subway" heading: "Late-night service" (moon) and
  "Weekend service" (calendar), both shown together when both apply.
- Late-night trains carry a pill: moon + "Late night".
- Banners live inside each station box's Express section; 1 2 3 and A C E
  follow the same rules.
- Evening: NO countdown phase (owner removed it). The banner appears when the
  first late-night train sets off from its terminal (A leaves Inwood 22:08
  weekdays): "Late-night service has started on the A. The last express train
  leaves at 10:33 PM." It goes once the last express has left Penn; then the
  normal late-night layout.
- Implementation: `switches` in `docs/subway-data.json` (built by
  `scripts/build-subway-data.py`: nightStart, lastExpress, firstExpressStart,
  firstExpressPenn per station/line/direction/day, minutes after the service
  day's midnight); `switchState`, `renderSubwayTags` and the Express-section
  notes in `docs/app.js`. Holiday notices that name a Saturday/Sunday schedule
  switch the times used. Tested with a simulated clock at 9:30 PM, 10:15 PM,
  10:40 PM, 1:12 AM, 5:20 AM, 5:37 AM and Saturday 1 PM.
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

## Late-night subway fixes (Nov 18, 2026)
- Trains that end at Penn (the 3 downtown late nights) are skipped in `docs/feeds.js`.
- `subway-data.json` now has `nightGaps` (built by `scripts/build-subway-data.py`): the C (both ways) and the 3 downtown have no trains from Penn late nights. The board shows "No C trains until T. For downtown service, use the A or E." in that line's usual section (the 3: "No 3 trains downtown until T. Use the 1 or 2."). The alternatives are the station's other lines still running that way.
- Late nights the 3 still runs express uptown from Penn, so the uptown 2 note says "2 trains run local late nights, until T." instead of "No express trains".

## Service-change map (Nov 18, 2026)
Subway notices that close or reroute part of a line ("Planned - Part Suspended",
"Suspended", "Reroute") get a **See map** button in the notices strip; a
"Rerouted, see map" train row opens the same map when a notice covers that line.
- **View 1, the whole line:** the line's own track (from `docs/subway-shapes.json`,
  built by `scripts/build-subway-data.py`), grey and dashed between the stations
  the notice names (both ends named = closed), live rerouted trains drawn in the
  line's colour, labels for Penn, the line's ends and where it stops/restarts.
- **View 2, "How to get around this":** read from the notice's own text
  (`readAlternatives` in `docs/app.js`): transfer stations ("Name | [A][N]", or a
  "Transfer stations:" list), shuttle buses ("... between X and Y, stopping at
  ..."), and lines the MTA says to take/consider/use. Those lines are drawn only
  near the closed part. Stations listed under the map zoom in when tapped, each
  with Google/Apple Maps transit directions (from the person's location). The
  MTA's full text is always shown underneath, plus "Live directions from Penn".
- Nothing is invented: what can't be read from the notice isn't drawn. On 18 Nov,
  50 of 51 system-wide route-change notices got view 1, and 36 a drawn view 2
  (the rest show the MTA's text only).
- The relay now passes subway notices' full text (`description_text`); about 30 KB.
- Map: Leaflet + OpenStreetMap tiles, made pale in CSS (`.cm-tiles`); labels are
  placed to avoid overlaps (`placeLabels`) and re-placed on zoom.

## Fixes (Nov 18, 2026, afternoon)
- Subway rows: one row per destination (`route|dir|svc|last stop`), so a line
  with two destinations during a service change no longer flips between them.
- Rerouted-train map note names the line borrowed: "running via the A line from
  59 St-Columbus Circle to Inwood-207 St" (the line normally serving most of the
  unusual stops).
- Late-night pill is per train and per line (`lateNightTrain`): subway-data.json
  "night" holds, per line/direction/day, when that line starts running 15+ min
  apart in the evening ("from") and when trains come closer again in the
  morning ("to"), from the MTA timetable. Pills drop off line by line.
  Like PATH, the pill goes by which scheduled trip each live train is:
  "trips" lists every night trip's id (the 6-digit scheduled start that begins
  the MTA's live trip_id, e.g. "033750" of "033750_1..N03R"), so a late night
  train keeps its pill until it leaves.
- PATH pills: per line (Journal Square incl. via Hoboken; Hoboken) from PATH's
  timetable, trains 16+ min apart = night (`pathNightWindow`); a live train is
  matched to its scheduled departure (within 8 min). Weekday JSQ: 10:58 PM to
  6:03 AM; Hoboken has no night trains, so never a pill.
- "Daytime service has started on the C/3" banners: `nightGaps` now has
  `firstStart` (first morning train leaves its terminal); the banner shows from
  then until a train of that line shows "now" at Penn (or 30 min after due).
- Departed is never assumed from the clock (owner's rule). It comes from the
  feed's report (Amtrak), or from the train dropping out of its feed as it's due
  (LIRR: watched 18 Nov, its Penn feed never says DEPARTED and drops a train
  ~30 s after it really leaves; NJ Transit likewise). A boarding train still
  listed past its time stays on Final call until it drops out; one still listed
  30 min past its time is dropped quietly (`LISTED_PAST_S`).
- The greyed "usual" LIRR track is LIRR's own `sched_track` (scheduled track);
  the posted `track` replaces it.
- Late nights a line not running either way (the C) says "No C trains until T. Use the A or E." with no direction.
- C and downtown 3: in the hour before their last train, a banner counts down
  ("The last downtown 3 train leaves at 10:24 PM, in 14 min.").
- PATH's late-night banner ends when the night's last via-Hoboken train has
  left (`lastNight` in the timetable), or sooner if live PATH data has no
  via-Hoboken trains left in the last hour of night service.
- Subway notices: station, boarding-change and elevator notices show only if
  they name a Penn station (128/A28). Skipped-stop notices show only if a live
  train leaving Penn in that direction calls at a skipped station
  (`reachableFromPenn`, using the notice's per-stop direction_id: 0 uptown,
  1 downtown); kept if that line/direction has no trains listed. Suspensions,
  reroutes and delays on Penn lines always show.

## Flip board style and phone Alerts tab (Nov 18, 2026)
- "Board style: Standard | Flip board" switch above the footer (owner chose
  style B: dark green tiles, ivory/gold letters; masthead and clock on the red
  masthead as red tiles with gold letters). Choice kept in localStorage
  `boardStyle`. Flip mode turns the masthead, clock (hh:mm and AM/PM; no seconds in flip mode;
  stay plain) and each train's time, destination, status and track into tiles.
  `flipText(key, text)` draws tiles showing the field's previous text
  (`flipShown`), and `runFlips(root)` turns changed tiles after each redraw.
  Flips even with Reduce Motion on (owner's choice). At final call the track
  tiles flip over and turn red (`flipLook`). Subway and PATH panels stay standard.
- Phones (≤960px): an "Alerts" tab with a count; notices grouped Trains at
  Penn / Subway / PATH (`renderAlertsTab`). The notice strips are hidden on
  phones; computers keep them.
- Flip performance: flips are queued a few rows at a time (`FLIP_ROWS_AT_ONCE`,
  `flipQueue`); off-screen rows get their new text without animating; rows are
  measured (not tiles) so off-screen rows aren't laid out (`content-visibility:
  auto` on flip rows); only rows whose markup changed are replaced
  (`patchRows`); flaps animate transform only. On a 4x-slowed phone the worst
  freeze on a tab switch went from ~1150 ms to ~120 ms.
- Tapping "Penn Station" in the masthead reloads the page.
- Flip animation engine (rewritten for smoothness): each tile has permanent
  halves and two flat flaps (`.ft` old upper half folds down with scaleY,
  `.fb` new lower half unfolds); one requestAnimationFrame loop
  (`flapFrame`) moves every flap; flaps chain back to back (150 ms each).
  No 3D, no WAAPI, no elements created mid-flip: a trace showed layer
  rebuilding ("Layerize") was most of the cost before. Tiles use
  `contain: layout paint style`. On a 4x-slowed phone, stutters (>34 ms
  frames) in a 40-field change went from 15 to 1.
- Subway rows: a line's trains to its main last stops (10%+ of its trips) share one
  row (`mergeScheduled`, subway-data.json "terminals"), named by the next
  train's last stop; the name slides to the next one when it changes
  (`destName`, `.dname.changing`). A last stop not in the timetable (service
  change) keeps its own row. The weekday rush-hour A to Rockaway Park shares
  the A's row too (`SHARE_ROW` in the build script); Euclid Av A trips stay separate.
- Trial (owner, Nov 18): a shared row with trains to more than one end (the A
  downtown) takes turns every 8 s (`ROTATE_MS`), showing each end's own next
  trains; each cycle starts with the end whose train comes first and restarts
  whenever that order changes (`turnCycles`); name and times slide together. Euclid Av A
  trips keep their own row. While its next train is "now" the row stops
  turning and lists every A train's time (named by the "now" train).
- Owner adopted the turning row for every subway line (Nov 18): all of a
  line's trains in one direction and service (express/local) share one row
  whatever their last stop (main ends, short trips, service changes), taking
  turns every 8 s when they go to more than one place, soonest first, and
  stopping on all times while a train is "now". Express and local stay in
  their own sections. subway-data.json "terminals" (and SHARE_ROW in the build
  script) are no longer used for this; kept in case per-destination rows return.

## NJ Transit (approved Nov 18, 2026)
- Owner's RailData login is stored as Worker secrets NJT_USERNAME / NJT_PASSWORD
  on penn-board-relay (redeploy with metadata `keep_bindings: ["secret_text"]`
  so the secrets survive). Worker route `GET /njt` gets a token (kept in memory
  and the Cache API for 23 h), then getTrainSchedule (station NY) and
  getStationMSG, cached 30 s. API docs: raildata.njtransit.com/swagger/index.html.
- Working since Nov 18: the owner's account exists only on NJ Transit's TEST
  server (testraildata.njtransit.com; the main server says "Missing user
  account."), which serves live data. The relay tries the main server, then
  the test one, and keeps the token with the server that issued it (a token
  only works there). Swap order/remove the test host once NJ Transit moves the
  account to production.
- The page reads `${PENN_RELAY}/njt` (`relayNjt` in docs/feeds.js);
  `parseNjt` / `njtNotices` are shared with server.js. NJ Transit's agreement
  requires data "as-is": destinations and line names are shown exactly as
  sent ("Trenton -SEC", "Northeast Corrdr Line"); only "&#9992" is rendered
  as ✈. Footer says the data "may not be real-time" (required when latency
  can exceed 1 min). Agreement also: data only from our own server (relay ✓),
  no implying NJT licence or accuracy, max 100,000 requests/day (relay: ~2
  calls per 30 s per Cloudflare location), and "not to be relied on for any
  commercial purposes" (owner asked about ads: ask passcomm@njtransit.com first). Blank NJT status shows
  "On time" or "N min late"; NJT's own status text is shown as-is. NJT's list
  includes Amtrak trains (ids "A2127") with tracks, merged into Amtrak rows.
- Nov 18 check: on the TEST server none of getTrainSchedule, getTrainSchedule19Rec or getStationSchedule carry tracks or statuses (0 of 19 / 474 trains). Production access is needed for tracks.
- "Final call" is now worded "All aboard" on every railroad (owner, Nov 18), matching NJ Transit.
- NJ Transit's RailData guide (V2.1): registration emails SEPARATE Test and
  Production credentials. Worker secrets: NJT_USERNAME/NJT_PASSWORD = test,
  NJT_PROD_USERNAME/NJT_PROD_PASSWORD = production (preferred when set; only
  production has tracks/statuses). getToken + isValidToken: 10 calls a day in
  total, so tokens are cached 23 h per setup (`njt-token-prod` / `-test`).
  Data calls: 40,000 a day.
- raildata.njt.gov (address in the portal's newer docs) didn't resolve on Nov 18 (Cloudflare 1016); kept first in NJT_HOSTS so it's used if it goes live. /njt-server reports which host the relay uses.
- Relay hardening (Nov 18 evening): NJ Transit token shared across all
  Cloudflare locations in Workers KV (namespace "penn-board-relay-njt",
  binding NJT_KV; keys token-test / token-prod, 23 h). When NJ Transit says
  the day's sign-ins are used up, `signin-blocked` stops further tries until
  NY midnight. Only an "Invalid token" error triggers a new sign-in. `/njt`
  keeps the last good copy 6 h and serves it marked `STALE: {since, reason}`
  instead of a 502; the page then says "NJ Transit times are from N min ago".
  Deploy metadata must include the KV binding and keep_bindings secret_text.
- Subway slides: renderSubway waits until a destination slide (1 s, SLIDE_MS) has finished before redrawing, so data/tick redraws no longer cut slides short.
- Subway: if any train in a line/direction/service is rerouted, that line's destinations stop turning and get separate still rows (so the rerouted one shows 'Rerouted, see map').
- PATH alerts (Nov 18): relay /path-alerts (Port Authority's alerts?agency=PATH&hours=8, a list of messages per incident 'ebid' with state Open/Closed). The board shows each open incident's latest message (time stamp removed) in a 'PATH alerts' strip above PATH times and in the phone Alerts tab.
- subway-data.json: if it fails to load it's retried every 20 s (was: never, leaving raw '[1]' text and grey 'S' badges). Notice text shows a line's name instead of '[1]' until line colours load.

## LIRR service-change map (Nov 19, 2026)
- docs/lirr-data.json (scripts/build-lirr-data.py, from the MTA's gtfslirr.zip):
  branches (name, colour, stations), stations (ids = stop_id in LIRR notices),
  simplified track paths; Penn = stop 237.
- LIRR notices of type stops skipped / substitute buses / suspended / reroute /
  single track / service change get "See map" (`lirrModel`, `openLirrChange`,
  `drawLirrChange` in docs/app.js, same dialog as the subway map). View 1: the
  branch in its colour, other LIRR lines thin grey, affected stations ringed
  red ("Skipped" / "Buses" / "No trains"); for buses or suspensions the stretch
  between affected stations is dotted / dashed. View 2 (when the notice has
  text before "What's happening?"): the MTA's text, affected stations to tap
  and zoom, Google/Apple Maps directions.
- Preview mode: add #preview to the address to list the next week's planned LIRR and subway work that has a map, labelled 'Upcoming planned work' (relay /alerts/{feed}?ahead=168).
- LIRR map: station cards and the tapped station's map label list the branches calling there as coloured chips (lirrBranchesAt; City Terminal Zone left out). Other LIRR branches are drawn in their own colours (thin, lighter).
- Subway map view 2: detour lines are trimmed by segment (any stretch touching the area is kept, ends included), not by point; the 1's track data has one straight stretch 157 St-Dyckman St with no points inside, which used to vanish.
- Reroute notices: readVia() reads '[C] runs via the [F] from X to Y and via the [D] to Z'; the map draws the line in its colour over those tracks, with its badge beside each borrowed station (zoom 13-14), a 'C via F D' tag further out, and station names listing it closer in.
- Reroute maps draw the rerouted line and the line it borrows side by side on the shared stretch (offsetLine, redrawn on zoom), like a subway-map trunk.
- Subway map: a 'Suspended' (not 'Part Suspended') notice draws the whole line as closed (whole: true); notices may list only the stations the line serves at that time (overnight 3: 34 St-148 St).

## PATH maps, NJ Transit fallback guides, delay options (Nov 19, 2026)
- PATH alerts get "See map" (`pathModel`, `openPathIssue`, `drawPathMap` in
  docs/app.js). PATH's network is built in (PATH_STATIONS / PATH_LINES, drawn
  station to station, lines side by side). Each sentence of the alert sets the
  lines it names ("JSQ-33 delayed" -> delays, "NWK-WTC ... running" -> running,
  "suspended" -> no trains); a station named in the first sentence of an
  elevator/escalator/closed alert is ringed red.
- NJ Transit disruption guides (`NJT_GUIDES`, `openGuide`): "To Newark Penn by
  PATH" (33 St -> Journal Square -> Newark; or E to WTC then Newark train) and
  "To Hoboken by PATH", with live PATH times, cross-honoring caveat and NJT's
  own notices as sent. A purple banner (#njt-alt, and top of the phone Alerts
  tab) offers them when `njtDisrupted()`: 3+ NJT cancellations in the next 75
  min, or 3+ trains 15+ min late making up 40%+ of them, or an NJT notice about
  a suspension / major delays / cross-honoring at Penn. Always in #preview.
- Delay notices under the trains they affect (`rowNotices`, `rowAlertHtml`):
  LIRR by branch (notice route id = lirr-data route), NJT by train number
  ("#6671") or line words (NEC, Morris & Essex...). Subway delay notices show
  under that line's rows. "Other options" (`openOptions`, `openSubwayOptions`):
  other trains on the board (next 3 h, not under a notice) stopping at the
  same stations, grouped by line; LIRR also lists branches serving those
  stations by timetable; NJT also links the PATH guides; subway lists other
  lines from the same platform sharing stations.
- Trial (owner, Nov 19): subway 'Rows with more than one destination: Take turns | All destinations' switch under the subway panel (localStorage subwayStyle). Option B (optionBRow): a still list, one line per destination with its next 3 times, ordered by next train (owner removed the switching and animation).
- Other options only for delay notices (isDelayNotice): a notice saying trains run express/local or are rerouted (even typed 'Delays') gets none. Subway delay notices starting 'Downtown'/'Uptown' apply to that direction only.
- 'Some C trains running express' notices: no note on express trains; a note with Other options (local-stopping lines only) goes under that line's local service, or in its Local section if no local train is listed (switchNoteHtml). Direction from 'uptown'/'downtown' anywhere in the first sentence (dirMatch).
- Notes on individual trains (delays, express changes, reroute rows' maps) only for notices in effect now (parseAlerts' activeNow; not shown-early notices, not #preview). LIRR row branch names map to MTA route ids via LIRR_ALIASES (Huntington = Port Jefferson Branch in the MTA's data).
- NJ Transit notices: `njtActiveNow` reads the dates in the text ("Saturday,
  November 21", "Beginning on Monday, November 23", "through Friday, November
  20"); if every date is still to come the notice isn't put on trains (it stays
  in the notices). Undated messages count as happening now.
- Last NJ Transit trains of the night: relay `/njt-day` (getStationSchedule,
  station NY, NJTOnly; cached 1 h) -> the page (`loadNjtLast`, every 30 min)
  finds, per line and overall, the last departure before a 2 h+ break that
  runs past 3 AM, and the first after it (tomorrow's estimated from this
  morning's when it's the same kind of day). Matched by train number, the row
  gets a banner: "Last Morristown Line train from Penn until 5:58 AM." /
  "Last NJ Transit train from Penn until 4:28 AM." (or "tonight" if unknown).
- Late-night pill also on local A/2 trains (localNight): judged by the train's own Penn time, from when the first late-night local sets off (switches nightStart, e.g. 10:08 PM downtown A) until the first daytime express reaches Penn.
- Late-night banners use the live train that matches the timetable's last train
  (`liveLast`: same line/direction[/service], within 15 min of the scheduled
  time) for "leaves at h:mm, in N min", so they agree with the rows; the 2/A
  "Late-night service has started" banner now counts down too. Two or more
  night banners in one section merge into one box (`mergeNightBanners`), one
  line each. Option B rows give each destination its own late-night pill.
- Last-train banners use live times: subway liveLast takes the latest live train from 10 min before to 60 min after the timetable time (liveLastOnly keeps the countdown up while a late last train hasn't left); PATH countdown uses livePathLast/livePathFirstVia and stays up while a late last direct JSQ train is still to come.
- Subway and PATH trouble shows as pills on rows (warnPill: Delays / Some trains skip stops / Rerouted / Suspended), not boxes under them. PATH pills come from pathModel states (Hoboken = HOB-33, Journal Square = JSQ-33, via Hoboken = both). 'Other options' for subway delay/express-switch notices is a button on the notice (strip and Alerts tab, data-nopt -> openNoticeOptions), beside See map. A rerouted row opens a map itself only when no notice covers it. Rail rows (LIRR/NJT/Amtrak) keep their row-alert boxes.
- Delays pill comes off on-time trains: subway matches each live train's trip code to docs/subway-times.json (scheduled minute at Penn per station/line/dir/day, built by build-subway-data.py) and drops the pill when it's no more than ON_TIME_S (3 min) behind; trains with no timetable match keep it. PATH drops it when the next live train leaves within 2 min of a scheduled departure to the same place (path-schedule.json). 'Suspended' and 'Some trains skip stops' pills stay.
- Subway 'Late night' pills are links (SUB_LATE_PILL) to the MTA late-night subway diagram page, mta.info/map/5336, in a new tab. PATH pills and pills inside a rerouted (button) row stay plain.
- Late-night pill (owner, Nov 19, final): back to the original rules. A and 2 local trains from their switch to local (localNight); any line once its trains are 15+ min apart at night (night_window, NIGHT_HEADWAY). The 12-min/after-last-express rule and the 3 cut-back rule were tried and dropped.
- The 3 uptown also has a pattern rule (cutbackNight): once the last downtown 3 has left Penn for the night (nightGaps 128/3/S 'after', weekdays 10:24 PM), uptown 3 trains get the pill until downtown trains restart (or the 15-min rule ends it later in the morning).
- Suspension notices (suspensionNote in app.js): a subway notice whose type says Suspended, naming a Penn line and that Penn station, in effect now or within 4 h. Before it starts: 'The last uptown 3 train leaves at {live time}... Then no 3 trains until {end}. use the 2.' (comma, one sentence; the line comes from the advisory text; its details stay in the notice). During: 'No uptown 3 trains until {end}. Use the 2.'. A direction already off by the timetable keeps its usual message. feeds.js parseAlerts now keeps each notice's periods.
- Lines named in subway sentences (banners, 'No C trains... Use the A or E', options sheet) show as their badge at text size: lineName(route) = bulletHtml(route, 'inl'), styled .bullet.inl.
- NJ Transit production (raildata.njtransit.com) accepted the main login on Nov 19, 2026 (checked with a one-off route, since removed). The relay now serves production data: tracks and NJ Transit's own statuses (BOARDING, CANCELLED...), shown as-is. raildata.njt.gov still doesn't resolve (Cloudflare 1016).
- Railroad train delay notices (rowAlertHtml) are collapsed to one line ('⚠ Delays up to 45 min', rowAlertSummary) that opens to NJ Transit's/MTA's own words and Other options; opened ones stay open across refreshes (openRowAlerts). A notice sent twice (short and long) shows once.
- Penn suspensions (pennSuspension in app.js): an in-effect railroad notice saying service into/out of (to/from, at) Penn is suspended shows that railroad's trains as 'Held' (red, 'service suspended at Penn' under it) in departures and arrivals; NJ Transit's own status text is kept. A train past its time by 2+ min with only the board's own status ('On time'/'N min late') shows 'Delayed'. LIRR trains with no branch from LIRR show 'LIRR' (not 'undefined Branch').
- LIRR disruption banner (lirrAltHtml, blue, above NJ Transit's): when LIRR service into/out of Penn is suspended (pennSuspension) or most of the next hour's LIRR trains are badly late. Two guides (LIRR_GUIDES/openLirrGuide): LIRR from Grand Central Madison, and the Queens-bound E to Sutphin Blvd for Jamaica (with the next live E times). Banners follow the railroad filter. The NJ Transit banner now says delayed / cancelled / both from what its trains show.
- LIRR banner and guides carry the MTA's own advice from the Penn notice's description (lirrAdvice: diversions to Grand Central, which subway lines take LIRR fares; branch train lists and 'click here' dropped) plus a link to the MTA's standing travel-alternatives map for Penn suspensions (MTA_LIRR_ALT_MAP, mta.info/image/186211, linked not copied; always shown with the LIRR banner and guides). Guides: Grand Central Madison, the 7 to Woodside, the E to Forest Hills/Kew Gardens/Jamaica.
- Guide wording (owner): short but detailed. LIRR and NJ Transit guide steps trimmed, lines shown as badges ([7], [E] in step text via noticeText); guide buttons use short names. External-link arrows use the text form (↗ + U+FE0E) so iPhones don't draw an emoji.
- Trains that won't run to/from Penn (applyTripChanges, tripChangeFor, matchLirrArrivals): LIRR's alert text names them ('The 10:20pm train from Penn Station to Huntington will originate at Jamaica at 10:42pm', '... is canceled at Jamaica', '... diverted to Grand Central'); feeds.js keeps those lines as n.trips (merged across branch alerts). Departures match by Penn time + destination; arrivals by the train's start time, looked up once per candidate from LIRR's locations API. NJ Transit messages match by train number ('#3880 ... canceled / will originate at Newark'). Matched trains are crossed off (tone 'stop') with 'Starts at Jamaica 10:42' / 'Ends at Jamaica' / 'To Grand Central' / 'Cancelled'; NJ Transit's own status text stays, with ours under it. A train that drops out of its feed because of such a change goes to cancelledGone, never 'Departed'.
- NJ Transit arrivals: the relay also reads NJ Transit's Secaucus board (getTrainSchedule SE, every 30 s) and, for trains that skip Secaucus, the Newark Penn (NP) and Newark Broad St (ND) boards (every 2 min, newarkBoards), merged by train number with Secaucus first and sends ARRIVALS: trains to New York with their stops. It remembers trains past Secaucus (Cache API, per location) until 10 min after their New York time. parseNjtArrivals uses the New York stop's DEP_TIME (scheduled) and TIME (expected); 'Arrived' only when NJ Transit marks the New York stop DEPARTED. Track at New York isn't in this data.
- Delayed (past-due) and Held trains aren't dimmed (no 'gone' class); their time column says 'due'. Departures never dim by the clock (only 'Departed' rows fade); an All aboard train past its time says 'due' instead of 'under 1 min'. Arrivals past their time still fade.
- NJ Transit arrivals past Secaucus/Newark are followed with getTrainStopList (per train, cached 45 s) so a train held on the way in keeps updating; the relay keeps it until NJ Transit marks the New York stop DEPARTED (then 10 more min), or 3 h past its time. On the board such a train (awaiting) stays listed past its expected time, showing 'Delayed' and 'due', until it's marked arrived.
- NJ Transit 'DEPARTED' more than 5 min before a train's time (seen: 6299, 45 min early) is set aside in parseNjt and the board's own status shown. NJ Transit departure stop lists no longer include New York Penn itself.
- Trial toggle 'Delay pills' in the subway panel (localStorage subwayLatePills): 'With advisories' (default: pill only with an MTA delay advisory, off for trains confirmed on time) or 'All late trains' (also a '7 min late' pill on any train LATE_PILL_MIN = 5+ min behind its timetable at Penn, no advisory needed). Applies to PATH too: pathLateBy measures a live train from the latest scheduled 33 St departure at or before it (trains start at 33 St and don't leave early).
- Subway reroute check (unusualStops) treats another platform of a station the line serves (same name and place, e.g. 145 St lower level D13 for a C ending there) as a normal stop, so such a train isn't 'rerouted'. Reroute note says 'via the B line at X' for a single station. The reroute map names Penn and the last stop always, other stations only at zoom 14+ (.show-names).
- Subway and PATH heading tags: Late-night service or Weekend service, never both (late night wins); Holiday and Severe weather tags still show with either.
- Cancelled trains keep full colour (struck through) until their last 30 s on the board, then fade. Board style toggle hidden on the phone Subway/PATH tab. Subway toggles (rows with more than one destination, delay pills) render into #sub-toggles under PATH.
- isSwitchNotice no longer matches 'Express to Local' notices (an express line making extra local stops), which had put 'Some trains skip stops' on the A.
- Nov 23 build (owner-approved):
  - Pills open a dropdown (dropPill/pills in app.js; openDrops keeps them open across refreshes): the railroad's own sentence, its end time ("until Mon 5:00 AM") and "See full alert", which jumps to that notice on the Alerts tab (phones) or in the notice strip (computers), highlighted. Used for subway, PATH and railroad rows (railroad rows' old collapsible alert line is now a pill; "Other options" is inside the dropdown).
  - Pill wording is the railroads' own: MTA types (Delays, Reroute, Express to local, Stops skipped, Reduced service, or the switch notice's type such as "Local to express"); LIRR types ("Some delays", "Boarding change"); NJ Transit keeps "Delays up to 45 min" (it sends no type). "Reduced service" and "Express to local" are blue-grey (info), the rest amber.
  - LIRR "Boarding change" notices put a pill on trains that stop at the named station (e.g. Forest Hills).
  - A line rerouted or suspended away from the station (lineAwayNote): "No C trains at 34 St-Penn Station until Mon 5:00 AM, use the A." Subway messages name the station the MTA way ("34 St-Penn Station").
  - Alternatives by destination (directionAlts, owner Nov 23): a line at the station counts if it takes you at least 70% (ALT_REACH) of the way, on the map, toward the missing line's main last stop(s) before the two part (stations within 400 m count as one); none if nothing goes there. The MTA notice's own named lines win. Uptown C: A; downtown C: A; uptown E: none; downtown E: A or C; downtown 3: 2; uptown 1 and 2: none. Used for overnight gaps, suspensions and lines away.
- Holidays (subwayHoliday/subSched): New Year's Day, Memorial Day, July 4, Labor Day, Thanksgiving and Christmas run the subway's Sunday timetable for late-night rules, switches, gaps and on-time checks, including the overnight after (an MTA notice naming a schedule still wins); the Holiday service tag shows on those days. PATH keeps its own timetable by the real day.
- Fastest-route guidance (owner, Nov 24): scripts/build-subway-guide.py reads the MTA timetable and writes docs/subway-guide.json: for each Penn line and direction, the fastest plans (day 6 AM-9 PM and night midnight-5 AM) to a reference stop where that line goes (HUBS), using other lines from the station: direct, or one change inside the subway (MTA transfers.txt times, no street walks), time = rides + transfer + half the second line's gap; the missing line is never used. Arriving anywhere in the reference stop's station counts. Rebuild with the subway timetable: `python3 scripts/build-subway-guide.py gtfs_subway.zip`.
  - Board (suggestionHtml): the MTA notice's own lines first; else the fastest plan whose first train is running ("Use the A." / "Take the A or C to 42 St, then the 7."); else a line going the same way (directionAlts). Shown as a second line under "No E trains at 34 St-Penn Station until …." in overnight gaps, suspensions and lines away.
- Guidance now allows up to two changes (build-subway-guide.py: MAX_LEGS 3, +2 min per change, routes merged within 2 min: "Take the 3 to Times Sq, the shuttle to Grand Central, then the 4."), plus "Or walk through Penn Station to the A." when a train from the other Penn subway station goes straight there within 5 min of the best (WALK_MIN 8).
- Weekly rebuild: .github/workflows/rebuild-data.yml (Mondays 07:23 UTC, or Run workflow by hand) downloads the MTA subway and LIRR timetables, reruns build-subway-data.py, build-subway-guide.py, build-lirr-data.py and build-path-schedule.py (PATH may fail without stopping the rest), and commits docs/*.json only if something changed.
- Airport helper (owner, Nov 24): "To the airport" button (index.html .trip-bar) opens the sheet with JFK / LGA / EWR. Options: JFK = LIRR to Jamaica + AirTrain, E to Sutphin Blvd + AirTrain, A (Rockaway trains) to Howard Beach + AirTrain; LGA = E to Jackson Hts + Q70, LIRR to Woodside + Q70; EWR = NJ Transit or Amtrak to Newark Airport + AirTrain. First train live from the board; subway rides from subway-guide.json "rides" (timetable medians, rebuilt weekly); other connection minutes in AIR_MIN. Fastest = earliest arrival; Cheapest = lowest fare. Fares in FARES (app.js) with their official sources and date; update there when fares change. Amtrak fares vary, so Amtrak isn't priced.
- NJ Transit bus (BUSDATA V1 doc from the owner's developer portal): relay /njt-bus-pabt = BUSDV2 getBusDV for stop PABT (live departures, next hour; gate, time, destination, load), cached 30 s; token from BUSDV2 authenticateUser with the same NJT login, kept in KV 'bus-token' (~20 h). Only the documented BUSDV2 endpoints are used (not the BUSConsole staff API on the same host).

## NJ Transit bus finder data (Nov 24, 2026)
- `scripts/build-njt-bus-finder.py bus.zip rail.zip` → `docs/njt-bus-finder.json`: for each NJT rail station on a Penn line, NJT bus routes from Port Authority (stop 26229; the part after `-` is the gate) stopping within 1.2 km, with usual ride, walk, gates and weekday trips. Stations with no walkable bus get the two closest routes within 8 km (5 miles), marked `far` (then a taxi/local ride). The page shows distances in miles (owner: US audience, no kilometers).
- Inputs come from NJT's developer API with the owner's login: bus `POST https://pcsdata.njtransit.com/api/GTFSG2/authenticateUser` then `getGTFS` (token form field); rail `POST https://raildata.njtransit.com/api/GTFSRT/getToken` (10 sign-ins/day) then `getGTFS`. Both also offer getTripUpdates / getVehiclePositions / getAlerts (GTFS-RT protobuf, no daily limit).
- The files were fetched once through a temporary relay route, which was then removed. The NJT bus file only has NJ TRANSIT BUS and covers about two weeks at a time.
- Partner companies (owner uploaded the portal's "GTFS Data Downloads", Nov 24; not committed — the repo is public): Coach USA `gtfs.zip` (ShortLine Hudson, Rockland Coaches, Suburban Transit, Community Coach, Newark Airport Express), Academy, Lakeland, Trans-Bridge, Seastreak `google_transit.zip`. Pass them as `Label=path` after the two NJT files. Trips count when they leave within 350 m of Port Authority (Seastreak: Manhattan piers). Result: 101 of 155 stations have a bus within a walk, 48 more within 8 km; none for Morristown, Hackettstown, Hamilton, Trenton, Otisville, White House.
- Not useful: Broadway Bus (expired 2022), Tuckerton (2024 only), county shuttles.
- Not shown on the board yet.

## Airport helper: Newark via PATH, Amtrak reservation note (Nov 24, 2026)
- EWR adds two PATH options from the live 33 St departures to Journal Square: change for Newark, then NJ Transit one stop to Newark Airport ($3.00 + $12.30 = $15.30, per njtransit.com/ewr) or the 62 bus from Newark Penn (Raymond Blvd, gate 3A; 2A after 10 PM, per newarkairport.com) ($3.00 + $1.90 one-zone bus fare from NJT's Northern Intrastate chart).
- Amtrak option carries a note: reservation required, NJ Transit tickets not valid.
- Not added: NJT 107 (Port Authority to the terminals, evenings only, fare zone not published per stop) and Newark Airport Express ($23.50, ~50 min, newarkairport.com; scheduled times are in the Coach USA file).

## Buses tab (testing, Nov 24, 2026)
- New "Buses · test" tab (`data-view="buses"`, `#buses`, `renderBuses()` at the end of app.js). On phones it sits on its own row under the other tabs.
- Pick a station (remembered in localStorage `busStation`). Step 1, get to Port Authority: next live uptown A/C/E from 34 St-Penn Station that stop at 42 St-Port Authority (A27); if none, the 1/2/3 to Times Sq-42 St (127) and the underground passage; and the 10-minute walk up 8 Av.
- Step 2, buses: NJ Transit routes show live departures from `/njt-bus-pabt` (refreshed every 30 s), kept only when the bus's sign is one of the signs whose trips reach the station (`heads` in njt-bus-finder.json; live headers match NJT's GTFS trip_headsign exactly). If none are listed live, or for partner companies, the next scheduled times (`times.wk/sa/su`, minutes after midnight at Port Authority). Ordered by which gets there first. No bus: link to NJT's alternate service plans (njtransit.com/abc).
- Later: show it from the NJ Transit banner only during big delays, cancellations or a strike, and remove the tab.

## Nov 24 fixes: express pills, skip maps, Secaucus, airport wording
- A local line the MTA says is "running express" gets a "Local to express" pill (once; it was showing the MTA's "Stops skipped" type and again as a second Stops skipped pill). An express line a notice says is "running local" gets "Express to local" whatever the notice type.
- Skipped stops and local-to-express notices now have a map (`changeModel` with `skip: true`): zoomed to the skipped stations and their neighbours, grayed out, "N trains skip". "See map" in the pill's dropdown; `#subway` now opens `[data-change]`. `changeFor` ignores skip models; `skipFor` stops those trains also showing as rerouted.
- Airport helper: "Arrive at the airport (estimated)".
- Bus finder: rail stops within 150 m are one station (Secaucus Junction); NAME_FIX for names riders know (Montclair State University, Ho-Ho-Kus, Wayne/Route 23...); title() capitalizes after - and /.

## Subway entrances data (Nov 24, 2026; not used by the page yet)
- `scripts/build-subway-entrances.py` → `docs/subway-entrances.json` from the MTA's "Subway Entrances and Exits" on data.ny.gov (i9wp-a4ja; host added to the environment). {GTFS stop id: [[lat, lon, type S/E/X/R/D, way B/X/N]]}, 2,120 entrances at 485 stations.
- For the map redesign (owner wants entrances shown like Google Maps). Mock-up proposed: show only at stations you'd use (transfers, destination, Penn), smaller markers, zoomed in; awaiting approval.

## Buses to skipped subway stops (Nov 24, 2026)
- Relay `/mta-bus-stop?stop=NNNNNN`: MTA Bus Time SIRI stop monitoring with the owner's key (Worker secret `MTA_BUSTIME_KEY`), simplified to {line, dest, dir, at, away}, cached 30 s.
- `scripts/build-subway-bus-links.py` → `docs/subway-bus-links.json` (~600 KB, loaded only when needed): for station pairs up to 6 stops apart on a line, MTA bus routes stopping within 300 m of both (in order), with the Bus Time stop codes, ride, walks, sign, daytime gap. Weekly rebuild downloads the six MTA bus GTFS files.
- On a skipped-stops / local-to-express notice (dropdown and map sheet): "Buses to the skipped stops", grouped by bus, from the open station just before or after the skipped stretch, with live next arrivals. E.g. the 1 express 207–242 St: Bx9 from Van Cortlandt Park-242 St to 238/231/225 St; M100 from 207 St to 215 St.
- Update (owner): pills use the MTA's own type again ("Stops skipped"), shown once. "Getting to the skipped stops": the MTA's advice from the notice if it has any; else other lines at each skipped station ("Take the A C instead"); buses only for stations with no other line.

## Entrances on the service-change maps (Nov 24, 2026)
- `drawChange` draws entrances from docs/subway-entrances.json only at zoom ≥ 16 (ENT_MIN_ZOOM), only for stations the advisory sends people to: the open stations either side of a closed/skipped stretch, where trains end, the MTA's transfer stations (view 2), and Penn. 12–18 px by zoom; green stairs, blue elevator, gray exit only.
- Owner decision (Nov 24): do NOT infer which direction an entrance serves (too error-prone). Entrances at the relevant stations show for both directions. Only add uptown/downtown filtering if an official source ever gives entrance direction.
- Still open: drawing platforms from OpenStreetMap outlines (Overpass, overpass-api.de now allowed). Overpass connections kept dropping through the session proxy (ws_closed_mid_exchange), so retry later. Drawing only, no direction guessing.
- "Other options" cards (owner, Nov 24): no more "Shares N stations with the X". From the live trains' upcoming stops: "Makes all the same stops as the X", "Goes as far as <station>, then change for the X", or for an express "Stops at A, B and C. Change for the X for other stops".
- Alerts whose headline leads into a list ("...tonight:", "The following trains...") now show the rest of the notice (its description, with line breaks; short "Westbound:" lines in bold) everywhere notice text is shown (`noticeFull`). Fixed the LIRR Elmont-UBS Arena notice being cut off.
- Update (owner): "Other options" cards are back to "Shares N stations with the X", now counted only along the other train's way from Penn, and tapping it lists those stations in order (`details.shared`).

## Readability pass (owner-approved, Nov 24, 2026)
- End of style.css, "Readability": one color per message (notes, card details, fares, bus notes); gray only for a purpose (departed/not-running, crossed-off stops, unselected tabs, fine print `.foot`/`.cm-live` #9aa79b); `--dim` lightened to #c4ccc2; small text raised to about 13.5px minimum (pills .84rem, tags, gates, line labels), supporting text about 10% bigger; `.time span` stays on one line.
- `glueBullets` (end of app.js, MutationObserver): a line bullet keeps the punctuation after it on the same line.
- Keep new styles to these rules: no gray for ordinary text, no text under ~.82rem.

## "NJ Transit data didn't load" blips (Nov 24, 2026)
- Relay and NJ Transit were fine (no relay errors in 24 h, sign-in valid, not blocked). Cause: phones cancel requests in flight when the screen locks or the app switches, and the next read only came a full ttl later, so the banner flashed.
- feeds.js `source()`: a failed read retries once after 2 s, then 5 s later instead of a full ttl; failures aren't reported while the last good copy is under ERROR_GRACE (90 s) old. A real outage still shows the message. `plainError` words connection drops plainly.

## LIRR "Other options" from the timetable (Nov 24, 2026)
- `scripts/build-lirr-timetable.py gtfslirr.zip` → `docs/lirr-timetable.json` (~190 KB, ~60 KB gzipped; weekly rebuild): every LIRR trip with train number, headsign, service, and [stop, minutes] pairs; `dates` maps YYYYMMDD to running services (holidays included).
- `lirrPlans` (app.js): for the delayed train's stations, earliest arrival from Penn in the next 12 h, direct or one change (≥3 min, ≤90 min wait, at any station), never using the delayed train; same arrival → no change, then the later Penn train. Grouped into cards by the trains used.
- A card's first train shows "Live" with the board's time and track once a train with that number is on the live board, else "Scheduled". Replaces the old guess from branch maps (which claimed Montauk trains stop at Mineola) and the separate live-only list for the LIRR. NJ Transit options unchanged.

## Nov 24: last-train final call, departed trains survive reloads, last stop
- `isLastTrain(r)`: NJ Transit from `njtLast` (the "Last … train from Penn" list); LIRR from lirr-timetable.json (no later train on the branch from Penn for 90 min). Its final call ("All aboard"/red) starts 2 min out, like a delayed train.
- Recently departed trains are saved in localStorage (`recentDeparted`) on every refresh and restored into `vanished` at start, for the rest of their time on the board (3 min, Amtrak 5), so a reload or tapping "Penn Station" keeps them.
- "Last stop:" drops NJ Transit's "-SEC" and ✈ (the destination itself stays as NJ Transit sends it).

## NJ Transit "Other options" from its timetable (Nov 24, 2026)
- Relay `/njt-rail-gtfs`: NJ Transit's rail GTFS zip (GTFSRT getToken + getGTFS, token in KV `gtfs-token-rail`). Locked: a GitHub Actions OIDC token (audience `penn-board-relay`, repository vexel420/penn-board, checked against GitHub's JWKS in `githubActionsCaller`), or the Worker secret REBUILD_KEY (for manual rebuilds from a session; its value is not stored anywhere else). GitHub's secrets API is blocked from cloud sessions, hence OIDC.
- `scripts/build-njt-timetable.py rail.zip` → `docs/njt-timetable.json` (same format as lirr-timetable.json plus `names`; stops are NJ Transit 2-letter codes; Secaucus TS→SE; no light rail). Weekly rebuild step uses the OIDC token (`id-token: write`).
- feeds.js keeps each NJ Transit train's `viaCodes` (STATION_2CHAR). The planner (`ttPlans`/`ttPlansHtml`) is shared by LIRR and NJ Transit: direct or one change (NJ Transit ≥4 min), never the delayed train, never a connection heading back to Penn; Live once the first train is on the board (train numbers without leading zeros). PATH buttons stay on NJ Transit cards.

## Masthead (owner's pick T3, Nov 24, 2026)
- "NEW YORK" kicker (`.mast-kicker`) over "Penn Station"; the view name (#h1-sub) is hidden on the page and kept only in the browser tab title.

## Installable app (Nov 24, 2026)
- `docs/manifest.webmanifest` (name "NYP Board" on home screens, owner Nov 24; standalone, theme #7d2f26), icons in `docs/icons/` ("NYP" in Limelight gold on Tuscan red with the masthead's gold rules; maskable version for Android; apple-touch-icon 180). No railroad logos.
- `docs/sw.js`: network first for this site's own files (always the latest version, last copy kept for no connection); never touches live data from other hosts. Registered at the end of app.js.
- iPhone: apple-mobile-web-app meta tags, `viewport-fit=cover`, safe-area padding on the masthead.
- Install: iPhone Safari → Share → Add to Home Screen. Android Chrome → menu → Install app / Add to Home screen.
- Nov 24 fixes: full-screen sheets (`.cm-head`) pad for the iPhone status bar in the installed app (Close button was under it). PATH "Delays" pills no longer drop for an on-time departure: PATH trains start at 33 St, so the delay is further along (the on-time removal stays for the subway, where Penn is mid-route).
