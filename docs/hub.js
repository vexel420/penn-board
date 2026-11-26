// Hubs (owner, Nov 25: "port all of the same features to both"): every
// station board runs the same engine (feeds.js + app.js + airport.js); this
// file is what differs between them. The data builds (scripts/hubs.py) read
// each hub's subway stations from here too, so a new hub needs only an entry. A page picks its hub by setting
// window.HUB_ID before loading this file ('nyp' if it doesn't).
(function () {
  const HUBS = {
    nyp: {
      tab: { code: 'NYP', serves: 'Amtrak, LIRR, NJ Transit, subway, PATH', label: 'Penn', bg: '#7d2f26', ink: '#e6b751' }, // the station bar (phones) and the station menu (computers), owner Nov 26
      id: 'nyp', page: 'index.html', name: 'Penn Station', short: 'Penn', kicker: 'New York', title: 'Penn Station', subwayTab: 'subway and PATH',
      pill: { href: 'gct.html', label: 'Grand Central' },
      ll: [40.7506, -73.9935],
      directions: { google: 'https://www.google.com/maps/dir/?api=1&origin=34+St-Penn+Station,+New+York,+NY&travelmode=transit', apple: 'https://maps.apple.com/?saddr=Penn+Station,+New+York,+NY&dirflg=r' },
      // Subway stations at the hub, their lines, and how each direction is named.
      stations: [{ id: '128', lines: ['1', '2', '3'] }, { id: 'A28', lines: ['A', 'C', 'E'] }],
      // The station's name over the subway panel, and minutes to walk between its subway stations.
      subwayName: '34 St–Penn Station', subwayWalk: 8,
      dirs: { '128': { N: 'Uptown and the Bronx', S: 'Downtown and Brooklyn' }, A28: { N: 'Uptown and Queens', S: 'Downtown and Brooklyn' } },
      subwayFeeds: ['gtfs', 'gtfs-ace', 'gtfs-bdfm'],
      subwayAlerts: 'subway',
      // Railroads on the board, and the LIRR's stop id for this hub in its timetable.
      rails: ['lirr', 'njt', 'amtrak'], lirrStop: '237', lirrCode: 'NYK',
      path: true, buses: true,
      elevatorStations: ['34 St-Penn Station'],
      eventVenues: /Madison Square Garden|UBS Arena/i,
      busStops: [
        { stop: '401819', ll: [40.751988, -73.993312], lines: ['M34-SBS', 'M34A-SBS'], label: '34 St crosstown, eastbound', where: 'W 34 St at 8 Av' },
        { stop: '401848', ll: [40.752301, -73.993588], lines: ['M34-SBS'], label: '34 St crosstown, to Javits Center', where: 'W 34 St at 8 Av' },
        { stop: '401231', ll: [40.752329, -73.993258], lines: ['M34A-SBS'], label: 'To Port Authority on 8 Av', where: '8 Av at W 34 St' },
        { stop: '404847', ll: [40.749952, -73.994947], lines: ['M20'], label: 'Uptown on 8 Av', where: '8 Av at W 31 St' },
        { stop: '401360', ll: [40.750627, -73.99102], lines: ['M20', 'M7'], label: 'Downtown on 7 Av', where: '7 Av at W 34 St' },
      ],
    },
    gct: {
      tab: { code: 'GCT', serves: 'Metro-North, LIRR, subway', label: 'Grand Central', bg: '#1d5c66', ink: '#f3d88f' }, // the station bar (phones) and the station menu (computers), owner Nov 26
      id: 'gct', page: 'gct.html', name: 'Grand Central', short: 'Grand Central', kicker: 'New York', title: 'Grand Central', subwayTab: 'subway',
      pill: { href: 'index.html', label: 'Penn Station' },
      ll: [40.7527, -73.9772],
      directions: { google: 'https://www.google.com/maps/dir/?api=1&origin=Grand+Central+Terminal+New+York&travelmode=transit', apple: 'https://maps.apple.com/?saddr=Grand+Central+Terminal+New+York&dirflg=r' },
      stations: [{ id: '631', lines: ['4', '5', '6'] }, { id: '723', lines: ['7'] }, { id: '901', lines: ['GS'] }],
      subwayName: 'Grand Central–42 St', subwayWalk: 5,
      dirs: { 631: { N: 'Uptown and the Bronx', S: 'Downtown and Brooklyn' }, 723: { N: 'Queens', S: 'Times Sq and Hudson Yards' }, 901: { N: 'Times Sq-42 St', S: 'Times Sq-42 St' } },
      subwayFeeds: ['gtfs'],
      subwayAlerts: 'subway-gct',
      rails: ['mnr', 'lirr'], lirrStop: '349', lirrCode: 'GCT', mnrStop: '1', mnrCode: '0NY',
      path: false, buses: false,
      elevatorStations: ['Grand Central-42 St'],
      eventVenues: /UBS Arena|Yankee Stadium|Citi Field/i,
      busStops: [
        { stop: '405241', ll: [40.752111, -73.97748], lines: ['M42'], label: '42 St crosstown, westbound', where: 'E 42 St at Park Av' },
        { stop: '403459', ll: [40.75188, -73.97733], lines: ['M42'], label: '42 St crosstown, eastbound', where: 'E 42 St at Park Av' },
        { stop: '402843', ll: [40.753095, -73.974905], lines: ['M101', 'M102', 'M103'], label: 'Downtown on Lexington Av', where: 'Lexington Av at E 45 St' },
        { stop: '402679', ll: [40.751085, -73.974122], lines: ['M101', 'M102', 'M103'], label: 'Uptown on 3 Av', where: '3 Av at E 42 St' },
        { stop: '400018', ll: [40.753349, -73.978759], lines: ['M1', 'M2'], label: 'Uptown on Madison Av', where: 'Madison Av at E 43 St' },
        { stop: '400561', ll: [40.753337, -73.978759], lines: ['M3', 'M4'], label: 'Uptown on Madison Av', where: 'Madison Av at E 42 St' },
      ],
    },
    pabt: {
      tab: { code: 'PABT', serves: 'Buses, A C E', label: 'Port Authority', bg: '#1d3f86', ink: '#ffd24a' }, // the station bar (phones) and the station menu (computers), owner Nov 26
      // Computers, side panel as the main board: subway (only the A C E) and MTA buses together (owner, Nov 26).
      mergeSide: true,
      id: 'pabt', page: 'pabt.html', name: 'Port Authority Bus Terminal', short: 'Port Authority', kicker: 'New York', title: 'Port Authority Bus Terminal', subwayTab: 'subway',
      pill: { href: 'tsq.html', label: 'Times Square–42 St' },
      ll: [40.7572, -73.9903],
      directions: { google: 'https://www.google.com/maps/dir/?api=1&origin=Port+Authority+Bus+Terminal+New+York&travelmode=transit', apple: 'https://maps.apple.com/?saddr=Port+Authority+Bus+Terminal+New+York&dirflg=r' },
      // The bus terminal (owner, Nov 26): departures are buses (NJ Transit live,
      // other companies from their timetables, docs/pabt-departures.json).
      busTerminal: true, airport: false, mainLabel: 'bus departures',
      stations: [{ id: 'A27', lines: ['A', 'C', 'E'], note: 'Connected by an underground tunnel to Times Sq–42 St for the 1 2 3, 7, N Q R W and shuttle: follow the signs for Times Sq. About 5 min.', noteLink: { href: 'tsq.html', label: 'Times Square–42 St board' } }],
      subwayName: '42 St–Port Authority Bus Terminal', subwayWalk: 5,
      dirs: { A27: { N: 'Uptown and Queens', S: 'Downtown and Brooklyn' } },
      subwayFeeds: ['gtfs-ace'], subwayAlerts: 'subway-lines?lines=A,C,E&stops=A27',
      rails: [], path: false, buses: true,
      elevatorStations: ['42St/Port Authority-Bus Terminal'],
      eventVenues: /^$/,
      busStops: [
        { stop: '401851', ll: [40.757575, -73.990464], lines: ['M42'], label: '42 St crosstown, westbound', where: 'W 42 St at 8 Av' },
        { stop: '403239', ll: [40.757191, -73.989904], lines: ['M42'], label: '42 St crosstown, eastbound', where: 'W 42 St at 8 Av' },
        { stop: '404870', ll: [40.757537, -73.98947], lines: ['M104', 'M20'], label: 'Uptown on 8 Av', where: '8 Av at W 42 St' },
        { stop: '401497', ll: [40.758584, -73.992665], lines: ['M11', 'M34A-SBS'], label: '9 Av, downtown and to Penn', where: '9 Av at W 42 St' },
      ],
    },
    tsq: {
      tab: { code: 'TSQ', serves: 'Subway, A C E across the tunnel', label: 'Times Sq–42 St', bg: '#fbfaf6', ink: '#111111', stripe: '#fccc0a' }, // the station bar (phones) and the station menu (computers), owner Nov 26
      // Computers: the platform cards in three fixed columns (owner, Nov 26: three columns; the 7 near the top).
      platCols: [['127', '902'], ['725', 'R16'], ['A27']],
      id: 'tsq', page: 'tsq.html', name: 'Times Square–42 St', short: 'Times Sq–42 St', kicker: 'New York', title: 'Times Square–42 St', subwayTab: 'subway',
      pill: { href: 'pabt.html', label: 'Port Authority' },
      ll: [40.7557, -73.9871],
      directions: { google: 'https://www.google.com/maps/dir/?api=1&origin=Times+Sq-42+St+New+York&travelmode=transit', apple: 'https://maps.apple.com/?saddr=Times+Square+New+York&dirflg=r' },
      // A subway station (owner, Nov 26): the subway is the main view, one card per
      // platform (they're far apart), and the side panel has only buses.
      layout: 'subway', airport: false, mainLabel: 'subway',
      stations: [
        { id: '127', lines: ['1', '2', '3'], platform: 'Broadway–7 Av line' },
        { id: 'R16', lines: ['N', 'Q', 'R', 'W'], platform: 'Broadway line' },
        { id: '725', lines: ['7'], platform: 'Flushing line' },
        { id: '902', lines: ['GS'], platform: '42 St Shuttle' },
        { id: 'A27', lines: ['A', 'C', 'E'], platform: '8 Av line', heading: '42 St–Port Authority Bus Terminal', sub: 'A separate station at the bus terminal', note: 'Connected by an underground tunnel: follow the signs for the A C E / Port Authority Bus Terminal. About 5 min.', noteLink: { href: 'pabt.html', label: 'Port Authority board' } }],
      subwayName: 'Times Sq–42 St', subwayWalk: 5,
      dirs: { 127: { N: 'Uptown and the Bronx', S: 'Downtown and Brooklyn' }, R16: { N: 'Uptown and Queens', S: 'Downtown and Brooklyn' }, 725: { N: 'Grand Central and Queens', S: '34 St-Hudson Yards' }, 902: { N: 'Grand Central', S: 'Grand Central' }, A27: { N: 'Uptown and Queens', S: 'Downtown and Brooklyn' } },
      subwayFeeds: ['gtfs', 'gtfs-nqrw', 'gtfs-ace'], subwayAlerts: 'subway-lines?lines=1,2,3,7,N,Q,R,W,GS,S,A,C,E&stops=127,R16,725,902,A27',
      rails: [], path: false, buses: true,
      elevatorStations: ['Times Sq-42 St', '42St/Port Authority-Bus Terminal'], // (the A C E at the bus terminal is on this board too)
      eventVenues: /^$/,
      busStops: [
        { stop: '405549', ll: [40.756311, -73.987403], lines: ['M42'], label: '42 St crosstown, westbound', where: 'W 42 St at 7 Av' },
        { stop: '403240', ll: [40.756259, -73.987735], lines: ['M42'], label: '42 St crosstown, eastbound', where: 'W 42 St at 7 Av' },
        { stop: '404153', ll: [40.755694, -73.987208], lines: ['M104'], label: 'Downtown on 7 Av', where: '7 Av at W 42 St' },
        { stop: '450045', ll: [40.755498, -73.987324], lines: ['M7', 'M20'], label: 'Downtown on 7 Av', where: '7 Av at W 41 St' },
      ],
    },
  };
  const id = (typeof window !== 'undefined' && window.HUB_ID) || 'nyp';
  const root = typeof window !== 'undefined' ? window : globalThis;
  root.HUBS = HUBS;
  root.HUB = HUBS[id] || HUBS.nyp;
})();
