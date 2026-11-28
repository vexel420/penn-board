# Handoff: Penn Station departure board

Written 16 Nov 2026 (evening, New York time). Read this first, then `README.md`.

## Next week: features to build when the owner's usage resets (list started Nov 26)

The owner is spending the rest of this week's usage on **bugs only**. New features
wait for next week. Add to this list instead of building them now.

**Asked for by the owner**
- [ ] **"To the airport" on the Times Square–42 St board** (owner, Nov 26). The
  button is hidden there now (`airport: false` in hub.js). It needs routes from
  Times Sq: the subway to Penn/Grand Central/Port Authority connections, the A/E to
  JFK via Howard Beach/Jamaica, the M60-SBS/Q70 for LaGuardia, and NJ Transit or
  Newark Airport Express from Port Authority for Newark. Same fastest/cheapest sort.

**Carried over from earlier (offered or open; confirm with the owner first)**
- [ ] "To the airport" on the Port Authority board too (also hidden; the Newark
  Airport Express already leaves from there).
- [ ] A note under the Times Square 7 about 42 St–Bryant Park: no in-station
  walkway; ride the 7 one stop to 5 Av, or walk two avenue blocks (offered Nov 26).
- [ ] PATH holiday timetables: today the board uses the weekend timetable on
  holidays, which is close but not exact (Thanksgiving's direct Journal Square
  trains started 9:40 AM, the weekend's 10:10 AM).
- [ ] Owner's feedback on the delayed-train layout (mockup E).
- [ ] Ticketmaster key in the relay (event warnings beyond the NHL schedule).
- [ ] Licensing: check the FlixBus/Greyhound GTFS terms; MTA data email (mention
  Grand Central/Metro-North); a Port Authority MyTerminal data request (offered).
- [ ] A name for the app.

- [ ] **Crowding on trains and MTA buses** (owner, Nov 28; only show when a vehicle is getting full). Done: NJ Transit buses at Port Authority ("Getting full" / "Full" pills from NJ Transit's `passload`). To do: MTA buses (Bus Time SIRI may carry occupancy for some routes), LIRR/Metro-North (TrainTime has car loads on some trains), NJ Transit rail (check whether the rail API gives a load). Subway has no public crowding feed.

- [ ] **Newark Airport Express: where it is** (owner, Nov 28; tabled until Monday). Show where the bus
  is and where it stops (likely a map, like the MTA bus stop map). First check for a live vehicle
  location source (Coach USA / Newark Airport Express publishes a GTFS timetable via Trillium; look
  for GTFS-realtime vehicle positions or a public tracker API before building). If none, show the
  route and stops from the timetable (Port Authority, Bryant Park/42 St, Grand Central, EWR
  terminals) with scheduled times.

**Bugs still open going into next week**
- [ ] **MAJOR: scrolling on the owner's iPad AND iPhone (Safari), worst at Times Square** (owner, Nov 26–28; Nov 28: "jumping down and up on iPhone too"; emulated iPhone in Chromium: page height steady, no movement):
  the page scrolls/jumps on its own, sometimes to the top. Can't be reproduced in Chromium (this
  environment has no WebKit; `playwright install` isn't allowed). Already done: rows/sections/page
  hold their tallest height (`holdHeights`, body min-height), no keepAnchor scroll adjustments,
  one-shot reload restore, no Times Square zoom, width-only layout keys, split.html ignores
  height-only resizes, a blank subway refresh keeps the trains, the toggles keep their place.
  Next step: have the owner open `split.html?debug=scroll` (or `tsq.html?debug=scroll`) on the
  iPad and screenshot the green log box after a jump — it names the redraw (or "no redraw") and
  the page-height change behind each jump. Then fix that cause. If it's "no redraw", suspect
  Safari itself (iframe scrolling in split view; try the board on its own page to compare).
- [ ] Times Square "jumping" in the 4-board view: not reproducible in Chromium.
  Fixes shipped Nov 26 for Safari (keepAnchor, locked split page); waiting on the
  owner's device and browser if it still happens.
- [ ] Watch the S's "Daytime service has started" and the Thanksgiving holiday
  pills on the live board (first seen working Nov 26 for the Q).

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
- PATH maps (Nov 24): every station is labelled where there's room. `pathModel` reads where a delay comes from ("track condition at 14 St" → spot 14S, cause "Track condition"; list of causes in the regex) and "JSQ-33 via HOB" marks both 33 St lines. The sheet zooms to the spot and its neighbours on the affected lines (Penn included only when close), rings the spot and labels it with the cause; the key shows the cause.
- NJ Transit notices about service as a whole (no train number, no line named; `NJT_SYSTEMWIDE`, e.g. "NJ TRANSIT rail service is subject to up to 20-minute delays into and out of Penn Station New York") put their pill only on NJ Transit trains running late (2+ min by NJ Transit, or 2+ min past their time and not gone) whose status doesn't already say late/delayed (`njtHiddenDelay`, owner Nov 24). Before, they only showed in the Alerts list.

## Hidden delays on every railroad and bus (Nov 24, 2026)
- `hiddenDelayMin(r)`: a train late by its railroad's numbers (2+ min) or 2+ min overdue and not gone, whose shown status doesn't say late/delayed/held (e.g. a late LIRR or Amtrak train with its track posted shows "Boarding"; NJ Transit's own "BOARDING"). Such a train gets a "N min late" (or "Running late") pill even with no notice.
- Railroad-wide advisories pill only those trains: NJ Transit (`NJT_SYSTEMWIDE`) and LIRR (a notice naming 8+ branches).
- Buses: NJ Transit live departures show "N min late" (departuretime vs sched_dep_time); MTA buses to skipped stops show it from Bus Time (relay `/mta-bus-stop` now passes `aimed`, the scheduled time). Partner bus companies have no live data.
- NJ Transit-wide advisories also pill trains on "STAND BY" (owner, Nov 24). Pill wording: notices saying "subject to / may / could / possible / potential" read "Possible delays up to N min" (`rowAlertSummary`).
- Final call timing (Nov 24): `scheduleFinalCall` sets a redraw for the exact second the next train enters its final call (the 10 s redraw could start it up to 10 s late). Departures learned 5+ min after the train was due (app asleep, slow feed) date from when it was due, so "left N min ago" is right and old departures don't reappear after a wake.

## Airport helper: buses, LaGuardia terminals, Islip (Nov 25, 2026)
- `scripts/build-airport-buses.py` → `docs/airport-buses.json` (weekly rebuild): per MTA bus route reaching an airport stop (JFK Lefferts Blvd AirTrain or Terminal 8; LGA Terminals B and C), the fastest subway ride from Penn (≤1 change) to a stop of that bus, the bus ride to each airport stop, its daytime gap. Today: JFK Q80/Q10 (E to Kew Gardens), B15 (A+L to New Lots), Q3 (E to Jamaica-179 St, Terminal 8); LGA Q70 (E to Jackson Hts), M60 (N to Astoria Blvd), Q72, Q90.
- `airportBusOptions`: first subway leg live from the board when listed, bus live from MTA Bus Time (`/mta-bus-stop`, with "N min late"), else the usual gap. JFK Lefferts Blvd adds the free AirTrain (fee only at Jamaica/Howard Beach). $3.00 (free subway-bus transfer). Two quickest shown per airport.
- LaGuardia terminals, from LaGuardia Airport's website (checked Nov 25): Terminal B = Air Canada, American, Frontier, JetBlue, Porter, Southwest, United; Terminal C = Delta; Terminal A has no passenger flights (Modern Aviation; Spirit ceased operations). Picker (Any/B/C, "Not sure?" airline list, remembered in localStorage `lgaTerminal`/`lgaAirline`) only names your terminal and ride time: every LaGuardia bus serves B and C. JFK and Newark need no picker (all buses reach every terminal).
- Islip (ISP): LIRR to Ronkonkoma (live) + taxi/ride-hail about 5 min (no confirmed scheduled shuttle; fare not shown).
- Newark Airport Express: `scripts/build-ewr-express.py <Coach USA gtfs.zip>` → `docs/ewr-express.json` (Port Authority departures to Terminals B, C, A by weekday/Saturday/Sunday; file runs to May 1, 2027). Not public, so rebuilt by hand when Coach USA changes its schedule. Shown as "Scheduled", $23.50 (newarkairport.com).
- Islip bus: Suffolk County Transit route 6 (the only bus to the terminal) from the LIRR's Central Islip or Patchogue station; `scripts/build-isp-bus.py` (feed https://tracksctbus.org/gtfs, no key; weekly rebuild) → `docs/isp-bus.json`, fare $2.25 from its fare data. LIRR arrival from lirr-timetable.json (`lirrArrivalAt`).
- Not yet: live NJ Transit 62 at Newark Penn.

## Nov 25: Stewart (SWF), Islip on hold, live 62 bus
- Airport buttons: JFK, LGA, EWR, ISP, SWF (owner brought Islip back, Nov 25; five across, `.sheet-air.five`).
- Stewart: per swfny.com (Nov 2026) there's no direct NYC bus any more. Two options, both ending on Leprechaun Lines' Newburgh Beacon Bridge Shuttle (free in 2026), on runs that stop at the terminal:
  1. Subway to Grand Central, then the Metro-North Hudson Line to Beacon, then the shuttle. Metro-North is live from TrainTime (`backend-unified.mylirr.org/arrivals/0NY`, matched by train number), with the timetable from the MTA's gtfsmnr.zip.
  2. Coach USA 700 from Port Authority to the Newburgh ShortLine Transportation Center (Route 17K Park & Ride), then the shuttle. Scheduled; Coach USA has no live data or fares in its file.
- `scripts/build-swf.py` builds `docs/swf.json`. The shuttle times are typed from Leprechaun's brochure dated 07/04/26 (westbound runs that stop at Stewart). Re-type them when the brochure changes.
- The weekly Action rebuilds the Metro-North part only. The Coach USA part comes from the uploaded Coach USA GTFS, which isn't public, and its dates run out 2027-05-01. Rebuild with: `python3 scripts/build-swf.py gtfsmnr.zip coach-usa-gtfs.zip`.
- Weekday holidays use the weekend shuttle table. They're detected as weekdays with few Metro-North trains to Beacon (`weekendDates`).
- Coach USA's file has a Stewart stop (2577798), but no trip calls there.
- Live 62 bus: the relay has a new route, `/njt-bus-stop?stop=NNNNN` (getBusDV, digits only, cached 30 s). Newark Penn's Raymond Blvd bus lanes are stop 18835. The PATH + 62 option uses the first 62 "VIA AIRPORT" bus after you reach Newark Penn, with its gate. It's shown as live when a vehicle is assigned, otherwise as scheduled.

## Nov 25: event warnings and elevator outages
- **Event warnings.** `docs/events.json` is built by `scripts/build-events.py` from two sources: the NHL's own schedule (Rangers home games at MSG, Islanders home games at UBS Arena) and `docs/events-extra.json`.
  - `docs/events-extra.json` is the owner's own list, for concerts, Knicks games, parades and the like. Entries look like `{"venue","title","start" with offset,"kind"}`.
  - A daily Action (`.github/workflows/events.yml`) rebuilds the file. It also runs when `events-extra.json` changes.
  - The relay's `/events` route adds Ticketmaster Discovery events at MSG and UBS Arena once the Worker secret `TICKETMASTER_KEY` is set. Without the key it returns nothing.
  - The NBA blocks automated access to its own files, so we don't fetch them, and we don't send browser-like headers to get around that.
  - The NHL rate-limits the relay (429), which is why hockey is a daily file and not fetched live.
  - On the board, a gold banner shows above the trains and on the Alerts tab. It appears from 2 h before an event's start until 1 h after its usual end. Usual lengths: hockey 160 min, basketball 150, other sports and shows 180.
  - MSG text: crowds at Penn before the start and when it ends. UBS Arena text: crowded LIRR trains to Elmont-UBS Arena.
- **Elevator and escalator outages at 34 St-Penn Station.**
  - Live from the MTA's feed (`nyct%2Fnyct_ene.json`, no key, open to browsers), refreshed every 3 min.
  - The MTA's "what to do instead" advice comes from `docs/penn-elevators.json` (`scripts/build-penn-elevators.py`, weekly). The advice's own status sentence is dropped because it can be older than the outage.
  - Shown in the subway panel and on the Alerts tab under "Elevators and escalators", which says when all are working.
  - Amtrak and NJ Transit don't publish elevator status for the Penn concourses, so only the MTA's equipment is covered (subway, plus the LIRR entrance elevators EL34X and EL618).

## Nov 25: Grand Central board (Celestial), the hub pill and the side-by-side view
- **`docs/gct.html` + `docs/gct.js`.** The Grand Central board has its own script, so a Grand Central bug can't break Penn. It shares `style.css`, and `body.hub-gct` overrides the color variables for the Celestial theme: teal and gold, gold constellations in the masthead, Cinzel for the name.
- **Trains** come from TrainTime: `/arrivals/0NY` for Metro-North and `/arrivals/GCT` for the LIRR at Grand Central Madison.
  - Times are scheduled times. otp is in seconds and negative means late, as at Penn. Departures never run early.
  - Grand Central posts tracks early, so a row says "Boarding" only once a track is posted and the train leaves within 15 min. "All aboard" covers the last 60 s.
  - A train that drops off the list near its time shows as Departed for 3 min.
  - Metro-North station names: `docs/mnr-stations.json` (`scripts/build-mnr-stations.py`, rebuilt in the weekly job). LIRR names reuse feeds.js.
- **Subway:** the MTA's 1–7/S feed, read in the page. Stations are 631 (4/5/6), 723 (7) and 901 (S).
- **Diamonds (fixed Nov 25):** the MTA's feed can label trains "7X" that make all stops, so a train only counts as express (diamond) if its stops ahead skip every local-only station on the express stretch (`LOCAL_ONLY`, `STRETCH_END` in gct.js), as Penn judges express by stops. Downtown 6s and Hudson Yards-bound 7s are local from Grand Central on and get the circle. Earlier note: express runs of the 6 and 7 (the MTA's "6X", "7X") use the MTA's diamond bullet (`.bullet.diamond`), in the subway panel and in notices. Uptown 6 diamonds say "express in the Bronx" and Flushing-bound 7 diamonds say "express in Queens"; trains already past that stretch get the diamond without the note.
- **Buses:** MTA Bus Time through the relay, at 6 stops (codes in `BUS_STOPS`): M42 both ways at Park Av, M101–M103 downtown on Lexington and uptown on 3 Av, M1–M4 uptown on Madison.
- **Notices:** three new relay routes. `/alerts/mnr` is Metro-North. `/alerts/subway-gct` covers the 4 5 6 7 S lines and the Grand Central stations. LIRR notices are kept unless they're about Penn only. TrainTime's own alerts (special schedules) are included too.
- **Elevators:** `docs/penn-elevators.json` now also lists Grand Central-42 St equipment.
- **feeds.js exports** `parseTripUpdates`, `parseAlerts`, `alertUrl`, `lirrStationName`, `LIRR_BRANCHES` and `URGENT` for the Grand Central page.
- **Tap to reload:** tapping the station name reloads that board on both pages (Grand Central added Nov 25); taps on the pill switch boards instead.
- **Switching:** the owner's choice for testing is a pill on the masthead's "New York" line. Penn says "⇄ Grand Central" and Grand Central says "⇄ Penn Station". On Penn the masthead's tap-to-reload ignores taps on the pill, and `HUB_PILL` is redrawn with the flip-board masthead.
- **Side by side:** `docs/split.html` puts both live pages in frames. At desktop size each board is drawn 1150 px wide and gets `html.split-big` (set by split.html only): text 118%, with narrower fixed row columns and a 19.5rem subway panel so destinations keep their room. Below 1100 px wide (phones) it loads neither board and shows a short note with links to each instead. "Desktop size" renders each at 1280 px and scales it to fit. "Phone size" renders each at 390×844. Swap sides and Reload both are on the toolbar. The "Side by side" button shows only at 1100 px and wider, and hides inside the frames (`.in-split`).
- **Same toggles as Penn on Grand Central (Nov 25):**
  - Board style (Standard / Flip board).
  - Subway "Rows with more than one destination" (Take turns / All destinations).
  - "Delay pills" (With advisories / All late trains).
  - The choices are saved under the same keys, so both boards follow one setting.
  - The flip engine moved unchanged from app.js into `docs/flip.js`, which both pages load before their own script.
  - Subway pills on Grand Central: Delays (dropped when the train runs on time), the MTA's skipped-stops type, Express to local and Reduced service. Each opens the notice's words; "See full alert" goes to the notices.
  - On-time checks use `subway-times.json`, which now also has Grand Central's 631 and 723. `build-subway-data.py` adds the `GCT` station set; Penn's data is unchanged. The shuttle (901) has only two stops, so it has no timetable entry.

## Nov 25: the airport helper at every hub
- **The split:** the shared part lives in `docs/airport.js`, loaded after each board's own script. It holds the screen, fares, the LaGuardia airline picker, airport buses, the Newark Airport Express, Islip and Stewart.
- **Each hub provides:**
  - `HUB_AIR`, which says where trips start, the bus plans file, the Newark Airport Express pickup and walk, how to reach Port Authority (Stewart coach) and Grand Central (Stewart trains), and `lirrFrom`.
  - `hubAirportOptions(code, nowS)` for its own trains, plus `hubAirportLoad()`, `railTo()`, `lirrArrivalAt()`, `subwayFromTo()`, `lineName()`, `loadMtaBusStop()`/`mtaBusLive`, `openSheet()` and `changeOpen`.
- **Penn's part** (JFK/LGA/EWR rail, subway, PATH and the 62) stays in app.js, unchanged.
- **Grand Central's part** is in gct.js:
  - JFK: LIRR from Grand Central Madison to Jamaica plus AirTrain; or the 6 one stop to 51 St, through to the E at Lexington Av/53 St, the E to Sutphin, then AirTrain.
  - LaGuardia: LIRR to Woodside plus Q70; or the 7 to 74 St plus Q70.
  - Newark: NJ Transit from Penn, live through the relay's /njt, after the S and 1/2/3 to Penn (15 min).
  - LIRR arrival times come from lirr-timetable.json, with Grand Central Madison as stop 349.
- **Data:**
  - `docs/ewr-express.json` now also has `gct`: departures from Grand Central (41 St between Park and Lexington). 77 trips a day start there; Port Authority's times are unchanged.
  - `docs/airport-buses-gct.json` comes from `build-airport-buses.py --from gct` (weekly job).
- **Same options at every hub (owner, Nov 25: "not giving one hub better information than others").**
  - The PATH-to-Newark-Penn connections (NJ Transit one stop, or the live 62 bus) are one shared function, `newarkPennOptions()` in airport.js. The 62 reader (`loadNjtStop`/`njtStopBuses`) is shared too.
  - Newark from either hub:
    - the Newark Airport Express;
    - NJ Transit and Amtrak (Grand Central: after the subway to Penn; Amtrak from Amtraker);
    - PATH from 33 St, changing at Journal Square (Grand Central: an 18-min walk. PATH's feed looks only about 20 min ahead, so without a live train far enough out it's estimated from the usual gap and marked Estimated);
    - PATH from World Trade Center straight to Newark (Penn: the E; Grand Central: the 4/5 to Fulton St).
  - JFK from either hub: LIRR, the E and the A with the AirTrain, and buses. Grand Central reaches the A via the 7 to Times Sq.
  - Checked Nov 25 (options per airport, Penn / Grand Central): JFK 5/5, LGA 3/4 (Grand Central adds the 7 + Q70), EWR 7/7, ISP 2/2, SWF 2/2.
  - A hub's own functions must not be defined in airport.js: a function declared twice across scripts silently replaces the first.

## Nov 25: features ported between the boards (owner: "port all of the same features to both")
- **Penn gained** a live "Buses" list under PATH: Bus Time at `HUB_BUS_STOPS` (M34/M34A Select Bus on 34 St, M20 on 8 Av and 7 Av, M7 on 7 Av).
- **Grand Central gained:**
  - Train-row pills: the railroad's delay notices for the train's line (Metro-North route ids 1–6 by branch; LIRR route ids from lirr-data.json, with the same aliases as Penn), LIRR boarding changes at a stop, and "N min late" or "Running late" when the status doesn't show the delay.
  - A 2-minute final call for late trains.
  - Departed trains kept through a reload (`gctDeparted` in localStorage).
  - Event banners for UBS Arena (and Yankee Stadium or Citi Field once a source lists them); MSG stays on Penn.
- **"Other options" for a delayed train on Grand Central** (the button in a row's notice dropdown): the quickest trips to the same stations, direct or with one change, from the timetable.
  - The LIRR uses lirr-timetable.json from Grand Central Madison (stop 349).
  - Metro-North uses the new `docs/mnr-timetable.json` (`build-lirr-timetable.py --mnr`, weekly job). It's the same format, plus `names`, and keeps only the next 3 weeks because Metro-North's file has many date-specific services (about 0.9 MB, loaded only when the sheet opens).
  - Trains already on the live board show live time and track.

## Nov 25: one board engine for every hub (owner: "the subway needs all of the same features for sure")
- **Grand Central runs Penn's engine.** `gct.html` sets `window.HUB_ID = 'gct'` and loads hub.js, feeds.js, flip.js, app.js and airport.js. gct.js is retired.
- **What differs per hub** lives in `docs/hub.js`:
  - name, short name, kicker and the pill to the other hub;
  - map center, live-directions links, and the subway stations with their lines and direction names;
  - subway feeds and the alerts feed (`subway` or `subway-gct`);
  - railroads and the LIRR stop (Penn NYK/237, Grand Central Madison GCT/349);
  - whether PATH and the NJ Transit Buses tab apply, the elevator stations, event venues and nearby bus stops.
- **feeds.js:**
  - A TrainTime reader for any station (`trainTime(code, railroad)`): the LIRR at NYK or GCT, Metro-North at 0NY with names from mnr-stations.json. It drops 0HB and the like, and only says "Boarding" within 15 min at Grand Central, where tracks post early.
  - Metro-North rows carry `plate`, `plateClass` and `group` (HU/HA/NH), which the chips filter on.
  - `hubBoard()` assembles the board for a hub without NJ Transit, Amtrak or PATH; the stub sources are `hidden`.
  - Express or local is judged by stops: Lexington locals call at 51 St (630) and 33 St (632); the diamond 6 and 7 count as express only if they skip every local-only stop on the express stretch.
- **app.js:**
  - Reads `HUB` for names, plates, line chips, subway stations, map center, the "you are here" label and entrances, notices, events, elevators and buses.
  - The timetables start from the hub (`ttFrom`). Metro-North gets "Other options" (mnr-timetable.json, `MNR_ROUTE_NAMES`) and train-row notices by route id.
  - The airport helper dispatches by hub (`pennAirportOptions` / `gctAirportOptions`).
  - Penn-only parts are off elsewhere: PATH, NJ Transit's last trains, and the "other ways" guides.
- **Checked on both boards:**
  - Departures, arrivals and the flip board.
  - Both subway toggles, delay and skipped-stop pills, and subway maps with "Getting to the skipped stops" and entrances.
  - "Other options", the airport helper, nearby buses and elevators.
  - Penn unchanged: its PATH panel, maps and airport options.
- **Late-night subway banners** come from subway-data.json `switches`/`nightGaps`/`night` by station, which now cover Grand Central too. `build-subway-data.py` knows its local-only next stops (630, 632), so the 4 switches from express to local late nights. The 5 is in `NIGHT_GAP_LINES` (no Manhattan service late nights: "No 5 trains until…, use the 4"). Penn's entries are unchanged.

## Buses panel: fixed order, route links, stop map (Nov 25)
- Owner: buses should stay in a fixed order, not reorder by which comes next. `renderHubBuses` lists rows in `HUB.busStops` order (one row per line per stop) and shows "none due soon" / "no live times" instead of dropping a row. Times more than 90 minutes out are hidden.
- Each route badge links to the MTA route page, `https://www.mta.info/schedules/bus/<route lowercase>` (e.g. m34-sbs), in a new tab.
- "Map of the stops" opens a Leaflet sheet: hub star plus numbered stop dots (nudged apart when two stops share a corner) and a numbered list. Stop coordinates (`ll`) in hub.js come from the MTA Manhattan bus GTFS.
- Tapping a stop in the list under the map flies the map to it (zoom 18.5), highlights its dot and list row, and opens its popup; a "Show all stops" button on the map zooms back out. Tapping a route badge still opens the MTA page.

## Diamond 6 and 7 listed as local (Nov 26)
- Owner: "If the diamond 6 is running on local tracks at Grand Central then it needs to be listed as local." In Manhattan the diamond trains make every local stop, so `serviceFromPenn` returns 'local' for the 6 and 7; uptown trains that run express in the Bronx/Queens carry `diamond: true` (feeds.js, `diamondExpress`).
- Take turns: a diamond train counts as its own "end" (`lastOf` = last stop + '|d'), so the row turns between circle and diamond like the A's ends; the bullet flips (`.bflip`, rotateY) and the "express in the Bronx" note slides with the name (destName takes extra html).
- All destinations: rows with diamond trains mark each end with its own small circle or diamond bullet.

## Train-specific railroad notices (Nov 26)
- Owner: an LIRR notice about an inbound train running late shouldn't show on every outgoing train. `namedTrains(n)` reads the trains a notice names ("The 9:11pm train from Babylon to Penn Station …", also "… from Grand Central due Poughkeepsie …"). If a notice names any train, `namedTrainFits` puts it only on the departure leaving this hub (Penn: /penn/, Grand Central: /grand central/) at that scheduled time; inbound-only notices go on no departure (they stay in the Alerts tab). Notices naming no train keep the branch rule. Applies to LIRR and Metro-North.

## Subway rules are universal (Nov 26)
- Owner: every subway rule must work for any future hub (Times Sq, WTC…). Adding a hub now needs only its entry in docs/hub.js (`stations`, `dirs`, `subwayFeeds`, `subwayName`, `subwayWalk`, `elevatorStations`); the data builds read the hub list from there via `scripts/hubs.py`.
- `docs/subway-rules.json` (built by build-subway-data.py `service_rules`, from the MTA timetable):
  - `localNext["<station>|<N/S>"]`: stations within the next three stops that only local trains call at (some trains pass them on the way to a later stop). feeds.js `serviceAt`: a train calling at one is local, one passing them is express; no entry means every train makes the same stops (all local: the 7, the shuttle); too few stops left: `usual`.
  - `usual["<station>|<line>|<dir>"]`: the line's usual section there (also lineSection's fallback in app.js).
  - `diamond["<line>"]`: "a|b" stop pairs the 6X/7X/FX run between while the line's daytime locals stop in between (6 in the Bronx, 7 in Queens, F in Brooklyn). A live train with such a pair is a diamond train, listed with its line's row (local in Manhattan) and taking turns with the circle.
  - Replaces the hand lists LOCAL_NEXT, USUALLY_EXPRESS, DIAMOND_LOCAL_ONLY/END and NIGHT_GAP_LINES (every line is now checked for a night break). Penn's and Grand Central's generated data matched the old output exactly.
- build-subway-guide.py covers every hub station: Penn's hand-picked targets stay; other lines head for the farthest stop ≥80% of their trips reach that another line also serves. A station with no other line (the 7, the shuttle) gets a walk to the hub's other stations, possibly with a change (`walk.to`/`walk.then`). Grand Central's lines now get skipped-stop advice (they had none).
- Fixed: the subway heading said "34 St–Penn Station" on Grand Central whenever a weekend/late-night tag showed (now `HUB.subwayName`); "walk through Penn Station" now uses the hub's name.
- Still per hub by nature: the airport routes (PENN_AIR / GCT_AIR) and the LIRR "other ways" guides.
- Railroad notices: `NAMED_TRAIN` also reads "the 10:07pm train from Penn Station will depart…" (no "to"). An outgoing train gets a notice only when the notice names it; the LIRR/MNR feeds and timetables carry no link between an inbound train and the one it turns into (checked: no block_id, TrainTime has no such field).

## City events + live MTA bus alerts (Nov 26: the postponed Macy's parade)
- `docs/city-events.json`: big street events (parades, marathons). Each has start/end, `showFrom`, a `route` polyline, `radiusKm`, the MTA's own `busRoutes` (named like the board: "M34-SBS") and subway `lines`, and a `source` link. Every hub works out for itself whether it's affected (app.js `loadCityEvents`): within radiusKm of the route, or sharing a bus route (from `HUB.busStops`) or subway line (from `HUB.stations`). Shown in #events-note (one line, details folded, "Route map" opens the route on a map with the hub's star) and in the Alerts tab. To add an event, add an entry; no code change.
- First entry: the 100th Macy's parade, postponed by the storm to Sat Nov 28, 8:30 AM–noon (NBC/CNBC/ABC, Nov 25). The MTA's alerts lmm:planned_work:36814 (buses, Fri–Sat; includes M34/M34A SBS, M20, M7, M42, M1–M4) and :36813 (B, C trains) supplied the lists; their details say "check back later", which the live alerts will pick up.
- Live MTA bus alerts (`camsys/bus-alerts.json`, CORS open, every 5 min) for the hub's bus routes, in effect now or within 48 h: folded at the top of the bus panel ("N MTA alerts for these buses"), a "Service change" tag on rows whose route has one in effect, and a Buses group in the Alerts tab. The feed gives no stop ids, so an alert about particular stops counts only when its text names one of the hub's own stops (same avenue, within a block; `aboutHubStop`). Far-off placeholder end dates read "until further notice".
- Found this way at Grand Central: the downtown M101–M103 stop at Lexington Av/E 45 St is the temporary stop for E 46 St (water main work), and the uptown 3 Av/E 42 St stop has moved before the intersection (construction).
- Folded sections keep their open state across redraws (`setKeepOpen`, details[data-k]).

## Daily service check before events (Nov 26)
- Owner: check daily until the parade (Sat Nov 28) so nothing from any agency is missed. `.github/workflows/service-check.yml` runs `scripts/check-service.py` every day at about 5:07 AM New York time (and on pushes to city-events.json). For each event in city-events.json with a `watch` pattern that hasn't ended, it reads the MTA's subway, bus, LIRR and Metro-North alert feeds, NJ Transit's and PATH's messages (relay /njt, /path-alerts) and TrainTime's Penn and Grand Central notices; adds any bus route or subway line the MTA ties to the event (lists only grow); writes docs/service-check.json (sources, notices about the event, holiday/special-schedule headlines through the event). While an event is coming up it also starts rebuild-data.yml so timetables refresh daily. With no event coming up it does nothing, so it's ready for future events.
- Amtrak has no public service-alert feed: not covered.
- The banner's folded details list the notices that concern the hub (its bus routes, subway lines, railroads) and when the check last ran.
- First run (Nov 25 evening): NJ Transit says the extra trains planned for Thursday's parade won't run; LIRR and Metro-North list extra/added Thanksgiving service; MTA bus and subway parade notices as above; no new routes beyond the MTA's lists.

## Storm readiness: skipped stops, reroutes, suspensions, dropdowns (Nov 26)
- Skipped-stop maps: a skipped station (the line keeps running past it) gets a red-ringed dot and a red "SKIPPED" tag; the legend shows the same dot. A lone skipped stop was easy to miss (only its name was greyed).
- Notice direction for any hub (`noticeDir`): uptown/downtown/northbound/southbound, or "<place>-bound" (Woodlawn-, Flushing-, Far Rockaway-, Manhattan-, Brooklyn-bound…) resolved from the line's terminals (subway-data "terminals") and where the notice applies. Replaces the fixed word lists, which missed "Woodlawn-bound" (pill showed both ways) and always took "Manhattan-bound" as uptown (wrong for the 7, E…).
- Reroute detection: a "skips <station>" notice no longer switches off "Rerouted, see map" for the whole line (the live "Woodlawn-bound 4 skips Burnside Av" was hiding a 4 rerouted via the 2); only "running express" notices in that direction do.
- Temporary routes: `readVia` reads the headline and details, any wording ("[4] trains run / are running / operate via the [2] from X to Y").
- New row pill for suspensions and reroutes (`changePill`): "Part suspended", "Suspended", "Reroute" (the MTA's own type) with See map, on the line's rows at the hub. A notice naming no direction goes only on trains heading into the closed stretch (`headsInto`, by which side of the hub it lies along the line's axis): "no 1 above 96 St" is on the uptown 1 only.
- Tested with simulated storm notices and rerouted trains at both hubs: 4 via the 2 to Flatbush, 7 part suspended in Queens with shuttle buses, 6 and E suspended, uptown 5 skipping 86 St, A/C via the F, 1 part suspended uptown. Rows, pills, maps (both views) and "getting around it" all work, no errors.
- Fixed a map error when switching views quickly (a delayed fit ran on a replaced map).
- Dropdowns: the notice strips ("Subway service notices" etc.) now stay open until closed; they closed whenever the MTA updated any notice (its ids change with each version). A row's open "Delays" dropdown stays while its notice does, even when the row turns to an on-time train. The elevator panel's "What to do instead" keeps its open state.

## Islip: next available trains from the timetable (Nov 26)
- Owner: "If there is nothing today we should try to work out the next available time." When no live LIRR train to Ronkonkoma / Central Islip / Patchogue is on the board, `ispScheduled` (airport.js) plans from the LIRR timetable with `ttPlans` (now with a `windowH` horizon; 30 h here), direct or with a change (at Grand Central Madison in the evening every Ronkonkoma trip changes at Jamaica, which is why the screenshot showed nothing: the live path only looked for direct trains). Cards are tagged Scheduled (and "Tomorrow" when the train is on another day); if the first train is on the live board and on time, the card is Live with its track. Tested at both hubs, live and with the board emptied, and at 2:15 AM (finds the 6:00 AM from Grand Central Madison).
- Mockups (not shipped): monitor with 3 / 4 / compact 4 / 2×2 boards (docs/_mock-monitor.html, local only, git-excluded), and a separate Buses tab (phone tab; desktop Subway/Buses switch in the side panel). Awaiting the owner's pick; recommended a combined Port Authority / Times Square hub next.

## Airport: sort, official rail fares, Metro-North/4/5 + M60 to LaGuardia (Nov 26)
- Sort by Fastest (earliest arrival) or Cheapest (by fare, unknown fares last, then arrival); remembered (localStorage airportSort). The Fastest/Cheapest tags still mark the best of each whatever the order.
- LIRR and Metro-North fares are the railroads' own from TrainTime (`https://backend-unified.mylirr.org/fares?from=&to=&time=`, header accept-version 3.0, CORS open; one-way adult, CityTicket where it applies), cached for the visit (`railFare`). Neither railroad's GTFS has fares, which is why Metro-North had none. Now filled: Islip (RON/CI/PGE: $16.00 off-peak from either hub, plus the Suffolk bus), Stewart (Grand Central to Beacon 0BC: $18.50 off-peak), Harlem-125 St (0HL: $5.25/$7.25 CityTicket, matching the MTA's 2026 fare table). Peak from the train's own TrainTime flag; for scheduled trains, weekday departures 4-8 PM count as peak (`peakOut`). Metro-North rows now carry their peak/off-peak flag too (feeds.js).
- LaGuardia from Grand Central: Metro-North to Harlem-125 St (live train, 11 min), walk to Lexington Av, then the M60-SBS from E 125 St/Lexington Av (stop 405421, live from Bus Time); and the 4/5 to 125 St then the same bus (free transfer). The M60 ride is the Manhattan bus timetable's median by hour (M60_RIDE: 21-33 min to Terminal C, 23-36 to B). First run: Metro-North + M60 43 min, tied with the subway + Q70.

## Buses get their own tab (Nov 26, owner: "busses in a separate tab looks better, push that")
- Phones: tabs Departures · Arrivals · Subway(, PATH) · Buses · Alerts on one row (the old "Buses test" tab is folded in). Computers: a Subway / Buses switch at the top of the side panel (`data-side` on body, remembered in localStorage sidePanel); widening from the Buses tab keeps the panel on Buses.
- The side panel has `.sub-part` (subway, PATH, toggles) and `.bus-part` (#bus-panel: the hub's MTA buses with alerts and stop map, then "NJ Transit buses from Port Authority": the bus finder, #buses, rendered when shown via `busesShown()`). Phone rules are last in style.css so the tab always decides, whatever a computer picked.
- NJ Transit's own cross-honoring notice shows above the finder when there is one (Penn; Grand Central doesn't load NJ Transit). Grand Central now has the finder too, with directions to Port Authority by the shuttle or the 7 to Times Sq (`portAuthorityFromGct`).
- Monitor for more hubs (decided): when there are 3-4 hubs, the side-by-side page gets a 4-across option using each board's phone layout (the compact mockup, docs/_mock-monitor.html locally).

## Station headings in the subway panel; hub list reader (Nov 26)
- A hub station entry may carry `heading`, `sub` and `note`: the subway panel then puts that station's name above its platforms, like PATH (for the A C E on a future Times Square board: "42 St–Port Authority Bus Terminal", "Through the underground passage…").
- scripts/hubs.py reads station lists that span lines or carry extra fields (it silently skipped them before).
- Owner, Nov 26: Port Authority Bus Terminal and Times Square are different places: two boards, each linking the other, the A C E on both (on Times Square under its own heading). Times Square looks mocked: Broadway (red, marquee bulbs), Signage (white with the lines' colors), Sunset (pink-orange), Daylight (light page; needs contrast work). Awaiting the owner's pick.

## Port Authority Bus Terminal and Times Square boards (Nov 26)
- Two new hubs in docs/hub.js, pages docs/pabt.html and docs/tsq.html. The station pill is now a "⇄ Stations" menu of the other hubs (each hub has `page`).
- **Port Authority Bus Terminal** (`busTerminal: true`, blue/yellow): departures are buses. NJ Transit live from NJ Transit (relay /njt-bus-pabt: its departure screens, with gates; >30 min "late" is treated as another trip, not a delay); every other company with a published timetable from docs/pabt-departures.json (scripts/build-pabt-departures.py, weekly workflow): Coach USA (ShortLine, Suburban, Rockland, Community Coach, Newark Airport Express, with usual gates) from Trillium's megabus-us file, Greyhound from FlixBus's US file (gtfs.gis.flix.tech), Adirondack/Pine Hill/New York Trailways and Fullington from 511NY (NYSDOT), Academy, Lakeland and Trans-Bridge from njtransit.com. 14 days ahead. Filters: All, NJ Transit, Commuter, Long distance, Airport; column "Gate" ("usual gate" for timetable gates; Greyhound's official range in the row). Bus rows keep their own status (no train rules). The A C E as its subway, with a tunnel note to Times Square. Buses tab: MTA buses, the NJ Transit bus finder (no "get to Port Authority" step here), and all 23 companies from the Port Authority's list (docs/pabt-carriers.json: live / scheduled / check with the company).
- **Times Square** (`layout: 'subway'`, white signage header): the subway is the main view, one card per platform named by its line (1 2 3 Broadway–7 Av, N Q R W Broadway, 7 Flushing, S 42 St Shuttle); the A C E under "42 St–Port Authority Bus Terminal" with "Connected by an underground tunnel: follow the signs for the A C E / Port Authority Bus Terminal". Side panel: buses only, plus a link to the Port Authority board. Phone tabs: Subway, Buses, Alerts.
- No airport button on either yet (`airport: false`): the airport helper's routes are written per hub.
- Relay: /alerts/subway-lines?lines=…&stops=… (any hub's subway notices); hubs set `subwayAlerts` to it.
- Hubs without railroads skip the LIRR/Metro-North feeds (hubBoard `rails`).

## Fixes the same day
- Late-night pills/banners: the subway timetable build skipped trips with only one stop left after the hub (`i + 2 < len`), so the 42 St Shuttle had no timetable data at all (no "no shuttle late nights", no on-time check) and the 7 to Hudson Yards at Times Sq would have none. Now any trip with a stop left counts; Penn's and Grand Central's other lines unchanged. The shuttle now uses the timetable's direction (from Grand Central N, from Times Sq S) instead of always S, so the data matches; shuttle messages say no uptown/downtown.
- NJ Transit last-train-of-the-night pill: if the schedule's last train is cancelled or not on the live list (storm/holiday changes), the latest listed train of that line (or of NJ Transit) leaving within an hour before it gets the pill (`njtLastFallback`).
- NJ Transit bus finder removed from Grand Central (owner: confusing there); kept at Penn and Port Authority.
- Bus "Service change" tags are now pills that open to the MTA's alert text (like the subway's), with "See full alert".

## Holidays vs late nights (Nov 26)
- Owner: a holiday's schedule doesn't override late-night service. The subway heading shows "Late-night service" alone overnight; on a holiday, "Holiday service" appears once daytime service has started (a line's switch phase is "day"); while some lines are still on late nights and others have started the day, both show (`renderSubwayTags`). Weekend tag not shown on a holiday.
- After a holiday, trains still on its schedule keep a "Holiday schedule" pill until they leave: subway trips whose id starts 144000+ (scheduled start past 24:00, the holiday's late trips) the day after a holiday (`subHolidayTrip`); LIRR and Metro-North rows whose TrainTime service date (`runDate`, from `run_date`) is a past holiday (`railHolidayHtml`). Holidays: `subwayHoliday` (New Year's, Memorial Day, July 4, Labor Day, Thanksgiving, Christmas).
- Tested with the page clock set: Thanksgiving 2:15 AM and 5:40 AM late night only; 8:00 AM both; 8:30 AM and 10 AM holiday only; Friday 1:30 AM late night only, holiday-schedule trains pilled.

## Station bar (Nov 26)
- Owner: "Let's do bottom bar for now". The "⇄ Stations" pill and its menu are gone from the masthead.
- app.js `stationBar()` builds a `<nav class="station-bar">` from every hub in hub.js that has `page` and `tab` ({code, label, bg, ink, stripe?}). A new hub only needs a `tab` entry.
- Phones: fixed to the bottom edge (safe-area aware), body gets `has-station-bar` padding.
- Computers (≥961px), owner: "bottom bar for mobile and B for desktop": the bar is hidden and a ▾ button (`.hub-dd`, in the masthead h1 via `HUB_DD`) opens `#hub-menu`: color tile, full name, `tab.serves`, ✓ on the current one. Closes on Esc (focus back to ▾), outside click, resize; arrow keys move through it. Clicking ▾ doesn't trigger the name's reload.
- Not drawn inside split.html's frames (window.top check). Hidden when printing.
- Mockups A (strip), B (tap-name sheet), D (arrows) were the alternatives if the owner revisits.
- Times Square board is named "Times Square–42 St" everywhere (owner, Nov 26). MTA data has no in-station link from Times Sq to 42 St–Bryant Park (only Bryant Park ↔ 5 Av on the 7).

## Side by side: any board, and 4 at once (Nov 26)
- Owner: "build it and also make sure the two desktop Split View can be swapped to any board".
- split.html now loads hub.js and builds its frames from every hub with a `page` (a new hub shows up by itself).
- "2 boards": Left/Right pickers (picking the board already on the other side swaps them), ⇄ swap, Desktop/Phone size. "4 boards": the first four hubs, each at phone width (390 px) scaled to its column, as tall as the screen allows. Choices are kept in localStorage (splitCount, splitPair, splitSize).
- Frames already open are kept when switching layouts (only frames that move reload).
- Each board's "Side by side" button links to split.html?from=<hub>: that board starts on the left, and the toolbar's back link returns to it.
- Toolbar fits from 1100 px (title and Left/Right words hide under 1350 px).
- Port Authority rows: wider company column (long names like "Newark Airport Express" wrap inside it instead of running into the destination).

## Holiday pills from the first morning train; narrow train columns stack (Nov 26)
- Holiday tag now shows as soon as any line's daytime service has started (phase 'morning' counts, not only 'day'), alongside Late-night until every line is out of late nights. Simulated Thanksgiving at all 4 hubs: night → "Late-night"; first morning trains → both; all day → "Holiday" only.
- The subway heading's tags render even when no subway trains are listed (was an early return).
- `.rail` is a size container: below 760 px (690 px in split-big) each row stacks like the phone layout. Fixes the destination column squeezed to a sliver at laptop widths (~960–1150 px) on every board, worst at Port Authority (owner: "overlapping").

## Event alerts minimize; side panel opens on Subway (Nov 26)
- City event alerts (the parade) have a – button: minimized to one slim line with "Show". Remembered per event in localStorage `eventsMin` (all boards share it); `renderEvents()` re-renders.
- The side panel always opens on Subway (owner: "default view to be subway not busses"). The old remembered `sidePanel` choice is removed on load and no longer saved.
- Elevator/escalator alerts minimize the same way (ids `ene-<equipment>` in the same `eventsMin` set; `renderElevators()` re-renders).

## Shuttle overnight: take the 7 (Nov 26)
- Overnight the S says "No S trains until 6:04 AM. Take the 7 to Grand Central (or Times Sq) until the first shuttle." (destination from HUB.dirs). Then "Daytime service has started on the S" (existing 'morning' phase) until the first shuttle shows "now".
- Overnight notes now show while the only trains listed for that line are after the gap ends (the first morning trains appear in the feed hours early; before, that hid the note — Grand Central's S had none). This applies to every line, e.g. Penn's C now says "No C trains until 7:51 AM. Use the A." before 7:51 even with the first C listed.

## PATH on holidays (Nov 26)
- Owner asked whether PATH was really late all night. It wasn't: PATH ran its Thanksgiving schedule (its 5 AM notice), and the board measured live trains against the weekday timetable (live 5:56 vs weekday 5:48 = "8 min late"; banner said direct Journal Square from 6:03 AM; PATH said 9:40 AM).
- `pathKey(d)`: on subwayHoliday() days PATH's weekend ('sunday') timetable is used for late measurement, on-time checks, the late-night pill/banner and the scheduled fallback. Approximate: Thanksgiving's direct Journal Square trains start 9:40 AM vs the weekend's 10:10 AM.
- `pathLateBy` returns 0 when the train is within 2 min of a scheduled time (a train leaving 2 min before its slot was counted late from the slot before).
- PATH's own overnight advisory ("Overnight trains may leave up to 10 minutes late") is real and daily, but it's in a Closed state in the feed, so the board doesn't show it.

## Keep your place on reload (Nov 26)
- Owner: boards "jumping back to the top on each refresh". The 30-second data refresh keeps position (tested 70 s on all 4 boards with scroll anchoring off, like iOS Safari). A reload (tapping the station name, or the browser's refresh) lost it: the board fills in after load, so the browser's restore found a short page.
- `keepPlace()` in app.js: saves scroll, phone tab (`view`) and side panel to sessionStorage (`place:<hub>`) on pagehide/hidden; on a reload within 30 min it restores the tab/side, then scrolls back once the page is tall enough, holding the spot 5 s while content fills in above, and stops at the first wheel/touch/key/mouse input. A fresh visit still starts at the top, on Subway.

## Desktop: swap and hide; Safari place-keeping (Nov 26)
- Owner: double-click Subway to make it the main board with the trains on the right; a way to hide the side panel for full screen.
- `.panel-tools` (injected at the top of aside.subway, computers only): "Make main" / "<Main> to main" (swap) and "Hide <side>". Double-clicking a side-switch tab also swaps. A hidden side gets a tab at the right edge ("Show …"). Body classes `side-main`, `panel-off`; remembered in localStorage `sideMain`, `panelOff`.
- Swapped: aside takes the wide column (each subway station's two directions side by side), the rail sits in a 27rem column on the right (its rows stack via the rail container query). Times Square swapped: buses main, platforms stack.
- Times Square "jumping" (owner, 4-board view): not reproducible in Chromium (it has scroll anchoring). Likely Safari, which has none: Times Square's main board is the subway, redrawn every few seconds. `keepAnchor()` wraps renderSubway/Rail/Path/Events/Elevators/HubBuses/Buses: element at the reader's eye line before → scroll by its movement after. split.html: html/body overflow hidden + overscroll-behavior none; boards in a frame get overscroll-behavior contain (owner: "the entire webpage is trying to scroll").
- Full-width subway (Nov 26, owner: "see all of the lines at once without scrolling", side-panel sizes): with the side panel as the main board, `#subway` uses newspaper columns (18rem) and each direction stays whole, so a big station's directions continue in the next column. Grand Central at 1440×900: 4 5 6 up | 4 5 6 down | 7 | S, all on screen.
- Port Authority (`mergeSide: true` in hub.js): as the main board, the subway (A C E, text 1.12×) and the MTA buses show side by side, with no Subway/Buses switch; with the trains hidden, the A C E's two directions sit side by side.
- Revised the same day (owner: "not stretched wide", see every line with the side bar hidden): subway columns are a fixed 18rem (the side panel's content width), as many as fit (`--sub-cols` from `fitSubCols()`), never wider. The Subway/Buses switch and the tool buttons share one row. Grand Central at 1440×900 with the trains hidden: 4 columns, everything on screen. Port Authority with the trains hidden: A C E in two 18rem columns (uptown | downtown) beside a 32rem bus column.
- Later Nov 26: double-clicking a side-panel tab goes straight to full screen (that panel as the main board, the trains hidden); double-click again for both. In full screen `fitSubZoom()` picks the largest zoom (1 → 0.75, steps of 0.05) and the column count together so every line (down to the last station / PATH) fits on the screen; the whole `.sub-part` flows in the columns, PATH included (Penn gets 1 2 3 up | down | A C E up | down | PATH). Port Authority zooms only its subway part. 1440×900 results: Penn 80%, Port Authority 80%, Grand Central 90%.
- split.html: the station name labels over each board are gone (they covered the bottom rows).
- Fix (owner's iPad, side-by-side at desktop size): `html.split-big body.side-main .layout` kept a 22rem column even with the trains hidden, so the full-screen subway sat in ~60% of the board. `html.split-big body.panel-off .layout` now gives one column.
- Port Authority full screen inside side-by-side: its two columns (subway 37rem, buses 32rem) are now shrinkable (`minmax(0, …)`); at the split view's larger text the fixed widths had squeezed the buses to a sliver (owner's iPad photo).
- Minimized alerts are shared by every open board: a toggle re-reads localStorage before saving (an old copy in another frame/tab no longer saves over it), and a `storage` listener re-renders the other boards at once (owner: "it says it's minimized but is still showing").
- Times Square also lists the bus terminal station's elevators (its board shows the A C E there).

## Special-schedule pills on every train (Nov 26)
- Owner: every train under a holiday schedule gets the pill until it turns late night or the holiday ends; the same for other special schedules like weather. Built on Thanksgiving to watch live.
- Subway: `specialPills(epoch, late)`: a daytime train on a holiday (subwayHoliday of the train's own date) gets "Holiday schedule"; while the severe-weather notice is up, "Severe weather schedule" (`WX_PILL`). A late-night train gets only the late-night pill. The after-midnight holiday trips (`subHolidayTrip`) keep their pill as before.
- PATH (live and timetable): "Holiday schedule" unless the late-night pill applies.
- Rail: every LIRR, Metro-North and NJ Transit train of a holiday's service day (run_date, else the train's own date); Amtrak none.
- First look, 6:40 AM Thanksgiving: Penn 8 late / 4 holiday, Grand Central 2 / 5, Times Square 9 / 13; no train with both.
- Times Square platforms (Nov 26, owner: a gap under the shuttle in the 2-board view; fit the A C E in): all platform cards, the A C E included, are one `.plats` flowing in 2 CSS columns (computers; 1 on phones; 1 when buses are the main board), each card whole. The A C E's separate heading and tunnel paragraph became one line under its bullets (`.plat-where`: "At 42 St–Port Authority Bus Terminal, through the tunnel · Port Authority board →"). hub.js keeps `heading`/`note` for other uses.
- Layout choices are per board (localStorage `sideMain:<hub>`, `panelOff:<hub>`; the old shared keys are removed on load). Owner, Nov 26: Subway full screen at Penn made Times Square open on its buses. Times Square never remembers "buses as main": it always opens with the subway main (hiding the bus panel is remembered).

## Full-screen subway reworked: fixed cards, no movement on refresh (Nov 26, later)
- Owner: Penn "moving around and flashing when it refreshes" (side panel hidden); "try not to split subway or path lines across multiple columns".
- Cause: CSS newspaper columns re-balanced on every redraw (heights change with Take turns and new times), moving blocks between columns, and the fit re-ran from 100% on every redraw.
- Now: `.sub-part` is a grid of 18rem tracks; each station is ONE card spanning one track per direction (`--dirs`, set in renderSubway), directions side by side inside it; PATH (wrapped in `.path-part` in index.html) is its own track. Penn: 1 2 3 | A C E | PATH; Grand Central: 4 5 6 | 7 | S.
- `fitSubZoom()` sizes once per window size + layout (`dataset.sized`); a data refresh only steps the zoom down if the lines stop fitting. Tested: 0 changes in 24 s on Penn and Grand Central, all lines on screen at 1440×900 and in the 2-board view.
- Times Square (owner: "three columns instead of two"): `platCols` in hub.js puts the cards in fixed columns on computers: 1 2 3 + S | 7 + N Q R W | A C E (phones: one column, station order via CSS `order`). Same once-per-layout sizing, 80% minimum. In the 2-board view with the bus panel showing it doesn't quite fit (A C E bottom ~15% below); with the bus panel hidden it fits at 85%.
- Then (owner: "no side by side at all for subways"; side-by-side directions made text run together at Grand Central): every board, full-screen subway = one card per line in its own 24rem column, uptown above downtown, like Times Square; PATH its own column at Penn; Port Authority's A C E one column. `body.stack-dirs` is always on; `--dirs` on cards is now unused. Fixed order, sized once (0 changes over 10 s). 1440×900: Grand Central fits at 75%; Penn (70%) and Port Authority (75%) run a little below the screen; in the 2-board view Grand Central and Penn fit.
- Take-turns rows keep one height (owner: "Ozone Park-Lefferts Blvd keeps making it move"): `destName(key, name, extra, alts)` puts every name the row turns between invisibly in the same grid cell (`.dname-size`), so the row is always as tall as its longest name. Times Square card heights unchanged over 20 s of turns and refreshes.
- "Show …" (the hidden side) is no longer a tab floating on the right edge (owner: it covered the PATH times). With the side panel as the main board it sits with "… to main" in `.panel-tools`; with the trains full width, in `.trip-bar` next to "Side by side". `.panel-back[hidden]` forced hidden (a `.panel-tools button` rule was overriding it).
- Subway rows: the minutes column is a fixed 6.8rem (was auto). Its width followed the text ("12 min, 32" vs "now, 16, 31"), so the name and pills beside it re-wrapped and the card changed height on refreshes (owner: the A at Times Square "moving a lot"). Over 60 s at Times Square, the only height changes left were the "Daytime service has started" banners ending (once per line per morning).
- Per-train holiday/weather pills only during a change-over (owner, Nov 26): `specialPills` wraps them in `.sp-pills`; after each subway render, `#subway.no-sp` hides them unless some train shows the late-night pill or some line is in a 'night'/'morning' phase. So: on through the morning switch-over, gone once all lines are on daytime service, back when late nights start tonight. The tags by the Subway heading are larger (0.9rem, outlined). Tested by serving app.js with the late-night checks forced off: Times Square showed no train pills, only "Holiday service" by the heading.
- Weekend works like a holiday (owner, Nov 26): Saturday/Sunday daytime trains (not holidays) get "Weekend schedule" (`WKND_PILL`, in `.sp-pills`, so only during late-night change-overs); the header shows Weekend service once daytime service has started, both tags while some lines are still on late nights (the old "late night or weekend, not both" rule is gone).
- Severe weather: `WX_PILL` on every train, late-night ones too, the whole time the weather notice is up (not hidden outside change-overs), to call out last-minute changes.
- "Daytime service has started on the X" also ends when the first daytime train has evidently left: due 3+ min ago and the earliest listed train is 8+ min after it (`firstMorningGone`). Before, a board opened after that train showed "now" kept the banner up to 30 min (owner, Nov 26: the C banner stuck at Times Square while Penn had cleared). Checked at 7:33: downtown C/A/2 banners gone on all boards; uptown C stays until its 7:52 first train.
- Morning banners end on arrival, every board (owner, Nov 26): `morningArrived(key, …)` notes the time of the first express (or, for night-gap lines like the C, the first train) listed when the banner first shows; once that time has passed, the train has arrived and the banner clears, even if a 30-second refresh never caught its "now". "now" and `firstMorningGone` still end it too. Checked 7:34: Times Square watching uptown A 7:48, 2 and C 7:54; Penn one minute earlier.
- Lines whose late-night pattern is only fewer trains (no switch, no gap; e.g. the 3 uptown at Penn, the 1, the E) now also get "Daytime service has started on the X" (`windowMorning`): from when the first daytime trip (not in the timetable's night trips) is listed until it arrives, within 90 min before / 20 min after the night window's end (`night[..].to`). Several in one section merge: "on the 2 and 3" (`mergeDayBanners`). Owner, Nov 26: "the banner is missing the 3 at Penn". Note: on today's Sunday/holiday timetable the uptown 3's 7:37 and 7:52 are night trips (its daytime trips from ~9:36), and the downtown 3 resumes 8:01 (banner from 7:42).
- PATH alert pills (owner, Nov 26: some alerts got no pill): PATH_NAMES also match PATH's short names (HOB, EX PL/EXP, JSQ, NWPT, GRV, HAR, NWK, CHR), so "elevators at HOB & EX PL will be closed" is understood; parenthetical text ("trains to 33 St and WTC") no longer flags stations; a notice naming no line but all/overnight/PATH trains + late/delay ("Overnight trains may leave up to 10 minutes late") delays every line; and a train gets "Elevator out" / "Station closed" (drop pill with the notice) when an elevator or closure alert names a station it stops at.
- Rows and sections don't shrink back (owner, Nov 26: "still so much movement" at Penn and Times Square): subway rows (`data-k` = rowKey), option-B rows, each direction section (`stn|dir`) and PATH rows keep the tallest height they've had (`holdHeights()`, min-height), forgotten on a window/layout/style change and every 15 min. Cause found by logging every height change for 90 s: at Times Square the C's uptown 168 St row kept disappearing and reappearing (A C E box ±42 px every 20–30 s); otherwise only the morning banners ending. After: 0 height changes in 90 s on Penn and Times Square.
- PATH, later Nov 26 (owner: elevator out is not a pill; delays that stopped service got none): no elevator pill (closures still get "Station closed"). `parsePathAlerts` keeps a delay/suspension/failure alert from the last 90 min whose latest message isn't PATH's all-clear ("Final Update", "resuming", "normal service") even when PATH's feed already marks it Closed (it does: today's 7:12 "JSQ-33 via HOB delayed … network communication problems" incident and the schedule advisories all read Closed). "Network Communication Failure" etc. now type as Delays.
- No "Daytime service has started" banner for lines that run all night with only fewer trains (owner, Nov 26: the trains' pills say late night or normal); `windowMorning` removed. Banners remain for express/local switches and overnight gaps.
- Times Square 2-board view "constant moving" on the owner's iPad (not reproducible in Chromium, even with scroll anchoring off): removed the keepAnchor scroll adjustments (they scrolled the page after redraws; heights are held now); layout keys for the fit and held heights use the width only (Safari's toolbar changes the height constantly, which reset the zoom to 100% and re-shrank it, and cleared held heights); split.html ignores resizes that only change the height by < 120 px.
- Lines that run all night (express/local switch lines): the morning banner ends as soon as the last late-night train has left, i.e. no listed train of that line and direction still gets the late-night pill (`lastNightGone`), not only when the first daytime express arrives (owner, Nov 26). Lines with an overnight gap (C, 5) keep the first-train rule.
- Reverted `lastNightGone` (owner: "the exception is … like the 2: once the first express 2 train arrives is when the banner gets removed for services that have different patterns at night"). Final rules: lines that change pattern at night (express/local switch) — banner until the first daytime express arrives; lines with an overnight gap (C, 5) — until the first train arrives; lines that only run less often at night (E, 1, 3 uptown) — no banner, the trains' late-night pills say it.
- split.html "Reload": each frame is opened afresh at `page?fresh=<time>` instead of `location.reload()` (Safari answered that from its cache; owner had to refresh each board by hand). Tested with 4 boards: four new documents fetched, every board re-created and loaded.
- Times Square fit: the zoom now lives on `#subway` (stable) instead of the `.plats` grid that every refresh rebuilds (which re-measured from 100% each refresh; Safari can paint that).
- `?debug=scroll` (owner's iPad, "keeps scrolling up" at Times Square; Safari can't be tested here): a small on-screen log of every scroll jump of 20+ px with no touch/wheel/key before it, with page height before/after and which render ran in the last 400 ms; also logs page height changes. split.html?debug=scroll passes it to every board (kept by Reload).
- Owner, Nov 26: "now it's scrolling all the way up". Two fixes: the zoom is back on the `.plats` grid (on `#subway`, refilling a zoomed element may make Safari scroll to the top), with the size found per width/layout kept in `tsqFit` and re-applied to each new grid (no re-measuring from 100%); and keepPlace also restores the scroll position after side by side's Reload (`?fresh=` loads). Tested: Times Square scrolled to 600 stays at 600 through Reload and 30 s of refreshes.
- Owner, Nov 26 (iPad): "every time I go to scroll it starts trying to go back up then every 20 seconds it force goes to the top" / "constantly fighting me". Fixes: keepPlace restores ONCE and lets go (cancelled by any scroll it didn't make, touchmove, pointerdown, wheel, key); a refresh with no subway trains keeps the trains on screen for up to 2 min (`subwayEmptySince`) instead of emptying the board (the page went short and Safari jumped to the top); `#subway` and `#path` themselves are held at their tallest too (cleared on the 15-min/layout reset). Tested: empty refresh keeps y; after Reload, a user scroll is never pulled back; y unchanged over 32 s.
- Times Square: shrink-to-fit removed entirely (owner, Nov 26: still "scrolling all over", only on Times Square, the one board that re-applied a CSS zoom on every refresh; likely a Safari zoom/scroll problem). The board scrolls instead. `tsqFit` is now unused.
- Owner screenshot, Nov 26: stable for 30 s, but at the very bottom it moved up once, with a gap under the cards (the held #subway height). Now: no hold on #subway itself; instead the page (body min-height) never gets shorter (checked each redraw and every second; reset with the 15-min/layout reset), so Safari never has to pull the view up at the bottom. Tested: at the bottom, shrinking the bus list leaves the view where it is.
- Late-night window (build-subway-data.py `night_window`): in the morning it also ends at the first trip on the line's usual daytime route (origin → terminus most common 10 AM–7 PM) that follows a trip on another route. Owner, Nov 26: the uptown 3 kept "Late night" on its 9:05 and 9:22, which run the full New Lots route on a Sunday morning's 15–17 min spacing; the late-night 3s are the ones that start at Penn (last one 7:52). Changed windows: the 3 at Penn/Times Sq (Sun 9:36 → 8:47; weekday 7:11 → 6:24; Sat 7:14 → 6:47) and the 4 at Grand Central Saturday (6:06 → 5:53); every other line and section unchanged. Trip tuples in `at_penn` now carry the origin and terminus.
- Subway heading: "Subway" 1.65rem, tags 1rem, laid out as a flex row so the tags sit centred on the word (owner, Nov 26).
- NJ Transit disruption banner: third button "By bus from Port Authority" (owner, Nov 26: the bus option planned for cancellations was missing) → `openBusFinder()`: computers show the side panel's Buses (un-hiding/un-swapping it), phones the Buses tab, scrolled to and focused on "Choose your station". Also in a cancelled NJT train's "Other options". When an NJT notice says rail tickets are cross-honored on buses (`njtBusHonored`), the banner adds "NJ Transit says rail tickets and passes are accepted on NJ Transit buses now." Live Nov 26: banner on (3 cancelled parade extras), cross-honoring line shown.
- Removed the unused `.dir-lines` (line bullets inside each direction heading, left from the per-direction column layout): the rule hiding them only applied at computer width, so phone-size boards (4-board view) showed the logos twice, stacked (owner screenshot, Nov 26).
- The railroad/bus filter chip choice is per board (`carrier:<hub>`; old shared `carrier` key removed on load), and a saved choice that isn't one of this board's chips falls back to All. It was shared: Penn's "NJ Transit" (njt) made Port Authority show "No NJ Transit departures" with no chip pressed, and Port Authority's bus filters emptied Penn's train list (owner screenshots, Nov 26).
- Nov 28: weekend pills skip Friday's late trips between midnight and 4 AM Saturday (they're still Friday's schedule; owner saw "Weekend schedule" at 12:09 AM). Take turns / All destinations and Delay pills buttons keep their place on the screen after the redraw (`keepToggles`), and switching them no longer resets the held heights (owner: the page jumped to the top).
- Header "Weekend service" tag not between midnight and 4 AM Saturday (Friday night), like the train pills. Owner, Nov 28: asked whether late nights differ on weekends; yes, weekend late-night service lasts longer into the morning (e.g. uptown A at Penn to 6:41 Sat vs 6:15 weekdays), so the Late-night tag stays.
- Nov 28: NJ Transit bus rows carry `load` (passload); `crowdHtml` shows "Getting full" (standing room / few seats) or "Full", nothing otherwise (EMPTY, HALF_EMPTY, "no data", N/A).
- Opening/closing a pill's notice (drop) releases the held heights for its row, the enclosing sections and the page, and a row/section with an open notice is never held (owner, Nov 28: closing a "Stops skipped" pill left a screen of empty space). Tested: row 53 → 955 open → 53 closed, and stays 53 after a refresh.
- Tapping a pill (open/close its notice): the redraw replaced the tapped button and iPhone Safari jumped to the top (owner's ?debug=scroll screenshot, Nov 28: taps aren't logged since a touch precedes them; the logged small "no redraw" jumps are Safari's momentum after the finger lifts). Now the new pill gets focus (preventScroll) and the page is scrolled so it stays exactly under the finger (same idea as keepToggles). Tested at iPhone size: 3 pills, open and close, pill stays at the same screen position.
- Pill tap follow-up (owner debug log, Nov 28: "jump y445→2782 [renderRail, … fitSubZoom]" right after a tap): the pill is now looked up inside the tapped row (`data-k`), else the visible copy nearest the finger, and the correction is capped at one screen (bigger = wrong copy → stay at the old scroll position).
